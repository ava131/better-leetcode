#!/usr/bin/env node
/**
 * 前缀缓存排布的回归测试。
 *   node server/test/prompt-order.ts
 *
 * 守的是这一次改动的**唯一目的**：让"上一轮发给模型的 prompt"成为
 * "这一轮 prompt"的**逐字节前缀**。满足这条，prefix 缓存才能把整段历史
 * 按 1 折计费；不满足，你每改一行代码就要按全价重算一遍历史。
 *
 * 反例对照也在里面（§5）：把老的排布照着拼一遍，断言这个测试**会红** ——
 * 不然我没法证明这个测试真的抓得住问题。
 */

import { buildMessages, filterHistory } from "../src/context.ts";
import { resetCodeMemory } from "../src/code-version.ts";
import { resetTurnMemory, userContents } from "../src/turn-memory.ts";
import { planPrompt } from "../src/prompt-plan.ts";
import type { ChatRequest } from "../src/types.ts";

let pass = 0,
  fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`, extra === undefined ? "" : JSON.stringify(String(extra).slice(0, 300)));
  }
};

const SYS = "（系统提示词占位）\n不要复述代码。";

/** 把消息数组拍平成一条字符串：前缀比较用 */
const flat = (msgs: Array<{ role: string; content: string }>) =>
  msgs.map((m) => `${m.role}\u0000${m.content}`).join("\u0001");

function makeReq(code: string, messages: ChatRequest["messages"]): ChatRequest {
  return {
    sessionId: "sess-1",
    problem: { id: 141, slug: "linked-list-cycle", title: "环形链表", difficulty: "Easy", tags: ["链表"], content: "给你一个链表的头节点 head…" },
    code,
    lang: "python3",
    verdict: null,
    messages,
  };
}

// ★ 用 40 行左右的代码：真实场景里"发增量划算"的门槛在这儿，
//   9 行的题解 diff 跟全文一样长（见 §8）。
const HEAD = [
  "from typing import Optional",
  "",
  "class ListNode:",
  "    def __init__(self, val=0, next=None):",
  "        self.val = val",
  "        self.next = next",
  "",
  "class Solution:",
  "    def hasCycle(self, head: Optional[ListNode]) -> bool:",
  "        # 快慢指针：快的每次两步，慢的一步",
  "        # 有环的话两者一定在环里相遇",
];
const BODY = Array.from({ length: 26 }, (_, i) => `        step_${i} = ${i}  # 占位，让文件有真实体量`);
const TAIL = ["        return False"];
const CODE1 = [...HEAD, ...BODY, ...TAIL].join("\n");

const CODE2 = CODE1.replace("step_13 = 13  # 占位，让文件有真实体量", "step_13 = 13  # 这一行改了");
const CODE3 = CODE2.replace("step_5 = 5  # 占位，让文件有真实体量", "step_5 = 5  # 又改一行");


console.log("=== 1) 上一轮的 prompt 必须是这一轮的真前缀（核心）===");
resetCodeMemory();
resetTurnMemory();

// 模拟客户端：历史只追加，不改写
let history: ChatRequest["messages"] = [{ role: "user", content: "这版哪里错了" }];
let flattens: string[] = [];
let plans: ReturnType<typeof planPrompt>[] = [];
const codes = [CODE1, CODE2, CODE3, CODE3, CODE1]; // 第 4 轮代码没变
const questions = ["这版哪里错了", "改了一下还是不行", "这次呢", "还是不对吧", "我又改回来了"];

for (let k = 0; k < codes.length; k++) {
  if (k > 0) {
    history = [...history, { role: "assistant", content: `（第 ${k} 轮回答，约 1350 字符……）` }, { role: "user", content: questions[k] }];
  }
  const req = makeReq(codes[k], history);
  const plan = planPrompt(req, SYS);
  const msgs = plan.build(SYS);
  flattens.push(flat(msgs));
  plans.push(plan);
  plan.commit(); // 上游收下了
}

for (let k = 1; k < flattens.length; k++) {
  const ok = flattens[k].startsWith(flattens[k - 1]);
  let where = "";
  if (!ok) {
    let i = 0;
    while (i < flattens[k - 1].length && flattens[k - 1][i] === flattens[k][i]) i++;
    where = `第 ${i} 个字符起分叉：旧=${JSON.stringify(flattens[k - 1].slice(i, i + 60))} 新=${JSON.stringify(flattens[k].slice(i, i + 60))}`;
  }
  check(`第 ${k} → ${k + 1} 轮：前缀逐字节一致`, ok, where);
}

console.log("\n=== 2) 模式选择：该省的省、该重发的重发 ===");
check("第 1 轮发全文（没有基准）", plans[0].render.mode === "full", plans[0].render.mode);
check("第 2 轮发增量", plans[1].render.mode === "diff", plans[1].render.mode);
check("第 4 轮代码没变 → 只发一行「没变」", plans[3].render.mode === "same", plans[3].render.mode);
check("第 5 轮又改了 → 增量", plans[4].render.mode === "diff", plans[4].render.mode);
check("增量确实比全文小得多", plans[1].render.stats.sentChars < plans[1].render.stats.fullChars / 2,
  `${plans[1].render.stats.sentChars} vs ${plans[1].render.stats.fullChars}`);

