/**
 * 识别映射表（服务端 / 小程序共用的事实源）
 * ------------------------------------------------------------------
 * 数据与网页版 public/recognize.html 内联的 IMAGENET_MAP / ITEM_GROUPS 保持同步。
 * 网页版为独立内联副本（历史原因：测试脚本 vm 内联执行）；服务端识别模块引用本文件，
 * 新增类别时需同步维护两处。提取为独立文件，避免服务端识别逻辑散落在 recognize.js 内。
 *
 * 用途：
 *  - recognize.js（服务端推理）用 ITEM_GROUPS 做类目聚合、IMAGENET_MAP 做关键字兜底；
 *  - 小程序发布页预填物品类型/分类也使用这里的映射（经 /api/recognize 返回）。
 */

'use strict';

// ImageNet 类别关键字 -> [中文物品名, 数据库分类]（具体词放前面，避免被泛词误命中）
// 与网页版 public/recognize.html 中 IMAGENET_MAP 一致（2026-11-18 修订版）。
const IMAGENET_MAP = [
  ['wallet', '钱包', '箱包类'],
  ['purse', '手提包', '箱包类'],
  ['handbag', '手提包', '箱包类'],
  ['backpack', '背包', '箱包类'],
  ['knapsack', '背包', '箱包类'],
  ['book bag', '背包', '箱包类'],
  ['plastic bag', '购物袋', '箱包类'],
  ['shopping bag', '购物袋', '箱包类'],
  ['money bag', '钱包', '箱包类'],
  ['cellular telephone', '手机', '电子数码'],
  ['mobile phone', '手机', '电子数码'],
  ['cellphone', '手机', '电子数码'],
  ['cellular phone', '手机', '电子数码'],
  ['ipod', '音乐播放器', '电子数码'],
  ['laptop', '笔记本电脑', '电子数码'],
  ['notebook computer', '笔记本电脑', '电子数码'],
  ['computer keyboard', '键盘', '电子数码'],
  ['keypad', '键盘', '电子数码'],
  ['computer mouse', '鼠标', '电子数码'],
  ['mouse', '鼠标', '电子数码'],
  ['earphones', '耳机', '电子数码'],
  ['headphones', '耳机', '电子数码'],
  ['earbuds', '耳机', '电子数码'],
  ['digital watch', '手表', '电子数码'],
  ['wristwatch', '手表', '电子数码'],
  ['watch', '手表', '电子数码'],
  ['remote', '遥控器', '电子数码'],
  ['remote control', '遥控器', '电子数码'],
  ['camera', '相机', '电子数码'],
  ['battery', '电池', '电子数码'],
  ['flashlight', '手电筒', '电子数码'],
  ['torch', '手电筒', '电子数码'],
  ['sunglass', '太阳镜', '衣物配饰'],
  ['shades', '太阳镜', '衣物配饰'],
  ['dark glasses', '太阳镜', '衣物配饰'],
  ['eyeglasses', '眼镜', '衣物配饰'],
  ['glasses', '眼镜', '衣物配饰'],
  ['cardigan', '衣物', '衣物配饰'],
  ['jersey', '衣物', '衣物配饰'],
  ['t-shirt', '衣物', '衣物配饰'],
  ['tee shirt', '衣物', '衣物配饰'],
  ['suit', '衣物', '衣物配饰'],
  ['umbrella', '雨伞', '其他物品'],
  ['water bottle', '水杯', '其他物品'],
  ['pop bottle', '水杯', '其他物品'],
  ['coffee mug', '杯子', '其他物品'],
  ['cup', '杯子', '其他物品'],
  ['mug', '杯子', '其他物品'],
  ['book jacket', '书本', '其他物品'],
  ['book cover', '书本', '其他物品'],
  ['comic book', '书本', '其他物品'],
  ['book', '书本', '其他物品'],
  ['notebook', '笔记本', '其他物品'],
  ['notepad', '笔记本', '其他物品'],
  ['envelope', '信封', '证件文件'],
  ['mailbag', '邮包', '证件文件'],
  ['postbag', '邮包', '证件文件'],
  ['playing card', '卡片', '证件文件'],
  ['card', '卡片', '证件文件'],
  ['teddy', '毛绒玩具', '其他物品'],
  ['chain', '链条', '其他物品'],
  ['combination lock', '锁', '其他物品'],
  ['padlock', '锁', '其他物品'],
  ['lipstick', '化妆品', '其他物品'],
  ['perfume', '化妆品', '其他物品'],
  ['hair spray', '化妆品', '其他物品'],
  ['sunscreen', '化妆品', '其他物品'],
  ['lighter', '打火机', '其他物品'],
  ['candle', '蜡烛', '其他物品'],
  ['table lamp', '灯具', '其他物品'],
  ['desk lamp', '灯具', '其他物品'],
  ['lamp', '灯具', '其他物品'],
  ['spotlight', '灯具', '其他物品'],
  ['pencil box', '文具', '其他物品'],
  ['ruler', '文具', '其他物品'],
  ['stapler', '文具', '其他物品'],
  ['scissors', '文具', '其他物品'],
  ['fountain pen', '笔', '其他物品'],
  ['ballpoint', '笔', '其他物品'],
  ['rubber eraser', '文具', '其他物品']
];

