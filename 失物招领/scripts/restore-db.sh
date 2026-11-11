#!/usr/bin/env bash
set -euo pipefail

mode=compose
if [[ "${1:-}" == --local ]]; then
  mode=local
  shift
fi
if [[ $# -ne 1 || ! -r "$1" || ! -s "$1" ]]; then
  echo '用法：bash scripts/restore-db.sh [--local] <非空备份文件>' >&2
  exit 1
fi
exec 8<"$1"
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
umask 077

exec 9>.deploy.lock
flock 9

if [[ "$mode" == local ]]; then
  # 调用前须手动停止 npm / PM2 应用。
  node scripts/db-snapshot.js restore <&8
else
  docker compose stop app
  docker compose run --rm --no-deps -T app node scripts/db-snapshot.js restore <&8
  docker compose up -d --wait --wait-timeout 120
fi
echo '数据库已恢复'
