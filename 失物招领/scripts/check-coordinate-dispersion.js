#!/usr/bin/env node
/**
 * 坐标分散校验：确保同一地点的多条启事不会被折叠到同一个功能区中心坐标，
 * 地图上 N 条启事应渲染为 N 个独立标记（此前 50 条塌缩为 14 个坐标、标记重叠）。
 *
 * 用法：node scripts/check-coordinate-dispersion.js
 */
'use strict';

const path = require('node:path');
const ROOT = path.join(__dirname, '..');

// 在可控环境下加载后端模块，屏蔽本机 .env 的生产校验干扰。
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test';
process.loadEnvFile = function () { };

const { coordinates, calibration } = require(path.join(ROOT, 'coordinates.js'));
const { CAMPUS_ZONES } = require(path.join(ROOT, 'public/js/campus-map.js'));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('[PASS] ' + name); }
  else { fail++; console.log('[FAIL] ' + name + (detail ? ' - ' + detail : '')); }
}

// 1. 标定表可用
check('功能区标定表已加载', calibration.length > 0, 'zones=' + calibration.length);

// 2. 同一地点 20 条启事（mapX/mapY 各异）应生成 20 个独立坐标
const zone = CAMPUS_ZONES[5] || CAMPUS_ZONES[0];
const mx = zone.x + zone.w / 2, my = zone.y + zone.h / 2;
const twenty = [];
for (let k = 0; k < 20; k++) {
  twenty.push(coordinates({
    mapX: Math.round(mx - 30 + k * 3), mapY: Math.round(my - 20 + k * 2),
    lng: null, lat: null, location: zone.name + '三楼'
  }));
}
const uniq20 = new Set(twenty.map(p => p.lng + ',' + p.lat));
check('同地点 20 条启事生成 20 个独立坐标（不再折叠到功能区中心）', uniq20.size === 20, 'uniq=' + uniq20.size);

// 3. 分散后的坐标仍落在对应功能区锚点附近（约 150 米内，不越界、不伪造实测精度）
const anchor = calibration.find(p => p.name === zone.name);
if (anchor) {
  const maxDev = Math.max.apply(null, twenty.map(p =>
    Math.sqrt((p.lng - anchor.lng) ** 2 + (p.lat - anchor.lat) ** 2)));
  check('分散坐标仍在功能区锚点附近（<0.01°）', maxDev < 0.01, 'maxDev=' + maxDev.toFixed(6));
} else {
  check('分散坐标仍在功能区锚点附近（<0.01°）', false, 'anchor not found for ' + zone.name);
}

// 4. 有真实经纬度的启事不被局部插值覆盖
const real = coordinates({ mapX: mx, mapY: my, lng: 114.36, lat: 30.54, location: zone.name });
check('真实经纬度原样保留（不覆盖实测值）', real.lng === 114.36 && real.lat === 30.54);

// 5. 50 条启事应生成 50 个独立坐标（对应"地图点数补齐"的核心诉求）
const many = [];
for (let k = 0; k < 50; k++) {
  many.push(coordinates({
    mapX: 200 + (k % 10) * 30 + (k % 3),
    mapY: 100 + Math.floor(k / 10) * 40 + (k % 5),
    lng: null, lat: null, location: '图书馆'
  }));
}
const uniq50 = new Set(many.map(p => p.lng + ',' + p.lat));
check('50 条启事生成 50 个独立坐标（地图标记数=启事数）', uniq50.size === 50, 'uniq=' + uniq50.size);

// 6. 无 mapX/mapY 且无真实坐标时仍安全回退，不抛异常
const bare = coordinates({ mapX: null, mapY: null, lng: null, lat: null, location: '' });
check('无坐标数据安全回退', bare.lng === null && bare.lat === null);

console.log('\n=== 结果：通过 ' + pass + ' / 失败 ' + fail + ' ===');
process.exit(fail ? 1 : 0);
