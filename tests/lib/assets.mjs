/**
 * 纯 Node 生成测试资源（PNG / 极小 MP4 外壳），避免任何外部依赖或第三方库。
 * PNG 用 node:zlib 手工拼 IHDR/IDAT/IEND，保证浏览器能真正解码（naturalWidth>0）。
 * MP4 只拼 ftyp + mdat 外壳：足以作为可请求的 video/mp4 端点，但不保证可解码播放，
 * 因此「视频替换」用例只断言 DOM/src，不断言可播放。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const CRC_TABLE = (function buildTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

/** 纯色 RGBA PNG（8bit，colorType 6） */
export function solidPng(width, height, rgba) {
  const r = rgba[0];
  const g = rgba[1];
  const b = rgba[2];
  const a = rgba.length > 3 ? rgba[3] : 255;

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  const rowLength = 1 + width * 4;
  const raw = Buffer.alloc(rowLength * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * rowLength;
    raw[rowStart] = 0; // filter type 0
    for (let x = 0; x < width; x += 1) {
      const p = rowStart + 1 + x * 4;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
      raw[p + 3] = a;
    }
  }

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function mp4Box(type, payload) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8, 0);
  header.write(type, 4, 'ascii');
  return Buffer.concat([header, payload]);
}

/** 极小 MP4 外壳：ftyp + mdat */
export function tinyMp4() {
  const ftyp = mp4Box('ftyp', Buffer.concat([
    Buffer.from('isom', 'ascii'),
    Buffer.from([0x00, 0x00, 0x02, 0x00]),
    Buffer.from('isomiso2mp41', 'ascii')
  ]));
  const mdat = mp4Box('mdat', Buffer.alloc(64, 0));
  return Buffer.concat([ftyp, mdat]);
}

/**
 * 极小 WAV（16bit / 8kHz / 单声道 / 静音）。
 * 与上面的 MP4 外壳不同，WAV 是「真的能解码」的：duration / currentTime / seek / play
 * 都正常工作，用于「双流同步」用例验证 audio.currentTime 的纠偏数值行为。
 * 注意 --mute-audio 下听不到声音，但媒体时钟照常推进，断言只看时间数值。
 */
export function tinyWav(seconds) {
  const sampleRate = 8000;
  const length = typeof seconds === 'number' && seconds > 0 ? seconds : 10;
  const frames = Math.round(sampleRate * length);
  const data = Buffer.alloc(frames * 2); // 静音 PCM
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);              // fmt 块长度
  header.writeUInt16LE(1, 20);               // PCM
  header.writeUInt16LE(1, 22);               // 单声道
  header.writeUInt32LE(sampleRate, 24);      // 采样率
  header.writeUInt32LE(sampleRate * 2, 28);  // 字节率
  header.writeUInt16LE(2, 32);               // 块对齐
  header.writeUInt16LE(16, 34);              // 位深
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * 生成/覆盖夹具里的二进制资源（真实磁盘文件，可由静态服务器直接请求）。
 * 返回生成的文件列表，便于日志展示。
 */
export function ensureFixtureAssets(fixturesDir) {
  const imgDir = path.join(fixturesDir, 'img');
  const videoDir = path.join(fixturesDir, 'video');
  fs.mkdirSync(imgDir, { recursive: true });
  fs.mkdirSync(videoDir, { recursive: true });

  const plan = [
    [path.join(imgDir, 'orig.png'), solidPng(320, 180, [37, 99, 235, 255])],
    [path.join(imgDir, 'replaced.png'), solidPng(320, 180, [236, 72, 153, 255])],
    [path.join(videoDir, 'orig.mp4'), tinyMp4()],
    [path.join(videoDir, 'replaced.mp4'), tinyMp4()],
    // 双流用例专用：可真正解码的音频（视频轨/音频轨共用同一个文件，只要地址不同即可）
    [path.join(videoDir, 'tone.wav'), tinyWav(10)]
  ];

  const written = [];
  plan.forEach(function (entry) {
    const file = entry[0];
    const buffer = entry[1];
    fs.writeFileSync(file, buffer);
    written.push(path.relative(fixturesDir, file) + '(' + buffer.length + 'B)');
  });
  return written;
}