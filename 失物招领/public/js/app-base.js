/**
 * 寻物智联 · 统一站点基址（B0 前端基线）
 *
 * 目的：让页面里的接口地址、站内跳转都不绑定具体域名、IP、端口或挂载路径，
 *      站点换到任意域名 / IP / 子路径打开时，页面与接口都不会 404。
 *
 * 约定：
 *   1) 所有页面在 <head> 里尽早引入本文件（必须早于任何业务脚本）；
 *   2) JS 里的接口地址一律写成 apiUrl('/api/items')；
 *   3) 默认取「当前页面所在目录」作为基址，零配置适配任意部署环境；
 *   4) 需要显式指定挂载前缀时，在 <head> 加
 *      <meta name="app-base" content="/xunwu/">
 *      并让反向代理把该前缀转发到本服务（部署侧由 A 负责）；
 *   5) 前端不持有任何地图 / OCR 密钥，B1、B2 的配置接口同样走 apiUrl()，
 *      由后端下发，仓库里只保留占位符。
 *
 * 静态资源（vendor/、css/、models/）用相对路径即可，浏览器会按页面 URL
 * 自动解析到同一挂载点，无需 JS 参与。
 */
(function () {
    'use strict';

    function resolveBase() {
        var meta = document.querySelector('meta[name="app-base"]');
        var explicit = meta ? (meta.getAttribute('content') || '').trim() : '';
        var raw = explicit || new URL('.', document.baseURI).pathname;

        // 非 HTTP(S) 环境（例如直接双击打开 html）一律退回根路径
        if (location.protocol !== 'http:' && location.protocol !== 'https:') {
            raw = '/';
        }
        // 误填完整 URL 时只取路径部分，绝不把域名带进基址
        if (/^https?:\/\//i.test(raw)) {
            try { raw = new URL(raw).pathname; } catch (e) { raw = '/'; }
        }

        raw = String(raw).split('?')[0].split('#')[0];
        var segs = raw.split('/').filter(function (s) {
            return s && s !== '.' && s !== '..';
        });
        return '/' + (segs.length ? segs.join('/') + '/' : '');
    }

    var base = resolveBase();
    window.APP_BASE = base;   // 站点根，末尾恒为 "/"
    window.API_BASE = base;   // 接口与页面同源，保持 HttpOnly Cookie 会话

    /**
     * 站内路径 -> 带基址的同源 URL
     *   apiUrl('/api/items')   -> '/api/items' 或 '/xunwu/api/items'
     *   apiUrl('vendor/x.js')  -> '/vendor/x.js' 或 '/xunwu/vendor/x.js'
     *   http(s) / data / blob  -> 原样返回（供后端下发的合法外链使用）
     */
    window.apiUrl = function (p) {
        var s = String(p == null ? '' : p);
        if (!s || /^https?:\/\//i.test(s) || /^(?:data|blob):/i.test(s) ||
            s.charAt(0) === '#' || s.charAt(0) === '?') {
            return s;
        }
        return base + s.replace(/^\/+/, '');
    };

    /**
     * HTML 文本转义。凡是把后端/用户可控字段拼进 innerHTML 的地方，
     * 文本节点与属性值都必须先经过本函数，避免注入 onerror= 等内联事件。
     * 用法：`<h3>${esc(item.title)}</h3>` / `alt="${esc(item.title)}"`。
     */
    window.esc = function (value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    };

    /**
     * 图片 URL 白名单：仅放行 data:image/、站内 /images/ /uploads/ /api/ 路径。
     * 返回空字符串表示拒绝（调用方应渲染占位图，避免把外链/javascript: 塞进 src）。
     */
    window.safeImageUrl = function (value) {
        var s = String(value == null ? '' : value).trim();
        if (/^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(s)) return s;
        if (/^\/(?:images|uploads|api)\//i.test(s)) return s;
        return '';
    };

    /**
     * 用户端图片压缩（减轻服务器上传/存储负载）。
     *
     * 目标：图片在浏览器端先缩放 + 重编码到合理体积，再以 data URL 交给后端，
     *      避免把几 MB 的原图原样上传（base64 还会再膨胀 1/3）。
     * 策略：
     *   - 长边超过 maxEdge 时等比缩放；
     *   - 以 quality 起、按 0.1 递减反复 JPEG 编码，直到估算体积 <= targetBytes
     *     或降到 minQuality（保证不会无限循环）；
     *   - 透明像素先铺白底，避免 PNG 转 JPEG 后透明区变黑；
     *   - GIF 天生小且带动画/透明，重编码会破坏动画，直接原样返回；
     *   - 已经足够小（尺寸与体积都达标）的图片原样返回，避免有损重编码掉画质。
     *
     * 返回 Promise<string>（data URL）；解码失败时 reject，调用方应降级到原图。
     */
    function numOr(value, fallback) {
        var n = Number(value);
        return isFinite(n) && n > 0 ? n : fallback;
    }

    function dataUrlBytes(dataUrl) {
        var s = String(dataUrl || '');
        var comma = s.indexOf(',');
        if (comma < 0) return s.length;
        return Math.floor((s.length - comma - 1) * 3 / 4); // base64: 4 字符 ≈ 3 字节
    }

    window.compressImage = function (file, opts) {
        opts = opts || {};
        var maxEdge = numOr(opts.maxEdge, 1280);
        var quality = numOr(opts.quality, 0.82);
        var targetBytes = numOr(opts.targetBytes, 1024 * 1024);
        var minQuality = numOr(opts.minQuality, 0.5);
        if (quality > 1) quality = 1;
        if (minQuality > quality) minQuality = quality;

        return new Promise(function (resolve, reject) {
            if (!file || !/^image\//i.test(file.type || '')) {
                reject(new Error('请选择图片文件'));
                return;
            }
            // GIF 重编码会丢动画，原样返回（后端 5 MiB 上限另行兜底）
            if (/^image\/gif$/i.test(file.type)) {
                var gifReader = new FileReader();
                gifReader.onerror = function () { reject(new Error('图片读取失败')); };
                gifReader.onload = function () { resolve(String(gifReader.result || '')); };
                gifReader.readAsDataURL(file);
                return;
            }

            var reader = new FileReader();
            reader.onerror = function () { reject(new Error('图片读取失败')); };
            reader.onload = function () {
                var raw = String(reader.result || '');
                var img = new Image();
                img.onerror = function () { reject(new Error('图片解码失败')); };
                img.onload = function () {
                    var w = img.naturalWidth || img.width;
                    var h = img.naturalHeight || img.height;
                    if (!w || !h) {
                        reject(new Error('图片尺寸无效'));
                        return;
                    }
                    // 尺寸与体积都达标：原样返回，保真且省 CPU
                    if (Math.max(w, h) <= maxEdge && dataUrlBytes(raw) <= targetBytes) {
                        resolve(raw);
                        return;
                    }
                    var scale = Math.max(w, h) > maxEdge ? maxEdge / Math.max(w, h) : 1;
                    var cw = Math.max(1, Math.round(w * scale));
                    var ch = Math.max(1, Math.round(h * scale));
                    var canvas = document.createElement('canvas');
                    canvas.width = cw;
                    canvas.height = ch;
                    var ctx = canvas.getContext('2d');
                    ctx.fillStyle = '#ffffff'; // 透明区铺白，避免转 JPEG 后发黑
                    ctx.fillRect(0, 0, cw, ch);
                    ctx.drawImage(img, 0, 0, cw, ch);

                    var q = quality;
                    var out = canvas.toDataURL('image/jpeg', q);
                    while (dataUrlBytes(out) > targetBytes && q > minQuality + 0.001) {
                        q = Math.max(minQuality, q - 0.1);
                        out = canvas.toDataURL('image/jpeg', q);
                    }
                    resolve(out);
                };
                img.src = raw;
            };
            reader.readAsDataURL(file);
        });
    };

    // 各上传入口的压缩预设（集中管理，便于统一调整）
    window.IMAGE_COMPRESS_PRESETS = {
        publish: { maxEdge: 1280, quality: 0.82, targetBytes: 1024 * 1024, minQuality: 0.5 },
        ocr:     { maxEdge: 1600, quality: 0.9,  targetBytes: 2 * 1024 * 1024, minQuality: 0.6 },
        avatar:  { maxEdge: 256,  quality: 0.85, targetBytes: 100 * 1024, minQuality: 0.5 }
    };
}());
