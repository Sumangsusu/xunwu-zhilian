// ==================== 寻物智联后端服务 ====================
const express = require('express');
const path = require('path');
const fs = require('node:fs');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const config = require('./config');
if (config.casEnabled) throw new Error('当前制品未接入校方 CAS，请先设置 CAS_ENABLED=false');
const { db, mapUser, mapItem, mapFeedback, publicItem, getQuizState, bumpQuizAttempt } = require('./db');
const quizRules = require('./quiz');
const { setSession, clearSession, sessionUser, isLegacySeed } = require('./session');
const { coordinates, validPair, approxGeo } = require('./coordinates');
const { readImage, saveImage } = require('./images');
const { buildMapConfig, mapCspSources } = require('./map-config');
const ocr = require('./ocr');
const recognize = require('./recognize');
const locationAlias = require('./public/js/location-alias');
const matcher = require('./matcher');
const points = require('./points');

const app = express();
app.set('trust proxy', config.trustProxy || false);

// B1 真实地图启用后，SDK 脚本、瓦片、Web 服务与 Worker 都来自腾讯地图域名。
// 未启用时返回空数组，整站维持原有严格 CSP，不因可选功能放宽安全策略。
const mapSources = mapCspSources();
app.use(helmet({
  strictTransportSecurity: config.cookieSecure ? undefined : false,
  contentSecurityPolicy: { directives: {
    // 现有页面使用内联脚本及事件处理器。动态内容在前端转义。
    // 'unsafe-eval' 供本地 TensorFlow.js 初始化（智能识别页的 MobileNet 物体识别）：
    // TF.js 2.8.6 在加载时用 Function() 做环境探测，缺此项会抛 EvalError 导致 tf 为空对象、
    // 报 "tf.ready is not a function"。物体识别纯浏览器端运行，不依赖任何云端额度。
    scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", ...mapSources],
    scriptSrcAttr: ["'unsafe-inline'"],
    connectSrc: ["'self'", ...mapSources],
    imgSrc: ["'self'", 'data:', 'blob:', ...mapSources],
    workerSrc: ["'self'", 'blob:'],
    styleSrc: ["'self'", "'unsafe-inline'"],
    upgradeInsecureRequests: null
  } }
}));

app.get('/health', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    db.prepare('SELECT 1 FROM items LIMIT 1').get();
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(503).json({ status: 'unavailable' });
  }
});

app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.vary('Origin');
  const origin = req.get('Origin');
  const ownOrigin = config.baseUrl || req.protocol + '://' + req.get('Host');
  const allowed = origin && (origin === ownOrigin || origin === config.corsOrigin);
  if (origin && !allowed && !['GET', 'HEAD'].includes(req.method)) {
    return res.status(403).json({ success: false, message: '请求来源不被允许' });
  }
  if (allowed && origin === config.corsOrigin) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Allow-Credentials', 'true');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});

const limit = (max) => rateLimit({
  windowMs: 15 * 60 * 1000, limit: max, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { success: false, message: '请求过于频繁，请稍后再试' }
});
const loginLimit = limit(config.rateLimit);
const publishLimit = limit(config.rateLimit);
const verifyLimit = limit(5);
const ocrLimit = limit(10);
const recognizeLimit = limit(10);
app.use(express.json({ limit: '8mb', inflate: false }));

// 页面（.html 及无扩展名路由）禁止缓存，确保前端改动后浏览器总是拿到最新页面
app.use((req, res, next) => {
  const ext = path.extname(req.path);
  if (ext === '' || ext === '.html') {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
  next();
});

const icons = path.dirname(require.resolve('font-awesome/package.json'));
for (const dir of ['css', 'fonts']) {
  app.use('/vendor/font-awesome/' + dir, express.static(path.join(icons, dir)));
}
app.use(express.static(path.join(__dirname, 'public')));

function tryAuth(req, _res, next) {
  req.user = sessionUser(req);
  next();
}

function authRequired(req, res, next) {
  req.user = sessionUser(req);
  if (!req.user) return res.status(401).json({ success: false, message: '请先登录' });
  next();
}

require('./agent').mount(app, authRequired, rateLimit);

// 管理员鉴权：在已登录基础上校验角色
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: '需要管理员权限' });
  }
  next();
}

