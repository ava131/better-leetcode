# AI 增强版 LeetCode 工具调研

> 数据取自 GitHub API 与第三方商店镜像（crxsoso），Chrome 商店/chrome-stats 有反爬，未取得逐条评论；量与评分可能滞后。除注明外为**查证事实**。

## 一、现有方案

| 工具 | 做什么 | 量级 / 评分 | 读判题失败用例？ |
|---|---|---|---|
| LeetChatGPT | 定时/手动点评当前代码、追问、导出；自备 key | Chrome 503 人 4.0(4)、Firefox 5 人；GitHub 152★；2023-11 停更 | 否 |
| Leetcode Explained | 视频题解＋公司标签＋进度；AI 只用题面＋你的代码生成/修代码、算复杂度 | Chrome 1 万人 2.9(35)；GitHub 114★ | 否 |
| Marble Tutor | 互动 walkthrough（理解→计划→实现），引导不给答案 | 1000 人 5.0(23)；2025-06 停更 | 否 |
| LeetCopilot | 10/20/30/100% 渐进提示、mock、笔记 | 免费 beta；来源为创始人自写软文，有偏 | 否 |
| Leetcode Buddy | 反问式提示、不给答案 | 404 人 3.4(5)，最低；2024-08 停更 | 否 |
| Cermonix | 分层苏格拉底提示，自述读"近期提交错误" | 10 人 5.0(2) | 仅文案 |
| LeetCode Debug Assistant | 自述提取"代码＋测试结果"发给 GPT/Claude/Gemini，渐进提示 | 21 人 0 评价 | 仅文案 |
| 力扣 AI 助手（负雪明烛） | 思路＋完整代码、错误代码指导、通过后评估；自备 key | 33 人 0 评价；2024-10 | 仅文案 |
| LeetAnalyze | 抓完整提交史→反复卡住的题、WA/TLE/RE 模式、薄弱主题 | 21 人 5.0(4)；2026-08 | 分析历史 |
| PatternCoach（开源） | 本地跑 Python，取真实首个失败用例做诊断；1–3 级提示；错题本＋技能画像 | GitHub 23★；仅 150 题、Python | **是**（自建可见用例） |
| LeetCode Analytics / leetStats | 仅 Elo 难度与本地统计，非 AI 辅导 | 257 人 5.0(5) / Firefox 1 评价 | 否 |

**官方竞争**：力扣「Leet 智能助手」2025.8 上线快捷指令与选中即问（Plus 每月 500 次高级模型额度），2026.3 上线「提交结果分析」（思路对比、复杂度优化、代码质量），2026.5 上线 Quick Fix 一键分析并修复编辑器报错；模型含 GPT-5.2、Gemini 3.1 Pro、Claude Sonnet 4.6、DeepSeek、Qwen、豆包。

## 二、关键区分（推断）

1. **读失败用例**：可查证的只有 PatternCoach（真执行、取首个失败用例），且是自建可见用例，非 LeetCode 隐藏用例。Debug Assistant、Cermonix、力扣 AI 助手相关表述仅商店文案，无评价或代码佐证，无法核实。
2. **长期错因画像**：只有 LeetAnalyze（21 人）与 PatternCoach（23★）；官方「进展分析」只有进度与知识脉络，未见错误归因。
3. 其余全是"题面＋你的代码→LLM 解释/提示"，不接触判题输出。

## 三、用户抱怨（查证到）

- Reddit：ChatGPT 常"just gives the results outright"，用户只能自己加"给提示别给答案"的 prompt（r/leetcode）。
- Reddit：很多人"outsourcing their thinking to GPT without realizing it harms their understanding"，故转向 Marble 这类强制走流程的工具（r/csMajors）。
- Leetcode Explained 2.9 分，2.4.0 更新日志自认"reviews 里提的问题已修复"、作者求"差评前先邮件我"→差评偏界面/失效，非 AI 质量。
- **未查到**"幻觉/分析错误/太泛"的具体用户证据，不编造。

## 四、结论

最大未满足需求：用真实判题证据（失败输入/期望/实际）定位到具体分支或边界＋跨题错因画像与复习调度＋分级提示。共同失败原因：无执行闭环→分析不可证伪→只能泛泛解释；唯一闭环者是覆盖面窄的小项目，而官方已把"提交结果分析＋一键修复"内置并捆绑 Plus，正压缩第三方空间。

## 来源

- LeetChatGPT：[GitHub](https://github.com/Liopun/leet-chatgpt-extension) · [crxsoso](https://www.crxsoso.com/webstore/detail/ephkkockglkjbdljoljjfdlfmgkeijek)
- Leetcode Explained：[GitHub](https://github.com/zubyj/leetcode-explained) · [crxsoso](https://www.crxsoso.com/webstore/detail/cofoinjfjcpgcjiinjhcpomcjoalijbe)
- Marble：[crxsoso](https://www.crxsoso.com/webstore/detail/mpjcipoidkmiiebdbdfknmpncmnpoboe)
- LeetCopilot：[DEV 软文](https://dev.to/alex_hunter_44f4c9ed6671e/12-best-leetcode-chrome-extensions-in-2025-ai-timers-more-k96)（作者即创始人）
- Leetcode Buddy：[crxsoso](https://www.crxsoso.com/webstore/detail/bledmldfaamjecodfanepibihpglaafk)
- Cermonix：[Chrome 商店](https://chromewebstore.google.com/detail/cermonix-%E2%80%94-dsa-ai-coach/bidamfnncbgbfldhekldhibdghipjhjl)
- LeetCode Debug Assistant：[Chrome 商店](https://chromewebstore.google.com/detail/leetcode-debug-assistant/mmmgmbbdbaikhbikcnokhijnkcckddpe)
- 力扣 AI 助手：[crxsoso](https://www.crxsoso.com/webstore/detail/fdmmeegbmgddikojbllfccmdgiidbokn)
- LeetAnalyze：[Chrome 商店](https://chromewebstore.google.com/detail/leetanalyze/hphgjmhgemmfdioknobebmnmjomhaclk)
- PatternCoach：[GitHub](https://github.com/Iriss0904/personalized-leetcode-coach)
- 官方更新日志：[力扣产品更新日志](https://leetcode.cn/discuss/post/3144606/chan-pin-geng-xin-ri-zhi-by-leetcode-5nx9/) · [Feature Release Notes](https://leetcode.com/discuss/post/5736503/feature-release-notes-by-leetcode-9awg/)
- Reddit 引用经 PullPush 归档检索：[API](https://api.pullpush.io/reddit/search/comment/?q=%22leetcode%22%20%22chatgpt%22%20%22just%20gives%22)
