/**
 * Element Swap - 后台 Service Worker
 *
 * 职责：
 *  1. 安装 / 升级时写入默认设置（不覆盖已有值）
 *  2. 监听 es_rules 变化 → 向所有 http/https 标签页广播 RULES_CHANGED
 *
 * MV3 Service Worker 会被反复唤醒，因此不允许顶层 await，只注册同步监听器。
 */
'use strict';

/* 契约层：Service Worker 里用 importScripts 加载（同样是经典脚本）
 * 加载失败时回退到字面键名，保证后台功能不因契约文件缺失而整体失效。 */
try {
  importScripts('shared/es-shared.js');
} catch (e) {
  /* 忽略：下面有字面量兜底 */
}

/* 媒体解析器：同样是经典脚本，必须在此同步加载
 * 加载失败时 ESMedia 未定义，消息处理器返回 'resolver-unavailable'，不影响后台既有功能。 */
try {
  importScripts('shared/media-resolver.js');
} catch (e) {
  /* 忽略：解析能力降级，不影响规则广播 */
}

var STORAGE_SETTINGS = 'es_settings';
var STORAGE_RULES = 'es_rules';
var DEFAULT_SETTINGS = { scope: 'domain', version: 1 };
var MSG_RULES_CHANGED = 'es:rules-changed';

if (typeof ES !== 'undefined' && ES && ES.STORAGE) {
  STORAGE_SETTINGS = ES.STORAGE.SETTINGS;
  STORAGE_RULES = ES.STORAGE.RULES;
  MSG_RULES_CHANGED = ES.MSG.RULES_CHANGED;
  if (ES.DEFAULTS) {
    DEFAULT_SETTINGS = { scope: ES.DEFAULTS.scope || 'domain', version: ES.DEFAULTS.version || 1 };
  }
}

/** 写入默认设置：缺字段才补，已有值一律保留 */
function ensureDefaults() {
  try {
    chrome.storage.local.get([STORAGE_SETTINGS], function (result) {
      if (chrome.runtime.lastError) return;
      var current = (result && result[STORAGE_SETTINGS]) || null;
      var patch = {};
      if (!current || typeof current !== 'object') {
        patch = { scope: DEFAULT_SETTINGS.scope, version: DEFAULT_SETTINGS.version };
      } else {
        if (typeof current.scope !== 'string') patch.scope = DEFAULT_SETTINGS.scope;
        if (typeof current.version !== 'number') patch.version = DEFAULT_SETTINGS.version;
        if (!Object.keys(patch).length) return; // 已有完整设置，不写
      }
      var next = Object.assign({}, current || {}, patch);
      var payload = {};
      payload[STORAGE_SETTINGS] = next;
      chrome.storage.local.set(payload, function () {
        if (chrome.runtime.lastError) {
          /* 忽略写入错误，避免未捕获异常 */
        }
      });
    });
  } catch (e) {
    /* 存储不可用时静默 */
  }
}

/** 给单个标签页发消息，吞掉「无接收端」错误 */
function notifyTab(tabId) {
  if (tabId === null || tabId === undefined) return;
  try {
    chrome.tabs.sendMessage(tabId, { type: MSG_RULES_CHANGED }, function () {
      // 必须读取 lastError，否则会出现未捕获的
      // "Could not establish connection. Receiving end does not exist."
      if (chrome.runtime.lastError) {
        void chrome.runtime.lastError;
      }
    });
  } catch (e) {
    /* 标签页已关闭 / 无权限时的异常，静默 */
  }
}

/** 向所有 http/https 标签页广播规则变更 */
function broadcastRulesChanged() {
  try {
    chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }, function (tabs) {
      if (chrome.runtime.lastError) return;
      (tabs || []).forEach(function (tab) {
        if (tab && tab.id !== undefined) notifyTab(tab.id);
      });
    });
  } catch (e) {
    /* 静默 */
  }
}

/* --- 监听器：只能是同步注册，SW 唤醒后立即生效 --- */

chrome.runtime.onInstalled.addListener(function (details) {
  ensureDefaults();
  // 首次安装 / 扩展更新后，让已打开的页面也刷新规则
  if (details && (details.reason === 'install' || details.reason === 'update')) {
    broadcastRulesChanged();
  }
});

chrome.runtime.onStartup.addListener(function () {
  ensureDefaults();
});

