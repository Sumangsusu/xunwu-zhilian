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

function buildMapConfig() {
  const key = String(config.mapKey || '').trim();
  if (!key) return disabled('map-key-not-configured');

  // 校区基准点不做任何默认猜测：没有实测标定就保持关闭。
  const lng = numberInRange(config.mapCenterLng, 73, 135);
  const lat = numberInRange(config.mapCenterLat, 3, 54);
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

  const zoom = numberInRange(config.mapZoom, 3, 20);
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
  return ['https://map.qq.com', 'https://*.map.qq.com', 'https://*.qq.com'];
}

module.exports = { buildMapConfig, mapCspSources, ALLOWED_HOST };
