/**
 * 逐轮记住"模型到底看过什么"。**这是让"发增量"成立的前提。**
 *
 * 问题：对话历史是从扩展传来的 `req.messages` 重建的，而那里存的是**用户的原话**，
 * 不含我们拼进去的 `<context>` 块。于是上一轮那段（含当时的代码）在新一轮的 prompt 里
 * **整个消失**。如果上一轮发的是增量，模型手上就只剩一个"相对某版"的差异，
 * 却找不到那一版 —— 它会开始猜代码，这比多花 token 严重得多。
 *
 * 解法：把上一轮**实际发出去**的每个 user 消息文本记下来，下一轮原样放回去。
 * 这样 prompt 就是严格 append-only 的：
 *
 *   第 k 轮 = [system][t1][a1]…[tk]         ← 上一轮的 prompt 是这一轮的**真前缀**
 *   第 k+1 轮 = [system][t1][a1]…[tk][ak][tk+1]
 *
 * 两个好处：① 前缀缓存命中率最大化；② 增量链完整，模型永远能自己还原当前代码。
 *
 * 对不上怎么办（服务重启、清了对话、从历史会话点"继续"、手改过历史）：
 * 位置或原话对不上就**判定链条断了**，这一轮老实发全文。代价是偶尔多花一次钱，
 * 换来的是"模型绝不会拿着对不上的增量硬猜"。
 */

import type { ChatMessage } from "./types.ts";

/** 一个会话最多记多少轮（超了丢最老的，链条会断一次，然后重新接上） */
const MAX_TURNS = 400;

interface Snapshot {
  /** 每个 user 消息的**原话**（用来做位置校验） */
  qs: string[];
  /** 对应的**实际发出**文本（含 <context> 块） */
  texts: string[];
  at: number;
}

const store = new Map<string, Snapshot>();

export interface TurnPlan {
  /**
   * 与 `req.messages` 里 user 消息一一对应。有记录就给出记录里的文本，
   * 没有（或就是本轮这条）给 null —— null 表示"必须现场渲染"。
   */
  texts: (string | null)[];
  /**
   * 历史里每一条 user 消息都有记录。
   * 只有它是 true，才允许对代码发增量（因为增量需要一个还看得见的基准）。
   */
  chainOk: boolean;
  /** 上游收下 prompt 之后调用：把这一轮最终发出去的文本记下来 */
  commit(texts: string[]): void;
}

/** 从（已按角色过滤过的）消息里按顺序取出 user 消息的原文 */
export function userContents(messages: ChatMessage[]): string[] {
  return messages.filter((m) => m.role === "user").map((m) => m.content);
}

export function planTurns(sessionId: string, messages: ChatMessage[]): TurnPlan {
  const qs = userContents(messages);
  const snap = sessionId ? store.get(sessionId) ?? null : null;

  // 最后一条是本轮问题，永远现场渲染；历史能对上多少就替换多少
  // （对上一部分也值：前半段照样能命中缓存，不必因为后半段对不上就全丢）
  const texts: (string | null)[] = qs.map(() => null);
  let matched = 0;
  if (sessionId && snap) {
    // ★ 正常情况是"记录比这一轮短"（历史每轮长一条），所以上界取两者的较小值。
    //   反过来（记录更长）说明客户端把对话截短了，能对上前多少条就复用多少条。
    const upto = Math.min(qs.length - 1, snap.qs.length);
    for (let i = 0; i < upto; i++) {
      if (snap.qs[i] !== qs[i] || !snap.texts[i]) break;
      texts[i] = snap.texts[i];
      matched++;
    }
  }
  // 历史每一条都对上，链条才算完整 —— 只有这时才允许发增量
  const chainOk = !!sessionId && qs.length > 0 && matched === qs.length - 1;

  return {
    texts,
    chainOk,
    commit(finalTexts: string[]) {
      if (!sessionId) return;
      const q = qs.slice();
      // 对齐到原始 user 消息条数（buildMessages 万一补了一条合成的，不参与下一轮的位置校验）
      const t = finalTexts.slice(0, q.length);
      if (q.length > MAX_TURNS) {
        q.splice(0, q.length - MAX_TURNS);
        t.splice(0, t.length - MAX_TURNS);
      }
      store.set(sessionId, { qs: q, texts: t, at: Date.now() });
      pruneTurnMemory();
    },
  };
}

export function turnMemoryStats() {
  return {
    sessions: store.size,
    items: [...store.entries()].map(([k, v]) => ({ session: k, turns: v.qs.length, at: v.at })),
  };
}

export function resetTurnMemory(sessionId?: string): void {
  if (sessionId) store.delete(sessionId);
  else store.clear();
}

/** 上限之外丢最久没动的会话 */
export function pruneTurnMemory(max = 64): number {
  if (store.size <= max) return 0;
  const sorted = [...store.entries()].sort((a, b) => a[1].at - b[1].at);
  const drop = sorted.slice(0, store.size - max);
  for (const [k] of drop) store.delete(k);
  return drop.length;
}
