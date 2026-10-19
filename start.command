#!/bin/bash
# 启动 better-leetcode 后端。
#
#   终端里：  bash start.command          （或 bash start.sh，等价）
#   双击：    直接双击这个文件
#
# 关掉这个窗口 / Ctrl-C 就停止。
#
# 改 system prompt **不需要**重启（v0.9.0 起是热重载的），侧边栏 SYS 按钮保存即生效；
# 但改了 server/src/*.ts 需要重跑这个脚本。

set -u

cd "$(dirname "$0")/server" || exit 1

# 双击时窗口会一闪而过，所以只在**出错**时停一下等按键；正常退出不停。
# 用 -t 10 兜底：就算你只是 `bash start.command`，也不会被永久卡住。
pause() {
  if [ -t 0 ]; then
    read -r -t 10 -n 1 -s -p "（10 秒后自动关闭，按任意键立即关闭）" || true
    echo
  fi
}

# ---- Node 版本 ----
if ! command -v node >/dev/null 2>&1; then
  echo "✗ 没有 node。装一个 Node 24（https://nodejs.org）再回来。"
  pause; exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "${NODE_MAJOR:-0}" -lt 22 ]; then
  echo "✗ Node 版本太旧（$(node -v)）。这个项目靠 Node 的类型剥离直接跑 .ts，需要 ≥ 22，推荐 24。"
  pause; exit 1
fi
if [ "${NODE_MAJOR:-0}" -lt 24 ]; then
  echo "⚠️  Node $(node -v) 能跑，但推荐 24（node:sqlite 在 24 上是稳定的）。"
fi

# ---- .env ----
if [ ! -f .env ]; then
  echo "✗ 没有 server/.env"
  echo "  cp .env.example .env 然后填 LLM_API_KEY"
  pause; exit 1
fi
if ! grep -qE '^[[:space:]]*LLM_API_KEY[[:space:]]*=[[:space:]]*[^[:space:]]' .env; then
  echo "⚠️  server/.env 里 LLM_API_KEY 看起来是空的 —— 对话会报错，其余功能正常。"
fi

# ---- 端口 ----
PORT="${PORT:-8787}"
# 只看 LISTEN，别把浏览器连过来的客户端 socket 也算进去
# （lsof -i 不带 -sTCP:LISTEN 会把 Chrome 的 CLOSE_WAIT 也列出来，容易误判）
LISTENERS="$(lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN -t 2>/dev/null | tr '\n' ' ' | sed 's/ *$//')"
if [ -n "${LISTENERS}" ]; then
  echo "✓ 后端已经在跑了（端口 ${PORT}，pid ${LISTENERS}）：http://127.0.0.1:${PORT}"
  echo "  要重启就：kill ${LISTENERS}  然后重新跑这个脚本"
  echo "  （或者回到原来那个窗口按 Ctrl-C）"
  exit 0 # 这不是错误，不停下来等按键
fi

echo "启动中… http://127.0.0.1:${PORT}"
echo "  日志：server/bl-server.log      健康检查：curl -s localhost:${PORT}/health"
echo "  保持这个窗口开着，关掉即停止。"
echo
node src/index.ts
CODE=$?
echo
# Ctrl-C（130）和 kill（143）都是**正常停止**，不该当成错误吓人。
case "${CODE}" in
  0 | 130 | 143) echo "已停止。" ;;
  *)
    echo "✗ 后端异常退出（code=${CODE}）。上面应该有原因；也可以看 server/bl-server.log"
    pause
    ;;
esac
exit "${CODE}"
