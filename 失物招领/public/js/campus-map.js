// ==================== 校园地图组件 ====================
// 两套渲染：腾讯地图 GL JS（GCJ-02 真实底图） + 自绘 SVG（内网 / 断网 / 无 key 降级）。
//
// B1 合规要点（对照任务清单第四节）：
//   - 底图只用合规服务商；SDK 脚本地址与 key 一律由后端配置接口下发，
//     前端仓库只保留占位符与域名白名单校验，不出现任何可用 key 或写死的外部地址；
//   - 坐标系 GCJ-02：SDK 事件返回的 latLng 直接入库，不做坐标系转换，
//     也不把 WGS-84 / BD-09 喂给 SDK（否则点位整体偏移）；
//   - 热力图采用「小点定位 + 气象式平滑色场」：每条启事只画一个极小的点状标记（携带真实
//     坐标与 id，点击可打开对应启事）；集中程度由一层连续平滑的密度色场表达（类似降水量 /
//     气温分布图）：把散点铺成规则网格、用高斯 KDE 估算每个格点的连续密度，再由官方热力层
//     插值成柔和色带，绝不出现一个个孤立色斑（点阵）。底图路网始终清晰可见，不叠加外晕 /
//     计数圆圈。进入前端的数据先做字段白名单，联系方式、图片、描述、防冒领问答一律不进入
//     页面全局对象；
//   - 地图容器使用固定像素高度，避免 flex 布局下高度为 0 导致白屏；
//   - 不自绘国界、不改官方底图标注；不使用预览环境的运行时代理模板；
//   - 官方真实 API：TMap.Map / TMap.LatLng / TMap.MultiMarker / TMap.MarkerStyle /
//     TMap.visualization.Heat / TMap.service.Geocoder，不手拼 WebService 代理 URL。
//
// 本文件顶层只放数据与纯函数，浏览器专属逻辑放在末尾 IIFE 内，
// 因此 Node 也能 require 本模块（A 的 coordinates.js 依赖 CAMPUS_ZONES），
// 同时验收脚本可以对纯逻辑做真实运行时测试。

const CAMPUS_MAP_W = 1000;
const CAMPUS_MAP_H = 700;

// 校园功能区（矩形区域），x/y 为左上角，w/h 为宽高
const CAMPUS_ZONES = [
  { name: '行政楼', x: 80, y: 40, w: 160, h: 100 },
  { name: '图书馆', x: 320, y: 40, w: 200, h: 120 },
  { name: '教学楼A座', x: 600, y: 40, w: 160, h: 100 },
  { name: '教学楼B座', x: 790, y: 40, w: 160, h: 100 },
  { name: '超市', x: 80, y: 220, w: 150, h: 90 },
  { name: '食堂', x: 290, y: 210, w: 190, h: 110 },
  { name: '艺术楼', x: 560, y: 210, w: 170, h: 110 },
  { name: '校医院', x: 790, y: 210, w: 140, h: 90 },
  { name: '保卫处', x: 80, y: 420, w: 140, h: 90 },
  { name: '学生公寓', x: 280, y: 400, w: 240, h: 140 },
  { name: '体育馆', x: 580, y: 400, w: 160, h: 110 },
  { name: '操场', x: 790, y: 390, w: 170, h: 140 },
  { name: '校车站牌', x: 80, y: 560, w: 140, h: 80 },
  { name: '校门', x: 280, y: 570, w: 160, h: 90 },
  { name: '湖畔花园', x: 560, y: 560, w: 200, h: 110 }
];

const CAMPUS_ZONE_COLORS = {
  '行政楼': '#E8EAF6', '图书馆': '#E3F2FD', '教学楼A座': '#E8EAF6', '教学楼B座': '#E8EAF6',
  '艺术楼': '#F3E5F5', '超市': '#FFF3E0', '食堂': '#FFF8E1', '校医院': '#FFEBEE',
  '保卫处': '#ECEFF1', '学生公寓': '#E8F5E9', '体育馆': '#E0F7FA', '操场': '#F1F8E9',
  '校车站牌': '#FFFDE7', '校门': '#EDE7F6', '湖畔花园': '#E0F2F1'
};

// 合规服务商域名白名单（不含协议，避免把外部地址写进前端业务代码）
const MAP_ALLOWED_HOST = 'map.qq.com';
// 地图容器固定高度（px）。flex 布局下不显式给高度会白屏。
const MAP_GL_HEIGHT = 460;
// 密度采样半径，约 300 米（武大尺度下一个功能区量级）：仅用于计算「某点周围有多密集」
// 以决定该点的热力渐变权重。半径太小会让 50 条散点的邻居数全是 1，热力层归一化后近乎透明、看不出色带。
// 不再把多条启事合并成一个点。每条启事保留自己的真实坐标与 id，可点击打开详情。
const HEAT_GRID_DEG = 0.003;
// 后端下发地图配置的接口（由 A 的部署侧实现；仓库内只有接口路径，没有 key）
const MAP_CONFIG_ENDPOINT = '/api/map/config';

