#!/usr/bin/env node
/**
 * 抓取力扣页面自己发出的 GraphQL 请求与响应。
 *
 * 用途：**力扣改 schema 时用它重新确认字段**。
 * docs/R0-captured-api.md 里的字段名就是这么拿到的。
 *
 *   node tools/probe/capture-api.mjs [题目slug]
 */

import { open, sleep } from "./cdp.mjs";

const slug = process.argv[2] ?? "linked-list-cycle";

const cdp = await open();
await cdp.send("Network.enable");

const reqs = new Map();
const captured = [];

cdp.ws.addEventListener("message", async (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === "Network.requestWillBeSent") {
    reqs.set(m.params.requestId, {
      url: m.params.request.url,
      postData: m.params.request.postData,
    });
  }
  if (m.method === "Network.loadingFinished") {
    const info = reqs.get(m.params.requestId);
    if (!info || !/graphql/.test(info.url)) return;
    try {
      const body = await cdp.send("Network.getResponseBody", { requestId: m.params.requestId });
      captured.push({ postData: info.postData, response: body.body });
    } catch {}
  }
});

console.log(`打开 https://leetcode.cn/problems/${slug}/ …`);
await cdp.navigate(`https://leetcode.cn/problems/${slug}/`);
await sleep(9000);

console.log(`\n捕获到 ${captured.length} 个 GraphQL 交互\n${"─".repeat(70)}`);

const seen = new Set();
for (const g of captured) {
  let op = "?";
  try {
    op = JSON.parse(g.postData).operationName ?? "?";
  } catch {}
  if (seen.has(op)) continue; // 同一 operation 只打一次
  seen.add(op);

  console.log(`\n### ${op}`);
  try {
    const q = JSON.parse(g.postData).query;
    console.log(q.trim().split("\n").map((l) => "    " + l).join("\n"));
  } catch {
    console.log("    (无法解析 query)");
  }
  console.log("  响应:");
  console.log("    " + String(g.response).slice(0, 700));
}

console.log(`\n${"─".repeat(70)}`);
console.log("关心的字段（比对 docs/R0-captured-api.md）：");
for (const f of [
  "outputDetail",
  "codeOutput",
  "expectedOutput",
  "lastTestcase",
  "passedTestCaseCnt",
  "statusDisplay",
  "submissionDetail",
  "submissionAnalysis",
]) {
  const hit = captured.some((g) => g.response.includes(f) || (g.postData ?? "").includes(f));
  console.log(`  ${hit ? "✓" : "✗"} ${f}`);
}

process.exit(0);
