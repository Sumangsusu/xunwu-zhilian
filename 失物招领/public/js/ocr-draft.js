/**
 * 寻物智联 · 拍照识别文字 -> 发布页描述草稿（B2）
 *
 * 隐私红线（与「联系方式打码 + 答对才解锁」同一套逻辑）：
 *   1) 识别结果只作填表草稿，绝不自动提交、绝不自行入库，用户必须亲自点「立即发布」；
 *   2) 证件号 / 学号 / 手机号一律脱敏，且不进入防冒领问答的题干或选项；
 *   3) 图片只经同源后端代理，不长期留存，前端不写任何密钥或外部地址；
 *   4) 接口未启用 / 超时 / 识别为空，一律给可见提示，不弹报错弹窗、不白屏。
 *
 * 纯逻辑函数可被 Node 直接 require 验收；DOM 绑定只在浏览器环境执行。
 */
(function (root) {
    'use strict';

    var ENDPOINT = '/api/ocr';
    var RECOGNIZE_ENDPOINT = '/api/recognize';
    var MAX_BYTES = 5 * 1024 * 1024;
    var ALLOWED_TYPE = /^image\/(jpe?g|png|gif|webp)$/i;

    // 与 recognize-draft.js / 发布页下拉框保持一致
    var COLORS = ['黑色', '白色', '银色', '灰色', '红色', '蓝色', '棕色', '绿色', '黄色', '粉色', '紫色'];
    var CATEGORY_HINTS = [
        { value: '电子数码', words: ['手机', '耳机', '手表', '手环', '平板', '电脑', '笔记本', '键盘', '鼠标', '相机', '充电盒', 'airpods', 'iphone', 'ipad', 'watch'] },
        { value: '证件文件', words: ['身份证', '学生证', '校园卡', '银行卡', '护照', '驾驶证', '准考证', '证件'] },
        { value: '衣物配饰', words: ['外套', '衣服', '衬衫', '裤子', '裙子', '帽子', '围巾', '鞋子', '眼镜', '手表带'] },
        { value: '箱包类', words: ['背包', '双肩包', '书包', '挎包', '钱包', '行李箱', '手提包'] },
        { value: '钥匙', words: ['钥匙', '门禁卡', '车钥匙'] }
    ];
    var FEATURE_HINTS = ['皮质', '金属', '陶瓷', '磨损', '划痕', '全新', '表带', '对折', '拉链', '按键', '屏幕', '挂绳', '反光'];
    var FIELD_LABELS = {
        title: '物品名称', category: '物品分类', color: '主色',
        features: '特征标签', description: '详细描述'
    };

    /** 前端二次脱敏：即使后端返回异常内容，也不让敏感编号落进公开描述字段。 */
    function sanitize(text) {
        // 与后端 ocr.js 保持同一顺序：先整段证件号，再手机号，最后长编号。
        return String(text == null ? '' : text)
            .replace(/(?<!\d)\d{17}[\dXx](?!\d)/g, '[证件号已隐藏]')
            .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '[手机号已隐藏]')
            .replace(/(?<!\d)\d{10,}(?!\d)/g, '[编号已隐藏]')
            .slice(0, 500);
    }

    /**
     * 只生成草稿文本：空描述直接填入；已有内容则追加，绝不覆盖用户输入。
     * 返回 { text, changed }，由调用方决定是否写回 textarea。
     */
    function composeDraft(current, recognized) {
        var cur = String(current == null ? '' : current);
        var add = sanitize(recognized);
        if (!add) return { text: cur, changed: false };
        if (!cur.trim()) return { text: add, changed: true };
        return { text: cur.replace(/\s+$/, '') + '\n' + add, changed: true };
    }

    function clean(v) { return String(v == null ? '' : v).trim(); }

    /**
     * 只从文字里提取「低风险、可核对」的草稿字段，绝不覆盖用户已填内容。
     * 名称取第一段像物品描述的文字（纯数字/敏感占位符一律跳过）。
     */
    function parseFieldsFromText(text, current) {
        var out = {
            title: clean(current && current.title),
            category: clean(current && current.category),
            color: clean(current && current.color),
            features: clean(current && current.features),
            description: clean(current && current.description)
        };
        var raw = sanitize(text);
        if (!raw) return out;
        var lower = raw.toLowerCase();

        if (!out.color) {
            for (var i = 0; i < COLORS.length; i++) {
                if (raw.indexOf(COLORS[i]) >= 0) { out.color = COLORS[i]; break; }
            }
        }
        if (!out.category) {
            var best = '', bestScore = 0;
            CATEGORY_HINTS.forEach(function (group) {
                var score = 0;
                group.words.forEach(function (w) {
                    if (lower.indexOf(w.toLowerCase()) >= 0) score++;
                });
                if (score > bestScore) { best = group.value; bestScore = score; }
            });
            if (best) out.category = best;
        }
        if (!out.title) {
            var lines = raw.split(/[\n，,。；;]+/).map(clean).filter(function (s) {
                return s.length >= 2 && s.length <= 24 &&
                    !/^[0-9.,:：\s]+$/.test(s) &&
                    s.indexOf('已隐藏') < 0 && s.indexOf('识别') < 0;
            });
            if (lines.length) out.title = lines[0];
        }
        if (!out.features) {
            var found = FEATURE_HINTS.filter(function (w) { return raw.indexOf(w) >= 0; });
            if (found.length) out.features = found.slice(0, 6).join('、');
        }
        return out;
    }

    /** 后端 /api/recognize 的返回 -> recognize-draft.js 能吃的识别结果。 */
    function normalizeRecognition(result) {
        if (!result || typeof result !== 'object') return null;
        var type = clean(result.type);
        var rejected = !!result.rejected || !type || type === '未能确定' || type.indexOf('识别失败') === 0;
        var features = [];
        if (!rejected) features.push(type);
        (Array.isArray(result.candidates) ? result.candidates : []).forEach(function (c) {
            var t = clean(c && c.type);
            if (t && features.indexOf(t) < 0) features.push(t);
        });
        return {
            type: rejected ? '' : type,
            category: result.category,
            color: result.color,
            features: features,
            modelError: rejected
        };
    }

    /**
     * 文字识别 + 物品识别 -> 发布页草稿。
     * 先按文字提取，再用物品识别补齐仍为空的字段；描述始终以 OCR 原文为准。
     * 返回 { values, filled }，filled 为实际新填入的字段名数组。
     */
    function composeFormDraft(text, recognition, current) {
        var originalDesc = clean(current && current.description);
        var textDraft = composeDraft(originalDesc, text);
        var before = {
            title: clean(current && current.title),
            category: clean(current && current.category),
            color: clean(current && current.color),
            features: clean(current && current.features),
            description: textDraft.text
        };
        var values = parseFieldsFromText(text, before);

        var normalized = normalizeRecognition(recognition);
        if (normalized && root.RecognizeDraft && typeof root.RecognizeDraft.build === 'function') {
            var draft = root.RecognizeDraft.build(normalized);
            if (draft) {
                values = root.RecognizeDraft.apply(draft, values);
                // 描述优先保留 OCR 原文，物品识别只补结构化字段
                values.description = textDraft.text;
            }
        }

        var filled = [];
        Object.keys(FIELD_LABELS).forEach(function (k) {
            if (clean(values[k]) && clean(values[k]) !== before[k]) filled.push(k);
        });
        // 描述可能原本就有内容，此时是在末尾追加，同样算「已填入」
        if (textDraft.changed && filled.indexOf('description') < 0) filled.push('description');
        return { values: values, filled: filled };
    }

    /** File -> data URL，先在浏览器侧做类型与体积校验，避免无谓上传。 */
    function fileToDataUrl(file) {
        return new Promise(function (resolve, reject) {
            if (!file) return reject(new Error('请先上传一张物品照片'));
            if (!ALLOWED_TYPE.test(file.type || '')) {
                return reject(new Error('仅支持 JPG / PNG / GIF / WebP 图片'));
            }
            if (file.size > MAX_BYTES) return reject(new Error('图片不能超过 5 MB'));
            // 用户端压缩后再传给后端 OCR，减小上传体积（OCR 需较高清晰度，用 ocr 预设）
            var rootWindow = (typeof window !== 'undefined') ? window : null;
            if (rootWindow && typeof rootWindow.compressImage === 'function' && rootWindow.IMAGE_COMPRESS_PRESETS) {
                rootWindow.compressImage(file, rootWindow.IMAGE_COMPRESS_PRESETS.ocr)
                    .then(function (dataUrl) { resolve(String(dataUrl || '')); })
                    .catch(function () {
                        // 压缩失败则降级为原图读取，不让识别功能不可用
                        var reader = new FileReader();
                        reader.onload = function () { resolve(String(reader.result || '')); };
                        reader.onerror = function () { reject(new Error('图片读取失败，请重新选择')); };
                        reader.readAsDataURL(file);
                    });
                return;
            }
            var reader = new FileReader();
            reader.onload = function () { resolve(String(reader.result || '')); };
            reader.onerror = function () { reject(new Error('图片读取失败，请重新选择')); };
            reader.readAsDataURL(file);
        });
    }

    function showNotice(message, kind) {
        var box = document.getElementById('ocrDraftNotice');
        var text = document.getElementById('ocrDraftNoticeText');
        if (!box || !text) return;
        text.textContent = message;
        box.className = 'mt-2 p-3 rounded-xl border-2 text-xs leading-relaxed ' +
            (kind === 'error'
                ? 'border-amber-200 bg-amber-50 text-amber-800'
                : 'border-blue-200 bg-blue-50 text-blue-800');
        box.classList.remove('hidden');
    }

    function valueOf(id) {
        var el = document.getElementById(id);
        return el ? el.value : '';
    }

    /** 填入后把第一个字段滚动到可视区，避免「提示说填了但页面看不到」。 */
    function revealField(id) {
        var el = document.getElementById(id);
        if (!el) return;
        try {
            if (typeof el.scrollIntoView === 'function') {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
            if (typeof el.focus === 'function') el.focus({ preventScroll: true });
        } catch (e) { /* 老浏览器不支持选项参数时静默降级 */ }
    }

    function init() {
        var btn = document.getElementById('ocrDraftBtn');
        if (!btn || btn.dataset.ocrBound === '1') return;
        btn.dataset.ocrBound = '1';

        btn.addEventListener('click', function () {
            var desc = document.getElementById('itemDesc');
            var input = document.getElementById('publishImageInput');
            var preview = document.getElementById('publishImagePreview');
            if (!desc) return;

            var label = btn.innerHTML;
            btn.disabled = true;
            btn.innerHTML = '<i class="fa fa-spinner fa-spin mr-1"></i>识别中…';
            showNotice('正在识别图片，稍候即可填入发布草稿。', 'info');

            var file = input && input.files && input.files[0];
            var source = file
                ? fileToDataUrl(file)
                : Promise.resolve(
                    preview && /^data:image\//i.test(preview.src || '') ? preview.src : ''
                );

            source
                .then(function (dataUrl) {
                    if (!dataUrl) throw new Error('请先上传一张物品照片');
                    // 统一站点基址，站点换到任意域名 / IP / 子路径都不会 404。
                    var base = root.apiUrl || function (p) { return p; };
                    var options = {
                        method: 'POST',
                        credentials: 'same-origin',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ image: dataUrl })
                    };
                    var ocrPromise = fetch(base(ENDPOINT), options)
                        .then(function (resp) { return resp.json().catch(function () { return {}; }); });
                    // 物品识别失败不影响文字识别，只用于补齐可见的结构化字段
                    var recognizePromise = fetch(base(RECOGNIZE_ENDPOINT), options)
                        .then(function (resp) { return resp.json().catch(function () { return {}; }); })
                        .then(function (data) { return data && data.success ? data.result : null; })
                        .catch(function () { return null; });
                    return Promise.all([ocrPromise, recognizePromise]);
                })
                .then(function (results) {
                    var data = results[0];
                    var recognition = results[1];
                    if (!data || data.success !== true || !data.text) {
                        throw new Error((data && data.message) || '文字识别暂时不可用，请手动填写描述');
                    }
                    // 描述以 OCR 原文追加不覆盖；其余字段只填空，不覆盖用户输入
                    var current = {
                        title: valueOf('itemTitle'),
                        category: valueOf('itemCategory'),
                        color: valueOf('itemColor'),
                        features: valueOf('itemFeatures'),
                        description: desc.value
                    };
                    var form = composeFormDraft(data.text, recognition, current);
                    var ids = {
                        title: 'itemTitle', category: 'itemCategory', color: 'itemColor',
                        features: 'itemFeatures', description: 'itemDesc'
                    };
                    form.filled.forEach(function (k) {
                        var el = document.getElementById(ids[k]);
                        if (el) el.value = form.values[k];
                    });
                    desc.value = form.values.description;

                    if (!form.filled.length) {
                        showNotice('未识别到可填入的内容，请手动填写发布信息。', 'error');
                        return;
                    }
                    var names = form.filled.map(function (k) { return FIELD_LABELS[k]; }).join('、');
                    showNotice('已填入：' + names + '。请核对后再点「立即发布」；未发布前不会写入数据库。', 'info');
                    revealField(ids[form.filled[0]]);
                })
                .catch(function (err) {
                    showNotice(err && err.message ? err.message : '文字识别暂时不可用，请手动填写描述。', 'error');
                })
                .finally(function () {
                    btn.disabled = false;
                    btn.innerHTML = label;
                });
        });
    }

    var api = {
        ENDPOINT: ENDPOINT,
        RECOGNIZE_ENDPOINT: RECOGNIZE_ENDPOINT,
        sanitize: sanitize,
        composeDraft: composeDraft,
        parseFieldsFromText: parseFieldsFromText,
        normalizeRecognition: normalizeRecognition,
        composeFormDraft: composeFormDraft,
        fileToDataUrl: fileToDataUrl,
        init: init
    };

    root.OcrDraft = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', function () { api.init(); });
        } else {
            api.init();
        }
    }
}(typeof window !== 'undefined' ? window : globalThis));
