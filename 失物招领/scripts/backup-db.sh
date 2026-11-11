#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
umask 077

exec 9>.deploy.lock
flock 9

backup_dir=${BACKUP_DIR:-backups}
keep=${BACKUP_KEEP:-7}
if [[ ! "$keep" =~ ^[1-9][0-9]{0,3}$ ]]; then
  echo 'BACKUP_KEEP 必须为 1 到 9999' >&2
  exit 1
fi
case "${1:-}" in
  --local) command=(node scripts/db-snapshot.js backup) ;;
  '') command=(docker compose exec -T app node scripts/db-snapshot.js backup) ;;
  *) echo '用法：bash scripts/backup-db.sh [--local]' >&2; exit 1 ;;
esac

mkdir -p -- "$backup_dir"
tmp=$(mktemp -- "$backup_dir/.xunwu-XXXXXXXX")
trap 'rm -f -- "$tmp"' EXIT
"${command[@]}" > "$tmp"
backup="$backup_dir/xunwu-$(date -u +%Y%m%dT%H%M%S%N)-${tmp##*-}.db"
mv -- "$tmp" "$backup"
trap - EXIT

export LC_ALL=C
shopt -s nullglob
snapshots=("$backup_dir"/xunwu-????????T???????????????-????????.db)
if (( ${#snapshots[@]} > keep )); then
  rm -f -- "${snapshots[@]:0:${#snapshots[@]}-keep}"
fi
printf '%s\n' "$backup"
