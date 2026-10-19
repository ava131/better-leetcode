/**
 * system prompt 的加载、热重载，以及「在侧边栏里看 / 改 / 回滚」。
 *
 * 设计要点：
 *  - **不存在数据库里**：prompt 是 `prompts/system.md` 这个文本文件，改它就是改代码。
 *    好处是可以 `git diff`、能被 code review；坏处是"改一个字要重启"——第二点由热重载解决。
 *  - 热重载按 mtime；**保存之后要显式清缓存**（同一毫秒内写完，mtime 可能没变）。
 *  - 每次保存/恢复之前，**先把当前这份自动归档**到 `archive/edited-<时间>.md` ——
 *    这样"手滑改坏了"永远能退回去，而不用逼用户先 git commit。
 *  - 手工里程碑（`system.v0.9.0.md` 这种）和自动归档放在同一个目录，列表里混排，
 *    用 kind 区分，界面上标一下就行。
 */

import { readFileSync, statSync, writeFileSync, copyFileSync, readdirSync, mkdirSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * prompt 文件路径。`BL_PROMPT_PATH` 给测试用 —— 集成测试要能改 prompt 而不能
 * 碰用户真正在用的那一份。
 */
export const PROMPT_PATH = process.env.BL_PROMPT_PATH
  ? resolve(process.env.BL_PROMPT_PATH)
  : resolve(HERE, "prompts/system.md");

/** 归档目录：跟 prompt 同级的 `archive/`（测试时自动跟着走） */
export const ARCHIVE_DIR = resolve(dirname(PROMPT_PATH), "archive");

/** 保存时的上限，防止手滑粘进来一整本书 */
const MAX_CHARS = 200_000;

interface CacheEntry {
  mtimeMs: number;
  text: string;
}

const caches = new Map<string, CacheEntry>();

/** 读 system prompt（按 mtime 热重载）。path 可传，方便测试。 */
export function loadSystemPrompt(path: string = PROMPT_PATH): string {
  const hit = caches.get(path);
  try {
    const st = statSync(path);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.text;
    const text = readFileSync(path, "utf8");
    caches.set(path, { mtimeMs: st.mtimeMs, text });
    return text;
  } catch (e) {
    if (hit) return hit.text; // 读不到就先用上一份
    throw new Error(`读不到 system prompt（${path}）：${(e as Error).message}`);
  }
}

/** 给 /health 或调试用 */
export function promptStatus(): { path: string; chars: number; mtimeMs: number } {
  const text = loadSystemPrompt();
  return { path: PROMPT_PATH, chars: text.length, mtimeMs: caches.get(PROMPT_PATH)?.mtimeMs ?? 0 };
}

/** 只给测试用：丢掉缓存 */
export function clearPromptCache(path?: string): void {
  if (path) caches.delete(path);
  else caches.clear();
}

export interface PromptVersion {
  /** 文件名（当 id 用） */
  name: string;
  chars: number;
  mtimeMs: number;
  /** milestone = 手工里程碑（system.vX.Y.Z.md）；edited = 每次保存前自动存的 */
  kind: "milestone" | "edited";
}

function archiveName(kind: "milestone" | "edited", at = new Date()): string {
  if (kind === "milestone") return `system.${at.toISOString().replace(/[:.]/g, "-")}.md`;
  const stamp = at.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  return `edited-${stamp}.md`;
}

/** 把当前 prompt 复制一份进归档（已经存在同名的就不重复写） */
function archiveCurrent(reason: string): string | null {
  try {
    mkdirSync(ARCHIVE_DIR, { recursive: true });
    const name = reason === "milestone" ? archiveName("milestone") : archiveName("edited");
    const dest = resolve(ARCHIVE_DIR, name);
    copyFileSync(PROMPT_PATH, dest);
    return name;
  } catch {
    return null; // 归档失败不该挡住保存，但会在返回值里体现
  }
}

/** 历史版本列表，新的在前 */
export function listPromptVersions(): PromptVersion[] {
  let names: string[] = [];
  try {
    names = readdirSync(ARCHIVE_DIR).filter((n) => n.endsWith(".md") && n !== "README.md");
  } catch {
    return [];
  }
  const out: PromptVersion[] = [];
  for (const name of names) {
    try {
      const st = statSync(resolve(ARCHIVE_DIR, name));
      out.push({
        name,
        chars: readFileSync(resolve(ARCHIVE_DIR, name), "utf8").length,
        mtimeMs: st.mtimeMs,
        kind: /^system\.v?\d+\.\d+\.\d+/.test(name) ? "milestone" : "edited",
      });
    } catch {
      /* 文件刚好被删：跳过 */
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** 读某个历史版本的全文 */
export function readPromptVersion(name: string): string {
  const safe = basename(String(name ?? ""));
  if (!safe.endsWith(".md") || safe === "README.md") throw new Error("非法的版本名");
  return readFileSync(resolve(ARCHIVE_DIR, safe), "utf8");
}

export interface SaveResult {
  ok: true;
  chars: number;
  /** 保存前自动归档出来的文件名（null = 归档失败，但保存成功） */
  archived: string | null;
  warning?: string;
}

/** 保存新 prompt：先归档旧的，再写新的，最后清缓存（下一轮就生效） */
export function saveSystemPrompt(text: string): SaveResult {
  if (typeof text !== "string") throw new Error("text 必须是字符串");
  const body = text.replace(/\r\n/g, "\n");
  if (!body.trim()) throw new Error("prompt 不能是空的");
  if (body.length > MAX_CHARS) throw new Error(`prompt 太长（${body.length} > ${MAX_CHARS} 字符）`);
  if (body.includes("\u0000")) throw new Error("prompt 里不能有 NUL 字符");

  let warning: string | undefined;
  try {
    const before = loadSystemPrompt();
    if (body.length < before.length * 0.3) {
      warning = `新内容只有原来的 ${Math.round((body.length / before.length) * 100)}%，确认一下没粘丢`;
    }
  } catch {
    /* 原来那份读不到也无所谓，继续写 */
  }

  const archived = archiveCurrent("edited");
  writeFileSync(PROMPT_PATH, body, "utf8");
  // ★ 必须显式清缓存：同一毫秒内写完，mtime 可能和上次读到的一样
  clearPromptCache(PROMPT_PATH);
  return { ok: true, chars: body.length, archived, ...(warning ? { warning } : {}) };
}

/** 恢复到某个历史版本（同样先把当前这份归档） */
export function restorePromptVersion(name: string): SaveResult {
  const text = readPromptVersion(name);
  const r = saveSystemPrompt(text);
  return { ...r, warning: undefined };
}
