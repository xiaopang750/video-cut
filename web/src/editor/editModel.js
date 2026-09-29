// 剪辑模型（纯函数）——「原始录音 + 修改记录」
//
// 修改记录 ops：按「处」记——时间轴上每一处修改是一条记录，扩大 / 缩小 / 微调都算同一条，
// 每条可以单独回撤 / 重新应用：
//   cut      删除：ranges = [{ src, a, b }]（音源时间）；和相邻 / 重叠的删除合并成一条
//   insert   新增：在原始录音 at 秒处插入补录 rec = { src, in, out }
//   replace  替换：把原始录音 range = { a, b } 换成补录 rec
//   page     翻页：第 page 页从 to（锚点）开始，from 是第一次调整前的位置；每页只有一条
// 位置都用「音源时间」记，所以回撤前面的某一条，后面的记录不会错位。
//
// 当前状态 = 从原始录音出发，按时间顺序叠加所有「已应用」的记录（replay），得到：
// items: [{ id, kind, src, in, out, orig?, group?, op?, anchor? }]，首尾相接构成「显示时间轴」：
//   keep    原始录音，保留（播放）
//   cut     删掉的内容：仍然显示（红色区块），播放 / 生成时跳过；orig 记录删之前的类型
//   old     被替换掉的原始录音：仍然显示（黄色区块），不播放；group = 替换记录 id
//   new     替换用的新录音（黄色，播放）；group = 替换记录 id
//   insert  新增的录音（绿色，播放）；group = 新增记录 id
// pages: [{ seg, start }]，start 是显示时间轴上的秒数。

export const MIN_PAGE = 0.25;
const EPS = 1e-6;

let seq = 0;
export const newId = (p = 'c') => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export const TIMELINE_OPS = new Set(['cut', 'insert', 'replace', 'page']);
// 插入空白用的静音音源（整个项目共用一段，每次插入取其中一段长度）
export const SILENCE = 'silence';
const PLAYED = { keep: true, new: true, insert: true };
export const isPlayed = (it) => Boolean(PLAYED[it.kind]);
const len = (it) => it.out - it.in;

// ---------- 布局（缓存）----------
const layoutCache = new WeakMap();
export function layout(items) {
  let L = layoutCache.get(items);
  if (L) return L;
  let dt = 0;
  let out = 0;
  L = items.map((it, i) => {
    const r = { i, it, dt, out, len: len(it), played: isPlayed(it) };
    dt += r.len;
    if (r.played) out += r.len;
    return r;
  });
  L.totalDT = dt;
  L.totalOut = out;
  layoutCache.set(items, L);
  return L;
}
export const totalDT = (items) => layout(items).totalDT;
export const totalOut = (items) => layout(items).totalOut;

const clipsCache = new WeakMap();
// 实际播放的片段（成片顺序）
export function playedClips(items) {
  let c = clipsCache.get(items);
  if (!c) {
    c = items.filter(isPlayed);
    clipsCache.set(items, c);
  }
  return c;
}

// 显示时间 -> 成片时间（落在不播放的区块里时，折叠到区块开头）
export function dtToOut(items, t) {
  const L = layout(items);
  if (!L.length) return 0;
  for (const r of L) {
    if (t < r.dt + r.len - EPS || r === L[L.length - 1]) return r.played ? r.out + clamp(t - r.dt, 0, r.len) : r.out;
  }
  return L.totalOut;
}

// 成片时间 -> 显示时间（跨过删除区块时直接跳到后面）
export function outToDT(items, o) {
  let last = null;
  for (const r of layout(items)) {
    if (!r.played) continue;
    last = r;
    if (o < r.out + r.len - EPS) return r.dt + clamp(o - r.out, 0, r.len);
  }
  return last ? last.dt + last.len : 0;
}

export function rowAt(items, t) {
  const L = layout(items);
  for (const r of L) if (t < r.dt + r.len - EPS) return r;
  return L[L.length - 1] || null;
}

export function dtToSource(items, t) {
  const r = rowAt(items, t);
  if (!r) return null;
  return { src: r.it.src, time: r.it.in + clamp(t - r.dt, 0, r.len), kind: r.it.kind, row: r };
}

export function sourceToDT(items, src, time) {
  for (const r of layout(items)) {
    if (r.it.src === src && time >= r.it.in - EPS && time <= r.it.out + EPS) return r.dt + (time - r.it.in);
  }
  return null;
}

