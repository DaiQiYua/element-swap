/**
 * 极简 CDP 客户端（零依赖）：
 *   - 用全局 WebSocket（Node 22+ 内置）连到 webSocketDebuggerUrl
 *   - 按 id 收发 { id, method, params } / { id, result | error }
 *   - 支持订阅事件（Runtime.exceptionThrown / Page.loadEventFired 等）
 * 每个 target 各自一个连接（page / service_worker / 侧栏页），不使用 flat session。
 */

const DEFAULT_TIMEOUT = 20000;

export class CDPError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CDPError';
  }
}

export class CDP {
  constructor(webSocketUrl) {
    this.url = webSocketUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.events = [];
    this.closed = false;
  }

  async connect(timeout) {
    const limit = typeof timeout === 'number' ? timeout : 10000;
    const ws = new WebSocket(this.url);
    this.ws = ws;

    await new Promise(function (resolve, reject) {
      const timer = setTimeout(function () {
        reject(new CDPError('ws 连接超时: ' + ws.url));
      }, limit);
      ws.addEventListener('open', function () {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      ws.addEventListener('error', function (event) {
        clearTimeout(timer);
        reject(new CDPError('ws 连接失败: ' + (event && event.message ? event.message : 'error')));
      }, { once: true });
    });

    const self = this;
    ws.addEventListener('message', function (event) {
      self.#handleMessage(event.data);
    });
    ws.addEventListener('close', function () {
      self.closed = true;
      self.pending.forEach(function (entry) {
        entry.reject(new CDPError('ws 已关闭（未完成: ' + entry.method + '）'));
      });
      self.pending.clear();
    });
    ws.addEventListener('error', function () {
      /* 连接错误在 close 里统一处理，避免未捕获 */
    });
    return this;
  }

  #handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch (e) {
      return;
    }
    if (message && typeof message.id === 'number') {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) {
        entry.reject(new CDPError(entry.method + ' 失败: ' + (message.error.message || JSON.stringify(message.error))));
      } else {
        entry.resolve(message.result || {});
      }
      return;
    }
    if (message && message.method) {
      this.events.push({ method: message.method, params: message.params || {}, at: Date.now() });
      if (this.events.length > 300) this.events.shift();
      const set = this.listeners.get(message.method);
      if (set) {
        set.forEach(function (fn) {
          try {
            fn(message.params || {});
          } catch (e) {
            /* 监听器异常不影响主流程 */
          }
        });
      }
    }
  }

  send(method, params, timeout) {
    if (this.closed || !this.ws) {
      return Promise.reject(new CDPError('ws 未就绪: ' + method));
    }
    const self = this;
    const id = this.nextId;
    this.nextId += 1;
    const limit = typeof timeout === 'number' ? timeout : DEFAULT_TIMEOUT;

    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function () {
        self.pending.delete(id);
        reject(new CDPError('CDP 超时: ' + method));
      }, limit);

      self.pending.set(id, {
        method: method,
        resolve: function (value) {
          clearTimeout(timer);
          resolve(value);
        },
        reject: function (err) {
          clearTimeout(timer);
          reject(err);
        }
      });

      try {
        self.ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
      } catch (e) {
        clearTimeout(timer);
        self.pending.delete(id);
        reject(new CDPError('ws 发送失败: ' + method + ' ' + e.message));
      }
    });
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(handler);
    const self = this;
    return function off() {
      const set = self.listeners.get(method);
      if (set) set.delete(handler);
    };
  }

  /** 等待某个事件（带超时） */
  waitEvent(method, timeout) {
    const limit = typeof timeout === 'number' ? timeout : 10000;
    const self = this;
    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function () {
        off();
        reject(new CDPError('等待事件超时: ' + method));
      }, limit);
      const off = self.on(method, function (params) {
        clearTimeout(timer);
        off();
        resolve(params);
      });
    });
  }

  close() {
    this.closed = true;
    try {
      if (this.ws) this.ws.close();
    } catch (e) {
      /* 已关闭 */
    }
  }
}

/** 在页面/扩展页里求值；异常会抛成 Error，便于用例断言 */
export async function evaluate(conn, expression, options) {
  const opts = options || {};
  const res = await conn.send('Runtime.evaluate', {
    expression: expression,
    awaitPromise: opts.awaitPromise !== false,
    returnByValue: true,
    userGesture: true,
    includeCommandLineAPI: false
  }, opts.timeout);

  if (res && res.exceptionDetails) {
    const details = res.exceptionDetails;
    const description = (details.exception && (details.exception.description || details.exception.value))
      || details.text
      || '未知异常';
    throw new Error('页面求值异常: ' + String(description).split('\n').slice(0, 3).join(' '));
  }
  if (!res || !res.result) return undefined;
  return res.result.value;
}