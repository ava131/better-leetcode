# tools/probe

对着**真实的力扣页面**做验证的一次性脚本。不是测试套件，是排查工具。

## 为什么需要它们

这个项目大多数 bug 只有对着真实页面才暴露得出来 —— 而且**测试环境必须保真**，
否则会掩盖问题。我们已经因此漏掉过一个致命 bug（见 `docs/TECH-DESIGN.md` ★20）：

> MAIN world 和 ISOLATED world 的 JS 作用域是隔离的。
> 把拦截器和 content script 注进**同一个 world** 会让一切看起来正常，
> 而真实扩展里它们根本通信不上。

所以这些脚本都用 CDP 的 `worldName` 参数还原真实的 world 结构。

## 前置：起一个带调试端口的 Chrome

用 **profile 副本**（带你力扣登录态，又不动你正在用的那份）。
完整命令见 `cdp.mjs` 文件头注释。

> ⚠️ 用完记得 `rm -rf /tmp/lc-chrome` —— 里面有你的 cookie 副本。

## 脚本

| 脚本 | 用途 |
|---|---|
| `capture-api.mjs` | **抓力扣页面自己发的 GraphQL**。力扣改 schema 时用它重新确认字段名（`docs/R0-captured-api.md` 的字段就是这么来的） |
| `e2e.mjs` | **端到端回归**：保真 world 结构 + 真实点击提交按钮，验证 `灰 → 蓝 → 绿` 状态流转与换 tab 不清空会话 |
| `ui-wiring.mjs` | 界面接线回归：发送按钮 / 回车 / Shift+Enter / 停止 / 把面板拉大后仍可用 |
| `scroll.mjs` | **滚动跟随回归**：贴底才跟随、往上滚不被拽走、`anchor()` 停在回答开头、真滚轮能停住。第二节用 `CHROME_STUB` 的**假流式**回复真的发一条，**不花额度、不碰账号** |
| `selfcheck.mjs` | **不开浏览器**：把"模板字符串生成出来、要注入页面的代码"当独立文件跑 `node --check` |

```bash
node tools/probe/selfcheck.mjs                # 最快，先跑这个
node tools/probe/capture-api.mjs linked-list-cycle
node tools/probe/ui-wiring.mjs
node tools/probe/scroll.mjs
node tools/probe/e2e.mjs linked-list-cycle    # ⚠️ 会真的提交一次
```

`e2e.mjs` 会往你的账号提交一条记录（默认用正确解，尽量不污染）。

**不需要登录**：`ui-wiring.mjs` / `scroll.mjs` 用全新空 profile 就行（空 profile 里
扩展会被识别成"后端未连接"？不会 —— `CHROME_STUB` 会替掉 `chrome.*`，健康检查走桩）。
`capture-api.mjs` / `e2e.mjs` 要读编辑器和真实判题，才需要登录态。

★ 改 `CHROME_STUB` 或任何注入脚本之后，**先跑 `selfcheck.mjs`**：模板字符串里的
`\n` 会在生成时被解码成真换行，让整段桩代码 `SyntaxError` 而**静默不执行**，
表现是整个 harness 一片红、看着像扩展坏了（踩过两次）。

## 排查后端在不在收到请求

```bash
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/diag          # 扩展汇报上来的事件
tail -f server/bl-server.log             # 后端日志（含 [ext] 行）
```
