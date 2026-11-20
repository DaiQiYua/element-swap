/**
 * Element Swap - 工具栏弹窗面板逻辑
 * 经典脚本（非 module），依赖 shared/es-shared.js 挂载的全局 ES。
 * 所有 chrome API 回调都检查 chrome.runtime.lastError，绝不抛未捕获异常。
 */
(function () {
  'use strict';

  var ES = globalThis.ES;

  var ICON_TRASH =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M4 7h16"></path>' +
    '<path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7"></path>' +
    '<path d="M6.5 7l.8 11.2A2 2 0 0 0 9.3 20h5.4a2 2 0 0 0 2-1.8L17.5 7"></path>' +
    '<path d="M10.5 11v5.5M13.5 11v5.5"></path>' +
    '</svg>';

  /** 产品只保留「隐藏」与「替换视频」两种规则 */
  var KIND_LABEL = { hide: '隐藏', video: '视频' };
  var KIND_ORDER = ['hide', 'video'];
  /**
   * 历史规则兼容：旧版本可能存有 kind='image'|'embed'。
   * 面板不展示也不计数（不自动删除，避免不可逆操作），仅给一行灰字提示。
   */
  var IGNORED_KINDS = { image: true, embed: true };

  function isVisibleRule(rule) {
    return !!rule && KIND_ORDER.indexOf(rule.kind) >= 0;
  }

  function isIgnoredRule(rule) {
    return !!rule && IGNORED_KINDS[rule.kind] === true;
  }

  var MSG_UNSUPPORTED = '当前页面不支持（浏览器内置页/商店页）';
  var MSG_NO_TAB = '没有找到可用的活动标签页';
  var MSG_EMPTY = '还没有修改规则，点击上方启动拾取器开始';

  /** 抖音抓流消息（契约层 MSG 未收录，走字面量；content 侧按同名实现） */
  var MSG_GRAB_DOUYIN = 'es:grab-douyin';
  var DOUYIN_GRAB_TIMEOUT = 6000;
  var DOUYIN_HOST_RE = /^([a-z0-9-]+\.)?douyin\.com$/i;

  var state = {
    tabId: null,
    url: '',
    supported: false,
    unsupportedReason: '',
    rules: [],
    ignoredCount: 0,
    scope: 'domain',
    busy: false,
    douyin: false
  };

  var douyin = {
    busy: false,
    timer: null,
    result: null,
    applying: false
  };

  var dom = {};
  var toastTimer = null;
  var clearTimer = null;
  var clearArmed = false;
  var refreshToken = 0;
  var lastHighlight = { id: null, at: 0 };

  /* ============ 工具函数 ============ */

  function byId(id) {
    return document.getElementById(id);
  }

  function lastErrMessage() {
    try {
      return chrome.runtime && chrome.runtime.lastError ? chrome.runtime.lastError.message || 'unknown' : '';
    } catch (e) {
      return '';
    }
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function shorten(text, max) {
    var s = typeof text === 'string' ? text : '';
    if (!s) return '';
    if (s.length <= max) return s;
    return '…' + s.slice(s.length - max);
  }

  function urlTail(url, max) {
    var s = typeof url === 'string' ? url : '';
    if (!s) return '';
    var clean = s.split('?')[0].split('#')[0];
    var segs = clean.split('/');
    var tail = segs.slice(-2).join('/');
    if (!tail) tail = clean;
    return shorten(tail, max);
  }

  function kindLabel(kind) {
    return KIND_LABEL[kind] || '规则';
  }

  /**
   * 取 payload 里的直链（视频直链）。
   * 兼容历史形态：payload 曾是字符串；现行为对象 { url }。
   */
  function payloadDirectUrl(payload) {
    if (typeof payload === 'string') return payload.trim();
    if (payload && typeof payload === 'object' && typeof payload.url === 'string') {
      return payload.url.trim();
    }
    return '';
  }

  /**
   * 取「视频页面链接」来源：payload.source = { provider, pageUrl }。
   * 非法结构一律返回 null，避免脏数据把面板渲染搞崩。
   */
  function payloadSource(payload) {
    if (!payload || typeof payload !== 'object') return null;
    var source = payload.source;
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    var pageUrl = typeof source.pageUrl === 'string' ? source.pageUrl.trim() : '';
    if (!pageUrl) return null;
    var provider = typeof source.provider === 'string' ? source.provider.trim().toLowerCase() : '';
    return { provider: provider, pageUrl: pageUrl };
  }

  /** 从 B 站 pageUrl 提取编号：BV1ZMWd6mE77 / av12345；失败返回空串 */
  function bilibiliRef(pageUrl) {
    var m = /\/video\/(BV[0-9A-Za-z]+)/.exec(pageUrl) || /\/video\/(av\d+)/i.exec(pageUrl);
    if (m) return m[1];
    var query = /[?&]bvid=(BV[0-9A-Za-z]+)/.exec(pageUrl);
    return query ? query[1] : '';
  }

  var PROVIDER_LABEL = { bilibili: 'B 站', douyin: '抖音', youtube: 'YouTube' };

  /** payload.audioUrl：分离流（DASH）规则才会有的第二条地址，非法值一律当成没有 */
  function payloadAudioUrl(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
    var audio = typeof payload.audioUrl === 'string' ? payload.audioUrl.trim() : '';
    return audio && /^https?:\/\//i.test(audio) ? audio : '';
  }

  /** 视频规则的次级信息：直链优先（与 content 侧「先判直链」一致），其次页面链接 */
  function describeVideo(rule) {
    var payload = rule && rule.payload;
    var direct = payloadDirectUrl(payload);
    if (direct) {
      // 有音轨的规则补一句「含音轨」：看得出这条规则是画面+声音双流
      return '视频替换 · ' + urlTail(direct, 26) + (payloadAudioUrl(payload) ? ' · 含音轨' : '');
    }

    var source = payloadSource(payload);
    if (!source) return '视频替换';

    var providerLabel = PROVIDER_LABEL[source.provider] || '';
    var ref = source.provider === 'bilibili' ? bilibiliRef(source.pageUrl) : '';
    if (providerLabel && ref) return '视频替换 · ' + providerLabel + ' · ' + ref;
    if (providerLabel) return '视频替换 · ' + providerLabel + '链接';
    return '视频替换 · 页面链接';
  }

  /** 次级信息行的 title：直链放完整 url，页面链接形态放完整 pageUrl；有音轨时一并给出 */
  function metaTitleOf(rule) {
    var payload = rule && rule.payload;
    var audio = payloadAudioUrl(payload);
    var direct = payloadDirectUrl(payload);
    if (direct) return audio ? direct + ' · 音轨 ' + audio : direct;
    var source = payloadSource(payload);
    return source ? source.pageUrl : '';
  }

  /* ============ 抖音抓流（仅抖音域） ============ */

  function isDouyinHost(url) {
    try {
      return DOUYIN_HOST_RE.test(new URL(url).hostname);
    } catch (e) {
      return false;
    }
  }

  /** 把 content 返回的 error 码翻成可读中文 */
  function douyinErrorMessage(error, message) {
    var hint = typeof message === 'string' ? message.trim() : '';
    if (error === 'not-douyin') return '当前页不是抖音页面';
    if (error === 'no-video') return hint || '当前页没有找到视频元素，请确认视频已在页面中播放';
    if (error === 'empty' || error === 'no-stream') {
      return hint || '没有抓到视频流地址，请先在该视频页播放一次再试';
    }
    if (error === 'no-content-script') return '页面脚本未就绪，请刷新页面后重试';
    if (error === 'unknown-message') return '页面脚本版本过旧，请刷新页面后重试';
    if (hint) return hint;
    if (error) return '抓取失败（' + error + '）';
    return '抓取失败，请重试';
  }

  /** 抓到的地址只做截断显示：保留末尾有辨识度的一段，完整地址放 title */
  function douyinUrlDisplay(url) {
    var clean = String(url || '').split('#')[0].split('?')[0];
    if (!clean) return '';
    return shorten(clean, 46) || clean;
  }

  /** 剪贴板降级：临时 textarea + execCommand('copy') */
  function fallbackCopy(text) {
    var ta = null;
    try {
      ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.left = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        ta.setSelectionRange(0, text.length);
      } catch (e) {
        /* 部分环境不支持，忽略 */
      }
      var ok = !!(document.execCommand && document.execCommand('copy'));
      return ok;
    } catch (e) {
      return false;
    } finally {
      if (ta && ta.parentNode) ta.parentNode.removeChild(ta);
    }
  }

  /* ============ chrome API 包装（全部容错） ============ */

  function queryActiveTab() {
    return new Promise(function (resolve) {
      try {
        if (!chrome.tabs || !chrome.tabs.query) return resolve(null);
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
          if (lastErrMessage()) return resolve(null);
          resolve(tabs && tabs[0] ? tabs[0] : null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  function sendToTab(tabId, message) {
    return new Promise(function (resolve) {
      if (typeof tabId !== 'number' || tabId < 0) return resolve({ ok: false, error: 'no-tab' });
      try {
        if (!chrome.tabs || !chrome.tabs.sendMessage) return resolve({ ok: false, error: 'no-api' });
        chrome.tabs.sendMessage(tabId, message, function (response) {
          var err = lastErrMessage();
          if (err) return resolve({ ok: false, error: err });
          resolve({ ok: true, response: response });
        });
      } catch (e) {
        resolve({ ok: false, error: String((e && e.message) || e) });
      }
    });
  }

  function executeFiles(tabId, files) {
    return new Promise(function (resolve) {
      try {
        if (!chrome.scripting || !chrome.scripting.executeScript) return resolve(false);
        chrome.scripting.executeScript({ target: { tabId: tabId }, files: files }, function () {
          resolve(!lastErrMessage());
        });
      } catch (e) {
        resolve(false);
      }
    });
  }

  /** 探测内容脚本；缺失则补注入 shared + content 后重试 */
  function ensureContentScript(tabId) {
    return sendToTab(tabId, { type: ES.MSG.GET_STATE }).then(function (probe) {
      if (probe.ok) return true;
      return executeFiles(tabId, ['shared/es-shared.js', 'content/content.js']).then(function (injected) {
        if (!injected) return false;
        var attempt = 0;
        function retry() {
          return sendToTab(tabId, { type: ES.MSG.GET_STATE }).then(function (res) {
            if (res.ok) return true;
            attempt += 1;
            if (attempt >= 4) return false;
            return sleep(90).then(retry);
          });
        }
        return retry();
      });
    });
  }

  function notifyRulesChanged() {
    if (!state.supported || typeof state.tabId !== 'number') return Promise.resolve(false);
    return sendToTab(state.tabId, { type: ES.MSG.RULES_CHANGED }).then(function (res) {
      return res.ok;
    }, function () {
      return false;
    });
  }

  /* ============ DOM 工具 ============ */

  function clearChildren(node) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function make(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (typeof text === 'string') node.textContent = text;
    return node;
  }

  /* ============ 提示条 ============ */

  function showToast(message, tone) {
    if (!dom.toast) return;
    dom.toast.textContent = message;
    dom.toast.className = 'toast toast--show toast--' + (tone || 'ok');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      dom.toast.className = 'toast';
      toastTimer = null;
    }, 2400);
  }

  /* ============ 渲染 ============ */

  function setVersion() {
    var version = '';
    try {
      if (chrome.runtime && typeof chrome.runtime.getManifest === 'function') {
        var manifest = chrome.runtime.getManifest();
        version = (manifest && manifest.version) || '';
      }
    } catch (e) {
      version = '';
    }
    if (dom.appVersion) dom.appVersion.textContent = version ? 'v' + version : '—';
  }

  function renderSupport() {
    var supported = state.supported && !state.busy;
    if (dom.pickBtn) {
      dom.pickBtn.disabled = !supported;
      dom.pickBtn.setAttribute('aria-disabled', supported ? 'false' : 'true');
    }
    if (dom.pickLabel) dom.pickLabel.textContent = state.busy ? '正在启动…' : '启动拾取器';
    if (dom.pickUnsupported) {
      dom.pickUnsupported.hidden = state.supported;
      dom.pickUnsupported.textContent = state.unsupportedReason || MSG_UNSUPPORTED;
    }
    if (dom.pickHint) {
      dom.pickHint.textContent = state.supported
        ? '点击后在页面上点选元素，按 Esc 退出'
        : '仅支持普通网页（http / https）';
    }
  }

  function renderScope() {
    if (!dom.scopeSwitch) return;
    // 纯视觉状态：驱动分段控件里滑块的位置（不改任何数据/消息行为）
    dom.scopeSwitch.classList.toggle('is-url', state.scope === ES.SCOPE.URL);
    var btns = dom.scopeSwitch.querySelectorAll('.seg-btn');
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].getAttribute('data-scope') === state.scope;
      btns[i].classList.toggle('is-active', on);
      btns[i].setAttribute('aria-checked', on ? 'true' : 'false');
    }
    if (dom.scopeState) {
      dom.scopeState.textContent = state.scope === ES.SCOPE.URL ? '当前网址' : '当前域名';
    }
  }

  function describeRule(rule) {
    var kind = rule && rule.kind;

    if (kind === ES.KIND.VIDEO) {
      return describeVideo(rule);
    }
    var scopeLabel = rule && rule.scope === ES.SCOPE.URL ? '本页' : '域名';
    return '保存粒度：' + scopeLabel;
  }

  function buildRuleRow(rule) {
    var kind = KIND_ORDER.indexOf(rule.kind) >= 0 ? rule.kind : 'hide';
    var li = make('li', 'rule');
    li.setAttribute('data-kind', kind);
    li.setAttribute('tabindex', '0');
    li.setAttribute('aria-label', '规则 ' + kindLabel(kind) + '，选择器 ' + (rule.selector || '未提供'));

    var badge = make('span', 'badge badge--' + kind, kindLabel(kind));
    badge.setAttribute('aria-hidden', 'true');

    var body = make('div', 'rule-body');

    var selector = make('code', 'rule-selector', rule.selector || '(未提供选择器)');
    selector.title = rule.selector || '';
    body.appendChild(selector);

    var metaText = describeRule(rule);
    var meta = make('span', 'rule-meta', metaText);
    // 完整地址放 title：直链放 url，B 站等页面链接放 pageUrl（行内只做截断显示）
    var metaTitleText = metaTitleOf(rule);
    if (metaTitleText) meta.title = metaTitleText;
    body.appendChild(meta);

    var del = make('button', 'rule-del');
    del.type = 'button';
    del.innerHTML = ICON_TRASH;
    del.setAttribute('aria-label', '删除该规则：' + kindLabel(kind));
    del.title = '删除该规则';
    del.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      deleteRule(rule);
    });

    li.appendChild(badge);
    li.appendChild(body);
    li.appendChild(del);

    li.addEventListener('mouseenter', function () {
      highlightRule(rule);
    });
    li.addEventListener('focus', function () {
      highlightRule(rule);
    });
    li.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        highlightRule(rule);
      }
    });

    return li;
  }

  function renderList() {
    if (!dom.ruleList) return;
    var rules = Array.isArray(state.rules) ? state.rules : [];

    if (dom.rulesTitle) dom.rulesTitle.textContent = '本站生效规则 (' + rules.length + ')';

    if (dom.rulesHost) {
      var keys = state.url ? ES.keysForUrl(state.url) : { host: '' };
      dom.rulesHost.textContent = state.supported ? keys.host || '' : '';
      dom.rulesHost.title = state.url || '';
    }

    clearChildren(dom.ruleList);

    var showEmpty = !state.supported || rules.length === 0;
    if (showEmpty) {
      dom.ruleList.hidden = true;
      if (dom.emptyState) {
        dom.emptyState.hidden = false;
        dom.emptyState.classList.toggle('empty--warn', !state.supported);
      }
      if (dom.emptyText) {
        dom.emptyText.textContent = state.supported
          ? MSG_EMPTY
          : state.unsupportedReason || MSG_UNSUPPORTED;
      }
    } else {
      dom.ruleList.hidden = false;
      if (dom.emptyState) dom.emptyState.hidden = true;
      for (var i = 0; i < rules.length; i++) {
        dom.ruleList.appendChild(buildRuleRow(rules[i]));
      }
    }

    if (dom.clearBtn) {
      dom.clearBtn.disabled = !state.supported || (rules.length === 0 && !state.ignoredCount);
      if (dom.clearBtn.disabled) disarmClear();
    }

    renderIgnoredNotice();
  }

  /** 历史 image/embed 规则的极轻量提示：默认隐藏，不抢占注意力 */
  function renderIgnoredNotice() {
    if (!dom.rulesIgnored) return;
    var ignored = state.supported && state.ignoredCount > 0 ? state.ignoredCount : 0;
    dom.rulesIgnored.hidden = ignored === 0;
    dom.rulesIgnored.textContent = ignored > 0 ? '已忽略 ' + ignored + ' 条旧版图片/嵌入规则' : '';
  }

  /* ============ 抖音卡片：状态与交互 ============ */

  function setGrabButtonBusy(busy) {
    if (dom.douyinGrabBtn) {
      dom.douyinGrabBtn.disabled = !!busy;
      dom.douyinGrabBtn.classList.toggle('is-loading', !!busy);
    }
    if (dom.douyinGrabLabel) dom.douyinGrabLabel.textContent = busy ? '抓取中…' : '抓取当前页面视频流';
  }

  function showDouyinError(text) {
    if (!dom.douyinError) return;
    dom.douyinError.textContent = String(text || '');
    dom.douyinError.hidden = false;
  }

  function hideDouyinError() {
    if (!dom.douyinError) return;
    dom.douyinError.textContent = '';
    dom.douyinError.hidden = true;
  }

  function resetDouyin() {
    douyin.busy = false;
    douyin.applying = false;
    douyin.result = null;
    if (douyin.timer) {
      clearTimeout(douyin.timer);
      douyin.timer = null;
    }
    setGrabButtonBusy(false);
    if (dom.douyinResult) dom.douyinResult.hidden = true;
    if (dom.douyinSource) dom.douyinSource.textContent = '已抓到 · 来源：—';
    if (dom.douyinUrl) {
      dom.douyinUrl.textContent = '';
      dom.douyinUrl.removeAttribute('title');
    }
    if (dom.douyinAudio) {
      dom.douyinAudio.textContent = '';
      dom.douyinAudio.removeAttribute('title');
    }
    if (dom.douyinRowAudio) dom.douyinRowAudio.hidden = true;
    if (dom.douyinCopyBtn) dom.douyinCopyBtn.hidden = false;
    if (dom.douyinApplyBtn) dom.douyinApplyBtn.disabled = false;
    hideDouyinError();
  }

  function setDouyinVisible(visible) {
    state.douyin = !!visible;
    if (dom.douyinCard) dom.douyinCard.hidden = !visible;
    if (dom.app) dom.app.classList.toggle('has-douyin', !!visible);
    if (!visible) resetDouyin();
  }

  function renderDouyinResult(data) {
    var audioUrl = typeof data.audioUrl === 'string' ? data.audioUrl.trim() : '';
    var isDash = data.track === 'dash' && !!audioUrl;
    douyin.result = {
      url: typeof data.url === 'string' ? data.url : '',
      // 分离流（DASH）：音频轨单独一条，应用时一并写进规则 payload
      audioUrl: isDash ? audioUrl : '',
      selector: typeof data.selector === 'string' && data.selector.trim() ? data.selector.trim() : 'video'
    };
    if (dom.douyinSource) {
      // note 由内容脚本按轨类型给出（纯视频轨 → 可能没有声音），沿用来源行的文案位
      var note = typeof data.note === 'string' ? data.note.trim() : '';
      dom.douyinSource.textContent = '已抓到 · 来源：' + (data.source || '页面网络') + (note ? ' · ' + note : '');
    }
    if (dom.douyinUrl) {
      var full = douyin.result.url;
      // 分离流各占一行便于核对：画面 / 声音分开显示，否则两条地址挤在一行没法分辨
      dom.douyinUrl.textContent = (isDash ? '画面 · ' : '') + douyinUrlDisplay(full);
      dom.douyinUrl.title = full;
    }
    if (dom.douyinAudio) {
      if (douyin.result.audioUrl) {
        dom.douyinAudio.textContent = '声音 · ' + douyinUrlDisplay(douyin.result.audioUrl);
        dom.douyinAudio.title = douyin.result.audioUrl;
      } else {
        dom.douyinAudio.textContent = '';
        dom.douyinAudio.removeAttribute('title');
      }
    }
    if (dom.douyinRowAudio) dom.douyinRowAudio.hidden = !douyin.result.audioUrl;
    if (dom.douyinResult) dom.douyinResult.hidden = false;
  }

  function grabDouyin() {
    if (douyin.busy) return;
    if (!state.douyin || !state.supported || typeof state.tabId !== 'number') return;

    douyin.busy = true;
    setGrabButtonBusy(true);
    hideDouyinError();

    var settled = false;
    function settle(apply) {
      if (settled) return;
      settled = true;
      douyin.busy = false;
      if (douyin.timer) {
        clearTimeout(douyin.timer);
        douyin.timer = null;
      }
      setGrabButtonBusy(false);
      apply();
    }

    douyin.timer = setTimeout(function () {
      settle(function () {
        showDouyinError('抓取超时，请确认视频已在页面中播放后重试');
      });
    }, DOUYIN_GRAB_TIMEOUT);

    sendToTab(state.tabId, { type: MSG_GRAB_DOUYIN }).then(function (res) {
      if (res.ok) return res;
      // 无内容脚本（页面刚打开 / 被禁用）：先补注入再重试一次，仍然失败给可读提示
      return ensureContentScript(state.tabId).then(function (ready) {
        if (!ready) return { ok: false, error: 'no-content-script' };
        return sendToTab(state.tabId, { type: MSG_GRAB_DOUYIN });
      }).then(function (retried) {
        return retried && retried.ok ? retried : { ok: false, error: 'no-content-script' };
      });
    }).then(function (res) {
      if (settled) return;
      if (!res || !res.ok) {
        settle(function () {
          showDouyinError(douyinErrorMessage((res && res.error) || 'no-content-script', ''));
        });
        return;
      }
      var data = res.response;
      if (!data || data.ok !== true) {
        var code = (data && data.error) || 'unknown-message';
        settle(function () {
          showDouyinError(douyinErrorMessage(code, data && data.message));
        });
        return;
      }
      settle(function () {
        renderDouyinResult(data);
        showToast('已抓到视频流地址');
      });
    }).catch(function () {
      settle(function () {
        showDouyinError('抓取失败，请重试');
      });
    });
  }

  /** 把一段纯 URL 写进剪贴板（优先异步 API，失败降级 execCommand），成功后走既有权重的 toast */
  function copyPlainText(text, okText) {
    function done(ok) {
      showToast(ok ? okText : '复制失败，请手动选择地址', ok ? 'ok' : 'error');
    }
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(text).then(function () {
          done(true);
        }, function () {
          done(fallbackCopy(text));
        });
        return;
      }
    } catch (e) {
      /* 落到降级路径 */
    }
    done(fallbackCopy(text));
  }

  /**
   * 一个按钮复制：分离流时一次复制两条（画面换行声音，无前缀），整段粘回面板即可自动分割；
   * 单条时只复制那一条。两条都用 \n 分隔，方便直接粘。
   */
  function copyDouyinUrl() {
    var data = douyin.result;
    var url = data && data.url ? data.url : '';
    if (!url) {
      showDouyinError('没有可复制的地址，请先抓取');
      return;
    }
    var audio = data && data.audioUrl ? data.audioUrl : '';
    if (audio) {
      copyPlainText(url + '\n' + audio, '画面与声音地址已复制');
      return;
    }
    copyPlainText(url, '视频地址已复制');
  }

  function applyDouyinToPage() {
    var data = douyin.result;
    if (!data || !data.url) {
      showDouyinError('没有可用的视频地址，请先抓取');
      return;
    }
    if (!state.supported || typeof state.tabId !== 'number' || !state.url) {
      showToast('当前页面不支持替换', 'warn');
      return;
    }
    if (douyin.applying) return;
    douyin.applying = true;
    if (dom.douyinApplyBtn) dom.douyinApplyBtn.disabled = true;

    function finish() {
      douyin.applying = false;
      if (dom.douyinApplyBtn) dom.douyinApplyBtn.disabled = false;
    }

    ES.getSettings().then(function (settings) {
      var scope = settings && settings.scope === ES.SCOPE.URL ? ES.SCOPE.URL : ES.SCOPE.DOMAIN;
      var payload = { url: data.url };
      // 分离流：音频轨一起写进 payload，内容脚本会用它做「双流替换 + 同步」
      if (data.audioUrl) payload.audioUrl = data.audioUrl;
      return ES.addRule(state.url, scope, {
        kind: ES.KIND.VIDEO,
        selector: data.selector,
        tag: 'video',
        label: 'main video',
        payload: payload
      });
    }).then(function () {
      return notifyRulesChanged();
    }).then(function () {
      return refreshRules();
    }).then(function () {
      finish();
      showToast('已替换本页主视频');
    }, function () {
      finish();
      showToast('替换失败，请重试', 'error');
    });
  }

  /* ============ 数据刷新 ============ */

  function applyRules(list) {
    var visible = [];
    var ignored = 0;
    var source = Array.isArray(list) ? list : [];
    for (var i = 0; i < source.length; i++) {
      if (isVisibleRule(source[i])) visible.push(source[i]);
      else if (isIgnoredRule(source[i])) ignored += 1;
    }
    state.rules = visible;
    state.ignoredCount = ignored;
    renderList();
  }

  function refreshRules() {
    refreshToken += 1;
    var token = refreshToken;
    if (!state.supported || !state.url) {
      state.rules = [];
      state.ignoredCount = 0;
      renderList();
      return Promise.resolve();
    }
    return ES.listRules(state.url).then(function (rules) {
      if (token !== refreshToken) return;
      applyRules(rules);
    }, function () {
      if (token !== refreshToken) return;
      state.rules = [];
      state.ignoredCount = 0;
      renderList();
      showToast('读取规则失败', 'error');
    });
  }

  function loadTab() {
    return queryActiveTab().then(function (tab) {
      if (!tab || typeof tab.id !== 'number' || tab.id < 0) {
        state.tabId = null;
        state.url = '';
        state.supported = false;
        state.unsupportedReason = MSG_NO_TAB;
        state.rules = [];
        state.ignoredCount = 0;
        renderSupport();
        renderList();
        return;
      }
      state.tabId = tab.id;
      var rawUrl = tab.url || tab.pendingUrl || '';
      var supported = /^https?:\/\//i.test(rawUrl);
      state.url = supported ? rawUrl : '';
      state.supported = supported;
      state.unsupportedReason = supported ? '' : MSG_UNSUPPORTED;
      renderSupport();
      // 抖音抓流卡片：仅抖音域出现
      setDouyinVisible(supported && isDouyinHost(rawUrl));
      if (!supported) {
        state.rules = [];
        state.ignoredCount = 0;
        renderList();
        return;
      }
      return refreshRules();
    }, function () {
      state.tabId = null;
      state.supported = false;
      state.unsupportedReason = MSG_NO_TAB;
      state.rules = [];
      state.ignoredCount = 0;
      setDouyinVisible(false);
      renderSupport();
      renderList();
    });
  }

  /* ============ 交互：拾取器 ============ */

  function startPick() {
    if (state.busy) return;
    if (!state.supported || typeof state.tabId !== 'number') {
      showToast(state.unsupportedReason || MSG_UNSUPPORTED, 'warn');
      return;
    }
    state.busy = true;
    renderSupport();

    ensureContentScript(state.tabId).then(function (ready) {
      if (!ready) {
        state.busy = false;
        renderSupport();
        showToast('无法注入脚本，请刷新页面后重试', 'error');
        return null;
      }
      return sendToTab(state.tabId, { type: ES.MSG.START_PICK }).then(function (res) {
        if (!res.ok) {
          state.busy = false;
          renderSupport();
          showToast('拾取器启动失败，请刷新页面后重试', 'error');
          return null;
        }
        try {
          window.close();
        } catch (e) {
          /* 忽略：某些环境下 window.close 不可用 */
        }
        return null;
      });
    }).catch(function () {
      state.busy = false;
      renderSupport();
      showToast('拾取器启动失败，请重试', 'error');
    });
  }

  /* ============ 交互：保存粒度 ============ */

  function setScope(scope) {
    if (scope !== ES.SCOPE.DOMAIN && scope !== ES.SCOPE.URL) return;
    if (scope === state.scope) return;
    state.scope = scope;
    renderScope();
    ES.updateSettings({ scope: scope }).then(function () {
      showToast(scope === ES.SCOPE.URL ? '保存粒度已切换为当前网址' : '保存粒度已切换为当前域名');
      renderScope();
      renderList();
    }, function () {
      showToast('保存设置失败', 'error');
    });
  }

  function onScopeClick(ev) {
    var target = ev.target;
    var btn = target && target.closest ? target.closest('.seg-btn') : null;
    if (!btn) return;
    setScope(btn.getAttribute('data-scope'));
  }

  /* ============ 交互：高亮 / 删除 / 清除 ============ */

  function highlightRule(rule) {
    if (!state.supported || typeof state.tabId !== 'number' || !rule) return;
    var now = Date.now();
    if (lastHighlight.id === rule.id && now - lastHighlight.at < 350) return;
    lastHighlight.id = rule.id;
    lastHighlight.at = now;
    sendToTab(state.tabId, { type: ES.MSG.HIGHLIGHT_RULE, rule: rule });
  }

  function deleteRule(rule) {
    if (!rule || !state.url) return;
    ES.removeRule(state.url, rule.scope, rule.id).then(function () {
      return notifyRulesChanged();
    }).then(function () {
      return refreshRules();
    }).then(function () {
      showToast('已删除该规则');
    }, function () {
      showToast('删除失败，请重试', 'error');
    });
  }

  function disarmClear() {
    clearArmed = false;
    if (clearTimer) {
      clearTimeout(clearTimer);
      clearTimer = null;
    }
    if (dom.clearBtn) {
      dom.clearBtn.classList.remove('is-armed');
      dom.clearBtn.setAttribute('aria-label', '清除本站全部修改');
    }
    if (dom.clearLabel) dom.clearLabel.textContent = '清除本站全部修改';
  }

  function armClear() {
    clearArmed = true;
    if (dom.clearBtn) {
      dom.clearBtn.classList.add('is-armed');
      dom.clearBtn.setAttribute('aria-label', '再点一次确认清除本站全部修改');
    }
    if (dom.clearLabel) dom.clearLabel.textContent = '再点一次确认清除';
    if (clearTimer) clearTimeout(clearTimer);
    clearTimer = setTimeout(function () {
      clearTimer = null;
      disarmClear();
    }, 3000);
  }

  function doClear() {
    disarmClear();
    if (!state.url) return;
    ES.clearForUrl(state.url).then(function () {
      return notifyRulesChanged();
    }).then(function () {
      return refreshRules();
    }).then(function () {
      showToast('已清除本站全部修改');
    }, function () {
      showToast('清除失败，请重试', 'error');
    });
  }

  function onClearClick() {
    if (dom.clearBtn && dom.clearBtn.disabled) return;
    if (!clearArmed) {
      armClear();
      return;
    }
    doClear();
  }

  /* ============ 其他绑定 ============ */

  function bindBrandImage() {
    var img = dom.brandImg;
    if (!img) return;
    img.addEventListener('load', function () {
      // 图标文件存在时用真实图标，否则保留内联 SVG 兜底
      img.style.display = 'block';
    });
    img.addEventListener('error', function () {
      img.style.display = 'none';
    });
  }

  function bindStorage() {
    if (typeof chrome === 'undefined' || !chrome || !chrome.storage || !chrome.storage.onChanged) return;
    chrome.storage.onChanged.addListener(function (changes, areaName) {
      if (areaName !== 'local' || !changes) return;
      var settingsChange = changes[ES.STORAGE.SETTINGS];
      if (settingsChange) {
        var next = settingsChange.newValue;
        var scope = next && next.scope;
        if (scope === ES.SCOPE.URL || scope === ES.SCOPE.DOMAIN) {
          if (scope !== state.scope) {
            state.scope = scope;
            renderScope();
          }
        }
      }
      if (changes[ES.STORAGE.RULES]) {
        refreshRules();
      }
    });
  }

  function bindEvents() {
    if (dom.pickBtn) dom.pickBtn.addEventListener('click', startPick);
    if (dom.scopeSwitch) dom.scopeSwitch.addEventListener('click', onScopeClick);
    if (dom.clearBtn) dom.clearBtn.addEventListener('click', onClearClick);
    if (dom.douyinGrabBtn) dom.douyinGrabBtn.addEventListener('click', grabDouyin);
    if (dom.douyinCopyBtn) dom.douyinCopyBtn.addEventListener('click', copyDouyinUrl);
    if (dom.douyinApplyBtn) dom.douyinApplyBtn.addEventListener('click', applyDouyinToPage);
  }

  function fatal(message) {
    if (dom.pickBtn) {
      dom.pickBtn.disabled = true;
      dom.pickBtn.setAttribute('aria-disabled', 'true');
    }
    showToast(message, 'error');
  }

  /* ============ 启动 ============ */

  function boot() {
    dom = {
      app: byId('app'),
      toast: byId('toast'),
      brandImg: byId('brandImg'),
      pickBtn: byId('pickBtn'),
      pickLabel: byId('pickLabel'),
      pickHint: byId('pickHint'),
      pickUnsupported: byId('pickUnsupported'),
      scopeSwitch: byId('scopeSwitch'),
      scopeState: byId('scopeState'),
      rulesTitle: byId('rulesTitle'),
      rulesHost: byId('rulesHost'),
      ruleList: byId('ruleList'),
      rulesIgnored: byId('rulesIgnored'),
      emptyState: byId('emptyState'),
      emptyText: byId('emptyText'),
      clearBtn: byId('clearBtn'),
      clearLabel: byId('clearLabel'),
      appVersion: byId('appVersion'),
      privacyNote: byId('privacyNote'),
      douyinCard: byId('douyinCard'),
      douyinGrabBtn: byId('douyinGrabBtn'),
      douyinGrabLabel: byId('douyinGrabLabel'),
      douyinError: byId('douyinError'),
      douyinResult: byId('douyinResult'),
      douyinSource: byId('douyinSource'),
      douyinUrl: byId('douyinUrl'),
      douyinAudio: byId('douyinAudio'),
      douyinRowAudio: byId('douyinRowAudio'),
      douyinCopyBtn: byId('douyinCopyBtn'),
      douyinApplyBtn: byId('douyinApplyBtn')
    };

    if (dom.emptyState) dom.emptyState.hidden = true;
    if (dom.ruleList) dom.ruleList.hidden = false;

    bindBrandImage();
    setVersion();

    if (!ES) {
      fatal('共享脚本加载失败，请重新安装扩展');
      return;
    }

    bindEvents();
    bindStorage();

    ES.getSettings().then(function (settings) {
      state.scope = settings && settings.scope === ES.SCOPE.URL ? ES.SCOPE.URL : ES.SCOPE.DOMAIN;
      renderScope();
    }, function () {
      state.scope = ES.SCOPE.DOMAIN;
      renderScope();
    }).then(function () {
      return loadTab();
    }).catch(function () {
      state.supported = false;
      state.unsupportedReason = MSG_NO_TAB;
      state.rules = [];
      state.ignoredCount = 0;
      renderSupport();
      renderList();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();