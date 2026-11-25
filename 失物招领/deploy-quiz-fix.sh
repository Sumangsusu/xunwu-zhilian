#!/bin/bash
# 部署「补齐招领启事题目 + 管理员详情视图 + 恢复占位图」到生产容器。
# 用法：bash deploy-quiz-fix.sh /path/to/解压源码/失物招领
set -euo pipefail

SRC="${1:?用法: bash deploy-quiz-fix.sh <解压后的失物招领源码目录>}"
D=/opt/xunwu-zhilian/失物招领

[ -f "$SRC/server.js" ] || { echo "SRC_MISSING_SERVER"; exit 1; }
[ -f "$SRC/seed-items.js" ] || { echo "SRC_MISSING_SEED"; exit 1; }
[ -d "$SRC/public/images/placeholder" ] || { echo "SRC_MISSING_PLACEHOLDER"; exit 1; }

# 宿主机同步（下次 docker compose build 会从这里固化进镜像）
cp "$SRC/server.js" "$D/server.js"
cp "$SRC/seed-items.js" "$D/seed-items.js"
mkdir -p "$D/public/images/placeholder"
cp "$SRC"/public/images/placeholder/*.svg "$D/public/images/placeholder/"

C=$(cd "$D" && docker compose ps -q app | head -1)
[ -n "$C" ] || { echo "NO_APP_CONTAINER"; exit 1; }

# 运行容器同步（静态资源实时读盘；后端改动需 restart）
docker cp "$D/server.js" "$C:/app/server.js"
docker cp "$D/seed-items.js" "$C:/app/seed-items.js"
docker exec "$C" mkdir -p /app/public/images/placeholder
docker cp "$D/public/images/placeholder/." "$C:/app/public/images/placeholder/"

# 重灌 50 条演示启事（幂等，含全部招领题目）
docker exec "$C" node /app/seed-items.js
docker restart "$C"

# 库内自检 + 容器文件自检
docker exec "$C" node -e 'const D=require("/app/node_modules/better-sqlite3");const db=new D("/app/data/xunwu.db",{readonly:true});const rows=db.prepare("select type,quiz from items where publisher=?").all("__seed50__");const found=rows.filter(r=>r.type==="found");const withQuiz=found.filter(r=>JSON.parse(r.quiz||"[]").length>0);console.log("DBCHECK seed="+rows.length+" found="+found.length+" foundWithQuiz="+withQuiz.length);if(rows.length!==50||withQuiz.length!==found.length)process.exit(2);'
docker exec "$C" sh -c 'test -s /app/public/images/placeholder/umbrella-blue.svg && echo IMGCHECK_OK'

echo DEPLOY_OK
