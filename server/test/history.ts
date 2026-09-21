#!/usr/bin/env node
/**
 * 对话历史层单测。
 *   MEMORY_DB=./.dev-memory.db node test/history.ts
 */
import {
  dbStatus,
  upsertProblem,
  ensureSession,
  appendMessage,
  snapshotOf,
  listSessions,
  getSessionMessages,
  searchMessages,
  historyStats,
  recordSubmission,
} from "../src/history.ts";

let pass = 0,
  fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`, extra === undefined ? "" : JSON.stringify(String(extra).slice(0, 160)));
  }
};

const RUN = Date.now().toString(36);
const SLUG = `hist-${RUN}`;
const PID = 700000 + Math.floor(Math.random() * 99999);
const S1 = `sess-1-${RUN}`;
const S2 = `sess-2-${RUN}`;

console.log("（本次 slug: " + SLUG + "）");
check("数据库可用", dbStatus().ok);

console.log("\n=== 1) 建会话 + 追加消息 ===");
upsertProblem({ id: PID, slug: SLUG, title: "测试题", difficulty: "Medium", tags: ["双指针", "数组"] });
ensureSession(S1, { id: PID, slug: SLUG, title: "测试题" }, "我这段二分查找过不了");
check("追加用户消息", appendMessage({ sessionId: S1, problemId: PID, role: "user", content: "我这段二分查找过不了" }));
check("追加上一条消息", appendMessage({ sessionId: S1, problemId: PID, role: "assistant", content: "你的 left 更新在 left == right 时会死循环" }));
check("追加带标记", appendMessage({ sessionId: S1, problemId: PID, role: "marker", content: "──── 提交 #1 · Wrong Answer ────" }));

const msgs = getSessionMessages(S1);
check("读回来 3 条", msgs.length === 3, msgs.length);
check("顺序正确", msgs[0].role === "user" && msgs[2].role === "marker", msgs.map((m) => m.role).join(","));

console.log("\n=== 2) 上下文快照去重（不重复存同一份代码）===");
ensureSession(S2, { id: PID, slug: SLUG, title: "测试题" }, "第一次问");
const snapA = snapshotOf({ code: "x=1", verdict: "Wrong Answer", testcase: { input: "1", output: "2", expected: "3" } });
const snapB = snapshotOf({ code: "x=2", verdict: "Wrong Answer", testcase: null });
appendMessage({ sessionId: S2, problemId: PID, role: "user", content: "第一次问", snapshot: snapA });
appendMessage({ sessionId: S2, problemId: PID, role: "assistant", content: "答一" });
appendMessage({ sessionId: S2, problemId: PID, role: "user", content: "代码没改再问", snapshot: snapA });
appendMessage({ sessionId: S2, problemId: PID, role: "user", content: "改了代码再问", snapshot: snapB });
const s2 = getSessionMessages(S2);
const withSnap = s2.filter((m) => m.snapshot);
check("只有 2 条带快照（重复的没写）", withSnap.length === 2, withSnap.length);
check("快照内容对得上", withSnap[0].snapshot === snapA && withSnap[1].snapshot === snapB);

console.log("\n=== 2.5) 安全网：会话不存在时也能落库（不静默丢消息）===");
const GHOST = `ghost-${RUN}`;
check("没建会话也能写入", appendMessage({ sessionId: GHOST, problemId: PID, slug: SLUG, role: "user", content: "幽灵会话" }));
check("幽灵会话挂到了正确的 slug 下", listSessions(SLUG).some((x) => x.id === GHOST), listSessions(SLUG).map((x) => x.id).join(","));
check("没给 slug 时挂到 unknown（不崩）", appendMessage({ sessionId: `n-${RUN}`, problemId: PID, role: "user", content: "无题" }));

console.log("\n=== 3) 会话列表 ===");
const list = listSessions(SLUG);
check("列出 3 个会话（S1/S2/幽灵）", list.length === 3, list.length);
check("最近活跃的在前（幽灵最后写的）", list[0].id === GHOST, list.map((s) => s.id).join(","));
check("带消息条数", list.find((s) => s.id === S1)?.msg_count === 3, JSON.stringify(list));
check("标题是首条用户消息", list.find((s) => s.id === S1)?.title === "我这段二分查找过不了");

console.log("\n=== 4) 全文检索（中文是重点）===");
appendMessage({ sessionId: S1, problemId: PID, role: "assistant", content: "注意闭区间的边界处理：left 应该取 mid 加一" });
appendMessage({ sessionId: S1, problemId: PID, role: "assistant", content: "单调栈适合处理下一个更大元素" });

for (const q of ["边界", "闭区间", "单调栈", "left", "死循环"]) {
  const r = searchMessages(SLUG, q);
  console.log(`    搜「${q}」→ ${r.length} 条${r[0] ? "：" + r[0].content.slice(0, 26) : ""}`);
}
check("能搜到中文词「边界」", searchMessages(SLUG, "边界").length > 0);
check("能搜到「闭区间」", searchMessages(SLUG, "闭区间").length > 0);
check("能搜到英文 left", searchMessages(SLUG, "left").length > 0);
check("搜不到的词返回空", searchMessages(SLUG, "量子力学").length === 0);

console.log("\n=== 5) 检索不该跨题 ===");
const OTHER = `hist-other-${RUN}`;
const OPID = PID + 1;
upsertProblem({ id: OPID, slug: OTHER, title: "另一题", tags: [] });
ensureSession(`other-${RUN}`, { id: OPID, slug: OTHER, title: "另一题" });
appendMessage({ sessionId: `other-${RUN}`, problemId: OPID, role: "user", content: "这里也有边界问题" });
check("别的题搜不到本题内容", searchMessages(OTHER, "单调栈").length === 0, searchMessages(OTHER, "单调栈").length);
check("别的题能搜到自己的", searchMessages(OTHER, "边界").length === 1, searchMessages(OTHER, "边界").length);

console.log("\n=== 6) 特殊字符不该炸 ===");
for (const q of ['"', "AND", "a OR b", "*", "()", "NEAR("]) {
  let ok = true;
  try {
    searchMessages(SLUG, q);
  } catch {
    ok = false;
  }
  check(`搜「${q}」不抛异常`, ok);
}

console.log("\n=== 7) 其它 ===");
recordSubmission(PID, 900000000 + Math.floor(Math.random() * 9999999), "python3", "Wrong Answer", 17, 29);
const st = historyStats();
check("统计到会话", st.sessions >= 3, JSON.stringify(st));
check("统计到消息", st.messages >= 8, JSON.stringify(st));
check("空 sessionId 不写", appendMessage({ sessionId: "", role: "user", content: "x" }) === false);
check("空内容不写", appendMessage({ sessionId: S1, role: "user", content: "" }) === false);

console.log(`\n${"─".repeat(48)}\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
