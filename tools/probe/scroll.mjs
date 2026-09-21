#!/usr/bin/env node
/**
 * 滚动跟随回归测试（真实 DOM，走用户点得到的东西）。
 *
 *   node tools/probe/scroll.mjs
 *
 * 守的是用户报的这个 bug：
 *   「他输出的时候，我还往上翻不了」
 * 原因是每收到一个 token 就无条件 `bodyEl.scrollTop = bodyEl.scrollHeight`，
 * 你刚往上滚一格就被拽回底部。修法是"贴底才跟随"，见 content.js 的 autoScroll。
 *
 * 这里**不碰内部函数**，全部用真实交互驱动：
 *   · 点 ⇤（钉住）按钮 → 内部 say() → appendMessage() → 一条真实消息
 *   点够多次把对话撑出滚动条，然后模拟"用户往上滚"看还会不会被拽走。
 *
 * 第二节更进一步：**真的发一条消息**（后端用 CHROME_STUB 的假流式回复，
 * 不花 API 额度、不碰你的账号），验证「发出去之后停在回答开头、不追尾部」。
 *
 * 需要先起一个带调试端口的 Chrome（见 cdp.mjs 顶部注释）。**不需要登录**，
 * 用全新 profile 即可 —— 这个测试不碰编辑器，只要有面板。
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
    console.log(`  ✗ ${name}`, extra === undefined ? "" : JSON.stringify(String(extra).slice(0, 200)));
  }
};

const cdp = await open();
// ★ 全程在**注入 content.js 的那个隔离 world** 里求值。
//   MAIN world 和隔离 world 的 window 是两份（TECH-DESIGN ★20），
//   在 MAIN 里 `window.__blScrollProbe` 拿不到 —— 会报 undefined。
//   这里只需要 DOM，不需要跨 world 通信，所以统一待在一个 world 里最省事。
const W = (expr) => cdp.evalInWorld("bl_ext", expr);

/** 页面里抛异常时 evalInWorld 返回 {__err}，直接 JSON.parse 只会看到 "[object Object]" */
const J = (raw, tag) => {
  if (raw === undefined || raw === null) {
    console.log(`  ! ${tag} 什么都没返回（${String(raw)}）—— 表达式可能没写 return`);
    return null;
  }
  if (typeof raw === "object" && raw.__err) {
    console.log(`  ! ${tag} 在页面里抛异常:`, raw.__err.slice(0, 300));
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.log(`  ! ${tag} 返回的不是 JSON:`, JSON.stringify(raw).slice(0, 300));
    return null;
  }
};
await cdp.send("Runtime.enable");
await cdp.addInitScript(readFileSync(resolve(EXT_SRC, "interceptor.js"), "utf8"));
await cdp.addInitScript(CHROME_STUB, "bl_ext");
await cdp.addInitScript(readFileSync(resolve(EXT_SRC, "markdown.js"), "utf8"), "bl_ext");
await cdp.addInitScript(readFileSync(resolve(EXT_SRC, "content.js"), "utf8"), "bl_ext");
await cdp.navigate("https://leetcode.cn/problems/linked-list-cycle/");
await sleep(6000);

// 测试环境里 content.js 可能跑出多个面板（真实扩展只注入一次）。
// 选定一个之后**全程只用它** —— 每次求值重新挑会挑到不同实例，结果自相矛盾。
const picked = await W(`(() => {
     const hosts = [...document.querySelectorAll('#better-leetcode-host')]
       .filter(h => h.shadowRoot && h.shadowRoot.querySelector('.wrap'));
     const h = hosts[hosts.length - 1];
     if (!h) return false;
     const sr = h.shadowRoot;
     sr.querySelector('.wrap')?.classList.remove('collapsed');
     window.__blScrollProbe = {
       body: sr.querySelector('.body'),
       jump: sr.querySelector('.jump'),
       pin:  sr.querySelector('[data-act="pin"]'),
     };
     return !!(window.__blScrollProbe.body && window.__blScrollProbe.jump && window.__blScrollProbe.pin);
   })()`
);
check("找到了面板（.body/.jump/⇤ 都在）", picked === true, picked);

