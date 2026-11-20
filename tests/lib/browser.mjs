/**
 * 真实 Edge 启动 + 扩展加载 + 目标（target）发现。
 *
 * 优先 headless=new；若拿不到扩展 service worker target（说明该模式下扩展未加载），
 * 自动回退到「非 headless + 窗口移出屏幕」模式。
 *
 * 扩展 ID：先按契约从 /json/list 里 type=service_worker 且
 * chrome-extension://<id>/background.js 的 target 解析；拿不到再用
 * 未打包扩展 ID 的 SHA-256 规则推算并逐个验证。
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CDP, evaluate } from './cdp.mjs';
import { expect, freePort, sleep, truncate } from './util.mjs';

export const EDGE_PATH = process.env.ES_EDGE_PATH
  || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const EXT_ID_RE = /chrome-extension:\/\/([a-p]{32})\/background\.js/i;
const ID_PATTERN = /^[a-p]{32}$/;

export function devtoolsUrl(port, targetId) {
  return 'ws://127.0.0.1:' + port + '/devtools/page/' + targetId;
}

/** GET 一个 DevTools 的 JSON 端点 */
export async function devtoolsJson(port, pathname, timeout) {
  const limit = typeof timeout === 'number' ? timeout : 5000;
  const controller = new AbortController();
  const timer = setTimeout(function () {
    controller.abort();
  }, limit);
  try {
    const res = await fetch('http://127.0.0.1:' + port + pathname, { signal: controller.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 从 target 列表里挑出所有形如 chrome-extension://<id>/background.js 的 service worker。
 * 注意：Edge 自带组件扩展也可能有 background.js，所以这里只负责「候选」，
 * 真正归属由 identifyExtension 用 manifest name 校验。
 */
export function pickServiceWorkerTargets(targets, extensionId) {
  const list = Array.isArray(targets) ? targets : [];
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    const t = list[i];
    if (!t || t.type !== 'service_worker') continue;
    const url = String(t.url || '');
    const match = EXT_ID_RE.exec(url);
    if (!match) continue;
    if (extensionId && match[1] !== extensionId) continue;
    out.push({ target: t, extensionId: match[1] });
  }
  return out;
}

/** 轮询 service worker target，最多 timeout 毫秒；返回候选数组（可能为空） */
export async function waitServiceWorker(port, timeout) {
  const limit = typeof timeout === 'number' ? timeout : 10000;
  const deadline = Date.now() + limit;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const targets = await devtoolsJson(port, '/json/list', 4000);
      const hits = pickServiceWorkerTargets(targets, '');
      if (hits.length) return hits;
    } catch (e) {
      lastError = e;
    }
    await sleep(200);
  }
  if (lastError) {
    throw new Error('轮询 /json/list 失败: ' + truncate(lastError.message, 120));
  }
  return [];
}

/** 未打包扩展 ID 推算（Chrome/Edge: sha256(扩展目录绝对路径) 前 32 位 hex 映射到 a-p） */
export function candidateExtensionIds(extensionDir) {
  const absolute = path.resolve(extensionDir);
  const variants = [absolute, absolute.toUpperCase(), absolute.toLowerCase()];
  const seen = new Set();
  const ids = [];
  variants.forEach(function (variant) {
    const digest = crypto.createHash('sha256').update(variant, 'utf8').digest('hex');
    const id = digest.slice(0, 32).split('').map(function (hexChar) {
      return String.fromCharCode(97 + parseInt(hexChar, 16));
    }).join('');
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  });
  return ids;
}

async function launchOnce(options) {
  const extensionDir = path.resolve(options.extensionDir);
  const headless = options.headless === true;
  const port = await freePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-e2e-profile-'));

  const args = [
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profileDir,
    '--load-extension=' + extensionDir,
    '--disable-extensions-except=' + extensionDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-sandbox',
    '--remote-allow-origins=*',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-default-apps',
    '--metrics-recording-only',
    // 关键：窗口移到屏幕外时，避免 Windows 原生遮挡检测把渲染器判为不可见，
    // 否则 headed 兜底模式下 Input.dispatchMouseEvent 会一直等不到渲染器 ack。
    '--disable-features=CalculateNativeWinOcclusion,Translate,OptimizationHints',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-ipc-flooding-protection',
    '--mute-audio'
  ];

  if (headless) {
    args.unshift('--headless=new');
  } else {
    args.push('--window-position=-2000,-2000', '--window-size=1280,900');
  }
  args.push('about:blank');

  const proc = spawn(EDGE_PATH, args, { stdio: 'ignore', windowsHide: true });

  // 等 DevTools 端口就绪
  const deadline = Date.now() + 25000;
  let version = null;
  let lastError = null;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error('浏览器进程提前退出, code=' + proc.exitCode);
    }
    try {
      version = await devtoolsJson(port, '/json/version', 3000);
      if (version && version.webSocketDebuggerUrl) break;
    } catch (e) {
      lastError = e;
    }
    await sleep(200);
  }
  if (!version || !version.webSocketDebuggerUrl) {
    throw new Error('DevTools 端口未就绪: ' + truncate(lastError && lastError.message, 120));
  }

  const browser = new CDP(version.webSocketDebuggerUrl);
  await browser.connect(10000);

  return {
    proc: proc,
    port: port,
    profileDir: profileDir,
    headless: headless,
    mode: headless ? 'headless=new' : 'headed(off-screen)',
    browserVersion: version.Browser || '',
    browser: browser,
    async close() {
      try {
        await browser.send('Browser.close', {}, 3000);
      } catch (e) {
        /* 已关闭 */
      }
      browser.close();
      await sleep(300);
      try {
        if (proc.exitCode === null) proc.kill();
      } catch (e) {
        /* 已退出 */
      }
      await sleep(200);
      for (let attempt = 0; attempt < 12; attempt += 1) {
        try {
          fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 80 });
          break;
        } catch (e) {
          await sleep(250);
        }
      }
    }
  };
}

