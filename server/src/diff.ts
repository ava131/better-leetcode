/**
 * 行级 unified diff。**零依赖**，纯字符串运算。
 *
 * 存在理由（见 docs/TECH-DESIGN.md §4.5）：多轮对话里，代码是唯一每轮都在变、
 * 而且每轮都要重发的东西。发全文的话它永远落在"缓存必然 miss 的尾巴"上，
 * 全价付一次；发增量的话通常只有几十个字符。
 *
 * ★ 它**不消耗任何 token**：不调模型、不走网络，就是两串字符比一比。
 *   所以放后端算最合适 —— 扩展照旧发全文，传输协议一个字都不用改。
 *
 * 实现要点（都是为了"典型的改 3 行"这个场景快）：
 *  1. 先掐掉公共前缀和后缀 —— 一次改 3 行的话，中间剩下的只有几行，
 *     DP 表小到可以忽略；不做这步的话 500 行的文件要开 250k 个格子。
 *  2. 剩下的中段用 LCS 动态规划回溯。
 *  3. 中段太大（两边几乎完全无关）就退化成"整块替换" —— 这种结果一定比
 *     全文还长，上层会用比例保险自动退回发全文（见 code-version.ts）。
 */

export interface LineDiff {
  /** unified diff 文本。prev 与 next 相同时是空串 */
  text: string;
  added: number;
  removed: number;
  hunks: number;
  /** text.length / next.length，用来判断"发 diff 划不划算" */
  ratio: number;
}

/** 中段超过这个格子数就不做 LCS 了，直接整块替换（防止内存爆掉） */
const MAX_CELLS = 400_000;

function splitLines(s: string): string[] {
  if (s === "") return [];
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

type Op = { kind: "keep" | "del" | "ins"; line: string };

/** 中段太大时的兜底：全删 + 全加 */
function replaceAll(a: string[], b: string[]): Op[] {
  return [
    ...a.map((line): Op => ({ kind: "del", line })),
    ...b.map((line): Op => ({ kind: "ins", line })),
  ];
}

/** 对掐掉公共前后缀之后的中段做 LCS 回溯 */
function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length,
    m = b.length;
  if (!n) return b.map((line): Op => ({ kind: "ins", line }));
  if (!m) return a.map((line): Op => ({ kind: "del", line }));
  if ((n + 1) * (m + 1) > MAX_CELLS) return replaceAll(a, b);

  // dp[i][j] = a[i..] 与 b[j..] 的 LCS 长度
  const dp: Int32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: Op[] = [];
  let i = 0,
    j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "keep", line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: "del", line: a[i] });
      i++;
    } else {
      ops.push({ kind: "ins", line: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "del", line: a[i++] });
  while (j < m) ops.push({ kind: "ins", line: b[j++] });
  return ops;
}

/**
 * 生成 unified diff。
 *
 * `context` 是每个变更块上下保留的行数（跟 `git diff -U3` 一个意思）。
 * 上下文之外未改动的行**完全不出现** —— 这正是省 token 的地方。
 */
export function unifiedDiff(prev: string, next: string, opts: { context?: number } = {}): LineDiff {
  const context = Math.max(0, opts.context ?? 3);
  const A = splitLines(prev);
  const B = splitLines(next);

  let head = 0;
  while (head < A.length && head < B.length && A[head] === B[head]) head++;
  let tail = 0;
  while (
    tail < A.length - head &&
    tail < B.length - head &&
    A[A.length - 1 - tail] === B[B.length - 1 - tail]
  )
    tail++;

  const ops: Op[] = [
    ...A.slice(0, head).map((line): Op => ({ kind: "keep", line })),
    ...lcsOps(A.slice(head, A.length - tail), B.slice(head, B.length - tail)),
    ...A.slice(A.length - tail).map((line): Op => ({ kind: "keep", line })),
  ];

  // 把 ops 切成 hunk：变更点前后各留 context 行
  const changed: number[] = [];
  ops.forEach((o, idx) => {
    if (o.kind !== "keep") changed.push(idx);
  });

  const lines: string[] = [];
  let added = 0,
    removed = 0,
    hunks = 0;

  if (changed.length) {
    // 区间合并：两处改动离得近就合成一个 hunk
    const ranges: Array<[number, number]> = [];
    for (const c of changed) {
      const s = Math.max(0, c - context);
      const e = Math.min(ops.length - 1, c + context);
      const last = ranges[ranges.length - 1];
      if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
      else ranges.push([s, e]);
    }

    // 行号要按"这次改动之前的内容"推进，所以从 0 开始走一遍
    let aLine = 1,
      bLine = 1;
    let cursor = 0;
    for (const [s, e] of ranges) {
      while (cursor < s) {
        if (ops[cursor].kind !== "ins") aLine++;
        if (ops[cursor].kind !== "del") bLine++;
        cursor++;
      }
      const aStart = aLine,
        bStart = bLine;
      let aCount = 0,
        bCount = 0;
      const body: string[] = [];
      for (let k = s; k <= e; k++) {
        const o = ops[k];
        if (o.kind === "keep") {
          body.push(" " + o.line);
          aCount++;
          bCount++;
          aLine++;
          bLine++;
        } else if (o.kind === "del") {
          body.push("-" + o.line);
          aCount++;
          aLine++;
          removed++;
        } else {
          body.push("+" + o.line);
          bCount++;
          bLine++;
          added++;
        }
      }
      hunks++;
      lines.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`, ...body);
      cursor = e + 1;
    }
  }

  const text = lines.join("\n");
  return {
    text,
    added,
    removed,
    hunks,
    ratio: next.length ? text.length / next.length : 0,
  };
}