export function sourceRangeToDT(items, src, a, b) {
  const out = [];
  for (const r of layout(items)) {
    if (r.it.src !== src) continue;
    const x = Math.max(a, r.it.in);
    const y = Math.min(b, r.it.out);
    if (y - x <= EPS) continue;
    const seg = [r.dt + x - r.it.in, r.dt + y - r.it.in];
    const last = out[out.length - 1];
    if (last && Math.abs(last[1] - seg[0]) < 0.002) last[1] = seg[1];
    else out.push(seg);
  }
  return out;
}

// 显示时间轴上的 [a, b] -> 音源区间（playedOnly：只要还在播放的部分）
export function dtRangeToSource(items, a, b, playedOnly = false) {
  const out = [];
  for (const r of layout(items)) {
    if (playedOnly && !r.played) continue;
    const x = Math.max(a, r.dt);
    const y = Math.min(b, r.dt + r.len);
    if (y - x <= 0.002) continue;
    const seg = { src: r.it.src, a: r.it.in + (x - r.dt), b: r.it.in + (y - r.dt) };
    const last = out[out.length - 1];
    if (last && last.src === seg.src && Math.abs(last.b - seg.a) < 0.002) last.b = seg.b;
    else out.push(seg);
  }
  return out;
}

// ---------- 区间运算（音源时间）----------
export function subtractRanges(ranges, sub) {
  let out = ranges.map((r) => ({ ...r }));
  for (const s of sub) {
    const next = [];
    for (const r of out) {
      if (r.src !== s.src || s.b <= r.a + EPS || s.a >= r.b - EPS) {
        next.push(r);
        continue;
      }
      if (s.a > r.a + 0.005) next.push({ ...r, b: s.a });
      if (s.b < r.b - 0.005) next.push({ ...r, a: s.b });
    }
    out = next;
  }
  return out;
}

const sumRanges = (ranges) => ranges.reduce((s, r) => s + (r.b - r.a), 0);
export { sumRanges };

// 合并重叠 / 相接（间隔 ≤ gap）的区间
export function unionRanges(ranges, gap = 0.002) {
  const bySrc = new Map();
  for (const r of ranges) {
    if (!bySrc.has(r.src)) bySrc.set(r.src, []);
    bySrc.get(r.src).push(r);
  }
  const out = [];
  for (const list of bySrc.values()) {
    list.sort((p, q) => p.a - q.a);
    let cur = null;
    for (const r of list) {
      if (cur && r.a <= cur.b + gap) cur.b = Math.max(cur.b, r.b);
      else {
        cur = { src: r.src, a: r.a, b: r.b };
        out.push(cur);
      }
    }
  }
  return out;
}

// ---------- 条目操作 ----------
function splitSrcAt(items, src, t) {
  const out = [];
  for (const it of items) {
    if (it.src === src && t > it.in + EPS && t < it.out - EPS) out.push({ ...it, out: t }, { ...it, id: newId(), in: t });
    else out.push(it);
  }
  return out;
}

function markRange(items, src, a, b, fn) {
  const out = [];
  for (const it of items) {
    if (it.src !== src || it.out <= a + EPS || it.in >= b - EPS) {
      out.push(it);
      continue;
    }
    const changed = fn(it);
    if (!changed) {
      out.push(it);
      continue;
    }
    const x = Math.max(a, it.in);
    const y = Math.min(b, it.out);
    if (x > it.in + EPS) out.push({ ...it, out: x });
    out.push({ ...changed, id: newId(), in: x, out: y });
    if (y < it.out - EPS) out.push({ ...it, id: newId(), in: y });
  }
  return out;
}

function sameKind(a, b) {
  const keys = ['src', 'kind', 'orig', 'group', 'op', 'anchor'];
  return keys.every((k) => (a[k] ?? null) === (b[k] ?? null));
}

export function normalize(items) {
  const out = [];
  for (const it of items) {
    if (len(it) < 0.001) continue;
    const last = out[out.length - 1];
    if (last && sameKind(last, it) && Math.abs(last.out - it.in) < 0.002) out[out.length - 1] = { ...last, out: it.out };
    else out.push(it);
  }
  return out;
}

function mainEnd(items) {
  let m = 0;
  for (const it of items) if (it.src === 'main') m = Math.max(m, it.out);
  return m;
}

