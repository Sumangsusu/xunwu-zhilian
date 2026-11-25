// ==================== 积分与等级体系 ====================
// 纯规则层：不直接依赖 db.js，所有读写通过传入的 better-sqlite3 实例完成，
// 避免 db.js <-> points.js 循环引用。
//
// 设计要点：
// 1. 积分事件流水 point_events 是唯一事实来源，users.points 只是冗余缓存；
// 2. 每类事件带幂等键 ref（如 publish:12 / resolve:12），重复触发不会重复加分；
// 3. 发布、归还各有每日计分次数上限，抑制批量灌水；异常账号由管理员手动减分。

// 等级门槛：lv.0 为注册默认等级，分数只增不减，等级只升不降。
// min 为该等级起始积分；next 为下一等级起始积分。
const LEVELS = [
  { level: 0, min: 0, title: '新同学', badge: '🌱' },
  { level: 1, min: 30, title: '热心路人', badge: '✨' },
  { level: 2, min: 80, title: '拾物达人', badge: '🔍' },
  { level: 3, min: 180, title: '归位能手', badge: '🎯' },
  { level: 4, min: 350, title: '校园活雷锋', badge: '🏅' },
  { level: 5, min: 600, title: '寻物领航员', badge: '🚀' },
  { level: 6, min: 1000, title: '珞珈守望者', badge: '🛡️' },
  { level: 7, min: 1600, title: '拾光传奇', badge: '👑' }
];

// 积分规则表：code 同时作为事件类型，前端规则说明直接读取此表。
const RULES = {
  publish_found: {
    label: '发布招领启事',
    delta: 5,
    desc: '捡到物品并发布招领启事，每条 +5（寻物+招领每日合计最多计分 5 条）'
  },
  publish_lost: {
    label: '发布寻物启事',
    delta: 2,
    desc: '发布寻物启事，每条 +2（寻物+招领每日合计最多计分 5 条）'
  },
  resolve_found: {
    label: '招领成功归还',
    delta: 60,
    desc: '你发布的招领启事被失主成功认领，+60（每日最多计分 3 次）'
  },
  resolve_lost: {
    label: '寻物成功找回',
    delta: 15,
    desc: '你发布的寻物启事确认找回，+15'
  },
  admin_adjust: {
    label: '管理员调整',
    delta: 0,
    desc: '管理员根据线下表现手动加/减分'
  }
};

// 发布类积分每日上限（条），防止批量灌水刷分
const DAILY_PUBLISH_CAP = 5;
// 归还类积分每日上限（次）：同一件启事只计一次分，再叠加上限防止自导自演批量刷分
const DAILY_RESOLVE_CAP = 3;

function levelInfo(points) {
  const score = Math.max(0, Math.floor(Number(points) || 0));
  let current = LEVELS[0];
  for (const item of LEVELS) {
    if (score >= item.min) current = item;
  }
  const next = LEVELS.find((item) => item.min > score) || null;
  const span = next ? next.min - current.min : 0;
  const progress = next ? Math.min(100, Math.round(((score - current.min) / span) * 100)) : 100;
  return {
    level: current.level,
    title: current.title,
    badge: current.badge,
    min: current.min,
    next: next ? next.min : null,
    nextLevel: next ? next.level : null,
    nextTitle: next ? next.title : null,
    toNext: next ? next.min - score : 0,
    progress,
    maxLevel: !next
  };
}

function ruleList() {
  return Object.entries(RULES)
    .filter(([code]) => code !== 'admin_adjust')
    .map(([code, rule]) => ({ code, label: rule.label, delta: rule.delta, desc: rule.desc }));
}