// ==================== 双向撮合 ====================
// 新启事入库时立即与反向类型的在架启事比对，命中阈值就双向写入 item_matches，
// 两边（失主和拾取者）都能在个人中心看到"疑似同一件物品"。
const insertMatch = db.prepare(
  'INSERT OR IGNORE INTO item_matches (item_id, match_id, score, reasons, seen, created_at) VALUES (?, ?, ?, ?, 0, ?)'
);

function activeOppositeItems(item) {
  const rows = db.prepare("SELECT * FROM items WHERE status = 'active' AND type != ? AND id != ?")
    .all(item.type, item.id);
  return rows.map(mapItem);
}

// 计算并落库一条启事的全部匹配（双向），返回本次命中的对方启事
function persistMatches(item) {
  const hits = matcher.rank(item, activeOppositeItems(item));
  if (!hits.length) return [];
  const now = Date.now();
  db.transaction(() => {
    for (const hit of hits) {
      const reasons = JSON.stringify(hit.reasons);
      insertMatch.run(item.id, hit.item.id, hit.score, reasons, now);
      insertMatch.run(hit.item.id, item.id, hit.score, reasons, now);
    }
  })();
  return hits;
}

// 首次启动时给历史数据补一遍匹配；表里已有数据则跳过，避免覆盖 seen 状态
function backfillMatches() {
  const existing = db.prepare('SELECT COUNT(*) AS c FROM item_matches').get().c;
  if (existing > 0) return 0;
  const rows = db.prepare("SELECT * FROM items WHERE status = 'active'").all().map(mapItem);
  // 数据量过大时不做 O(n²) 全量补算，避免拖慢启动
  if (rows.length > 2000) return 0;
  const now = Date.now();
  let pairs = 0;
  db.transaction(() => {
    for (let i = 0; i < rows.length; i += 1) {
      for (let j = i + 1; j < rows.length; j += 1) {
        const a = rows[i];
        const b = rows[j];
        if (a.type === b.type) continue;
        if (a.publisher && b.publisher && a.publisher === b.publisher) continue;
        const result = matcher.scorePair(a, b);
        if (result.score < matcher.THRESHOLD) continue;
        const reasons = JSON.stringify(result.reasons);
        insertMatch.run(a.id, b.id, result.score, reasons, now);
        insertMatch.run(b.id, a.id, result.score, reasons, now);
        pairs += 1;
      }
    }
  })();
  if (pairs) console.log('[撮合] 已为历史数据补算 ' + pairs + ' 对匹配');
  return pairs;
}

const unreadMatchCount = (username) => db.prepare(
  `SELECT COUNT(*) AS c FROM item_matches m
   JOIN items i ON i.id = m.item_id
   JOIN items o ON o.id = m.match_id
   WHERE i.publisher = ? AND i.status = 'active' AND o.status = 'active' AND m.seen = 0`
).get(username).c;

// ==================== 认证相关 API ====================

