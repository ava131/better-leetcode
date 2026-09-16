# R0 · 实测结果（真实抓包）

> 本文所有内容为**实测所得**，不是推测或文档推断。
> 实测时间：2026-09-16
> 实测方式：拷贝 Chrome profile 副本 → headless Chrome + CDP → 用真实登录态在页面内发同源请求 → 监听页面自身 GraphQL 流量
> 实测账号：一个**普通（非会员）**账号（`isPremium: false`，账号信息已脱敏）

---

## 0. 最重要的一条：站点是 leetcode.cn，不是 .com

用户浏览器里**只有 `leetcode.cn` 的登录态**，没有任何 `.leetcode.com` cookie。

这一条推翻了 PRD 初稿的假设，带来三个后果：

| 影响 | 说明 |
|---|---|
| 接口名字不同 | `.cn` 的字段是 **`submissionDetail`（单数）**；`.com` 是 `submissionDetails`（复数）。写错字段名整个 query 会直接报错 |
| 需要 CSRF | `.cn` 必须带 `x-csrftoken` |
| 有 WAF 与限流 | 存在阿里云 WAF cookie `aliyungf_tc`；社区报告 `.cn` 限流约 60 次/10 分钟 |

**实测未被拦截**：headless Chrome 直接访问题目页与提交详情页均正常返回，无验证码。

---

## 1. 登录态与鉴权

| 项 | 实测值 |
|---|---|
| 账号 | 已脱敏（非会员） |
| 是否会员 | **否**（`isPremium: false`，`premiumExpiredAt: 946684821504` = 2000 年，即从未开通） |
| 会话 cookie | `LEETCODE_SESSION`，**还有 16 天有效** |
| CSRF cookie | `csrftoken`，364 天有效 |
| CSRF 可读性 | ✅ **可从 `document.cookie` 直接读取**（非 httpOnly，无 `meta[name=csrf-token]`） |
| 需要请求头 | `x-csrftoken: <csrftoken 的值>` |

**结论**：扩展可以直接 `document.cookie` 读 csrftoken，不需要解析 DOM。

---

## 2. 接口清单（全部实测）

### 2.1 提交历史 —— REST，最简单

```http
GET /api/submissions/?offset=0&limit=50
```

返回：

```jsonc
{
  "submissions_dump": [
    { "id": 123456789, "lang": "Python3", "time": "1 月，2 周",
      "status_display": "Accepted", "runtime": "3 ms", "memory": "22.1 MB",
      "url": "/submissions/detail/123456789/", "is_pending": "Not Pending",
      "title": "二叉树的直径", "timestamp": 1785397463 }
  ],
  "has_next": true,
  "last_key": "nrguyyt2m"
}
```

分页用 `last_key`。**注意路径带 `/api/` 前缀**（这一点与 `.com` 不同）。

实测该账号 80 次提交：`Accepted 54 / Wrong Answer 16 / Runtime Error 8 / Output Limit Exceeded 1 / Time Limit Exceeded 1`。

---

### 2.2 题干 —— GraphQL

```graphql
query questionDetail($titleSlug: String!) {
  question(titleSlug: $titleSlug) {
    title  titleSlug  questionId  questionFrontendId
    questionTitle  translatedTitle
    content            # 英文 HTML
    translatedContent  # 中文 HTML  ← 用这个
    categoryTitle  difficulty  stats
    topicTags { ... }
  }
}
```

**要点**：题干是 **HTML**，喂给模型前需要转 markdown（省 token，且模型对 markdown 更稳）。中文站要用 `translatedContent`。

---

### 2.3 提交详情 —— GraphQL（★ 核心）

```graphql
query submissionDetails($submissionId: ID!) {   # ← operationName 是复数
  submissionDetail(submissionId: $submissionId) { # ← 但字段是单数！这是个坑
    ... 
  }
}
```

实测完整字段（页面自己发的 query，含内联片段）：

