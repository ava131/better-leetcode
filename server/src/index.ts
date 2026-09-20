#!/usr/bin/env node
/**
 * 本地后端。只绑 127.0.0.1。
 *
 *   POST /chat               SSE 流式对话
 *   GET  /memory/:slug       读某题记忆
 *   POST /memory/confirm     显式写入（用户点了「记下来」才调）
 *   GET  /memory/overview    掌握度矩阵 + 跨题高频卡点
 *   GET  /health             扩展启动探测
 *   GET  /debug/last-prompt  dump 上一次实际发出的完整 prompt（调 prompt 用）
 *
 * **无状态**：会话（对话历史 + 代码快照）由扩展持有，每轮全量送上来。
 * 这样后端重启不丢会话，也没有同步问题。
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMessages, renderForReview } from "./context.ts";
import { loadEnv, streamChat, stripMemoryBlocks, allowedModels, defaultModel } from "./llm.ts";
import {
  getMemory,
  getOverview,
  confirmSuggestion,
  upsertProblem,
  recordSubmission,
  memoryStatus,
} from "./memory.ts";
import { htmlToMarkdown } from "./html.ts";
import type { ChatRequest, MemorySuggestion } from "./types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..");

loadEnv(resolve(PROJECT_ROOT, ".env"));

const PORT = Number(process.env.PORT ?? 8787);
const SYSTEM_PROMPT = readFileSync(resolve(HERE, "prompts/system.md"), "utf8");

/** 日志同时写 stdout 和文件（文件是为了让 AI 助手/事后排查能读到） */
const LOG_FILE = resolve(PROJECT_ROOT, "bl-server.log");
try {
  writeFileSync(LOG_FILE, `=== 启动 ${new Date().toISOString()} ===\n`);
} catch {}

function log(msg: string) {
  const line = `[${new Date().toTimeString().slice(0, 8)}] ${msg}`;
  console.log(line);
  try {
    appendFileSync(LOG_FILE, line + "\n");
  } catch {}
}

/** 扩展汇报上来的诊断事件（排查"插件到底看到了什么"） */
const diagRing: string[] = [];

/** 上一次实际发出的内容，供 /debug/last-prompt 查看 */
let lastPrompt: { at: string; rendered: string } | null = null;

/** /models 的探测结果缓存 */
let modelsCache: { at: number; list: string[] } | null = null;

function json(res: ServerResponse, code: number, body: unknown) {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(s),
  });
  res.end(s);
}

/** 带 HTTP 状态码的错误：客户端的问题报 4xx，别一律 500（否则日志里看不出原因） */
class HttpError extends Error {
  // 注意：Node 的 type-stripping 不支持 TS 的"参数属性"写法
  // （constructor(public code: number)），必须显式赋值。
  code: number;
  constructor(code: number, msg: string) {
    super(msg);
    this.code = code;
  }
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  const LIMIT = 4 * 1024 * 1024;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > LIMIT) throw new HttpError(413, `请求体超过 ${LIMIT} 字节`);
    chunks.push(c as Buffer);
  }
  if (!chunks.length) throw new HttpError(400, "请求体为空");
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new HttpError(400, "请求体不是合法 JSON: " + (e as Error).message.slice(0, 120));
  }
}

/** 只允许扩展来的请求。网页无法伪造 Origin。 */
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // service worker / curl 可能不带
  return origin.startsWith("chrome-extension://") || origin.startsWith("moz-extension://");
}

