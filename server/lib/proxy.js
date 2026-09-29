// 原始视频预览：把各段视频按「音轨时间」截取、缩小后合并成一个低清预览视频，
// 和音频时间轴一一对应（iPhone 视频的音轨通常比画面晚 0.x 秒开始，要从音轨起点截）。
import fs from 'node:fs';
import path from 'node:path';
import { FFMPEG, ensureDir } from './config.js';
import { run } from './proc.js';
import { probe } from './media.js';

export const PROXY_FPS = 25;
const SCALE = 'scale=640:640:force_original_aspect_ratio=decrease:force_divisible_by=2';

// 第一个音频帧在容器时间轴上的位置
export async function firstAudioPts(file) {
  let pts = null;
  try {
    await run(FFMPEG, ['-nostdin', '-hide_banner', '-i', file, '-map', '0:a:0', '-frames:a', '1', '-af', 'ashowinfo', '-f', 'null', '-'], {
      onStderrLine: (line) => {
        const m = line.match(/pts_time:([\d.]+)/);
        if (m && pts == null) pts = Number(m[1]);
      },
    });
  } catch {}
  return pts || 0;
}

async function encodeSegment({ file, audioStart, frames, size, out, signal }) {
  const tail = [
    '-frames:v', String(frames),
    '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30',
    '-g', '12', '-sc_threshold', '0', '-pix_fmt', 'yuv420p', out,
  ];
  if (!file) {
    // 没有画面的片段（纯音频）：用黑屏占位，保证时间轴连续
    await run(FFMPEG, ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=black:s=${size}:r=${PROXY_FPS}`, ...tail], { signal });
    return;
  }
  const vf = ['-vf', `fps=${PROXY_FPS},${SCALE},format=yuv420p,tpad=stop_mode=clone:stop_duration=3`];
  const input = ['-ss', audioStart.toFixed(3), '-i', file];
  const hw = process.platform === 'darwin' ? ['-hwaccel', 'videotoolbox'] : [];
  try {
    await run(FFMPEG, ['-nostdin', '-y', '-v', 'error', ...hw, ...input, ...vf, ...tail], { signal });
  } catch (e) {
    if (signal?.aborted || !hw.length) throw e;
    await run(FFMPEG, ['-nostdin', '-y', '-v', 'error', ...input, ...vf, ...tail], { signal });
  }
}

/**
 * items: [{ file|null, audioStart, start, duration }]（start/duration 为音频时间轴上的位置）
 * 返回 { segs: [{ start, end, vstart }], width, height }
 */
export async function buildProxy(items, out, { workDir, signal, onProgress } = {}) {
  ensureDir(workDir);
  const parts = [];
  const segs = [];
  let vstart = 0;
  let size = '360x640';
  for (let i = 0; i < items.length; i++) {
    if (signal?.aborted) throw new Error('已取消');
    const it = items[i];
    const frames = Math.max(1, Math.round(it.duration * PROXY_FPS));
    const part = path.join(workDir, `vseg-${String(i + 1).padStart(3, '0')}.mp4`);
    await encodeSegment({ file: it.file, audioStart: it.audioStart || 0, frames, size, out: part, signal });
    if (i === 0 || !parts.length) {
      const info = await probe(part).catch(() => null);
      if (info?.video?.width) size = `${info.video.width}x${info.video.height}`;
    }
    parts.push(part);
    segs.push({ start: +it.start.toFixed(4), end: +(it.start + it.duration).toFixed(4), vstart: +vstart.toFixed(4) });
    vstart += frames / PROXY_FPS;
    onProgress?.((i + 1) / items.length);
  }
  const list = path.join(workDir, 'vsegs.txt');
  fs.writeFileSync(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
  await run(FFMPEG, ['-nostdin', '-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out], { signal });
  for (const p of parts) fs.rmSync(p, { force: true });
  fs.rmSync(list, { force: true });
  const [w, h] = size.split('x').map(Number);
  return { segs, width: w, height: h, v: Date.now() };
}
