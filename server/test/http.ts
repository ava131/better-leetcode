#!/usr/bin/env node
/**
 * HTTP 层集成测试：**真的把后端起起来**，打桩上游 LLM，走完整条链路。
 *
 *   node server/test/http.ts
 *
 * 存在理由（这是最贵的一课）：
 *   · ★49 变量用在声明之前 → /chat 全 500，而**所有单测全绿**（单测不跑 HTTP 处理器）
 *   · ★50 buildMessages 的 render 改成必填，cli.ts 忘了传 → 整个 CLI 喂题崩掉，
 *     同样**全绿**（没有任何单测调用 streamChat）
 *   两次都是"真跑一下就炸"。所以这一层必须真的起服务、真的发请求、真的走 SSE。
 *
 * 做法：
 *   1. 起一个**打桩的"上游 LLM"**（就是个 http server，回一段 SSE），
 *      它会把收到的请求体存下来，供断言"模型实际看到了什么"。
 *   2. 用 LLM_BASE_URL 把真后端指向这个桩（`loadEnvFile` 不覆盖已有环境变量，
 *      已实测），再用临时 MEMORY_DB 起在随机端口上。
 *   3. ★ 起完先断言 /health 的 baseUrl 确实是桩 —— 不然这一跑会打到真 API 上花钱。
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const SERVER = join(ROOT, "server/src/index.ts");
const CLI = join(ROOT, "server/src/cli.ts");

let pass = 0,
  fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`, extra === undefined ? "" : JSON.stringify(String(extra).slice(0, 400)));
  }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 随机取一个空闲端口 */
async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      const port = typeof a === "object" && a ? a.port : 0;
      s.close(() => res(port));
    });
  });
}

/** 打桩上游。记下最后一次收到的请求体，供断言。 */
function startStubLlm() {
  let last: unknown = null;
  const answer = "先看你第 7 行：`fast = fast.next.next` 这里没判空。";
  const server = createServer((req, res) => {
    if (req.url === "/last") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(last));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      try {
        last = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        last = null;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const ev = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      ev({ choices: [{ delta: { reasoning_content: "想一下边界。" } }] });
      ev({ choices: [{ delta: { content: answer.slice(0, 10) } }] });
      ev({ choices: [{ delta: { content: answer.slice(10) } }] });
      // 上游最后一帧带用量（真 DeepSeek 也是这么给的）
      ev({
        choices: [],
        usage: {
          prompt_tokens: 1234,
          completion_tokens: 56,
          total_tokens: 1290,
          prompt_cache_hit_tokens: 1000,
          prompt_cache_miss_tokens: 234,
        },
      });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise<{ port: number; url: string; last: () => any; close: () => void }>((res) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      const port = typeof a === "object" && a ? a.port : 0;
      res({ port, url: `http://127.0.0.1:${port}/v1`, last: () => last, close: () => server.close() });
    });
  });
}

const tmp = mkdtempSync(join(tmpdir(), "bl-http-"));
const stub = await startStubLlm();
const port = await freePort();

const env = {
  ...process.env,
  PORT: String(port),
  MEMORY_DB: join(tmp, "t.db"),
  LLM_BASE_URL: stub.url,
  LLM_API_KEY: "test-key-not-real",
  LLM_MODEL: "stub-model",
};

