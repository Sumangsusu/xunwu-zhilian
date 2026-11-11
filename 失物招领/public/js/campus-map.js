// ==================== 校园地图组件 ====================
// 两套渲染：腾讯地图 GL JS（GCJ-02 真实底图） + 自绘 SVG（内网 / 断网 / 无 key 降级）。
//
// B1 合规要点（对照任务清单第四节）：
//   - 底图只用合规服务商；SDK 脚本地址与 key 一律由后端配置接口下发，
//     前端仓库只保留占位符与域名白名单校验，不出现任何可用 key 或写死的外部地址；
//   - 坐标系 GCJ-02：SDK 事件返回的 latLng 直接入库，不做坐标系转换，
//     也不把 WGS-84 / BD-09 喂给 SDK（否则点位整体偏移）；
//   - 热力图只做网格聚合，不渲染单条启事的精确坐标；进入前端的数据先做字段白名单，
//     联系方式、图片、描述、防冒领问答一律不进入页面全局对象；
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
// 热力聚合网格，约 50 米。聚合后才交给热力层，不渲染单条启事的精确坐标。
const HEAT_GRID_DEG = 0.0005;
// 后端下发地图配置的接口（由 A 的部署侧实现；仓库内只有接口路径，没有 key）
const MAP_CONFIG_ENDPOINT = '/api/map/config';

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

/** 网格聚合：输出网格中心（已模糊）+ 条数，绝不输出单条启事的精确坐标或 id。 */
function aggregateHeatPoints(items, gridDeg) {
  const g = Number(gridDeg) > 0 ? Number(gridDeg) : HEAT_GRID_DEG;
  const buckets = new Map();
  (Array.isArray(items) ? items : []).forEach(function (p) {
    if (p.lng == null || p.lat == null || !isChinaGcj02(p.lng, p.lat)) return;
    const ix = Math.round(p.lng / g), iy = Math.round(p.lat / g);
    const k = ix + ':' + iy;
    if (!buckets.has(k)) buckets.set(k, { lng: round6(ix * g), lat: round6(iy * g), count: 0 });
    buckets.get(k).count += 1;
  });
  return Array.from(buckets.values());
}

/** 转成官方热力层 setData 的数据格式 [{lat,lng,count}] */
function toHeatData(points) {
  return (Array.isArray(points) ? points : []).map(function (p) {
    return { lat: p.lat, lng: p.lng, count: p.count };
  });
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

/** SVG 模式的热力聚合圆（沿用原有视觉，但过滤无坐标项，避免 NaN 聚合） */
function renderSvgHeat(overlay, items) {
  if (!overlay) return 0;
  const agg = new Map();
  (Array.isArray(items) ? items : []).forEach(function (i) {
    if (i.mapX == null || i.mapY == null) return;
    const k = Math.round(i.mapX) + ',' + Math.round(i.mapY);
    if (!agg.has(k)) agg.set(k, { x: Math.round(i.mapX), y: Math.round(i.mapY), n: 0, lost: 0, found: 0 });
    const p = agg.get(k);
    p.n++;
    if (i.type === 'lost') p.lost++; else p.found++;
  });
  overlay.innerHTML = Array.from(agg.values()).map(function (p) {
    const r = 16 + Math.min(p.n, 8) * 6;
    const color = p.found > 0 && p.lost === 0 ? '#10B981' : (p.lost > 0 && p.found === 0 ? '#EF4444' : '#F59E0B');
    return `<g>
      <circle cx="${p.x}" cy="${p.y}" r="${r}" fill="${color}" opacity="0.18"/>
      <circle cx="${p.x}" cy="${p.y}" r="${Math.max(5, Math.round(r / 3))}" fill="${color}" stroke="#ffffff" stroke-width="2.5"/>
      <text x="${p.x}" y="${p.y - r - 6}" text-anchor="middle" font-size="17" font-weight="700" fill="#334155">${p.n}</text>
    </g>`;
  }).join('');
  return agg.size;
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

  function svgHeatUpdater(container) {
    return function (list) {
      const overlay = container.querySelector('#mapOverlay');
      return renderSvgHeat(overlay, normalizeHeatItems(list));
    };
  }

  /**
   * 统一挂载入口。先同步渲染 SVG 兜底（绝不白屏），再异步尝试升级到真实地图。
   * options:
   *   pick: true              -> 发布页选点模式
   *   onPick(coords)          -> 选点回调，coords 已含双写字段
   *   currentLocation()       -> 读取用户已填的地点文字（逆地理编码失败时用于匹配区域）
   *   onMode(handle)          -> 模式确定后的回调，供页面展示降级提示
   *   update(list) 由返回的 handle 提供，供热力图按筛选刷新
   */
  async function mount(container, options) {
    const opts = options || {};
    const onPick = typeof opts.onPick === 'function' ? opts.onPick : function () { };
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
      handle.update = svgHeatUpdater(container);
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
              const r = await geo.getAddress({ location: new T.LatLng(lat, lng) });
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
        const heat = new T.visualization.Heat({
          map: map,
          radius: 34,
          max: 60,
          min: 0,
          gradientColor: {
            0.2: 'rgba(59,130,246,0)', 0.45: '#3B82F6',
            0.7: '#F59E0B', 1: '#EF4444'
          }
        });
        handle.heat = heat;
        handle.update = function (list) {
          const pts = aggregateHeatPoints(normalizeHeatItems(list));
          try { heat.setData(toHeatData(pts)); } catch (e) { /* 热力层异常不影响列表 */ }
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
    toHeatData: toHeatData,
    buildPublishCoords: buildPublishCoords,
    renderSvgHeat: renderSvgHeat,
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
    toHeatData: toHeatData,
    svgPointFromLocation: svgPointFromLocation,
    buildPublishCoords: buildPublishCoords,
    renderSvgHeat: renderSvgHeat,
    campusMapMarkup: campusMapMarkup,
    campusZoneAt: campusZoneAt,
    isChinaGcj02: isChinaGcj02
  };
}
