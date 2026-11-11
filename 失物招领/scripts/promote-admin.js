const fs = require('node:fs');
const { dbPath } = require('../config');
const username = process.argv[2];
if (!username) throw new Error('用法：node scripts/promote-admin.js <已注册用户名>');
if (!fs.existsSync(dbPath)) throw new Error('找不到数据库：' + dbPath);
const { db } = require('../db');
const { isLegacySeed } = require('../session');

try {
  db.transaction(() => {
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || isLegacySeed(user)) throw new Error('请使用已注册的普通账号');
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
  }).immediate();
  console.log('已授予管理员权限：' + username);
} finally {
  db.close();
}