function applyInsert(items, op) {
  const t = clamp(op.at, 0, mainEnd(items));
  items = splitSrcAt(items, 'main', t);
  let idx = items.findIndex((it) => it.src === 'main' && Math.abs(it.in - t) < EPS);
  // 落在某个替换的「被替换原录音」中间时，放到那一组的后面
  if (idx >= 0 && items[idx].kind === 'old') {
    const g = items[idx].group;
    const first = items.findIndex((it) => it.group === g);
    if (Math.abs(items[first].in - t) > EPS) {
      let last = -1;
      items.forEach((it, k) => it.group === g && (last = k));
      idx = last + 1;
    }
  }
  if (idx < 0) idx = items.length;
  const item = { id: newId(), kind: 'insert', src: op.rec.src, in: op.rec.in, out: op.rec.out, group: op.id, op: op.id, anchor: t };
  return [...items.slice(0, idx), item, ...items.slice(idx)];
}

function applyReplace(items, op) {
  const { a, b } = op.range;
  items = splitSrcAt(splitSrcAt(items, 'main', a), 'main', b);
  items = items.map((it) =>
    it.src === 'main' && it.kind === 'keep' && it.in >= a - EPS && it.out <= b + EPS ? { ...it, kind: 'old', group: op.id, op: op.id } : it,
  );
  let idx = -1;
  items.forEach((it, k) => it.src === 'main' && it.in >= a - EPS && it.out <= b + EPS && (idx = k));
  idx += 1;
  if (idx === 0) {
    idx = items.findIndex((it) => it.src === 'main' && Math.abs(it.in - b) < EPS);
    if (idx < 0) idx = items.length;
  }
  const item = { id: newId(), kind: 'new', src: op.rec.src, in: op.rec.in, out: op.rec.out, group: op.id, op: op.id };
  return [...items.slice(0, idx), item, ...items.slice(idx)];
}

function applyCut(items, op) {
  for (const r of op.ranges) {
    items = markRange(items, r.src, r.a, r.b, (it) => (isPlayed(it) ? { ...it, kind: 'cut', orig: it.kind, op: op.id } : null));
  }
  return items;
}

// ---------- 锚点：页的开始位置用「音源 + 时间」记 ----------
export function anchorToDT(items, a) {
  if (!a) return 0;
  const L = layout(items);
  if (a.src !== 'main') {
    const row = L.find((r) => r.it.src === a.src && a.t >= r.it.in - EPS && a.t <= r.it.out + EPS);
    if (row) return row.dt + (a.t - row.it.in);
    return anchorToDT(items, { src: 'main', t: a.mt ?? 0 });
  }
  const row = L.find((r) => r.it.src === 'main' && a.t >= r.it.in - EPS && a.t < r.it.out - EPS);
  if (!row) return L.totalDT;
  let dt = row.dt + (a.t - row.it.in);
  // 正好在一段「新增」的位置翻页：新增的录音算这一页的
  if (Math.abs(a.t - row.it.in) < EPS) {
    for (let k = row.i - 1; k >= 0; k--) {
      const it = L[k].it;
      if ((it.kind === 'insert' || it.orig === 'insert') && Math.abs((it.anchor ?? -1) - a.t) < EPS) dt = L[k].dt;
      else break;
    }
  }
  return dt;
}

export function dtToAnchor(items, t) {
  const r = rowAt(items, t);
  if (!r) return { src: 'main', t: 0 };
  const time = r.it.in + clamp(t - r.dt, 0, r.len);
  if (r.it.src === 'main') return { src: 'main', t: time };
  const L = layout(items);
  let mt = mainEnd(items);
  for (let k = r.i + 1; k < L.length; k++) {
    if (L[k].it.src === 'main') {
      mt = L[k].it.in;
      break;
    }
  }
  return { src: r.it.src, t: time, mt };
}

// 在显示时间 p 新增：换算成原始录音上的插入点（落在补录 / 被替换区块里时放到那一组后面）
export function insertAnchor(items, p) {
  const r = rowAt(items, p);
  if (!r) return 0;
  if (r.it.src === 'main' && r.it.kind !== 'old') return r.it.in + clamp(p - r.dt, 0, r.len);
  // 找这一组后面的第一段原始录音
  const L = layout(items);
  const g = r.it.group;
  let k = r.i;
  if (g) while (k + 1 < L.length && L[k + 1].it.group === g) k++;
  for (let j = k + 1; j < L.length; j++) if (L[j].it.src === 'main') return L[j].it.in;
  return mainEnd(items);
}

