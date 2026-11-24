const fs = require('node:fs');
const config = require('./config');
const { calibrationPath } = require('./config');
const { CAMPUS_ZONES } = require('./public/js/campus-map');

const zones = CAMPUS_ZONES.map(({ name, x, y, w, h }) => ({
  name, mapX: x + w / 2, mapY: y + h / 2
}));
const locationPatterns = [
  /行政楼/, /图书馆/, /教学楼\s*A/, /教学楼\s*B/, /超市/,
  /食堂/, /艺术楼/, /医院/, /保卫处/, /宿舍|公寓/, /体育馆/,
  /操场|篮球场/, /校车|站牌/, /校门/, /花园|湖畔|湖/
];

function validPair(a, b, minA, maxA, minB, maxB) {
  return Number.isFinite(a) && a >= minA && a <= maxA &&
    Number.isFinite(b) && b >= minB && b <= maxB;
}

// 无实测标定文件时的离线折算：以 .env 的校园中心点为原点，按示意图线性外推各区域坐标。
// 注意：这是降级近似（约 2 米 / SVG 单位），只用于无 key 的示意图模式做半径匹配与热力分布，
// 不作为实测坐标对外宣称；一旦放入实测标定表，此分支自动失效。
function approxGeo(mapX, mapY) {
  const lng = Number(config.mapCenterLng);
  const lat = Number(config.mapCenterLat);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  const metersPerUnit = 2;
  const lngPerMeter = 1 / (111320 * Math.cos(lat * Math.PI / 180));
  const latPerMeter = 1 / 110540;
  return {
    lng: lng + (Number(mapX) - 500) * metersPerUnit * lngPerMeter,
    lat: lat - (Number(mapY) - 350) * metersPerUnit * latPerMeter
  };
}

// 标定文件历史上存在两种写法，同一路径 data/campus-calibration.json：
//   旧格式（DEPLOY.md / migrate-coords.js）：{ "图书馆": { lng, lat }, ... }
//   新格式（map-config.js / 验收脚本）：{ center:{lng,lat}, zoom, zones:[{name,lng,lat},...] }
// 两种都在此接受，避免写入一种格式时另一种消费者解析失败导致服务端启动崩溃。
function loadCalibration() {
  let source;
  try {
    source = JSON.parse(fs.readFileSync(calibrationPath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      return zones.map((zone) => {
        const geo = approxGeo(zone.mapX, zone.mapY);
        return geo ? { ...zone, ...geo, approx: true } : null;
      }).filter(Boolean);
    }
    throw err;
  }
  if (!source || Array.isArray(source) || typeof source !== 'object') {
    throw new Error('标定表应为以 CAMPUS_ZONES 区域名称为键的 JSON 对象');
  }

  // 新格式：取 zones 数组里的 {name,lng,lat}；center/zoom 不是功能区，忽略。
  if (Array.isArray(source.zones)) {
    const seen = new Map();
    for (const point of source.zones) {
      if (!point || typeof point.name !== 'string' || !validPair(point.lng, point.lat, -180, 180, -90, 90)) continue;
      const zone = zones.find((entry) => entry.name === point.name);
      if (!zone) continue; // 非 CAMPUS_ZONES 的标注点不影响坐标映射
      seen.set(point.name, { ...zone, lng: point.lng, lat: point.lat });
    }
    return Array.from(seen.values());
  }

  // 旧格式：键即 CAMPUS_ZONES 区域名；center 等元数据键跳过而非误报非法。
  const metaKeys = new Set(['center', 'zoom', 'campus', '_说明']);
  return Object.entries(source).map(([name, point]) => {
    if (metaKeys.has(name)) return null;
    const zone = zones.find((entry) => entry.name === name);
    if (!zone || !point || !validPair(point.lng, point.lat, -180, 180, -90, 90)) {
      throw new Error('无效的 GCJ-02 标定区：' + name);
    }
    return { ...zone, lng: point.lng, lat: point.lat };
  }).filter(Boolean);
}

const calibration = loadCalibration();

function closest(entries, distance) {
  return entries.reduce((best, point) => !best || distance(point) < distance(best) ? point : best, null);
}

function coordinates({ mapX, mapY, lng, lat, location }) {
  let svg = validPair(mapX, mapY, 0, 1000, 0, 700) ? { mapX, mapY } : null;
  let geo = validPair(lng, lat, -180, 180, -90, 90) ? { lng, lat } : null;
  if (!svg) {
    const fromLocation = zones.find(({ name }, index) =>
      String(location || '').includes(name) || locationPatterns[index].test(location || ''));
    const fromGeo = geo && closest(calibration, (p) => (lng - p.lng) ** 2 + (lat - p.lat) ** 2);
    const zone = fromLocation || fromGeo;
    if (zone) svg = { mapX: zone.mapX, mapY: zone.mapY };
  }
  if (!geo && svg) {
    const zone = closest(zones, (p) => (svg.mapX - p.mapX) ** 2 + (svg.mapY - p.mapY) ** 2);
    const point = calibration.find((p) => p.name === zone.name);
    if (point) geo = { lng: point.lng, lat: point.lat };
  }
  return { mapX: null, mapY: null, lng: null, lat: null, ...svg, ...geo };
}

module.exports = { coordinates, validPair, calibration, approxGeo };
