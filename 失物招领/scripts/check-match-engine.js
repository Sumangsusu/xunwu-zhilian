#!/usr/bin/env node
/**
 * 寻物智联 · 双向撮合验收脚本（零依赖，better-sqlite3 来自项目依赖）
 *
 * 用法：在「失物招领/」目录下执行
 *     node scripts/check-match-engine.js
 * 退出码：0 = 全部通过；1 = 存在失败项
 *
 * 覆盖三层：
 *   1) matcher.js 纯评分逻辑真实执行（不是字符串断言）：地点别名 / 校区隔离 / 时间窗 / 阈值 / 限条数；
 *   2) 数据库层真实建表 + 执行 server.js 里的 SQL（从源码抽取，避免测试与实现漂移）：
 *      只返回在架启事、按发布者隔离、未读计数、UNIQUE 去重；
 *   3) 前端与接口接线：发布响应带 matches、个人中心渲染、导航红点、联系方式仍走 publicItem 脱敏。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const matcher = require(path.join(ROOT, 'matcher.js'));

let pass = 0;
let total = 0;
function check(name, ok, detail) {
  total += 1;
  if (ok) pass += 1;
  console.log((ok ? '[PASS] ' : '[FAIL] ') + name + (detail ? '  - ' + detail : ''));
}

// 构造一条启事（只放 mapItem 之后会出现的公开字段）
function item(over) {
  return Object.assign({
    id: 1,
    type: 'lost',
    title: '黑色钱包',
    category: '箱包类',
    color: '黑色',
    location: '三食堂二楼',
    date: '2026-11-20',
    features: [],
    publisher: 'u1',
    status: 'active'
  }, over);
}

console.log('寻物智联 · 双向撮合验收\n');

// ==================== 1. 评分逻辑 ====================
console.log('【1】matcher.scorePair 评分');

const full = matcher.scorePair(item({ id: 1 }), item({ id: 2, type: 'found', publisher: 'u2' }));
check('同日/同地点/同类别/同颜色/同标题 → 满分', full.score === 100, 'score=' + full.score);
check('满分时理由覆盖地点/时间/类别/颜色', ['同一地点', '同一天', '类别相同', '颜色相同'].every((r) => full.reasons.indexOf(r) !== -1), full.reasons.join('/'));

const alias = matcher.scorePair(
  item({ id: 1, location: '信息学部一教', date: '2026-11-20' }),
  item({ id: 2, type: 'found', publisher: 'u2', location: '第一教学楼', date: '2026-11-20' })
);
check('地点别名「信息学部一教 ↔ 第一教学楼」判为同一地点', alias.breakdown.location === 30, 'location=' + alias.breakdown.location);

const crossArea = matcher.scorePair(
  item({ id: 1, location: '信部一教' }),
  item({ id: 2, type: 'found', publisher: 'u2', location: '工学部一教' })
);
check('跨校区「信部一教 ✗ 工学部一教」地点不得分', !crossArea.breakdown.location, 'location=' + (crossArea.breakdown.location || 0));

const crossArea2 = matcher.scorePair(
  item({ id: 1, location: '信息学部一教' }),
  item({ id: 2, type: 'found', publisher: 'u2', location: '工学部一教' })
);
check('normalize 抹掉校区后仍不得跨校区匹配', !crossArea2.breakdown.location, 'location=' + (crossArea2.breakdown.location || 0));

const sameArea = matcher.scorePair(
  item({ id: 1, location: '信息学部一教' }),
  item({ id: 2, type: 'found', publisher: 'u2', location: '工学部图书馆', date: '2026-10-01' })
);
check('仅同校区（信息学部 vs 工学部）不成立', sameArea.breakdown.location === undefined, 'location=' + (sameArea.breakdown.location || 0));

const sameArea2 = matcher.scorePair(
  item({ id: 1, location: '信息学部一教' }),
  item({ id: 2, type: 'found', publisher: 'u2', location: '信息学部图书馆', date: '2026-10-01' })
);
check('同校区不同楼栋 → 12 分（低于楼栋级）', sameArea2.breakdown.location === 12, 'location=' + (sameArea2.breakdown.location || 0));

const nearTime = matcher.scorePair(
  item({ id: 1, date: '2026-11-20' }),
  item({ id: 2, type: 'found', publisher: 'u2', date: '2026-11-21' })
);
check('相差 1 天 → 15 分', nearTime.breakdown.time === 15, 'time=' + (nearTime.breakdown.time || 0));

const weekTime = matcher.scorePair(
  item({ id: 1, date: '2026-11-20' }),
  item({ id: 2, type: 'found', publisher: 'u2', date: '2026-11-26' })
);
check('相差 6 天 → 8 分', weekTime.breakdown.time === 8, 'time=' + (weekTime.breakdown.time || 0));

const farTime = matcher.scorePair(
  item({ id: 1, date: '2026-11-20' }),
  item({ id: 2, type: 'found', publisher: 'u2', date: '2026-09-01' })
);
check('相差两月 → 时间不得分', !farTime.breakdown.time, 'time=' + (farTime.breakdown.time || 0));

const badDate = matcher.scorePair(
  item({ id: 1, date: '上周三' }),
  item({ id: 2, type: 'found', publisher: 'u2', date: '上周四' })
);
check('非法日期不参与时间得分（不抛错）', !badDate.breakdown.time && Number.isFinite(badDate.score), 'score=' + badDate.score);

const unknownColor = matcher.scorePair(
  item({ id: 1, color: '未知', category: '箱包类' }),
  item({ id: 2, type: 'found', publisher: 'u2', color: '未知', category: '电子数码' })
);
check('颜色「未知」不给分', !unknownColor.breakdown.color, 'color=' + (unknownColor.breakdown.color || 0));

const sameType = matcher.scorePair(item({ id: 1 }), item({ id: 2, type: 'lost' }));
check('同类型（寻物↔寻物）直接 0 分', sameType.score === 0);

const textGrams = matcher.textGrams('黑色皮质钱包');
check('标题二元词忽略颜色词', !textGrams.has('黑色') && textGrams.has('钱包'), Array.from(textGrams).join(','));

// ==================== 2. 排序与阈值 ====================
console.log('\n【2】matcher.rank 阈值与过滤');

const own = item({ id: 10 });
const strong = item({ id: 11, type: 'found', publisher: 'u2', title: '黑色钱包', location: '三食堂二楼', date: '2026-11-20' });
const weak = item({ id: 12, type: 'found', publisher: 'u3', title: '蓝色雨伞', category: '其他物品', color: '蓝色', location: '图书馆', date: '2026-09-01' });
const selfPublished = item({ id: 13, type: 'found', publisher: 'u1', title: '黑色钱包', location: '三食堂二楼', date: '2026-11-20' });

const ranked = matcher.rank(own, [strong, weak, selfPublished]);
check('rank 只保留过阈值的一条', ranked.length === 1 && ranked[0].item.id === 11, 'hits=' + ranked.length);
check('rank 排除同一发布者的启事', ranked.every((hit) => hit.item.publisher !== own.publisher));
check('rank 结果带可读理由', Array.isArray(ranked[0].reasons) && ranked[0].reasons.length > 0, ranked[0].reasons.join('/'));
check('阈值常量为 60', matcher.THRESHOLD === 60, String(matcher.THRESHOLD));

const many = [];
for (let i = 0; i < 15; i += 1) {
  many.push(item({ id: 100 + i, type: 'found', publisher: 'u' + i, title: '黑色钱包', location: '三食堂二楼', date: '2026-11-20' }));
}
check('单条启事最多保留 10 条匹配', matcher.rank(own, many).length === 10, 'hits=' + matcher.rank(own, many).length);

const boundary = matcher.scorePair(
  item({ id: 1, location: '三食堂二楼', category: '箱包类', color: '黑色', title: '黑色钱包', date: '2026-11-19' }),
  item({ id: 2, type: 'found', publisher: 'u2', location: '食堂二楼', category: '箱包类', color: '黑色', title: '黑色钱包', date: '2026-11-20' })
);
check('楼栋级+相邻日+同类别+同颜色+标题重合 → 82 分', boundary.score === 82, 'score=' + boundary.score);

// ==================== 3. 数据库层：真实执行 server.js 里的 SQL ====================
console.log('\n【3】数据库层（内存库 + 源码抽取的 SQL）');

const serverSrc = read('server.js');
const dbSrc = read('db.js');
check('db.js 建了 item_matches 表并对 (item_id, match_id) 去重',
  /CREATE TABLE IF NOT EXISTS item_matches/.test(dbSrc) && /UNIQUE\(item_id, match_id\)/.test(dbSrc));
check('db.js 建了 (item_id, seen) 索引', /idx_item_matches_owner/.test(dbSrc));

const routeStart = serverSrc.indexOf("app.get('/api/matches'");
const routeEnd = serverSrc.indexOf("app.get('/api/matches/unread'");
const matchesBlock = serverSrc.slice(routeStart, routeEnd);
const matchesSql = (matchesBlock.match(/`([\s\S]*?)`/) || [])[1];
check('能从 server.js 抽到 /api/matches 的查询 SQL', Boolean(matchesSql) && /item_matches/.test(matchesSql || ''));

const unreadFn = (serverSrc.match(/const unreadMatchCount[\s\S]*?\.get\(username\)\.c/) || [''])[0];
const unreadSql = (unreadFn.match(/`([\s\S]*?)`/) || [])[1];
check('能从 server.js 抽到未读计数 SQL', Boolean(unreadSql) && /seen = 0/.test(unreadSql || ''));

const mem = new Database(':memory:');
mem.exec(`
CREATE TABLE items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL, title TEXT NOT NULL, category TEXT NOT NULL, color TEXT DEFAULT '未知',
  location TEXT NOT NULL, date TEXT NOT NULL, image TEXT DEFAULT '', description TEXT NOT NULL,
  contact TEXT NOT NULL, reward TEXT DEFAULT '', features TEXT DEFAULT '[]', publisher TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active', quiz TEXT DEFAULT '', map_x REAL, map_y REAL, lng REAL, lat REAL,
  created_at INTEGER NOT NULL
);
CREATE TABLE item_matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL, match_id INTEGER NOT NULL, score INTEGER NOT NULL,
  reasons TEXT NOT NULL DEFAULT '[]', seen INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  UNIQUE(item_id, match_id)
);
`);
const addItem = mem.prepare(
  'INSERT INTO items (id, type, title, category, color, location, date, description, contact, publisher, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
);
addItem.run(1, 'lost', '黑色钱包', '箱包类', '黑色', '三食堂二楼', '2026-11-20', 'd', '13800000000', 'u1', 'active', 1);
addItem.run(2, 'found', '黑色钱包', '箱包类', '黑色', '三食堂二楼', '2026-11-20', 'd', '13900000000', 'u2', 'active', 2);
addItem.run(3, 'lost', '校园卡', '证件文件', '蓝色', '图书馆', '2026-11-19', 'd', '13700000000', 'u1', 'resolved', 3);
addItem.run(4, 'found', '蓝色校园卡', '证件文件', '蓝色', '图书馆', '2026-11-19', 'd', '13600000000', 'u3', 'active', 4);

const addMatch = mem.prepare('INSERT OR IGNORE INTO item_matches (item_id, match_id, score, reasons, seen, created_at) VALUES (?,?,?,?,?,?)');
addMatch.run(1, 2, 82, '["同一地点"]', 0, 10);
addMatch.run(2, 1, 82, '["同一地点"]', 0, 10);
addMatch.run(3, 4, 90, '["同一地点"]', 0, 11);
const dup = addMatch.run(1, 2, 82, '[]', 0, 12);
check('UNIQUE(item_id, match_id) 阻止重复写入', dup.changes === 0, 'changes=' + dup.changes);

const rows = mem.prepare(matchesSql).all('u1');
check('/api/matches 只返回自己的在架启事', rows.length === 1 && rows[0].item_id === 1, 'rows=' + rows.length);
check('/api/matches 过滤已结案的对方启事', rows.every((row) => row.match_id !== 4));

const unreadRows = mem.prepare(unreadSql).all('u1');
check('未读计数 SQL 返回 1（排除已结案）', unreadRows[0].c === 1, 'c=' + unreadRows[0].c);

const afterSeen = mem.prepare('UPDATE item_matches SET seen = 1 WHERE item_id IN (SELECT id FROM items WHERE publisher = ?)').run('u1');
const otherUserSeen = mem.prepare('SELECT seen FROM item_matches WHERE item_id = 2').get().seen;
check('标记已读只影响自己的启事（对方仍为未读）',
  afterSeen.changes === 2 && otherUserSeen === 0,
  'changes=' + afterSeen.changes + ' other=' + otherUserSeen);
check('标记已读后未读数归零', mem.prepare(unreadSql).all('u1')[0].c === 0);

// ==================== 4. 接口与前端接线 ====================
console.log('\n【4】接口与前端接线');

check('发布成功后调用 persistMatches 并回传 matches',
  /hits = persistMatches\(item\)/.test(serverSrc) && /matches: hits\.map/.test(serverSrc));
check('撮合失败不会让发布失败（try/catch 包裹）',
  /try \{\s*hits = persistMatches\(item\);[\s\S]{0,120}\} catch/.test(serverSrc));
check('双向落库：同一对启事写两条记录',
  /insertMatch\.run\(item\.id, hit\.item\.id/.test(serverSrc) && /insertMatch\.run\(hit\.item\.id, item\.id/.test(serverSrc));
check('/api/auth/me 返回 matchUnread 供导航红点使用', /matchUnread: unreadMatchCount/.test(serverSrc));
check('启动时对历史数据补算匹配', /backfillMatches\(\)/.test(serverSrc) && /existing > 0/.test(serverSrc));
check('匹配结果仍走 publicItem 脱敏（联系方式不直接给出）', /publicItem\(mapItem\(other\)\)/.test(matchesBlock));
check('三个撮合接口都需要登录', (serverSrc.match(/app\.(get|post)\('\/api\/matches[^']*', authRequired/g) || []).length === 3);

const commonSrc = read('public/js/common.js');
check('前端 DB 暴露 getMatches / markMatchesSeen', /getMatches\(\)/.test(commonSrc) && /markMatchesSeen\(\)/.test(commonSrc));
check('导航红点函数存在且由 matchUnread 驱动', /function paintMatchBadge/.test(commonSrc) && /paintMatchBadge\(matchUnread\)/.test(commonSrc));
check('发布接口返回完整响应（含 matches）', /async add\(item\) \{ return await api\.post\('\/api\/items', item\); \}/.test(commonSrc));

const profileSrc = read('public/profile.html');
check('个人中心渲染疑似匹配列表', /async function renderMatches/.test(profileSrc) && /id="matchList"/.test(profileSrc));
check('匹配卡片用 esc 转义并复用详情弹窗', /esc\(other\.title/.test(profileSrc) && /showItemDetail\(\$\{Number\(other\.id\)/.test(profileSrc));
check('查看后自动标记已读', /DB\.markMatchesSeen\(\)/.test(profileSrc));

const publishSrc = read('public/publish.html');
check('发布页在有匹配时提示条数并跳转个人中心',
  /res\.matches/.test(publishSrc) && /profile\.html#matches/.test(publishSrc));

console.log('\n通过 ' + pass + '/' + total);
process.exit(pass === total ? 0 : 1);
