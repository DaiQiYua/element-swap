#!/usr/bin/env node
/**
 * Element Swap — 端到端自动化测试夹具（零依赖）
 *
 * 用真实 Edge（--headless=new）加载未打包扩展，通过自研极简 CDP 客户端驱动：
 *   - 静态校验 + 扩展加载
 *   - hide / video 两类规则的真实页面效果（image / embed 已下线：仅静默忽略）
 *   - 撤销恢复、popup 面板渲染、可视化拾取器、无内容脚本页面
 *
 * 用法：
 *   node tests/e2e.mjs                # 跑全部
 *   node tests/e2e.mjs --only=3,7     # 只跑指定用例
 *   node tests/e2e.mjs --headed       # 强制先试非 headless（调试用）
 *
 * 退出码：有失败 → 1，否则 0。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureFixtureAssets } from './lib/assets.mjs';
import { launchBrowserWithExtension, devtoolsUrl, devtoolsJson } from './lib/browser.mjs';
import { CDP, evaluate } from './lib/cdp.mjs';
import { startServer } from './lib/server.mjs';
import { expect, safeJson, sleep, skip, truncate, waitForState } from './lib/util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(HERE, '..');
const FIXTURES_DIR = path.join(HERE, 'fixtures');
const CASE_TIMEOUT = 15000;
// 6 / 9 都要驱动真实拾取器（前台化 + 合成鼠标事件 + 面板交互），单独放宽；
// 13 要额外起一条「抖音域」target（Fetch 兜文档）并跑两轮 popup 抓流，同样放宽
const CASE_TIMEOUT_OVERRIDE = { 6: 20000, 9: 20000, 13: 40000 };

/* ================================================================== *
 * 参数解析
 * ================================================================== */
function parseArgs(argv) {
  const out = { only: null, headedFirst: false };
  argv.slice(2).forEach(function (arg) {
    if (arg.indexOf('--only=') === 0) {
      const ids = arg.slice('--only='.length).split(',').map(function (v) {
        return Number(String(v).trim());
      }).filter(function (v) {
        return Number.isFinite(v) && v > 0;
      });
      out.only = new Set(ids);
    } else if (arg === '--headed') {
      out.headedFirst = true;
    }
  });
  return out;
}

const ARGS = parseArgs(process.argv);

/* ================================================================== *
 * 上下文工具
 * ================================================================== */
function extUrl(ctx, relPath) {
  return 'chrome-extension://' + ctx.extensionId + '/' + relPath;
}

function extEval(ctx, expression, options) {
  return evaluate(ctx.popupConn, expression, options);
}

/** 等待页面完成加载，并（可选）等待内容脚本注入 */
async function navigate(ctx, url, options) {
  const opts = options || {};
  const timeout = typeof opts.timeout === 'number' ? opts.timeout : 12000;
  const waitContentScript = opts.waitContentScript !== false;

  const res = await ctx.pageConn.send('Page.navigate', { url: url }, 8000);
  if (res && res.errorText) {
    // 偶发：扩展刚装载时，DNR 规则集注册与首次导航可能挤在同一个窗口里，
    // 表现为一次 net::ERR_HTTP_RESPONSE_CODE_FAILURE（重试即好）。只对导航类错误重试一次。
    if (/ERR_HTTP_RESPONSE_CODE_FAILURE|ERR_ABORTED/.test(String(res.errorText))) {
      await sleep(600);
      const retry = await ctx.pageConn.send('Page.navigate', { url: url }, 8000);
      if (retry && !retry.errorText) {
        // 重试成功：继续走下面的就绪等待
      } else if (retry && retry.errorText) {
        throw new Error('导航失败 ' + url + ': ' + retry.errorText);
      }
    } else {
      throw new Error('导航失败 ' + url + ': ' + res.errorText);
    }
  }

  const predicate = waitContentScript
    ? "(document.readyState === 'complete' && document.documentElement && document.documentElement.hasAttribute('data-es-loaded'))"
    : "(document.readyState === 'complete')";

  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const ready = await evaluate(ctx.pageConn, predicate, { timeout: 4000 });
      if (ready) return true;
    } catch (e) {
      lastError = e; // 导航中执行上下文会被销毁，属预期
    }
    await sleep(100);
  }
  throw new Error('页面就绪超时 ' + url + (lastError ? ' / ' + truncate(lastError.message, 120) : ''));
}

/** 清空 es_rules（每个用例独立的起点） */
async function resetRules(ctx) {
  await ensurePopup(ctx);
  const result = await extEval(ctx, `new Promise(function (resolve) {
    chrome.storage.local.remove(['es_rules'], function () {
      resolve({ ok: !chrome.runtime.lastError, error: chrome.runtime.lastError ? chrome.runtime.lastError.message : '' });
    });
  })`);
  expect(result && result.ok, '清空 es_rules 失败: ' + safeJson(result));
}

async function readRulesStorage(ctx) {
  return extEval(ctx, `new Promise(function (resolve) {
    chrome.storage.local.get(['es_rules'], function (res) { resolve(res && res.es_rules ? res.es_rules : {}); });
  })`);
}

async function addRule(ctx, rule, scope) {
  const payloadScope = scope || 'domain';
  const result = await extEval(ctx, `ES.addRule(${JSON.stringify(ctx.pageUrl)}, ${JSON.stringify(payloadScope)}, ${JSON.stringify(rule)})
    .then(function (r) { return { ok: true, rule: r }; }, function (e) { return { ok: false, error: String(e && e.message || e) }; })`);
  expect(result && result.ok, 'ES.addRule 失败: ' + safeJson(result));
  return result.rule;
}

/** 从扩展上下文向测试页面标签页发消息 */
async function sendToPage(ctx, message) {
  const expression = `new Promise(function (resolve) {
    chrome.tabs.query({}, function (tabs) {
      var list = (tabs || []).filter(function (t) { return /^https?:\\/\\//i.test(t.url || ''); });
      var tab = null;
      for (var i = 0; i < list.length; i += 1) {
        if ((list[i].url || '').indexOf(${JSON.stringify(ctx.pageOrigin)}) === 0) { tab = list[i]; break; }
      }
      if (!tab) return resolve({ ok: false, error: 'tab-not-found', count: list.length });
      chrome.tabs.sendMessage(tab.id, ${JSON.stringify(message)}, function (response) {
        var err = chrome.runtime.lastError;
        if (err) return resolve({ ok: false, error: err.message, tabId: tab.id });
        resolve({ ok: true, response: response, tabId: tab.id });
      });
    });
  })`;
  return extEval(ctx, expression);
}

/**
 * 建（或复用）扩展 popup 标签页连接，并在其加载前挂上错误采集钩子。
 * 注意：popup 用「真实标签页」打开，chrome.tabs 能力与扩展弹窗一致。
 */