if (picked !== true) {
  console.log(`\n${"─".repeat(48)}\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(1);
}

// ── 1) 点 ⇤ 撑出滚动条，验证"贴底时跟随" ──
const filled = await W(
  `(async () => {
     const p = window.__blScrollProbe;
     const frame = () => new Promise(r => requestAnimationFrame(() => r()));
     for (let i = 0; i < 40; i++) { p.pin.click(); await frame(); }
     await new Promise(r => setTimeout(r, 120));
     const b = p.body;
     return JSON.stringify({
       scrollTop: Math.round(b.scrollTop),
       scrollHeight: Math.round(b.scrollHeight),
       clientHeight: Math.round(b.clientHeight),
       msgs: b.querySelectorAll('.msg').length,
     });
   })()`
);
const F = J(filled, "filled");
console.log(`  · 对话高 ${F.scrollHeight}px / 视口 ${F.clientHeight}px，共 ${F.msgs} 条消息`);
check("对话被撑出滚动条（测试前提成立）", F.scrollHeight > F.clientHeight + 100, filled);
check("新消息进来时贴底跟随（autoScroll 生效）", F.scrollHeight - F.scrollTop - F.clientHeight <= 2, filled);

// ── 2) 用户往上滚 → 必须停住，并且浮出「回到底部」 ──
const scrolledUp = await W(
  `(async () => {
     const p = window.__blScrollProbe, b = p.body;
     b.scrollTop = 0;
     await new Promise(r => setTimeout(r, 120));
     return JSON.stringify({ scrollTop: Math.round(b.scrollTop), hidden: p.jump.hidden, label: p.jump.textContent });
   })()`
);
const U = J(scrolledUp, "scrolledUp");
check("往上滚之后浮出跳转按钮", U.hidden === false, scrolledUp);
check("按钮文案是「回到底部」（不在流式输出）", /回到底部/.test(U.label), U.label);
check("往上滚的位置没有被改写", U.scrollTop < 10, scrolledUp);

// ── 3) ★ 核心：用户在上面读的时候，新内容不能把他拽回底部 ──
const afterAppend = await W(
  `(async () => {
     const p = window.__blScrollProbe, b = p.body;
     p.pin.click();
     await new Promise(r => setTimeout(r, 150));
     return JSON.stringify({ scrollTop: Math.round(b.scrollTop), msgs: b.querySelectorAll('.msg').length });
   })()`
);
const A = J(afterAppend, "afterAppend");
check("新消息确实加进来了", A.msgs > F.msgs, afterAppend);
check("★ 新消息没有把用户拽回底部", A.scrollTop < 10, afterAppend);

// ── 4) 点「回到底部」→ 重新跟随 ──
const jumped = await W(
  `(async () => {
     const p = window.__blScrollProbe, b = p.body;
     p.jump.click();
     await new Promise(r => setTimeout(r, 120));
     const atBottom = b.scrollHeight - b.scrollTop - b.clientHeight <= 2;
     p.pin.click();                      // 再进一条，验证"重新跟随"真的恢复了
     await new Promise(r => setTimeout(r, 150));
     return JSON.stringify({
       afterJump: atBottom,
       hiddenAfterJump: p.jump.hidden,
       stillFollowing: b.scrollHeight - b.scrollTop - b.clientHeight <= 2,
     });
   })()`
);
const J2 = J(jumped, "jumped");
check("点按钮能跳回底部", J2.afterJump === true, jumped);
check("跳回去之后按钮自己收起来", J2.hiddenAfterJump === true, jumped);
check("跳回去之后恢复跟随（后续消息继续贴底）", J2.stillFollowing === true, jumped);

// ── 5) 阈值：差 20px 算贴底，差 300px 算离开 ──
const thresh = await W(
  `(async () => {
     const p = window.__blScrollProbe, b = p.body;
     const wait = () => new Promise(r => setTimeout(r, 100));
     b.scrollTop = b.scrollHeight - b.clientHeight - 20; await wait();
     const near = p.jump.hidden;
     b.scrollTop = b.scrollHeight - b.clientHeight - 300; await wait();
     const far = p.jump.hidden;
     return JSON.stringify({ nearSticks: near, farDetaches: far });
   })()`
);
const T = J(thresh, "thresh");
check("离底 20px 仍算贴底（不打扰）", T.nearSticks === true, thresh);
check("离底 300px 判定为离开（停止跟随）", T.farDetaches === false, thresh);

// ─────────────────────────────────────────────────────────────
// 第二节：真的发一条消息，验证"停在回答开头、不追尾部"
// ─────────────────────────────────────────────────────────────
console.log("\n=== 真的发一条（假流式回复，不花额度）===");

const sent = await W(`(async () => {
  window.__blStubLong = { n: 200, ms: 25 };      // 慢慢流 5 秒，够采样
  const p = window.__blScrollProbe;
  const sr = p.body.getRootNode();
  const input = sr.querySelector("textarea, input[type=text]");
  const btn = sr.querySelector(".send");
  if (!input || !btn) return JSON.stringify({ err: "没有输入框或发送按钮" });
  window.__blBefore = p.body.querySelectorAll(".msg.assistant").length;
  input.value = "这题我卡在 cur.next 上了，帮我看看";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  btn.click();
  return JSON.stringify({ ok: true });
})()`);
check("能发出消息（stub 后端）", J(sent, "sent").ok === true, sent);

// 流式进行中采样：回答开头的位置 + scrollTop 有没有被改写
const sample = await W(`(async () => {
  const p = window.__blScrollProbe, body = p.body;
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  // send() 前面有个 snapshotCode()（拿不到编辑器时 300ms 超时），所以要等气泡出现
  let last = null;
  for (let i = 0; i < 80 && !last; i++) {
    await wait(100);
    const bs = body.querySelectorAll(".msg.assistant");
    if (bs.length > (window.__blBefore ?? 0)) last = bs[bs.length - 1];
  }
  if (!last) return JSON.stringify({ err: "助手气泡一直没出现" });
  await wait(150);
  const bodyTop = body.getBoundingClientRect().top;
  const users = body.querySelectorAll(".msg.user");
  const lastUser = users[users.length - 1];
  const s1 = { scrollTop: Math.round(body.scrollTop),
               bubbleTop: Math.round(last.getBoundingClientRect().top - bodyTop),
               bubbleH: Math.round(last.offsetHeight),
               userTop: Math.round(lastUser.getBoundingClientRect().top - bodyTop),
               viewH: Math.round(body.clientHeight) };
  await wait(500);
  const s2 = { scrollTop: Math.round(body.scrollTop), bubbleH: Math.round(last.offsetHeight) };
  await wait(500);
  const s3 = { scrollTop: Math.round(body.scrollTop), bubbleH: Math.round(last.offsetHeight) };
  return JSON.stringify({ s1, s2, s3, jumpHidden: p.jump.hidden, jumpLabel: p.jump.textContent });
})()`);
const S = J(sample, "sample");
if (!S) {
  check("采样成功", false, "页面没返回结果");
  console.log(`\n${"─".repeat(48)}\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(1);
}
console.log(`  · 回答开头在视口内 ${S.s1.bubbleTop}px 处；高度 ${S.s1.bubbleH} → ${S.s3.bubbleH}px`);
check("回答确实在流式增长（前提成立）", S.s3.bubbleH > S.s1.bubbleH + 100, sample);
// 这里**不能**要求"回答开头贴在视口最上面"：回答在内容末尾，而视口不能滚过
// 内容末尾 —— 所以开头只能停在视口偏下的位置，这是几何决定的，不是 bug。
// 真正要保证的是：①开头看得见 ②我自己的问题还在屏幕上 ③它全程不动。
check(
  "★ 回答的开头就在视口里（能看见第一行）",
  S.s1.bubbleTop >= 0 && S.s1.bubbleTop <= S.s1.viewH - 20,
  sample
);
check(
  "★ 我问的那句话还在屏幕上（窗口停在我问问题的地方）",
  S.s1.userTop >= 0 && S.s1.userTop < S.s1.viewH,
  sample
);
check(
  "★ 流式过程中不追尾部（scrollTop 全程不动）",
  Math.abs(S.s2.scrollTop - S.s1.scrollTop) <= 2 && Math.abs(S.s3.scrollTop - S.s1.scrollTop) <= 2,
  JSON.stringify([S.s1.scrollTop, S.s2.scrollTop, S.s3.scrollTop])
);
check("流式中就浮出跳转按钮", S.jumpHidden === false, sample);
check("流式中文案是「↓ 新内容」", /新内容/.test(S.jumpLabel), S.jumpLabel);

// ★ 真滚轮（CDP 真输入事件）—— 证明"用户的滚动"没被 selfScrollTop 一起误杀
{
  const box = await W(`(() => {
    const r = window.__blScrollProbe.body.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
  })()`);
  const b = J(box, "box");
  if (!b) {
    check("拿到对话区坐标", false, box);
  } else {
    const before = await W(`Math.round(window.__blScrollProbe.body.scrollTop)`);
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel", x: b.x, y: b.y, deltaX: 0, deltaY: -400,
    });
    await new Promise((r) => setTimeout(r, 400));
    const after = await W(`(async () => {
      const p = window.__blScrollProbe, body = p.body;
      const h1 = body.scrollHeight;
      await new Promise(r => setTimeout(r, 400));      // 期间还在流式
      return JSON.stringify({
        scrollTop: Math.round(body.scrollTop),
        h1, h2: body.scrollHeight,
        hidden: p.jump.hidden,
        label: p.jump.textContent,
      });
    })()`);
    const A2 = J(after, "after");
    if (!A2) {
      check("滚轮之后读到状态", false, after);
    } else {
      check("★ 真滚轮能停住（用户意图被认出来）", A2.scrollTop < before - 100, JSON.stringify({ before, after: A2.scrollTop }));
      check("滚上去之后还在流式（前提成立）", A2.h2 > A2.h1, after);
      check("滚上去之后新内容不把他拽回去", A2.hidden === false && A2.scrollTop < before - 100, after);
    }
  }
}