```graphql
query submissionDetails($submissionId: ID!) {
  submissionDetail(submissionId: $submissionId) {
    code
    timestamp
    statusDisplay
    isMine
    runtimeDisplay
    memoryDisplay
    memory
    lang
    langVerboseName
    question { questionId titleSlug hasFrontendPreview }
    user { realName userAvatar userSlug }
    runtimePercentile
    memoryPercentile
    submissionComment { flagType }
    passedTestCaseCnt
    totalTestCaseCnt
    fullCodeOutput
    testDescriptions
    testInfo
    testBodies
    stdOutput
    aiJudgeMessage
    isCompiledLang
    aiRecheckSubmitted
    ... on GeneralSubmissionNode {
      outputDetail {
        codeOutput expectedOutput input compileError runtimeError lastTestcase
      }
    }
    ... on ContestSubmissionNode {
      outputDetail {
        codeOutput expectedOutput input compileError runtimeError lastTestcase
      }
    }
  }
}
```

**注意内联片段**：`outputDetail` 挂在 `GeneralSubmissionNode` / `ContestSubmissionNode` 两个类型上，**必须写 `... on`**，否则拿不到。

---

## 3. ★ R1 结论：免费用户能拿到完整失败用例

对一次真实的 WA 提交（题目「环形链表」，submissionId `123456789`）实测返回：

```jsonc
{
  "submissionDetail": {
    "code": "# Definition for singly-linked list.\n...（完整代码）",
    "statusDisplay": "Wrong Answer",
    "lang": "python3",
    "langVerboseName": "Python3",
    "passedTestCaseCnt": 17,
    "totalTestCaseCnt": 29,
    "question": { "questionId": "141", "titleSlug": "linked-list-cycle" },
    "stdOutput": "",
    "outputDetail": {
      "input":          "[-21,10,17,8,4,26,5,35,33,-7,-16,27,-12,6,29,-12,5,9,20,14,14,2,13,-24,21,23,-21,5]\n-1",
      "codeOutput":     "true",     // ← 用户的输出
      "expectedOutput": "false",    // ← 期望输出
      "compileError":   "",
      "runtimeError":   "",
      "lastTestcase":   "（与 input 相同）"
    }
  }
}
```

**逐条对照 PRD §9.1 的 R1**：

| 问题 | 答案 |
|---|---|
| 免费用户能拿到失败用例吗？ | ✅ **能** |
| 能拿到用户的输出吗？ | ✅ `outputDetail.codeOutput` |
| 能拿到期望输出吗？ | ✅ `outputDetail.expectedOutput` |
| 能拿到失败的输入吗？ | ✅ `outputDetail.input`（`lastTestcase` 同值） |
| 隐藏用例会被截断/占位吗？ | ❌ **没有**。返回的是真实完整输入（25 个元素的数组） |
| 非会员有额外门槛吗？ | ❌ 无 |

**附带确认**：`code` 字段返回的是**完整、带缩进换行的原始代码**，是判题时真正跑的那份。这解决了 FR-1 里"不要去抓 Monaco 渲染 DOM"的问题——直接拿服务端权威副本。

---

## 4. 官方 AI 的能力边界（竞争情报）

抓到官方 `submissionAnalysis` 的字段定义：

```graphql
query submissionAnalysis($submissionId: ID!) {
  submissionAnalysis(submissionId: $submissionId) {
    id  summary  status  errorMessage
    timeComplexity        { complexity displayName funcStr }
    spaceComplexity       { complexity displayName funcStr }
    suggestedTimeComplexity  { complexity displayName funcStr }
    suggestedSpaceComplexity { complexity displayName funcStr }
    efficiencyImprovements
    readabilityScore      structureScore
    styleImprovements
    currentKnowledge      suggestedKnowledge
    coreConcept           guidanceQuestion
    vote
  }
}
query submissionAnalysisUsesLeft { submissionAnalysisUsesLeft }
```

**这些字段说明了官方 AI 是什么**：

