const fs = require('node:fs');
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

function loadCalibration() {
  let source;
  try {
    source = JSON.parse(fs.readFileSync(calibrationPath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  if (!source || Array.isArray(source) || typeof source !== 'object') {
    throw new Error('标定表应为以 CAMPUS_ZONES 区域名称为键的 JSON 对象');
  }
  return Object.entries(source).map(([name, point]) => {
    const zone = zones.find((entry) => entry.name === name);
    if (!zone || !point || !validPair(point.lng, point.lat, -180, 180, -90, 90)) {
      throw new Error('无效的 GCJ-02 标定区：' + name);
    }
    return { ...zone, lng: point.lng, lat: point.lat };
  });
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

module.exports = { coordinates, validPair, calibration };
