// ==================== 双向撮合评分模块 ====================
// 目标：用户发布一条启事后，系统主动去"反向类型"的启事里找疑似同一件物品，
//       把「用户自己翻列表」变成「系统先帮你找一遍」。
//
// 设计原则：
//   1) 纯函数、无 IO、无数据库依赖 —— 方便用 scripts/check-match-engine.js 直接单测；
//   2) 复用 location-alias.js 的三层地点归一化（校区 / 楼栋 / 别名），
//      保证「信部一教」与「信息学部第一教学楼」被算作同一地点；
//   3) 分数可解释 —— 每个得分点都产出一句理由，前端直接展示，不做黑箱。
//
// 评分（满分 100，阈值 60）：
//   地点：字面归一化完全相同 30 / 同一楼栋区域 22 / 仅同校区 12
//   时间：同一天 25 / 相差 2 天内 15 / 相差一周内 8
//   类别相同 20 ｜ 颜色相同（且非"未知"）15
//   标题二元词重合 5~10 ｜ 特征标签重合 5
//
// 合规：本模块不接触联系方式、防冒领答案、图片；只读公开字段。

'use strict';

const locationAlias = require('./public/js/location-alias');

// 达到该分数才认为"值得提醒用户看一眼"
const THRESHOLD = 60;
// 单条启事最多保留的匹配数，避免一次发布刷出几十条噪音
const MAX_PER_ITEM = 10;

// 这些颜色对区分物品几乎没有信息量，不作为得分项
const COLOR_IGNORE = ['', '未知', '其他', '不清楚', '彩色'];

// 标题里这些二元词属于通用词/颜色词，重复命中不算"特征重合"
const GRAM_IGNORE = [
  '黑色', '白色', '蓝色', '红色', '绿色', '黄色', '灰色', '银色', '金色', '粉色',
  '紫色', '棕色', '橙色', '黑色', '一个', '一张', '一把', '一只', '丢失', '捡到',
  '拾到', '不见', '找到', '物品', '东西'
];

function cleanText(value) {
  return String(value == null ? '' : value).toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]/g, '');
}

// 标题 → 二元词集合（中文按 2 字滑窗，英文数字按整词）
function textGrams(text) {
  const s = cleanText(text);
  const grams = new Set();
  const ascii = s.match(/[a-z0-9]{2,}/g) || [];
  for (const word of ascii) grams.add(word);
  const cjk = s.replace(/[a-z0-9]/g, '');
  for (let i = 0; i + 1 < cjk.length; i += 1) {
    const gram = cjk.slice(i, i + 2);
    if (GRAM_IGNORE.indexOf(gram) === -1) grams.add(gram);
  }
  return grams;
}

function sharedCount(a, b) {
  let n = 0;
  for (const value of a) if (b.has(value)) n += 1;
  return n;
}

// 'YYYY-MM-DD' → 当天 0 点的时间戳；无法解析返回 null（不参与时间得分）
function parseDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return null;
  const ms = Date.parse(value.trim() + 'T00:00:00');
  return Number.isNaN(ms) ? null : ms;
}

function scoreLocation(a, b) {
  const ta = locationAlias.tokens(a);
  const tb = locationAlias.tokens(b);
  const isArea = (key) => key.charAt(0) === '@';
  const areaA = ta.filter(isArea);
  const areaB = tb.filter(isArea);
  // 两边都点明校区时必须一致，否则"信部一教"会靠 normalize 去掉校区后错配"工学部一教"。
  if (areaA.length && areaB.length && !areaA.some((key) => areaB.indexOf(key) !== -1)) {
    return { score: 0, reason: '' };
  }

  const na = locationAlias.normalize(a);
  const nb = locationAlias.normalize(b);
  if (na && na === nb) return { score: 30, reason: '同一地点' };

  if (!ta.length || !tb.length) return { score: 0, reason: '' };
  const shared = ta.filter((key) => tb.indexOf(key) !== -1);
  if (!shared.length) return { score: 0, reason: '' };
  // 校区键（@ 前缀）单独降权：同校区不同楼栋不该拿满地点分。
  if (shared.some((key) => !isArea(key))) return { score: 22, reason: '同一楼栋区域' };
  return { score: 12, reason: '同一校区' };
}