// ===== 类目聚合表（与网页版 2026-11-19 扩充版一致）=====
// 把同一物品的多个 ImageNet 类概率相加，再比较。匹配用「主名精确匹配」，不用 includes，
// 否则 'window screen'（纱窗）、'screen door'（纱门）会被误判成显示器。
const ITEM_GROUPS = [
  // ===== 电子数码 =====
  ['笔记本电脑', '电子数码', ['laptop', 'notebook', 'desktop computer', 'hand-held computer']],
  ['显示器', '电子数码', ['monitor', 'screen', 'television', 'flat-screen']],
  ['手机', '电子数码', ['cellular telephone', 'cellphone', 'ipod']],
  ['键盘', '电子数码', ['computer keyboard', 'space bar', 'typewriter keyboard']],
  ['鼠标', '电子数码', ['mouse']],
  ['耳机', '电子数码', ['earphone', 'earphones', 'headphone', 'headphones', 'earbuds']],
  ['相机', '电子数码', ['camera', 'reflex camera', 'polaroid camera', 'digital camera']],
  ['手表', '电子数码', ['digital watch', 'wristwatch', 'stopwatch', 'analog clock', 'digital clock', 'wall clock']],
  ['遥控器', '电子数码', ['remote control', 'remote']],
  // ===== 箱包类 =====
  ['钱包', '箱包类', ['wallet', 'billfold', 'notecase', 'purse']],
  ['背包', '箱包类', ['backpack', 'knapsack', 'book bag', 'mailbag', 'postbag']],
  ['手提包', '箱包类', ['handbag', 'shopping bag', 'plastic bag', 'shopping basket', 'hamper']],
  // ===== 衣物配饰 =====
  // 2026-11-19 扩充：中式棉袄/卫衣/裙子等软质穿戴物在 ImageNet 无专门类，会被拆成
  // shower cap / bathing cap / bonnet / stole / apron / swimming trunks / pajama 等十几个细类。
  // 统一聚合成「衣物」大类，几类概率相加即可越过拒识阈值，不再误判为 backpack 或「未能确定」。
  ['衣物', '衣物配饰', [
    'coat', 'trench coat', 'fur coat', 'lab coat', 'cloak', 'cape', 'suit', 'wool',
    'cardigan', 'jersey', 'sweatshirt', 'pajama', 'kimono', 'dress', 'gown', 'sarong',
    'apron', 'stole', 'bow tie', 'windsor tie', 'bolo tie', 'scarf', 'veil',
    'jean', 'miniskirt', 'bikini', 'swimming trunks', 'overskirt', 'hoopskirt',
    'brassiere', 'diaper', 'sock', 'bathing cap', 'shower cap', 'bonnet',
    'cowboy hat', 'sombrero', 'cowboy boot', 'loafer', 'sandal', 'mitten',
    'academic gown', 'military uniform', 'bulletproof vest', 'vestment'
  ]],
  ['眼镜', '衣物配饰', ['sunglass', 'sunglasses', 'dark glasses', 'eyeglasses', 'glasses']],
  ['首饰', '衣物配饰', ['necklace', 'bracelet', 'hair slide']],
  // ===== 其他物品 =====
  ['水杯', '其他物品', ['water bottle', 'pop bottle', 'beer bottle', 'coffee mug', 'cup', 'mug', 'water jug', 'pitcher', 'measuring cup', 'whiskey jug', 'wine bottle']],
  ['书本', '其他物品', ['book jacket', 'comic book', 'binder', 'newspaper']],
  ['雨伞', '其他物品', ['umbrella']],
  ['锁具', '其他物品', ['padlock', 'combination lock', 'safety pin']],
  ['文具', '其他物品', ['pencil box', 'ruler', 'stapler', 'scissors', 'ballpoint', 'fountain pen', 'rubber eraser', 'pencil sharpener']],
  ['灯具', '其他物品', ['table lamp', 'lampshade', 'spotlight', 'torch']],
  ['打火机', '其他物品', ['lighter', 'candle']],
  ['乐器', '其他物品', ['acoustic guitar', 'electric guitar', 'violin', 'cello', 'harp', 'banjo', 'flute', 'drum', 'harmonica', 'grand piano', 'steel drum', 'whistle']],
  ['运动用品', '其他物品', ['basketball', 'soccer ball', 'tennis ball', 'racket', 'baseball', 'golf ball', 'mountain bike', 'bicycle-built-for-two', 'football helmet', 'motor scooter']],
  ['玩具', '其他物品', ['teddy', 'jigsaw puzzle', 'crossword puzzle', 'balloon', 'kite']],
  ['化妆品', '其他物品', ['lipstick', 'face powder', 'perfume', 'hair spray', 'lotion', 'sunscreen']],
  // ===== 证件文件 =====
  ['信封', '证件文件', ['envelope']],
  ['卡片', '证件文件', ['playing card']]
];

