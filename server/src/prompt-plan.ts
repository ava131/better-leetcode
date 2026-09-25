/**
 * 一轮请求的"提示词计划"：把三件事绑在一起，并且**只算一次**。
 *
 *   1. 历史替换表（turn-memory）—— 让 prompt 保持 append-only，前缀可命中
 *   2. 代码怎么发（code-version）—— 全文 / 增量 / 没变
 *   3. 真正拼出消息数组（context）
 *
 * ★ 为什么非要有这个中间层：`buildMessages` 每次请求会被调用**两次**
 *   （`/debug/last-prompt` 那次 + 真正流式那次）。如果让 `planCode` 藏进
 *   `buildMessages` 里顺手推进版本号，一次请求就会推进两次，下一轮的增量
 *   基准全是错的。所以：算计划是一次纯操作，提交（commit）显式做，
 *   而且只在**上游确实收下 prompt** 之后做。
 */

import { buildMessages, filterHistory } from "./context.ts";
import { planCode, type CodeRender } from "./code-version.ts";
import { planTurns, userContents } from "./turn-memory.ts";
import type { ChatMessage, ChatRequest } from "./types.ts";

export interface PromptPlan {
  render: CodeRender;
  /** 历史替换表（给 buildMessages 用） */
  texts: (string | null)[];
  /** 历史链条是否完整；不完整就不能发增量 */
  chainOk: boolean;
  /** 拼出消息数组。纯函数，可重复调用（结果会被缓存） */
  build(systemPrompt: string): Array<{ role: "system" | "user" | "assistant"; content: string }>;
  /** 上游确认收到 prompt 之后调用：记下代码版本 + 这一轮实际发出去的文本 */
  commit(): void;
}

export function planPrompt(req: ChatRequest, systemPrompt: string): PromptPlan {
  const sessionId = req.sessionId ?? "";
  const history: ChatMessage[] = filterHistory(req.messages);

  const turns = planTurns(sessionId, history);
  // 最后一条必须是 user 消息（本轮问题），否则这一轮的 <context> 是"单独补发的"，
  // 它不在 req.messages 里，下一轮就会凭空消失 → 链条必然断。
  const last = history.length ? history[history.length - 1].role : null;
  const chainOk = turns.chainOk && last === "user";

  const codePlan = planCode(sessionId, req.code ?? "", req.lang ?? "", { chainOk });

  let built: Array<{ role: "system" | "user" | "assistant"; content: string }> | null = null;
  const build = (sys: string) => (built ??= buildMessages(req, sys, codePlan.render, turns.texts));

  return {
    render: codePlan.render,
    texts: turns.texts,
    chainOk,
    build,
    commit() {
      const msgs = build(systemPrompt);
      turns.commit(msgs.filter((m) => m.role === "user").map((m) => m.content));
      codePlan.commit();
    },
  };
}

/** 便于观察：这一轮"模型看到的"和"客户端原始历史"差多少 */
export function planSummary(plan: PromptPlan, req: ChatRequest): string {
  const raws = userContents(filterHistory(req.messages));
  const reused = plan.texts.filter((t) => t !== null).length;
  return (
    `rev=${plan.render.rev} 模式=${plan.render.mode}(${plan.render.reason}) ` +
    `链条=${plan.chainOk ? "完整" : "断了"} ` +
    `历史user=${raws.length}条 复用=${reused}条`
  );
}
