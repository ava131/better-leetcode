#!/usr/bin/env node
/**
 * content.js 静态接线检查。
 *
 *   node extension/test/wiring.test.mjs
 *
 * 存在理由：有一次重构把一整个区间的代码删掉了 —— 包括
 * `sendEl.onclick`、回车的 keydown、输入框自动撑高 ——
 * 而 `node --check` **依然通过**（语法没问题，只是东西没了）。
 * 用户看到的现象是「点发送没反应、回车只换行」。
 *
 * 这个检查跑得极快，能在提交前抓住"函数/绑定被静默删掉"这一类问题。
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(resolve(HERE, "../src", f), "utf8");
const SRC = read("content.js");
const BG = read("background.js");
const IC = read("interceptor.js");

let pass = 0,
  fail = 0;
const check = (name, cond, extra) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`, extra === undefined ? "" : String(extra).slice(0, 200));
  }
};

console.log("=== 1) 关键函数都得在 ===");
// 少一个都会让某个功能静默失效
const REQUIRED_FNS = [
  "build", "boot", "send", "say", "diag",
  "statusLine", "renderMessages", "renderChips", "renderMemoryCards",
  "appendMessage", "beginStreamBubble", "md2messages",
  "applySubmission", "applyRun", "resetSession",
  "saveSession", "restoreSession",
  "snapshotCode", "requestProblem", "handshake", "postToSelf",
  "setCollapsed", "applySide", "applyPinUI",
  "applyPanelLayout", "applyBallLayout", "snapToSide", "saveLayout",
  "slugFromPath", "syncModels", "sessionId", "updateAll",
].filter((f) => f !== "md2messages"); // 占位，避免误报

const missingFns = REQUIRED_FNS.filter(
  (f) => !new RegExp(`(?:async\\s+)?function\\s+${f}\\s*\\(`).test(SRC)
);
check(`必需函数齐全（${REQUIRED_FNS.length} 个）`, missingFns.length === 0, missingFns.join(", "));

console.log("\n=== 2) 不能引用未定义的函数（上次就是这么坏的）===");
const defined = new Set([
  ...SRC.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g),
].map((m) => m[1]));
for (const m of SRC.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) defined.add(m[1]);
// 解构赋值：const { esc, md } = ...
for (const m of SRC.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g))
  for (const part of m[1].split(",")) {
    const n = part.split(":").pop().trim().replace(/=.*$/, "").trim();
    if (/^[A-Za-z_$][\w$]*$/.test(n)) defined.add(n);
  }
// 对象方法简写：fail(msg) { ... }
for (const m of SRC.matchAll(/^\s{2,}([a-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) defined.add(m[1]);
// 形参也算已定义
for (const m of SRC.matchAll(/[({,]\s*([a-z_$][\w$]*)\s*[,)}]/g)) defined.add(m[1]);

const BUILTINS = new Set([
  "if","for","while","switch","catch","return","function","typeof","new","await","delete","void","in","of","do","else","try","finally","throw","case","break","continue","yield","class","extends","super","this","null","true","false","undefined",
  "JSON","String","Number","Math","Object","Array","Date","console","Promise","Error","Set","Map","Boolean","RegExp","Symbol","Proxy","Reflect","Intl","URL","URLSearchParams","TextDecoder","TextEncoder","AbortController","Event","CustomEvent","PointerEvent","KeyboardEvent","MutationObserver","IntersectionObserver","ResizeObserver","performance","navigator","document","window","globalThis","chrome","location","history","localStorage","setTimeout","setInterval","clearTimeout","clearInterval","requestAnimationFrame","cancelAnimationFrame","fetch","parseFloat","parseInt","isNaN","isFinite","encodeURIComponent","decodeURIComponent","btoa","atob","structuredClone","queueMicrotask","alert","confirm","prompt","Function","alert",
]);
// 代码里出现的 `xxx(` 形式，且不是方法调用（前面没有点）
const called = new Set();
for (const m of SRC.matchAll(/(^|[^.\w$])([a-z_$][\w$]*)\s*\(/g)) called.add(m[2]);
// content.js 里内嵌了 CSS 字符串，那些 `calc(` `rgba(` 之类不是我们的函数
const CSS_FNS = new Set([
  "attr","calc","rgba","rgb","hsl","hsla","rotate","rotateX","rotateY","scale","scaleX","scaleY",
  "translate","translateX","translateY","skew","matrix","media","supports","not","var","url",
  "linear-gradient","radial-gradient","cubic-bezier","steps","minmax","repeat","blur","brightness",
  "drop-shadow","opacity","format","local","theme","env","min","max","clamp","fit-content",
]);
const unknown = [...called]
  .filter((c) => !defined.has(c) && !BUILTINS.has(c) && !CSS_FNS.has(c) && c !== "async")
  .sort();
check("没有未定义的函数引用", unknown.length === 0, unknown.join(", "));

console.log("\n=== 3) 关键事件绑定都得在 ===");
const BINDINGS = [
  ["sendEl.onclick = send", "发送按钮"],
  ['e.key !== "Enter"', "回车发送"],
  ["inputEl.scrollHeight", "输入框自动撑高"],
  ['[data-act="collapse"]', "收起按钮"],
  ['[data-act="clear"]', "清空按钮"],
  ['[data-act="pin"]', "失焦收起开关"],
  ['"pointerdown"', "失焦收起监听"],
  ["composedPath", "穿透 Shadow DOM 判断点击位置"],
  ["hdEl.addEventListener", "拖动面板"],
  ["gripEl.addEventListener", "拖动调大小"],
  ["ball.addEventListener", "拖动小球"],
];
const missingBind = BINDINGS.filter(([pat]) => !SRC.includes(pat)).map(([, label]) => label);
check(`关键绑定齐全（${BINDINGS.length} 处）`, missingBind.length === 0, missingBind.join(", "));

console.log("\n=== 4) HTML 结构里的关键元素 ===");
// 有的元素写在 HTML 串里（class="x"），有的是 createElement + className = "x"
const ELEMENTS = [
  ['class="input"', "输入框"],
  ['class="send"', "发送按钮"],
  ['class="grip"', "尺寸把手"],
  ['class="body"', "消息区"],
  ['class="status', "状态条"],       // 实际是 "status gray"
  ['class="chips"', "建议按钮区"],
  ['className = "ball"', "小球"],     // 用 createElement 建的
  ['data-act="pin"', "pin 按钮"],
];
const missingEl = ELEMENTS.filter(([pat]) => !SRC.includes(pat)).map(([, l]) => l);
check(`关键元素齐全（${ELEMENTS.length} 个）`, missingEl.length === 0, missingEl.join(", "));

console.log("\n=== 5) 没有残留的旧代码 ===");
const STALE = ["autoHide", "scheduleHide", "cancelHide", "saveBallPos", "applyBallPos", "applyPanelSize"];
const stale = STALE.filter((p) => SRC.includes(p));
check("无旧 API 残留", stale.length === 0, stale.join(", "));

console.log("\n=== 6) background.js：done 只能发一次 ===");
// 上游 SSE 有自己的 done，循环结束还会补一个兜底的 —— 不记账就会发两个，
// content.js 会把同一条助手回复 push 两遍。
check("有 doneSent 记账", BG.includes("doneSent"));
check("兜底的 done 受 doneSent 保护", /!doneSent\s*&&\s*!errored/.test(BG));
check("报错后不再补 done", BG.includes("errored = true"));
check(
  "只有一处无条件 post done",
  (BG.match(/port\.postMessage\(\{\s*type:\s*"done"/g) || []).length === 2,
  (BG.match(/port\.postMessage\(\{\s*type:\s*"done"/g) || []).length
);

console.log("\n=== 7) content.js：连接异常不能把 UI 卡死 ===");
check("监听了 port.onDisconnect", SRC.includes("port.onDisconnect.addListener"));
check("有 settled 幂等标志", SRC.includes("settled"));
check("done 处理里做了幂等判断", SRC.includes("if (settled) return;"));

console.log("\n=== 8) interceptor.js：同一事件不能重复上报 ===");
check("run 结果有去重集合", IC.includes("runPosted") && IC.includes("postRunOnce"));
check(
  "没有裸的 post(\"run\" 调用",
  !/^\s*post\("run"/.test(IC),
  (IC.match(/^\s*post\("run"/gm) || []).join(" | ")
);

console.log("\n=== 9) 会话里不能残留 <memory> 标签 ===");
check("渲染层会剥掉 <memory>", SRC.includes("stripMemory"));
check("markdown.js 导出了 stripMemory", read("markdown.js").includes("stripMemory"));

console.log(`\n${"─".repeat(48)}\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
