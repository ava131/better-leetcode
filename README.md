# AI 刷题小助手（better-leetcode）

一个挂在**力扣（leetcode.cn）**上的 AI 刷题小助手。

**它不做什么**：不判题、不题库、不自动改代码。
**它做什么**：把题干、你的代码、判题结果**自动送进对话**，让你不用再复制粘贴 —— 外加一份能跨题积累的本地记忆。

> 设计文档见 `docs/`。**先读 `docs/PRD.md`**。

---

## 现在能跑什么

| 模块 | 状态 |
|---|---|
| 本地后端（HTTP + SSE + 记忆库） | ✅ 可用 |
| 上下文组装 + system prompt | ✅ 可用，`--dry-run` 可直接评审 |
| 记忆层（卡点 / 解法掌握度） | ✅ 可用，21 项冒烟测试全过（幂等） |
| 扩展：拦截器（题干 / 代码 / 判题结果） | ✅ 已对真实力扣页面验证 |
| 扩展：侧边栏 + 状态条 + 思考指示 + 记忆卡片 | ✅ 已验证 |
| **「运行」结果挂载**（示例用例，不写提交记录） | ✅ 已验证 |
| Markdown 渲染（列表/标题/引用/表格/代码块） | ✅ 已验证，40 项单测 |
| 面板可拖动、左右自动吸附、可调大小 | ✅ 已验证 |
| 点力扣界面（面板外）自动收起 | ✅ 已验证 |
| **对话全量落库**（不存思考过程） | ✅ 后端已验证，31 项单测 |
| **历史标签**（列表 / 只读回看 / 继续这条 / 搜索） | ⚠️ 后端已验证；前端待你实机确认 |
| 真实 LLM 调用（DeepSeek） | ✅ 已跑通 |

### 模型选型（实测）

| 模型 | 总耗时 | 结果 |
|---|---|---|
| `deepseek-v4-pro` | 28~80s | ✅ **推荐**。分析正确、聚焦 |
| `deepseek-flash` | ~8s | ⚠️ 快，但**编造了一个不存在的 bug** |

推理模型的思考过程会通过 `thinking` 事件流式出来，**首字节 0.6s** 就能看到「思考中…」，所以 pro 的等待是可感知的、不难受。

分析代码这类任务，**幻觉的代价远大于等待的代价** —— 详见 `docs/TECH-DESIGN.md` §4.3.1。

---

## 上手（三步）

### 第 1 步 · 启动后端

**方式 A（推荐）**：在 Finder 里双击项目根目录的 **`start.command`**。

首次双击 macOS 可能拦一下（"无法打开，因为来自身份不明的开发者"）：
右键 → 打开 → 确认。之后就能直接双击了。

窗口出现这样的输出就成了：

```
  better-leetcode 后端已启动
  → http://127.0.0.1:8787
  默认模型 deepseek-v4-pro
  可选模型 deepseek-v4-pro, deepseek-flash
  API key  已配置
  记忆库   ~/.better-leetcode/memory.db
```

**保持这个窗口开着。关掉窗口 = 停止后端。**

**方式 B**：终端里

```bash
cd server && node src/index.ts
```

> `.env` 已经配好了（DeepSeek + `deepseek-v4-pro`）。要换别家模型就改 `.env` 里的
> `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` / `LLM_MODELS`。

### 第 2 步 · 加载扩展（只需做一次）

1. Chrome 地址栏输入 **`chrome://extensions`** 回车
2. 打开右上角的 **「开发者模式」** 开关
3. 点左上角 **「加载已解压的扩展程序」**
4. 选中项目里的 **`extension/`** 文件夹 → 确定

列表里会出现「AI 刷题小助手」。

> 改扩展代码后：回到 `chrome://extensions`，点这个扩展的 **⟳ 刷新** 按钮，再刷新力扣页面。

### 第 3 步 · 用它

1. 打开任意力扣题目页，比如 <https://leetcode.cn/problems/linked-list-cycle/>
2. 右侧出现 **「AI 刷题小助手」** 侧边栏，顶部状态条是灰的：`○ 已就绪（未提交）`
3. 这时就能问：**「这题有几种解法？」「思路是什么？」**
4. 写代码，然后二选一：

   **点「运行」**（日常最常用）→ 状态条变绿：
   `● 运行结果已就绪 · Accepted · 3/3`
   示例用例的逐条对比（你的输出 vs 期望）自动进上下文，AI 能看到哪个用例没过。

   **点「提交」** → 状态条变绿：
   `● 上下文已就绪 · Wrong Answer · 17/29`
   隐藏用例里失败的那一条自动进上下文。

   > ⚠️ **运行通过 ≠ 提交能过。** 运行只跑题目自带的 2~3 个示例用例，很宽松。
   > 这恰恰是最值得问 AI 的场景 —— 直接点「运行过了为什么提交会挂」。
