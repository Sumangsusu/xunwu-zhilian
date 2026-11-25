// ============================================================
// 生成「示意占位图」SVG —— 用于种子数据中缺少实拍图的物品。
// 每张图明确写出物品名称/类别/颜色，并标注「示意占位图·非实拍」，
// 既保证图文一致，也不会让人误以为是真实照片。
// 用法：node scripts/gen-placeholder-images.js
// 输出：public/images/placeholder/*.svg（可重复执行，覆盖同名文件）
// ============================================================
const path = require('node:path');
const fs = require('node:fs');

const OUT_DIR = path.resolve(__dirname, '../public/images/placeholder');

// file, emoji, name, category, color, accent(主题色)
const ITEMS = [
  ['notebook-black', '📓', '黑色软皮笔记本', '书籍文具 · 黑色', '#334155'],
  ['notebook-green', '📗', '绿色软皮笔记本', '书籍文具 · 绿色', '#15803d'],
  ['cable', '🔌', '白色数据线', '电子数码 · 白色', '#64748b'],
  ['glasses-case', '👓', '黑色眼镜盒', '衣物配饰 · 黑色', '#475569'],
  ['usb-drive', '💾', '银色U盘', '电子数码 · 银色', '#94a3b8'],
  ['scarf-red', '🧣', '红色针织围巾', '衣物配饰 · 红色', '#dc2626'],
  ['scarf-gray', '🧣', '灰色羊毛围巾', '衣物配饰 · 灰色', '#6b7280'],
  ['calculator', '🧮', '科学计算器', '书籍文具 · 白色', '#0ea5e9'],
  ['water-bottle', '🥤', '蓝色运动水杯', '其他物品 · 蓝色', '#2563eb'],
  ['tablet', '📱', 'iPad 平板电脑', '电子数码 · 灰色', '#475569'],
  ['sweater', '🧥', '蓝色针织毛衣', '衣物配饰 · 蓝色', '#1d4ed8'],
  ['dictionary', '📖', '牛津英语词典', '书籍文具 · 绿色', '#166534'],
  ['keyboard', '⌨️', '黑色机械键盘', '电子数码 · 黑色', '#1e293b'],
  ['speaker', '🔊', '便携蓝牙音箱', '电子数码 · 红色', '#e11d48'],
  ['ring', '💍', '银色尾戒', '衣物配饰 · 银色', '#94a3b8'],
  ['bank-card', '💳', '银行卡', '证件文件 · 绿色', '#059669'],
  ['cap', '🧢', '藏青色棒球帽', '衣物配饰 · 蓝色', '#1e3a8a'],
  ['bus-card', '🎫', '公交卡', '证件文件 · 黄色', '#d97706'],
  ['id-card', '🪪', '居民身份证', '证件文件 · 白色', '#0369a1'],
  ['band', '⌚', '黑色运动手环', '电子数码 · 黑色', '#0f172a'],
  ['earrings', '💎', '珍珠耳环一对', '衣物配饰 · 白色', '#a16207'],
  ['pen', '🖊️', '黑色签字笔', '书籍文具 · 黑色', '#1e293b'],
  ['watch', '⌚', '银色石英手表', '衣物配饰 · 银色', '#64748b'],
  ['necklace', '📿', '金色细项链', '衣物配饰 · 金色', '#ca8a04'],
  // —— 颜色/款式变体（保证与启事描述的种类+颜色都一致）——
  ['umbrella-blue', '☂️', '蓝色折叠雨伞', '其他物品 · 蓝色', '#2563eb'],
  ['umbrella-black', '☂️', '黑色三折雨伞', '其他物品 · 黑色', '#1e293b'],
  ['umbrella-green', '☂️', '绿色折叠伞', '其他物品 · 绿色', '#15803d'],
  ['earphone-wired', '🎧', '白色有线耳机', '电子数码 · 白色', '#94a3b8'],
  ['student-id-red', '🪪', '红色学生证', '证件文件 · 红色', '#b91c1c'],
  ['backpack-brown', '🎒', '棕色双肩包', '箱包类 · 棕色', '#92400e'],
  ['key-gold', '🔑', '金色宿舍门钥匙', '钥匙 · 金色', '#ca8a04'],
  ['thermos-green', '🧴', '绿色保温杯', '其他物品 · 绿色', '#15803d'],
  ['laptop-bag', '💼', '联想笔记本电脑包', '箱包类 · 黑色', '#1e293b'],
];

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function svg([file, emoji, name, meta, accent]) {
  // 1200×600（2:1）：比卡片 h-48 与详情 h-64 更扁，object-cover 下文字不易被裁。
  // 关键信息（图标+名称+类别）集中在垂直 150~450 的安全区内。
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600" viewBox="0 0 1200 600" role="img" aria-label="${esc(name)}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f8fafc"/>
      <stop offset="1" stop-color="#e2e8f0"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="600" fill="url(#bg)"/>
  <rect width="1200" height="12" fill="${accent}"/>
  <circle cx="600" cy="245" r="100" fill="#ffffff" opacity="0.85"/>
  <circle cx="600" cy="245" r="100" fill="none" stroke="${accent}" stroke-opacity="0.25" stroke-width="3"/>
  <text x="600" y="285" text-anchor="middle" font-size="112" font-family="Segoe UI Emoji, Apple Color Emoji, Noto Color Emoji, sans-serif">${esc(emoji)}</text>
  <text x="600" y="415" text-anchor="middle" font-size="50" font-weight="700" fill="#1e293b" font-family="Microsoft YaHei, PingFang SC, sans-serif">${esc(name)}</text>
  <text x="600" y="462" text-anchor="middle" font-size="28" fill="#64748b" font-family="Microsoft YaHei, PingFang SC, sans-serif">${esc(meta)}</text>
  <text x="600" y="520" text-anchor="middle" font-size="20" fill="#94a3b8" font-family="Microsoft YaHei, PingFang SC, sans-serif">示意占位图 · 物品以文字描述为准</text>
</svg>
`;
}

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
ITEMS.forEach((item) => {
  fs.writeFileSync(path.join(OUT_DIR, item[0] + '.svg'), svg(item), 'utf8');
});
console.log(`占位图生成完成：${ITEMS.length} 张 → ${OUT_DIR}`);
