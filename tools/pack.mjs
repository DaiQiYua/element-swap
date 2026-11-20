#!/usr/bin/env node
/**
 * 打包脚本：把运行时文件收进 dist/element-swap-<version>.zip
 * 只收 manifest 引用的运行时目录，排除 tests/、README、临时文件。
 *
 * 用法：node tools/pack.mjs
 */
import { createWriteStream, existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { deflateRawSync, crc32 } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = ['manifest.json', 'background.js', 'shared', 'content', 'popup', 'assets', 'rules'];
const SKIP_EXT = new Set(['.md', '.map', '.log']);
const SKIP_NAME = new Set(['.DS_Store', 'Thumbs.db']);

// ---------- 最小 ZIP 写入器（store/deflate，无第三方依赖） ----------
const LOCAL_HEADER = Buffer.alloc(30);
function dosTime(d) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = e.data;
    const crc = crc32(data);
    const { time, date } = dosTime(e.mtime);
    const deflated = deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);            // version needed
    header.writeUInt16LE(0x0800, 6);        // UTF-8 flag
    header.writeUInt16LE(useDeflate ? 8 : 0, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);

    chunks.push(header, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(useDeflate ? 8 : 0, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += header.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, end]);
}

// ---------- 收集文件 ----------
async function walk(absPath, relPath, out) {
  const st = await stat(absPath);
  if (st.isDirectory()) {
    for (const name of (await readdir(absPath)).sort()) {
      if (SKIP_NAME.has(name) || name.startsWith('.')) continue;
      await walk(path.join(absPath, name), `${relPath}/${name}`, out);
    }
    return;
  }
  if (SKIP_EXT.has(path.extname(absPath).toLowerCase())) return;
  out.push({
    name: relPath,
    data: await readFile(absPath),
    mtime: st.mtime
  });
}

const manifestPath = path.join(root, 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error('缺少 manifest.json');
  process.exit(1);
}
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

const entries = [];
for (const item of RUNTIME) {
  const abs = path.join(root, item);
  if (!existsSync(abs)) {
    console.warn(`跳过不存在的路径: ${item}`);
    continue;
  }
  await walk(abs, item, entries);
}

const zip = buildZip(entries);
const outDir = path.join(root, 'dist');
const outFile = path.join(outDir, `element-swap-${manifest.version}.zip`);
await (await import('node:fs/promises')).mkdir(outDir, { recursive: true });
await new Promise((resolve, reject) => {
  const ws = createWriteStream(outFile);
  ws.on('error', reject);
  ws.on('finish', resolve);
  ws.end(zip);
});

const kb = (zip.length / 1024).toFixed(1);
console.log(`已打包 ${entries.length} 个文件 → ${path.relative(process.cwd(), outFile)} (${kb} KB)`);
for (const e of entries) console.log(`  · ${e.name}`);