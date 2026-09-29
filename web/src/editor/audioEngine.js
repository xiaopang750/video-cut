// Web Audio 播放引擎：按剪辑列表把多个音源无缝串起来播放（采样级精确，切点处 4ms 淡入淡出）
import { clamp } from './editModel.js';

export const totalOf = (clips) => clips.reduce((s, c) => s + (c.out - c.in), 0);

const BASE = 64;

function buildPeaks(audio) {
  const data = audio.getChannelData(0);
  const n0 = Math.ceil(data.length / BASE);
  let peak = new Float32Array(n0);
  let ms = new Float32Array(n0);
  for (let i = 0; i < n0; i++) {
    const a = i * BASE;
    const b = Math.min(data.length, a + BASE);
    let mx = 0;
    let sq = 0;
    for (let k = a; k < b; k++) {
      const v = data[k];
      const av = v < 0 ? -v : v;
      if (av > mx) mx = av;
      sq += v * v;
    }
    peak[i] = mx;
    ms[i] = sq / Math.max(1, b - a);
  }
  const levels = [{ size: BASE, peak, ms }];
  while (peak.length > 1) {
    const m = Math.ceil(peak.length / 2);
    const p2 = new Float32Array(m);
    const s2 = new Float32Array(m);
    for (let i = 0; i < m; i++) {
      const x = peak[2 * i];
      const y = 2 * i + 1 < peak.length ? peak[2 * i + 1] : 0;
      p2[i] = x > y ? x : y;
      s2[i] = 2 * i + 1 < ms.length ? (ms[2 * i] + ms[2 * i + 1]) / 2 : ms[2 * i];
    }
    peak = p2;
    ms = s2;
    levels.push({ size: levels[levels.length - 1].size * 2, peak, ms });
  }
  let max = 0;
  for (const v of levels[0].peak) if (v > max) max = v;
  // 用 99.5 分位做归一化，避免个别爆音把整体压得很扁
  const sorted = Float32Array.from(levels[Math.min(3, levels.length - 1)].peak).sort();
  const p995 = sorted[Math.floor(sorted.length * 0.995)] || max || 1;
  // 响度（RMS）参考值：约 23ms 一格，取 98 分位，让正常朗读接近满高、停顿接近 0
  const lv = levels[Math.min(4, levels.length - 1)];
  const rmsSorted = Float32Array.from(lv.ms, (v) => Math.sqrt(v)).sort();
  const rmsRef = rmsSorted[Math.floor(rmsSorted.length * 0.98)] || 1e-4;
  return { sr: audio.sampleRate, levels, max: Math.max(p995, 1e-4), rmsRef: Math.max(rmsRef, 1e-4) };
}

// 音源时间 [t0, t1) 内的峰值与均方根
export function peakRange(pk, t0, t1) {
  const s0 = Math.max(0, t0 * pk.sr);
  const s1 = Math.max(s0 + 1, t1 * pk.sr);
  const span = s1 - s0;
  let li = 0;
  while (li + 1 < pk.levels.length && pk.levels[li + 1].size * 2 <= span) li++;
  const L = pk.levels[li];
  const a = Math.floor(s0 / L.size);
  const b = Math.min(L.peak.length, Math.max(a + 1, Math.ceil(s1 / L.size)));
  let peak = 0;
  let ms = 0;
  for (let i = a; i < b; i++) {
    if (L.peak[i] > peak) peak = L.peak[i];
    ms += L.ms[i];
  }
  const rms = Math.sqrt(ms / Math.max(1, b - a));
  return { peak: peak / pk.max, rms: rms / pk.max, loud: rms / pk.rmsRef };
}

export class AudioEngine {
  constructor() {
    try {
      this.ctx = new AudioContext({ sampleRate: 44100, latencyHint: 'interactive' });
    } catch {
      this.ctx = new AudioContext();
    }
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.buffers = new Map();
    this.peaks = new Map();
    this.nodes = [];
    this.previewNodes = [];
    this.previewInfo = null;
    this.playing = false;
    this.startCtx = 0;
    this.startPos = 0;
    this.endPos = 0;
    this.pausedPos = 0;
  }

  async load(src, url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`音频加载失败 (${res.status})`);
    const audio = await this.ctx.decodeAudioData(await res.arrayBuffer());
    this.buffers.set(src, audio);
    this.peaks.set(src, buildPeaks(audio));
    return audio;
  }

  position() {
    if (!this.playing) return this.pausedPos;
    return Math.min(this.endPos, this.startPos + Math.max(0, this.ctx.currentTime - this.startCtx));
  }

  // 把 clips 在成片时间 [from, end) 的部分排进播放队列，返回节点和开始时刻
  schedule(clips, from, end) {
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const nodes = [];
    const t0 = this.ctx.currentTime + 0.05;
    let start = 0;
    for (const c of clips) {
      const len = c.out - c.in;
      const cs = start;
      const ce = start + len;
      start = ce;
      if (ce <= from || cs >= end) continue;
      const buf = this.buffers.get(c.src);
      if (!buf) continue;
      const a = Math.max(cs, from);
      const b = Math.min(ce, end);
      const when = t0 + (a - from);
      const dur = b - a;
      const node = this.ctx.createBufferSource();
      node.buffer = buf;
      const g = this.ctx.createGain();
      const F = Math.min(0.004, dur / 3);
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(1, when + F);
      g.gain.setValueAtTime(1, when + dur - F);
      g.gain.linearRampToValueAtTime(0, when + dur);
      node.connect(g);
      g.connect(this.master);
      node.start(when, c.in + (a - cs), dur);
      nodes.push(node);
    }
    return { nodes, t0 };
  }

  play(clips, from, until = null) {
    this.stopNodes();
    this.stopPreview();
    const total = totalOf(clips);
    from = clamp(from, 0, total);
    const end = until != null ? clamp(until, from, total) : total;
    if (end - from < 0.02) return false;
    const { nodes, t0 } = this.schedule(clips, from, end);
    this.nodes = nodes;
    this.playing = true;
    this.startCtx = t0;
    this.startPos = from;
    this.endPos = end;
    return true;
  }

  pause() {
    this.pausedPos = this.position();
    this.stopNodes();
    this.playing = false;
  }

  // 试听（录音弹窗里用）：独立于主播放，不影响时间轴上的播放头
  preview(clips, from, until) {
    this.stopPreview();
    const total = totalOf(clips);
    from = clamp(from, 0, total);
    const end = clamp(until, from, total);
    if (end - from < 0.02) return null;
    const { nodes, t0 } = this.schedule(clips, from, end);
    this.previewNodes = nodes;
    this.previewInfo = { t0, from, end };
    return this.previewInfo;
  }

  previewPosition() {
    const p = this.previewInfo;
    if (!p) return null;
    const pos = p.from + (this.ctx.currentTime - p.t0);
    if (pos >= p.end) {
      this.previewInfo = null;
      return null;
    }
    return Math.max(p.from, pos);
  }

  stopPreview() {
    for (const n of this.previewNodes) {
      try {
        n.stop();
        n.disconnect();
      } catch {}
    }
    this.previewNodes = [];
    this.previewInfo = null;
  }

  seek(t) {
    this.pausedPos = t;
  }

  stopNodes() {
    for (const n of this.nodes) {
      try {
        n.stop();
        n.disconnect();
      } catch {}
    }
    this.nodes = [];
  }

  dispose() {
    this.stopNodes();
    this.stopPreview();
    this.ctx.close();
  }
}
