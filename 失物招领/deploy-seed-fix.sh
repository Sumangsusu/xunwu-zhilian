#!/bin/bash
# 部署 50 条演示启事的图文修正（v2：带诊断日志回传）
# 结果日志最后复制到容器内 /app/public/seedfix-log.txt，公网可 curl 读取。
set +e
D=/opt/xunwu-zhilian/失物招领
LOG=/tmp/seedfix-log.txt
HASH=4ada98e0793cb73d2d5c1ab983f12daf73ce3531
BASE="https://cdn.jsdelivr.net/gh/Sumangsusu/xunwu-zhilian@${HASH}/%E5%A4%B1%E7%89%A9%E6%8B%9B%E9%A2%86"
CN=$(docker ps --format '{{.Names}}' | grep -i app | head -1)

{
echo "=== $(date '+%F %T') seed-fix v2 start ==="
echo "container=$CN"

echo "--- 1. download scripts (with retry) ---"
for try in 1 2 3; do
  curl -fsSL --max-time 60 "$BASE/scripts/gen-placeholder-images.js" -o /tmp/gen-placeholder-images.js && break
  echo "gen download retry $try"; sleep 3
done
echo "gen.js bytes: $(wc -c < /tmp/gen-placeholder-images.js 2>/dev/null)"
for try in 1 2 3; do
  curl -fsSL --max-time 60 "$BASE/seed-items.js" -o /tmp/seed-items.js && break
  echo "seed download retry $try"; sleep 3
done
echo "seed.js bytes: $(wc -c < /tmp/seed-items.js 2>/dev/null)"
head -1 /tmp/seed-items.js

echo "--- 2. copy into container ---"
[ -z "$CN" ] && { echo "NO APP CONTAINER"; exit 1; }
docker cp /tmp/gen-placeholder-images.js "$CN:/app/scripts/gen-placeholder-images.js" 2>&1; echo "cp gen rc=$?"
docker cp /tmp/seed-items.js "$CN:/app/seed-items.js" 2>&1; echo "cp seed rc=$?"

echo "--- 3. generate placeholders in container ---"
docker exec "$CN" node /app/scripts/gen-placeholder-images.js 2>&1; echo "gen rc=$?"
echo "svg count: $(docker exec "$CN" sh -c 'ls /app/public/images/placeholder/*.svg 2>/dev/null | wc -l')"

echo "--- 4. reseed ---"
docker exec "$CN" node /app/seed-items.js 2>&1; echo "seed rc=$?"

echo "--- 5. db verify ---"
docker exec "$CN" node -e "var D=require('better-sqlite3');var db=new D('/app/data/xunwu.db',{readonly:true});var c=db.prepare(\"SELECT COUNT(*) c FROM items WHERE publisher='__seed50__'\").get().c;var p=db.prepare(\"SELECT COUNT(*) c FROM items WHERE publisher='__seed50__' AND image LIKE '/images/placeholder/%'\").get().c;console.log('seed50='+c+' placeholder='+p);" 2>&1

echo "=== DONE $(date '+%T') ==="
} > "$LOG" 2>&1

# 把日志复制进容器 public 目录，供公网 curl 读取诊断
[ -n "$CN" ] && docker cp "$LOG" "$CN:/app/public/seedfix-log.txt" 2>/dev/null
