/** 扩展 ↔ 后端 的数据契约。见 docs/TECH-DESIGN.md §6 */

export interface Problem {
  id: number;
  slug: string;
  title: string;
  difficulty?: string;
  tags?: string[];
  /** 已转 markdown 的题干 */
  content?: string;
}

export interface Testcase {
  /** 失败用例的输入。力扣用 \n 分隔多个参数 */
  input: string;
  /** 用户的输出 */
  output: string;
  /** 期望输出 */
  expected: string;
}

/** 会话内存里的一份代码快照（不落库） */
export interface CodeSnapshot {
  code: string;
  verdict: string | null;
  testcase?: Testcase | null;
  passed?: number | null;
  total?: number | null;
}

export interface StuckPoint {
  desc: string;
  insight?: string | null;
  count: number;
  first?: string;
  last?: string;
}

export interface Approach {
  name: string;
  time?: string | null;
  space?: string | null;
  mastered: boolean;
  evidence?: string | null;
  note?: string | null;
}

export interface Memory {
  stuckPoints: StuckPoint[];
  approaches: Approach[];
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** POST /chat 的请求体 */
export interface ChatRequest {
  sessionId: string;
  problem: Problem;
  /** 当前代码（整份，不截取） */
  code: string;
  lang: string;
  /** 未提交时为 null */
  verdict?: string | null;
  testcase?: Testcase | null;
  passed?: number | null;
  total?: number | null;
  runtimeError?: string | null;
  /** 会话内的历史代码快照（最近 2 份），不落库 */
  codeHistory?: CodeSnapshot[];
  /** 只放"说过的话" + system 标记，不含代码 */
  messages: ChatMessage[];
}

/** LLM 建议写入记忆的结构 */
export interface MemorySuggestion {
  kind: "stuck_point" | "approach";
  desc?: string;
  insight?: string | null;
  name?: string;
  time?: string | null;
  space?: string | null;
  mastered?: boolean;
  note?: string | null;
}