/**
 * 打开某个 chrome-extension://<id>/popup/popup.html 并读 chrome.runtime.getManifest()。
 * 用于把「候选 ID」核实成真正的 Element Swap 扩展（Edge 自带扩展也有 background.js）。
 * @returns {Promise<{extensionId:string, name:string, version:string}|null>}
 */
async function probeExtension(port, browser, id, expectedName) {
  if (!ID_PATTERN.test(id)) return null;
  let targetId = null;
  let conn = null;
  let created = null;
  try {
    created = await browser.send('Target.createTarget', { url: 'about:blank' }, 6000);
    targetId = created.targetId;
    conn = new CDP(devtoolsUrl(port, targetId));
    await conn.connect(6000);
    await conn.send('Page.enable', {}, 4000);
    await conn.send('Page.navigate', { url: 'chrome-extension://' + id + '/popup/popup.html' }, 6000);

    for (let i = 0; i < 20; i += 1) {
      await sleep(100);
      let info = null;
      try {
        info = await evaluate(conn, `(function () {
          try {
            if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.getManifest) return null;
            var m = chrome.runtime.getManifest();
            return { id: chrome.runtime.id, name: m && m.name, version: m && m.version, href: location.href };
          } catch (e) { return null; }
        })()`, { timeout: 4000 });
      } catch (e) {
        info = null;
      }
      if (info && info.id === id) {
        if (expectedName && info.name !== expectedName) return null; // 不是目标扩展（Edge 内置扩展等）
        return { extensionId: id, name: String(info.name || ''), version: String(info.version || '') };
      }
    }
    return null;
  } catch (e) {
    return null;
  } finally {
    if (conn) conn.close();
    if (targetId) {
      try {
        await browser.send('Target.closeTarget', { targetId: targetId }, 3000);
      } catch (e) {
        /* 忽略 */
      }
    }
  }
}

/**
 * 启动浏览器（自动选择 headless / headed 兜底）并解析扩展 ID。
 * @returns {Promise<object>} 浏览器句柄 + extensionId + 首个页面 target
 */
