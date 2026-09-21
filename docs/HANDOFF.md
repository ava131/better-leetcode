# 交接文档（给下一个窗口）

> 写于 v0.7.0（commit `6c023bd`）。目标：**别的会话读完这份就能接着改，不用重新摸索。**
>
> 顺序建议：先读「§1 这是什么」，再读「§6 当前这个 bug」（那是第一优先级），
> 需要改代码时看「§2 文件清单」和「§9 踩过的坑」。

---

## 1. 这是什么

一个挂在 **力扣（leetcode.cn）** 上的 Chrome 扩展 + 本地后端。用户刷题时，
把**题干 + 自己的代码 + 判题/运行结果**自动送进一个侧边栏对话，可以追问、
可以让它挑最小用例一步步走。对话**全量存本地 SQLite**，可按题翻回历史。

**用户就是唯一使用者也是唯一决策者**，所以：
- 不追用户量、不追功能完整度，只追「他自己每天真的会用」
- 唯一验收标准：**下次卡在 `cur.next` 上，第一反应是打开它，而不是去点题解**

**不是**什么：不做判题器、不做题库、不自动改代码。

---

## 2. 文件清单（每个文件干什么）

### 根目录

| 文件 | 作用 |
|---|---|
| `README.md` | 面向使用者的上手说明（三步：起后端 / 加载扩展 / 用） |
| `start.command` | 双击启动后端的 macOS 脚本。有端口占用检查 |
| `.gitignore` | 忽略 `.env` / `*.db` / `bl-server.log` |

### `docs/` —— **先读这里**

| 文件 | 作用 |
|---|---|
| `docs/HANDOFF.md` | 本文件 |
| `docs/PRD.md` | 需求与交互设计。**FR-1~FR-7**。FR-5 是存储取舍（v0.7 刚反转过），FR-7 是 P2 的分层导师 |
| `docs/TECH-DESIGN.md` | 技术设计 + **§7 是一份 41 条「踩过的坑」清单**。改代码前扫一眼省很多事 |
| `docs/R0-captured-api.md` | 力扣 `.cn` 的**真实抓包证据**（接口形状的唯一权威来源） |

### `server/` —— 本地后端（Node 24，**零依赖零构建**）

Node 24 自带 `node:sqlite` 和 TS 直跑，所以：**没有 package.json 依赖，没有构建步骤**。
改完直接 `node src/index.ts`。

| 文件 | 作用 |
|---|---|
| `src/index.ts` | HTTP 服务（只绑 127.0.0.1）。路由：`/chat`(SSE)、`/history/*`、`/health`、`/diag`、`/models`、`/debug/last-prompt`。**日志同时写 stdout 和 `bl-server.log`** |
| `src/history.ts` | **对话存储层**（新，v0.7）。schema、落库、会话列表、LIKE 检索、快照去重 |
| `src/context.ts` | **上下文组装**：把扩展传来的快照拼成给模型的 `<context>` 块（`<problem>` `<code>` `<judge>` `<run>`） |
| `src/prompts/system.md` | **system prompt**。整个产品的价值主要在这里，最该改的文件 |
| `src/llm.ts` | LLM provider（OpenAI 兼容）+ SSE 流解析。`reasoning_content` 走 `thinking` 事件 |
| `src/html.ts` | 力扣题干 HTML → markdown（自实现，零依赖） |
| `src/types.ts` | 扩展↔后端的数据契约类型 |
| `src/cli.ts` | 命令行：`--dry-run` 打印拼好的 prompt（**不用 API key**），不带参数则真调用 |
| `test/history.ts` | 对话存储层单测（31 项） |
| `test/smoke.ts` | HTML→markdown + `<memory>` 防御性剥离（8 项） |
| `fixtures/*.json` | 真实数据的测试夹具（`linked-list-cycle` / `step-through` / `run-example`） |
| `.env` | **API key 在这里，已 gitignore**。`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` / `LLM_MODELS` |

### `extension/` —— Chrome MV3

