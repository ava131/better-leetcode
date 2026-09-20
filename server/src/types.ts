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

/**
 * 「运行」的结果（点了运行按钮跑题目自带的示例用例）。
 *
 * 和提交是**两条独立链路**：运行不产生提交记录，也不代表最终判定。
 * 力扣运行后返回逐用例的答案对比（code_answer / expected_code_answer），
 * 以及一个成败位图 compare_result（"101" = 第 2 个用例失败）。
 */
export interface RunResult {
  verdict: string | null;
  passed: number;
  total: number;
  /** 1-based；全过则为 null */
  failedIndex: number | null;
  compareResult: string;
  /** 全部用例的输入，按顺序拼接（力扣不告诉我们切分点） */
  dataInput: string;
  lang?: string | null;
  answers: string[];
  expected: string[];
  stdout?: string[];
  runtime?: string | null;
  memory?: string | null;
  runtimeError?: string | null;
  compileError?: string | null;
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
  /** 点了「运行」才有：题目自带示例用例的结果 */
  run?: RunResult | null;
  /** 最近一次动作，决定 UI 优先展示谁 */
  lastAction?: "run" | "submit" | null;
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
