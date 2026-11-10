#!/usr/bin/env node
/**
 * 寻物智联 · B3「识别 → 发布联动」验收脚本（零依赖）
 *
 * 用法：在「失物招领/」目录下执行
 *     node scripts/check-recognize-publish.js
 * 退出码：0 = 全部通过；1 = 存在失败项
 *
 * 不只是静态扫字符串：用 vm + 极简 DOM 桩真实执行 sendToPublish() 与
 * applyRecognizeDraft()，验证「草稿能带进表单」且「绝不自动提交入库」。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const draft = require(path.join(ROOT, 'public', 'js', 'recognize-draft.js'));
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const rec = read('public/recognize.html');
const pub = read('public/publish.html');
const mod = read('public/js/recognize-draft.js');

let pass = 0, total = 0;
function check(name, ok, detail) {
    total++;
    if (ok) pass++;
    console.log((ok ? '[PASS] ' : '[FAIL] ') + name + (detail ? '  - ' + detail : ''));
}

console.log('寻物智联 · B3 识别→发布联动验收\n');

// ==================== 1. 纯逻辑模块运行时测试 ====================
const normal = draft.build({
    type: '双肩包', color: '黑色', category: '箱包类',
    features: ['黑色', '背包', '运动', '背包'], confidence: 88
});
check('正常结果生成 v1 草稿',
    !!normal && normal.v === 1 && normal.source === 'recognize' && normal.category === '箱包类');
check('特征去重并剔除与主色重复项',
    JSON.stringify(normal.features) === '["背包","运动"]',
    JSON.stringify(normal.features));

const illegal = draft.build({ type: 'x', color: '霓虹色', category: '不存在的类', features: [] });
check('非法颜色/分类被过滤为空', illegal.color === '' && illegal.category === '');

const failed = draft.build({
    type: '（物体识别暂不可用）', color: '未知', category: '其他物品',
    features: ['黑色'], modelError: true
});
check('模型失败不伪造数据',
    failed.modelError === true && failed.type === '' && failed.color === '' &&
    failed.category === '' && failed.features.length === 0);
check('build 对空输入安全', draft.build(null) === null && draft.build(undefined) === null);

const applied = draft.apply(normal, {
    title: '我自己写的标题', category: '', color: '', features: '', description: ''
});
check('只填空字段，不覆盖用户输入',
    applied.title === '我自己写的标题' && applied.category === '箱包类' && applied.color === '黑色');
check('特征与描述草稿生成',
    applied.features === '背包、运动' && applied.description.indexOf('识别主色：黑色') >= 0);

const applied2 = draft.apply(normal, {
    title: 'T', category: '钥匙', color: '红色', features: '旧标签', description: '已有描述'
});
check('已填字段全部保留',
    applied2.category === '钥匙' && applied2.color === '红色' &&
    applied2.features === '旧标签' && applied2.description === '已有描述');
check('草稿版本不符时原样返回',
    draft.apply({ v: 99 }, { title: 'A' }).title === 'A');
check('特征输入框解析',
    JSON.stringify(draft.parseFeatures('皮质、对折, 有磨损')) === '["皮质","对折","有磨损"]');
check('颜色枚举与 classifyColor 一致（11 色）', draft.COLORS.length === 11 &&
    draft.COLORS.indexOf('银色') >= 0 && draft.COLORS.indexOf('棕色') >= 0);
// 先剥掉注释，避免「写进 sessionStorage 前先过这一层」这类说明文字造成假阳性
const modCode = mod.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('纯逻辑模块不碰 DOM / 网络 / 存储',
    !/document\.|sessionStorage|fetch\s*\(|XMLHttpRequest/.test(modCode));

// ==================== 2. 用 vm 真实执行「一键带入」 ====================
function slice(src, startMark, endMark) {
    const s = src.indexOf(startMark);
    const e = src.indexOf(endMark, s);
    if (s < 0 || e < 0) return '';
    return src.slice(s, e);
}

const sendSrc = slice(rec, '        function sendToPublish() {', '        async function showRecognitionResult');
const store2 = {};
const sandbox2 = {
    window: { _lastRecognitionResult: normal, RecognizeDraft: draft },
    sessionStorage: { setItem: (k, v) => { store2[k] = v; } },
    location: { href: '' },
    alert: () => { throw new Error('不应弹出错误'); },
    // 若函数里出现任何写库 / 网络行为，立即抛错使本项失败
    fetch: () => { throw new Error('不应发起网络请求'); },
    DB: { add: () => { throw new Error('不应写入数据库'); } },
    console
};
let sendOk = false, sendErr = '';
try {
    vm.runInNewContext(sendSrc + '\nsendToPublish();', sandbox2);
    sendOk = true;
} catch (e) { sendErr = e.message; }
check('sendToPublish() 真实执行且不提交入库', sendOk, sendErr || '无网络/写库调用');
check('草稿写入 sessionStorage 并跳转发布页',
    !!store2[draft.DRAFT_KEY] && /publish\.html\?from=recognize/.test(sandbox2.location.href));
const sentDraft = JSON.parse(store2[draft.DRAFT_KEY] || '{}');
check('跳转携带的草稿字段正确',
    sentDraft.category === '箱包类' && sentDraft.color === '黑色' &&
    JSON.stringify(sentDraft.features) === '["背包","运动"]');

// ==================== 3. 用 vm + DOM 桩真实执行「预填进表单」 ====================
const applySrc = slice(pub, '        function applyRecognizeDraft() {', '        function dismissRecognizeDraft()');
const els = {
    itemTitle: { value: '' }, itemCategory: { value: '' }, itemColor: { value: '' },
    itemFeatures: { value: '' }, itemDesc: { value: '' },
    recognizeDraftNotice: { classList: { remove() {}, add() {} } },
    recognizeDraftSummary: { textContent: '' }
};
const store3 = { [draft.DRAFT_KEY]: JSON.stringify(sentDraft) };
const sandbox3 = {
    window: { RecognizeDraft: draft },
    document: { getElementById: id => els[id] || null },
    sessionStorage: {
        getItem: k => (k in store3 ? store3[k] : null),
        removeItem: k => { delete store3[k]; }
    },
    console
};
let applyOk = false, applyErr = '';
try {
    vm.runInNewContext(applySrc + '\napplyRecognizeDraft();', sandbox3);
    applyOk = true;
} catch (e) { applyErr = e.message; }
check('applyRecognizeDraft() 真实执行', applyOk, applyErr || '无异常');
check('类别 / 主色 / 特征带入发布表单',
    els.itemCategory.value === '箱包类' && els.itemColor.value === '黑色' &&
    els.itemFeatures.value === '背包、运动',
    [els.itemCategory.value, els.itemColor.value, els.itemFeatures.value].join(' / '));
check('名称与描述作为草稿带入',
    els.itemTitle.value === '双肩包' && els.itemDesc.value.indexOf('识别主色：黑色') >= 0);
check('草稿一次性消费（刷新不覆盖）', !(draft.DRAFT_KEY in store3));

// 用户已有内容不被覆盖（第二次模拟）
els.itemCategory.value = '钥匙'; els.itemColor.value = '红色';
els.itemFeatures.value = ''; els.itemDesc.value = '用户自己写的描述'; els.itemTitle.value = '我的标题';
store3[draft.DRAFT_KEY] = JSON.stringify(sentDraft);
vm.runInNewContext(applySrc + '\napplyRecognizeDraft();', sandbox3);
check('重放草稿不覆盖用户已填字段',
    els.itemCategory.value === '钥匙' && els.itemColor.value === '红色' &&
    els.itemDesc.value === '用户自己写的描述' && els.itemFeatures.value === '背包、运动');

// ==================== 4. 页面静态契约 ====================
check('识别页有一键带入按钮', /id="sendToPublishBtn"[\s\S]{0,300}onclick="sendToPublish\(\)"/.test(rec));
check('识别页有模型失败提示并按结果切换',
    /id="modelErrorNotice"/.test(rec) && /classList\.toggle\('hidden', !result\.modelError\)/.test(rec));
check('识别异常结果带降级标记', /modelError:\s*true/.test(rec) && /识别未完成/.test(rec));
check('两页均引入 recognize-draft.js',
    /src="js\/recognize-draft\.js"/.test(rec) && /src="js\/recognize-draft\.js"/.test(pub));
check('发布页新增主色与特征字段',
    /id="itemColor"/.test(pub) && /id="itemFeatures"/.test(pub));
check('提交时携带 color / features（不再写死）',
    /color:\s*document\.getElementById\('itemColor'\)/.test(pub) &&
    /features:\s*window\.RecognizeDraft\.parseFeatures/.test(pub) &&
    !/features:\s*\[\]/.test(pub));
check('提示条明确「未发布前不入库」', /未发布前不会写入数据库/.test(pub));

// ==================== 5. 断网可用性 ====================
const RE_EXT = /https?:\/\/(?!www\.w3\.org)[^\s"'`)<>]+/gi;
const extHits = [];
for (const [name, src] of [['recognize.html', rec], ['publish.html', pub], ['recognize-draft.js', mod]]) {
    let m;
    RE_EXT.lastIndex = 0;
    while ((m = RE_EXT.exec(src)) !== null) extHits.push(name + ': ' + m[0].slice(0, 50));
}
check('联动链路无外部 URL（断网可用）', extHits.length === 0,
    extHits.length ? extHits.join(' | ') : '0 处外部依赖');
const modelsOk = fs.existsSync(path.join(ROOT, 'public/models/mobilenet/model.json')) &&
    fs.existsSync(path.join(ROOT, 'public/vendor/tf.min.js'));
check('本地模型与推理库齐备', modelsOk);

console.log('\n汇总：' + pass + '/' + total + ' 项通过');
process.exit(pass === total ? 0 : 1);
