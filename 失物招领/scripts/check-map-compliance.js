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
const ADMIN_HTML = path.join(PUBLIC, 'admin.html');

const results = [];
function check(name, ok, detail) {
    results.push({ name, ok: !!ok, detail: detail || '' });
}
function read(p) { return fs.readFileSync(p, 'utf8'); }

const mapSrc = read(MAP_FILE);
const pubSrc = read(PUB_HTML);
const hmSrc = read(HM_HTML);
const adminSrc = read(ADMIN_HTML);
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

// 混合数据：只有示意图坐标的老启事也能落到真实地图上（修复管理端只显示 1 个点）
const approx = M.withApproxGeo([
    { lng: 114.36012, lat: 30.53012, mapX: 420, mapY: 100, id: 1 },
    { lng: null, lat: null, mapX: 420, mapY: 100, id: 2 },
    { lng: null, lat: null, mapX: 700, mapY: 500, id: 3 },
    { lng: null, lat: null, mapX: null, mapY: null, id: 4 }
], { lng: 114.36444, lat: 30.536286 });
check('真实经纬度不被近似折算覆盖', approx[0].lng === 114.36012 && !approx[0].approx, JSON.stringify(approx[0]));
check('仅示意图坐标的启事折算为 GCJ-02 近似点', approx[1].lng != null && approx[1].lat != null && approx[1].approx === true, JSON.stringify(approx[1]));
check('不同区域折算到不同点位（不止 1 个点）', approx[1].lng !== approx[2].lng || approx[1].lat !== approx[2].lat);
check('无坐标无示意图的启事保持无经纬度', approx[3].lng == null && approx[3].lat == null);
check('无经纬度时仍能降级到默认校园中心', M.withApproxGeo([{ mapX: 420, mapY: 100 }], null)[0].lng != null);
const mixedAgg = M.aggregateHeatPoints(approx);
check('混合数据下每条启事各自成一个散点（3 条有坐标）', mixedAgg.length === 3, JSON.stringify(mixedAgg));

