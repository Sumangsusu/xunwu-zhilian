const path = require('node:path');

try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

function integer(name, fallback, min, max) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(name + ' 超出允许范围');
  }
  return value;
}

function origin(name) {
  const value = process.env[name];
  if (!value) return '';
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || (value !== url.origin && value !== url.origin + '/')) {
    throw new Error(name + ' 必须是 HTTP(S) 源，例如 https://example.org');
  }
  return url.origin;
}

const production = process.env.NODE_ENV === 'production';
const sessionSecret = process.env.SESSION_SECRET;
if (production && (!sessionSecret || sessionSecret.length < 32 ||
    /^(change.?me|replace.?me|your.?secret|xunwu[-_]dev)/i.test(sessionSecret) ||
    new Set(sessionSecret).size < 12)) {
  throw new Error('生产环境必须配置随机 SESSION_SECRET。可用 openssl rand -hex 32 生成。');
}

const baseUrl = origin('BASE_URL');
const imageStore = process.env.IMAGE_STORE || (production ? 'file' : 'db');
if (!['db', 'file'].includes(imageStore)) throw new Error('IMAGE_STORE 必须为 db 或 file');
const dbPath = path.resolve(__dirname, process.env.DB_PATH || 'data/xunwu.db');

module.exports = {
  production, baseUrl, imageStore, dbPath,
  port: integer('PORT', 3000, 1, 65535),
  host: process.env.HOST || '0.0.0.0',
  trustProxy: integer('TRUST_PROXY', 0, 0, 1),
  sessionSecret: sessionSecret || require('node:crypto').randomBytes(32).toString('hex'),
  cookieSecure: baseUrl.startsWith('https:'),
  seedDevUser: !production && process.env.SEED_DEV_USER === 'true',
  corsOrigin: origin('CORS_ORIGIN'),
  rateLimit: integer('RATE_LIMIT', 20, 1, 1000),
  casEnabled: process.env.CAS_ENABLED === 'true',
  casBaseUrl: process.env.CAS_BASE_URL || '',
  mapKey: process.env.MAP_KEY || '',
  ocrSecretId: process.env.OCR_SECRET_ID || '',
  ocrSecretKey: process.env.OCR_SECRET_KEY || '',
  calibrationPath: path.resolve(__dirname, process.env.CAMPUS_CALIBRATION || 'data/campus-calibration.json')
};
