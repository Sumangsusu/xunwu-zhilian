// ==================== 地点别名归一化模块 ====================
// 目标：让"同一地点的多种表述"互相匹配，检索不再卡死在字面一字不差。
// 例：发布者写"信息学部一教"，检索者输入"一教 / 第一教学楼 / 教一 / 1教 / 教学楼一"
//     都应命中；"图书馆 / 图馆 / library"、"校医院 / 医务室"同理。
//
// 设计（第一性原理）：地点检索的本质是"把不同字面映射到同一实体"，分四层解决：
//   1) 强归一化 normalize()：全角转半角、大小写、中文数字→阿拉伯、去修饰词与标点、
//      同义词合并（教学楼→教、餐厅→食堂…），让规则化表述天然收敛到同一形式；
//   2) 别名表 LOCATION_ALIASES：覆盖无法用规则推导的叫法（珞珈湖→湖畔花园等）；
//   3) 校区/学部层 AREA_ALIASES：独立于 normalize，因为 normalize 会把"信息学部/工学部"
//      当修饰词删掉，"信息学部""信部"这类只指校区的查询会被清空 → 永远搜不到；
//   4) 双向 token 匹配 tokens()/matchText()：既做归一化子串包含（保留原能力），
//      又做"查询与文本是否指向同一地点键"的集合交集，从而兼顾召回与精度；
//   5) 查询侧片段召回 queryTokens()：用户输入地点名的任意连续片段（≥2字，如
//      "万林" → "万林艺术博物馆" → 艺术楼）都能归入该地点键，不再逐个地点补别名。
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

  // ---------- 2.5 校区 / 学部层（独立于 normalize） ----------
  // 为什么必须单开一层：normalize() 把「信息学部 / 工学部」当修饰词删掉（这样「一教」才能
  // 命中「信息学部一教」），副作用是校区信息也一起丢失 ——「信息学部」「信部」这类只指校区
  // 的查询归一化后变成空串，tokens 为空、字面包含也不成立，于是永远搜不到任何东西。
  // 这里用「不删修饰词」的轻归一化单独抽校区键，用 @ 前缀与教学楼层（教1）区分：
  //   tokens('信息学部一教') -> ['@信息学部', '教1']
  //   tokens('信部')         -> ['@信息学部']
  // 匹配时：两侧都指明校区就先校验校区一致，再做键交集，避免「信部一教」命中「工学部一教」。
  const AREA_ALIASES = {
    '信息学部': ['信息学部', '信部', '信息部', '信息学院', '信院'],
    '工学部': ['工学部', '工部', '工学院', '工院'],
    '医学部': ['医学部', '医部', '医学院', '医学校区'],
    '文理学部': ['文理学部', '文理部', '文部', '理学部', '文学部', '文学院', '理学院']
  };

  // 「工部」是「勤工部 / 社工部」的子串、「信部」是「通信部」的子串：落在这些更长的词里时不算校区。
  const AREA_FALSE_FRIENDS = ['勤工部', '社工部', '通信部', '信息部门'];

  // 不删修饰词的轻归一化：只做全角→半角、小写、去标点。
  function lightNormalize(text) {
    return stripNoise(toHalfWidth(text).toLowerCase());
  }

  const AREA_ALIAS_LIST = [];
  for (const key of Object.keys(AREA_ALIASES)) {
    for (const alias of AREA_ALIASES[key]) {
      const t = lightNormalize(alias);
      if (t) AREA_ALIAS_LIST.push({ key: '@' + key, text: t });
    }
  }
  // 长词优先：「文理学部」先于「理学部」被识别（二者同键，顺序影响可预期性）。
  AREA_ALIAS_LIST.sort(function (a, b) { return b.text.length - a.text.length; });

  /**
   * 从原始文本中扫描校区键。跑在 lightNormalize 结果上，因此不受 FILLER_WORDS 影响。
   */
  function scanAreas(text) {
    const s = lightNormalize(text);
    const found = Object.create(null);
    if (!s) return [];
    for (const item of AREA_ALIAS_LIST) {
      let from = 0;
      let idx;
      while ((idx = s.indexOf(item.text, from)) !== -1) {
        from = idx + item.text.length;
        let blocked = false;
        for (const bad of AREA_FALSE_FRIENDS) {
          const p = s.indexOf(bad);
          if (p !== -1 && idx >= p && idx < p + bad.length) { blocked = true; break; }
        }
        if (!blocked) { found[item.key] = true; break; }
      }
    }
    return Object.keys(found);
  }

  function isAreaKey(key) {
    return typeof key === 'string' && key.charAt(0) === '@';
  }

  /**
   * 查询侧的校区键：除字面命中别名外，还接受"校区名的不完整前缀"（如"信息学"→信息学部）。
   * 用户常只打一半；该规则只用于关键词侧，文本侧不启用，避免描述里的半截词误伤。
   */
  function queryAreaKeys(text) {
    const keys = scanAreas(text);
    const s = lightNormalize(text);
    if (s.length >= 2) {
      for (const item of AREA_ALIAS_LIST) {
        if (item.text.indexOf(s) === 0 && keys.indexOf(item.key) === -1) keys.push(item.key);
      }
    }
    return keys;
  }

  function intersect(a, b) {
    for (const key of a) if (b.indexOf(key) !== -1) return true;
    return false;
  }

  /**
   * 子串命中判定（带数字左边界保护）。
   * 返回 short 是否为 long 的连续片段，且不是更长数字串的尾部。
   * 例：substringHit('301教室','1教') = false（'1教' 是 '301' 的尾巴，不是独立地点）；
   *     substringHit('图书馆三楼自习室','图书馆') = true。
   */
  function substringHit(long, short) {
    if (!long || !short || short.length < 2) return false;
    const idx = long.indexOf(short);
    if (idx === -1) return false;
    // 短串以数字开头且在长串中前一个字符也是数字 → 是数字串的一部分，不算地点。
    if (/^[0-9]/.test(short) && idx > 0 && /[0-9]/.test(long.charAt(idx - 1))) return false;
    return true;
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
    // 万林艺术博物馆即学生口中的"艺术楼"，地图上标的是前者、启事里多写后者。
    // 登记整名后，查询侧片段召回（见 fragmentKeys）会让"万林 / 万林艺术 / 艺术博物馆"
    // 等任意片段都归入本键，无需为每种截断写法再补一条别名。
    '艺术楼': ['艺术楼', '艺术学院', '美术馆', '万林艺术博物馆', '万林艺术馆'],
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

  // ---------- 2.8 查询侧片段召回（通用部分关键字匹配） ----------
  // 为什么需要：tokens() 只认"完整别名"或"N教"规则。用户输"万林"时，它不是任何别名，
  // 于是 ks 为空、退回字面包含；而发布者写"艺术楼画室"，两者字面毫无交集 → 漏配。
  // 逐地点补别名（把"万林"也塞进别名表）只能修这一个词，来一个新地点又要改一次。
  // 通用做法：用 lightNormalize（不删修饰词/不做同义合并）保留别名原始字形，建立
  // "别名全文 → 地点键"索引；查询词只要是其中任一条的连续片段（≥2 字），就归入该键。
  // 例：万林 → 命中"万林艺术博物馆" → 艺术楼；艺术博物馆 → 同样命中；
  //     图书馆三楼 → 命中"图书馆" → 图书馆。文本侧仍用严格 tokens()，靠键交集保证精度。
  const FRAGMENT_ALIASES = [];
  for (const key of Object.keys(LOCATION_ALIASES)) {
    for (const alias of LOCATION_ALIASES[key]) {
      const t = lightNormalize(alias);
      if (t.length >= 2) FRAGMENT_ALIASES.push({ text: t, key: key });
    }
  }
  for (const item of AREA_ALIAS_LIST) {
    if (item.text.length >= 2) FRAGMENT_ALIASES.push({ text: item.text, key: item.key });
  }

  /**
   * 查询词命中的地点键（片段召回）。单字不参与，避免"一 / 的"之类泛字误伤。
   * 只用于查询侧；文本侧不启用，防止描述里的半截词把不相关启事拉进来。
   */
  function fragmentKeys(text) {
    const q = lightNormalize(text);
    const found = [];
    if (q.length < 2) return found;
    for (const item of FRAGMENT_ALIASES) {
      if (item.text.indexOf(q) !== -1 && found.indexOf(item.key) === -1) found.push(item.key);
    }
    return found;
  }

  // 教学楼数字键的识别范围：1~30 教，避免把随机数字（如"301"）误判成地点。
  const TEACHING_BUILDING_MAX = 30;

  /**
   * 抽取一段文本指向的所有地点键（集合）。
   * 规则：校区层扫描（@学部键）+ 归一化后命中别名索引 + 包含某个别名 + 形如"N教"。
   */
  function tokens(text) {
    const n = normalize(text);
    const found = Object.create(null);
    // 校区层跑在原始文本上，避免被 normalize 的修饰词删除清空。
    for (const areaKey of scanAreas(text)) found[areaKey] = true;
    if (!n) return Object.keys(found);
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
   * 顺序：地点键（先校验校区一致，再取交集）→ 单侧为已知地点则否 → 普通关键词字面包含。
   * 单字符查询不做包含匹配（避免"一"命中"301"之类误伤），只认精确或同键。
   */
  function matchText(keyword, text) {
    const ks = tokens(keyword);
    for (const qa of queryAreaKeys(keyword)) if (ks.indexOf(qa) === -1) ks.push(qa);
    // 通用部分关键字：查询是某地点别名的连续片段时也归入该地点键。
    for (const fk of fragmentKeys(keyword)) if (ks.indexOf(fk) === -1) ks.push(fk);
    const kt = tokens(text);
    const nk = normalize(keyword);
    const nt = normalize(text);

    if (ks.length && kt.length) {
      // 校区一致性：两侧都点明校区时，校区必须相同（"信部一教"不该命中"工学部一教"）。
      const areaQ = ks.filter(isAreaKey);
      const areaT = kt.filter(isAreaKey);
      if (areaQ.length && areaT.length && !intersect(areaQ, areaT)) return false;
      return intersect(ks, kt);
    }

    // 查询本身指向已知地点键（完整别名或片段）：文本侧没有地点键时也不走字面。
    // 否则 normalize('一教')='1教' 会作为子串误命中 '301教室'。
    if (ks.length) return false;

    if (!nk || !nt) return false;
    if (nk === nt) return true;

    // 普通关键词：双向子串包含。正向（文本含查询）保留原 includes 语义；
    // 反向（查询含文本）覆盖"用户输完整地点、启事只写简称/片段"的情况，
    // 例如查询"图书馆三楼自习室"命中文本"图书馆"。
    // 两侧都要求长度 > 1，单字符不参与，避免"一 / 的"泛字误伤。
    // 数字边界：normalize('信息学部一教')='1教'，若不加保护，反向包含会让"301教室"
    // 里的尾串"1教"误命中一教。与 tokens() 的数字左边界同策：短串以数字开头且
    // 在长串中前一字符也是数字时，视为数字串的一部分，不算地点片段。
    if (substringHit(nt, nk)) return true;
    if (substringHit(nk, nt)) return true;
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
      if (isAreaKey(key)) {
        const list = AREA_ALIASES[key.slice(1)];
        if (list) for (const a of list) out.push(a);
        continue;
      }
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
    fragmentKeys: fragmentKeys,
    matchText: matchText,
    matchLocation: matchLocation,
    matchItem: matchItem,
    expandAliases: expandAliases,
    LOCATION_ALIASES: LOCATION_ALIASES,
    AREA_ALIASES: AREA_ALIASES
  };
});
