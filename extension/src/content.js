/**
 * ISOLATED world 内容脚本：侧边栏 UI + 状态机 + 与后端通信。
 * Shadow DOM 隔离样式（否则被力扣 CSS 污染）。
 */

(function () {
  "use strict";

  // esc / md 来自 markdown.js（content_scripts 的多个 js 共享同一作用域）
  const { esc, md } = globalThis.__BL_MD__;

  const TAG = "__better_leetcode__";
  /** 版本号显示在标题旁 —— 用来确认扩展到底有没有重新加载 */
  const VER = "0.6.1";

  /**
   * ★ nonce 不能从 window 读！
   *   MAIN world 设的 window.__BL_NONCE__ 在 ISOLATED world 里是 undefined，
   *   那样所有消息都会被 nonce 校验丢掉（插件表现为完全没反应）。
   *   DOM 是两个 world 共享的，所以从 DOM 属性读；读不到就等第一条消息时学习。
   */
  let NONCE = "";
  function readNonce() {
    if (NONCE) return NONCE;
    try {
      NONCE = document.documentElement.getAttribute("data-bl-nonce") || "";
    } catch {}
    return NONCE;
  }


  // ───────────────────────── 状态（会话级，不落库） ─────────────────────────

  const S = {
    problem: null, // {id,slug,title,difficulty,tags,content}
    code: "",
    lang: "python3",
    verdict: null,
    testcase: null,
    passed: null,
    total: null,
    runtimeError: null,
    submissionId: null,
    /** 会话内的历史代码快照，不落库。见 TECH-DESIGN §8.3 */
    codeHistory: [],
    messages: [], // 只放"说过的话" + system 标记
    collapsed: false,
    backendOk: false,
    streaming: false,
    slug: null,
    /** 已提交、判题中（异步判题需要这个中间态） */
    judging: false,
    judgeFailed: false,
    /** 运行中（点「运行」跑示例用例） */
    running: false,
    /** 最近一次运行的结果 —— 和提交是两条独立链路 */
    run: null,
    /** 最近一次动作："run" | "submit"，决定状态条优先显示谁 */
    lastAction: null,
    /** 点到力扣界面（面板之外）时收起。默认开 */
    collapseOnBlur: true,
    /** 吸附在哪一侧："left" | "right" */
    side: "right",
    /** 面板顶边位置（纵向保留，横向交给 side） */
    panelTop: 60,
    /** 用户拖出来的面板尺寸 */
    panelSize: null,
    /** 当前选中的模型（空 = 用后端的默认值） */
    model: "",
    /** 后端给出的可选模型列表 */
    models: [],
  };

  const SUGGESTIONS_NEW = ["这题有几种解法？", "思路是什么？", "帮我分析下这题的坑"];
  const SUGGESTIONS_JUDGED = ["这版哪里错了", "为什么这里会错", "找个用例一步步走", "这题有几种解法？"];
  const SUGGESTIONS_RUN = ["这个用例为什么不过", "帮我找个用例一步步走", "运行过了为什么提交会挂", "这题有几种解法？"];

  /** 从 URL 里取题号。力扣是 /problems/{slug}/... ，tab 会跟在后面 */
  function slugFromPath() {
    const m = location.pathname.match(/\/problems\/([^/]+)/);
    return m ? m[1] : null;
  }

  /**
   * 向自己所在的 window 发消息。
   *
   * ★ 坑：在 about:blank / 沙箱 iframe 里 `location.origin` 是字符串 "null"，
   *   直接当 targetOrigin 传会抛 `SyntaxError: Invalid target origin 'null'`。
   *   消息本来就没离开这个 window，安全性靠 nonce 保证，所以退化成 "*" 没问题。
   */
  function postToSelf(msg) {
    const o = location.origin;
    const target = o && o !== "null" ? o : "*";
    try {
      window.postMessage(msg, target);
    } catch {
      try {
        window.postMessage(msg, "*");
      } catch {}
    }
  }

  /**
   * 汇报诊断给后端 → 落到 server/bl-server.log。
   * 排查"插件到底看到了什么"用。失败时静默，绝不影响主流程。
   */
  function diag(event, data) {
    try {
      chrome.runtime
        .sendMessage({
          type: "diag",
          payload: {
            event,
            url: location.href,
            slug: S.slug || slugFromPath(),
            data,
          },
        })
        .catch(() => {});
    } catch {}
  }

  // ───────────────────────── UI ─────────────────────────

  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; }
.wrap { position: fixed; top: 60px; width: 380px; max-height: calc(100vh - 90px);
  min-width: 300px; display: flex; flex-direction: column; background: #fff; border: 1px solid #e5e7eb;
  border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,.14); z-index: 2147483000;
  overflow: hidden; font-size: 13px; color: #111827; }
/* 靠哪一边：拖动后自动吸附到最近一侧 */
.wrap.side-right { right: 12px; }
.wrap.side-left  { left: 12px; }
.wrap.dragging { box-shadow: 0 14px 44px rgba(0,0,0,.22); opacity: .96; }
.wrap.dragging .hd { cursor: grabbing; }
/* 左下角的尺寸把手（面板贴右边，所以往左拖是变宽） */
.grip { position: absolute; bottom: 0; width: 18px; height: 18px; touch-action: none; z-index: 2; }
.wrap.side-right .grip { left: 0; cursor: nesw-resize; }
.wrap.side-left  .grip { right: 0; cursor: nwse-resize; }
.grip::after { content: ""; position: absolute; bottom: 4px; width: 7px; height: 7px; opacity: .8; }
.wrap.side-right .grip::after { left: 4px;
  border-left: 2px solid #cbd5e1; border-bottom: 2px solid #cbd5e1; border-radius: 0 0 0 3px; }
.wrap.side-left .grip::after { right: 4px;
  border-right: 2px solid #cbd5e1; border-bottom: 2px solid #cbd5e1; border-radius: 0 0 3px 0; }
.grip:hover::after { border-color: #2563eb; opacity: 1; }
@media (prefers-color-scheme: dark) {
  .wrap { background: #1f2937; border-color: #374151; color: #f3f4f6; }
  .hd { background: #111827; border-color: #374151; }
  .msg.user { background: #374151; }
  .msg.assistant { background: #1f2937; }
  .input { background: #111827; border-color: #374151; color: #f3f4f6; }
  .chip { background: #374151; border-color: #4b5563; color: #e5e7eb; }
  .card { background: #111827; border-color: #4b5563; }
  code, pre { background: #111827 !important; }
}
.wrap.collapsed { display: none; }

.ball { position: fixed; width: 46px; height: 46px; border-radius: 13px;
  background: #fff; border: 1px solid #e5e7eb; overflow: hidden;
  color: #fff; display: none; align-items: center; justify-content: center;
  cursor: grab; box-shadow: 0 4px 16px rgba(77,107,254,.42); z-index: 2147483000;
  border: none; padding: 0; user-select: none; touch-action: none; }
.ball.show { display: flex; }
.ball.side-right { right: 18px; }
.ball.side-left  { left: 18px; }
.ball:active { cursor: grabbing; }
.ball.dragging { box-shadow: 0 8px 28px rgba(77,107,254,.55); transform: scale(1.06); }
.ball svg { width: 26px; height: 26px; pointer-events: none; }
.ball .ds { font-size: 17px; font-weight: 700; letter-spacing: -.6px; line-height: 1;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", sans-serif;
  pointer-events: none; }
.ball .pet { width: 100%; height: 100%; object-fit: cover; display: block; pointer-events: none; }
.ball .dot { position: absolute; top: -3px; right: -3px; width: 11px; height: 11px; border-radius: 50%;
  background: #22c55e; border: 2px solid #fff; display: none; pointer-events: none; }
.ball .dot.show { display: block; }

.hd { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #e5e7eb;
  background: #f9fafb; flex: 0 0 auto; cursor: grab; user-select: none; touch-action: none; }
.hd .ttl { font-weight: 600; font-size: 13px; flex: 1; }
.hd .ver { font-weight: 400; font-size: 10px; color: #9ca3af; font-family: ui-monospace, monospace; }
.hd .model { border: 1px solid #d1d5db; background: #fff; color: #4b5563; border-radius: 5px;
  font-size: 11px; padding: 2px 4px; max-width: 132px; cursor: pointer; outline: none; }
.hd .model:focus { border-color: #2563eb; }
@media (prefers-color-scheme: dark) {
  .hd .model { background: #1f2937; border-color: #4b5563; color: #d1d5db; }
}
.hd button { border: none; background: transparent; cursor: pointer; color: #6b7280; font-size: 15px;
  padding: 2px 6px; border-radius: 4px; line-height: 1; }
.hd button:hover { background: #e5e7eb; }
.hd button.on { background: #dbeafe; color: #1d4ed8; }

/* 状态条 —— 回答「上下文已就绪」这个需求 */
.status { padding: 7px 12px; font-size: 12px; border-bottom: 1px solid #e5e7eb; flex: 0 0 auto;
  display: flex; flex-direction: column; gap: 3px; }
.status .line1 { display: flex; align-items: center; gap: 6px; font-weight: 600; }
.status .line2 { color: #6b7280; font-size: 11px; font-family: ui-monospace, monospace;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.status.gray  { background: #f3f4f6; color: #4b5563; }
.status.green { background: #ecfdf5; color: #047857; }
.status.yellow{ background: #fffbeb; color: #b45309; }
.status.blue  { background: #eff6ff; color: #1d4ed8; }
.status .dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; }
.status.gray .dot   { background: #9ca3af; }
.status.green .dot  { background: #10b981; }
.status.yellow .dot { background: #f59e0b; }
.status.blue .dot   { background: #3b82f6; animation: blpulse 1.1s ease-in-out infinite; }
@keyframes blpulse { 0%,100% { opacity: 1; } 50% { opacity: .28; } }

.body { flex: 1 1 auto; overflow-y: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 10px; }
.body:empty::after { content: "问点什么。题干和代码已经在我手里了。"; color: #9ca3af; font-size: 12px; }

.msg { padding: 8px 10px; border-radius: 8px; white-space: pre-wrap; word-break: break-word; line-height: 1.55; }
.msg.user { background: #eff6ff; align-self: flex-end; max-width: 88%; }
.msg.assistant { background: #f9fafb; align-self: stretch; }
.msg.system { align-self: stretch; text-align: center; color: #9ca3af; font-size: 11px;
  font-family: ui-monospace, monospace; padding: 2px; }
.msg.assistant p { margin: 0 0 7px; }
.msg.assistant p:last-child { margin-bottom: 0; }
.msg.assistant h1, .msg.assistant h2, .msg.assistant h3, .msg.assistant h4 {
  margin: 11px 0 5px; font-size: 13px; font-weight: 700; line-height: 1.35; }
.msg.assistant h1 { font-size: 15px; } .msg.assistant h2 { font-size: 14px; }
.msg.assistant ul, .msg.assistant ol { margin: 5px 0 8px; padding-left: 20px; }
.msg.assistant li { margin: 2px 0; }
.msg.assistant ul li { list-style: disc; } .msg.assistant ol li { list-style: decimal; }
.msg.assistant blockquote { margin: 6px 0; padding: 2px 0 2px 9px; border-left: 3px solid #c7d2fe;
  color: #6b7280; }
.msg.assistant blockquote p { margin: 0; }
.msg.assistant hr { border: none; border-top: 1px solid #e5e7eb; margin: 9px 0; }
.msg.assistant a { color: #2563eb; text-decoration: underline; }
.msg.assistant del { opacity: .6; }
.msg.assistant strong { font-weight: 700; }
.msg.assistant code { background: #eef2ff; padding: 1px 4px; border-radius: 3px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.msg.assistant pre { background: #0f172a; color: #e2e8f0; padding: 8px 10px; border-radius: 6px;
  overflow-x: auto; margin: 6px 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px; line-height: 1.5; position: relative; }
.msg.assistant pre code { background: none; padding: 0; color: inherit; font-size: inherit; }
.msg.assistant pre[data-lang]:not([data-lang=""])::before {
  content: attr(data-lang); position: absolute; top: 4px; right: 8px;
  font-size: 10px; color: #64748b; text-transform: lowercase; }
.msg.assistant table { border-collapse: collapse; margin: 6px 0; font-size: 12px; width: 100%; }
.msg.assistant th, .msg.assistant td { border: 1px solid #e5e7eb; padding: 3px 6px; text-align: left; }
.msg.assistant th { background: #f3f4f6; font-weight: 600; }
@media (prefers-color-scheme: dark) {
  .msg.assistant code { background: #111827; color: #c7d2fe; }
  .msg.assistant th, .msg.assistant td { border-color: #4b5563; }
  .msg.assistant th { background: #111827; }
  .msg.assistant hr { border-top-color: #4b5563; }
}
.msg.err { background: #fef2f2; color: #b91c1c; align-self: stretch; }

/* 推理模型的思考指示 —— 没有它用户要盯空白面板几十秒 */
.thinking { display: flex; align-items: center; gap: 7px; color: #9ca3af; font-size: 12px; }
.thinking .spinner { width: 11px; height: 11px; border: 2px solid #d1d5db;
  border-top-color: #6366f1; border-radius: 50%; animation: blspin .7s linear infinite; flex: 0 0 auto; }
.thinking .tcount { font-family: ui-monospace, monospace; font-size: 11px; opacity: .75; }
@keyframes blspin { to { transform: rotate(360deg); } }
.msg.assistant .content:empty { display: none; }

.chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 12px 8px; flex: 0 0 auto; }
.chip { border: 1px solid #d1d5db; background: #fff; color: #374151; border-radius: 999px;
  padding: 4px 10px; font-size: 12px; cursor: pointer; }
.chip:hover { background: #f3f4f6; }

.card { border: 1px solid #c7d2fe; background: #f5f7ff; border-radius: 8px; padding: 9px 10px;
  font-size: 12px; display: flex; flex-direction: column; gap: 6px; }
.card .k { font-weight: 600; color: #4338ca; }
.card .d { color: #4b5563; }
.card .btns { display: flex; gap: 6px; }
.card button { border-radius: 5px; padding: 3px 10px; font-size: 12px; cursor: pointer; border: 1px solid; }
.card .yes { background: #4338ca; border-color: #4338ca; color: #fff; }
.card .no { background: transparent; border-color: #d1d5db; color: #6b7280; }

.ft { display: flex; gap: 6px; padding: 8px 12px 10px; border-top: 1px solid #e5e7eb; flex: 0 0 auto; }
.input { flex: 1; resize: none; border: 1px solid #d1d5db; border-radius: 7px; padding: 7px 9px;
  font-size: 13px; font-family: inherit; max-height: 120px; min-height: 34px; outline: none; }
.input:focus { border-color: #2563eb; }
.send { border: none; background: #2563eb; color: #fff; border-radius: 7px; padding: 0 14px;
  cursor: pointer; font-size: 13px; }
.send:disabled { background: #9ca3af; cursor: default; }
`;

  let root, host, wrap, ball, statusEl, bodyEl, chipsEl, inputEl, sendEl, modelEl, pinEl;

  /** 小球的形象图。拿不到 URL 就退回文字标（测试环境里 chrome.runtime 可能是 stub） */
  let PET = "";
  try {
    PET = chrome.runtime.getURL("assets/pet.jpg");
  } catch {}

  function build() {
    host = document.createElement("div");
    host.id = "better-leetcode-host";
    root = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = CSS;
    root.appendChild(style);

    wrap = document.createElement("div");
    wrap.className = "wrap";
    wrap.innerHTML = `
      <div class="hd">
        <span class="ttl">AI 刷题小助手 <span class="ver">v${VER}</span></span>
        <select class="model" title="切换模型"></select>
        <button data-act="pin" title="点力扣界面时收起">⇤</button>
        <button data-act="clear" title="清空对话">⟲</button>
        <button data-act="collapse" title="收起">—</button>
      </div>
      <div class="status gray"></div>
      <div class="body"></div>
      <div class="chips"></div>
      <div class="ft">
        <textarea class="input" rows="1" placeholder="问点什么…  Enter 发送 · Shift+Enter 换行"></textarea>
        <button class="send">发送</button>
      </div>
      <div class="grip" title="拖动调整大小"></div>`;
    root.appendChild(wrap);

    ball = document.createElement("button");
    ball.className = "ball";
    ball.innerHTML = PET
      ? `<img class="pet" alt="" src="${PET}"><span class="dot"></span>`
      : `<span class="ds">DS</span><span class="dot"></span>`;
    ball.title = "打开 AI 刷题小助手（可拖动）";
    root.appendChild(ball);

    document.documentElement.appendChild(host);

    statusEl = root.querySelector(".status");
    bodyEl = root.querySelector(".body");
    chipsEl = root.querySelector(".chips");
    inputEl = root.querySelector(".input");
    sendEl = root.querySelector(".send");
    modelEl = root.querySelector(".model");

    pinEl = root.querySelector('[data-act="pin"]');
    const gripEl = root.querySelector(".grip");

    // ── 面板尺寸：拖左下角。面板贴右边，所以往左拖 = 变宽 ──
    gripEl.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const r = wrap.getBoundingClientRect();
      const start = { x: e.clientX, y: e.clientY, w: r.width, h: r.height };
      try {
        gripEl.setPointerCapture(e.pointerId);
      } catch {}
      // 拖动过程中就防抖保存 —— 别只依赖 pointerup（它有可能丢，
      // 例如指针离开窗口、或者被别的元素抢走）。真实浏览器里 pointerup
      // 基本都会来，但"基本"不是"一定"。
      let saveTimer = null;
      const saveSize = () => {
        const r2 = wrap.getBoundingClientRect();
        S.panelSize = { w: Math.round(r2.width), h: Math.round(r2.height) };
        try {
          chrome.storage?.local.set({ blPanelSize: S.panelSize });
        } catch {}
      };
      const move = (ev) => {
        const w = Math.min(Math.max(300, start.w - (ev.clientX - start.x)), window.innerWidth - 40);
        const h = Math.min(Math.max(320, start.h + (ev.clientY - start.y)), window.innerHeight - 40);
        wrap.style.width = w + "px";
        wrap.style.height = h + "px";
        wrap.style.maxHeight = "none";
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(saveSize, 250);
      };
      const up = () => {
        if (saveTimer) clearTimeout(saveTimer);
        gripEl.removeEventListener("pointermove", move);
        gripEl.removeEventListener("pointerup", up);
        gripEl.removeEventListener("pointercancel", up);
        window.removeEventListener("mouseup", up);
        window.removeEventListener("blur", up);
        saveSize();
      };
      gripEl.addEventListener("pointermove", move);
      gripEl.addEventListener("pointerup", up);
      gripEl.addEventListener("pointercancel", up);
      // 兜底：指针跑出窗口/被抢走时也要收尾
      window.addEventListener("mouseup", up);
      window.addEventListener("blur", up);
    });

    // ── 拖动面板：拖标题栏 ──
    const hdEl = root.querySelector(".hd");
    let panDrag = null;
    hdEl.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button, select")) return; // 别抢按钮/下拉的交互
      const r = wrap.getBoundingClientRect();
      panDrag = { dx: e.clientX - r.left, dy: e.clientY - r.top, w: r.width };
      try {
        hdEl.setPointerCapture(e.pointerId);
      } catch {}
      wrap.classList.add("dragging");
      e.preventDefault();
    });
    hdEl.addEventListener("pointermove", (e) => {
      if (!panDrag) return;
      const x = Math.min(Math.max(4, e.clientX - panDrag.dx), window.innerWidth - panDrag.w - 4);
      const y = Math.min(Math.max(4, e.clientY - panDrag.dy), window.innerHeight - 60);
      wrap.style.left = x + "px";
      wrap.style.right = "auto";
      wrap.style.top = y + "px";
    });
    const endPan = () => {
      if (!panDrag) return;
      panDrag = null;
      wrap.classList.remove("dragging");
      snapToSide();
    };
    hdEl.addEventListener("pointerup", endPan);
    hdEl.addEventListener("pointercancel", endPan);
    window.addEventListener("mouseup", endPan);
    window.addEventListener("blur", endPan);

    // ── 点到面板外面就收起 ──
    //
    // 这**不是**"鼠标移开就收" —— 鼠标划过不算离开，那样读答案时会被反复打断。
    // 只有用户真的去点力扣界面（编辑器、题面…）才收。
    document.addEventListener(
      "pointerdown",
      (ev) => {
        if (!S.collapseOnBlur || S.collapsed) return;
        // composedPath 能穿透 Shadow DOM：点在面板里的话 host 一定在路径上
        const path = ev.composedPath ? ev.composedPath() : [];
        if (path.includes(host)) return;
        setCollapsed(true);
      },
      true
    );

    pinEl.addEventListener("click", () => {
      S.collapseOnBlur = !S.collapseOnBlur;
      applyPinUI();
      saveLayout();
      say("system", S.collapseOnBlur ? "已开：点力扣界面时收起" : "已关：点外部不收起");
    });

    modelEl.addEventListener("change", () => {
      S.model = modelEl.value;
      try {
        chrome.storage?.local.set({ blModel: S.model });
      } catch {}
      say("system", `已切到 ${S.model}（下一轮生效）`);
    });

    root.querySelector('[data-act="collapse"]').onclick = () => setCollapsed(true);
    root.querySelector('[data-act="clear"]').onclick = () => {
      S.messages = [];
      renderMessages();
      say("system", "对话已清空（记忆不受影响）");
    };
    // 拖动小球 + 点击。用位移阈值区分两者，避免"拖完顺手跳开侧边栏"。
    // 横向松手后吸附到最近一侧，纵向位置保留。
    let drag = null;
    ball.addEventListener("pointerdown", (e) => {
      const r = ball.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false, sx: e.clientX, sy: e.clientY };
      try {
        ball.setPointerCapture(e.pointerId);
      } catch {}
      ball.classList.add("dragging");
    });
    ball.addEventListener("pointermove", (e) => {
      if (!drag) return;
      if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 4) return;
      drag.moved = true;
      const x = Math.min(Math.max(0, e.clientX - drag.dx), window.innerWidth - ball.offsetWidth);
      const y = Math.min(Math.max(0, e.clientY - drag.dy), window.innerHeight - ball.offsetHeight);
      ball.style.left = x + "px";
      ball.style.right = "auto";
      ball.style.top = y + "px";
    });
    const endDrag = () => {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      ball.classList.remove("dragging");
      if (moved) {
        const r = ball.getBoundingClientRect();
        S.side = r.left + r.width / 2 < window.innerWidth / 2 ? "left" : "right";
        S.ballTop = Math.round(Math.min(Math.max(4, r.top), window.innerHeight - 60));
        ball.style.left = "";
        ball.style.right = "";
        applySide();
        applyBallLayout();
        saveLayout();
      } else {
        setCollapsed(false);
      }
    };
    ball.addEventListener("pointerup", endDrag);
    ball.addEventListener("pointercancel", endDrag);

    // ── 发送 ──
    sendEl.onclick = send;

    inputEl.addEventListener("keydown", (e) => {
      // Enter 发送，Shift+Enter 换行。
      // 中文输入法组词时按 Enter 是"上屏"，不能当发送 ——
      // 除了 isComposing，还要防 keyCode 229（Chrome 上组词结束的 Enter 有时
      // isComposing 已经是 false，但 keyCode 仍是 229）。
      if (e.key !== "Enter" || e.shiftKey || e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      send();
    });

    // 输入框随内容自动撑高（上限 120px）
    inputEl.addEventListener("input", () => {
      inputEl.style.height = "auto";
      inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + "px";
    });

    document.addEventListener(
      "keydown",
      (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "i") {
          e.preventDefault();
          setCollapsed(false);
          inputEl.focus();
        }
      },
      true
    );
  }

  function applySide() {
    const left = S.side === "left";
    wrap.classList.toggle("side-left", left);
    wrap.classList.toggle("side-right", !left);
    ball.classList.toggle("side-left", left);
    ball.classList.toggle("side-right", !left);
  }

  function applyPinUI() {
    if (!pinEl) return;
    pinEl.classList.toggle("on", !!S.collapseOnBlur);
    pinEl.title = S.collapseOnBlur ? "点力扣界面时收起：已开" : "点力扣界面时收起：已关";
    pinEl.textContent = S.collapseOnBlur ? "⇤" : "⇥";
  }

  /** 面板：纵向位置 + 尺寸。横向由 side 类决定 */
  function applyPanelLayout() {
    wrap.style.top = Math.max(4, S.panelTop || 60) + "px";
    if (S.panelSize) {
      const w = Math.min(Math.max(300, S.panelSize.w), window.innerWidth - 40);
      const h = Math.min(Math.max(320, S.panelSize.h), window.innerHeight - 40);
      wrap.style.width = w + "px";
      wrap.style.height = h + "px";
      wrap.style.maxHeight = "none";
    }
  }

  /** 小球：只记纵向。横向跟着 side 走 */
  function applyBallLayout() {
    const fallback = window.innerHeight - 140;
    const top = Number.isFinite(S.ballTop) ? S.ballTop : fallback;
    S.ballTop = Math.round(Math.min(Math.max(4, top), window.innerHeight - 60));
    ball.style.top = S.ballTop + "px";
    ball.style.left = "";
    ball.style.right = "";
  }

  /**
   * 松手后吸附到最近的一侧。
   * 面板和小球**共用** S.side —— 一起拖、一起靠边，不会一个左一个右。
   */
  function snapToSide() {
    const r = wrap.getBoundingClientRect();
    S.side = r.left + r.width / 2 < window.innerWidth / 2 ? "left" : "right";
    S.panelTop = Math.round(Math.min(Math.max(8, r.top), window.innerHeight - 80));
    wrap.style.left = "";
    wrap.style.right = "";
    applySide();
    applyPanelLayout();
    applyBallLayout();
    saveLayout();
  }

  function saveLayout() {
    try {
      chrome.storage?.local.set({
        blSide: S.side,
        blPanelTop: S.panelTop,
        blPanelSize: S.panelSize,
        blBallTop: S.ballTop,
        blCollapseOnBlur: S.collapseOnBlur,
      });
    } catch {}
  }

  function setCollapsed(v) {
    S.collapsed = v;
    wrap.classList.toggle("collapsed", v);
    ball.classList.toggle("show", v);
    if (!v) {
      applySide();
      applyPanelLayout();
      setTimeout(() => inputEl.focus(), 50);
    }
    try {
      chrome.storage?.local.set({ blCollapsed: v });
    } catch {}
  }

  function statusLine() {
    if (!S.backendOk) {
      statusEl.className = "status yellow";
      statusEl.innerHTML = `<div class="line1"><span class="dot"></span>后端未连接</div>
        <div class="line2">先启动 server（node src/index.ts），然后刷新本页</div>`;
      return;
    }
    if (S.judging || S.running) {
      statusEl.className = "status blue";
      const t = S.problem ? S.problem.title : "";
      statusEl.innerHTML = `<div class="line1"><span class="dot"></span>${
        S.judging ? "判题中…" : "运行中…"
      }</div>
        <div class="line2">${esc(t)} · 拿到结果后自动就绪</div>`;
      return;
    }
    if (S.judgeFailed) {
      statusEl.className = "status yellow";
      statusEl.innerHTML = `<div class="line1"><span class="dot"></span>没等到判题结果</div>
        <div class="line2">可以手动告诉我结果，或再提交一次</div>`;
      return;
    }
    // 最近一次是「运行」→ 优先显示运行结果（用户日常最常用这个）
    if (S.lastAction === "run" && S.run) {
      const r = S.run;
      const ok = !r.failedIndex && /accepted/i.test(r.verdict ?? "");
      statusEl.className = "status " + (ok ? "green" : "yellow");
      const bits = [S.problem ? S.problem.title : "", `运行 ${r.verdict ?? "?"}`, `${r.passed}/${r.total}`];
      const detail = r.failedIndex
        ? `第 ${r.failedIndex} 个用例：你的输出 ${esc(trim(r.answers?.[r.failedIndex - 1], 20))} / 期望 ${esc(trim(r.expected?.[r.failedIndex - 1], 20))}`
        : "示例用例全过（但示例全过 ≠ 提交能过）";
      statusEl.innerHTML = `<div class="line1"><span class="dot"></span>运行结果已就绪</div>
        <div class="line2">${esc(bits.filter(Boolean).join(" · "))}</div>
        <div class="line2">${detail}</div>`;
      return;
    }

    if (S.verdict) {
      statusEl.className = "status green";
      const pass = S.passed != null && S.total != null ? ` · ${S.passed}/${S.total}` : "";
      const bits = [];
      if (S.problem) bits.push(S.problem.title);
      bits.push(S.verdict + pass);
      const tc = S.testcase ? `用例 ${trim(S.testcase.input, 46)} → ${trim(S.testcase.output, 18)} / 期望 ${trim(S.testcase.expected, 18)}` : "无失败用例（可能是编译错误）";
      statusEl.innerHTML = `<div class="line1"><span class="dot"></span>上下文已就绪</div>
        <div class="line2">${esc(bits.join(" · "))}</div>
        <div class="line2" title="${esc(tc)}">${esc(tc)}</div>`;
    } else {
      statusEl.className = "status gray";
      const t = S.problem ? S.problem.title : "（题干未取到）";
      statusEl.innerHTML = `<div class="line1"><span class="dot"></span>已就绪（未提交）</div>
        <div class="line2">${esc(t)} · 题干 + 代码</div>`;
    }
  }

  /** 用后端 /health 返回的模型列表填充下拉框 */
  function syncModels(health) {
    if (!modelEl) return;
    const list = Array.isArray(health?.models) && health.models.length
      ? health.models
      : health?.model
      ? [health.model]
      : [];
    if (!list.length) {
      modelEl.style.display = "none";
      return;
    }
    modelEl.style.display = "";
    const sig = list.join("|");
    if (S.models.join("|") !== sig) {
      S.models = list;
      modelEl.innerHTML = list.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join("");
    }
    // 优先用用户上次选的；它不在列表里就退回后端默认值
    const wanted = S.model && list.includes(S.model) ? S.model : health?.model || list[0];
    if (modelEl.value !== wanted) modelEl.value = wanted;
    S.model = wanted;
  }

  function trim(s, n) {    if (s == null) return "";
    s = String(s).replace(/\n/g, "⏎");
    return s.length > n ? s.slice(0, n) + "…" : s;
  }
  function renderMessages() {
    bodyEl.innerHTML = "";
    for (const m of S.messages) {
      const d = document.createElement("div");
      d.className = "msg " + m.role;
      if (m.role === "assistant") d.innerHTML = md(m.content);
      else d.textContent = m.content;
      bodyEl.appendChild(d);
    }
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  function appendMessage(role, content) {
    S.messages.push({ role, content });
    const d = document.createElement("div");
    d.className = "msg " + role;
    if (role === "assistant") d.innerHTML = md(content);
    else d.textContent = content;
    bodyEl.appendChild(d);
    bodyEl.scrollTop = bodyEl.scrollHeight;
    return d;
  }

  /** 流式：先在气泡里累积，结束后再走一次 markdown */
  function beginStreamBubble() {
    const d = document.createElement("div");
    d.className = "msg assistant";
    // 推理模型会先思考很久（实测 pro 首字节 77s）。
    // 必须给即时反馈，否则用户盯着空白面板。
    const think = document.createElement("div");
    think.className = "thinking";
    think.innerHTML = `<span class="spinner"></span><span class="tlabel">思考中…</span><span class="tcount"></span>`;
    d.appendChild(think);
    const content = document.createElement("div");
    content.className = "content";
    d.appendChild(content);
    bodyEl.appendChild(d);

    let buf = "";
    let thinkChars = 0;
    let gotContent = false;

    return {
      think(t) {
        thinkChars += t.length;
        const c = think.querySelector(".tcount");
        if (c) c.textContent = `${Math.round(thinkChars / 2)} 字`;
        bodyEl.scrollTop = bodyEl.scrollHeight;
      },
      push(t) {
        if (!gotContent) {
          gotContent = true;
          think.remove();
        }
        buf += t;
        content.textContent = buf;
        bodyEl.scrollTop = bodyEl.scrollHeight;
      },
      finish() {
        think.remove();
        content.innerHTML = md(buf);
        bodyEl.scrollTop = bodyEl.scrollHeight;
        return buf;
      },
      fail(msg) {
        think.remove();
        d.className = "msg err";
        d.textContent = msg;
      },
    };
  }

  function renderChips() {
    const list =
      S.lastAction === "run" && S.run
        ? SUGGESTIONS_RUN
        : S.verdict
        ? SUGGESTIONS_JUDGED
        : SUGGESTIONS_NEW;
    chipsEl.innerHTML = "";
    if (!S.backendOk) return;
    for (const t of list) {
      const b = document.createElement("button");
      b.className = "chip";
      b.textContent = t;
      b.onclick = () => {
        inputEl.value = t;
        send();
      };
      chipsEl.appendChild(b);
    }
  }

  function renderMemoryCards(suggestions) {
    for (const s of suggestions) {
      const d = document.createElement("div");
      d.className = "card";
      const isStuck = s.kind === "stuck_point";
      d.innerHTML = `
        <div class="k">💡 记下来？</div>
        <div class="d">${isStuck ? "卡点" : "解法"}：${esc(isStuck ? s.desc : s.name)}</div>
        ${s.insight ? `<div class="d">认知：${esc(s.insight)}</div>` : ""}
        ${!isStuck && s.time ? `<div class="d">${esc(s.time)}${s.space ? " / " + esc(s.space) : ""}</div>` : ""}
        <div class="btns"><button class="yes">记下来</button><button class="no">不用</button></div>`;
      const remove = () => d.remove();
      d.querySelector(".yes").onclick = async () => {
        try {
          const r = await chrome.runtime.sendMessage({
            type: "confirmMemory",
            payload: { slug: S.problem?.slug, problem: S.problem, suggestions: [s] },
          });
          d.querySelector(".btns").innerHTML = `<span class="d">${
            r?.results?.[0]?.ok ? "✓ 已记录" : "✗ " + (r?.results?.[0]?.message || "写入失败")
          }</span>`;
          setTimeout(remove, 1200);
        } catch (e) {
          d.querySelector(".btns").innerHTML = `<span class="d">✗ ${esc(e.message)}</span>`;
        }
      };
      d.querySelector(".no").onclick = remove;
      bodyEl.appendChild(d);
    }
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  function say(role, text) {
    appendMessage(role, text);
  }

  // ───────────────────────── 发送 ─────────────────────────

  function snapshotCode() {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 300);
      const handler = (ev) => {
        const d = ev.data;
        if (d && d.__bl === TAG && d.nonce === NONCE && d.type === "code") {
          clearTimeout(timer);
          window.removeEventListener("message", handler);
          resolve(d.payload);
        }
      };
      window.addEventListener("message", handler);
      postToSelf({ __bl: TAG, nonce: readNonce(), type: "read_code" });
    });
  }

  /** 让拦截器读一次题面。力扣题面是 SSR 的，必须主动要，不能靠监听。 */
  function requestProblem() {
    postToSelf({ __bl: TAG, nonce: readNonce(), type: "read_problem" });
  }

  /**
   * 握手：请求拦截器回一条带 nonce 的 ready。
   * ISOLATED world 读不到 MAIN world 的 window 变量，而拦截器在 document_start
   * 发的 ready 我们（document_idle）已经错过了 —— 不补这一次，所有消息都会被
   * nonce 校验丢掉，插件表现为"完全没反应"。
   */
  function handshake() {
    postToSelf({ __bl: TAG, nonce: readNonce(), type: "hello" });
  }

  let sending = false;
  async function send() {
    const text = inputEl.value.trim();
    if (!text || sending) return;

    if (!S.backendOk) {
      say("error", "后端没连上。先在 server 目录跑 `node src/index.ts`。");
      return;
    }

    // 代码可能刚改过，先同步一次
    const snap = await snapshotCode();
    if (snap?.code) {
      S.code = snap.code;
      if (snap.lang) S.lang = snap.lang;
    }

    inputEl.value = "";
    inputEl.style.height = "auto";
    appendMessage("user", text);

    sending = true;
    sendEl.disabled = true;
    const bubble = beginStreamBubble();

    const payload = {
      sessionId: sessionId(),
      problem: S.problem || { id: 0, slug: S.slug || "unknown", title: S.slug || "" },
      code: S.code || "",
      lang: S.lang,
      model: S.model || undefined,
      verdict: S.verdict,
      testcase: S.testcase,
      run: S.run,
      passed: S.passed,
      total: S.total,
      runtimeError: S.runtimeError,
      codeHistory: S.codeHistory.slice(-2),
      messages: S.messages.slice(0, -1).concat([{ role: "user", content: text }]),
    };

    try {
      const port = chrome.runtime.connect({ name: "chat" });
      let full = "";
      port.onMessage.addListener((m) => {
        if (m.type === "thinking") {
          bubble.think(m.text);
        } else if (m.type === "delta") {
          full += m.text;
          bubble.push(m.text);
        } else if (m.type === "memory_suggestion") {
          renderMemoryCards(m.suggestions);
        } else if (m.type === "done") {
          const rendered = bubble.finish();
          S.messages.push({ role: "assistant", content: rendered });
          saveSession();
          port.disconnect();
          sending = false;
          sendEl.disabled = false;
          inputEl.focus();
        } else if (m.type === "error") {
          bubble.fail("✗ " + m.message);
          port.disconnect();
          sending = false;
          sendEl.disabled = false;
        }
      });
      port.postMessage({ type: "chat", payload });
    } catch (e) {
      bubble.fail("✗ " + e.message);
      sending = false;
      sendEl.disabled = false;
    }
  }

  function sessionId() {
    if (!S._sid) S._sid = (S.problem?.slug || "unknown") + "-" + Date.now().toString(36);
    return S._sid;
  }

  // ───────────────────────── 接收拦截器消息 ─────────────────────────

  window.addEventListener("message", (ev) => {
    const d = ev.data;
    if (!d || d.__bl !== TAG) return;
    // 第一条消息顺便把 nonce 学下来（DOM 属性读不到时的兜底）
    if (!NONCE && d.nonce) NONCE = d.nonce;
    if (!NONCE || d.nonce !== NONCE) return;

    // 每一次拦截器消息都记一笔（排查时序问题最有用）
    diag("rx:" + d.type, d.payload ? { keys: Object.keys(d.payload) } : undefined);

    switch (d.type) {
      case "problem": {
        const p = d.payload;
        // 换题 → 结束当前会话（旧会话不落库）
        if (p.slug && S.slug && p.slug !== S.slug) resetSession(p.slug);
        S.slug = p.slug || S.slug;
        S.problem = {
          id: p.id || S.problem?.id || 0,
          slug: p.slug,
          title: p.title,
          difficulty: p.difficulty,
          tags: p.tags,
          content: p.content,
        };
        updateAll();
        break;
      }
      case "code": {
        if (d.payload?.code) {
          S.code = d.payload.code;
          if (d.payload.lang) S.lang = d.payload.lang;
          statusLine();
        }
        break;
      }
      case "submitted": {
        S.submissionId = d.payload.submissionId;
        break;
      }
      case "running": {
        S.running = true;
        S.lastAction = "run";
        updateAll();
        break;
      }
      case "run": {
        applyRun(d.payload);
        break;
      }
      case "judging": {
        // 判题是异步的，先亮中间态，别让界面看起来是死的
        S.judging = true;
        S.running = false;
        S.lastAction = "submit";
        S.judgeFailed = false;
        S.submissionId = d.payload.submissionId;
        updateAll();
        break;
      }
      case "judge_failed": {
        S.judging = false;
        S.judgeFailed = true;
        updateAll();
        break;
      }
      case "submission": {
        applySubmission(d.payload);
        break;
      }
      case "error": {
        console.warn("[better-leetcode] 拦截器报告:", d.payload);
        break;
      }
    }
  });

  function applySubmission(s) {
    if (!s) return;
    S.judging = false;
    S.judgeFailed = false;

    // 把当前这版存进会话历史（不落库），供"刚才那版为什么错"
    if (S.code && S.verdict && S.code !== s.code) {
      S.codeHistory.unshift({ code: S.code, verdict: S.verdict, testcase: S.testcase, passed: S.passed, total: S.total });
      if (S.codeHistory.length > 2) S.codeHistory.pop();
    }

    S.verdict = s.verdict;
    S.testcase = s.testcase;
    S.passed = s.passed;
    S.total = s.total;
    S.runtimeError = s.runtimeError;
    if (s.code) S.code = s.code;
    if (s.lang) S.lang = s.lang;
    if (s.slug) S.slug = s.slug;
    if (s.submissionId) S.submissionId = s.submissionId;
    if (s.questionId && S.problem && !S.problem.id) S.problem.id = s.questionId;

    // 对话流里插一行 system 标记（PRD §8.3）——不重复贴代码
    const label = `──── 提交 #${S.codeHistory.length + 1} · ${s.verdict ?? "?"}${
      s.passed != null && s.total != null ? ` · ${s.passed}/${s.total}` : ""
    } ────`;
    appendMessage("system", label);

    updateAll();
    saveSession();
    diag("applied", {
      verdict: s.verdict,
      passed: s.passed,
      total: s.total,
      hasCase: !!s.testcase,
      history: S.codeHistory.length,
    });
    if (S.problem?.slug) {
      chrome.runtime
        .sendMessage({
          type: "recordSubmission",
          payload: {
            problem: S.problem,
            submissionId: s.submissionId,
            lang: s.lang,
            verdict: s.verdict,
            passed: s.passed,
            total: s.total,
          },
        })
        .catch(() => {});
    }
  }

  // ─────────── 会话暂存（chrome.storage.session = 纯内存，不落盘） ───────────
  //
  // 为什么需要：力扣某些操作会**整页重载**，content script 会重跑、内存状态全丢。
  // 用 storage.session 让对话挺过刷新，同时**不写磁盘**（符合 PRD FR-5：
  // 只沉淀结构化结论，不留对话历史）。浏览器关掉就没了。

  const SESSION_KEY = "blSession";

  async function saveSession() {
    if (!S.slug) return;
    try {
      await chrome.storage.session.set({
        [SESSION_KEY]: {
          slug: S.slug,
          at: Date.now(),
          problem: S.problem,
          messages: S.messages.slice(-40),
          code: S.code,
          lang: S.lang,
          verdict: S.verdict,
          testcase: S.testcase,
          run: S.run,
          lastAction: S.lastAction,
          passed: S.passed,
          total: S.total,
          runtimeError: S.runtimeError,
          codeHistory: S.codeHistory,
          submissionId: S.submissionId,
        },
      });
    } catch {
      /* storage.session 不可用就静默跳过 */
    }
  }

  async function restoreSession() {
    try {
      const st = await chrome.storage.session.get([SESSION_KEY]);
      const s = st && st[SESSION_KEY];
      if (!s || !s.slug) return false;
      // 只恢复同一道题的；且超过 6 小时就不要了
      const here = slugFromPath();
      if (here && s.slug !== here) return false;
      if (s.at && Date.now() - s.at > 6 * 3600_000) return false;

      S.slug = s.slug;
      S.problem = s.problem ?? null;
      S.messages = Array.isArray(s.messages) ? s.messages : [];
      S.code = s.code || S.code;
      S.lang = s.lang || S.lang;
      S.verdict = s.verdict ?? null;
      S.testcase = s.testcase ?? null;
      S.run = s.run ?? null;
      S.lastAction = s.lastAction ?? null;
      S.passed = s.passed ?? null;
      S.total = s.total ?? null;
      S.runtimeError = s.runtimeError ?? null;
      S.codeHistory = Array.isArray(s.codeHistory) ? s.codeHistory : [];
      S.submissionId = s.submissionId ?? null;
      renderMessages();
      return true;
    } catch {
      return false;
    }
  }

  /** 处理运行结果。和提交分开存 —— 运行不产生提交记录。 */
  function applyRun(r) {
    if (!r) return;
    S.running = false;
    S.run = r;
    S.lastAction = "run";
    updateAll();
    saveSession();
    diag("applied-run", {
      verdict: r.verdict,
      passed: r.passed,
      total: r.total,
      failedIndex: r.failedIndex,
    });
    // 运行不通知后端记提交 —— 它不是提交
  }

  function resetSession(newSlug) {
    diag("reset-session", { from: S.slug, to: newSlug ?? null, hadMsgs: S.messages.length });
    S.verdict = null;
    S.testcase = null;
    S.passed = null;
    S.total = null;
    S.runtimeError = null;
    S.judging = false;
    S.judgeFailed = false;
    S.running = false;
    S.run = null;
    S.lastAction = null;
    S.codeHistory = [];
    S.messages = [];
    S._sid = null;
    bodyEl.innerHTML = "";
    ball.querySelector(".dot")?.classList.remove("show");
    try {
      chrome.storage?.session?.remove(SESSION_KEY);
    } catch {}
  }

  function updateAll() {
    statusLine();
    renderChips();
  }

  // ───────────────────────── 启动 ─────────────────────────

  async function boot() {
    build();
    try {
      const st = await chrome.storage.local.get([
        "blCollapsed",
        "blModel",
        "blSide",
        "blPanelTop",
        "blPanelSize",
        "blBallTop",
        "blCollapseOnBlur",
      ]);
      if (st.blModel) S.model = st.blModel;
      if (st.blSide === "left" || st.blSide === "right") S.side = st.blSide;
      if (Number.isFinite(st.blPanelTop)) S.panelTop = st.blPanelTop;
      if (st.blPanelSize) S.panelSize = st.blPanelSize;
      if (Number.isFinite(st.blBallTop)) S.ballTop = st.blBallTop;
      S.collapseOnBlur = st.blCollapseOnBlur !== false; // 默认开
      applySide();
      applyPinUI();
      applyPanelLayout();
      applyBallLayout();
      setCollapsed(!!st.blCollapsed);
    } catch {}

    // 恢复上次的会话（题面/代码/判题结果/对话）。storage.session 是纯内存的，
    // 只为了挺过页面刷新，不落盘。
    const restored = await restoreSession();
    if (restored) {
      updateAll();
      say("system", "已恢复上次的对话");
    }
    // 汇报启动信息。navType 能告诉我们「页面是不是整页重载了」
    let navType = "?";
    try {
      const nav = performance.getEntriesByType("navigation")[0];
      navType = nav ? nav.type : "?";
    } catch {}
    diag("boot", {
      navType,
      restored,
      msgs: S.messages.length,
      hasProblem: !!S.problem,
      verdict: S.verdict ?? null,
      collapsed: S.collapsed,
    });

    // 后端探测
    async function ping() {
      try {
        const r = await chrome.runtime.sendMessage({ type: "health" });
        S.backendOk = !!r?.ok;
        syncModels(r);
      } catch {
        S.backendOk = false;
      }
      updateAll();
    }
    await ping();
    setInterval(ping, 15000);

    // 首次主动要一次题面 + 代码
    let tries = 0;
    const grab = async () => {
      handshake(); // 先握手拿 nonce，否则下面的请求会被拦截器丢掉
      await new Promise((r) => setTimeout(r, 120));
      requestProblem();
      await new Promise((r) => setTimeout(r, 250));
      const snap = await snapshotCode();
      if (snap?.code) {
        S.code = snap.code;
        if (snap.lang) S.lang = snap.lang;
      }
      updateAll();
      // 题面还没出来就重试（SPA 首屏慢 / nonce 还没学到）
      if (!S.problem && ++tries < 12) setTimeout(grab, 700);
    };
    handshake();
    setTimeout(grab, 400);

    // SPA 路由监听。
    //
    // ★ 坑（实测）：力扣切 tab（描述 / 提交记录 / 题解）**也会改 pathname**。
    //   按 pathname 判断会把「点提交后自动跳到提交记录 tab」误判成换题 → 清空对话。
    //   只有**题号变了**才算换题。
    let lastSlug = slugFromPath();
    const routeWatch = () => {
      const now = slugFromPath();
      if (now === lastSlug) return; // tab 切换，同一道题 → 什么都不做
      const from = lastSlug;
      lastSlug = now;
      diag("route-change", { from, to: now });
      if (!now) return;
      resetSession();
      S.problem = null;
      tries = 0;
      setTimeout(grab, 600);
    };
    for (const m of ["pushState", "replaceState"]) {
      const orig = history[m];
      history[m] = function () {
        const r = orig.apply(this, arguments);
        setTimeout(routeWatch, 0);
        return r;
      };
    }
    window.addEventListener("popstate", () => setTimeout(routeWatch, 0));
    // 兜底：力扣有时不通过 history API
    setInterval(routeWatch, 1000);

    // 代码变更监听（防抖 800ms，只写本地缓存，不发请求）
    let t = null;
    document.addEventListener(
      "input",
      () => {
        clearTimeout(t);
        t = setTimeout(async () => {
          const snap = await snapshotCode();
          if (snap?.code && snap.code !== S.code) {
            S.code = snap.code;
            if (snap.lang) S.lang = snap.lang;
            statusLine();
          }
        }, 800);
      },
      true
    );

    say("system", `就绪 · ${location.pathname.split("/")[2] || ""}`);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
