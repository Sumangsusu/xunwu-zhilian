/**
 * 寻物智联 · 地图运行配置（A↔B 协同接口的服务层）
 *
 * 职责单一：把服务端环境变量拼成 B1 前端 validateMapConfig() 认可的响应。
 * 控制器（server.js）只负责发 JSON，业务逻辑留在本模块，便于零依赖脚本直接 require 验收。
 *
 * 合规约束：
 *   1) SDK 地址与 key 只能由后端下发，仓库里不出现任何可用的真实 key；
 *   2) SDK 主机必须是 map.qq.com（或其子域），协议必须 HTTPS；
 *   3) 中心点必须是 A、B 现场实测的 GCJ-02 值。未标定 / 未配 key 时返回
 *      enabled:false，前端按设计降级自绘 SVG，绝不用联网近似值冒充实测值；
 *   4) 不返回密钥以外的任何内部环境细节。
 */
'use strict';

const fs = require('node:fs');
const config = require('./config');

const ALLOWED_HOST = 'map.qq.com';
const DEFAULT_LIBRARIES = 'visualization,service';
const DEFAULT_ZOOM = 16;

function numberInRange(value, min, max) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

function disabled(reason) {
  return {
    enabled: false,
    reason: reason,
    sdkUrl: '',
    key: '',
    center: { lng: null, lat: null },
    zoom: DEFAULT_ZOOM
  };
}

/**
 * 读取现场实测的 GCJ-02 标定文件（路径来自 CAMPUS_CALIBRATION）。
 * 支持两种写法，center 优先，其次取 zones 里第一个有效点：
 *   { "center": { "lng": 114.36, "lat": 30.54 }, "zoom": 16 }
 *   { "zones": [ { "name": "图书馆", "lng": 114.36, "lat": 30.54 } ] }
 * 文件缺失、JSON 损坏或坐标越界统一返回 null，调用方据此保持自绘 SVG 降级。
 */
function calibrationCenter() {
  let raw;
  try {
    raw = fs.readFileSync(config.calibrationPath, 'utf8');
  } catch (err) {
    return null;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return null;
  }
  const candidates = [];
  if (data && data.center) candidates.push({ point: data.center, zoom: data.zoom });
  if (data && Array.isArray(data.zones)) {
    for (const zone of data.zones) {
      if (!zone) continue;
      candidates.push({ point: zone.center || zone, zoom: zone.zoom });
    }
  }
  for (const item of candidates) {
    if (!item || !item.point) continue;
    const lng = numberInRange(item.point.lng, 73, 135);
    const lat = numberInRange(item.point.lat, 3, 54);
    if (lng !== null && lat !== null) {
      return { lng: lng, lat: lat, zoom: item.zoom };
    }
  }
  return null;
}

function buildMapConfig() {
  const key = String(config.mapKey || '').trim();
  if (!key) return disabled('map-key-not-configured');

  // 优先读环境变量；未配置时回退到实测标定文件；两者都没有就保持关闭，绝不猜坐标。
  let lng = numberInRange(config.mapCenterLng, 73, 135);
  let lat = numberInRange(config.mapCenterLat, 3, 54);
  let zoomRaw = config.mapZoom;
  if (lng === null || lat === null) {
    const cal = calibrationCenter();
    if (cal) {
      lng = cal.lng;
      lat = cal.lat;
      if (zoomRaw === '' || zoomRaw == null) zoomRaw = cal.zoom;
    }
  }
  if (lng === null || lat === null) return disabled('campus-calibration-not-configured');

  let url;
  try {
    url = new URL(String(config.mapSdkUrl));
  } catch (err) {
    return disabled('invalid-sdk-url');
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' ||
      (host !== ALLOWED_HOST && !host.endsWith('.' + ALLOWED_HOST))) {
    return disabled('sdk-host-not-allowed');
  }

  // key 只出现在运行时响应里，不写回仓库；B1 同时校验 sdkUrl 主机与 key 字段。
  url.searchParams.set('key', key);
  url.searchParams.set('libraries', DEFAULT_LIBRARIES);

  const zoom = numberInRange(zoomRaw, 3, 20);
  return {
    enabled: true,
    reason: '',
    sdkUrl: url.toString(),
    key: key,
    center: { lng: lng, lat: lat },
    zoom: zoom === null ? DEFAULT_ZOOM : Math.round(zoom)
  };
}

/**
 * helmet CSP 需要放行的外部来源。
 * 只在真实地图已启用时放宽；没配 key / 没标定时返回空数组，整站维持原有严格策略。
 */
function mapCspSources() {
  if (!buildMapConfig().enabled) return [];
  // 腾讯地图 GL 除了 map.qq.com 系列，还会从以下官方 CDN 取资源：
  //   - *.qpic.cn ：地图样式脚本（如 mapstyle.qpic.cn/.../style.js），走 connect-src，
  //                 被拦会导致底图无样式、瓦片不渲染（容器控件仍在，表现为"空白地图"）；
  //   - *.gtimg.com：栅格/矢量瓦片图片，被拦则底图一片浅灰。
  // 两者均为腾讯官方静态资源域，仅 HTTPS，随地图启用一并放行到 script/connect/img/worker-src。
  return [
    'https://map.qq.com',
    'https://*.map.qq.com',
    'https://*.qq.com',
    'https://*.qpic.cn',
    'https://*.gtimg.com'
  ];
}

module.exports = { buildMapConfig, mapCspSources, ALLOWED_HOST };
