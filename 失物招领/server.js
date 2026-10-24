// ==================== 寻物智联后端服务 ====================
const express = require('express');
const path = require('path');
const os = require('os');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db, mapUser, mapItem, mapFeedback, publicItem } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'xunwu-dev-secret-please-change-in-production';
const TOKEN_EXPIRES = '7d';

// base64 头像/图片可能较大，放宽请求体限制
app.use(express.json({ limit: '12mb' }));

// 页面（.html 及无扩展名路由）禁止缓存，确保前端改动后浏览器总是拿到最新页面
app.use((req, res, next) => {
  const ext = path.extname(req.path);
  if (ext === '' || ext === '.html') {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ---------------- JWT 鉴权中间件 ----------------
function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ success: false, message: '请先登录' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.id);
    if (!row) {
      return res.status(401).json({ success: false, message: '用户不存在，请重新登录' });
    }
    req.user = mapUser(row);
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: '登录已失效，请重新登录' });
  }
}

function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: TOKEN_EXPIRES });
}

// 可选鉴权：有合法令牌则填充 req.user，否则匿名继续（用于详情页区分发布者本人）
function tryAuth(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const row = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.id);
      if (row) req.user = mapUser(row);
    } catch (err) { /* 匿名访问 */ }
  }
  next();
}

// 管理员鉴权：在已登录基础上校验角色
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: '需要管理员权限' });
  }
  next();
}

// ==================== 认证相关 API ====================

// 注册
app.post('/api/auth/register', (req, res) => {
  const { username, password, phone } = req.body || {};

  if (!username || !password || !phone) {
    return res.status(400).json({ success: false, message: '请填写完整的注册信息' });
  }
  if (username.length < 3 || username.length > 20) {
    return res.status(400).json({ success: false, message: '用户名长度需在3-20位之间' });
  }
  if (!/^1[3-9]\d{9}$/.test(phone)) {
    return res.status(400).json({ success: false, message: '请输入正确的手机号' });
  }
  if (password.length < 6) {
    return res.status(400).json({ success: false, message: '密码至少6位字符' });
  }

  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
    return res.status(409).json({ success: false, message: '用户名已被注册' });
  }
  if (db.prepare('SELECT id FROM users WHERE phone = ?').get(phone)) {
    return res.status(409).json({ success: false, message: '手机号已被注册' });
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  const createdAt = Date.now();
  const info = db.prepare(
    'INSERT INTO users (username, password_hash, phone, avatar, signature, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(username, passwordHash, phone, '', '', createdAt);

  const user = mapUser(db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid));
  return res.json({ success: true, message: '注册成功', user });
});

// 登录（支持用户名或手机号）
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ success: false, message: '请输入用户名和密码' });
  }

  const row = db.prepare('SELECT * FROM users WHERE username = ? OR phone = ?').get(username, username);
  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    return res.status(401).json({ success: false, message: '用户名或密码错误' });
  }

  const user = mapUser(row);
  const token = signToken(user);
  return res.json({ success: true, token, user });
});

// 获取当前登录用户信息
app.get('/api/auth/me', authRequired, (req, res) => {
  return res.json({ success: true, user: req.user });
});

// 更新个人资料（头像、个性签名）
app.put('/api/auth/profile', authRequired, (req, res) => {
  const { avatar, signature } = req.body || {};
  const current = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

  if (avatar !== undefined) current.avatar = avatar;
  if (signature !== undefined) current.signature = signature;

  db.prepare('UPDATE users SET avatar = ?, signature = ? WHERE id = ?')
    .run(current.avatar || '', current.signature || '', req.user.id);

  const updated = mapUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id));
  return res.json({ success: true, user: updated });
});

// 退出登录（无状态 JWT，客户端丢弃令牌即可）
app.post('/api/auth/logout', (_req, res) => {
  return res.json({ success: true });
});

// ==================== 物品相关 API ====================

// 统计信息（注意：/stats 必须在 /:id 之前注册）
// total=累计发布（全部启事）；active=在架总数；found=在架招领数
// recovered=已找回（寻物）；claimed=已认领（招领）
// rate=找回率 = 已找回的寻物启事 / 全部寻物启事
app.get('/api/items/stats', (_req, res) => {
  const count = (sql) => db.prepare(sql).get().c;
  const total = count("SELECT COUNT(*) AS c FROM items");
  const active = count("SELECT COUNT(*) AS c FROM items WHERE status = 'active'");
  const found = count("SELECT COUNT(*) AS c FROM items WHERE type = 'found' AND status = 'active'");
  const lostAll = count("SELECT COUNT(*) AS c FROM items WHERE type = 'lost'");
  const recovered = count("SELECT COUNT(*) AS c FROM items WHERE type = 'lost' AND status = 'resolved'");
  const claimed = count("SELECT COUNT(*) AS c FROM items WHERE type = 'found' AND status = 'resolved'");
  const rate = lostAll > 0 ? Math.round((recovered / lostAll) * 100) : 0;
  return res.json({ success: true, stats: { total, active, found, recovered, claimed, rate } });
});

