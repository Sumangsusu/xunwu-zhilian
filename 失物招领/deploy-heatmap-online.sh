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
grep -q "0.4: 'rgba(234,179,8,0.26)'" "$SRC/public/js/campus-map.js" || { echo "FATAL: 源码非气象色带调色版"; exit 3; }
grep -q "onMarkerClick" "$SRC/public/heatmap.html" || { echo "FATAL: heatmap.html 非散点版"; exit 3; }
grep -q "onMarkerClick" "$SRC/public/admin.html" || { echo "FATAL: admin.html 非散点版"; exit 3; }
CID=$(docker ps -q -f name=xunwu-zhilian-app | head -1)
[ -z "$CID" ] && CID=$(docker ps --format '{{.ID}} {{.Names}}' | grep -iE 'xunwu|xunw' | head -1 | awk '{print $1}')
echo "CID=$CID"
test -n "$CID"
for f in js/campus-map.js heatmap.html admin.html; do
  cp -f "$DST/public/$f" "$DST/public/$f.bak-gridkde" 2>/dev/null || true
  cp -f "$SRC/public/$f" "$DST/public/$f"
  docker cp "$DST/public/$f" "$CID:/app/public/$f"
  echo "deployed $f"
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
curl -sS --max-time 10 http://127.0.0.1/heatmap.html | grep -o "onMarkerClick" | head -1
echo "=== DEPLOY_DONE ==="
