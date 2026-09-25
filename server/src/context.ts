/**
 * 上下文组装。**这里决定了前缀缓存能不能命中**，改动前先读 docs/TECH-DESIGN.md §4.6。
 *
 * 排布原则（v0.8 起）：
 *
 *   [system]  系统提示词 + 题干              ← 换题才变（稳定，越靠前越值钱）
 *   [user]    ……历史对话……                  ← 只追加，永不改写
 *   [user]    <context>代码/判题/运行</context> + 本轮问题   ← 易变，全部堆在末尾
 *
 * ★ 为什么要这么排：prefix 缓存是"从头逐 token 比对，第一个不一致的地方之后
 *   全部作废"。以前代码和判题被塞在 system 消息里（历史前面），于是**你每改一行
 *   代码，整段历史都要按全价重算**。实测 9 轮会话输入 46.5k tokens，命中率只有
 *   70%，挪到末尾后到 96%。详见 §4.6 的实测数据。
 *
 * 其它既有原则：
 *  - 代码原样保留，不 trim 缩进（行尾统一 \n 由 code-version.ts 负责）
 *  - 题干已在扩展侧/此处转成 markdown
 *  - 失败用例过长时截断并显式标注
 */

import type { ChatMessage, ChatRequest } from "./types.ts";
import type { CodeRender } from "./code-version.ts";

