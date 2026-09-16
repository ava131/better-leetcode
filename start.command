#!/bin/bash
# 双击启动 better-leetcode 后端。关掉这个窗口就停止。
cd "$(dirname "$0")/server" || exit 1

if [ ! -f .env ]; then
  echo "✗ 没有 server/.env —— 先复制 .env.example 为 .env 并填入 LLM_API_KEY"
  read -n 1 -s -r -p "按任意键关闭…"
  exit 1
fi

if lsof -nP -iTCP:8787 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "✓ 后端已经在跑了（端口 8787）。"
  echo "  如果要重启，先关掉原来那个窗口。"
  read -n 1 -s -r -p "按任意键关闭…"
  exit 0
fi

echo "启动中… 保持这个窗口开着，关掉即停止。"
echo
exec node src/index.ts
