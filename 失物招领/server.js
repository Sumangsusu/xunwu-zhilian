// ==================== 寻物智联后端服务 ====================
const express = require('express');
const path = require('path');
const os = require('os');
const bcrypt = require('bcryptjs');
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const config = require('./config');
const session = require('./session');
const { db, mapUser, mapItem, mapFeedback, publicItem } = require('./db');

// ---------------- 图片存储：db(base64 入库) / file(随机文件名落盘) ----------------
const uploadDir = config.uploadDir;
try { fs.mkdirSync(uploadDir, { recursive: true }); } catch (e) {}
const ALLOWED_IMG = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
// 把前端传来的图片（base64 dataURL 或已存在的路径引用）转成可存储形式。
// db 模式：原样存 base64；file 模式：落盘到 public/uploads，返回 /uploads/xxx 相对路径（由 express.static 提供）。
function resolveImageField(image) {
  if (config.imageStore !== 'file' || typeof image !== 'string') return image || '';
  const m = image.match(/^data:([\w/+.-]+);base64,(.+)$/);
  if (!m) return image || ''; // 已经是路径引用（如种子数据 /images/...），原样保留
  const ext = ALLOWED_IMG[m[1]];
  if (!ext) return ''; // 不支持的 MIME，不存储图片
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > config.maxImageBytes) return ''; // 超出大小限制
  const name = crypto.randomBytes(16).toString('hex') + '.' + ext; // 随机名，杜绝路径穿越
  fs.writeFileSync(path.join(uploadDir, name), buf);
  return '/uploads/' + name;
}

const app = express();
const PORT = config.port;

app.use(express.json({ limit: '12mb' }));

