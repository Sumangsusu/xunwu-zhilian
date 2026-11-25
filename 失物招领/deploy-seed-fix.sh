#!/bin/bash
# 50条演示启事图文修正 —— 在目标服务器root执行。
# 复用已验证的 deploy-points-online.sh 定位模式；结果写到公网可读的日志+数据库校验。
set +e
HASH=92c1ac4577477d7fb8adcfd3cb02c849b1f1bf93
BASE="https://cdn.jsdelivr.net/gh/Sumangsusu/xunwu-zhilian@${HASH}/%E5%A4%B1%E7%89%A9%E6%8B%9B%E9%A2%86"
DST="$(dirname "$(find /opt/xunwu-zhilian -maxdepth 3 -type f -name server.js | head -1)")"
LOG=/tmp/seedfix-log.txt
: > "$LOG"
cd "$DST" 2>/dev/null
CID=$(docker compose ps -q app 2>/dev/null | head -1)
[ -z "$CID" ] && CID=$(docker ps --format '{{.Names}}' | grep -i app | head -1)
echo "DST=$DST CID=$CID" >> "$LOG"

# 1. 下载脚本到宿主机
curl -fsSL --max-time 60 "$BASE/scripts/gen-placeholder-images.js" -o "$DST/gen-placeholder-images.js" 2>>"$LOG"
echo "gen size=$(wc -c < "$DST/gen-placeholder-images.js" 2>/dev/null)" >> "$LOG"
curl -fsSL --max-time 60 "$BASE/seed-items.js" -o "$DST/seed-items.js" 2>>"$LOG"
echo "seed size=$(wc -c < "$DST/seed-items.js" 2>/dev/null)" >> "$LOG"

if [ -n "$CID" ]; then
  docker cp "$DST/gen-placeholder-images.js" "$CID:/app/scripts/gen-placeholder-images.js" >>"$LOG" 2>&1; echo "cp gen rc=$?" >> "$LOG"
  docker cp "$DST/seed-items.js" "$CID:/app/seed-items.js" >>"$LOG" 2>&1; echo "cp seed rc=$?" >> "$LOG"
  docker exec "$CID" node /app/scripts/gen-placeholder-images.js >>"$LOG" 2>&1; echo "gen rc=$?" >> "$LOG"
  echo "svg=$(docker exec "$CID" sh -c 'ls /app/public/images/placeholder/*.svg 2>/dev/null | wc -l')" >> "$LOG"
  docker exec "$CID" node /app/seed-items.js >>"$LOG" 2>&1; echo "seed rc=$?" >> "$LOG"
  docker exec "$CID" node -e "var D=require('better-sqlite3');var db=new D('/app/data/xunwu.db',{readonly:true});console.log('seed50='+db.prepare(\"SELECT COUNT(*) c FROM items WHERE publisher='__seed50__'\").get().c+' ph='+db.prepare(\"SELECT COUNT(*) c FROM items WHERE publisher='__seed50__' AND image LIKE '/images/placeholder/%'\").get().c);" >>"$LOG" 2>&1
fi
echo "=== DONE ===" >> "$LOG"

# 把日志复制到容器 public 供公网 curl 读取
[ -n "$CID" ] && docker cp "$LOG" "$CID:/app/public/seedfix-log.txt" 2>/dev/null
cat "$LOG"
