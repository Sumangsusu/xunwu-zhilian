#!/usr/bin/env node
/**
 * 寻物智联 · B0 前端基线验收脚本（零依赖）
 *
 * 用法：在「失物招领/」目录下执行
 *     node scripts/check-frontend-baseline.js
 * 退出码：0 = 全部通过；1 = 存在失败项
 *
 * 检查对象：public/ 下的业务 HTML 与 public/js/ 下的业务 JS。
 * 第三方库（vendor/、models/）、静态图片（images/）、样式（css/）不参与扫描，
 * 因为它们不是本项目手写代码，改动它们反而会破坏「断网可用」。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const JS_DIR = path.join(PUBLIC, 'js');

const results = [];
function record(name, ok, detail) {
    results.push({ name: name, ok: !!ok, detail: detail || '' });
}
function readText(p) { return fs.readFileSync(p, 'utf8'); }
function rel(p) { return path.relative(ROOT, p).replace(/\\/g, '/'); }

// ---------- 收集业务文件 ----------
const htmlFiles = fs.readdirSync(PUBLIC)
    .filter(f => f.endsWith('.html'))
    .map(f => path.join(PUBLIC, f)).sort();
const jsFiles = fs.readdirSync(JS_DIR)
    .filter(f => f.endsWith('.js'))
    .map(f => path.join(JS_DIR, f)).sort();
const businessFiles = htmlFiles.concat(jsFiles);

console.log('寻物智联 · B0 前端基线验收');
console.log('扫描业务文件 ' + businessFiles.length + ' 个（' +
    htmlFiles.length + ' HTML / ' + jsFiles.length + ' JS）\n');

// ---------- 规则 1：无本机地址 / 回环地址硬编码 ----------
const RE_LOCALHOST = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?/i;
const localHits = [];
for (const f of businessFiles) {
    readText(f).split(/\r?\n/).forEach((line, i) => {
        if (RE_LOCALHOST.test(line)) localHits.push(rel(f) + ':' + (i + 1));
    });
}
record('业务代码无本机/回环地址硬编码', localHits.length === 0,
    localHits.length ? '命中 ' + localHits.join(', ') : '0 处命中');

// ---------- 规则 2：无外部域名硬编码 ----------
// 白名单：SVG / XML 标准命名空间与许可证注释，不是网络请求
const RE_EXT_URL = /https?:\/\/[^\s"'`)<>]+/gi;
const URL_WHITELIST = /w3\.org|schemas\.xmlsoap|apache\.org\/licenses/i;
const extHits = [];
for (const f of businessFiles) {
    readText(f).split(/\r?\n/).forEach((line, i) => {
        let m;
        RE_EXT_URL.lastIndex = 0;
        while ((m = RE_EXT_URL.exec(line)) !== null) {
            if (!URL_WHITELIST.test(m[0])) {
                extHits.push(rel(f) + ':' + (i + 1) + ' -> ' + m[0].slice(0, 60));
            }
        }
    });
}
record('业务代码无外部域名硬编码', extHits.length === 0,
    extHits.length ? '命中 ' + extHits.slice(0, 8).join(' | ') :
        '0 处命中（XML 命名空间已豁免）');

// ---------- 规则 3：接口地址统一走 apiUrl() ----------
const RE_RAW_API = /(?:\bfetch\s*\(\s*|\bhref\s*=\s*|location\.(?:href|replace|assign)\s*=\s*)['"]\/api\//i;
const rawApiHits = [];
for (const f of businessFiles) {
    readText(f).split(/\r?\n/).forEach((line, i) => {
        if (RE_RAW_API.test(line)) rawApiHits.push(rel(f) + ':' + (i + 1));
    });
}
record('接口地址统一经 apiUrl() 生成', rawApiHits.length === 0,
    rawApiHits.length ? '裸绝对路径 ' + rawApiHits.join(', ') : '0 处裸 /api/ 调用');

// ---------- 规则 4：静态资源使用相对路径 ----------
const RE_ABS_ASSET = /(?:src|href)\s*=\s*["']\/(?:vendor|css|js|images|models)\//i;
const absHits = [];
for (const f of businessFiles) {
    readText(f).split(/\r?\n/).forEach((line, i) => {
        if (RE_ABS_ASSET.test(line)) absHits.push(rel(f) + ':' + (i + 1));
    });
}
record('静态资源改为相对路径', absHits.length === 0,
    absHits.length ? '绝对引用 ' + absHits.join(', ') : '0 处根绝对引用');

// ---------- 规则 5：每个页面都引入 app-base.js ----------
const missingBase = htmlFiles
    .filter(f => !/src\s*=\s*["']js\/app-base\.js["']/.test(readText(f)))
    .map(rel);
record('所有页面引入 js/app-base.js', missingBase.length === 0,
    missingBase.length ? '缺少 ' + missingBase.join(', ') :
        htmlFiles.length + ' 个页面全部引入');

// ---------- 规则 6：统一基址模块存在 ----------
const baseFile = path.join(JS_DIR, 'app-base.js');
const baseOk = fs.existsSync(baseFile) && /window\.apiUrl\s*=/.test(readText(baseFile));
record('统一基址模块存在', baseOk, baseOk ? rel(baseFile) : '缺少 public/js/app-base.js');

// ---------- 规则 7：CDN / 模型已本地化（断网可用） ----------
const requiredAssets = [
    'public/vendor/tailwind.js',
    'public/vendor/font-awesome.min.css',
    'public/vendor/tf.min.js',
    'public/vendor/mobilenet.min.js',
    'public/vendor/imagenet_labels.js',
    'public/models/mobilenet/model.json'
];
const missingAssets = requiredAssets.filter(p => !fs.existsSync(path.join(ROOT, p)));
record('本地化资源齐备', missingAssets.length === 0,
    missingAssets.length ? '缺失 ' + missingAssets.join(', ') :
        requiredAssets.length + ' 项齐备');

// ---------- 汇总 ----------
let pass = 0;
for (const r of results) {
    console.log((r.ok ? '[PASS] ' : '[FAIL] ') + r.name + (r.detail ? '  - ' + r.detail : ''));
    if (r.ok) pass++;
}
console.log('\n汇总：' + pass + '/' + results.length + ' 项通过');
console.log('说明：README / 使用说明 / 启动脚本 / 原始备份页中的本机地址属本地开发文档，');
console.log('      不是浏览器运行代码，不参与扫描，也不影响「换域名或 IP 打开」的验收。');
process.exit(pass === results.length ? 0 : 1);
