#!/usr/bin/env node
/**
 * 寻物智联 · 发布页「识别 → 草稿」验收脚本（零依赖）
 *
 * 用法：在「失物招领/」目录下执行 node scripts/check-ocr-draft.js
 * 覆盖：OCR 文字只追加描述、结构化字段只填空不覆盖、物品识别失败不影响文字草稿、
 *      提示文案与页面按钮一致。
 */
'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'public', 'js', 'recognize-draft.js'));
const M = require(path.join(ROOT, 'public', 'js', 'ocr-draft.js'));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, total = 0;
function check(name, ok, detail) {
    total++;
    if (ok) pass++;
    console.log((ok ? '[PASS] ' : '[FAIL] ') + name + (detail ? '  - ' + detail : ''));
}

console.log('寻物智联 · OCR 识别草稿验收\n');

// 1. 脱敏仍生效（公开描述字段不得出现手机号）
const masked = M.sanitize('联系我 13812345678 领取');
check('手机号在描述草稿中脱敏', masked.indexOf('13812345678') < 0 && masked.indexOf('[手机号已隐藏]') >= 0, masked);

// 2. 描述只追加，不覆盖用户输入
const appended = M.composeDraft('我捡到的', '黑色双肩包');
check('已有描述时追加而非覆盖', appended.text === '我捡到的\n黑色双肩包' && appended.changed === true, appended.text);

// 3. 纯文字提取结构化字段，且只填空字段
const parsed = M.parseFieldsFromText('黑色双肩包，皮质，有磨损', {
    title: '', category: '', color: '', features: '', description: ''
});
check('文字提取分类/主色/特征', parsed.category === '箱包类' && parsed.color === '黑色' && parsed.features === '皮质、磨损', JSON.stringify(parsed));
const kept = M.parseFieldsFromText('蓝色耳机，全新', {
    title: '我自己的标题', category: '钥匙', color: '红色', features: '原有', description: ''
});
check('不覆盖用户已填字段', kept.title === '我自己的标题' && kept.category === '钥匙' && kept.color === '红色' && kept.features === '原有', JSON.stringify(kept));

// 4. 物品识别结果归一化：不确定结果不带入分类/名称
const norm = M.normalizeRecognition({ type: '手表', category: '电子数码', color: '白色', candidates: [{ type: '手环' }] });
check('正常识别结果归一化', norm.type === '手表' && norm.category === '电子数码' && norm.features.length === 2);
const rejected = M.normalizeRecognition({ type: '未能确定', category: '其他物品', rejected: true, color: '未知' });
check('识别失败不伪造字段', rejected.type === '' && rejected.modelError === true);

// 5. 组合草稿：文字 + 物品识别，描述以 OCR 原文为准，可见字段被真正填入
const current = { title: '', category: '', color: '', features: '', description: '' };
const draft = M.composeFormDraft('白色智能手表', {
    type: '手表', category: '电子数码', color: '白色', rejected: false,
    candidates: [{ type: '智能手表' }]
}, current);
check('识别结果填入名称/分类/主色', !!draft.values.title && draft.values.category === '电子数码' && draft.values.color === '白色', JSON.stringify(draft.values));
check('填入字段被如实记录用于提示', ['title', 'category', 'color', 'features', 'description'].every((k) => draft.filled.indexOf(k) >= 0), JSON.stringify(draft.filled));
check('描述使用 OCR 原文', draft.values.description === '白色智能手表', draft.values.description);
check('用户已填名称不被覆盖', M.composeFormDraft('蓝色耳机', norm, {
    title: '我的耳机', category: '', color: '', features: '', description: ''
}).values.title === '我的耳机');

// 6. 物品识别失败时文字草稿仍然可用
const textOnly = M.composeFormDraft('黑色双肩包，皮质', null, {
    title: '', category: '', color: '', features: '', description: ''
});
check('物品识别失败仍填入文字字段', textOnly.values.category === '箱包类' && textOnly.filled.indexOf('category') >= 0, JSON.stringify(textOnly.filled));

// 7. 页面与后端接线静态检查
const html = read('public/publish.html');
const js = read('public/js/ocr-draft.js');
const server = read('server.js');
check('发布页加载 ocr-draft.js', html.indexOf('js/ocr-draft.js') >= 0);
check('按钮文案与「填入发布草稿」一致', html.indexOf('识别图片内容，填入发布草稿') >= 0);
check('提示如实列出填入字段', js.indexOf("'已填入：' + names") >= 0);
check('填入后滚动到字段', js.indexOf('scrollIntoView') >= 0);
check('后端两个识别接口都在', server.indexOf("app.post('/api/ocr'") >= 0 && server.indexOf("app.post('/api/recognize'") >= 0);

console.log('\n结果：' + pass + '/' + total + ' 通过');
process.exit(pass === total ? 0 : 1);