/** 失败用例输入超过这个长度就截断（力扣隐藏用例可能上万字符） */
const TESTCASE_MAX = 2000;

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncate(s: string, max = TESTCASE_MAX): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…（已截断，原长 ${s.length} 字符）`;
}

/** 稳定块：题干。换题才变，所以放最前面 */
export function buildStableBlock(req: ChatRequest): string {
  const p = req.problem;
  const meta: string[] = [];
  if (p.difficulty) meta.push(`难度 ${p.difficulty}`);
  if (p.tags?.length) meta.push(`标签 ${p.tags.join(" / ")}`);

  return [
    `<problem id="${p.id}" slug="${xmlEscape(p.slug)}">`,
    `<title>${xmlEscape(p.title)}</title>`,
    meta.length ? `<meta>${xmlEscape(meta.join(" · "))}</meta>` : "",
    `<content>`,
    p.content ?? "（题干未取到）",
    `</content>`,
    `</problem>`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** 代码块。按照 render.mode 决定发全文、增量、还是"没变" */
export function buildCodeBlock(render: CodeRender): string {
  const lang = xmlEscape(render.lang);

  if (render.mode === "same") {
    return [
      `<code rev="${render.rev}" lang="${lang}" unchanged="true">`,
      `（代码没变，还是 rev ${render.rev} —— 你上面已经看过全文了。需要重发就说一声。）`,
      `</code>`,
    ].join("\n");
  }

  if (render.mode === "diff") {
    return [
      `<code rev="${render.rev}" lang="${lang}" diff_from="${render.diffFrom}" format="unified-diff">`,
      `<note>这是相对 rev ${render.diffFrom} 的**增量**（unified diff；@@ 那段是行号，`,
      `空格开头=没改、- =删掉、+ =新增）。rev ${render.diffFrom} 的全文就在你上面的对话里，`,
      `自己对照着还原当前代码。**如果你在上面找不到那版全文，不要猜，直接说"把代码全文发我"。**</note>`,
      render.body,
      `</code>`,
    ].join("\n");
  }

  // ★ 代码**不转义**（跟改动前的行为一致）：转义会把 `i < n` 变成 `i &lt; n`，
  //   模型看到的就是被毁掉的代码。风险是代码里有 `</code>` 会破坏框，
  //   但这是改动前就有的取舍，不在这次改动的范围里。
  return [`<code rev="${render.rev}" lang="${lang}">`, render.body, `</code>`].join("\n");
}

/** 判题结果（提交）+ 运行结果（示例用例） */
export function buildJudgeBlock(req: ChatRequest): string {
  const parts: string[] = [];

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

  return parts.join("\n\n");
}

/** 会话内的历史代码（不落库，只在同题多次提交时存在） */
export function buildCodeHistoryBlock(req: ChatRequest): string | null {
  const hist = (req.codeHistory ?? []).filter((h) => h.code !== req.code);
  if (!hist.length) return null;

  const blocks = hist.map((h, i) => {
    const v = h.verdict ?? "未知";
    const tc = h.testcase
      ? `\n  <failed_case>\n    <input>${xmlEscape(truncate(h.testcase.input, 600))}</input>\n    <your_output>${xmlEscape(truncate(h.testcase.output, 300))}</your_output>\n    <expected>${xmlEscape(truncate(h.testcase.expected, 300))}</expected>\n  </failed_case>`
      : "";
    return `<version n="${i + 1}" verdict="${xmlEscape(v)}">\n${h.code}${tc}\n</version>`;
  });

  return [
    `<code_history>`,
    `<note>用户在这道题上之前提交过的版本，最近的在前。当前代码是上面的 <code>。`,
    `如果用户问"刚才那版为什么错"，指的就是这里。</note>`,
    ...blocks,
    `</code_history>`,
  ].join("\n");
}

/**
 * 易变块：代码 + 判题 + 运行 + 历史代码。
 * **只放在最后一条 user 消息里**，绝不放到 system 或历史前面。
 */
export function buildVolatileBlock(req: ChatRequest, render: CodeRender): string {
  const parts = [buildCodeBlock(render), buildJudgeBlock(req)];
  const hist = buildCodeHistoryBlock(req);
  if (hist) parts.push(hist);
  return parts.join("\n\n");
}

/** 对话历史里若有 system 标记（如提交分隔），保持 system 角色 */
export function filterHistory(messages: ChatMessage[] | undefined): ChatMessage[] {
  return (messages ?? []).filter((m) => m.role !== "system" || m.content.startsWith("────"));
}

/** 本轮这条 user 消息最终发出去的文本（含易变块） */
export function currentTurnText(req: ChatRequest, render: CodeRender): string {
  const volatile = `<context>\n${buildVolatileBlock(req, render)}\n</context>`;
  const q = lastUserContent(req);
  return q === null ? volatile : `${volatile}\n\n${q}`;
}

/** 历史里最后一条 user 消息的原文（没有就是 null） */
function lastUserContent(req: ChatRequest): string | null {
  const h = filterHistory(req.messages);
  for (let i = h.length - 1; i >= 0; i--) if (h[i].role === "user") return h[i].content;
  return null;
}

/**
 * 组装最终发给模型的消息数组。
 *
 * `userTexts` 是 turn-memory 给的历史替换表：第 i 条 user 消息原本**实际发出去**
 * 的文本（含当时的 `<context>`）。有就原样放回去，让 prompt 保持 append-only。
 */
export function buildMessages(
  req: ChatRequest,
  systemPrompt: string,
  render: CodeRender,
  userTexts: (string | null)[] = []
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const stable = buildStableBlock(req);
  const volatile = `<context>\n${buildVolatileBlock(req, render)}\n</context>`;
  const turnText = currentTurnText(req, render);

  const history: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
  let ui = 0;
  for (const m of filterHistory(req.messages)) {
    if (m.role === "user") {
      // 历史 = 复用当时发出去的那份；本轮最后一条 = 现场渲染
      history.push({ role: "user", content: userTexts[ui] ?? m.content });
      ui++;
    } else {
      history.push({ role: m.role, content: m.content });
    }
  }

  // ★ 易变块塞进**最后一条 user 消息**（也就是本轮问题）：
  //   这样前面所有内容（提示词+题干+历史）构成一个稳定的、可命中的前缀。
  //   注意：这里必须是"本轮最后一条 user 消息"，不能是"数组最后一条"——
  //   提交标记是 system 角色，可能跟在问题后面。
  let replaced = false;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "user") {
      history[i] = { role: "user", content: turnText };
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    // 兜底：没有待回答的问题（例如只提交了一次就触发），单独发一块
    history.push({ role: "user", content: volatile });
  }

  return [{ role: "system", content: `${systemPrompt}\n\n${stable}` }, ...history];
}

/** 把**已经拼好的**消息渲染成便于人读的文本（--dry-run / /debug/last-prompt 用） */
export function renderMessagesForReview(
  msgs: Array<{ role: "system" | "user" | "assistant"; content: string }>
): string {
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
