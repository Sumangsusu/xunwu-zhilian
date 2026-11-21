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
    var MAX_BYTES = 5 * 1024 * 1024;
    var ALLOWED_TYPE = /^image\/(jpe?g|png|gif|webp)$/i;

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
            showNotice('正在识别图片中的文字，稍候即可填入描述草稿。', 'info');

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
                    var url = root.apiUrl ? root.apiUrl(ENDPOINT) : ENDPOINT;
                    return fetch(url, {
                        method: 'POST',
                        credentials: 'same-origin',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ image: dataUrl })
                    });
                })
                .then(function (resp) {
                    return resp.json().catch(function () { return {}; });
                })
                .then(function (data) {
                    if (!data || data.success !== true || !data.text) {
                        throw new Error((data && data.message) || '文字识别暂时不可用，请手动填写描述');
                    }
                    var draft = composeDraft(desc.value, data.text);
                    if (draft.changed) desc.value = draft.text;
                    showNotice(draft.changed
                        ? '已将识别文字填入描述草稿，请核对后再点「立即发布」；未发布前不会写入数据库。'
                        : '未识别到可用文字，请手动填写描述。', 'info');
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
        sanitize: sanitize,
        composeDraft: composeDraft,
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