chrome.storage.onChanged.addListener(function (changes, areaName) {
  if (areaName !== 'local' || !changes) return;
  if (!Object.prototype.hasOwnProperty.call(changes, STORAGE_RULES)) return;
  broadcastRulesChanged();
});

/* ================================================================== *
 * 媒体解析（视频页链接 → 可直接播放的音视频流）
 * 只新增监听器与工具函数，不改动上面的既有逻辑。
 * ================================================================== */

var MSG_RESOLVE_MEDIA = 'es:resolve-media';
var MEDIA_CACHE_KEY = 'es:media_cache';
var MEDIA_CACHE_TTL_MS = 15 * 60 * 1000; // 15 分钟
var MEDIA_CACHE_MAX = 30; // 上限 30 条，超出淘汰最旧

var MEDIA_CACHE_FIELDS = ['mediaUrl', 'title', 'quality', 'durationMs'];

/** session 存储是否可用（不可用时静默降级为「不缓存」） */
function hasSessionStorage() {
  try {
    return !!(chrome.storage && chrome.storage.session);
  } catch (e) {
    return false;
  }
}

/** 读整张缓存表；任何异常都当成空表 */
function readMediaCache() {
  return new Promise(function (resolve) {
    if (!hasSessionStorage()) return resolve({});
    try {
      chrome.storage.session.get([MEDIA_CACHE_KEY], function (result) {
        if (chrome.runtime.lastError) return resolve({});
        var map = result && result[MEDIA_CACHE_KEY];
        resolve(map && typeof map === 'object' ? map : {});
      });
    } catch (e) {
      resolve({});
    }
  });
}

/** 写整张缓存表；失败静默 */
function writeMediaCache(map) {
  return new Promise(function (resolve) {
    if (!hasSessionStorage()) return resolve();
    try {
      var payload = {};
      payload[MEDIA_CACHE_KEY] = map;
      chrome.storage.session.set(payload, function () {
        if (chrome.runtime.lastError) {
          /* 忽略写入错误 */
        }
        resolve();
      });
    } catch (e) {
      resolve();
    }
  });
}

/** 命中未过期缓存则返回条目，否则 null；cacheKey = <bvid>:<cid> */
function mediaCacheGet(cacheKey) {
  return readMediaCache().then(function (map) {
    var entry = map && map[cacheKey];
    if (!entry || typeof entry.mediaUrl !== 'string' || !entry.mediaUrl) return null;
    if (typeof entry.expiresAt !== 'number' || entry.expiresAt <= Date.now()) return null;
    var hit = {};
    MEDIA_CACHE_FIELDS.forEach(function (field) {
      if (entry[field] !== undefined) hit[field] = entry[field];
    });
    return hit;
  });
}

/** 写入缓存：先清理过期项，再按上限淘汰最旧（expiresAt 最小） */
function mediaCachePut(cacheKey, entry) {
  if (!cacheKey || !entry || typeof entry.mediaUrl !== 'string' || !entry.mediaUrl) {
    return Promise.resolve();
  }
  return readMediaCache().then(function (map) {
    var now = Date.now();
    var next = {};
    Object.keys(map || {}).forEach(function (key) {
      var item = map[key];
      if (!item || typeof item.expiresAt !== 'number') return;
      if (item.expiresAt <= now) return; // 过期即丢弃
      if (key === cacheKey) return;
      next[key] = item;
    });
    var record = { mediaUrl: entry.mediaUrl, expiresAt: now + MEDIA_CACHE_TTL_MS };
    MEDIA_CACHE_FIELDS.forEach(function (field) {
      if (entry[field] !== undefined) record[field] = entry[field];
    });
    next[cacheKey] = record;

    var keys = Object.keys(next);
    if (keys.length > MEDIA_CACHE_MAX) {
      keys.sort(function (a, b) {
        return (next[a].expiresAt || 0) - (next[b].expiresAt || 0);
      });
      var overflow = keys.length - MEDIA_CACHE_MAX;
      for (var i = 0; i < overflow; i += 1) delete next[keys[i]];
    }
    return writeMediaCache(next);
  });
}

