const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { imageStore } = require('./config');

const uploadDir = path.join(__dirname, 'public', 'uploads');
const maxImageBytes = 5 * 1024 * 1024;

function readImage(value) {
  const match = typeof value === 'string' && /^data:image\/(jpeg|png|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length > Math.ceil(maxImageBytes / 3) * 4) {
    throw new Error('仅支持 5 MiB 以内的 JPEG、PNG、GIF 或 WebP 图片');
  }
  const [, type, encoded] = match;
  const bytes = Buffer.from(encoded, 'base64');
  const valid = {
    jpeg: () => bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
    png: () => bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')),
    gif: () => ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)),
    webp: () => bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
  };
  if (bytes.length > maxImageBytes || bytes.toString('base64') !== encoded || !valid[type]()) {
    throw new Error('图片大小或内容与声明的 MIME 类型不符');
  }
  return { bytes, type };
}

function saveImage(value, image) {
  if (!image || imageStore === 'db') return { url: value || '' };
  fs.mkdirSync(uploadDir, { recursive: true });
  const name = randomUUID() + '.' + image.type;
  const filename = path.join(uploadDir, name);
  try {
    fs.writeFileSync(filename, image.bytes, { flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') fs.rmSync(filename, { force: true });
    throw err;
  }
  return { url: '/uploads/' + name, filename };
}

module.exports = { readImage, saveImage };
