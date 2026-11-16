/**
 * 寻物智联 · 文字识别代理（B2）
 *
 * 密钥只在后端环境变量中，前端拿不到；图片只在内存中解码后直接外发，
 * 不落盘、不写数据库、不进入任何公开字段。
 *
 * 用 Node 内置 crypto + fetch 实现腾讯云 TC3-HMAC-SHA256 签名，
 * 不引入第三方 SDK，避免给 A1 的 docker 构建增加不确定的 npm 依赖。
 *
 * 隐私红线：识别结果只作填表草稿，但 description 是公开字段，因此
 * 手机号 / 证件号 / 长学号一律在服务端先行脱敏，绝不回传原文，
 * 也绝不拼进防冒领问答的题干或选项。
 */
'use strict';

const crypto = require('node:crypto');
const config = require('./config');
const { readImage } = require('./images');

const HOST = 'ocr.tencentcloudapi.com';
const ENDPOINT = 'https://' + HOST;
const SERVICE = 'ocr';
const ACTION = 'GeneralBasicOCR';
const VERSION = '2018-11-19';
const TIMEOUT_MS = 10000;
const MAX_DRAFT_CHARS = 500;

function enabled() {
  return Boolean(String(config.ocrSecretId || '').trim() && String(config.ocrSecretKey || '').trim());
}

/** 识别文本脱敏：宁可多遮，也不让证件号 / 学号 / 手机号进入公开描述。 */
function maskSensitive(text) {
  // 顺序不能反：先整段匹配 18 位证件号，再匹配 11 位手机号，
  // 否则手机号规则会把证件号从中间切碎，留下可还原的数字片段。
  return String(text || '')
    .replace(/(?<!\d)\d{17}[\dXx](?!\d)/g, '[证件号已隐藏]')
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '[手机号已隐藏]')
    .replace(/(?<!\d)\d{10,}(?!\d)/g, '[编号已隐藏]')
    .slice(0, MAX_DRAFT_CHARS);
}

function sha256Hex(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }
function hmac(key, s) { return crypto.createHmac('sha256', key).update(s, 'utf8').digest(); }
function hmacHex(key, s) { return crypto.createHmac('sha256', key).update(s, 'utf8').digest('hex'); }

/** 腾讯云 TC3-HMAC-SHA256 签名，仅签 content-type 与 host。 */
function authorization(payload, timestamp) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const contentType = 'application/json; charset=utf-8';
  const canonicalHeaders = 'content-type:' + contentType + '\nhost:' + HOST + '\n';
  const signedHeaders = 'content-type;host';
  const canonicalRequest = [
    'POST', '/', '', canonicalHeaders, signedHeaders, sha256Hex(payload)
  ].join('\n');
  const scope = date + '/' + SERVICE + '/tc3_request';
  const stringToSign = [
    'TC3-HMAC-SHA256', String(timestamp), scope, sha256Hex(canonicalRequest)
  ].join('\n');
  const secretDate = hmac('TC3' + config.ocrSecretKey, date);
  const secretService = hmac(secretDate, SERVICE);
  const secretSigning = hmac(secretService, 'tc3_request');
  const signature = hmacHex(secretSigning, stringToSign);
  return 'TC3-HMAC-SHA256 Credential=' + config.ocrSecretId + '/' + scope +
    ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;
}

function failure(code, message) { return { ok: false, code: code, message: message }; }

/**
 * @param {string} image data:image/...;base64,... 格式的图片
 * @returns {{ok:boolean, text?:string, code?:string, message?:string}}
 */
async function recognize(image) {
  if (!enabled()) {
    return failure('ocr-not-configured', '文字识别暂未启用，请手动填写描述');
  }
  let decoded;
  try {
    // 复用 A2 既有的 5 MiB + MIME/魔数校验，不另造一套规则。
    decoded = readImage(image);
  } catch (err) {
    return failure('invalid-image', err.message);
  }

  const base64 = decoded.bytes.toString('base64');
  // 腾讯云 GeneralBasicOCR 合法枚举：zh / en / auto 等；'zh_cn' 会报 LanguageNotSupport。
  const payload = JSON.stringify({ ImageBase64: base64, LanguageType: 'zh' });
  const timestamp = Math.floor(Date.now() / 1000);

  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': authorization(payload, timestamp),
        'X-TC-Action': ACTION,
        'X-TC-Timestamp': String(timestamp),
        'X-TC-Version': VERSION,
        'X-TC-Region': config.ocrRegion
      },
      body: payload,
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (err) {
    return failure('ocr-unavailable', '文字识别服务暂时不可用，请手动填写描述');
  }
  if (!response.ok) return failure('ocr-http-error', '文字识别服务暂时不可用，请手动填写描述');

  let data;
  try {
    data = await response.json();
  } catch (err) {
    return failure('ocr-bad-response', '文字识别服务返回异常，请手动填写描述');
  }
  const result = data && data.Response;
  if (!result || result.Error || !Array.isArray(result.TextDetections)) {
    return failure('ocr-rejected', '文字识别未成功，请手动填写描述');
  }
  const text = result.TextDetections.map((d) => String(d.DetectedText || '')).join('\n').trim();
  if (!text) return failure('ocr-empty', '图片中未识别到文字，请手动填写描述');
  return { ok: true, text: maskSensitive(text) };
}

module.exports = {
  enabled, maskSensitive, authorization, recognize,
  HOST, ACTION, VERSION
};