/** 解析单个链接：解析器缺失 / 同步抛错 / 异步拒绝都收敛成 { ok:false, error } */
function resolveMediaRequest(url) {
  try {
    if (typeof ESMedia === 'undefined' || !ESMedia || typeof ESMedia.resolveMedia !== 'function') {
      return Promise.resolve({ ok: false, error: 'resolver-unavailable' });
    }
    var pending = ESMedia.resolveMedia(url, {
      cacheGet: mediaCacheGet,
      cachePut: mediaCachePut
    });
    return Promise.resolve(pending).then(function (result) {
      if (result && typeof result === 'object') return result;
      return { ok: false, error: '解析失败' };
    });
  } catch (e) {
    return Promise.resolve({ ok: false, error: String((e && e.message) || e) });
  }
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || message.type !== MSG_RESOLVE_MEDIA) return false;
  // 异步应答：必须返回 true 保持消息通道
  resolveMediaRequest(message.url).then(function (result) {
    try {
      sendResponse(result);
    } catch (e) {
      /* 接收端已断开 */
    }
  }).catch(function (e) {
    try {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    } catch (err) {
      /* 接收端已断开 */
    }
  });
  return true;
});

/* ================================================================== *
 * 媒体流诊断（es:probe-media-url）
 *
 * 目的：替换后的 <video> 播不出来时，判断到底是
 *   403 防盗链 / 404 失效 / HLS 分片清单 / 接口 JSON / 被风控返回的 HTML。
 *
 * 只读：GET + Range 前 1KB，credentials:'omit'，12s 超时。
 * 注意：浏览器禁止脚本设置 Referer / Origin，这两者由
 * rules/media-referer.json 的 DNR 规则（douyinvod / byteicdn / zjcdn / douyinpic）
 * 在请求层补齐；这里绝不能也不需要在 headers 里手写它们。
 * ================================================================== */

var MSG_PROBE_MEDIA = 'es:probe-media-url';
var PROBE_TIMEOUT_MS = 12000;
var PROBE_BYTE_LIMIT = 1024;
var PROBE_SNIFF_BYTES = 12;   // 容器判定只需前 12 字节
var PROBE_TEXT_BYTES = 64;    // 文本类判定（m3u8/json/html）多读一点更稳

/** 前 N 字节转小写文本，用于文本类判定；二进制内容会得到不可打印字符，不影响判定 */
function probeTextOf(bytes, limit) {
  var end = Math.min(bytes.length, limit);
  var text = '';
  for (var i = 0; i < end; i += 1) {
    var code = bytes[i];
    // 只保留可见 ASCII，其余换成空格（避免误把二进制当文本）
    text += (code >= 0x20 && code < 0x7f) ? String.fromCharCode(code) : ' ';
  }
  return text;
}

/**
 * 容器判定（按优先级）：
 *   bytes[4..8]==='ftyp'      → mp4（浏览器 <video> 可直接播放的渐进式容器）
 *   文本以 '#EXT' 开头        → hls（分片清单，不能直连播放）
 *   文本以 '{' / '[' 开头     → json（接口响应）
 *   文本以 '<' 开头           → html（多半是防盗链 / 风控拦截页）
 *   其它                      → unknown
 */
function probeKindOf(bytes) {
  if (!bytes || !bytes.length) return 'unknown';
  if (bytes.length >= 8) {
    var ftyp = '';
    for (var i = 4; i < 8; i += 1) {
      var c = bytes[i];
      ftyp += (c >= 0x20 && c < 0x7f) ? String.fromCharCode(c) : '\u0000';
    }
    if (ftyp === 'ftyp') return 'mp4';
  }
  var head = probeTextOf(bytes, PROBE_TEXT_BYTES).replace(/^\s+/, '');
  if (!head) return 'unknown';
  if (head.indexOf('#EXT') === 0) return 'hls';
  if (head.charAt(0) === '{' || head.charAt(0) === '[') return 'json';
  if (head.charAt(0) === '<') return 'html';
  return 'unknown';
}

/** kind → 给用户的补充说明（可播放的 mp4 不写 note） */
function probeNoteOf(kind, status) {
  if (kind === 'hls') return '这是 HLS 分片清单，<video> 不能直接播放';
  if (kind === 'json') return '返回的是 JSON/接口响应，不是媒体流';
  if (kind === 'html') return '返回的是 HTML（多半被防盗链/风控拦截）';
  if (kind === 'unknown' && status && status >= 200 && status < 300) return '无法识别的容器格式';
  return '';
}

