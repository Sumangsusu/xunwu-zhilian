#!/usr/bin/env bash
# 寻物智联 · 干净主机一键验收（从零建卷 → /health → down -v → 卷重建 → /health）
#
# 用法：bash deploy/verify-clean-deploy.sh [端口，默认 18080]
#
# 设计约束：
#   1) 不修改当前目录的 .env、data/ 与任何数据卷——全程在 mktemp 隔离目录里跑；
#   2) 使用独立项目名与独立端口，可与 80 端口的正式实例并存；
#   3) 结束时自动清理容器与卷（trap），失败也可直接重跑；
#   4) 只依赖 docker Engine + compose v2 + curl + openssl，不装其他东西。
#
# 验收口径对应 A1：「在一台干净机器上执行部署脚本，站点可用，/health 返回 status=ok」，
# 并额外验证命名卷删除后可从零重建。
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${1:-18080}"
PROJECT="xunwu-cleanverify-$$"
WORK="$(mktemp -d -t xunwu-cleanverify-XXXXXX)"

cleanup() {
  if [[ -d "$WORK/src" ]]; then
    ( cd "$WORK/src" && docker compose -p "$PROJECT" down -v --remove-orphans >/dev/null 2>&1 ) || true
  fi
  rm -rf -- "$WORK"
}
trap cleanup EXIT

echo "[1/6] 检查依赖"
for cmd in docker curl openssl tar; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "缺少命令：$cmd" >&2; exit 1; }
done
docker compose version >/dev/null

# 旧版 curl 不认识 --retry-all-errors，探测后再决定是否追加，避免健康检查误报失败。
RETRY_ARGS=(--retry 10 --retry-delay 2 --retry-connrefused)
if curl --help all 2>/dev/null | grep -q -- '--retry-all-errors'; then
  RETRY_ARGS+=(--retry-all-errors)
fi

echo "[2/6] 复制源码到隔离目录（排除 node_modules / .git 与本地数据库）"
mkdir -p "$WORK/src"
tar -C "$ROOT" --exclude=node_modules --exclude=.git --exclude=.deploy.lock -cf - . \
  | tar -C "$WORK/src" -xf -
rm -f "$WORK"/src/.env "$WORK"/src/data/*.db "$WORK"/src/data/*.db-* 2>/dev/null || true
cd "$WORK/src"

echo "[3/6] 生成隔离 .env（项目名 $PROJECT，端口 $PORT）"
secret="$(openssl rand -hex 32)"
sed "s/^SESSION_SECRET=$/SESSION_SECRET=$secret/" .env.example > .env
printf 'COMPOSE_PROJECT_NAME=%s\nHTTP_PORT=%s\nAPP_IMAGE=xunwu-cleanverify:local\n' "$PROJECT" "$PORT" >> .env
chmod 600 .env
unset secret

echo "[4/6] 首次启动：从零构建镜像并创建命名卷"
docker compose up --build -d --wait --wait-timeout 240
curl -fsS "${RETRY_ARGS[@]}" "http://127.0.0.1:${PORT}/health"
echo
if ! docker volume ls --format '{{.Name}}' | grep -qx "${PROJECT}_database"; then
  echo "数据卷 ${PROJECT}_database 未创建" >&2
  exit 1
fi
echo "  命名卷已创建：${PROJECT}_database / ${PROJECT}_uploads"

echo "[5/6] 删除全部卷后重建（验证卷可重建、站点可再次起来）"
docker compose down -v --remove-orphans
docker compose up -d --wait --wait-timeout 240
curl -fsS "${RETRY_ARGS[@]}" "http://127.0.0.1:${PORT}/health"
echo

echo "[6/6] 通过：干净目录可从零部署，且卷删除后可重建"
echo "     （清理阶段会自动删除本次临时容器与卷）"
