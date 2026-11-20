/**
 * 通用小工具：延时、状态轮询、端口探测、安全序列化。
 * 只用 Node 内置能力（node:net / node:timers），不引入任何外部依赖。
 */
import net from 'node:net';

export function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

/** 一行 JSON，超长截断（用于证据行） */
export function safeJson(value, maxLength) {
  const limit = typeof maxLength === 'number' ? maxLength : 400;
  let text;
  try {
    text = JSON.stringify(value);
  } catch (e) {
    text = String(value);
  }
  if (text === undefined) text = String(value);
  return text.length > limit ? text.slice(0, limit) + '…(截断)' : text;
}

export function truncate(text, maxLength) {
  const limit = typeof maxLength === 'number' ? maxLength : 200;
  const s = String(text == null ? '' : text);
  return s.length > limit ? s.slice(0, limit) + '…' : s;
}

/**
 * 轮询探针直到 predicate(snapshot) 为真，返回命中的那份快照。
 * 超时抛出带「最后状态」的错误，便于失败取证。
 */
export async function waitForState(probe, predicate, options) {
  const opts = options || {};
  const timeout = typeof opts.timeout === 'number' ? opts.timeout : 8000;
  const interval = typeof opts.interval === 'number' ? opts.interval : 120;
  const label = opts.label || 'condition';
  const deadline = Date.now() + timeout;
  let last = null;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      last = await probe();
      if (predicate(last)) return last;
    } catch (e) {
      lastError = e;
    }
    await sleep(interval);
  }
  throw new Error(
    '等待超时[' + label + ']: 最后状态=' + safeJson(last, 320)
    + ' 最近错误=' + (lastError ? truncate(lastError.message, 160) : '无')
  );
}

/** 找一个当前空闲的 TCP 端口 */
export function freePort() {
  return new Promise(function (resolve, reject) {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', function () {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close(function () {
        resolve(port);
      });
    });
  });
}

/** 中文断言 */
export function expect(condition, message) {
  if (!condition) throw new Error(message);
}

/** 用于跳过（SKIP）用例的哨兵错误 */
export class SkipSignal extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'SkipSignal';
    this.isSkip = true;
  }
}

export function skip(reason) {
  throw new SkipSignal(reason);
}