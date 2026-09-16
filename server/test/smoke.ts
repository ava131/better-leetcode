/**
 * 冒烟测试：不起 HTTP，直接验证核心模块。
 * 运行: MEMORY_DB=./.dev-memory.db node test/smoke.ts
 */
import { htmlToMarkdown } from "../src/html.ts";
import {
  upsertProblem,
  getMemory,
  confirmSuggestion,
  recordSubmission,
  getOverview,
  memoryStatus,
} from "../src/memory.ts";
import { stripMemoryBlocks } from "../src/llm.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`, extra ?? "");
  }
}

// 每次跑用唯一 slug，避免上一次的残留数据干扰（测试要幂等）
// 每次跑用唯一的 id + slug，测试要幂等。注意：**不能只换 slug 不换 id** ——
// 同 id 就是同一道题，记忆会跟着走（这是正确行为，但会让断言串味）。
const RUN = Date.now().toString(36);
const SLUG = "smoke-test-" + RUN;
const PID = 900000 + Math.floor(Math.random() * 99999);

// 基线必须在任何写入之前取（否则断言会被自己的写入污染）
const BASELINE = getOverview().stats;
console.log(`（本次测试用 slug: ${SLUG}）`);

console.log("=== 1) HTML → markdown ===");
const html = `<p>给你一个数组 <code>nums</code>，返回 <strong>两数之和</strong>。</p><ul><li>范围 <code>2 &lt;= nums.length &lt;= 10<sup>4</sup></code></li><li>只对应一个答案</li></ul><p>&nbsp;</p><pre>输入: nums = [2,7]</pre>`;
const md = htmlToMarkdown(html);
console.log(md.split("\n").map((l) => "    " + l).join("\n"));
check("去掉了所有标签", !/<[a-z][^>]*>/i.test(md));
check("实体已解码（&lt; → <）", md.includes("2 <= nums.length"));
check("上标已转（10^4）", md.includes("10^4"), md);
check("保留了代码块", md.includes("```"), md);
check("压缩比合理", md.length < html.length, `${md.length} vs ${html.length}`);

console.log("\n=== 2) 记忆：初始为空 ===");
upsertProblem({ id: PID, slug: SLUG, title: "141. 环形链表", difficulty: "Easy", tags: ["链表", "双指针"] });
check("新题记忆为 null", getMemory(SLUG) === null);

console.log("\n=== 3) 显式确认写入 ===");
const r1 = confirmSuggestion(SLUG, { kind: "stuck_point", desc: "slow/fast 的比较时机", insight: "初始化与首次比较的顺序错了" });
const r2 = confirmSuggestion(SLUG, { kind: "stuck_point", desc: "slow/fast 的比较时机", insight: "初始化与首次比较的顺序错了" });
const r3 = confirmSuggestion(SLUG, { kind: "approach", name: "快慢指针", time: "O(n)", space: "O(1)", mastered: true });
const r4 = confirmSuggestion(SLUG, { kind: "approach", name: "哈希表", time: "O(n)", space: "O(n)", mastered: false, note: "知道有，没写过" });
console.log("    " + [r1.message, r2.message, r3.message, r4.message].join(" | "));
check("首次写入成功", r1.ok);
check("重复写入不新增行，只累加次数", r2.ok && r2.message.includes("2"));
check("解法写入成功", r3.ok && r4.ok);

console.log("\n=== 4) 读回来（注入 prompt 的形状）===");
const mem = getMemory(SLUG);
console.log(JSON.stringify(mem, null, 2).split("\n").map((l) => "    " + l).join("\n"));
check("卡点 1 条且 count=2", mem?.stuckPoints.length === 1 && mem.stuckPoints[0].count === 2);
check("解法 2 条", mem?.approaches.length === 2);
check("mastered 正确转成 boolean", mem?.approaches.some((a) => a.mastered === true) === true);

console.log("\n=== 4.5) 回归：同 id 不同 slug（力扣改 slug）===");
let slugChanged = true;
try {
  upsertProblem({ id: PID, slug: SLUG + "-renamed", title: "141. 环形链表（新 slug）", difficulty: "Easy", tags: [] });
} catch (e) {
  slugChanged = false;
  console.log("    异常: " + (e as Error).message);
}
const afterRename = getMemory(SLUG + "-renamed");
check("改 slug 不崩", slugChanged);
check("改 slug 后记忆仍在（卡点没被级联删掉）", afterRename?.stuckPoints.length === 1, afterRename);
check("旧 slug 查不到了", getMemory(SLUG) === null);
upsertProblem({ id: PID, slug: SLUG, title: "141. 环形链表", difficulty: "Easy", tags: ["链表"] }); // 改回

console.log("\n=== 5) 跨题总览 ===");
recordSubmission(PID, 900000000 + Math.floor(Math.random() * 99999999), "python3", "Wrong Answer", 17, 29);
const ov = getOverview();
console.log(JSON.stringify(ov, null, 2).split("\n").map((l) => "    " + l).join("\n"));
check("题目数 +1", ov.stats.problems === BASELINE.problems + 1);
check("提交数 +1", ov.stats.submissions === BASELINE.submissions + 1);
const row = ov.mastery.find((m) => m.slug === SLUG);
check("掌握度矩阵 1/2", row?.approaches_mastered === 1 && row?.approaches_total === 2, row);

console.log("\n=== 6) <memory> 块剥离 ===");
const out = `你的比较放在移动之后了。\n\n<memory>{"kind":"stuck_point","desc":"比较时机","insight":"顺序"}</memory>`;
const r = stripMemoryBlocks(out);
console.log("    正文: " + JSON.stringify(r.text));
console.log("    建议: " + JSON.stringify(r.suggestions));
check("正文不含 <memory>", !r.text.includes("<memory>"));
check("建议被解析出来", r.suggestions.length === 1 && r.suggestions[0].kind === "stuck_point");

console.log("\n=== 7) 非法 <memory> 不崩 ===");
const bad = stripMemoryBlocks(`正文\n<memory>这不是 JSON</memory>`);
check("坏 JSON 被丢弃且正文保留", bad.suggestions.length === 0 && bad.text.includes("正文"));

console.log("\n=== 8) 记忆库状态 ===");
console.log("    " + JSON.stringify(memoryStatus()));

console.log(`\n${"─".repeat(50)}\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