// 主名归一化：'laptop, laptop computer' -> 'laptop'
function mainLabel(label) {
  return String(label || '').toLowerCase().split(',')[0].trim();
}

// 精确匹配类目组
function matchItemGroup(label) {
  const m = mainLabel(label);
  for (let g = 0; g < ITEM_GROUPS.length; g++) {
    const keys = ITEM_GROUPS[g][2];
    if (keys.indexOf(m) !== -1) return { name: ITEM_GROUPS[g][0], category: ITEM_GROUPS[g][1] };
  }
  return null;
}

// 类目聚合：把同一物品的多个类概率合并后降序
function aggregateByGroup(predictions) {
  const groups = new Map();
  for (const p of predictions) {
    const g = matchItemGroup(p.className);
    if (!g) continue;
    if (!groups.has(g.name)) groups.set(g.name, { type: g.name, category: g.category, prob: 0, members: [] });
    const e = groups.get(g.name);
    e.prob += (p.probability || 0);
    const mn = mainLabel(p.className);
    if (e.members.indexOf(mn) === -1) e.members.push(mn);
  }
  return Array.from(groups.values()).sort((a, b) => b.prob - a.prob);
}

// 将模型预测（英文 ImageNet 标签）映射到中文物品 + 数据库分类
// 策略：① 先做类目聚合（把同一物品的多个 ImageNet 类概率合并，最稳）；② 聚合无命中才退回关键字表兜底。
function mapPredictions(predictions) {
  if (!predictions || !predictions.length) {
    return { primary: { type: '（未识别）', category: '其他物品', prob: 0, raw: '' }, candidates: [] };
  }

  const groups = aggregateByGroup(predictions);
  if (groups.length > 0) {
    const primary = {
      type: groups[0].type,
      category: groups[0].category,
      prob: groups[0].prob,
      raw: groups[0].members[0] || ''
    };
    const candidates = groups.slice(1, 4).map(g => ({
      type: g.type, category: g.category, prob: g.prob, raw: g.members[0] || ''
    }));
    return { primary, candidates };
  }

  // 兜底：没有任何类目命中时，沿用关键字表
  const hits = [];
  for (const p of predictions) {
    const lower = (p.className || '').toLowerCase();
    for (const [kw, type, category] of IMAGENET_MAP) {
      if (lower.includes(kw)) {
        hits.push({ type, category, prob: p.probability, raw: p.className.split(',')[0] });
        break;
      }
    }
    if (hits.length >= 3) break;
  }
  if (hits.length === 0) {
    const top = predictions[0];
    return {
      primary: { type: top.className.split(',')[0], category: '其他物品', prob: top.probability, raw: top.className.split(',')[0] },
      candidates: []
    };
  }
  return { primary: hits[0], candidates: hits.slice(1) };
}

module.exports = {
  IMAGENET_MAP,
  ITEM_GROUPS,
  mainLabel,
  matchItemGroup,
  aggregateByGroup,
  mapPredictions
};