// 替换只能作用在原始录音上：显示区间 -> 原始录音区间
export function replaceRange(items, a, b) {
  const parts = dtRangeToSource(items, a, b, false);
  if (!parts.length) return { error: '选区是空的' };
  if (isAllCut(items, a, b)) return { error: '选区已经删掉了，不能替换' };
  if (parts.some((p) => p.src !== 'main')) return { error: '选区里有补录的内容，先回撤那条修改再替换' };
  const L = layout(items);
  for (const r of L) {
    if (r.dt + r.len <= a + EPS || r.dt >= b - EPS) continue;
    if (r.it.kind === 'old') return { error: '选区和已有的替换重叠了，先回撤那条替换' };
  }
  return { a: parts[0].a, b: parts[parts.length - 1].b };
}

// 在时间轴上挨着 / 重叠的删除记录合并成一条（保留最早的那条），返回新的 ops
export function mergeTouchingCuts(base, ops, mainDuration) {
  for (let guard = 0; guard < 100; guard++) {
    const { items } = replay(base, ops, mainDuration);
    const byOp = new Map();
    for (const b of blocks(items)) {
      if (b.type !== 'cut') continue;
      if (!byOp.has(b.op)) byOp.set(b.op, []);
      byOp.get(b.op).push(b);
    }
    const cand = ops.filter((o) => o.type === 'cut' && o.applied && byOp.has(o.id));
    let pair = null;
    for (let i = 0; i < cand.length && !pair; i++) {
      for (let j = i + 1; j < cand.length && !pair; j++) {
        const A = byOp.get(cand[i].id);
        const B = byOp.get(cand[j].id);
        if (A.some((x) => B.some((y) => x.a <= y.b + 0.01 && y.a <= x.b + 0.01))) pair = [cand[i], cand[j]];
      }
    }
    if (!pair) return ops;
    const [keep, drop] = pair[0].time <= pair[1].time ? pair : [pair[1], pair[0]];
    const merged = { ...keep, ranges: unionRanges([...keep.ranges, ...drop.ranges], 0.012), mtime: Date.now() };
    ops = ops.filter((o) => o !== drop).map((o) => (o === keep ? merged : o));
  }
  return ops;
}

// 去掉和初始化时没有区别的记录：删除范围为空的、翻页位置等于初始位置的
export function pruneOps(base, ops, mainDuration) {
  let out = ops.filter((o) => !(o.type === 'cut' && sumRanges(o.ranges || []) < 0.002));
  const pageOps = out.filter((o) => o.type === 'page' && o.applied);
  if (!pageOps.length) return out;
  const { items } = replay(base, out, mainDuration);
  const drop = new Set();
  for (const o of pageOps) {
    const init = base.pages[o.page]?.anchor;
    if (!init || Math.abs(anchorToDT(items, o.to) - anchorToDT(items, init)) < 0.002) drop.add(o.id);
  }
  // 同一页只保留最后一条
  const seen = new Set();
  for (let i = out.length - 1; i >= 0; i--) {
    const o = out[i];
    if (o.type !== 'page') continue;
    if (seen.has(o.page)) drop.add(o.id);
    seen.add(o.page);
  }
  return drop.size ? out.filter((o) => !drop.has(o.id)) : out;
}

// 重新应用 / 新建替换时检查冲突
export function replaceConflict(ops, range, exceptId) {
  for (const op of ops) {
    if (!op.applied || op.id === exceptId) continue;
    if (op.type === 'replace' && op.range.a < range.b - EPS && op.range.b > range.a + EPS) return '和另一条「替换」重叠了，先回撤那一条';
    if (op.type === 'insert' && op.at > range.a + EPS && op.at < range.b - EPS) return '这段范围里有「新增」的录音，先回撤那一条';
  }
  return null;
}

// ---------- 由修改记录得到当前状态 ----------
export function replay(base, ops, mainDuration) {
  let items = [{ id: 'm0', kind: 'keep', src: 'main', in: 0, out: mainDuration }];
  const active = ops.filter((o) => o.applied && TIMELINE_OPS.has(o.type));
  // 固定顺序（和创建先后无关）：先删原始录音，再新增 / 替换，最后是补录上的删除（旧数据才有）
  const mainCut = (o) => o.type === 'cut' && o.ranges.every((r) => r.src === 'main');
  for (const op of active) if (mainCut(op)) items = applyCut(items, op);
  for (const op of active) {
    if (op.type === 'insert') items = applyInsert(items, op);
    else if (op.type === 'replace') items = applyReplace(items, op);
  }
  for (const op of active) if (op.type === 'cut' && !mainCut(op)) items = applyCut(items, op);
  items = normalize(items);
  const anchors = base.pages.map((p) => p.anchor);
  for (const op of active) if (op.type === 'page' && op.page < anchors.length) anchors[op.page] = op.to;
  const pages = base.pages.map((p, i) => ({ seg: p.seg, start: i === 0 ? 0 : anchorToDT(items, anchors[i]) }));
  return { items, pages: fixPages(pages, totalDT(items)) };
}

