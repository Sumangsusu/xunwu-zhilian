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
}());
