/**
 * Element Swap - MAIN world 媒体探针（仅 *://*.douyin.com/*）
 *
 * 为什么需要它：
 *   抖音播放器的真实媒体地址（已签名的 /video/tos/… / douyinvod 流）只在页面
 *   自身的 fetch / XHR / HTMLMediaElement 里出现。ISOLATED world 的内容脚本读不到
 *   这些通道，performance 条目又经常被 MSE / blob 吞掉，所以必须有一条 MAIN world
 *   的旁路：钩住页面自身的网络与媒体接口，把命中媒体特征的 URL 用 postMessage
 *   单向广播给内容脚本，由内容脚本并入候选池。
 *
 * 硬约束（务必保持）：
 *  1. 幂等：重复注入直接退出（document_start 只会有一次，但侧栏补注可能再来）。
 *  2. 绝不改变宿主语义：钩子一律原样调用原实现、原样返回原返回值，同步不转异步。
 *  3. 任何钩子内部异常都必须静默吞掉，绝不能冒泡到页面逻辑。
 *  4. 不使用 eval / 不引入依赖 / 不写 DOM / 不读存储。
 *
 * 上报格式（唯一出口）：
 *   window.postMessage({ __esMainProbe: 1, url: '<媒体 URL>', kind: 'xhr'|'fetch'|'media-src'|'mse', t: <ms> }, '*')
 */