// ===== 热力视觉：气象式底色色带（降水量 / 气温分布图观感） =====
// 4 档色阶沿用气象惯用的冷到暖：青绿(稀疏) → 黄(一般) → 橙(集中) → 玫红(高发)。
// 色值只用于「半透明、边缘柔和、彼此连片」的底色带（GL Heat / SVG 模糊色带 / PNG 导出），
// 不画在定位小点上。wash alpha 取中等值：太高压住底图、太低（上一版 0.06）肉眼看不出色带。
const HEAT_STOPS = [
  { key: 'low', name: '稀疏', main: '#0E9F8E', light: '#5EEAD4', dark: '#0B6E63', wash: 0.20 },
  { key: 'mid', name: '一般', main: '#EAB308', light: '#FDE047', dark: '#A16207', wash: 0.25 },
  { key: 'high', name: '集中', main: '#EA580C', light: '#FDBA74', dark: '#9A3412', wash: 0.30 },
  { key: 'peak', name: '高发', main: '#E11D48', light: '#FDA4AF', dark: '#9F1239', wash: 0.34 }
];
// 按聚合条数取色阶档位（1-2 / 3-4 / 5-6 / 7+）
function heatStop(count) {
  const n = Number(count) || 1;
  const idx = n >= 7 ? 3 : (n >= 5 ? 2 : (n >= 3 ? 1 : 0));
  return HEAT_STOPS[idx];
}

// ===== 平滑密度场（高斯 KDE 网格化）=====
// 关键：不能把「每条启事一个散点」直接喂给热力层——散点间距大于核半径时，每个点被画成
// 一个孤立色斑，连不成片，看起来就是点阵。这里先在所有散点的外接矩形上铺一张规则网格，
// 用高斯核密度估计（KDE）给每个格点算一个连续强度，再交给官方热力层插值成平滑色带。
// 网格密度场只用于「底色」；每条启事的精确定位与点击仍由独立的小点 marker 承担。
const HEAT_GRID_COLS = 22;          // 网格列数（越多越平滑）
const HEAT_GRID_ROWS = 16;          // 网格行数
const HEAT_GRID_PAD = 0.35;         // 外接矩形外扩比例，避免色带贴边被裁
const HEAT_KDE_SIGMA = 0.0016;      // 高斯核带宽（度，约 160 米），决定色带平滑程度
const HEAT_MAX_LEVELS = 100;        // 密度量化上限，供热力层 max 使用

/**
 * 把散点转成规则网格上的连续密度场（高斯 KDE）。
 * 每个格点的强度 = Σ exp(-d² / (2σ²))，d 为该格点到各启事的距离（经纬度近似等距）。
 * 返回 [{lat, lng, count}]，count 为归一化到 [1, 100] 的连续密度（越高越暖）。
 * 格点坐标由数据外接矩形推导，不引入任何新的底图坐标或外部服务。
 */
function buildGridHeatField(points, opts) {
  const o = opts || {};
  const cols = Number(o.cols) > 0 ? Math.round(Number(o.cols)) : HEAT_GRID_COLS;
  const rows = Number(o.rows) > 0 ? Math.round(Number(o.rows)) : HEAT_GRID_ROWS;
  const sigmaRaw = Number(o.sigma) > 0 ? Number(o.sigma) : HEAT_KDE_SIGMA;
  const pts = (Array.isArray(points) ? points : []).filter(function (p) {
    return p && isFiniteNumber(p.lng) && isFiniteNumber(p.lat) && isChinaGcj02(p.lng, p.lat);
  });
  if (!pts.length) return [];

  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
  pts.forEach(function (p) {
    minLng = Math.min(minLng, Number(p.lng)); maxLng = Math.max(maxLng, Number(p.lng));
    minLat = Math.min(minLat, Number(p.lat)); maxLat = Math.max(maxLat, Number(p.lat));
  });
  // 单点 / 极窄范围时给一个最小跨度，网格不至于退化成一条线
  const spanLng = Math.max(maxLng - minLng, HEAT_KDE_SIGMA * 2);
  const spanLat = Math.max(maxLat - minLat, HEAT_KDE_SIGMA * 2);
  const padLng = spanLng * HEAT_GRID_PAD, padLat = spanLat * HEAT_GRID_PAD;
  const x0 = minLng - padLng, y0 = minLat - padLat;
  const stepLng = (spanLng + padLng * 2) / (cols - 1);
  const stepLat = (spanLat + padLat * 2) / (rows - 1);
  // 带宽至少覆盖 1.5 个格距，保证相邻格点密度连续、色带平滑不呈点阵
  const sigma = Math.max(sigmaRaw, Math.max(stepLng, stepLat) * 1.5);
  const twoSigma2 = 2 * sigma * sigma;

  const raw = [];
  let peak = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const lng = x0 + c * stepLng;
      const lat = y0 + r * stepLat;
      let v = 0;
      for (let i = 0; i < pts.length; i++) {
        const dx = Number(pts[i].lng) - lng;
        const dy = Number(pts[i].lat) - lat;
        v += Math.exp(-(dx * dx + dy * dy) / twoSigma2);
      }
      raw.push({ lat: round6(lat), lng: round6(lng), v: v });
      if (v > peak) peak = v;
    }
  }
  // 归一化到 [0,1]，再做 gamma 压缩：让中低密度也有可见色，同时峰值才到最暖档。
  // count 用连续浮点（非整数档），热力层据此平滑插值出气象图式色带。
  return raw.map(function (cell) {
    const ratio = peak > 0 ? cell.v / peak : 0;
    const shaped = Math.pow(ratio, 0.72);
    return {
      lat: cell.lat,
      lng: cell.lng,
      count: Math.max(0.5, shaped * HEAT_MAX_LEVELS)
    };
  });
}

function isFiniteNumber(v) {
  return v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
}
function round6(n) { return Math.round(Number(n) * 1e6) / 1e6; }

