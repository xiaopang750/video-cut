// whisper.cpp 调用与结果解析。
// 输出统一的词级时间轴：[{ t0, t1, text, p }]（秒）。
import fs from 'node:fs';
import os from 'node:os';
import { WHISPER_BIN, whisperModel, dtwPresetFor } from './config.js';
import { run } from './proc.js';
import { envelope } from './wav.js';

export const CJK_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/;
const WORD_CHAR_RE = /[\p{L}\p{N}'’]/u;
const OPENING_RE = /[“"‘'(（《「【\[]/;

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// 在能量包络里找 [from, to] 之间的第一个起音点
export function findOnset(envInfo, from, to) {
  const { env, fps, threshold } = envInfo;
  const a = Math.max(0, Math.floor(from * fps));
  const b = Math.min(env.length - 3, Math.ceil(to * fps));
  for (let f = a; f < b; f++) {
    if (env[f] > threshold && env[f + 1] > threshold && env[f + 2] > threshold) return f / fps;
  }
  return null;
}

export function analyzeEnvelope(file16k) {
  const e = envelope(file16k);
  const sorted = Float32Array.from(e.env).sort();
  const floor = sorted[Math.floor(sorted.length * 0.1)] || 0;
  const loud = sorted[Math.floor(sorted.length * 0.9)] || 1;
  return { ...e, floor, loud, threshold: floor + (loud - floor) * 0.12 };
}

function parseJson(file) {
  // 以 latin1 读取：JSON 结构字符都是 ASCII，token 文本保留原始字节，
  // 这样被 BPE 拆开的多字节汉字可以在拼接后再按 UTF-8 解码
  const j = JSON.parse(fs.readFileSync(file, 'latin1'));
  return {
    language: j.result?.language || null,
    segments: (j.transcription || []).map((s) => ({
      t0: s.offsets.from / 1000,
      t1: s.offsets.to / 1000,
      tokens: s.tokens || [],
    })),
  };
}

function segmentWords(seg) {
  const dec = new TextDecoder('utf-8');
  const words = [];
  let cur = null;
  for (const tk of seg.tokens) {
    if (tk.text.startsWith('[_')) continue;
    const str = dec.decode(Buffer.from(tk.text, 'latin1'), { stream: true });
    const dtw = tk.t_dtw >= 0 ? tk.t_dtw / 100 : null;
    const off = tk.offsets.from / 1000;
    for (const ch of str) {
      if (/\s/.test(ch)) {
        cur = null;
        continue;
      }
      if (CJK_RE.test(ch)) {
        words.push({ text: ch, dtw, off, p: tk.p, cjk: true });
        cur = null;
        continue;
      }
      if (WORD_CHAR_RE.test(ch)) {
        if (!cur) {
          cur = { text: '', dtw, off, p: tk.p };
          words.push(cur);
        }
        cur.text += ch;
        cur.p = Math.min(cur.p, tk.p);
        continue;
      }
      // 标点：开引号跟随下一个词，其余附着在前一个词上
      if (cur) cur.text += ch;
      else if (OPENING_RE.test(ch)) {
        cur = { text: ch, dtw, off, p: tk.p, lead: true };
        words.push(cur);
      } else if (words.length) words[words.length - 1].text += ch;
    }
  }
  // 纯标点的"词"合并到相邻词
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!/[\p{L}\p{N}]/u.test(w.text)) {
      if (i + 1 < words.length) words[i + 1].text = w.text + words[i + 1].text;
      else if (out.length) out[out.length - 1].text += w.text;
      continue;
    }
    out.push(w);
  }
  return out;
}

function maxWordDur(w) {
  if (w.cjk) return 0.55;
  return 0.35 + 0.085 * w.text.replace(/[^\p{L}\p{N}]/gu, '').length;
}

