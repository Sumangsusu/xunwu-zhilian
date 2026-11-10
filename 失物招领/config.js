// config.js — 集中配置（环境变量优先，提供本地开发兜底默认值）
// 不依赖第三方库，仅用 Node 内置模块。
const fs = require('fs');
const path = require('path');

function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, 'utf8');
  text.split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!m || m[1].startsWith('#')) return;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = val;
  });
}
loadEnvFile();

const str = (v, d) => (v === undefined || v === '' ? d : v);
const bool = (v, d) => (v === undefined ? d : (v === 'true' || v === '1'));
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const isHttps = (url) => typeof url === 'string' && url.startsWith('https');

const casEnabled = bool(process.env.CAS_ENABLED, false);

const config = {
  port: num(process.env.PORT, 3000),

  // 会话 Cookie 签名密钥（生产必须改为强随机值，且勿入库）
  sessionSecret: str(process.env.SESSION_SECRET, 'dev-only-change-me-in-production'),
  sessionMaxAge: num(process.env.SESSION_MAX_AGE, 8 * 3600),

  // 武汉大学统一身份认证（CAS）
  casEnabled,
  casBaseUrl: str(process.env.CAS_BASE_URL, 'https://cas.whu.edu.cn/authserver'),
  // 上线时填写：https://你的.whu.edu.cn（CAS 回调与统一注销依赖此值）
  baseUrl: str(process.env.BASE_URL, ''),
  // CAS 断言返回的学工号中，哪些直接赋予管理员角色（逗号分隔）
  adminStudentIds: str(process.env.ADMIN_STUDENT_IDS, '')
    .split(',').map(s => s.trim()).filter(Boolean),

  // 本地开发：是否写入演示/管理员账号与演示数据（CAS 启用时默认不写入，避免校内暴露测试账号）
  seedDevUser: bool(process.env.SEED_DEV_USER, !casEnabled),
  // 开发期本地密码登录/注册；CAS 启用后自动关闭
  allowLocalAuth: !casEnabled,

  // 数据库：route B 上线时由学校实例替换（DB_TYPE=mysql|postgres|sqlite）
  dbType: str(process.env.DB_TYPE, 'sqlite'),

  // 图片存储：db（base64 入库）| file（随机文件名落盘）
  imageStore: str(process.env.IMAGE_STORE, 'db'),
  uploadDir: str(process.env.UPLOAD_DIR, path.join(__dirname, 'public', 'uploads')),
  maxImageBytes: num(process.env.MAX_IMAGE_BYTES, 2 * 1024 * 1024)
};

config.secureCookie = isHttps(config.baseUrl);
module.exports = config;