// 注册
app.post('/api/auth/register', loginLimit, (req, res) => {
  const { username, password, phone } = req.body || {};

  if (![username, password, phone].every((v) => typeof v === 'string' && v)) {
    return res.status(400).json({ success: false, message: '请填写完整的注册信息' });
  }
  if (username.length < 3 || username.length > 20) {
    return res.status(400).json({ success: false, message: '用户名长度需在3-20位之间' });
  }
  if (!/^1[3-9]\d{9}$/.test(phone) && !/^TEST-[A-Z0-9]{4,20}$/.test(phone)) {
    return res.status(400).json({ success: false, message: '请输入正确的手机号' });
  }
  if (password.length < 8 || Buffer.byteLength(password) > 72) {
    return res.status(400).json({ success: false, message: '密码需至少 8 个字符且不超过 72 字节' });
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
app.post('/api/auth/login', loginLimit, (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password || Buffer.byteLength(password) > 72) {
    return res.status(400).json({ success: false, message: '请输入用户名和密码' });
  }

  const row = db.prepare('SELECT * FROM users WHERE username = ? OR phone = ?').get(username, username);
  if (!row || (!config.seedDevUser && isLegacySeed(row)) || !bcrypt.compareSync(password, row.password_hash)) {
    return res.status(401).json({ success: false, message: '用户名或密码错误' });
  }

  const user = mapUser(row);
  setSession(res, user);
  return res.json({ success: true, user });
});

// 公开登录配置：只下发前端决定登录入口所需的最小字段，不下发任何密钥/内部地址。
// 当前制品未接入校方 CAS（启动时即校验 CAS_ENABLED=false），故恒为 false，
// 但接口必须返回真实 JSON，避免被 SPA 兜底回退成 HTML 后被前端静默吞错。
app.get('/api/auth/config', (_req, res) => {
  return res.json({ success: true, casEnabled: false });
});

// 获取当前登录用户信息（附带未读撮合数，供导航红点使用）
app.get('/api/auth/me', authRequired, (req, res) => {
  return res.json({ success: true, user: req.user, matchUnread: unreadMatchCount(req.user.username) });
});

// 更新个人资料（头像、个性签名）
app.put('/api/auth/profile', authRequired, (req, res) => {
  const { avatar, signature } = req.body || {};
  const current = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

  if (signature !== undefined) {
    if (typeof signature !== 'string' || signature.length > 500) {
      return res.status(400).json({ success: false, message: '个性签名需在 500 字内' });
    }
    current.signature = signature;
  }

  let upload;
  if (avatar !== undefined) {
    let decoded;
    try { if (avatar !== '') decoded = readImage(avatar); } catch (err) {
      return res.status(400).json({ success: false, message: err.message });
    }
    upload = saveImage(avatar, decoded);
    current.avatar = upload.url;
  }

  try {
    db.prepare('UPDATE users SET avatar = ?, signature = ? WHERE id = ?')
      .run(current.avatar || '', current.signature || '', req.user.id);
  } catch (err) {
    if (upload?.filename) fs.rmSync(upload.filename, { force: true });
    throw err;
  }

  const updated = mapUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id));
  return res.json({ success: true, user: updated });
});

// 清除浏览器的 HttpOnly 会话 Cookie。
app.post('/api/auth/logout', (_req, res) => {
  clearSession(res);
  return res.json({ success: true });
});

// ==================== 配置与文字识别 API（A↔B 协同） ====================

// B1 前端 readConfig() 的唯一数据来源。未配 key / 未实测标定时 enabled:false，
// 前端按设计降级自绘 SVG；这里永远返回 JSON，不会被 app.get('*') 的 SPA 兜底吃掉。
app.get('/api/map/config', (_req, res) => {
  res.json(buildMapConfig());
});

// B2：密钥只在后端，图片不落盘、不入库。失败统一给可操作提示，不抛堆栈、不报 5xx。
app.post('/api/ocr', authRequired, ocrLimit, async (req, res) => {
  try {
    const result = await ocr.recognize((req.body || {}).image);
    if (!result.ok) {
      return res.json({ success: false, code: result.code, message: result.message });
    }
    return res.json({ success: true, text: result.text });
  } catch (err) {
    console.error('[ocr]', err.code || err.name);
    return res.json({ success: false, code: 'ocr-unavailable', message: '文字识别服务暂时不可用，请手动填写描述' });
  }
});