| 文件 | 作用 |
|---|---|
| `manifest.json` | MV3。**两个 content_scripts**：拦截器进 MAIN world，扩展代码进 ISOLATED |
| `src/interceptor.js` | **MAIN world 拦截器**。读题干/代码、抓提交与运行、轮询判题结果 |
| `src/content.js` | **ISOLATED：整个侧边栏 UI**（1700 行，最大的文件）。状态机、渲染、历史视图、拖动吸附、超时与停止 |
| `src/markdown.js` | markdown 渲染 + `stripMemory()`。**单独成文件是为了能在 Node 里单测**（content_scripts 多文件共享作用域） |
| `src/background.js` | service worker。**唯一能发跨域请求的地方**（只跟 localhost 说话）+ SSE→port 转发 |
| `assets/pet.jpg` | 小球形象图 |
| `icons/*.png` | 扩展图标 16/32/48/128 |

### `tools/probe/` —— 对着**真实页面**验证的 CDP 脚本

| 文件 | 作用 |
|---|---|
| `README.md` | 用法 + 起调试版 Chrome 的完整命令 |
| `cdp.mjs` | 极简 CDP 客户端（零依赖）。含 `open()` / `evalInWorld()`（**按主 frame 过滤**） |
| `capture-api.mjs` | 抓力扣页面自己发的 GraphQL（力扣改 schema 时用它重新确认字段） |
| `e2e.mjs` | 端到端回归：保真 world 结构 + 真实点提交按钮 |
| `ui-wiring.mjs` | 界面接线回归：发送按钮 / 回车 / 停止 / 拉大后仍可用 |
| `scroll.mjs` | **滚动跟随回归**：贴底才跟随 / 往上滚不被拽走 / `anchor()` 停在回答开头 / 真滚轮能停住。后端用假流式回复，**不花 API 额度、不碰账号** |
| `selfcheck.mjs` | **不开浏览器**，只对"生成出来要注入页面的代码"跑 `node --check`（★44 就是它守的坑） |

---

## 3. 怎么跑

```bash
# 起后端（或双击根目录 start.command）
cd server && node src/index.ts

# 不花钱看 prompt —— 最该先做的事
cd server && node src/cli.ts --dry-run fixtures/linked-list-cycle.json

# 真问一次
cd server && node src/cli.ts fixtures/linked-list-cycle.json

# 全部测试
node extension/test/wiring.test.mjs
node extension/test/markdown.test.mjs
node extension/test/background.test.mjs
cd server && MEMORY_DB=./.dev-memory.db node test/smoke.ts
cd server && MEMORY_DB=./.dev-memory.db node test/history.ts
```

**当前测试状态（全绿）**：history 31 / smoke 8 / wiring 17 / markdown 47 / background 9。

---

## 4. 关键设计决定（别再重新讨论）

| 决定 | 理由 |
|---|---|
| 上下文只要**题干 + 代码 + 一个测试用例** | 判题元数据（通过数、击败百分比）是噪声 |
| **不要代码选区功能** | 力扣解法就二三十行，整份塞进去不占地方；选区反而多一步操作 |
| 提交后**只就位，不自动发问** | 没有提问就没有模型调用（省 token，也不烦） |
| **全量存对话**，不存模型思考 | 思路在对话里；思考占 85% 体积且不是用户的思路（v0.7 反转，原为"只存结构化事实"） |
| **不压缩存储** | gzip 省 3~4 倍但毁掉检索，而检索是全部价值 |
| 检索用 **LIKE 不用 FTS5** | 实测 FTS5 对中文无效（见 §9） |
| **拆掉「结构化记忆」** | 平行维护第二份事实来源 = 不一致风险，且是模型建议的（幻觉重灾区） |
| 默认模型 **`deepseek-v4-pro`** | `flash` 快 6 倍但**会编造不存在的 bug**（实测） |
| 后端**无状态会话** | 会话由扩展持有每轮全量送；已发生的对话落库，后端重启不影响进行中的对话 |

