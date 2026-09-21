#!/usr/bin/env node
/**
 * 界面接线回归测试。
 *
 * 存在理由：有一次重构把 `sendEl.onclick` / 回车的 keydown / 输入框自动撑高
 * **三处绑定一起删掉了**，而 `node --check` 依然通过 —— 表现就是
 * 「点发送没反应、回车只换行」。当时我只测了拖动吸附，没测最基本的发送。
 *
 * 这个脚本专门守住这些"最基本的交互"。
 *
 * ⚠️ 已知局限：测试环境里 content.js 会跑出**多个面板**（真实扩展一个 document
 *    只注入一次，所以只有一个）。多个实例的文档级监听器会互相干扰，
 *    导致"面板宽度"这类断言偶尔飘。所以：
 *      · 断言只关心"绑定还在不在、点了有没有反应"，不做像素级判断
 *      · 涉及具体面板的断言用"任一面板满足"的写法
 *    更可靠的覆盖在 `extension/test/*.test.mjs`（Node 里跑，确定性）。
 *
 *   node tools/probe/ui-wiring.mjs
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { open, sleep, EXT_SRC, CHROME_STUB } from "./cdp.mjs";

let pass = 0,
  fail = 0;
const check = (name, cond, extra) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`, extra === undefined ? "" : JSON.stringify(String(extra).slice(0, 120)));
  }
};

const cdp = await open();
await cdp.send("Runtime.enable");
await cdp.addInitScript(readFileSync(resolve(EXT_SRC, "interceptor.js"), "utf8"));
await cdp.addInitScript(CHROME_STUB, "bl_ext");
await cdp.addInitScript(readFileSync(resolve(EXT_SRC, "markdown.js"), "utf8"), "bl_ext");
await cdp.addInitScript(readFileSync(resolve(EXT_SRC, "content.js"), "utf8"), "bl_ext");
await cdp.navigate("https://leetcode.cn/problems/linked-list-cycle/");
await sleep(14000);
// ⚠️ 测试环境里 content.js 可能跑出**多个面板**，而且各自的后端连接状态可能不同
//    （真实扩展一个 document 只注入一次，所以只有一个）。
//    所以每次求值都现场挑一个"活着"的（状态条不是"后端未连接"）；
//    都活着就取最后一个 —— 它在最上面，鼠标点击命中的正是它。
const SRX = `(() => {
  const hosts = [...document.querySelectorAll('#better-leetcode-host')];
  const alive = hosts.filter((h) => {
    const t = h.shadowRoot?.querySelector('.status')?.textContent || '';
    return !t.includes('后端未连接');
  });
  return (alive.length ? alive : hosts).pop()?.shadowRoot || null;
})()`;
const SR = `(${SRX})`;

const setInput = (text) =>
  cdp.eval(`(() => {
    const sr = ${SR};
    if (!sr) return null;
    const i = sr.querySelector('.input');
    i.value = ${JSON.stringify(text)};
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.focus();
    return i.value;
  })()`);

const state = async () => {
  const raw = await cdp.eval(`(() => {
    const sr = ${SR};
    if (!sr) return JSON.stringify({ err: 'no panel' });
    return JSON.stringify({
      input: sr.querySelector('.input').value,
      users: [...sr.querySelectorAll('.msg.user')].map((m) => m.textContent),
      inputH: Math.round(sr.querySelector('.input').getBoundingClientRect().height),
      sendDisabled: sr.querySelector('.send').disabled,
      wrapW: Math.round(sr.querySelector('.wrap').getBoundingClientRect().width),
    });
  })()`);
  return typeof raw === "string" ? JSON.parse(raw) : raw;
};

const pressEnter = async (shift = false) => {
  for (const type of ["keyDown", "keyUp"]) {
    await cdp.send("Input.dispatchKeyEvent", {
      type,
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      modifiers: shift ? 8 : 0, // 8 = Shift
    });
  }
  await sleep(1200);
};

console.log("=== 1) 点发送按钮 ===");
await setInput("点按钮发的");
await cdp.eval(`${SR}.querySelector('.send').click()`);
await sleep(1400);
let s = await state();
check("发送出用户消息", s.users.includes("点按钮发的"), s.users);
check("输入框已清空", s.input === "", s.input);

console.log("\n=== 2) 回车发送 ===");
await setInput("回车发的");
await pressEnter(false);
s = await state();
check("回车能发送", s.users.includes("回车发的"), s.users);
check("输入框已清空", s.input === "", s.input);

console.log("\n=== 3) Shift+Enter 换行（不发送）===");
await setInput("第一行");
await pressEnter(true);
s = await state();
check("Shift+Enter 不发送", !s.users.some((u) => u.startsWith("第一行")), s.users);
check("输入框内容还在", s.input.startsWith("第一行"), s.input);

console.log("\n=== 4) 输入框随内容撑高 ===");
await setInput("短");
const h1 = (await state()).inputH;
await setInput("很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长");
await sleep(200);
const h2 = (await state()).inputH;
check("长文本把输入框撑高了", h2 > h1, `${h1} → ${h2}`);

console.log("\n=== 5) 把面板拉大之后，发送仍然可用（用户报的场景）===");
// 拖左下把手把面板拉大
const g = JSON.parse(await cdp.eval(`(() => {
  const r = ${SR}.querySelector('.grip').getBoundingClientRect();
  return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
})()`));
await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: g.x, y: g.y, button: "left", clickCount: 1 });
for (let i = 1; i <= 6; i++) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: g.x - i * 25, y: g.y + i * 30, button: "left" });
  await sleep(40);
}
await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: g.x - 150, y: g.y + 180, button: "left", clickCount: 1 });
await sleep(700);
s = await state();
const widened = s.wrapW;

await setInput("拉大之后发的");
await cdp.eval(`${SR}.querySelector('.send').click()`);
await sleep(1400);
s = await state();
// 多个面板时，点中的可能是另一个 —— 所以看"有没有任何一个变宽了"
const widest = await cdp.eval(`Math.max(0, ...[...document.querySelectorAll('#better-leetcode-host')]
  .map(h => h.shadowRoot?.querySelector('.wrap')?.getBoundingClientRect().width || 0))`);
check(`面板确实变大了（最宽 ${Math.round(widest)}px）`, widest > 400, widest);
check("拉大后点发送仍然有效", s.users.includes("拉大之后发的"), s.users);

console.log("\n=== 6) 拉大后回车也有效 ===");
await setInput("拉大后回车");
await pressEnter(false);
s = await state();
check("拉大后回车仍然有效", s.users.includes("拉大后回车"), s.users);

console.log("\n=== 7) 卡住时能停下来（后端连不上/不响应）===");
// 让 stub 不回复，模拟"后端没响应"
await cdp.evalInWorld("bl_ext", `window.__blStubHang = true; "ok"`);
await setInput("卡住测试");
await cdp.eval(`${SR}.querySelector('.send').click()`);
await sleep(1200);
let btn = await cdp.eval(`(()=>{const b=${SR}.querySelector('.send');
  return JSON.stringify({text:b.textContent, stop:b.classList.contains('stop'), disabled:b.disabled});})()`);
let bj = JSON.parse(btn);
check("发送中按钮变成「停止」", bj.text === "停止" && bj.stop === true, btn);
check("停止按钮可点（不是禁用状态）", bj.disabled === false, btn);
check("气泡先是「连接中…」而不是「思考中…」",
  await cdp.eval(`${SR}.querySelector('.thinking .tlabel')?.textContent === "连接中…"`),
  await cdp.eval(`${SR}.querySelector('.thinking .tlabel')?.textContent`));

// 点「停止」
await cdp.eval(`${SR}.querySelector('.send').click()`);
await sleep(600);
btn = await cdp.eval(`(()=>{const b=${SR}.querySelector('.send');
  return JSON.stringify({text:b.textContent, stop:b.classList.contains('stop')});})()`);
bj = JSON.parse(btn);
check("点停止后按钮变回「发送」", bj.text === "发送" && !bj.stop, btn);
check("显示了「已停止」",
  await cdp.eval(`(${SR}.textContent||'').includes("已停止")`),
  await cdp.eval(`${SR}.querySelector('.note')?.textContent`));

console.log("\n=== 8) 停止之后还能继续发（不会卡死）===");
await cdp.evalInWorld("bl_ext", `window.__blStubHang = false; "ok"`);
await setInput("停止后重发");
await pressEnter(false);
s = await state();
check("停止后能正常再发一条", s.users.includes("停止后重发"), s.users);

console.log(`\n${"─".repeat(48)}\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
