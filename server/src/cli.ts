#!/usr/bin/env node
/**
 * 命令行入口。两个用途：
 *
 *   node src/cli.ts --dry-run fixtures/xxx.json
 *     ★ M0 的核心：把将要发给模型的完整内容原样打印出来。
 *       不需要 API key，用于评审「拼出来的 prompt 到底对不对」。
 *
 *   node src/cli.ts fixtures/xxx.json
 *     真实调用 LLM，流式输出。用于验证回答质量（M1）。
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderMessagesForReview } from "./context.ts";
import { resetCodeMemory } from "./code-version.ts";
import { resetTurnMemory } from "./turn-memory.ts";
import { planPrompt, planSummary } from "./prompt-plan.ts";
import { loadEnv, streamChat, stripMemoryBlocks } from "./llm.ts";
import { htmlToMarkdown } from "./html.ts";
import type { ChatRequest } from "./types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..");

loadEnv(resolve(PROJECT_ROOT, ".env"));

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const fileArg = argv.find((a) => !a.startsWith("--"));

if (!fileArg) {
  console.error("用法: node src/cli.ts [--dry-run] <fixture.json>");
  process.exit(1);
}

const raw = JSON.parse(readFileSync(resolve(process.cwd(), fileArg), "utf8"));
const req = raw as ChatRequest;

// 题干兜底：扩展侧没转就在这转
if (req.problem?.content && /<[a-z][\s\S]*>/i.test(req.problem.content)) {
  req.problem.content = htmlToMarkdown(req.problem.content);
}

const systemPrompt = readFileSync(resolve(HERE, "prompts/system.md"), "utf8");

/**
 * --dry-run 时反复演练"多轮"：每轮模拟用户改一行 + 问一句，
 * 并且老实调用 commit()（假装上一轮真的发出去了），
 * 这样第二轮开始就能看到"发增量"，第 6 轮能看到"到点重发全文"。
 *
 *   node src/cli.ts --dry-run --revs=3 fixtures/xxx.json
 */
const revs = Number((argv.find((a) => a.startsWith("--revs=")) ?? "--revs=1").split("=")[1]) || 1;
const SID = "cli-dry-run";
resetCodeMemory();
resetTurnMemory();

if (dryRun) {
  let plan = planPrompt({ ...req, sessionId: SID }, systemPrompt);
  for (let i = 1; i < revs; i++) {
    plan.commit();
    // 模拟"用户又改了一行，然后追问"
    req.code = req.code.replace(/\n?$/, "") + `\n# 改动 ${i}\n`;
    req.messages = [
      ...(req.messages ?? []),
      { role: "assistant", content: `（第 ${i} 轮的回答）` },
      { role: "user", content: `第 ${i + 1} 问：这版呢？` },
    ];
    plan = planPrompt({ ...req, sessionId: SID }, systemPrompt);
  }
  const r = plan.render;
  console.log(`第 ${revs} 轮 → ${planSummary(plan, { ...req, sessionId: SID })}`);
  console.log(
    `代码发送方式: rev=${r.rev} mode=${r.mode} 原因=${r.reason} ` +
      `全文=${r.stats.fullChars}字符 实发=${r.stats.sentChars}字符` +
      (r.mode === "diff" ? `（省 ${Math.round((1 - r.stats.ratio) * 100)}%）` : "") +
      "\n"
  );
  const msgs = plan.build(systemPrompt);
  console.log(renderMessagesForReview(msgs));
  const total = msgs.reduce((a, m) => a + m.content.length, 0);
  console.log("\n" + "─".repeat(80));
  console.log("统计：");
  console.log(`  消息条数        ${msgs.length}`);
  console.log(`  总字符数        ${total}   （粗估 ≈ ${Math.round(total / 3)}~${Math.round(total / 1.5)} tokens）`);
  console.log(`  题干字符数      ${req.problem.content?.length ?? 0}`);
  console.log(`  代码字符数      ${req.code?.length ?? 0}`);
  console.log("─".repeat(80));
  process.exit(0);
}

// ---- 真实调用 ----
console.log(`模型: ${process.env.LLM_MODEL ?? "(未设置)"}   base: ${process.env.LLM_BASE_URL ?? "(未设置)"}`);
if (!process.env.LLM_API_KEY) {
  console.error("\n✗ 没有 LLM_API_KEY。复制 .env.example 为 .env 并填入。");
  console.error("  或者先用 --dry-run 看拼出来的 prompt（不需要 key）。");
  process.exit(1);
}
console.log("─".repeat(80));

let full = "";
let thinking = 0;
let t0 = Date.now();
let firstByte: number | null = null;
try {
  for await (const chunk of streamChat(req, systemPrompt)) {
    if (firstByte === null) firstByte = Date.now() - t0;
    if (chunk.kind === "usage") {
      const u = chunk.usage;
      const hit = u.prompt_cache_hit_tokens,
        miss = u.prompt_cache_miss_tokens;
      if (hit != null && miss != null) {
        process.stderr.write(
          `[用量] 输入 ${u.prompt_tokens} 输出 ${u.completion_tokens} ` +
            `缓存命中 ${Math.round((hit / Math.max(1, hit + miss)) * 100)}% (${hit}+${miss})\n`
        );
      }
      continue;
    }
    if (chunk.kind === "thinking") {
      if (thinking === 0) process.stderr.write("\n[思考中] ");
      thinking += chunk.text.length;
      if (thinking % 400 < chunk.text.length) process.stderr.write(".");
      continue;
    }
    if (thinking > 0 && full === "") process.stderr.write(" 完成思考\n\n");
    full += chunk.text;
    process.stdout.write(chunk.text);
  }
} catch (e) {
  console.error("\n✗ 调用失败: " + (e as Error).message);
  process.exit(1);
}

// 防御性剥离：模型偶尔还会吐旧的 <memory> 格式
const { text } = stripMemoryBlocks(full);
console.log("\n" + "─".repeat(80));
console.log(
  `\n（正文 ${text.length} 字符；首字节 ${firstByte ?? "?"}ms；` +
    `思考 ${thinking} 字符；总耗时 ${Date.now() - t0}ms）`
);