5. 点建议按钮或直接打字。想问逐步调试就说 **「找个用例一步步走」**

**快捷键**：`⌘ + I` 唤起输入框。

**面板怎么摆**：

- 拖标题栏移动面板 → 松手**自动吸附到最近的一侧**（左/右）
- 拖左下角（贴左时是右下角）调大小
- **点到力扣界面上，面板自动收起成小球**；点小球回来，还在原来那一侧
- 标题栏的 `⇤` 开关可以关掉「点外部收起」——开着时也没关系，鼠标划过不会收
- 小球也能拖，跟面板共享同一侧

---

## 关于模型

侧边栏右上角有下拉框，可以随时切：

| 模型 | 耗时 | 特点 |
|---|---|---|
| `deepseek-v4-pro` | 30~80s | **默认**。分析准确、聚焦 |
| `deepseek-flash` | 6~10s | 快，但**会编造不存在的 bug**（实测） |

选择会记住（存在 `chrome.storage`），下次自动恢复。

推理模型的思考过程会**实时显示**（"思考中…"转圈 + 累计字数），
所以 pro 的等待是可感知的 —— **首字节 0.6 秒**，不是卡住。

**建议**：默认留在 pro。发现它想太久、而你只是问个简单的思路，再临时切 flash。

---

## 调 prompt（最该折腾的地方）

整件事的价值全在 prompt 和上下文组装上。改 `server/src/prompts/system.md`，
然后用真实数据看效果——**不需要开插件、不需要点页面**：

```bash
cd server
node src/cli.ts --dry-run fixtures/step-through.json   # 只打印拼好的 prompt，不花钱
node src/cli.ts fixtures/step-through.json             # 真问一次
```

两个 fixture 都来自真实数据（`环形链表` 那次 WA）：
- `linked-list-cycle.json` — 问「这版哪里错了」
- `step-through.json` — 问「找个用例一步步走」

改完 prompt 不用重启后端（每次请求都重新读 `system.md`）。

---

## 状态条（回答"上下文已就绪"）

侧边栏顶部那条，三态：

| | 显示 | 含义 |
|---|---|---|
| 灰 | `○ 已就绪（未提交）· 环形链表 · 题干 + 代码` | 能问思路，没有判题结果 |
| 绿 | `● 上下文已就绪 · Wrong Answer · 17/29` + 失败用例 | **提交后自动变绿**，AI 能看到失败用例 |
| 黄 | `⚠️ 后端未连接` | 后端没起 |

因为 LLM 是无状态的，没有这条你没法知道插件到底准备好了什么。

---

## 测试

```bash
cd server
MEMORY_DB=./.dev-memory.db node test/smoke.ts
```

18 项：HTML→markdown、记忆读写、重复卡点累加、掌握度矩阵、`<memory>` 块剥离与容错。

---

## 目录

```
start.command         ← 双击启动后端
docs/
  PRD.md              需求与交互设计（先读这个）
  TECH-DESIGN.md      技术设计：架构、接口、schema、15 个坑、模型选型
  R0-captured-api.md  力扣 .cn 真实抓包证据
research/
  ai-leetcode-tools.md  现有产品与官方动向调研
server/               本地后端（Node 24，零依赖）
  .env                  ← API key 在这里（已 gitignore）
  src/prompts/system.md   ← 小助手的 system prompt，最该改的文件
  fixtures/               真实数据 fixture
  test/smoke.ts           21 项冒烟测试
extension/            Chrome MV3
  src/interceptor.js     MAIN world：拦截 + 读题面/代码
  src/content.js         ISOLATED：侧边栏 UI
  src/background.js      service worker：只跟 localhost 说话
```

---

## 图标

标题栏和小球用的是 DeepSeek 的吉祥物（鲸鱼娘），纯粹因为个人喜欢、且本项目默认接 DeepSeek。
图标素材版权归 DeepSeek 所有，本项目与 DeepSeek 官方无关。
换掉的话：替换 `extension/assets/pet.jpg` 和 `extension/icons/*.png` 即可。

---

## 隐私

- API key 只在 `server/.env`，**扩展永远拿不到**
- 登录 cookie **永不外发**；只有题干 + 代码 + 用例发给模型
- 记忆库默认 `~/.better-leetcode/memory.db`（可用 `MEMORY_DB` 覆盖）
- 后端只绑 `127.0.0.1`，并拒绝非扩展来源的请求