| 官方在做 | 官方没在做 |
|---|---|
| 复杂度分析 | ❌ 不陪你逐步调试 |
| 效率改进建议 | ❌ 不给失败用例的逐步推演 |
| 可读性/结构**评分** | ❌ 不追问 |
| 风格建议 | |
| 知识点映射（`currentKnowledge` → `suggestedKnowledge`） | |
| 核心概念 + **引导问题**（`guidanceQuestion`） | |

**结论**：官方产出的是**评分式的复盘总结**（`readabilityScore` / `structureScore`），形态上是一份报告。
这和 PRD §2.1 的定位（"陪你走一遍"）**不冲突，是互补的**。

**另外**：`submissionAnalysisUsesLeft` 实测返回 **1**，且 `submissionAnalysis: null`（按需生成，不是自动跑）。
免费账号额度极小 → 官方这个功能对免费用户基本不可用。

---

## 5. 实测方法（可复现）

```bash
# 1) 拷贝 Chrome profile 副本（不动正在用的那份）
cp -R "$HOME/Library/Application Support/Google/Chrome/Default" /tmp/lc-chrome/Default
cp "$HOME/Library/Application Support/Google/Chrome/Local State" /tmp/lc-chrome/

# 2) 启动 headless Chrome（macOS 没有 setsid，别用）
nohup "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --remote-debugging-port=9222 --user-data-dir=/tmp/lc-chrome \
  --no-sandbox --disable-gpu --disable-gpu-sandbox --in-process-gpu \
  --no-first-run --no-default-browser-check \
  --crash-dumps-dir=/tmp/lc-chrome/Crashpad \
  about:blank >/tmp/lc-chrome.log 2>&1 &

# 3) 用 CDP 在页面内发同源请求（cookie 由 Chrome 自动携带，无需解密）
#    探针脚本见 /tmp/lc-probe/probe*.mjs
```

**踩过的坑**：

- `macOS` 没有 `setsid` → 用 `nohup ... &`
- `--disable-gpu` 单独不够，会 `FATAL: GPU process isn't usable` → 需加 `--no-sandbox --disable-gpu-sandbox --in-process-gpu`
- Crashpad 默认写用户真实 Chrome 目录会被权限拒绝 → 加 `--crash-dumps-dir`
- 读取 Cookies SQLite 时 `expires_utc` 是 int64，Node 的 `DatabaseSync` 直接取会 `ERR_OUT_OF_RANGE` → 用 `cast(... as text)`
- **不需要解密 cookie**：用 CDP 在页面内 `fetch()`，Chrome 自动带 cookie，绕开 Keychain

---

## 6. 尚未验证（剩余风险）

| # | 项 | 说明 |
|---|---|---|
| R2 | `/graphql/` 是否**总是**需要 `x-csrftoken` | 实测带了就成功；没测过不带的情况。**实现时一律带上**，成本为零 |
| R3 | 提交（submit）走 REST 还是 GraphQL | 未实测——**故意没测**，因为提交会往账号里写记录。`leetcode-graphql-queries` 的 `.com` 真实抓包显示是 REST `POST /problems/{slug}/submit/`。**扩展的拦截器应按 URL 模式泛化匹配，不写死** |
| R4 | 限流阈值 | 社区报告 `.cn` 约 60 次/10 分钟，本次未压测。**设计上只在用户主动操作时发请求**，正常使用不会接近阈值 |
| R5 | 其他语言的 `outputDetail` 形状 | 只测了 Python3。预期一致，但未验证 Java/C++ |

---

## 7. 对 PRD 的影响

| PRD 处 | 需要改动 |
|---|---|
| 全文 | `.com` → `.cn` |
| §5 关键技术事实 | 用本文的实测结果替换调研推断 |
| §9.1 R1 | ✅ 已解决，可关闭 |
| FR-1 | ✅ 取消"失败用例可能拿不到"的降级方案，直接可用 |
| FR-4 | ✅ 逐步调试**有真实失败用例可用**，不必让 AI 凭空造用例 |
| §5 官方竞争 | 补上官方 AI 实际字段（评分式总结，非调试陪伴） |
