set -e
cd /tmp && rm -rf xw-heat && mkdir -p xw-heat
curl -fsSL --retry 3 --retry-delay 2 https://codeload.github.com/Sumangsusu/xunwu-zhilian/tar.gz/refs/heads/fix/ocr-garbage-fill -o xw-heat/m.tgz
tar -xzf xw-heat/m.tgz -C xw-heat
SRC=$(dirname $(dirname $(dirname $(find /tmp/xw-heat -type f -name campus-map.js | head -1))))
DST=$(dirname $(find /opt/xunwu-zhilian -maxdepth 3 -type f -name server.js | head -1))
echo "SRC=$SRC"
echo "DST=$DST"
test -f "$SRC/public/js/campus-map.js"
test -f "$DST/server.js"
grep -q "heat-wash-layer" "$SRC/public/js/campus-map.js" || { echo "FATAL: 源码非底色渐变版"; exit 3; }
grep -q "styleId: 'dot'" "$SRC/public/js/campus-map.js" || { echo "FATAL: 源码非统一定位小点版"; exit 3; }
grep -q 'stdDeviation="34"' "$SRC/public/js/campus-map.js" || { echo "FATAL: 源码非气象式低透明色带版"; exit 3; }
grep -q "const core = 2.6" "$SRC/public/js/campus-map.js" || { echo "FATAL: 源码非小点状版"; exit 3; }
grep -q "function buildGridHeatField" "$SRC/public/js/campus-map.js" || { echo "FATAL: 源码非网格KDE平滑色场版"; exit 3; }
grep -q "const field = buildGridHeatField(pts)" "$SRC/public/js/campus-map.js" || { echo "FATAL: 热力层未用网格密度场"; exit 3; }
grep -q "Math.pow(ratio, 1.6)" "$SRC/public/js/campus-map.js" || { echo "FATAL: 源码非gamma压缩版（仍会全粉）"; exit 3; }
grep -q "1: 'rgba(225,29,72,0.30)'" "$SRC/public/js/campus-map.js" || { echo "FATAL: 源码非低alpha色带版"; exit 3; }
grep -q "onMarkerClick" "$SRC/public/heatmap.html" || { echo "FATAL: heatmap.html 非散点版"; exit 3; }
grep -q "onMarkerClick" "$SRC/public/admin.html" || { echo "FATAL: admin.html 非散点版"; exit 3; }
# 后端坐标局部插值：确保同地点多条启事不再折叠到同一坐标（50 条 -> 14 坐标的修复）
grep -q "const offX = Number(svg.mapX) - Number(zone.mapX)" "$SRC/coordinates.js" || { echo "FATAL: coordinates.js 非局部插值版（仍会坐标重叠）"; exit 3; }
grep -q "Math.round(lng \* 1e6) / 1e6" "$SRC/coordinates.js" || { echo "FATAL: coordinates.js 无插值坐标量化"; exit 3; }
grep -q "toFixed(5)" "$SRC/server.js" || { echo "FATAL: server.js heatmap 接口仍截断坐标到 3 位（会折叠重叠）"; exit 3; }
CID=$(docker ps -q -f name=xunwu-zhilian-app | head -1)
[ -z "$CID" ] && CID=$(docker ps --format '{{.ID}} {{.Names}}' | grep -iE 'xunwu|xunw' | head -1 | awk '{print $1}')
echo "CID=$CID"
test -n "$CID"
for f in js/campus-map.js heatmap.html admin.html; do
  cp -f "$DST/public/$f" "$DST/public/$f.bak-gamma" 2>/dev/null || true
  cp -f "$SRC/public/$f" "$DST/public/$f"
  docker cp "$DST/public/$f" "$CID:/app/public/$f"
  echo "deployed $f"
done
# 后端坐标映射：与 server.js 同级的 coordinates.js / server.js（不在 public 下）
for bf in coordinates.js server.js; do
  test -f "$SRC/$bf" && test -f "$DST/$bf"
  cp -f "$DST/$bf" "$DST/$bf.bak-disperse" 2>/dev/null || true
  cp -f "$SRC/$bf" "$DST/$bf"
  docker cp "$DST/$bf" "$CID:/app/$bf"
  echo "deployed $bf"
done
docker restart "$CID" >/dev/null
sleep 8
echo "=== HEALTH ==="
curl -sS --max-time 10 http://127.0.0.1/health
echo ""
echo "=== ONLINE CHECK ==="
curl -sS --max-time 10 http://127.0.0.1/js/campus-map.js | grep -o "heat-wash-layer" | head -1
curl -sS --max-time 10 http://127.0.0.1/js/campus-map.js | grep -o 'stdDeviation="34"' | head -1
curl -sS --max-time 10 http://127.0.0.1/js/campus-map.js | grep -o "const core = 2.6" | head -1
curl -sS --max-time 10 http://127.0.0.1/js/campus-map.js | grep -o "function buildGridHeatField" | head -1
curl -sS --max-time 10 http://127.0.0.1/js/campus-map.js | grep -o "Math.pow(ratio, 1.6)" | head -1
curl -sS --max-time 10 http://127.0.0.1/heatmap.html | grep -o "onMarkerClick" | head -1
echo "=== COORD DISPERSION (total / unique) ==="
curl -sS --max-time 15 http://127.0.0.1/api/items/heatmap > /tmp/heat-check.json
node -e "const d=require('/tmp/heat-check.json');const a=d.items||d.data||d;const u=new Set(a.map(i=>i.lng+','+i.lat));console.log('items='+a.length+' uniqueCoords='+u.size);" 2>/dev/null || echo "node check skipped"
echo "=== DEPLOY_DONE ==="
