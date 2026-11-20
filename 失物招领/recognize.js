/**
 * 服务端物品识别模块（小程序 / 网页版共用）
 * ------------------------------------------------------------------
 * 用 tfjs + wasm backend（纯 JS，无原生编译依赖）加载本地 TFHub MobileNetV2 图模型，
 * 对上传图片做：解码 -> 等比缩放+中心裁剪到 224 -> 归一化 [0,1] -> 推理 -> softmax
 * -> topK(20) -> 类目聚合（recognize-map.js）-> 中文物品名 + 数据库分类 + 主色。
 *
 * 与网页版 public/recognize.html 的识别结果口径保持一致（同一模型、同一预处理、同一映射表）。
 *
 * 注意：
 *  - 模型懒加载（首次调用才加载，全局复用），避免拖慢服务启动；
 *  - wasm 二进制由 @tensorflow/tfjs-backend-wasm 自带（node_modules 内），无需服务器编译；
 *  - 图片解码用 jpeg-js / pngjs（纯 JS），仅支持 JPEG / PNG（小程序端先压缩转格式）。
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const tf = require('@tensorflow/tfjs');
require('@tensorflow/tfjs-backend-wasm');
const jpeg = require('jpeg-js');
const { PNG } = require('pngjs');
const { mapPredictions } = require('./recognize-map');

const MODEL_DIR = path.join(__dirname, 'public', 'models', 'mobilenet');
const LABELS_PATH = path.join(__dirname, 'public', 'vendor', 'imagenet_labels.js');

const TOP_K = 20;
const REJECT_THRESHOLD = 0.22; // 与网页版一致：聚合后低于该值判定「未能确定」

let _labels = null;
let _modelPromise = null;

/** 从 vendor/imagenet_labels.js（挂 window 的 UMD 脚本）读取标签数组 */
function loadLabels() {
  if (_labels) return _labels;
  const src = fs.readFileSync(LABELS_PATH, 'utf8');
  const match = /window\.IMAGENET_LABELS\s*=\s*(\[[\s\S]*?\])\s*;/.exec(src);
  if (!match) throw new Error('无法解析 imagenet_labels.js');
  _labels = JSON.parse(match[1]);
  return _labels;
}

/** 自定义 IOHandler：直接从本地文件加载 TFHub 图模型（Node 无 file:// fetch） */
function fileIOHandler(modelDir) {
  return {
    async load() {
      const modelJson = JSON.parse(fs.readFileSync(path.join(modelDir, 'model.json'), 'utf8'));
      const weightSpecs = [];
      const parts = [];
      for (const group of modelJson.weightsManifest) {
        for (const w of group.paths) parts.push(fs.readFileSync(path.join(modelDir, w)));
        weightSpecs.push(...group.weights);
      }
      return {
        modelTopology: modelJson.modelTopology,
        weightSpecs,
        weightData: Buffer.concat(parts)
      };
    }
  };
}

/** 懒加载并复用模型 */
function loadModel() {
  if (!_modelPromise) {
    _modelPromise = (async () => {
      await tf.setBackend('wasm');
      await tf.ready();
      return tf.loadGraphModel(fileIOHandler(MODEL_DIR));
    })();
  }
  return _modelPromise;
}

