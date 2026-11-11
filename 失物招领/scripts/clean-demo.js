const fs = require('node:fs');
const { dbPath, seedDevUser } = require('../config');
if (seedDevUser) throw new Error('请先设置 SEED_DEV_USER=false');
if (!fs.existsSync(dbPath)) throw new Error('找不到数据库：' + dbPath);
const { db } = require('../db');
const { isLegacySeed } = require('../session');

const apply = process.argv.includes('--apply');
try {
  const result = db.transaction(() => {
    const accounts = db.prepare("SELECT * FROM users WHERE username IN ('demo', 'admin')").all().filter(isLegacySeed);
    const sanitize = db.prepare(`
      UPDATE items SET contact = '演示联系 TEST-0000'
      WHERE image GLOB '/images/item-[0-9]*.jpg' AND date BETWEEN '2025-01-11' AND '2025-01-15'
        AND contact != '演示联系 TEST-0000'
    `);
    if (apply) {
      for (const row of accounts) {
        db.prepare('UPDATE feedback SET user_id = NULL WHERE user_id = ?').run(row.id);
        db.prepare('UPDATE items SET publisher = ? WHERE publisher = ?').run('[已清理演示账号]', row.username);
        db.prepare('DELETE FROM users WHERE id = ?').run(row.id);
      }
      return { removedAccounts: accounts.map((row) => row.username), sanitizedItems: sanitize.run().changes };
    }
    return { previewAccounts: accounts.map((row) => row.username), hint: '使用 --apply 执行清理' };
  }).immediate();
  console.log(JSON.stringify(result));
} finally {
  db.close();
}
