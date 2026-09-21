/**
 * 对话历史层：node:sqlite，单文件，零原生依赖。
 *
 * 设计取舍（见 docs/PRD.md FR-5）：
 *  - **全量存对话**。很多思路是在对话里诞生的，摘要会丢掉过程。
 *  - **不存模型的思考过程**：那是模型的推理不是用户的思路，且占 ~85% 体积。
 *  - 每条 user 消息带一份**上下文快照**（当时的代码/判定/用例），
 *    否则几个月后回看会不知道当时在说什么。**只在变化时才写**。
 *  - FTS5 全文检索（node:sqlite 自带）——存了能搜，才不是坟场。
 *
 * 体积实测：只存正文约 3.3KB/轮 → 一年 ~18MB。
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type { ChatMessage, Problem, RunResult, Testcase } from "./types.ts";

let db: DatabaseSync | null = null;
let dbFailed = false;
let dbLastError = "";

export function defaultDbPath(): string {
  return process.env.MEMORY_DB || join(homedir(), ".better-leetcode", "memory.db");
}

/** ★ 永远用 `IF NOT EXISTS`，老库（只有 problems/submissions）能平滑升上来 */
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS problems (
  id          INTEGER PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  difficulty  TEXT,
  tags        TEXT,               -- JSON 数组。将来按 tag 聚合导师摘要要用
  updated_at  TEXT NOT NULL
);

-- 旧库里可能还有 approaches / stuck_points（老的"结构化记忆"）。**不 DROP**：
-- 从旧库升上来时 DROP 是不可逆的。它们不再被读写，只是占一点地方。

CREATE TABLE IF NOT EXISTS submissions (
  id         INTEGER PRIMARY KEY,
  problem_id INTEGER NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  lang       TEXT,
  verdict    TEXT,
  passed     INTEGER,
  total      INTEGER,
  created_at TEXT NOT NULL
);

-- 一次「打开题目页」= 一个会话
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  problem_id INTEGER,
  slug       TEXT NOT NULL,
  title      TEXT,                -- 首条用户消息，列表里显示用
  started_at TEXT NOT NULL,
  last_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  problem_id INTEGER,
  role       TEXT NOT NULL,       -- user | assistant | marker
  content    TEXT NOT NULL,
  snapshot   TEXT,                -- JSON: 当时的代码/判定/用例（仅变化时写）
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_msg_session ON messages(session_id, id);
CREATE INDEX IF NOT EXISTS idx_msg_problem ON messages(problem_id, id);
CREATE INDEX IF NOT EXISTS idx_sess_slug   ON sessions(slug, last_at DESC);

