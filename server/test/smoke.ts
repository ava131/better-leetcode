/**
 * 核心模块冒烟测试：不起 HTTP，直接验证。
 *   MEMORY_DB=./.dev-memory.db node test/smoke.ts
 *
 * 对话历史那一层在 test/history.ts 里单独测。
 */
import { htmlToMarkdown } from "../src/html.ts";
import { buildMessages } from "../src/context.ts";
import { loadSystemPrompt, clearPromptCache } from "../src/prompt.ts";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripMemoryBlocks } from "../src/llm.ts";

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`, extra ?? "");
  }
};

console.log("=== 1) HTML → markdown ===");
const html = `<p>给你一个数组 <code>nums</code>，返回 <strong>两数之和</strong>。</p><ul><li>范围 <code>2 &lt;= nums.length &lt;= 10<sup>4</sup></code></li><li>只对应一个答案</li></ul><p>&nbsp;</p><pre>输入: nums = [2,7]</pre>`;
const md = htmlToMarkdown(html);
console.log(md.split("\n").map((l) => "    " + l).join("\n"));
check("去掉了所有标签", !/<[a-z][^>]*>/i.test(md));
check("实体已解码（&lt; → <）", md.includes("2 <= nums.length"));
check("上标已转（10^4）", md.includes("10^4"), md);
check("保留了代码块", md.includes("```"), md);
check("压缩比合理", md.length < html.length, `${md.length} vs ${html.length}`);

console.log("\n=== 2) <memory> 防御性剥离 ===");
// prompt 里已经不再要求模型输出这个了；留着剥离只是防旧格式漏出来
const out = `你的比较放在移动之后了。\n\n<memory>{"kind":"stuck_point","desc":"比较时机"}</memory>`;
const r = stripMemoryBlocks(out);
console.log("    正文: " + JSON.stringify(r.text));
check("正文不含 <memory>", !r.text.includes("<memory>"));
check("正文保留", r.text.includes("比较放在移动之后"));

console.log("\n=== 3) 非法 <memory> 不崩 ===");
const bad = stripMemoryBlocks(`正文\n<memory>这不是 JSON</memory>`);
check("坏 JSON 被丢弃且正文保留", bad.text.includes("正文"));

console.log("\n=== 4) 漏传 render 不许崩（v0.8 真的崩过）===");
{
  // cli.ts 的真实调用路径忘了传 codeRender，buildMessages 里读 render.lang 直接抛
  // `Cannot read properties of undefined (reading 'lang')` —— 而当时所有单测都不调用
  // streamChat，所以全绿。这条守住"漏传最多多发点 token，不许崩"。
  const req = {
    sessionId: "s",
    problem: { id: 1, slug: "x", title: "t", content: "c" },
    code: "print(1)",
    lang: "python3",
    messages: [{ role: "user", content: "hi" }],
  } as unknown as Parameters<typeof buildMessages>[0];
  let msgs: ReturnType<typeof buildMessages> | null = null;
  let err = "";
  try {
    msgs = buildMessages(req, "SYS");
  } catch (e) {
    err = (e as Error).message;
  }
  check("不传 render 不抛异常", msgs !== null, err);
  const all = (msgs ?? []).map((m) => m.content).join("\n");
  check("兜底成了全文", all.includes("<code") && all.includes("print(1)"), all.slice(-160));
}

console.log("\n=== 5) prompt 热重载（改 prompt 不用重启后端）===");
{
  const dir = mkdtempSync(join(tmpdir(), "bl-prompt-"));
  const f = join(dir, "system.md");
  clearPromptCache(f);

  writeFileSync(f, "第一版");
  const a = loadSystemPrompt(f);
  const b = loadSystemPrompt(f);
  check("第一次读出第一版", a === "第一版", a);
  check("内容没变时走缓存（同一个值）", b === a, b);

  writeFileSync(f, "第二版，更长一点");
  // 同一毫秒内写完 mtime 可能没变，显式推一下（真机上编辑器保存不会这么快）
  const t = new Date(Date.now() + 2000);
  utimesSync(f, t, t);
  const c = loadSystemPrompt(f);
  check("文件一改，下一个请求就读到新版（不用重启）", c === "第二版，更长一点", c);

  // 读不到文件时不能崩，也不能把 prompt 变成空字符串
  rmSync(f);
  let d = "";
  let err = "";
  try {
    d = loadSystemPrompt(f);
  } catch (e) {
    err = (e as Error).message;
  }
  check("文件被挪走时不抛异常", err === "", err);
  check("读不到就继续用上一份", d === "第二版，更长一点", d);

  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${"─".repeat(50)}\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
