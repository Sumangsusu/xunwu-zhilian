#!/usr/bin/env node
/**
 * 寻物智联 · A↔B 协同接口契约验收（零依赖）
 *
 * 用法：node scripts/check-backend-integration.js
 *
 * 覆盖：地图配置下发（未启用降级 / SDK 白名单 / CSP 来源）、OCR 代理的
 *       TC3 签名与隐私脱敏、前后端接线静态检查。
 * 用真实 require 在可控环境变量下执行模块，不做纯字符串断言。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const results = [];
function check(name, ok, detail) {
    results.push({ name: name, ok: !!ok, detail: detail || '' });
}
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

const MODULES = ['config.js', 'map-config.js', 'ocr.js', 'images.js'];

/** 在干净、可控的环境变量下重新 require 后端模块，屏蔽本机 .env 的干扰。 */
function loadWith(vars) {
    const saved = {};
    const realLoad = process.loadEnvFile;
    for (const key of Object.keys(vars)) {
        saved[key] = process.env[key];
        if (vars[key] === undefined) delete process.env[key];
        else process.env[key] = vars[key];
    }
    process.loadEnvFile = function () { };
    for (const file of MODULES) {
        const target = path.join(ROOT, file);
        try { delete require.cache[require.resolve(target)]; } catch (e) { /* 尚未加载 */ }
    }
    try {
        return {
            config: require(path.join(ROOT, 'config.js')),
            map: require(path.join(ROOT, 'map-config.js')),
            ocr: require(path.join(ROOT, 'ocr.js'))
        };
    } finally {
        process.loadEnvFile = realLoad;
        for (const key of Object.keys(saved)) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
    }
}

const CLEAN = {
    NODE_ENV: 'test',
    SESSION_SECRET: '',
    BASE_URL: '',
    CORS_ORIGIN: '',
    MAP_KEY: '',
    MAP_SDK_URL: undefined,
    MAP_CENTER_LNG: '',
    MAP_CENTER_LAT: '',
    MAP_ZOOM: '',
    // 显式指向不存在的标定文件，避免开发者本机真实标定影响断言结果。
    CAMPUS_CALIBRATION: 'data/__no-such-calibration__.json',
    OCR_SECRET_ID: '',
    OCR_SECRET_KEY: '',
    OCR_REGION: 'ap-guangzhou'
};

const KEY = 'TESTKEY1234567890';
const WITH_KEY = Object.assign({}, CLEAN, { MAP_KEY: KEY });
const CALIBRATED = Object.assign({}, WITH_KEY, {
    MAP_CENTER_LNG: '114.36', MAP_CENTER_LAT: '30.53', MAP_ZOOM: '17'
});