// 某条记录在当前时间轴上的位置（用于定位 / 显示）
export function opExtent(op, items) {
  const L = layout(items);
  if (op.type === 'cut') {
    const rows = L.filter((r) => r.it.op === op.id && r.it.kind === 'cut');
    if (rows.length) return [Math.min(...rows.map((r) => r.dt)), Math.max(...rows.map((r) => r.dt + r.len))];
    const segs = op.ranges.flatMap((r) => sourceRangeToDT(items, r.src, r.a, r.b));
    if (segs.length) return [Math.min(...segs.map((s) => s[0])), Math.max(...segs.map((s) => s[1]))];
    return null;
  }
  if (op.type === 'insert' || op.type === 'replace') {
    const rows = L.filter((r) => r.it.group === op.id);
    if (rows.length) return [Math.min(...rows.map((r) => r.dt)), Math.max(...rows.map((r) => r.dt + r.len))];
    if (op.type === 'replace') {
      const segs = sourceRangeToDT(items, 'main', op.range.a, op.range.b);
      return segs.length ? [segs[0][0], segs[segs.length - 1][1]] : null;
    }
    const p = anchorToDT(items, { src: 'main', t: op.at });
    return [p, p];
  }
  if (op.type === 'page') {
    const p = anchorToDT(items, op.to);
    return [p, p];
  }
  return null;
}

// ---------- 用于显示的「区块」----------
// cut：同一条删除记录连续的部分；replace / insert：一组补录
export function blocks(items) {
  const L = layout(items);
  const out = [];
  let run = null;
  for (const r of L) {
    if (r.it.kind === 'cut') {
      if (run && run.op === r.it.op && Math.abs(run.b - r.dt) < 0.002) run.b = r.dt + r.len;
      else {
        run = { type: 'cut', op: r.it.op, a: r.dt, b: r.dt + r.len };
        out.push(run);
      }
    } else run = null;
  }
  const groups = new Map();
  for (const r of L) {
    const g = r.it.group;
    if (!g) continue;
    let e = groups.get(g);
    if (!e) {
      e = { type: 'insert', g, op: g, a: r.dt, b: r.dt + r.len, oldA: null, oldB: null, recA: null, recB: null, src: null };
      groups.set(g, e);
    }
    e.a = Math.min(e.a, r.dt);
    e.b = Math.max(e.b, r.dt + r.len);
    if (r.it.kind === 'old') {
      e.type = 'replace';
      e.oldA = e.oldA == null ? r.dt : Math.min(e.oldA, r.dt);
      e.oldB = Math.max(e.oldB ?? -Infinity, r.dt + r.len);
    } else {
      e.src = r.it.src;
      e.recA = e.recA == null ? r.dt : Math.min(e.recA, r.dt);
      e.recB = Math.max(e.recB ?? -Infinity, r.dt + r.len);
    }
  }
  // 插入的空白单独算一类（灰色），方便和录音区分
  for (const e of groups.values()) if (e.type === 'insert' && e.src === SILENCE) e.type = 'silence';
  return [...out, ...groups.values()];
}

export function isAllCut(items, a, b) {
  let any = false;
  for (const r of layout(items)) {
    if (r.dt + r.len <= a + EPS || r.dt >= b - EPS) continue;
    if (r.it.kind !== 'cut') return false;
    any = true;
  }
  return any;
}

// ---------- 页面 ----------
export function fixPages(pages, total) {
  let prev = 0;
  return pages.map((p, i) => {
    const s = i === 0 ? 0 : clamp(Math.max(p.start, prev), 0, total);
    prev = s;
    return s === p.start ? p : { ...p, start: s };
  });
}

// 拖动翻页把手时的实时预览（松手后再生成一条「翻页」记录）
export function setPageStart(edit, idx, t) {
  if (idx <= 0) return edit;
  const total = totalDT(edit.items);
  const prev = edit.pages[idx - 1].start;
  const next = idx + 1 < edit.pages.length ? edit.pages[idx + 1].start : total;
  const lo = Math.min(prev + MIN_PAGE, next);
  const hi = Math.max(next - MIN_PAGE, lo);
  const s = clamp(t, lo, hi);
  if (Math.abs(s - edit.pages[idx].start) < 1e-4) return edit;
  const pages = edit.pages.slice();
  pages[idx] = { ...pages[idx], start: s };
  return { ...edit, pages };
}