function scoreTime(a, b) {
  const da = parseDay(a);
  const db = parseDay(b);
  if (da == null || db == null) return { score: 0, reason: '' };
  const days = Math.abs(da - db) / 86400000;
  if (days === 0) return { score: 25, reason: '同一天' };
  if (days <= 2) return { score: 15, reason: '相差 2 天内' };
  if (days <= 7) return { score: 8, reason: '相差一周内' };
  return { score: 0, reason: '' };
}

function scoreFeatures(a, b) {
  const fa = new Set((Array.isArray(a) ? a : []).map(cleanText).filter(Boolean));
  const fb = new Set((Array.isArray(b) ? b : []).map(cleanText).filter(Boolean));
  if (!fa.size || !fb.size) return { score: 0, reason: '' };
  return sharedCount(fa, fb) > 0 ? { score: 5, reason: '特征重合' } : { score: 0, reason: '' };
}

function scoreTitle(a, b) {
  const ga = textGrams(a);
  const gb = textGrams(b);
  if (!ga.size || !gb.size) return { score: 0, reason: '' };
  const n = sharedCount(ga, gb);
  if (n >= 2) return { score: 10, reason: '标题特征重合' };
  if (n === 1) return { score: 5, reason: '标题有共同词' };
  return { score: 0, reason: '' };
}

/**
 * 给一对启事打分。a、b 为 mapItem 过的对象（只需公开字段）。
 * @returns {{score:number, reasons:string[], breakdown:Object}}
 */
function scorePair(a, b) {
  if (!a || !b) return { score: 0, reasons: [], breakdown: {} };
  // 同类型不互配：寻物只能被招领匹配，反之亦然。
  if (a.type === b.type) return { score: 0, reasons: [], breakdown: {} };

  const reasons = [];
  const breakdown = {};
  let score = 0;

  const loc = scoreLocation(a.location, b.location);
  const time = scoreTime(a.date, b.date);
  const cat = String(a.category || '') === String(b.category || '') && a.category ? 20 : 0;
  const color = COLOR_IGNORE.indexOf(String(a.color || '')) === -1 &&
    String(a.color || '') === String(b.color || '') ? 15 : 0;
  const title = scoreTitle(a.title, b.title);
  const feature = scoreFeatures(a.features, b.features);

  const parts = [
    ['location', loc.score, loc.reason],
    ['time', time.score, time.reason],
    ['category', cat, cat ? '类别相同' : ''],
    ['color', color, color ? '颜色相同' : ''],
    ['title', title.score, title.reason],
    ['features', feature.score, feature.reason]
  ];
  for (const [key, value, reason] of parts) {
    if (value > 0) {
      score += value;
      breakdown[key] = value;
      if (reason) reasons.push(reason);
    }
  }

  return { score: Math.min(100, score), reasons, breakdown };
}

/** 该商启事（item）与候选列表里哪些够阈值，按分数降序，最多 MAX_PER_ITEM 条。 */
function rank(item, candidates) {
  const hits = [];
  for (const other of candidates) {
    if (!other || other.id === item.id) continue;
    // 同一个人自己的两条启事互配没有意义，只在两边都有发布者时排除
    if (item.publisher && other.publisher && item.publisher === other.publisher) continue;
    const result = scorePair(item, other);
    if (result.score < THRESHOLD) continue;
    hits.push({ item: other, score: result.score, reasons: result.reasons, breakdown: result.breakdown });
  }
  hits.sort((x, y) => y.score - x.score);
  return hits.slice(0, MAX_PER_ITEM);
}

module.exports = { THRESHOLD, MAX_PER_ITEM, scorePair, rank, textGrams, parseDay };
