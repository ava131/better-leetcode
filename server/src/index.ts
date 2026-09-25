#!/usr/bin/env node
/**
 * 本地后端。只绑 127.0.0.1。
 *
 *   POST /chat               SSE 流式对话
 *   GET  /history/list       某题的会话列表
 *   GET  /history/session    某个会话的全部消息
 *   GET  /history/search     在某题里搜对话
 *   GET  /history/stats      总量统计
 *   GET  /health             扩展启动探测
 *   GET  /debug/last-prompt  dump 上一次实际发出的完整 prompt（调 prompt 用）
 *
 * **对话协商**：会话状态（当前这轮的历史 + 代码快照）由扩展持有，每轮全量送上来，
 * 所以后端重启不影响正在进行的对话。而**已发生的对话落库**（history.ts），
 * 换页/重开也能翻回来。
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderMessagesForReview } from "./context.ts";
import { loadEnv, streamChat, stripMemoryBlocks, allowedModels, defaultModel } from "./llm.ts";
import { resetCodeMemory, codeMemoryStats } from "./code-version.ts";
import { resetTurnMemory, turnMemoryStats } from "./turn-memory.ts";
import { planPrompt, planSummary } from "./prompt-plan.ts";
import {
  dbStatus,
  upsertProblem,
  recordSubmission,
  ensureSession,
  appendMessage,
  snapshotOf,
  lastUserMessage,
  listSessions,
  getSessionMessages,
  searchMessages,
  historyStats,
} from "./history.ts";
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
let lastPrompt: { at: string; rendered: string; codeRev?: number; codeMode?: string } | null = null;

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
        db: dbStatus(),
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
      if (path === "/debug/code-memory") {
        return json(res, 200, codeMemoryStats());
      }
      if (path === "/debug/turn-memory") {
        return json(res, 200, turnMemoryStats());
      }
      if (path === "/debug/forget-code") {
        resetCodeMemory();
        resetTurnMemory();
        return json(res, 200, { ok: true, note: "已清空代码版本账本，下一轮会重发全文" });
      }
      if (!lastPrompt) return json(res, 404, { error: "还没有发过请求" });
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      return res.end(
        `# 发送于 ${lastPrompt.at}  代码 rev=${lastPrompt.codeRev ?? "?"} 模式=${lastPrompt.codeMode ?? "?"}\n\n` +
          lastPrompt.rendered
      );
    }

    // ---------- 对话历史 ----------
    if (path === "/history/list" && req.method === "GET") {
      return json(res, 200, { sessions: listSessions(url.searchParams.get("slug") || "") });
    }
    if (path === "/history/session" && req.method === "GET") {
      return json(res, 200, { messages: getSessionMessages(url.searchParams.get("id") || "") });
    }
    if (path === "/history/search" && req.method === "GET") {
      return json(res, 200, {
        results: searchMessages(url.searchParams.get("slug") || "", url.searchParams.get("q") || ""),
      });
    }
    if (path === "/history/stats" && req.method === "GET") {
      return json(res, 200, historyStats());
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

      // ★ 提示词计划**只算一次**，而且必须在 log 之前算好（log 里要报 rev/模式）。
      //   算的时候只读；真正提交要等上游收下 prompt（见 prompt-plan.ts 开头那段注释）。
      const plan = planPrompt(chatReq, SYSTEM_PROMPT);
      const cr = plan.render;

      // 题目元信息入库（外键锚点）
      if (chatReq.problem?.id) upsertProblem(chatReq.problem);

      // ★ 落库：用户这条先写。中途刷新/断线也不至于丢。
      const userMsg = lastUserMessage(chatReq.messages);
      if (chatReq.sessionId && userMsg) {
        ensureSession(chatReq.sessionId, chatReq.problem, userMsg);
        appendMessage({
          sessionId: chatReq.sessionId,
          problemId: chatReq.problem?.id ?? null,
          slug: chatReq.problem?.slug,
          role: "user",
          content: userMsg,
          snapshot: snapshotOf({
            code: chatReq.code, lang: chatReq.lang, verdict: chatReq.verdict,
            testcase: chatReq.testcase, run: chatReq.run,
          }),
        });
      }

      log(
        `[chat] 题=${chatReq.problem.title || chatReq.problem.slug} ` +
          `模型=${useModel} 判定=${chatReq.verdict ?? "无"} ` +
          `用例=${chatReq.testcase ? "有" : "无"} ` +
          `代码=${chatReq.code?.length ?? 0}字符 题干=${chatReq.problem.content?.length ?? 0}字符 ` +
          `历史=${chatReq.messages?.length ?? 0}条 ` +
          `代码rev=${cr.rev}/${cr.mode}` +
          (cr.mode === "diff" ? `(省${Math.round((1 - cr.stats.ratio) * 100)}%)` : "") +
          ` ${planSummary(plan, chatReq)} ` +
          `问题="${(chatReq.messages?.[chatReq.messages.length - 1]?.content ?? "").slice(0, 40)}"`
      );

      lastPrompt = {
        at: new Date().toISOString(),
        rendered: renderMessagesForReview(plan.build(SYSTEM_PROMPT)),
        codeRev: cr.rev,
        codeMode: cr.mode,
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
      let usage: Record<string, number> | null = null;
      try {
        for await (const chunk of streamChat(chatReq, SYSTEM_PROMPT, {
          signal: ac.signal,
          model: useModel,
          codeRender: cr,
          userTexts: plan.texts,
        })) {
          if (firstByteMs === null && chunk.kind !== "usage") {
            firstByteMs = Date.now() - t0;
            // 上游确实收下了这份 prompt，从这一刻起模型"看过"这一轮了
            plan.commit();
          }
          if (chunk.kind === "usage") {
            usage = chunk.usage as Record<string, number>;
            continue; // ★ 千万别落到下面 full += chunk.text
          }
          if (chunk.kind === "thinking") {
            thinkingChars += chunk.text.length;
            send("thinking", { text: chunk.text });
            continue;
          }
          full += chunk.text;
          send("delta", { text: chunk.text });
        }
        // <memory> 那套已拆；保留剥离只是防御（模型偶尔还会吐旧格式）
        const { text } = stripMemoryBlocks(full);
        // ★ 落库：助手这条。空回复不写。
        if (text.trim() && chatReq.sessionId) {
          appendMessage({
            sessionId: chatReq.sessionId,
            problemId: chatReq.problem?.id ?? null,
            slug: chatReq.problem?.slug,
            role: "assistant",
            content: text,
          });
        }
        // ★ 这两行是验证"前缀缓存到底有没有命中"的唯一实测来源
        const u = usage ?? {};
        const hit = u.prompt_cache_hit_tokens,
          miss = u.prompt_cache_miss_tokens;
        const cache =
          hit != null && miss != null
            ? `缓存命中=${Math.round((hit / Math.max(1, hit + miss)) * 100)}%(${hit}+${miss})`
            : "缓存=上游没返回";
        log(
          `[chat] 完成 首字节=${firstByteMs ?? "?"}ms 总耗时=${Date.now() - t0}ms ` +
            `思考=${thinkingChars}字符 正文=${text.length}字符 ` +
            `输入=${u.prompt_tokens ?? "?"} 输出=${u.completion_tokens ?? "?"} ${cache}`
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
  const m = dbStatus();
  console.log(`\n  better-leetcode 后端已启动`);
  console.log(`  → http://127.0.0.1:${PORT}`);
  console.log(`  默认模型 ${defaultModel() || "（未配置）"}`);
  console.log(`  可选模型 ${allowedModels().join(", ") || "（未配置）"}`);
  console.log(`  API key  ${process.env.LLM_API_KEY ? "已配置" : "⚠️  未配置 —— /chat 会失败"}`);
  console.log(`  对话库   ${m.ok ? m.path : `⚠️  不可用：${m.error}`}`);
  console.log(`  日志文件 ${LOG_FILE}`);
  console.log(`\n  调试: curl http://127.0.0.1:${PORT}/diag      ← 看扩展汇报了什么`);
  console.log(`        curl http://127.0.0.1:${PORT}/debug/last-prompt\n`);
});
