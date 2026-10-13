/**
 * system prompt 的加载与**热重载**。
 *
 * 原来是模块顶层 `readFileSync` 一次，改一个字就得重启后端 —— 而 prompt 恰恰是
 * 最需要反复调的东西（v0.8.1 就是为了改它）。现在按 mtime 缓存：文件一变，
 * **下一个请求就用新版**，不用重启。
 *
 * 读不到文件时**继续用上一份**，不要让服务挂 —— 编辑器保存到一半、
 * 或者你临时 `mv` 走它，都不该让侧边栏直接报错。
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROMPT_PATH = resolve(HERE, "prompts/system.md");

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