---

## 5. 提醒：用户的工作方式

- **中文交流**
- 讨厌**过度设计**。当他说"不用做什么边界"，就是别加限制、别想太多
- 希望**分小步做、每步验证**（我因为"整块替换"删过两次代码，见 §9）
- 会**实机测试并反馈**，反馈通常很准
- **不要甩锅**。承认错误、给出证据、说清哪块没验完，他接受这个
- 他会说"先不做这个""记着以后再做"——那就真的别做，记进文档

---

## 6. 那个"历史标签不显示" —— **不是 bug，已结案**

### 现象
v0.7.0 装上后，侧边栏没有出现「对话 / 历史」两个标签。

### 真相
**历史是从 v0.7.0 才开始攒的。** 用户之前那些对话（v0.6.x）**从来没存过**
（那版根本没有存储层）。查他的库：

```
~/.better-leetcode/memory.db
  sessions:    0 行     ← 一条都没有
  messages:    0 行
  problems:    6 行     ← 这些是 v0.6.x 留下的
  submissions: 8 行
```

`0 个会话` → `renderTabs()` 正确地隐藏标签。**这正是设计行为**
（PRD FR-6：「只有存在历史对话时才显示，新题跟以前一模一样」）。

### 但暴露了一个真的体验问题
**用户分不清"没历史"和"功能坏了"。**

修法（v0.7.1）：第一次攒出历史时，在对话里插一句系统提示
「这次对话已存到本地 —— 标题栏出现了「历史」标签，以后可以翻回来」。
（系统消息里不以 `────` 开头的不会进 LLM payload，只是 UI 提示。）

### 这里留下的教训
排查这类"功能没出现"的问题，**先查数据、再查代码**。
我在这上面先在浏览器测试环境里耗了很久，而正确答案在
`~/.better-leetcode/memory.db` 里一条查询就能看到：

```bash
node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.env.HOME+'/.better-leetcode/memory.db',{readOnly:true});
for (const t of ['sessions','messages','problems'])
  console.log(t, db.prepare('select count(*) c from '+t).get().c);
"
```

### 还没验证的一环
「聊一次之后标签确实会出现」——**这一环只能实机确认**。
后端已经端到端验证过（落库、列表、搜索都通），渲染路径也在一次测量里
渲染出过 `hidden:false, badge:"1"`。如果用户聊完还是不出现，那才是真 bug，
**此时先看 `bl-server.log` 里有没有 `GET /history/list`**（见 §7）。

---

## 7. 调试工具箱

```bash
curl http://127.0.0.1:8787/health          # 后端在不在、模型、库状态
curl http://127.0.0.1:8787/diag            # 扩展汇报上来的事件（时序）
tail -f server/bl-server.log               # 后端日志（每个请求一行 + [chat] + [ext]）
curl http://127.0.0.1:8787/debug/last-prompt   # 上一次实际发出的完整 prompt
```

界面 / 滚动这类**只有真实布局才看得出来**的问题，用探针（先按 `tools/probe/README.md`
起一个带调试端口的 Chrome，**用全新空 profile 即可，不需要登录、不碰你的 cookie**）：

```bash
node tools/probe/selfcheck.mjs      # 不开浏览器，13 项语法自检（★44）
node tools/probe/ui-wiring.mjs      # 发送 / 回车 / 停止 / 拉大后仍可用
node tools/probe/scroll.mjs         # 滚动跟随（含"发一条"的假流式，不花额度）
```

侧边栏标题旁的 **`vX.Y.Z`** 是判断"扩展到底刷没刷新"的最快方式。
**改了扩展必须点 `chrome://extensions` 的 ⟳，光刷新网页不够。**

---

## 8. 架构要点（改代码前看）

