/**
 * Element Swap - 共享契约层（content script / popup / background 共用）
 * 经典脚本（非 ESM），挂到 globalThis.ES，供其它脚本直接使用。
 * 任何一侧都不得修改本文件，存储结构变更需三方同步。
 */
(function () {
  'use strict';

  var VERSION = 1;

  /** 消息类型：popup -> content */
  var MSG = {
    START_PICK: 'es:start-pick',
    STOP_PICK: 'es:stop-pick',
    GET_STATE: 'es:get-state',
    RULES_CHANGED: 'es:rules-changed',
    HIGHLIGHT_RULE: 'es:highlight-rule'
  };

  /** 规则类型 */
  var KIND = {
    HIDE: 'hide',
    IMAGE: 'image',
    VIDEO: 'video',
    EMBED: 'embed'
  };

  /** 保存粒度 */
  var SCOPE = {
    DOMAIN: 'domain',
    URL: 'url'
  };

  var STORAGE = {
    SETTINGS: 'es_settings',
    RULES: 'es_rules'
  };

  var DEFAULTS = {
    scope: SCOPE.DOMAIN,
    version: VERSION
  };

  function uid() {
    return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function hasStorage() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  }

  function storageGet(keys) {
    if (!hasStorage()) return Promise.resolve({});
    return new Promise(function (resolve) {
      chrome.storage.local.get(keys, function (res) {
        // 兼容运行时错误，保证不抛未捕获异常
        if (chrome.runtime && chrome.runtime.lastError) return resolve({});
        resolve(res || {});
      });
    });
  }

  function storageSet(obj) {
    if (!hasStorage()) return Promise.resolve();
    return new Promise(function (resolve) {
      chrome.storage.local.set(obj, function () {
        resolve();
      });
    });
  }

  /** 读设置（缺字段用默认值补全） */
  function getSettings() {
    return storageGet(STORAGE.SETTINGS).then(function (res) {
      var saved = res[STORAGE.SETTINGS] || {};
      return {
        scope: saved.scope === SCOPE.URL ? SCOPE.URL : SCOPE.DOMAIN,
        version: VERSION
      };
    });
  }

  function updateSettings(patch) {
    return getSettings().then(function (cur) {
      var next = Object.assign({}, cur, patch || {}, { version: VERSION });
      var obj = {};
      obj[STORAGE.SETTINGS] = next;
      return storageSet(obj).then(function () {
        return next;
      });
    });
  }

  /**
   * 由页面 URL 推出存储键。
   * domain: "domain:example.com"（含子域差异，不做 www 合并，行为可预期）
   * url:    "url:https://example.com/path"（忽略 query / hash，避免参数抖动）
   */
  function keysForUrl(url) {
    var u;
    try {
      u = new URL(url);
    } catch (e) {
      return { domain: null, url: null, host: '', origin: '', path: '' };
    }
    if (!/^https?:$/.test(u.protocol)) {
      return { domain: null, url: null, host: u.hostname, origin: u.origin, path: u.pathname };
    }
    return {
      domain: 'domain:' + u.hostname,
      url: 'url:' + u.origin + u.pathname,
      host: u.hostname,
      origin: u.origin,
      path: u.pathname
    };
  }

  function readAllRules() {
    return storageGet(STORAGE.RULES).then(function (res) {
      return res[STORAGE.RULES] || {};
    });
  }

  function writeAllRules(all) {
    var obj = {};
    obj[STORAGE.RULES] = all;
    return storageSet(obj);
  }

  function bucketRules(all, key) {
    if (!key) return [];
    var bucket = all[key];
    if (!bucket || !Array.isArray(bucket.rules)) return [];
    return bucket.rules;
  }

  /**
   * 取当前页生效规则：域名桶 + 精确网址桶都要应用（网址桶更细，后应用）。
   * 每条规则额外带 scope 字段，便于 UI 展示与删除定位。
   */
  function listRules(url) {
    var keys = keysForUrl(url);
    return readAllRules().then(function (all) {
      var out = [];
      bucketRules(all, keys.domain).forEach(function (r) {
        out.push(Object.assign({}, r, { scope: SCOPE.DOMAIN, siteKey: keys.domain }));
      });
      bucketRules(all, keys.url).forEach(function (r) {
        out.push(Object.assign({}, r, { scope: SCOPE.URL, siteKey: keys.url }));
      });
      return out;
    });
  }

  function addRule(url, scope, rule) {
    var keys = keysForUrl(url);
    var key = scope === SCOPE.URL ? keys.url : keys.domain;
    if (!key) return Promise.reject(new Error('unsupported-url'));
    return readAllRules().then(function (all) {
      var bucket = all[key] || { host: keys.host, scope: scope, rules: [], updatedAt: 0 };
      var full = Object.assign({}, rule, {
        id: (rule && rule.id) || uid(),
        createdAt: (rule && rule.createdAt) || Date.now()
      });
      bucket.rules = bucket.rules.filter(function (r) {
        return r.id !== full.id;
      });
      bucket.rules.push(full);
      bucket.updatedAt = Date.now();
      all[key] = bucket;
      return writeAllRules(all).then(function () {
        return full;
      });
    });
  }

  function removeRule(url, scope, ruleId) {
    var keys = keysForUrl(url);
    var key = scope === SCOPE.URL ? keys.url : keys.domain;
    if (!key) return Promise.resolve();
    return readAllRules().then(function (all) {
      var bucket = all[key];
      if (!bucket || !Array.isArray(bucket.rules)) return;
      bucket.rules = bucket.rules.filter(function (r) {
        return r.id !== ruleId;
      });
      bucket.updatedAt = Date.now();
      if (!bucket.rules.length) delete all[key];
      else all[key] = bucket;
      return writeAllRules(all);
    });
  }

  /** 清空当前页面两个桶（域名 + 该网址），即“一键重置” */
  function clearForUrl(url) {
    var keys = keysForUrl(url);
    return readAllRules().then(function (all) {
      var changed = false;
      [keys.domain, keys.url].forEach(function (k) {
        if (k && all[k]) {
          delete all[k];
          changed = true;
        }
      });
      if (!changed) return;
      return writeAllRules(all);
    });
  }

  /** 统计用：某个 host 下所有桶的规则总数 */
  function countForHost(url) {
    var keys = keysForUrl(url);
    return readAllRules().then(function (all) {
      var n = 0;
      Object.keys(all).forEach(function (k) {
        if (k === keys.url || k === keys.domain) {
          n += bucketRules(all, k).length;
        }
      });
      return n;
    });
  }

  var ES = {
    VERSION: VERSION,
    MSG: MSG,
    KIND: KIND,
    SCOPE: SCOPE,
    STORAGE: STORAGE,
    DEFAULTS: DEFAULTS,
    uid: uid,
    keysForUrl: keysForUrl,
    getSettings: getSettings,
    updateSettings: updateSettings,
    listRules: listRules,
    addRule: addRule,
    removeRule: removeRule,
    clearForUrl: clearForUrl,
    countForHost: countForHost
  };

  globalThis.ES = ES;
  if (typeof module !== 'undefined' && module.exports) module.exports = ES;
})();