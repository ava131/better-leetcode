#!/usr/bin/env node
/**
 * 行级 diff 单测。
 *   node server/test/diff.ts
 *
 * 最强的断言是**往返**：把 diff 应用回 prev，必须逐字节等于 next。
 * 只检查"diff 里包含 -x +y"是抓不到行号/上下文算错的。
 */

import { unifiedDiff } from "../src/diff.ts";

let pass = 0,
  fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`, extra === undefined ? "" : JSON.stringify(String(extra).slice(0, 200)));
  }
};

/**
 * 一个最小 unified diff 应用器（只在测试里用）。
 * 它能跑通，就说明 diff 的行号和上下文是对的。
 */
function applyUnified(prev: string, diff: string): string {
  if (!diff.trim()) return prev;
  // ★ 跟 diff.ts 保持同一个空串约定："" 是 0 行，不是「一个空行」
  const norm = prev.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const src = norm === "" ? [] : norm.split("\n");
  const out: string[] = [];
  let pos = 0; // src 里下一个待消费的行下标
  const lines = diff.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("@@")) {
      const m = l.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/);
      if (!m) throw new Error("hunk 头解析不了: " + l);
      const aStart = Number(m[1]);
      // 把 hunk 之前的原文原样抄过去
      while (pos < aStart - 1) out.push(src[pos++]);
      continue;
    }
    const tag = l[0];
    const body = l.slice(1);
    if (tag === " ") {
      if (src[pos] !== body) throw new Error(`上下文对不上：期望 ${JSON.stringify(src[pos])} 实际 ${JSON.stringify(body)}`);
      out.push(body);
      pos++;
    } else if (tag === "-") {
      if (src[pos] !== body) throw new Error(`待删行对不上：期望 ${JSON.stringify(src[pos])} 实际 ${JSON.stringify(body)}`);
      pos++;
    } else if (tag === "+") {
      out.push(body);
    } else if (l === "") {
      // 尾部空行（diff 以 \n 结尾时会产生），忽略
    } else {
      throw new Error("看不懂的行: " + JSON.stringify(l));
    }
  }
  while (pos < src.length) out.push(src[pos++]);
  return out.join("\n");
}

const roundTrip = (name: string, prev: string, next: string) => {
  const d = unifiedDiff(prev, next);
  let got: string | null = null;
  let err = "";
  try {
    got = applyUnified(prev, d.text);
  } catch (e) {
    err = (e as Error).message;
  }
  check(`${name}：往返一致`, got === next, err || `还原结果 ${JSON.stringify(got?.slice(0, 120))}`);
  return d;
};

console.log("=== 1) 往返：各种改法都能还原 ===");
const A15 = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join("\n");
roundTrip("完全相同", A15, A15);
roundTrip("改一行（中间）", A15, A15.replace("line 8", "line 8 changed"));
roundTrip("改一行（开头）", A15, A15.replace("line 1", "first!"));
roundTrip("改一行（结尾）", A15, A15.replace("line 15", "last!"));
roundTrip("删一行", A15, A15.replace("line 5\n", ""));
roundTrip("插一行", A15, A15.replace("line 5", "line 5\nbrand new"));
roundTrip("加一行到末尾", A15, A15 + "\nappended");
roundTrip("加一行到开头", A15, "prepended\n" + A15);
roundTrip("整段重写", A15, Array.from({ length: 15 }, (_, i) => `other ${i}`).join("\n"));
roundTrip("清空", A15, "");
roundTrip("从空开始", "", A15);
roundTrip("连续多处改动", A15, A15.replace("line 2", "L2").replace("line 9", "L9"));
// 行尾统一成 \n：一来省掉不可见的 \r token，二来让"全文模式"和"diff 模式"
// 看到的是同一份文本（否则 diff 里的上下文行会跟全文模式差一个 \r）
{
  const d = unifiedDiff("a\r\nb\r\nc", "a\r\nB\r\nc");
  check("CRLF 被规范化成 LF", !d.text.includes("\r"), JSON.stringify(d.text));
  check("CRLF 规范化后往返一致", applyUnified("a\nb\nc", d.text) === "a\nB\nc");
}
roundTrip("缩进变化（Python 常见）", "if x:\n    return 1\nelse:\n    return 2", "if x:\n    return 1\nreturn 2");

console.log("\n=== 2) 省不省：只保留上下文 ===");
{
  const big = Array.from({ length: 200 }, (_, i) => `    do_something(${i});`).join("\n");
  const small = big.replace("    do_something(100);", "    do_something(100)  # 改了");
  const d = unifiedDiff(big, small);
  check("diff 比全文小得多（<15%）", d.ratio < 0.15, `ratio=${d.ratio.toFixed(3)}`);
  check("只有 1 个 hunk", d.hunks === 1, d.hunks);
  check("统计：加 1 行删 1 行", d.added === 1 && d.removed === 1, `${d.added}/${d.removed}`);
  check("远处没改的行不出现", !d.text.includes("do_something(20);"), d.text.slice(0, 200));
  const far = d.text.split("\n").filter((l) => l.startsWith(" "));
  check("上下文就是 3+3 行", far.length === 6, far.length);
}

console.log("\n=== 3) 该退回发全文的时候，比例要够大 ===");
{
  const big = Array.from({ length: 100 }, (_, i) => `l${i}`).join("\n");
  const allNew = Array.from({ length: 100 }, (_, i) => `x${i}`).join("\n");
  const d = unifiedDiff(big, allNew);
  check("整块重写的 ratio > 1（上层据此退回全文）", d.ratio > 1, `ratio=${d.ratio.toFixed(2)}`);
  check("整块重写仍然往返一致", applyUnified(big, d.text) === allNew);
}

console.log("\n=== 4) 大文件不会爆（走整块替换兜底）===");
{
  const big1 = Array.from({ length: 1200 }, (_, i) => `a${i}`).join("\n");
  const big2 = Array.from({ length: 1200 }, (_, i) => `b${i}`).join("\n");
  const t0 = Date.now();
  const d = unifiedDiff(big1, big2);
  const ms = Date.now() - t0;
  check("1200 行全改也能算出来（<1s）", ms < 1000, `${ms}ms`);
  check("兜底结果往返一致", applyUnified(big1, d.text) === big2);
  check("兜底时 ratio 很大，会被上层判成「发全文」", d.ratio > 1, d.ratio.toFixed(2));
}

console.log("\n=== 5) 行号与 hunk 头 ===");
{
  const prev = "a\nb\nc\nd\ne\nf\ng\nh";
  const next = "a\nb\nc\nD\ne\nf\ng\nh";
  const d = unifiedDiff(prev, next, { context: 1 });
  const head = d.text.split("\n")[0];
  check("hunk 头形如 @@ -3,3 +3,3 @@", /^@@ -\d+,\d+ \+\d+,\d+ @@$/.test(head), head);
  check("context=1 时只有 1 行上文", d.text.split("\n").filter((l) => l.startsWith(" ")).length === 2, d.text);
}

console.log(`\n${"─".repeat(48)}\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
