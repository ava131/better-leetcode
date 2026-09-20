#!/usr/bin/env node
/**
 * 端到端回归：**保真的 world 结构**下，跑完整交互链路。
 *
 * 为什么必须"保真"：拦截器在 MAIN world，扩展代码在 ISOLATED world，
 * 两者 JS 作用域隔离。把两个脚本注进同一个 world 会让一切看起来正常，
 * 而真实扩展里它们根本通信不上 —— 我们真的踩过（docs/TECH-DESIGN.md ★20）。
 *
 *   node tools/probe/e2e.mjs [题目slug] [--run-only|--submit-only]
 *
 * ⚠️ 提交会真的往你的账号写一条记录（运行不会）。
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { open, sleep, EXT_SRC, CHROME_STUB, READ_SIDEBAR } from "./cdp.mjs";

const slug = process.argv[2] ?? "linked-list-cycle";
const runOnly = process.argv.includes("--run-only");
const submitOnly = process.argv.includes("--submit-only");

/** 这份解故意有 bug：示例用例全过，但提交会 WA —— 正是要覆盖的场景 */
const BUGGY = `class Solution:
    def hasCycle(self, head):
        if not head:
            return False
        slow, fast = head, head
        while fast.next and fast.next.next:
            if fast == slow:
                return True
            slow = slow.next
            fast = fast.next.next
        return False`;

const CORRECT = `class Solution:
    def hasCycle(self, head):
        if not head:
            return False
        slow, fast = head, head
        while fast and fast.next:
            slow = slow.next
            fast = fast.next.next
            if slow == fast:
                return True
        return False`;

const cdp = await open();
await cdp.addInitScript(readFileSync(resolve(EXT_SRC, "interceptor.js"), "utf8"));
await cdp.addInitScript(CHROME_STUB, "bl_ext");
await cdp.addInitScript(readFileSync(resolve(EXT_SRC, "content.js"), "utf8"), "bl_ext");

const setCode = (code) =>
  cdp.eval(`(() => {
    const m = window.monaco;
    if (!m || !m.editor) return 'no monaco';
    const ed = m.editor.getEditors()[0];
    if (!ed) return 'no editor';
    ed.getModel().setValue(${JSON.stringify(code)});
    return 'ok';
  })()`);

const click = (sel, text) =>
  cdp.eval(`(() => {
    const b = document.querySelector(${JSON.stringify(sel)})
      || [...document.querySelectorAll('button')].find(x => ${JSON.stringify(text)}.test(x.textContent.trim()));
    if (!b) return '找不到按钮';
    b.click(); return 'clicked';
  })()`);

const show = async (label) => console.log(`  ${label.padEnd(18)} ${await cdp.eval(READ_SIDEBAR)}`);

console.log(`打开 https://leetcode.cn/problems/${slug}/ …`);
await cdp.navigate(`https://leetcode.cn/problems/${slug}/`);
await sleep(10000);

await show("初始");

if (!submitOnly) {
  console.log("\n──────── 运行（示例用例，不写提交记录）────────");
  console.log("  写入有 bug 的解（示例用例会全过）: " + (await setCode(BUGGY)));
  console.log("  点运行: " + (await click('[data-e2e-locator="console-run-button"]', "/^运行$/")));
  for (const t of [1000, 2500, 5000]) {
    await sleep(t === 1000 ? 1000 : t === 2500 ? 1500 : 2500);
    await show(`+${t}ms`);
  }
}

if (!runOnly) {
  console.log("\n──────── 提交（写一条记录）────────");
  console.log("  写入正确解: " + (await setCode(CORRECT)));
  console.log("  点提交: " + (await click('[data-e2e-locator="console-submit-button"]', "/^提交$/")));
  for (const t of [1000, 3000, 6000]) {
    await sleep(t === 1000 ? 1000 : 2000);
    await show(`+${t}ms`);
  }
}

console.log("\n──────── 换 tab（不应清空会话）────────");
await cdp.eval(`history.pushState({}, '', '/problems/${slug}/submissions/')`);
await sleep(2500);
await show("push submissions");

console.log("\n判定标准：运行 → 状态条变绿且写「运行结果已就绪」；");
console.log("          提交 → 变绿且写「上下文已就绪」+ 对话流里有提交标记；");
console.log("          换 tab → 会话保留。");
process.exit(0);
