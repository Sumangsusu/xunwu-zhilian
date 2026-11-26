/**
 * 寻物智联 · 拍照识别文字 -> 发布页描述草稿（B2）
 *
 * 隐私红线（与「联系方式打码 + 答对才解锁」同一套逻辑）：
 *   1) 识别结果只作上方结构化字段的填表草稿，「详细描述」始终留空由用户自己写；
 *      绝不自动提交、绝不自行入库，用户必须亲自点「立即发布」；
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
    // 物品照片上的 OCR 常把包装/铭牌/吊牌识别成杂乱文字（型号、参数、认证、厂名…）。
    // 这些行即使含中文也不是"物品描述"，绝不能整段塞进公开的详细描述字段。
    var DESCRIPTION_NOISE = [
        '型号', '货号', '编号', '序列号', '批号', '批次', '执行标准', '生产日期', '保质期',
        '净含量', '规格', '产地', '厂名', '厂址', '制造商', '生产商', '输入', '输出', '电压',
        '电流', '功率', '容量', '成分', '材质', '认证', '条码', '网址', '电话', '热线',
        '商标', '品牌', '有效期', '储存', '储存条件', '注意事项', '使用说明', '合格证',
        '品名', '产品名称', '商品名称', '名称', '重量', '尺寸', '等级', '检验', '包装',
        '公司', '工厂', '电子厂', '商行', '旗舰店', 'made in', 'model', 'serial', 'iso',
        'gb/t', 'fcc', 'batch', 'expiry', 's/n', 'sn:', 'www.', 'http'
    ];
    // 物品识别给出的中文 type 优先于 OCR 文本；OCR 文字只有「可信」时才兜底填名称。
    // 这些英文词用于判断一段 OCR 文本是否真的在描述物品，而不是表盘/包装上的乱码。
    var EN_ITEM_WORDS = ['phone', 'iphone', 'ipad', 'ipod', 'watch', 'airpods', 'headphone',
        'earphone', 'earbuds', 'laptop', 'keyboard', 'mouse', 'camera', 'wallet', 'backpack',
        'handbag', 'purse', 'book', 'notebook', 'umbrella', 'bottle', 'cup', 'mug', 'glasses',
        'sunglasses', 'key', 'card', 'pen', 'ruler', 'scissors', 'lamp', 'lock', 'battery'];
    var CN_CHARS = /[\u4e00-\u9fff]/;
    // 详细描述不参与自动填入，提示文案也不包含它
    var FIELD_LABELS = {
        title: '物品名称', category: '物品分类', color: '主色',
        features: '特征标签'
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
     * 产品要求：智能识别不再写入「详细描述」，该栏保持空白（已填内容原样保留）。
     * 保留此函数仅为兼容旧调用方，永远返回原值、changed=false。
     */
    function composeDraft(current, recognized) {
        return { text: String(current == null ? '' : current), changed: false };
    }

    function clean(v) { return String(v == null ? '' : v).trim(); }

    /** 是否含有意义的中文（至少两个汉字，排除单字噪声）。 */
    function hasMeaningfulChinese(s) {
        return (String(s || '').match(/[\u4e00-\u9fff]/g) || []).length >= 2;
    }

    /**
     * 判断一段 OCR 文本是否「可信到可以填进公开草稿」。
     * OCR 在物品照片上常把包装、表盘、logo 识别成 `00'GT` 这类乱码：
     * 无中文、无已知英文物品词、字母数字混杂且没有可读词 -> 一律判为噪声，不填入。
     */
    function isCredibleText(text) {
        var s = clean(text);
        if (!s) return false;
        if (s.indexOf('已隐藏') >= 0) return false;
        if (hasMeaningfulChinese(s)) return true;
        var lower = s.toLowerCase();
        // 命中已知物品英文词，或存在 3 个以上连续字母组成的英文单词
        if (EN_ITEM_WORDS.some(function (w) { return lower.indexOf(w) >= 0; })) return true;
        return /[a-z]{3,}/i.test(s);
    }

    /** 只保留可信的 OCR 行，供结构化字段（名称/分类/颜色/特征）提取使用；整段乱码时返回空串。 */
    function credibleLines(text) {
        var raw = sanitize(text);
        if (!raw) return '';
        return raw.split(/\r?\n/).map(clean).filter(function (line) {
            return line && isCredibleText(line);
        }).join('\n');
    }

    /**
     * 严格判断一行 OCR 文字是否"像一句物品描述"，用于详细描述字段兜底。
     * 比 isCredibleText 严得多：包装参数、铭牌编号、厂名认证、过长过短的行一律拒绝。
     */
    function isDescriptiveLine(text) {
        var s = clean(text);
        if (!s || s.indexOf('已隐藏') >= 0) return false;
        // 过长行极可能是整段说明文字/广告语，过短行是噪声单字
        if (s.length < 2 || s.length > 30) return false;
        // 含冒号的多为"字段：值"参数行（型号：xxx / 材质：xxx）
        if (/[:：]/.test(s)) return false;
        // 3 位以上连续数字多为型号、批号、规格值
        if (/\d{3,}/.test(s)) return false;
        var lower = s.toLowerCase();
        if (DESCRIPTION_NOISE.some(function (w) { return lower.indexOf(w) >= 0; })) return false;
        // 以中文为主（至少 2 个汉字且占比过半），避免纯英文编号/乱码
        var cn = (s.match(/[\u4e00-\u9fff]/g) || []).length;
        return cn >= 2 && cn * 2 >= s.length;
    }

    /** 严格过滤后的描述行：去重后最多取 2 行，用顿号连成一句，供描述兜底。 */
    function descriptiveLines(text) {
        var raw = sanitize(text);
        if (!raw) return '';
        var seen = Object.create(null), out = [];
        raw.split(/\r?\n/).map(clean).forEach(function (line) {
            if (line && isDescriptiveLine(line) && !seen[line]) {
                seen[line] = 1;
                out.push(line);
            }
        });
        return out.slice(0, 2).join('，');
    }

    /**
     * 由已填好的结构化字段生成一句通顺的描述草稿。
     * 优先用物品识别给出的中文物品名；主色/特征只在名称里没出现时才补，避免重复。
     * 任何看起来像包装参数的名称都不进入描述。
     */
    function buildDescriptionDraft(values, ocrFallback) {
        var v = values || {};
        var title = clean(v.title);
        if (title && !isDescriptiveLine(title)) title = '';
        var color = clean(v.color);
        var features = clean(v.features);
        var fallback = clean(ocrFallback);
        var base = title || fallback;
        if (!base) return '';
        var detail = [];
        if (color && base.indexOf(color) < 0) detail.push(color);
        if (features) {
            var parts = features.split(/[、,，]/).map(clean).filter(function (f) {
                return f && base.indexOf(f) < 0 && detail.indexOf(f) < 0;
            });
            if (parts.length) detail.push(parts.join('、'));
        }
        var text = base + (detail.length ? '，' + detail.join('，') : '');
        return text + '。（由智能识别预填，请核对并补充细节）';
    }

    /**
     * 只从文字里提取「低风险、可核对」的草稿字段，绝不覆盖用户已填内容。
     * 名称取第一段可信的物品描述文字；乱码/纯数字/敏感占位符一律跳过。
     */
    function parseFieldsFromText(text, current) {
        var out = {
            title: clean(current && current.title),
            category: clean(current && current.category),
            color: clean(current && current.color),
            features: clean(current && current.features),
            description: clean(current && current.description)
        };
        var raw = credibleLines(text);
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
                return s.length >= 2 && s.length <= 24 && isCredibleText(s) &&
                    s.indexOf('识别') < 0;
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
     * 先按文字提取，再用物品识别补齐仍为空的上方字段；
     * 「详细描述」一律不自动填入，保持空白由用户手写，避免凌乱文字污染公开内容。
     * 返回 { values, filled }，filled 为实际新填入的字段名数组（不含 description）。
     */
    function composeFormDraft(text, recognition, current) {
        var originalDesc = clean(current && current.description);
        var before = {
            title: clean(current && current.title),
            category: clean(current && current.category),
            color: clean(current && current.color),
            features: clean(current && current.features),
            description: originalDesc
        };
        // 物品识别给出的中文物品名比 OCR 文字更可靠，先用它填结构化字段；
        // OCR 文字仅在识别没填上的字段里兜底，避免乱码或误识别的英文占据名称。
        var values = {
            title: before.title, category: before.category, color: before.color,
            features: before.features, description: originalDesc
        };
        var normalized = normalizeRecognition(recognition);
        if (normalized && root.RecognizeDraft && typeof root.RecognizeDraft.build === 'function') {
            var draft = root.RecognizeDraft.build(normalized);
            if (draft) values = root.RecognizeDraft.apply(draft, values);
        }
        var fromText = parseFieldsFromText(text, values);
        ['title', 'category', 'color', 'features'].forEach(function (k) {
            if (!clean(values[k]) && clean(fromText[k])) values[k] = fromText[k];
        });
        // 详细描述：智能识别不写入。values.description 保持当前值（空则继续空白），
        // 用户已填内容也不改动；filled 不含 description，提示里不会再提到它。

        var filled = [];
        Object.keys(FIELD_LABELS).forEach(function (k) {
            if (clean(values[k]) && clean(values[k]) !== before[k]) filled.push(k);
        });
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

    /**
     * /api/recognize 只接受 JPEG/PNG（后端解码器限制），而上传可能是 WebP/GIF。
     * 用 canvas 统一重编码为 JPEG，保证「其他种类的图片」也能触发物品识别，
     * 而不是静默失败导致分类/主色/特征全空。已是 JPEG/PNG 则原样返回。
     */
    function toJpegDataUrl(dataUrl) {
        return new Promise(function (resolve, reject) {
            var s = String(dataUrl || '');
            if (/^data:image\/(jpe?g|png);base64,/i.test(s)) return resolve(s);
            if (!/^data:image\//i.test(s)) return reject(new Error('请先上传一张图片'));
            var img = new Image();
            img.onerror = function () { resolve(s); }; // 转换失败时回退原图，不阻断 OCR
            img.onload = function () {
                try {
                    var canvas = document.createElement('canvas');
                    canvas.width = img.naturalWidth || img.width;
                    canvas.height = img.naturalHeight || img.height;
                    var ctx = canvas.getContext('2d');
                    ctx.fillStyle = '#ffffff'; // 透明区铺白，避免转 JPEG 后发黑
                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                    ctx.drawImage(img, 0, 0);
                    resolve(canvas.toDataURL('image/jpeg', 0.9));
                } catch (e) {
                    resolve(s);
                }
            };
            img.src = s;
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
                    // 物品识别只接受 JPEG/PNG：先把 WebP/GIF 等统一转码，保证各类图片都能识别。
                    // 识别失败不影响文字识别，只用于补齐可见的结构化字段。
                    var recognizePromise = toJpegDataUrl(dataUrl)
                        .then(function (jpeg) {
                            return fetch(base(RECOGNIZE_ENDPOINT), {
                                method: 'POST',
                                credentials: 'same-origin',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ image: jpeg })
                            });
                        })
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
                    // 只填上方结构化字段（且只填空字段，不覆盖用户输入）；
                    // 详细描述一律不写回，保持空白或用户已填的原样。
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
        isCredibleText: isCredibleText,
        credibleLines: credibleLines,
        isDescriptiveLine: isDescriptiveLine,
        descriptiveLines: descriptiveLines,
        buildDescriptionDraft: buildDescriptionDraft,
        toJpegDataUrl: toJpegDataUrl,
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