```
页面 (leetcode.cn)
 ├─ MAIN world: interceptor.js   ← 只观察不改写，任何异常都吞掉
 │    · 读题干（来自 __NEXT_DATA__，力扣不发 GraphQL 请求！）
 │    · 读代码（当前活动编辑器的 model，不是"最长的那个"）
 │    · 抓 submit / interpret_solution → 轮询 /check/
 │    ↓ postMessage（走 DOM 属性传 nonce，见 ★20）
 └─ ISOLATED: content.js  ← Shadow DOM 侧边栏，全在这里
      ↓ chrome.runtime.connect / sendMessage
    background.js  ← 只跟 127.0.0.1:8787 说话（绝不在 SW 里直接请求力扣）
      ↓ SSE / JSON
    本地后端 → SQLite
```

**两条独立的判题链路**（别混）：

| | 运行 | 提交 |
|---|---|---|
| 接口 | `POST /problems/{slug}/interpret_solution/` | `POST /problems/{slug}/submit/` |
| id | **字符串** `runcode_...` | 数字 |
| 结果 | **逐用例**对比（`code_answer` / `expect_code_answer` / `compare_result` 位图） | 只有失败的**那一个**用例 |
| 落库 | 不产生提交记录 | 产生 |

**判题是异步的**：`submit` 返回时 `statusDisplay` 是**空字符串**，必须轮询到非空。

---

## 9. 我踩过的坑（别再踩）

完整 41 条在 `docs/TECH-DESIGN.md` §7。最值得记的几条：

| | 坑 | 教训 |
|---|---|---|
| **★20** | MAIN world 与 ISOLATED world 的 `window` **不共享**。拦截器设的 `window.__BL_NONCE__`，content script 读到的是 `undefined` → 所有消息被校验丢掉 → **插件完全没反应** | DOM 是唯一共享的。**测试必须还原 world 隔离**，两个脚本注进同一 world 会掩盖这个 bug |
| **★29** | 大段"整块替换"式补丁会**静默删掉中间的函数** —— 一次把 `content.js` 从 1209 行砍到 721 行，而 `node --check` **依然通过** | **分小步做，每步 `assert count == 1` + 复查行数与关键函数**。排查这类问题**看浏览器异常**（`Runtime.exceptionThrown`），别靠读代码猜 |
| **★18** | 力扣**切 tab 也会改 pathname**。按 pathname 判断"换题"会在点提交后清空对话 | 换题只比 **slug** |
| **★36/★41** | 测试环境里 `addScriptToEvaluateOnNewDocument` 注入到**所有 frame**、且每个新 document 都跑 → content.js 跑出**多个面板实例**，文档级监听器互相干扰，UI 断言飘忽。**真实扩展一个 document 只注入一次** | 遇到这种就**立刻停手**，把确定性覆盖放到 Node 单测；别在浏览器 harness 上无限投入（我在上面浪费了很久） |
| **★37** | FTS5 的 `unicode61` 把连续中文当成**一个 token**，搜「边界」命中 0 条 | 中文检索用 `LIKE` |
| **★42/★43** | 流式时**每来一个 token 就把用户拽回底部**（用户原话「我还往上翻不了」）；改完静态检查全绿，但 `anchor()` 自己写 `scrollTop` 触发的 `scroll` 事件又把跟随打开了 —— **只有真浏览器跑出来才知道** | 贴底才跟随；并且把"代码滚的"和"用户滚的"分开（`selfScrollTop`）。**几何判断分不清意图，得额外记账** |
| **★44** | 模板字符串里写 `\n` / `\u0000` 会**在生成脚本时就被解码**，注入的源码里出现真换行/真 NUL → 语法错误。**这次又踩了**：桩代码整段没跑，`ui-wiring` 10 条全红，看起来像扩展坏了 | 探测脚本里要写成 `\\n`；并且用 `tools/probe/selfcheck.mjs` 把"生成出来的注入代码"当独立文件 `node --check` 一遍 |

**更根本的一条**：`node --check` 通过 ≠ 东西还在。所以有 `extension/test/wiring.test.mjs`
（静态检查：必需函数在不在、有没有引用未定义的函数、关键绑定在不在）。
它**用人为破坏验证过真的会红**。

