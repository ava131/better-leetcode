#!/usr/bin/env node
/**
 * background.js 的单测（在 Node 里跑，用假的 chrome API）。
 *
 *   node extension/test/background.test.mjs
 *
 * 存在理由：`background.js` 是 SSE → port 的转发层，浏览器端的探针脚本用
 * fake 的 `chrome.runtime.connect` 绕过了它，所以它一直没被覆盖。
 * 「上游的 done + 循环结束的兜底 done」发两次就是这么漏出去的 ——
 * content.js 收到两个 done，会把同一条助手回复 push 进会话两次。
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(HERE, "../src/background.js"), "utf8");

let pass = 0,
  fail = 0;
const check = (name, cond, extra) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`, extra === undefined ? "" : JSON.stringify(String(extra).slice(0, 200)));
  }
};

/** 起一份 background.js，拿到它注册的 onConnect 处理器 */
function loadBackground({ sse }) {
  let onConnect = null;
  const chrome = {
    storage: { session: { setAccessLevel() {}, get: async () => ({}), set: async () => {} } },
    runtime: {
      onMessage: { addListener() {} },
      onConnect: { addListener: (fn) => (onConnect = fn) },
    },
  };
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });

  // background.js 是普通脚本，直接在拿得到 chrome 的作用域里跑一遍
  new Function("chrome", "console", SRC)(chrome, { warn() {}, log() {}, error() {} });

  const port = {
    name: "chat",
    _msg: [],
    _disc: [],
    onMessage: { addListener: (fn) => port._msg.push(fn) },
    onDisconnect: { addListener: (fn) => port._disc.push(fn) },
    postMessage: (m) => port._sent.push(m),
    disconnect() {},
    _sent: [],
  };
  onConnect(port);
  const restore = () => {
    globalThis.fetch = prevFetch;
  };
  return { port, restore };
}

const sseOf = (events) =>
  events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");

const run = async (sseText) => {
  const { port, restore } = loadBackground({ sse: sseText });
  await port._msg[0]({ type: "chat", payload: { problem: { slug: "x" }, messages: [] } });
  // 等流读完
  for (let i = 0; i < 60 && !port._sent.some((m) => m.type === "done" || m.type === "error"); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 80)); // 再给兜底 done 一点时间冒出来
  restore();
  return port._sent;
};

console.log("=== 1) 正常一轮：done 只能有一个 ===");
{
  const sent = await run(
    sseOf([
      { event: "thinking", data: { text: "想…" } },
      { event: "delta", data: { text: "正文" } },
      { event: "done", data: { chars: 2, model: "m" } },
    ])
  );
  const dones = sent.filter((m) => m.type === "done");
  check("delta 转发", sent.some((m) => m.type === "delta" && m.text === "正文"));
  check("thinking 转发", sent.some((m) => m.type === "thinking"));
  check("done 只发一次", dones.length === 1, `发了 ${dones.length} 次`);
  check("没有多送兜底 done", !dones.some((d) => d.fallback), JSON.stringify(dones));
}

console.log("\n=== 2) 上游没给 done（流被截断）→ 兜底补一个 ===");
{
  const sent = await run(sseOf([{ event: "delta", data: { text: "半截" } }]));
  const dones = sent.filter((m) => m.type === "done");
  check("补了一个兜底 done", dones.length === 1 && dones[0].fallback === true, JSON.stringify(dones));
}

console.log("\n=== 3) 上游报错 → 转发 error，不补 done ===");
{
  const sent = await run(sseOf([{ event: "error", data: { message: "上游 429" } }]));
  check("转发 error", sent.some((m) => m.type === "error" && m.message === "上游 429"));
  check("没有多余的 done", sent.filter((m) => m.type === "done").length === 0, JSON.stringify(sent));
}

console.log("\n=== 4) 分块到达（一次一个字符）也能正确解析 ===");
{
  const full = sseOf([
    { event: "delta", data: { text: "AB" } },
    { event: "done", data: { chars: 2 } },
  ]);
  const { port, restore } = loadBackground({ sse: full });
  // 让 Response 的流一块块吐
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      start(c) {
        for (const ch of full) c.enqueue(enc.encode(ch));
        c.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  await port._msg[0]({ type: "chat", payload: {} });
  for (let i = 0; i < 80 && !port._sent.some((m) => m.type === "done"); i++)
    await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 80));
  globalThis.fetch = origFetch;
  restore();
  const dones = port._sent.filter((m) => m.type === "done");
  check("分块流也能拿到 delta", port._sent.some((m) => m.type === "delta" && m.text === "AB"));
  check("分块流 done 也只有一次", dones.length === 1, `发了 ${dones.length} 次`);
}

console.log(`\n${"─".repeat(48)}\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