// 中国范围粗校验，用于拦截明显错误的经纬度（WGS-84 直喂之外的脏数据）
function isChinaGcj02(lng, lat) {
  const a = Number(lng), b = Number(lat);
  return Number.isFinite(a) && Number.isFinite(b) &&
    a >= 73 && a <= 135 && b >= 3 && b <= 54;
}

/**
 * 校验后端下发的地图配置。任何不合规都返回 ok:false，由调用方降级到 SVG。
 * 期望结构：{ enabled, sdkUrl, key, center:{lng,lat}, zoom }
 *   sdkUrl 须为合规服务商的 HTTPS 绝对地址，且含 key 与 visualization/service 类库；
 *   key 只存在于运行时的配置响应里，本文件不保存任何值。
 */
function validateMapConfig(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'no-config' };
  if (raw.enabled === false) return { ok: false, reason: 'disabled' };
  const sdkUrl = String(raw.sdkUrl == null ? '' : raw.sdkUrl).trim();
  const key = String(raw.key == null ? '' : raw.key).trim();
  if (!sdkUrl || !key) return { ok: false, reason: 'missing-key-or-url' };

  let u;
  try { u = new URL(sdkUrl); } catch (e) { return { ok: false, reason: 'invalid-url' }; }
  if (u.protocol !== 'https:') return { ok: false, reason: 'insecure-protocol' };
  const host = u.hostname.toLowerCase();
  if (host !== MAP_ALLOWED_HOST && !host.endsWith('.' + MAP_ALLOWED_HOST)) {
    return { ok: false, reason: 'host-not-allowed' };
  }

  const center = raw.center || {};
  const lng = Number(center.lng), lat = Number(center.lat);
  if (!isChinaGcj02(lng, lat)) return { ok: false, reason: 'invalid-center' };
  const zoom = Number(raw.zoom);
  return {
    ok: true,
    reason: '',
    sdkUrl: sdkUrl,
    key: key,
    center: { lng: lng, lat: lat },
    zoom: Number.isFinite(zoom) && zoom >= 3 && zoom <= 20 ? Math.round(zoom) : 16
  };
}

function resolveMapMode(cfg, sdkReady, forceSvg) {
  if (forceSvg) return 'svg';
  if (!cfg || cfg.ok !== true) return 'svg';
  if (!sdkReady) return 'svg';
  return 'gl';
}

/**
 * 热力数据字段白名单。后端 /api/items/heatmap 可能带更多字段，
 * 这里只保留列表与聚合所需的最小集合，联系方式 / 图片 / 描述 / 问答一律丢弃。
 */
function normalizeHeatItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map(function (it) {
    const o = it && typeof it === 'object' ? it : {};
    const pairOk = isFiniteNumber(o.lng) && isFiniteNumber(o.lat) && isChinaGcj02(o.lng, o.lat);
    return {
      id: isFiniteNumber(o.id) ? Number(o.id) : null,
      type: o.type === 'found' ? 'found' : 'lost',
      title: String(o.title == null ? '' : o.title).slice(0, 120),
      location: String(o.location == null ? '' : o.location).slice(0, 120),
      date: String(o.date == null ? '' : o.date).slice(0, 40),
      lng: pairOk ? Number(o.lng) : null,
      lat: pairOk ? Number(o.lat) : null,
      mapX: isFiniteNumber(o.mapX) ? Number(o.mapX) : null,
      mapY: isFiniteNumber(o.mapY) ? Number(o.mapY) : null
    };
  });
}

/**
 * 分散标点 + 密度权重：每条启事保留自己的真实坐标与 id（可点击打开对应启事），
 * 同时计算它周边 HEAT_GRID_DEG 半径内的邻居条数作为 count —— 地图底色的热力层据此
 * 上色，越集中的区域颜色越暖，实现「底色渐变反映集中程度」。
 * 小点本身不带颜色/外晕，只承担定位；也不把多条启事合并成一个网格中心点。
 */
function aggregateHeatPoints(items, gridDeg) {
  const g = Number(gridDeg) > 0 ? Number(gridDeg) : HEAT_GRID_DEG;
  const pts = (Array.isArray(items) ? items : [])
    .filter(function (p) { return p && p.lng != null && p.lat != null && isChinaGcj02(p.lng, p.lat); })
    .map(function (p) {
      return {
        id: p.id != null ? Number(p.id) : null,
        type: p.type === 'found' ? 'found' : 'lost',
        lng: Number(p.lng),
        lat: Number(p.lat),
        approx: !!p.approx
      };
    });
  // 每个点统计半径内的邻居数（含自身），作为热力渐变权重
  const g2 = g * g;
  return pts.map(function (p) {
    let density = 0;
    for (let i = 0; i < pts.length; i++) {
      const dx = pts[i].lng - p.lng;
      const dy = pts[i].lat - p.lat;
      if (dx * dx + dy * dy <= g2) density++;
    }
    return {
      id: p.id,
      type: p.type,
      lng: p.lng,
      lat: p.lat,
      approx: p.approx,
      count: density
    };
  });
}

/**
 * 真实地图模式下，给只有示意图坐标（mapX/mapY）的老启事补一个「区域级」近似经纬度。
 * - 与小程序 heatmap.js 的无经纬度兜底同思路，避免「只要 1 条有真实坐标就切 GL 模式，
 *   其余只带示意图坐标的启事全被 aggregateHeatPoints 丢弃」导致地图上只剩 1 个点。
 * - 折算只依赖后端下发的校园中心点，精度到功能区量级；随后仍走网格聚合，
 *   不对外暴露单条启事的精确坐标。
 * - 有真实 lng/lat 的点原样保留，不覆盖实测数据。
 */