// 当天 00:00 的时间戳（服务器本地时区，校园场景足够）
function dayStart(ts) {
  const d = new Date(ts == null ? Date.now() : ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function userExists(db, username) {
  return Boolean(db.prepare('SELECT 1 FROM users WHERE username = ?').get(username));
}

function readPoints(db, username) {
  const row = db.prepare('SELECT points FROM users WHERE username = ?').get(username);
  return row ? Number(row.points) || 0 : 0;
}

function syncUserPoints(db, username) {
  const row = db.prepare(
    'SELECT COALESCE(SUM(delta), 0) AS total FROM point_events WHERE username = ?'
  ).get(username);
  const total = Math.max(0, Number(row.total) || 0);
  db.prepare('UPDATE users SET points = ? WHERE username = ?').run(total, username);
  return total;
}

/**
 * 给用户加分。ref 为幂等键，重复调用只生效一次。
 * @returns {{awarded:boolean, duplicate?:boolean, capped?:boolean, delta?:number, points?:number, level?:object}}
 */
function award(db, { username, code, detail = '', ref = null }) {
  const rule = RULES[code];
  if (!rule || !username) return { awarded: false, reason: 'unknown-rule' };
  if (!userExists(db, username)) return { awarded: false, reason: 'no-user' };

  const now = Date.now();
  const insert = db.transaction(() => {
    if (ref && db.prepare('SELECT 1 FROM point_events WHERE username = ? AND ref = ?').get(username, ref)) {
      return { awarded: false, duplicate: true, points: readPoints(db, username) };
    }
    // 发布类积分限每日条数（寻物 + 招领合计），超出的发布仍可正常发布，只是不再计分
    if (code === 'publish_found' || code === 'publish_lost') {
      const start = dayStart(now);
      const count = db.prepare(
        `SELECT COUNT(*) AS c FROM point_events
         WHERE username = ? AND reason IN ('publish_found', 'publish_lost') AND created_at >= ?`
      ).get(username, start).c;
      if (count >= DAILY_PUBLISH_CAP) {
        return { awarded: false, capped: true, points: readPoints(db, username) };
      }
    }
    // 归还类积分限每日次数：防止「自己发布 → 自己标记已认领」批量刷分
    if (code === 'resolve_found' || code === 'resolve_lost') {
      const start = dayStart(now);
      const count = db.prepare(
        `SELECT COUNT(*) AS c FROM point_events
         WHERE username = ? AND reason IN ('resolve_found', 'resolve_lost') AND created_at >= ?`
      ).get(username, start).c;
      if (count >= DAILY_RESOLVE_CAP) {
        return { awarded: false, capped: true, points: readPoints(db, username) };
      }
    }
    try {
      db.prepare(
        'INSERT INTO point_events (username, delta, reason, detail, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(username, rule.delta, code, String(detail || ''), ref || null, now);
    } catch (err) {
      // 并发重复触发时 UNIQUE(username, ref) 会拒绝写入，视为已发放，不报错
      if (String(err.code || err.message).includes('SQLITE_CONSTRAINT')) {
        return { awarded: false, duplicate: true, points: readPoints(db, username) };
      }
      throw err;
    }
    const points = syncUserPoints(db, username);
    return { awarded: true, delta: rule.delta, points, level: levelInfo(points) };
  });
  return insert.immediate();
}

/** 管理员手动调分（正负均可，写入流水便于审计） */
function adjust(db, { username, delta, detail = '' }) {
  const value = Math.trunc(Number(delta));
  if (!Number.isFinite(value) || value === 0) return { ok: false, reason: 'invalid-delta' };
  if (Math.abs(value) > 500) return { ok: false, reason: 'out-of-range' };
  if (!userExists(db, username)) return { ok: false, reason: 'no-user' };
  const run = db.transaction(() => {
    const now = Date.now();
    db.prepare(
      'INSERT INTO point_events (username, delta, reason, detail, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(username, value, 'admin_adjust', String(detail || ''), 'admin:' + now + ':' + Math.random().toString(36).slice(2, 8), now);
    const points = syncUserPoints(db, username);
    return { ok: true, points, level: levelInfo(points) };
  });
  return run.immediate();
}

function recentEvents(db, username, limit = 10) {
  const rows = db.prepare(
    'SELECT delta, reason, detail, created_at FROM point_events WHERE username = ? ORDER BY id DESC LIMIT ?'
  ).all(username, limit);
  return rows.map((row) => ({
    delta: row.delta,
    code: row.reason,
    label: (RULES[row.reason] || {}).label || row.reason,
    detail: row.detail || '',
    createdAt: row.created_at
  }));
}

function rankOf(db, username) {
  const rows = db.prepare('SELECT username FROM users ORDER BY points DESC, created_at ASC, id ASC').all();
  const index = rows.findIndex((row) => row.username === username);
  return { rank: index < 0 ? null : index + 1, total: rows.length };
}

/** 个人积分概览：总分、等级、排名、最近流水、规则表 */
function overview(db, username) {
  const points = readPoints(db, username);
  const { rank, total } = rankOf(db, username);
  return {
    points,
    level: levelInfo(points),
    rank,
    totalUsers: total,
    recent: recentEvents(db, username, 10),
    rules: ruleList(),
    levels: LEVELS.map((item) => ({
      level: item.level,
      title: item.title,
      badge: item.badge,
      min: item.min
    }))
  };
}

const LEADERBOARD_SQL = `
  SELECT u.id, u.username, u.points, u.role, u.created_at,
    (SELECT COUNT(*) FROM items i WHERE i.publisher = u.username) AS published,
    (SELECT COUNT(*) FROM items i WHERE i.publisher = u.username AND i.type = 'found' AND i.status = 'resolved') AS returned,
    (SELECT COUNT(*) FROM items i WHERE i.publisher = u.username AND i.type = 'lost' AND i.status = 'resolved') AS recovered
  FROM users u
  ORDER BY u.points DESC, u.created_at ASC, u.id ASC
`;

/** 全体用户积分总榜（含 0 分用户，管理员可完整查看） */
function leaderboard(db, { limit = 0 } = {}) {
  const rows = db.prepare(LEADERBOARD_SQL).all();
  const list = rows.map((row, index) => ({
    rank: index + 1,
    id: row.id,
    username: row.username,
    points: Number(row.points) || 0,
    role: row.role || 'user',
    level: levelInfo(row.points),
    published: row.published,
    returned: row.returned,
    recovered: row.recovered,
    createdAt: row.created_at
  }));
  return limit > 0 ? list.slice(0, limit) : list;
}

/** 榜单统计：总发放积分、人均、最高分、有分用户数 */
function boardSummary(db) {
  const row = db.prepare(
    `SELECT COUNT(*) AS users, COALESCE(SUM(points), 0) AS total,
            COALESCE(MAX(points), 0) AS max, SUM(CASE WHEN points > 0 THEN 1 ELSE 0 END) AS active
     FROM users`
  ).get();
  const events = db.prepare('SELECT COUNT(*) AS c FROM point_events').get().c;
  return {
    users: Number(row.users) || 0,
    totalPoints: Number(row.total) || 0,
    maxPoints: Number(row.max) || 0,
    activeUsers: Number(row.active) || 0,
    avgPoints: row.users ? Math.round((Number(row.total) || 0) / row.users) : 0,
    events: Number(events) || 0
  };
}

/**
 * 历史数据回填：按已有启事补算积分，幂等（ref=publish:<id> / resolve:<id>）。
 * - 发布：招领 +5、寻物 +2（不受每日上限限制）
 * - 已解决：招领 +60、寻物 +15
 * 只在启动时执行一次，已存在的 ref 自动跳过。
 */
function backfill(db) {
  const items = db.prepare(
    "SELECT id, type, status, publisher FROM items WHERE publisher != '' AND publisher IS NOT NULL"
  ).all();
  const existsUser = db.prepare('SELECT 1 FROM users WHERE username = ?');
  const existsRef = db.prepare('SELECT 1 FROM point_events WHERE username = ? AND ref = ?');
  const insert = db.prepare(
    'INSERT INTO point_events (username, delta, reason, detail, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const touched = new Set();
  let added = 0;

  const run = db.transaction(() => {
    for (const item of items) {
      const username = item.publisher;
      if (!existsUser.get(username)) continue; // 演示/种子数据没有真实账号，跳过
      const publishCode = item.type === 'found' ? 'publish_found' : 'publish_lost';
      const publishRef = 'publish:' + item.id;
      if (!existsRef.get(username, publishRef)) {
        insert.run(username, RULES[publishCode].delta, publishCode, '历史启事 #' + item.id, publishRef, Date.now());
        touched.add(username);
        added += 1;
      }
      if (item.status === 'resolved') {
        const code = item.type === 'found' ? 'resolve_found' : 'resolve_lost';
        const ref = 'resolve:' + item.id;
        if (!existsRef.get(username, ref)) {
          insert.run(username, RULES[code].delta, code, '历史启事 #' + item.id + ' 已' + (item.type === 'found' ? '认领' : '找回'), ref, Date.now());
          touched.add(username);
          added += 1;
        }
      }
    }
    for (const username of touched) syncUserPoints(db, username);
  });
  run.immediate();
  return { added, users: touched.size };
}

module.exports = {
  LEVELS,
  RULES,
  DAILY_PUBLISH_CAP,
  DAILY_RESOLVE_CAP,
  levelInfo,
  ruleList,
  award,
  adjust,
  overview,
  leaderboard,
  boardSummary,
  recentEvents,
  syncUserPoints,
  backfill
};