// 生成最终时间：DTW 时间减去校准偏移，保证单调且落在片段范围内
function timeWords(seg, words, lag) {
  let prev = seg.t0 - 0.1;
  for (const w of words) {
    let t = w.dtw != null ? w.dtw - lag : w.off;
    t = Math.min(Math.max(t, seg.t0 - 0.1, prev + 0.02), seg.t1 - 0.05);
    w.t0 = Math.max(0, t);
    prev = w.t0;
  }
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = i + 1 < words.length ? words[i + 1].t0 : seg.t1 + 0.1;
    w.t1 = Math.max(w.t0 + 0.05, Math.min(next - 0.01, w.t0 + maxWordDur(w), seg.t1 + 0.1));
  }
}

/**
 * items: [{ wav16k, offset, duration }] —— 多个文件一次调用（模型只加载一次）
 * 返回 { language, lag, words, segments }，时间已加上各自 offset
 */
export async function transcribe(items, { language = 'auto', prompt = '', onProgress, signal } = {}) {
  const model = whisperModel();
  if (!WHISPER_BIN || !model) throw new Error('未找到 whisper-cli 或模型文件，请先运行 npm run setup');
  const dtw = dtwPresetFor(model);
  const args = ['-m', model, '-l', language || 'auto', '-mc', '0', '-sns', '-ojf', '-pp'];
  args.push('-t', String(Math.max(2, Math.min(8, os.cpus().length))));
  if (dtw) args.push('-dtw', dtw, '-nfa');
  if (prompt) args.push('--prompt', prompt);
  for (const it of items) {
    fs.rmSync(`${it.wav16k}.json`, { force: true });
    args.push('-f', it.wav16k);
  }

  const total = items.reduce((s, it) => s + (it.duration || 1), 0) || 1;
  let idx = -1;
  let done = 0;
  await run(WHISPER_BIN, args, {
    signal,
    onStderrLine: (line) => {
      if (/processing '/.test(line)) {
        if (idx >= 0) done += items[idx].duration || 1;
        idx = Math.min(idx + 1, items.length - 1);
        onProgress?.(done / total);
        return;
      }
      const p = line.match(/progress\s*=\s*(\d+)%/);
      if (p && idx >= 0) onProgress?.((done + ((items[idx].duration || 1) * Number(p[1])) / 100) / total);
    },
  });

  const results = items.map((it) => {
    const file = `${it.wav16k}.json`;
    if (!fs.existsSync(file)) throw new Error(`whisper 没有生成结果文件: ${file}`);
    const r = parseJson(file);
    r.segments.forEach((s) => (s.words = segmentWords(s)));
    return r;
  });

  // DTW 时间戳普遍偏晚且偏差稳定：用每句第一个词对比能量起音点，取中位数作为校准量
  const diffs = [];
  items.forEach((it, i) => {
    const envInfo = analyzeEnvelope(it.wav16k);
    for (const s of results[i].segments) {
      const w = s.words[0];
      if (!w || w.dtw == null) continue;
      const on = findOnset(envInfo, s.t0 - 0.3, s.t0 + 1.2);
      if (on == null) continue;
      const d = w.dtw - on;
      if (d > -0.2 && d < 0.8) diffs.push(d);
    }
  });
  const lag = diffs.length >= 4 ? Math.min(0.5, Math.max(0, median(diffs))) : 0.2;

  const words = [];
  const segments = [];
  const langs = {};
  items.forEach((it, i) => {
    const r = results[i];
    if (r.language) langs[r.language] = (langs[r.language] || 0) + (it.duration || 1);
    for (const s of r.segments) {
      if (!s.words.length) continue;
      timeWords(s, s.words, lag);
      const segWords = s.words.map((w) => ({
        t0: +(w.t0 + it.offset).toFixed(3),
        t1: +(w.t1 + it.offset).toFixed(3),
        text: w.text,
        p: +w.p.toFixed(3),
      }));
      segments.push({
        t0: +(s.t0 + it.offset).toFixed(3),
        t1: +(s.t1 + it.offset).toFixed(3),
        text: segWords.map((w) => w.text).join(' '),
      });
      words.push(...segWords);
    }
  });
  const detected = Object.entries(langs).sort((a, b) => b[1] - a[1])[0]?.[0] || language;
  return { language: detected, lag: +lag.toFixed(3), model: model.split('/').pop(), words, segments };
}