// 页面（.html 及无扩展名路由）禁止缓存，确保前端改动后浏览器总是拿到最新页面
app.use((req, res, next) => {
  const ext = path.extname(req.path);
  if (ext === '' || ext === '.html') {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
  next();
});

// ---------------- 整站门禁（CAS 启用时，未登录强制跳转统一认证） ----------------
// 放在静态资源之前：页面请求在 express.static 命中前就被拦截/放行，静态资源本身始终放行。
app.use((req, res, next) => {
  if (!config.casEnabled) return next();
  const p = req.path;

  // 1) 公开 API：认证流程本身、健康检查、前端配置
  const publicApi = ['/health', '/api/auth/config', '/api/auth/cas/login', '/api/auth/cas/callback'];
  if (publicApi.some(prefix => p === prefix || p.startsWith(prefix + '/'))) return next();

  // 2) 公开页面：登录/报错页允许未登录访问，避免 CAS 失败回跳时死循环
  if (p === '/login.html') return next();

  // 3) 静态资源（带扩展名且非 .html）：CSS/JS/图片/字体等一律放行，保证页面可加载
  const ext = path.extname(p);
  if (ext && ext !== '.html') return next();

  // 4) 已登录则放行
  const s = session.getSession(req);
  if (s) return next();

  // 5) 未登录：API 返回 401（带 CAS 登录地址）；页面 302 跳转统一认证
  if (p.startsWith('/api/')) {
    return res.status(401).json({ success: false, message: '请先登录', casLoginUrl: '/api/auth/cas/login' });
  }
  return res.redirect('/api/auth/cas/login' + (p && p !== '/' ? '?next=' + encodeURIComponent(p) : ''));
});

app.use(express.static(path.join(__dirname, 'public')));

// ---------------- 健康检查（上线接入网关/存活探针用） ----------------
app.get('/health', (_req, res) => res.json({ status: 'ok', casEnabled: config.casEnabled }));

// ==================== 认证相关 API ====================

// 前端获取登录方式（CAS 是否启用）
app.get('/api/auth/config', (_req, res) =>
  res.json({ success: true, casEnabled: config.casEnabled, casLoginUrl: '/api/auth/cas/login' })
);

// CAS 回调地址：未配置 BASE_URL 时回退到当前请求的 host，保证 localhost 也能正确跳转
function serviceUrl(req) {
  const base = config.baseUrl || (req ? (req.protocol + '://' + req.get('host')) : '');
  return base + '/api/auth/cas/callback';
}

// CAS 登录入口：重定向到学校统一身份认证
app.get('/api/auth/cas/login', (req, res) => {
  if (!config.casEnabled) return res.status(400).json({ success: false, message: '当前未启用统一身份认证' });
  const next = req.query.next ? '?next=' + encodeURIComponent(String(req.query.next)) : '';
  const service = serviceUrl(req) + next;
  res.redirect(config.casBaseUrl + '/login?service=' + encodeURIComponent(service));
});

// CAS 回调：校验票据 → 按学工号建号/登录 → 写入会话 Cookie → 跳回来源页
app.get('/api/auth/cas/callback', async (req, res) => {
  const ticket = req.query.ticket;
  if (!ticket) return res.redirect('/login.html?error=cas');
  const service = serviceUrl(req) + (req.query.next ? '?next=' + encodeURIComponent(String(req.query.next)) : '');
  try {
    const xml = await casValidate(service, ticket);
    const uid = parseCasUser(xml);
    if (!uid) return res.redirect('/login.html?error=cas');
    let row = db.prepare('SELECT * FROM users WHERE student_id = ?').get(uid);
    if (!row) {
      const info = db.prepare(
        "INSERT INTO users (username, password_hash, phone, avatar, signature, role, created_at, student_id) VALUES (?,?,?,?,?,?,?,?)"
      ).run('whu_' + uid, '', null, '', '', config.adminStudentIds.includes(uid) ? 'admin' : 'user', Date.now(), uid);
      row = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    } else if (config.adminStudentIds.includes(uid) && row.role !== 'admin') {
      db.prepare("UPDATE users SET role='admin' WHERE id=?").run(row.id);
      row = db.prepare('SELECT * FROM users WHERE id = ?').get(row.id);
    }
    session.setSession(res, mapUser(row));
    res.redirect(req.query.next ? String(req.query.next) : '/');
  } catch (e) {
    res.redirect('/login.html?error=cas');
  }
});

function casValidate(service, ticket) {
  return new Promise((resolve, reject) => {
    const url = config.casBaseUrl + '/serviceValidate?service=' + encodeURIComponent(service) + '&ticket=' + encodeURIComponent(ticket);
    https.get(url, (r) => {
      let data = '';
      r.on('data', (c) => (data += c));
      r.on('end', () => resolve(data));
    }).on('error', reject);
  });
}
function parseCasUser(xml) {
  const m = xml.match(/<cas:user>(.*?)<\/cas:user>/);
  return m ? m[1].trim() : null;
}

// 本地密码登录（仅开发期 / CAS 未启用）
app.post('/api/auth/login', (req, res) => {
  if (config.casEnabled) return res.status(400).json({ success: false, message: '本校系统统一使用智慧珞珈登录' });
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ success: false, message: '请输入用户名和密码' });
  const row = db.prepare('SELECT * FROM users WHERE username = ? OR phone = ?').get(username, username);
  if (!row || !row.password_hash || !bcrypt.compareSync(password, row.password_hash)) {
    return res.status(401).json({ success: false, message: '用户名或密码错误' });
  }
  const user = mapUser(row);
  session.setSession(res, user);
  return res.json({ success: true, user });
});

// 注册（仅开发期 / CAS 未启用）
app.post('/api/auth/register', (req, res) => {
  if (config.casEnabled) return res.status(400).json({ success: false, message: '本校系统统一使用智慧珞珈登录，无需注册' });
  const { username, password, phone } = req.body || {};
  if (!username || !password || !phone) return res.status(400).json({ success: false, message: '请填写完整的注册信息' });
  if (username.length < 3 || username.length > 20) return res.status(400).json({ success: false, message: '用户名长度需在3-20位之间' });
  if (!/^1[3-9]\d{9}$/.test(phone)) return res.status(400).json({ success: false, message: '请输入正确的手机号' });
  if (password.length < 6) return res.status(400).json({ success: false, message: '密码至少6位字符' });
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) return res.status(409).json({ success: false, message: '用户名已被注册' });
  if (db.prepare('SELECT id FROM users WHERE phone = ?').get(phone)) return res.status(409).json({ success: false, message: '手机号已被注册' });
  const passwordHash = bcrypt.hashSync(password, 10);
  const info = db.prepare('INSERT INTO users (username, password_hash, phone, avatar, signature, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(username, passwordHash, phone, '', '', Date.now());
  const user = mapUser(db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid));
  session.setSession(res, user);
  return res.json({ success: true, message: '注册成功', user });
});

