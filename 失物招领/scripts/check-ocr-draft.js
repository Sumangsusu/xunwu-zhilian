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
check('描述由识别结果生成通顺草稿', /手表/.test(draft.values.description) && /请核对并补充细节/.test(draft.values.description) && draft.values.description.indexOf('00\'GT') < 0, draft.values.description);
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

// 8. 乱码拒填：OCR 在物品照片上识别出的乱码不得进入任何公开字段（issue: 00'GT）
check('乱码 00\'GT 判定为不可信', M.isCredibleText("00'GT") === false);
check('乱码不进描述草稿', M.composeDraft('', "00'GT").changed === false);
check('乱码不进可信文字行', M.credibleLines("00'GT\n￥#@").length === 0);
check('可信中文仍保留', M.isCredibleText('黑色双肩包') === true && M.isCredibleText('钥匙') === true);
check('英文物品词仍保留', M.isCredibleText('Apple Watch Ultra') === true);
const garbageOnly = M.composeFormDraft("00'GT", null, {
    title: '', category: '', color: '', features: '', description: ''
});
check('纯乱码时一个字段都不填', garbageOnly.filled.length === 0, JSON.stringify(garbageOnly.filled));

// 9. 截图场景：乱码 + 物品识别成功 -> 填入模型给出的可靠中文名，描述不被乱码污染
const rescued = M.composeFormDraft("00'GT", {
    type: '手表', category: '电子数码', color: '银色', rejected: false, candidates: []
}, { title: '', category: '', color: '', features: '', description: '' });
check('乱码场景由物品识别补名称', rescued.values.title === '手表' && rescued.values.category === '电子数码', JSON.stringify(rescued.values));
check('乱码不污染描述（用可靠识别结果生成，不含乱码）', rescued.values.description.indexOf("00'GT") < 0 && /手表/.test(rescued.values.description), JSON.stringify(rescued.values.description));
const bothFail = M.composeFormDraft("00'GT", { type: '未能确定', rejected: true, color: '未知' }, {
    title: '', category: '', color: '', features: '', description: ''
});
check('乱码且识别失败时留空待手填', bothFail.filled.length === 0, JSON.stringify(bothFail.filled));

// 10. 多品类物品识别同样可行：各类物品都能从识别结果填入名称/分类/主色
const CATEGORIES = [
    ['背包', '箱包类', '黑色'], ['手表', '电子数码', '白色'], ['手机', '电子数码', '黑色'],
    ['耳机', '电子数码', '白色'], ['钥匙', '钥匙', '银色'], ['水杯', '其他物品', '蓝色'],
    ['笔记本', '其他物品', '红色'], ['钱包', '箱包类', '棕色'], ['眼镜', '衣物配饰', '黑色'],
    ['雨伞', '其他物品', '蓝色']
];
CATEGORIES.forEach(function (c) {
    const r = M.composeFormDraft(c[0], {
        type: c[0], category: c[1], color: c[2], rejected: false, candidates: []
    }, { title: '', category: '', color: '', features: '', description: '' });
    check('物品识别-' + c[0], r.values.title === c[0] && r.values.category === c[1] && r.values.color === c[2], JSON.stringify(r.values));
});

// 11. 图片格式统一：WebP/GIF/PNG 转 JPEG 后才发 /api/recognize（后端只解 JPEG/PNG）
check('存在 toJpegDataUrl 转码函数', typeof M.toJpegDataUrl === 'function');
check('识别请求前先经过 toJpegDataUrl', /toJpegDataUrl\(dataUrl\)[\s\S]{0,120}RECOGNIZE_ENDPOINT/.test(js));
check('转码目标为 image/jpeg', js.indexOf("canvas.toDataURL('image/jpeg', 0.9)") >= 0);

// 12. 核心回归：物品照片 OCR 把包装/铭牌/水印识别成杂乱文字，不得整段进详细描述
//     模拟一张耳机包装盒照片的真实 OCR 返回（型号/参数/认证/厂名 + 一句真实描述）
const messyOCR = [
    '型号：A1234', '执行标准 GB/T 14436', '生产日期 2024.05.12', '净含量 120g',
    '黑色蓝牙耳机', '序列号 882731094', 'Made in China', '认证：CE FCC',
    '东莞市某某电子厂', 'www.example.com', '￥#@ 00\'GT'
].join('\n');
check('参数行判定为不可作描述',
    ['型号：A1234', '执行标准 GB/T 14436', '生产日期 2024.05.12', 'Made in China', '认证：CE FCC', '序列号 882731094']
        .every((line) => M.isDescriptiveLine(line) === false));
check('真实物品描述行被保留', M.isDescriptiveLine('黑色蓝牙耳机') === true);
const cleaned = M.descriptiveLines(messyOCR);
check('严格过滤只留物品描述短句', cleaned === '黑色蓝牙耳机', cleaned);
const messyDraft = M.composeFormDraft(messyOCR, null, {
    title: '', category: '', color: '', features: '', description: ''
});
check('凌乱 OCR 只留干净短句、不带参数水印',
    /黑色蓝牙耳机/.test(messyDraft.values.description) &&
    ['型号', '执行标准', 'GB', '生产日期', '序列号', 'Made in', '认证', '电子厂', 'www', '00\'GT']
        .every((noise) => messyDraft.values.description.indexOf(noise) < 0),
    JSON.stringify(messyDraft.values.description));
const messyWithRecognize = M.composeFormDraft(messyOCR, {
    type: '耳机', category: '电子数码', color: '黑色', rejected: false, candidates: []
}, { title: '', category: '', color: '', features: '', description: '' });
const md = messyWithRecognize.values.description;
check('有识别结果时描述通顺且无参数乱码',
    /耳机/.test(md) && md.indexOf('型号') < 0 && md.indexOf('GB') < 0 && md.indexOf('Made in') < 0 &&
    md.indexOf('00\'GT') < 0 && md.indexOf('电子厂') < 0, md);
// 用户已填描述时绝不被覆盖
const keepDesc = M.composeFormDraft(messyOCR, {
    type: '耳机', category: '电子数码', color: '黑色', rejected: false, candidates: []
}, { title: '', category: '', color: '', features: '', description: '我自己写的描述' });
check('凌乱 OCR 不覆盖用户已填描述', keepDesc.values.description === '我自己写的描述', keepDesc.values.description);

console.log('\n结果：' + pass + '/' + total + ' 通过');
process.exit(pass === total ? 0 : 1);