function withApproxGeo(items, center) {
  const c = center && isChinaGcj02(center.lng, center.lat)
    ? { lng: Number(center.lng), lat: Number(center.lat) }
    : { lng: 114.36444, lat: 30.536286 };
  const latRad = c.lat * Math.PI / 180;
  return (Array.isArray(items) ? items : []).map(function (p) {
    if (!p || (p.lng != null && p.lat != null)) return p;
    if (!isFiniteNumber(p.mapX) || !isFiniteNumber(p.mapY)) return p;
    const lng = c.lng + (Number(p.mapX) - 500) * 2 / (111320 * Math.cos(latRad));
    const lat = c.lat - (Number(p.mapY) - 350) * 2 / 110540;
    if (!isChinaGcj02(lng, lat)) return p;
    return Object.assign({}, p, { lng: round6(lng), lat: round6(lat), approx: true });
  });
}

/** 转成官方热力层 setData 的数据格式 [{lat,lng,count}]（count 为邻域密度，决定渐变色） */
function toHeatData(points) {
  return (Array.isArray(points) ? points : []).map(function (p) {
    return { lat: p.lat, lng: p.lng, count: p.count };
  });
}

/** 转成可点击散点标记的数据：[{id,lat,lng,count}]，每条启事一个点、携带真实 id */
function toMarkerData(points) {
  return (Array.isArray(points) ? points : [])
    .filter(function (p) { return p && p.id != null; })
    .map(function (p) {
      return { id: Number(p.id), lat: p.lat, lng: p.lng, count: p.count || 1 };
    });
}

/** SDK 是否支持把多个点纳入视野（选点/降级桩不需要） */
function canFitBounds(map, T) {
  return !!(map && typeof map.fitBounds === 'function' &&
    T && typeof T.LatLngBounds === 'function' && typeof T.LatLng === 'function');
}

/**
 * 把所有聚合点纳入视野并留边距，保证一览时点不贴边、不被控件遮挡。
 * 单点或极小范围时给一个最小跨度，避免放到最大缩放级别。
 */
function fitPoints(map, T, points) {
  if (!Array.isArray(points) || !points.length) return false;
  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
  points.forEach(function (p) {
    if (!isFiniteNumber(p.lng) || !isFiniteNumber(p.lat)) return;
    minLng = Math.min(minLng, p.lng); maxLng = Math.max(maxLng, p.lng);
    minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
  });
  if (!isFiniteNumber(minLng)) return false;
  const spanLng = Math.max(maxLng - minLng, 0.004);
  const spanLat = Math.max(maxLat - minLat, 0.003);
  const padLng = spanLng * 0.35, padLat = spanLat * 0.35;
  const bounds = new T.LatLngBounds(
    new T.LatLng(minLat - padLat, minLng - padLng),
    new T.LatLng(minLat + spanLat + padLat, minLng + spanLng + padLng)
  );
  map.fitBounds(bounds, { padding: 24 });
  return true;
}

/** 地点文字 -> 示意图区域中心，用于给老后端双写 mapX/mapY（不是伪造经纬度） */
function svgPointFromLocation(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return null;
  let z = CAMPUS_ZONES.find(function (v) { return s.indexOf(v.name) >= 0; });
  if (!z) z = CAMPUS_ZONES.find(function (v) { return v.name.indexOf(s) >= 0; });
  if (!z) return null;
  return { x: Math.round(z.x + z.w / 2), y: Math.round(z.y + z.h / 2), zone: z.name };
}

/**
 * 发布选点坐标双写：
 *   GL 模式  -> lng/lat 为 SDK 返回的 GCJ-02 真实坐标；mapX/mapY 按地点文字匹配示意图区域中心
 *   SVG 模式 -> lng/lat 为空，mapX/mapY 为示意图坐标（当前 main 的 POST /api/items 只认这两个）
 * 这样不改后端也能在现有 main 上落库；A3 后端合并后 lng/lat 自动生效。
 */
function buildPublishCoords(sel) {
  const s = sel || {};
  if (s.mode === 'gl' && isChinaGcj02(s.lng, s.lat)) {
    const zp = svgPointFromLocation(s.locationText);
    return {
      lng: round6(Number(s.lng)),
      lat: round6(Number(s.lat)),
      mapX: zp ? zp.x : null,
      mapY: zp ? zp.y : null,
      zone: zp ? zp.zone : '',
      source: 'gl'
    };
  }
  if (s.mode === 'svg' && isFiniteNumber(s.x) && isFiniteNumber(s.y)) {
    return {
      lng: null, lat: null,
      mapX: Math.round(Number(s.x)), mapY: Math.round(Number(s.y)),
      zone: s.zone || '', source: 'svg'
    };
  }
  return { lng: null, lat: null, mapX: null, mapY: null, zone: '', source: 'none' };
}

// ---------------- 自绘 SVG（降级方案，清单要求保留，不整套删除） ----------------