// 物品列表，支持 ?type=lost|found 与 ?publisher=用户名（公开列表只返回在架 active）
app.get('/api/items', (req, res) => {
  const { type, publisher } = req.query;
  let sql = "SELECT * FROM items WHERE status = 'active'";
  const params = [];
  if (type === 'lost' || type === 'found') {
    sql += ' AND type = ?';
    params.push(type);
  }
  if (publisher) {
    sql += ' AND publisher = ?';
    params.push(publisher);
  }
  sql += ' ORDER BY id DESC';
  const rows = db.prepare(sql).all(...params);
  return res.json({ success: true, items: rows.map((r) => publicItem(mapItem(r))) });
});

// 我发布的全部启事（含已撤销，需登录；供个人中心管理/撤销/恢复）
app.get('/api/items/mine', authRequired, (req, res) => {
  const rows = db.prepare('SELECT * FROM items WHERE publisher = ? ORDER BY id DESC')
    .all(req.user.username);
  return res.json({ success: true, items: rows.map(mapItem) });
});

// 智能匹配（寻物启事与失物招领互配，保持与原前端相同的评分规则）
app.post('/api/items/match', (req, res) => {
  const { type, color, category } = req.body || {};
  const rows = db.prepare("SELECT * FROM items WHERE status = 'active'").all();
  const items = rows
    .map((row) => {
      const item = mapItem(row);
      let score = 0;
      if (item.color === color) score += 40;
      if (item.category === category) score += 35;
      if (item.type !== type) score += 25;
      return { ...publicItem(item), similarity: score };
    })
    .filter((item) => item.similarity > 30)
    .sort((a, b) => b.similarity - a.similarity);
  return res.json({ success: true, items });
});

// 校园热力图数据：返回在架且带坐标的启事（旧数据无坐标时按地点文字推断）
const GEOCODE = [
  [/图书馆/, [420, 100]],
  [/教学楼\s*A/, [680, 90]],
  [/教学楼\s*B/, [870, 90]],
  [/教学楼/, [680, 90]],
  [/艺术楼/, [645, 265]],
  [/食堂/, [385, 265]],
  [/超市/, [155, 265]],
  [/宿舍|公寓/, [400, 470]],
  [/操场/, [875, 460]],
  [/体育馆/, [660, 455]],
  [/保卫处/, [150, 465]],
  [/校门/, [360, 615]],
  [/校车|站牌/, [150, 600]],
  [/医院/, [860, 255]],
  [/行政楼/, [160, 90]],
  [/花园|湖畔|湖/, [660, 615]]
];

function geocode(locationText) {
  if (!locationText) return null;
  for (const [re, pt] of GEOCODE) {
    if (re.test(locationText)) return pt;
  }
  return null;
}

app.get('/api/items/heatmap', (_req, res) => {
  const rows = db.prepare("SELECT * FROM items WHERE status = 'active'").all();
  const items = rows
    .map((row) => {
      const item = mapItem(row);
      if (item.mapX == null || item.mapY == null) {
        const pt = geocode(row.location);
        if (pt) {
          item.mapX = pt[0];
          item.mapY = pt[1];
        }
      }
      return item;
    })
    .filter((item) => item.mapX != null && item.mapY != null);
  return res.json({ success: true, items: items.map(publicItem) });
});

// 物品详情（发布者本人/管理员可见完整联系方式与答案，其余访客看到打码版）
app.get('/api/items/:id', tryAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!row) {
    return res.status(404).json({ success: false, message: '物品不存在' });
  }
  const item = mapItem(row);
  const isOwner = req.user && req.user.username === item.publisher;
  const isAdmin = req.user && req.user.role === 'admin';
  if (isOwner || isAdmin) {
    return res.json({ success: true, item });
  }
  return res.json({ success: true, item: publicItem(item) });
});

// 防冒领问答验证：全部答对才返回完整联系方式
app.post('/api/items/:id/verify', tryAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!row) {
    return res.status(404).json({ success: false, message: '物品不存在' });
  }
  const item = mapItem(row);
  const quiz = item.quiz || [];
  if (!quiz.length) {
    return res.json({ success: true, correct: true, contact: item.contact });
  }
  const answers = Array.isArray((req.body || {}).answers) ? req.body.answers : [];
  const correct = quiz.length === answers.length &&
    quiz.every((q, i) => Number(answers[i]) === q.answer);
  if (!correct) {
    return res.json({ success: true, correct: false, message: '答案不完全正确，请再仔细想想' });
  }
  return res.json({ success: true, correct: true, contact: item.contact });
});