/** 软最大化 */
function softmax(arr) {
  const m = Math.max.apply(null, arr);
  const e = arr.map(x => Math.exp(x - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map(x => x / s);
}

/** 前 K 个概率 */
function topK(probs, k) {
  return probs.map((p, i) => ({ i, p })).sort((a, b) => b.p - a.p).slice(0, k);
}

/** 解码图片（JPEG / PNG）为 { width, height, rgb: Float32Array }，并按需压缩缩放 */
function decodeImage(buffer) {
  let raw;
  if (buffer.length >= 8 && buffer.toString('ascii', 1, 4) === 'PNG') {
    const png = PNG.sync.read(buffer);
    raw = { width: png.width, height: png.height, data: png.data }; // RGBA
  } else if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    raw = jpeg.decode(buffer, { useTArray: true }); // {width,height,data}
  } else {
    throw new Error('仅支持 JPEG / PNG 图片');
  }
  const { width, height, data } = raw;
  const rgb = new Float32Array(width * height * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    rgb[j] = data[i];
    rgb[j + 1] = data[i + 1];
    rgb[j + 2] = data[i + 2];
  }
  return { width, height, rgb };
}

/**
 * 主色提取（纯像素版，与网页版 extractDominantColor 口径一致）：
 * 中心 60% 区域 + 剔除近白/近黑 + k-means(k=3) 主簇 + HSV 中文色名。
 * @param {Float32Array} rgb 整图 RGB
 * @param {number} width
 * @param {number} height
 */
function extractDominantColor(rgb, width, height) {
  const classifyColor = (r, g, b) => {
    // HSV 归类（与网页版 classifyColor 一致）
    const rn = r / 255, gn = g / 255, bn = b / 255;
    const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn), d = max - min;
    let h = 0;
    if (d !== 0) {
      if (max === rn) h = ((gn - bn) / d) % 6;
      else if (max === gn) h = (bn - rn) / d + 2;
      else h = (rn - gn) / d + 4;
      h = Math.round(h * 60); if (h < 0) h += 360;
    }
    const s = max === 0 ? 0 : d / max, v = max;
    if (s < 0.18) { if (v > 0.82) return '白色'; if (v > 0.55) return '银色'; if (v > 0.28) return '灰色'; return '黑色'; }
    if (v < 0.55 && h >= 15 && h <= 55) return '棕色';
    if (h < 15 || h >= 345) return '红色';
    if (h < 70) return '黄色';
    if (h < 170) return '绿色';
    if (h < 255) return '蓝色';
    if (h < 315) return '紫色';
    if (h < 345) return '粉色';
    return '红色';
  };

  // 中心 60% 区域采样
  const cw = Math.max(1, Math.round(width * 0.6));
  const ch = Math.max(1, Math.round(height * 0.6));
  const sx = Math.round((width - cw) / 2);
  const sy = Math.round((height - ch) / 2);
  const isNearWhite = (r, g, b) => r > 225 && g > 225 && b > 225;
  const isNearBlack = (r, g, b) => r < 28 && g < 28 && b < 28;

  const collect = (x0, y0, w, h) => {
    const out = [];
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const i = (y * width + x) * 3;
        const r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
        if (isNearWhite(r, g, b) || isNearBlack(r, g, b)) continue;
        out.push([r, g, b]);
      }
    }
    return out;
  };

  let samples = collect(sx, sy, cw, ch);
  if (samples.length < 30) {
    // 回退全图
    const all = [];
    for (let i = 0; i < rgb.length; i += 3) {
      const r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
      if (isNearWhite(r, g, b) || isNearBlack(r, g, b)) continue;
      all.push([r, g, b]);
    }
    samples = all;
  }
  if (samples.length === 0) return { name: '未知', hex: '#888888', confidence: 0 };

  // k-means(k=3)
  const k = 3;
  const centroids = [];
  for (let i = 0; i < k; i++) centroids.push(samples[Math.floor(i * (samples.length / k))].slice());
  const assign = new Array(samples.length).fill(0);
  for (let iter = 0; iter < 12; iter++) {
    const sums = Array.from({ length: k }, () => [0, 0, 0, 0]);
    for (let i = 0; i < samples.length; i++) {
      const p = samples[i]; let best = 0, bd = Infinity;
      for (let c = 0; c < k; c++) {
        const d = (p[0] - centroids[c][0]) ** 2 + (p[1] - centroids[c][1]) ** 2 + (p[2] - centroids[c][2]) ** 2;
        if (d < bd) { bd = d; best = c; }
      }
      assign[i] = best;
      const s = sums[best];
      s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3]++;
    }
    for (let c = 0; c < k; c++) { const s = sums[c]; if (s[3] > 0) centroids[c] = [Math.round(s[0] / s[3]), Math.round(s[1] / s[3]), Math.round(s[2] / s[3])]; }
  }
  const counts = new Array(k).fill(0);
  for (let i = 0; i < assign.length; i++) counts[assign[i]]++;
  let dom = 0;
  for (let c = 1; c < k; c++) if (counts[c] > counts[dom]) dom = c;
  const avg = centroids[dom];
  const hex = '#' + avg.map(v => v.toString(16).padStart(2, '0')).join('');
  return { name: classifyColor(avg[0], avg[1], avg[2]), hex, confidence: Math.round((counts[dom] / samples.length) * 100) };
}

/**
 * 识别一张图片（Buffer），返回与网页版 realRecognition 对齐的结果：
 * { type, category, confidence, color, colorHex, colorConfidence, rawType, candidates, rejected, error? }
 *  - rejected=true 表示聚合概率低于拒识阈值（模型没把握），调用方可提示「未能确定」。
 */
async function recognizeImage(buffer) {
  const { width, height, rgb } = decodeImage(buffer);
  const color = extractDominantColor(rgb, width, height);

  const model = await loadModel();
  // 等比缩放 + 中心裁剪到 224（与网页版 predictImage 一致）
  const scale = Math.min(224 / width, 224 / height);
  const nw = Math.max(1, Math.round(width * scale));
  const nh = Math.max(1, Math.round(height * scale));
  const result = tf.tidy(() => {
    let img = tf.tensor3d(rgb, [height, width, 3]);
    img = tf.image.resizeBilinear(img, [nh, nw]);
    const offW = Math.max(0, Math.floor((nw - 224) / 2));
    const offH = Math.max(0, Math.floor((nh - 224) / 2));
    const cw = Math.min(224, nw), ch = Math.min(224, nh);
    if (nw !== 224 || nh !== 224) {
      img = tf.image.cropAndResize(
        img.expandDims(0),
        [[offH / nh, offW / nw, (offH + ch) / nh, (offW + cw) / nw]],
        [0], [224, 224]
      ).squeeze();
    }
    const batched = img.div(255).expandDims(0);
    return model.predict(batched);
  });
  const data = Array.from(await result.data());
  result.dispose();

  const labels = loadLabels();
  const probs = softmax(data);
  const top = topK(probs, TOP_K).map(t => ({
    className: labels[t.i] || ('class_' + t.i),
    probability: t.p
  }));

  const mapped = mapPredictions(top);
  const primary = mapped.primary;
  const confidence = Math.round((primary.prob || 0) * 100);
  const rejected = (primary.prob || 0) < REJECT_THRESHOLD;

  return {
    type: rejected ? '未能确定' : primary.type,
    category: primary.category,
    confidence,
    color: color.name,
    colorHex: color.hex,
    colorConfidence: color.confidence,
    rawType: primary.raw || primary.type,
    candidates: mapped.candidates,
    rejected,
    model: 'MobileNetV2'
  };
}

/** 识别是否可用（模型文件存在性检查） */
function enabled() {
  try {
    return fs.existsSync(path.join(MODEL_DIR, 'model.json')) &&
      fs.existsSync(path.join(MODEL_DIR, 'group1-shard1of4'));
  } catch (e) {
    return false;
  }
}

module.exports = { recognizeImage, enabled };
