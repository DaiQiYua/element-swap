/**
 * Element Swap - 媒体解析器（经典脚本，挂到 globalThis.ESMedia）
 *
 * 职责：把用户粘贴的视频页面链接解析成「可直接播放」的音视频流地址。
 * 目前只支持 B 站（bilibili.com / b23.tv）。
 *
 * 解析链路（实测）：
 *  1. b23.tv 短链 → fetch(redirect:'follow') 取最终 URL 再取 BV 号
 *  2. GET /x/web-interface/view?bvid=<BV>  → cid / title / duration / pages[]
 *  3. GET /x/player/playurl?bvid&cid&qn=80&fnval=1&platform=html5&high_quality=1
 *       → data.durl[0].url 是 upos-sz-estgoss.bilivideo.com 上的单文件 MP4（已含音轨），
 *         实测不带 Referer 也能 206 拉到 ftyp，因此优先走这条「免 Referer」分支
 *     ↑ 失败（code≠0 或 durl 空）再退到 fnval=1&qn=80（镜像地址，必须带 Referer）
 *
 * 不修改任何既有文件，background.js 用 importScripts 加载，Node 下可直接 eval 单测。
 */
(function () {
  'use strict';

  var PROVIDER = 'bilibili';
  var API_VIEW = 'https://api.bilibili.com/x/web-interface/view';
  var API_PLAYURL = 'https://api.bilibili.com/x/player/playurl';
  var REFERER = 'https://www.bilibili.com/';
  var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'Chrome/126.0.0.0 Safari/537.36';
  var TIMEOUT_MS = 12000;
  var BV_RE = /^BV[0-9A-Za-z]{10}$/;

  function isBilibiliHost(host) {
    if (!host) return false;
    return host === 'bilibili.com' || /\.bilibili\.com$/.test(host)
      || host === 'b23.tv' || /\.b23\.tv$/.test(host);
  }

  /** 宽松地取 URL；裸域名（b23.tv/xxx）自动补 https:// */
  function toUrl(input) {
    if (typeof input !== 'string') return null;
    var raw = input.trim();
    if (!raw) return null;
    var withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw;
    try {
      return new URL(withScheme);
    } catch (e) {
      return null;
    }
  }

  function parsePage(value) {
    if (value === null || value === undefined || value === '') return null;
    var n = parseInt(String(value), 10);
    if (!isFinite(n) || n < 1) return null;
    return n;
  }

  /** 从路径里取 BV 号（/video/BVxxxxxxxxxx） */
  function bvFromPath(pathname) {
    var m = /\/video\/(BV[0-9A-Za-z]{10})(?=[/?#]|$)/.exec(String(pathname || ''));
    if (!m) return null;
    return BV_RE.test(m[1]) ? m[1] : null;
  }

  /** 从路径里取旧版 av 号（/video/av170001），返回数字 aid */
  function aidFromPath(pathname) {
    var m = /\/video\/av(\d+)(?=[/?#]|$)/i.exec(String(pathname || ''));
    if (!m) return null;
    var aid = parseInt(m[1], 10);
    if (!isFinite(aid) || aid <= 0) return null;
    return aid;
  }

  /**
   * 解析 B 站视频链接。
   * @returns {{provider:'bilibili', bvid:string, page?:number}
   *          | {provider:'bilibili', aid:number, page?:number}
   *          | {provider:'bilibili', shortUrl:string, page?:number}
   *          | null}
   *   BV 号与旧版 av 号都支持；短链返回 shortUrl（自带 ?p= 也会带上）；
   *   非视频页 / 取不到号返回 null。
   */
  function parseBilibiliUrl(url) {
    var u = toUrl(url);
    if (!u) return null;
    var host = String(u.hostname || '').toLowerCase();
    if (!isBilibiliHost(host)) return null;
    var page = parsePage(u.searchParams.get('p'));

    // b23.tv/<code>：短链需要先跟随重定向拿最终 URL；短链自带的 ?p= 也要留着
    if (host === 'b23.tv' || /\.b23\.tv$/.test(host)) {
      var code = String(u.pathname || '').replace(/^\/+/, '').split('/')[0];
      if (!code) return null;
      var short = { provider: PROVIDER, shortUrl: u.href };
      if (page) short.page = page;
      return short;
    }

    var bvid = bvFromPath(u.pathname);
    if (bvid) {
      var byBv = { provider: PROVIDER, bvid: bvid };
      if (page) byBv.page = page;
      return byBv;
    }

    var aid = aidFromPath(u.pathname);
    if (aid) {
      var byAid = { provider: PROVIDER, aid: aid };
      if (page) byAid.page = page;
      return byAid;
    }

    return null;
  }

  function timeoutError() {
    var err = new Error('网络超时');
    err.code = 'timeout';
    return err;
  }

  /**
   * 请求头候选（自适应降级）：
   *  B 站 WAF 实测行为：只带 Referer（没有配套 Origin）或带外部 Origin 一律 HTTP 412；
   *  Referer + Origin=https://www.bilibili.com 正常，什么都不带也正常。
   *  浏览器内核会丢弃 Referer / Origin 这类禁止头（等于裸请求，实测 200），
   *  Node 下 undici 会真的发送，所以两套头依次尝试。
   */
  var HEADER_CANDIDATES = [
    {
      name: 'browser',
      headers: { 'Referer': REFERER, 'Origin': 'https://www.bilibili.com', 'User-Agent': UA }
    },
    {
      name: 'bare',
      headers: { 'User-Agent': UA }
    }
  ];

  var JSON_ACCEPT = 'application/json, text/plain, */*';
  var HTML_ACCEPT = 'text/html,application/xhtml+xml,*/*';

  /**
   * 单次请求：独立 12s AbortController 超时。
   * @returns {Promise<Response>}
   */
  async function requestOnce(url, headers, accept, redirect) {
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = null;
    var timedOut = false;
    if (controller) {
      timer = setTimeout(function () {
        timedOut = true;
        try {
          controller.abort();
        } catch (e) {
          /* 已结束 */
        }
      }, TIMEOUT_MS);
    }
    try {
      var merged = Object.assign({}, headers || {}, { 'Accept': accept });
      return await fetch(url, {
        method: 'GET',
        headers: merged,
        credentials: 'omit',
        cache: 'no-store',
        redirect: redirect || 'follow',
        signal: controller ? controller.signal : undefined
      });
    } catch (e) {
      if (timedOut || (e && (e.name === 'AbortError' || e.code === 'timeout'))) throw timeoutError();
      var err = new Error('网络请求失败');
      err.code = 'network';
      err.cause = e;
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 按请求头候选依次尝试；只有 412 / 403（WAF 拦截）才换下一组 */
  async function request(url, opts) {
    var options = opts || {};
    var accept = options.accept || JSON_ACCEPT;
    var redirect = options.redirect || 'follow';
    var lastError = null;
    for (var i = 0; i < HEADER_CANDIDATES.length; i += 1) {
      var res = await requestOnce(url, HEADER_CANDIDATES[i].headers, accept, redirect);
      if (res && res.ok) return res;
      var status = (res && res.status) || 0;
      lastError = httpError(status);
      if (status === 412 || status === 403) continue; // 换一组头再试
      throw lastError;
    }
    throw lastError || new Error('接口请求失败');
  }

  function httpError(status) {
    var err = new Error('接口请求失败（HTTP ' + String(status || 0) + '）');
    err.code = 'http';
    err.status = status || 0;
    return err;
  }

  /** 请求 JSON 接口；非 JSON / HTTP 异常统一抛中文错误 */
  async function requestJson(url) {
    var res = await request(url);
    var text = '';
    try {
      text = await res.text();
    } catch (e) {
      throw timeoutError();
    }
    try {
      return JSON.parse(text);
    } catch (e) {
      var bad = new Error('接口返回非 JSON 数据');
      bad.code = 'parse';
      throw bad;
    }
  }

  /** 跟随重定向解析 b23.tv 短链的最终 URL */
  async function followShortUrl(shortUrl) {
    var res = await request(shortUrl, { accept: HTML_ACCEPT });
    var finalUrl = (res && res.url) || shortUrl;
    try {
      if (typeof res.body !== 'undefined' && res.body && typeof res.body.cancel === 'function') {
        res.body.cancel().catch(function () { /* 丢弃响应体 */ });
      }
    } catch (e) {
      /* 忽略 */
    }
    return finalUrl;
  }

  /** view 接口地址：bvid 与 aid 都支持（有 bvid 优先用 bvid） */
  function viewUrl(target) {
    if (target && target.bvid) return API_VIEW + '?bvid=' + encodeURIComponent(target.bvid);
    return API_VIEW + '?aid=' + encodeURIComponent(String(target && target.aid));
  }

  /** 取 view 接口数据（含 cid / title / duration / pages，aid 请求时还会带回 bvid） */
  async function fetchView(target) {
    var json = await requestJson(viewUrl(target));
    var code = json && typeof json.code === 'number' ? json.code : null;
    if (code === null || code !== 0 || !json.data) {
      var msg = (code === -404 || code === -400 || code === 62002 || code === 62004)
        ? '视频不存在'
        : '接口返回 code=' + String(code);
      var err = new Error(msg);
      err.code = 'api';
      err.apiCode = code;
      throw err;
    }
    return json.data;
  }

  function pickCid(view, page) {
    var pages = view && Array.isArray(view.pages) ? view.pages : null;
    if (page) {
      if (!pages || !pages[page - 1] || !pages[page - 1].cid) {
        var err = new Error('分P不存在（p=' + page + '）');
        err.code = 'api';
        throw err;
      }
      return pages[page - 1].cid;
    }
    if (view && view.cid) return view.cid;
    if (pages && pages[0] && pages[0].cid) return pages[0].cid;
    var missing = new Error('接口返回缺少 cid');
    missing.code = 'api';
    throw missing;
  }

  /**
   * 两条 playurl 分支：
   *  html5  —— platform=html5&high_quality=1，返回可免 Referer 直连的单文件 MP4（优先）
   *  mirror —— 仅 fnval=1，镜像地址必须带 Referer
   */
  var PLAYURL_BRANCHES = [
    {
      name: 'html5',
      needsReferer: false,
      query: { qn: '80', fnval: '1', platform: 'html5', high_quality: '1' }
    },
    {
      name: 'mirror',
      needsReferer: true,
      query: { qn: '80', fnval: '1' }
    }
  ];

  function playurlUrl(target, cid, branch) {
    var idPart = (target && target.bvid)
      ? 'bvid=' + encodeURIComponent(target.bvid)
      : 'aid=' + encodeURIComponent(String(target && target.aid));
    var parts = [idPart, 'cid=' + encodeURIComponent(String(cid))];
    Object.keys(branch.query).forEach(function (key) {
      parts.push(key + '=' + encodeURIComponent(branch.query[key]));
    });
    return API_PLAYURL + '?' + parts.join('&');
  }

  /** 单条分支尝试；失败返回 {ok:false,error}，不抛异常 */
  async function tryPlayurlBranch(target, cid, branch, viewDurationSec) {
    var json;
    try {
      json = await requestJson(playurlUrl(target, cid, branch));
    } catch (e) {
      return { ok: false, error: (e && e.message) || '接口请求失败', code: e && e.code };
    }
    var code = json && typeof json.code === 'number' ? json.code : null;
    if (code !== 0) {
      return { ok: false, error: '接口返回 code=' + String(code), code: 'api' };
    }
    var data = json && json.data;
    var durl = data && Array.isArray(data.durl) ? data.durl : null;
    var mediaUrl = durl && durl[0] && typeof durl[0].url === 'string' ? durl[0].url : '';
    if (!mediaUrl) return { ok: false, error: '播放地址为空', code: 'empty' };

    var durationMs = 0;
    if (typeof data.timelength === 'number' && data.timelength > 0) durationMs = data.timelength;
    else if (durl[0] && typeof durl[0].length === 'number' && durl[0].length > 0) durationMs = durl[0].length;
    else if (typeof viewDurationSec === 'number' && viewDurationSec > 0) durationMs = viewDurationSec * 1000;

    return {
      ok: true,
      mediaUrl: mediaUrl,
      quality: typeof data.quality === 'number' ? data.quality : null,
      durationMs: durationMs,
      needsReferer: branch.needsReferer
    };
  }

  /** 页面地址：有 bvid 用 BV 形态，只有 av 号用 av 形态 */
  function pageUrlFor(target, page) {
    var segment = (target && target.bvid) ? target.bvid : ('av' + String(target && target.aid));
    var base = 'https://www.bilibili.com/video/' + segment + '/';
    return page ? base + '?p=' + page : base;
  }

  /** 缓存钩子统一封装：钩子缺省 / 抛异常都当未命中，绝不阻断主流程 */
  async function cacheGet(opts, key) {
    if (!opts || typeof opts.cacheGet !== 'function') return null;
    try {
      var hit = await opts.cacheGet(key);
      if (!hit || typeof hit.mediaUrl !== 'string' || !hit.mediaUrl) return null;
      // 钩子可能把过期条目原样返回，这里再兜一道
      if (typeof hit.expiresAt === 'number' && hit.expiresAt <= Date.now()) return null;
      return hit;
    } catch (e) {
      return null;
    }
  }

  async function cachePut(opts, key, entry) {
    if (!opts || typeof opts.cachePut !== 'function') return;
    try {
      await opts.cachePut(key, entry);
    } catch (e) {
      /* 缓存写入失败不影响解析结果 */
    }
  }

  /**
   * 解析 B 站视频链接为可直连播放的媒体地址。
   * @param {string} url 视频页链接（bilibili.com / b23.tv 短链）
   * @param {{cacheGet?:Function, cachePut?:Function}} [opts] 可选缓存钩子，
   *        键为 `<bvid>:<cid>`；命中则直接返回（附 cached:true），不回源。
   * @returns {Promise<object>} 成功 {ok:true, provider, bvid, cid, title, durationMs,
   *          mediaUrl, quality, needsReferer, pageUrl}；失败 {ok:false, error}
   */
  async function resolveBilibili(url, opts) {
    try {
      // ① 短链先跟随重定向（短链或最终 URL 上的 ?p= 都要保留）
      var parsed = parseBilibiliUrl(url);
      var page = parsed && parsed.page ? parsed.page : null;
      var wasShort = !!(parsed && parsed.shortUrl);
      if (wasShort) {
        var finalUrl;
        try {
          finalUrl = await followShortUrl(parsed.shortUrl);
        } catch (e) {
          return { ok: false, error: (e && e.message) || '短链解析失败' };
        }
        parsed = parseBilibiliUrl(finalUrl);
        // 最终 URL 上的分P优先；最终 URL 没带 ?p= 时沿用短链上的 ?p=
        if (parsed && parsed.page) page = parsed.page;
      }
      if (!parsed || (!parsed.bvid && !parsed.aid)) {
        return {
          ok: false,
          error: wasShort ? '短链未指向视频页' : '仅支持 BV 号或 av 号视频链接'
        };
      }

      // 记录「输入侧」的标识：决定缓存键形态（BV 输入用 bvid:cid，纯 av 输入用 aid:<aid>:<cid>）
      var inputBvid = parsed.bvid || null;
      var inputAid = parsed.bvid ? null : (parsed.aid || null);
      var bvid = inputBvid;
      var aid = inputAid;

      // ② view 接口：cid / title / duration / pages（bvid 优先，只有 av 号时用 aid）
      var view;
      try {
        view = await fetchView({ bvid: bvid, aid: aid });
      } catch (e) {
        return { ok: false, error: (e && e.message) || '接口请求失败' };
      }
      // aid 请求时 view 会带回 bvid，后续 playurl / 页面地址优先用它
      if (!bvid && view && typeof view.bvid === 'string' && BV_RE.test(view.bvid)) {
        bvid = view.bvid;
      }

      var cid;
      try {
        cid = pickCid(view, page);
      } catch (e) {
        return { ok: false, error: (e && e.message) || '接口返回缺少 cid' };
      }
      var title = typeof view.title === 'string' ? view.title : '';
      var viewDurationSec = typeof view.duration === 'number' ? view.duration : 0;
      var target = { bvid: bvid, aid: aid };

      // ②.5 缓存命中（同 bvid+cid / aid+cid 且未过期）→ 直接返回，不回源
      var cacheKey = inputBvid
        ? inputBvid + ':' + String(cid)
        : 'aid:' + String(inputAid) + ':' + String(cid);
      var cached = await cacheGet(opts, cacheKey);
      if (cached) {
        return buildResult(bvid, aid, cid, (cached.title || title || ''), cached.mediaUrl,
          typeof cached.quality === 'number' ? cached.quality : null,
          typeof cached.durationMs === 'number' ? cached.durationMs : viewDurationSec * 1000,
          false, page, true);
      }

      // ③ 依次尝试 playurl 分支
      var errors = [];
      for (var i = 0; i < PLAYURL_BRANCHES.length; i += 1) {
        var branch = PLAYURL_BRANCHES[i];
        var attempt = await tryPlayurlBranch(target, cid, branch, viewDurationSec);
        if (!attempt.ok) {
          errors.push(branch.name + ' ' + attempt.error);
          continue;
        }
        // ④ 成功结果写入缓存钩子（TTL / 上限由调用方决定）
        await cachePut(opts, cacheKey, {
          mediaUrl: attempt.mediaUrl,
          title: title,
          quality: attempt.quality,
          durationMs: attempt.durationMs || viewDurationSec * 1000
        });
        return buildResult(bvid, aid, cid, title, attempt.mediaUrl, attempt.quality,
          attempt.durationMs || viewDurationSec * 1000, attempt.needsReferer, page, false);
      }

      return { ok: false, error: '获取播放地址失败（' + (errors.join('；') || '接口无数据') + '）' };
    } catch (e) {
      return { ok: false, error: (e && e.message) || '解析失败' };
    }
  }

  /** 成功结果的统一形状（BV 与 av 两种输入共用；av 输入也会带上解析出的 bvid） */
  function buildResult(bvid, aid, cid, title, mediaUrl, quality, durationMs, needsReferer, page, cached) {
    var out = {
      ok: true,
      provider: PROVIDER,
      bvid: bvid || '',
      cid: cid,
      title: title || '',
      durationMs: typeof durationMs === 'number' ? durationMs : 0,
      mediaUrl: mediaUrl,
      quality: typeof quality === 'number' ? quality : null,
      needsReferer: !!needsReferer,
      pageUrl: pageUrlFor({ bvid: bvid, aid: aid }, page)
    };
    if (aid) out.aid = aid;
    if (cached) out.cached = true;
    return out;
  }

  /**
   * 统一入口：目前只路由 B 站，其它输入直接返回 unsupported-provider（不发网络请求）。
   */
  async function resolveMedia(url, opts) {
    var u = toUrl(url);
    if (!u || !isBilibiliHost(String(u.hostname || '').toLowerCase())) {
      return { ok: false, error: 'unsupported-provider' };
    }
    return resolveBilibili(url, opts);
  }

  var ESMedia = {
    PROVIDER: PROVIDER,
    TIMEOUT_MS: TIMEOUT_MS,
    REFERER: REFERER,
    parseBilibiliUrl: parseBilibiliUrl,
    resolveBilibili: resolveBilibili,
    resolveMedia: resolveMedia
  };

  globalThis.ESMedia = ESMedia;
  if (typeof module !== 'undefined' && module.exports) module.exports = ESMedia;
})();