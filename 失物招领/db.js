// ==================== 数据库连接与初始化 ====================
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const { dbPath, seedDevUser } = require('./config');
fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// ---------------- 建表 ----------------
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  phone         TEXT UNIQUE NOT NULL,
  avatar        TEXT DEFAULT '',
  signature     TEXT DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'user',
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL CHECK(type IN ('lost', 'found')),
  title       TEXT NOT NULL,
  category    TEXT NOT NULL,
  color       TEXT DEFAULT '未知',
  location    TEXT NOT NULL,
  date        TEXT NOT NULL,
  image       TEXT DEFAULT '',
  description TEXT NOT NULL,
  contact     TEXT NOT NULL,
  reward      TEXT DEFAULT '',
  features    TEXT DEFAULT '[]',
  publisher   TEXT DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS feedback (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER,
  username    TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT '其他',
  content     TEXT NOT NULL,
  contact     TEXT DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'pending',
  reply       TEXT DEFAULT '',
  created_at  INTEGER NOT NULL
);
`);

// 在写锁内检查列，兼容旧库和并发启动。
db.transaction(() => {
  const userColumns = db.pragma('table_info(users)').map((column) => column.name);
  if (!userColumns.includes('role')) {
    db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
  }
  const itemColumns = db.pragma('table_info(items)').map((column) => column.name);
  const columns = {
    status: "TEXT NOT NULL DEFAULT 'active'", quiz: "TEXT DEFAULT ''",
    map_x: 'REAL', map_y: 'REAL', lng: 'REAL', lat: 'REAL'
  };
  for (const [column, type] of Object.entries(columns)) {
    if (!itemColumns.includes(column)) db.exec('ALTER TABLE items ADD COLUMN ' + column + ' ' + type);
  }
}).immediate();

// ---------------- 字段映射（不暴露密码哈希） ----------------
function mapUser(row) {
  return {
    id: row.id,
    username: row.username,
    phone: row.phone,
    avatar: row.avatar || '',
    signature: row.signature || '',
    role: row.role || 'user',
    createdAt: row.created_at
  };
}

function mapItem(row) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    category: row.category,
    color: row.color,
    location: row.location,
    date: row.date,
    image: row.image,
    description: row.description,
    contact: row.contact,
    reward: row.reward,
    features: JSON.parse(row.features || '[]'),
    quiz: JSON.parse(row.quiz || '[]'),
    publisher: row.publisher,
    status: row.status || 'active',
    mapX: row.map_x == null ? null : Number(row.map_x),
    mapY: row.map_y == null ? null : Number(row.map_y),
    lng: row.lng == null ? null : Number(row.lng),
    lat: row.lat == null ? null : Number(row.lat)
  };
}

// ---------------- 反馈字段映射 ----------------
function mapFeedback(row) {
  return {
    id: row.id,
    userId: row.user_id,
    username: row.username,
    category: row.category,
    content: row.content,
    contact: row.contact || '',
    status: row.status || 'pending',
    reply: row.reply || '',
    createdAt: row.created_at
  };
}

// ---------------- 防冒领问答：联系方式打码与公开视图 ----------------
function maskContact(contact) {
  if (!contact) return '';
  const chars = Array.from(String(contact));
  if (chars.length < 5) return '****';
  return chars.slice(0, 2).join('') + '****' + chars.at(-1);
}

// 公开版问答：只返回题干与选项，不暴露正确选项下标
function publicQuiz(quiz) {
  return (quiz || []).map((q) => ({ q: q.q, options: q.options }));
}

// 公开视图：设置了防冒领问答的启事，联系方式打码、答案剥离；hasQuiz 标记前端需答题
function publicItem(item) {
  const quiz = item.quiz || [];
  return {
    ...item,
    // 对外仅提供约百米级经纬度。
    lng: item.lng == null ? null : Number(item.lng.toFixed(3)),
    lat: item.lat == null ? null : Number(item.lat.toFixed(3)),
    contact: maskContact(item.contact),
    contactMasked: Boolean(item.contact),
    hasQuiz: Boolean(quiz.length),
    quiz: publicQuiz(quiz)
  };
}

// ---------------- 种子数据（仅首次运行时写入） ----------------
function seed() {
  const { randomBytes } = require('node:crypto');
  const addUser = db.prepare(
    'INSERT INTO users (username, password_hash, phone, role, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  for (const [username, role] of [['demo', 'user'], ['admin', 'admin']]) {
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) continue;
    const password = randomBytes(18).toString('base64url');
    addUser.run(username, bcrypt.hashSync(password, 10), 'TEST-' + username, role, Date.now());
    console.log('[仅本地开发] ' + username + ' 临时密码：' + password);
  }

  const itemCount = db.prepare('SELECT COUNT(*) AS c FROM items').get().c;
  if (itemCount === 0) {
    const now = Date.now();
    const seedItems = [
      { type: 'lost', title: '黑色皮质钱包', category: '箱包类', color: '黑色', location: '三食堂二楼', date: '2025-01-15', image: '/images/item-1.jpg', description: '黑色皮质钱包，内有身份证、银行卡和少量现金，钱包边角有轻微磨损。', contact: '演示联系 TEST-0000', reward: '必有重谢', features: ['皮质', '对折', '黑色'], publisher: 'demo' },
      { type: 'lost', title: 'AirPods Pro 耳机', category: '电子数码', color: '白色', location: '图书馆三楼', date: '2025-01-14', image: '/images/item-2.jpg', description: '白色AirPods Pro，充电盒背面有刻字，左耳续航时间较短。', contact: '演示联系 TEST-0000', reward: '500元酬谢', features: ['白色', '耳机', '苹果'], publisher: 'demo' },
      { type: 'lost', title: '银色钥匙串', category: '钥匙', color: '银色', location: '操场看台下', date: '2025-01-14', image: '/images/item-3.jpg', description: '一串钥匙共5把，有一个小熊挂件，其中一把是宿舍钥匙。', contact: '演示联系 TEST-0000', reward: '', features: ['银色', '钥匙', '挂件'], publisher: '' },
      { type: 'lost', title: '蓝色保温杯', category: '其他物品', color: '蓝色', location: '教学楼A座302', date: '2025-01-13', image: '/images/item-4.jpg', description: '膳魔师蓝色保温杯，杯身有贴纸，底部有轻微凹陷。', contact: '演示联系 TEST-0000', reward: '', features: ['蓝色', '杯子', '不锈钢'], publisher: '' },
      { type: 'lost', title: '黑色边框眼镜', category: '衣物配饰', color: '黑色', location: '自习室B区', date: '2025-01-12', image: '/images/item-5.jpg', description: '黑框近视眼镜，镜腿有轻微磨损，镜片度数约300度。', contact: '演示联系 TEST-0000', reward: '200元酬谢', features: ['黑色', '眼镜', '全框'], publisher: '' },
      { type: 'lost', title: '校园卡', category: '证件文件', color: '蓝色', location: '超市内', date: '2025-01-11', image: '/images/item-6.jpg', description: '校园学生卡，卡号尾号2341，卡套是透明的。', contact: '演示联系 TEST-0000', reward: '', features: ['蓝色', '卡片', '证件'], publisher: '' },
      { type: 'found', title: '红色雨伞', category: '其他物品', color: '红色', location: '校车站牌', date: '2025-01-15', image: '/images/item-7.jpg', description: '捡到一把红色折叠伞，伞面有花纹图案，手柄是黑色的。', contact: '演示联系 TEST-0000', reward: '', features: ['红色', '雨伞', '折叠'], publisher: 'demo', quiz: [{ q: '这把伞的伞面是什么样的？', options: ['纯色无图案', '有花纹图案', '格子图案', '条纹图案'], answer: 1 }, { q: '伞的手柄是什么颜色？', options: ['红色', '木色', '黑色', '透明'], answer: 2 }] },
      { type: 'found', title: '学生卡一张', category: '证件文件', color: '蓝色', location: '超市收银台', date: '2025-01-15', image: '/images/item-8.jpg', description: '捡到一张学生校园卡，卡号尾号3456，已交至超市服务台。', contact: '演示联系 TEST-0000', reward: '', features: ['蓝色', '卡片', '证件'], publisher: '', quiz: [{ q: '这张学生卡的卡号尾号是多少？', options: ['3456', '1234', '6789', '0000'], answer: 0 }, { q: '卡是在哪个位置捡到的？', options: ['超市收银台', '图书馆', '食堂', '操场'], answer: 0 }] },
      { type: 'found', title: '黑色双肩包', category: '箱包类', color: '黑色', location: '体育馆更衣室', date: '2025-01-14', image: '/images/item-9.jpg', description: 'Nike黑色双肩包，包内有运动衣物和毛巾，无贵重物品。', contact: '演示联系 TEST-0000', reward: '', features: ['黑色', '背包', '运动'], publisher: '', quiz: [{ q: '这个双肩包的品牌标识是？', options: ['Adidas', 'Nike', '李宁', '没有明显标识'], answer: 1 }, { q: '包里装的是什么？', options: ['笔记本电脑', '运动衣物和毛巾', '课本和文具', '雨伞和水杯'], answer: 1 }] },
      { type: 'found', title: '苹果手机', category: '电子数码', color: '黑色', location: '篮球场边', date: '2025-01-13', image: '/images/item-10.jpg', description: '捡到iPhone 14手机一台，屏幕有贴膜，已交保卫处。', contact: '演示联系 TEST-0000', reward: '', features: ['黑色', '手机', '苹果'], publisher: '', quiz: [{ q: '捡到的这部手机是什么型号？', options: ['iPhone 13', 'iPhone 14', '华为 Mate 60', '小米 14'], answer: 1 }, { q: '手机是在哪里捡到的？', options: ['图书馆', '篮球场边', '食堂', '宿舍楼下'], answer: 1 }] },
      { type: 'found', title: '白色无线耳机', category: '电子数码', color: '白色', location: '食堂一楼', date: '2025-01-12', image: '/images/item-11.jpg', description: '捡到白色无线耳机一副，充电盒有划痕，放在食堂服务台。', contact: '演示联系 TEST-0000', reward: '', features: ['白色', '耳机', '无线'], publisher: '' },
      { type: 'found', title: '棕色钱包', category: '箱包类', color: '棕色', location: '教学楼走廊', date: '2025-01-11', image: '/images/item-12.jpg', description: '棕色短款钱包，内无现金，有银行卡若干，已交楼管处。', contact: '演示联系 TEST-0000', reward: '', features: ['棕色', '钱包', '短款'], publisher: '', quiz: [{ q: '钱包里有什么？', options: ['现金和身份证', '银行卡若干', '只有照片', '公交卡和零钱'], answer: 1 }, { q: '这个钱包是哪种款式？', options: ['长款', '拉链式', '短款', '对折带扣'], answer: 2 }] }
    ];
    const stmt = db.prepare(
      `INSERT INTO items (type, title, category, color, location, date, image, description, contact, reward, features, publisher, quiz, created_at)
       VALUES (@type, @title, @category, @color, @location, @date, @image, @description, @contact, @reward, @features, @publisher, @quiz, @created_at)`
    );
    const insertMany = db.transaction((rows) => {
      rows.forEach((r, i) => stmt.run({
        ...r,
        features: JSON.stringify(r.features),
        quiz: JSON.stringify(r.quiz || []),
        created_at: now - i * 1000
      }));
    });
    insertMany(seedItems);
  }
}

if (seedDevUser) db.transaction(seed).immediate();

module.exports = { db, mapUser, mapItem, mapFeedback, maskContact, publicItem, publicQuiz };