const app = spawn(process.execPath, [SERVER], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
let appLog = "";
app.stdout.on("data", (d) => (appLog += d));
app.stderr.on("data", (d) => (appLog += d));

const base = `http://127.0.0.1:${port}`;
const cleanup = () => {
  try { app.kill(); } catch {}
  stub.close();
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
};

try {
  console.log("=== 0) 起服务 + 安全闸 ===");
  let health: any = null;
  for (let i = 0; i < 60 && !health; i++) {
    await sleep(150);
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) health = await r.json();
    } catch {}
  }
  check("后端起来了", !!health, appLog.slice(-300));
  check("/health 里带 prompt 状态（热重载用）", typeof health?.prompt?.chars === "number", health?.prompt);
  // ★ 安全闸：上游必须是桩，否则后面每一次 /chat 都在花真钱
  if (health?.baseUrl !== stub.url) {
    console.log(`\n✗ 上游没被指到桩上（${health?.baseUrl}）—— 中止，绝不打真 API`);
    cleanup();
    process.exit(1);
  }
  check("上游确实指向打桩服务器（安全闸）", true);

  const problem = {
    id: 141, slug: "linked-list-cycle", title: "141. 环形链表",
    difficulty: "Easy", tags: ["链表"], content: "给你一个链表的头节点 head，判断链表中是否有环。",
  };
  const LONG_CODE = ["class Solution:", "    def hasCycle(self, head):"]
    .concat(Array.from({ length: 30 }, (_, i) => `        step_${i} = ${i}  # 占位，让代码够长以触发增量`))
    .concat(["        return False"])
    .join("\n");

  const chat = async (messages: unknown[], code: string, extra: Record<string, unknown> = {}) => {
    const r = await fetch(`${base}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "http-test", problem, code, lang: "python3", verdict: null, messages, model: "stub-model", ...extra }),
    });
    const text = await r.text();
    const events: Array<{ event: string; data: any }> = [];
    let ev = "";
    for (const line of text.split("\n")) {
      if (line.startsWith("event: ")) ev = line.slice(7).trim();
      else if (line.startsWith("data: ")) {
        try { events.push({ event: ev, data: JSON.parse(line.slice(6)) }); } catch {}
      }
    }
    return { status: r.status, text, events };
  };

  console.log("\n=== 1) 入参校验（畸形请求要 400 而不是 500）===");
  {
    const r = await fetch(`${base}/chat`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "x", code: "y", messages: [{ role: "user", content: "hi" }] }),
    });
    check("缺 problem → 400", r.status === 400, r.status);
    const j = await r.json().catch(() => null);
    check("400 里说明了原因", typeof j?.error === "string" && j.error.includes("problem"), j);
  }
  {
    const r = await fetch(`${base}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://leetcode.cn" },
      body: JSON.stringify({ sessionId: "x", problem, code: "y", messages: [{ role: "user", content: "hi" }] }),
    });
    check("非扩展来源 → 403", r.status === 403, r.status);
  }

  console.log("\n=== 2) 一轮完整对话（走真 SSE）===");
  const turn1 = await chat([{ role: "user", content: "我卡住了" }], LONG_CODE, {
    cursor: { line: 7, column: 9, text: "        step_4 = 4  # 占位，让代码够长以触发增量" },
  });
  check("HTTP 200", turn1.status === 200, turn1.status);
  check("有 thinking 事件", turn1.events.some((e) => e.event === "thinking"), turn1.text.slice(0, 200));
  check("有 delta 事件", turn1.events.some((e) => e.event === "delta"), turn1.text.slice(0, 200));
  const done1 = turn1.events.find((e) => e.event === "done");
  check("有 done 事件", !!done1, turn1.text.slice(-200));
  check("done 里带 usage（侧边栏要显示）", done1?.data?.usage?.prompt_tokens === 1234, done1?.data);
  check("done 里带 http 缓存命中数", done1?.data?.usage?.prompt_cache_hit_tokens === 1000, done1?.data?.usage);
  check("done 里带耗时", typeof done1?.data?.ms === "number", done1?.data);

  console.log("\n=== 3) 模型实际收到什么（读打桩服务器记下来的请求体）===");
  {
    const sent = stub.last();
    const msgs = sent?.messages ?? [];
    check("上游收到 messages 数组", Array.isArray(msgs) && msgs.length >= 2, msgs.length);
    const sys = msgs[0];
    check("第一条是 system", sys?.role === "system", sys?.role);
    check("system 里有题干", String(sys?.content).includes("<problem"), String(sys?.content).slice(-200));
    // 注意：system prompt **本身**就会提到 `<code>` `<judge>` 这些标签名（它得解释
    // 这些东西是什么），所以不能拿"字符串里有没有 <code"当判据 —— 那是假阳性。
    // 真正的判据是：**用户的代码和这一轮的信息不在稳定前缀里**。
    check(
      "★ system 里没有用户的代码（易变块没被塞进稳定前缀）",
      !String(sys?.content).includes("step_0 = 0") && !String(sys?.content).includes('<cursor line="7"'),
      String(sys?.content).slice(-300)
    );
    const last = msgs[msgs.length - 1];
    check("最后一条是 user", last?.role === "user", last?.role);
    check("★ 易变块在最后一条 user 里", String(last?.content).startsWith("<context>"), String(last?.content).slice(0, 120));
    check("第一轮发全文（有 rev=1）", String(last?.content).includes('<code rev="1"'), String(last?.content).slice(0, 300));
    check("带了光标块", String(last?.content).includes("<cursor line=\"7\""), String(last?.content).slice(0, 400));
    check("光标块里说了「不代表他问的就是这一行」", String(last?.content).includes("不代表他问的就是这一行"));
    check("system 里用的是 stub 模型能跑的 prompt（非空）", String(sys?.content).length > 500, String(sys?.content).length);
  }

  console.log("\n=== 4) 第二轮：改一行代码 → 该发增量，而且上一轮的全文还在历史里 ===");
  const code2 = LONG_CODE.replace("step_13 = 13  # 占位", "step_13 = 13  # 改了");
  const turn2 = await chat(
    [
      { role: "user", content: "我卡住了" },
      { role: "assistant", content: "（上一轮的回答）" },
      { role: "user", content: "改了还是不对" },
    ],
    code2
  );
  check("第二轮 200", turn2.status === 200, turn2.status);
  {
    const msgs = stub.last()?.messages ?? [];
    const all = msgs.map((m: any) => m.content).join("\n");
    const turn1User = String(msgs.find((m: any) => m.role === "user")?.content ?? "");
    check("★ 上一轮那条 user 消息被原样复用（turn-memory 生效）",
      turn1User.includes('<code rev="1"') && turn1User.includes("step_13 = 13  # 占位"), turn1User.slice(0, 200));
    const last = String(msgs[msgs.length - 1]?.content ?? "");
    check("★ 这一轮发的是增量（diff_from=1）", last.includes('diff_from="1"'), last.slice(0, 300));
    check("增量比全文短得多", last.length < LONG_CODE.length, `${last.length} vs ${LONG_CODE.length}`);
    check("prompt 里能找到基准（rev 1 的全文）", all.includes('<code rev="1"'), "找不到基准就说明链条断了");
  }

  console.log("\n=== 4.5) 点了「运行」的状态必须进 prompt（否则会被当成'还在自己写'）===");
  {
    // 用户报的那个"什么都不给"：其实就是这句没送到，模型就一直以为他还在自己写。
    const turn3 = await chat(
      [
        { role: "user", content: "我卡住了" },
        { role: "assistant", content: "（回答）" },
        { role: "user", content: "改了还是不对" },
        { role: "assistant", content: "（回答）" },
        { role: "user", content: "现在又有什么问题" },
      ],
      code2,
      {
        run: {
          verdict: "Memory Limit Exceeded", passed: 0, total: 0, failedIndex: null,
          compareResult: "", answers: [], expected: [], dataInput: "[1,2,3]", runtime: "N/A", memory: "N/A",
        },
      }
    );
    check("第三轮 200", turn3.status === 200, turn3.status);
    const last = String((stub.last()?.messages ?? []).slice(-1)[0]?.content ?? "");
    check("★ <run> 块进了本轮上下文", last.includes("<run verdict="), last.slice(0, 300));
    check("★ run 的判定也在（MLE）", last.includes("Memory Limit Exceeded"), last.slice(0, 400));
    check("没提交时 judge 明确说「尚未提交」（两条信息不冲突）", last.includes("尚未提交"), last.slice(0, 400));
  }

  console.log("\n=== 5) 调试端点 ===");
  {
    const cm = await (await fetch(`${base}/debug/code-memory`)).json();
    check("代码版本账本记到 rev 2", cm?.items?.[0]?.rev === 2, cm);
    const tm = await (await fetch(`${base}/debug/turn-memory`)).json();
    // 上面一共问了 3 轮（第 3 轮代码没改，所以 rev 还是 2）
    check("逐轮记忆记到 3 轮", tm?.items?.[0]?.turns === 3, tm);
    const lp = await (await fetch(`${base}/debug/last-prompt`)).text();
    check("/debug/last-prompt 能看完整 prompt", lp.includes("MESSAGES") && lp.includes("<context>"), lp.slice(0, 120));
    check("/debug/last-prompt 标了 rev/模式", /代码 rev=2 模式=(diff|same)/.test(lp), lp.split("\n")[0]);
  }

  console.log("\n=== 6) CLI 真实调用不再崩（★50 就是这条抓出来的）===");
  {
    const fx = join(tmp, "fx.json");
    writeFileSync(
      fx,
      JSON.stringify({
        sessionId: "cli-test", problem, code: LONG_CODE, lang: "python3", verdict: null,
        messages: [{ role: "user", content: "这版哪里错了" }], model: "stub-model",
      })
    );
    const out = await new Promise<{ code: number | null; out: string; err: string }>((res) => {
      const p = spawn(process.execPath, [CLI, fx], { cwd: ROOT, env });
      let o = "", e = "";
      p.stdout.on("data", (d) => (o += d));
      p.stderr.on("data", (d) => (e += d));
      p.on("close", (code) => res({ code, out: o, err: e }));
    });
    check("CLI 退出码 0", out.code === 0, out.err.slice(-300));
    check("CLI 打出了回答正文", out.out.includes("先看你第 7 行"), out.out.slice(-200));
    check("CLI 没报「调用失败」", !out.out.includes("调用失败") && !out.err.includes("调用失败"), out.err.slice(-200));
    check("CLI 打出了用量（含缓存命中）", /缓存命中/.test(out.err), out.err.slice(-200));
  }
} finally {
  cleanup();
}

console.log(`\n${"─".repeat(50)}\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