// 发布物品（需登录，发布者以令牌为准）
app.post('/api/items', authRequired, (req, res) => {
  const {
    type, title, category, color, location, date,
    image, description, contact, reward, features, mapX, mapY, quiz
  } = req.body || {};

  if (type !== 'lost' && type !== 'found') {
    return res.status(400).json({ success: false, message: '发布类型无效' });
  }
  if (!title || !category || !location || !date || !description || !contact) {
    return res.status(400).json({ success: false, message: '请填写所有必填项' });
  }

  // 防冒领问答校验（选填）：每题需有题干、2-4 个选项及正确选项，最多 5 题
  let cleanQuiz = [];
  if (Array.isArray(quiz) && quiz.length > 0) {
    if (quiz.length > 5) {
      return res.status(400).json({ success: false, message: '防冒领问题最多 5 题' });
    }
    for (const q of quiz) {
      const text = String(q.q || '').trim();
      const options = (Array.isArray(q.options) ? q.options : []).map((o) => String(o).trim()).filter(Boolean);
      const answer = Number(q.answer);
      if (!text || options.length < 2 || options.length > 4 || !Number.isInteger(answer) || answer < 0 || answer >= options.length) {
        return res.status(400).json({ success: false, message: '防冒领问题格式不正确：每题需题干、2-4 个选项并选定正确答案' });
      }
      cleanQuiz.push({ q: text, options, answer });
    }
  }

  const toCoord = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const createdAt = Date.now();
  const info = db.prepare(
    `INSERT INTO items (type, title, category, color, location, date, image, description, contact, reward, features, publisher, map_x, map_y, quiz, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    type, title, category, color || '未知', location, date,
    image || '', description, contact, reward || '',
    JSON.stringify(Array.isArray(features) ? features : []),
    req.user.username, toCoord(mapX), toCoord(mapY),
    JSON.stringify(cleanQuiz), createdAt
  );

  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(info.lastInsertRowid);
  return res.status(201).json({ success: true, item: mapItem(row) });
});

// 更新启事状态（PATCH /api/items/:id/status）
// active=在架 / removed=已撤销 / resolved=已找回（寻物）或已认领（招领）
// 权限：发布者本人可操作自己的；管理员可操作任意启事
app.patch('/api/items/:id/status', authRequired, (req, res) => {
  const target = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!target) {
    return res.status(404).json({ success: false, message: '启事不存在' });
  }
  const next = (req.body || {}).status;
  if (next !== 'active' && next !== 'removed' && next !== 'resolved') {
    return res.status(400).json({ success: false, message: '状态值无效' });
  }
  const isOwner = target.publisher === req.user.username;
  const isAdmin = req.user.role === 'admin';
  if (!isOwner && !isAdmin) {
    return res.status(403).json({ success: false, message: '只能操作自己发布的启事' });
  }
  db.prepare('UPDATE items SET status = ? WHERE id = ?').run(next, target.id);
  const updated = db.prepare('SELECT * FROM items WHERE id = ?').get(target.id);
  let message = '启事已恢复上架';
  if (next === 'removed') message = '启事已撤销';
  if (next === 'resolved') message = updated.type === 'lost' ? '已标记为已找回' : '已标记为已认领';
  return res.json({ success: true, message, item: mapItem(updated) });
});

// ==================== 意见反馈 API ====================

// 提交反馈（需登录）
app.post('/api/feedback', authRequired, (req, res) => {
  const { category, content, contact } = req.body || {};
  const text = (content || '').trim();
  if (!text) {
    return res.status(400).json({ success: false, message: '请填写反馈内容' });
  }
  if (text.length > 1000) {
    return res.status(400).json({ success: false, message: '反馈内容不超过 1000 字' });
  }
  const allowedCats = ['功能建议', '问题反馈', '物品相关', '其他'];
  const cat = allowedCats.includes(category) ? category : '其他';
  const info = db.prepare(
    `INSERT INTO feedback (user_id, username, category, content, contact, status, reply, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', '', ?)`
  ).run(req.user.id, req.user.username, cat, text, (contact || '').trim(), Date.now());

  const row = db.prepare('SELECT * FROM feedback WHERE id = ?').get(info.lastInsertRowid);
  return res.status(201).json({ success: true, message: '反馈已提交，感谢你的意见！', feedback: mapFeedback(row) });
});

// 查看我提交的反馈
app.get('/api/feedback/mine', authRequired, (req, res) => {
  const rows = db.prepare('SELECT * FROM feedback WHERE user_id = ? ORDER BY id DESC').all(req.user.id);
  return res.json({ success: true, feedback: rows.map(mapFeedback) });
});

// ==================== 管理员后台 API ====================

// 后台总览统计（失物/招领按在架 active 计，并附带已撤销数）
app.get('/api/admin/stats', authRequired, requireAdmin, (_req, res) => {
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const adminCount = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get().c;
  const countBy = (type, status) =>
    db.prepare("SELECT COUNT(*) AS c FROM items WHERE type = ? AND status = ?").get(type, status).c;
  const lostCount = countBy('lost', 'active');
  const foundCount = countBy('found', 'active');
  const lostRemoved = countBy('lost', 'removed');
  const foundRemoved = countBy('found', 'removed');
  const lostResolved = countBy('lost', 'resolved');
  const foundResolved = countBy('found', 'resolved');
  return res.json({
    success: true,
    stats: {
      userCount,
      adminCount,
      itemCount: lostCount + foundCount + lostRemoved + foundRemoved + lostResolved + foundResolved,
      lostCount,
      foundCount,
      lostRemoved,
      foundRemoved,
      lostResolved,
      foundResolved
    }
  });
});

// 用户列表（含注册时间与角色）
app.get('/api/admin/users', authRequired, requireAdmin, (_req, res) => {
  const rows = db.prepare('SELECT id, username, phone, avatar, signature, role, created_at FROM users ORDER BY id ASC').all();
  return res.json({ success: true, users: rows.map(mapUser) });
});

// 物品列表（管理用）
app.get('/api/admin/items', authRequired, requireAdmin, (_req, res) => {
  const rows = db.prepare('SELECT * FROM items ORDER BY id DESC').all();
  return res.json({ success: true, items: rows.map(mapItem) });
});

// 意见反馈汇总（含分类/状态统计）
app.get('/api/admin/feedback', authRequired, requireAdmin, (_req, res) => {
  const rows = db.prepare('SELECT * FROM feedback ORDER BY id DESC').all();
  const list = rows.map(mapFeedback);
  const byCategory = {};
  list.forEach((f) => { byCategory[f.category] = (byCategory[f.category] || 0) + 1; });
  const summary = {
    total: list.length,
    pending: list.filter((f) => f.status === 'pending').length,
    resolved: list.filter((f) => f.status === 'resolved').length,
    byCategory
  };
  return res.json({ success: true, feedback: list, summary });
});

// 处理反馈：标记待处理/已处理，可附回复
app.patch('/api/admin/feedback/:id', authRequired, requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM feedback WHERE id = ?').get(req.params.id);
  if (!target) {
    return res.status(404).json({ success: false, message: '反馈不存在' });
  }
  const next = (req.body || {}).status;
  if (next !== 'pending' && next !== 'resolved') {
    return res.status(400).json({ success: false, message: '状态值无效' });
  }
  const reply = req.body.reply !== undefined ? String(req.body.reply) : target.reply;
  db.prepare('UPDATE feedback SET status = ?, reply = ? WHERE id = ?').run(next, reply, target.id);
  const row = db.prepare('SELECT * FROM feedback WHERE id = ?').get(target.id);
  return res.json({ success: true, message: next === 'resolved' ? '已标记为已处理' : '已标记为待处理', feedback: mapFeedback(row) });
});

