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
grep -q "HEAT_STOPS" "$SRC/public/js/campus-map.js"
grep -q "heat-legend-bar" "$SRC/public/css/style.css"
grep -q "legend-bar" "$SRC/public/heatmap.html"
CID=$(docker ps -q -f name=xunwu-zhilian-app | head -1)
[ -z "$CID" ] && CID=$(docker ps --format '{{.ID}} {{.Names}}' | grep -iE 'xunwu|xunw' | head -1 | awk '{print $1}')
echo "CID=$CID"
test -n "$CID"
for f in js/campus-map.js css/style.css heatmap.html admin.html; do
  cp -f "$DST/public/$f" "$DST/public/$f.bak-heat" 2>/dev/null || true
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
curl -sS --max-time 10 http://127.0.0.1/js/campus-map.js | grep -o "HEAT_STOPS" | head -1
curl -sS --max-time 10 http://127.0.0.1/css/style.css | grep -o "heat-legend-bar" | head -1
echo "=== DEPLOY_DONE ==="
