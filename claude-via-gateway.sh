#!/usr/bin/env bash
# 通过本网关启动 Claude Code：
#   1. 先启动网关:  npm run gateway   （上游/GW_UPSTREAM 与 token 兜底自动读 claude.settings）
#   2. 再运行本脚本: ./claude-via-gateway.sh
# claude.settings 中 ANTHROPIC_BASE_URL 已指向网关；直连上游备份在 ANTHROPIC_BASE_URL_BAK
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ! curl -s -m 2 http://127.0.0.1:8787/api/health >/dev/null 2>&1; then
  echo "[claude-via-gateway] ⚠ 网关未启动，请先运行: npm run gateway"
  exit 1
fi
echo "[claude-via-gateway] 网关在线，启动 claude（settings: $DIR/claude.settings）"
exec claude --settings "$DIR/claude.settings" "$@"
