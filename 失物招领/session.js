const jwt = require('jsonwebtoken');
const { db, mapUser } = require('./db');
const { sessionSecret, cookieSecure, seedDevUser } = require('./config');

const name = 'xunwu_session';
const maxAge = 24 * 60 * 60 * 1000;
const options = { httpOnly: true, sameSite: 'lax', secure: cookieSecure, path: '/' };

function isLegacySeed(row) {
  return ['TEST-demo', 'TEST-admin'].includes(row.phone) ||
    (row.username === 'demo' && row.signature === '帮助他人，快乐自己～') ||
    (row.username === 'admin' && row.signature === '系统管理员');
}

function setSession(res, user) {
  const token = jwt.sign({}, sessionSecret, { subject: String(user.id), expiresIn: maxAge / 1000 });
  res.cookie(name, token, { ...options, maxAge });
}

function clearSession(res) {
  res.clearCookie(name, options);
}

function sessionUser(req) {
  const cookie = (req.get('Cookie') || '').split(';').map((part) => part.trim());
  const token = cookie.find((part) => part.startsWith(name + '='))?.slice(name.length + 1);
  if (!token) return null;
  let payload;
  try {
    payload = jwt.verify(token, sessionSecret, { algorithms: ['HS256'] });
  } catch (err) {
    return null;
  }
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
  return row && (seedDevUser || !isLegacySeed(row)) ? mapUser(row) : null;
}

module.exports = { setSession, clearSession, sessionUser, isLegacySeed };