export async function launchBrowserWithExtension(options) {
  const opts = options || {};
  const extensionDir = path.resolve(opts.extensionDir || '');
  const expectedName = opts.expectedName || '';

  expect(fs.existsSync(EDGE_PATH), '找不到 Edge: ' + EDGE_PATH);
  expect(fs.existsSync(path.join(extensionDir, 'manifest.json')), '扩展目录缺少 manifest.json');

  const attempts = [];
  const modes = opts.modes || [true, false];
  let handle = null;
  let extensionId = '';
  let swTarget = null;
  const notes = [];

  for (let i = 0; i < modes.length; i += 1) {
    const headless = modes[i];
    const modeLabel = headless ? 'headless=new' : 'headed(off-screen)';
    let current = null;
    try {
      current = await launchOnce({ extensionDir: extensionDir, headless: headless });
    } catch (e) {
      attempts.push(modeLabel + ': 启动失败 ' + truncate(e.message, 120));
      continue;
    }

    // 1) 契约路径：service worker target（可能含 Edge 自带扩展，需要校验）
    let swCandidates = [];
    try {
      swCandidates = await waitServiceWorker(current.port, 10000);
    } catch (e) {
      attempts.push(modeLabel + ': 轮询 target 失败 ' + truncate(e.message, 120));
    }

    // 扩展安装可能比 DevTools 端口慢，这里在 20s 内反复重试识别（避免误判为「该模式不支持扩展」）
    const identifyDeadline = Date.now() + 20000;
    let round = 0;
    while (!handle && Date.now() < identifyDeadline) {
      round += 1;
      let ids = [];
      try {
        const again = await waitServiceWorker(current.port, 1);
        ids = again.map(function (hit) {
          return hit.extensionId;
        });
        if (ids.length) swCandidates = again;
      } catch (e) {
        /* 忽略：用上一轮候选 */
      }

      const candidates = [];
      const seen = new Set();
      // 路径哈希推算值优先（通常恰好命中），再补 service worker 候选
      candidateExtensionIds(extensionDir).concat(
        swCandidates.map(function (hit) {
          return hit.extensionId;
        })
      ).concat(ids).forEach(function (id) {
        if (!seen.has(id)) {
          seen.add(id);
          candidates.push(id);
        }
      });

      for (let c = 0; c < candidates.length; c += 1) {
        const probed = await probeExtension(current.port, current.browser, candidates[c], expectedName);
        if (!probed) continue;
        extensionId = probed.extensionId;
        const matchedSw = swCandidates.filter(function (hit) {
          return hit.extensionId === extensionId;
        })[0];
        swTarget = matchedSw ? matchedSw.target : null;
        notes.push('扩展 ID 校验通过（manifest.name=' + probed.name + ', version=' + probed.version + ', 识别轮次=' + round + '）');
        notes.push(swTarget ? 'service_worker target 存在: ' + swTarget.url : '未在 /json/list 里看到该扩展的 service_worker target');
        handle = current;
        break;
      }
      if (!handle) await sleep(600);
    }
    if (handle) break;

    attempts.push(modeLabel + ': 未识别出目标扩展（轮次 ' + round + '）');
    await current.close();
  }

  expect(handle, '浏览器无法加载扩展，尝试记录: ' + JSON.stringify(attempts));
  expect(extensionId, '无法解析扩展 ID');

  // 首个页面 target（about:blank）作为主页面目标；没有就新建一个
  const targets = await devtoolsJson(handle.port, '/json/list', 5000);
  let pageTarget = (targets || []).filter(function (t) {
    return t && t.type === 'page' && !String(t.url || '').startsWith('chrome-extension://');
  })[0];

  if (!pageTarget) {
    const created = await handle.browser.send('Target.createTarget', { url: 'about:blank' }, 6000);
    pageTarget = { id: created.targetId, type: 'page', url: 'about:blank' };
  }

  handle.extensionId = extensionId;
  handle.serviceWorkerTarget = swTarget;
  handle.pageTargetId = pageTarget.id;
  handle.notes = notes;
  handle.launchAttempts = attempts;
  handle.pageConnection = async function pageConnection() {
    const conn = new CDP(devtoolsUrl(handle.port, handle.pageTargetId));
    await conn.connect(8000);
    return conn;
  };

  // 若刚才是「推算 ID」路径，可能残留一个探测用的 popup tab，清掉以免干扰 chrome.tabs 断言
  try {
    const after = await devtoolsJson(handle.port, '/json/list', 5000);
    const strays = (after || []).filter(function (t) {
      return t && t.type === 'page' && String(t.url || '').indexOf('chrome-extension://' + extensionId + '/popup/') === 0;
    });
    for (let i = 0; i < strays.length; i += 1) {
      await handle.browser.send('Target.closeTarget', { targetId: strays[i].id }, 3000);
    }
  } catch (e) {
    /* 清理失败不影响主流程 */
  }

  return handle;
}