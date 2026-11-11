#!/usr/bin/env node
/**
 * 寻物智联 · B1 地图合规落地验收脚本（零依赖）
 *
 * 用法：在「失物招领/」目录下执行
 *     node scripts/check-map-compliance.js
 * 退出码：0 = 全部通过；1 = 存在失败项
 *
 * 分三部分：
 *   A. 纯逻辑真实运行时测试（require campus-map.js）
 *   B. 浏览器运行时测试（vm + DOM 桩 + TMap 桩，真实执行 mount 的降级/GL 分支）
 *   C. 静态合规红线检查（境外底图、明文 key、本地代理模板、字段白名单、双写等）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const JS_DIR = path.join(PUBLIC, 'js');
const MAP_FILE = path.join(JS_DIR, 'campus-map.js');
const PUB_HTML = path.join(PUBLIC, 'publish.html');
const HM_HTML = path.join(PUBLIC, 'heatmap.html');

const results = [];
function check(name, ok, detail) {
    results.push({ name, ok: !!ok, detail: detail || '' });
}
function read(p) { return fs.readFileSync(p, 'utf8'); }

const mapSrc = read(MAP_FILE);
const pubSrc = read(PUB_HTML);
const hmSrc = read(HM_HTML);
const M = require(MAP_FILE);

console.log('寻物智联 · B1 地图合规落地验收\n');

// ==================== A. 纯逻辑真实运行时 ====================
console.log('--- A. 纯逻辑（require 真实执行） ---');

const GOOD_SDK = 'https://map.qq.com/api/gljs?v=1.exp&key=TESTKEY&libraries=visualization,service';
const WUHAN = { lng: 114.36, lat: 30.53 };

check('缺配置拒绝并降级', M.validateMapConfig(null).ok === false && M.validateMapConfig(null).reason === 'no-config');
check('enabled:false 时降级', M.validateMapConfig({ enabled: false }).reason === 'disabled');
check('缺 key / sdkUrl 时降级', M.validateMapConfig({ sdkUrl: GOOD_SDK }).reason === 'missing-key-or-url');
check('非 HTTPS 拒绝', M.validateMapConfig({ sdkUrl: 'http://map.qq.com/api/gljs', key: 'TESTKEY', center: WUHAN }).reason === 'insecure-protocol');
check('境外/非白名单底图拒绝', M.validateMapConfig({ sdkUrl: 'https://tiles.example.org/gljs?key=X', key: 'TESTKEY', center: WUHAN }).reason === 'host-not-allowed');
check('本地代理地址拒绝', M.validateMapConfig({ sdkUrl: 'https://127.0.0.1/gljs?key=X', key: 'TESTKEY', center: WUHAN }).reason === 'host-not-allowed');
check('非法中心点拒绝', M.validateMapConfig({ sdkUrl: GOOD_SDK, key: 'TESTKEY', center: { lng: 0, lat: 0 } }).reason === 'invalid-center');
const goodCfg = M.validateMapConfig({ sdkUrl: GOOD_SDK, key: 'TESTKEY', center: WUHAN, zoom: 17 });
check('合规配置通过且 zoom 正确', goodCfg.ok === true && goodCfg.zoom === 17 && goodCfg.center.lng === 114.36);
check('合规配置默认 zoom=16', M.validateMapConfig({ sdkUrl: GOOD_SDK, key: 'TESTKEY', center: WUHAN }).zoom === 16);

check('resolveMapMode: 强制 SVG 生效', M.resolveMapMode(goodCfg, true, true) === 'svg');
check('resolveMapMode: 无 SDK 降级', M.resolveMapMode(goodCfg, false, false) === 'svg');
check('resolveMapMode: 配置无效降级', M.resolveMapMode({ ok: false }, true, false) === 'svg');
check('resolveMapMode: 条件齐备才用真实地图', M.resolveMapMode(goodCfg, true, false) === 'gl');

// 隐私红线：字段白名单
const dirty = [{
    id: 7, type: 'lost', title: '黑色钱包', location: '图书馆', date: '2026-11-11',
    lng: 114.36012, lat: 30.53012, mapX: 420, mapY: 100,
    contact: '13800138000', image: 'data:image/png;base64,AAA',
    description: '内有身份证', quiz: [{ q: '答案' }], contactMasked: true,
    publisher: 'demo', reward: '重谢'
}];
const norm = M.normalizeHeatItems(dirty);
const normKeys = Object.keys(norm[0]).sort().join(',');
check('热力数据字段白名单（9 字段）', normKeys === 'date,id,lat,lng,location,mapX,mapY,title,type', normKeys);
check('联系方式/图片/描述/问答不进入前端', !/contact|image|description|quiz|publisher|reward/.test(JSON.stringify(norm)));
check('合法 GCJ-02 保留', norm[0].lng === 114.36012 && norm[0].lat === 30.53012);
check('示意坐标保留（老数据兼容）', norm[0].mapX === 420 && norm[0].mapY === 100);
check('中国范围外经纬度丢弃', M.normalizeHeatItems([{ lng: 0, lat: 0, mapX: 1, mapY: 2 }])[0].lng === null);
check('非数组输入返回空', Array.isArray(M.normalizeHeatItems(null)) && M.normalizeHeatItems(null).length === 0);

// 聚合：不渲染单条精确坐标
const agg = M.aggregateHeatPoints([
    { lng: 114.36012, lat: 30.53012 },
    { lng: 114.36018, lat: 30.53018 },
    { lng: 115.00000, lat: 31.00000 }
]);
check('热力按网格聚合成 2 组', agg.length === 2, JSON.stringify(agg));
check('聚合结果只有 lng/lat/count', Object.keys(agg[0]).sort().join(',') === 'count,lat,lng');
check('聚合后不含单条精确坐标', !agg.some(p => p.lng === 114.36012 || p.lat === 30.53012));
check('聚合 count 正确', agg.some(p => p.count === 2));
const heatData = M.toHeatData(agg);
check('setData 格式为 {lat,lng,count}', Object.keys(heatData[0]).sort().join(',') === 'count,lat,lng');

// 双写坐标
const glCoords = M.buildPublishCoords({ mode: 'gl', lng: 114.360123456, lat: 30.530123456, locationText: '图书馆三楼' });
check('GL 选点产出 GCJ-02 lng/lat（6 位精度）', glCoords.lng === 114.360123 && glCoords.lat === 30.530123);
check('GL 选点同时双写 mapX/mapY', glCoords.mapX === 420 && glCoords.mapY === 100);
check('GL 选点按地点文字匹配区域', glCoords.zone === '图书馆');
const svgCoords = M.buildPublishCoords({ mode: 'svg', x: 420, y: 100, zone: '图书馆' });
check('SVG 降级选点 lng/lat 为空', svgCoords.lng === null && svgCoords.lat === null);
check('SVG 降级选点 mapX/mapY 有效', svgCoords.mapX === 420 && svgCoords.mapY === 100);
check('非法选点返回全空', M.buildPublishCoords({ mode: 'gl', lng: 0, lat: 0 }).source === 'none');
check('SVG 老渲染仍可用', typeof M.renderSvgHeat === 'function' && M.campusMapMarkup().indexOf('viewBox') >= 0);
check('CAMPUS_ZONES 仍导出给 A 的 coordinates.js', Array.isArray(M.CAMPUS_ZONES) && M.CAMPUS_ZONES.length === 15);

// ==================== B. 浏览器运行时（vm + 桩） ====================
console.log('--- B. 浏览器运行时（vm 真实执行 mount） ---');

function makeSandbox(opts) {
    const overlay = { innerHTML: '' };
    const svg = {
        _click: null,
        addEventListener: function (ev, cb) { if (ev === 'click') this._click = cb; },
        getScreenCTM: function () { return null; },
        createSVGPoint: function () { return { x: 0, y: 0 }; }
    };
    const container = {
        style: {}, innerHTML: '', _children: [],
        appendChild: function (c) { this._children.push(c); },
        querySelector: function (sel) {
            if (sel === 'svg') return svg;
            if (sel === '#mapOverlay') return overlay;
            return null;
        },
        _svg: svg, _overlay: overlay
    };
    const head = { appendChild: function (s) { if (opts && opts.sdkFail) { setTimeout(function () { s.onerror && s.onerror(); }, 0); } } };
    const sandbox = {
        console: console,
        setTimeout: setTimeout, clearTimeout: clearTimeout, URL: URL,
        AbortController: AbortController, encodeURIComponent: encodeURIComponent,
        Promise: Promise, Map: Map,
        document: {
            head: head,
            createElement: function () { return { style: {}, innerHTML: '', charset: '', src: '' }; }
        },
        fetch: opts.fetch,
        module: { exports: {} }, exports: {}
    };
    sandbox.window = sandbox;
    sandbox.apiUrl = function (p) { return String(p).replace(/^\/+/, '/'); };
    if (opts.TMap) sandbox.TMap = opts.TMap;
    return { sandbox, container };
}

function loadModule(ctx) {
    vm.runInNewContext(mapSrc, ctx, { filename: 'campus-map.js' });
    return ctx.CampusMapGL;
}

function fakeTMap() {
    const calls = { heatData: null, clickHandler: null, geometries: null, geoCalls: 0 };
    function Heat(cfg) { this.cfg = cfg; this.setData = function (d) { calls.heatData = d; }; this.setMap = function () { }; }
    function Map(canvas, cfg) { this.canvas = canvas; this.cfg = cfg; this.on = function (ev, cb) { if (ev === 'click') calls.clickHandler = cb; }; }
    function LatLng(lat, lng) { this.lat = lat; this.lng = lng; this.getLat = function () { return lat; }; this.getLng = function () { return lng; }; }
    function MultiMarker(cfg) { this.cfg = cfg; this.updateGeometries = function (g) { calls.geometries = g; }; }
    function MarkerStyle(cfg) { this.cfg = cfg; }
    function Geocoder() { this.getAddress = function () { calls.geoCalls++; return Promise.resolve({ result: { address: '图书馆' } }); }; }
    return {
        calls: calls,
        TMap: {
            Map: Map, LatLng: LatLng, MultiMarker: MultiMarker, MarkerStyle: MarkerStyle,
            visualization: { Heat: Heat }, service: { Geocoder: Geocoder }
        }
    };
}

const okFetch = async function () {
    return { ok: true, status: 200, json: async function () {
        return { enabled: true, sdkUrl: GOOD_SDK, key: 'TESTKEY', center: WUHAN, zoom: 17 };
    } };
};
const noFetch = async function () { return { ok: false, status: 404, json: async function () { return {}; } }; };

(async function () {
    // B1: 配置接口 404 -> 同步渲染 SVG，不白屏
    {
        const { sandbox, container } = makeSandbox({ fetch: noFetch });
        const GL = loadModule(sandbox);
        const h = await GL.mount(container, { pick: true, onPick: function () { } });
        check('配置接口 404 时降级为 SVG', h.mode === 'svg' && h.reason === 'config-http-404', h.reason);
        check('降级后容器立刻有 SVG（不白屏）', container.innerHTML.indexOf('<svg') >= 0);
        const n = h.update(M.normalizeHeatItems([{ id: 1, mapX: 420, mapY: 100, type: 'lost' }]));
        check('降级热力图可渲染聚合圆', n === 1 && container._overlay.innerHTML.indexOf('<circle') >= 0);
    }

    // B2: 网络异常 -> 降级
    {
        const badFetch = async function () { throw new Error('offline'); };
        const { sandbox, container } = makeSandbox({ fetch: badFetch });
        const GL = loadModule(sandbox);
        const h = await GL.mount(container, {});
        check('断网（fetch 抛错）时降级不白屏', h.mode === 'svg' && container.innerHTML.indexOf('<svg') >= 0 && h.reason === 'config-unavailable', h.reason);
    }

    // B2b: 当前 main 的真实行为 —— /api/map/config 被 SPA 兜底返回 200 + HTML，
    //      resp.ok 为 true 但 resp.json() 抛错，必须安全降级而不是整页报错
    {
        const htmlFetch = async function () {
            return { ok: true, status: 200, json: async function () { throw new SyntaxError('Unexpected token <'); } };
        };
        const { sandbox, container } = makeSandbox({ fetch: htmlFetch });
        const GL = loadModule(sandbox);
        const h = await GL.mount(container, {});
        check('配置接口返回 HTML(200) 时安全降级不白屏',
            h.mode === 'svg' && h.reason === 'config-unavailable' && container.innerHTML.indexOf('<svg') >= 0, h.reason);
    }

    // B3: 老数据无经纬度 -> 强制 SVG
    {
        const { sandbox, container } = makeSandbox({ fetch: okFetch, TMap: fakeTMap().TMap });
        const GL = loadModule(sandbox);
        const h = await GL.mount(container, { forceSvg: true });
        check('老数据无 lng/lat 时强制回退 SVG', h.mode === 'svg' && h.reason === 'legacy-data-no-lnglat');
    }

    // B4: 合规配置 + SDK -> 真实地图，且用官方 API + 固定高度 + 聚合数据
    {
        const fake = fakeTMap();
        const { sandbox, container } = makeSandbox({ fetch: okFetch, TMap: fake.TMap });
        const GL = loadModule(sandbox);
        const h = await GL.mount(container, {});
        check('合规配置 + SDK 时启用真实地图', h.mode === 'gl' && h.map != null, h.reason);
        const canvas = container._children[0];
        check('地图容器设置固定像素高度（防白屏）', canvas && canvas.style.height === '460px', canvas && canvas.style.height);
        check('TMap.Map 收到 GCJ-02 中心点与 zoom', h.map && h.map.cfg.zoom === 17 && h.map.cfg.center.lat === 30.53);
        const items = M.normalizeHeatItems([
            { id: 1, type: 'lost', lng: 114.36012, lat: 30.53012, mapX: 420, mapY: 100, title: 'a', location: '图书馆', date: 'd' },
            { id: 2, type: 'found', lng: 114.36018, lat: 30.53018, mapX: 421, mapY: 101, title: 'b', location: '图书馆', date: 'd' }
        ]);
        const cnt = h.update(items);
        check('热力层 setData 收到聚合数据', cnt === 1 && Array.isArray(fake.calls.heatData) && fake.calls.heatData.length === 1);
        check('聚合数据不含单条精确坐标或 id', !/id|114\.36012/.test(JSON.stringify(fake.calls.heatData)), JSON.stringify(fake.calls.heatData));
        check('热力层 setData 格式为 {lat,lng,count}', Object.keys(fake.calls.heatData[0]).sort().join(',') === 'count,lat,lng');
    }

    // B5: 发布页选点 -> 双写 lng/lat + mapX/mapY，地点文字走 service 类
    {
        const fake = fakeTMap();
        const { sandbox, container } = makeSandbox({ fetch: okFetch, TMap: fake.TMap });
        const GL = loadModule(sandbox);
        let picked = null;
        const h = await GL.mount(container, {
            pick: true,
            onPick: function (c) { picked = c; },
            currentLocation: function () { return ''; }
        });
        check('发布页 GL 模式挂载成功', h.mode === 'gl' && h.marker != null);
        check('点击事件已绑定', typeof fake.calls.clickHandler === 'function');
        await fake.calls.clickHandler({ latLng: new fake.TMap.LatLng(30.5301, 114.3601) });
        check('选点走 TMap.service.Geocoder（未手拼代理 URL）', fake.calls.geoCalls === 1);
        check('选点产出 GCJ-02 lng/lat', picked && picked.lng === 114.3601 && picked.lat === 30.5301, JSON.stringify(picked));
        check('选点同时双写 mapX/mapY（兼容现有 main）', picked && picked.mapX === 420 && picked.mapY === 100);
        check('选点用 TMap.MultiMarker 标记', Array.isArray(fake.calls.geometries) && fake.calls.geometries.length === 1);
    }

    // B6: SDK 加载超时/失败 -> 降级
    {
        const slowFetch = async function () {
            return { ok: true, status: 200, json: async function () {
                return { enabled: true, sdkUrl: GOOD_SDK, key: 'TESTKEY', center: WUHAN };
            } };
        };
        const { sandbox, container } = makeSandbox({ fetch: slowFetch, sdkFail: true });
        const GL = loadModule(sandbox);
        const h = await GL.mount(container, { sdkTimeout: 30 });
        check('SDK 加载失败/超时时降级为 SVG', h.mode === 'svg' && container.innerHTML.indexOf('<svg') >= 0, h.reason);
    }

    // ==================== C. 静态合规红线 ====================
    console.log('--- C. 静态合规红线 ---');

    const FORBIDDEN = /googleapis|google\.com\/maps|openstreetmap|osm\.org|mapbox|leafletjs|leaflet\b|bing\.com\/maps|apple\.com\/maps/i;
    check('无境外/非合规底图服务商', !FORBIDDEN.test(mapSrc + pubSrc + hmSrc));
    check('未照搬本地代理安全配置模板', !/_TMapSecurityConfig|securityConfig/i.test(mapSrc + pubSrc + hmSrc));
    check('无本机/回环地址硬编码', !/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?/i.test(mapSrc + pubSrc + hmSrc));

    // 外部 URL：只允许 SVG 命名空间；SDK 地址不得写死在前端业务代码
    const extUrls = (mapSrc + pubSrc + hmSrc).match(/https?:\/\/[^\s"'`)<>]+/gi) || [];
    const badUrls = extUrls.filter(u => !/w3\.org/i.test(u));
    check('业务代码无写死的外部 SDK 地址（SDK 由后端下发）', badUrls.length === 0, badUrls.slice(0, 4).join(' | '));
    check('无明文可用 key（只校验不保存）', !/key\s*[:=]\s*['"][A-Za-z0-9]{16,}['"]/i.test(mapSrc + pubSrc + hmSrc));
    check('配置接口路径存在且由 apiUrl 取址', /\/api\/map\/config/.test(mapSrc) && /apiPath\(MAP_CONFIG_ENDPOINT\)/.test(mapSrc));
    check('SDK 域名白名单校验存在', /MAP_ALLOWED_HOST/.test(mapSrc) && /host-not-allowed/.test(mapSrc));

    const OFFICIAL_APIS = ['T.Map', 'T.LatLng', 'T.MultiMarker', 'T.MarkerStyle', 'T.visualization.Heat', 'T.service.Geocoder'];
    check('只使用官方真实存在的 API', OFFICIAL_APIS.every(a => mapSrc.indexOf(a) >= 0), OFFICIAL_APIS.filter(a => mapSrc.indexOf(a) < 0).join(','));
    check('坐标系标注 GCJ-02 且不做 WGS-84 转换', /GCJ-02/.test(mapSrc) && !/WGS-?84\s*(?:to|2|=>|转)/i.test(mapSrc));
    check('地图容器固定高度常量存在', /MAP_GL_HEIGHT/.test(mapSrc) && /canvas\.style\.height/.test(mapSrc));
    check('热力层只做聚合（setData 前先 aggregate）', /aggregateHeatPoints\(normalizeHeatItems/.test(mapSrc));
    check('降级链路覆盖多种失败原因', (mapSrc.match(/return fallback\(/g) || []).length >= 6);
    check('自绘 SVG 降级方案保留（未整套删除）', /function campusMapMarkup/.test(mapSrc) && /campusMapMarkup\(\)/.test(mapSrc));

    check('发布页双写 lng/lat + mapX/mapY', /lng:\s*document\.getElementById\('itemLng'\)/.test(pubSrc) && /lat:\s*document\.getElementById\('itemLat'\)/.test(pubSrc) && /mapX:\s*document\.getElementById\('itemMapX'\)/.test(pubSrc));
    check('发布页地点文字字段保留', /id="itemLocation"/.test(pubSrc));
    check('发布页 B3 字段未被覆盖', /id="itemColor"/.test(pubSrc) && /id="itemFeatures"/.test(pubSrc) && /applyRecognizeDraft/.test(pubSrc));
    check('发布页有降级可见提示', /id="publishMapNotice"/.test(pubSrc) && /onPublishMapMode/.test(pubSrc));

    check('热力图数据经字段白名单过滤', /normalizeHeatItems\(d\.items/.test(hmSrc));
    check('热力图不把完整 item 打进全局对象', !/heatmapAll\s*=\s*d\.items/.test(hmSrc));
    check('热力图筛选（lost/found/全部）保持可用', /hmType/.test(hmSrc) && /addEventListener\('change',\s*renderHeatmap\)/.test(hmSrc));
    check('热力图刷新保持可用', /hmRefresh/.test(hmSrc) && /loadHeatmap/.test(hmSrc));
    check('热力图有降级可见提示', /id="hmMapNotice"/.test(hmSrc) && /onHeatmapMode/.test(hmSrc));
    check('热力图老数据强制回退判断', /forceSvg:\s*!hasGeo/.test(hmSrc));
    check('两页都引入统一地图组件', /js\/campus-map\.js/.test(pubSrc) && /js\/campus-map\.js/.test(hmSrc));

    // ---------- 汇总 ----------
    let pass = 0;
    for (const r of results) {
        console.log((r.ok ? '[PASS] ' : '[FAIL] ') + r.name + (r.detail ? '  - ' + r.detail : ''));
        if (r.ok) pass++;
    }
    console.log('\n汇总：' + pass + '/' + results.length + ' 项通过');
    if (pass !== results.length) {
        console.log('\n失败项：');
        results.filter(r => !r.ok).forEach(r => console.log('  - ' + r.name + (r.detail ? ' :: ' + r.detail : '')));
    }
    process.exit(pass === results.length ? 0 : 1);
})().catch(function (e) {
    console.error('验收脚本自身异常：', e);
    process.exit(1);
});