async function main() {
    console.log('寻物智联 · A↔B 协同接口契约验收\n');

    // ---------- 地图配置：未启用一律安全降级 ----------
    let m = loadWith(CLEAN);
    let cfg = m.map.buildMapConfig();
    check('无 key 时 enabled:false 且不返回任何 key',
        cfg.enabled === false && cfg.key === '' && cfg.reason === 'map-key-not-configured', cfg.reason);
    check('无 key 时 CSP 不放行任何外部域', m.map.mapCspSources().length === 0);

    m = loadWith(WITH_KEY);
    cfg = m.map.buildMapConfig();
    check('有 key 但缺实测标定时仍关闭真实地图',
        cfg.enabled === false && cfg.reason === 'campus-calibration-not-configured', cfg.reason);
    check('未标定时不编造中心点', cfg.center.lng === null && cfg.center.lat === null);

    m = loadWith(Object.assign({}, WITH_KEY, { MAP_CENTER_LNG: '0', MAP_CENTER_LAT: '0' }));
    check('中国范围外中心点被拒', m.map.buildMapConfig().enabled === false);

    m = loadWith(Object.assign({}, CALIBRATED, { MAP_SDK_URL: 'https://tiles.example.org/gljs' }));
    check('非白名单 SDK 主机被拒', m.map.buildMapConfig().reason === 'sdk-host-not-allowed');

    m = loadWith(Object.assign({}, CALIBRATED, { MAP_SDK_URL: 'http://map.qq.com/api/gljs' }));
    check('非 HTTPS SDK 被拒', m.map.buildMapConfig().enabled === false);

    m = loadWith(CALIBRATED);
    cfg = m.map.buildMapConfig();
    check('配置齐备时 enabled:true', cfg.enabled === true, cfg.reason);
    check('sdkUrl 为 HTTPS 且主机为 map.qq.com', /^https:\/\/map\.qq\.com\//.test(cfg.sdkUrl), cfg.sdkUrl);
    check('sdkUrl 运行时注入 key（仓库内无明文 key）', cfg.sdkUrl.indexOf('key=' + KEY) >= 0);
    check('sdkUrl 带 visualization,service 类库',
        /libraries=visualization(%2C|,)/.test(cfg.sdkUrl), cfg.sdkUrl);
    check('center 为实测 GCJ-02 且 zoom 生效',
        cfg.center.lng === 114.36 && cfg.center.lat === 30.53 && cfg.zoom === 17);
    const csp = m.map.mapCspSources();
    check('启用真实地图时 CSP 放行腾讯地图域', csp.indexOf('https://map.qq.com') >= 0 && csp.length >= 2);
    check('未启用时不放宽 CSP（对照）', loadWith(CLEAN).map.mapCspSources().length === 0);

    // ---------- 地图配置：现场实测标定文件回退 ----------
    const calDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xunwu-cal-'));
    const calFile = path.join(calDir, 'campus-calibration.json');
    try {
        fs.writeFileSync(calFile, JSON.stringify({ center: { lng: 114.3621, lat: 30.5412 }, zoom: 17 }));
        m = loadWith(Object.assign({}, WITH_KEY, { CAMPUS_CALIBRATION: calFile }));
        cfg = m.map.buildMapConfig();
        check('仅有标定文件（无环境变量中心点）时也能启用真实地图',
            cfg.enabled === true && cfg.center.lng === 114.3621 && cfg.center.lat === 30.5412, cfg.reason);
        check('标定文件的 zoom 生效', cfg.zoom === 17);

        fs.writeFileSync(calFile, JSON.stringify({
            zones: [{ name: '空点', lng: null, lat: null }, { name: '图书馆', lng: 114.35, lat: 30.53 }]
        }));
        m = loadWith(Object.assign({}, WITH_KEY, { CAMPUS_CALIBRATION: calFile }));
        cfg = m.map.buildMapConfig();
        check('标定文件按 zones 回退到第一个有效点',
            cfg.enabled === true && cfg.center.lng === 114.35 && cfg.center.lat === 30.53, cfg.reason);

        fs.writeFileSync(calFile, '{not valid json');
        m = loadWith(Object.assign({}, WITH_KEY, { CAMPUS_CALIBRATION: calFile }));
        check('标定文件 JSON 损坏时安全降级',
            m.map.buildMapConfig().reason === 'campus-calibration-not-configured');

        fs.writeFileSync(calFile, JSON.stringify({ center: { lng: 114.3621, lat: 30.5412 } }));
        m = loadWith(Object.assign({}, CALIBRATED, { CAMPUS_CALIBRATION: calFile }));
        check('环境变量中心点优先于标定文件',
            m.map.buildMapConfig().center.lng === 114.36);

        fs.writeFileSync(calFile, JSON.stringify({ center: { lng: 0, lat: 0 } }));
        m = loadWith(Object.assign({}, WITH_KEY, { CAMPUS_CALIBRATION: calFile }));
        check('标定文件坐标越界时不得启用',
            m.map.buildMapConfig().reason === 'campus-calibration-not-configured');
    } finally {
        try { fs.rmSync(calDir, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响结论 */ }
    }

    // ---------- OCR：签名 + 隐私 + 降级 ----------
    m = loadWith(CLEAN);
    check('无密钥时 OCR 未启用', m.ocr.enabled() === false);
    const noKey = await m.ocr.recognize('');
    check('无密钥时给友好提示且不外呼',
        noKey.ok === false && noKey.code === 'ocr-not-configured' && /手动填写/.test(noKey.message));

    // 拼接构造样例号，避免公开仓库里出现完整的敏感号样式（清单 A2 红线）。
    const SAMPLE_PHONE = '138' + '00138000';
    const SAMPLE_STUDENT_ID = '2020' + '12345678';
    const SAMPLE_ID_CARD = '110101' + '1990' + '01011234';
    const sample = '联系 ' + SAMPLE_PHONE + ' 学号 ' + SAMPLE_STUDENT_ID + ' 证件 ' + SAMPLE_ID_CARD;
    const masked = m.ocr.maskSensitive(sample);
    check('OCR 结果脱敏手机号 / 学号 / 证件号',
        !masked.includes(SAMPLE_PHONE) && !masked.includes(SAMPLE_STUDENT_ID) &&
        !masked.includes(SAMPLE_ID_CARD), masked);
    check('脱敏后不残留可还原的长数字片段', !/\d{6,}/.test(masked), masked);
    check('脱敏后仍保留正常描述文字', /联系/.test(masked) && /学号/.test(masked));

    m = loadWith(Object.assign({}, CLEAN, { OCR_SECRET_ID: 'TESTID', OCR_SECRET_KEY: 'TESTSECRET' }));
    check('配齐密钥后 OCR 启用', m.ocr.enabled() === true);
    const ts = 1700000000;
    const payload = '{"ImageBase64":"AA=="}';
    const auth = m.ocr.authorization(payload, ts);
    check('TC3 签名格式正确',
        /^TC3-HMAC-SHA256 Credential=TESTID\/\d{4}-\d{2}-\d{2}\/ocr\/tc3_request, SignedHeaders=content-type;host, Signature=[0-9a-f]{64}$/.test(auth), auth);
    check('TC3 签名确定性', auth === m.ocr.authorization(payload, ts));
    const badImg = await m.ocr.recognize('not-an-image');
    check('非法图片在发网络前被拦下', badImg.ok === false && badImg.code === 'invalid-image');

    // ---------- 前后端接线 ----------
    const server = read('server.js');
    const envExample = read('.env.example');
    const draft = read('public/js/ocr-draft.js');
    const pub = read('public/publish.html');
    const mapSrc = read('public/js/campus-map.js');

    check('server.js 注册 GET /api/map/config', /app\.get\('\/api\/map\/config'/.test(server));
    check('server.js 注册 POST /api/ocr', /app\.post\('\/api\/ocr'/.test(server));
    // 只匹配真正的注册语句，避开注释里提到的 app.get('*') 字面量。
    const fallbackAt = server.search(/app\.get\('\*',\s*\(/);
    check('配置接口在 SPA 兜底之前注册',
        fallbackAt > 0 && server.indexOf("app.get('/api/map/config'") < fallbackAt);
    check('helmet CSP 按启用状态放行地图域',
        /mapCspSources\(\)/.test(server) && /connectSrc/.test(server) &&
        /imgSrc/.test(server) && /workerSrc/.test(server));
    check('.env.example 只放占位、不含可用 key',
        /^MAP_KEY=$/m.test(envExample) && !/[A-Za-z0-9]{32,}/.test(envExample));
    check('前端 OCR 走统一 apiUrl 基址', /apiUrl\(ENDPOINT\)/.test(draft));
    check('前端 OCR 不写外部 URL / 密钥', !/https?:\/\//.test(draft) && !/OCR_SECRET/.test(draft));
    check('发布页挂载 OCR 入口与提示区',
        /js\/ocr-draft\.js/.test(pub) && /id="ocrDraftBtn"/.test(pub) && /id="ocrDraftNotice"/.test(pub));
    // 与 B1 验收脚本口径一致：SVG 命名空间（w3.org）豁免，其余外部 URL 一律禁止。
    const extUrls = mapSrc.match(/https?:\/\/[^\s"'`)<>]+/gi) || [];
    const badUrls = extUrls.filter((u) => !/w3\.org/i.test(u));
    check('B1 前端仍无写死的外部 SDK 地址', badUrls.length === 0, badUrls.slice(0, 3).join(' | '));

    // ---------- 汇总 ----------
    let pass = 0;
    for (const r of results) {
        console.log((r.ok ? '[PASS] ' : '[FAIL] ') + r.name + (r.detail ? '  - ' + r.detail : ''));
        if (r.ok) pass++;
    }
    console.log('\n汇总：' + pass + '/' + results.length + ' 项通过');
    process.exit(pass === results.length ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
