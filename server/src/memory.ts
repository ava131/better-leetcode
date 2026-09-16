/**
 * 记忆层：node:sqlite，单文件，零原生依赖。
 *
 * 硬约束（PRD FR-5 / FR-6）：**只存结构化事实，不存对话，不存代码。**
 * 且写入必须显式 —— AI 只能「建议」，用户点确认才落库。
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Memory, MemorySuggestion, Problem } from "./types.ts";

let db: DatabaseSync | null = null;
let dbFailed = false;
let dbLastError = "";

/** 记忆库不可用时返回 null —— **绝不让记忆问题阻断对话** */
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
    console.error(`[memory] 记忆库不可用，本次以「无记忆」模式运行：${dbLastError}`);
    return null;
  }
}

export function memoryStatus(): { ok: boolean; path: string; error?: string } {
  const d = tryDb();
  return { ok: !!d, path: defaultDbPath(), ...(d ? {} : { error: dbLastError }) };
}


const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS problems (
  id          INTEGER PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  difficulty  TEXT,
  tags        TEXT,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approaches (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  problem_id       INTEGER NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  time_complexity  TEXT,
  space_complexity TEXT,
  mastered         INTEGER NOT NULL DEFAULT 0,
  evidence         TEXT,
  note             TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE(problem_id, name)
);

CREATE TABLE IF NOT EXISTS stuck_points (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  problem_id  INTEGER NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  insight     TEXT,
  count       INTEGER NOT NULL DEFAULT 1,
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS submissions (
  id         INTEGER PRIMARY KEY,
  problem_id INTEGER NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  lang       TEXT,
  verdict    TEXT,
  passed     INTEGER,
  total      INTEGER,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stuck_problem  ON stuck_points(problem_id);
CREATE INDEX IF NOT EXISTS idx_stuck_last     ON stuck_points(last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_appr_problem   ON approaches(problem_id);
CREATE INDEX IF NOT EXISTS idx_sub_problem    ON submissions(problem_id);
`;

export function defaultDbPath(): string {
  return process.env.MEMORY_DB || join(homedir(), ".better-leetcode", "memory.db");
}

function now(): string {
  return new Date().toISOString();
}

/** 记录/更新题目元信息（本身不是"记忆"，是必要的外键锚点） */
export function upsertProblem(p: Problem): number {
  const d = tryDb();
  if (!d) return p.id;
  // 用 catch-all 的 ON CONFLICT：**id 或 slug 任一冲突都能处理**。
  // 只写 ON CONFLICT(slug) 的话，「同 id 不同 slug」（力扣改 slug）会撞主键崩掉。
  // 也刻意不用 INSERT OR REPLACE —— 那会删旧行并级联删掉卡点/解法。
  d.prepare(
    `INSERT INTO problems (id, slug, title, difficulty, tags, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT DO UPDATE SET
       slug       = excluded.slug,
       title      = excluded.title,
       difficulty = excluded.difficulty,
       tags       = excluded.tags,
       updated_at = excluded.updated_at`
  ).run(p.id, p.slug, p.title, p.difficulty ?? null, JSON.stringify(p.tags ?? []), now());
  return p.id;
}

/** 读某题的记忆。没有就返回空结构（调用方据此决定是否注入）。 */
export function getMemory(slug: string): Memory | null {
  const d = tryDb();
  if (!d) return null;
  const prob = d
    .prepare(`SELECT id FROM problems WHERE slug = ?`)
    .get(slug) as { id: number } | undefined;
  if (!prob) return null;

  const stuckPoints = d
    .prepare(
      `SELECT description AS desc, insight, count, first_seen AS first, last_seen AS last
       FROM stuck_points WHERE problem_id = ? ORDER BY last_seen DESC`
    )
    .all(prob.id) as any[];

  const approaches = d
    .prepare(
      `SELECT name, time_complexity AS time, space_complexity AS space, mastered, evidence, note
       FROM approaches WHERE problem_id = ? ORDER BY mastered DESC, name`
    )
    .all(prob.id) as any[];

  if (!stuckPoints.length && !approaches.length) return null;

  return {
    stuckPoints: stuckPoints as any,
    approaches: approaches.map((a) => ({ ...a, mastered: !!a.mastered })) as any,
  };
}

/** 显式确认后写入。这是唯一的写入路径。 */
export function confirmSuggestion(slug: string, s: MemorySuggestion): { ok: boolean; message: string } {
  const d = tryDb();
  if (!d) return { ok: false, message: "记忆库不可用，本次未写入" };
  const prob = d.prepare(`SELECT id FROM problems WHERE slug = ?`).get(slug) as
    | { id: number }
    | undefined;
  if (!prob) return { ok: false, message: `未知题目 ${slug}，请先提交一次` };

  const ts = now();

  if (s.kind === "stuck_point") {
    if (!s.desc) return { ok: false, message: "stuck_point 缺少 desc" };
    // 同一题同一描述视为同一个卡点，累加次数
    const existing = d
      .prepare(`SELECT id, count FROM stuck_points WHERE problem_id = ? AND description = ?`)
      .get(prob.id, s.desc) as { id: number; count: number } | undefined;

    if (existing) {
      d.prepare(`UPDATE stuck_points SET count = ?, last_seen = ?, insight = COALESCE(?, insight) WHERE id = ?`)
        .run(existing.count + 1, ts, s.insight ?? null, existing.id);
      return { ok: true, message: `卡点已存在，出现次数 → ${existing.count + 1}` };
    }
    d.prepare(
      `INSERT INTO stuck_points (problem_id, description, insight, count, first_seen, last_seen)
       VALUES (?, ?, ?, 1, ?, ?)`
    ).run(prob.id, s.desc, s.insight ?? null, ts, ts);
    return { ok: true, message: "新卡点已记录" };
  }

  if (s.kind === "approach") {
    if (!s.name) return { ok: false, message: "approach 缺少 name" };
    d.prepare(
      `INSERT INTO approaches (problem_id, name, time_complexity, space_complexity, mastered, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(problem_id, name) DO UPDATE SET
         time_complexity  = COALESCE(excluded.time_complexity,  approaches.time_complexity),
         space_complexity = COALESCE(excluded.space_complexity, approaches.space_complexity),
         mastered         = excluded.mastered,
         note             = COALESCE(excluded.note, approaches.note),
         updated_at       = excluded.updated_at`
    ).run(
      prob.id,
      s.name,
      s.time ?? null,
      s.space ?? null,
      s.mastered ? 1 : 0,
      s.note ?? null,
      ts,
      ts
    );
    return { ok: true, message: `解法「${s.name}」已记录，掌握=${s.mastered ? "是" : "否"}` };
  }

  return { ok: false, message: "未知的建议类型" };
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

/** 跨题总览：掌握度矩阵 + 高频卡点 */
export function getOverview(): {
  mastery: any[];
  topStuckPoints: any[];
  stats: { problems: number; submissions: number; mastered: number; totalApproaches: number };
} {
  const d = tryDb();
  if (!d) {
    return {
      mastery: [],
      topStuckPoints: [],
      stats: { problems: 0, submissions: 0, mastered: 0, totalApproaches: 0 },
    };
  }

  const mastery = d
    .prepare(
      `SELECT p.slug, p.title, p.difficulty,
              COUNT(a.id)                                    AS approaches_total,
              SUM(CASE WHEN a.mastered = 1 THEN 1 ELSE 0 END) AS approaches_mastered
       FROM problems p
       JOIN approaches a ON a.problem_id = p.id
       GROUP BY p.id
       ORDER BY (approaches_total - approaches_mastered) DESC, p.title`
    )
    .all();

  const topStuckPoints = d
    .prepare(
      `SELECT s.description AS desc, s.insight, SUM(s.count) AS total_count,
              COUNT(DISTINCT s.problem_id) AS problem_count,
              MAX(s.last_seen) AS last_seen
       FROM stuck_points s
       GROUP BY s.description
       ORDER BY total_count DESC, last_seen DESC
       LIMIT 20`
    )
    .all();

  const stats = d
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM problems)                                   AS problems,
         (SELECT COUNT(*) FROM submissions)                                AS submissions,
         (SELECT COUNT(*) FROM approaches WHERE mastered = 1)              AS mastered,
         (SELECT COUNT(*) FROM approaches)                                 AS totalApproaches`
    )
    .get() as any;

  return { mastery, topStuckPoints, stats };
}

export function closeDb(): void {
  db?.close();
  db = null;
}
