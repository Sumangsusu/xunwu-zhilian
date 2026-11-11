const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const Database = require('better-sqlite3');
const { dbPath } = require('../config');

function checkSnapshot(filename) {
  const db = new Database(filename, { fileMustExist: true });
  try {
    const integrity = db.pragma('integrity_check', { simple: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    if (integrity !== 'ok' || !['users', 'items', 'feedback'].every((name) => tables.some((table) => table.name === name))) {
      throw new Error('备份未通过完整性或表结构检查');
    }
    db.pragma('journal_mode = DELETE');
  } finally {
    db.close();
  }
}

async function snapshot(mode) {
  if (!['backup', 'restore'].includes(mode)) throw new Error('用法：db-snapshot.js backup|restore');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const temp = fs.mkdtempSync(path.join(path.dirname(dbPath), '.snapshot-'));
  const filename = path.join(temp, 'snapshot.db');
  try {
    if (mode === 'backup') {
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        await db.backup(filename);
      } finally {
        db.close();
      }
      checkSnapshot(filename);
      await pipeline(fs.createReadStream(filename), process.stdout);
      return;
    }

    await pipeline(process.stdin, fs.createWriteStream(filename, { mode: 0o600 }));
    checkSnapshot(filename);
    if (fs.existsSync(dbPath)) {
      const current = new Database(dbPath, { fileMustExist: true });
      try {
        const checkpoint = current.pragma('wal_checkpoint(TRUNCATE)')[0];
        if (checkpoint.busy) throw new Error('数据库仍在使用，请先停止应用');
        current.pragma('journal_mode = DELETE');
      } finally {
        current.close();
      }
    } else {
      // 主库被误删时，旧 WAL/SHM 与恢复的快照不属于同一个数据库。
      fs.rmSync(dbPath + '-wal', { force: true });
      fs.rmSync(dbPath + '-shm', { force: true });
    }
    fs.renameSync(filename, dbPath);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

snapshot(process.argv[2]).catch((err) => {
  console.error('数据库操作失败：' + err.message);
  process.exitCode = 1;
});
