#!/usr/bin/env node
/**
 * 寻物智联 · B4 端到端验收脚本（零依赖）
 *
 * 用法：node scripts/check-e2e-flow.js [baseUrl]
 *   默认 http://127.0.0.1:3000
 *   公网演示站：node scripts/check-e2e-flow.js http://60.205.178.60
 *
 * 覆盖清单验收标准 2 的完整链路：
 *   注册 → 发布带防冒领问答的招领 → 换普通账号看详情（打码 + 答题卡）
 *   → 答错被拒 → 答对解锁 → 热力图出现该点 → 结案。
 * 另加本次新增的 /api/map/config 与 /api/ocr 降级检查。
 *
 * 注意：脚本会真实注册两个测试账号并发布一条启事，最后结案（resolved），
 *       不会残留在架列表；只在验收 / 演示环境运行。
 */
'use strict';

const BASE = String(process.argv[2] || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const CONTACT = 'TEST-CONTACT-9527';
const results = [];

function check(name, ok, detail) {
    results.push({ name: name, ok: !!ok, detail: detail || '' });
}

function cookieOf(resp) {
    const list = typeof resp.headers.getSetCookie === 'function'
        ? resp.headers.getSetCookie()
        : [resp.headers.get('set-cookie')];
    for (const raw of list) {
        if (!raw) continue;
        const m = /(?:^|,\s*)(xunwu_session=[^;]+)/.exec(raw);
        if (m) return m[1];
    }
    return '';
}

async function call(pathname, opts) {
    const o = opts || {};
    const headers = { Accept: 'application/json' };
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    if (o.cookie) headers.Cookie = o.cookie;
    const resp = await fetch(BASE + pathname, {
        method: o.method || 'GET',
        headers: headers,
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
        redirect: 'manual'
    });
    const text = await resp.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { /* 非 JSON 响应 */ }
    return {
        status: resp.status, data: data, text: text,
        cookie: cookieOf(resp), type: resp.headers.get('content-type') || ''
    };
}

function suffix() {
    return Math.random().toString(36).slice(2, 8).toUpperCase();
}

async function main() {
    console.log('寻物智联 · B4 端到端验收  ->  ' + BASE + '\n');

    // ---------- 0. 健康与新增接口 ----------
    const health = await call('/health');
    check('/health 返回 200 且 status=ok',
        health.status === 200 && health.data && health.data.status === 'ok',
        'HTTP ' + health.status);

    const mapCfg = await call('/api/map/config');
    check('/api/map/config 返回 JSON（不被 SPA 兜底成 HTML）',
        !!mapCfg.data && typeof mapCfg.data === 'object' && !/text\/html/.test(mapCfg.type),
        mapCfg.type);
    check('/api/map/config 有 enabled 且关闭时不带 key',
        typeof (mapCfg.data || {}).enabled === 'boolean' &&
        (mapCfg.data.enabled ? /key=/.test(mapCfg.data.sdkUrl || '') : !mapCfg.data.key),
        (mapCfg.data || {}).reason || '');

    const ocrAnon = await call('/api/ocr', { method: 'POST', body: { image: '' } });
    check('未登录调用 OCR 被拒（401）', ocrAnon.status === 401, 'HTTP ' + ocrAnon.status);

    // ---------- 1. 发布者注册 / 登录 ----------
    const s = suffix();
    const owner = {
        username: 'e2eo_' + s.toLowerCase(),
        password: 'TestPass123!',
        phone: 'TEST-E2E' + s
    };
    const visitor = {
        username: 'e2ev_' + s.toLowerCase(),
        password: 'TestPass123!',
        phone: 'TEST-VIS' + s
    };

    const regOwner = await call('/api/auth/register', { method: 'POST', body: owner });
    check('注册发布者账号',
        regOwner.status === 200 && regOwner.data && regOwner.data.success === true,
        'HTTP ' + regOwner.status);

    const loginOwner = await call('/api/auth/login', {
        method: 'POST', body: { username: owner.username, password: owner.password }
    });
    const ownerCookie = loginOwner.cookie;
    check('发布者登录拿到 HttpOnly 会话', !!ownerCookie);

    const regVisitor = await call('/api/auth/register', { method: 'POST', body: visitor });
    check('注册第二个普通账号',
        regVisitor.status === 200 && regVisitor.data && regVisitor.data.success === true);

    const loginVisitor = await call('/api/auth/login', {
        method: 'POST', body: { username: visitor.username, password: visitor.password }
    });
    const visitorCookie = loginVisitor.cookie;
    check('普通账号登录成功', !!visitorCookie);

    // ---------- 2. 发布带防冒领问答的招领 ----------
    const pub = await call('/api/items', {
        method: 'POST', cookie: ownerCookie,
        body: {
            type: 'found',
            title: 'E2E 验收用钥匙扣',
            category: '钥匙',
            color: '黑色',
            location: '图书馆',
            date: '2026-11-15',
            description: '端到端验收脚本生成的描述，不含任何真实个人信息',
            contact: CONTACT,
            reward: '',
            features: ['验收'],
            mapX: 420, mapY: 210,
            lng: 114.36, lat: 30.53,
            quiz: [{ q: '内侧刻了什么字？', options: ['无', '珞珈', '星河'], answer: 1 }]
        }
    });
    check('发布招领（HTTP 201）',
        pub.status === 201 && pub.data && pub.data.success === true, 'HTTP ' + pub.status);
    const id = pub.data && pub.data.item && pub.data.item.id;
    check('返回启事 id', Number.isInteger(id));
    check('双写坐标入库（lng/lat + mapX/mapY）',
        !!(pub.data && pub.data.item && pub.data.item.lng != null && pub.data.item.mapX != null));
    if (!Number.isInteger(id)) { return finish(); }

    // ---------- 3. 换普通账号看详情：打码 + 答题卡 ----------
    const detail = await call('/api/items/' + id, { cookie: visitorCookie });
    const shown = detail.data && detail.data.item;
    check('普通账号看到联系方式打码',
        !!shown && shown.contact !== CONTACT && shown.contactMasked === true);
    check('答题卡存在且不泄露正确选项',
        !!shown && Array.isArray(shown.quiz) && shown.quiz.length === 1 &&
        shown.quiz[0].answer === undefined && Array.isArray(shown.quiz[0].options));

    // ---------- 4. 答错被拒 / 答对解锁 ----------
    const wrong = await call('/api/items/' + id + '/verify', {
        method: 'POST', cookie: visitorCookie, body: { answers: [0] }
    });
    check('答错被拒且不返回联系方式',
        !!wrong.data && wrong.data.correct === false && !wrong.data.contact);

    const right = await call('/api/items/' + id + '/verify', {
        method: 'POST', cookie: visitorCookie, body: { answers: [1] }
    });
    check('答对解锁完整联系方式',
        !!right.data && right.data.correct === true && right.data.contact === CONTACT);

    // ---------- 5. 热力图出现该点 ----------
    const heat = await call('/api/items/heatmap');
    const points = (heat.data && heat.data.items) || [];
    const point = points.find((p) => p.id === id);
    check('热力图出现该点且带约百米级经纬度',
        !!point && point.lng != null && point.lat != null);

    // ---------- 6. OCR 无密钥时友好降级 ----------
    const ocrDraft = await call('/api/ocr', {
        method: 'POST', cookie: ownerCookie, body: { image: '' }
    });
    check('OCR 未配密钥时友好降级（非 5xx、无堆栈）',
        ocrDraft.status === 200 && !!ocrDraft.data &&
        ocrDraft.data.success === false && !ocrDraft.data.stack,
        (ocrDraft.data || {}).code || '');

    // ---------- 7. 结案 ----------
    // PATCH /api/items/:id/status 允许发布者本人或管理员操作，此处用发布者身份结案。
    const close = await call('/api/items/' + id + '/status', {
        method: 'PATCH', cookie: ownerCookie, body: { status: 'resolved' }
    });
    check('结案成功（resolved）',
        !!close.data && close.data.success === true &&
        close.data.item && close.data.item.status === 'resolved');

    const list = await call('/api/items');
    const active = (list.data && list.data.items) || [];
    check('结案后不再出现在在架列表', !active.some((i) => i.id === id));

    return finish();
}

function finish() {
    let pass = 0;
    for (const r of results) {
        console.log((r.ok ? '[PASS] ' : '[FAIL] ') + r.name + (r.detail ? '  - ' + r.detail : ''));
        if (r.ok) pass++;
    }
    console.log('\n汇总：' + pass + '/' + results.length + ' 项通过');
    process.exit(pass === results.length ? 0 : 1);
}

main().catch((err) => {
    console.error('[e2e] 无法连接服务或流程中断：' + (err && err.message ? err.message : err));
    finish();
});
