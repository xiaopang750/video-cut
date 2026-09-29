// 图文合成：上方照片 + 中间中英文字 + 左下角水印卡片（复刻 doc/pic.png 的版式）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import sharp from 'sharp';
import { run } from './proc.js';
import { ensureDir } from './config.js';
import { CJK_RE } from './whisper.js';

sharp.cache(false);

const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

// HEIC 等 sharp 不支持的格式，在 macOS 上用系统自带 sips 转成 JPG
async function decodablePath(file, cacheDir) {
  if (!/\.(heic|heif)$/i.test(file)) return file;
  const out = path.join(ensureDir(cacheDir), `heic-${hash(file + fs.statSync(file).mtimeMs)}.jpg`);
  if (!fs.existsSync(out)) await run('sips', ['-s', 'format', 'jpeg', file, '--out', out]);
  return out;
}

export async function photoBuffer(file, { width, height, fit = 'cover', focus = 'centre', background = '#ffffff', cacheDir }) {
  const key = hash([file, fs.statSync(file).mtimeMs, width, height, fit, focus, background].join('|'));
  const cachePath = cacheDir ? path.join(cacheDir, `photo-${key}.jpg`) : null;
  if (cachePath && fs.existsSync(cachePath)) return fs.readFileSync(cachePath);
  const src = await decodablePath(file, cacheDir);
  let img = sharp(src, { failOn: 'none' }).rotate();
  img =
    fit === 'contain'
      ? img.resize(width, height, { fit: 'contain', background })
      : img.resize(width, height, { fit: 'cover', position: focus });
  const buf = await img.jpeg({ quality: 93 }).toBuffer();
  if (cachePath) {
    ensureDir(cacheDir);
    fs.writeFileSync(cachePath, buf);
  }
  return buf;
}

export async function thumbnail(file, width, cacheDir) {
  const key = hash([file, fs.statSync(file).mtimeMs, width].join('|'));
  const cachePath = path.join(ensureDir(cacheDir), `thumb-${key}.jpg`);
  if (fs.existsSync(cachePath)) return cachePath;
  const src = await decodablePath(file, cacheDir);
  await sharp(src, { failOn: 'none' }).rotate().resize({ width, withoutEnlargement: true }).jpeg({ quality: 82 }).toFile(cachePath);
  return cachePath;
}

// ---------- 排版 ----------

const OPENING = /^[“‘（《「『【(\[]$/;
const CLOSING = /^[”’）》」』】)\]，。！？、；：,.!?;:…—%]$/;

// 拆成不可再分的排版单元：英文单词（带后随空格）、单个汉字/标点
function units(text) {
  const raw = text.match(/[A-Za-z0-9À-ɏ'’\-]+[ \t]*|[^\sA-Za-z0-9À-ɏ][ \t]*|\s+/g) || [];
  const out = [];
  let pendingOpen = '';
  for (let i = 0; i < raw.length; i++) {
    let u = raw[i];
    const core = u.trim();
    const isStraightQuote = core === '"' || core === "'";
    const opening = OPENING.test(core) || (isStraightQuote && (i === 0 || /\s$/.test(raw[i - 1])));
    const closing = !opening && (CLOSING.test(core) || isStraightQuote);
    if (!core) {
      if (out.length) out[out.length - 1] += u;
      continue;
    }
    if (opening) {
      pendingOpen += u;
      continue;
    }
    u = pendingOpen + u;
    pendingOpen = '';
    if (closing && out.length) out[out.length - 1] = out[out.length - 1].trimEnd() + u;
    else out.push(u);
  }
  if (pendingOpen) out.push(pendingOpen);
  return out;
}

function wrap(ctx, text, maxWidth) {
  const lines = [];
  let cur = '';
  for (const u of units(text)) {
    const test = cur + u;
    if (!cur || ctx.measureText(test.trimEnd()).width <= maxWidth) cur = test;
    else {
      lines.push(cur.trimEnd());
      cur = u.trimStart();
    }
  }
  if (cur.trim()) lines.push(cur.trimEnd());
  return lines;
}

const isZh = (text) => {
  const cjk = (text.match(new RegExp(CJK_RE.source, 'g')) || []).length;
  return cjk > 0 && cjk >= (text.match(/[A-Za-z]/g) || []).length * 0.3;
};

function fontStr(size, family, weight = 400) {
  return `${weight} ${size.toFixed(2)}px "${family}", "PingFang SC", "Hiragino Sans GB", sans-serif`;
}

function layoutText(ctx, blocks, { k, scale, maxWidth, t }) {
  const pitch = t.linePitch * k * scale;
  const gap = t.blockGap * k * scale;
  const out = [];
  let y = 0;
  blocks.forEach((block, bi) => {
    if (bi > 0) y += gap;
    for (const text of block) {
      const size = (isZh(text) ? t.zhSize : t.enSize) * k * scale;
      ctx.font = fontStr(size, t.fontFamily);
      for (const line of wrap(ctx, text, maxWidth)) {
        out.push({ text: line, size, y: y + pitch / 2 });
        y += pitch;
      }
    }
  });
  return { lines: out, height: y };
}

function drawDocIcon(ctx, x, y, w, h, k) {
  const r = 4 * k;
  const fold = 15 * k;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - fold, y);
  ctx.lineTo(x + w, y + fold);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fillStyle = '#D05550';
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x + w - fold, y);
  ctx.lineTo(x + w - fold, y + fold - 2 * k);
  ctx.quadraticCurveTo(x + w - fold, y + fold, x + w - fold + 2 * k, y + fold);
  ctx.lineTo(x + w, y + fold);
  ctx.closePath();
  ctx.fillStyle = '#A83F3B';
  ctx.fill();
  ctx.fillStyle = '#FFFFFF';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = fontStr(19 * k, 'PingFang SC', 600);
  ctx.fillText('PDF', x + w / 2, y + h - 17 * k);
}

