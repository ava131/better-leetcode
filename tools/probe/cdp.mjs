/**
 * 极简 CDP 客户端。零依赖，只用 Node 内置的 fetch 与 WebSocket。
 *
 * 共同前置条件：先起一个带调试端口的 Chrome，**并且用 profile 副本**
 * （这样带你的力扣登录态，又不动你正在用的那份）：
 *
 *   SRC="$HOME/Library/Application Support/Google/Chrome"
 *   rm -rf /tmp/lc-chrome && mkdir -p /tmp/lc-chrome
 *   cp -R "$SRC/Default" /tmp/lc-chrome/Default
 *   cp "$SRC/Local State" /tmp/lc-chrome/
 *   rm -f /tmp/lc-chrome/Singleton* /tmp/lc-chrome/Default/Singleton*
 *   nohup "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *     --headless=new --remote-debugging-port=9222 --user-data-dir=/tmp/lc-chrome \
 *     --no-sandbox --disable-gpu --disable-gpu-sandbox --in-process-gpu \
 *     --disable-software-rasterizer --disable-dev-shm-usage \
 *     --crash-dumps-dir=/tmp/lc-chrome/Crashpad \
 *     --no-first-run --no-default-browser-check about:blank >/tmp/lc-chrome.log 2>&1 &
 *
 * 踩过的坑：
 *  - macOS 没有 `setsid`
 *  - `--disable-gpu` 单独不够，会 `FATAL: GPU process isn't usable`
 *  - 用完记得删掉 /tmp/lc-chrome（里面有你的 cookie）
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export const CDP_BASE = "http://127.0.0.1:9222";
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const EXT_SRC = resolve(REPO_ROOT, "extension/src");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function assertCdpUp() {
  try {
    const r = await fetch(`${CDP_BASE}/json/version`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) throw new Error();
  } catch {
    throw new Error(`连不上 ${CDP_BASE}。先按本文件顶部注释启动带调试端口的 Chrome。`);
  }
}

export async function newTab(url = "about:blank") {
  const r = await fetch(`${CDP_BASE}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  if (!r.ok) throw new Error(`新建标签页失败 ${r.status}`);
  return r.json();
}

export class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    /** 执行上下文。★ 每次导航都会新建隔离上下文，旧的会失效，所以要跟踪生死 */
    this.contexts = [];
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = rej;
    });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && c.pending.has(m.id)) {
        const { res, rej } = c.pending.get(m.id);
        c.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      } else if (m.method) {
        if (m.method === "Runtime.executionContextCreated") c.contexts.push(m.params.context);
        else if (m.method === "Runtime.executionContextDestroyed")
          c.contexts = c.contexts.filter((x) => x.id !== m.params.executionContextId);
        else if (m.method === "Runtime.executionContextsCleared") c.contexts = [];
        c.events.push(m);
      }
    };
    return c;
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** 在**主世界**执行表达式。读取共享的 DOM 不需要进隔离 world。 */
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) return { __err: JSON.stringify(r.exceptionDetails).slice(0, 400) };
    return r.result.value;
  }

  /** 主 frame 的 id。用来把「主文档」和「页面里的 iframe」区分开 */
  async mainFrameId() {
    try {
      const { frameTree } = await this.send("Page.getFrameTree");
      return frameTree?.frame?.id ?? null;
    } catch {
      return null;
    }
  }

  /**
   * 在**最新的**指定隔离 world 里求值。
   *
   * ★ 必须每次重新解析上下文：每次导航都会新建一个隔离上下文，
   *   `executionContextCreated` 会攒一堆已失效的。写死一个 id 迟早会报
   *   "Cannot find context with specified id"。
   */
  async evalInWorld(worldName, expression) {
    // ★ 两个坑叠在一起：
    //   1) `Page.addScriptToEvaluateOnNewDocument` 作用于**所有 frame**，
    //      页面里的 iframe 也会跑一遍 content script（真实扩展默认只跑顶层）；
    //   2) 每次导航都会新建隔离上下文，旧的会失效。
    //   所以必须：先锁定主 frame，再取该 frame 里 id 最大的上下文。
    const mainFrameId = await this.mainFrameId();
    const ctx = this.contexts
      .filter((c) => c.name === worldName && (!mainFrameId || c.auxData?.frameId === mainFrameId))
      .sort((a, b) => a.id - b.id)
      .pop();
    if (!ctx) throw new Error(`主 frame 里找不到 world "${worldName}" 的存活上下文`);
    const r = await this.send("Runtime.evaluate", {
      expression,
      contextId: ctx.id,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) return { __err: JSON.stringify(r.exceptionDetails).slice(0, 300) };
    return r.result.value;
  }

  /**
   * 注入脚本。**这是保真的关键**：
   *  - 省略 worldName → MAIN world（模拟扩展的 `"world": "MAIN"`）
   *  - 给了 worldName → 一个隔离 world（模拟扩展默认的 ISOLATED content script）
   *
   * 两个都注进同一个 world 是**假的**，会掩盖跨 world 通信的 bug（我们踩过，见
   * docs/TECH-DESIGN.md ★20）。
   */
  addInitScript(source, worldName) {
    return this.send("Page.addScriptToEvaluateOnNewDocument", {
      source,
      ...(worldName ? { worldName } : {}),
    });
  }

  navigate(url) {
    return this.send("Page.navigate", { url });
  }
}

