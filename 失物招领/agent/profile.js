// Adapted from UniFound chinese_text.py and item_profiles.py (MIT).
const { CAMPUS_ZONES } = require('../public/js/campus-map');
const GROUPS = [
  ['笔记本电脑', '电脑', '笔电', 'laptop'],
  ['水杯', '保温杯', '马克杯', '杯子', '水壶', 'water bottle'],
  ['校园卡', '一卡通', '学生卡', '饭卡'], ['耳机', '蓝牙耳机', 'airpods', 'headphones'],
  ['背包', '书包', '双肩包'], ['手机', '移动电话', 'iphone'], ['钱包', '钱夹'],
  ['钥匙', '锁匙'], ['雨伞', '伞'], ['眼镜'], ['手表'], ['书本', '课本', '教材', '书籍'],
  ['证件', '身份证', '护照'], ['充电宝'], ['充电器'], ['U盘', 'u盘'], ['计算器']
];
const QUESTIONS = {
  水杯: ['杯身颜色', '品牌或容量', '杯盖或贴纸特征'],
  校园卡: ['卡套颜色', '卡套或挂绳特征'],
  耳机: ['耳机品牌型号', '耳机盒颜色', '保护套特征'],
  手机: ['手机品牌型号', '手机壳颜色', '外观标记'],
  钥匙: ['钥匙数量', '钥匙扣特征'], 钱包: ['钱包颜色材质', '品牌或外观标记'],
  背包: ['背包颜色品牌', '挂件或图案'], 雨伞: ['伞面颜色图案', '长柄还是折叠', '伞柄特征'],
  笔记本电脑: ['电脑品牌型号', '外壳颜色贴纸'], 书本: ['书名或课程', '封面颜色'],
  眼镜: ['镜框颜色材质', '镜框形状'], 手表: ['手表品牌型号', '表带颜色材质']
};
const PLACES = [...CAMPUS_ZONES.map(z => z.name), '教学楼', '宿舍', '公寓', '樱顶', '梅园', '桂园', '枫园', '湖滨', '工学部', '信息学部'];
const aliases = GROUPS.flatMap(group => group.map(alias => [alias.toLowerCase(), group[0].toLowerCase()]))
  .sort((a, b) => b[0].length - a[0].length);
const escaped = s => s.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
const aliasPattern = new RegExp(aliases.map(([alias]) => escaped(alias)).join('|'), 'gi');
const aliasMap = new Map(aliases);
function normalize(text) {
  return String(text || '').toLowerCase().replace(aliasPattern, value => aliasMap.get(value.toLowerCase()));
}
function objectOf(text) {
  const normalized = normalize(text);
  return GROUPS.find(group => normalized.includes(group[0].toLowerCase()))?.[0] || '';
}
function profileFor(message, history = []) {
  const turns = [...history.filter(t => t.role === 'user').map(t => t.content), message];
  let object = '', facts = [];
  for (const turn of turns) {
    const detected = objectOf(turn);
    if (detected && detected !== object) { object = detected; facts = []; }
    facts.push(turn);
  }
  let place = '', color = '', type = 'found';
  const supplied = new Map();
  for (const fact of facts) {
    const detected = PLACES.filter(p => fact.includes(p)).sort((a, b) => b.length - a.length)[0];
    if (detected) place = detected;
    if (/不限地点|所有地点|全校|换个地方/.test(fact)) place = '';
    const colorMatch = fact.match(/(黑|白|红|蓝|绿|黄|粉|紫|灰|银|棕)(?:色|的)/);
    if (colorMatch) color = colorMatch[1] + '色';
    if (fact.includes('透明')) color = '透明';
    if (/不限颜色|颜色不清楚/.test(fact)) color = '';
    if (/捡到|拾到|寻物启事/.test(fact)) type = 'lost';
    if (/丢了|丢失|遗失|招领记录|失物招领/.test(fact)) type = 'found';
    if (/失物和招领|失物与招领/.test(fact)) type = 'all';
    for (const line of fact.split('\n')) {
      const match = /^([^：:]{2,25})[：:]\s*(.{1,60})$/.exec(line.trim());
      if (match) supplied.set(match[1], match[2]);
    }
  }
  const labels = [...(QUESTIONS[object] || []), '最后出现的地点'];
  const features = labels.filter(label => !label.includes('地点') && !label.includes('颜色'))
    .map(label => supplied.get(label)).filter(value => value && !/^(不清楚|不知道|不记得|无|没有)$/.test(value));
  const questions = object ? labels.filter(label => !supplied.has(label) &&
    !(color && label.includes('颜色')) && !(place && label.includes('地点'))).slice(0, 3) : [];
  const quoted = message.match(/[“「"]([^”」"]{1,40})[”」"]/);
  return { object, keyword: object || quoted?.[1] || '', type, place, color, features,
    questions: questions.map(label => ({ label, placeholder: '不记得可填“不清楚”' })) };
}
function localPlan(message, profile) {
  if (/^(你好[！!]?|您好|帮助|怎么用|hi|hello)$/i.test(message.trim())) {
    return { answer: '你好，我是寻物智联助手。告诉我物品和地点，例如“我在图书馆丢了黑色水杯”。我也可以查相似启事、查看启事状态，或查找地图选点附近的记录。' };
  }
  if (/系统提示词|泄露密钥|绕过权限|提升权限|reveal secret|bypass auth/i.test(message)) {
    return { answer: '我可以帮你查找校园物品和启事状态。请描述物品、地点或启事编号。' };
  }
  if (/认领申请|申请进度/.test(message)) {
    return { answer: '寻物智联通过物品详情里的防冒领问答核实线索。答对后可查看联系方式，归还后由发布者或管理员结案。你可以输入“查看物品 3 的状态”。' };
  }
  if (/发布|登记|提交认领|帮我认领/.test(message) && !/我的发布|我发布的|我之前发布/.test(message)) {
    return { answer: '你可以使用下方“发布启事”填写物品信息，或打开搜索结果的详情完成防冒领问答。', action: 'publish' };
  }
  if (/识别|分析图片|图像/.test(message)) {
    return { answer: '请打开“智能识别”上传图片，提取物品特征后，可以把品牌、颜色和类别告诉我继续查找。', action: 'recognize' };
  }
  const id = /(?:物品|启事|编号|item|#)\s*[#：:]?\s*(\d+)/i.exec(message)?.[1];
  if (id) return { tool: /匹配|相似|match/i.test(message) ? 'find_matches' : 'get_item', arguments: { item_id: Number(id) } };
  if (/我的发布|我发布的|我之前发布|我的启事/.test(message)) return { tool: 'list_my_items', arguments: {} };
  if (!profile.keyword && !/附近|所有|全部|最近.*(招领|寻物)/.test(message)) {
    return { answer: '请补充要找的物品，例如水杯、校园卡、耳机。也可以把物品名称放在引号里搜索。' };
  }
  return { tool: 'search_items', arguments: { keyword: profile.keyword, type: profile.type, location: profile.place } };
}
module.exports = { normalize, objectOf, profileFor, localPlan };
