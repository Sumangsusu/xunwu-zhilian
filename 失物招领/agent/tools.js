const { db, mapItem, publicItem } = require('../db');
const { coordinates } = require('../coordinates');
const { CAMPUS_ZONES } = require('../public/js/campus-map');
const { normalize, objectOf } = require('./profile');
const catalog = [
  { name: 'search_items', description: '按物品和地点查询在架记录', arguments: { keyword: '物品词，最多40字', type: 'lost 或 found', location: '地点，可空' } },
  { name: 'get_item', description: '查看在架启事，或本人、管理员有权查看的历史启事', arguments: { item_id: '正整数' } },
  { name: 'find_matches', description: '读取指定启事后查找相反类型的相似在架记录', arguments: { item_id: '正整数' } },
  { name: 'list_my_items', description: '查询当前登录用户的最近启事及结案状态', arguments: {} }
];
function getVisible(id, user) {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('请提供有效的启事编号。');
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  if (!row || (row.status !== 'active' && row.publisher !== user.username && user.role !== 'admin')) {
    throw new Error('启事不存在或当前不可查看。');
  }
  return mapItem(row);
}
// Agent 和模型只收到检索字段。联系方式、问答与身份信息留在原有鉴权接口中。
function card(item) {
  const visible = publicItem({ ...item, ...coordinates(item) });
  const { id, type, title, category, color, location, date, status, mapX, mapY, lng, lat } = visible;
  return { id, type, title, category, color, location, date, status, mapX, mapY, lng, lat };
}
function zoneAt(point) {
  return CAMPUS_ZONES.find(z => point.mapX != null && point.mapY != null &&
    point.mapX >= z.x && point.mapX <= z.x + z.w && point.mapY >= z.y && point.mapY <= z.y + z.h);
}
// 示意图上点到建筑还有一点距离时，按最近的建筑区域匹配，避免“点在路边就说没有结果”。
function zoneNear(at, maxUnits = 60) {
  const exact = zoneAt(at);
  if (exact) return { zone: exact, approximate: false };
  if (!Number.isFinite(at.mapX) || !Number.isFinite(at.mapY)) return { zone: null, approximate: false };
  let best = null, bestDistance = Infinity;
  for (const zone of CAMPUS_ZONES) {
    const dx = Math.max(zone.x - at.mapX, 0, at.mapX - (zone.x + zone.w));
    const dy = Math.max(zone.y - at.mapY, 0, at.mapY - (zone.y + zone.h));
    const gap = Math.hypot(dx, dy);
    if (gap < bestDistance) { bestDistance = gap; best = zone; }
  }
  return bestDistance <= maxUnits ? { zone: best, approximate: true } : { zone: null, approximate: false };
}
function distance(a, b) {
  const rad = v => v * Math.PI / 180;
  const term = Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, term)));
}
function textArg(value, max = 40) {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > max) throw new Error('检索条件格式不正确。');
  return value.trim();
}
function search(args, context) {
  const keyword = normalize(context.profile.keyword || textArg(args.keyword));
  const place = textArg(context.profile.place || args.location);
  const type = context.profile.type || args.type;
  if (!['lost', 'found', 'all'].includes(type)) throw new Error('启事类型无效。');
  const sql = type === 'all'
    ? "SELECT * FROM items WHERE status = 'active' ORDER BY id DESC"
    : "SELECT * FROM items WHERE status = 'active' AND type = ? ORDER BY id DESC";
  const rows = db.prepare(sql).all(...(type === 'all' ? [] : [type]));
  const items = rows.map(mapItem).filter(item => {
    const text = normalize([item.title, item.category, item.description, ...item.features].join(' '));
    return (!keyword || text.includes(keyword)) &&
      (!context.profile.color || normalize(item.color + item.title + item.description).includes(context.profile.color)) &&
      context.profile.features.every(feature => text.includes(normalize(feature)));
  });
  const allCandidates = items.map(item => ({ item, point: coordinates(item) }));
  let candidates = allCandidates;
  let notice = '';
  if (context.nearby) {
    const at = context.location;
    if (!at) throw new Error('请先在地图选择这次搜索的位置，或直接告诉我校园地点。');
    const byPlace = place
      ? allCandidates.filter(({ item }) => normalize(item.location).includes(normalize(place)))
      : [];
    if (at.lng != null) {
      // 示意坐标并非实测，按距离硬筛容易把用户明确说出的地点漏掉：
      // 先取“既符合地点文字又在范围内”的记录，再退回地点文字，最后才放宽距离。
      const within = (radius, subset = allCandidates) => subset
        .filter(({ point }) => point.lng != null && point.lat != null)
        .map(entry => ({ ...entry, distance: distance(at, entry.point) }))
        .filter(entry => entry.distance <= radius)
        .sort((a, b) => a.distance - b.distance);
      candidates = within(at.radius_m, byPlace.length ? byPlace : allCandidates);
      notice = '附近结果包含已登记坐标的记录，距离为近似直线距离。';
      if (!candidates.length && byPlace.length) {
        candidates = byPlace;
        notice = '选点 ' + at.radius_m + ' 米内暂无匹配记录，已按地点“' + place + '”展示全校结果（坐标为示意估算，仅供参考）。';
      }
      if (!candidates.length) {
        const wider = within(5000);
        if (wider.length) {
          candidates = wider;
          notice = '选点 ' + at.radius_m + ' 米内暂无记录，已扩大到全校范围（距离为示意估算，仅供参考）。';
        }
      }
    } else {
      const picked = zoneNear(at);
      if (!picked.zone) throw new Error('请在示意图的建筑区域内选点，或输入地点名称。');
      const inZone = allCandidates.filter(({ point }) => zoneAt(point)?.name === picked.zone.name);
      candidates = byPlace.length ? inZone.filter(entry => byPlace.includes(entry)) : inZone;
      notice = '正在查找' + picked.zone.name + '区域内的记录。示意图按区域筛选。' +
        (picked.approximate ? '（选点靠近该建筑，已按最近区域匹配）' : '');
      if (!candidates.length && byPlace.length) {
        candidates = byPlace;
        notice = '选点区域暂无匹配记录，已按地点“' + place + '”展示全校结果。';
      }
    }
  } else if (place) {
    candidates = allCandidates.filter(({ item }) => normalize(item.location).includes(normalize(place)));
  }
  const result = candidates.slice(0, 6).map(({ item, distance: meters }) => ({
    ...card(item), ...(meters == null ? {} : { distance_m: Math.round(meters / 100) * 100 })
  }));
  const hotspots = new Map();
  for (const { item } of candidates) hotspots.set(item.location, (hotspots.get(item.location) || 0) + 1);
  return { items: result, total: candidates.length, notice,
    hotspots: [...hotspots].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([location, count]) => ({ location, count })) };
}
function matches(args, context) {
  const source = getVisible(args.item_id, context.user);
  const category = objectOf(source.title + ' ' + source.description);
  const rows = db.prepare("SELECT * FROM items WHERE status = 'active' AND type != ? ORDER BY id DESC").all(source.type);
  const scored = rows.map(mapItem).map(item => {
    let score = 0;
    const evidence = [];
    const add = (condition, amount, reason) => { if (condition) { score += amount; evidence.push(reason); } };
    add(category && category === objectOf(item.title + ' ' + item.description), 40, '物品名称相近');
    add(item.category === source.category, 15, '分类相同');
    add(source.color && source.color !== '未知' && item.color === source.color, 20, '颜色相同');
    add(item.location === source.location, 15, '登记地点相同');
    add(item.date === source.date, 10, '登记日期相同');
    return { ...card(item), similarity: score, evidence };
  }).filter(item => item.similarity >= 35).sort((a, b) => b.similarity - a.similarity || b.id - a.id);
  return { items: scored.slice(0, 6), total: scored.length, source_id: source.id, notice: '匹配评分用于排序，请通过详情中的防冒领问答进一步核对。' };
}
function execute(name, args, context) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数格式错误。');
  switch (name) {
    case 'search_items': return search(args, context);
    case 'get_item': return { items: [card(getVisible(args.item_id, context.user))], total: 1 };
    case 'find_matches': return matches(args, context);
    case 'list_my_items': {
      const rows = db.prepare('SELECT * FROM items WHERE publisher = ? ORDER BY id DESC LIMIT 6').all(context.user.username);
      const total = db.prepare('SELECT COUNT(*) AS n FROM items WHERE publisher = ?').get(context.user.username).n;
      return { items: rows.map(row => card(mapItem(row))), total };
    }
    default: throw new Error('此操作不可用。');
  }
}
module.exports = { catalog, execute };