// 获取当前登录用户
app.get('/api/auth/me', session.tryAuth, (req, res) => {
  if (!req.user) return res.status(401).json({ success: false, message: '请先登录' });
  return res.json({ success: true, user: req.user });
});

// 更新个人资料（头像、个性签名）
app.put('/api/auth/profile', session.authRequired, (req, res) => {
  const { avatar, signature } = req.body || {};
  const current = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (avatar !== undefined) current.avatar = avatar;
  if (signature !== undefined) current.signature = signature;
  db.prepare('UPDATE users SET avatar = ?, signature = ? WHERE id = ?')
    .run(current.avatar || '', current.signature || '', req.user.id);
  const updated = mapUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id));
  return res.json({ success: true, user: updated });
});

// 退出登录（清空会话 Cookie；CAS 模式下额外返回统一注销地址）
app.post('/api/auth/logout', (_req, res) => {
  session.clearSession(res);
  if (config.casEnabled) {
    const base = config.baseUrl || (_req.protocol + '://' + _req.get('host'));
    return res.json({ success: true, casLogoutUrl: config.casBaseUrl + '/logout?service=' + encodeURIComponent(base + '/') });
  }
  return res.json({ success: true });
});

// ==================== 物品相关 API ====================

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

// 物品列表（公开列表只返回在架 active；公开视图联系方式已脱敏）
app.get('/api/items', (req, res) => {
  const { type, publisher } = req.query;
  let sql = "SELECT * FROM items WHERE status = 'active'";
  const params = [];
  if (type === 'lost' || type === 'found') { sql += ' AND type = ?'; params.push(type); }
  if (publisher) { sql += ' AND publisher = ?'; params.push(publisher); }
  sql += ' ORDER BY id DESC';
  const rows = db.prepare(sql).all(...params);
  return res.json({ success: true, items: rows.map((r) => publicItem(mapItem(r))) });
});

// 我发布的全部启事（含已撤销，需登录）
app.get('/api/items/mine', session.authRequired, (req, res) => {
  const rows = db.prepare('SELECT * FROM items WHERE publisher = ? ORDER BY id DESC').all(req.user.username);
  return res.json({ success: true, items: rows.map(mapItem) });
});

// 智能匹配
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

// 校园热力图数据
const GEOCODE = [
  [/图书馆/, [420, 100]], [/教学楼\s*A/, [680, 90]], [/教学楼\s*B/, [870, 90]], [/教学楼/, [680, 90]],
  [/艺术楼/, [645, 265]], [/食堂/, [385, 265]], [/超市/, [155, 265]], [/宿舍|公寓/, [400, 470]],
  [/操场/, [875, 460]], [/体育馆/, [660, 455]], [/保卫处/, [150, 465]], [/校门/, [360, 615]],
  [/校车|站牌/, [150, 600]], [/医院/, [860, 255]], [/行政楼/, [160, 90]], [/花园|湖畔|湖/, [660, 615]]
];
function geocode(locationText) {
  if (!locationText) return null;
  for (const [re, pt] of GEOCODE) if (re.test(locationText)) return pt;
  return null;
}
app.get('/api/items/heatmap', (_req, res) => {
  const rows = db.prepare("SELECT * FROM items WHERE status = 'active'").all();
  const items = rows
    .map((row) => {
      const item = mapItem(row);
      if (item.mapX == null || item.mapY == null) {
        const pt = geocode(row.location);
        if (pt) { item.mapX = pt[0]; item.mapY = pt[1]; }
      }
      return item;
    })
    .filter((item) => item.mapX != null && item.mapY != null);
  return res.json({ success: true, items: items.map(publicItem) });
});

// 物品详情（发布者本人/管理员可见完整联系方式与答案，其余访客看到打码版）
app.get('/api/items/:id', session.tryAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ success: false, message: '物品不存在' });
  const item = mapItem(row);
  const isOwner = req.user && req.user.username === item.publisher;
  const isAdmin = req.user && req.user.role === 'admin';
  if (isOwner || isAdmin) return res.json({ success: true, item });
  return res.json({ success: true, item: publicItem(item) });
});