// 分散标点：每条启事保留自己的坐标与 id，count 为邻域密度（决定渐变色）
const agg = M.aggregateHeatPoints([
    { id: 10, lng: 114.36012, lat: 30.53012 },
    { id: 11, lng: 114.36018, lat: 30.53018 },
    { id: 12, lng: 115.00000, lat: 31.00000 }
]);
check('分散标点：3 条启事生成 3 个点（不再合并成 1 点）', agg.length === 3, JSON.stringify(agg));
check('每个散点带 id/type/lng/lat/count', ['count', 'id', 'lat', 'lng', 'type'].every(k => k in agg[0]), Object.keys(agg[0]).sort().join(','));
check('散点保留单条真实坐标（供点击定位）', agg.some(p => p.lng === 114.36012 && p.lat === 30.53012));
check('散点携带真实启事 id（供点击跳转）', agg.map(p => p.id).sort().join(',') === '10,11,12');
check('邻域密度 count 正确（相邻 2 条互相计数）', agg.filter(p => p.count === 2).length === 2 && agg.some(p => p.count === 1));
const heatData = M.toHeatData(agg);
check('热力层 setData 格式为 {lat,lng,count}', Object.keys(heatData[0]).sort().join(',') === 'count,lat,lng');
const markerData = M.toMarkerData(agg);
check('标记数据每条带真实 id（可点击打开对应启事）', markerData.length === 3 && markerData.every(p => p.id > 0), JSON.stringify(markerData));

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
    const calls = { heatData: null, heatMax: null, clickHandler: null, geometries: null, geoCalls: 0, fitBounds: null, markerClickHandler: null };
    function Heat(cfg) {
        this.cfg = cfg;
        this.setData = function (d) { calls.heatData = d; };
        this.setMax = function (m) { calls.heatMax = m; };
        this.setMap = function () { };
    }
    function Map(canvas, cfg) {
        this.canvas = canvas; this.cfg = cfg;
        this.on = function (ev, cb) { if (ev === 'click') calls.clickHandler = cb; };
        this.fitBounds = function (b, o) { calls.fitBounds = { b: b, o: o }; };
    }
    function LatLng(lat, lng) { this.lat = lat; this.lng = lng; this.getLat = function () { return lat; }; this.getLng = function () { return lng; }; }
    function LatLngBounds(sw, ne) { this.sw = sw; this.ne = ne; }
    function MultiMarker(cfg) {
        this.cfg = cfg;
        this.updateGeometries = function (g) { calls.geometries = g; };
        this.on = function (ev, cb) { if (ev === 'click') calls.markerClickHandler = cb; };
    }
    function MarkerStyle(cfg) { this.cfg = cfg; }
    function Geocoder() { this.getAddress = function () { calls.geoCalls++; return Promise.resolve({ result: { address: '图书馆' } }); }; }
    return {
        calls: calls,
        TMap: {
            Map: Map, LatLng: LatLng, LatLngBounds: LatLngBounds,
            MultiMarker: MultiMarker, MarkerStyle: MarkerStyle,
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
        check('降级热力图可渲染底色与小点', n === 1 && container._overlay.innerHTML.indexOf('heat-wash-layer') >= 0 && container._overlay.innerHTML.indexOf('heat-dot') >= 0);
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
        check('热力层 setData 收到分散标点数据（每条一点）',
            cnt === 2 && Array.isArray(fake.calls.heatData) && fake.calls.heatData.length === 2,
            JSON.stringify(fake.calls.heatData));
        check('热力数据带密度权重 count（渐变色依据）',
            fake.calls.heatData.every(p => p.count >= 1) && fake.calls.heatData.some(p => p.count === 2),
            JSON.stringify(fake.calls.heatData));
        check('热力层 setData 格式为 {lat,lng,count}', Object.keys(fake.calls.heatData[0]).sort().join(',') === 'count,lat,lng');
        check('热力上限按峰值动态调整', fake.calls.heatMax === 3, String(fake.calls.heatMax));
        check('真实地图推送可点击定位小点（每条启事一个，统一 dot 样式）',
            Array.isArray(fake.calls.geometries) && fake.calls.geometries.length === 2 &&
            fake.calls.geometries[0].styleId === 'dot', JSON.stringify(fake.calls.geometries));
        check('散点标记携带真实启事 id（非 heat-序号）',
            fake.calls.geometries.map(g => g.id).sort().join(',') === '1,2', JSON.stringify(fake.calls.geometries));
        check('散点标记位置为单条真实坐标',
            fake.calls.geometries.some(g => g.position.lng === 114.36012 && g.position.lat === 30.53012),
            JSON.stringify(fake.calls.geometries));
        // 点击散点 -> 回调传真实 id
        {
            const fake2 = fakeTMap();
            const env2 = makeSandbox({ fetch: okFetch, TMap: fake2.TMap });
            const GL2 = loadModule(env2.sandbox);
            let clickedId = null;
            const h2 = await GL2.mount(env2.container, { onMarkerClick: function (id) { clickedId = id; } });
            h2.update(M.normalizeHeatItems([
                { id: 77, type: 'lost', lng: 114.36012, lat: 30.53012, mapX: 420, mapY: 100 }
            ]));
            check('散点点击回调已绑定', typeof fake2.calls.markerClickHandler === 'function');
            if (typeof fake2.calls.markerClickHandler === 'function') {
                fake2.calls.markerClickHandler({ geometry: { id: '77' } });
                check('点击散点把真实启事 id 传给回调（可打开详情）', clickedId === 77, String(clickedId));
            }
        }

        // overview 模式：视野自动纳入全部点
        const ov = fakeTMap();
        const ovEnv = makeSandbox({ fetch: okFetch, TMap: ov.TMap });
        const ovGL = loadModule(ovEnv.sandbox);
        const ovHandle = await ovGL.mount(ovEnv.container, { overview: true });
        ovHandle.update(items);
        check('overview 模式自动 fitBounds 纳入全部点', ov.calls.fitBounds && ov.calls.fitBounds.b && ov.calls.fitBounds.b.sw,
            JSON.stringify(ov.calls.fitBounds && ov.calls.fitBounds.b));
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
    const ALL_PAGES = mapSrc + pubSrc + hmSrc + adminSrc;
    check('无境外/非合规底图服务商', !FORBIDDEN.test(ALL_PAGES));
    check('未照搬本地代理安全配置模板', !/_TMapSecurityConfig|securityConfig/i.test(ALL_PAGES));
    check('无本机/回环地址硬编码', !/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?/i.test(ALL_PAGES));

    // 外部 URL：只允许 SVG 命名空间；SDK 地址不得写死在前端业务代码
    const extUrls = ALL_PAGES.match(/https?:\/\/[^\s"'`)<>]+/gi) || [];
    const badUrls = extUrls.filter(u => !/w3\.org/i.test(u));
    check('业务代码无写死的外部 SDK 地址（SDK 由后端下发）', badUrls.length === 0, badUrls.slice(0, 4).join(' | '));
    check('无明文可用 key（只校验不保存）', !/key\s*[:=]\s*['"][A-Za-z0-9]{16,}['"]/i.test(ALL_PAGES));
    check('配置接口路径存在且由 apiUrl 取址', /\/api\/map\/config/.test(mapSrc) && /apiPath\(MAP_CONFIG_ENDPOINT\)/.test(mapSrc));
    check('SDK 域名白名单校验存在', /MAP_ALLOWED_HOST/.test(mapSrc) && /host-not-allowed/.test(mapSrc));

    const OFFICIAL_APIS = ['T.Map', 'T.LatLng', 'T.MultiMarker', 'T.MarkerStyle', 'T.visualization.Heat', 'T.service.Geocoder'];
    check('只使用官方真实存在的 API', OFFICIAL_APIS.every(a => mapSrc.indexOf(a) >= 0), OFFICIAL_APIS.filter(a => mapSrc.indexOf(a) < 0).join(','));
    check('坐标系标注 GCJ-02 且不做 WGS-84 转换', /GCJ-02/.test(mapSrc) && !/WGS-?84\s*(?:to|2|=>|转)/i.test(mapSrc));
    check('地图容器固定高度常量存在', /MAP_GL_HEIGHT/.test(mapSrc) && /canvas\.style\.height/.test(mapSrc));
    check('热力层用分散标点数据（setData 前先 aggregate 保留每条点与密度）', /aggregateHeatPoints\(withApproxGeo\(normalizeHeatItems/.test(mapSrc));
    check('混合数据下老示意图坐标折算为近似经纬度（不再只显示 1 个点）',
        /function withApproxGeo/.test(mapSrc) && /aggregateHeatPoints\(withApproxGeo\(normalizeHeatItems/.test(mapSrc));
    check('真实地图有可点击定位小点（不只靠透明热力斑）', /buildHeatMarkerStyles/.test(mapSrc) && /pinLayer\.updateGeometries/.test(mapSrc));
    check('定位小点不带外晕/密度色（只表示位置）', /function heatPinSvg/.test(mapSrc) && /fill="#20304F"/.test(mapSrc) && !/halo/.test(mapSrc));
    check('定位点缩成点状而非饼状（core<=3 / SVG r<=3）',
        /const core = 2\.6/.test(mapSrc) && /r="2\.6" fill="#20304F"/.test(mapSrc));
    check('集中度由气象式底色色带表达（GL + SVG 双层）', /new T\.visualization\.Heat/.test(mapSrc) && /heat-wash-layer/.test(mapSrc) && /feGaussianBlur/.test(mapSrc));
    check('底色带半透明可辨识、大模糊，透出底图（不再盖住地图）',
        /gradientColor: \{[\s\S]{0,300}0\.46/.test(mapSrc) && /stdDeviation="34"/.test(mapSrc) && /Math\.min\(0\.34, 0\.10/.test(mapSrc));
    check('密度采样半径足够大（约 300 米，避免权重全为 1 导致色带不可见）',
        /const HEAT_GRID_DEG = 0\.003/.test(mapSrc) && /peak \* 0\.6/.test(mapSrc));
    check('散点标记携带真实启事 id（toMarkerData）', /function toMarkerData/.test(mapSrc) && /toMarkerData\(pts\)/.test(mapSrc));
    check('散点绑定 click 事件回传启事 id', /pinLayer\.on\('click'/.test(mapSrc) && /onMarkerClick\(id\)/.test(mapSrc));
    check('热力图页面把 onMarkerClick 接到 showItemDetail', /onMarkerClick:\s*function\s*\(id\)[\s\S]{0,60}showItemDetail/.test(hmSrc));
    check('热力上限按峰值动态调整（不写死 max=60 抹平数据）', /heat\.setMax/.test(mapSrc));
    check('视野自适应只在 overview 模式启用（公开页不被重置）', /opts\.overview === true && pts\.length && canFitBounds/.test(mapSrc) && /overview:\s*true/.test(adminSrc));
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

    // 管理端热力图：同一套真实地图组件，禁止回到自绘假坐标示意图
    check('管理端引入统一地图组件', /js\/campus-map\.js/.test(adminSrc));
    check('管理端热力图使用统一组件挂载', /CampusMapGL\.mount\(host/.test(adminSrc) && /onAdminHeatMode/.test(adminSrc));
    check('管理端已移除自绘假坐标 Canvas', !/id="heatmapCanvas"/.test(adminSrc) && !/\/ 1000\) \* \(W - 48\)/.test(adminSrc));
    check('管理端热力数据经字段白名单过滤', /normalizeHeatItems\(raw\)/.test(adminSrc));
    check('管理端老数据/无经纬度强制回退', /forceSvg:\s*!hasGeo/.test(adminSrc));
    check('管理端有降级可见提示', /id="adminHeatNotice"/.test(adminSrc) && /ADMIN_HEAT_FALLBACK_TEXT/.test(adminSrc));
    check('管理端导出图按经纬度聚合且不含底图', /aggregateHeatPoints\(geo\)/.test(adminSrc) && /不含底图/.test(adminSrc));

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
