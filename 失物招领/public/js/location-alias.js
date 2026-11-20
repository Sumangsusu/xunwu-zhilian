// ==================== 地点别名归一化模块 ====================
// 目标：让"同一地点的多种表述"互相匹配，检索不再卡死在字面一字不差。
// 例：发布者写"信息学部一教"，检索者输入"一教 / 第一教学楼 / 教一 / 1教 / 教学楼一"
//     都应命中；"图书馆 / 图馆 / library"、"校医院 / 医务室"同理。
//
// 设计（第一性原理）：地点检索的本质是"把不同字面映射到同一实体"，分三层解决：
//   1) 强归一化 normalize()：全角转半角、大小写、中文数字→阿拉伯、去修饰词与标点、
//      同义词合并（教学楼→教、餐厅→食堂…），让规则化表述天然收敛到同一形式；
//   2) 别名表 LOCATION_ALIASES：覆盖无法用规则推导的叫法（珞珈湖→湖畔花园等）；
//   3) 双向 token 匹配 tokens()/matchText()：既做归一化子串包含（保留原能力），
//      又做"查询与文本是否指向同一地点键"的集合交集，从而兼顾召回与精度。
//
// 兼容：本文件顶层只有数据与纯函数，无 window/document 依赖。
//   - Node：require('./public/js/location-alias')（后端检索接口与验收脚本用）
//   - 浏览器：挂到 window.LocationAlias（found.html / lost.html 用）
//   - 小程序：同内容的副本放 utils/location-alias.js（小程序不能跨目录 require）
//   验收脚本会对两端副本做一致性校验，避免改了一端忘了另一端。
// 合规：不引用任何外部 URL / key，不接收或返回联系方式 / 描述正文以外的敏感字段。

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.LocationAlias = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---------- 1. 基础字符归一化 ----------

  // 全角 → 半角（含全角空格）。只处理常见可见 ASCII 区，避免动到中文标点语义。
  function toHalfWidth(text) {
    return String(text == null ? '' : text).replace(/[\uFF01-\uFF5E]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
    }).replace(/\u3000/g, ' ');
  }

  // 中文数字 → 阿拉伯数字。按顺序处理，先长后短，避免"十"被"一"拆开误判。
  const CN_DIGITS = {
    '零': '0', '〇': '0', '一': '1', '二': '2', '两': '2', '三': '3', '四': '4',
    '五': '5', '六': '6', '七': '7', '八': '8', '九': '9'
  };
  function cnNumberToArabic(text) {
    let s = String(text == null ? '' : text);
    s = s.replace(/十([零〇一二两三四五六七八九])/g, function (_m, d) {
      return '1' + (CN_DIGITS[d] || '');
    });
    s = s.replace(/([一二两三四五六七八九])十([零〇一二两三四五六七八九])?/g, function (_m, t, d) {
      return (CN_DIGITS[t] || '') + (d ? CN_DIGITS[d] : '0');
    });
    s = s.replace(/[零〇一二两三四五六七八九十]/g, function (ch) {
      return CN_DIGITS[ch] || '十';
    });
    return s;
  }

  // 无意义修饰词 / 泛称：这些词出现在地点里不改变实体，去掉以提升收敛率。
  // 长词在前，避免"学部"先于"信息学部"命中导致残留"信息"。
  const FILLER_WORDS = [
    '武汉大学', '珞珈山', '珞珈', '信息学部', '工学部', '理学部', '文学部', '文科部',
    '医学部', '学部', '校区', '校园', '校内', '武大', '学校', '本校',
    '附近', '旁边', '边上', '里面', '周围', '一带', '这边', '那边', '处',
    '的', '在', '第', '号', '座', '栋', '幢', '层', '楼' // 单独的"楼"在"教学楼→教"后已无意义
  ];

  // 同义 / 近义词合并：长词优先，避免"教学楼"被"教"先命中。
  const SYNONYMS = [
    ['教学楼', '教'], ['教学楼', '教'],
    ['图书馆', '图书馆'], ['图书管', '图书馆'], ['图馆', '图书馆'], ['library', '图书馆'],
    ['餐厅', '食堂'], ['饭堂', '食堂'], ['dininghall', '食堂'],
    ['公寓', '宿舍'], ['寝室', '宿舍'], ['dorm', '宿舍'],
    ['医务室', '校医院'], ['校医室', '校医院'], ['hospital', '校医院'],
    ['体育场', '体育馆'], ['文体馆', '体育馆'], ['gym', '体育馆'],
    ['运动场', '操场'], ['田径场', '操场'],
    ['小卖部', '超市'], ['便利店', '超市'], ['商店', '超市'], ['market', '超市'],
    ['校门口', '校门'], ['大门', '校门'], ['gate', '校门'],
    ['行政大楼', '行政楼'], ['办公楼', '行政楼'],
    ['保卫科', '保卫处'], ['美术馆', '艺术楼'],
    ['湖畔', '湖畔花园'], ['珞珈湖', '湖畔花园'], ['人工湖', '湖畔花园'],
    ['校车站', '校车站牌'], ['车站牌', '校车站牌'], ['班车点', '校车站牌']
  ];

  // 只保留有意义的字符：中文、字母、数字；其余（标点/空白）删除。
  function stripNoise(text) {
    return String(text == null ? '' : text).replace(/[^\u4e00-\u9fa5a-z0-9]/g, '');
  }

  /**
   * 地点文本归一化。纯函数，同样的输入永远得到同样的输出。
   * 步骤：全角→半角 → 小写 → 中文数字→阿拉伯 → 同义词合并 → 去修饰词 → 去噪 → 数字/教顺序统一。
   */
  function normalize(text) {
    let s = toHalfWidth(text).toLowerCase();
    s = cnNumberToArabic(s);
    for (const pair of SYNONYMS) {
      if (s.indexOf(pair[0]) !== -1) s = s.split(pair[0]).join(pair[1]);
    }
    for (const word of FILLER_WORDS) {
      if (s.indexOf(word) !== -1) s = s.split(word).join('');
    }
    s = stripNoise(s);
    // "教1" 与 "1教" 统一为 "1教"；字母座同理 "教a" → "a教"（教学楼A座 / a教 / A座收敛到一键）。
    s = s.replace(/教([a-z0-9]{1,2})/g, '$1教');
    // 折叠重复字符，避免"一一教"之类噪声导致漏配。
    s = s.replace(/(.)\1+/g, '$1');
    return s;
  }

  // ---------- 2. 别名表（规则无法推导的叫法） ----------
  // canonical key 用归一化后的形式书写，避免运行时再翻译。
  const LOCATION_ALIASES = {
    '图书馆': ['图书馆', '图书管', '图馆', 'library', '借阅室'],
    '校医院': ['校医院', '医务室', '校医室', '医院', 'hospital'],
    '体育馆': ['体育馆', '体育场', '文体馆', 'gym', '室内体育馆'],
    '操场': ['操场', '运动场', '田径场', '篮球场', '球场'],
    '食堂': ['食堂', '餐厅', '饭堂', '大食堂', '第一食堂', '一食堂', '二食堂'],
    '超市': ['超市', '小卖部', '便利店', '商店', 'market'],
    '宿舍': ['学生公寓', '宿舍', '公寓', '寝室', 'dorm', '几舍'],
    '校门': ['校门', '校门口', '大门', '南门', '北门', '东门', '西门', 'gate'],
    '行政楼': ['行政楼', '行政大楼', '办公楼'],
    '保卫处': ['保卫处', '保卫科'],
    '艺术楼': ['艺术楼', '艺术学院', '美术馆'],
    '湖畔花园': ['湖畔花园', '湖畔', '珞珈湖', '人工湖'],
    '校车站牌': ['校车站牌', '校车站', '车站牌', '班车点'],
    // 教学楼 A/B 座：与"数字教"体系区分，单独成键。
    'a教': ['教学楼a座', 'a教', '教a', '教学楼a', 'a座', 'a座教学楼'],
    'b教': ['教学楼b座', 'b教', '教b', '教学楼b', 'b座', 'b座教学楼']
  };

  // 归一化后的别名 → canonical key 索引（启动时构建一次）。
  const ALIAS_INDEX = Object.create(null);
  for (const key of Object.keys(LOCATION_ALIASES)) {
    for (const alias of LOCATION_ALIASES[key]) {
      const n = normalize(alias);
      if (n) ALIAS_INDEX[n] = key;
    }
  }

  // 教学楼数字键的识别范围：1~30 教，避免把随机数字（如"301"）误判成地点。
  const TEACHING_BUILDING_MAX = 30;

  /**
   * 抽取一段文本指向的所有地点键（集合）。
   * 规则：归一化后精确命中别名索引，或包含某个别名，或形如"N教"。
   */
  function tokens(text) {
    const n = normalize(text);
    const found = Object.create(null);
    if (!n) return [];
    for (const aliasNorm of Object.keys(ALIAS_INDEX)) {
      if (aliasNorm && n.indexOf(aliasNorm) !== -1) found[ALIAS_INDEX[aliasNorm]] = true;
    }
    // 数字左边界：确保 "1教" 不会从 "301教室" 的尾部 "01教" 误命中。
    const tbRe = /(^|[^\d])(\d{1,2})教/g;
    let tb;
    while ((tb = tbRe.exec(n)) !== null) {
      const num = Number(tb[2]);
      if (num >= 1 && num <= TEACHING_BUILDING_MAX) found['教' + num] = true;
    }
    return Object.keys(found);
  }

  /**
   * 关键词与一段文本是否"指向同一地点 / 内容命中"。
   * 保留原 includes 语义（归一化后互相包含），再叠加地点键交集。
   * 单字符查询不做包含匹配（避免"一"命中"301"之类误伤），只认精确或同键。
   */
  function matchText(keyword, text) {
    const nk = normalize(keyword);
    const nt = normalize(text);
    if (!nk || !nt) return false;
    if (nk === nt) return true;

    const ks = tokens(keyword);
    if (ks.length) {
      // 查询是已知地点：只认地点键交集，不走子串。
      // 否则 normalize('一教')='1教' 会作为子串误命中 '301教室'。
      // 文本若真指向该地点，其别名必然能被 tokens 识别，不会出现漏配。
      const kt = tokens(text);
      for (const k of ks) if (kt.indexOf(k) !== -1) return true;
      return false;
    }

    // 普通关键词：保持原 includes 语义（文本包含查询），单字符不做包含以免误伤。
    // 注意：这里刻意不做 nk.indexOf(nt) 的反向包含，与原前端行为一致。
    if (nk.length > 1 && nt.indexOf(nk) !== -1) return true;
    return false;
  }

  /**
   * 地点字段专用匹配：与 matchText 一致，单独暴露是为了让调用方语义清晰，
   * 也便于将来给地点字段加更严格的策略（如只允许地点键命中）。
   */
  function matchLocation(keyword, location) {
    return matchText(keyword, location);
  }

  /**
   * 关键词是否命中一条启事：标题 / 地点 / 分类 / 颜色 / 描述任一字段命中即可。
   * 描述字段用 matchText 是为了"信息学部一教"能在描述里被"一教"找到，
   * 但不会把联系方式 / 防冒领问答参与匹配（这些字段根本没传进来）。
   */
  function matchItem(keyword, item) {
    if (!keyword || !item) return true; // 空关键词 = 不过滤（与前端现有行为一致）
    const fields = [item.title, item.location, item.category, item.color, item.description];
    for (const field of fields) {
      if (field && matchText(keyword, field)) return true;
    }
    return false;
  }

  /**
   * 把一个查询词扩展成"等价地点表述"列表，供需要生成候选 SQL 参数或展示提示的场景使用。
   * 例：expandAliases('一教') → ['一教','1教','第一教学楼','教一',…]
   */
  function expandAliases(keyword) {
    const n = normalize(keyword);
    const out = [];
    const keys = tokens(keyword);
    for (const key of keys) {
      const aliases = LOCATION_ALIASES[key];
      if (aliases) for (const a of aliases) out.push(a);
      if (/^教\d+$/.test(key)) {
        const num = key.slice(1);
        out.push(num + '教', '第' + num + '教学楼', '教' + num, '教学楼' + num);
      }
    }
    if (!out.length && n) out.push(n);
    return Array.from(new Set(out));
  }

  return {
    normalize: normalize,
    tokens: tokens,
    matchText: matchText,
    matchLocation: matchLocation,
    matchItem: matchItem,
    expandAliases: expandAliases,
    LOCATION_ALIASES: LOCATION_ALIASES
  };
});
