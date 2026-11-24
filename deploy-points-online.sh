#!/bin/bash
# 寻物智联 · 积分与等级体系上线脚本
# 在目标服务器上以 root 执行：同步源码到宿主机、热替换进运行容器、重启、自检。
# 幂等：可重复执行；每次执行前会把将被覆盖的文件备份到 /root/xw-backup-<时间戳>。

set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
# 本脚本位于仓库根，真正的应用源码在「失物招领」子目录，需向下定位 server.js
SRC="$(dirname "$(find "$ROOT" -maxdepth 3 -type f -name server.js | head -1)")"
if [ -z "$SRC" ] || [ ! -f "$SRC/server.js" ]; then
  echo "FAIL: 源码目录定位失败（未在 $ROOT 下找到 server.js）"
  ls -1 "$ROOT" | head -20
  exit 1
fi
DST="$(dirname "$(find /opt/xunwu-zhilian -maxdepth 3 -type f -name server.js | head -1)")"

if [ -z "$DST" ] || [ ! -f "$DST/server.js" ]; then
  echo "FAIL: 未定位到生产目录（/opt/xunwu-zhilian 下的 server.js）"
  echo "现有目录："
  ls -1 /opt 2>/dev/null
  exit 1
fi
echo "SRC=$SRC"
echo "DST=$DST"

# ---------- 1. 备份 ----------
STAMP=$(date +%Y%m%d%H%M%S)
BK="/root/xw-backup-$STAMP"
mkdir -p "$BK"
for f in server.js db.js points.js quiz.js package.json package-lock.json; do
  [ -f "$DST/$f" ] && cp -f "$DST/$f" "$BK/$f"
done
[ -d "$DST/public" ] && cp -a "$DST/public" "$BK/public"
echo "BACKUP=$BK"

# ---------- 2. 同步源码到宿主机 ----------
FILES="server.js db.js points.js quiz.js matcher.js coordinates.js recognize.js recognize-map.js package.json package-lock.json seed-items.js"
for f in $FILES; do
  if [ -f "$SRC/$f" ]; then
    cp -f "$SRC/$f" "$DST/$f"
    echo "sync $f"
  fi
done
if [ -d "$SRC/public" ]; then
  cp -rf "$SRC/public/." "$DST/public/"
  echo "sync public/"
fi

# 同步后强制校验，避免「路径错了但脚本仍退出 0」的静默失败
if ! grep -q "api/points" "$DST/server.js"; then
  echo "FAIL: 宿主机 server.js 未包含积分路由，同步未生效"
  exit 1
fi
if [ ! -f "$DST/points.js" ] || [ ! -f "$DST/public/points.html" ]; then
  echo "FAIL: points.js 或 public/points.html 未同步到位"
  exit 1
fi
echo "sync verified: server.js + points.js + public/points.html"

# ---------- 3. 定位运行容器 ----------
cd "$DST"
echo "=== compose ps ==="
docker compose ps 2>&1 | head -10
CID=$(docker compose ps -q app 2>/dev/null | head -1)
[ -z "$CID" ] && CID=$(docker compose ps -q 2>/dev/null | head -1)
[ -z "$CID" ] && CID=$(docker ps --format '{{.ID}} {{.Names}}' | grep -iE 'xunwu|xunw' | head -1 | awk '{print $1}')
if [ -z "$CID" ]; then
  echo "FAIL: 未找到运行中的应用容器"
  docker ps
  exit 1
fi
echo "CID=$CID"

# ---------- 4. 热替换进容器 ----------
for f in server.js db.js points.js quiz.js matcher.js coordinates.js recognize.js recognize-map.js package.json; do
  [ -f "$DST/$f" ] && docker cp "$DST/$f" "$CID:/app/$f" && echo "cp $f -> container"
done
docker cp "$DST/public/." "$CID:/app/public"
echo "cp public -> container"

docker restart "$CID" >/dev/null
echo "容器已重启，等待健康检查..."

# ---------- 5. 自检 ----------
OK=0
for i in $(seq 1 30); do
  sleep 2
  H=$(curl -s --max-time 3 http://127.0.0.1/health 2>/dev/null || true)
  if [ -n "$H" ]; then
    echo "HEALTH=$H"
    OK=1
    break
  fi
done
[ "$OK" = "0" ] && echo "WARN: 健康检查 60 秒内未通过，请查看 docker logs $CID"

echo "=== 容器内关键文件 ==="
docker exec "$CID" sh -c 'ls -l /app/points.js /app/public/points.html /app/db.js' 2>&1 | head -5
echo "=== 页面与接口 ==="
curl -s -o /dev/null -w "points_page=%{http_code}\n" --max-time 8 http://127.0.0.1/points
curl -s -o /dev/null -w "points_api=%{http_code}\n" --max-time 8 "http://127.0.0.1/api/points/leaderboard?limit=1"
echo "=== 榜单前 3 ==="
curl -s --max-time 10 "http://127.0.0.1/api/points/leaderboard?limit=3" | head -c 700
echo
echo "=== 表结构 ==="
docker exec "$CID" node -e "const D=require('better-sqlite3');const db=new D(process.env.DB_PATH||'/app/data/xunwu.db',{readonly:true});try{console.log('point_events:',db.prepare('select count(*) c from point_events').get().c);console.log('with_points:',db.prepare('select count(*) c from users where points > 0').get().c);}catch(e){console.log('ERR',e.message)}" 2>&1 | head -5
echo "DEPLOY_DONE"