/** 起一个标签页并连好 CDP */
export async function open({ width = 1440, height = 900 } = {}) {
  await assertCdpUp();
  const tab = await newTab();
  const cdp = await CDP.connect(tab.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  if (width) {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }
  return cdp;
}

/**
 * 读取侧边栏状态。**走 DOM** —— DOM 是两个 world 唯一共享的东西，
 * 所以从主世界读隔离 world 建的 Shadow DOM 是可行且可靠的。
 */
export const READ_SIDEBAR = `(() => {
  // 取最上面那个（测试环境里可能叠了多个；真实扩展只有一个）
  const h = [...document.querySelectorAll('#better-leetcode-host')].pop();
  if (!h || !h.shadowRoot) return JSON.stringify({ exists: false });
  const sr = h.shadowRoot, s = sr.querySelector('.status');
  return JSON.stringify({
    exists: true,
    url: location.pathname,
    version: sr.querySelector('.ver')?.textContent ?? null,
    statusClass: s ? s.className : null,
    statusText: s ? s.innerText.replace(/\\n/g, ' | ') : null,
    chips: [...sr.querySelectorAll('.chip')].map(c => c.textContent),
    messages: [...sr.querySelectorAll('.msg')].map(m => m.textContent.slice(0, 40)),
  });
})()`;

/** 给隔离 world 用的最小 chrome.* stub（模拟扩展环境） */
export const CHROME_STUB = `
// ★ 这段代码要能被**重复执行**（同一 realm 里重跑一次不该炸），
//   所以一律挂在 window 上，不用const/let —— 见下面 __blInstallChromeStub。
window.__sess = window.__sess || {}; window.__local = window.__local || {}; window.__diag = window.__diag || [];
window.__blStub = window.__blStub || {
  storage: {
    // 真的存起来，方便断言"偏好有没有持久化"
    local: {
      get: async (keys) => {
        const o = {};
        (keys || []).forEach((k) => { if (window.__local[k] !== undefined) o[k] = window.__local[k]; });
        return o;
      },
      set: async (o) => { Object.assign(window.__local, o); },
    },
    session: {
      get: async (keys) => { const o = {}; keys.forEach(k => { if (window.__sess[k]) o[k] = window.__sess[k]; }); return o; },
      set: async (o) => { Object.assign(window.__sess, o); },
      remove: async (k) => { delete window.__sess[k]; },
    },
  },
  runtime: {
    // 模拟后端：发一条假回复再 done，这样 sending 会复位，能连着测多次发送。
    // 把 window.__blStubHang 设成 true 就不回复 —— 用来测「停止」按钮和超时。
    // 把 window.__blStubLong 设成 true 就**慢慢流一大段**（60 个 delta），
    //   用来测滚动行为：内容一直在长，正好看"会不会追尾部"。
    connect: () => {
      const handlers = [];
      const reply = (m) => { if (!window.__blStubHang) handlers.forEach((h) => h(m)); };
      if (window.__blStubLong) {
        // true → 默认 60 段 × 20ms；也可以给 { n, ms } 精确控制时长
        const cfg = window.__blStubLong === true ? { n: 60, ms: 20 } : window.__blStubLong;
        let n = 0;
        const tick = setInterval(() => {
          n++;
          reply({ type: "thinking", text: "想一下这个问题。" });
          reply({ type: "delta", text: "第 " + n + " 段：这里是一段用来撑高对话的测试文本，验证滚动跟随。" });
          if (n >= cfg.n) { clearInterval(tick); reply({ type: "done", chars: n * 40 }); }
        }, cfg.ms);
        return {
          onMessage: { addListener: (f) => handlers.push(f) },
          onDisconnect: { addListener: () => {} },
          postMessage: () => {},
          disconnect: () => { clearInterval(tick); },
        };
      }
      setTimeout(() => reply({ type: "delta", text: "（stub）" }), 60);
      setTimeout(() => reply({ type: "done", chars: 6 }), 140);
      return {
        onMessage: { addListener: (f) => handlers.push(f) },
        onDisconnect: { addListener: () => {} },
        postMessage: () => {},
        disconnect: () => {},
      };
    },
    getURL: (p) => "chrome-extension://stub/" + p,
    sendMessage: async (m) => {
      if (m.type === 'diag') { window.__diag.push(m.payload); }
      if (m.type === 'health') return { ok: true, model: 'stub', models: ['stub'], hasKey: true, memory: { ok: true } };
      return { ok: true };
    },
  },
};

// ★ 不能直接给 window.chrome 赋值就完事：Chrome 自己也有个 window.chrome
//   （loadTimes/csi），会在 document-start 之后覆盖掉我们的桩。症状是
//   backendOk 永远 false —— 所有"点发送"的用例都变成「后端没连上」，
//   看起来像扩展坏了。所以用**数据属性**占位，并在启动阶段补装几次。
window.__blInstallChromeStub = () => {
  try {
    Object.defineProperty(window, "chrome", {
      configurable: true,
      writable: true,
      value: window.__blStub,
    });
  } catch {
    try { window.chrome = window.__blStub; } catch {}
  }
  return typeof window.chrome?.runtime?.sendMessage;
};
window.__blInstallChromeStub();
document.addEventListener("readystatechange", window.__blInstallChromeStub, true);
setTimeout(window.__blInstallChromeStub, 0);
setTimeout(window.__blInstallChromeStub, 100);
`;
