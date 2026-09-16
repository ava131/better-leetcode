#!/usr/bin/env node
/**
 * 端到端验证：**保真的 world 结构** + 真实点击提交按钮。
 *
 * 为什么要"保真"：拦截器在 MAIN world，扩展代码在 ISOLATED world，
 * 两者 JS 作用域隔离。如果把两个脚本注进同一个 world，就会掩盖跨 world 的 bug
 * （我们真的踩过 —— 见 docs/TECH-DESIGN.md ★20）。
 *
 *   node tools/probe/e2e.mjs [题目slug]
 *
 * ⚠️ 会真的往你的账号提交一次代码。默认用正确解（AC），尽量不污染。
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { open, sleep, EXT_SRC, CHROME_STUB, READ_SIDEBAR } from "./cdp.mjs";

const slug = process.argv[2] ?? "linked-list-cycle";

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

// 拦截器 → MAIN world
await cdp.addInitScript(readFileSync(resolve(EXT_SRC, "interceptor.js"), "utf8"));
// 扩展代码 → 独立 ISOLATED world
await cdp.addInitScript(CHROME_STUB, "bl_ext");
await cdp.addInitScript(readFileSync(resolve(EXT_SRC, "content.js"), "utf8"), "bl_ext");

console.log(`打开 https://leetcode.cn/problems/${slug}/ …`);
await cdp.navigate(`https://leetcode.cn/problems/${slug}/`);
await sleep(10000);

const state = async (label) => {
  console.log(`  ${label.padEnd(20)} ${await cdp.eval(READ_SIDEBAR)}`);
};

console.log("\n=== 提交前 ===");
await state("就绪态");

console.log("\n=== 写入正确解 → 真实点击提交按钮 ===");
await cdp.eval(`(() => {
  const m = window.monaco;
  if (!m || !m.editor) return 'no monaco';
  const ed = m.editor.getEditors()[0];
  if (!ed) return 'no editor';
  ed.getModel().setValue(${JSON.stringify(CORRECT)});
  return 'ok';
})()`);

const clicked = await cdp.eval(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /^提交$/.test(x.textContent.trim()));
  if (!b) return '找不到提交按钮';
  b.click();
  return 'clicked';
})()`);
console.log("  " + clicked);

for (const t of [1000, 3000, 6000]) {
  await sleep(t === 1000 ? 1000 : 2000);
  await state(`+${t}ms`);
}

console.log("\n=== 换 tab（不应清空会话）===");
await cdp.eval(`history.pushState({}, '', '/problems/${slug}/submissions/')`);
await sleep(2500);
await state("push submissions");

console.log("\n（提交记录里会多一条，自己看着删）");
process.exit(0);