/** HTTP 状态 → 中文短句错误 */
function probeErrorOfStatus(status) {
  if (status === 403 || status === 401) return '被防盗链拒绝（HTTP ' + status + '）';
  if (status === 404) return '地址已失效（HTTP 404）';
  return 'HTTP ' + status;
}

/**
 * 探测一个媒体地址是否真的能当 <video> 的 src 用。
 * 全 try/catch：任何异常都收敛成结构化结果，绝不让 Service Worker 抛未捕获异常
 * （抓到的地址可能落在无 host 权限 / 非法 URL / 已断网等情形）。
 */
function probeMediaUrl(url) {
  var target = String(url || '').trim();
  var base = {
    ok: false,
    status: 0,
    contentType: '',
    contentLength: '',
    contentRange: '',
    acceptRanges: '',
    finalUrl: target,
    kind: 'unknown'
  };

  if (!/^https?:\/\//i.test(target)) {
    return Promise.resolve(Object.assign({}, base, { error: '不是 http(s) 地址' }));
  }

  var controller = null;
  var timer = 0;

  var request = (function () {
    try {
      controller = new AbortController();
      timer = setTimeout(function () {
        try {
          controller.abort();
        } catch (e) {
          /* 已中止 */
        }
      }, PROBE_TIMEOUT_MS);
      return fetch(target, {
        method: 'GET',
        headers: { range: 'bytes=0-' + (PROBE_BYTE_LIMIT - 1) },
        credentials: 'omit',
        redirect: 'follow',
        cache: 'no-store',
        signal: controller.signal
      });
    } catch (e) {
      // fetch 同步抛错（非法 URL / 无权限 host 等）
      return Promise.reject(e);
    }
  })();

  return Promise.resolve(request).then(function (response) {
    var status = Number(response && response.status) || 0;
    var header = function (name) {
      try {
        return String((response.headers && response.headers.get(name)) || '');
      } catch (e) {
        return '';
      }
    };
    var result = Object.assign({}, base, {
      status: status,
      contentType: header('content-type'),
      contentLength: header('content-length'),
      contentRange: header('content-range'),
      acceptRanges: header('accept-ranges'),
      finalUrl: String((response && response.url) || target)
    });

    return Promise.resolve(response.arrayBuffer()).then(function (buffer) {
      var bytes = new Uint8Array(buffer || new ArrayBuffer(0));
      var kind = probeKindOf(bytes);
      var okStatus = status >= 200 && status < 300;
      result.kind = kind;
      result.note = probeNoteOf(kind, status);
      result.sniffedBytes = Math.min(bytes.length, PROBE_SNIFF_BYTES + PROBE_TEXT_BYTES);
      if (!okStatus) {
        result.ok = false;
        result.error = probeErrorOfStatus(status);
      } else {
        result.ok = true;
      }
      return result;
    }).catch(function () {
      // 响应体读不出来（被中止 / 流异常）：仍返回头部信息
      var okStatus = status >= 200 && status < 300;
      result.ok = okStatus;
      if (!okStatus) result.error = probeErrorOfStatus(status);
      else result.error = '网络错误：响应体读取失败';
      return result;
    });
  }).catch(function (e) {
    var message = String((e && e.message) || e || '未知错误');
    var aborted = /abort/i.test(message);
    return Object.assign({}, base, {
      ok: false,
      error: aborted ? ('网络错误：探测超时（' + Math.round(PROBE_TIMEOUT_MS / 1000) + ' 秒）') : ('网络错误：' + message),
      note: aborted ? '地址可能已失效或需要登录态' : ''
    });
  }).then(function (result) {
    if (timer) clearTimeout(timer);
    timer = 0;
    controller = null;
    return result;
  });
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || message.type !== MSG_PROBE_MEDIA) return false;
  // 异步应答：必须返回 true 保持消息通道；pageUrl 仅作上下文预留（Referer 由 DNR 补）
  probeMediaUrl(message.url).then(function (result) {
    try {
      sendResponse(result);
    } catch (e) {
      /* 接收端已断开 */
    }
  }).catch(function (e) {
    try {
      sendResponse({
        ok: false,
        status: 0,
        contentType: '',
        contentLength: '',
        contentRange: '',
        acceptRanges: '',
        finalUrl: String(message.url || ''),
        kind: 'unknown',
        error: '网络错误：' + String((e && e.message) || e)
      });
    } catch (err) {
      /* 接收端已断开 */
    }
  });
  return true;
});