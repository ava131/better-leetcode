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

```bash
node tools/probe/capture-api.mjs linked-list-cycle
node tools/probe/e2e.mjs linked-list-cycle    # ⚠️ 会真的提交一次
```

`e2e.mjs` 会往你的账号提交一条记录（默认用正确解，尽量不污染）。

## 排查后端在不在收到请求

```bash
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/diag          # 扩展汇报上来的事件
tail -f server/bl-server.log             # 后端日志（含 [ext] 行）
```
