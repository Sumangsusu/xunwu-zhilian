// session.js — 基于 HMAC 签名的 HttpOnly 会话 Cookie（替换原 localStorage JWT 方案）
// 设计要点（对应学校安全要求）：令牌不在 localStorage、不在 URL；仅通过 HttpOnly Cookie 传输。
const crypto = require('crypto');
const config = require('./config');
const { db, mapUser } = require('./db');

const COOKIE_NAME = 'xunwu_sid';

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }

function signSession(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', config.sessionSecret).update(body).digest('base64url');
  return body + '.' + sig;
}

function verifySession(cookie) {
  if (!cookie || typeof cookie !== 'string' || !cookie.includes('.')) return null;
  const [body, sig] = cookie.split('.');
  const expected = crypto.createHmac('sha256', config.sessionSecret).update(body).digest('base64url');
  if (sig !== expected) return null; // 篡改或签名不符
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return null; // 过期
    return payload;
  } catch { return null; }
}

function setSession(res, user) {
  const payload = {
    uid: user.id,
    role: user.role,
    name: user.username,
    exp: Date.now() + config.sessionMaxAge * 1000
  };
  const val = signSession(payload);
  const parts = [
    `${COOKIE_NAME}=${val}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${config.sessionMaxAge}`
  ];
  if (config.secureCookie) parts.push('Secure'); // 仅 HTTPS 下标记 Secure
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0`);
}

function getSession(req) {
  const c = req.headers.cookie || '';
  const m = c.match(new RegExp(COOKIE_NAME + '=([^;]+)'));
  return m ? verifySession(m[1]) : null;
}

// 必需登录
function authRequired(req, res, next) {
  const s = getSession(req);
  if (!s) return res.status(401).json({ success: false, message: '请先登录' });
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(s.uid);
  if (!row) return res.status(401).json({ success: false, message: '用户不存在，请重新登录' });
  req.user = mapUser(row);
  next();
}

// 可选登录：有合法会话则填充 req.user，否则匿名
function tryAuth(req, _res, next) {
  const s = getSession(req);
  if (s) {
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(s.uid);
    if (row) req.user = mapUser(row);
  }
  next();
}

// 管理员鉴权
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: '需要管理员权限' });
  }
  next();
}

module.exports = {
  COOKIE_NAME, signSession, verifySession,
  setSession, clearSession, getSession,
  authRequired, tryAuth, requireAdmin
};