// 点「↓ 新内容」→ 跟到尾部，并且恢复跟随（后续内容继续贴底）
const follow = await W(`(async () => {
  const p = window.__blScrollProbe, body = p.body;
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  p.jump.click();
  await wait(300);
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight <= 2;
  const h1 = body.scrollHeight;
  await wait(500);
  const h2 = body.scrollHeight;
  return JSON.stringify({
    atBottom,
    grew: h2 > h1,
    stillAtBottom: body.scrollHeight - body.scrollTop - body.clientHeight <= 2,
  });
})()`);
const FO = J(follow, "follow");
check("点「↓ 新内容」跳到最新", FO.atBottom === true, follow);
check("这时候还在流式（前提成立）", FO.grew === true, follow);
check("跳过去之后恢复跟随，新内容继续贴底", FO.stillAtBottom === true, follow);

// 等这轮结束 → 按钮文案回到「回到底部」
const afterDone = await W(`(async () => {
  const p = window.__blScrollProbe, body = p.body;
  const sr = body.getRootNode();
  const btn = sr.querySelector(".send");
  // 等这轮真的收尾（按钮从"停止"变回"发送"），别跟固定的 sleep 赌
  for (let i = 0; i < 120 && btn && btn.textContent !== "发送"; i++) {
    await new Promise(r => setTimeout(r, 100));
  }
  body.scrollTop = 0;                       // 滚上去，看停止输出后的文案
  await new Promise(r => setTimeout(r, 150));
  return JSON.stringify({ label: p.jump.textContent, hidden: p.jump.hidden, mode: btn ? btn.textContent : null });
})()`);
const AD = J(afterDone, "afterDone");
check("输出结束后文案变回「回到底部」", /回到底部/.test(AD.label), AD);

console.log(`\n${"─".repeat(48)}\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