async function ensurePopup(ctx) {
  if (ctx.popupConn && !ctx.popupConn.closed) return ctx.popupConn;

  const created = await ctx.browser.send('Target.createTarget', { url: 'about:blank' }, 8000);
  ctx.popupTargetId = created.targetId;
  const conn = new CDP(devtoolsUrl(ctx.port, created.targetId));
  await conn.connect(8000);
  ctx.popupConn = conn;

  conn.on('Runtime.exceptionThrown', function (params) {
    const details = (params && params.exceptionDetails) || {};
    const text = (details.exception && (details.exception.description || details.exception.value)) || details.text || '未知异常';
    ctx.popupExceptions.push(String(text).split('\n')[0]);
  });

  await conn.send('Page.enable', {}, 5000);
  await conn.send('Runtime.enable', {}, 5000);
  try {
    await conn.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.__esErrors = [];
        window.addEventListener('error', function (e) { window.__esErrors.push('error: ' + String(e.message || e.error)); });
        window.addEventListener('unhandledrejection', function (e) { window.__esErrors.push('rejection: ' + String(e.reason && e.reason.message || e.reason)); });`
    }, 5000);
  } catch (e) {
    /* 注入失败不致命：还有 Runtime.exceptionThrown */
  }

  const res = await conn.send('Page.navigate', { url: extUrl(ctx, 'popup/popup.html') }, 8000);
  if (res && res.errorText) throw new Error('打开 popup 失败: ' + res.errorText);
  await waitForState(
    function () {
      return evaluate(conn, `({ ready: document.readyState, hasEs: typeof ES !== 'undefined', hasChrome: typeof chrome !== 'undefined' && !!chrome.tabs })`);
    },
    function (s) {
      return s.ready === 'complete' && s.hasEs && s.hasChrome;
    },
    { timeout: 8000, label: 'popup 页就绪' }
  );
  return conn;
}

/** 把测试页面标签页设为活动标签页（popup 用 active:true 查询），然后重载 popup */
async function refreshPopupAgainstPage(ctx) {
  await ctx.browser.send('Target.activateTarget', { targetId: ctx.pageTargetId }, 5000);
  await sleep(250);
  await ctx.popupConn.send('Page.reload', { ignoreCache: true }, 8000);
  await waitForState(
    function () {
      return evaluate(ctx.popupConn, `document.readyState`);
    },
    function (s) {
      return s === 'complete';
    },
    { timeout: 8000, label: 'popup 重载完成' }
  );
}

/* ================================================================== *
 * 用例
 * ================================================================== */
const CASES = [];

/* ---------- 1. 清单与静态校验 ---------- */
CASES.push({
  id: 1,
  name: '清单与静态校验',
  async run() {
    const manifestPath = path.join(EXT_DIR, 'manifest.json');
    expect(fs.existsSync(manifestPath), 'manifest.json 不存在');

    const raw = fs.readFileSync(manifestPath, 'utf8');
    let manifest = null;
    let parseError = '';
    try {
      manifest = JSON.parse(raw);
    } catch (e) {
      parseError = e.message;
    }
    expect(manifest, 'manifest.json 不是合法 JSON: ' + parseError);

    const problems = [];
    if (manifest.manifest_version !== 3) problems.push('manifest_version≠3(' + String(manifest.manifest_version) + ')');
    if (!manifest.name) problems.push('缺少 name');
    if (!/^\d+(\.\d+){1,3}$/.test(String(manifest.version || ''))) problems.push('version 格式异常(' + manifest.version + ')');
    if (!manifest.background || !manifest.background.service_worker) problems.push('缺少 background.service_worker');
    if (!manifest.action || !manifest.action.default_popup) problems.push('缺少 action.default_popup');
    if (!Array.isArray(manifest.content_scripts) || manifest.content_scripts.length === 0) problems.push('缺少 content_scripts[]');
    if (!Array.isArray(manifest.permissions) || manifest.permissions.indexOf('storage') === -1) problems.push('permissions 缺少 storage');

    // 清单实际引用的 JS 全部动态收集（不写死数量）：
    //   background.service_worker + 所有 content_scripts[].js（含 world:MAIN 的条目）
    //   + action.default_popup 页面里 <script src> 引用的脚本（按 popup 目录解析相对路径）
    const manifestJs = [];
    if (manifest.background && manifest.background.service_worker) manifestJs.push(manifest.background.service_worker);
    (manifest.content_scripts || []).forEach(function (entry) {
      (entry.js || []).forEach(function (file) {
        manifestJs.push(file);
      });
    });

    const popupPage = manifest.action && manifest.action.default_popup;
    const popupJs = [];
    if (popupPage) {
      const popupAbsolute = path.join(EXT_DIR, popupPage);
      if (!fs.existsSync(popupAbsolute)) {
        problems.push('action.default_popup 文件不存在: ' + popupPage);
      } else {
        const popupHtml = fs.readFileSync(popupAbsolute, 'utf8');
        const scriptRe = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
        let match = null;
        while ((match = scriptRe.exec(popupHtml))) {
          const src = String(match[1] || '').trim();
          if (!src) continue;
          if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.indexOf('//') === 0) continue; // 外链不参与 --check
          popupJs.push(path.posix.normalize(path.posix.join(path.posix.dirname(popupPage), src)));
        }
      }
    }
    popupJs.forEach(function (file) {
      manifestJs.push(file);
    });

    const uniqueFiles = Array.from(new Set(manifestJs));
    expect(uniqueFiles.length > 0, '清单没有引用任何 JS（manifest / popup html 解析异常）: ' + safeJson({ popupPage: popupPage, popupJs: popupJs }));

    const checks = uniqueFiles.map(function (file) {
      const absolute = path.join(EXT_DIR, file);
      const exists = fs.existsSync(absolute);
      if (!exists) return { file: file, ok: false, detail: '文件不存在' };
      const result = spawnSync(process.execPath, ['--check', absolute], { encoding: 'utf8', timeout: 15000 });
      const ok = result.status === 0;
      return {
        file: file,
        ok: ok,
        detail: ok ? 'ok' : truncate(String(result.stderr || result.stdout || '').split('\n').slice(0, 2).join(' '), 160)
      };
    });
    const badFiles = checks.filter(function (c) {
      return !c.ok;
    });
    if (badFiles.length) problems.push('node --check 失败: ' + safeJson(badFiles));

    // 覆盖性断言：清单里出现的每一个脚本都必须真的进了 node --check，不允许漏检
    const checkedFiles = new Set(checks.map(function (c) {
      return c.file;
    }));
    const uncovered = uniqueFiles.filter(function (file) {
      return !checkedFiles.has(file);
    });
    if (uncovered.length) problems.push('清单引用的脚本未被 node --check 覆盖: ' + safeJson(uncovered));
    const uncoveredContentScripts = [];
    (manifest.content_scripts || []).forEach(function (entry) {
      (entry.js || []).forEach(function (file) {
        if (!checkedFiles.has(file)) uncoveredContentScripts.push(file + (entry.world ? ' (world:' + entry.world + ')' : ''));
      });
    });
    if (uncoveredContentScripts.length) problems.push('content_scripts 条目未被 node --check 覆盖: ' + safeJson(uncoveredContentScripts));

    expect(problems.length === 0, problems.join(' | '));
    return {
      evidence: {
        name: manifest.name,
        version: manifest.version,
        mv: manifest.manifest_version,
        jsChecked: checks.length,
        jsOk: checks.length - badFiles.length,
        jsFiles: uniqueFiles
      }
    };
  }
});

/* ---------- 2. 扩展加载 ---------- */
CASES.push({
  id: 2,
  name: '扩展加载（ID + service worker）',
  async run(ctx) {
    expect(/^[a-p]{32}$/.test(ctx.extensionId), '扩展 ID 格式异常: ' + ctx.extensionId);

    const list = await devtoolsJson(ctx.port, '/json/list', 6000);
    const sw = (list || []).filter(function (t) {
      return t && t.type === 'service_worker' && String(t.url || '') === 'chrome-extension://' + ctx.extensionId + '/background.js';
    })[0];
    expect(sw && sw.webSocketDebuggerUrl, '找不到扩展的 service_worker target（扩展可能未加载）');

    // SW 冷启动瞬间求值可能拿到空对象，这里带重试；同时记录每次的原始返回便于取证
    const probeAttempts = [];
    let swProbe = null;

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const swConn = new CDP(sw.webSocketDebuggerUrl);
      try {
        await swConn.connect(6000);
        try {
          await swConn.send('Runtime.enable', {}, 4000);
        } catch (e) {
          /* worker 目标未提供 Runtime.enable 时不致命 */
        }
        const raw = await swConn.send('Runtime.evaluate', {
          expression: `JSON.stringify((function () {
            var out = { alive: true };
            try {
              out.runtimeId = (chrome && chrome.runtime && chrome.runtime.id) || '';
              out.hasStorage = !!(chrome && chrome.storage && chrome.storage.local);
              out.hasOnMessage = !!(chrome && chrome.runtime && chrome.runtime.onMessage);
            } catch (e) {
              out.error = String(e && e.message || e);
            }
            return out;
          })())`,
          awaitPromise: true,
          returnByValue: true
        }, 6000);

        const value = raw && raw.result ? raw.result.value : undefined;
        let parsed = null;
        try {
          parsed = JSON.parse(String(value));
        } catch (e) {
          parsed = null;
        }
        probeAttempts.push({ attempt: attempt, value: truncate(String(value), 160), exception: raw && raw.exceptionDetails ? truncate(raw.exceptionDetails.text || '', 80) : '' });
        if (parsed && parsed.runtimeId === ctx.extensionId) {
          swProbe = parsed;
          break;
        }
      } catch (e) {
        probeAttempts.push({ attempt: attempt, error: truncate(e.message, 160) });
      } finally {
        swConn.close();
      }
      await sleep(400);
    }

    expect(swProbe, 'service worker 求值未拿到有效扩展上下文，尝试记录: ' + safeJson(probeAttempts, 600));
    expect(swProbe.runtimeId === ctx.extensionId,
      'service worker 内 chrome.runtime.id 校验失败（期望 ' + ctx.extensionId + '）: ' + safeJson(swProbe));
    expect(swProbe.hasStorage === true, 'service worker 内 chrome.storage.local 不可用: ' + safeJson(swProbe));

    return {
      evidence: {
        extensionId: ctx.extensionId,
        mode: ctx.mode,
        browser: ctx.browserVersion,
        swUrl: 'chrome-extension://' + ctx.extensionId + '/background.js',
        swProbe: swProbe,
        probeAttempts: probeAttempts.length
      }
    };
  }
});

/* ---------- 3. 隐藏生效并持久化 ---------- */
CASES.push({
  id: 3,
  name: '隐藏规则生效并持久化',
  async run(ctx) {
    await resetRules(ctx);
    await navigate(ctx, ctx.pageUrl);

    const baseline = await evaluate(ctx.pageConn, `(function () {
      var el = document.getElementById('ad-banner');
      return el ? getComputedStyle(el).display : 'missing';
    })()`);
    expect(baseline !== 'none', '#ad-banner 基线状态已是隐藏（页面夹具异常）: ' + baseline);

    await addRule(ctx, { kind: 'hide', selector: '#ad-banner' }, 'domain');
    await navigate(ctx, ctx.pageUrl); // 重新导航 = 刷新，同时验证持久化

    const snapshot = await waitForState(
      function () {
        return evaluate(ctx.pageConn, `(function () {
          var el = document.getElementById('ad-banner');
          var style = document.querySelector('style[data-es-internal]#es-hide-rules');
          return {
            display: el ? getComputedStyle(el).display : 'missing',
            css: style ? String(style.textContent) : '',
            internalStyleCount: document.querySelectorAll('style[data-es-internal]').length,
            online: navigator.onLine
          };
        })()`);
      },
      function (s) {
        return s.display === 'none';
      },
      { timeout: 8000, label: '隐藏规则生效' }
    );

    expect(snapshot.css.indexOf('#ad-banner') !== -1,
      '内部样式未包含 remove selector: ' + safeJson(snapshot.css, 160));

    const stored = await readRulesStorage(ctx);
    const siteKey = 'domain:127.0.0.1';
    const bucket = stored[siteKey];
    expect(bucket && Array.isArray(bucket.rules) && bucket.rules.length === 1,
      'es_rules 存储桶结构不符预期: ' + safeJson(stored));
    expect(bucket.rules[0].kind === 'hide', '存储里的规则 kind 不是 hide: ' + safeJson(bucket.rules[0]));
    expect(bucket.rules[0].selector === '#ad-banner', '存储里的规则 selector 不符: ' + safeJson(bucket.rules[0].selector));

    return {
      evidence: {
        baselineDisplay: baseline,
        display: snapshot.display,
        siteKey: siteKey,
        ruleCount: bucket.rules.length,
        internalCssIncludesSelector: snapshot.css.indexOf('#ad-banner') !== -1
      }
    };
  }
});

/* ---------- 4. 视频直链原地替换（同类型改写） ---------- */
CASES.push({
  id: 4,
  name: '视频直链原地替换（同类型改写）',
  async run(ctx) {
    await resetRules(ctx);
    await navigate(ctx, ctx.pageUrl);

    const targetUrl = ctx.baseUrl + '/video/replaced.mp4';
    const rule = await addRule(ctx, { kind: 'video', selector: '#movie', payload: { url: targetUrl } }, 'domain');
    await navigate(ctx, ctx.pageUrl);

    const snapshot = await waitForState(
      function () {
        return evaluate(ctx.pageConn, `(function () {
          var el = document.getElementById('movie');
          if (!el) return { exists: false };
          return {
            exists: true,
            src: el.getAttribute('src'),
            applied: el.getAttribute('data-es-applied'),
            backupRaw: el.getAttribute('data-es-backup'),
            hasOrigHtml: el.hasAttribute('data-es-orig-html'),
            replacementCount: document.querySelectorAll('[data-es-replacement]').length,
            videoCount: document.querySelectorAll('video').length,
            hiddenCount: document.querySelectorAll('[data-es-hidden]').length
          };
        })()`);
      },
      function (s) {
        return s.exists && s.src === targetUrl && !!s.applied;
      },
      { timeout: 8000, label: '视频原地替换生效' }
    );

    let backup = null;
    try {
      backup = JSON.parse(snapshot.backupRaw || 'null');
    } catch (e) {
      backup = null;
    }

    expect(snapshot.src === targetUrl, '#movie 的 src 未被改写为直链: ' + safeJson(snapshot.src));
    expect(!!snapshot.applied, '#movie 缺少 data-es-applied: ' + safeJson(snapshot));
    expect(!!backup, 'data-es-backup 不是合法 JSON: ' + safeJson(truncate(String(snapshot.backupRaw), 160)));
    expect(backup.ruleId === snapshot.applied,
      'data-es-backup.ruleId 与 data-es-applied 不一致: ' + safeJson({ backupRuleId: backup.ruleId, applied: snapshot.applied }));
    expect(backup.attrs && backup.attrs.src === '/video/orig.mp4',
      'data-es-backup.attrs.src 备份不符预期: ' + safeJson(backup && backup.attrs));
    expect(snapshot.hasOrigHtml === true, '#movie 缺少 data-es-orig-html 备份: ' + safeJson(snapshot));
    expect(snapshot.replacementCount === 0,
      '同类型替换应是原地改写，不应插入 [data-es-replacement] 节点: ' + snapshot.replacementCount);
    expect(snapshot.videoCount === 1, '页面上 video 元素数量应为 1（未新增节点）: ' + snapshot.videoCount);
    expect(snapshot.hiddenCount === 0, '原地改写不应留下 [data-es-hidden]: ' + snapshot.hiddenCount);

    return {
      evidence: {
        src: snapshot.src,
        applied: snapshot.applied,
        ruleIdFromAddRule: rule && rule.id,
        backupSrc: backup && backup.attrs ? backup.attrs.src : null,
        origHtmlBackedUp: snapshot.hasOrigHtml,
        replacementCount: snapshot.replacementCount,
        videoCount: snapshot.videoCount,
        hiddenCount: snapshot.hiddenCount,
        note: '夹具 mp4 仅 ftyp+mdat 外壳，无头环境下媒体管线会停，故只断言 DOM 与 src'
      }
    };
  }
});

/* ---------- 5. 视频跨类型替换 ---------- */
CASES.push({
  id: 5,
  name: '视频规则跨类型替换（img → video）',
  async run(ctx) {
    await resetRules(ctx);
    await navigate(ctx, ctx.pageUrl);

    const videoUrl = ctx.baseUrl + '/video/replaced.mp4';
    await addRule(ctx, { kind: 'video', selector: '#hero', payload: { url: videoUrl } }, 'domain');
    await navigate(ctx, ctx.pageUrl);

    const snapshot = await waitForState(
      function () {
        return evaluate(ctx.pageConn, `(function () {
          var replacement = document.querySelector('[data-es-replacement]');
          var hero = document.getElementById('hero');
          return {
            replacementCount: document.querySelectorAll('[data-es-replacement]').length,
            replacementTag: replacement ? replacement.localName : '',
            replacementSrc: replacement ? replacement.getAttribute('src') : '',
            inserted: replacement ? replacement.getAttribute('data-es-inserted') : '',
            heroDisplay: hero ? getComputedStyle(hero).display : 'missing',
            heroHiddenTokens: hero ? hero.getAttribute('data-es-hidden') : null
          };
        })()`);
      },
      function (s) {
        return s.replacementTag === 'video' && s.replacementSrc === videoUrl && s.heroDisplay === 'none';
      },
      { timeout: 8000, label: '视频替换生效' }
    );

    expect(snapshot.replacementTag === 'video', '未插入 video 替换节点: ' + safeJson(snapshot));
    expect(snapshot.heroDisplay === 'none', '原 img#hero 未被隐藏: ' + safeJson(snapshot));
    expect(snapshot.heroHiddenTokens && snapshot.heroHiddenTokens.length > 0,
      '原 img#hero 缺少 data-es-hidden 令牌: ' + safeJson(snapshot.heroHiddenTokens));

    return {
      evidence: {
        replacementTag: snapshot.replacementTag,
        replacementSrc: snapshot.replacementSrc,
        inserted: snapshot.inserted,
        heroDisplay: snapshot.heroDisplay,
        note: '夹具 mp4 仅 ftyp+mdat 外壳，不强求可解码，因此只断言 DOM 与 src'
      }
    };
  }
});

/* ---------- 6. 面板操作入口收敛为两种 ---------- */
CASES.push({
  id: 6,
  name: '面板操作入口收敛为两种',
  async run(ctx) {
    await resetRules(ctx);
    await navigate(ctx, ctx.pageUrl);

    // 合成鼠标事件要求页面标签页在前台，否则 Input.dispatchMouseEvent 会一直卡住
    try {
      await ctx.browser.send('Target.activateTarget', { targetId: ctx.pageTargetId }, 5000);
      await ctx.pageConn.send('Page.bringToFront', {}, 5000);
    } catch (e) {
      /* 非致命 */
    }
    await sleep(250);

    const startRes = await sendToPage(ctx, { type: 'es:start-pick' });
    expect(startRes && startRes.ok, '发送 es:start-pick 失败: ' + safeJson(startRes));
    expect(startRes.response && startRes.response.ok === true, 'start-pick 响应异常: ' + safeJson(startRes.response));

    // 走真实拾取器：对 #hero 派发完整鼠标手势
    const rect = await evaluate(ctx.pageConn, `(function () {
      var el = document.getElementById('hero');
      try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) { el.scrollIntoView(); }
      var r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), width: r.width, height: r.height };
    })()`);
    expect(rect && rect.width > 0 && rect.height > 0, '#hero 不可见（rect 异常）: ' + safeJson(rect));

    const dispatch = async function (params) {
      try {
        await ctx.pageConn.send('Input.dispatchMouseEvent', params, 4000);
      } catch (e) {
        throw new Error('Input.dispatchMouseEvent(' + params.type + ') 失败: ' + truncate(e.message, 160));
      }
    };

    await dispatch({ type: 'mouseMoved', x: rect.x, y: rect.y, button: 'none', buttons: 0 });
    await sleep(120);
    await dispatch({ type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(60);
    await dispatch({ type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', buttons: 0, clickCount: 1 });

    /** 读面板 shadowRoot 的全部可断言状态（面板未出现时 hasPanel=false） */
    const probePanel = function () {
      return evaluate(ctx.pageConn, `(function () {
        var host = document.querySelector('[data-es-ui="panel"]');
        if (!host) return { hasPanel: false, hasRoot: false };
        var root = host.shadowRoot;
        if (!root) return { hasPanel: true, hasRoot: false };
        var kinds = Array.prototype.map.call(root.querySelectorAll('.kind'), function (btn) {
          return {
            kind: btn.getAttribute('data-kind'),
            text: String(btn.textContent || '').trim(),
            pressed: btn.getAttribute('aria-pressed')
          };
        });
        var fieldUrl = root.getElementById('es-field-url');
        var grabRow = root.getElementById('es-grab-row');
        var urlInput = root.getElementById('es-url');
        var inputs = Array.prototype.slice.call(root.querySelectorAll('input'));
        // display:none 的元素 getClientRects() 为空 —— 用它判断「可见」
        var visibleInputs = inputs.filter(function (el) { return el.getClientRects().length > 0; });
        // 面板高度上限 min(calc(100vh-24px),640px)：面板必须整体留在视口内，
        // 「保存并生效」也不能被挤出可视区
        var hostRect = host.getBoundingClientRect();
        var saveBtn = root.getElementById('es-save');
        var saveRect = saveBtn ? saveBtn.getBoundingClientRect() : null;
        var wrapEl = root.querySelector('.wrap');
        var wrapRect = wrapEl ? wrapEl.getBoundingClientRect() : hostRect;
        var directText = Array.prototype.filter.call(root.childNodes, function (n) {
          return n.nodeType === 3;
        }).map(function (n) { return String(n.textContent || ''); }).join('');
        return {
          hasPanel: true,
          hasRoot: true,
          shadowChildCount: root.childElementCount,
          kindCount: kinds.length,
          kinds: kinds,
          pressedTrueCount: root.querySelectorAll('[aria-pressed="true"]').length,
          fieldUrlOn: !!(fieldUrl && fieldUrl.classList.contains('on')),
          grabRowOn: !!(grabRow && grabRow.classList.contains('on')),
          urlInputCount: root.querySelectorAll('input[type=url]').length,
          visibleInputCount: visibleInputs.length,
          visibleInputIds: visibleInputs.map(function (el) { return String(el.id || ''); }).sort(),
          hasUrlInput: !!urlInput,
          // 结构回退为单框：第二个音频输入框与它的字段块都不该再存在
          hasAudioInput: !!root.getElementById('es-audio'),
          hasAudioField: !!root.getElementById('es-field-audio'),
          urlHintText: String(((root.getElementById('es-url-hint') || {}).textContent) || ''),
          trackNoteText: String(((root.getElementById('es-track-note') || {}).textContent) || ''),
          placeholder: urlInput ? String(urlInput.placeholder || '') : '',
          hostHeight: Math.round(hostRect.height),
          hostTop: Math.round(hostRect.top),
          hostBottom: Math.round(hostRect.bottom),
          wrapTop: Math.round(wrapRect.top),
          wrapBottom: Math.round(wrapRect.bottom),
          wrapHeight: Math.round(wrapRect.height),
          maxHeightRatio: wrapEl ? String(getComputedStyle(wrapEl).maxHeight || '') : '',
          bodyClientHeight: (root.querySelector('.body') || {}).clientHeight || -1,
          bodyScrollHeight: (root.querySelector('.body') || {}).scrollHeight || -1,
          bodyIsScrollable: !!(root.querySelector('.body') && root.querySelector('.body').classList.contains('is-scrollable')),
          saveVisible: !!saveRect && saveRect.height > 0
            && saveRect.top >= 0 && saveRect.bottom <= window.innerHeight && saveRect.bottom <= hostRect.bottom + 1,
          saveBottom: saveRect ? Math.round(saveRect.bottom) : -1,
          viewportHeight: window.innerHeight,
          hasHtmlNodes: !!(root.getElementById('es-html') || root.getElementById('es-field-html')),
          hasEmbedNodes: !!(root.getElementById('es-embed') || root.getElementById('es-field-embed')),
          shadowText: String(root.textContent || ''),
          directText: directText,
          tagText: String((root.getElementById('es-tag') || {}).textContent || '')
        };
      })()`);
    };

    const opened = await waitForState(probePanel, function (s) {
      return s.hasPanel === true && s.hasRoot === true && s.kindCount === 2;
    }, { timeout: 8000, label: '拾取面板打开' });

    expect(opened.tagText === 'img', '面板展示的拾取标签不是 img: ' + safeJson(opened.tagText));

    // —— 1) 只有两种操作入口，且文案 / data-kind / 顺序固定
    expect(opened.kindCount === 2, '.kind 数量应为 2: ' + opened.kindCount);
    expect(opened.kinds[0].kind === 'hide', '第 1 个操作入口的 data-kind 应为 hide: ' + safeJson(opened.kinds));
    expect(opened.kinds[1].kind === 'video', '第 2 个操作入口的 data-kind 应为 video: ' + safeJson(opened.kinds));
    expect(opened.kinds[0].text === '隐藏元素', '第 1 个操作入口文案应为「隐藏元素」: ' + safeJson(opened.kinds[0].text));
    expect(opened.kinds[1].text === '替换视频', '第 2 个操作入口文案应为「替换视频」: ' + safeJson(opened.kinds[1].text));

    const panelText = opened.shadowText + opened.directText;
    expect(panelText.indexOf('替换图片') === -1, '面板仍出现「替换图片」文案: ' + safeJson(truncate(panelText, 200)));
    expect(panelText.indexOf('嵌入代码') === -1, '面板仍出现「嵌入代码」文案: ' + safeJson(truncate(panelText, 200)));
    expect(opened.hasHtmlNodes === false, '面板仍存在 #es-html / #es-field-html 节点');
    expect(opened.hasEmbedNodes === false, '面板仍存在 #es-embed / #es-field-embed 节点');

    // —— 2) 初始态：无选中 kind、无可见输入
    expect(opened.pressedTrueCount === 0, '初始态不应有 aria-pressed="true": ' + opened.pressedTrueCount);
    expect(opened.fieldUrlOn === false, '初始态 #es-field-url 不应带 on: ' + safeJson(opened.fieldUrlOn));
    expect(opened.visibleInputCount === 0, '初始态不应有可见 input: ' + opened.visibleInputCount);
    expect(opened.grabRowOn === false, '非抖音域 #es-grab-row 不应带 on: ' + safeJson(opened.grabRowOn));

    // —— 3) 点「替换视频」→ 只出现一个 URL 输入框（整段粘贴时自动分轨，不再有第二个框）
    const clickKind = async function (kind) {
      const res = await evaluate(ctx.pageConn, `(function () {
        var host = document.querySelector('[data-es-ui="panel"]');
        var root = host && host.shadowRoot;
        if (!root) return { ok: false, error: 'no-shadow-root' };
        var btn = root.querySelector('.kind[data-kind="${kind}"]');
        if (!btn) return { ok: false, error: 'kind-button-missing' };
        btn.click();
        return { ok: true };
      })()`);
      expect(res && res.ok, '点击 .kind[data-kind=' + kind + '] 失败: ' + safeJson(res));
    };

    await clickKind('video');
    const videoState = await waitForState(probePanel, function (s) {
      return s.fieldUrlOn === true && s.visibleInputCount === 1;
    }, { timeout: 4000, label: '选中「替换视频」后出现唯一输入框' });

    expect(videoState.fieldUrlOn === true, '点「替换视频」后 #es-field-url 未加 on: ' + safeJson(videoState.fieldUrlOn));
    // 结构回退（单框）：只有一个 input[type=url]，旧的 #es-audio / #es-field-audio 全部消失
    expect(videoState.urlInputCount === 1, 'input[type=url] 数量应为 1（只有 #es-url）: ' + videoState.urlInputCount);
    expect(videoState.hasUrlInput === true, '视频态必须存在 #es-url: ' + safeJson(videoState.hasUrlInput));
    expect(videoState.hasAudioInput === false, '视频态不应再有 #es-audio 输入框: ' + safeJson(videoState.hasAudioInput));
    expect(videoState.hasAudioField === false, '视频态不应再有 #es-field-audio 字段块: ' + safeJson(videoState.hasAudioField));
    expect(videoState.visibleInputCount === 1, '可见 input 数量应为 1: ' + videoState.visibleInputCount);
    expect(videoState.visibleInputIds.join(',') === 'es-url',
      '可见输入框应恰为 es-url: ' + safeJson(videoState.visibleInputIds));
    expect(/MP4|B\s?站|抖音/.test(videoState.placeholder), 'placeholder 未命中 /MP4|B\\s?站|抖音/: ' + safeJson(videoState.placeholder));
    expect(videoState.urlHintText.indexOf('MP4 外链') !== -1,
      '输入框文案未命中「MP4 外链」: ' + safeJson(videoState.urlHintText));
    // 上限从 70vh 改为 min(calc(100vh-24px),640px) 后，断言改为更严的「不溢出视口」：
    // 面板上下都在视口内、且「保存并生效」完整可见
    expect(videoState.wrapTop >= 0,
      '视频态面板顶部溢出视口: ' + safeJson({
        wrapTop: videoState.wrapTop, viewport: videoState.viewportHeight, maxHeight: videoState.maxHeightRatio
      }));
    expect(videoState.wrapBottom <= videoState.viewportHeight,
      '视频态面板底部溢出视口: ' + safeJson({
        wrapBottom: videoState.wrapBottom, viewport: videoState.viewportHeight, maxHeight: videoState.maxHeightRatio
      }));
    expect(videoState.saveVisible === true,
      '视频态「保存并生效」按钮被挤出可视区: ' + safeJson({
        saveBottom: videoState.saveBottom, hostTop: videoState.hostTop, viewport: videoState.viewportHeight
      }));
    expect(videoState.kinds.filter(function (k) {
      return k.pressed === 'true';
    }).length === 1, '选中后应恰有一个 aria-pressed="true": ' + safeJson(videoState.kinds));

    // —— 3b) 回归：视口高 400 的矮窗口下，唯一输入框与 hint 仍完整可见
    await ctx.pageConn.send('Emulation.setDeviceMetricsOverride', {
      width: 1000, height: 400, deviceScaleFactor: 1, mobile: false
    }, 8000);
    await sleep(260);
    const probeAt400 = function () {
      return evaluate(ctx.pageConn, `(function () {
        var host = document.querySelector('[data-es-ui="panel"]');
        var root = host && host.shadowRoot;
        if (!root) return { hasPanel: false };
        var body = root.querySelector('.body');
        var input = root.getElementById('es-url');
        var hint = root.getElementById('es-url-hint');
        var wrap = root.querySelector('.wrap');
        var save = root.getElementById('es-save');
        if (!body || !input) return { hasPanel: true, hasBody: !!body, hasInput: !!input };
        var br = body.getBoundingClientRect();
        var ir = input.getBoundingClientRect();
        var hr = hint ? hint.getBoundingClientRect() : null;
        var wr = wrap ? wrap.getBoundingClientRect() : null;
        var sr = save ? save.getBoundingClientRect() : null;
        return {
          hasPanel: true,
          hasBody: true,
          hasInput: true,
          inputCount: root.querySelectorAll('input[type=url]').length,
          viewportHeight: window.innerHeight,
          wrapTop: wr ? Math.round(wr.top) : -1,
          wrapBottom: wr ? Math.round(wr.bottom) : -1,
          bodyTop: Math.round(br.top),
          bodyBottom: Math.round(br.bottom),
          bodyClientHeight: body.clientHeight,
          bodyScrollHeight: body.scrollHeight,
          inputTop: Math.round(ir.top),
          inputBottom: Math.round(ir.bottom),
          inputVisible: ir.width > 0 && ir.height > 0,
          inputInsideBody: ir.top >= br.top - 1 && ir.bottom <= br.bottom + 1,
          hintInsideBody: !!hr && hr.top >= br.top - 1 && hr.bottom <= br.bottom + 1,
          saveInsideViewport: !!sr && sr.top >= 0 && sr.bottom <= window.innerHeight
        };
      })()`);
    };
    const at400 = await waitForState(probeAt400, function (s) {
      return !!s && s.hasPanel === true && s.hasBody === true && s.hasInput === true && s.inputVisible === true;
    }, { timeout: 5000, label: '400 高视口下面板仍可用' });

    expect(at400.viewportHeight === 400, '视口高度覆盖失败（应为 400）: ' + safeJson({ h: at400.viewportHeight }));
    expect(at400.inputCount === 1, '400 高视口下仍应只有 1 个输入框: ' + safeJson(at400.inputCount));
    expect(at400.wrapTop >= 0 && at400.wrapBottom <= at400.viewportHeight,
      '400 高视口下「替换视频」面板溢出视口: ' + safeJson({
        wrapTop: at400.wrapTop, wrapBottom: at400.wrapBottom, viewport: at400.viewportHeight
      }));
    expect(at400.inputVisible === true,
      '400 高视口下 #es-url 不可见: ' + safeJson({ inputVisible: at400.inputVisible }));
    expect(at400.inputInsideBody === true,
      '400 高视口下 #es-url 落在 .body 可视区之外（需要内部滚动才摸得到）: ' + safeJson({
        inputTop: at400.inputTop, inputBottom: at400.inputBottom,
        bodyTop: at400.bodyTop, bodyBottom: at400.bodyBottom,
        bodyClientHeight: at400.bodyClientHeight, bodyScrollHeight: at400.bodyScrollHeight
      }));
    expect(at400.hintInsideBody === true,
      '400 高视口下输入框 hint 落在 .body 可视区之外: ' + safeJson({ hintInsideBody: at400.hintInsideBody }));
    expect(at400.saveInsideViewport === true,
      '400 高视口下「保存并生效」不在视口内: ' + safeJson({ saveInsideViewport: at400.saveInsideViewport }));

    // 还原视口，后续步骤回到真实窗口尺寸
    await ctx.pageConn.send('Emulation.clearDeviceMetricsOverride', {}, 8000);
    await sleep(260);

    // —— 4) 再点「隐藏元素」→ 输入框收起
    await clickKind('hide');
    const hideState = await waitForState(probePanel, function (s) {
      return s.fieldUrlOn === false && s.visibleInputCount === 0;
    }, { timeout: 4000, label: '切回「隐藏元素」后输入框收起' });

    expect(hideState.fieldUrlOn === false, '点「隐藏元素」后 #es-field-url 仍带 on: ' + safeJson(hideState.fieldUrlOn));
    expect(hideState.hasAudioInput === false, '点「隐藏元素」后不应存在 #es-audio: ' + safeJson(hideState.hasAudioInput));
    expect(hideState.visibleInputCount === 0, '点「隐藏元素」后仍有可见 input: ' + hideState.visibleInputCount);
    expect(hideState.visibleInputIds.length === 0, '点「隐藏元素」后仍列出可见输入框: ' + safeJson(hideState.visibleInputIds));
    expect(hideState.kinds.filter(function (k) {
      return k.pressed === 'true';
    }).length === 1, '切回后应恰有一个 aria-pressed="true": ' + safeJson(hideState.kinds));

    // —— 5) 关闭面板 → 宿主移除
    const closed = await evaluate(ctx.pageConn, `(function () {
      var host = document.querySelector('[data-es-ui="panel"]');
      var root = host && host.shadowRoot;
      var btn = root ? root.getElementById('es-close') : null;
      if (!btn) return { ok: false, error: 'close-button-missing' };
      btn.click();
      return { ok: true };
    })()`);
    expect(closed && closed.ok, '点击 #es-close 失败: ' + safeJson(closed));

    const panelGone = await waitForState(
      function () {
        return evaluate(ctx.pageConn, `({
          panelCount: document.querySelectorAll('[data-es-ui="panel"]').length,
          picking: document.documentElement.classList.contains('es-picking'),
          pickerStyle: !!document.getElementById('es-picker-style')
        })`);
      },
      function (s) {
        return s.panelCount === 0;
      },
      { timeout: 5000, label: '关闭后面板宿主被移除' }
    );
    expect(panelGone.panelCount === 0, '点 #es-close 后面板宿主仍存在: ' + panelGone.panelCount);

    // —— 6) stop-pick 后页面无未捕获异常
    const stopRes = await sendToPage(ctx, { type: 'es:stop-pick' });
    expect(stopRes && stopRes.ok, '发送 es:stop-pick 失败: ' + safeJson(stopRes));
    expect(stopRes.response && stopRes.response.ok === true, 'stop-pick 响应异常: ' + safeJson(stopRes.response));
    await sleep(200);

    const pageExceptions = ctx.pageExceptions.slice(0, 5);
    expect(pageExceptions.length === 0, '测试页面出现未捕获异常: ' + safeJson(pageExceptions));

    return {
      evidence: {
        clickedAt: { x: rect.x, y: rect.y },
        kinds: opened.kinds.map(function (k) {
          return k.kind + ':' + k.text;
        }),
        initial: {
          pressedTrueCount: opened.pressedTrueCount,
          fieldUrlOn: opened.fieldUrlOn,
          visibleInputCount: opened.visibleInputCount,
          grabRowOn: opened.grabRowOn
        },
        afterVideo: {
          fieldUrlOn: videoState.fieldUrlOn,
          urlInputCount: videoState.urlInputCount,
          hasAudioInput: videoState.hasAudioInput,
          hasAudioField: videoState.hasAudioField,
          visibleInputCount: videoState.visibleInputCount,
          visibleInputIds: videoState.visibleInputIds,
          placeholder: videoState.placeholder,
          urlHintText: videoState.urlHintText,
          wrapTop: videoState.wrapTop,
          wrapBottom: videoState.wrapBottom,
          viewportHeight: videoState.viewportHeight,
          maxHeight: videoState.maxHeightRatio,
          saveBottom: videoState.saveBottom
        },
        at400: {
          viewportHeight: at400.viewportHeight,
          wrapTop: at400.wrapTop,
          wrapBottom: at400.wrapBottom,
          inputCount: at400.inputCount,
          inputTop: at400.inputTop,
          inputBottom: at400.inputBottom,
          bodyTop: at400.bodyTop,
          bodyBottom: at400.bodyBottom,
          bodyClientHeight: at400.bodyClientHeight,
          bodyScrollHeight: at400.bodyScrollHeight,
          inputInsideBody: at400.inputInsideBody,
          hintInsideBody: at400.hintInsideBody,
          saveInsideViewport: at400.saveInsideViewport
        },
        afterHide: {
          fieldUrlOn: hideState.fieldUrlOn,
          hasAudioInput: hideState.hasAudioInput,
          visibleInputCount: hideState.visibleInputCount
        },
        panelRemoved: panelGone.panelCount === 0,
        pageExceptions: pageExceptions
      }
    };
  }
});

/* ---------- 7. 撤销 / 恢复 ---------- */
CASES.push({
  id: 7,
  name: '撤销恢复（hide + video 两条规则）',
  async run(ctx) {
    await resetRules(ctx);
    await navigate(ctx, ctx.pageUrl);

    const targetUrl = ctx.baseUrl + '/video/replaced.mp4';
    await addRule(ctx, { kind: 'hide', selector: '#ad-banner' }, 'domain');
    await addRule(ctx, { kind: 'video', selector: '#movie', payload: { url: targetUrl } }, 'domain');
    await navigate(ctx, ctx.pageUrl);

    const appliedSnapshot = await waitForState(
      function () {
        return evaluate(ctx.pageConn, `(function () {
          var hero = document.getElementById('hero');
          var movie = document.getElementById('movie');
          var banner = document.getElementById('ad-banner');
          var link = document.getElementById('link');
          return {
            bannerDisplay: banner ? getComputedStyle(banner).display : 'missing',
            heroSrc: hero ? String(hero.getAttribute('src')) : '',
            heroApplied: hero ? hero.getAttribute('data-es-applied') : 'no-hero',
            movieSrc: movie ? String(movie.getAttribute('src')) : '',
            movieApplied: movie ? movie.getAttribute('data-es-applied') : 'no-movie',
            linkDisplay: link ? getComputedStyle(link).display : 'missing',
            replacements: document.querySelectorAll('[data-es-replacement]').length,
            hiddenTokens: document.querySelectorAll('[data-es-hidden]').length
          };
        })()`);
      },
      function (s) {
        return s.bannerDisplay === 'none' && s.movieSrc === targetUrl && !!s.movieApplied;
      },
      { timeout: 10000, label: 'hide + video 两条规则生效' }
    );

    expect(appliedSnapshot.bannerDisplay === 'none', '#ad-banner 的 display 应为 none: ' + safeJson(appliedSnapshot.bannerDisplay));
    expect(appliedSnapshot.movieSrc === targetUrl, '#movie 的 src 应被改写为直链: ' + safeJson(appliedSnapshot.movieSrc));
    expect(!!appliedSnapshot.movieApplied, '#movie 缺少 data-es-applied: ' + safeJson(appliedSnapshot));
    expect(appliedSnapshot.heroSrc === '/img/orig.png',
      '未被规则命中的 #hero 的 src 不应变化: ' + safeJson(appliedSnapshot.heroSrc));
    expect(appliedSnapshot.heroApplied === null,
      '未被规则命中的 #hero 不应带 data-es-applied: ' + safeJson(appliedSnapshot.heroApplied));
    expect(appliedSnapshot.linkDisplay !== 'none', '未被规则命中的 #link 不应被隐藏: ' + safeJson(appliedSnapshot.linkDisplay));
    expect(appliedSnapshot.replacements === 0,
      '两条规则都不产生替换节点，[data-es-replacement] 应为 0: ' + appliedSnapshot.replacements);
    expect(appliedSnapshot.hiddenTokens === 0,
      '两条规则都不产生隐藏令牌，[data-es-hidden] 应为 0: ' + appliedSnapshot.hiddenTokens);

    // 存储清空 + 通知内容脚本
    const cleared = await extEval(ctx, `ES.clearForUrl(${JSON.stringify(ctx.pageUrl)})
      .then(function () { return { ok: true }; }, function (e) { return { ok: false, error: String(e && e.message || e) }; })`);
    expect(cleared && cleared.ok, 'ES.clearForUrl 失败: ' + safeJson(cleared));

    const notified = await sendToPage(ctx, { type: 'es:rules-changed' });
    expect(notified && notified.ok, '向页面发送 es:rules-changed 失败: ' + safeJson(notified));

    const restoredSnapshot = await waitForState(
      function () {
        return evaluate(ctx.pageConn, `(function () {
          var hero = document.getElementById('hero');
          var movie = document.getElementById('movie');
          var banner = document.getElementById('ad-banner');
          var link = document.getElementById('link');
          var hideStyle = document.querySelector('style#es-hide-rules');
          return {
            bannerDisplay: banner ? getComputedStyle(banner).display : 'missing',
            heroSrc: hero ? String(hero.getAttribute('src')) : '',
            movieSrc: movie ? String(movie.getAttribute('src')) : '',
            linkDisplay: link ? getComputedStyle(link).display : 'missing',
            movieApplied: movie ? movie.getAttribute('data-es-applied') : 'no-movie',
            movieBackup: movie ? movie.getAttribute('data-es-backup') : 'no-movie',
            replacements: document.querySelectorAll('[data-es-replacement]').length,
            hiddenTokens: document.querySelectorAll('[data-es-hidden]').length,
            hideCss: hideStyle ? String(hideStyle.textContent) : '',
            internalStyles: document.querySelectorAll('style[data-es-internal]').length
          };
        })()`);
      },
      function (s) {
        return s.bannerDisplay === 'flex'
          && s.movieSrc === '/video/orig.mp4'
          && s.movieApplied === null
          && s.replacements === 0
          && s.hiddenTokens === 0
          && s.internalStyles === 0;
      },
      { timeout: 10000, label: '规则撤销后恢复原状' }
    );

    expect(restoredSnapshot.bannerDisplay === 'flex',
      '#ad-banner 的 display 应恢复为 flex: ' + safeJson(restoredSnapshot.bannerDisplay));
    expect(restoredSnapshot.movieSrc === '/video/orig.mp4',
      '#movie 的 src 应恢复为原值: ' + safeJson(restoredSnapshot.movieSrc));
    expect(restoredSnapshot.movieApplied === null, '#movie 仍带 data-es-applied: ' + safeJson(restoredSnapshot.movieApplied));
    expect(restoredSnapshot.movieBackup === null,
      '#movie 仍带 data-es-backup: ' + safeJson(truncate(String(restoredSnapshot.movieBackup), 80)));
    expect(restoredSnapshot.linkDisplay !== 'none', '#link 不应被隐藏: ' + safeJson(restoredSnapshot.linkDisplay));
    expect(restoredSnapshot.replacements === 0, '仍残留 [data-es-replacement] 节点: ' + restoredSnapshot.replacements);
    expect(restoredSnapshot.hiddenTokens === 0, '仍残留 [data-es-hidden] 标记: ' + restoredSnapshot.hiddenTokens);
    expect(restoredSnapshot.internalStyles === 0,
      '仍残留 style[data-es-internal] 节点: ' + restoredSnapshot.internalStyles);
    expect(!restoredSnapshot.hideCss.trim(), '隐藏样式仍有残留内容: ' + safeJson(restoredSnapshot.hideCss, 120));

    const storedAfter = await readRulesStorage(ctx);
    expect(Object.keys(storedAfter).length === 0, '存储未清空: ' + safeJson(storedAfter));

    return {
      evidence: {
        before: {
          banner: appliedSnapshot.bannerDisplay,
          movieSrc: appliedSnapshot.movieSrc,
          heroSrc: appliedSnapshot.heroSrc,
          replacements: appliedSnapshot.replacements,
          hiddenTokens: appliedSnapshot.hiddenTokens
        },
        after: {
          banner: restoredSnapshot.bannerDisplay,
          movieSrc: restoredSnapshot.movieSrc,
          linkDisplay: restoredSnapshot.linkDisplay,
          replacements: restoredSnapshot.replacements,
          hiddenTokens: restoredSnapshot.hiddenTokens,
          internalStyles: restoredSnapshot.internalStyles,
          storedBuckets: Object.keys(storedAfter).length
        }
      }
    };
  }
});

/* ---------- 8. popup 面板 ---------- */
CASES.push({
  id: 8,
  name: 'popup 面板渲染（直链 / B 站 / 旧版忽略提示 / 两段式清除）',
  async run(ctx) {
    await ensurePopup(ctx);
    await resetRules(ctx);
    await navigate(ctx, ctx.pageUrl);

    const directUrl = ctx.baseUrl + '/video/replaced.mp4';
    const biliPageUrl = 'https://www.bilibili.com/video/BV1ZMWd6mE77/';

    await addRule(ctx, { kind: 'hide', selector: '#ad-banner' }, 'domain');
    await addRule(ctx, { kind: 'video', selector: '#movie', payload: { url: directUrl } }, 'domain');
    await addRule(ctx, {
      kind: 'video',
      selector: '#hero',
      payload: { source: { provider: 'bilibili', pageUrl: biliPageUrl } }
    }, 'domain');

    await refreshPopupAgainstPage(ctx);

    /** 读 popup 渲染快照（规则行 / 计数 / 徽标 / 忽略提示 / 空态 / 错误钩子） */
    const probePopup = function () {
      return evaluate(ctx.popupConn, `(function () {
        var list = document.getElementById('ruleList');
        var empty = document.getElementById('emptyState');
        var ignored = document.getElementById('rulesIgnored');
        var clearBtn = document.getElementById('clearBtn');
        var rows = list ? Array.prototype.slice.call(list.querySelectorAll('li.rule')) : [];
        var pick = function (li, selector) {
          var node = li.querySelector(selector);
          return node ? String(node.textContent || '').trim() : '';
        };
        return {
          title: document.title,
          brand: (document.querySelector('.brand-name') || {}).textContent || '',
          rulesTitle: (document.getElementById('rulesTitle') || {}).textContent || '',
          rowCount: rows.length,
          listHidden: list ? !!list.hidden : null,
          emptyHidden: empty ? !!empty.hidden : null,
          emptyClass: empty ? String(empty.className) : '',
          emptyText: (document.getElementById('emptyText') || {}).textContent || '',
          host: (document.getElementById('rulesHost') || {}).textContent || '',
          version: (document.getElementById('appVersion') || {}).textContent || '',
          kinds: rows.map(function (li) { return li.getAttribute('data-kind'); }),
          badges: rows.map(function (li) { return pick(li, '.badge'); }),
          selectors: rows.map(function (li) { return pick(li, '.rule-selector'); }),
          metas: rows.map(function (li) { return pick(li, '.rule-meta'); }),
          ignoredHidden: ignored ? !!ignored.hidden : null,
          ignoredText: ignored ? String(ignored.textContent || '') : '',
          clearDisabled: clearBtn ? !!clearBtn.disabled : null,
          errors: Array.isArray(window.__esErrors) ? window.__esErrors.slice(0, 5) : ['no-hook']
        };
      })()`);
    };

    const populated = await waitForState(probePopup, function (s) {
      return s.rowCount === 3;
    }, { timeout: 10000, label: 'popup 渲染 3 条规则' });

    const hookErrorsOf = function (snapshot) {
      return (snapshot.errors || []).filter(function (e) {
        return e !== 'no-hook';
      });
    };

    expect(populated.title === 'Element Swap', 'popup 标题不符: ' + safeJson(populated.title));
    expect(populated.brand.trim() === 'Element Swap', 'popup 品牌标题不符: ' + safeJson(populated.brand));
    expect(populated.rulesTitle.indexOf('(3)') !== -1, '规则计数文案不符: ' + safeJson(populated.rulesTitle));
    expect(populated.rowCount === 3, '规则列表条目数不符: ' + populated.rowCount);
    expect(populated.emptyHidden === true, '非空态下空态块未隐藏: ' + safeJson(populated.emptyHidden));
    expect(populated.host === '127.0.0.1', '规则域名展示不符: ' + safeJson(populated.host));

    const kindsSorted = populated.kinds.slice().sort().join(',');
    expect(kindsSorted === 'hide,video,video', '列表里的规则类型不符: ' + kindsSorted);

    // 徽标只剩「隐藏」「视频」两种文案
    expect(populated.badges.length === 3, '徽标数量不符: ' + safeJson(populated.badges));
    expect(populated.badges.every(function (b) {
      return b === '隐藏' || b === '视频';
    }), '徽标文案只应有「隐藏」「视频」: ' + safeJson(populated.badges));
    expect(populated.badges.indexOf('隐藏') !== -1 && populated.badges.indexOf('视频') !== -1,
      '徽标未同时覆盖「隐藏」与「视频」: ' + safeJson(populated.badges));

    // 直链行 meta 展示地址尾部；B 站行 meta 展示 B 站 + BV 号
    const directRowIndex = populated.selectors.indexOf('#movie');
    const biliRowIndex = populated.selectors.indexOf('#hero');
    expect(directRowIndex !== -1, '找不到选择器为 #movie 的直链规则行: ' + safeJson(populated.selectors));
    expect(biliRowIndex !== -1, '找不到选择器为 #hero 的 B 站规则行: ' + safeJson(populated.selectors));
    expect(populated.metas[directRowIndex].indexOf('replaced.mp4') !== -1,
      '直链行 meta 未展示 replaced.mp4: ' + safeJson(populated.metas[directRowIndex]));
    expect(populated.metas[biliRowIndex].indexOf('B 站') !== -1,
      'B 站行 meta 未展示「B 站」: ' + safeJson(populated.metas[biliRowIndex]));
    expect(populated.metas[biliRowIndex].indexOf('BV1ZMWd6mE77') !== -1,
      'B 站行 meta 未展示 BV 号: ' + safeJson(populated.metas[biliRowIndex]));

    // 没有旧版规则时，忽略提示必须隐藏
    expect(populated.ignoredHidden === true, '无旧版规则时 #rulesIgnored 应隐藏: ' + safeJson(populated.ignoredHidden));

    const populatedHookErrors = hookErrorsOf(populated);
    expect(populatedHookErrors.length === 0, 'popup 运行时错误(window.onerror/unhandledrejection): ' + safeJson(populatedHookErrors));
    expect(ctx.popupExceptions.length === 0, 'popup 未捕获异常(Runtime.exceptionThrown): ' + safeJson(ctx.popupExceptions.slice(0, 5)));

    // —— 第 2 段：直写两条旧版规则（image / embed），列表不计入、提示可见、存储不删
    await addRule(ctx, { kind: 'image', selector: '#hero', payload: { url: ctx.baseUrl + '/img/replaced.png' } }, 'domain');
    await addRule(ctx, { kind: 'embed', selector: '#link', payload: { html: '<iframe src="/embed.html" width="300" height="150"></iframe>' } }, 'domain');

    const withIgnored = await waitForState(probePopup, function (s) {
      return s.ignoredHidden === false && s.rowCount === 3;
    }, { timeout: 10000, label: '旧版规则忽略提示出现' });

    expect(withIgnored.rowCount === 3, '旧版规则不应进入列表，条目数应仍为 3: ' + withIgnored.rowCount);
    expect(withIgnored.rulesTitle.indexOf('(3)') !== -1, '旧版规则不应计入标题计数: ' + safeJson(withIgnored.rulesTitle));
    expect(withIgnored.ignoredHidden === false, '有旧版规则时 #rulesIgnored 应可见: ' + safeJson(withIgnored.ignoredHidden));
    expect(withIgnored.ignoredText.indexOf('已忽略 2 条旧版') !== -1,
      '忽略提示文案不符: ' + safeJson(withIgnored.ignoredText));

    const storedFive = await readRulesStorage(ctx);
    const storedTotal = Object.keys(storedFive).reduce(function (sum, key) {
      const bucket = storedFive[key];
      return sum + (bucket && Array.isArray(bucket.rules) ? bucket.rules.length : 0);
    }, 0);
    expect(storedTotal === 5, '旧版规则被删除或新增失败（es_rules 共 ' + storedTotal + ' 条，应为 5）: ' + safeJson(Object.keys(storedFive)));

    // —— 第 3 段：两段式清除
    const armed = await evaluate(ctx.popupConn, `(function () {
      var btn = document.getElementById('clearBtn');
      if (!btn) return { ok: false, error: 'clear-button-missing' };
      if (btn.disabled) return { ok: false, error: 'clear-button-disabled' };
      btn.click();
      var label = document.getElementById('clearLabel');
      return {
        ok: true,
        label: label ? String(label.textContent || '') : '',
        armed: btn.classList.contains('is-armed'),
        ariaLabel: String(btn.getAttribute('aria-label') || ''),
        rowCount: document.querySelectorAll('#ruleList li.rule').length
      };
    })()`);
    expect(armed && armed.ok, '第一次点击 #clearBtn 失败: ' + safeJson(armed));
    expect(armed.label === '再点一次确认清除', '#clearLabel 未进入确认态: ' + safeJson(armed.label));
    expect(armed.armed === true, '#clearBtn 未加 is-armed: ' + safeJson(armed));
    expect(armed.rowCount === 3, '第一次点击不应清除规则: ' + armed.rowCount);

    const confirmed = await evaluate(ctx.popupConn, `(function () {
      var btn = document.getElementById('clearBtn');
      if (!btn) return { ok: false, error: 'clear-button-missing' };
      btn.click();
      return { ok: true };
    })()`);
    expect(confirmed && confirmed.ok, '第二次点击 #clearBtn 失败: ' + safeJson(confirmed));

    await waitForState(function () {
      return readRulesStorage(ctx);
    }, function (rules) {
      return Object.keys(rules).length === 0;
    }, { timeout: 10000, label: 'es_rules 被清空' });

    const clearedSnapshot = await waitForState(probePopup, function (s) {
      return s.rowCount === 0 && s.emptyHidden === false;
    }, { timeout: 10000, label: 'popup 回到空态' });

    expect(clearedSnapshot.rulesTitle.indexOf('(0)') !== -1, '空态计数文案不符: ' + safeJson(clearedSnapshot.rulesTitle));
    expect(clearedSnapshot.rowCount === 0, '空态列表条目数不符: ' + clearedSnapshot.rowCount);
    expect(clearedSnapshot.emptyText.trim() === '还没有修改规则，点击上方启动拾取器开始',
      '空态文案不符: ' + safeJson(clearedSnapshot.emptyText));
    expect(clearedSnapshot.emptyClass.indexOf('empty--warn') === -1,
      '页面受支持时空态误标为不支持: ' + safeJson(clearedSnapshot.emptyClass));
    expect(clearedSnapshot.ignoredHidden === true,
      '旧版规则随清空一并移除后 #rulesIgnored 应隐藏: ' + safeJson(clearedSnapshot.ignoredHidden));

    const hookErrors = hookErrorsOf(clearedSnapshot);
    const exceptionErrors = ctx.popupExceptions.slice(0, 5);
    expect(hookErrors.length === 0, 'popup 运行时错误(window.onerror/unhandledrejection): ' + safeJson(hookErrors));
    expect(exceptionErrors.length === 0, 'popup 未捕获异常(Runtime.exceptionThrown): ' + safeJson(exceptionErrors));

    return {
      evidence: {
        populated: {
          rulesTitle: populated.rulesTitle,
          rowCount: populated.rowCount,
          kinds: populated.kinds,
          badges: populated.badges,
          directMeta: populated.metas[directRowIndex],
          biliMeta: populated.metas[biliRowIndex],
          ignoredHidden: populated.ignoredHidden,
          host: populated.host,
          version: populated.version
        },
        legacyIgnored: {
          rowCount: withIgnored.rowCount,
          rulesTitle: withIgnored.rulesTitle,
          ignoredText: withIgnored.ignoredText,
          storedTotal: storedTotal
        },
        afterClear: {
          rulesTitle: clearedSnapshot.rulesTitle,
          rowCount: clearedSnapshot.rowCount,
          emptyText: clearedSnapshot.emptyText,
          emptyHidden: clearedSnapshot.emptyHidden,
          ignoredHidden: clearedSnapshot.ignoredHidden
        },
        errors: hookErrors.concat(exceptionErrors)
      }
    };
  }
});

/* ---------- 9. 拾取器 ---------- */
CASES.push({
  id: 9,
  name: '可视化拾取器（start-pick → 点击 → 面板 → stop-pick）',
  async run(ctx) {
    await ensurePopup(ctx);
    await resetRules(ctx);
    await navigate(ctx, ctx.pageUrl);

    // headed 兜底模式下，后台标签页可能收不到合成输入事件，这里先把它拉到前台
    try {
      await ctx.browser.send('Target.activateTarget', { targetId: ctx.pageTargetId }, 5000);
      await ctx.pageConn.send('Page.bringToFront', {}, 5000);
    } catch (e) {
      /* 非致命 */
    }
    await sleep(250);

    const startRes = await sendToPage(ctx, { type: 'es:start-pick' });
    expect(startRes && startRes.ok, '发送 es:start-pick 失败: ' + safeJson(startRes));
    expect(startRes.response && startRes.response.ok === true, 'start-pick 响应异常: ' + safeJson(startRes.response));

    const pickingSnapshot = await waitForState(
      function () {
        return evaluate(ctx.pageConn, `({
          picking: document.documentElement.classList.contains('es-picking'),
          pickerStyle: !!document.getElementById('es-picker-style'),
          internalStyles: document.querySelectorAll('style[data-es-internal]').length
        })`);
      },
      function (s) {
        return s.picking === true && s.pickerStyle === true;
      },
      { timeout: 6000, label: '拾取器进入拾取态' }
    );

    const stateWhilePicking = await sendToPage(ctx, { type: 'es:get-state' });
    expect(stateWhilePicking.response && stateWhilePicking.response.pickerActive === true,
      'es:get-state 未反映 pickerActive=true: ' + safeJson(stateWhilePicking.response));

    // 取 #hero 中心坐标，用真实鼠标事件点选
    const rect = await evaluate(ctx.pageConn, `(function () {
      var el = document.getElementById('hero');
      try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) { el.scrollIntoView(); }
      var r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), width: r.width, height: r.height };
    })()`);
    expect(rect && rect.width > 0 && rect.height > 0, '#hero 不可见（rect 异常）: ' + safeJson(rect));

    const dispatch = async function (params) {
      try {
        await ctx.pageConn.send('Input.dispatchMouseEvent', params, 4000);
      } catch (e) {
        throw new Error('Input.dispatchMouseEvent(' + params.type + ') 失败: ' + truncate(e.message, 160));
      }
    };

    await dispatch({ type: 'mouseMoved', x: rect.x, y: rect.y, button: 'none', buttons: 0 });
    await sleep(120);
    await dispatch({ type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(60);
    await dispatch({ type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', buttons: 0, clickCount: 1 });

    const panel = await waitForState(
      function () {
        return evaluate(ctx.pageConn, `(function () {
          var host = document.querySelector('[data-es-ui="panel"]');
          var anyUi = document.querySelector('[data-es-ui]');
          var tagNode = host && host.shadowRoot ? host.shadowRoot.getElementById('es-tag') : null;
          return {
            hasPanelHost: !!host,
            shadowChildCount: host && host.shadowRoot ? host.shadowRoot.childElementCount : -1,
            pickedTag: tagNode ? String(tagNode.textContent) : '',
            anyUiKind: anyUi ? String(anyUi.getAttribute('data-es-ui')) : '',
            picking: document.documentElement.classList.contains('es-picking'),
            pickerStyle: !!document.getElementById('es-picker-style')
          };
        })()`);
      },
      function (s) {
        return s.hasPanelHost === true && s.shadowChildCount > 0;
      },
      { timeout: 8000, label: '拾取面板打开' }
    );

    expect(panel.hasPanelHost, '点击后未出现 [data-es-ui="panel"] 宿主节点: ' + safeJson(panel));
    expect(panel.shadowChildCount > 0, '面板 shadowRoot 为空: ' + safeJson(panel));
    expect(panel.pickedTag === 'img', '面板展示的拾取标签不是 img: ' + safeJson(panel.pickedTag));

    const stateAfterPick = await sendToPage(ctx, { type: 'es:get-state' });
    expect(stateAfterPick.response && stateAfterPick.response.ok === true, 'es:get-state 异常: ' + safeJson(stateAfterPick.response));
    expect(stateAfterPick.response.pickerActive === false,
      '选中后面板应已退出拾取态(pickerActive=false): ' + safeJson(stateAfterPick.response));

    const stopRes = await sendToPage(ctx, { type: 'es:stop-pick' });
    expect(stopRes && stopRes.ok, '发送 es:stop-pick 失败: ' + safeJson(stopRes));
    expect(stopRes.response && stopRes.response.ok === true, 'stop-pick 响应异常: ' + safeJson(stopRes.response));

    const exited = await waitForState(
      function () {
        return evaluate(ctx.pageConn, `({
          picking: document.documentElement.classList.contains('es-picking'),
          pickerStyle: !!document.getElementById('es-picker-style'),
          pickerActive: null
        })`);
      },
      function (s) {
        return s.picking === false && s.pickerStyle === false;
      },
      { timeout: 6000, label: '拾取器退出' }
    );

    const stateFinal = await sendToPage(ctx, { type: 'es:get-state' });
    expect(stateFinal.response && stateFinal.response.pickerActive === false,
      'stop-pick 后 pickerActive 仍为 true: ' + safeJson(stateFinal.response));

    const pageExceptions = ctx.pageExceptions.slice(0, 5);
    expect(pageExceptions.length === 0, '测试页面出现未捕获异常: ' + safeJson(pageExceptions));

    return {
      evidence: {
        pickingSnapshot: pickingSnapshot,
        clickedAt: { x: rect.x, y: rect.y },
        panel: {
          shadowChildCount: panel.shadowChildCount,
          pickedTag: panel.pickedTag,
          anyUiKind: panel.anyUiKind
        },
        pickerActive: {
          whilePicking: stateWhilePicking.response.pickerActive,
          afterClick: stateAfterPick.response.pickerActive,
          afterStop: stateFinal.response.pickerActive
        },
        pageExceptions: pageExceptions
      }
    };
  }
});

/* ---------- 10. 无内容脚本页面 ---------- */
CASES.push({
  id: 10,
  name: '浏览器内置页不注入内容脚本',
  async run(ctx) {
    const created = await ctx.browser.send('Target.createTarget', { url: 'about:blank' }, 8000);
    const conn = new CDP(devtoolsUrl(ctx.port, created.targetId));
    let result = null;
    try {
      await conn.connect(8000);
      await conn.send('Page.enable', {}, 5000);

      let navigatedTo = '';
      const attempts = [];
      for (const url of ['edge://version', 'chrome://version']) {
        let res = null;
        try {
          res = await conn.send('Page.navigate', { url: url }, 6000);
        } catch (e) {
          attempts.push(url + ': ' + truncate(e.message, 80));
          continue;
        }
        await sleep(700);
        const href = await evaluate(conn, 'location.href', { timeout: 4000 }).catch(function () {
          return '';
        });
        attempts.push(url + ' → ' + truncate(String(href), 60) + (res && res.errorText ? ' (errorText: ' + res.errorText + ')' : ''));
        if (String(href).indexOf(url) === 0) {
          navigatedTo = url;
          break;
        }
      }

      if (!navigatedTo) {
        skip('CDP 无法导航到 edge:// 或 chrome://version（可能被策略拦截），尝试记录: ' + JSON.stringify(attempts));
      }

      result = await evaluate(conn, `(function () {
        return {
          href: location.href,
          title: document.title,
          esLoaded: document.documentElement.hasAttribute('data-es-loaded'),
          internalStyles: document.querySelectorAll('style[data-es-internal]').length,
          esPresent: typeof window.__ES_LOADED__ !== 'undefined',
          hasChrome: typeof chrome !== 'undefined'
        };
      })()`, { timeout: 6000 });

      expect(result.esLoaded === false,
        '内置页被注入了内容脚本（documentElement 带 data-es-loaded）: ' + safeJson(result));
      expect(result.internalStyles === 0, '内置页出现内部样式节点: ' + safeJson(result));
      expect(result.esPresent === false, '内置页出现 window.__ES_LOADED__: ' + safeJson(result));
    } finally {
      conn.close();
      try {
        await ctx.browser.send('Target.closeTarget', { targetId: created.targetId }, 3000);
      } catch (e) {
        /* 忽略 */
      }
    }

    return { evidence: result };
  }
});

/* ---------- 11. 抖音抓流轨选择 ---------- */
/**
 * 注意（能力边界，别把这条用例当成真实抖音回归）：
 *  1. 真实抖音 CDN 流（v11-weba.douyinvod.com/.../media-audio-und-mp4a/）在 E2E 里
 *     无法复现：夹具页是 127.0.0.1，不会去请求抖音，也没有真实的 DASH 播放器。
 *     这里用「与真实 URL 同构的伪造地址」注入候选池，验证的是内容脚本的判轨与排序逻辑。
 *  2. 注入通道是真实存在的：MAIN world 探针 → 内容脚本只走 postMessage，内容脚本
 *     的 onMainProbeMessage 只校验 event.source === window，因此页面自身 postMessage
 *     能真实命中该通道（不是伪造通过，走的就是线上那条路）。
 *  3. es:grab-douyin 只在抖音页可用（handleGrabDouyinMessage 先过 isDouyinPage()，
 *     判 hostname），夹具页拿不到 audio-only 那个回包分支。因此「只有音频轨」的断言
 *     落在 es:probe-stats 的 pickedTrack / pickUrl 上（音频轨永不入选 = 不选它），
 *     并额外断言非抖音页仍回 not-douyin，保证抓流通道的守卫没被改坏。
 *     audio-only 回包的最终文案只能在真实抖音页手工验证。
 */
CASES.push({
  id: 11,
  name: '抖音抓流轨选择（audio / video / muxed）',
  async run(ctx) {
    await resetRules(ctx);

    // 三条伪造地址都与真实抖音流同构：只有 pathname 段不同（query 里同样带 mime_type=video_mp4）
    const AUDIO_URL = 'https://v11-weba.douyinvod.com/8f3d1a2b0c/video/tos/cn/tos-cn-vd-0026/abc123def456/media-audio-und-mp4a/?a=6383&br=60&bt=60&cs=0&ds=1&mime_type=video_mp4';
    const VIDEO_URL = 'https://v11-weba.douyinvod.com/8f3d1a2b0c/video/tos/cn/tos-cn-vd-0026/abc123def456/media-video-avc1/?a=6383&br=2000&bt=2000&mime_type=video_mp4';
    const MUXED_URL = 'https://v11-weba.douyinvod.com/8f3d1a2b0c/video/tos/cn/tos-cn-ve-15/0123456789abcdef0123456789abcdef/?a=6383&btag=80000e00010000&mime_type=video_mp4';

    const probeStats = function () {
      return sendToPage(ctx, { type: 'es:probe-stats' });
    };
    const statsOf = function (res) {
      return (res && res.response) || null;
    };
    /** 每个子场景都要一份「候选池为空」的新文档：换 cache-busting 查询串重载夹具页 */
    const reloadFresh = function (step) {
      return navigate(ctx, ctx.pageUrl + '?escase=11&step=' + step);
    };
    /** 页面自身 postMessage → 内容脚本 onMainProbeMessage（线上同一条通道） */
    const inject = async function (urls) {
      const res = await evaluate(ctx.pageConn, `(function () {
        var list = ${JSON.stringify(urls)};
        for (var i = 0; i < list.length; i += 1) {
          window.postMessage({ __esMainProbe: 1, url: list[i], kind: 'fetch', t: Date.now() }, '*');
        }
        return { ok: true, count: list.length };
      })()`);
      expect(res && res.ok, '注入探针候选失败: ' + safeJson(res));
    };
    const waitStats = function (expectedTotal, label) {
      return waitForState(
        function () {
          return probeStats();
        },
        function (res) {
          const snapshot = statsOf(res);
          return !!snapshot && snapshot.ok === true && snapshot.total === expectedTotal;
        },
        { timeout: 6000, label: label }
      );
    };

    // —— 1) 音频轨 + 纯视频轨 + 合流 → 必须选合流
    await reloadFresh('a');
    await inject([AUDIO_URL, VIDEO_URL, MUXED_URL]);
    const mixed = statsOf(await waitStats(3, '三条候选并入候选池'));
    expect(mixed.audioTracks === 1, '音频轨计数应为 1（pathname 段 /media-audio-und-mp4a/ 未被识别）: ' + safeJson(mixed));
    expect(mixed.videoTracks === 1, '纯视频轨计数应为 1（/media-video-avc1/ 未被识别）: ' + safeJson(mixed));
    expect(mixed.muxedTracks === 1, '合流计数应为 1（/video/tos/ + 哈希结尾 未被识别）: ' + safeJson(mixed));
    expect(mixed.pickedTrack === 'muxed', '三条并存时应选合流轨: ' + safeJson(mixed));
    expect(mixed.pickUrl === MUXED_URL, '选中的应是合流地址: ' + safeJson({ pickUrl: mixed.pickUrl, expect: MUXED_URL }));

    // —— 2) 音频轨 + 纯视频轨（没有合流）→ 选纯视频轨，绝不选音频
    await reloadFresh('b');
    await inject([AUDIO_URL, VIDEO_URL]);
    const videoOnly = statsOf(await waitStats(2, '两条候选并入候选池'));
    expect(videoOnly.audioTracks === 1 && videoOnly.videoTracks === 1,
      '音频/视频轨计数不符: ' + safeJson(videoOnly));
    expect(videoOnly.muxedTracks === 0, '未注入合流时 muxedTracks 应为 0: ' + safeJson(videoOnly));
    expect(videoOnly.pickedTrack === 'video', '没有合流时应选纯视频轨（不是音频）: ' + safeJson(videoOnly));
    expect(videoOnly.pickUrl === VIDEO_URL, '选中的应是纯视频轨地址: ' + safeJson({ pickUrl: videoOnly.pickUrl, expect: VIDEO_URL }));

    // —— 3) 只有音频轨 → 不得当选（pickUrl 为空，pickedTrack 为 null）
    await reloadFresh('c');
    await inject([AUDIO_URL]);
    const audioOnly = statsOf(await waitStats(1, '仅有音频轨一条候选'));
    expect(audioOnly.audioTracks === 1, '音频轨计数应为 1: ' + safeJson(audioOnly));
    expect(audioOnly.videoTracks === 0 && audioOnly.muxedTracks === 0,
      '本子场景不应出现视频/合流轨: ' + safeJson(audioOnly));
    expect(audioOnly.pickedTrack === null, '只有音频轨时不应选出任何候选（音频轨永不入选）: ' + safeJson(audioOnly));
    expect(audioOnly.pickUrl === null, '只有音频轨时 pickUrl 必须为空: ' + safeJson(audioOnly));

    // —— 4) 抓流通道守卫：非抖音页必须回 not-douyin（audio-only 分支只能真实抖音页手工验证）
    const grabRes = await sendToPage(ctx, { type: 'es:grab-douyin' });
    expect(grabRes && grabRes.ok, '发送 es:grab-douyin 失败: ' + safeJson(grabRes));
    const grab = grabRes.response || {};
    expect(grab.ok === false, '夹具页（非抖音）es:grab-douyin 不应成功: ' + safeJson(grab));
    expect(grab.error === 'not-douyin', '夹具页 es:grab-douyin 应回 not-douyin: ' + safeJson(grab));

    return {
      evidence: {
        limit: '真实抖音 CDN 流在 E2E 中无法复现，此处用同构伪造地址注入主探针通道',
        mixed: {
          audioTracks: mixed.audioTracks,
          videoTracks: mixed.videoTracks,
          muxedTracks: mixed.muxedTracks,
          pickedTrack: mixed.pickedTrack,
          pickedIsMuxed: mixed.pickUrl === MUXED_URL
        },
        videoOnly: {
          audioTracks: videoOnly.audioTracks,
          videoTracks: videoOnly.videoTracks,
          muxedTracks: videoOnly.muxedTracks,
          pickedTrack: videoOnly.pickedTrack,
          pickedIsVideo: videoOnly.pickUrl === VIDEO_URL
        },
        audioOnly: {
          audioTracks: audioOnly.audioTracks,
          pickedTrack: audioOnly.pickedTrack,
          pickUrl: audioOnly.pickUrl
        },
        grabGuard: grab.error
      }
    };
  }
});

/* ---------- 12. 双流替换与同步（DASH 分离流：画面轨 + 声音轨） ---------- */
/**
 * 能力边界（别把这条用例当成真实媒体/解码回归）：
 *  1. 视频轨/音频轨都用夹具里的 tone.wav —— MP4 外壳只有 ftyp+mdat（没有 moov），
 *     duration 是 NaN、currentTime 不可写，无法验证同步；WAV 是能真正解码的媒体，
 *     duration / play / seek / currentTime 都正常（--mute-audio 下听不到声音，
 *     但媒体时钟照常推进，断言只看时间数值）。
 *  2. 仍然不断言「解码正确 / 有声音输出」：只断言 DOM 结构（wrapper / video / audio）、
 *     属性（muted / src / 隐藏样式、控件不可聚焦）、尺寸（wrapper 占住原元素盒子），
 *     以及同步逻辑的数值行为（muted/volume 单向映射、倍速跟随、漂移纠偏）。
 *  3. 静音模型：初始 video 与 audio 都 muted（因此可自动播放），首次真实点击 wrapper
 *     才一起解除静音 —— 用例按 a)/b)/c) 三步逐条断言这三个状态。
 *  4. 漂移是**真实**造出来的：先让两条真播一会儿，再把 audio.currentTime 往回拉 1s，
 *     等 500ms 定时器纠偏后比较两者差值 —— 不是打桩，也不是「差值为 0 恒真」。
 */
CASES.push({
  id: 12,
  name: '双流替换与同步（DASH 分离流）',
  async run(ctx) {
    await resetRules(ctx);
    await navigate(ctx, ctx.pageUrl);

    // 双流 wrapper 必须占住与原元素一致的盒子：先记下未应用规则时 #movie 的实测尺寸
    const beforeRect = await evaluate(ctx.pageConn, `(function () {
      var el = document.getElementById('movie');
      if (!el) return null;
      var r = el.getBoundingClientRect();
      return { width: Math.round(r.width), height: Math.round(r.height) };
    })()`);
    expect(beforeRect && beforeRect.width > 0 && beforeRect.height > 0,
      '#movie 替换前不可测量（rect 异常）: ' + safeJson(beforeRect));

    // 同一条可解码音频的两个地址：内容脚本只看「两条地址是否都 http(s)」，不看内容
    const videoUrl = ctx.baseUrl + '/video/tone.wav?v=dual-video';
    const audioUrl = ctx.baseUrl + '/video/tone.wav?a=dual-audio';
    await addRule(ctx, {
      kind: 'video',
      selector: '#movie',
      payload: { url: videoUrl, audioUrl: audioUrl }
    }, 'domain');
    await navigate(ctx, ctx.pageUrl);

    /** 读双流结构快照（wrapper 不存在时 hasWrapper=false） */
    const probePair = function () {
      return evaluate(ctx.pageConn, `(function () {
        var wrapper = document.querySelector('[data-es-media-pair]');
        var movie = document.getElementById('movie');
        var base = {
          pairCount: document.querySelectorAll('[data-es-media-pair]').length,
          audioTotal: document.querySelectorAll('audio').length,
          movieDisplay: movie ? getComputedStyle(movie).display : 'missing',
          movieSrc: movie ? String(movie.getAttribute('src') || '') : '',
          movieApplied: movie ? movie.getAttribute('data-es-applied') : 'no-movie',
          movieBackup: movie ? movie.getAttribute('data-es-backup') : 'no-movie'
        };
        if (!wrapper) return Object.assign(base, { hasWrapper: false });
        var video = wrapper.querySelector('video');
        var audio = wrapper.querySelector('audio');
        var audioStyle = audio ? getComputedStyle(audio) : null;
        var wrapperRect = wrapper.getBoundingClientRect();
        return Object.assign(base, {
          hasWrapper: true,
          videoCount: wrapper.querySelectorAll('video').length,
          audioCount: wrapper.querySelectorAll('audio').length,
          wrapperRect: { width: Math.round(wrapperRect.width), height: Math.round(wrapperRect.height) },
          videoMuted: video ? video.muted === true : null,
          audioMuted: audio ? audio.muted === true : null,
          videoVolume: video ? Number(video.volume) : null,
          audioVolume: audio ? Number(audio.volume) : null,
          videoBox: video ? {
            width: Math.round(video.getBoundingClientRect().width),
            height: Math.round(video.getBoundingClientRect().height)
          } : null,
          videoObjectFit: video ? String(getComputedStyle(video).objectFit || '') : '',
          videoSrc: video ? String(video.getAttribute('src') || '') : '',
          videoControls: video ? video.hasAttribute('controls') : null,
          videoPlaysinline: video ? video.hasAttribute('playsinline') : null,
          videoPreload: video ? String(video.getAttribute('preload') || '') : '',
          audioSrc: audio ? String(audio.getAttribute('src') || '') : '',
          audioPreload: audio ? String(audio.getAttribute('preload') || '') : '',
          audioControls: audio ? audio.hasAttribute('controls') : null,
          audioTabIndex: audio ? String(audio.getAttribute('tabindex') || '') : '',
          audioAriaHidden: audio ? String(audio.getAttribute('aria-hidden') || '') : '',
          audioHiddenAttr: audio ? audio.hasAttribute('hidden') : null,
          audioDisplay: audioStyle ? String(audioStyle.display) : '',
          audioStyleAttr: audio ? String(audio.getAttribute('style') || '') : '',
          audioParent: audio ? String(audio.parentNode && audio.parentNode.getAttribute('data-es-media-pair') || '') : '',
          audioPosition: audioStyle ? String(audioStyle.position) : '',
          audioWidth: audioStyle ? String(audioStyle.width) : '',
          audioHeight: audioStyle ? String(audioStyle.height) : '',
          audioOpacity: audioStyle ? String(audioStyle.opacity) : '',
          audioPointerEvents: audioStyle ? String(audioStyle.pointerEvents) : '',
          videoRate: video ? Number(video.playbackRate) : null,
          audioRate: audio ? Number(audio.playbackRate) : null,
          userActivated: (function () {
            try { return !!(navigator.userActivation && navigator.userActivation.hasBeenActive); } catch (e) { return 'na'; }
          })()
        });
      })()`);
    };

    const structure = await waitForState(probePair, function (s) {
      return s.hasWrapper === true && s.audioCount === 1 && s.videoCount === 1;
    }, { timeout: 8000, label: '双流 wrapper 建立' });

    // —— 1) 结构：wrapper 内 1 个 muted <video> + 1 个可播放但 0 尺寸的 <audio>
    expect(structure.pairCount === 1, '[data-es-media-pair] 数量应为 1: ' + structure.pairCount);
    expect(structure.videoCount === 1, 'wrapper 内 <video> 数量应为 1: ' + structure.videoCount);
    expect(structure.audioCount === 1, 'wrapper 内 <audio> 数量应为 1: ' + structure.audioCount);
    expect(structure.audioTotal === 1, '页面上 <audio> 总数应为 1（重复应用不得插出第二个）: ' + structure.audioTotal);
    // 新静音模型：初始**先按带声音起播**（这是用户反馈的修复点），被拒才降级静音+提示。
    // 因此这里不断言「初始一定 muted」，只断言两条轨的静音状态彼此一致（状态机自洽）。
    expect(structure.videoMuted === structure.audioMuted,
      '两条轨的 muted 状态必须一致（video→audio 单向映射）: '
      + safeJson({ videoMuted: structure.videoMuted, audioMuted: structure.audioMuted }));
    // —— 尺寸：wrapper 必须占住与原元素一致的盒子（宽、高各 ≤ 2px 误差）
    const rectDelta = {
      width: Math.abs(structure.wrapperRect.width - beforeRect.width),
      height: Math.abs(structure.wrapperRect.height - beforeRect.height)
    };
    expect(structure.videoObjectFit === 'cover', '<video> 应为 object-fit:cover: ' + safeJson(structure.videoObjectFit));
    expect(rectDelta.width <= 2 && rectDelta.height <= 2,
      'wrapper 尺寸应与替换前原元素一致（各 ≤ 2px）: ' + safeJson({
        before: beforeRect, wrapper: structure.wrapperRect, delta: rectDelta
      }));
    expect(structure.videoSrc === videoUrl, '<video> src 应为视频轨地址: ' + safeJson(structure.videoSrc));
    expect(structure.audioSrc === audioUrl, '<audio> src 应为音频轨地址: ' + safeJson(structure.audioSrc));
    expect(structure.videoControls === true && structure.videoPlaysinline === true && structure.videoPreload === 'auto',
      '<video> 应带 controls / playsinline / preload=auto: ' + safeJson({
        controls: structure.videoControls, playsinline: structure.videoPlaysinline, preload: structure.videoPreload
      }));
    expect(structure.audioControls === true,
      '<audio> 必须带 controls（否则 UA 样式表强制 display:none）: ' + safeJson(structure.audioControls));
    expect(structure.audioTabIndex === '-1', '<audio> 应带 tabindex=-1（不可聚焦）: ' + safeJson(structure.audioTabIndex));
    expect(structure.audioAriaHidden === 'true', '<audio> 应带 aria-hidden=true: ' + safeJson(structure.audioAriaHidden));
    expect(structure.audioPreload === 'auto', '<audio> 应带 preload=auto: ' + safeJson(structure.audioPreload));

    // 隐藏方式必须是「0 尺寸 + opacity:0」：display:none / hidden 会让浏览器暂停它，声音就没了
    expect(structure.audioDisplay !== 'none', '<audio> 不能用 display:none 隐藏: '
      + safeJson({ display: structure.audioDisplay, style: structure.audioStyleAttr, parent: structure.audioParent }));
    expect(structure.audioHiddenAttr === false, '<audio> 不能带 hidden 属性: ' + safeJson(structure.audioHiddenAttr));
    expect(structure.audioPosition === 'absolute', '<audio> 应为 position:absolute: ' + safeJson(structure.audioPosition));
    expect(structure.audioWidth === '0px' && structure.audioHeight === '0px',
      '<audio> 应为 0 尺寸: ' + safeJson({ w: structure.audioWidth, h: structure.audioHeight }));
    expect(structure.audioOpacity === '0', '<audio> opacity 应为 0: ' + safeJson(structure.audioOpacity));
    expect(structure.audioPointerEvents === 'none', '<audio> pointer-events 应为 none: ' + safeJson(structure.audioPointerEvents));

    // 原元素只被隐藏令牌挡住，不是原地改写（双流要多挂一条 <audio>，塞不进原地）
    expect(structure.movieDisplay === 'none', '原 #movie 应被隐藏: ' + safeJson(structure.movieDisplay));
    expect(structure.movieApplied === null && structure.movieBackup === null,
      '双流不应走原地改写（#movie 不该带 data-es-applied / data-es-backup）: ' + safeJson({
        applied: structure.movieApplied, backup: String(structure.movieBackup).slice(0, 40)
      }));

    // —— 幂等：再刷一次页面，仍只有一个 wrapper / 一条 audio
    await navigate(ctx, ctx.pageUrl);
    const again = await waitForState(probePair, function (s) {
      return s.hasWrapper === true && s.audioCount === 1;
    }, { timeout: 8000, label: '二次应用后仍只有一条 audio' });
    expect(again.pairCount === 1, '二次应用后 [data-es-media-pair] 数量应为 1: ' + again.pairCount);
    expect(again.audioTotal === 1, '二次应用后 <audio> 总数应为 1: ' + again.audioTotal);

    // —— 2) (a) 加载后两条轨都「静音 + 自动播」：静音媒体不受自动播放策略限制
    try {
      await ctx.browser.send('Target.activateTarget', { targetId: ctx.pageTargetId }, 5000);
      await ctx.pageConn.send('Page.bringToFront', {}, 5000);
    } catch (e) {
      /* 非致命 */
    }

    /** 读一次真实播放状态：时间都来自真媒体时钟，muted/volume 来自元素自身状态 */
    const PLAY_MIN = 1.6; // 播到这个位置再制造 1s 漂移，保证漂移量确定大于 0.3s 阈值
    const probePlay = function () {
      return evaluate(ctx.pageConn, `(function () {
        var wrapper = document.querySelector('[data-es-media-pair]');
        if (!wrapper) return { ok: false, error: 'no-wrapper' };
        var video = wrapper.querySelector('video');
        var audio = wrapper.querySelector('audio');
        if (!video || !audio) return { ok: false, error: 'no-media' };
        return {
          ok: true,
          videoPaused: video.paused === true,
          audioPaused: audio.paused === true,
          videoMuted: video.muted === true,
          audioMuted: audio.muted === true,
          videoVolume: Number(video.volume),
          audioVolume: Number(audio.volume),
          videoTime: Number(video.currentTime) || 0,
          audioTime: Number(audio.currentTime) || 0,
          videoDuration: Number(video.duration),
          hasHint: !!wrapper.querySelector('[data-es-audio-hint]')
        };
      })()`);
    };

    const waitPlayState = function (predicate, label, timeout) {
      return waitForState(probePlay, function (s) {
        return s && s.ok === true && predicate(s);
      }, { timeout: typeof timeout === 'number' ? timeout : 8000, label: label }).catch(function (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) };
      });
    };

    // 读 es:probe-stats 里的双流运行态（新增字段，纯内存只读）
    const probePairs = async function () {
      const res = await sendToPage(ctx, { type: 'es:probe-stats' });
      const snapshot = (res && res.response) || null;
      return {
        ok: !!(snapshot && snapshot.ok === true),
        pairs: (snapshot && Array.isArray(snapshot.pairs)) ? snapshot.pairs : []
      };
    };

    // (a) 起播状态：新模型「先按带声音起播」，成功就直接有声；被拒才降级为静音+提示。
    //     这里断言状态机自洽（两轨 muted 一致、提示与 unmuted/播放状态一致），不断言死某一分支。
    const startedState = await waitPlayState(function (s) {
      return s.videoPaused === false && s.videoTime > 0.2;
    }, '画面轨已起播');
    expect(startedState && startedState.ok === true,
      'a) 加载后画面轨应已起播: ' + safeJson(startedState, 600));
    expect(startedState.videoDuration > 0,
      '夹具 tone.wav 应可解码（duration > 0）: ' + safeJson(startedState.videoDuration));
    expect(startedState.videoMuted === startedState.audioMuted,
      'a) 两条轨的 muted 必须一致: ' + safeJson(startedState));

    const startedPairs = await probePairs();
    expect(startedPairs.ok, 'a) es:probe-stats 应回 ok:true: ' + safeJson(startedPairs, 600));
    expect(startedPairs.pairs.length === 1, 'a) es:probe-stats 应给出 1 条双流运行态: ' + safeJson(startedPairs.pairs));
    const pair0 = startedPairs.pairs[0];
    expect(pair0.videoUrl === videoUrl && pair0.audioUrl === audioUrl,
      'a) probe-stats 里的 videoUrl/audioUrl 应等于规则写入的地址: ' + safeJson(pair0));
    expect(pair0.videoMuted === pair0.audioMuted,
      'a) probe-stats 里两轨 muted 必须一致: ' + safeJson(pair0));
    expect(pair0.unmuted === (pair0.videoMuted === false),
      'a) unmuted 与 muted 状态必须自洽: ' + safeJson(pair0));
    // 提示常驻判据：!unmuted 且画面在播 → 提示必须在；已解除静音 → 必须没有
    const expectHint = pair0.unmuted !== true && pair0.videoPaused !== true;
    expect(pair0.hintShown === expectHint,
      'a) 提示应与「未启用声音且画面在播」一致: ' + safeJson(pair0));
    if (pair0.unmuted !== true) {
      expect(pair0.degraded === true, 'a) 未启用声音时应处于降级态: ' + safeJson(pair0));
      const hintText = await evaluate(ctx.pageConn, `(function () {
        var node = document.querySelector('[data-es-media-pair] [data-es-audio-hint]');
        return node ? String(node.textContent || '') : '';
      })()`);
      expect(hintText.indexOf('点击开启声音') !== -1,
        'a) 降级时提示文案应含「点击开启声音」: ' + safeJson(hintText));
    }

    // (b) 真实点击页面**别处**（验证 document 级手势监听）→ 解除静音，声音真正播起来
    const clickTarget = await evaluate(ctx.pageConn, `(function () {
      var el = document.getElementById('ad-banner');
      try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) { el.scrollIntoView(); }
      var r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    await ctx.pageConn.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: clickTarget.x, y: clickTarget.y, button: 'none', buttons: 0
    }, 4000);
    await ctx.pageConn.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: clickTarget.x, y: clickTarget.y, button: 'left', buttons: 1, clickCount: 1
    }, 4000);
    await ctx.pageConn.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: clickTarget.x, y: clickTarget.y, button: 'left', buttons: 0, clickCount: 1
    }, 4000);

    const unmutedState = await waitPlayState(function (s) {
      return s.videoMuted === false && s.audioMuted === false
        && s.audioPaused === false && Number(s.audioVolume) > 0;
    }, '手势后声音轨真正带声音播放', 5000);
    expect(unmutedState && unmutedState.ok === true,
      'b) 手势后应 video.muted=false、audio.muted=false、audio 在播、音量>0: ' + safeJson(unmutedState, 600));
    expect(unmutedState.videoMuted === false && unmutedState.audioMuted === false,
      'b) 手势后两条轨都应为非静音: ' + safeJson(unmutedState));
    expect(unmutedState.audioPaused === false,
      'b) 手势后声音轨必须处于播放中（不能只是取消 muted 却停着）: ' + safeJson(unmutedState));
    expect(Number(unmutedState.audioVolume) > 0,
      'b) 手势后 audio.volume 必须 > 0: ' + safeJson(unmutedState.audioVolume));
    expect(unmutedState.audioVolume === unmutedState.videoVolume,
      'b) audio.volume 应等于 video.volume: ' + safeJson({
        videoVolume: unmutedState.videoVolume, audioVolume: unmutedState.audioVolume
      }));
    expect(unmutedState.hasHint === false, 'b) 解除静音后提示必须消失: ' + safeJson(unmutedState.hasHint));

    const unmutedPairs = await probePairs();
    expect(unmutedPairs.ok && unmutedPairs.pairs.length === 1,
      'b) es:probe-stats 应仍有 1 条双流运行态: ' + safeJson(unmutedPairs, 600));
    expect(unmutedPairs.pairs[0].unmuted === true && unmutedPairs.pairs[0].hintShown === false,
      'b) probe-stats 应显示 unmuted=true 且 hintShown=false: ' + safeJson(unmutedPairs.pairs[0]));

    // 点击落点可能命中 <video> 控件区（切换暂停）：显式恢复播放再进入漂移断言
    await evaluate(ctx.pageConn, `(function () {
      var wrapper = document.querySelector('[data-es-media-pair]');
      if (!wrapper) return { ok: false };
      var video = wrapper.querySelector('video');
      var audio = wrapper.querySelector('audio');
      if (video && video.paused) { var p = video.play(); if (p && p.catch) p.catch(function () {}); }
      if (audio && audio.paused) { var q = audio.play(); if (q && q.catch) q.catch(function () {}); }
      return { ok: true };
    })()`);

    const playState = await waitPlayState(function (s) {
      return s.videoPaused === false && s.audioPaused === false && s.videoTime > PLAY_MIN;
    }, '画面轨与声音轨都在播放（解除静音后）');
    expect(playState && playState.ok === true, '双流应同时在播（暂停时纠偏按设计跳过）: ' + safeJson(playState, 600));

    // —— 3) 漂移纠偏：真播起来后把 audio 往回拉 1s，等 500ms 定时器纠回 <0.3s
    const driftSeeded = await evaluate(ctx.pageConn, `(function () {
      var wrapper = document.querySelector('[data-es-media-pair]');
      if (!wrapper) return { ok: false, error: 'no-wrapper' };
      var video = wrapper.querySelector('video');
      var audio = wrapper.querySelector('audio');
      if (!video || !audio) return { ok: false, error: 'no-media' };
      var before = Number(video.currentTime) || 0;
      // 真实 seek：audio 往回拉 1s（若视频才播到 0.6s，就拉到 0，漂移量按实际值报）
      var target = Math.max(0, before - 1);
      audio.currentTime = target;
      return {
        ok: true,
        videoTime: Number(video.currentTime) || 0,
        audioTime: Number(audio.currentTime) || 0,
        drift: Math.abs((Number(video.currentTime) || 0) - (Number(audio.currentTime) || 0))
      };
    })()`);
    expect(driftSeeded && driftSeeded.ok, '制造音画漂移失败: ' + safeJson(driftSeeded));
    expect(driftSeeded.drift > 0.3, '制造的漂移应超过 0.3s 阈值（否则纠偏无从验证）: ' + safeJson(driftSeeded));

    const driftAfter = await waitPlayState(function (s) {
      return Math.abs(s.videoTime - s.audioTime) < 0.3;
    }, '500ms 纠偏把 audio 拉回 video', 4000);
    expect(driftAfter && driftAfter.ok, '500ms 纠偏没有生效: ' + safeJson(driftAfter, 600));
    expect(Math.abs(driftAfter.videoTime - driftAfter.audioTime) < 0.3,
      '纠偏后 |video.currentTime - audio.currentTime| 应 < 0.3s: ' + safeJson({
        videoTime: driftAfter.videoTime, audioTime: driftAfter.audioTime
      }));

    // —— 4) 倍速跟随：改 video.playbackRate + dispatch ratechange → audio 跟随
    const rateApplied = await evaluate(ctx.pageConn, `(function () {
      var wrapper = document.querySelector('[data-es-media-pair]');
      if (!wrapper) return { ok: false, error: 'no-wrapper' };
      var video = wrapper.querySelector('video');
      var audio = wrapper.querySelector('audio');
      if (!video || !audio) return { ok: false, error: 'no-media' };
      video.playbackRate = 1.5;
      video.dispatchEvent(new Event('ratechange'));
      return { ok: true, videoRate: Number(video.playbackRate), audioRate: Number(audio.playbackRate) };
    })()`);
    expect(rateApplied && rateApplied.ok, '设置 video.playbackRate 失败: ' + safeJson(rateApplied));

    let rateError = '';
    const rateSynced = await waitForState(probePair, function (s) {
      return s.audioRate === 1.5;
    }, { timeout: 3000, label: 'audio 倍速跟随 video' }).catch(function (e) {
      rateError = e && e.message ? e.message : String(e);
      return null;
    });
    expect(rateSynced, 'audio.playbackRate 未跟随 video.playbackRate=1.5: ' + truncate(rateError, 200) + ' / '
      + safeJson({ videoRate: rateApplied.videoRate, audioRate: rateApplied.audioRate }));

    // —— 5) (c) volumechange 单向映射：video 重新静音 → audio 也必须静音（图标 = 事实）
    const muteMapped = await evaluate(ctx.pageConn, `(function () {
      var wrapper = document.querySelector('[data-es-media-pair]');
      if (!wrapper) return { ok: false, error: 'no-wrapper' };
      var video = wrapper.querySelector('video');
      var audio = wrapper.querySelector('audio');
      if (!video || !audio) return { ok: false, error: 'no-media' };
      video.muted = true;                 // 浏览器会自己派发 volumechange，这里再显式补一次
      video.dispatchEvent(new Event('volumechange'));
      return { ok: true, videoMuted: video.muted === true, audioMuted: audio.muted === true };
    })()`);
    expect(muteMapped && muteMapped.ok, '设置 video.muted=true 失败: ' + safeJson(muteMapped));
    const muteState = await waitPlayState(function (s) {
      return s.audioMuted === true;
    }, 'volumechange 把 video.muted 映射到 audio.muted', 3000);
    expect(muteState && muteState.ok === true,
      'c) video.muted=true + volumechange 后 audio.muted 应为 true: ' + safeJson(muteState, 600));

    // —— 6) 降级分支（真实触发）：音频地址换成不被支持的资源 → audio.play() 被拒 →
    //     内容脚本必须降级为「静音播画面 + 立刻提示」，且 document 级手势能解除降级。
    const badAudioUrl = ctx.baseUrl + '/page.html?a=not-media'; // text/html：媒体元素必然不支持
    await extEval(ctx, `ES.clearForUrl(${JSON.stringify(ctx.pageUrl)})
      .then(function () { return { ok: true }; }, function (e) { return { ok: false, error: String(e && e.message || e) }; })`);
    await addRule(ctx, {
      kind: 'video',
      selector: '#movie',
      payload: { url: videoUrl, audioUrl: badAudioUrl }
    }, 'domain');
    await navigate(ctx, ctx.pageUrl);

    const degradedState = await waitPlayState(function (s) {
      return s.videoPaused === false && s.videoTime > 0.2 && s.hasHint === true;
    }, '降级后画面在播且提示已出现', 8000);
    expect(degradedState && degradedState.ok === true,
      '降级分支：画面应在静音播放且提示可见: ' + safeJson(degradedState, 600));
    expect(degradedState.videoMuted === true && degradedState.audioMuted === true,
      '降级分支：两条轨都必须回到 muted=true: ' + safeJson(degradedState));

    const degradedHintText = await evaluate(ctx.pageConn, `(function () {
      var node = document.querySelector('[data-es-media-pair] [data-es-audio-hint]');
      return node ? String(node.textContent || '') : '';
    })()`);
    expect(degradedHintText.indexOf('点击开启声音') !== -1,
      '降级分支：提示文案应含「点击开启声音」: ' + safeJson(degradedHintText));

    const degradedPairs = await probePairs();
    expect(degradedPairs.ok && degradedPairs.pairs.length === 1,
      '降级分支：es:probe-stats 应给出 1 条运行态: ' + safeJson(degradedPairs, 600));
    const degradedPair = degradedPairs.pairs[0];
    expect(degradedPair.unmuted === false && degradedPair.degraded === true && degradedPair.hintShown === true,
      '降级分支：probe-stats 应为 unmuted=false / degraded=true / hintShown=true: ' + safeJson(degradedPair));
    expect(degradedPair.audioUrl === badAudioUrl,
      '降级分支：probe-stats 的 audioUrl 应为坏地址: ' + safeJson(degradedPair.audioUrl));
    expect(String(degradedPair.audioError).length > 0 || degradedPair.audioReadyState <= 0
      || degradedPair.audioPaused === true,
      '降级分支：probe-stats 应能看出声音轨确实没在播: ' + safeJson(degradedPair));

    // 点击页面**别处**（document 级 capture）→ 解除静音并把提示撤掉
    const degradedClickTarget = await evaluate(ctx.pageConn, `(function () {
      var el = document.getElementById('ad-banner');
      try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) { el.scrollIntoView(); }
      var r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    await ctx.pageConn.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: degradedClickTarget.x, y: degradedClickTarget.y, button: 'left', buttons: 1, clickCount: 1
    }, 4000);
    await ctx.pageConn.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: degradedClickTarget.x, y: degradedClickTarget.y, button: 'left', buttons: 0, clickCount: 1
    }, 4000);

    const degradedUnlocked = await waitForState(
      function () { return probePairs(); },
      function (result) {
        return !!(result && result.ok && result.pairs.length === 1
          && result.pairs[0].unmuted === true && result.pairs[0].hintShown === false);
      },
      { timeout: 5000, label: '降级态被 document 级手势解除' }
    ).catch(function (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    });
    expect(degradedUnlocked && degradedUnlocked.ok === true,
      '降级分支：手势应解除静音并撤掉提示: ' + safeJson(degradedUnlocked, 600));
    expect(degradedUnlocked.pairs[0].videoMuted === false && degradedUnlocked.pairs[0].audioMuted === false,
      '降级分支：手势后两轨 muted 应为 false: ' + safeJson(degradedUnlocked.pairs[0]));

    // —— 7) 撤销：wrapper 与 audio 都被移除，原 #movie 恢复
    const cleared = await extEval(ctx, `ES.clearForUrl(${JSON.stringify(ctx.pageUrl)})
      .then(function () { return { ok: true }; }, function (e) { return { ok: false, error: String(e && e.message || e) }; })`);
    expect(cleared && cleared.ok, 'ES.clearForUrl 失败: ' + safeJson(cleared));
    const notified = await sendToPage(ctx, { type: 'es:rules-changed' });
    expect(notified && notified.ok, '向页面发送 es:rules-changed 失败: ' + safeJson(notified));

    const removed = await waitForState(probePair, function (s) {
      return s.pairCount === 0 && s.audioTotal === 0;
    }, { timeout: 8000, label: '撤销后 wrapper 与 audio 被移除' });
    expect(removed.pairCount === 0, '撤销后仍残留 [data-es-media-pair]: ' + removed.pairCount);
    expect(removed.audioTotal === 0, '撤销后仍残留 <audio>: ' + removed.audioTotal);
    expect(removed.movieDisplay !== 'none', '撤销后原 #movie 应恢复可见: ' + safeJson(removed.movieDisplay));
    expect(removed.movieSrc === '/video/orig.mp4', '撤销后原 #movie 的 src 应保持夹具原值: ' + safeJson(removed.movieSrc));

    // 撤销后运行态注册表也应清空（不得残留悬挂条目）
    const afterRevokePairs = await probePairs();
    expect(afterRevokePairs.ok && afterRevokePairs.pairs.length === 0,
      '撤销后 es:probe-stats 的 pairs 应为空: ' + safeJson(afterRevokePairs, 600));

    const pageExceptions = ctx.pageExceptions.slice(0, 5);
    expect(pageExceptions.length === 0, '测试页面出现未捕获异常: ' + safeJson(pageExceptions));

    return {
      evidence: {
        limit: '视频轨/音频轨都用可解码的 tone.wav；不断言音频输出，只断言结构与同步数值',
        // 起播状态机（a）：本环境 sticky activation 已存在 → 直接带声音起播
        start: {
          videoMuted: startedState.videoMuted,
          audioMuted: startedState.audioMuted,
          videoPaused: startedState.videoPaused,
          audioPaused: startedState.audioPaused,
          unmuted: pair0.unmuted,
          degraded: pair0.degraded,
          hintShown: pair0.hintShown
        },
        // 手势后（b）：用户最终真正需要的结果
        afterClick: {
          videoMuted: unmutedState.videoMuted,
          audioMuted: unmutedState.audioMuted,
          audioPaused: unmutedState.audioPaused,
          videoVolume: unmutedState.videoVolume,
          audioVolume: unmutedState.audioVolume,
          hintShown: unmutedState.hasHint
        },
        // probe-stats 运行态字段（b 段实测）
        pairState: unmutedPairs.pairs[0],
        // 降级分支实测
        degrade: {
          hintText: degradedHintText,
          pair: degradedPair
        },
        muteMap: { videoMuted: muteState.videoMuted, audioMuted: muteState.audioMuted },
        box: {
          before: beforeRect,
          wrapper: structure.wrapperRect,
          delta: rectDelta,
          objectFit: structure.videoObjectFit
        },
        structure: {
          pairCount: structure.pairCount,
          videoCount: structure.videoCount,
          audioCount: structure.audioCount,
          audioTotal: structure.audioTotal,
          audioDisplay: structure.audioDisplay,
          audioBox: { width: structure.audioWidth, height: structure.audioHeight, opacity: structure.audioOpacity },
          videoSrcMatches: structure.videoSrc === videoUrl,
          audioSrcMatches: structure.audioSrc === audioUrl,
          originalHidden: structure.movieDisplay,
          inPlaceRewrite: structure.movieApplied !== null || structure.movieBackup !== null
        },
        idempotent: { pairCount: again.pairCount, audioTotal: again.audioTotal },
        playback: {
          videoPaused: playState.videoPaused,
          audioPaused: playState.audioPaused,
          videoTime: playState.videoTime,
          audioTime: playState.audioTime
        },
        rateSync: { videoRate: rateApplied.videoRate, audioRate: rateSynced.audioRate },
        driftSync: {
          seededDrift: driftSeeded.drift,
          afterDrift: Math.abs(driftAfter.videoTime - driftAfter.audioTime),
          videoTime: driftAfter.videoTime,
          audioTime: driftAfter.audioTime
        },
        afterRevoke: {
          pairCount: removed.pairCount,
          audioTotal: removed.audioTotal,
          movieDisplay: removed.movieDisplay,
          movieSrc: removed.movieSrc
        },
        pageExceptions: pageExceptions
      }
    };
  }
});

/* ---------- 13. 复制一次 → 单框粘贴 → 自动分轨 → 保存闭环 ---------- */
/**
 * 用户链路只有两次操作：popup 点一次「复制」（分离流一次给两条，换行分隔），
 * 页内面板只有一个输入框，整段粘进去自动分成画面 / 声音，保存时一起落库。
 *
 * 两条链路都跑线上代码路径：
 *  1) popup 侧：抖音域用 CDP Fetch.fulfillRequest 把文档请求就地兜成夹具页，
 *     标签页 URL 真的是 http://www.douyin.com/...（卡片显示判定、content script 注入、
 *     es:grab-douyin 回包全走线上）；剪贴板用 CDP 覆盖 navigator.clipboard.writeText 捕获实参，
 *     断言复制结果是「画面URL + \n + 声音URL」这一段真实文本。
 *  2) 面板侧：把上一步捕获的那段文本，用真实 paste 事件（ClipboardEvent + DataTransfer）
 *     灌进唯一输入框，断言自动分割、hint 文案、落库 payload 的两条地址。
 *
 * 能力边界（别把这条当成真实抖音 CDN 回归）：
 *  - 没有真实抖音 DASH 播放器与 CDN 流，候选是与真实 URL 同构的伪造地址（注入通道与用例 11 相同）。
 *  - 夹具页在伪造域名下的子资源解析失败，不断言任何解码/播放结果。
 */
CASES.push({
  id: 13,
  name: '复制一次 → 单框粘贴 → 自动分轨 → 保存闭环',
  async run(ctx) {
    await ensurePopup(ctx);
    await resetRules(ctx);

    // 与真实抖音流同构：轨类型只由 pathname 段决定（query 里的 mime_type=video_mp4 音频轨上也有）。
    // 结尾带 .mp4 是为了让 classifyVideoInput 判成直链（douyinvod 域名本身不带媒体语义）。
    const AUDIO_URL = 'https://v11-weba.douyinvod.com/8f3d1a2b0c/video/tos/cn/tos-cn-vd-0026/abc123def456/media-audio-und-mp4a/clip.mp4?a=6383&br=60&mime_type=video_mp4';
    const VIDEO_URL = 'https://v11-weba.douyinvod.com/8f3d1a2b0c/video/tos/cn/tos-cn-vd-0026/abc123def456/media-video-avc1/clip.mp4?a=6383&br=2000&mime_type=video_mp4';
    const PLAIN_URL = ctx.baseUrl + '/video/replaced.mp4';

    /* ============ 1) popup 侧：一个按钮复制两条 ============ */
    const fixtureHtml = fs.readFileSync(path.join(FIXTURES_DIR, 'page.html'), 'utf8');
    const fixtureBody = Buffer.from(fixtureHtml, 'utf8').toString('base64');
    const DOUYIN_PAGE = 'http://www.douyin.com/escase13.html';

    const created = await ctx.browser.send('Target.createTarget', { url: 'about:blank' }, 8000);
    const dyTargetId = created.targetId;
    const dyConn = new CDP(devtoolsUrl(ctx.port, dyTargetId));
    let fulfilledDocs = 0;
    let copiedTwoLine = '';

    try {
      await dyConn.connect(8000);
      await dyConn.send('Page.enable', {}, 5000);
      // 只兜文档请求：把 douyin 域的导航就地 fulfill 成夹具页（子资源解析失败不影响断言）
      await dyConn.send('Fetch.enable', {
        patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }]
      }, 5000);
      dyConn.on('Fetch.requestPaused', function (params) {
        fulfilledDocs += 1;
        dyConn.send('Fetch.fulfillRequest', {
          requestId: params.requestId,
          responseCode: 200,
          responseHeaders: [
            { name: 'content-type', value: 'text/html; charset=utf-8' },
            { name: 'cache-control', value: 'no-store' }
          ],
          body: fixtureBody
        }, 5000).catch(function () {
          /* 端口已关闭 / 已处理，忽略 */
        });
      });

      const loadDouyin = async function (label) {
        const res = await dyConn.send('Page.navigate', { url: DOUYIN_PAGE + '?r=' + Date.now() }, 8000);
        expect(!(res && res.errorText), '导航到抖音域夹具失败: ' + safeJson(res));
        const ready = await waitForState(function () {
          return evaluate(dyConn, `({
            ready: document.readyState,
            href: location.href,
            loaded: document.documentElement.hasAttribute('data-es-loaded')
          })`).catch(function (e) {
            return { ready: '', href: '', loaded: false, error: String(e && e.message || e) };
          });
        }, function (s) {
          return s.ready === 'complete' && s.loaded === true;
        }, { timeout: 12000, label: label });
        expect(String(ready.href).indexOf('www.douyin.com') !== -1,
          '标签页 URL 不是抖音域（popup 卡片不会出现）: ' + safeJson(ready.href));
        return ready;
      };

      /** 从扩展上下文给这条抖音 target 发消息（按 URL 找 tab，不依赖 active） */
      const sendToDouyinTab = function (message) {
        return extEval(ctx, `new Promise(function (resolve) {
          chrome.tabs.query({}, function (tabs) {
            var list = (tabs || []).filter(function (t) {
              return String(t.url || '').indexOf(${JSON.stringify('http://www.douyin.com/')}) === 0;
            });
            if (!list.length) return resolve({ ok: false, error: 'tab-not-found' });
            chrome.tabs.sendMessage(list[0].id, ${JSON.stringify(message)}, function (response) {
              var err = chrome.runtime.lastError;
              if (err) return resolve({ ok: false, error: err.message });
              resolve({ ok: true, response: response });
            });
          });
        })`);
      };

      /** 页面自身 postMessage → 内容脚本 onMainProbeMessage（与用例 11 同一条线上通道） */
      const injectCandidates = function (urls) {
        return evaluate(dyConn, `(function () {
          var list = ${JSON.stringify(urls)};
          for (var i = 0; i < list.length; i += 1) {
            window.postMessage({ __esMainProbe: 1, url: list[i], kind: 'fetch', t: Date.now() }, '*');
          }
          return { ok: true, count: list.length };
        })()`);
      };
      const waitCandidates = function (total, label) {
        return waitForState(function () {
          return sendToDouyinTab({ type: 'es:probe-stats' });
        }, function (res) {
          const snapshot = res && res.response;
          return !!snapshot && snapshot.ok === true && snapshot.total === total;
        }, { timeout: 6000, label: label });
      };

      /** 把抖音 target 设为活动标签页后重载 popup（popup 用 active tab 判定是否显示抖音卡片） */
      const openPopupOnDouyin = async function (label) {
        await ctx.browser.send('Target.activateTarget', { targetId: dyTargetId }, 5000);
        await sleep(250);
        await ctx.popupConn.send('Page.reload', { ignoreCache: true }, 8000);
        await waitForState(function () {
          return evaluate(ctx.popupConn, 'document.readyState');
        }, function (s) {
          return s === 'complete';
        }, { timeout: 8000, label: label + '（popup 重载）' });
        return waitForState(function () {
          return evaluate(ctx.popupConn, `(function () {
            var card = document.getElementById('douyinCard');
            return { hidden: card ? !!card.hidden : null };
          })()`);
        }, function (s) {
          return s.hidden === false;
        }, { timeout: 8000, label: label + '（抖音卡片出现）' });
      };

      /** CDP 覆盖剪贴板：捕获真实写入的实参（按钮点的是线上代码路径） */
      const stubClipboard = function () {
        return evaluate(ctx.popupConn, `(function () {
          window.__esCopied = [];
          try {
            Object.defineProperty(navigator.clipboard, 'writeText', {
              configurable: true,
              writable: true,
              value: function (text) {
                window.__esCopied.push(String(text));
                return Promise.resolve();
              }
            });
            return { ok: true };
          } catch (e) {
            return { ok: false, error: String(e && e.message || e) };
          }
        })()`);
      };

      const grabInPopup = async function (label) {
        const res = await evaluate(ctx.popupConn, `(function () {
          var btn = document.getElementById('douyinGrabBtn');
          if (!btn) return { ok: false, error: 'grab-button-missing' };
          btn.click();
          return { ok: true };
        })()`);
        expect(res && res.ok, '点击 #douyinGrabBtn 失败: ' + safeJson(res));
        return waitForState(function () {
          return evaluate(ctx.popupConn, `(function () {
            var result = document.getElementById('douyinResult');
            var err = document.getElementById('douyinError');
            return {
              resultHidden: result ? !!result.hidden : null,
              errorHidden: err ? !!err.hidden : null,
              errorText: err ? String(err.textContent || '') : ''
            };
          })()`);
        }, function (s) {
          if (s.errorHidden === false) throw new Error('popup 抓流报错: ' + safeJson(s.errorText));
          return s.resultHidden === false;
        }, { timeout: 10000, label: label });
      };

      const probeCard = function () {
        return evaluate(ctx.popupConn, `(function () {
          var pick = function (id) {
            var el = document.getElementById(id);
            if (!el) return null;
            return {
              hidden: !!el.hidden,
              text: String(el.textContent || ''),
              title: String(el.getAttribute('title') || ''),
              ariaLabel: String(el.getAttribute('aria-label') || '')
            };
          };
          var rows = Array.prototype.slice.call(document.querySelectorAll('#douyinResult .douyin-row'));
          return {
            url: pick('douyinUrl'),
            audio: pick('douyinAudio'),
            rowAudio: pick('douyinRowAudio'),
            copySingle: pick('douyinCopyBtn'),
            copyButtons: rows.map(function (row) {
              return Array.prototype.map.call(row.querySelectorAll('button'), function (btn) {
                return String(btn.id || '');
              });
            }).reduce(function (all, ids) { return all.concat(ids); }, []),
            hasSplitVideoBtn: !!document.getElementById('douyinCopyVideoBtn'),
            hasSplitAudioBtn: !!document.getElementById('douyinCopyAudioBtn'),
            copied: Array.isArray(window.__esCopied) ? window.__esCopied.slice() : null,
            toast: String((document.getElementById('toast') || {}).textContent || ''),
            errors: Array.isArray(window.__esErrors) ? window.__esErrors.slice(0, 5) : ['no-hook']
          };
        })()`);
      };

      const clickCopy = async function (id) {
        const res = await evaluate(ctx.popupConn, `(function () {
          var btn = document.getElementById(${JSON.stringify(id)});
          if (!btn) return { ok: false, error: 'button-missing' };
          if (btn.hidden) return { ok: false, error: 'button-hidden' };
          btn.click();
          return { ok: true };
        })()`);
        expect(res && res.ok, '点击 ' + id + ' 失败: ' + safeJson(res));
      };

      // 1-a) DASH 场景：只有一个复制按钮，一次复制两条
      await loadDouyin('抖音域夹具加载');
      const injectedBoth = await injectCandidates([AUDIO_URL, VIDEO_URL]);
      expect(injectedBoth && injectedBoth.ok, '注入双轨候选失败: ' + safeJson(injectedBoth));
      await waitCandidates(2, '双轨候选并入候选池');
      await openPopupOnDouyin('DASH 场景');
      const clipboardStub = await stubClipboard();
      expect(clipboardStub && clipboardStub.ok, '覆盖 navigator.clipboard.writeText 失败: ' + safeJson(clipboardStub));
      await grabInPopup('DASH 场景抓流完成');

      const dashCard = await probeCard();
      expect(dashCard.hasSplitVideoBtn === false, '不应再存在 #douyinCopyVideoBtn: ' + safeJson(dashCard));
      expect(dashCard.hasSplitAudioBtn === false, '不应再存在 #douyinCopyAudioBtn: ' + safeJson(dashCard));
      expect(dashCard.copyButtons.join(',') === 'douyinCopyBtn',
        '结果区应只有一个复制按钮: ' + safeJson(dashCard.copyButtons));
      expect(dashCard.copySingle.hidden === false, '唯一复制按钮不应隐藏: ' + safeJson(dashCard.copySingle));
      // 展示仍然两行，便于核对（画面 / 声音各一行）
      expect(dashCard.url.title === VIDEO_URL && dashCard.url.text.indexOf('画面 · ') === 0,
        '画面行未展示「画面 · <截断地址>」: ' + safeJson(dashCard.url));
      expect(dashCard.audio.title === AUDIO_URL && dashCard.audio.text.indexOf('声音 · ') === 0,
        '声音行未展示「声音 · <截断地址>」: ' + safeJson(dashCard.audio));
      expect(dashCard.rowAudio.hidden === false, 'DASH 场景声音行未显示: ' + safeJson(dashCard.rowAudio));

      await clickCopy('douyinCopyBtn');
      const afterCopy = await waitForState(probeCard, function (s) {
        return (s.copied || []).length === 1;
      }, { timeout: 4000, label: '复制被捕获' });
      copiedTwoLine = afterCopy.copied[0];
      expect(copiedTwoLine === VIDEO_URL + '\n' + AUDIO_URL,
        '复制内容不是「画面URL + 换行 + 声音URL」: ' + safeJson(copiedTwoLine));
      expect(copiedTwoLine.indexOf('\n') !== -1, '复制内容缺少换行分隔: ' + safeJson(copiedTwoLine));
      expect(afterCopy.toast === '画面与声音地址已复制', '复制提示不符: ' + safeJson(afterCopy.toast));

      // 1-b) 单条（只有纯视频轨）→ 复制那一条，提示回到「视频地址已复制」
      await loadDouyin('抖音域夹具重载（单轨场景）');
      const injectedOne = await injectCandidates([VIDEO_URL]);
      expect(injectedOne && injectedOne.ok, '注入单轨候选失败: ' + safeJson(injectedOne));
      await waitCandidates(1, '单轨候选并入候选池');
      await openPopupOnDouyin('单轨场景');
      await stubClipboard();
      await grabInPopup('单轨场景抓流完成');

      const singleCard = await probeCard();
      expect(singleCard.copyButtons.join(',') === 'douyinCopyBtn',
        '单轨场景也应只有一个复制按钮: ' + safeJson(singleCard.copyButtons));
      expect(singleCard.rowAudio.hidden === true, '无音轨时不应显示声音行: ' + safeJson(singleCard.rowAudio));
      expect(singleCard.url.text.indexOf('画面 · ') === -1, '无音轨时画面行不应带前缀: ' + safeJson(singleCard.url.text));

      await clickCopy('douyinCopyBtn');
      const afterSingleCopy = await waitForState(probeCard, function (s) {
        return (s.copied || []).length === 1;
      }, { timeout: 4000, label: '单条复制被捕获' });
      expect(afterSingleCopy.copied[0] === VIDEO_URL, '单条复制不是纯 URL: ' + safeJson(afterSingleCopy.copied));
      expect(afterSingleCopy.copied[0].indexOf('\n') === -1, '单条复制不应带换行: ' + safeJson(afterSingleCopy.copied));
      expect(afterSingleCopy.toast === '视频地址已复制', '单条复制提示不符: ' + safeJson(afterSingleCopy.toast));

      const popupErrors = (afterSingleCopy.errors || []).filter(function (e) {
        return e !== 'no-hook';
      });
      expect(popupErrors.length === 0, 'popup 运行时错误(window.onerror/unhandledrejection): ' + safeJson(popupErrors));

      /* ============ 2) 面板侧：唯一的输入框 + 整段粘贴自动分轨 ============ */
      // 先把测试页标签页切回前台再导航：合成鼠标事件与 getBoundingClientRect 都要求标签页可见
      try {
        await ctx.browser.send('Target.activateTarget', { targetId: ctx.pageTargetId }, 5000);
        await ctx.pageConn.send('Page.bringToFront', {}, 5000);
      } catch (e) {
        /* 非致命 */
      }
      await sleep(250);
      await navigate(ctx, ctx.pageUrl);
      await resetRules(ctx);
      await sleep(200);

      /**
       * 打开面板并切到「替换视频」：真实拾取器点 #hero。
       * @returns {Promise<object>} 面板结构快照
       */
      const openPanelOnHero = async function (label) {
        const startRes = await sendToPage(ctx, { type: 'es:start-pick' });
        expect(startRes && startRes.ok, '发送 es:start-pick 失败: ' + safeJson(startRes));
        expect(startRes.response && startRes.response.ok === true, 'start-pick 响应异常: ' + safeJson(startRes.response));

        const heroRect = await waitForState(function () {
          return evaluate(ctx.pageConn, `(function () {
            var el = document.getElementById('hero');
            if (!el) return { missing: true };
            try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) { el.scrollIntoView(); }
            var r = el.getBoundingClientRect();
            return {
              x: Math.round(r.left + r.width / 2),
              y: Math.round(r.top + r.height / 2),
              width: r.width,
              height: r.height,
              visibility: String(document.visibilityState || ''),
              display: String(getComputedStyle(el).display || '')
            };
          })()`);
        }, function (r) {
          return !!r && r.width > 0 && r.height > 0;
        }, { timeout: 6000, label: label + '（#hero 可测量）' });

        const dispatch = async function (params) {
          await ctx.pageConn.send('Input.dispatchMouseEvent', params, 4000);
        };
        await dispatch({ type: 'mouseMoved', x: heroRect.x, y: heroRect.y, button: 'none', buttons: 0 });
        await sleep(120);
        await dispatch({ type: 'mousePressed', x: heroRect.x, y: heroRect.y, button: 'left', buttons: 1, clickCount: 1 });
        await sleep(60);
        await dispatch({ type: 'mouseReleased', x: heroRect.x, y: heroRect.y, button: 'left', buttons: 0, clickCount: 1 });

        await waitForState(function () {
          return evaluate(ctx.pageConn, `(function () {
            var host = document.querySelector('[data-es-ui="panel"]');
            var root = host && host.shadowRoot;
            return { hasRoot: !!root, kindCount: root ? root.querySelectorAll('.kind').length : 0 };
          })()`);
        }, function (s) {
          return s.hasRoot === true && s.kindCount === 2;
        }, { timeout: 8000, label: label + '（面板打开）' });

        const clickKind = await evaluate(ctx.pageConn, `(function () {
          var host = document.querySelector('[data-es-ui="panel"]');
          var btn = host && host.shadowRoot && host.shadowRoot.querySelector('.kind[data-kind="video"]');
          if (!btn) return { ok: false, error: 'kind-missing' };
          btn.click();
          return { ok: true };
        })()`);
        expect(clickKind && clickKind.ok, '点击 .kind[data-kind=video] 失败: ' + safeJson(clickKind));

        return waitForState(probePanelInput, function (s) {
          return s.hasPanel === true && s.fieldOn === true;
        }, { timeout: 4000, label: label + '（输入框出现）' });
      };

      /** 面板结构 + 输入框/hint 的实测快照 */
      const probePanelInput = function () {
        return evaluate(ctx.pageConn, `(function () {
          var host = document.querySelector('[data-es-ui="panel"]');
          var root = host && host.shadowRoot;
          if (!root) return { hasPanel: false };
          var input = root.getElementById('es-url');
          var field = root.getElementById('es-field-url');
          var note = root.getElementById('es-track-note');
          var err = root.getElementById('es-err');
          var hint = root.getElementById('es-url-hint');
          var inputs = Array.prototype.slice.call(root.querySelectorAll('input'));
          return {
            hasPanel: true,
            fieldOn: !!(field && field.classList.contains('on')),
            inputCount: root.querySelectorAll('input[type=url]').length,
            visibleInputIds: inputs.filter(function (el) { return el.getClientRects().length > 0; })
              .map(function (el) { return String(el.id || ''); }).sort(),
            hasAudioInput: !!root.getElementById('es-audio'),
            hasAudioField: !!root.getElementById('es-field-audio'),
            value: input ? String(input.value || '') : null,
            hasNewline: input ? String(input.value || '').indexOf('\\n') !== -1 : null,
            hintText: hint ? String(hint.textContent || '') : '',
            note: note ? String(note.textContent || '') : '',
            noteOn: !!(note && note.classList.contains('on')),
            noteVisible: !!(note && note.getClientRects().length > 0),
            errText: err ? String(err.textContent || '') : '',
            errOn: !!(err && err.classList.contains('on'))
          };
        })()`);
      };

      /** 真实 paste：ClipboardEvent + DataTransfer（走面板的 onPanelUrlPaste → clipboardData.getData） */
      const pasteIntoInput = function (text) {
        return evaluate(ctx.pageConn, `(function () {
          var host = document.querySelector('[data-es-ui="panel"]');
          var root = host && host.shadowRoot;
          var input = root && root.getElementById('es-url');
          if (!input) return { ok: false, error: 'input-missing' };
          input.focus();
          var dt = new DataTransfer();
          dt.setData('text/plain', ${JSON.stringify(text)});
          var evt = new ClipboardEvent('paste', {
            bubbles: true, cancelable: true, clipboardData: dt
          });
          input.dispatchEvent(evt);
          return { ok: true, defaultPrevented: evt.defaultPrevented, value: String(input.value || '') };
        })()`);
      };

      // 2-a) 把 popup 复制出来的那段两行文本，整段粘进唯一输入框
      const firstOpen = await openPanelOnHero('读取视频面板');
      expect(firstOpen.inputCount === 1, '面板应只有 1 个输入框: ' + safeJson(firstOpen.inputCount));
      expect(firstOpen.hasAudioInput === false, '面板不应存在 #es-audio: ' + safeJson(firstOpen.hasAudioInput));
      expect(firstOpen.hasAudioField === false, '面板不应存在 #es-field-audio: ' + safeJson(firstOpen.hasAudioField));
      expect(firstOpen.visibleInputIds.join(',') === 'es-url',
        '可见输入框应恰为 es-url: ' + safeJson(firstOpen.visibleInputIds));

      const pasted = await pasteIntoInput(copiedTwoLine);
      expect(pasted && pasted.ok && pasted.defaultPrevented === true,
        'paste 未被面板接管（应 preventDefault）: ' + safeJson(pasted));

      const splitState = await waitForState(probePanelInput, function (s) {
        return s.value === VIDEO_URL;
      }, { timeout: 4000, label: '粘贴后输入框自动成为画面地址' });

      expect(splitState.value === VIDEO_URL, '粘贴后 #es-url 不是画面地址: ' + safeJson(splitState.value));
      expect(splitState.hasNewline === false, '输入框里残留了换行（应为单条画面地址）: ' + safeJson(splitState.hasNewline));
      expect(splitState.inputCount === 1 && splitState.hasAudioInput === false,
        '自动分轨不应生成第二个输入框: ' + safeJson({ count: splitState.inputCount, audio: splitState.hasAudioInput }));
      expect(splitState.note.indexOf('已识别：画面 + 声音') !== -1,
        'hint 未显示「已识别：画面 + 声音」: ' + safeJson(splitState.note));
      expect(splitState.noteOn === true && splitState.noteVisible === true,
        'hint 未真正可见: ' + safeJson({ on: splitState.noteOn, visible: splitState.noteVisible }));
      expect(splitState.errOn === false && splitState.errText.trim() === '',
        '正常分轨不应写进 #es-err: ' + safeJson({ errOn: splitState.errOn, errText: splitState.errText }));

      // 2-b) 保存 → payload.url 画面、payload.audioUrl 声音
      const saveClicked = await evaluate(ctx.pageConn, `(function () {
        var host = document.querySelector('[data-es-ui="panel"]');
        var save = host && host.shadowRoot && host.shadowRoot.getElementById('es-save');
        if (!save) return { ok: false, error: 'save-missing' };
        save.click();
        return { ok: true };
      })()`);
      expect(saveClicked && saveClicked.ok, '点击 #es-save 失败: ' + safeJson(saveClicked));

      const savedRule = await waitForState(function () {
        return extEval(ctx, `ES.listRules(${JSON.stringify(ctx.pageUrl)}).then(function (list) {
          var videos = (list || []).filter(function (r) { return r && r.kind === 'video'; });
          return {
            total: (list || []).length,
            videoCount: videos.length,
            rule: videos.length ? { selector: videos[0].selector, payload: videos[0].payload } : null
          };
        }, function (e) { return { total: -1, videoCount: -1, rule: null, error: String(e && e.message || e) }; })`);
      }, function (s) {
        return s.videoCount === 1 && !!s.rule;
      }, { timeout: 10000, label: '保存后的规则落库' });

      expect(savedRule.rule.payload && savedRule.rule.payload.url === VIDEO_URL,
        '落库的 payload.url 不是画面地址: ' + safeJson(savedRule.rule));
      expect(savedRule.rule.payload && savedRule.rule.payload.audioUrl === AUDIO_URL,
        '落库的 payload.audioUrl 不是声音地址: ' + safeJson(savedRule.rule));

      // 2-c) 只粘一条音频轨 → #es-err 提示，且不落库
      // 先清掉上面那条规则并重载页面：跨类型替换会把 #hero 隐藏掉，负面分支要在原始页面上测
      await resetRules(ctx);
      await navigate(ctx, ctx.pageUrl);
      await sleep(250);

      const secondOpen = await openPanelOnHero('再次读取视频面板');
      expect(secondOpen.inputCount === 1, '面板仍应只有 1 个输入框: ' + safeJson(secondOpen.inputCount));

      const pastedAudioOnly = await pasteIntoInput(AUDIO_URL);
      expect(pastedAudioOnly && pastedAudioOnly.ok, '粘贴音频轨失败: ' + safeJson(pastedAudioOnly));
      const audioOnlyState = await waitForState(probePanelInput, function (s) {
        return s.errOn === true;
      }, { timeout: 4000, label: '只粘音频轨时给出提示' });

      expect(audioOnlyState.errText.indexOf('音频轨地址') !== -1,
        '只粘音频轨的提示文案不符: ' + safeJson(audioOnlyState.errText));
      expect(audioOnlyState.value === '', '只粘音频轨时不应把音频地址写进画面框: ' + safeJson(audioOnlyState.value));
      expect(audioOnlyState.hasAudioInput === false, '不应生成音频输入框: ' + safeJson(audioOnlyState.hasAudioInput));

      const saveAfterAudioOnly = await evaluate(ctx.pageConn, `(function () {
        var host = document.querySelector('[data-es-ui="panel"]');
        var save = host && host.shadowRoot && host.shadowRoot.getElementById('es-save');
        if (!save) return { ok: false, error: 'save-missing' };
        save.click();
        return { ok: true };
      })()`);
      expect(saveAfterAudioOnly && saveAfterAudioOnly.ok, '点击 #es-save（仅音频）失败: ' + safeJson(saveAfterAudioOnly));
      await sleep(300);
      const rulesAfterAudioOnly = await extEval(ctx, `ES.listRules(${JSON.stringify(ctx.pageUrl)}).then(function (list) {
        return { total: (list || []).length, payloads: (list || []).map(function (r) { return r && r.payload; }) };
      })`);
      expect(rulesAfterAudioOnly.total === 0, '只粘音频轨不应落库: ' + safeJson(rulesAfterAudioOnly));

      // 2-d) 粘普通 .mp4 直链 → 不乱提示、payload 只有 url
      const pastedPlain = await pasteIntoInput(PLAIN_URL);
      expect(pastedPlain && pastedPlain.ok, '粘贴普通直链失败: ' + safeJson(pastedPlain));
      const plainState = await waitForState(probePanelInput, function (s) {
        return s.value === PLAIN_URL && s.errOn === false;
      }, { timeout: 4000, label: '普通直链写入输入框' });
      expect(plainState.noteOn === false && plainState.note === '',
        '普通直链不应出现「已识别」提示: ' + safeJson({ note: plainState.note, on: plainState.noteOn }));

      const savePlain = await evaluate(ctx.pageConn, `(function () {
        var host = document.querySelector('[data-es-ui="panel"]');
        var save = host && host.shadowRoot && host.shadowRoot.getElementById('es-save');
        if (!save) return { ok: false, error: 'save-missing' };
        save.click();
        return { ok: true };
      })()`);
      expect(savePlain && savePlain.ok, '点击 #es-save（普通直链）失败: ' + safeJson(savePlain));

      const plainRule = await waitForState(function () {
        return extEval(ctx, `ES.listRules(${JSON.stringify(ctx.pageUrl)}).then(function (list) {
          var videos = (list || []).filter(function (r) { return r && r.kind === 'video'; });
          return { total: (list || []).length, rule: videos.length ? videos[0].payload : null };
        })`);
      }, function (s) {
        return !!s.rule && s.rule.url === PLAIN_URL;
      }, { timeout: 10000, label: '普通直链规则落库' });

      expect(plainRule.rule.url === PLAIN_URL, '普通直链 payload.url 不符: ' + safeJson(plainRule.rule));
      expect(!plainRule.rule.audioUrl, '普通直链不应带 payload.audioUrl: ' + safeJson(plainRule.rule));

      const pageExceptions = ctx.pageExceptions.slice(0, 5);
      expect(pageExceptions.length === 0, '测试页面出现未捕获异常: ' + safeJson(pageExceptions));

      return {
        evidence: {
          limit: '抖音域用 Fetch.fulfillRequest 兜文档；候选为与真实 URL 同构的伪造地址（通道与用例 11 相同）',
          fulfilledDocs: fulfilledDocs,
          popupCopy: {
            rowButtons: dashCard.copyButtons,
            hasSplitButtons: dashCard.hasSplitVideoBtn || dashCard.hasSplitAudioBtn,
            copiedIsTwoLines: copiedTwoLine === VIDEO_URL + '\n' + AUDIO_URL,
            copiedLineBreakCount: (copiedTwoLine.match(/\n/g) || []).length,
            toast: afterCopy.toast,
            singleCopyLines: (afterSingleCopy.copied[0].match(/\n/g) || []).length,
            singleToast: afterSingleCopy.toast,
            twoDisplayRows: dashCard.url.text.indexOf('画面 · ') === 0 && dashCard.audio.text.indexOf('声音 · ') === 0
          },
          panelInput: {
            inputCount: firstOpen.inputCount,
            hasAudioInput: firstOpen.hasAudioInput,
            hasAudioField: firstOpen.hasAudioField,
            visibleInputIds: firstOpen.visibleInputIds,
            pastedDefaultPrevented: pasted ? pasted.defaultPrevented : null,
            valueAfterPaste: splitState.value === VIDEO_URL ? '画面URL' : splitState.value,
            hasNewlineInInput: splitState.hasNewline,
            hint: splitState.note
          },
          savedPayload: {
            urlIsVideoTrack: savedRule.rule.payload && savedRule.rule.payload.url === VIDEO_URL,
            audioIsAudioTrack: savedRule.rule.payload && savedRule.rule.payload.audioUrl === AUDIO_URL
          },
          audioOnly: {
            errText: audioOnlyState.errText,
            inputValueEmpty: audioOnlyState.value === '',
            rulesUnchanged: rulesAfterAudioOnly.total === 0
          },
          plainDirect: {
            noteEmpty: plainState.note === '',
            payloadHasAudioUrl: !!plainRule.rule.audioUrl,
            payloadUrlIsPlain: plainRule.rule.url === PLAIN_URL
          },
          errors: popupErrors.concat(ctx.popupExceptions.slice(0, 5)).concat(pageExceptions)
        }
      };
    } finally {
      try {
        dyConn.close();
      } catch (e) {
        /* 已关闭 */
      }
      try {
        await ctx.browser.send('Target.closeTarget', { targetId: dyTargetId }, 3000);
      } catch (e) {
        /* 忽略 */
      }
      try {
        await ctx.browser.send('Target.activateTarget', { targetId: ctx.pageTargetId }, 3000);
      } catch (e) {
        /* 忽略 */
      }
    }
  }
});

/* ================================================================== *
 * 运行器
 * ================================================================== */
function withTimeout(promise, ms, label) {
  return new Promise(function (resolve, reject) {
    const timer = setTimeout(function () {
      reject(new Error('用例执行超时 ' + ms + 'ms（' + label + '）'));
    }, ms);
    promise.then(function (value) {
      clearTimeout(timer);
      resolve(value);
    }, function (err) {
      clearTimeout(timer);
      reject(err);
    });
  });
}

const results = [];
let server = null;
let handle = null;
let cleaning = false;

async function cleanup() {
  if (cleaning) return;
  cleaning = true;
  if (handle && handle.popupConn) {
    try {
      handle.popupConn.close();
    } catch (e) {
      /* 忽略 */
    }
  }
  if (handle && handle.pageConn) {
    try {
      handle.pageConn.close();
    } catch (e) {
      /* 忽略 */
    }
  }
  if (handle) {
    try {
      await handle.close();
    } catch (e) {
      /* 忽略 */
    }
  }
  if (server) {
    try {
      await server.close();
    } catch (e) {
      /* 忽略 */
    }
  }
}

function reportLine(entry) {
  const head = String(entry.id) + '. ' + entry.name;
  const dots = ' ' + '.'.repeat(Math.max(2, 46 - head.length)) + ' ';
  const status = entry.status;
  const tail = entry.status === 'PASS'
    ? safeJson(entry.evidence, 460)
    : truncate(entry.reason || '', 700);
  console.log(head + dots + status + '  ' + tail);
}

async function main() {
  const startedAt = Date.now();
  console.log('');
  console.log('Element Swap E2E — 真实 Edge + 扩展加载 + CDP 驱动');
  console.log('扩展目录: ' + EXT_DIR);
  console.log('用例超时: ' + CASE_TIMEOUT + 'ms' + (ARGS.only ? ' / 仅跑: ' + Array.from(ARGS.only).join(',') : ''));

  const assets = ensureFixtureAssets(FIXTURES_DIR);
  console.log('夹具资源: ' + assets.join(', '));

  server = await startServer(FIXTURES_DIR);
  console.log('静态服务: ' + server.baseUrl + '（端口 ' + server.port + '）');

  const manifest = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));
  handle = await launchBrowserWithExtension({
    extensionDir: EXT_DIR,
    expectedName: manifest.name,
    modes: ARGS.headedFirst ? [false, true] : [true, false]
  });

  handle.popupConn = null;
  handle.popupTargetId = '';
  handle.pageExceptions = [];
  handle.popupExceptions = [];
  handle.pageUrl = server.baseUrl + '/page.html';
  handle.pageOrigin = server.baseUrl;
  handle.baseUrl = server.baseUrl;

  const pageConn = new CDP(devtoolsUrl(handle.port, handle.pageTargetId));
  await pageConn.connect(8000);
  await pageConn.send('Page.enable', {}, 6000);
  await pageConn.send('Runtime.enable', {}, 6000);
  pageConn.on('Runtime.exceptionThrown', function (params) {
    const details = (params && params.exceptionDetails) || {};
    const text = (details.exception && (details.exception.description || details.exception.value)) || details.text || '未知异常';
    handle.pageExceptions.push(String(text).split('\n')[0]);
  });
  handle.pageConn = pageConn;

  console.log('浏览器: ' + handle.mode + ' / ' + handle.browserVersion + ' / 扩展 ID: ' + handle.extensionId);
  (handle.notes || []).forEach(function (note) {
    console.log('  · ' + note);
  });
  if (handle.launchAttempts && handle.launchAttempts.length) {
    console.log('  启动尝试记录: ' + JSON.stringify(handle.launchAttempts.map(function (a) {
      return truncate(a, 160);
    })));
  }
  console.log('');

  const ctx = handle;
  const selected = CASES.filter(function (c) {
    return !ARGS.only || ARGS.only.has(c.id);
  });

  for (let i = 0; i < selected.length; i += 1) {
    const testCase = selected[i];
    const limit = CASE_TIMEOUT_OVERRIDE[testCase.id] || CASE_TIMEOUT;
    const caseStart = Date.now();
    let entry = null;
    // 每个用例独立的异常采集窗口
    ctx.pageExceptions.length = 0;
    ctx.popupExceptions.length = 0;
    try {
      const output = await withTimeout(testCase.run(ctx), limit, testCase.name);
      entry = {
        id: testCase.id,
        name: testCase.name,
        status: 'PASS',
        evidence: output && output.evidence,
        ms: Date.now() - caseStart
      };
    } catch (e) {
      if (e && e.isSkip) {
        entry = { id: testCase.id, name: testCase.name, status: 'SKIP', reason: e.message, ms: Date.now() - caseStart };
      } else {
        entry = {
          id: testCase.id,
          name: testCase.name,
          status: 'FAIL',
          reason: (e && e.message) || String(e),
          ms: Date.now() - caseStart
        };
      }
    }
    results.push(entry);
    reportLine(entry);
  }

  const passed = results.filter(function (r) { return r.status === 'PASS'; }).length;
  const failed = results.filter(function (r) { return r.status === 'FAIL'; }).length;
  const skipped = results.filter(function (r) { return r.status === 'SKIP'; }).length;

  console.log('');
  console.log('='.repeat(72));
  if (failed) {
    console.log('失败明细:');
    results.filter(function (r) { return r.status === 'FAIL'; }).forEach(function (r) {
      console.log('  [' + r.id + '] ' + r.name + ' → ' + r.reason);
    });
    console.log('');
  }
  if (skipped) {
    console.log('跳过明细:');
    results.filter(function (r) { return r.status === 'SKIP'; }).forEach(function (r) {
      console.log('  [' + r.id + '] ' + r.name + ' → ' + r.reason);
    });
    console.log('');
  }
  console.log('汇总: ' + passed + ' passed / ' + failed + ' failed / ' + skipped + ' skipped'
    + '（' + ((Date.now() - startedAt) / 1000).toFixed(1) + 's）');
  console.log('='.repeat(72));

  await cleanup();
  process.exit(failed > 0 ? 1 : 0);
}

process.on('SIGINT', async function () {
  console.log('\n收到中断信号，开始清理…');
  await cleanup();
  process.exit(130);
});

main().catch(async function (err) {
  console.error('夹具本身出错: ' + ((err && err.stack) || err));
  await cleanup();
  process.exit(2);
});


