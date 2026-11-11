const fs = require('node:fs');
const { dbPath, calibrationPath } = require('../config');
const { calibration, coordinates } = require('../coordinates');

if (!fs.existsSync(dbPath)) throw new Error('找不到数据库：' + dbPath);
if (!calibration.length) throw new Error('缺少实测 GCJ-02 标定数据：' + calibrationPath);
const { db, mapItem } = require('../db');

// SVG 中心由 public/js/campus-map.js 的 CAMPUS_ZONES 算出。
// 例如图书馆 (420,100) 对应标定表中同名区域的 {lng,lat}。
// 旧点归到最近的 SVG 区域中心。该区域缺测时保留原坐标，经纬度留空。
const migrate = db.transaction(() => {
  const rows = db.prepare('SELECT * FROM items WHERE lng IS NULL OR lat IS NULL').all();
  const update = db.prepare('UPDATE items SET map_x = ?, map_y = ?, lng = ?, lat = ? WHERE id = ?');
  let migrated = 0;
  for (const row of rows) {
    const { mapX, mapY, lng, lat } = coordinates(mapItem(row));
    if (lng == null || lat == null) continue;
    update.run(mapX, mapY, lng, lat, row.id);
    migrated++;
  }
  return { migrated, remaining: rows.length - migrated };
});
try {
  console.log(JSON.stringify(migrate.immediate()));
} finally {
  db.close();
}
