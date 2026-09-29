// 最终生成：按剪辑拼接音频 -> 合成每页画面 -> 编码 MP4（可选淡入淡出转场）
import fs from 'node:fs';
import path from 'node:path';
import { FFMPEG, ensureDir, rel } from './config.js';
import { run } from './proc.js';
import { renderClips } from './wav.js';
import { encodeMp3 } from './media.js';
import { composePage } from './compose.js';
import { resolveSize } from './settings.js';
import * as store from './store.js';
import { outputDir, safeName, sourceWav, pageAssets } from './project.js';

// 合并同一音源首尾相接的片段，去掉空片段
export function normalizeClips(clips) {
  const out = [];
  for (const c of clips || []) {
    if (!(c.out - c.in > 0.005)) continue;
    const last = out[out.length - 1];
    if (last && last.src === c.src && Math.abs(last.out - c.in) < 0.002) last.out = c.out;
    else out.push({ ...c });
  }
  return out;
}

// 剪辑记录 -> 实际播放的片段 + 翻页时间（成片时间）。
// 新格式 items 按显示时间轴排列，删除 / 被替换的内容不播放，翻页时间要从显示时间映射到成片时间。
const PLAYED = new Set(['keep', 'new', 'insert']);
export function editForRender(edit) {
  if (!Array.isArray(edit.items) || !edit.items.length) return { clips: edit.clips, pages: edit.pages };
  const rows = [];
  let dt = 0;
  let out = 0;
  for (const it of edit.items) {
    const l = it.out - it.in;
    const played = PLAYED.has(it.kind);
    rows.push({ dt, out, l, played });
    dt += l;
    if (played) out += l;
  }
  const toOut = (t) => {
    for (const r of rows) if (t < r.dt + r.l - 1e-6) return r.played ? r.out + Math.max(0, t - r.dt) : r.out;
    return out;
  };
  return {
    clips: edit.items.filter((it) => PLAYED.has(it.kind)),
    pages: edit.pages.map((p, i) => ({ ...p, start: i === 0 ? 0 : toOut(p.start) })),
  };
}

// 页的起点列表 -> 连续的时间段（时长为 0 的页会被跳过）
export function pageTimeline(pages, duration) {
  const sorted = [...(pages || [])].sort((a, b) => a.start - b.start);
  const tl = [];
  sorted.forEach((pg, i) => {
    const start = i === 0 ? 0 : Math.max(0, Math.min(duration, pg.start));
    const end = i + 1 < sorted.length ? Math.max(0, Math.min(duration, sorted[i + 1].start)) : duration;
    if (end - start >= 0.04) tl.push({ seg: pg.seg, start, end });
  });
  if (tl.length) tl[0].start = 0;
  return tl;
}

const quote = (p) => `'${p.replace(/'/g, "'\\''")}'`;

async function encodeVideo({ frames, audio, duration, settings, out, workDir, onProgress, signal }) {
  const v = settings.video;
  const fps = v.fps || 30;
  const n = frames.length;
  let T = v.transition === 'fade' && n > 1 ? v.transitionDuration || 0.3 : 0;
  if (T > 0) {
    const minDur = Math.min(...frames.map((f) => f.end - f.start));
    T = Math.min(T, minDur * 0.8);
    if (T < 0.08) T = 0;
  }

  const common = [
    '-c:v', 'libx264', '-preset', 'medium', '-tune', 'stillimage', '-crf', String(v.crf || 20),
    '-pix_fmt', 'yuv420p', '-r', String(fps),
    '-c:a', 'aac', '-b:a', v.audioBitrate || '256k', '-ar', '44100',
    ...(v.loudnorm ? ['-af', 'loudnorm=I=-16:TP=-1.5:LRA=11'] : []),
    '-movflags', '+faststart', '-shortest', '-progress', 'pipe:1', '-nostats', out,
  ];

  let args;
  if (!T) {
    const list = path.join(workDir, 'frames.ffconcat');
    const lines = ['ffconcat version 1.0'];
    for (const f of frames) lines.push(`file ${quote(f.path)}`, `duration ${(f.end - f.start).toFixed(4)}`);
    lines.push(`file ${quote(frames[n - 1].path)}`);
    fs.writeFileSync(list, lines.join('\n'));
    args = [
      '-nostdin', '-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-i', audio,
      '-map', '0:v', '-map', '1:a', '-vf', `fps=${fps},format=yuv420p`, ...common,
    ];
  } else {
    // 每页一个循环静帧输入，用 xfade 串起来；转场居中落在翻页时间点上
    const inputs = [];
    frames.forEach((f, i) => {
      let len;
      if (i === 0) len = f.end + T / 2;
      else if (i === n - 1) len = duration - f.start + T / 2;
      else len = f.end - f.start + T;
      inputs.push('-loop', '1', '-framerate', String(fps), '-t', len.toFixed(4), '-i', f.path);
    });
    inputs.push('-i', audio);
    const chains = frames.map((_, i) => `[${i}:v]format=yuv420p,setsar=1,fps=${fps},settb=AVTB[v${i}]`);
    let last = 'v0';
    for (let k = 1; k < n; k++) {
      const label = k === n - 1 ? 'vout' : `x${k}`;
      chains.push(
        `[${last}][v${k}]xfade=transition=fade:duration=${T.toFixed(4)}:offset=${(frames[k].start - T / 2).toFixed(4)}[${label}]`,
      );
      last = label;
    }
    const script = path.join(workDir, 'filter.txt');
    fs.writeFileSync(script, chains.join(';\n'));
    args = ['-nostdin', '-y', '-v', 'error', ...inputs, '-filter_complex_script', script, '-map', '[vout]', '-map', `${n}:a`, ...common];
  }

  await run(FFMPEG, args, {
    signal,
    onStdoutLine: (line) => {
      const m = line.match(/^out_time_(?:us|ms)=(\d+)/);
      if (m) onProgress?.(Math.min(1, Number(m[1]) / 1e6 / duration));
    },
  });
}

