/**
 * 代码版本记账：决定这一轮把当前代码**怎么发给模型**（全文 / 增量 / 没变）。
 *
 * 存在理由：代码是每轮都在变的唯一大块内容。发全文的话，它永远落在
 * "前缀缓存必然 miss 的尾巴"上，每轮全价付一次；发增量通常只要几十个字符。
 * 详见 docs/TECH-DESIGN.md §4.5 与 §4.6。
 *
 * ★ 三个安全阀（宁可贵一点，也不能让模型看错代码）：
 *   1. 没有上一版 / 换了语言 / 改动太大 → 发全文；
 *   2. 每 FULL_EVERY 版强制发一次全文，让模型有机会重新对齐；
 *   3. **只有上游真的收下了这份 prompt 才提交版本号**（见 commit）。
 *      如果这一轮请求失败/被中止，模型没看到这版代码，那么下一轮必须还拿
 *      上一版做基准 —— 否则它会拿到一份"从它没见过的版本改过来"的增量。
 */

import { unifiedDiff } from "./diff.ts";

export type CodeMode = "full" | "diff" | "same";

/**
 * 低于这个长度就别发增量了。
 *
 * 为什么是 600：一个改动块的 diff ≈ 8 行（改 1 行 + 上下各 3 行上下文），
 * 约 240 字符。9 行的题解全文才 250 字符 —— 实测 diff 会是全文的 95%，
 * 不但没省，还让模型多一层还原成本。600 字符（约 20 行）以上才开始划算。
 */
const DIFF_MIN_CHARS = 600;
/** diff 超过全文这个比例就发全文（说明这次几乎重写） */
const DIFF_MAX_RATIO = 0.5;
/** 每这么多版强制重发一次全文 */
const FULL_EVERY = 6;
/** 内存里最多记多少个会话（单用户，够用；防止长跑泄漏） */
const MAX_SESSIONS = 64;

export interface CodeRender {
  /** 版本号，从 1 开始。代码没变时不递增 */
  rev: number;
  mode: CodeMode;
  /** diff 模式的基准版本 */
  diffFrom: number | null;
  lang: string;
  /** 直接嵌进 prompt 的正文 */
  body: string;
  /** 选这个模式的原因（写日志用） */
  reason: string;
  stats: { fullChars: number; sentChars: number; added: number; removed: number; ratio: number };
}

export interface CodePlan {
  render: CodeRender;
  /** 上游确认收到 prompt 之后再调（首次收到 chunk 时）。幂等 */
  commit(): void;
}

interface Version {
  rev: number;
  code: string;
  lang: string;
  at: number;
}

const versions = new Map<string, Version>();

/** 行尾统一成 \n：省掉不可见的 \r，也让全文模式和 diff 模式看到同一份文本 */
export function normalizeCode(code: string): string {
  return (code ?? "").replace(/\r\n?/g, "\n");
}

/** 只看不改：给测试/调试用 */
export function peekVersion(sessionId: string): Version | null {
  return versions.get(sessionId) ?? null;
}

export function codeMemoryStats() {
  return { sessions: versions.size, items: [...versions.entries()].map(([k, v]) => ({ session: k, ...v })) };
}

export function resetCodeMemory(sessionId?: string): void {
  if (sessionId) versions.delete(sessionId);
  else versions.clear();
}

function remember(key: string, rev: number, code: string, lang: string) {
  if (!key) return;
  versions.set(key, { rev, code, lang, at: Date.now() });
  pruneCodeMemory();
}

/**
 * 算出这一轮代码怎么发。**纯读**，不改状态 —— commit() 才改。
 *
 * 说人话：
 *  - 第一次聊这题 → 全文
 *  - 代码没动   → 一行"没变"（rev 也不涨）
 *  - 只改了几行 → 增量
 *  - 大改/换语言/到点 → 全文
 */
export function planCode(
  sessionId: string,
  code: string,
  lang: string,
  opts: { chainOk?: boolean } = {}
): CodePlan {
  // 增量必须有个"还看得见的基准"。历史链条断了（服务重启/清了对话/改过历史）
  // 就一律发全文 —— 宁可贵，也不能让模型拿着对不上的增量硬猜。
  const chainOk = opts.chainOk !== false;
  const norm = normalizeCode(code);
  const key = sessionId || "";
  const prev = key ? versions.get(key) ?? null : null;

  const full = (rev: number, reason: string): CodePlan => ({
    render: {
      rev,
      mode: "full",
      diffFrom: null,
      lang,
      body: norm,
      reason,
      stats: { fullChars: norm.length, sentChars: norm.length, added: 0, removed: 0, ratio: 1 },
    },
    commit: () => remember(key, rev, norm, lang),
  });

  // 没有会话 id（比如 --dry-run 的手工请求）就别记账，每次全文最安全
  if (!key) return full((prev?.rev ?? 0) + 1, "没有 sessionId，一律全文");

  if (!prev) return full(1, "首次：没有上一版可比");

  if (prev.lang !== lang) return full(prev.rev + 1, `换了语言（${prev.lang} → ${lang}）`);

  if (prev.code === norm) {
    const rev = prev.rev;
    return {
      render: {
        rev,
        mode: "same",
        diffFrom: null,
        lang,
        body: "",
        reason: "代码没变",
        stats: { fullChars: norm.length, sentChars: 0, added: 0, removed: 0, ratio: 0 },
      },
      commit: () => {}, // 没变就没什么可提交的
    };
  }

  const rev = prev.rev + 1;

  // 链条断了优先报出来：说明"记的东西和客户端历史对不上"，比到点重发更值得注意
  if (!chainOk) return full(rev, "历史链条断了（看不到上一版的全文），只能发全文");

  // 到点强制重发全文：万一模型哪一轮把增量理解错了，这一步让它自己纠回来
  if (rev % FULL_EVERY === 0) return full(rev, `第 ${rev} 版：按 ${FULL_EVERY} 版一次的节奏重发全文`);

  const d = unifiedDiff(prev.code, norm);
  if (norm.length < DIFF_MIN_CHARS) return full(rev, `代码太短（${norm.length} 字符），全文更省事`);
  if (d.ratio > DIFF_MAX_RATIO)
    return full(rev, `改动太大（增量是全文的 ${Math.round(d.ratio * 100)}%），不如发全文`);

  return {
    render: {
      rev,
      mode: "diff",
      diffFrom: prev.rev,
      lang,
      body: d.text,
      reason: `只改了 ${d.added} 加 / ${d.removed} 删 行`,
      stats: { fullChars: norm.length, sentChars: d.text.length, added: d.added, removed: d.removed, ratio: d.ratio },
    },
    commit: () => remember(key, rev, norm, lang),
  };
}

/** 简单的 LRU 清理：超过上限就丢掉最久没动的 */
export function pruneCodeMemory(): number {
  if (versions.size <= MAX_SESSIONS) return 0;
  const sorted = [...versions.entries()].sort((a, b) => a[1].at - b[1].at);
  const drop = sorted.slice(0, versions.size - MAX_SESSIONS);
  for (const [k] of drop) versions.delete(k);
  return drop.length;
}