function campusMapMarkup() {
  const roads = `
    <rect x="0" y="180" width="1000" height="26" rx="6" fill="#D5DCE6"/>
    <rect x="0" y="360" width="1000" height="26" rx="6" fill="#D5DCE6"/>
    <rect x="260" y="0" width="26" height="700" rx="6" fill="#D5DCE6"/>
    <rect x="540" y="0" width="26" height="700" rx="6" fill="#D5DCE6"/>
    <rect x="770" y="0" width="26" height="700" rx="6" fill="#D5DCE6"/>`;
  const zones = CAMPUS_ZONES.map((z) => {
    const cx = z.x + z.w / 2;
    const cy = z.y + z.h / 2;
    const color = CAMPUS_ZONE_COLORS[z.name] || '#F1F5F9';
    return `<g class="campus-zone" data-zone="${z.name}" data-cx="${cx}" data-cy="${cy}">
      <rect x="${z.x}" y="${z.y}" width="${z.w}" height="${z.h}" rx="14" fill="${color}" stroke="#B7C0CE" stroke-width="2"/>
      <text x="${cx}" y="${cy + 2}" text-anchor="middle" fill="#334155" font-size="21" font-weight="600">${z.name}</text>
    </g>`;
  }).join('');
  return `<svg class="campus-map-svg w-full h-auto" viewBox="0 0 ${CAMPUS_MAP_W} ${CAMPUS_MAP_H}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
    <defs><filter id="heatBlur" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="34"/>
    </filter></defs>
    <rect width="${CAMPUS_MAP_W}" height="${CAMPUS_MAP_H}" fill="#EDF2EC"/>
    ${roads}
    ${zones}
    <g id="mapOverlay"></g>
  </svg>`;
}

function campusZoneAt(x, y) {
  return CAMPUS_ZONES.find((z) => x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h) || null;
}