console.log("\n=== 3) 易变块必须在**最后**，题干和提示词在最前 ===");
{
  const req = makeReq(CODE3, history);
  const msgs = buildMessages(req, SYS, plans[4].render, plans[4].texts);
  const sys = msgs[0];
  check("system 是第一条", sys.role === "system");
  check("system 里没有易变块（<code>/<judge>/<context> 都不该有）",
    !sys.content.includes("<code") && !sys.content.includes("<judge") && !sys.content.includes("<context"),
    sys.content.slice(-200));
  check("system 里有题干（稳定块）", sys.content.includes("<problem"));
  const lastUser = [...msgs].reverse().find((m) => m.role === "user")!;
  check("最后一条 user 里才有 <context>", lastUser.content.startsWith("<context>"));
  const sysPerTurn = plans.map((p) => p.build(SYS)[0].content);
  check("每一轮的 system 完全相同", new Set(sysPerTurn).size === 1, new Set(sysPerTurn).size);
}

console.log("\n=== 4) 发增量时，基准那一版的全文必须还在 prompt 里 ===");
{
  const req = makeReq(CODE2, history.slice(0, 2));
  const plan = plans[1];
  const msgs = plan.build(SYS);
  const all = flat(msgs);
  check("这一轮发的是增量", plan.render.mode === "diff", plan.render.mode);
  check(`增量声明的基准是 rev ${plan.render.diffFrom}`, plan.render.diffFrom === 1, plan.render.diffFrom);
  check("prompt 里能找到 rev 1 的全文（否则模型只能猜）",
    all.includes(`<code rev="1"`) && all.includes("step_13 = 13  # 占位"));
  check("prompt 里也有本轮增量", all.includes(`diff_from="1"`));
}

console.log("\n=== 5) 链条断了必须退回全文（对照组：老排布会挂）===");
{
  resetTurnMemory(); // 模拟服务重启 / 清了对话
  const req = makeReq(CODE2, history.slice(0, 2));
  const plan = planPrompt(req, SYS);
  check("链条断了 → 判定 chainOk=false", plan.chainOk === false, plan.chainOk);
  check("链条断了 → 老实发全文", plan.render.mode === "full", plan.render.mode);
  check("原因里说清楚了", plan.render.reason.includes("链条断了"), plan.render.reason);
}

console.log("\n=== 6) 到点强制重发全文（防止模型把增量理解歪了）===");
{
  resetCodeMemory();
  resetTurnMemory();
  let hist2: ChatRequest["messages"] = [{ role: "user", content: "q1" }];
  let modes: string[] = [];
  for (let k = 0; k < 7; k++) {
    if (k > 0) hist2 = [...hist2, { role: "assistant", content: "a" + k }, { role: "user", content: "q" + (k + 1) }];
    const req = makeReq(CODE1 + `\n# rev ${k + 1}`, hist2);
    const plan = planPrompt(req, SYS);
    modes.push(plan.render.mode);
    plan.commit();
  }
  check("第 6 版是全文（其余是增量/没变）", modes[5] === "full", modes.join(","));
  check("只有第 1 和第 6 版是全文", modes.filter((m) => m === "full").length === 2, modes.join(","));
}

console.log("\n=== 7) 反例对照：老排布（易变块塞进 system）一定会破坏前缀 ===");
{
  // 照着 v0.7 的排布手工拼一遍
  const oldFlat = (code: string, hist: ChatRequest["messages"]) => {
    const volatile = `<context>\n<code lang="python3">\n${code}\n</code>\n</context>`;
    const msgs = [{ role: "system", content: `${SYS}\n\n${volatile}` }, ...hist];
    return flat(msgs);
  };
  let h: ChatRequest["messages"] = [{ role: "user", content: "这版哪里错了" }];
  const a = oldFlat(CODE1, h);
  h = [...h, { role: "assistant", content: "（回答）" }, { role: "user", content: "改了一下还是不行" }];
  const b = oldFlat(CODE2, h);
  check("老排布：前缀**不**一致（这就是为什么要改）", !b.startsWith(a),
    "如果这条断言挂了，说明测试没抓住重点");
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  const lost = a.length - i;
  console.log(`     · 老排布下，仅因为改了一行代码，就有 ${lost} 个字符（整段历史）从缓存前缀里掉出去`);
}

console.log("\n=== 8) 短代码不发增量（diff 比全文还长，发了是倒帮忙）===");
{
  resetCodeMemory();
  resetTurnMemory();
  const short1 = ["class Solution:", "    def f(self, x):", "        return x + 1"].join("\n");
  const short2 = short1.replace("return x + 1", "return x + 2");
  let h3: ChatRequest["messages"] = [{ role: "user", content: "q1" }];
  const p1 = planPrompt(makeReq(short1, h3), SYS);
  p1.commit();
  h3 = [...h3, { role: "assistant", content: "a" }, { role: "user", content: "q2" }];
  const p2 = planPrompt(makeReq(short2, h3), SYS);
  check("短代码第 2 轮仍然发全文", p2.render.mode === "full", p2.render.mode);
  check("原因写明了是「代码太短」", p2.render.reason.includes("太短") || p2.render.reason.includes("改动太大"), p2.render.reason);
}

console.log(`\n${"─".repeat(48)}\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