export async function renderVideo(id, { report, signal }) {
  const p = store.getProject(id);
  if (!p?.edit) throw new Error('项目还没有初始化');
  const settings = p.settings;
  const dir = ensureDir(store.projectPath(id, 'render'));
  const pagesDir = path.join(dir, 'pages');
  fs.rmSync(pagesDir, { recursive: true, force: true });
  ensureDir(pagesDir);

  report(0.02, '拼接剪辑后的音频');
  const plan = editForRender(p.edit);
  const clips = normalizeClips(plan.clips).map((c) => ({ file: sourceWav(id, c.src), in: c.in, out: c.out }));
  for (const c of clips) if (!fs.existsSync(c.file)) throw new Error('缺少音源文件，请重新初始化项目');
  const audioWav = path.join(dir, 'audio.wav');
  const { duration } = renderClips(clips, audioWav);
  if (duration < 0.5) throw new Error('剪辑后的音频太短');

  const timeline = pageTimeline(plan.pages, duration);
  if (!timeline.length) throw new Error('没有可以显示的页面');
  const assets = new Map(pageAssets(p).map((a) => [a.id, a]));
  const size = resolveSize(settings);
  const cacheDir = store.projectPath(id, 'cache');
  const frames = [];
  for (let i = 0; i < timeline.length; i++) {
    if (signal.aborted) throw new Error('已取消');
    report(0.05 + (0.2 * i) / timeline.length, `合成画面 ${i + 1}/${timeline.length}`);
    const t = timeline[i];
    const asset = assets.get(t.seg) || { photo: null, blocks: [] };
    const file = path.join(pagesDir, `p${String(i + 1).padStart(3, '0')}.jpg`);
    fs.writeFileSync(file, await composePage(asset, settings, { ...size, cacheDir, quality: 95 }));
    frames.push({ ...t, path: file });
  }

  report(0.26, '编码视频');
  const outDir = outputDir(p);
  const base = safeName(p.name);
  const tmpVideo = path.join(dir, 'video.mp4');
  await encodeVideo({
    frames,
    audio: audioWav,
    duration,
    settings,
    out: tmpVideo,
    workDir: dir,
    signal,
    onProgress: (f) => report(0.26 + 0.66 * f, `编码视频 ${Math.round(f * 100)}%`),
  });
  const videoOut = path.join(outDir, `${base}.mp4`);
  fs.copyFileSync(tmpVideo, videoOut);
  fs.rmSync(tmpVideo, { force: true });

  report(0.94, '导出剪辑后的音频');
  const audioOut = path.join(outDir, `${base}.mp3`);
  await encodeMp3(audioWav, audioOut, '320k');

  // 中间文件（拼好的 WAV、每页 JPG）下次生成会重建，这里清掉省空间
  fs.rmSync(dir, { recursive: true, force: true });

  const output = {
    video: rel(videoOut),
    audio: rel(audioOut),
    duration: +duration.toFixed(2),
    pages: timeline.length,
    size,
    renderedAt: Date.now(),
    editRev: p.edit.rev || 0,
  };
  store.updateProject(id, (q) => {
    q.output = { ...(q.output || {}), ...output };
  });
  report(1, '完成');
  return output;
}
