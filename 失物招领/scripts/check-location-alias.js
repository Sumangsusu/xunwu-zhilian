#!/usr/bin/env node
/**
 * 寻物智联 · 地点智能匹配验收脚本（零依赖）
 *
 * 用法：在「失物招领/」目录下执行
 *     node scripts/check-location-alias.js
 * 退出码：0 = 全部通过；1 = 存在失败项
 *
 * 覆盖三端：
 *   1) 共享模块 location-alias.js 的纯逻辑（vm 真实执行，不是字符串断言）；
 *   2) 后端 /api/items?q= 的接线（server.js 用 matchItem 且在 publicItem 脱敏后返回）；
 *   3) 网页 found/lost 的 applyFilter 接线（vm 执行真实过滤函数，DOM 桩）；
 *   4) 小程序 index 搜索框 + api.getItems(type, q) 接线；
 *   5) 合规：不引入外部 URL、不把联系方式/防冒领问答参与匹配。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const Alias = require(path.join(ROOT, 'public', 'js', 'location-alias.js'));

let pass = 0, total = 0;
function check(name, ok, detail) {
    total++;
    if (ok) pass++;
    console.log((ok ? '[PASS] ' : '[FAIL] ') + name + (detail ? '  - ' + detail : ''));
}

console.log('寻物智联 · 地点智能匹配验收\n');

// ==================== 1. 共享模块纯逻辑（vm 真实执行） ====================
console.log('【1】共享模块 normalize / tokens / matchText');

// vm 里重新执行模块源码，验证 UMD 在纯 Node 上下文能挂 module.exports
const moduleSrc = read('public/js/location-alias.js');
const sandbox = { module: { exports: {} }, globalThis: {} };
vm.createContext(sandbox);
vm.runInContext(moduleSrc, sandbox);
const VmAlias = sandbox.module.exports;
check('模块可在 vm 中真实加载并导出', !!VmAlias && typeof VmAlias.matchText === 'function');

check('归一化：信息学部一教 → 1教', VmAlias.normalize('信息学部一教') === '1教', VmAlias.normalize('信息学部一教'));
check('归一化：第一教学楼 → 1教', VmAlias.normalize('第一教学楼') === '1教', VmAlias.normalize('第一教学楼'));
check('归一化：全角数字转半角', VmAlias.normalize('１教') === '1教', VmAlias.normalize('１教'));
check('归一化：中文数字转阿拉伯', VmAlias.normalize('二教') === '2教', VmAlias.normalize('二教'));
check('归一化：教学楼A座 → a教', VmAlias.normalize('教学楼A座') === 'a教', VmAlias.normalize('教学楼A座'));

// 用户核心场景：同一地点的多种表述互通
const variants = [
    ['信息学部一教', ['一教', '第一教学楼', '教一', '1教', '教学楼一', '信息学部第一教学楼', '一教楼']],
    ['图书馆', ['图馆', 'library', '图书馆']],
    ['校医院', ['医务室', '校医院']],
    ['学生公寓', ['宿舍', '公寓', '寝室']],
    ['教学楼A座', ['a教', 'A座', '教学楼a']],
    ['食堂', ['餐厅', '一食堂', '饭堂']],
    ['操场', ['运动场', '篮球场', '田径场']]
];
let variantOk = 0, variantTotal = 0;
for (const [canon, list] of variants) {
    for (const v of list) {
        variantTotal++;
        if (VmAlias.matchLocation(v, canon) && VmAlias.matchLocation(canon, v)) variantOk++;
        else console.log('    [明细] ' + v + ' <-> ' + canon + ' 未互通');
    }
}
check('同一地点多种表述双向互通（' + variantOk + '/' + variantTotal + '）', variantOk === variantTotal);

// 不误伤：不同地点不能互相命中
const negatives = [
    ['一教', '二教'], ['图书馆', '体育馆'], ['食堂', '操场'], ['校门', '校医院'],
    ['一教', '301教室'], ['一教', '201教'], ['二教', '12教'], ['图书馆', '超市']
];
let negOk = 0;
for (const [a, b] of negatives) if (!VmAlias.matchLocation(a, b)) negOk++;
check('不同地点不误伤（' + negOk + '/' + negatives.length + '）', negOk === negatives.length);

// ---- 校区/学部层（PR16：修复"信部"搜不到"信息学部一教"）----
// 缺陷根因：normalize() 把"信息学部"当修饰词删掉，只指校区的查询归一化后为空串。
check('tokens：信息学部一教 同时含校区键与教楼键',
    VmAlias.tokens('信息学部一教').indexOf('@信息学部') !== -1 &&
    VmAlias.tokens('信息学部一教').indexOf('教1') !== -1,
    JSON.stringify(VmAlias.tokens('信息学部一教')));
check('tokens：信部 → @信息学部', JSON.stringify(VmAlias.tokens('信部')) === '["@信息学部"]',
    JSON.stringify(VmAlias.tokens('信部')));

const areaVariants = ['信部', '信息学部', '信息学', '信息部', '信息学院', '信院'];
let areaOk = 0;
for (const v of areaVariants) if (VmAlias.matchLocation(v, '信息学部一教')) areaOk++;
check('校区表述互通：' + areaVariants.join('/') + ' 均命中信息学部一教（' + areaOk + '/' + areaVariants.length + '）',
    areaOk === areaVariants.length);

check('校区 + 楼栋组合：信部一教 命中 信息学部一教', VmAlias.matchLocation('信部一教', '信息学部一教'));
check('校区 + 楼栋组合：信息学部第一教学楼 命中 信息学部一教',
    VmAlias.matchLocation('信息学部第一教学楼', '信息学部一教'));

const areaNegatives = [
    ['信部', '工学部一教'],          // 校区不同
    ['信部一教', '工学部一教'],      // 校区冲突时不能靠"教1"蒙过
    ['工部', '信息学部一教'],
    ['医部', '信息学部一教'],
    ['工部', '勤工部'],              // "勤工部"不是校区
    ['信部', '通信部']               // "通信部"不是校区
];
let areaNegOk = 0;
for (const [a, b] of areaNegatives) if (!VmAlias.matchLocation(a, b)) areaNegOk++;
check('校区不误伤（' + areaNegOk + '/' + areaNegatives.length + '）', areaNegOk === areaNegatives.length);

check('matchItem：信部 命中 location=信息学部一教',
    VmAlias.matchItem('信部', { title: '薯片', location: '信息学部一教', description: '', category: '食品' }));
check('matchItem：信部 不命中 location=工学部一教',
    !VmAlias.matchItem('信部', { title: '水杯', location: '工学部一教', description: '', category: '生活' }));
check('expandAliases：信部 展开为校区名列表',
    JSON.stringify(VmAlias.expandAliases('信部')) === '["信息学部","信部","信息部","信息学院","信院"]',
    JSON.stringify(VmAlias.expandAliases('信部')));

// 普通关键词保持原 includes 语义
check('普通词：钱包 命中 黑色钱包', VmAlias.matchText('钱包', '黑色钱包'));
check('普通词：不相关词不命中', !VmAlias.matchText('雨伞', '黑色钱包'));

// ---- 通用部分关键字（PR：万林 → 万林艺术馆 / 艺术楼画室）----
check('片段召回：万林 → 艺术楼键', VmAlias.fragmentKeys('万林').indexOf('艺术楼') !== -1,
    JSON.stringify(VmAlias.fragmentKeys('万林')));
check('片段召回：艺术博物馆 → 艺术楼键', VmAlias.fragmentKeys('艺术博物馆').indexOf('艺术楼') !== -1);
check('部分关键字：万林 命中 艺术楼画室', VmAlias.matchLocation('万林', '艺术楼画室'));
check('部分关键字：万林 命中 万林艺术馆', VmAlias.matchLocation('万林', '万林艺术馆'));
check('部分关键字：艺术馆 命中 万林艺术博物馆', VmAlias.matchLocation('艺术馆', '万林艺术博物馆'));
check('部分关键字：三楼自习 命中 图书馆三楼自习室', VmAlias.matchLocation('三楼自习', '图书馆三楼自习室'));
check('双向子串：完整地点查询 命中 简称文本', VmAlias.matchText('图书馆三楼自习室', '图书馆'));
check('片段召回不误伤：一教 不命中 301教室', !VmAlias.matchLocation('一教', '301教室'));
check('双向子串不误伤：301教室 不命中 信息学部一教', !VmAlias.matchLocation('301教室', '信息学部一教'));
check('双向子串不误伤：201教 不命中 信息学部一教', !VmAlias.matchLocation('201教', '信息学部一教'));
check('片段召回不误伤：万林 不命中 图书馆', !VmAlias.matchLocation('万林', '图书馆三楼'));
check('matchItem：万林 命中 location=艺术楼画室的启事',
    VmAlias.matchItem('万林', { title: '蓝色水杯', location: '艺术楼画室', description: '', category: '其他' }));

// matchItem 多字段
check('matchItem：一教 命中 location=信息学部一教',
    VmAlias.matchItem('一教', { title: '钱包', location: '信息学部一教', description: '食堂捡到' }));
check('matchItem：图书馆 命中 description 里的地点',
    VmAlias.matchItem('图书馆', { title: '钱包', location: '信息学部一教', description: '在图书馆捡到' }));
check('matchItem：空关键词不过滤', VmAlias.matchItem('', { title: '钱包' }));
check('matchItem：无关地点不命中', !VmAlias.matchItem('一教', { title: '钱包', location: '图书馆', description: '二教捡到' }));

// ==================== 2. 后端接线 ====================
console.log('\n【2】后端 /api/items?q= 接线');
const server = read('server.js');
check('server.js 引入 location-alias 模块', /require\(['"]\.\/public\/js\/location-alias['"]\)/.test(server));
check('server.js 读取 q 查询参数', /const\s*\{[^}]*\bq\b[^}]*\}\s*=\s*req\.query/.test(server));
check('server.js 用 matchItem 过滤', /locationAlias\.matchItem\(keyword,\s*item\)/.test(server));
// 顺序要求：先 mapItem 拿全字段 → matchItem 用全字段匹配 → 最后 publicItem 脱敏输出。
// 用分段断言而非单一超长窗口，避免中间新增坐标/半径逻辑就把窗口撑爆（历史误报）。
const mapIdx = server.indexOf('rows.map(mapItem)');
const matchIdx = server.indexOf('locationAlias.matchItem(keyword, item)');
const pubIdx = server.indexOf('items.map(publicItem)');
check('匹配在 publicItem 脱敏之前（先 mapItem 全字段、后 publicItem）',
    mapIdx !== -1 && matchIdx !== -1 && pubIdx !== -1 && mapIdx < matchIdx && matchIdx < pubIdx);
check('公开列表仍只返回在架 active', /SELECT \* FROM items WHERE status = 'active'/.test(server));

// ==================== 3. 网页 applyFilter 接线（vm 执行真实过滤） ====================
console.log('\n【3】网页 found/lost 过滤逻辑');
for (const page of ['found', 'lost']) {
    const html = read('public/' + page + '.html');
    check(page + '.html 引入 location-alias.js', /<script src="js\/location-alias\.js"><\/script>/.test(html));
    check(page + '.html 关键词走 matchItem', /LocationAlias\.matchItem\(kw,\s*i\)/.test(html));
    check(page + '.html 地点下拉走 matchLocation', /LocationAlias\.matchLocation\(loc,\s*i\.location\)/.test(html));
    check(page + '.html 不再用裸 includes(kw) 过滤',
        !/\.toLowerCase\(\)\.includes\(kw\)/.test(html));
    check(page + '.html 不再用 i.location === loc 全等', !/i\.location\s*===\s*loc/.test(html));

    // vm 真实执行过滤：发布者写"信息学部一教"，检索者输"一教"应命中
    const ctx = { window: { LocationAlias: VmAlias } };
    vm.createContext(ctx);
    const filterSrc = `
        var items = [
          {id:1,title:'钱包',location:'信息学部一教',description:'食堂附近',category:'箱包类'},
          {id:2,title:'耳机',location:'图书馆',description:'自习室',category:'电子类'},
          {id:3,title:'水杯',location:'二教',description:'操场旁',category:'生活类'}
        ];
        var kw='一教', loc='', cat='';
        var out = items.filter(i => window.LocationAlias.matchItem(kw, i));
    `;
    vm.runInContext(filterSrc, ctx);
    const out = ctx.out;
    check(page + '.html vm：搜"一教"命中"信息学部一教"',
        Array.isArray(out) && out.length === 1 && out[0].id === 1,
        JSON.stringify(out && out.map(x => x.id)));

    // 校区检索：发布者写"信息学部一教"，检索者只打"信部"也应命中
    const ctx2 = { window: { LocationAlias: VmAlias } };
    vm.createContext(ctx2);
    vm.runInContext(`
        var items = [
          {id:1,title:'薯片',location:'信息学部一教',description:'',category:'食品'},
          {id:2,title:'耳机',location:'图书馆',description:'自习室',category:'电子类'},
          {id:3,title:'水杯',location:'工学部一教',description:'',category:'生活类'}
        ];
        var kw='信部';
        var out = items.filter(i => window.LocationAlias.matchItem(kw, i));
    `, ctx2);
    const out2 = ctx2.out;
    check(page + '.html vm：搜"信部"命中"信息学部一教"且不误命中工学部',
        Array.isArray(out2) && out2.length === 1 && out2[0].id === 1,
        JSON.stringify(out2 && out2.map(x => x.id)));
}

// 网页首页搜索框把 q 带到列表页（原有链路，确认未被破坏）
const indexHtml = read('public/index.html');
check('首页搜索框仍把关键词带到 lost.html?q=', /lost\.html\?q='\s*\+\s*encodeURIComponent\(kw\)/.test(indexHtml));

// ==================== 4. 小程序接线 ====================
console.log('\n【4】小程序搜索接线');
const MP = path.join(ROOT, '..', '..', '寻物智联小程序');
const mpRead = p => fs.readFileSync(path.join(MP, p), 'utf8');
let mpApi, mpJs, mpWxml;
try {
    mpApi = mpRead('utils/api.js');
    mpJs = mpRead('pages/index/index.js');
    mpWxml = mpRead('pages/index/index.wxml');
} catch (e) {
    check('小程序目录可读', false, e.message);
}
if (mpApi) {
    // 小程序端副本必须与网页/后端共享模块逐字节一致（忽略 CRLF），否则两端搜索行为会分叉。
    try {
        const mpAlias = mpRead('utils/location-alias.js');
        const norm = s => s.replace(/\r\n/g, '\n').trim();
        check('小程序 utils/location-alias.js 与共享模块一致', norm(mpAlias) === norm(moduleSrc));
        check('小程序副本含片段召回 fragmentKeys', /function fragmentKeys/.test(mpAlias));
    } catch (e) {
        check('小程序 utils/location-alias.js 与共享模块一致', false, e.message);
    }
    check('api.getItems 支持 q 参数', /getItems:\s*function\s*\(type,\s*q\)/.test(mpApi));
    check('api.getItems 用 encodeURIComponent 拼 q', /q='\s*\+\s*encodeURIComponent/.test(mpApi));
    check('index.js 有关键词状态', /keyword:\s*''/.test(mpJs));
    check('index.js 输入防抖', /setTimeout\(/.test(mpJs) && /clearTimeout\(/.test(mpJs));
    check('index.js 过期响应令牌', /_searchToken/.test(mpJs));
    check('index.js loadItems 传 q 给后端', /getItems\(type === 'all' \? '' : type, q\)/.test(mpJs));
    check('index.wxml 有搜索框', /class="search-input"/.test(mpWxml) && /bindinput="onSearchInput"/.test(mpWxml));
    check('index.wxml 有清除按钮', /bindtap="onSearchClear"/.test(mpWxml));
}

// ==================== 5. 合规 / 边界 ====================
console.log('\n【5】合规与边界');
check('别名模块无外部 URL', !/https?:\/\//.test(moduleSrc));
check('别名模块无 IP 硬编码', !/\b\d{1,3}(\.\d{1,3}){3}\b/.test(moduleSrc));
check('匹配不接收联系方式字段',
    !/matchItem\([^)]*\bcontact\b/.test(moduleSrc) && !/item\.contact/.test(moduleSrc));
check('匹配不接收防冒领问答字段',
    !/item\.quiz/.test(moduleSrc));
check('matchItem 字段白名单仅 title/location/category/color/description',
    /\[item\.title,\s*item\.location,\s*item\.category,\s*item\.color,\s*item\.description\]/.test(moduleSrc));
check('普通词搜索不会被地点别名过度扩展（钱包保持字面）',
    VmAlias.expandAliases('钱包').length === 1 && VmAlias.expandAliases('钱包')[0] === '钱包');

console.log('\n汇总：' + pass + '/' + total + ' 项通过');
process.exit(pass === total ? 0 : 1);
