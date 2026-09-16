/**
 * LLM provider：OpenAI 兼容接口 + SSE 流式解析。
 * 零依赖 —— 用 fetch 和手写的 SSE 解析。
 */

import { existsSync, readFileSync } from "node:fs";
import { buildMessages } from "./context.ts";
import type { ChatRequest, Memory, MemorySuggestion } from "./types.ts";

export function loadEnv(path: string): void {
  if (existsSync(path)) {
    // Node 24 自带
    try {
      process.loadEnvFile(path);
      return;
    } catch {
      /* 降级到手写解析 */
    }
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
      if (!m) continue;
      const v = m[2].replace(/^["']|["']$/g, "");
      if (!(m[1] in process.env)) process.env[m[1]] = v;
    }
  }
}

export interface StreamOptions {
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  /** 覆盖默认模型（来自 .env 的 LLM_MODEL） */
  model?: string;
}

/** .env 的 LLM_MODEL：默认用哪个 */
export function defaultModel(): string {
  return process.env.LLM_MODEL ?? "";
}

/** .env 的 LLM_MODELS（逗号分隔）：可选列表。没配就退化成只有默认模型 */
export function allowedModels(): string[] {
  const raw = process.env.LLM_MODELS;
  if (raw) {
    const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (list.length) return list;
  }
  const d = defaultModel();
  return d ? [d] : [];
}

/**
 * 流式增量。区分两类：
 *  - thinking：推理模型的思考过程（reasoning_content）。必须转发 —— 否则
 *    用户要盯着空白面板几十秒（实测 pro 模型首字节 77s）。
 *  - content：正文
 */
export interface StreamChunk {
  kind: "thinking" | "content";
  text: string;
}

/** 流式对话 */
export async function* streamChat(
  req: ChatRequest,
  memory: Memory | null | undefined,
  systemPrompt: string,
  opts: StreamOptions = {}
): AsyncGenerator<StreamChunk, void, unknown> {
  const baseUrl = (process.env.LLM_BASE_URL ?? "").replace(/\/+$/, "");
  const apiKey = process.env.LLM_API_KEY ?? "";
  const model = opts.model || process.env.LLM_MODEL || "";

  if (!baseUrl) throw new Error("未设置 LLM_BASE_URL");
  if (!apiKey) throw new Error("未设置 LLM_API_KEY");
  if (!model) throw new Error("未设置 LLM_MODEL");

  const messages = buildMessages(req, memory, systemPrompt);

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      temperature: opts.temperature ?? 0.3,
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
    }),
    signal: opts.signal,
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(`上游 ${res.status} ${res.statusText} ${detail.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    // SSE：事件以空行分隔
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1 || (idx = buf.indexOf("\r\n\r\n")) !== -1) {
      const isCrlf = buf.indexOf("\r\n\r\n") === idx && idx !== -1;
      const sep = isCrlf ? 4 : 2;
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + sep);

      for (const line of chunk.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const j = JSON.parse(payload);
          const delta = j.choices?.[0]?.delta;
          if (!delta) continue;
          // 推理模型的思考过程
          if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
            yield { kind: "thinking", text: delta.reasoning_content };
          }
          if (typeof delta.content === "string" && delta.content) {
            yield { kind: "content", text: delta.content };
          }
        } catch {
          /* 忽略无法解析的行 */
        }
      }
    }
  }
}

const MEMORY_RE = /<memory>\s*([\s\S]*?)\s*<\/memory>/g;

/** 从模型输出里剥离 <memory> 段，返回正文 + 结构化建议 */
export function stripMemoryBlocks(text: string): {
  text: string;
  suggestions: MemorySuggestion[];
} {
  const suggestions: MemorySuggestion[] = [];
  const cleaned = text.replace(MEMORY_RE, (_, body) => {
    try {
      const j = JSON.parse(String(body).trim());
      if (j && (j.kind === "stuck_point" || j.kind === "approach")) suggestions.push(j);
    } catch {
      /* 不是合法 JSON 就丢弃 */
    }
    return "";
  });
  return { text: cleaned.replace(/\n{3,}/g, "\n\n").trim(), suggestions };
}
