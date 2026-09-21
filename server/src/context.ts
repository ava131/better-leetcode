/**
 * 上下文组装：把扩展传来的快照拼成给模型看的 <context> 块。
 *
 * 设计原则（见 docs/TECH-DESIGN.md §4.4）：
 *  - 代码原样保留，不 trim 缩进
 *  - 题干已在扩展侧/此处转成 markdown
 *  - 失败用例过长时截断并显式标注
 *  - 记忆只注入当前题，且为空时不产生空标签
 */

import type { ChatRequest } from "./types.ts";

/** 失败用例输入超过这个长度就截断（力扣隐藏用例可能上万字符） */
const TESTCASE_MAX = 2000;

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncate(s: string, max = TESTCASE_MAX): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…（已截断，原长 ${s.length} 字符）`;
}

export function buildContextBlock(req: ChatRequest): string {
  const parts: string[] = [];

  // ---- 题干 ----
  const p = req.problem;
  const meta: string[] = [];
  if (p.difficulty) meta.push(`难度 ${p.difficulty}`);
  if (p.tags?.length) meta.push(`标签 ${p.tags.join(" / ")}`);

  parts.push(
    [
      `<problem id="${p.id}" slug="${xmlEscape(p.slug)}">`,
      `<title>${xmlEscape(p.title)}</title>`,
      meta.length ? `<meta>${xmlEscape(meta.join(" · "))}</meta>` : "",
      `<content>`,
      p.content ?? "（题干未取到）",
      `</content>`,
      `</problem>`,
    ]
      .filter(Boolean)
      .join("\n")
  );

  // ---- 代码（整份，原样） ----
  parts.push(`<code lang="${xmlEscape(req.lang)}">\n${req.code}\n</code>`);

  // ---- 判题结果 ----
  if (req.verdict) {
    const attrs = [`verdict="${xmlEscape(req.verdict)}"`];
    if (req.passed != null) attrs.push(`passed="${req.passed}"`);
    if (req.total != null) attrs.push(`total="${req.total}"`);

    const inner: string[] = [];
    if (req.testcase) {
      inner.push(
        `<failed_case>`,
        `<input>${xmlEscape(truncate(req.testcase.input))}</input>`,
        `<your_output>${xmlEscape(truncate(req.testcase.output, 500))}</your_output>`,
        `<expected>${xmlEscape(truncate(req.testcase.expected, 500))}</expected>`,
        `</failed_case>`
      );
    }
    if (req.runtimeError) {
      inner.push(`<runtime_error>${xmlEscape(truncate(req.runtimeError, 1500))}</runtime_error>`);
    }
    if (!inner.length) {
      inner.push(`<note>这次提交没有失败用例（可能是编译错误或全部通过）</note>`);
    }

    parts.push([`<judge ${attrs.join(" ")}>`, ...inner, `</judge>`].join("\n"));
  } else {
    parts.push(`<judge>（尚未提交，没有判题结果）</judge>`);
  }

  // ---- 运行结果（题目自带示例用例） ----
  if (req.run) {
    const r = req.run;
    const attrs = [`verdict="${xmlEscape(r.verdict ?? "未知")}"`, `passed="${r.passed}"`, `total="${r.total}"`];
    if (r.failedIndex) attrs.push(`failed_case="${r.failedIndex}"`);

    const inner: string[] = [
      `<note>用户点的是「运行」，不是「提交」—— 只跑了题目**自带的示例用例**。`,
      `⚠️ **运行通过不代表提交能通过**：示例用例通常很宽松，覆盖不到边界。</note>`,
    ];

    const cmp = r.compareResult ?? "";
    const cases: string[] = [];
    for (let i = 0; i < r.total; i++) {
      const ok = cmp[i] !== "0";
      const mine = r.answers?.[i] ?? "";
      const want = r.expected?.[i] ?? "";
      cases.push(
        `    <case n="${i + 1}" ok="${ok}"><your_output>${xmlEscape(truncate(mine, 300))}</your_output>` +
          `<expected>${xmlEscape(truncate(want, 300))}</expected></case>`
      );
    }
    if (cases.length) {
      inner.push(`  <testcases compare="${xmlEscape(cmp)}">`, ...cases, `  </testcases>`);
    }

    if (r.dataInput) {
      inner.push(
        `  <data_input>`,
        `    <note>全部用例的输入按顺序拼接。力扣不返回切分点，所以哪几行属于第几个用例要自己判断。</note>`,
        xmlEscape(truncate(r.dataInput, 1200)),
        `  </data_input>`
      );
    }
    if (r.runtimeError) inner.push(`  <runtime_error>${xmlEscape(truncate(r.runtimeError, 1200))}</runtime_error>`);
    if (r.compileError) inner.push(`  <compile_error>${xmlEscape(truncate(r.compileError, 1200))}</compile_error>`);
    if (r.runtime) inner.push(`  <perf runtime="${xmlEscape(r.runtime)}" memory="${xmlEscape(r.memory ?? "")}" />`);

    parts.push([`<run ${attrs.join(" ")}>`, ...inner, `</run>`].join("\n"));
  }

  // ---- 会话内的历史代码（不落库，只在同题多次提交时存在） ----
  const hist = (req.codeHistory ?? []).filter((h) => h.code !== req.code);
  if (hist.length) {
    const blocks = hist.map((h, i) => {
      const v = h.verdict ?? "未知";
      const tc = h.testcase
        ? `\n  <failed_case>\n    <input>${xmlEscape(truncate(h.testcase.input, 600))}</input>\n    <your_output>${xmlEscape(truncate(h.testcase.output, 300))}</your_output>\n    <expected>${xmlEscape(truncate(h.testcase.expected, 300))}</expected>\n  </failed_case>`
        : "";
      return `<version n="${i + 1}" verdict="${xmlEscape(v)}">\n${h.code}${tc}\n</version>`;
    });
    parts.push(
      [
        `<code_history>`,
        `<note>用户在这道题上之前提交过的版本，最近的在前。当前代码是上面的 <code>。`,
        `如果用户问"刚才那版为什么错"，指的就是这里。</note>`,
        ...blocks,
        `</code_history>`,
      ].join("\n")
    );
  }

  return `<context>\n${parts.join("\n\n")}\n</context>`;
}

/** 组装最终发给模型的消息数组 */
export function buildMessages(
  req: ChatRequest,
  systemPrompt: string
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const contextBlock = buildContextBlock(req);

  // 对话历史里若有 system 标记（如提交分隔），保持 system 角色
  const history = (req.messages ?? []).filter((m) => m.role !== "system" || m.content.startsWith("────"));

  return [
    { role: "system", content: `${systemPrompt}\n\n${contextBlock}` },
    ...history.map((m) => ({ role: m.role, content: m.content })),
  ];
}

/** 把组装结果渲染成便于人读的文本（--dry-run 用） */
export function renderForReview(req: ChatRequest, systemPrompt: string): string {
  const msgs = buildMessages(req, systemPrompt);
  const out: string[] = [];
  out.push("╔" + "═".repeat(78) + "╗");
  out.push("║ " + "MESSAGES（实际发给模型的完整内容）".padEnd(76) + " ║");
  out.push("╚" + "═".repeat(78) + "╝");
  for (const m of msgs) {
    out.push(`\n┌─── role: ${m.role} ${"─".repeat(Math.max(0, 66 - m.role.length))}`);
    out.push(m.content);
    out.push(`└${"─".repeat(76)}`);
  }
  return out.join("\n");
}