(function () {
  'use strict';

  /* ---- 0. 幂等 + 标记（内容脚本自测时读 window.__ES_MAIN_PROBE__） ---- */
  try {
    if (window.__ES_MAIN_PROBE__) return;
    window.__ES_MAIN_PROBE__ = true;
  } catch (e) {
    return;
  }

  /* ---- 1. 媒体特征判定（与内容脚本 isMediaCandidateUrl 同口径） ---- */
  var EXT_RE = /\.(?:mp4|webm|m3u8|m4a)(?:$|[?#])/i;
  var PATH_RE = /\/video\/tos\/|\/playwm\/|\/play\/|mime_type=video/i;
  var HOST_RE = /(?:^|\.)douyinvod\.com$/i;
  /** 明显不是媒体的静态资源 + byteimg 图床一律排除 */
  var EXCLUDE_RE = /\.(?:jpe?g|png|webp|gif|css|js|ico)(?:$|[?#])/i;
  var BYTEIMG_RE = /byteimg/i;

  function isMediaUrl(value) {
    var raw = String(value == null ? '' : value).trim();
    if (!raw || !/^https?:\/\//i.test(raw)) return false;
    var parsed;
    try {
      parsed = new URL(raw);
    } catch (e) {
      return false;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    var host = String(parsed.hostname || '');
    var pathname = String(parsed.pathname || '');
    var target = pathname + String(parsed.search || '');
    if (BYTEIMG_RE.test(host) || BYTEIMG_RE.test(pathname)) return false;
    if (EXCLUDE_RE.test(pathname)) return false;
    if (EXT_RE.test(target)) return true;
    if (PATH_RE.test(target)) return true;
    if (HOST_RE.test(host)) return true;
    return false;
  }

  /* ---- 2. 上报：队列 + 有界重播（内容脚本 document_end 才就位，早发的消息会丢） ---- */
  var QUEUE_LIMIT = 40;
  var queue = [];            // [{url, kind}]，去重后只留最近 QUEUE_LIMIT 条
  var replayTimer = null;
  var replayTicks = 0;
  var REPLAY_INTERVAL = 1200;
  var REPLAY_MAX_TICKS = 18; // ≈21.6s：覆盖内容脚本注入 + 首屏起流

  function pushQueue(url, kind) {
    for (var i = 0; i < queue.length; i += 1) {
      if (queue[i].url === url) {
        queue[i].kind = kind;
        return;
      }
    }
    queue.push({ url: url, kind: kind });
    if (queue.length > QUEUE_LIMIT) queue = queue.slice(queue.length - QUEUE_LIMIT);
  }

  function post(url, kind) {
    try {
      window.postMessage({ __esMainProbe: 1, url: String(url || ''), kind: String(kind || ''), t: Date.now() }, '*');
    } catch (e) {
      /* 静默 */
    }
  }

  function armReplay() {
    if (replayTimer) return;
    try {
      replayTimer = setInterval(function () {
        replayTicks += 1;
        if (replayTicks > REPLAY_MAX_TICKS) {
          clearInterval(replayTimer);
          replayTimer = null;
          return;
        }
        for (var i = 0; i < queue.length; i += 1) post(queue[i].url, queue[i].kind);
      }, REPLAY_INTERVAL);
    } catch (e) {
      replayTimer = null;
    }
  }

  /** 命中特征才上报；mse 走 reportMse，不进入可播候选 */
  function report(url, kind) {
    try {
      var raw = String(url == null ? '' : url).trim();
      if (!raw || !isMediaUrl(raw)) return;
      pushQueue(raw, kind);
      post(raw, kind);
      armReplay();
    } catch (e) {
      /* 静默 */
    }
  }

  /** MSE：只标记有流，不给可播 URL（blob: 对内容脚本没意义） */
  var MSE_MIN_GAP = 400;   // 玩家可能反复赋值，节流避免消息洪水
  var lastMseAt = 0;
  function reportMse() {
    try {
      var now = Date.now();
      if (now - lastMseAt < MSE_MIN_GAP) return;
      lastMseAt = now;
      post('', 'mse');
    } catch (e) {
      /* 静默 */
    }
  }

  /* ---- 3. XMLHttpRequest：open 记 url，send 后 loadend 上报 ---- */
  try {
    var xhrProto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (xhrProto && typeof xhrProto.open === 'function' && typeof xhrProto.send === 'function') {
      var origXhrOpen = xhrProto.open;
      var origXhrSend = xhrProto.send;

      xhrProto.open = function (method, url) {
        try {
          this.__esProbeUrl = String(url == null ? '' : url);
        } catch (e) {
          /* 静默 */
        }
        return origXhrOpen.apply(this, arguments);
      };

      xhrProto.send = function () {
        try {
          var url = '';
          try {
            url = String(this.__esProbeUrl || '');
          } catch (e) {
            url = '';
          }
          if (url && typeof this.addEventListener === 'function') {
            this.addEventListener('loadend', function () {
              try {
                report(url, 'xhr');
              } catch (e) {
                /* 静默 */
              }
            }, { once: true });
          }
        } catch (e) {
          /* 静默 */
        }
        return origXhrSend.apply(this, arguments);
      };
    }
  } catch (e) {
    /* 钩不上就放弃这一条通道，绝不影响页面 */
  }

  /* ---- 4. fetch：读 res.url（相对请求回落到请求 URL），原样返回原 promise ---- */
  try {
    if (typeof window.fetch === 'function') {
      var origFetch = window.fetch;
      window.fetch = function (input) {
        var result = origFetch.apply(this, arguments);
        try {
          var requestUrl = '';
          try {
            requestUrl = typeof input === 'string' ? input : String((input && input.url) || '');
          } catch (e) {
            requestUrl = '';
          }
          return Promise.resolve(result).then(function (response) {
            try {
              report((response && response.url) || requestUrl, 'fetch');
            } catch (e) {
              /* 静默 */
            }
            return response;
          });
        } catch (e) {
          return result; // 包装失败也绝不改变原返回值
        }
      };
    }
  } catch (e) {
    /* 静默 */
  }

  /* ---- 5. HTMLMediaElement.src setter + setSrcObject ---- */
  try {
    if (typeof window.HTMLMediaElement !== 'undefined' && window.HTMLMediaElement.prototype) {
      var mediaProto = window.HTMLMediaElement.prototype;
      var srcDesc = null;
      try {
        srcDesc = Object.getOwnPropertyDescriptor(mediaProto, 'src');
      } catch (e) {
        srcDesc = null;
      }
      if (srcDesc && typeof srcDesc.set === 'function' && srcDesc.configurable) {
        try {
          Object.defineProperty(mediaProto, 'src', {
            configurable: true,
            enumerable: !!srcDesc.enumerable,
            get: srcDesc.get,
            set: function (value) {
              var ret = srcDesc.set.call(this, value);
              try {
                report(String(value == null ? '' : value), 'media-src');
              } catch (e) {
                /* 静默 */
              }
              return ret;
            }
          });
        } catch (e) {
          /* 静默 */
        }
      }
      if (typeof mediaProto.setSrcObject === 'function') {
        var origSetSrcObject = mediaProto.setSrcObject;
        try {
          mediaProto.setSrcObject = function () {
            try {
              reportMse();
            } catch (e) {
              /* 静默 */
            }
            return origSetSrcObject.apply(this, arguments);
          };
        } catch (e) {
          /* 静默 */
        }
      }
      // Chromium 没有 setSrcObject，实际用的是 srcObject 访问器：同样只标记有流，不给可播 URL
      try {
        var objDesc = Object.getOwnPropertyDescriptor(mediaProto, 'srcObject');
        if (objDesc && typeof objDesc.set === 'function' && objDesc.configurable) {
          Object.defineProperty(mediaProto, 'srcObject', {
            configurable: true,
            enumerable: !!objDesc.enumerable,
            get: objDesc.get,
            set: function (value) {
              var ret = objDesc.set.call(this, value);
              try {
                if (value) reportMse();
              } catch (e) {
                /* 静默 */
              }
              return ret;
            }
          });
        }
      } catch (e) {
        /* 静默 */
      }
    }
  } catch (e) {
    /* 静默 */
  }
})();