/** 题干兜底转换：扩展侧没转就在这转 */
function normalize(req: ChatRequest): ChatRequest {
  if (req.problem?.content && /<[a-z][a-z0-9]*[\s>]/i.test(req.problem.content)) {
    req.problem.content = htmlToMarkdown(req.problem.content);
  }
  return req;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  // ── 请求日志（排查"插件到底有没有发请求"最有用） ──
  const t0 = Date.now();
  const origin = req.headers.origin ?? "(无)";
  res.on("finish", () => {
    const ms = Date.now() - t0;
    // 隐藏轮询噪声
    const noisy = path === "/health" && res.statusCode === 200;
    if (noisy) return;
    log(
      `${String(req.method).padEnd(5)} ${path.padEnd(22)} ` +
        `${res.statusCode}  ${String(ms).padStart(5)}ms  origin=${origin}`
    );
  });

  if (!originAllowed(req)) {
    log(`[拒绝] origin=${origin} —— 只接受浏览器扩展来的请求`);
    return json(res, 403, { error: "只接受来自浏览器扩展的请求" });
  }

  try {
    // ---------- 扩展汇报诊断（排查"插件到底看到了什么"） ----------
    if (path === "/diag" && req.method === "POST") {
      const b = await readBody(req);
      const line =
        `[ext] ${String(b.event ?? "?").padEnd(24)} ` +
        `url=${String(b.url ?? "").replace("https://leetcode.cn", "").slice(0, 44)} ` +
        `slug=${b.slug ?? "-"} ` +
        (b.data ? JSON.stringify(b.data).slice(0, 260) : "");
      log(line);
      diagRing.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
      if (diagRing.length > 300) diagRing.splice(0, diagRing.length - 300);
      return json(res, 200, { ok: true });
    }
    if (path === "/diag" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      return res.end(diagRing.join("\n") || "（还没有扩展汇报）");
    }

    // ---------- 健康检查 ----------
    if (path === "/health") {
      return json(res, 200, {
        ok: true,
        model: defaultModel(),
        models: allowedModels(),
        baseUrl: process.env.LLM_BASE_URL ?? null,
        hasKey: !!process.env.LLM_API_KEY,
        memory: memoryStatus(),
      });
    }

    // ---------- 向 provider 探测可用模型（带缓存） ----------
    if (path === "/models" && req.method === "GET") {
      if (modelsCache && Date.now() - modelsCache.at < 5 * 60_000) {
        return json(res, 200, { models: modelsCache.list, cached: true });
      }
      const base = (process.env.LLM_BASE_URL ?? "").replace(/\/+$/, "");
      const key = process.env.LLM_API_KEY ?? "";
      if (!base || !key) return json(res, 400, { error: "未配置 LLM_BASE_URL / LLM_API_KEY" });
      try {
        const r = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${key}` } });
        if (!r.ok) return json(res, 502, { error: `上游 ${r.status}` });
        const j: any = await r.json();
        const list = (j?.data ?? []).map((m: any) => m.id).filter(Boolean);
        modelsCache = { at: Date.now(), list };
        return json(res, 200, { models: list, cached: false });
      } catch (e) {
        return json(res, 502, { error: (e as Error).message });
      }
    }

    // ---------- 调 prompt 用 ----------
    if (path === "/debug/last-prompt" && req.method === "GET") {
      if (!lastPrompt) return json(res, 404, { error: "还没有发过请求" });
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      return res.end(`# 发送于 ${lastPrompt.at}\n\n${lastPrompt.rendered}`);
    }

    // ---------- 读记忆 ----------
    if (path.startsWith("/memory/") && req.method === "GET") {
      const slug = decodeURIComponent(path.slice("/memory/".length));
      if (slug === "overview") return json(res, 200, getOverview());
      return json(res, 200, getMemory(slug) ?? { stuckPoints: [], approaches: [] });
    }

    // ---------- 显式写入记忆 ----------
    if (path === "/memory/confirm" && req.method === "POST") {
      const body = await readBody(req);
      const { slug, suggestions, problem } = body as {
        slug: string;
        suggestions: MemorySuggestion[];
        problem?: ChatRequest["problem"];
      };
      if (!slug || !Array.isArray(suggestions)) {
        return json(res, 400, { error: "需要 slug 和 suggestions" });
      }
      if (problem) upsertProblem(problem);
      const results = suggestions.map((s) => confirmSuggestion(slug, s));
      return json(res, 200, { results });
    }

    // ---------- 记录提交（只存元数据，不存代码） ----------
    if (path === "/submission" && req.method === "POST") {
      const b = await readBody(req);
      if (!b.problem?.id) return json(res, 400, { error: "缺少 problem.id" });
      upsertProblem(b.problem);
      if (b.submissionId != null) {
        recordSubmission(
          b.problem.id,
          b.submissionId,
          b.lang ?? "",
          b.verdict ?? "",
          b.passed ?? null,
          b.total ?? null
        );
      }
      return json(res, 200, { ok: true });
    }

    // ---------- 对话（SSE） ----------
    if (path === "/chat" && req.method === "POST") {
      const raw = await readBody(req);
      const chatReq = normalize(raw as ChatRequest);

      // 入参校验：缺了这些字段要么上游有 bug，要么是手工调用
      if (!chatReq || typeof chatReq !== "object") throw new HttpError(400, "请求体必须是对象");
      if (!chatReq.problem || typeof chatReq.problem !== "object")
        throw new HttpError(400, "缺少 problem");
      if (typeof chatReq.problem.slug !== "string" || !chatReq.problem.slug)
        throw new HttpError(400, "problem.slug 必须是非空字符串");
      if (!Array.isArray(chatReq.messages) || chatReq.messages.length === 0)
        throw new HttpError(400, "messages 必须是非空数组");

      // 模型：请求里带了就用（需在白名单内），否则用 .env 默认值
      const requested = typeof (raw as any).model === "string" ? (raw as any).model.trim() : "";
      const allow = allowedModels();
      let useModel = defaultModel();
      if (requested) {
        if (!allow.length || allow.includes(requested)) useModel = requested;
        else console.warn(`[chat] 拒绝未在白名单内的模型 "${requested}"，回退到 ${useModel}`);
      }

      // 题目元信息入库（外键锚点，不算"记忆"）
      if (chatReq.problem?.id) upsertProblem(chatReq.problem);
      const memory = getMemory(chatReq.problem.slug);

      log(
        `[chat] 题=${chatReq.problem.title || chatReq.problem.slug} ` +
          `模型=${useModel} 判定=${chatReq.verdict ?? "无"} ` +
          `用例=${chatReq.testcase ? "有" : "无"} ` +
          `代码=${chatReq.code?.length ?? 0}字符 题干=${chatReq.problem.content?.length ?? 0}字符 ` +
          `历史=${chatReq.messages?.length ?? 0}条 记忆=${memory ? `${memory.stuckPoints.length}卡点/${memory.approaches.length}解法` : "无"} ` +
          `问题="${(chatReq.messages?.[chatReq.messages.length - 1]?.content ?? "").slice(0, 40)}"`
      );

      lastPrompt = {
        at: new Date().toISOString(),
        rendered: renderForReview(chatReq, memory, SYSTEM_PROMPT),
      };

      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      const send = (event: string, data: unknown) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      // 客户端断开要中止上游，别浪费 token
      const ac = new AbortController();
      req.on("close", () => ac.abort());

      const t0 = Date.now();
      let full = "";
      let firstByteMs: number | null = null;
      let thinkingChars = 0;
      try {
        for await (const chunk of streamChat(chatReq, memory, SYSTEM_PROMPT, {
          signal: ac.signal,
          model: useModel,
        })) {
          if (firstByteMs === null) firstByteMs = Date.now() - t0;
          if (chunk.kind === "thinking") {
            thinkingChars += chunk.text.length;
            send("thinking", { text: chunk.text });
            continue;
          }
          full += chunk.text;
          send("delta", { text: chunk.text });
        }
        const { text, suggestions } = stripMemoryBlocks(full);
        if (suggestions.length) send("memory_suggestion", { suggestions });
        log(
          `[chat] 完成 首字节=${firstByteMs ?? "?"}ms 总耗时=${Date.now() - t0}ms ` +
            `思考=${thinkingChars}字符 正文=${text.length}字符 记忆建议=${suggestions.length}条`
        );
        send("done", {
          chars: text.length,
          thinkingChars,
          firstByteMs,
          latencyMs: Date.now() - t0,
          model: useModel,
        });
      } catch (e) {
        if (!ac.signal.aborted) send("error", { message: (e as Error).message });
      }
      return res.end();
    }

    json(res, 404, { error: `未知路由 ${req.method} ${path}` });
  } catch (e) {
    const code = e instanceof HttpError ? e.code : 500;
    if (code >= 500) console.error("[500]", e);
    json(res, code, { error: (e as Error).message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  const m = memoryStatus();
  console.log(`\n  better-leetcode 后端已启动`);
  console.log(`  → http://127.0.0.1:${PORT}`);
  console.log(`  默认模型 ${defaultModel() || "（未配置）"}`);
  console.log(`  可选模型 ${allowedModels().join(", ") || "（未配置）"}`);
  console.log(`  API key  ${process.env.LLM_API_KEY ? "已配置" : "⚠️  未配置 —— /chat 会失败"}`);
  console.log(`  记忆库   ${m.ok ? m.path : `⚠️  不可用：${m.error}`}`);
  console.log(`  日志文件 ${LOG_FILE}`);
  console.log(`\n  调试: curl http://127.0.0.1:${PORT}/diag      ← 看扩展汇报了什么`);
  console.log(`        curl http://127.0.0.1:${PORT}/debug/last-prompt\n`);
});
