#!/bin/bash
# 部署 50 条演示启事的图文修正：下载生成脚本+种子脚本，容器内生成占位图并重灌数据库。
# 由云助手执行；结果写到 nginx 挂载的 acme-challenge 目录，便于本地 curl 回读。
set +e
D=/opt/xunwu-zhilian/失物招领
V="$D/deploy/acme/.well-known/acme-challenge"
LOG="$V/seedfix-result.txt"
mkdir -p "$V"
HASH=1ca132e08d258a972294f6b4bed55f69448c6c86
BASE="https://cdn.jsdelivr.net/gh/Sumangsusu/xunwu-zhilian@${HASH}/%E5%A4%B1%E7%89%A9%E6%8B%9B%E9%A2%86"

{
echo "=== $(date '+%F %T') seed-fix start ==="

echo "--- 1. download scripts to host /tmp ---"
curl -fsSL --max-time 60 "$BASE/scripts/gen-placeholder-images.js" -o /tmp/gen-placeholder-images.js
echo "gen.js: $(wc -c < /tmp/gen-placeholder-images.js 2>/dev/null) bytes"
curl -fsSL --max-time 60 "$BASE/seed-items.js" -o /tmp/seed-items.js
echo "seed.js: $(wc -c < /tmp/seed-items.js 2>/dev/null) bytes"

echo "--- 2. container name ---"
CN=$(docker ps --format '{{.Names}}' | grep -i app | head -1)
echo "container=$CN"
[ -z "$CN" ] && { echo "NO APP CONTAINER"; echo "=== FAILED ==="; exit 1; }

echo "--- 3. copy scripts into container ---"
docker cp /tmp/gen-placeholder-images.js "$CN:/app/scripts/gen-placeholder-images.js" && echo "cp gen OK"
docker cp /tmp/seed-items.js "$CN:/app/seed-items.js" && echo "cp seed OK"

echo "--- 4. generate placeholders inside container ---"
docker exec "$CN" node /app/scripts/gen-placeholder-images.js 2>&1
echo "svg count: $(docker exec "$CN" sh -c 'ls /app/public/images/placeholder/*.svg 2>/dev/null | wc -l')"

echo "--- 5. reseed 50 items ---"
docker exec "$CN" node /app/seed-items.js 2>&1

echo "--- 6. verify via local api ---"
docker exec "$CN" node -e "const D=require('better-sqlite3');const db=new D('/app/data/xunwu.db',{readonly:true});const r=db.prepare(\"SELECT COUNT(*) c FROM items WHERE publisher='__seed50__'\").get();const ph=db.prepare(\"SELECT COUNT(*) c FROM items WHERE publisher='__seed50__' AND image LIKE '/images/placeholder/%'\").get();console.log('seed50='+r.c+' placeholder='+ph.c);" 2>&1

echo "=== DONE ==="
} > "$LOG" 2>&1