function campusSvgPoint(svgEl, clientX, clientY) {
  const ctm = svgEl.getScreenCTM();
  if (!ctm) return null;
  const pt = svgEl.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const p = pt.matrixTransform(ctm.inverse());
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

/**
 * SVG 模式的热力图（降级底图）。
 * 两层结构：先画一整片按密度着色的柔和底色（filter 模糊后连成渐变，不出现可见圆圈），
 * 再在每条启事位置画一个统一的小圆点，只负责定位与点击，不叠加外晕/计数徽章。
 * 每个标点带 data-id/data-density，点击回调 onMarkerClick(id) 打开对应启事。
 * @param {Element} overlay 覆盖层
 * @param {Array} items 已归一化数据（含 mapX/mapY/id/type）
 * @param {Function} [onMarkerClick] 点击标点回调，传启事 id
 */
function renderSvgHeat(overlay, items, onMarkerClick) {
  if (!overlay) return 0;
  const raw = (Array.isArray(items) ? items : []).filter(function (i) {
    return i && i.mapX != null && i.mapY != null && i.id != null;
  });
  // 邻域密度：在 SVG 坐标系里按 60 单位（约一个功能区）统计邻居
  const R = 60, R2 = R * R;
  const pts = raw.map(function (i) {
    let density = 0;
    raw.forEach(function (j) {
      const dx = j.mapX - i.mapX, dy = j.mapY - i.mapY;
      if (dx * dx + dy * dy <= R2) density++;
    });
    return { id: Number(i.id), x: Number(i.mapX), y: Number(i.mapY), type: i.type, density: Math.max(1, density) };
  });

  // 底色层：模仿降水 / 气温分布图——更大半径、半透明、大尺度高斯模糊，
  // 让相邻色块连成一整片柔和色带并透出底图路网，不出现可见的圆圈边界。
  const wash = pts.map(function (p) {
    const stop = heatStop(p.density);
    const radius = 110 + Math.min(p.density, 12) * 10;
    const alpha = Math.min(0.34, 0.10 + p.density * 0.035);
    return `<circle class="heat-wash" cx="${p.x}" cy="${p.y}" r="${radius}" fill="${stop.main}" opacity="${alpha.toFixed(2)}" pointer-events="none"/>`;
  }).join('');

  // 定位层：极小的点状标记（深墨色 + 细白描边），颜色不承载密度信息，避免与底色色带重复。
  const marks = pts.map(function (p) {
    return `<g class="heat-dot" data-id="${p.id}" data-type="${p.type}" data-density="${p.density}" style="cursor:pointer">
      <circle cx="${p.x}" cy="${p.y}" r="2.6" fill="#20304F" stroke="#ffffff" stroke-width="1"/>
      <title>启事 #${p.id} · 点击查看</title>
    </g>`;
  }).join('');
  overlay.innerHTML = `<g class="heat-wash-layer" filter="url(#heatBlur)" pointer-events="none">${wash}</g>` + marks;

  // 事件委托：给每个标点绑定点击（SVG g 元素在 innerHTML 重绘后需重新绑定）
  if (typeof onMarkerClick === 'function' && typeof overlay.querySelectorAll === 'function') {
    Array.prototype.forEach.call(overlay.querySelectorAll('.heat-dot'), function (g) {
      g.addEventListener('click', function (evt) {
        evt.stopPropagation();
        const id = Number(g.getAttribute('data-id'));
        if (id) onMarkerClick(id);
      });
    });
  }
  return pts.length;
}

// ---------------- 浏览器运行时（Node 环境不会执行） ----------------
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  'use strict';

  // 站点基址由 app-base.js 提供；漏引时退回相对路径，不会拼出写死的域名
  function apiPath(p) {
    return typeof window.apiUrl === 'function'
      ? window.apiUrl(p)
      : String(p).replace(/^\/+/, '');
  }

  let sdkPromise = null;

  /** 读后端地图配置。404 / 超时 / 非 JSON / 异常一律返回不可用，由调用方降级，不抛到控制台。 */
  async function readConfig(timeoutMs) {
    let ctrl = null, timer = null;
    if (typeof AbortController !== 'undefined') {
      ctrl = new AbortController();
      timer = setTimeout(function () { ctrl.abort(); }, timeoutMs || 3000);
    }
    try {
      const resp = await fetch(apiPath(MAP_CONFIG_ENDPOINT), {
        credentials: 'same-origin',
        signal: ctrl ? ctrl.signal : undefined
      });
      if (!resp.ok) return { ok: false, reason: 'config-http-' + resp.status };
      const data = await resp.json();
      return validateMapConfig(data);
    } catch (e) {
      return { ok: false, reason: 'config-unavailable' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 动态加载 SDK：只在拿到合规配置后才发起；超时 / onerror 都视为不可用。 */
  function loadSdk(url, timeoutMs) {
    if (window.TMap && typeof window.TMap.Map === 'function') return Promise.resolve(true);
    if (sdkPromise) return sdkPromise;
    sdkPromise = new Promise(function (resolve) {
      let doneFlag = false, timer = null;
      const done = function (ok) {
        if (doneFlag) return;
        doneFlag = true;
        if (timer) clearTimeout(timer);
        resolve(ok);
      };
      const s = document.createElement('script');
      s.charset = 'utf-8';
      s.src = url;
      s.onload = function () { done(!!(window.TMap && typeof window.TMap.Map === 'function')); };
      s.onerror = function () { done(false); };
      timer = setTimeout(function () { done(false); }, timeoutMs || 6000);
      document.head.appendChild(s);
    });
    return sdkPromise;
  }

  // 选点标记用内联 SVG，避免引入外部图片地址
  const PIN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26">' +
    '<circle cx="13" cy="13" r="9" fill="#EF4444" stroke="#ffffff" stroke-width="3"/>' +
    '<circle cx="13" cy="13" r="3" fill="#ffffff"/></svg>';

  /**
   * 统一的点状样式：每条启事一个极小的点，只表示「这里有一条启事」，
   * 不带外晕、不带密度色、不带计数——集中度完全交给底色的气象式色带表达。
   * 图标画布留透明边距保证点击热区，视觉上只是一个约 2.6px 的小点（呈点状而非饼状）。
   */
  function heatPinSvg() {
    const size = 18;
    const c = size / 2;
    const core = 2.6;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size +
      '" viewBox="0 0 ' + size + ' ' + size + '">' +
      '<circle cx="' + c + '" cy="' + c + '" r="' + core + '" fill="#20304F" stroke="#ffffff" stroke-width="0.9"/>' +
      '</svg>';
    return { size: size, src: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) };
  }

  function buildHeatMarkerStyles(T) {
    const pin = heatPinSvg();
    return {
      dot: new T.MarkerStyle({
        width: pin.size, height: pin.size,
        anchor: { x: pin.size / 2, y: pin.size / 2 },
        src: pin.src
      })
    };
  }

  function svgHeatUpdater(container, onMarkerClick) {
    return function (list) {
      const overlay = container.querySelector('#mapOverlay');
      return renderSvgHeat(overlay, normalizeHeatItems(list), onMarkerClick);
    };
  }

  /**
   * 统一挂载入口。先同步渲染 SVG 兜底（绝不白屏），再异步尝试升级到真实地图。
   * options:
   *   pick: true              -> 发布页选点模式
   *   onPick(coords)          -> 选点回调，coords 已含双写字段
   *   onMarkerClick(id)       -> 点击热力散点回调，传启事 id（供热力图打开详情）
   *   currentLocation()       -> 读取用户已填的地点文字（逆地理编码失败时用于匹配区域）
   *   onMode(handle)          -> 模式确定后的回调，供页面展示降级提示
   *   update(list) 由返回的 handle 提供，供热力图按筛选刷新
   */
  async function mount(container, options) {
    const opts = options || {};
    const onPick = typeof opts.onPick === 'function' ? opts.onPick : function () { };
    const onMarkerClick = typeof opts.onMarkerClick === 'function' ? opts.onMarkerClick : null;
    const handle = {
      mode: 'svg', reason: '', map: null, heat: null,
      update: function () { return 0; },
      destroy: function () { }
    };

    function fallback(reason) {
      handle.mode = 'svg';
      handle.reason = reason;
      handle.map = null;
      handle.heat = null;
      container.style.height = '';
      container.innerHTML = campusMapMarkup();
      handle.update = svgHeatUpdater(container, onMarkerClick);
      handle.destroy = function () { container.innerHTML = ''; };
      const svg = container.querySelector('svg');
      if (opts.pick && svg) {
        svg.addEventListener('click', function (evt) {
          const pt = campusSvgPoint(svg, evt.clientX, evt.clientY);
          if (!pt || pt.x < 0 || pt.x > CAMPUS_MAP_W || pt.y < 0 || pt.y > CAMPUS_MAP_H) return;
          const zone = campusZoneAt(pt.x, pt.y);
          const coords = buildPublishCoords({ mode: 'svg', x: pt.x, y: pt.y, zone: zone ? zone.name : '' });
          coords.address = zone ? zone.name : '';
          onPick(coords);
        });
      }
      if (typeof opts.onMode === 'function') opts.onMode(handle);
      return handle;
    }

    if (!container) return fallback('no-container');
    fallback('init'); // 立刻出图，后续异步升级

    // 老数据只有示意图坐标时，即使 SDK 可用也强制回退自绘 SVG，
    // 否则没有经纬度可喂给热力层，页面会显示一张空底图（清单要求兼容老数据）。
    if (opts.forceSvg) return fallback('legacy-data-no-lnglat');

    const cfg = await readConfig(opts.configTimeout);
    let ready = false;
    if (cfg.ok === true) ready = await loadSdk(cfg.sdkUrl, opts.sdkTimeout);
    if (resolveMapMode(cfg, ready, false) === 'svg') {
        return fallback(cfg.ok !== true ? cfg.reason : 'sdk-unavailable');
    }

    const T = window.TMap;
    const hasVis = T.visualization && typeof T.visualization.Heat === 'function';
    const hasService = T.service && typeof T.service.Geocoder === 'function';
    if (typeof T.Map !== 'function' || typeof T.LatLng !== 'function' ||
      typeof T.MultiMarker !== 'function' || typeof T.MarkerStyle !== 'function') {
      return fallback('sdk-incomplete');
    }
    if (!opts.pick && !hasVis) return fallback('visualization-missing');

    try {
      // 固定高度容器：flex 布局下不显式设高度会白屏
      const canvas = document.createElement('div');
      canvas.style.width = '100%';
      canvas.style.height = MAP_GL_HEIGHT + 'px';
      container.innerHTML = '';
      container.appendChild(canvas);

      const map = new T.Map(canvas, {
        center: new T.LatLng(cfg.center.lat, cfg.center.lng),
        zoom: cfg.zoom
      });
      handle.map = map;
      handle.mode = 'gl';
      handle.reason = '';
      handle.destroy = function () {
        try { if (handle.heat && handle.heat.setMap) handle.heat.setMap(null); } catch (e) { /* 忽略 */ }
        container.innerHTML = '';
        handle.map = null;
      };

      if (opts.pick) {
        const marker = new T.MultiMarker({
          map: map,
          styles: {
            pin: new T.MarkerStyle({
              width: 26, height: 26, anchor: { x: 13, y: 13 },
              src: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(PIN_SVG)
            })
          },
          geometries: []
        });
        handle.marker = marker;
        map.on('click', async function (evt) {
          const ll = evt && evt.latLng;
          if (!ll) return;
          const lat = typeof ll.getLat === 'function' ? ll.getLat() : ll.lat;
          const lng = typeof ll.getLng === 'function' ? ll.getLng() : ll.lng;
          if (!isChinaGcj02(lng, lat)) return;
          try {
            marker.updateGeometries([{ id: 'pick', styleId: 'pin', position: new T.LatLng(lat, lng) }]);
          } catch (e) { /* 标记失败不影响选点 */ }

          // 地点文字走 SDK 的 service 类，绝不手拼代理 URL；失败时降级为用户已填文字
          let address = '';
          if (hasService) {
            try {
              const geo = new T.service.Geocoder();
              // 逆地理编码超时/失败不能阻塞选点，否则按钮一直禁用，用户会以为搜索失效
              const r = await Promise.race([
                geo.getAddress({ location: new T.LatLng(lat, lng) }),
                new Promise(resolve => setTimeout(() => resolve(null), 1500))
              ]);
              const d = r && (r.result || (r.data && r.data[0]));
              address = d && d.address ? String(d.address) : '';
            } catch (e) { address = ''; }
          }
          const current = typeof opts.currentLocation === 'function' ? opts.currentLocation() : '';
          const coords = buildPublishCoords({
            mode: 'gl', lng: lng, lat: lat,
            locationText: address || current || ''
          });
          coords.address = address;
          onPick(coords);
        });
        handle.update = function () { return 0; };
      } else {
        // 气象式底色带：半径加大、alpha 取中等值，让相邻热区连成一整片可见的柔和色带，
        // 同时保留约一半透明度让底图路网 / 地名透出（类似降水量 / 气温分布图）。
        // 上一版峰值 alpha 只有 0.24、密度权重又集中在 1-2，归一化后几乎全透明，等于没染色。
        const heat = new T.visualization.Heat({
          map: map,
          radius: 72,
          max: 6,
          min: 0,
          // 渐变起点完全透明，随后快速进入可见区；稀疏青绿 -> 一般黄 -> 集中橙 -> 高发玫红。
          // 峰值 alpha 0.46：足以一眼看出色带，又不至于盖住底图。
          gradientColor: {
            0: 'rgba(14,159,142,0)', 0.18: 'rgba(14,159,142,0.16)',
            0.4: 'rgba(234,179,8,0.26)', 0.68: 'rgba(234,88,12,0.36)',
            1: 'rgba(225,29,72,0.46)'
          }
        });
        handle.heat = heat;

        // 可点击定位小点：每条启事一个统一小圆点，携带真实启事 id；
        // 密度色只出现在底色热力层，点本身不带外晕。点击触发 onMarkerClick(id) 打开详情。
        let pinLayer = null;
        if (typeof T.MultiMarker === 'function' && typeof T.MarkerStyle === 'function') {
          pinLayer = new T.MultiMarker({
            map: map,
            styles: buildHeatMarkerStyles(T),
            geometries: []
          });
          handle.pinLayer = pinLayer;
          // 事件名与腾讯 GL MultiMarker 一致：click，事件对象带 geometry.id。
          // 桩环境/老版本没有 on 时安全跳过，不影响渲染。
          if (typeof pinLayer.on === 'function') {
            try {
              pinLayer.on('click', function (evt) {
                if (!onMarkerClick || !evt) return;
                const g = evt.geometry || evt.geom || (evt.target && evt.target.geometry);
                const rawId = g && (g.id != null ? g.id : (g.properties && g.properties.id));
                const id = Number(rawId);
                if (rawId != null && Number.isFinite(id) && id > 0) onMarkerClick(id);
              });
            } catch (e) { /* 事件绑定失败不影响渲染 */ }
          }
        }

        handle.update = function (list) {
          // 先把只有 mapX/mapY 的老启事折算为区域级近似经纬度（不覆盖实测值），
          // 再按「分散标点 + 邻域密度」处理：每条启事保留自己的点与 id，不合并。
          const pts = aggregateHeatPoints(withApproxGeo(normalizeHeatItems(list), cfg.center));
          // 热力层：网格 KDE 平滑密度场——把散点铺成规则网格、高斯核估算连续密度，
          // 交给热力层插值成气象图式连续色带，不再把每条启事画成一个孤立色斑（点阵）。
          // 定位仍由下面的独立小点 marker 承担，点击可打开对应启事。
          const field = buildGridHeatField(pts);
          try { heat.setData(field); } catch (e) { /* 热力层异常不影响列表 */ }

          // 密度场已归一化到 [0, HEAT_MAX_LEVELS]，max 固定保证色阶稳定可比：
          // 稀疏区落在渐变起点（近透明）、高发区落到最暖档，整片连续过渡。
          if (typeof heat.setMax === 'function') {
            try { heat.setMax(HEAT_MAX_LEVELS); } catch (e) { /* 老版本 SDK 无 setMax，忽略 */ }
          }

          // 定位小点：每条启事一个点，id 为真实启事 id，统一 dot 样式（不按密度着色）
          if (pinLayer && typeof pinLayer.updateGeometries === 'function') {
            try {
              pinLayer.updateGeometries(toMarkerData(pts).map(function (p) {
                return {
                  id: String(p.id),
                  styleId: 'dot',
                  position: new T.LatLng(p.lat, p.lng)
                };
              }));
            } catch (e) { /* 标记失败不影响热力层 */ }
          }

          // 视野自适应：仅 overview（管理端）自动把全部散点纳入画面，管理员无需手动找点。
          // 公开热力页保持默认视野、由用户自己缩放，不被反复重置。
          // 只在点位集合变化时 fit，避免打断用户手动缩放。
          if (opts.overview === true && pts.length && canFitBounds(map, T)) {
            const sig = pts.map(function (p) { return p.lng + ',' + p.lat; }).join(';');
            if (sig !== handle._fitSig) {
              handle._fitSig = sig;
              try { fitPoints(map, T, pts); } catch (e) { /* 视野调整失败不影响数据 */ }
            }
          }
          return pts.length;
        };
      }

      if (typeof opts.onMode === 'function') opts.onMode(handle);
      return handle;
    } catch (e) {
      return fallback('map-init-failed');
    }
  }

  window.CampusMapGL = {
    mount: mount,
    readConfig: readConfig,
    loadSdk: loadSdk,
    validateMapConfig: validateMapConfig,
    resolveMapMode: resolveMapMode,
    normalizeHeatItems: normalizeHeatItems,
    aggregateHeatPoints: aggregateHeatPoints,
    withApproxGeo: withApproxGeo,
    toHeatData: toHeatData,
    toMarkerData: toMarkerData,
    buildGridHeatField: buildGridHeatField,
    buildPublishCoords: buildPublishCoords,
    renderSvgHeat: renderSvgHeat,
    HEAT_STOPS: HEAT_STOPS,
    heatStop: heatStop,
    HEAT_GRID_COLS: HEAT_GRID_COLS,
    HEAT_GRID_ROWS: HEAT_GRID_ROWS,
    HEAT_MAX_LEVELS: HEAT_MAX_LEVELS,
    MAP_GL_HEIGHT: MAP_GL_HEIGHT,
    MAP_CONFIG_ENDPOINT: MAP_CONFIG_ENDPOINT
  };
}());

// Node 侧（A 的 coordinates.js 与验收脚本）也可复用数据与纯逻辑
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CAMPUS_ZONES: CAMPUS_ZONES,
    CAMPUS_ZONE_COLORS: CAMPUS_ZONE_COLORS,
    CAMPUS_MAP_W: CAMPUS_MAP_W,
    CAMPUS_MAP_H: CAMPUS_MAP_H,
    MAP_ALLOWED_HOST: MAP_ALLOWED_HOST,
    MAP_GL_HEIGHT: MAP_GL_HEIGHT,
    MAP_CONFIG_ENDPOINT: MAP_CONFIG_ENDPOINT,
    validateMapConfig: validateMapConfig,
    resolveMapMode: resolveMapMode,
    normalizeHeatItems: normalizeHeatItems,
    aggregateHeatPoints: aggregateHeatPoints,
    withApproxGeo: withApproxGeo,
    toHeatData: toHeatData,
    toMarkerData: toMarkerData,
    buildGridHeatField: buildGridHeatField,
    canFitBounds: canFitBounds,
    fitPoints: fitPoints,
    svgPointFromLocation: svgPointFromLocation,
    buildPublishCoords: buildPublishCoords,
    renderSvgHeat: renderSvgHeat,
    campusMapMarkup: campusMapMarkup,
    campusZoneAt: campusZoneAt,
    isChinaGcj02: isChinaGcj02,
    HEAT_STOPS: HEAT_STOPS,
    heatStop: heatStop,
    HEAT_GRID_COLS: HEAT_GRID_COLS,
    HEAT_GRID_ROWS: HEAT_GRID_ROWS,
    HEAT_MAX_LEVELS: HEAT_MAX_LEVELS
  };
}