-- 检索用 LIKE，不用 FTS5。
-- ★ 实测：FTS5 的 unicode61 分词器把**连续中文当成一个 token**，
--   搜「边界」在「注意闭区间的边界处理」里命中 0 条；trigram 又要求 ≥3 字符。
--   而 LIKE 对中英文一视同仁，也不会有 "unterminated string" 这类语法错误。
--   这个规模（实测 ~18MB/年）全表扫是毫秒级，够用很久。
`;

/** 记忆库不可用时返回 null —— **绝不让存储问题阻断对话** */
function tryDb(path = defaultDbPath()): DatabaseSync | null {
  if (db) return db;
  if (dbFailed) return null;
  try {
    mkdirSync(dirname(path), { recursive: true });
    db = new DatabaseSync(path);
    db.exec(SCHEMA);
    return db;
  } catch (e) {
    dbFailed = true;
    dbLastError = (e as Error).message;
    console.error(`[history] 数据库不可用，本次以「无历史」模式运行：${dbLastError}`);
    return null;
  }
}

export function dbStatus(): { ok: boolean; path: string; error?: string } {
  const d = tryDb();
  return { ok: !!d, path: defaultDbPath(), ...(d ? {} : { error: dbLastError }) };
}

const now = () => new Date().toISOString();

// ───────────────────────── 题目 / 提交 ─────────────────────────

export function upsertProblem(p: Problem): number {
  const d = tryDb();
  if (!d) return p.id;
  // catch-all ON CONFLICT：id 或 slug 任一冲突都能处理。
  // 刻意不用 INSERT OR REPLACE —— 那会删旧行并级联删掉会话/消息。
  d.prepare(
    `INSERT INTO problems (id, slug, title, difficulty, tags, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT DO UPDATE SET
       slug = excluded.slug, title = excluded.title,
       difficulty = excluded.difficulty, tags = excluded.tags,
       updated_at = excluded.updated_at`
  ).run(p.id, p.slug, p.title, p.difficulty ?? null, JSON.stringify(p.tags ?? []), now());
  return p.id;
}

export function recordSubmission(
  problemId: number,
  submissionId: number,
  lang: string,
  verdict: string,
  passed?: number | null,
  total?: number | null
): void {
  const d = tryDb();
  if (!d) return;
  d.prepare(
    `INSERT OR REPLACE INTO submissions (id, problem_id, lang, verdict, passed, total, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(submissionId, problemId, lang, verdict, passed ?? null, total ?? null, now());
}

// ───────────────────────── 会话 / 消息 ─────────────────────────

/** 保证会话存在。首条用户消息拿来做标题 */
export function ensureSession(
  sessionId: string,
  problem: Problem | undefined,
  firstUserMessage?: string
): void {
  const d = tryDb();
  if (!d || !sessionId) return;
  try {
    d.prepare(
      `INSERT INTO sessions (id, problem_id, slug, title, started_at, last_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_at = excluded.last_at`
    ).run(
      sessionId,
      problem?.id ?? null,
      problem?.slug ?? "unknown",
      firstUserMessage ? firstUserMessage.slice(0, 120) : null,
      now(),
      now()
    );
  } catch (e) {
    console.error("[history] ensureSession 失败:", (e as Error).message);
  }
}

export interface AppendOpts {
  sessionId: string;
  problemId?: number | null;
  /** 自动建会话时要用 —— 不给的话会话会挂到 "unknown" 下，列表里就查不到了 */
  slug?: string | null;
  role: "user" | "assistant" | "marker";
  content: string;
  /** 只在该会话里与上一条不同时才会真正落库 */
  snapshot?: string | null;
}

/**
 * 追加一条消息。
 *
 * `snapshot` 做去重：代码没改、判定没变就不重复写 —— 不然每轮白搭 ~1.5KB。
 * 返回是否真的写入。
 */
export function appendMessage(o: AppendOpts): boolean {
  const d = tryDb();
  if (!d || !o.sessionId || !o.content) return false;
  try {
    // ★ 防御：会话不存在就自己建一个。外键约束会让这次写入直接失败，
    //   而失败只是打条日志 —— 那就是**静默丢消息**。宁可建个空壳会话。
    d.prepare(
      `INSERT OR IGNORE INTO sessions (id, problem_id, slug, title, started_at, last_at)
       VALUES (?, ?, ?, NULL, ?, ?)`
    ).run(o.sessionId, o.problemId ?? null, o.slug || "unknown", now(), now());

    let snap: string | null = null;
    if (o.snapshot) {
      const last = d
        .prepare(`SELECT snapshot FROM messages WHERE session_id = ? AND snapshot IS NOT NULL
                  ORDER BY id DESC LIMIT 1`)
        .get(o.sessionId) as { snapshot: string } | undefined;
      if (!last || last.snapshot !== o.snapshot) snap = o.snapshot;
    }
    d.prepare(
      `INSERT INTO messages (session_id, problem_id, role, content, snapshot, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(o.sessionId, o.problemId ?? null, o.role, o.content, snap, now());
    d.prepare(`UPDATE sessions SET last_at = ? WHERE id = ?`).run(now(), o.sessionId);
    return true;
  } catch (e) {
    console.error("[history] appendMessage 失败:", (e as Error).message);
    return false;
  }
}

/** 把当前上下文压成一个可比较的快照字符串（内容一样 → 哈希一样 → 不重复存） */
export function snapshotOf(ctx: {
  code?: string;
  lang?: string;
  verdict?: string | null;
  testcase?: Testcase | null;
  run?: RunResult | null;
}): string {
  const payload = JSON.stringify({
    code: ctx.code ?? "",
    lang: ctx.lang ?? "",
    verdict: ctx.verdict ?? null,
    testcase: ctx.testcase ?? null,
    run: ctx.run
      ? { verdict: ctx.run.verdict, passed: ctx.run.passed, total: ctx.run.total, failedIndex: ctx.run.failedIndex }
      : null,
  });
  return createHash("sha1").update(payload).digest("hex").slice(0, 16) + "\u0000" + payload;
}

// ───────────────────────── 历史查询 ─────────────────────────

export interface SessionRow {
  id: string;
  title: string | null;
  started_at: string;
  last_at: string;
  msg_count: number;
}

/** 某道题的会话列表，最近的在前 */
export function listSessions(slug: string, limit = 50): SessionRow[] {
  const d = tryDb();
  if (!d) return [];
  try {
    return d
      .prepare(
        `SELECT s.id, s.title, s.started_at, s.last_at,
                (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS msg_count
         FROM sessions s
         WHERE s.slug = ?
         -- 按"最后一条消息 id"排：单调递增，不会像时间戳那样并列
         ORDER BY COALESCE((SELECT MAX(m2.id) FROM messages m2 WHERE m2.session_id = s.id), 0) DESC
         LIMIT ?`
      )
      .all(slug, limit) as unknown as SessionRow[];
  } catch {
    return [];
  }
}

export interface StoredMessage {
  id: number;
  role: string;
  content: string;
  snapshot: string | null;
  created_at: string;
}

export function getSessionMessages(sessionId: string): StoredMessage[] {
  const d = tryDb();
  if (!d) return [];
  try {
    return d
      .prepare(
        `SELECT id, role, content, snapshot, created_at
         FROM messages WHERE session_id = ? ORDER BY id`
      )
      .all(sessionId) as unknown as StoredMessage[];
  } catch {
    return [];
  }
}

/** 只搜当前题（跨题搜索等攒够题量再做） */
export function searchMessages(
  slug: string,
  query: string,
  limit = 30
): (StoredMessage & { session_id: string })[] {
  const d = tryDb();
  const q = query.trim();
  if (!d || !q) return [];
  try {
    return d
      .prepare(
        `SELECT m.id, m.session_id, m.role, m.content, m.created_at
         FROM messages m JOIN sessions s ON s.id = m.session_id
         WHERE s.slug = ? AND m.content LIKE ? ESCAPE '\\'
         ORDER BY m.id DESC LIMIT ?`
      )
      .all(slug, `%${escapeLike(q)}%`, limit) as unknown as (StoredMessage & { session_id: string })[];
  } catch (e) {
    console.error("[history] 搜索失败:", (e as Error).message);
    return [];
  }
}

/** LIKE 里 % _ \ 有特殊含义，要转义，否则用户搜 "100%" 会变成通配 */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}

export function historyStats(): { sessions: number; messages: number; problems: number } {
  const d = tryDb();
  if (!d) return { sessions: 0, messages: 0, problems: 0 };
  try {
    return d
      .prepare(
        `SELECT (SELECT COUNT(*) FROM sessions)  AS sessions,
                (SELECT COUNT(*) FROM messages)  AS messages,
                (SELECT COUNT(*) FROM problems)  AS problems`
      )
      .get() as unknown as { sessions: number; messages: number; problems: number };
  } catch {
    return { sessions: 0, messages: 0, problems: 0 };
  }
}

/** 把客户端的 messages 数组拆出「最后一条用户消息」——/chat 落库用 */
export function lastUserMessage(msgs: ChatMessage[] | undefined): string | null {
  if (!Array.isArray(msgs)) return null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role === "user") return msgs[i].content ?? null;
  }
  return null;
}

export function closeDb(): void {
  db?.close();
  db = null;
}