// 防冒领问答验证：全部答对才返回完整联系方式
app.post('/api/items/:id/verify', session.tryAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ success: false, message: '物品不存在' });
  const item = mapItem(row);
  const quiz = item.quiz || [];
  if (!quiz.length) return res.json({ success: true, correct: true, contact: item.contact });
  const answers = Array.isArray((req.body || {}).answers) ? req.body.answers : [];
  const correct = quiz.length === answers.length &&
    quiz.every((q, i) => Number(answers[i]) === q.answer);
  if (!correct) return res.json({ success: true, correct: false, message: '答案不完全正确，请再仔细想想' });
  return res.json({ success: true, correct: true, contact: item.contact });
});

// 发布物品（需登录，发布者以会话为准）
app.post('/api/items', session.authRequired, (req, res) => {
  const { type, title, category, color, location, date, image, description, contact, reward, features, mapX, mapY, quiz } = req.body || {};
  if (type !== 'lost' && type !== 'found') return res.status(400).json({ success: false, message: '发布类型无效' });
  if (!title || !category || !location || !date || !description || !contact) return res.status(400).json({ success: false, message: '请填写所有必填项' });

  let cleanQuiz = [];
  if (Array.isArray(quiz) && quiz.length > 0) {
    if (quiz.length > 5) return res.status(400).json({ success: false, message: '防冒领问题最多 5 题' });
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

  const toCoord = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const createdAt = Date.now();
  const info = db.prepare(
    `INSERT INTO items (type, title, category, color, location, date, image, description, contact, reward, features, publisher, map_x, map_y, quiz, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    type, title, category, color || '未知', location, date, resolveImageField(image), description, contact, reward || '',
    JSON.stringify(Array.isArray(features) ? features : []),
    req.user.username, toCoord(mapX), toCoord(mapY), JSON.stringify(cleanQuiz), createdAt
  );
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(info.lastInsertRowid);
  return res.status(201).json({ success: true, item: mapItem(row) });
});

// 更新启事状态
app.patch('/api/items/:id/status', session.authRequired, (req, res) => {
  const target = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ success: false, message: '启事不存在' });
  const next = (req.body || {}).status;
  if (next !== 'active' && next !== 'removed' && next !== 'resolved') return res.status(400).json({ success: false, message: '状态值无效' });
  const isOwner = target.publisher === req.user.username;
  const isAdmin = req.user.role === 'admin';
  if (!isOwner && !isAdmin) return res.status(403).json({ success: false, message: '只能操作自己发布的启事' });
  db.prepare('UPDATE items SET status = ? WHERE id = ?').run(next, target.id);
  const updated = db.prepare('SELECT * FROM items WHERE id = ?').get(target.id);
  let message = '启事已恢复上架';
  if (next === 'removed') message = '启事已撤销';
  if (next === 'resolved') message = updated.type === 'lost' ? '已标记为已找回' : '已标记为已认领';
  return res.json({ success: true, message, item: mapItem(updated) });
});

// ==================== 意见反馈 API ====================

app.post('/api/feedback', session.authRequired, (req, res) => {
  const { category, content, contact } = req.body || {};
  const text = (content || '').trim();
  if (!text) return res.status(400).json({ success: false, message: '请填写反馈内容' });
  if (text.length > 1000) return res.status(400).json({ success: false, message: '反馈内容不超过 1000 字' });
  const allowedCats = ['功能建议', '问题反馈', '物品相关', '其他'];
  const cat = allowedCats.includes(category) ? category : '其他';
  const info = db.prepare(
    `INSERT INTO feedback (user_id, username, category, content, contact, status, reply, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', '', ?)`
  ).run(req.user.id, req.user.username, cat, text, (contact || '').trim(), Date.now());
  const row = db.prepare('SELECT * FROM feedback WHERE id = ?').get(info.lastInsertRowid);
  return res.status(201).json({ success: true, message: '反馈已提交，感谢你的意见！', feedback: mapFeedback(row) });
});

app.get('/api/feedback/mine', session.authRequired, (req, res) => {
  const rows = db.prepare('SELECT * FROM feedback WHERE user_id = ? ORDER BY id DESC').all(req.user.id);
  return res.json({ success: true, feedback: rows.map(mapFeedback) });
});

// ==================== 管理员后台 API ====================

app.get('/api/admin/stats', session.authRequired, session.requireAdmin, (_req, res) => {
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const adminCount = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get().c;
  const countBy = (type, status) => db.prepare("SELECT COUNT(*) AS c FROM items WHERE type = ? AND status = ?").get(type, status).c;
  const lostCount = countBy('lost', 'active');
  const foundCount = countBy('found', 'active');
  const lostRemoved = countBy('lost', 'removed');
  const foundRemoved = countBy('found', 'removed');
  const lostResolved = countBy('lost', 'resolved');
  const foundResolved = countBy('found', 'resolved');
  return res.json({
    success: true,
    stats: {
      userCount, adminCount,
      itemCount: lostCount + foundCount + lostRemoved + foundRemoved + lostResolved + foundResolved,
      lostCount, foundCount, lostRemoved, foundRemoved, lostResolved, foundResolved
    }
  });
});

app.get('/api/admin/users', session.authRequired, session.requireAdmin, (_req, res) => {
  const rows = db.prepare('SELECT id, username, phone, avatar, signature, role, created_at FROM users ORDER BY id ASC').all();
  return res.json({ success: true, users: rows.map(mapUser) });
});

app.get('/api/admin/items', session.authRequired, session.requireAdmin, (_req, res) => {
  const rows = db.prepare('SELECT * FROM items ORDER BY id DESC').all();
  return res.json({ success: true, items: rows.map(mapItem) });
});

app.get('/api/admin/feedback', session.authRequired, session.requireAdmin, (_req, res) => {
  const rows = db.prepare('SELECT * FROM feedback ORDER BY id DESC').all();
  const list = rows.map(mapFeedback);
  const byCategory = {};
  list.forEach((f) => { byCategory[f.category] = (byCategory[f.category] || 0) + 1; });
  return res.json({
    success: true,
    feedback: list,
    summary: { total: list.length, pending: list.filter((f) => f.status === 'pending').length, resolved: list.filter((f) => f.status === 'resolved').length, byCategory }
  });
});

app.patch('/api/admin/feedback/:id', session.authRequired, session.requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM feedback WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ success: false, message: '反馈不存在' });
  const next = (req.body || {}).status;
  if (next !== 'pending' && next !== 'resolved') return res.status(400).json({ success: false, message: '状态值无效' });
  const reply = req.body.reply !== undefined ? String(req.body.reply) : target.reply;
  db.prepare('UPDATE feedback SET status = ?, reply = ? WHERE id = ?').run(next, reply, target.id);
  const row = db.prepare('SELECT * FROM feedback WHERE id = ?').get(target.id);
  return res.json({ success: true, message: next === 'resolved' ? '已标记为已处理' : '已标记为待处理', feedback: mapFeedback(row) });
});