// 添加管理员：把指定用户名提升为管理员
app.post('/api/admin/users/promote', authRequired, requireAdmin, (req, res) => {
  const username = ((req.body || {}).username || '').trim();
  if (!username) {
    return res.status(400).json({ success: false, message: '请输入用户名' });
  }
  const target = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!target) {
    return res.status(404).json({ success: false, message: '该用户不存在' });
  }
  if (target.role === 'admin') {
    return res.json({ success: true, message: '该用户已经是管理员' });
  }
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(target.id);
  return res.json({ success: true, message: '已将 ' + username + ' 提升为管理员' });
});

// 管理员后台页面
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// 多页面路由（登录、失物、招领、识别、发布、个人中心）
['login', 'lost', 'found', 'recognize', 'publish', 'profile', 'feedback', 'heatmap'].forEach((page) => {
  app.get('/' + page, (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', page + '.html'));
  });
});

// ---------------- 其他路由回退到首页 ----------------
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------- 启动 ----------------
app.listen(PORT, () => {
  const nets = os.networkInterfaces();
  const ips = [];
  Object.values(nets).forEach((list) => {
    list.forEach((ni) => {
      if (ni.family === 'IPv4' && !ni.internal) ips.push(ni.address);
    });
  });
  console.log('==================================================');
  console.log('  寻物智联服务已启动');
  console.log('  本机访问:   http://localhost:' + PORT);
  ips.forEach((ip) => console.log('  局域网访问: http://' + ip + ':' + PORT));
  console.log('  数据库文件: ' + path.join(__dirname, 'data', 'xunwu.db'));
  console.log('  测试账号:   demo / 123456');
  console.log('==================================================');
});
