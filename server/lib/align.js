// 文字稿 <-> 识别结果 对齐。
// 用带仿射罚分的全局序列比对（Gotoh），英文用编辑距离 + Soundex 音近匹配，中文用拼音匹配。
// 输出：每页建议起点、每行时间、每个识别词的匹配状态、剪辑建议（多读/重读、长停顿、片段首尾）。
import { pinyin } from 'pinyin-pro';
import { CJK_RE, findOnset } from './whisper.js';

const TOKEN_RE = /([぀-ヿ㐀-䶿一-鿿豈-﫿가-힯])|([\p{L}\p{N}]+(?:['’][\p{L}]+)*)/gu;
const STOP = new Set(['the', 'to', 'too', 'two', 'a', 'an', 'and', 'in', 'on', 'at', 'it', 'is', 'of', 'or', 'as', 'he']);

const pyCache = new Map();
function py(ch) {
  if (!pyCache.has(ch)) pyCache.set(ch, pinyin(ch, { toneType: 'none', type: 'string' }));
  return pyCache.get(ch);
}

function soundex(w) {
  const s = w.toLowerCase().replace(/[^a-z]/g, '');
  if (!s) return '';
  const codes = { b: 1, f: 1, p: 1, v: 1, c: 2, g: 2, j: 2, k: 2, q: 2, s: 2, x: 2, z: 2, d: 3, t: 3, l: 4, m: 5, n: 5, r: 6 };
  let out = s[0].toUpperCase();
  let last = codes[s[0]] || 0;
  for (let i = 1; i < s.length && out.length < 4; i++) {
    const c = codes[s[i]] || 0;
    if (c && c !== last) out += c;
    if (s[i] !== 'h' && s[i] !== 'w') last = c;
  }
  return out.padEnd(4, '0');
}

function lev(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// 缩写统一展开（识别结果有时写 we're，有时写 we are）；'s 有所有格歧义，保持原样
const CONTRACTIONS = { "can't": ['can', 'not'], "won't": ['will', 'not'], "shan't": ['shall', 'not'] };
function expandWord(w) {
  if (CONTRACTIONS[w]) return CONTRACTIONS[w];
  let m;
  if ((m = w.match(/^(.+)n't$/))) return [m[1], 'not'];
  if ((m = w.match(/^(.+)'re$/))) return [m[1], 'are'];
  if ((m = w.match(/^(.+)'m$/))) return [m[1], 'am'];
  if ((m = w.match(/^(.+)'ll$/))) return [m[1], 'will'];
  if ((m = w.match(/^(.+)'ve$/))) return [m[1], 'have'];
  if ((m = w.match(/^(.+)'d$/))) return [m[1], 'would'];
  return [w];
}

export function tokenize(text) {
  const toks = [];
  for (const m of text.normalize('NFKC').matchAll(TOKEN_RE)) {
    if (m[1]) toks.push({ w: m[1], cjk: true, py: py(m[1]) });
    else {
      for (const w of expandWord(m[2].toLowerCase().replace(/’/g, "'"))) toks.push({ w, cjk: false, sx: soundex(w) });
    }
  }
  return toks;
}

function sim(a, b) {
  if (a.cjk !== b.cjk) return -2;
  if (a.w === b.w) return 3;
  if (a.cjk) return a.py && a.py === b.py ? 2 : -1.5;
  const r = 1 - lev(a.w, b.w) / Math.max(a.w.length, b.w.length);
  if (r >= 0.75) return 2;
  if (a.w.length >= 3 && b.w.length >= 3 && !STOP.has(a.w) && !STOP.has(b.w) && a.sx === b.sx) return 1.8;
  if (r >= 0.5) return 0.5;
  return -1.5;
}

const GO_S = -2.5; // 文字稿词被跳过（没读 / 没识别出）
const GE_S = -1;
const GO_T = -2.5; // 识别结果多出来的词（多读、重读、闲聊）
const GE_T = -0.8;
const NEG = -1e9;

/** 返回 pairs: [{ i, j, s }]（仅配对），freeScriptEnds 时文字稿首尾跳过不罚分（用于短录音局部对齐） */
export function alignTokens(S, T, { freeScriptEnds = false } = {}) {
  const n = S.length;
  const m = T.length;
  const W = m + 1;
  if (!n || !m) return [];
  const tb = new Uint8Array((n + 1) * W);
  let Mp = new Float64Array(W).fill(NEG);
  let Xp = new Float64Array(W).fill(NEG);
  let Yp = new Float64Array(W).fill(NEG);
  Mp[0] = 0;
  for (let j = 1; j <= m; j++) {
    Yp[j] = GO_T + (j - 1) * GE_T;
    tb[j] = (j === 1 ? 0 : 2) << 4;
  }
  let Mc = new Float64Array(W);
  let Xc = new Float64Array(W);
  let Yc = new Float64Array(W);
  const endScores = [];
  for (let i = 1; i <= n; i++) {
    Mc[0] = NEG;
    Yc[0] = NEG;
    Xc[0] = freeScriptEnds ? 0 : GO_S + (i - 1) * GE_S;
    tb[i * W] = (i === 1 || freeScriptEnds ? 0 : 1) << 2;
    const si = S[i - 1];
    for (let j = 1; j <= m; j++) {
      // M：优先沿对角线延续（重读时会匹配到后一遍，把前一遍标为多读）
      let bm = Mp[j - 1];
      let pm = 0;
      if (Yp[j - 1] > bm) (bm = Yp[j - 1]), (pm = 2);
      if (Xp[j - 1] > bm) (bm = Xp[j - 1]), (pm = 1);
      Mc[j] = bm + sim(si, T[j - 1]);
      // X：文字稿跳过
      let bx = Mp[j] + GO_S;
      let px = 0;
      if (Xp[j] + GE_S > bx) (bx = Xp[j] + GE_S), (px = 1);
      if (Yp[j] + GO_S > bx) (bx = Yp[j] + GO_S), (px = 2);
      Xc[j] = bx;
      // Y：识别结果多出
      let by = Mc[j - 1] + GO_T;
      let pyy = 0;
      if (Yc[j - 1] + GE_T > by) (by = Yc[j - 1] + GE_T), (pyy = 2);
      if (Xc[j - 1] + GO_T > by) (by = Xc[j - 1] + GO_T), (pyy = 1);
      Yc[j] = by;
      tb[i * W + j] = pm | (px << 2) | (pyy << 4);
    }
    if (freeScriptEnds) endScores.push([i, Math.max(Mc[m], Yc[m]), Mc[m] >= Yc[m] ? 0 : 2]);
    [Mp, Mc] = [Mc, Mp];
    [Xp, Xc] = [Xc, Xp];
    [Yp, Yc] = [Yc, Yp];
  }
  let i = n;
  let j = m;
  let state;
  if (freeScriptEnds) {
    const best = endScores.reduce((a, b) => (b[1] > a[1] ? b : a));
    i = best[0];
    state = best[2];
  } else {
    const cand = [
      [Mp[m], 0],
      [Xp[m], 1],
      [Yp[m], 2],
    ].sort((a, b) => b[0] - a[0]);
    state = cand[0][1];
  }
  const pairs = [];
  while (i > 0 && j > 0) {
    const cell = tb[i * W + j];
    if (state === 0) {
      pairs.push({ i: i - 1, j: j - 1, s: sim(S[i - 1], T[j - 1]) });
      state = cell & 3;
      i--;
      j--;
    } else if (state === 1) {
      state = (cell >> 2) & 3;
      i--;
    } else {
      state = (cell >> 4) & 3;
      j--;
    }
  }
  return pairs.reverse();
}

// ---------- 文字稿准备 ----------

function lineKind(text) {
  const cjk = (text.match(new RegExp(CJK_RE.source, 'g')) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  return cjk > latin * 0.3 ? 'zh' : 'en';
}

/** segments: [{ blocks: [[line...]] }] -> 行列表（带全局行号） */
export function scriptLines(segments) {
  const lines = [];
  segments.forEach((seg, s) => {
    seg.blocks.forEach((block, b) =>
      block.forEach((text, l) => lines.push({ seg: s, block: b, line: l, text, kind: lineKind(text) })),
    );
  });
  return lines;
}

// 从文字稿里抽取专有名词，作为 whisper 提示词（提升人名识别率）
export function buildPrompt(segments, title = '') {
  const count = new Map();
  for (const l of scriptLines(segments)) {
    if (l.kind !== 'en') continue;
    for (const sentence of l.text.split(/[.!?…]+/)) {
      const ws = sentence.trim().split(/\s+/);
      ws.forEach((w, k) => {
        const c = w.replace(/[^A-Za-z]/g, '');
        if (k > 0 && /^[A-Z][a-z]+$/.test(c) && c !== 'I') count.set(c, (count.get(c) || 0) + 1);
      });
    }
  }
  const names = [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map((e) => e[0]);
  const parts = [];
  if (title) parts.push(`${title}.`);
  if (names.length) parts.push(`${names.join(', ')}.`);
  return parts.join(' ');
}

// ---------- 能量工具 ----------

function quietest(envInfo, lo, hi, target) {
  if (!envInfo || hi <= lo) return Math.max(lo, Math.min(hi, target));
  const { env, fps } = envInfo;
  const a = Math.max(1, Math.floor(lo * fps));
  const b = Math.min(env.length - 2, Math.ceil(hi * fps));
  let best = target;
  let bestV = Infinity;
  for (let f = a; f <= b; f++) {
    const v = (env[f - 1] + env[f] + env[f + 1]) / 3 + Math.abs(f / fps - target) * 40;
    if (v < bestV) (bestV = v), (best = f / fps);
  }
  return best;
}

function silences(envInfo, minDur) {
  const { env, fps, floor, loud } = envInfo;
  const thr = floor + (loud - floor) * 0.06;
  const out = [];
  let start = -1;
  for (let f = 0; f <= env.length; f++) {
    const quiet = f < env.length && env[f] < thr;
    if (quiet && start < 0) start = f;
    if (!quiet && start >= 0) {
      if ((f - start) / fps >= minDur) out.push({ t0: start / fps, t1: f / fps });
      start = -1;
    }
  }
  return out;
}

const r2 = (x) => Math.round(x * 100) / 100;

/**
 * 主对齐流程
 * segments: 页列表；words: 识别词；fragments: [{start,end}] 原视频片段；envInfo: 16k 能量包络
 */
export function alignProject({ segments, words, duration, fragments = [], envInfo = null }) {
  const lines = scriptLines(segments);

  // 识别结果以哪种语言为主：只读英文时，中文行不参与对齐（反之亦然）
  let cjkWords = 0;
  for (const w of words) if (CJK_RE.test(w.text)) cjkWords++;
  const cjkRatio = words.length ? cjkWords / words.length : 0;
  const useKinds = new Set(cjkRatio < 0.05 ? ['en'] : cjkRatio > 0.95 ? ['zh'] : ['en', 'zh']);

  const S = [];
  lines.forEach((l, li) => {
    if (!useKinds.has(l.kind)) return;
    for (const t of tokenize(l.text)) {
      if (useKinds.size === 1 && (useKinds.has('en') ? t.cjk : !t.cjk)) continue;
      S.push({ ...t, seg: l.seg, line: li });
    }
  });
  const T = [];
  words.forEach((w, wi) => {
    for (const t of tokenize(w.text)) T.push({ ...t, word: wi });
  });

  const pairs = alignTokens(S, T);

  const wordState = new Array(words.length).fill('x'); // m 匹配 / s 近似 / x 多出
  const segFirst = new Array(segments.length).fill(null);
  const segLast = new Array(segments.length).fill(null);
  const segMatched = new Array(segments.length).fill(0);
  const segTotal = new Array(segments.length).fill(0);
  const lineSpan = new Array(lines.length).fill(null);
  for (const t of S) segTotal[t.seg]++;
  for (const p of pairs) {
    const st = S[p.i];
    const wi = T[p.j].word;
    if (p.s > 0) {
      wordState[wi] = 'm';
      segMatched[st.seg]++;
      if (segFirst[st.seg] == null || wi < segFirst[st.seg]) segFirst[st.seg] = wi;
      if (segLast[st.seg] == null || wi > segLast[st.seg]) segLast[st.seg] = wi;
      const ls = lineSpan[st.line] || (lineSpan[st.line] = { a: wi, b: wi });
      ls.a = Math.min(ls.a, wi);
      ls.b = Math.max(ls.b, wi);
    } else if (wordState[wi] === 'x') wordState[wi] = 's';
  }

  // ---- 每页起点 ----
  const N = segments.length;
  const starts = new Array(N).fill(null);
  starts[0] = 0;
  for (let s = 1; s < N; s++) {
    const b = segFirst[s];
    if (b == null) continue;
    let a = null;
    for (let k = s - 1; k >= 0; k--) {
      if (segLast[k] != null) {
        a = segLast[k];
        break;
      }
    }
    if (a != null && a < b) {
      // 两页之间找最长的停顿，新页在下一句开口前一点点出现
      let bestK = b - 1;
      let bestGap = -Infinity;
      for (let k = a; k < b; k++) {
        const gap = words[k + 1].t0 - words[k].t1;
        if (gap > bestGap) (bestGap = gap), (bestK = k);
      }
      const gapStart = words[bestK].t1;
      const gapEnd = words[bestK + 1].t0;
      const lead = Math.min(0.4, Math.max(0.12, (gapEnd - gapStart) * 0.5));
      starts[s] = Math.max(gapStart, gapEnd - lead);
      if (envInfo && gapEnd - gapStart > 0.15) {
        const on = findOnset(envInfo, gapEnd - 0.35, gapEnd + 0.25);
        if (on != null) starts[s] = Math.max(gapStart, Math.min(starts[s], on - 0.15));
      }
    } else {
      starts[s] = Math.max(0, words[b].t0 - 0.25);
    }
  }
  // 缺失的页按文字量插值；并保证严格递增
  const MIN_PAGE = 0.4;
  for (let s = 1; s < N; s++) {
    if (starts[s] != null) continue;
    let e = s;
    while (e < N && starts[e] == null) e++;
    const t0 = starts[s - 1];
    const t1 = e < N ? starts[e] : duration;
    const weights = [];
    for (let k = s - 1; k < e; k++) weights.push(Math.max(1, segTotal[k]));
    const sum = weights.reduce((x, y) => x + y, 0);
    let acc = 0;
    for (let k = s; k < e; k++) {
      acc += weights[k - s];
      starts[k] = t0 + ((t1 - t0) * acc) / sum;
    }
    s = e;
  }
  for (let s = 1; s < N; s++) starts[s] = Math.max(starts[s], starts[s - 1] + MIN_PAGE);
  for (let s = N - 1; s >= 1; s--) {
    const maxAllowed = (s + 1 < N ? starts[s + 1] : duration) - MIN_PAGE;
    starts[s] = Math.min(starts[s], maxAllowed);
  }

  const confidence = segments.map((_, s) => (segTotal[s] ? +(segMatched[s] / segTotal[s]).toFixed(2) : null));
  const lineTimes = lines.map((l, li) => {
    const sp = lineSpan[li];
    return sp ? { seg: l.seg, block: l.block, line: l.line, t0: words[sp.a].t0, t1: words[sp.b].t1 } : null;
  });

  // ---- 剪辑建议 ----
  const suggestions = [];
  const add = (type, t0, t1, text) => {
    t0 = r2(Math.max(0, t0));
    t1 = r2(Math.min(duration, t1));
    if (t1 - t0 < 0.2) return;
    suggestions.push({ id: `${type}-${Math.round(t0 * 100)}-${Math.round(t1 * 100)}`, type, t0, t1, text });
  };

  // 1) 多读 / 重读：连续的未匹配词
  for (let p = 0; p < words.length; p++) {
    if (wordState[p] !== 'x') continue;
    let q = p;
    while (q + 1 < words.length && wordState[q + 1] === 'x') q++;
    const runText = words.slice(p, q + 1).map((w) => w.text).join(' ');
    const runDur = words[q].t1 - words[p].t0;
    if (runDur >= 0.2) {
      // 与后面（或前面）已匹配内容相似 -> 重读
      const runToks = tokenize(runText);
      const around = [...words.slice(q + 1, q + 1 + runToks.length + 2), ...words.slice(Math.max(0, p - runToks.length - 2), p)];
      const aroundToks = tokenize(around.map((w) => w.text).join(' '));
      const hits = runToks.filter((t) => aroundToks.some((u) => sim(t, u) >= 2)).length;
      const type = runToks.length && hits / runToks.length >= 0.6 ? 'repeat' : 'extra';
      const prevEnd = p > 0 ? words[p - 1].t1 : 0;
      const nextStart = q + 1 < words.length ? words[q + 1].t0 : Math.min(duration, words[q].t1 + 0.6);
      const t0 = quietest(envInfo, Math.max(prevEnd, words[p].t0 - 0.3), words[p].t0 + 0.03, words[p].t0 - 0.08);
      const t1 =
        q + 1 < words.length
          ? quietest(envInfo, Math.max(words[q].t1 - 0.05, nextStart - 0.45), nextStart - 0.02, nextStart - 0.12)
          : nextStart;
      if (t1 > t0) add(type, t0, t1, runText);
    }
    p = q;
  }

  // 2) 片段首尾（开始/停止录制时的空白与按键声）
  const trimRanges = [];
  for (const fr of fragments) {
    const inside = words.filter((w) => w.t0 >= fr.start - 0.01 && w.t0 < fr.end);
    if (!inside.length) {
      // 整体都没识别出内容时多半是识别失败，不建议删除整段
      if (words.length) {
        add('trim', fr.start, fr.end, '没有识别到朗读内容的片段');
        trimRanges.push([fr.start, fr.end]);
      }
      continue;
    }
    const head = inside[0].t0 - 0.35;
    if (head - fr.start >= 0.35) {
      const t1 = quietest(envInfo, head - 0.2, head + 0.1, head);
      add('trim', fr.start, t1, '片段开头空白');
      trimRanges.push([fr.start, t1]);
    }
    const tail = inside[inside.length - 1].t1 + 0.45;
    if (fr.end - tail >= 0.35) {
      const t0 = quietest(envInfo, tail - 0.1, tail + 0.2, tail);
      add('trim', t0, fr.end, '片段结尾空白');
      trimRanges.push([t0, fr.end]);
    }
  }

  // 3) 过长停顿：保留约 0.8s
  if (envInfo) {
    for (const sl of silences(envInfo, 1.6)) {
      const t0 = sl.t0 + 0.45;
      const t1 = sl.t1 - 0.35;
      if (trimRanges.some(([a, b]) => t0 < b && t1 > a)) continue;
      if (words.some((w) => w.t0 > t0 && w.t0 < t1)) continue;
      add('pause', t0, t1, `停顿 ${(sl.t1 - sl.t0).toFixed(1)} 秒`);
    }
  }

  // 同一区域只保留一条（优先 多读/重读 > 片段首尾 > 停顿）
  const rank = { repeat: 0, extra: 1, trim: 2, pause: 3 };
  suggestions.sort((a, b) => rank[a.type] - rank[b.type] || a.t0 - b.t0);
  const kept = [];
  for (const sg of suggestions) {
    if (kept.some((k) => sg.t0 < k.t1 && sg.t1 > k.t0)) continue;
    kept.push(sg);
  }
  kept.sort((a, b) => a.t0 - b.t0);

  return {
    languageKinds: [...useKinds],
    pageStarts: starts.map(r2),
    confidence,
    lineTimes,
    wordState: wordState.join(''),
    suggestions: kept,
    stats: { scriptTokens: S.length, transcriptTokens: T.length, matched: pairs.filter((p) => p.s > 0).length },
  };
}

// 新录音与文字稿做局部对齐，只返回每个词的匹配状态
export function alignRecording({ segments, words }) {
  const lines = scriptLines(segments);
  const S = [];
  lines.forEach((l, li) => tokenize(l.text).forEach((t) => S.push({ ...t, seg: l.seg, line: li })));
  const T = [];
  words.forEach((w, wi) => tokenize(w.text).forEach((t) => T.push({ ...t, word: wi })));
  const state = new Array(words.length).fill('x');
  const segs = new Set();
  for (const p of alignTokens(S, T, { freeScriptEnds: true })) {
    const wi = T[p.j].word;
    if (p.s > 0) {
      state[wi] = 'm';
      segs.add(S[p.i].seg);
    } else if (state[wi] === 'x') state[wi] = 's';
  }
  return { wordState: state.join(''), segments: [...segs].sort((a, b) => a - b) };
}