export function clampPageStart(pages, total, idx, t) {
  const prev = pages[idx - 1].start;
  const next = idx + 1 < pages.length ? pages[idx + 1].start : total;
  const lo = Math.min(prev + MIN_PAGE, next);
  return clamp(t, lo, Math.max(next - MIN_PAGE, lo));
}

export function pageIndexAt(pages, t) {
  let lo = 0;
  let hi = pages.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pages[mid].start <= t + 1e-4) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

// 某一页在成片里实际显示多久
export function pageOutDuration(items, pages, i) {
  const total = totalDT(items);
  const a = pages[i].start;
  const b = i + 1 < pages.length ? pages[i + 1].start : total;
  return dtToOut(items, b) - dtToOut(items, a);
}

// ---------- 旧格式迁移 ----------
// 1) 最早的格式：只有成片顺序的 clips
export function itemsFromClips(clips, mainDuration) {
  const items = [];
  let mainPos = 0;
  for (let k = 0; k < clips.length; k++) {
    const c = clips[k];
    if (c.src === 'main') {
      if (c.in > mainPos + 0.001) items.push({ id: newId(), kind: 'cut', orig: 'keep', src: 'main', in: mainPos, out: c.in });
      items.push({ id: c.id || newId(), kind: 'keep', src: 'main', in: c.in, out: c.out });
      mainPos = Math.max(mainPos, c.out);
    } else {
      const nextMain = clips.slice(k + 1).find((x) => x.src === 'main');
      const gapEnd = nextMain ? nextMain.in : mainDuration;
      const g = newId('g');
      if (gapEnd > mainPos + 0.001) {
        items.push({ id: newId(), kind: 'old', group: g, src: 'main', in: mainPos, out: gapEnd });
        items.push({ id: c.id || newId(), kind: 'new', group: g, src: c.src, in: c.in, out: c.out });
        mainPos = gapEnd;
      } else items.push({ id: c.id || newId(), kind: 'insert', group: g, src: c.src, in: c.in, out: c.out });
    }
  }
  if (mainPos < mainDuration - 0.001) items.push({ id: newId(), kind: 'cut', orig: 'keep', src: 'main', in: mainPos, out: mainDuration });
  return normalize(items);
}

// 2) 只有 items + pages（没有修改记录）：反推出修改记录
export function opsFromItems(items, pages, base, time) {
  const L = layout(items);
  const ops = [];
  const groups = new Map();
  for (const r of L) {
    const g = r.it.group;
    if (!g) continue;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  for (const [g, rows] of groups) {
    const rec = rows.filter((r) => r.it.kind !== 'old');
    const old = rows.filter((r) => r.it.kind === 'old');
    if (!rec.length) continue;
    const recSpec = { src: rec[0].it.src, in: Math.min(...rec.map((r) => r.it.in)), out: Math.max(...rec.map((r) => r.it.out)) };
    if (old.length) {
      ops.push({ id: g, type: 'replace', rec: recSpec, range: { a: Math.min(...old.map((r) => r.it.in)), b: Math.max(...old.map((r) => r.it.out)) }, applied: true, time });
    } else {
      let at = null;
      const lastIdx = rec[rec.length - 1].i;
      for (let k = lastIdx + 1; k < L.length; k++) {
        if (L[k].it.src === 'main') {
          at = L[k].it.in;
          break;
        }
      }
      ops.push({ id: g, type: 'insert', rec: recSpec, at: at ?? mainEnd(items), applied: true, time });
    }
  }
  let run = null;
  for (const r of L) {
    if (r.it.kind !== 'cut') {
      run = null;
      continue;
    }
    if (!run) {
      run = { id: newId('op'), type: 'cut', ranges: [], applied: true, time };
      ops.push(run);
    }
    const last = run.ranges[run.ranges.length - 1];
    if (last && last.src === r.it.src && Math.abs(last.b - r.it.in) < 0.002) last.b = r.it.out;
    else run.ranges.push({ src: r.it.src, a: r.it.in, b: r.it.out });
  }
  pages.forEach((p, i) => {
    if (i === 0) return;
    const now = dtToAnchor(items, p.start);
    const b = base.pages[i]?.anchor;
    if (!b || b.src !== now.src || Math.abs(b.t - now.t) > 0.01) ops.push({ id: newId('op'), type: 'page', page: i, to: now, applied: true, time });
  });
  return ops;
}
