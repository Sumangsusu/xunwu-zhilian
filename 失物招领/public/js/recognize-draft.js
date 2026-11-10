/**
 * 寻物智联 · 识别结果 -> 发布页草稿（B3）
 *
 * 纯逻辑模块：不碰 DOM、不碰网络、不读写数据库。浏览器挂 window.RecognizeDraft，
 * Node 可直接 require，便于 scripts/ 下的验收脚本做真实运行时测试。
 *
 * 隐私红线：只生成「待用户确认的填表草稿」，绝不自动提交、绝不自行入库；
 * 用户必须核对字段并亲自点击「立即发布」才会写入数据库。
 * 模型加载失败时不伪造类别 / 置信度，降级为仅带入可靠字段。
 */
(function (root) {
    'use strict';

    var DRAFT_KEY = 'xunwu.recognize.draft';
    // 与 recognize.html 的 classifyColor()、发布页下拉框、数据库种子数据保持一致
    var COLORS = ['黑色', '白色', '银色', '灰色', '红色', '蓝色', '棕色', '绿色', '黄色', '粉色', '紫色'];
    var CATEGORIES = ['电子数码', '证件文件', '衣物配饰', '箱包类', '钥匙', '其他物品'];

    function cleanText(v) { return String(v == null ? '' : v).trim(); }

    function dedupe(list) {
        var seen = Object.create(null), out = [];
        for (var i = 0; i < list.length; i++) {
            if (list[i] && !seen[list[i]]) { seen[list[i]] = 1; out.push(list[i]); }
        }
        return out;
    }

    // 只放行发布页下拉里真实存在的枚举值，避免把「霓虹色」这类模型输出写进库
    function normalizeColor(c) {
        var s = cleanText(c);
        return COLORS.indexOf(s) >= 0 ? s : '';
    }
    function normalizeCategory(c) {
        var s = cleanText(c);
        return CATEGORIES.indexOf(s) >= 0 ? s : '';
    }

    /** 识别结果对象 -> 草稿对象（写进 sessionStorage 前先过这一层） */
    function build(result) {
        if (!result || typeof result !== 'object') return null;

        var failed = !!(result.modelError || result.failed);
        var type = cleanText(result.type);
        if (!type || type.indexOf('识别失败') === 0 || type.indexOf('（') === 0) type = '';

        var color = normalizeColor(result.color);
        // 模型未加载时没有可靠的类别推断，兜底的「其他物品」不带入发布页，交给用户自己选
        var category = failed ? '' : normalizeCategory(result.category);
        var features = (Array.isArray(result.features) ? result.features : [])
            .map(cleanText)
            .filter(function (s) {
                // 颜色名由独立的主色字段承载，不重复塞进特征标签
                if (!s || s === '未知' || s === color || COLORS.indexOf(s) >= 0) return false;
                if (s.indexOf('识别失败') === 0 || s.indexOf('（识别') === 0) return false;
                return s.indexOf('物体识别暂不可用') < 0;
            });
        features = dedupe(features).slice(0, 8);

        return {
            v: 1,
            source: 'recognize',
            type: type,
            category: category,
            color: color,
            features: features,
            modelError: failed,
            createdAt: Date.now()
        };
    }

    /**
     * 草稿 -> 表单值。只填空字段，绝不覆盖用户已输入的内容。
     * current / 返回值均为 { title, category, color, features, description }
     */
    function apply(draft, current) {
        var c = current || {};
        var out = {
            title: cleanText(c.title),
            category: cleanText(c.category),
            color: cleanText(c.color),
            features: cleanText(c.features),
            description: cleanText(c.description)
        };
        if (!draft || draft.v !== 1) return out;

        if (!out.category && draft.category) out.category = draft.category;
        if (!out.color && draft.color) out.color = draft.color;
        if (!out.features && draft.features && draft.features.length) {
            out.features = draft.features.join('、');
        }
        if (!out.title && draft.type) out.title = draft.type;
        if (!out.description) {
            var bits = [];
            if (draft.color) bits.push('识别主色：' + draft.color);
            if (draft.features && draft.features.length) bits.push('识别特征：' + draft.features.join('、'));
            if (bits.length) {
                out.description = bits.join('；') + '。（由智能识别预填，请核对并补充细节）';
            }
        }
        return out;
    }

    /** 特征输入框（顿号/逗号/分号/空格分隔）-> features 数组 */
    function parseFeatures(text) {
        return dedupe(String(text == null ? '' : text)
            .split(/[、,，;；\s]+/)
            .map(cleanText)
            .filter(Boolean)).slice(0, 12);
    }

    var api = {
        DRAFT_KEY: DRAFT_KEY,
        COLORS: COLORS,
        CATEGORIES: CATEGORIES,
        build: build,
        apply: apply,
        parseFeatures: parseFeatures
    };

    root.RecognizeDraft = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
