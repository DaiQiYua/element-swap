/**
 * Element Swap - 内容脚本主体
 *
 * 职责：
 *  1. 规则应用（幂等、可撤销）：隐藏元素 / 替换视频
 *     历史遗留的 image / embed 规则一律静默忽略（不应用、不删除存储）
 *  2. 可视化拾取器（十字光标 + 高亮框）
 *  3. 页内操作面板（Shadow DOM 隔离）
 *  4. 与 popup / background 的消息处理
 *
 * 经典脚本（非 ESM），由 manifest 在 document_end 注册，依赖 shared/es-shared.js 提供的全局 ES。
 */
(function () {
  'use strict';

  /* ================================================================== *
   * 0. 重复注入保护
   * popup 可能用 chrome.scripting.executeScript 补注入一份，这里必须挡住。
   * ================================================================== */
  const HAS_EXTENSION = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;
  if (!HAS_EXTENSION) return; // 被注入到 MAIN world 等无扩展 API 的环境，直接退出，不写 DOM 标记

  if (window.__ES_LOADED__) return;
  if (document.documentElement && document.documentElement.hasAttribute('data-es-loaded')) return;
  window.__ES_LOADED__ = true;
  if (document.documentElement) document.documentElement.setAttribute('data-es-loaded', '1');

  const ES = globalThis.ES;
  if (!ES) return; // 契约缺失（脚本顺序错乱），静默退出

  const MSG = ES.MSG;
  const KIND = ES.KIND;
  const SCOPE = ES.SCOPE;

  /** 自身写入节点的统一标记，apply 与 MutationObserver 都靠它排除自己 */
  const INTERNAL_SELECTOR = '[data-es-internal],[data-es-replacement],[data-es-ui]';
  const MAX_Z_PANEL = '2147483647';
  const MAX_Z_HIGHLIGHT = '2147483646';

  const state = {
    applying: false,        // 正在应用规则（防重入 + 防观察者自激）
    loaded: false,          // 是否已从 storage 读过上下文
    pickerActive: false,
    appliedCount: 0,
    misses: 0,              // 定位失败计数（内部 debug）
    conflicts: 0,           // 同一元素被更高优先级规则占用而被顶掉的规则数
    siteKey: '',
    scope: SCOPE.DOMAIN,
    settings: { scope: SCOPE.DOMAIN },
    rules: [],              // 当前页生效规则
    hideCss: '',
    pendingSweep: false,    // apply 期间又有页面变动，结束后补一次
    // 面板「替换视频」只有一个输入框：整段粘贴时被识别出的音频轨地址暂存在这里，
    // 不出现在任何输入框里，保存时与画面地址一起落库。关闭/取消/切 kind 一律清空。
    pendingAudioUrl: ''
  };

  /* ================================================================== *
   * 1. 通用小工具
   * ================================================================== */
  function normText(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function localOf(el) {
    return (el && (el.localName || el.tagName || '')).toLowerCase();
  }

  function isHttpUrl(value) {
    return /^https?:\/\//i.test(String(value == null ? '' : value).trim());
  }

  function toArray(list) {
    return Array.prototype.slice.call(list || []);
  }

  /** 属性选择器里的值转义（只处理引号与反斜杠，够用且不会抛异常） */
  function attrValue(value) {
    return String(value == null ? '' : value).replace(/["\\]/g, '\\$&');
  }

  /** 是否属于扩展自身的 UI / 注入节点 */
  function isOwnNode(node) {
    if (!node || node.nodeType !== 1) return false;
    try {
      if (node.matches && node.matches(INTERNAL_SELECTOR)) return true;
      return !!(node.closest && node.closest(INTERNAL_SELECTOR));
    } catch (e) {
      return false;
    }
  }

  /** 用 !important 写内联样式，尽量不被页面 CSS 影响 */
  function styleImportant(el, props) {
    if (!el || !el.style) return;
    Object.keys(props).forEach(function (key) {
      el.style.setProperty(key, props[key], 'important');
    });
  }

  function removeNode(node) {
    if (node && node.parentNode) node.parentNode.removeChild(node);
  }

  /* ================================================================== *
   * 2. 内部 <style> 写入（隐藏规则、拾取光标都由它管理）
   * ================================================================== */
  function removeInternalStyle(id) {
    toArray(document.querySelectorAll('style[data-es-internal]')).forEach(function (node) {
      if (node.id === id) removeNode(node);
    });
  }

  function writeInternalStyle(id, css) {
    removeInternalStyle(id);
    if (!css || !css.trim()) return;
    const style = document.createElement('style');
    style.id = id;
    style.setAttribute('data-es-internal', '');
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  /* ================================================================== *
   * 3. 选择器 / XPath / 标签 生成
   * ================================================================== */

  /** 能用来做选择器的稳定类名：合法、长度 ≤20，最多两个 */
  function stableClasses(el) {
    const raw = el && el.getAttribute ? el.getAttribute('class') : '';
    if (!raw) return [];
    const out = [];
    String(raw).split(/\s+/).forEach(function (cls) {
      if (!cls) return;
      if (out.length >= 2) return;
      if (cls.length > 20) return;
      if (!/^[a-zA-Z][\w-]*$/.test(cls)) return;
      out.push(cls);
    });
    return out;
  }

  function isUniqueSelector(selector) {
    if (!selector) return false;
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch (e) {
      return false;
    }
  }

  /** selector 语法是否可用（不要求唯一） */
  function canQuery(selector) {
    if (!selector) return false;
    try {
      document.querySelector(selector);
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 单层路径片段：tag[.cls][:nth-of-type(n)] */
  function partFor(node, useClasses) {
    const tag = localOf(node) || '*';
    let part = tag;
    if (useClasses) {
      stableClasses(node).forEach(function (cls) {
        part += '.' + CSS.escape(cls);
      });
    }
    let index = 1;
    let sib = node;
    while ((sib = sib.previousElementSibling)) {
      if (localOf(sib) === localOf(node)) index += 1;
    }
    return part + ':nth-of-type(' + index + ')';
  }

  /**
   * 从元素向上拼路径，一旦唯一就返回（即最短唯一链）。
   * useClasses 为 true 时附加稳定类名，用于「只有加类名才唯一」的情况。
   * 若一直爬到 body/html 仍不唯一，返回最长链。
   */
  function selectorPath(el, useClasses) {
    const parts = [];
    let node = el;
    let guard = 0;
    while (node && node.nodeType === 1 && guard < 80) {
      guard += 1;
      parts.unshift(partFor(node, useClasses));
      const selector = parts.join(' > ');
      if (isUniqueSelector(selector)) return selector;
      if (node === document.body || node === document.documentElement) break;
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  /** 生成稳定 selector：优先唯一 id，其次最短唯一路径，最后带类名的最长链 */
  function buildSelector(el) {
    if (!el || el.nodeType !== 1) return '';
    const id = el.getAttribute ? el.getAttribute('id') : '';
    if (id) {
      const byId = '#' + CSS.escape(id);
      if (isUniqueSelector(byId)) return byId;
    }
    const plain = selectorPath(el, false);
    if (isUniqueSelector(plain)) return plain;
    const withClasses = selectorPath(el, true);
    if (isUniqueSelector(withClasses)) return withClasses;
    return withClasses || plain;
  }

  /** 生成 XPath：//tag[n]/tag[n]/... 作为 selector 的备份 */
  function buildXPath(el) {
    if (!el || el.nodeType !== 1) return '';
    const parts = [];
    let node = el;
    let guard = 0;
    while (node && node.nodeType === 1 && guard < 80) {
      guard += 1;
      const tag = localOf(node) || '*';
      let index = 1;
      let sib = node;
      while ((sib = sib.previousElementSibling)) {
        if (localOf(sib) === localOf(node)) index += 1;
      }
      parts.unshift(tag + '[' + index + ']');
      if (node === document.documentElement) break;
      node = node.parentElement;
    }
    return '//' + parts.join('/');
  }

  /** 简短描述：tag#id.cls，用于仅按 tag 兜底匹配 */
  function descriptorOf(el) {
    if (!el || el.nodeType !== 1) return '';
    let out = localOf(el);
    const id = el.getAttribute ? el.getAttribute('id') : '';
    if (id) out += '#' + id;
    stableClasses(el).forEach(function (cls) {
      out += '.' + cls;
    });
    return out;
  }

  /** 规则的 label：优先可见文本片段，其次 tag#id.class 描述 */
  function labelFor(el) {
    if (!el || el.nodeType !== 1) return '';
    const text = normText(el.textContent);
    if (text) return text.slice(0, 60);
    return descriptorOf(el);
  }

  /* ================================================================== *
   * 4. 元素定位（selector → xpath → tag+label 模糊）
   * ================================================================== */
  function queryOne(selector) {
    if (!selector) return null;
    try {
      const el = document.querySelector(selector);
      return el && el.nodeType === 1 ? el : null;
    } catch (e) {
      return null;
    }
  }

  function queryXPath(expr) {
    if (!expr || typeof document.evaluate !== 'function') return null;
    try {
      const result = document.evaluate(expr, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      const node = result && result.singleNodeValue;
      return node && node.nodeType === 1 ? node : null;
    } catch (e) {
      return null;
    }
  }

  /** 第一轮：selector + xpath（精确、便宜） */
  function resolveExact(rule) {
    return queryOne(rule.selector) || queryXPath(rule.xpath);
  }

  /**
   * 第二轮：按 tag + label 在「尚未被别的规则占用」的候选里模糊匹配。
   * 文本命中 +3，描述符完全命中 +4；最高分为 0 则视为未命中（避免误伤）。
   * tag 缺失时退化到全文档扫描（有上限保护），仅靠 label 择优。
   */
  function resolveFuzzy(rule, claimed) {
    const tag = String(rule.tag || '').toLowerCase().trim();
    const label = normText(rule.label).slice(0, 60);
    if (!label) return null;

    let list;
    try {
      if (tag) {
        list = toArray(document.getElementsByTagName(tag));
      } else {
        // 规则没带 tag（例如外部写入的旧规则）：全文档扫描，带上限避免大页面卡顿
        const all = document.body ? document.body.getElementsByTagName('*') : null;
        if (!all || all.length > 5000) return null;
        list = toArray(all);
      }
    } catch (e) {
      return null;
    }

    let best = null;
    let bestScore = 0;
    for (let i = 0; i < list.length; i += 1) {
      const el = list[i];
      if (!el || el.nodeType !== 1) continue;
      if (claimed && claimed.has(el)) continue;
      if (isOwnNode(el)) continue;
      let score = 0;
      if (descriptorOf(el) === label) score += 4;
      const text = normText(el.textContent);
      if (text && text.indexOf(label) !== -1) score += 3;
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return bestScore > 0 ? best : null;
  }

  /** 同一元素上多种类型规则同时命中时的优先级：VIDEO > HIDE
   *  （历史 image / embed 规则在 apply 阶段就被跳过，不参与抢占） */
  const KIND_PRIORITY = { video: 2, hide: 1 };

  function rulePriority(rule) {
    const value = KIND_PRIORITY[String((rule && rule.kind) || '')] || 0;
    return value;
  }

  /** 高优先级在前；同优先级后创建者在前（「后设置的生效」语义） */
  function compareRules(a, b) {
    const pa = rulePriority(a);
    const pb = rulePriority(b);
    if (pa !== pb) return pb - pa;
    const ca = Number(a && a.createdAt) || 0;
    const cb = Number(b && b.createdAt) || 0;
    if (ca !== cb) return cb - ca;
    return 0;
  }

  /**
   * 两轮解析（按优先级抢占元素）：
   *  - status='ok'       拿到元素，可以应用
   *  - status='conflict' 命中了同一元素但被更高优先级规则占用（确定性让位，不丢信息）
   *  - status='missing'  确实没找到元素
   * 模糊兜底只对 missing 的规则做，且不得占用已 claim 的元素。
   */
  function resolveRules(rules) {
    const out = [];
    const owners = new Map(); // element -> 占用它的规则
    const claimed = new Set();
    const ordered = rules.slice().sort(compareRules);

    ordered.forEach(function (rule) {
      const item = { rule: rule, el: null, status: 'missing' };
      out.push(item);
      const el = resolveExact(rule);
      if (!el) return;
      if (owners.has(el)) {
        item.status = 'conflict'; // 同一元素已被更高优先级规则占用
        item.conflictWith = owners.get(el).id || '';
        return;
      }
      owners.set(el, rule);
      claimed.add(el);
      item.el = el;
      item.status = 'ok';
    });

    out.forEach(function (item) {
      if (item.status !== 'missing') return;
      const el = resolveFuzzy(item.rule, claimed);
      if (!el) return;
      claimed.add(el);
      owners.set(el, item.rule);
      item.el = el;
      item.status = 'ok';
    });

    return out;
  }

  /* ================================================================== *
   * 5. 隐藏令牌（data-es-hidden）
   * 跨类型替换需要隐藏原元素，用空格分隔的 token 支持多规则共存，
   * 撤销时只移除失效 token，隐藏样式整体重建即可自然恢复。
   * ================================================================== */
  function hiddenTokens(el) {
    const raw = el.getAttribute ? el.getAttribute('data-es-hidden') : '';
    return String(raw || '').split(/\s+/).filter(Boolean);
  }

  function addHiddenToken(el, ruleId) {
    if (!el || !el.setAttribute) return;
    const tokens = hiddenTokens(el);
    if (tokens.indexOf(ruleId) === -1) tokens.push(ruleId);
    el.setAttribute('data-es-hidden', tokens.join(' '));
  }

  /* ================================================================== *
   * 6. 原地改写的备份 / 还原
   * data-es-backup : { ruleId, attrs: {name: 原值|null}, html: 原 innerHTML|null }
   * data-es-applied: 当前生效的规则 id
   * ================================================================== */
  function snapshotElement(el, ruleId, attrNames, keepHtml) {
    const attrs = {};
    (attrNames || []).forEach(function (name) {
      attrs[name] = el.hasAttribute(name) ? el.getAttribute(name) : null;
    });
    const backup = {
      ruleId: ruleId,
      attrs: attrs,
      html: keepHtml ? el.innerHTML : null
    };
    el.setAttribute('data-es-backup', JSON.stringify(backup));
    el.setAttribute('data-es-applied', ruleId);
    return backup;
  }

  function restoreSnapshot(el) {
    const raw = el.getAttribute ? el.getAttribute('data-es-backup') : null;
    el.removeAttribute('data-es-backup');
    el.removeAttribute('data-es-applied');
    // 下面三个镜像备份属性只由历史 image / embed 规则写过，这里一并清掉残留
    el.removeAttribute('data-es-orig-src');
    el.removeAttribute('data-es-orig-srcset');
    el.removeAttribute('data-es-orig-html');
    if (!raw) return;
    let backup = null;
    try {
      backup = JSON.parse(raw);
    } catch (e) {
      return;
    }
    if (!backup) return;
    if (backup.attrs) {
      Object.keys(backup.attrs).forEach(function (name) {
        const value = backup.attrs[name];
        if (value === null || value === undefined) el.removeAttribute(name);
        else el.setAttribute(name, value);
      });
    }
    if (typeof backup.html === 'string') el.innerHTML = backup.html;
  }

  /* ================================================================== *
   * 8. 各类规则的具体应用（hide 走 CSS，video 走元素替换）
   * ================================================================== */
  function findReplacement(ruleId) {
    if (!ruleId) return null;
    try {
      return document.querySelector('[data-es-replacement~="' + attrValue(ruleId) + '"]');
    } catch (e) {
      return null;
    }
  }

  /** 新插入节点取原元素宽度，最大不超过容器 */
  function applyBoxWidth(node, ref) {
    let width = 0;
    try {
      const rect = ref.getBoundingClientRect();
      if (rect && rect.width > 0) width = Math.round(rect.width);
    } catch (e) {
      width = 0;
    }
    if (width > 0) node.style.setProperty('width', width + 'px', 'important');
    node.style.setProperty('max-width', '100%', 'important');
    node.style.setProperty('display', 'block', 'important');
  }

  /**
   * 双流 wrapper 的盒子：与被替换元素的原盒子一致（宽 + 高都锁死）。
   * 单 URL 路径的布局值只有 width / max-width / display（高度交给媒体的固有比例），
   * 双流这边换了容器（div + 两条轨），高度必须显式锁成原元素高度，
   * 否则 wrapper 会变成「宽度满、高度自由」，替换后位置与占位都对不上。
   * 量取必须在隐藏原元素之前（隐藏后 rect 为 0）。
   */
  function applyPairBox(wrapper, video, box) {
    const width = box && box.width > 0 ? Math.round(box.width) : 0;
    const height = box && box.height > 0 ? Math.round(box.height) : 0;
    if (width > 0) wrapper.style.setProperty('width', width + 'px', 'important');
    wrapper.style.setProperty('max-width', '100%', 'important');
    wrapper.style.setProperty('display', 'block', 'important');
    if (height > 0) wrapper.style.setProperty('height', height + 'px', 'important');
    // 画面轨填满 wrapper（object-fit:cover，避免非 1:1 比例时被拉伸变形）
    styleImportant(video, {
      display: 'block',
      width: '100%',
      height: '100%',
      'object-fit': 'cover',
      'max-width': '100%',
      'max-height': '100%',
      margin: '0',
      background: '#000000',
      'box-sizing': 'border-box'
    });
  }

  /* ================================================================== *
   * 8.0 双流播放（DASH 分离流）：画面 + 声音两条地址一起播
   *
   * 抖音是 DASH 分离流：/media-video-avc1/ 有画面无声音，/media-audio-und-mp4a/
   * 有声音无画面。拿不到合流地址时，这是唯一的「有声有画」办法。
   * 规则形如 { payload:{ url:<视频轨>, audioUrl:<音频轨> } }：
   *   - 无 audioUrl → 完全不进这条路（既有单 URL 行为逐字不变）
   *   - 有 audioUrl → 替换成 wrapper（<video> + 隐藏的 <audio>），同步见 syncAudioVideo
   * 静音模型（按顺序）：
   *   1) 先按**带声音**尝试起播（video.muted=false / audio.muted=false + 两支 play()）；
   *   2) 只有 play() 被拒（NotAllowedError 等）才降级：两者设回 muted=true 重播，
   *      并立刻挂 data-es-audio-hint 提示「点击开启声音」；
   *   3) 提示常驻判据 = 「!unmuted && 画面在播」，与降级与否无关 —— 静音自动播成功
   *      也要提示，否则用户看到画面在走、没有任何提示，永远不会去点；
   *   4) document 级 capture 的 pointerdown / keydown / click 任一手势解除静音。
   * ================================================================== */

  const AUDIO_SYNC_INTERVAL = 500;   // 漂移检查间隔（ms）
  const AUDIO_SYNC_THRESHOLD = 0.3;  // 音画允许偏差（秒），超过就对齐
  const AUDIO_HINT_TEXT = '点击开启声音';

  /**
   * audio 的隐藏样式：0 尺寸但「可播放」。
   * 绝不能用 display:none / hidden —— 浏览器会把不可见的媒体元素暂停，声音就没了。
   */
  function styleAudioHidden(audio) {
    styleImportant(audio, {
      // 平台限制：UA 对「无 controls 的 audio」是 display:none !important，作者样式盖不住，
      // 所以元素本身带 controls（否则一定落到 display:none）；这里再用 0 尺寸彻底藏掉。
      display: 'block',
      position: 'absolute',
      left: '0',
      top: '0',
      width: '0',
      height: '0',
      overflow: 'hidden',
      opacity: '0',
      'pointer-events': 'none',
      margin: '0',
      padding: '0',
      border: '0'
    });
  }

  /* ---- 双流运行态注册表：只读自测用（es:probe-stats），最多 3 条，纯内存不落盘 ----
   * 线上「有画面没声音」这类反馈只能靠真实状态定位，所以把每条双流的 muted/paused/
   * readyState/networkState/error/是否有提示 都读出来，不写存储、不影响播放。
   */
  const mediaPairRegistry = { items: [], MAX: 3 };

  function registerMediaPair(entry) {
    if (!entry) return;
    mediaPairRegistry.items.push(entry);
    while (mediaPairRegistry.items.length > mediaPairRegistry.MAX) mediaPairRegistry.items.shift();
  }

  function unregisterMediaPair(entry) {
    const index = mediaPairRegistry.items.indexOf(entry);
    if (index !== -1) mediaPairRegistry.items.splice(index, 1);
  }

  function mediaPairSnapshot() {
    const out = [];
    mediaPairRegistry.items.forEach(function (entry) {
      try {
        out.push(entry.read());
      } catch (e) {
        /* 单条读取失败不影响其它条目 */
      }
    });
    return out;
  }

  /**
   * 音画同步（只由 video 驱动 audio，audio 的事件绝不回写 video）。
   * @param {HTMLVideoElement} video 画面轨
   * @param {HTMLAudioElement} audio 声音轨（0 尺寸隐藏）
   * @param {HTMLElement} wrapper   双流容器（提示浮层挂在这里）
   */
  function syncAudioVideo(video, audio, wrapper) {
    if (!video || !audio || !wrapper) return;
    let syncing = false;  // 防止事件互触发成环：所有「video 事件 → 写 audio」都过这道闸门
    let hint = null;      // data-es-audio-hint 小浮层
    let timer = 0;        // 500ms 漂移检查
    let torn = false;
    let unmuted = false;  // 声音是否已启用（true = 带声音在播）
    let degraded = false; // 是否因自动播放被拒、降级成「静音播画面」
    let gesturesBound = false;

    const removeHint = function () {
      if (!hint) return;
      const node = hint;
      hint = null;
      try {
        removeNode(node);
      } catch (e) {
        /* 静默 */
      }
    };

    const showHint = function () {
      if (hint || torn || !wrapper.isConnected) return;
      const box = document.createElement('div');
      box.setAttribute('data-es-audio-hint', '1');
      box.textContent = AUDIO_HINT_TEXT;
      styleImportant(box, {
        position: 'absolute',
        left: '8px',
        bottom: '44px',
        padding: '3px 8px',
        'border-radius': '6px',
        'font-size': '11px',
        'line-height': '1.5',
        color: '#ffffff',
        background: 'rgba(16,24,40,0.72)',
        'pointer-events': 'none',
        'z-index': '2'
      });
      hint = box;
      wrapper.appendChild(box);
    };

    /**
     * 提示的显示/移除判据（唯一真源）：声音还没启用 **且画面正在播** → 常驻提示。
     * 这样「静音自动播成功」这条主路径也会有可见提示，用户一眼知道要点。
     */
    const updateHint = function () {
      if (torn) return;
      let paused = true;
      try {
        paused = video.paused !== false;
      } catch (e) {
        paused = true;
      }
      if (!unmuted && !paused) showHint();
      else removeHint();
    };

    // ---- 手势解锁：document 级 capture，用户点页面任何地方都算 ----
    const GESTURE_EVENTS = ['pointerdown', 'keydown', 'click'];

    const detachGestures = function () {
      if (!gesturesBound) return;
      gesturesBound = false;
      GESTURE_EVENTS.forEach(function (name) {
        try {
          document.removeEventListener(name, onGesture, true);
        } catch (e) {
          /* 静默 */
        }
      });
    };

    const attachGestures = function () {
      if (gesturesBound || torn) return;
      gesturesBound = true;
      GESTURE_EVENTS.forEach(function (name) {
        try {
          document.addEventListener(name, onGesture, true); // capture：早于页面自己的处理器
        } catch (e) {
          /* 静默 */
        }
      });
    };

    /**
     * 启用声音（首次手势）：两者一起解除静音、音量对齐、补一次起播。
     * unmuted 标志保证只执行一次；真实手势下 audio.play() 才可能被放行。
     */
    const enableSound = function () {
      if (torn || unmuted) return;
      unmuted = true;
      degraded = false;
      syncing = true;
      try {
        video.muted = false;
      } catch (e) {
        /* 静默 */
      }
      try {
        audio.muted = false;
      } catch (e) {
        /* 静默 */
      }
      try {
        audio.volume = video.volume;
      } catch (e) {
        /* 静默 */
      }
      syncing = false;
      try {
        const played = audio.play();
        if (played && typeof played.catch === 'function') played.catch(function () {});
      } catch (e) {
        /* 静默：声音起不来也不抛错 */
      }
      try {
        if (video.paused) {
          const resumed = video.play();
          if (resumed && typeof resumed.catch === 'function') resumed.catch(function () {});
        }
      } catch (e) {
        /* 静默 */
      }
      removeHint();
    };

    const onGesture = function () {
      if (torn) return;
      enableSound();
      detachGestures();
    };

    /** 降级：带声音起播被拒 → 静音播画面（至少动起来）并立刻挂提示 */
    const degrade = function () {
      if (torn || unmuted) return;
      degraded = true;
      try {
        video.muted = true; // 会触发 volumechange → 把 audio 也静音，这是期望行为
      } catch (e) {
        /* 静默 */
      }
      try {
        audio.muted = true;
      } catch (e) {
        /* 静默 */
      }
      try {
        const played = video.play();
        if (played && typeof played.catch === 'function') played.catch(function () {});
      } catch (e) {
        /* 静默 */
      }
      try {
        const heard = audio.play();
        if (heard && typeof heard.catch === 'function') heard.catch(function () {});
      } catch (e) {
        /* 静默 */
      }
      updateHint(); // 立刻显示「点击开启声音」，不等用户猜
      attachGestures();
    };

    /**
     * 首次起播：**先按带声音尝试**（抖音页通常已有 sticky user activation，可以直接有声），
     * 任一 play() 被拒（NotAllowedError 等）才降级成静音播放 + 提示。
     */
    const attemptStart = function () {
      if (torn) return;
      syncing = true;
      try {
        video.muted = false;
      } catch (e) {
        /* 静默 */
      }
      try {
        audio.muted = false;
      } catch (e) {
        /* 静默 */
      }
      try {
        audio.volume = video.volume;
      } catch (e) {
        /* 静默 */
      }
      syncing = false;

      const guard = function (play) {
        let result = null;
        try {
          result = play();
        } catch (e) {
          return Promise.resolve(false);
        }
        if (!result || typeof result.then !== 'function') return Promise.resolve(true);
        return result.then(function () {
          return true;
        }, function () {
          return false;
        });
      };

      Promise.all([
        guard(function () {
          return video.play();
        }),
        guard(function () {
          return audio.play();
        })
      ]).then(function (results) {
        if (torn) return;
        if (results[0] === true && results[1] === true) {
          unmuted = true; // 带声音起播成功：无需手势
          degraded = false;
          removeHint();
          return;
        }
        degrade();
      }, function () {
        if (torn) return;
        degrade();
      });
    };

    /** 对齐进度（audio 跟 video） */
    const align = function () {
      if (syncing) return;
      syncing = true;
      try {
        audio.currentTime = video.currentTime;
      } catch (e) {
        /* 元数据未就绪时浏览器会忽略赋值，静默 */
      }
      syncing = false;
    };

    // ---- video → audio 的单向跟随 ----
    const onPlay = function () {
      if (torn || syncing) return;
      syncing = true;
      try {
        audio.playbackRate = video.playbackRate;
      } catch (e) {
        /* 静默 */
      }
      syncing = false;
      // 画面在播而声音轨没跟着播：补一次（静音状态下不受自动播放策略限制）
      try {
        if (audio.paused) {
          const played = audio.play();
          if (played && typeof played.catch === 'function') played.catch(function () {});
        }
      } catch (e) {
        /* 静默 */
      }
      updateHint();
    };
    const onPause = function () {
      if (torn || syncing) return;
      try {
        audio.pause();
      } catch (e) {
        /* 静默 */
      }
      updateHint(); // 画面暂停 → 提示按判据自动收起
    };
    const onRateChange = function () {
      if (torn || syncing) return;
      syncing = true;
      try {
        audio.playbackRate = video.playbackRate;
      } catch (e) {
        /* 静默 */
      }
      syncing = false;
    };
    const onVolumeChange = function () {
      if (torn || syncing) return;
      syncing = true;
      // 单向映射：静音状态与音量都跟 video 走（图标 = 事实）
      try {
        audio.muted = video.muted;
      } catch (e) {
        /* 静默 */
      }
      try {
        audio.volume = video.volume;
      } catch (e) {
        /* 静默 */
      }
      syncing = false;
    };
    const onSeeking = function () {
      if (torn) return;
      align();
    };
    const onSeeked = function () {
      if (torn) return;
      align();
    };
    const onEnded = function () {
      if (torn) return;
      try {
        audio.pause();
      } catch (e) {
        /* 静默 */
      }
      try {
        audio.currentTime = 0;
      } catch (e) {
        /* 静默 */
      }
      updateHint();
    };

    /** 漂移纠正：播放中每 500ms 比对一次，超过阈值就拉回；暂停时不检查 */
    const checkDrift = function () {
      if (torn || !video.isConnected || !audio.isConnected) {
        if (timer) {
          clearInterval(timer);
          timer = 0;
        }
        return;
      }
      updateHint(); // 保底：提示跟「未启用声音 + 画面在播」这个状态保持一致
      if (video.paused || audio.paused) return;
      let drift = 0;
      try {
        drift = Math.abs(Number(video.currentTime) - Number(audio.currentTime));
      } catch (e) {
        drift = 0;
      }
      if (!isFinite(drift)) return;
      if (drift > AUDIO_SYNC_THRESHOLD) align();
    };

    /** es:probe-stats 用的只读状态（任何异常都收敛成字段值，绝不抛） */
    const readState = function () {
      const num = function (fn, fallback) {
        try {
          const value = fn();
          return typeof value === 'number' && isFinite(value) ? value : fallback;
        } catch (e) {
          return fallback;
        }
      };
      const bool = function (fn) {
        try {
          return fn() === true;
        } catch (e) {
          return null;
        }
      };
      return {
        videoUrl: String((function () { try { return video.getAttribute('src') || video.currentSrc || ''; } catch (e) { return ''; } })()),
        audioUrl: String((function () { try { return audio.getAttribute('src') || audio.currentSrc || ''; } catch (e) { return ''; } })()),
        videoMuted: bool(function () { return video.muted; }),
        audioMuted: bool(function () { return audio.muted; }),
        videoPaused: bool(function () { return video.paused; }),
        audioPaused: bool(function () { return audio.paused; }),
        videoTime: num(function () { return video.currentTime; }, 0),
        audioTime: num(function () { return audio.currentTime; }, 0),
        videoReadyState: num(function () { return video.readyState; }, -1),
        audioReadyState: num(function () { return audio.readyState; }, -1),
        audioNetworkState: num(function () { return audio.networkState; }, -1),
        audioError: (function () {
          try {
            return audio.error ? String(audio.error.code) : '';
          } catch (e) {
            return '';
          }
        })(),
        unmuted: unmuted === true,
        degraded: degraded === true,
        hintShown: !!(hint && hint.isConnected)
      };
    };
    const pairEntry = { read: readState };

    try {
      audio.playbackRate = video.playbackRate;
    } catch (e) {
      /* 静默 */
    }
    try {
      audio.volume = video.volume;
    } catch (e) {
      /* 静默 */
    }

    try {
      video.addEventListener('play', onPlay);
      video.addEventListener('pause', onPause);
      video.addEventListener('ratechange', onRateChange);
      video.addEventListener('volumechange', onVolumeChange);
      video.addEventListener('seeking', onSeeking);
      video.addEventListener('seeked', onSeeked);
      video.addEventListener('ended', onEnded);
    } catch (e) {
      /* 监听注册失败静默：宁可不同步，也不打断页面 */
    }

    timer = setInterval(checkDrift, AUDIO_SYNC_INTERVAL);
    registerMediaPair(pairEntry);

    /** 撤销/清理：停掉定时器与监听，并把 audio 彻底停掉（避免后台继续解码） */
    wrapper.__esMediaPairTeardown = function () {
      if (torn) return;
      torn = true;
      if (timer) {
        clearInterval(timer);
        timer = 0;
      }
      detachGestures();
      removeHint();
      unregisterMediaPair(pairEntry);
      try {
        video.removeEventListener('play', onPlay);
        video.removeEventListener('pause', onPause);
        video.removeEventListener('ratechange', onRateChange);
        video.removeEventListener('volumechange', onVolumeChange);
        video.removeEventListener('seeking', onSeeking);
        video.removeEventListener('seeked', onSeeked);
        video.removeEventListener('ended', onEnded);
      } catch (e) {
        /* 静默 */
      }
      try {
        audio.pause();
      } catch (e) {
        /* 静默 */
      }
      try {
        audio.removeAttribute('src');
        audio.load();
      } catch (e) {
        /* 静默 */
      }
      try {
        video.pause();
      } catch (e) {
        /* 静默 */
      }
    };

    // 先按「带声音」起播，被拒才降级（见 attemptStart/degrade）
    attemptStart();
  }

  /** 双流节点（wrapper 或其中任一条）彻底停掉：pause + 清 src，防止后台继续解码 */
  function teardownMediaPair(node) {
    if (!node || node.nodeType !== 1) return;
    if (typeof node.__esMediaPairTeardown === 'function') {
      try {
        node.__esMediaPairTeardown();
      } catch (e) {
        /* 静默 */
      }
    }
    toArray(node.querySelectorAll('audio,video')).forEach(function (media) {
      try {
        media.pause();
      } catch (e) {
        /* 静默 */
      }
      try {
        media.removeAttribute('src');
      } catch (e) {
        /* 静默 */
      }
      try {
        media.load();
      } catch (e) {
        /* 静默 */
      }
    });
  }

  /**
   * 双流替换：隐藏原元素 + 插入 wrapper（<video muted> + 0 尺寸 <audio>）。
   * wrapper 带 data-es-replacement，幂等（findReplacement 直接命中）与撤销
   * （cleanupStale → restoreReplacement）都复用既有机制，不会插出第二个 audio。
   */
  function buildMediaPair(rule, el, videoUrl, audioUrl) {
    if (!rule || !el || !el.parentNode) return false;
    // 先在原元素还可见时量取盒子（隐藏后 getBoundingClientRect() 会是 0），
    // 之后用它锁死 wrapper 的宽高，保证替换后占住与原元素一致的尺寸。
    let box = null;
    try {
      const rect = el.getBoundingClientRect();
      if (rect) box = { width: Math.round(rect.width), height: Math.round(rect.height) };
    } catch (e) {
      box = null;
    }
    addHiddenToken(el, rule.id);

    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-es-replacement', rule.id);
    wrapper.setAttribute('data-es-inserted', 'sibling');
    wrapper.setAttribute('data-es-media-pair', '1');
    styleImportant(wrapper, { position: 'relative', margin: '0' });

    const video = document.createElement('video');
    video.setAttribute('data-es-media-pair-video', '1');
    video.setAttribute('src', videoUrl);
    video.setAttribute('controls', '');
    video.setAttribute('playsinline', '');
    video.setAttribute('preload', 'auto');
    // 初始态由 syncAudioVideo 的 attemptStart 决定：先按「带声音」尝试，
    // 被自动播放策略拒了才降级为静音（所以这里既不写 muted 属性也不设属性值）。
    wrapper.appendChild(video);

    const audio = document.createElement('audio');
    audio.setAttribute('data-es-media-pair-audio', '1');
    audio.setAttribute('src', audioUrl);
    audio.setAttribute('preload', 'auto');
    // 平台限制（实测 Chromium/Edge）：UA 样式表对「无 controls 的 <audio>」写的是
    // display:none !important，作者样式（哪怕 !important）也盖不住 —— 那就必然落到
    // display:none 这条「可能被浏览器暂停」的路上。所以这里带 controls，再用
    // 0 尺寸 + opacity:0 + overflow:hidden 把它彻底藏掉（见 styleAudioHidden），
    // 并去掉可聚焦 / 可访问性暴露，保证它既不可见也不抢交互。
    audio.setAttribute('controls', '');
    audio.setAttribute('tabindex', '-1');
    audio.setAttribute('aria-hidden', 'true');
    styleAudioHidden(audio);
    wrapper.appendChild(audio);

    applyPairBox(wrapper, video, box);
    el.parentNode.insertBefore(wrapper, el.nextSibling);

    try {
      video.load();
    } catch (e) {
      /* 静默 */
    }

    // 绑定同步 + 触发首次起播（attemptStart：先带声音，被拒才降级静音 + 提示）
    syncAudioVideo(video, audio, wrapper);
    mediaDiagAttach(video, rule.id); // 播放失败诊断（幂等，只挂一次）
    return true;
  }

  /**
   * 视频替换。保持同步签名（不改造成整体异步流水线）：
   *  - payload.url    直链 MP4 → 原有行为，逐字不变（E2E 用例 5 依赖它）
   *  - payload.source 视频页面链接 { provider, pageUrl }：
   *      先按原结构插入占位 <video data-es-replacement …>（不设 src），
   *      再异步解析真实媒体流（B 站走后台契约，抖音走页内嗅探），
   *      结果落到 data-es-media-* 属性上，失败用 toast 报。
   *  - payload.audioUrl 合法 http(s) 时改走双流（见 buildMediaPair）；
   *      只在直链分支生效，payload.source 分支永远不会带 audioUrl。
   */
  function applyVideo(rule, el) {
    const payload = (rule && rule.payload) || {};
    const url = String(payload.url || '').trim();
    const source = payload.source && typeof payload.source === 'object' && !Array.isArray(payload.source)
      ? payload.source
      : null;
    const sourcePageUrl = String((source && source.pageUrl) || '').trim();
    const audioUrl = String(payload.audioUrl || '').trim();
    const hasDirect = isHttpUrl(url);
    const hasSource = !hasDirect && isHttpUrl(sourcePageUrl);
    // 双流只在直链（视频轨）分支生效：payload.source 分支不带 audioUrl
    const hasAudio = hasDirect && isHttpUrl(audioUrl);
    if (!hasDirect && !hasSource) return false;

    const existing = findReplacement(rule.id);
    if (existing) {
      // 已插入过替换节点，不重复插入；仅补一次隐藏令牌（页面可能重建了原元素）。
      if (existing.getAttribute('data-es-inserted') === 'sibling') addHiddenToken(el, rule.id);
      // 占位仍在等流：允许重新触发解析（resolveSourceInto 内部有 in-flight 与重试次数防抖）
      if (hasSource && existing.getAttribute('data-es-media-pending') === '1') {
        resolveSourceInto(existing, rule, source);
      }
      return true;
    }

    // ---- 双流（DASH 分离流）：画面轨 + 声音轨一起播 ----
    // 即使原元素本身就是 <video> 也走 wrapper：要多挂一条 <audio>，
    // 原地改写塞不进去；wrapper 仍复用了兄弟插入 + 隐藏令牌 + 备份撤销那套机制。
    if (hasAudio) return buildMediaPair(rule, el, url, audioUrl);

    if (hasDirect) {
      if (localOf(el) === 'video') {
        const applied = el.getAttribute('data-es-applied');
        if (applied && applied !== rule.id) return false;
        if (applied === rule.id) {
          if (el.getAttribute('src') !== url) el.setAttribute('src', url);
          mediaDiagAttach(el, rule.id); // 失败诊断（幂等，只挂一次）
          return true;
        }
        snapshotElement(el, rule.id, ['src', 'controls', 'playsinline', 'muted', 'loop', 'preload'], true);
        // 规格要求：原始 innerHTML 也要落在 data-es-orig-html 上（便于外部/调试读取）
        el.setAttribute('data-es-orig-html', el.innerHTML);
        // 清空 <source> 子节点，改用 src 直连
        el.textContent = '';
        el.setAttribute('src', url);
        el.setAttribute('controls', '');
        el.setAttribute('playsinline', '');
        el.setAttribute('muted', '');
        el.setAttribute('loop', '');
        el.setAttribute('preload', 'metadata');
        try {
          el.load();
        } catch (e) {
          /* 静默 */
        }
        try {
          const played = el.play();
          if (played && typeof played.catch === 'function') played.catch(function () {});
        } catch (e) {
          /* play 失败静默 */
        }
        mediaDiagAttach(el, rule.id); // 播放失败诊断（不改 DOM 结构）
        return true;
      }

      // 跨类型替换：隐藏原元素 + 在原元素后插入 <video> 兄弟节点
      addHiddenToken(el, rule.id);
      if (!el.parentNode) return false;
      const video = document.createElement('video');
      video.setAttribute('data-es-replacement', rule.id);
      video.setAttribute('data-es-inserted', 'sibling');
      video.setAttribute('src', url);
      video.setAttribute('controls', '');
      video.setAttribute('playsinline', '');
      video.setAttribute('muted', '');
      video.setAttribute('loop', '');
      video.setAttribute('preload', 'metadata');
      video.style.setProperty('margin', '0', 'important');
      video.style.setProperty('background', '#000', 'important');
      applyBoxWidth(video, el);
      el.parentNode.insertBefore(video, el.nextSibling);
      try {
        const played = video.play();
        if (played && typeof played.catch === 'function') played.catch(function () {});
      } catch (e) {
        /* 自动播放被拦截时静默 */
      }
      mediaDiagAttach(video, rule.id); // 播放失败诊断（不改 DOM 结构）
      return true;
    }

    addHiddenToken(el, rule.id);
    if (!el.parentNode) return false;
    const pending = document.createElement('video');
    pending.setAttribute('data-es-replacement', rule.id);
    pending.setAttribute('data-es-inserted', 'sibling');
    pending.setAttribute('data-es-media-pending', '1');
    pending.setAttribute('data-es-media-provider', String(source.provider || ''));
    pending.setAttribute('controls', '');
    pending.setAttribute('playsinline', '');
    pending.setAttribute('preload', 'metadata');
    pending.style.setProperty('margin', '0', 'important');
    pending.style.setProperty('background', '#000', 'important');
    applyBoxWidth(pending, el);
    el.parentNode.insertBefore(pending, el.nextSibling);
    // 先挂失败诊断（此时无 src，等 setMediaReady 塞上 src 后由 loadstart 起 8s 看门狗）
    mediaDiagAttach(pending, rule.id);
    resolveSourceInto(pending, rule, source);
    return true;
  }

  function applyOneRule(rule, el) {
    if (!rule || !rule.kind || !el) return false;
    // 历史 image / embed 规则：静默忽略（不应用、不报错、不 toast、不删存储）
    if (rule.kind === KIND.IMAGE || rule.kind === KIND.EMBED) return false;
    if (rule.kind === KIND.VIDEO) return applyVideo(rule, el);
    return false;
  }

  /* ================================================================== *
   * 8.5 视频页面链接：输入识别 + 媒体流获取
   *
   *  - B 站 / b23.tv：内容脚本解析不了（防盗链 + 需服务端 HEAD），
   *    交给后台契约 chrome.runtime.sendMessage({type:'es:resolve-media', url})。
   *  - 抖音：服务端无法解析（风控 VM 页），只能在「当前页就是 douyin」时
   *    从页面自身取流。内容脚本拿不到 MAIN world 的 XHR/fetch，也不允许把
   *    probe 脚本登记进 manifest（web_accessible_resources），因此这里只用
   *    内容脚本可直达的两条通道：
   *      1) performance.getEntriesByType('resource') + PerformanceObserver
   *      2) DOM：<video>.currentSrc / <source src>
   *    MSE / blob: 流拿不到，那就明确提示用户改用 B 站链接或直链 MP4。
   * ================================================================== */

  const VIDEO_INPUT_PLACEHOLDER = 'MP4 外链，或 B 站 / 抖音视频页面链接';
  const VIDEO_INPUT_HINT = 'MP4 外链，或 B 站 / 抖音视频页面链接';
  const MEDIA_RESOLVE_TIMEOUT = 12000; // 兜底超时：12s 未回包即判定失败
  const MEDIA_RESOLVE_MAX_TRIES = 2;   // 同一 ruleId 最多重试 2 次（共 3 次尝试）
  const PROBE_LIMIT = 40;              // 候选列表上限（去重后保留最近 40 条）

  /** 直链形态：路径以 mp4/webm/m4v/mov 结尾 */
  const VIDEO_DIRECT_PATH_RE = /\.(?:mp4|webm|m4v|mov)$/i;
  /** 媒体特征：扩展名 / 抖音流路径 / douyinvod 域 */
  const MEDIA_EXT_RE = /\.(?:mp4|webm|m4v|m3u8|m4a)(?:$|[?#])/i;
  const MEDIA_PATH_RE = /\/video\/tos\/|\/play(?:wm)?\/|mime_type=video/i;
  const MEDIA_HOST_RE = /(?:^|\.)douyinvod\.com$/i;
  /** 明显不是媒体的静态资源（byteimg 等图床一律排除） */
  const MEDIA_EXCLUDE_RE = /\.(?:jpe?g|png|gif|webp|avif|svg|ico|css|js|mjs|json|woff2?|ttf|otf|wasm|html?)(?:$|[?#])/i;

  /* ---- 8.5.1 抖音 DASH 轨分类 ----
   * 抖音网页播放器是 DASH 分离流：音频轨、视频轨是两条独立 URL，只有部分场景给合流。
   * 全局必须能区分「音频 / 纯视频 / 合流」，否则音频轨先到达就会稳定当选 ——
   * 那正是「有进度条、有声音、画面全黑」的成因。
   *
   * 判据只认 decode 后的 pathname 段（query 里的 mime_type=video_mp4 在音频轨上
   * 同样存在，响应头 Content-Type 也可能回 video/mp4，两者都不能当判据）：
   *   /media-audio-und-mp4a/            音频轨（历史变体 /media-audio-mp4a/）
   *   /media-video-avc1|hvc1/           纯视频轨（有画面、无声音）
   *   /video/tos/cn/tos-cn-xx-xx/<hash>/  合流（画面 + 声音）
   */
  const TRACK = { MUXED: 'muxed', VIDEO: 'video', UNKNOWN: 'unknown', AUDIO: 'audio' };
  /** 轨优先级：合流 > 纯视频 > 未知；音频垫底且永不入选 */
  const TRACK_RANK = { muxed: 3, video: 2, unknown: 1, audio: 0 };
  /** 同轨同体积时的来源优先级：页面自身网络（已签名流）> performance > DOM */
  const TRACK_SOURCE_RANK = { 'main-probe': 3, performance: 2, 'dom-video': 1, 'dom-source': 1 };
  /** 音频轨段：/media-audio-und-mp4a/、/media-audio-mp4a/ */
  const TRACK_AUDIO_SEG_RE = /(?:^|[\/_-])media-audio(?:[\/_-]|$)/i;
  /** 纯视频轨段：/media-video-avc1/、/media-video-hvc1/ */
  const TRACK_VIDEO_SEG_RE = /(?:^|[\/_-])media-video(?:[\/_-]|$)/i;
  /** 其它 media-* 段（字幕 / 影集等）：不做合流判定 */
  const TRACK_ANY_MEDIA_SEG_RE = /(?:^|[\/_-])media-[a-z0-9]/i;
  /** 媒体域（合流判定要求域名可靠，避免把普通页面资源当成流） */
  const TRACK_MEDIA_HOST_RE = /(?:^|\.)(?:douyinvod\.com|zjcdn\.com|douyinstatic\.com)$/i;
  const TRACK_TOS_PATH_RE = /\/video\/tos\//i;
  /** 哈希结尾：合流 URL 的最后一段就是文件 hash */
  const TRACK_HASH_TAIL_RE = /\/[0-9a-z~_]{8,}\/?$/i;
  const TRACK_LABEL = { muxed: '合流（画面+声音）', video: '纯视频轨', audio: '音频轨', unknown: '未确认', dash: '分离流（画面+声音）' };

  /**
   * 抖音媒体 URL 的轨分类（纯函数，无副作用）。
   * 只看 decode 后的 pathname，绝不匹配整条 URL。
   * @param {string} value
   * @returns {'muxed'|'video'|'audio'|'unknown'}
   */
  function classifyDouyinTrack(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return TRACK.UNKNOWN;
    let parsed = null;
    try {
      parsed = new URL(raw, (location && location.href) || undefined);
    } catch (e) {
      return TRACK.UNKNOWN;
    }
    if (!parsed) return TRACK.UNKNOWN;
    const pathname = String(parsed.pathname || '');
    const host = String(parsed.hostname || '');
    // 1) 音频轨 / 纯视频轨：路径段即判据
    if (TRACK_AUDIO_SEG_RE.test(pathname)) return TRACK.AUDIO;
    if (TRACK_VIDEO_SEG_RE.test(pathname)) return TRACK.VIDEO;
    // 2) 合流：媒体域 + 无 media-* 段 + /video/tos/ 或哈希结尾
    if (!TRACK_MEDIA_HOST_RE.test(host)) return TRACK.UNKNOWN;
    if (TRACK_ANY_MEDIA_SEG_RE.test(pathname)) return TRACK.UNKNOWN;
    if (TRACK_TOS_PATH_RE.test(pathname) || TRACK_HASH_TAIL_RE.test(pathname)) return TRACK.MUXED;
    return TRACK.UNKNOWN;
  }

  /** 当前页是否就是抖音（只有这里才谈得上页内嗅探） */
  function isDouyinPage() {
    const host = String((location && location.hostname) || '').toLowerCase();
    if (!host) return false;
    return host === 'douyin.com' || /\.douyin\.com$/.test(host);
  }

  /**
   * 视频输入分类（面板保存用）：
   *  - { mode:'direct', url }                       直链，走原有 payload.url
   *  - { mode:'source', source:{provider,pageUrl} } 视频页面链接
   *  - { mode:'invalid' }                           非 http(s)
   * 判定顺序：优先判直链（扩展名），再命中站点域名才走 source，
   * 其余 http(s) 维持原行为（当作直链 url）。
   */
  function classifyVideoInput(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!isHttpUrl(raw)) return { mode: 'invalid' };
    let parsed = null;
    try {
      parsed = new URL(raw);
    } catch (e) {
      return { mode: 'invalid' };
    }
    if (!/^https?:$/.test(parsed.protocol)) return { mode: 'invalid' };

    const host = String(parsed.hostname || '').toLowerCase();
    const path = String(parsed.pathname || '');

    // 1) 直链优先：.mp4/.webm/.m4v/.mov
    if (VIDEO_DIRECT_PATH_RE.test(path)) return { mode: 'direct', url: raw };

    // 2) B 站：b23.tv 短链，或 bilibili.com/video/…
    if (host === 'b23.tv' || /(?:^|\.)b23\.tv$/.test(host)) {
      return { mode: 'source', source: { provider: 'bilibili', pageUrl: raw } };
    }
    if (/(?:^|\.)bilibili\.com$/.test(host) && /^\/video\//i.test(path)) {
      return { mode: 'source', source: { provider: 'bilibili', pageUrl: raw } };
    }

    // 3) 抖音：douyin.com/**（含 modal_id= 参数）
    if (host === 'douyin.com' || /\.douyin\.com$/.test(host)) {
      return { mode: 'source', source: { provider: 'douyin', pageUrl: raw } };
    }

    // 4) 其它 http(s)：与原行为一致，当作直链
    return { mode: 'direct', url: raw };
  }

  /** URL 是否具有媒体特征（扩展名 / 抖音流路径 / douyinvod 域） */
  function isMediaCandidateUrl(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!isHttpUrl(raw)) return false;
    let parsed = null;
    try {
      parsed = new URL(raw);
    } catch (e) {
      return false;
    }
    if (!/^https?:$/.test(parsed.protocol)) return false;
    if (MEDIA_EXCLUDE_RE.test(parsed.pathname)) return false;
    if (MEDIA_EXT_RE.test(parsed.pathname + parsed.search)) return true;
    if (MEDIA_PATH_RE.test(parsed.pathname + parsed.search)) return true;
    if (MEDIA_HOST_RE.test(parsed.hostname)) return true;
    return false;
  }

  /** 页内媒体候选缓存：去重 + 只留最近 PROBE_LIMIT 条，带时间戳 */
  const probe = { entries: [], observer: null };

  function probeSizeOf(entry) {
    if (!entry) return 0;
    const size = Number(entry.transferSize || 0) || Number(entry.encodedBodySize || 0) || Number(entry.decodedBodySize || 0);
    return size > 0 ? size : 0;
  }

  function rememberProbeCandidate(url, source, info) {
    const key = String(url || '').trim();
    if (!key) return;
    for (let i = 0; i < probe.entries.length; i += 1) {
      if (probe.entries[i].url === key) {
        probe.entries[i].seenAt = Date.now();
        if (info && Number(info.size || 0) > Number(probe.entries[i].size || 0)) probe.entries[i].size = Number(info.size || 0);
        return;
      }
    }
    probe.entries.push({
      url: key,
      source: source || 'unknown',
      size: Number((info && info.size) || 0),
      startTime: Number((info && info.startTime) || 0),
      seenAt: Date.now()
    });
    if (probe.entries.length > PROBE_LIMIT) probe.entries = probe.entries.slice(probe.entries.length - PROBE_LIMIT);
  }

  /** DOM 通道：<video>.currentSrc / src，以及 <source src> */
  function collectDomMedia() {
    const out = [];
    try {
      toArray(document.querySelectorAll('video')).forEach(function (video) {
        let src = '';
        try {
          src = video.currentSrc || video.getAttribute('src') || video.src || '';
        } catch (e) {
          src = '';
        }
        if (src && isMediaCandidateUrl(src)) out.push({ url: src, source: 'dom-video' });
        try {
          toArray(video.querySelectorAll('source')).forEach(function (node) {
            const child = node.getAttribute('src') || '';
            if (child && isMediaCandidateUrl(child)) out.push({ url: child, source: 'dom-source' });
          });
        } catch (e) {
          /* 静默 */
        }
      });
    } catch (e) {
      /* 静默 */
    }
    return out;
  }

  /** performance 通道：resource timing 里命中媒体特征的条目 */
  function collectPerformanceMedia() {
    const out = [];
    try {
      if (!performance || typeof performance.getEntriesByType !== 'function') return out;
      toArray(performance.getEntriesByType('resource') || []).forEach(function (entry) {
        if (!entry || !entry.name) return;
        if (!isMediaCandidateUrl(entry.name)) return;
        out.push({
          url: entry.name,
          source: 'performance',
          size: probeSizeOf(entry),
          startTime: Number(entry.startTime || 0)
        });
      });
    } catch (e) {
      /* 静默 */
    }
    return out;
  }

  /** 懒安装 PerformanceObserver：页面持续起流时把新条目也记进候选 */
  function ensureProbeObserver() {
    if (probe.observer || typeof PerformanceObserver !== 'function') return;
    try {
      probe.observer = new PerformanceObserver(function (list) {
        try {
          toArray((list && list.getEntries && list.getEntries()) || []).forEach(function (entry) {
            if (!entry || !entry.name) return;
            if (!isMediaCandidateUrl(entry.name)) return;
            rememberProbeCandidate(entry.name, 'performance', { size: probeSizeOf(entry), startTime: entry.startTime });
          });
        } catch (e) {
          /* 静默 */
        }
      });
      probe.observer.observe({ entryTypes: ['resource'] });
    } catch (e) {
      try {
        probe.observer.observe({ type: 'resource', buffered: true });
      } catch (e2) {
        probe.observer = null;
      }
    }
  }

  /** 跑一次嗅探：DOM + performance，并合并进候选缓存；返回本次命中的条目 */
  function sniffMediaCandidates() {
    ensureProbeObserver();
    const fresh = [];
    collectPerformanceMedia().forEach(function (item) {
      fresh.push(item);
      rememberProbeCandidate(item.url, item.source, { size: item.size, startTime: item.startTime });
    });
    collectDomMedia().forEach(function (item) {
      fresh.push(item);
      rememberProbeCandidate(item.url, item.source, null);
    });
    return fresh;
  }

  /**
   * 把候选池条目提升成带轨类型的可比较对象（audio 由调用方剔除）。
   * 保留原字段，附加 track / rank，便于排序与回包文案。
   */
  function douyinCandidateOf(item) {
    const url = String((item && item.url) || '');
    const track = classifyDouyinTrack(url);
    return {
      url: url,
      source: String((item && item.source) || 'unknown'),
      size: Number((item && item.size) || 0),
      startTime: Number((item && item.startTime) || 0),
      seenAt: Number((item && item.seenAt) || 0),
      track: track,
      rank: typeof TRACK_RANK[track] === 'number' ? TRACK_RANK[track] : 0
    };
  }

  /** 候选池的轨分布（只看内存，不触发嗅探） */
  function douyinTrackCounts() {
    const counts = { muxed: 0, video: 0, audio: 0, unknown: 0 };
    probe.entries.forEach(function (item) {
      const track = classifyDouyinTrack(item && item.url);
      counts[track] = (counts[track] || 0) + 1;
    });
    return counts;
  }

  /**
   * 选最佳候选：
   *  排序键 [轨类型（muxed > video > unknown > audio）, size, startTime, 来源, seenAt]
   *  音频轨直接剔除（永不入选）——它一定是「有进度条、有声音、画面全黑」。
   *  原实现按 postMessage 到达顺序「先到先得」，音频轨先请求就稳定当选，是本次 bug 的根因。
   */
  function bestDouyinCandidate() {
    if (!probe.entries.length) return null;
    const candidates = [];
    probe.entries.forEach(function (item) {
      if (!item || !item.url) return;
      const candidate = douyinCandidateOf(item);
      if (candidate.track === TRACK.AUDIO) return; // 音频轨永不入选
      candidates.push(candidate);
    });
    if (!candidates.length) return null;
    candidates.sort(function (a, b) {
      if (b.rank !== a.rank) return b.rank - a.rank;
      if (b.size !== a.size) return b.size - a.size;
      if (b.startTime !== a.startTime) return b.startTime - a.startTime;
      const sourceDelta = (TRACK_SOURCE_RANK[b.source] || 0) - (TRACK_SOURCE_RANK[a.source] || 0);
      if (sourceDelta !== 0) return sourceDelta;
      return b.seenAt - a.seenAt;
    });
    return candidates[0];
  }

  /**
   * 最佳音频轨候选（DASH 分离流专用）：与视频轨同一个候选池，只挑 track===audio。
   * 排序键与 bestDouyinCandidate 同构（size > startTime > 来源 > seenAt），
   * 只是这里音频轨是「要的」而不是「要剔除的」。没有音频轨时返回 null。
   */
  function bestDouyinAudioCandidate() {
    if (!probe.entries.length) return null;
    const candidates = [];
    probe.entries.forEach(function (item) {
      if (!item || !item.url) return;
      const candidate = douyinCandidateOf(item);
      if (candidate.track !== TRACK.AUDIO) return;
      candidates.push(candidate);
    });
    if (!candidates.length) return null;
    candidates.sort(function (a, b) {
      if (b.size !== a.size) return b.size - a.size;
      if (b.startTime !== a.startTime) return b.startTime - a.startTime;
      const sourceDelta = (TRACK_SOURCE_RANK[b.source] || 0) - (TRACK_SOURCE_RANK[a.source] || 0);
      if (sourceDelta !== 0) return sourceDelta;
      return b.seenAt - a.seenAt;
    });
    return candidates[0];
  }

  /** 可播放候选：必须能出画面（合流 / 纯视频轨），unknown 不算「等到了」 */
  function isPlayableDouyinPick(pick) {
    return !!(pick && (pick.track === TRACK.MUXED || pick.track === TRACK.VIDEO));
  }

  /** 抓流状态快照：{ pick, track, counts }，pick 里永远不可能是 audio */
  function douyinGrabState() {
    const pick = bestDouyinCandidate();
    return {
      pick: pick,
      track: pick ? pick.track : null,
      counts: douyinTrackCounts()
    };
  }

  /**
   * 抓流判定（两个抓流入口共用，保证文案与降级行为一致）：
   *   audio-only → { ok:false, error:'audio-only', message }
   *   no-stream  → { ok:false, error:'no-stream', message }
   *   合流       → { ok:true, pick, track:'muxed', note:'' }
   *   分离流     → { ok:true, pick, track:'dash', audioPick, note }（图 + 声各一条）
   *   仅视频轨   → { ok:true, pick, track:'video', note:'该地址是纯视频轨，可能没有声音' }
   */
  function douyinGrabVerdict(state) {
    const counts = (state && state.counts) || { muxed: 0, video: 0, audio: 0, unknown: 0 };
    const pick = state && state.pick;
    if (pick && pick.track === TRACK.AUDIO) {
      // 双保险：候选选择已经剔除 audio，这里再挡一次
      return { ok: false, error: 'audio-only', message: '只抓到音频轨（没有画面），请先在页面里播放一下视频再重试' };
    }
    if (!pick) {
      if (Number(counts.audio || 0) > 0) {
        return { ok: false, error: 'audio-only', message: '只抓到音频轨（没有画面），请先在页面里播放一下视频再重试' };
      }
      return { ok: false, error: 'no-stream', message: '当前页没有捕获到视频流，请先在该视频页播放一次再试' };
    }
    if (pick.track === TRACK.VIDEO) {
      // 视频轨 + 音频轨都在池里 → 分离流，两条一起给（拿不到合流时的唯一「有声有画」办法）
      const audioPick = bestDouyinAudioCandidate();
      if (audioPick) {
        return { ok: true, pick: pick, track: 'dash', audioPick: audioPick, note: '已分离抓取：画面 + 声音' };
      }
      return { ok: true, pick: pick, track: pick.track, note: '该地址是纯视频轨，可能没有声音' };
    }
    if (pick.track === TRACK.MUXED) {
      return { ok: true, pick: pick, track: pick.track, note: '' };
    }
    return { ok: true, pick: pick, track: pick.track, note: '该地址未确认是否含画面' };
  }

  function probeSourceLabel(source) {
    if (source === 'main-probe') return '页面网络（已签名流）';
    if (source === 'performance') return '页面资源(performance)';
    if (source === 'dom-video') return '页面 video 元素';
    if (source === 'dom-source') return '页面 source 元素';
    return String(source || '未知');
  }

  /* ---- MAIN world 探针通道（content/probe-main.js，仅 *://*.douyin.com/*） ----
   * 抖音真实媒体地址只在页面自身的 fetch / XHR / HTMLMediaElement 里出现，
   * ISOLATED world 读不到，因此由 MAIN world 探针用 postMessage 单向广播过来。
   * 这里只做「收 → 验证 → 并进候选池」：不写 DOM、不触发 apply / 面板重建，
   * 保证探针消息（含拾取器模式下）不会引起 UI 抖动或异常。
   */
  const MAIN_PROBE_FLAG = '__esMainProbe';
  const mainProbeStats = { messages: 0, accepted: 0, mse: 0 };

  /** 把 MAIN world 探针报来的 URL 并进既有候选池（复用去重/截断逻辑） */
  function mergeMainProbeCandidate(url) {
    const key = String(url || '').trim();
    if (!key || !isMediaCandidateUrl(key)) return false;
    let existing = null;
    for (let i = 0; i < probe.entries.length; i += 1) {
      if (probe.entries[i].url === key) {
        existing = probe.entries[i];
        break;
      }
    }
    rememberProbeCandidate(key, 'main-probe', null);
    // 同一 URL 可能先被 performance 记成 'performance'：页面网络（已签名流）更可信，
    // 抓取时应优先选它，所以把来源升级为 main-probe。
    if (existing && existing.source !== 'main-probe') existing.source = 'main-probe';
    mainProbeStats.accepted += 1;
    return true;
  }

  function onMainProbeMessage(event) {
    try {
      if (!event || event.source !== window) return;
      const data = event.data;
      if (!data || typeof data !== 'object' || data[MAIN_PROBE_FLAG] !== 1) return;
      mainProbeStats.messages += 1;
      if (String(data.kind || '') === 'mse') {
        mainProbeStats.mse += 1; // MSE/blob: 只说明有流，不给可播 URL
        return;
      }
      mergeMainProbeCandidate(data.url);
    } catch (e) {
      /* 静默：探针消息绝不能打断页面 / 面板流程 */
    }
  }

  function bindMainProbeChannel() {
    try {
      window.addEventListener('message', onMainProbeMessage, false);
    } catch (e) {
      /* 静默 */
    }
  }

  /**
   * 只读快照（自测用；不发存储、不触发嗅探、不影响正常流程）。
   * 除既有计数字段外，额外给出轨分布与「当前会选中谁」：
   *   videoTracks / audioTracks / muxedTracks / unknownTracks / pickedTrack / pickUrl
   * 全部纯内存，不写存储、不进规则 payload。
   */
  function mainProbeSnapshot() {
    const counts = douyinTrackCounts();
    const pick = bestDouyinCandidate();
    const out = {
      mainProbe: 0,
      perf: 0,
      dom: 0,
      total: probe.entries.length,
      messages: mainProbeStats.messages,
      mse: mainProbeStats.mse,
      videoTracks: counts.video,
      audioTracks: counts.audio,
      muxedTracks: counts.muxed,
      unknownTracks: counts.unknown,
      pickedTrack: pick ? pick.track : null,
      pickUrl: pick ? pick.url : null,
      // 双流（DASH）运行态：纯内存只读快照，最多 3 条；线上「有画面没声音」类反馈靠它定位
      pairs: mediaPairSnapshot()
    };
    probe.entries.forEach(function (item) {
      if (!item) return;
      if (item.source === 'main-probe') out.mainProbe += 1;
      else if (item.source === 'performance') out.perf += 1;
      else if (item.source === 'dom-video' || item.source === 'dom-source') out.dom += 1;
    });
    return out;
  }

  bindMainProbeChannel();

  /**
   * 抖音取流：最多再试几次（播放后流地址才会出现），仍无则交给调用方提示。
   * 等待窗口：最多 6 次 × 600ms —— 抖音页首个已签名流常在首帧渲染后才出现。
   * 收工条件改成「等到能出画面的候选」（muxed / video）：
   * 池里只要出现任意候选就收工，会让先到的音频轨抢先当选（画面全黑的根因）。
   * 回调参数：{ pick, track, counts }，超时也回调，pick 可能为 null 或 unknown 轨。
   */
  function sniffDouyinWithRetry(attempts, callback) {
    let state = null;
    try {
      sniffMediaCandidates();
      state = douyinGrabState();
    } catch (e) {
      state = null;
    }
    if (state && isPlayableDouyinPick(state.pick)) {
      callback(state);
      return;
    }
    if (attempts <= 0) {
      // 超时：把状态原样交回调用方判定，绝不在这里把音频轨当成结果
      callback(state || { pick: null, track: null, counts: { muxed: 0, video: 0, audio: 0, unknown: 0 } });
      return;
    }
    setTimeout(function () {
      sniffDouyinWithRetry(attempts - 1, callback);
    }, 600);
  }

  /* ---- 后台解析契约：{type:'es:resolve-media', url} → {ok, mediaUrl, title, durationMs, quality} ---- */
  const mediaPump = { timers: new Map() }; // ruleId -> timeout id（in-flight 去重 + 兜底超时）

  function requestResolveMedia(pageUrl) {
    return new Promise(function (resolve) {
      try {
        if (!HAS_EXTENSION || !chrome.runtime || typeof chrome.runtime.sendMessage !== 'function') {
          resolve({ ok: false, error: 'runtime-unavailable' });
          return;
        }
        chrome.runtime.sendMessage({ type: 'es:resolve-media', url: pageUrl }, function (response) {
          let lastError = '';
          try {
            if (chrome.runtime.lastError) lastError = chrome.runtime.lastError.message || 'runtime-error';
          } catch (e) {
            lastError = '';
          }
          if (lastError) {
            resolve({ ok: false, error: lastError });
            return;
          }
          resolve(response && typeof response === 'object' ? response : { ok: false, error: 'empty-response' });
        });
      } catch (e) {
        resolve({ ok: false, error: 'send-failed' });
      }
    });
  }

  function clearMediaTimer(ruleId) {
    const timer = mediaPump.timers.get(ruleId);
    if (timer) {
      clearTimeout(timer);
      mediaPump.timers.delete(ruleId);
    }
  }

  /** 解析失败：占位保留，属性留痕，toast 报错（面板打开时同时写面板错误槽） */
  function setMediaFailed(video, message) {
    const text = String(message || '解析失败');
    if (video) {
      try {
        video.removeAttribute('data-es-media-pending');
        video.setAttribute('data-es-media-failed', '1');
        video.setAttribute('data-es-media-error', text);
      } catch (e) {
        /* 静默 */
      }
      if (!video.isConnected) return; // 节点已被清理（规则被删/页面重建）：不打扰用户
    }
    toast(text);
    if (panel.host) showPanelError(text);
  }

  /** 解析成功：塞 src、去掉 pending、写 provider/title、load + play（失败静默） */
  function setMediaReady(video, result) {
    if (!video || !result || !isHttpUrl(result.mediaUrl)) return false;
    try {
      video.removeAttribute('data-es-media-pending');
      video.removeAttribute('data-es-media-failed');
      video.removeAttribute('data-es-media-error');
      video.setAttribute('data-es-media-provider', String(result.provider || ''));
      video.setAttribute('data-es-media-title', String(result.title || '').slice(0, 200));
      video.setAttribute('src', String(result.mediaUrl));
    } catch (e) {
      return false;
    }
    try {
      video.load();
    } catch (e) {
      /* 静默 */
    }
    try {
      const played = video.play();
      if (played && typeof played.catch === 'function') played.catch(function () {});
    } catch (e) {
      /* 自动播放被拦截时静默 */
    }
    return true;
  }

  /**
   * 为占位 <video> 解析真实媒体流（异步，不阻塞 apply 主流程）。
   * 同一 ruleId 只允许一个 in-flight；data-es-resolve-tried 记录尝试次数，
   * 超过 MEDIA_RESOLVE_MAX_TRIES 不再重试，避免 sweep 反复打后台。
   */
  function resolveSourceInto(video, rule, source) {
    const ruleId = rule && rule.id;
    if (!video || !ruleId || !source) return;
    if (mediaPump.timers.has(ruleId)) return; // 已有解析在跑
    let tried = 0;
    try {
      tried = Number(video.getAttribute('data-es-resolve-tried') || 0) || 0;
    } catch (e) {
      tried = 0;
    }
    if (tried > MEDIA_RESOLVE_MAX_TRIES) return; // 已用尽重试
    try {
      video.setAttribute('data-es-resolve-tried', String(tried + 1));
    } catch (e) {
      /* 静默 */
    }

    const provider = String(source.provider || '');
    const pageUrl = String(source.pageUrl || '').trim();
    let done = false;

    const timer = setTimeout(function () {
      if (mediaPump.timers.get(ruleId) !== timer) return;
      mediaPump.timers.delete(ruleId);
      if (done) return;
      done = true;
      setMediaFailed(video, '解析超时：12 秒内没有拿到视频流');
    }, MEDIA_RESOLVE_TIMEOUT);
    mediaPump.timers.set(ruleId, timer);

    const finish = function (result) {
      if (mediaPump.timers.get(ruleId) !== timer) return; // 超时已收尾 / 被替换
      clearMediaTimer(ruleId);
      if (done) return;
      done = true;
      if (result && result.ok === true && isHttpUrl(result.mediaUrl)) {
        setMediaReady(video, result);
        return;
      }
      setMediaFailed(video, (result && result.message) || ('解析失败：' + String((result && result.error) || '未知错误')));
    };

    // 抖音：不在后台解析，走页内嗅探（服务端拿不到，风控 VM 页）
    if (provider === 'douyin') {
      if (!isDouyinPage()) {
        finish({ ok: false, message: '抖音视频流只能在抖音页面内抓取：请先在该视频页播放一次再试，或改用 B 站链接 / 直链 MP4' });
        return;
      }
      sniffDouyinWithRetry(5, function (state) {
        const verdict = douyinGrabVerdict(state);
        if (!verdict.ok) {
          const tail = verdict.error === 'audio-only' ? '' : '（也可改用 B 站链接或直链 MP4）';
          finish({ ok: false, message: verdict.message + tail });
          return;
        }
        finish({ ok: true, mediaUrl: verdict.pick.url, provider: 'douyin', title: (document.title || '') });
      });
      return;
    }

    // B 站等：交给后台契约解析
    requestResolveMedia(pageUrl).then(function (response) {
      if (!response || response.ok !== true) {
        finish({
          ok: false,
          error: (response && response.error) || 'resolver-unavailable'
        });
        return;
      }
      finish({
        ok: true,
        mediaUrl: response.mediaUrl,
        provider: provider || 'bilibili',
        title: response.title || ''
      });
    });
  }

  /* ================================================================== *
   * 8.6 替换后播放失败诊断（只加事件监听与标记，不改替换节点结构）
   *
   * 静默失败的原因通常只有四种：403 防盗链 / 404 地址过期 /
   * 抓到的是 HLS 分片清单 / 抓到的是接口 JSON 或风控 HTML。
   * 这里在替换后的 <video> 上挂一次性失败监听，交给后台
   * es:probe-media-url 探测真实响应，再把可诊断的结论用 toast 说出来。
   *
   * 约束：
   *   - 只在失败时触发，绝不阻塞首次播放
   *   - 同一 ruleId 只诊断一次（mediaDiag.done 去重），不受 MutationObserver 影响
   *   - 节点已被清理（规则删除 / 页面重建）则不打扰用户
   * ================================================================== */

  const MEDIA_DIAG_STALL_MS = 8000; // stalled/waiting 持续 8s 且 readyState<2 视为失败
  const mediaDiag = {
    done: new Set(),      // 已诊断过的 ruleId
    timers: new Map()     // ruleId → 8s 看门狗
  };

  /** 取该 <video> 的可用流地址（currentSrc 优先，回退属性 src） */
  function mediaDiagSrcOf(video) {
    if (!video) return '';
    let src = '';
    try {
      src = String(video.currentSrc || video.getAttribute('src') || '');
    } catch (e) {
      src = '';
    }
    return isHttpUrl(src) ? src : '';
  }

  function mediaDiagClearTimer(ruleId) {
    const timer = mediaDiag.timers.get(ruleId);
    if (timer) {
      clearTimeout(timer);
      mediaDiag.timers.delete(ruleId);
    }
  }

  /** 走后台探测（只读 GET + Range）；任何通道异常都收敛成结构化结果 */
  function requestProbeMedia(url, pageUrl) {
    return new Promise(function (resolve) {
      try {
        if (!HAS_EXTENSION || !chrome.runtime || typeof chrome.runtime.sendMessage !== 'function') {
          resolve({ ok: false, error: '网络错误：扩展消息通道不可用' });
          return;
        }
        chrome.runtime.sendMessage({ type: 'es:probe-media-url', url: url, pageUrl: pageUrl }, function (response) {
          let lastError = '';
          try {
            if (chrome.runtime.lastError) lastError = chrome.runtime.lastError.message || 'runtime-error';
          } catch (e) {
            lastError = '';
          }
          if (lastError) {
            resolve({ ok: false, error: '网络错误：' + lastError });
            return;
          }
          resolve(response && typeof response === 'object' ? response : { ok: false, error: '探测无响应' });
        });
      } catch (e) {
        resolve({ ok: false, error: '网络错误：消息发送失败' });
      }
    });
  }

  /** 探测结果 → 用户可读的可诊断文案（状态码优先，再看容器类型） */
  function mediaDiagTextOf(result) {
    const status = Number((result && result.status) || 0) || 0;
    const kind = String((result && result.kind) || '');
    const error = String((result && result.error) || '');
    const note = String((result && result.note) || '');

    if (status === 403 || status === 401) {
      return '流被防盗链拒绝（HTTP ' + status + '），地址可能已过期，请在抖音页重新抓取';
    }
    if (status === 404) {
      return '流地址已失效（HTTP 404），请重新抓取';
    }
    if (status >= 200 && status < 300) {
      if (kind === 'hls') return '抓到的是 HLS 分片清单，不能直接播放（需要在抖音页重新抓取）';
      if (kind === 'mp4') return '流可下载但播放器未能解码，可能是编码/分片问题';
      if (kind === 'json' || kind === 'html') return '流不可用：' + (note || error || '返回内容不是媒体流');
      return '流不可用：' + (error || note || '容器格式无法识别');
    }
    return '流不可用：' + (error || note || ('HTTP ' + status));
  }

  /** 真正发起一次诊断（每个 ruleId 只发一次） */
  function runMediaDiagnosis(video, ruleId) {
    if (!video || !ruleId) return;
    if (mediaDiag.done.has(ruleId)) return;
    if (!video.isConnected) return; // 节点已被清理：不打扰用户
    const src = mediaDiagSrcOf(video);
    if (!src) return;               // 还没拿到地址（解析中），下一轮事件再诊断

    mediaDiag.done.add(ruleId);
    mediaDiagClearTimer(ruleId);
    try {
      video.setAttribute('data-es-media-diag', 'probing');
    } catch (e) {
      /* 静默 */
    }

    requestProbeMedia(src, location.href).then(function (result) {
      let text = mediaDiagTextOf(result);
      // 抖音页：再补一句「去哪儿重新抓」
      if (isDouyinPage() && text.indexOf('抖音') === -1) {
        text += '；可点扩展图标 →「抖音视频流」重新抓取';
      }
      try {
        video.setAttribute('data-es-media-diag', 'failed');
        video.setAttribute('data-es-media-diag-kind', String((result && result.kind) || 'unknown'));
        video.setAttribute('data-es-media-diag-status', String(Number((result && result.status) || 0) || 0));
        video.setAttribute('data-es-media-diag-error', text);
      } catch (e) {
        /* 静默 */
      }
      if (!video.isConnected) return; // 探测期间节点被清理：不打扰用户
      toast(text);
    });
  }

  /**
   * 给替换后的 <video> 挂一次性失败监听（幂等：同一节点只挂一次）。
   * 触发条件：
   *   1) error 事件（媒体元素加载/解码失败）
   *   2) stalled / waiting 持续 8s 仍 readyState < 2
   *   3) 已带 src 时立刻挂 8s 看门狗（覆盖「既不报错也不前进」的卡死）
   */
  function mediaDiagAttach(video, ruleId) {
    if (!video || !ruleId) return;
    let bound = false;
    try {
      bound = video.getAttribute('data-es-media-diag-bound') === '1';
    } catch (e) {
      bound = false;
    }
    if (bound) return;
    try {
      video.setAttribute('data-es-media-diag-bound', '1');
    } catch (e) {
      return;
    }

    const arm = function () {
      if (mediaDiag.done.has(ruleId)) return;
      mediaDiagClearTimer(ruleId);
      mediaDiag.timers.set(ruleId, setTimeout(function () {
        mediaDiag.timers.delete(ruleId);
        let ready = 0;
        try {
          ready = Number(video.readyState) || 0;
        } catch (e) {
          ready = 0;
        }
        if (ready >= 2) return; // 已有当前帧数据：不是失败
        runMediaDiagnosis(video, ruleId);
      }, MEDIA_DIAG_STALL_MS));
    };
    const disarm = function () {
      mediaDiagClearTimer(ruleId);
    };
    const onError = function () {
      let ready = 0;
      try {
        ready = Number(video.readyState) || 0;
      } catch (e) {
        ready = 0;
      }
      if (ready >= 2) return;
      runMediaDiagnosis(video, ruleId);
    };

    try {
      video.addEventListener('error', onError);
      video.addEventListener('stalled', arm);
      video.addEventListener('waiting', arm);
      video.addEventListener('loadstart', arm);
      video.addEventListener('loadedmetadata', disarm);
      video.addEventListener('loadeddata', disarm);
      video.addEventListener('canplay', disarm);
      video.addEventListener('playing', disarm);
    } catch (e) {
      /* 监听注册失败静默 */
    }

    // 直链路径：绑定瞬间已有 src，直接挂看门狗
    if (mediaDiagSrcOf(video)) arm();
  }

  /* ---- 面板内「抓取当前页面视频流」 ---- */
  function setGrabInfo(text, bad) {
    const info = panelEl('es-grab-info');
    if (!info) return;
    info.textContent = String(text || '');
    info.classList.toggle('bad', !!bad);
  }

  /* ---- 面板：单框输入 + 自动分轨（画面进 #es-url，声音进内部暂存） ----
   * 用户只看到一个输入框：把 popup 复制出来的「画面URL 换行 声音URL」整段粘进去，
   * 这里按 /[\s,;]+/ 拆条、只留 http(s)，再用 classifyDouyinTrack（只看 pathname 段）判轨：
   *   media-audio-* → 音频轨 → state.pendingAudioUrl（不占输入框）
   *   合流 / media-video-* / 其它 http(s) → 画面候选 → #es-url
   * 画面候选优先级：muxed > video > unknown（音频永不进画面位）。
   */
  const TRACK_NOTE_BOTH = '已识别：画面 + 声音';
  const TRACK_NOTE_VIDEO_ONLY = '已识别：画面';
  const TRACK_ONLY_AUDIO_MESSAGE = '这是音频轨地址，还需要一条画面轨地址';
  const TRACK_URL_SPLIT_RE = /[\s,;]+/;
  /** 画面位挑选优先级：合流 > 纯视频轨 > 未确认（音频 0 分，永不入选） */
  const TRACK_PICK_RANK = { muxed: 3, video: 2, unknown: 1 };

  /** 把输入框里的一行提示点亮/熄灭（不是错误，不用 #es-err） */
  function showTrackNote(text) {
    const note = panelEl('es-track-note');
    if (!note) return;
    note.textContent = String(text || '');
    note.classList.toggle('on', !!text);
  }

  /**
   * 拆条：按换行 / 空格 / 逗号 / 分号切分，只保留 http(s)，原序去重。
   * @param {string} text
   * @returns {string[]}
   */
  function splitAddressList(text) {
    const raw = String(text == null ? '' : text);
    const out = [];
    raw.split(TRACK_URL_SPLIT_RE).forEach(function (part) {
      const value = normText(part);
      if (!value || !isHttpUrl(value)) return;
      if (out.indexOf(value) < 0) out.push(value);
    });
    return out;
  }

  /**
   * 单框自动分轨：从一段文本里挑出画面地址 + 音频地址。
   * @param {string} text
   * @returns {{url:string, urlTrack:string, audioUrl:string, count:number, hasVideo:boolean, hasAudio:boolean}}
   */
  function splitTrackAddresses(text) {
    const list = splitAddressList(text);
    let url = '';
    let bestRank = 0;
    let audioUrl = '';
    list.forEach(function (value) {
      const track = classifyDouyinTrack(value);
      if (track === TRACK.AUDIO) {
        if (!audioUrl) audioUrl = value;
        return;
      }
      const rank = TRACK_PICK_RANK[track] || 0;
      if (rank > bestRank) {
        bestRank = rank;
        url = value;
      }
    });
    return {
      url: url,
      urlTrack: url ? classifyDouyinTrack(url) : '',
      audioUrl: audioUrl,
      count: list.length,
      hasVideo: !!url,
      hasAudio: !!audioUrl
    };
  }

  /**
   * 把一段文本（粘贴内容或输入框当前值）落到面板：
   * 画面 → #es-url、声音 → state.pendingAudioUrl，并给一行「已识别」反馈。
   * @param {string} text
   * @returns {object} splitTrackAddresses 的结果
   */
  function commitTrackInput(text) {
    const parsed = splitTrackAddresses(text);
    const input = panelEl('es-url');
    if (!input) return parsed;
    if (parsed.url) {
      if (input.value !== parsed.url) input.value = parsed.url;
      state.pendingAudioUrl = parsed.audioUrl || '';
      // 单条 unknown（普通 mp4 / B 站链接）不打扰用户：按原样保存
      const known = parsed.urlTrack === TRACK.VIDEO || parsed.urlTrack === TRACK.MUXED;
      showTrackNote(parsed.audioUrl ? TRACK_NOTE_BOTH : (known ? TRACK_NOTE_VIDEO_ONLY : ''));
      showPanelError('');
      return parsed;
    }
    if (parsed.hasAudio) {
      // 只有音频轨：不写进画面框、不落库，明确告诉用户还缺画面地址
      if (input.value !== '') input.value = '';
      state.pendingAudioUrl = parsed.audioUrl;
      showTrackNote('');
      showPanelError(TRACK_ONLY_AUDIO_MESSAGE);
      return parsed;
    }
    // 空 / 非 http(s)：保持用户输入原样，交给保存时的既有校验
    const raw = normText(text);
    if (input.value !== raw) input.value = raw;
    state.pendingAudioUrl = '';
    showTrackNote('');
    showPanelError('');
    return parsed;
  }

  /** 粘贴：接管默认插入，拿到剪贴板原文（换行分隔的两条也能整段进来） */
  function onPanelUrlPaste(event) {
    let text = '';
    try {
      const data = event.clipboardData;
      if (data && typeof data.getData === 'function') {
        text = data.getData('text') || data.getData('text/plain') || '';
      }
    } catch (e) {
      text = '';
    }
    if (!text) return; // 拿不到剪贴板原文时退回默认插入，由 input 事件接管
    event.preventDefault();
    commitTrackInput(text);
  }

  /** 给唯一输入框绑定自动分割：paste 走剪贴板原文，input/change 走当前值 */
  function bindTrackInput() {
    const input = panelEl('es-url');
    if (!input) return;
    input.addEventListener('paste', onPanelUrlPaste);
    input.addEventListener('input', function () {
      commitTrackInput(input.value);
    });
    input.addEventListener('change', function () {
      commitTrackInput(input.value);
    });
  }

  /** 面板关闭 / 切换 kind 时清空内部暂存的音频地址（它不在任何输入框里） */
  function resetPendingAudio() {
    state.pendingAudioUrl = '';
  }

  /** 抓取会话令牌：连点按钮时让上一轮的等待窗口自行失效 */
  const grabPump = { token: 0 };

  /**
   * 把抓到的候选写进输入框并汇报来源与轨类型（取不到返回 null）。
   * @param {object} pick      视频轨/合流候选（必填）
   * @param {number} freshCount 本轮新嗅到的条目数
   * @param {object} audioPick  分离流时的音频轨候选（可选，有值就进内部暂存 state.pendingAudioUrl）
   */
  function commitGrabCandidate(pick, freshCount, audioPick) {
    if (!pick || !pick.url || !panel.root) return null;
    // 抓流入口在 douyin 域下对任何 kind 都可见：从别的 kind 用它时，
    // 抓到候选后自动切到「替换视频」再填值，避免用户不知道这条链接要配哪种操作。
    if (panel.kind !== KIND.VIDEO) setPanelKind(KIND.VIDEO);
    const input = panelEl('es-url');
    if (!input) return null;
    const hasAudio = !!(audioPick && audioPick.url);
    // 面板只有一个输入框：画面写进去，声音进内部暂存（保存时一起落库）
    input.value = pick.url;
    state.pendingAudioUrl = hasAudio ? audioPick.url : '';
    showTrackNote(hasAudio ? TRACK_NOTE_BOTH : '');
    try {
      input.focus();
    } catch (e) {
      /* 静默 */
    }
    showPanelError('');
    const track = hasAudio ? 'dash' : pick.track;
    const trackText = TRACK_LABEL[track] || TRACK_LABEL.unknown;
    let info = '候选 ' + probe.entries.length + ' 条（本次 ' + freshCount + ' 条）· 来源：'
      + probeSourceLabel(pick.source) + ' · 轨：' + trackText;
    if (hasAudio) info += ' · 已分离抓取：画面 + 声音（保存时一起生效）';
    else if (pick.track === TRACK.VIDEO) info += '（该地址是纯视频轨，可能没有声音）';
    else if (pick.track !== TRACK.MUXED) info += '（未能确认该地址是否含画面）';
    setGrabInfo(info, false);
    return pick;
  }

  /** 等待窗口：null-safe，每 600ms 再嗅一次，最多 6 次（首次在 grabDouyinMedia 里已做）
   *  收工条件是「等到能出画面的候选」，否则一直等到窗口关闭 —— 音频轨先到不算等到了 */
  function grabWaitWindow(token, remaining) {
    if (token !== grabPump.token) return;
    if (remaining <= 0) {
      // 超时：只有音频 / 未确认时不要把它们填进输入框（音频轨 = 有进度条、有声音、画面全黑）
      const verdict = douyinGrabVerdict(douyinGrabState());
      if (!verdict.ok) {
        setGrabInfo(verdict.message + (verdict.error === 'audio-only' ? '' : '；也可改用 B 站链接或直链 MP4'), true);
        showPanelError(verdict.message);
        return;
      }
      commitGrabCandidate(verdict.pick, 0, verdict.audioPick || null);
      return;
    }
    setTimeout(function () {
      if (token !== grabPump.token) return;
      let state = null;
      let freshCount = 0;
      try {
        freshCount = sniffMediaCandidates().length;
        state = douyinGrabState();
      } catch (e) {
        state = null;
        freshCount = 0;
      }
      if (state && isPlayableDouyinPick(state.pick)) {
        // 判定放在这里跑一遍：分离流要把音频地址一起填进第二个输入框
        const verdict = douyinGrabVerdict(state);
        commitGrabCandidate(verdict.pick, freshCount, verdict.audioPick || null);
        return;
      }
      grabWaitWindow(token, remaining - 1);
    }, 600);
  }

  /** 点一次按钮：跑一遍嗅探，把最佳候选写进输入框；取不到就明确报错 */
  function grabDouyinMedia() {
    grabPump.token += 1;
    const token = grabPump.token;
    try {
      const fresh = sniffMediaCandidates();
      const state = douyinGrabState();
      if (isPlayableDouyinPick(state.pick)) {
        const verdict = douyinGrabVerdict(state);
        return commitGrabCandidate(verdict.pick, fresh.length, verdict.audioPick || null);
      }
      // 首帧常还没起流：放宽到最多 6 次 × 600ms，主探针（页面网络已签名流）优先
      setGrabInfo('正在等待页面起流（最多 6 次 × 600ms）…', false);
      grabWaitWindow(token, 5);
      return null;
    } catch (e) {
      const message = '抓取失败：' + (e && e.message ? e.message : '未知错误');
      setGrabInfo(message, true);
      showPanelError(message);
      return null;
    }
  }

  /* ---- 主视频元素 → 可定位选择器（只读，不写 DOM） ----
   * 抖音页往往有多个 <video>（列表里的预览 + 主播放器），取「面积最大且
   * currentSrc/src 不是 blob: 的那个」；没有这样的 video 时退化为 'video'。
   * 最近一次结果记在 grab.lastSelector 里，供 es:grab-douyin 回包使用。
   */
  const grab = { lastSelector: '' };

  function pickMainVideoSelector() {
    let videoCount = 0;
    let bestEl = null;
    let bestArea = -1;
    try {
      toArray(document.querySelectorAll('video')).forEach(function (video) {
        videoCount += 1;
        let src = '';
        try {
          src = video.currentSrc || video.getAttribute('src') || video.src || '';
        } catch (e) {
          src = '';
        }
        if (!src || /^blob:/i.test(src)) return; // MSE/blob 流没有可复用的直链
        let area = 0;
        try {
          const rect = video.getBoundingClientRect ? video.getBoundingClientRect() : null;
          if (rect) area = Math.max(0, Number(rect.width) || 0) * Math.max(0, Number(rect.height) || 0);
        } catch (e) {
          area = 0;
        }
        if (area > bestArea) {
          bestArea = area;
          bestEl = video;
        }
      });
    } catch (e) {
      bestEl = null;
      videoCount = 0;
    }
    if (bestEl) {
      const built = buildSelector(bestEl);
      grab.lastSelector = built || 'video';
      return { selector: grab.lastSelector, videoCount: videoCount };
    }
    grab.lastSelector = videoCount > 0 ? 'video' : '';
    return { selector: grab.lastSelector, videoCount: videoCount };
  }

  /**
   * es:grab-douyin —— 给 popup / 外部脚本用的抓流通道（不需要拾取器、不需要面板）：
   * 只做「同步嗅探 + 生成主视频选择器」，不写存储、不建规则、不改页面 DOM。
   * 回包契约（既有字段不变，只增 audioUrl）：
   *   合流 {ok:true, url, selector, source, count, title, mediaCount, track:'muxed'}
   *   分离流 {ok:true, url:<视频轨>, audioUrl:<音频轨>, …, track:'dash'}
   *        url 仍给视频轨，便于旧调用方直接当单 URL 用
   *   仅视频轨 {ok:true, url, …, track:'video', note:'该地址是纯视频轨，可能没有声音'}
   *   失败 {ok:false, error:'not-douyin'|'no-video'|'no-stream'|'audio-only'|'handler-error', message}
   * 注意：只抓到音频轨时绝不回 ok:true ——那样的地址能出声、有进度条，但画面全黑。
   */
  function handleGrabDouyinMessage(sendResponse) {
    const reply = function (payload) {
      try {
        sendResponse(payload);
      } catch (e) {
        /* 端口已关闭，忽略 */
      }
    };
    try {
      if (!isDouyinPage()) {
        reply({ ok: false, error: 'not-douyin', message: '抖音视频流只能在抖音页面内抓取' });
        return true;
      }
      // 与按钮同款等待窗口：先同步嗅一次，再最多 5 次 × 600ms（合计 6 次）
      sniffDouyinWithRetry(5, function (state) {
        try {
          const verdict = douyinGrabVerdict(state);
          if (!verdict.ok) {
            reply({ ok: false, error: verdict.error, message: verdict.message });
            return;
          }
          const picked = pickMainVideoSelector();
          if (!picked.videoCount) {
            reply({ ok: false, error: 'no-video', message: '当前页没有找到视频元素，请先播放视频' });
            return;
          }
          const response = {
            ok: true,
            url: verdict.pick.url,
            selector: picked.selector,
            source: probeSourceLabel(verdict.pick.source),
            count: probe.entries.length,
            title: document.title || '',
            mediaCount: picked.videoCount,
            track: verdict.track
          };
          // 分离流：额外给一条音频轨地址（url 仍是视频轨，旧调用方不受影响）
          if (verdict.track === 'dash' && verdict.audioPick && verdict.audioPick.url) {
            response.audioUrl = verdict.audioPick.url;
          }
          if (verdict.note) response.note = verdict.note;
          reply(response);
        } catch (e) {
          reply({ ok: false, error: 'handler-error', message: '抓取失败：' + (e && e.message ? e.message : '未知错误') });
        }
      });
    } catch (e) {
      reply({ ok: false, error: 'handler-error', message: '抓取失败：' + (e && e.message ? e.message : '未知错误') });
    }
    return true;
  }

  /* ================================================================== *
   * 9. 反向清理（撤销失效规则）
   * ================================================================== */
  /** 还原被替换掉的节点（历史 embed 规则留下的 iframe 整替节点 → 原始 outerHTML；其它插入节点直接移除） */
  function restoreReplacement(node) {
    // 双流 wrapper（或其内部 <video>/<audio>）先停掉：清定时器、pause、src 置空，
    // 否则节点摘掉后 audio 仍可能在后台继续解码。
    teardownMediaPair(node);
    const origHtml = node.getAttribute && node.getAttribute('data-es-orig-html');
    if (origHtml && node.getAttribute('data-es-replaced-tag')) {
      const tpl = document.createElement('template');
      tpl.innerHTML = origHtml;
      const restored = tpl.content.firstElementChild;
      if (restored && node.parentNode) {
        node.parentNode.replaceChild(restored, node);
        return;
      }
    }
    removeNode(node);
  }

  function cleanupStale(active) {
    // 1) 规则已失效的替换节点 → 移除 / 还原
    toArray(document.querySelectorAll('[data-es-replacement]')).forEach(function (node) {
      const id = node.getAttribute('data-es-replacement') || '';
      const tokens = id.split(/\s+/).filter(Boolean);
      const alive = tokens.some(function (token) {
        return active[token] === true;
      });
      if (!alive) restoreReplacement(node);
    });

    // 2) 规则已失效的原地改写 → 还原备份
    toArray(document.querySelectorAll('[data-es-applied]')).forEach(function (el) {
      const id = el.getAttribute('data-es-applied') || '';
      if (active[id] === true) return;
      restoreSnapshot(el);
    });

    // 3) 隐藏令牌只保留仍生效的规则
    toArray(document.querySelectorAll('[data-es-hidden]')).forEach(function (el) {
      const kept = hiddenTokens(el).filter(function (token) {
        return active[token] === true;
      });
      if (kept.length) el.setAttribute('data-es-hidden', kept.join(' '));
      else el.removeAttribute('data-es-hidden');
    });
  }

  /* ================================================================== *
   * 10. 规则应用主流程（幂等）
   * ================================================================== */
  function loadContext() {
    return Promise.all([
      ES.getSettings(),
      ES.listRules(location.href)
    ]).then(function (result) {
      const settings = result[0] || { scope: SCOPE.DOMAIN };
      const rules = result[1] || [];
      const keys = ES.keysForUrl(location.href);
      state.settings = settings;
      state.scope = settings.scope;
      state.siteKey = settings.scope === SCOPE.URL ? (keys.url || '') : (keys.domain || '');
      state.rules = rules;
      state.loaded = true;
      return rules;
    });
  }

  function apply(useCache) {
    if (state.applying) {
      state.pendingSweep = true;
      return Promise.resolve();
    }
    state.applying = true;

    const ready = (!useCache || !state.loaded) ? loadContext() : Promise.resolve(state.rules);

    return ready
      .then(function (rules) {
        const list = rules || [];

        // a) 分类：hide 走 CSS，video 需要真实元素；
        //    历史 image / embed 规则直接跳过（静默忽略，不参与抢占元素、不计 miss/conflict）
        const hideSelectors = [];
        const hideRuleIds = [];
        const needElement = [];
        list.forEach(function (rule) {
          if (!rule || !rule.kind) return;
          if (rule.kind === KIND.IMAGE || rule.kind === KIND.EMBED) return;
          if (rule.kind === KIND.HIDE) {
            const selector = String(rule.selector || '').trim();
            // 语法无效的 selector 会连累整条 CSS 规则，先单独校验
            if (selector && canQuery(selector)) {
              hideSelectors.push(selector);
              if (rule.id) hideRuleIds.push(rule.id);
            }
            return;
          }
          needElement.push(rule);
        });

        // b) 按优先级抢占元素：ok / conflict / missing
        const resolved = resolveRules(needElement);
        let conflicts = 0;
        const active = {};
        hideRuleIds.forEach(function (id) {
          active[id] = true;
        });
        resolved.forEach(function (item) {
          if (item.status === 'conflict') {
            conflicts += 1;
            return;
          }
          if (item.status === 'ok' && item.rule && item.rule.id) active[item.rule.id] = true;
        });

        // c) 反向清理：失效规则（含被更高优先级顶掉的冲突规则）的改动全部撤销
        cleanupStale(active);

        // d) 应用拿到元素的规则
        let appliedCount = 0;
        let misses = 0;
        resolved.forEach(function (item) {
          if (item.status === 'conflict') return;   // 冲突已在 conflicts 里统计，不算 miss
          if (item.status !== 'ok' || !item.el) {
            misses += 1;
            return;
          }
          if (applyOneRule(item.rule, item.el)) appliedCount += 1;
          else misses += 1;
        });
        state.misses = misses;
        state.conflicts = conflicts;

        // d) 重建隐藏样式：hide 规则 selector + 现存隐藏令牌
        const tokenRules = [];
        toArray(document.querySelectorAll('[data-es-hidden]')).forEach(function (el) {
          hiddenTokens(el).forEach(function (token) {
            if (active[token] === true && tokenRules.indexOf(token) === -1) tokenRules.push(token);
          });
        });

        let css = '';
        // 每条 hide 规则写成独立规则块：单个 selector 失效不会连累其它规则
        hideSelectors.forEach(function (selector) {
          css += selector + '{display:none !important;}';
        });
        tokenRules.forEach(function (token) {
          css += '[data-es-hidden~="' + attrValue(token) + '"]{display:none !important;}';
        });
        state.hideCss = css;
        writeInternalStyle('es-hide-rules', css);

        // hide 规则通过 CSS 生效，也算「已应用」
        state.appliedCount = appliedCount + hideSelectors.length;
        return appliedCount;
      })
      .catch(function () {
        /* 存储不可用 / 页面异常时保持静默，不影响宿主页面 */
      })
      .then(function () {
        state.applying = false;
        if (state.pendingSweep) {
          state.pendingSweep = false;
          scheduleSweep();
        }
      });
  }

  /** 目标缺失或未应用的规则 → 需要重新 apply */
  function ruleNeedsApply(rule, claimed) {
    if (!rule || !rule.kind) return false;
    // 历史 image / embed 规则永不应用：直接判「无需处理」，避免 sweep 反复空转
    if (rule.kind === KIND.IMAGE || rule.kind === KIND.EMBED) return false;
    if (rule.kind === KIND.HIDE) {
      const selector = String(rule.selector || '').trim();
      if (!selector) return false;
      return state.hideCss.indexOf(selector) === -1;
    }
    const el = resolveExact(rule) || resolveFuzzy(rule, claimed);
    if (!el) return true; // 目标可能由 SPA 动态插入，交由 apply 再试
    const applied = el.getAttribute('data-es-applied');
    if (applied === rule.id) return false;
    if (applied) return false; // 已被更高优先级规则占用（冲突），不该反复重跑
    if (hiddenTokens(el).some(function (token) { return token !== rule.id; })) return false;
    if (rule.kind === KIND.VIDEO && findReplacement(rule.id)) return false;
    return true;
  }

  let sweepTimer = 0;
  function scheduleSweep() {
    if (sweepTimer) clearTimeout(sweepTimer);
    sweepTimer = setTimeout(function () {
      sweepTimer = 0;
      sweep();
    }, 250);
  }

  function sweep() {
    if (state.applying) {
      state.pendingSweep = true;
      return;
    }
    if (!state.loaded) {
      apply(false);
      return;
    }
    const claimed = new Set();
    let need = false;
    for (let i = 0; i < state.rules.length; i += 1) {
      if (ruleNeedsApply(state.rules[i], claimed)) {
        need = true;
        break;
      }
    }
    if (need) apply(true); // 用缓存规则，避免高频读 storage
  }

  /* ================================================================== *
   * 11. MutationObserver
   * ================================================================== */
  let observer = null;

  function observerRelevant(mutations) {
    for (let i = 0; i < mutations.length; i += 1) {
      const mutation = mutations[i];
      const target = mutation.target;
      if (target && target.nodeType === 1 && isOwnNode(target)) continue;

      const nodes = toArray(mutation.addedNodes).concat(toArray(mutation.removedNodes));
      if (!nodes.length) continue; // 纯文本节点变化，交给上层判断

      const onlyOwn = nodes.every(function (node) {
        if (node.nodeType !== 1) return true;
        return isOwnNode(node);
      });
      if (!onlyOwn) return true;
    }
    return false;
  }

  function onMutations(mutations) {
    if (!mutations || !mutations.length) return;
    if (!observerRelevant(mutations)) return;
    if (state.applying) {
      state.pendingSweep = true;
      return;
    }
    scheduleSweep();
  }

  function startObserver() {
    if (observer || !document.documentElement) return;
    try {
      observer = new MutationObserver(onMutations);
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true
      });
    } catch (e) {
      observer = null;
    }
  }

  /* ================================================================== *
   * 12. 页内 UI 视觉 token（与 popup/popup.css 同源，浮在任意站点上）
   *     白色极简：白卡面 + hairline 描边 + 单一靛蓝强调色 + 极轻阴影。
   *     文字对比度（白底）：正文 15.6:1 / 次级 6.0:1 / 弱化 5.3:1，均过 WCAG AA。
   * ================================================================== */
  const UI = {
    // 面：白卡面 / 内凹 / 悬停抬升
    panel: '#ffffff',
    sunken: '#f7f8fa',
    raise: '#f1f3f6',
    // 描边（hairline，透明度分层）
    line: 'rgba(16,24,40,0.08)',
    lineStrong: 'rgba(16,24,40,0.14)',
    // 文字
    text: '#1a1d23',
    dim: '#5b6472',
    muted: '#646c7a',
    // 强调色（全站唯一，实心按钮用 accent，深色描边用 accentLine）
    accent: '#4f46e5',
    accentHover: '#4338ca',
    accentActive: '#3730a3',
    accentSoft: '#eef0fe',
    accentLine: 'rgba(79,70,229,0.30)',
    accentText: '#4338ca',
    // 语义色
    danger: '#dc2626',
    dangerText: '#b91c1c',
    dangerSoft: '#fef2f2',
    warnText: '#8a5a00',
    warnSoft: '#fff8ec',
    // 阴影（极轻，两层：贴地 1px + 浮起模糊）
    shadow: '0 12px 32px -12px rgba(16,24,40,0.22),0 1px 2px rgba(16,24,40,0.06)',
    shadowSoft: '0 1px 2px rgba(16,24,40,0.06)',
    mono: 'ui-monospace,"Cascadia Mono",SFMono-Regular,Consolas,monospace',
    sans: '-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei UI","Microsoft YaHei",sans-serif',
    ease: 'cubic-bezier(.2,.8,.2,1)'
  };
  const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

  function prefersReduced() {
    try {
      return !!(window.matchMedia && window.matchMedia(REDUCED_MOTION_QUERY).matches);
    } catch (e) {
      return false;
    }
  }

  function viewportSize() {
    return {
      w: Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1),
      h: Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1)
    };
  }

  /* ================================================================== *
   * 12.1 拾取高亮框 + 尺寸/标签小条
   *      1px 强调色描边 + 内部 8% 薄雾 + 四角短角标；外面再压一条暗描边，
   *      保证在浅色页 / 花哨页上都不被背景吃掉。
   * ================================================================== */
  const HL = { box: null, label: null, frame: null, desc: null, size: null, shown: false };
  const HL_CORNER = 9;
  const HL_STROKE = '2px solid ' + UI.accent;

  function hlCornerCss(corner) {
    const css = {
      position: 'absolute',
      width: HL_CORNER + 'px',
      height: HL_CORNER + 'px',
      'pointer-events': 'none',
      'box-sizing': 'border-box'
    };
    const vertical = corner.charAt(0) === 't' ? 'top' : 'bottom';
    const horizontal = corner.charAt(1) === 'l' ? 'left' : 'right';
    css[vertical] = '0';
    css[horizontal] = '0';
    css['border-' + vertical] = HL_STROKE;
    css['border-' + horizontal] = HL_STROKE;
    css['border-' + vertical + '-' + horizontal + '-radius'] = '3px';
    return css;
  }

  /** 四角短角标（拾取高亮框与规则定位闪光共用） */
  function addCornerMarks(host) {
    ['tl', 'tr', 'bl', 'br'].forEach(function (corner) {
      const mark = document.createElement('div');
      mark.setAttribute('data-es-corner', corner);
      styleImportant(mark, hlCornerCss(corner));
      host.appendChild(mark);
    });
  }

  function ensureHighlight() {
    if (!HL.box) {
      HL.box = document.createElement('div');
      HL.box.setAttribute('data-es-ui', 'highlight');
      styleImportant(HL.box, {
        position: 'fixed',
        left: '0px',
        top: '0px',
        width: '0px',
        height: '0px',
        display: 'none',
        'pointer-events': 'none',
        'z-index': MAX_Z_HIGHLIGHT,
        margin: '0',
        padding: '0',
        border: '0',
        background: 'transparent',
        'box-sizing': 'border-box'
      });

      HL.frame = document.createElement('div');
      styleImportant(HL.frame, {
        position: 'absolute',
        left: '0',
        top: '0',
        right: '0',
        bottom: '0',
        'border-radius': '3px',
        border: '1px solid rgba(79,70,229,0.85)',
        background: 'rgba(79,70,229,0.07)',
        'box-shadow': '0 0 0 1px rgba(16,24,40,0.12), inset 0 0 0 1px rgba(255,255,255,0.65)',
        'pointer-events': 'none',
        'box-sizing': 'border-box'
      });
      HL.box.appendChild(HL.frame);
      addCornerMarks(HL.box);
      document.documentElement.appendChild(HL.box);
    }

    if (!HL.label) {
      HL.label = document.createElement('div');
      HL.label.setAttribute('data-es-ui', 'highlight-label');
      styleImportant(HL.label, {
        position: 'fixed',
        left: '0px',
        top: '0px',
        display: 'none',
        'max-width': 'min(320px, calc(100vw - 16px))',
        'align-items': 'center',
        gap: '6px',
        padding: '3px 7px',
        'border-radius': '6px',
        border: '1px solid ' + UI.lineStrong,
        background: 'rgba(255,255,255,0.98)',
        color: UI.text,
        font: '500 11px/1.45 ' + UI.mono,
        'white-space': 'nowrap',
        overflow: 'hidden',
        'pointer-events': 'none',
        'z-index': MAX_Z_HIGHLIGHT,
        margin: '0',
        'box-sizing': 'border-box',
        'text-align': 'left',
        'box-shadow': '0 6px 20px -6px rgba(16,24,40,0.28),0 1px 2px rgba(16,24,40,0.08)'
      });

      HL.desc = document.createElement('span');
      styleImportant(HL.desc, {
        flex: '1 1 auto',
        'min-width': '0',
        overflow: 'hidden',
        'text-overflow': 'ellipsis',
        'white-space': 'nowrap'
      });

      HL.size = document.createElement('span');
      styleImportant(HL.size, {
        flex: '0 0 auto',
        color: UI.muted,
        'padding-left': '6px',
        'border-left': '1px solid ' + UI.line,
        'font-variant-numeric': 'tabular-nums'
      });

      HL.label.appendChild(HL.desc);
      HL.label.appendChild(HL.size);
      document.documentElement.appendChild(HL.label);
    }
  }

  /** info: { desc, size } —— desc 是 tag#id.class，size 是「320 × 180」 */
  function showHighlight(rect, info) {
    ensureHighlight();
    const box = HL.box;
    const label = HL.label;
    if (!box || !label) return;

    const vp = viewportSize();
    box.style.setProperty('left', Math.round(rect.left) + 'px', 'important');
    box.style.setProperty('top', Math.round(rect.top) + 'px', 'important');
    box.style.setProperty('width', Math.max(1, Math.round(rect.width)) + 'px', 'important');
    box.style.setProperty('height', Math.max(1, Math.round(rect.height)) + 'px', 'important');
    box.style.setProperty('display', 'block', 'important');

    HL.desc.textContent = (info && info.desc) || '';
    HL.desc.title = (info && info.desc) || '';
    HL.size.textContent = (info && info.size) || '';
    label.style.setProperty('display', 'flex', 'important');

    // 先落位再量宽，避免标签条右溢出视口
    label.style.setProperty('left', '0px', 'important');
    const labelH = Math.max(20, label.offsetHeight || 20);
    const labelW = Math.max(24, label.offsetWidth || 24);
    const gap = 6;

    let top = Math.round(rect.top) - labelH - gap;
    if (top < 4) {
      // 上方没位置：翻到下方外侧；下方也放不下则压进元素内部顶部
      top = Math.round(rect.top + rect.height) + gap;
      if (top + labelH > vp.h - 4) top = Math.max(4, Math.round(rect.top) + 4);
    }

    let left = Math.round(rect.left);
    const maxLeft = Math.max(4, vp.w - labelW - 4);
    left = Math.min(Math.max(4, left), maxLeft);

    label.style.setProperty('left', left + 'px', 'important');
    label.style.setProperty('top', top + 'px', 'important');

    if (!HL.shown) {
      HL.shown = true;
      if (!prefersReduced()) {
        [box, label].forEach(function (node) {
          try {
            node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 110, easing: UI.ease });
          } catch (e) {
            /* 环境不支持 WAAPI 时直接显示 */
          }
        });
      }
    }
  }

  function hideHighlight() {
    if (HL.box) HL.box.style.setProperty('display', 'none', 'important');
    if (HL.label) HL.label.style.setProperty('display', 'none', 'important');
  }

  function destroyHighlight() {
    removeNode(HL.box);
    removeNode(HL.label);
    HL.box = null;
    HL.label = null;
    HL.frame = null;
    HL.desc = null;
    HL.size = null;
    HL.shown = false;
  }

  function describeElement(el) {
    const rect = el.getBoundingClientRect();
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    return {
      desc: descriptorOf(el),
      size: width + ' × ' + height
    };
  }

  /* ================================================================== *
   * 13. 可视化拾取器
   * ================================================================== */
  const picker = {
    active: false,
    point: null,
    raf: 0,
    hoverEl: null,
    handlers: null
  };

  const PICKER_CSS = 'html.es-picking, html.es-picking body, html.es-picking body *{cursor:crosshair !important;}';

  function pickTargetFromPoint(x, y) {
    if (typeof document.elementFromPoint !== 'function') return null;
    const el = document.elementFromPoint(x, y);
    if (!el || el.nodeType !== 1) return null;
    if (isOwnNode(el)) return null;
    return el;
  }

  function updateHighlightAtPoint(point) {
    if (!picker.active || !point) return;
    const el = pickTargetFromPoint(point.x, point.y);
    if (!el) {
      picker.hoverEl = null;
      hideHighlight();
      return;
    }
    const rect = el.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      picker.hoverEl = null;
      hideHighlight();
      return;
    }
    picker.hoverEl = el;
    showHighlight(rect, describeElement(el));
  }

  function onPickMove(event) {
    if (!picker.active) return;
    picker.point = { x: event.clientX, y: event.clientY };
    if (picker.raf) return;
    picker.raf = requestAnimationFrame(function () {
      picker.raf = 0;
      updateHighlightAtPoint(picker.point);
    });
  }

  /** 阻止页面拿到事件，但放行落在自身 UI 上的操作
   * allowDefault=false 时不调用 preventDefault（pointerdown 取消默认动作会连带吃掉兼容的 click）*/
  function blockEvent(event, el, allowDefault) {
    if (isOwnNode(el) || isOwnNode(event.target)) return;
    if (!allowDefault && event.preventDefault) event.preventDefault();
    if (event.stopPropagation) event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
  }

  /** click 负责「选中」：mousedown 的 preventDefault 不会取消 click，最可靠 */
  function onPickClick(event) {
    if (!picker.active) return;
    const el = pickTargetFromPoint(event.clientX, event.clientY);
    if (!el) return;
    blockEvent(event, el, false);
    selectTarget(el);
  }

  /** pointerdown：只掐断传播，不 preventDefault，保证后续 click 一定派发 */
  function onPickPointerDown(event) {
    if (!picker.active) return;
    const el = pickTargetFromPoint(event.clientX, event.clientY);
    if (!el) return;
    blockEvent(event, el, true);
  }

  /** mousedown：阻止默认（聚焦、文字选择、拖拽），不会抑制 click */
  function onPickMouseDown(event) {
    if (!picker.active) return;
    const el = pickTargetFromPoint(event.clientX, event.clientY);
    if (!el) return;
    blockEvent(event, el, false);
  }

  function onPickKeyDown(event) {
    if (!picker.active) return;
    if (event.key === 'Escape' || event.key === 'Esc') {
      if (event.preventDefault) event.preventDefault();
      stopPicker();
      toast('已退出拾取');
    }
  }

  function onPickViewportChange() {
    if (!picker.active || !picker.point) return;
    if (picker.raf) return;
    picker.raf = requestAnimationFrame(function () {
      picker.raf = 0;
      updateHighlightAtPoint(picker.point);
    });
  }

  function bindPickerEvents() {
    if (picker.handlers) return;
    const handlers = {
      mousemove: onPickMove,
      click: onPickClick,
      mousedown: onPickMouseDown,
      pointerdown: onPickPointerDown,
      keydown: onPickKeyDown,
      scroll: onPickViewportChange,
      resize: onPickViewportChange
    };
    picker.handlers = handlers;
    Object.keys(handlers).forEach(function (type) {
      // 只有需要 preventDefault 的事件才用非 passive，避免滚动性能告警；
      // scroll/resize 必须走 capture 才能拿到任意容器（含非冒泡的滚动事件）
      const needsBlocking = type === 'mousedown' || type === 'pointerdown' || type === 'click';
      window.addEventListener(type, handlers[type], {
        capture: true,
        passive: !needsBlocking
      });
    });
  }

  function unbindPickerEvents() {
    if (!picker.handlers) return;
    const handlers = picker.handlers;
    Object.keys(handlers).forEach(function (type) {
      window.removeEventListener(type, handlers[type], { capture: true });
    });
    picker.handlers = null;
  }

  function startPicker() {
    if (picker.active) return { ok: true };
    closePanel();
    picker.active = true;
    state.pickerActive = true;
    document.documentElement.classList.add('es-picking');
    writeInternalStyle('es-picker-style', PICKER_CSS);
    ensureHighlight();
    hideHighlight();
    bindPickerEvents();
    return { ok: true };
  }

  function stopPicker() {
    if (!picker.active) {
      state.pickerActive = false;
      return { ok: true };
    }
    picker.active = false;
    state.pickerActive = false;
    picker.hoverEl = null;
    picker.point = null;
    if (picker.raf) {
      cancelAnimationFrame(picker.raf);
      picker.raf = 0;
    }
    document.documentElement.classList.remove('es-picking');
    removeInternalStyle('es-picker-style');
    destroyHighlight(); // 退出即销毁高亮宿主，不在页面留残余节点
    unbindPickerEvents();
    return { ok: true };
  }

  function selectTarget(el) {
    if (!el || el.nodeType !== 1) return;
    const selection = {
      el: el,
      selector: buildSelector(el),
      xpath: buildXPath(el),
      tag: localOf(el),
      label: labelFor(el)
    };
    stopPicker();
    destroyHighlight();
    openPanel(selection);
  }

  /* ================================================================== *
   * 14. 页内操作面板（Shadow DOM 隔离）
   * ================================================================== */
  const PANEL_CSS = [
    // 与 popup/popup.css 同一套白色极简 token：白卡片、hairline 描边、单一强调色、极轻阴影
    '*{box-sizing:border-box;}',
    // 高度上限：随视口走但留出 20px 底距 + 4px 顶距（min(100vh-24px,640px)）。
    // 矮窗口里「替换视频」表单（自然高约 346px）也能完整放下，不再被 70vh 压成内部滚动；
    // 宽屏下高度本来就由内容决定，抬高上限不会让面板变高。
    '.wrap{position:relative;display:flex;flex-direction:column;',
    'max-height:min(calc(100vh - 24px),640px);overflow:hidden;',
    'background:' + UI.panel + ';color:' + UI.text + ';border:1px solid ' + UI.lineStrong + ';',
    'border-radius:10px;font:400 13px/1.5 ' + UI.sans + ';',
    'box-shadow:' + UI.shadow + ';',
    'transform-origin:var(--es-origin,50% 100%);',
    'animation:es-panel-in .16s ' + UI.ease + ' both;}',
    '@keyframes es-panel-in{from{opacity:0;transform:translateY(4px);}to{opacity:1;transform:none;}}',

    // 头部：已选元素说明 / tag 徽标 / tag.class 摘要 / 关闭
    '.hd{flex:0 0 auto;display:flex;align-items:flex-start;gap:10px;padding:14px 14px 12px;}',
    '.hd-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:7px;}',
    '.eyebrow{font-size:11px;line-height:1.2;letter-spacing:.3px;color:' + UI.muted + ';}',
    '.hd-line{display:flex;align-items:center;gap:8px;min-width:0;}',
    '.tag{flex:0 0 auto;font:500 11px/1.6 ' + UI.mono + ';color:' + UI.accentText + ';',
    'background:' + UI.accentSoft + ';border:1px solid ' + UI.accentLine + ';border-radius:6px;padding:1px 6px;}',
    '.meta{flex:1 1 auto;min-width:0;font:400 11px/1.6 ' + UI.mono + ';color:' + UI.muted + ';',
    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.x{flex:0 0 auto;appearance:none;display:inline-flex;align-items:center;justify-content:center;',
    'width:26px;height:26px;padding:0;border:1px solid transparent;border-radius:6px;background:transparent;',
    'color:' + UI.muted + ';cursor:pointer;transition:background .16s,color .16s,border-color .16s;}',
    '.x:hover{background:' + UI.sunken + ';border-color:' + UI.line + ';color:' + UI.text + ';}',
    '.x:active{background:' + UI.raise + ';}',

    // 操作卡：仅「隐藏元素」「替换视频」两种，2 列 → 1 行（宽度自适应）
    '.kinds{flex:0 0 auto;display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:0 14px;}',
    '.kind{appearance:none;display:flex;align-items:center;gap:7px;padding:9px 10px;',
    'border:1px solid ' + UI.line + ';border-radius:8px;background:' + UI.panel + ';',
    'color:' + UI.dim + ';font-family:inherit;font-size:12px;font-weight:500;line-height:1.2;text-align:left;',
    'cursor:pointer;transition:background .16s,border-color .16s,color .16s;}',
    '.kind:hover{background:' + UI.sunken + ';border-color:' + UI.lineStrong + ';color:' + UI.text + ';}',
    '.kind:active{background:' + UI.raise + ';}',
    '.kind svg{flex:0 0 auto;width:16px;height:16px;color:' + UI.muted + ';transition:color .16s;}',
    '.kind:hover svg{color:' + UI.dim + ';}',
    '.kind .kname{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.kind[aria-pressed="true"]{border-color:' + UI.accentLine + ';background:' + UI.accentSoft + ';',
    'color:' + UI.accentText + ';}',
    '.kind[aria-pressed="true"] svg{color:' + UI.accentText + ';}',
    '.kind[aria-pressed="true"] .kname{font-weight:600;}',

    // 输入区（content 超出时内部滚动；正常高度下不出现滚动条）
    // 细滚动条：与 popup/.rule-list 同一套（10px、透明轨道、内缩圆角滑块、色值走 rgba 令牌）
    '.body{flex:1 1 auto;min-height:0;overflow-y:auto;padding:2px 14px 0;',
    'scrollbar-width:thin;scrollbar-color:rgba(16,24,40,.28) transparent;}',
    '.body::-webkit-scrollbar{width:10px;height:10px;}',
    '.body::-webkit-scrollbar-track{background:transparent;}',
    '.body::-webkit-scrollbar-thumb{border:3px solid transparent;border-radius:999px;',
    'background:rgba(16,24,40,.18);background-clip:content-box;}',
    '.body::-webkit-scrollbar-thumb:hover{background:rgba(16,24,40,.3);background-clip:content-box;}',
    // 极矮窗口仍会溢出：底部渐隐遮罩提示「下面还有内容」（只在真的溢出时由 JS 加 is-scrollable）
    '.body.is-scrollable::after{content:"";position:sticky;bottom:0;display:block;height:18px;',
    'margin-top:-18px;pointer-events:none;',
    'background:linear-gradient(180deg,rgba(255,255,255,0) 0%,' + UI.panel + ' 88%);}',
    '.body.is-scrollable.at-end::after{opacity:0;}',
    '.field{display:none;margin-top:12px;}',
    '.field.on{display:block;}',
    '.hint{margin:0 0 7px;font-size:11px;line-height:1.5;color:' + UI.muted + ';}',
    'input[type=url]{display:block;width:100%;border:1px solid ' + UI.lineStrong + ';border-radius:8px;',
    'padding:8px 10px;font:400 12px/1.5 ' + UI.mono + ';color:' + UI.text + ';background:' + UI.sunken + ';',
    'outline:none;transition:background .16s,border-color .16s,box-shadow .16s;}',
    'input[type=url]::placeholder{color:' + UI.muted + ';}',
    'input[type=url]:hover{border-color:rgba(16,24,40,.24);}',
    'input[type=url]:focus{background:' + UI.panel + ';border-color:' + UI.accent + ';',
    'box-shadow:0 0 0 3px rgba(79,70,229,.15);}',

    // 抖音页内抓流：只要当前页是 douyin 就出现的一行小按钮（不限 kind）
    '.grab-row{display:none;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap;}',
    '.grab-row.on{display:flex;}',
    '.grab{flex:0 0 auto;appearance:none;display:inline-flex;align-items:center;justify-content:center;',
    'height:26px;padding:0 9px;border:1px solid ' + UI.lineStrong + ';border-radius:6px;',
    'background:' + UI.panel + ';color:' + UI.dim + ';font-family:inherit;font-size:11px;font-weight:500;',
    'line-height:1;cursor:pointer;transition:background .16s,color .16s,border-color .16s;}',
    '.grab:hover{background:' + UI.sunken + ';color:' + UI.text + ';border-color:rgba(16,24,40,.24);}',
    '.grab:active{background:' + UI.raise + ';}',
    '.grab:disabled{cursor:progress;color:' + UI.muted + ';background:' + UI.sunken + ';}',
    '.grab-info{flex:1 1 auto;min-width:0;font:400 11px/1.5 ' + UI.mono + ';color:' + UI.muted + ';}',
    '.grab-info.bad{color:' + UI.dangerText + ';}',

    // 按轨归位提示：极轻的一行说明（不是错误，因此不进 .err 槽）
    '.track-note{display:none;margin:8px 0 1px;font-size:11px;line-height:1.5;color:' + UI.muted + ';}',
    '.track-note.on{display:block;}',

    // 校验错误：固定槽位，出现/消失不改变面板高度
    '.err{flex:0 0 auto;min-height:16px;margin:8px 14px 0;font-size:11px;line-height:1.4;',
    'color:' + UI.dangerText + ';opacity:0;transition:opacity .16s;}',
    '.err.on{opacity:1;}',

    // 底栏：实心主按钮 + 描边次按钮，上方 hairline 分隔
    '.ft{flex:0 0 auto;display:flex;align-items:center;gap:8px;margin-top:12px;padding:12px 14px 14px;',
    'border-top:1px solid ' + UI.line + ';}',
    '.primary{flex:1 1 auto;appearance:none;display:inline-flex;align-items:center;justify-content:center;',
    'height:34px;padding:0 14px;border:1px solid ' + UI.accent + ';border-radius:8px;color:#fff;',
    'background:' + UI.accent + ';',
    'font-family:inherit;font-size:12px;font-weight:600;letter-spacing:.2px;cursor:pointer;',
    'box-shadow:' + UI.shadowSoft + ';',
    'transition:background .16s,border-color .16s,box-shadow .16s,transform .14s;}',
    '.primary:hover{background:' + UI.accentHover + ';border-color:' + UI.accentHover + ';}',
    '.primary:active{background:' + UI.accentActive + ';border-color:' + UI.accentActive + ';',
    'transform:translateY(1px);box-shadow:none;}',
    '.primary:disabled{cursor:not-allowed;background:' + UI.raise + ';border-color:' + UI.line + ';',
    'color:' + UI.muted + ';box-shadow:none;transform:none;}',
    '.ghost{flex:0 0 auto;appearance:none;display:inline-flex;align-items:center;justify-content:center;',
    'height:34px;padding:0 14px;border:1px solid ' + UI.lineStrong + ';border-radius:8px;',
    'background:' + UI.panel + ';color:' + UI.dim + ';font-family:inherit;font-size:12px;font-weight:500;',
    'cursor:pointer;transition:background .16s,color .16s,border-color .16s;}',
    '.ghost:hover{background:' + UI.sunken + ';color:' + UI.text + ';border-color:rgba(16,24,40,.24);}',
    '.ghost:active{background:' + UI.raise + ';}',
    '.ghost:disabled{cursor:not-allowed;color:' + UI.muted + ';border-color:' + UI.line + ';',
    'background:' + UI.sunken + ';}',

    // 焦点环（键盘可见）
    '.x:focus-visible,.kind:focus-visible,.primary:focus-visible,.ghost:focus-visible,.grab:focus-visible{',
    'outline:2px solid ' + UI.accent + ';outline-offset:2px;}',

    // 尊重减少动效
    '@media (prefers-reduced-motion: reduce){',
    '.wrap{animation:none;}.kind,.primary,.ghost,.x,.err,.grab{transition-duration:.001ms;}}'
  ].join('');

  const ICON = {
    hide: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A9.6 9.6 0 0 1 12 5c5 0 9 4.5 9 7a11.7 11.7 0 0 1-2.2 3.3"/><path d="M6.3 6.8A12.9 12.9 0 0 0 3 12c0 2.5 4 7 9 7a9.7 9.7 0 0 0 4-.9"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>',
    video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M10.4 9.6l4.5 2.4-4.5 2.4z"/></svg>'
  };

  const PANEL_HTML = [
    '<div class="wrap">',
    // 标题栏：说明文字 + 元素摘要，右侧关闭（线性图标，无装饰）
    '  <div class="hd">',
    '    <div class="hd-main">',
    '      <span class="eyebrow">已选元素</span>',
    '      <div class="hd-line">',
    '        <span class="tag" id="es-tag">div</span>',
    '        <span class="meta" id="es-meta"></span>',
    '      </div>',
    '    </div>',
    '    <button class="x" id="es-close" type="button" title="关闭" aria-label="关闭">',
    '      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75"',
    ' stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    '    </button>',
    '  </div>',
    '  <div class="kinds" id="es-kinds" role="group" aria-label="操作类型">',
    '    <button class="kind" type="button" data-kind="hide" aria-pressed="false">' + ICON.hide + '<span class="kname">隐藏元素</span></button>',
    '    <button class="kind" type="button" data-kind="video" aria-pressed="false">' + ICON.video + '<span class="kname">替换视频</span></button>',
    '  </div>',
    '  <div class="body">',
    '    <div class="field" id="es-field-url">',
    '      <p class="hint" id="es-url-hint">' + VIDEO_INPUT_HINT + '</p>',
    '      <input type="url" id="es-url" placeholder="' + VIDEO_INPUT_PLACEHOLDER + '" spellcheck="false" autocomplete="off">',
    '      <div class="grab-row" id="es-grab-row">',
    '        <button class="grab" id="es-grab" type="button">抓取当前页面视频流</button>',
    '        <span class="grab-info" id="es-grab-info"></span>',
    '      </div>',
    '    </div>',
    // 只有一个输入框：整段粘贴时自动分成画面 / 声音（声音进内部暂存，不占输入框）
    '    <p class="track-note" id="es-track-note"></p>',
    '  </div>',
    '  <div class="err" id="es-err" role="status" aria-live="polite"></div>',
    '  <div class="ft">',
    '    <button class="primary" id="es-save" type="button">保存并生效</button>',
    '    <button class="ghost" id="es-cancel" type="button">取消</button>',
    '  </div>',
    '</div>'
  ].join('\n');

  const panel = {
    host: null,
    root: null,
    selection: null,
    kind: '',
    resizeHandler: null
  };

  /** 关闭：先让 pointer-events 失效，再 150ms 缩放淡出，最后移除（旧节点不会挡住新面板） */
  function closePanel() {
    const host = panel.host;
    panel.host = null;
    panel.root = null;
    panel.selection = null;
    panel.kind = '';
    // 面板没了，内部暂存的音频地址也必须清掉（它不在任何输入框里）
    resetPendingAudio();
    // 输入区溢出提示用的 resize 监听：面板关了就不再需要，避免监听泄漏
    if (panel.resizeHandler) {
      window.removeEventListener('resize', panel.resizeHandler);
      panel.resizeHandler = null;
    }
    if (!host) return;

    host.style.setProperty('pointer-events', 'none', 'important');
    let removed = false;
    const finish = function () {
      if (removed) return;
      removed = true;
      removeNode(host);
    };
    const wrap = host.shadowRoot ? host.shadowRoot.querySelector('.wrap') : null;
    if (wrap && !prefersReduced() && typeof wrap.animate === 'function') {
      try {
        const anim = wrap.animate(
          [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.97)' }],
          { duration: 150, easing: 'ease-out' }
        );
        anim.onfinish = finish;
        anim.oncancel = finish;
      } catch (e) {
        finish();
        return;
      }
      setTimeout(finish, 280); // 兜底：动画被中断也要清掉
      return;
    }
    finish();
  }

  /** 面板缩放原点朝向被选元素的方向 */
  function panelOriginFor(el) {
    if (!el || !el.getBoundingClientRect) return '50% 100%';
    let rect = null;
    try {
      rect = el.getBoundingClientRect();
    } catch (e) {
      return '50% 100%';
    }
    if (!rect) return '50% 100%';
    const vp = viewportSize();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const x = cx < vp.w / 2 ? 'left' : 'right';
    const y = cy < vp.h * 0.62 ? 'bottom' : 'top';
    return x + ' ' + y;
  }

  function panelEl(id) {
    return panel.root ? panel.root.getElementById(id) : null;
  }

  /**
   * 抓流按钮的文案 / title：抖音页抓的是「已签名流地址」。
   */
  function syncGrabButton() {
    const btn = panelEl('es-grab');
    if (!btn) return;
    btn.textContent = '抓取当前页面视频流';
    btn.title = '抓取当前页面正在播放的视频流地址';
  }

  function showPanelError(message) {
    const box = panelEl('es-err');
    if (!box) return;
    box.textContent = message || '';
    box.classList.toggle('on', !!message);
  }

  /**
   * 输入区溢出提示（极矮窗口兜底）：
   * 真的溢出才给 .body 加 is-scrollable（底部渐隐遮罩 + 细滚动条），
   * 已经滚到底再加 at-end 让遮罩淡出——不靠浏览器默认滚动条，也不用常驻遮罩。
   */
  function syncPanelBodyHint() {
    if (!panel.root) return;
    const body = panel.root.querySelector('.body');
    if (!body) return;
    const scrollable = body.scrollHeight > body.clientHeight + 1;
    body.classList.toggle('is-scrollable', scrollable);
    body.classList.toggle('at-end', scrollable && body.scrollTop + body.clientHeight >= body.scrollHeight - 1);
  }

  function setPanelKind(kind) {
    panel.kind = kind;
    if (!panel.root) return;
    toArray(panel.root.querySelectorAll('.kind')).forEach(function (btn) {
      btn.setAttribute('aria-pressed', btn.getAttribute('data-kind') === kind ? 'true' : 'false');
    });

    const fieldUrl = panelEl('es-field-url');
    const urlInput = panelEl('es-url');
    const urlHint = panelEl('es-url-hint');
    if (!fieldUrl) return;

    // 只有「替换视频」需要输入；「隐藏元素」无输入（整块收起）
    fieldUrl.classList.toggle('on', kind === KIND.VIDEO);

    if (kind === KIND.VIDEO) {
      if (urlInput) urlInput.placeholder = VIDEO_INPUT_PLACEHOLDER;
      if (urlHint) urlHint.textContent = VIDEO_INPUT_HINT;
    }

    // 页内抓流入口：只在抖音页出现（抓已签名流）；其它域一律不显示。
    // 抓到候选后会自动切到「替换视频」。
    const grabRow = panelEl('es-grab-row');
    const canGrabHere = isDouyinPage();
    if (grabRow) grabRow.classList.toggle('on', canGrabHere);
    if (canGrabHere) syncGrabButton();
    if (kind !== KIND.VIDEO) setGrabInfo('', false);
    // 切走 kind：输入收起，内部暂存的音频地址与提示一并清空
    if (kind !== KIND.VIDEO) {
      showTrackNote('');
      resetPendingAudio();
    }

    showPanelError('');
    if (kind === KIND.VIDEO && urlInput) urlInput.focus();
    syncPanelBodyHint();
  }

  function buildPayload() {
    const kind = panel.kind;
    // 只允许 hide / video 落库（历史 image / embed 已下线）
    if (kind !== KIND.HIDE && kind !== KIND.VIDEO) {
      showPanelError('请先选择一种操作');
      return null;
    }
    if (kind === KIND.HIDE) return { payload: {}, ok: true };

    const input = panelEl('es-url');
    const rawText = normText(input ? input.value : '');
    // 保存前再解析一次：输入框里可能残留整段两条地址（绕过 paste 处理直接写值也能兜住）。
    // payload.url 必须是画面轨、payload.audioUrl 是音频轨；音频永远不会被当成画面。
    const parsed = splitTrackAddresses(rawText);
    let url = parsed.url;
    let audioRaw = parsed.audioUrl || state.pendingAudioUrl || '';

    if (!url) {
      if (parsed.hasAudio) {
        // 只有音频轨：明确拒绝，绝不存一条「有声无画」的规则
        showPanelError(TRACK_ONLY_AUDIO_MESSAGE);
        return null;
      }
      if (rawText) {
        showPanelError('链接必须以 http:// 或 https:// 开头');
        return null;
      }
      showPanelError('请填写视频外链或视频页面链接');
      return null;
    }
    // 解析结果写回：用户看到的就是最终要存进去的那一条画面地址
    if (input && input.value !== url) input.value = url;
    state.pendingAudioUrl = audioRaw;

    if (!isHttpUrl(url)) {
      showPanelError('链接必须以 http:// 或 https:// 开头');
      return null;
    }

    const classified = classifyVideoInput(url);
    if (classified.mode === 'invalid') {
      showPanelError('链接必须以 http:// 或 https:// 开头');
      return null;
    }

    // 音频地址（可选）：留空 → 不写 payload.audioUrl，走原来的单 URL 路径（逐字不变）
    if (audioRaw && !isHttpUrl(audioRaw)) {
      showPanelError('音频地址必须以 http:// 或 https:// 开头');
      return null;
    }

    if (classified.mode === 'source') {
      const source = classified.source;
      if (source.provider === 'douyin') {
        // 抖音流必须即时用（Referer 依赖当前页，且服务端解析不了）：
        // 当前页就是 douyin 且已抓到候选 → 直接存成直链 url，不存 source。
        if (!isDouyinPage()) {
          showPanelError('抖音链接需在抖音页面内抓取：请先打开该视频页，再点「抓取当前页面视频流」');
          return null;
        }
        sniffMediaCandidates();
        // 保存路径同样走轨判定：只有音频轨时不给用户存一条「有声无画」的流
        const verdict = douyinGrabVerdict(douyinGrabState());
        if (!verdict.ok) {
          if (verdict.error === 'audio-only') {
            showPanelError(verdict.message);
            return null;
          }
          showPanelError('当前页没有捕获到视频流，请先点击「抓取当前页面视频流」重试');
          return null;
        }
        const payload = { url: verdict.pick.url };
        // 分离流：自动带上的音频轨优先，其次用用户手填的
        const dashAudio = verdict.track === 'dash' && verdict.audioPick ? verdict.audioPick.url : '';
        if (dashAudio || audioRaw) payload.audioUrl = dashAudio || audioRaw;
        return { payload: payload, ok: true };
      }
      // B 站：只存页面链接，解析结果会过期，不能存进 payload.url；
      // audioUrl 不写进 source 分支（流的解析在后台契约里完成）
      return { payload: { source: source }, ok: true };
    }
    const payload = { url: classified.url || url };
    if (audioRaw) payload.audioUrl = audioRaw;
    return { payload: payload, ok: true };
  }

  /** selector 是否能命中该元素（语法异常时视为不命中） */
  function matchesSelector(el, selector) {
    if (!el || !el.matches || !selector) return false;
    try {
      return el.matches(selector);
    } catch (e) {
      return false;
    }
  }

  /** 某条既有规则当前是否命中 targetEl */
  function ruleHitsElement(rule, targetEl) {
    if (!rule || !rule.kind || !targetEl) return false;
    if (rule.kind === KIND.HIDE) {
      // 隐藏规则没有「元素定位」这一步，用 selector 直接判定
      return matchesSelector(targetEl, String(rule.selector || '').trim());
    }
    const el = resolveExact(rule) || resolveFuzzy(rule, new Set());
    return !!el && el === targetEl;
  }

  /**
   * 「这个元素现在改成这样」的语义：保存前把命中同一元素的既有规则找出来删掉，
   * 避免同一元素上堆两条不同类型规则，导致其中一条永远被顶掉。
   */
  function collectSupersededRules(list, targetEl, newRule) {
    const found = [];
    if (!targetEl) return found;
    (list || []).forEach(function (rule) {
      if (!rule || !rule.id || !rule.kind) return;
      if (newRule && rule.id === newRule.id) return;
      if (!ruleHitsElement(rule, targetEl)) return;
      found.push({
        id: rule.id,
        scope: rule.scope === SCOPE.URL ? SCOPE.URL : SCOPE.DOMAIN,
        kind: rule.kind
      });
    });
    return found;
  }

  /** 定位面板里选中的元素（页面可能已经重建过该节点） */
  function panelTargetElement(selection) {
    if (!selection) return null;
    if (selection.el && selection.el.isConnected) return selection.el;
    return queryOne(selection.selector) || queryXPath(selection.xpath);
  }

  function savePanel() {
    const selection = panel.selection;
    if (!selection || !selection.el) {
      closePanel();
      return;
    }
    const built = buildPayload();
    if (!built) return;

    const rule = {
      kind: panel.kind,
      selector: selection.selector,
      xpath: selection.xpath,
      label: selection.label,
      tag: selection.tag,
      payload: built.payload
    };
    const scope = state.settings && state.settings.scope ? state.settings.scope : SCOPE.DOMAIN;
    const targetEl = panelTargetElement(selection);

    showPanelError('');
    let superseded = [];

    // 1) 先读一次最新规则，找出命中同一元素的旧规则
    ES.listRules(location.href)
      .then(function (list) {
        superseded = collectSupersededRules(list, targetEl, null);
        // 2) 逐条删除旧规则（顺序执行，避免并发写坏桶）
        return superseded.reduce(function (chain, item) {
          return chain.then(function () {
            return ES.removeRule(location.href, item.scope, item.id);
          });
        }, Promise.resolve());
      })
      .then(function () {
        // 3) 写入新规则
        return ES.addRule(location.href, scope, rule);
      })
      .then(function () {
        closePanel();
        state.loaded = false; // 规则集已变，下次 apply 重新读
        return apply(false);
      })
      .then(function () {
        toast(built.toast || (superseded.length ? '已替换该元素原有规则' : '已保存，刷新后依然生效'));
      })
      .catch(function (err) {
        showPanelError('保存失败：' + (err && err.message ? err.message : '未知错误'));
      });
  }

  function openPanel(selection) {
    closePanel();
    if (!selection || !selection.el) return;
    panel.selection = selection;

    const host = document.createElement('div');
    host.setAttribute('data-es-ui', 'panel');
    styleImportant(host, {
      position: 'fixed',
      left: '50%',
      bottom: '20px',
      width: '380px',
      'max-width': 'calc(100vw - 16px)',
      transform: 'translateX(-50%)',
      'z-index': MAX_Z_PANEL,
      display: 'block',
      margin: '0',
      padding: '0',
      border: '0',
      background: 'transparent',
      'box-sizing': 'border-box',
      'font-size': '13px',
      'line-height': '1.45',
      'text-align': 'left',
      'pointer-events': 'auto'
    });
    // 缩放原点朝向被选元素（面板自身从底部居中弹出）
    host.style.setProperty('--es-origin', panelOriginFor(selection.el));

    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = PANEL_CSS;
    root.appendChild(style);

    const wrapper = document.createElement('div');
    wrapper.innerHTML = PANEL_HTML;
    while (wrapper.firstChild) root.appendChild(wrapper.firstChild);

    document.documentElement.appendChild(host);
    panel.host = host;
    panel.root = root;
    panel.kind = '';

    // 页内抓流入口（抖音抓已签名流）：面板一打开就可见，
    // 不必先选 kind（随后 setPanelKind 会再校准）；文案也一并校准
    const initialGrabRow = panelEl('es-grab-row');
    if (initialGrabRow) initialGrabRow.classList.toggle('on', isDouyinPage());
    syncGrabButton();

    const tagNode = panelEl('es-tag');
    const metaNode = panelEl('es-meta');
    if (tagNode) tagNode.textContent = selection.tag || 'div';
    if (metaNode) {
      const desc = descriptorOf(selection.el);
      metaNode.textContent = desc;
      metaNode.title = selection.selector || desc;
    }

    toArray(root.querySelectorAll('.kind')).forEach(function (btn) {
      btn.addEventListener('click', function (event) {
        event.preventDefault();
        setPanelKind(btn.getAttribute('data-kind') || '');
      });
    });

    const closeBtn = panelEl('es-close');
    if (closeBtn) closeBtn.addEventListener('click', function (event) {
      event.preventDefault();
      closePanel();
    });

    const cancelBtn = panelEl('es-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', function (event) {
      event.preventDefault();
      closePanel();
    });

    const saveBtn = panelEl('es-save');
    if (saveBtn) saveBtn.addEventListener('click', function (event) {
      event.preventDefault();
      savePanel();
    });

    // 抖音页内抓流按钮（非 douyin 页该行不显示；douyin 页任何 kind 下都显示，
    // 抓到候选后 commitGrabCandidate 会把 kind 切到「替换视频」再填值）
    const grabBtn = panelEl('es-grab');
    if (grabBtn) grabBtn.addEventListener('click', function (event) {
      event.preventDefault();
      grabDouyinMedia();
    });

    // 唯一输入框：整段粘贴时自动分割成画面 / 声音（声音进内部暂存）
    bindTrackInput();

    // 输入区溢出提示：滚动时同步（极矮窗口才有内容可滚）
    const bodyForHint = panel.root.querySelector('.body');
    if (bodyForHint) {
      bodyForHint.addEventListener('scroll', syncPanelBodyHint, { passive: true });
      syncPanelBodyHint();
    }
    // 窗口高度变化会改变 max-height → .body 是否溢出也会变，跟着同步，关闭时移除
    if (panel.resizeHandler) window.removeEventListener('resize', panel.resizeHandler);
    panel.resizeHandler = syncPanelBodyHint;
    window.addEventListener('resize', syncPanelBodyHint);

    root.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' || event.key === 'Esc') {
        event.preventDefault();
        closePanel();
        return;
      }
      if (event.key === 'Enter') {
        const active = root.activeElement;
        if (active && active.tagName === 'INPUT') {
          event.preventDefault();
          savePanel();
        }
      }
    });
  }

  /* ================================================================== *
   * 15. 轻提示 toast（屏幕底部居中；面板打开时自动抬到面板上方）
   * ================================================================== */
  const TOAST = { host: null, fadeTimer: 0, killTimer: 0 };

  function toastLift() {
    // 面板同为底部居中，toast 需要避开它，别遮住可操作区域
    if (!panel.host) return 24;
    let rect = null;
    try {
      rect = panel.host.getBoundingClientRect();
    } catch (e) {
      return 24;
    }
    if (!rect) return 24;
    const lift = Math.round(viewportSize().h - rect.top + 10);
    return lift > 24 ? lift : 24;
  }

  function toast(message) {
    if (!message) return;
    if (TOAST.fadeTimer) clearTimeout(TOAST.fadeTimer);
    if (TOAST.killTimer) clearTimeout(TOAST.killTimer);
    if (TOAST.host) removeNode(TOAST.host);
    TOAST.host = null;

    const host = document.createElement('div');
    host.setAttribute('data-es-ui', 'toast');
    styleImportant(host, {
      position: 'fixed',
      left: '50%',
      bottom: toastLift() + 'px',
      transform: 'translateX(-50%)',
      'z-index': MAX_Z_PANEL,
      display: 'block',
      'pointer-events': 'none',
      margin: '0',
      padding: '0',
      background: 'transparent',
      'box-sizing': 'border-box',
      'max-width': 'calc(100vw - 16px)'
    });

    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = [
      '.t{display:flex;align-items:center;max-width:calc(100vw - 16px);padding:9px 12px;',
      'border:1px solid ' + UI.lineStrong + ';border-left:3px solid ' + UI.accent + ';border-radius:8px;',
      'background:' + UI.panel + ';color:' + UI.text + ';font:500 12px/1.45 ' + UI.sans + ';',
      'box-shadow:' + UI.shadow + ';',
      'animation:es-toast-in .14s ' + UI.ease + ' both;}',
      '.t .msg{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '@keyframes es-toast-in{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:none;}}',
      '@keyframes es-toast-out{from{opacity:1;}to{opacity:0;}}',
      '.t.out{animation:es-toast-out .18s ease forwards;}',
      '@media (prefers-reduced-motion: reduce){.t{animation:none;}.t.out{animation:none;opacity:0;}}'
    ].join('');
    root.appendChild(style);

    const box = document.createElement('div');
    box.className = 't';
    const msg = document.createElement('span');
    msg.className = 'msg';
    msg.textContent = message;
    box.appendChild(msg);
    root.appendChild(box);

    document.documentElement.appendChild(host);
    TOAST.host = host;

    // 1.5s 后淡出，淡完即移除
    TOAST.fadeTimer = setTimeout(function () {
      box.classList.add('out');
    }, 1500);
    TOAST.killTimer = setTimeout(function () {
      removeNode(host);
      if (TOAST.host === host) TOAST.host = null;
    }, 1750);
  }

  /* ================================================================== *
   * 16. 规则定位高亮（popup 的 HIGHLIGHT_RULE）
   * ================================================================== */
  function flashElement(el) {
    const rect = el.getBoundingClientRect();
    const host = document.createElement('div');
    host.setAttribute('data-es-ui', 'flash');
    styleImportant(host, {
      position: 'fixed',
      left: Math.round(rect.left) + 'px',
      top: Math.round(rect.top) + 'px',
      width: Math.max(1, Math.round(rect.width)) + 'px',
      height: Math.max(1, Math.round(rect.height)) + 'px',
      'pointer-events': 'none',
      'z-index': MAX_Z_HIGHLIGHT,
      margin: '0',
      padding: '0',
      border: '0',
      background: 'transparent',
      'box-sizing': 'border-box'
    });

    // 与拾取高亮框同一套观感：1px 强调色描边 + 薄雾 + 四角角标 + 一圈外扩光晕
    const frame = document.createElement('div');
    styleImportant(frame, {
      position: 'absolute',
      left: '0',
      top: '0',
      right: '0',
      bottom: '0',
      'border-radius': '3px',
      border: '1px solid rgba(79,70,229,0.9)',
      background: 'rgba(79,70,229,0.1)',
      'box-shadow': '0 0 0 1px rgba(16,24,40,0.14), 0 0 0 4px rgba(79,70,229,0.14)',
      'box-sizing': 'border-box'
    });
    host.appendChild(frame);
    addCornerMarks(host);

    document.documentElement.appendChild(host);
    if (!prefersReduced()) {
      try {
        host.animate(
          [{ opacity: 0 }, { opacity: 1, offset: 0.12 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }],
          { duration: 1000, easing: 'ease-out' }
        );
      } catch (e) {
        /* 环境不支持 WAAPI */
      }
    }
    setTimeout(function () {
      removeNode(host);
    }, 1000);
  }

  function highlightRule(rule) {
    if (!rule || typeof rule !== 'object') return { ok: false };
    const el = resolveExact(rule) || resolveFuzzy(rule, new Set());
    if (!el) return { ok: false };
    try {
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    } catch (e) {
      try {
        el.scrollIntoView();
      } catch (e2) {
        /* 静默 */
      }
    }
    flashElement(el);
    return { ok: true };
  }

  /* ================================================================== *
   * 17. 状态与消息处理
   * ================================================================== */
  function getState() {
    return {
      pickerActive: state.pickerActive,
      appliedCount: state.appliedCount,
      siteKey: state.siteKey,
      href: location.href,
      scope: state.scope,
      misses: state.misses,
      conflicts: state.conflicts
    };
  }

  function handleMessage(message, sendResponse) {
    const type = message && message.type;
    if (!type) {
      sendResponse({ ok: false, error: 'empty-message' });
      return;
    }

    if (type === MSG.START_PICK) {
      sendResponse(startPicker());
      return;
    }
    if (type === MSG.STOP_PICK) {
      sendResponse(stopPicker());
      return;
    }
    if (type === MSG.GET_STATE) {
      sendResponse(Object.assign({ ok: true }, getState()));
      return;
    }
    if (type === MSG.RULES_CHANGED) {
      state.loaded = false;
      apply(false)
        .then(function () {
          sendResponse(Object.assign({ ok: true }, getState()));
        })
        .catch(function () {
          sendResponse({ ok: false });
        });
      return;
    }
    if (type === MSG.HIGHLIGHT_RULE) {
      sendResponse(highlightRule(message.rule));
      return;
    }

    if (type === 'es:probe-stats') {
      // 只读自测通道：不写存储、不触发 apply / 面板重建，正常用户不可见
      sendResponse(Object.assign({ ok: true }, mainProbeSnapshot(), { picking: state.pickerActive === true }));
      return;
    }

    if (type === 'es:grab-douyin') {
      // 只读抓流通道（popup / 外部脚本可用，无需拾取器与面板）：异步回包，始终 return true
      return handleGrabDouyinMessage(sendResponse);
    }

    sendResponse({ ok: false, error: 'unknown-message' });
  }

  function bindRuntimeMessages() {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.onMessage) return;
    try {
      chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
        try {
          handleMessage(message, function (response) {
            try {
              sendResponse(response || { ok: false });
            } catch (e) {
              /* 端口已关闭，忽略 */
            }
          });
        } catch (e) {
          try {
            sendResponse({ ok: false, error: 'handler-error' });
          } catch (e2) {
            /* 忽略 */
          }
        }
        return true; // 异步响应
      });
    } catch (e) {
      /* 扩展上下文失效时静默 */
    }
  }

  /* ================================================================== *
   * 18. 启动
   * ================================================================== */
  function boot() {
    if (!document.documentElement) return;
    bindRuntimeMessages();
    startObserver();
    apply(false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();