// 物品图片识别（小程序 / 网页版共用）：图片不落盘、不入库，仅内存推理。
// 复用网页版同一 MobileNetV2 模型 + 类目聚合映射，识别口径与网页版一致。
app.post('/api/recognize', authRequired, recognizeLimit, async (req, res) => {
  try {
    const image = (req.body || {}).image;
    if (!image || typeof image !== 'string') {
      return res.json({ success: false, code: 'no-image', message: '请上传图片' });
    }
    const match = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);
    if (!match) {
      return res.json({ success: false, code: 'bad-image', message: '仅支持 JPEG / PNG 图片' });
    }
    const buf = Buffer.from(match[2], 'base64');
    if (buf.length > 5 * 1024 * 1024) {
      return res.json({ success: false, code: 'too-large', message: '图片不能超过 5 MiB' });
    }
    const result = await recognize.recognizeImage(buf);
    return res.json({ success: true, result });
  } catch (err) {
    console.error('[recognize]', err.name || err.message);
    return res.json({ success: false, code: 'recognize-unavailable', message: '物品识别服务暂时不可用，请稍后再试或手动填写描述' });
  }
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

// 两点间球面距离（米），用于地图选点半径匹配
function haversineMeters(lng1, lat1, lng2, lat2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// 物品列表，支持 ?type=lost|found 与 ?publisher=用户名（公开列表只返回在架 active）
// ?q=关键词：走 locationAlias.matchItem 做地点别名/关键词匹配（"一教"能找到"信息学部一教"）。
// ?lng=&lat=&radius= 地图选点半径匹配，与关键词可任意组合；两者至少提供其一。
//   关键词与半径是「与」关系，可先选点再输入关键词收窄，也可反过来；匹配后经 publicItem 脱敏。
app.get('/api/items', (req, res) => {
  const { type, publisher, q, lng, lat, radius, mapX, mapY, browse } = req.query;
  // browse=1 供首页/列表页浏览最新启事：不受"必须有关键词或选点"限制，仍按 type/status 过滤。
  // 地图页 nearby.html 不传此参数，保持"至少输入关键词或选点"的约束。
  const isBrowse = browse === '1';
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
  let items = rows.map(mapItem);

  const keyword = typeof q === 'string' ? q.trim() : '';
  const pLng = Number(lng), pLat = Number(lat);
  const hasGeo = lng !== undefined && lat !== undefined &&
    Number.isFinite(pLng) && Number.isFinite(pLat) && validPair(pLng, pLat, -180, 180, -90, 90);
  const sX = Number(mapX), sY = Number(mapY);
  const hasSvg = !hasGeo && mapX !== undefined && mapY !== undefined && validPair(sX, sY, 0, 1000, 0, 700);
  // 自绘 SVG 选点先按标定表折算成 GCJ-02 圆心，无 key 的降级图同样能按半径匹配
  const center = hasGeo ? { lng: pLng, lat: pLat }
    : hasSvg ? (approxGeo(sX, sY) || coordinates({ mapX: sX, mapY: sY })) : null;
  const hasCenter = Boolean(center && center.lng != null && center.lat != null);
  if (!keyword && !hasCenter && !isBrowse) {
    return res.json({ success: true, items: [], hint: '请至少输入关键词或在地图上选点' });
  }

  if (keyword) items = items.filter((item) => locationAlias.matchItem(keyword, item));

  let range = null;
  if (hasCenter) {
    range = Math.min(Math.max(Number(radius) > 0 ? Number(radius) : 1000, 50), 5000);
    items = items
      .map((item) => {
        const point = coordinates(item);
        return {
          ...item,
          distance: point.lng == null ? null : Math.round(haversineMeters(center.lng, center.lat, point.lng, point.lat))
        };
      })
      .filter((item) => item.distance != null && item.distance <= range)
      .sort((a, b) => a.distance - b.distance);
  }

  return res.json({
    success: true,
    items: items.map(publicItem),
    filters: {
      keyword: keyword || null,
      point: hasCenter ? {
        lng: center.lng, lat: center.lat, radius: range,
        source: hasGeo ? 'geo' : 'svg-approx'
      } : null
    }
  });
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

// 我的启事的疑似匹配（需登录）。只返回 publicItem 视图，联系方式仍走防冒领问答解锁。
app.get('/api/matches', authRequired, (req, res) => {
  const rows = db.prepare(
    `SELECT m.id, m.item_id, m.match_id, m.score, m.reasons, m.seen, m.created_at
     FROM item_matches m
     JOIN items i ON i.id = m.item_id
     JOIN items o ON o.id = m.match_id
     WHERE i.publisher = ? AND i.status = 'active' AND o.status = 'active'
     ORDER BY m.seen ASC, m.score DESC, m.id DESC
     LIMIT 50`
  ).all(req.user.username);

  const getItem = db.prepare('SELECT * FROM items WHERE id = ?');
  const items = [];
  let unread = 0;
  for (const row of rows) {
    const own = getItem.get(row.item_id);
    const other = getItem.get(row.match_id);
    if (!own || !other) continue;
    if (!row.seen) unread += 1;
    const ownItem = mapItem(own);
    items.push({
      matchId: row.id,
      score: row.score,
      seen: Boolean(row.seen),
      reasons: JSON.parse(row.reasons || '[]'),
      createdAt: row.created_at,
      own: { id: ownItem.id, type: ownItem.type, title: ownItem.title, date: ownItem.date, location: ownItem.location },
      other: publicItem(mapItem(other))
    });
  }
  return res.json({ success: true, unread, items });
});

// 未读数（导航红点轮询用）
app.get('/api/matches/unread', authRequired, (req, res) => {
  return res.json({ success: true, unread: unreadMatchCount(req.user.username) });
});

// 标记已读：默认清空当前用户全部启事的未读匹配
app.post('/api/matches/seen', authRequired, (req, res) => {
  const info = db.prepare(
    'UPDATE item_matches SET seen = 1 WHERE item_id IN (SELECT id FROM items WHERE publisher = ?)'
  ).run(req.user.username);
  return res.json({ success: true, updated: info.changes });
});

// 地图散点专用接口：每条启事一个独立坐标。
// 注意：这里刻意不使用 publicItem() 的 toFixed(3) 截断——百米级精度会把同一功能区的
// 多条启事折叠成同一个坐标（50 条只显示十几个点）。coordinates() 已在功能区锚点内
// 按 mapX/mapY 做局部插值（约 2 米/SVG 单位、5 位小数、偏差 <150 米），仍是"功能区级
// 近似位置"而非实测精确坐标；联系方式/图片/描述/问答依旧不进入本接口。
app.get('/api/items/heatmap', (_req, res) => {
  const rows = db.prepare("SELECT * FROM items WHERE status = 'active'").all();
  const items = rows.map(mapItem).map((item) => ({ ...item, ...coordinates(item) }))
    .filter((item) => item.mapX != null || item.lng != null)
    .map((item) => {
      // 只输出白名单字段，坐标保留 5 位小数（约 1 米级显示精度，仍落在功能区内）
      const lng = item.lng == null ? null : Number(Number(item.lng).toFixed(5));
      const lat = item.lat == null ? null : Number(Number(item.lat).toFixed(5));
      return {
        id: item.id, type: item.type, title: item.title,
        location: item.location, date: item.date,
        mapX: item.mapX, mapY: item.mapY,
        lng: lng, lat: lat
      };
    });
  return res.json({ success: true, items });
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
    // 发布者/管理员免答题，但详情弹窗的答题区渲染条件是 item.hasQuiz && item.contactMasked。
    // mapItem 原始对象没有这两个字段，会导致卡片标记「需答题认领」却看不到题目。
    // 这里补齐视图字段（保留完整联系方式与含答案题目），双端共用同一接口。
    return res.json({
      success: true,
      item: {
        ...item,
        hasQuiz: Boolean(item.quiz && item.quiz.length),
        contactMasked: Boolean(item.contact),
        quizMaxAttempts: Number(item.quizAttempts) > 0
          ? Number(item.quizAttempts)
          : (item.quiz.some((q) => q.type === 'blank') ? 3 : 1),
        quizState: { attempts: 0, unlocked: true },
        ownerBypass: true
      }
    });
  }
  const view = publicItem(item);
  if (req.user && view.hasQuiz) {
    const state = getQuizState(item.id, req.user.username);
    view.quizState = state;
    if (state.unlocked) {
      view.contact = item.contact;
      view.contactMasked = false;
    }
  }
  return res.json({ success: true, item: view });
});

// 防冒领问答验证：按「用户 + 启事」计次，答对即解锁；次数耗尽不再接受尝试
app.post('/api/items/:id/verify', authRequired, verifyLimit, (req, res) => {
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!row) {
    return res.status(404).json({ success: false, message: '物品不存在' });
  }
  const item = mapItem(row);
  if (item.status !== 'active') return res.status(409).json({ success: false, message: '启事已下架或结案' });
  const quiz = item.quiz || [];
  if (!quiz.length) {
    return res.json({ success: true, correct: true, contact: item.contact });
  }
  // 发布者本人与管理员不需要接受自己的问答
  if (req.user.username === item.publisher || req.user.role === 'admin') {
    return res.json({ success: true, correct: true, contact: item.contact, bypass: true });
  }

  const max = Number(item.quizAttempts) > 0 ? Number(item.quizAttempts) : quizRules.maxAttempts(quiz);
  let state = getQuizState(item.id, req.user.username);
  if (state.unlocked) {
    return res.json({ success: true, correct: true, contact: item.contact, remaining: Math.max(0, max - state.attempts) });
  }
  if (state.attempts >= max) {
    return res.json({
      success: true, correct: false, locked: true, remaining: 0,
      message: '答题次数已用完，请通过布告上的其他方式联系发布者'
    });
  }

  const answers = Array.isArray((req.body || {}).answers) ? req.body.answers : [];
  const correct = quizRules.answersCorrect(quiz, answers);
  state = bumpQuizAttempt(item.id, req.user.username, correct);
  const remaining = Math.max(0, max - state.attempts);
  if (correct) {
    return res.json({ success: true, correct: true, contact: item.contact, remaining });
  }
  return res.json({
    success: true, correct: false, remaining, locked: remaining === 0,
    message: remaining === 0
      ? '答题次数已用完，请通过布告上的其他方式联系发布者'
      : `答案不完全正确，还可以再试 ${remaining} 次`
  });
});

// 发布物品（需登录，发布者以令牌为准）
app.post('/api/items', authRequired, publishLimit, (req, res) => {
  const {
    type, title, category, color, location, date,
    image, description, contact, reward, features, mapX, mapY, lng, lat, quiz
  } = req.body || {};

  if (type !== 'lost' && type !== 'found') {
    return res.status(400).json({ success: false, message: '发布类型无效' });
  }
  if (![title, category, location, date, description, contact].every((v) => typeof v === 'string' && v.trim())) {
    return res.status(400).json({ success: false, message: '请填写所有必填项' });
  }

  // 防冒领问答校验（选填）：选择题 / 判断题 / 填空题，填空题须通过答案唯一性鉴定
  if ([color, reward].some((v) => v != null && typeof v !== 'string')) {
    return res.status(400).json({ success: false, message: '颜色或酬谢字段格式错误' });
  }
  const normalized = quizRules.normalizeQuiz(quiz, req.body && req.body.quizAttempts);
  if (!normalized.ok) {
    return res.status(400).json({
      success: false,
      message: normalized.issues[0] || '防冒领问答格式不正确',
      issues: normalized.issues
    });
  }
  const cleanQuiz = normalized.quiz;
  const cleanAttempts = normalized.attempts;

  // 旧版发布表单以字符串提交 SVG 坐标。
  const numericSvg = (value) => typeof value === 'string' && value.trim() ? Number(value) : value;
  const x = numericSvg(mapX);
  const y = numericSvg(mapY);
  if (((x != null || y != null) && !validPair(x, y, 0, 1000, 0, 700)) ||
      ((lng != null || lat != null) && !validPair(lng, lat, -180, 180, -90, 90))) {
    return res.status(400).json({ success: false, message: '坐标必须成对提供且在有效范围内' });
  }
  const point = coordinates({ mapX: x, mapY: y, lng, lat, location });
  let decoded;
  try {
    if (image != null && image !== '') decoded = readImage(image);
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message });
  }

  const upload = saveImage(image, decoded);
  let info;
  try {
    info = db.prepare(
      `INSERT INTO items (type, title, category, color, location, date, image, description, contact, reward, features, publisher, map_x, map_y, lng, lat, quiz, quiz_attempts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      type, title, category, color || '未知', location, date, upload.url, description, contact, reward || '',
      JSON.stringify(Array.isArray(features) ? features.filter((v) => typeof v === 'string') : []),
      req.user.username, point.mapX, point.mapY, point.lng, point.lat,
      JSON.stringify(cleanQuiz), cleanAttempts, Date.now()
    );
  } catch (err) {
    if (upload.filename) fs.rmSync(upload.filename, { force: true });
    throw err;
  }

  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(info.lastInsertRowid);
  const item = mapItem(row);

  // 入库后立刻做一次双向撮合；撮合出错不影响发布本身。
  let hits = [];
  try {
    hits = persistMatches(item);
  } catch (err) {
    console.error('[撮合] 计算失败：', err.message);
  }

  // 发布积分：招领 +5 / 寻物 +2，每人每日计分上限 5 条（超出仍可发布，只是不再计分）
  let pointsAward = null;
  try {
    pointsAward = points.award(db, {
      username: req.user.username,
      code: type === 'found' ? 'publish_found' : 'publish_lost',
      detail: title,
      ref: 'publish:' + item.id
    });
  } catch (err) {
    console.error('[积分] 发布计分失败：', err.message);
  }

  return res.status(201).json({
    success: true,
    item,
    points: pointsAward,
    matches: hits.map((hit) => ({
      id: hit.item.id,
      type: hit.item.type,
      title: hit.item.title,
      score: hit.score,
      reasons: hit.reasons
    }))
  });
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

  // 积分联动：标记已找回/已认领时给发布者加分。
  // ref=resolve:<id> 保证同一启事只计一次；每日归还计分上限 3 次，防止批量自导自演。
  // 积分一经发放不自动回收（避免误操作丢分），异常刷分由管理员在后台手动减分。
  let pointsChange = null;
  try {
    if (next === 'resolved' && target.status !== 'resolved') {
      pointsChange = points.award(db, {
        username: target.publisher,
        code: target.type === 'found' ? 'resolve_found' : 'resolve_lost',
        detail: '启事 #' + target.id + ' ' + target.title,
        ref: 'resolve:' + target.id
      });
    }
  } catch (err) {
    console.error('[积分] 结案计分失败：', err.message);
  }

  let message = '启事已恢复上架';
  if (next === 'removed') message = '启事已撤销';
  if (next === 'resolved') message = updated.type === 'lost' ? '已标记为已找回' : '已标记为已认领';
  if (pointsChange && pointsChange.awarded) {
    message += '，发布者积分 +' + pointsChange.delta;
  } else if (pointsChange && pointsChange.capped) {
    message += '（今日归还计分已达上限，本次不额外加分）';
  }
  return res.json({ success: true, message, item: mapItem(updated), points: pointsChange });
});

// ==================== 意见反馈 API ====================

// 提交反馈（需登录）
app.post('/api/feedback', authRequired, (req, res) => {
  const { category, content, contact } = req.body || {};
  const text = typeof content === 'string' ? content.trim() : '';
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
  ).run(req.user.id, req.user.username, cat, text, typeof contact === 'string' ? contact.trim() : '', Date.now());

  const row = db.prepare('SELECT * FROM feedback WHERE id = ?').get(info.lastInsertRowid);
  return res.status(201).json({ success: true, message: '反馈已提交，感谢你的意见！', feedback: mapFeedback(row) });
});

// 查看我提交的反馈
app.get('/api/feedback/mine', authRequired, (req, res) => {
  const rows = db.prepare('SELECT * FROM feedback WHERE user_id = ? ORDER BY id DESC').all(req.user.id);
  return res.json({ success: true, feedback: rows.map(mapFeedback) });
});

// ==================== 积分与等级 API ====================

// 我的积分：总分、等级、排名、最近流水、规则说明（需登录）
app.get('/api/points/me', authRequired, (req, res) => {
  return res.json({ success: true, ...points.overview(db, req.user.username) });
});

// 积分排行榜（公开可看）：默认返回前 20 名，登录用户附带自己的排名
// ?limit=50 可拉取更多；limit=0 表示不限（最多 200 条，避免一次返回过大）。
// 公开榜只展示「有积分或有发布」的参与者，避免把从未参与的空账号列出来；
// 管理员端 /api/admin/points 返回全体用户。
app.get('/api/points/leaderboard', tryAuth, (req, res) => {
  const raw = Number((req.query || {}).limit);
  const limit = Number.isFinite(raw) && raw >= 0 ? Math.min(Math.floor(raw), 200) : 20;
  const all = points.leaderboard(db);
  const participants = all.filter((row) => row.points > 0 || row.published > 0);
  const list = limit === 0 ? participants : participants.slice(0, limit);
  const me = req.user ? (all.find((row) => row.username === req.user.username) || null) : null;
  return res.json({
    success: true,
    leaderboard: list,
    me: me ? {
      rank: me.rank, username: me.username, points: me.points,
      level: me.level, published: me.published,
      returned: me.returned, recovered: me.recovered
    } : null,
    totalUsers: participants.length,
    summary: points.boardSummary(db),
    rules: points.ruleList(),
    levels: points.LEVELS.map((item) => ({
      level: item.level, title: item.title, badge: item.badge, min: item.min
    }))
  });
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

// 用户列表（含注册时间、角色与积分等级）
app.get('/api/admin/users', authRequired, requireAdmin, (_req, res) => {
  const rows = db.prepare('SELECT id, username, phone, avatar, signature, role, points, created_at FROM users ORDER BY points DESC, created_at ASC').all();
  return res.json({ success: true, users: rows.map(mapUser) });
});

// 物品列表（管理用）
// 与 /api/items/heatmap 一致，给只有示意图坐标（mapX/mapY）的老启事回填区域级近似经纬度。
// 管理端热力图直接消费本接口；不回填会出现「50 条启事里只有 1 条有经纬度、地图只剩 1 个点」。
app.get('/api/admin/items', authRequired, requireAdmin, (_req, res) => {
  const rows = db.prepare('SELECT * FROM items ORDER BY id DESC').all();
  const items = rows.map(mapItem).map((item) => ({ ...item, ...coordinates(item) }));
  return res.json({ success: true, items });
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

// 积分总榜（管理端）：全体用户按积分排序 + 贡献明细 + 发放统计 + 最近流水
app.get('/api/admin/points', authRequired, requireAdmin, (_req, res) => {
  const users = points.leaderboard(db);
  const events = db.prepare(
    'SELECT username, delta, reason, detail, created_at FROM point_events ORDER BY id DESC LIMIT 30'
  ).all().map((row) => ({
    username: row.username,
    delta: row.delta,
    code: row.reason,
    label: (points.RULES[row.reason] || {}).label || row.reason,
    detail: row.detail || '',
    createdAt: row.created_at
  }));
  return res.json({
    success: true,
    users,
    summary: points.boardSummary(db),
    events,
    rules: points.ruleList(),
    levels: points.LEVELS
  });
});

// 手动调分（线下表现、活动奖励等）：delta 为 ±1~500 的整数，写入流水便于审计
app.post('/api/admin/points/adjust', authRequired, requireAdmin, (req, res) => {
  const { username, delta, reason } = req.body || {};
  const name = typeof username === 'string' ? username.trim() : '';
  const value = Math.trunc(Number(delta));
  if (!name) return res.status(400).json({ success: false, message: '请填写用户名' });
  if (!Number.isFinite(value) || value === 0) {
    return res.status(400).json({ success: false, message: '请填写非 0 的调整分值' });
  }
  if (Math.abs(value) > 500) {
    return res.status(400).json({ success: false, message: '单次调整不能超过 500 分' });
  }
  const note = typeof reason === 'string' ? reason.trim().slice(0, 100) : '';
  const result = points.adjust(db, { username: name, delta: value, detail: note || '管理员手动调整' });
  if (!result.ok) {
    const message = result.reason === 'no-user' ? '用户不存在' : '调整失败，请检查分值';
    return res.status(400).json({ success: false, message });
  }
  return res.json({
    success: true,
    message: (value > 0 ? '已加 ' : '已减 ') + Math.abs(value) + ' 分，当前 ' + result.points + ' 分',
    points: result.points,
    level: result.level
  });
});

// 管理员后台页面
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// 多页面路由（登录、失物、招领、识别、发布、个人中心）
['login', 'lost', 'found', 'recognize', 'publish', 'profile', 'feedback', 'heatmap', 'agent', 'points'].forEach((page) => {
  app.get('/' + page, (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', page + '.html'));
  });
});

// ---------------- 其他路由回退到首页 ----------------
// 只对「看似前端页面」的无扩展名路径回退 index.html；API、隐藏文件、静态资源
// 一律返回真实 404，避免不存在的接口/资源被 200 HTML 吞掉导致前端 resp.json() 解析失败被静默捕获。
app.get('*', (req, res) => {
  const pathname = req.path;
  const looksLikeApi = pathname === '/api' || pathname.startsWith('/api/');
  const looksLikeFile = /(?:^|\/)\.[^/]/.test(pathname) || /\.[a-z0-9]+$/i.test(pathname);
  if (looksLikeApi || looksLikeFile) {
    return res.status(404).json({ success: false, message: '请求的资源不存在' });
  }
  return res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, _req, res, _next) => {
  const status = err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) console.error('[server]', err.code || err.name);
  const message = status === 413 ? '请求体超过 8 MiB' : status === 400 ? '请求格式无效' : '服务器无法处理请求';
  res.status(status).json({ success: false, message });
});

app.listen(config.port, config.host, () => {
  console.log('寻物智联服务已启动，监听 ' + config.host + ':' + config.port);
  try {
    backfillMatches();
  } catch (err) {
    console.error('[撮合] 历史数据补算失败：', err.message);
  }
  // 积分回填：把已有启事补算成积分（幂等，重复启动不会重复加分）
  try {
    const info = points.backfill(db);
    if (info.added > 0) {
      console.log('[积分] 历史贡献回填 ' + info.added + ' 条，涉及 ' + info.users + ' 位用户');
    }
  } catch (err) {
    console.error('[积分] 历史数据回填失败：', err.message);
  }
});