app.post('/api/admin/users/promote', session.authRequired, session.requireAdmin, (req, res) => {
  const username = ((req.body || {}).username || '').trim();
  if (!username) return res.status(400).json({ success: false, message: '请输入用户名' });
  const target = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!target) return res.status(404).json({ success: false, message: '该用户不存在' });
  if (target.role === 'admin') return res.json({ success: true, message: '该用户已经是管理员' });
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(target.id);
  return res.json({ success: true, message: '已将 ' + username + ' 提升为管理员' });
});

// 管理员后台页面
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// 多页面路由
['login', 'lost', 'found', 'recognize', 'publish', 'profile', 'feedback', 'heatmap'].forEach((page) => {
  app.get('/' + page, (_req, res) => res.sendFile(path.join(__dirname, 'public', page + '.html')));
});

// 其他路由回退到首页
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---------------- 启动 ----------------
app.listen(PORT, () => {
  const nets = os.networkInterfaces();
  const ips = [];
  Object.values(nets).forEach((list) => list.forEach((ni) => { if (ni.family === 'IPv4' && !ni.internal) ips.push(ni.address); }));
  console.log('==================================================');
  console.log('  寻物智联服务已启动');
  console.log('  本机访问:   http://localhost:' + PORT);
  ips.forEach((ip) => console.log('  局域网访问: http://' + ip + ':' + PORT));
  console.log('  CAS 统一认证: ' + (config.casEnabled ? '已启用' : '未启用（开发期本地登录）'));
  if (config.seedDevUser && !config.casEnabled) {
    console.log('  测试账号:   demo / 123456  （管理员 admin / admin123）');
  }
  console.log('  数据库文件: ' + path.join(__dirname, 'data', 'xunwu.db'));
  console.log('==================================================');
});
