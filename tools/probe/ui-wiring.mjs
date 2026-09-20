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

const SR = `document.getElementById('better-leetcode-host').shadowRoot`;

const setInput = (text) =>
  cdp.eval(`(() => {
    const i = ${SR}.querySelector('.input');
    i.value = ${JSON.stringify(text)};
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.focus();
    return i.value;
  })()`);

const state = async () => {
  const raw = await cdp.eval(`(() => {
    const sr = ${SR};
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
check(`面板确实变大了（${widened}px）`, widened > 400, widened);
check("拉大后点发送仍然有效", s.users.includes("拉大之后发的"), s.users);

console.log("\n=== 6) 拉大后回车也有效 ===");
await setInput("拉大后回车");
await pressEnter(false);
s = await state();
check("拉大后回车仍然有效", s.users.includes("拉大后回车"), s.users);

console.log(`\n${"─".repeat(48)}\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