function drawWatermark(ctx, W, H, k, wm, family) {
  const titleSize = 18 * k;
  const subSize = 14 * k;
  const padX = 8 * k;
  const iconW = wm.icon === 'pdf' ? 51 * k : 0;
  ctx.font = fontStr(titleSize, family);
  const titleW = ctx.measureText(wm.title || '').width;
  ctx.font = fontStr(subSize, family);
  const subW = ctx.measureText(wm.subtitle || '').width;
  const cardW = Math.min(W * 0.92, Math.max(360 * k, padX + Math.max(titleW, subW) + 24 * k + iconW + 11 * k));
  const cardH = 94 * k;
  const cardY = H - cardH;
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, cardY, cardW, cardH);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = fontStr(titleSize, family);
  const title = wm.title || '';
  const hl = wm.highlight && title.includes(wm.highlight) ? wm.highlight : null;
  const parts = hl ? title.split(hl).flatMap((p, i, arr) => (i < arr.length - 1 ? [[p, false], [hl, true]] : [[p, false]])) : [[title, false]];
  let x = padX;
  for (const [text, isHl] of parts) {
    if (!text) continue;
    ctx.fillStyle = isHl ? wm.highlightColor || '#40A053' : '#191919';
    ctx.fillText(text, x, cardY + 31 * k);
    x += ctx.measureText(text).width;
  }
  if (wm.subtitle) {
    ctx.font = fontStr(subSize, family);
    ctx.fillStyle = '#A7A7A7';
    ctx.fillText(wm.subtitle, padX, cardY + 57 * k);
  }
  if (wm.icon === 'pdf') drawDocIcon(ctx, cardW - 11 * k - iconW, cardY + 14 * k, iconW, 65 * k, k);
  return cardY;
}

/**
 * 合成一页，返回 JPEG Buffer
 * page: { photo: 图片绝对路径 | null, blocks: [[行...]] }
 */
export async function composePage(page, settings, { width, height, cacheDir, quality = 92 }) {
  const W = width;
  const H = height;
  const k = W / 750;
  const L = settings.layout;
  const t = settings.text;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = L.background;
  ctx.fillRect(0, 0, W, H);

  const photoH = Math.round(W * L.photoRatio);
  if (page.photo && fs.existsSync(page.photo)) {
    const buf = await photoBuffer(page.photo, {
      width: W,
      height: photoH,
      fit: L.photoFit,
      focus: L.photoFocus,
      background: L.background,
      cacheDir,
    });
    ctx.drawImage(await loadImage(buf), 0, 0, W, photoH);
  }

  const wm = settings.watermark;
  const textBottom = wm.enabled ? drawWatermark(ctx, W, H, k, wm, t.fontFamily) : H;

  const blocks = (page.blocks || []).filter((b) => b.length);
  if (blocks.length) {
    const padY = 16 * k;
    const areaTop = photoH + padY;
    const areaH = textBottom - padY - areaTop;
    const maxWidth = W - 2 * 30 * k;
    let scale = t.scale || 1;
    let lay = layoutText(ctx, blocks, { k, scale, maxWidth, t });
    for (let i = 0; i < 40 && lay.height > areaH && scale > 0.4; i++) {
      scale *= 0.96;
      lay = layoutText(ctx, blocks, { k, scale, maxWidth, t });
    }
    const top = areaTop + Math.max(0, (areaH - lay.height) / 2);
    ctx.fillStyle = t.color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const line of lay.lines) {
      ctx.font = fontStr(line.size, t.fontFamily);
      ctx.fillText(line.text, W / 2, top + line.y);
    }
  }
  return canvas.encode('jpeg', quality);
}
