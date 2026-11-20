/**
 * 测试用静态 HTTP 服务（node:http，端口随机），指向 tests/fixtures。
 * 附带 no-store，避免浏览器缓存干扰「刷新后仍生效」类断言。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { expect } from './util.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8'
};

function contentType(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

/**
 * @param {string} rootDir tests/fixtures 绝对路径
 * @returns {Promise<{baseUrl:string, port:number, close:()=>Promise<void>, requests:string[]}>}
 */
export function startServer(rootDir) {
  const root = path.resolve(rootDir);
  const requests = [];

  const server = http.createServer(function (req, res) {
    const requestedUrl = req.url || '/';
    requests.push(req.method + ' ' + requestedUrl);

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(requestedUrl, 'http://127.0.0.1').pathname);
    } catch (e) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('bad-request');
      return;
    }

    if (pathname === '/' || pathname === '') pathname = '/page.html';

    const target = path.resolve(root, '.' + pathname);
    if (!target.startsWith(root + path.sep) && target !== root) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('forbidden');
      return;
    }

    fs.readFile(target, function (err, buffer) {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end('not-found: ' + pathname);
        return;
      }

      // Range 支持：媒体元素只有在响应可 Range 时才有非空的 seekable 区间，
      // 「双流同步」用例要真实 seek（制造/纠正音画漂移）依赖它。
      const rangeHeader = String(req.headers.range || '');
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
      if (match) {
        const total = buffer.length;
        let start = match[1] === '' ? total - Number(match[2] || 0) : Number(match[1]);
        let end = match[1] === '' || match[2] === '' ? total - 1 : Number(match[2]);
        if (!Number.isFinite(start)) start = 0;
        if (!Number.isFinite(end) || end > total - 1) end = total - 1;
        if (start < 0) start = 0;
        if (start > end || start >= total) {
          res.writeHead(416, { 'content-range': 'bytes */' + total, 'cache-control': 'no-store' });
          res.end();
          return;
        }
        const chunk = buffer.subarray(start, end + 1);
        res.writeHead(206, {
          'content-type': contentType(target),
          'content-length': chunk.length,
          'content-range': 'bytes ' + start + '-' + end + '/' + total,
          'accept-ranges': 'bytes',
          'cache-control': 'no-store, no-cache, must-revalidate',
          'access-control-allow-origin': '*'
        });
        res.end(chunk);
        return;
      }

      res.writeHead(200, {
        'content-type': contentType(target),
        'content-length': buffer.length,
        'accept-ranges': 'bytes',
        'cache-control': 'no-store, no-cache, must-revalidate',
        'access-control-allow-origin': '*'
      });
      res.end(buffer);
    });
  });

  return new Promise(function (resolve, reject) {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', function () {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      expect(port > 0, '静态服务未取得端口');
      resolve({
        port: port,
        baseUrl: 'http://127.0.0.1:' + port,
        requests: requests,
        close: function () {
          return new Promise(function (done) {
            server.close(function () {
              done();
            });
            server.closeAllConnections && server.closeAllConnections();
          });
        }
      });
    });
  });
}