// 导入前的整理：把选中的文件分成视频 / 图片 / 文字稿，生成缩略图，预览文字稿配图
// （配图规则和服务端 server/lib/project.js 的 mapScriptImages 保持一致）

import { findImageByReference, imageReferenceOrdinal, lastImageNumber } from '../../../shared/imageReference.js';

export const MEDIA_RE = /\.(mov|mp4|m4v|avi|mkv|webm|3gp|mts|m4a|mp3|wav|aac|flac|ogg|opus|amr)$/i;
export const AUDIO_RE = /\.(m4a|mp3|wav|aac|flac|ogg|opus|amr)$/i;
export const IMAGE_RE = /\.(jpe?g|png|webp|heic|heif)$/i;
export const SCRIPT_RE = /\.(rtf|txt|md)$/i;

const natural = (a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
// 文件名里最后一段数字（IMG_4313.JPG -> 4313）
export const imageNo = (name) => lastImageNumber(name);

export const fmtBytes = (n) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`;

export const defaultVideoOrder = (list) => [...list].sort((a, b) => natural(a.name, b.name));
export const defaultImageOrder = (list) =>
  [...list].sort((a, b) => Number(imageNo(a.name)) - Number(imageNo(b.name)) || natural(a.name, b.name));

// 选中 / 拖进来的文件 -> 一本绘本
export function classify(list) {
  const seen = new Set();
  const files = [];
  let ignored = 0;
  for (const f of list) {
    const name = f.name;
    if (!name || name.startsWith('.') || seen.has(name)) continue;
    seen.add(name);
    if (MEDIA_RE.test(name) || IMAGE_RE.test(name) || SCRIPT_RE.test(name)) files.push(f);
    else ignored++;
  }
  const scripts = files.filter((f) => SCRIPT_RE.test(f.name));
  return {
    files,
    ignored,
    videos: defaultVideoOrder(files.filter((f) => MEDIA_RE.test(f.name))),
    images: defaultImageOrder(files.filter((f) => IMAGE_RE.test(f.name))),
    scripts,
    script: scripts.find((f) => /zimu|字幕|文字|文稿|script/i.test(f.name)) || scripts[0] || null,
  };
}

// 拖进来的文件夹：递归读出里面的文件
export async function filesFromDrop(dt) {
  const entries = [...dt.items].map((it) => it.webkitGetAsEntry?.()).filter(Boolean);
  const out = [];
  const readDir = (dir) =>
    new Promise((resolve) => {
      const reader = dir.createReader();
      const all = [];
      const next = () =>
        reader.readEntries(
          (batch) => {
            if (!batch.length) return resolve(all);
            all.push(...batch);
            next();
          },
          () => resolve(all),
        );
      next();
    });
  const walk = async (entry) => {
    if (entry.isFile) out.push(await new Promise((res, rej) => entry.file(res, rej)));
    else if (entry.isDirectory) for (const e of await readDir(entry)) await walk(e);
  };
  for (const e of entries) await walk(e);
  const folder = entries.length === 1 && entries[0].isDirectory ? entries[0].name : '';
  return { files: out, folder };
}

// 文字稿每一段配哪张图：note = missing（找不到这张图）/ ordinal（按第几张图）/ inherit（沿用上一张）
export function mapPages(parsed, images) {
  if (!parsed?.length) return images.map((f) => ({ image: f, blocks: [], imageNo: imageNo(f.name), note: null }));
  let last = images[0] || null;
  return parsed.map((s) => {
    let image = last;
    let note = 'inherit';
    if (s.imageNo) {
      const k = imageReferenceOrdinal(s.imageNo);
      image = findImageByReference(s.imageNo, images, (f) => f.name);
      note = null;
      if (!image && k >= 1 && k <= images.length) {
        image = images[k - 1];
        note = 'ordinal';
      }
      if (!image) note = 'missing';
    }
    if (image) last = image;
    return { imageNo: s.imageNo, image, blocks: s.blocks, note };
  });
}

// ---- 缩略图 ----
export async function imageThumb(file, width = 240) {
  try {
    const bmp = await createImageBitmap(file, { resizeWidth: width, resizeQuality: 'medium' });
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close();
    return await new Promise((r) => c.toBlob((b) => r(b ? URL.createObjectURL(b) : null), 'image/jpeg', 0.8));
  } catch {
    return null; // HEIC 等浏览器不能直接显示的格式
  }
}

// 视频：时长 + 第一秒左右的画面；音频：只有时长
export function mediaInfo(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = AUDIO_RE.test(file.name);
    const el = document.createElement(audio ? 'audio' : 'video');
    let finished = false;
    const done = (thumb) => {
      if (finished) return;
      finished = true;
      const duration = Number.isFinite(el.duration) ? el.duration : null;
      el.removeAttribute('src');
      el.load?.();
      URL.revokeObjectURL(url);
      resolve({ duration, thumb, portrait: el.videoHeight > el.videoWidth });
    };
    el.preload = 'metadata';
    el.muted = true;
    el.onerror = () => done(null);
    el.onloadedmetadata = () => {
      if (audio) return done(null);
      el.currentTime = Math.min(1, (el.duration || 3) / 3);
    };
    el.onseeked = () => {
      try {
        const W = 160;
        const H = Math.round((W * (el.videoHeight || 9)) / (el.videoWidth || 16));
        const c = document.createElement('canvas');
        c.width = W;
        c.height = H;
        c.getContext('2d').drawImage(el, 0, 0, W, H);
        c.toBlob((b) => done(b ? URL.createObjectURL(b) : null), 'image/jpeg', 0.75);
      } catch {
        done(null);
      }
    };
    setTimeout(() => done(null), 10000);
    el.src = url;
  });
}

export const move = (list, from, to) => {
  const out = list.slice();
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x);
  return out;
};

// 和默认顺序比：每一项原来在第几个、一共挪动了几项
export function moves(list, defaults) {
  const orig = new Map(defaults.map((f, i) => [f, i]));
  return { orig, moved: list.filter((f, i) => orig.get(f) !== i).length };
}

export const swap = (list, a, b) => {
  const out = list.slice();
  [out[a], out[b]] = [out[b], out[a]];
  return out;
};
