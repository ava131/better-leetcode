#!/bin/bash
# `bash start.sh` 的别名 —— 有些人记不住 macOS 的 .command 后缀。
# 真正的逻辑都在 start.command 里，两边不会走散。
cd "$(dirname "$0")" || exit 1
exec bash ./start.command "$@"