---

## 10. 下一步该做什么

### 立刻

1. **让用户实机确认「聊一次之后历史标签出现」**（见 §6 末）。
   不出现才是真 bug，先看 `bl-server.log` 里有没有 `GET /history/list`
2. **让用户实机确认滚动手感**（v0.7.2）。
   现在的策略是「**发出去就停在回答开头，不追尾部**」，右下角浮出「↓ 新内容」；
   自己滚回底部会自动恢复跟随。要观察的是：回答开头停在视口偏下（只有一行可见）
   会不会难受 —— 这是几何决定的（回答在内容末尾，视口滚不过末尾），
   如果用户觉得难受，唯一的解法是给 `.body` 加"流式期间才有的底部留白"，
   但那会在收尾时动到滚动位置，要小心

### 之后（用户已明确想要，按优先级）

3. **全局搜索**（跨题搜对话）。用户已同意"等攒够题量再做"，但现在历史标签有了，
   跨题搜索的价值会很快显现
4. **分层导师（P2）** —— 见 `docs/PRD.md` FR-7。**做之前必须先解决那里列的四个问题**，
   而且一条硬约束：**导师的每个结论必须引用具体题目**

### 还没做但不急

- 对话导出（JSON / markdown）
- 记忆库在 `~` 下建目录失败时的提示（现在会优雅降级成"无历史"，但不告诉用户）

---

## 11. 一些数字（避免重新测）

| 项 | 值 |
|---|---|
| 对话存储体积 | **~3.3KB/轮** → 每天 15 轮 = 50KB/天 → **18MB/年** |
| 上下文 token | 约 **1100~2600**（题干 518 字符 + 代码 471 字符 + prompt） |
| `deepseek-v4-pro` 首字节 | **0.6s**（thinking 事件），正文 30~80s |
| `deepseek-flash` | 6~10s，**但会编造不存在的 bug** |
| 力扣 `.cn` 限流 | 社区报告 ~60 次/10 分钟。本产品**每次提交只增加 1 个请求** |

---

## 12. 隐私红线

- **API key 只在 `server/.env`**，扩展永远拿不到（已 gitignore）
- **登录 cookie 永不外发**。只有题干 + 代码 + 用例发给模型
- 后端只绑 `127.0.0.1`，并拒绝非扩展来源的请求
- 记忆库默认 `~/.better-leetcode/memory.db`（可用 `MEMORY_DB` 覆盖）
- 仓库是**公开的**，推之前必须扫 key 和身份信息（脚本见下）

```bash
KEY=$(grep '^LLM_API_KEY=' server/.env | cut -d= -f2-)
git grep -qF "$KEY" -- . && echo "⚠️ key 泄漏" || echo "✓ 无 key"
grep -rInE 'drainbowdash|Rainbowdash|/Users/Admin' docs/ README.md extension/src/ server/src/ tools/
```

---

## 13. 用户最近的原话（省得你猜他要什么）

> 「我每次打开一遍这个对话，之前的对话不见了。这显然是不对的。」

> 「很多思路的诞生都是在对话里。」

> 「思考过程不存，我也看不到，对我没有任何帮助。」

> 「如果已经有历史对话，就在侧边栏加历史标签。然后新题就维持原样就好了。」

> 「之前那个只存要点就算了，感觉没什么用。你觉得呢？」

> （关于导师）「现在也不一定要做这个功能。可以先记着以后再做。」

> 「每次llm生成的时候，有没有办法窗口保持在我问问题的那个地方？他很快一下子全部输出，
> 根本看不过来，还得往上回去翻。而且在他输出的时候，我还往上翻不了，不知道是啥情况。
> 这可能是bug，也可能是机理。」

→ 两条都是真的：**「翻不了」是 bug**（★42/★43）；**「一下子全出来」是机理性感受**
（流式确实在流，但追尾部让它看起来"唰一下就过去了"）。所以解法是**不追尾部**，
而不是放慢输出。
