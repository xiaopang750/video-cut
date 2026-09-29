import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeftRight,
  ChevronLeft,
  ChevronRight,
  Keyboard,
  Loader2,
  Maximize2,
  Mic,
  Minus,
  Play,
  Plus,
  Redo2,
  RotateCcw,
  Scissors,
  SquarePlus,
  Undo2,
  VolumeX,
  X,
} from 'lucide-react';
import { fmtTime, toast } from '../appStore.js';
import { Keys, Switch, Tip, hideTip, showTip } from '../components/ui.jsx';
import { peakRange } from './audioEngine.js';
import * as M from './editModel.js';
import { getEngine, onFrame, useEditor } from './store.js';
import { sentencesOf, sentenceText } from './transcript.js';

// ---------- 布局（CSS 像素）----------
const RULER_H = 24;
const PAGES_Y = 26;
const PAGES_H = 28;
const FRAG_Y = 58;
const FRAG_H = 16;
const WAVE_Y = 78;
const WAVE_H = 112;
const WORDS_Y = 194;
const WORD_ROW = 22;
const H = WORDS_Y + WORD_ROW * 2 + 4;
const MINI_H = 30;
const MAX_PPS = 1200;
const BADGE_Y = WAVE_Y + 12;

const LANES = [
  { y: PAGES_Y, h: PAGES_H, label: '页面', tip: '每一页图文显示的时间段。拖动两页之间的白色把手，可以调整翻到下一页的时间' },
  { y: FRAG_Y, h: FRAG_H, label: '视频段', tip: '原始视频的分段（按文件名顺序拼接）；黄色是替换用的补录，绿色是新增的补录' },
  { y: WAVE_Y, h: WAVE_H, label: '音频', tip: '音频波形（越高越响）。拖选一段后可以试听、删除或替换成补录' },
  { y: WORDS_Y, h: WORD_ROW * 2, label: '识别文字', tip: '语音识别出的文字，按句分组、颜色跟随所在的页；加粗 = 和文字稿对上的词，灰色 = 文字稿里没有的，划线 = 已删除' },
];

const FAMILY = '-apple-system, "PingFang SC", sans-serif';
const C = { sea: '#1E65C0', sunset: '#FF7425', sky: '#4A92E0', waveBg: '#F8FAFD', grid: '#E6ECF5', muted: '#8A96A8' };
const PAGE_COLORS = [
  { bg: '#DCEBFF', on: '#4A92E0', text: '#1E4F94', line: '#4A92E0' },
  { bg: '#FFE7D1', on: '#FF9A4D', text: '#9A4A0C', line: '#FF7425' },
];
const WORD_PAL = [
  { text: '#174A93', pill: 'rgba(74,146,224,0.10)', pillOn: 'rgba(74,146,224,0.26)' },
  { text: '#9C470A', pill: 'rgba(255,176,96,0.17)', pillOn: 'rgba(255,145,60,0.32)' },
];
const WORD_FONT = { m: `600 13px ${FAMILY}`, s: `500 13px ${FAMILY}`, x: `400 13px ${FAMILY}` };
// 波形颜色：按片段类型
const WAVE = {
  keep: { strong: '#1E65C0', light: '#9CC2F0' },
  cut: { strong: '#C9D0DA', light: '#C9D0DA' },
  old: { strong: '#CDD2D9', light: '#CDD2D9' },
  new: { strong: '#C98F00', light: '#EFCF7A' },
  insert: { strong: '#23915A', light: '#96D5B2' },
};
// 剪辑标记：删除红、替换黄、插入绿
export const MARK = {
  cut: { line: '#E5484D', tint: 'rgba(229,72,77,0.07)', icon: '✂', name: '删除' },
  replace: { line: '#E0A100', tint: 'rgba(245,184,0,0.09)', tintNew: 'rgba(245,184,0,0.17)', icon: '⇄', name: '替换' },
  insert: { line: '#2FA56B', tint: 'rgba(47,165,107,0.11)', icon: '+', name: '新增' },
  silence: { line: '#6F7C91', tint: 'rgba(111,124,145,0.12)', icon: '空', name: '空白' },
};

function niceStep(pps) {
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  return steps.find((s) => s * pps >= 70) || 600;
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const setPop = (pop) => useEditor.setState({ pop });

// 工具栏放不下时一级级收紧：0 全显示 → 1 去掉分组说明、缩短缩放条 → 2 撤销 / 重做 / 贴合字词只留图标
// → 3 插入按钮只留图标、去掉缩放条 → 4 全部只留图标（还放不下就横向滚动）
const DENSITY_MAX = 4;
function useToolbarDensity(ref) {
  const [d, setD] = useState(0);
  const widths = useRef({});
  const [, force] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => force((n) => n + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const avail = el.clientWidth;
    widths.current[d] = el.scrollWidth;
    if (el.scrollWidth > avail + 1 && d < DENSITY_MAX) setD(d + 1);
    else if (d > 0 && widths.current[d - 1] != null && widths.current[d - 1] <= avail) setD(d - 1);
  });
  return d;
}

// 当前还存在的、与 pop 对应的区块（剪辑后区块位置会变；同一条记录有几块时取离得最近的）
function findBlock(items, pop) {
  let best = null;
  for (const b of M.blocks(items)) {
    if (b.op !== pop.op) continue;
    if (!best || Math.abs(b.a - pop.a) < Math.abs(best.a - pop.a)) best = b;
  }
  return best;
}

export default function Timeline({ onRecord, onSilence }) {
  const mainRef = useRef(null);
  const cvRef = useRef(null);
  const miniRef = useRef(null);
  const fileRef = useRef(null);
  const helpBtn = useRef(null);
  const barRef = useRef(null);
  const density = useToolbarDensity(barRef);
  const fileMode = useRef('insert');
  const hits = useRef({ words: [], badges: [], edges: [], frags: [], sents: [] });
  const [width, setWidth] = useState(1000);
  const pop = useEditor((s) => s.pop);
  const [dragging, setDragging] = useState(false);
  const [help, setHelp] = useState(false);

  const sel = useEditor((s) => s.sel);
  const edit = useEditor((s) => s.edit);
  const pps = useEditor((s) => s.view.pps);
  const snap = useEditor((s) => s.snap);
  const busy = useEditor((s) => s.busy);
  const canUndo = useEditor((s) => s.undoStack.length > 0);
  const canRedo = useEditor((s) => s.redoStack.length > 0);
  // 只有存在选区时才订阅滚动位置（浮动操作条要跟着走），避免播放时整个组件每帧重渲染
  const vstart = useEditor((s) => (s.sel ? s.view.start : null));
  const total = useMemo(() => M.totalDT(edit.items), [edit.items]);
  const outTotal = useMemo(() => M.totalOut(edit.items), [edit.items]);
  const selAllCut = sel ? M.isAllCut(edit.items, sel.a, sel.b) : false;
  const minPps = Math.max(0.5, (width - 40) / Math.max(1, total));

  const dirty = useRef(true);
  useEffect(() => useEditor.subscribe(() => (dirty.current = true)), []);

  useEffect(() => {
    const ro = new ResizeObserver(([e]) => {
      const w = Math.max(200, Math.floor(e.contentRect.width));
      setWidth(w);
      useEditor.setState({ tlWidth: w });
      dirty.current = true;
    });
    ro.observe(mainRef.current);
    return () => ro.disconnect();
  }, []);

  const clampStart = (start, p = useEditor.getState().view.pps) => {
    const span = width / p;
    return M.clamp(start, 0, Math.max(0, total - span * 0.85));
  };

  // ================= 绘制 =================
  useEffect(() => {
    const cv = cvRef.current;
    const mini = miniRef.current;
    const dpr = window.devicePixelRatio || 1;
    cv.width = width * dpr;
    cv.height = H * dpr;
    mini.width = width * dpr;
    mini.height = MINI_H * dpr;
    const ctx = cv.getContext('2d');
    const mctx = mini.getContext('2d');
    const widthCache = new Map();
    const measure = (text, font) => {
      const key = font + text;
      let w = widthCache.get(key);
      if (w == null) {
        ctx.font = font;
        w = ctx.measureText(text).width;
        widthCache.set(key, w);
      }
      return w;
    };
    let lastPos = -1;

    const draw = (pos) => {
      const st = useEditor.getState();
      const engine = getEngine();
      if (!st.edit || !engine) return;
      const { items, pages } = st.edit;
      const rows = M.layout(items);
      const { pps: P, start: v0 } = st.view;
      const W = width;
      const v1 = v0 + W / P;
      const X = (t) => (t - v0) * P;
      const tot = rows.totalDT;
      const current = M.pageIndexAt(pages, pos);
      const playX = X(pos);
      const blockList = M.blocks(items);

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';

      ctx.fillStyle = C.waveBg;
      ctx.fillRect(0, WAVE_Y, W, WAVE_H);
      if (X(tot) < W) {
        ctx.fillStyle = '#F1F3F7';
        const x0 = Math.max(0, X(tot));
        ctx.fillRect(x0, PAGES_Y, W - x0, H - PAGES_Y);
      }

      // ---- 刻度尺 ----
      const step = niceStep(P);
      const minor = step / 5;
      ctx.font = `11px ${FAMILY}`;
      ctx.lineWidth = 1;
      for (let t = Math.floor(v0 / minor) * minor; t <= v1; t += minor) {
        const x = Math.round(X(t)) + 0.5;
        const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
        ctx.strokeStyle = C.grid;
        ctx.beginPath();
        ctx.moveTo(x, major ? 12 : 18);
        ctx.lineTo(x, RULER_H);
        ctx.stroke();
        if (major) {
          ctx.fillStyle = C.muted;
          ctx.fillText(step < 1 ? fmtTime(t) : fmtTime(t, false), x + 4, 9);
          ctx.strokeStyle = '#EEF2F7';
          ctx.beginPath();
          ctx.moveTo(x, WAVE_Y);
          ctx.lineTo(x, WAVE_Y + WAVE_H);
          ctx.stroke();
        }
      }

      // ---- 剪辑区块底色（在波形下面）----
      for (const b of blockList) {
        if (b.b < v0 || b.a > v1) continue;
        if (b.type === 'replace') {
          if (b.oldA != null) {
            ctx.fillStyle = MARK.replace.tint;
            ctx.fillRect(X(b.oldA), WAVE_Y, (b.oldB - b.oldA) * P, H - WAVE_Y);
          }
          if (b.recA != null) {
            ctx.fillStyle = MARK.replace.tintNew;
            ctx.fillRect(X(b.recA), WAVE_Y, (b.recB - b.recA) * P, H - WAVE_Y);
          }
        } else {
          ctx.fillStyle = MARK[b.type].tint;
          ctx.fillRect(X(b.a), WAVE_Y, (b.b - b.a) * P, H - WAVE_Y);
        }
      }

      // ---- 页面色带 ----
      pages.forEach((pg, i) => {
        const a = pg.start;
        const b = i + 1 < pages.length ? pages[i + 1].start : tot;
        if (b < v0 || a > v1) return;
        const col = PAGE_COLORS[i % 2];
        const x0 = X(a) + 1;
        const x1 = X(b) - 1;
        const w = x1 - x0;
        if (w <= 0.5) return;
        ctx.fillStyle = i === current ? col.on : col.bg;
        roundRect(ctx, x0, PAGES_Y, w, PAGES_H, 8);
        ctx.fill();
        if (w > 26) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(x0 + 4, PAGES_Y, w - 8, PAGES_H);
          ctx.clip();
          const seg = st.segments.find((s) => s.id === pg.seg);
          const label = `P${i + 1}`;
          const lx = Math.max(x0 + 8, Math.min(8, x1 - 60));
          ctx.fillStyle = i === current ? '#fff' : col.text;
          ctx.font = `700 12px ${FAMILY}`;
          ctx.fillText(label, lx, PAGES_Y + PAGES_H / 2);
          const lw = ctx.measureText(label).width;
          ctx.font = `12px ${FAMILY}`;
          ctx.globalAlpha = 0.9;
          ctx.fillText(seg?.blocks?.[0]?.[0] || '', lx + lw + 8, PAGES_Y + PAGES_H / 2);
          ctx.globalAlpha = 1;
          ctx.restore();
        }
      });

      // ---- 视频段 ----
      const fragHits = [];
      const frags = st.sources.main?.fragments || [];
      ctx.font = `600 10.5px ${FAMILY}`;
      frags.forEach((f, i) => {
        for (const [a, b] of M.sourceRangeToDT(items, 'main', f.start, f.end)) {
          if (b < v0 || a > v1) continue;
          const x0 = X(a) + 1;
          const w = X(b) - X(a) - 2;
          if (w <= 0.5) continue;
          ctx.fillStyle = i % 2 ? '#DDE4EE' : '#EBEFF5';
          roundRect(ctx, x0, FRAG_Y, w, FRAG_H, 5);
          ctx.fill();
          if (w > 34) {
            ctx.fillStyle = '#5D6B80';
            ctx.fillText(`段 ${i + 1}`, Math.max(x0 + 6, Math.min(6, x0 + w - 40)), FRAG_Y + FRAG_H / 2 + 0.5);
          }
          fragHits.push({ x0, x1: x0 + w, index: i, file: f.file, dur: f.end - f.start, start: a });
        }
      });
      for (const b of blockList) {
        if (b.type === 'cut' || b.recA == null || b.recB < v0 || b.recA > v1) continue;
        const x0 = X(b.recA) + 1;
        const w = (b.recB - b.recA) * P - 2;
        ctx.fillStyle = b.type === 'replace' ? '#F7DE94' : b.type === 'silence' ? '#DCE2EA' : '#B7E4CB';
        roundRect(ctx, x0, FRAG_Y, w, FRAG_H, 5);
        ctx.fill();
        if (w > 30) {
          ctx.fillStyle = b.type === 'replace' ? '#8A6200' : b.type === 'silence' ? '#5D6B80' : '#1D6E45';
          ctx.fillText(b.type === 'silence' ? '空白' : '补录', Math.max(x0 + 6, Math.min(6, x0 + w - 30)), FRAG_Y + FRAG_H / 2 + 0.5);
        }
        const srcInfo = st.sources[b.src];
        fragHits.push({ x0, x1: x0 + w, rec: b.type, file: srcInfo?.name || '补录', dur: b.recB - b.recA, start: b.recA });
      }

      // ---- 波形：按响度画细条，播放过的部分用深色；删除 / 被替换的内容是灰色 ----
      const mid = WAVE_Y + WAVE_H / 2;
      const amp = WAVE_H / 2 - 7;
      const barW = P < 160 ? 3 : P < 480 ? 2 : 1;
      const fillW = barW === 3 ? 2 : barW === 2 ? 1.4 : 1;
      const phase = (((v0 * P) % barW) + barW) % barW;
      for (const r of rows) {
        const a = r.dt;
        const b = r.dt + r.len;
        if (b < v0 || a > v1) continue;
        const pk = engine.peaks.get(r.it.src);
        if (!pk) continue;
        const col = WAVE[r.it.kind] || WAVE.keep;
        const xa = Math.max(0, X(a));
        const xb = Math.min(W, X(b));
        const played = new Path2D();
        const rest = new Path2D();
        for (let x = Math.floor((xa + phase) / barW) * barW - phase; x < xb; x += barW) {
          const t0 = Math.max(a, v0 + x / P);
          const t1 = Math.min(b, v0 + (x + barW) / P);
          if (t1 <= t0) continue;
          const pr = peakRange(pk, r.it.in + (t0 - a), r.it.in + (t1 - a));
          const v = barW === 1 ? Math.min(1, pr.peak) ** 0.85 : Math.min(1, pr.loud) ** 0.7;
          const h = Math.max(1, v * amp);
          (x + fillW <= playX ? played : rest).rect(x, mid - h, fillW, h * 2);
        }
        ctx.fillStyle = col.light;
        ctx.fill(rest);
        ctx.fillStyle = col.strong;
        ctx.fill(played);
      }

      // 原视频分段线
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = '#A9B5C6';
      ctx.lineWidth = 1;
      frags.forEach((f, i) => {
        if (i === 0) return;
        const t = M.sourceToDT(items, 'main', f.start);
        if (t == null || t < v0 || t > v1) return;
        const x = Math.round(X(t)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, FRAG_Y);
        ctx.lineTo(x, WAVE_Y + WAVE_H);
        ctx.stroke();
      });
      ctx.setLineDash([]);

      // ---- 识别文字：按句成组，两行交替，颜色跟随所在页；删除的内容划线 ----
      const itemsVis = [];
      for (const r of rows) {
        const a = r.dt;
        if (a + r.len < v0 - 20 || a > v1 + 1) continue;
        const ws = st.words[r.it.src];
        if (!ws?.words?.length) continue;
        const dim = !r.played;
        for (const s of sentencesOf(ws.words)) {
          if (s.t1 < r.it.in || s.t0 >= r.it.out) continue;
          const idx = [];
          for (let k = s.i0; k <= s.i1; k++) {
            const w = ws.words[k];
            if (w.t0 >= r.it.in && w.t0 < r.it.out) idx.push(k);
          }
          if (!idx.length) continue;
          const t0 = a + (ws.words[idx[0]].t0 - r.it.in);
          const t1 = a + (Math.min(ws.words[idx[idx.length - 1]].t1, r.it.out) - r.it.in);
          if (t1 < v0 - 20 || t0 > v1) continue;
          itemsVis.push({ ws, idx, a, cin: r.it.in, cout: r.it.out, t0, t1, sent: s, dim });
        }
      }
      const wordHits = [];
      const sentHits = [];
      const space = measure(' ', WORD_FONT.m);
      itemsVis.forEach((it, k) => {
        const row = k % 2;
        const y = WORDS_Y + row * WORD_ROW + WORD_ROW / 2;
        const xs = X(it.t0);
        const xe = X(it.t1);
        const cap = k + 2 < itemsVis.length ? X(itemsVis[k + 2].t0) - 10 : W + 400;
        if (xs > W || cap < 0) return;
        const pal = WORD_PAL[M.pageIndexAt(pages, it.t0) % 2];
        const words = it.idx.map((i) => ({ w: it.ws.words[i], state: it.ws.state[i] || 'm' }));
        let placed = [];
        let fits = true;
        let prevEnd = -1e9;
        for (const d of words) {
          const x = X(it.a + d.w.t0 - it.cin);
          const tw = measure(d.w.text, WORD_FONT[d.state] || WORD_FONT.m);
          if (x < prevEnd + 4) {
            fits = false;
            break;
          }
          placed.push({ ...d, x, tw });
          prevEnd = x + tw;
        }
        if (fits && prevEnd > cap) fits = false;
        let truncated = false;
        if (!fits) {
          placed = [];
          let x = xs;
          for (const d of words) {
            const tw = measure(d.w.text, WORD_FONT[d.state] || WORD_FONT.m);
            if (x + tw > cap - 12 && placed.length) {
              truncated = true;
              break;
            }
            placed.push({ ...d, x, tw });
            x += tw + space;
          }
          prevEnd = placed.length ? placed[placed.length - 1].x + placed[placed.length - 1].tw : xs;
        }
        const end = Math.min(Math.max(xe, prevEnd + (truncated ? 14 : 0)), cap);
        const isCur = !it.dim && pos >= it.t0 && pos <= it.t1;
        ctx.fillStyle = it.dim ? 'rgba(160,170,184,0.12)' : isCur ? pal.pillOn : pal.pill;
        roundRect(ctx, xs - 5, y - 10, end - xs + 10, 20, 10);
        ctx.fill();
        for (const d of placed) {
          ctx.font = WORD_FONT[d.state] || WORD_FONT.m;
          ctx.fillStyle = it.dim ? '#AAB3C0' : d.state === 'x' ? '#98A3B3' : pal.text;
          ctx.fillText(d.w.text, d.x, y + 0.5);
          if (it.dim) ctx.fillRect(d.x, y + 0.5, d.tw, 1.2);
          const ts = it.a + (d.w.t0 - it.cin);
          wordHits.push({
            x0: d.x - 2,
            x1: d.x + d.tw + 2,
            y0: y - 10,
            y1: y + 10,
            start: ts,
            end: Math.max(ts + 0.05, it.a + (Math.min(d.w.t1, it.cout) - it.cin)),
            sent: it,
          });
        }
        if (truncated) {
          ctx.fillStyle = it.dim ? '#AAB3C0' : pal.text;
          ctx.font = WORD_FONT.m;
          ctx.fillText('…', prevEnd + 3, y);
        }
        sentHits.push({ x0: xs - 5, x1: end + 5, y0: y - 10, y1: y + 10, it });
      });

      // ---- 选区 ----
      const sl = st.sel;
      if (sl && sl.b > v0 && sl.a < v1) {
        const xa = X(sl.a);
        const xb = X(sl.b);
        ctx.fillStyle = 'rgba(74,146,224,0.16)';
        ctx.fillRect(xa, WAVE_Y, xb - xa, H - WAVE_Y);
        ctx.fillStyle = C.sky;
        ctx.fillRect(xa - 1, WAVE_Y, 2, H - WAVE_Y);
        ctx.fillRect(xb - 1, WAVE_Y, 2, H - WAVE_Y);
        for (const x of [xa, xb]) {
          roundRect(ctx, x - 4, WAVE_Y - 2, 8, 14, 3);
          ctx.fill();
        }
      }

      // ---- 剪辑标记：两端加粗虚线 + 图标 ----
      const badges = [];
      const edges = [];
      const drawLine = (x, color) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.5;
        ctx.setLineDash([7, 5]);
        ctx.beginPath();
        ctx.moveTo(x, FRAG_Y);
        ctx.lineTo(x, H);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineWidth = 1;
      };
      const drawBadge = (x, color, icon) => {
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(x, BADGE_Y, 11.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, BADGE_Y, 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.font = `700 ${icon === '+' ? 15 : 12}px ${FAMILY}`;
        ctx.fillText(icon, x, BADGE_Y + 0.5);
        ctx.textAlign = 'left';
      };
      const drawTag = (x, text, color) => {
        ctx.font = `600 11px ${FAMILY}`;
        const tw = ctx.measureText(text).width + 12;
        ctx.fillStyle = color;
        roundRect(ctx, x, WAVE_Y + WAVE_H - 22, tw, 18, 9);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.fillText(text, x + 6, WAVE_Y + WAVE_H - 13);
      };
      const dur = (x, y) => `${(y - x).toFixed(1)}s`;
      for (const b of blockList) {
        if (b.b < v0 - 1 || b.a > v1 + 1) continue;
        const m = MARK[b.type];
        const xa = X(b.a);
        const xb = X(b.b);
        drawLine(xa, m.line);
        drawLine(xb, m.line);
        if (b.type === 'replace' && b.oldA != null && b.recA != null) {
          ctx.strokeStyle = m.line;
          ctx.beginPath();
          ctx.moveTo(X(b.recA) + 0.5, WAVE_Y);
          ctx.lineTo(X(b.recA) + 0.5, H);
          ctx.stroke();
        }
        if (b.type === 'cut' && xb - xa > 76) drawTag(xa + 8, `已删除 ${dur(b.a, b.b)}`, m.line);
        if (b.type === 'insert' && xb - xa > 64) drawTag(xa + 8, `新增 ${dur(b.a, b.b)}`, m.line);
        if (b.type === 'silence' && xb - xa > 64) drawTag(xa + 8, `空白 ${dur(b.a, b.b)}`, m.line);
        if (b.type === 'replace') {
          if (b.oldA != null && X(b.oldB) - X(b.oldA) > 76) drawTag(X(b.oldA) + 8, `被替换 ${dur(b.oldA, b.oldB)}`, '#B98400');
          if (b.recA != null && X(b.recB) - X(b.recA) > 76) drawTag(X(b.recA) + 8, `新录音 ${dur(b.recA, b.recB)}`, m.line);
        }
        drawBadge(xa, m.line, m.icon);
        drawBadge(xb, m.line, m.icon);
        badges.push({ x: xa, block: b }, { x: xb, block: b });
        if (b.type === 'cut') edges.push({ x: xa, block: b, edge: 'start' }, { x: xb, block: b, edge: 'end' });
      }

      // ---- 翻页把手 ----
      pages.forEach((pg, i) => {
        if (i === 0 || pg.start < v0 - 1 || pg.start > v1 + 1) return;
        const x = Math.round(X(pg.start)) + 0.5;
        const col = PAGE_COLORS[i % 2];
        ctx.strokeStyle = col.line;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(x, PAGES_Y + PAGES_H);
        ctx.lineTo(x, WAVE_Y + WAVE_H);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#fff';
        ctx.lineWidth = 1.5;
        roundRect(ctx, x - 5, PAGES_Y + 2, 10, PAGES_H - 4, 4);
        ctx.fill();
        ctx.stroke();
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x - 1.5, PAGES_Y + 9);
        ctx.lineTo(x - 1.5, PAGES_Y + PAGES_H - 9);
        ctx.moveTo(x + 1.5, PAGES_Y + 9);
        ctx.lineTo(x + 1.5, PAGES_Y + PAGES_H - 9);
        ctx.stroke();
      });

      // ---- 播放头 ----
      if (pos >= v0 && pos <= v1) {
        const x = Math.round(playX);
        ctx.fillStyle = C.sunset;
        ctx.fillRect(x - 1, 14, 2, H - 14);
        ctx.beginPath();
        ctx.moveTo(x - 7, 2);
        ctx.lineTo(x + 7, 2);
        ctx.lineTo(x + 7, 10);
        ctx.lineTo(x, 17);
        ctx.lineTo(x - 7, 10);
        ctx.closePath();
        ctx.fill();
      }

      hits.current = { words: wordHits, badges, edges, frags: fragHits, sents: sentHits };

      // ---- 小地图 ----
      mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      mctx.clearRect(0, 0, W, MINI_H);
      mctx.fillStyle = '#FBFCFE';
      mctx.fillRect(0, 0, W, MINI_H);
      const k = W / Math.max(tot, 0.001);
      pages.forEach((pg, i) => {
        const b = i + 1 < pages.length ? pages[i + 1].start : tot;
        mctx.fillStyle = i === current ? PAGE_COLORS[i % 2].line : PAGE_COLORS[i % 2].bg;
        mctx.fillRect(pg.start * k, MINI_H - 5, Math.max(1, (b - pg.start) * k - 1), 5);
      });
      for (const r of rows) {
        const pk = engine.peaks.get(r.it.src);
        if (!pk) continue;
        const col = WAVE[r.it.kind] || WAVE.keep;
        for (let x = Math.floor(r.dt * k); x < Math.ceil((r.dt + r.len) * k); x += 2) {
          const t0 = r.it.in + (x / k - r.dt);
          const pr = peakRange(pk, Math.max(r.it.in, t0), Math.min(r.it.out, t0 + 2 / k));
          const h = Math.max(0.5, Math.min(1, pr.loud) ** 0.7 * (MINI_H / 2 - 5));
          mctx.fillStyle = x <= pos * k ? col.strong : col.light;
          mctx.fillRect(x, (MINI_H - 5) / 2 - h, 1.4, h * 2);
        }
      }
      for (const b of blockList) {
        mctx.fillStyle = MARK[b.type].line;
        mctx.fillRect(b.a * k, 0, Math.max(1.5, (b.b - b.a) * k), 3);
      }
      mctx.fillStyle = 'rgba(30,101,192,0.08)';
      mctx.strokeStyle = C.sea;
      mctx.lineWidth = 1.5;
      const vx = v0 * k;
      const vw = Math.max(4, (v1 - v0) * k);
      mctx.fillRect(vx, 1, vw, MINI_H - 2);
      mctx.strokeRect(vx + 0.75, 1.75, vw - 1.5, MINI_H - 3.5);
      mctx.fillStyle = C.sunset;
      mctx.fillRect(Math.round(pos * k) - 1, 0, 2, MINI_H);
    };

    const unsub = onFrame((pos, playing) => {
      const st = useEditor.getState();
      if (playing && st.follow) {
        const span = width / st.view.pps;
        let start = st.view.start;
        if (pos > start + span * 0.72) start = pos - span * 0.72;
        else if (pos < start) start = Math.max(0, pos - span * 0.1);
        if (start !== st.view.start) useEditor.setState({ view: { ...st.view, start } });
      }
      if (dirty.current || pos !== lastPos) {
        dirty.current = false;
        lastPos = pos;
        draw(pos);
      }
    });
    dirty.current = true;
    return unsub;
  }, [width]);

  // ================= 交互 =================
  useEffect(() => {
    const cv = cvRef.current;
    let drag = null;
    let hoverKey = '';
    const local = (e) => {
      const r = cv.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const tAt = (x) => {
      const { view } = useEditor.getState();
      return view.start + x / view.pps;
    };
    const viewRect = (x0, y0, x1, y1) => {
      const r = cv.getBoundingClientRect();
      return { left: r.left + x0, top: r.top + y0, right: r.left + x1, bottom: r.top + y1, width: x1 - x0, height: y1 - y0 };
    };

    // prefer：优先吸附的位置（拖翻页把手时 = 这一页初始化时的位置，方便拖回去）
    const snapT = (t, e, prefer = null) => {
      const st = useEditor.getState();
      if (e.altKey) return t;
      const P = st.view.pps;
      if (prefer != null && Math.abs((prefer - t) * P) < 10) return prefer;
      if (!st.snap) return t;
      let best = t;
      let bestD = 7;
      const consider = (ct) => {
        const d = Math.abs((ct - t) * P);
        if (d < bestD) (bestD = d), (best = ct);
      };
      for (const w of hits.current.words) {
        consider(w.start - 0.04);
        consider(w.end);
      }
      for (const b of hits.current.badges) consider(st.view.start + b.x / P);
      for (const f of hits.current.frags) consider(f.start);
      consider(st.position());
      return best;
    };

    const hitTest = (x, y) => {
      const st = useEditor.getState();
      const P = st.view.pps;
      const X = (t) => (t - st.view.start) * P;
      if (y < RULER_H) return { type: 'ruler' };
      if (y >= PAGES_Y && y <= PAGES_Y + PAGES_H) {
        const pages = st.edit.pages;
        let best = null;
        for (let i = 1; i < pages.length; i++) {
          const d = Math.abs(X(pages[i].start) - x);
          if (d <= 7 && (!best || d < best.d)) best = { d, i };
        }
        if (best) return { type: 'boundary', index: best.i, x: X(pages[best.i].start) };
        return { type: 'page', index: M.pageIndexAt(pages, tAt(x)) };
      }
      for (const b of hits.current.badges) if (Math.hypot(b.x - x, BADGE_Y - y) <= 12) return { type: 'badge', ...b };
      if (y >= FRAG_Y && y <= FRAG_Y + FRAG_H) {
        const f = hits.current.frags.find((h) => x >= h.x0 && x <= h.x1);
        return f ? { type: 'frag', ...f } : { type: 'none' };
      }
      const sl = st.sel;
      if (sl && y >= WAVE_Y - 4) {
        if (Math.abs(X(sl.a) - x) <= 5) return { type: 'selEdge', anchor: sl.b, x: X(sl.a) };
        if (Math.abs(X(sl.b) - x) <= 5) return { type: 'selEdge', anchor: sl.a, x: X(sl.b) };
      }
      if (y >= WAVE_Y) for (const e of hits.current.edges) if (Math.abs(e.x - x) <= 5) return { type: 'cutEdge', ...e };
      if (y >= WORDS_Y) {
        for (const w of hits.current.words) if (x >= w.x0 && x <= w.x1 && y >= w.y0 && y <= w.y1) return { type: 'word', ...w };
        for (const s of hits.current.sents) if (x >= s.x0 && x <= s.x1 && y >= s.y0 && y <= s.y1) return { type: 'sentence', ...s };
      }
      return { type: 'wave' };
    };

    const blockTip = (b) => {
      const d = (x, y) => (y - x).toFixed(1);
      if (b.type === 'cut') return `已删除 ${d(b.a, b.b)} 秒（播放和生成时跳过）。点击：试听、微调或回撤；也可以直接拖动红线调整删除范围`;
      if (b.type === 'replace') {
        return `替换：原录音 ${b.oldA != null ? d(b.oldA, b.oldB) : 0} 秒 → 新录音 ${d(b.recA, b.recB)} 秒。点击：试听、微调或回撤`;
      }
      if (b.type === 'silence') return `插入的空白 ${d(b.a, b.b)} 秒。点击：试听前后、改时长或回撤`;
      return `新增的录音 ${d(b.a, b.b)} 秒。点击：试听、微调或回撤`;
    };

    // 画布上的悬停提示（和按钮用同一个 Tooltip 浮层）
    const hoverTip = (h, x) => {
      const st = useEditor.getState();
      const pages = st.edit.pages;
      const tot = M.totalDT(st.edit.items);
      switch (h.type) {
        case 'boundary':
          return { key: `b${h.index}`, rect: viewRect(h.x - 6, PAGES_Y, h.x + 6, PAGES_Y + PAGES_H), text: `拖动调整 P${h.index + 1} 从哪里开始（左右拖）` };
        case 'page': {
          const i = h.index;
          const a = pages[i].start;
          const b = i + 1 < pages.length ? pages[i + 1].start : tot;
          const seg = st.segments.find((s) => s.id === pages[i].seg);
          return {
            key: `p${i}`,
            rect: viewRect(x - 1, PAGES_Y, x + 1, PAGES_Y + PAGES_H),
            text: `P${i + 1} · ${fmtTime(a)}–${fmtTime(b)}  ${seg?.blocks?.[0]?.[0] || ''}`,
          };
        }
        case 'frag':
          return {
            key: `f${h.index ?? h.rec}${h.x0}`,
            rect: viewRect(Math.max(0, x - 1), FRAG_Y, x + 1, FRAG_Y + FRAG_H),
            text: h.rec
              ? h.rec === 'silence'
                ? `插入的空白 · ${h.dur.toFixed(2)} 秒`
                : `补录（${h.rec === 'replace' ? '替换' : '新增'}）：${h.file} · ${h.dur.toFixed(1)} 秒`
              : `第 ${h.index + 1} 段视频：${h.file} · ${h.dur.toFixed(1)} 秒`,
          };
        case 'badge':
          return { key: `bd${h.x}`, rect: viewRect(h.x - 10, BADGE_Y - 10, h.x + 10, BADGE_Y + 10), text: blockTip(h.block) };
        case 'cutEdge':
          return { key: `ce${h.x}`, rect: viewRect(h.x - 3, WAVE_Y + 26, h.x + 3, WAVE_Y + 40), text: '拖动这条红线，调整删除的范围' };
        case 'selEdge':
          return { key: 'se', rect: viewRect(h.x - 4, WAVE_Y, h.x + 4, WAVE_Y + 12), text: '拖动调整选区边缘' };
        case 'word':
        case 'sentence': {
          const it = h.sent || h.it;
          return {
            key: `s${it.t0}`,
            rect: viewRect(h.x0, h.y0, h.x1, h.y1),
            text: `${it.dim ? '（已删除）' : ''}${fmtTime(it.t0)}  ${sentenceText(it.ws.words, it.sent)}`,
          };
        }
        default:
          return null;
      }
    };

    const cursorFor = (h) =>
      ({
        ruler: 'ew-resize',
        boundary: 'col-resize',
        page: 'pointer',
        frag: 'pointer',
        badge: 'pointer',
        cutEdge: 'col-resize',
        selEdge: 'ew-resize',
        word: 'pointer',
      })[h.type] || 'text';

    const onDown = (e) => {
      if (e.button !== 0) return;
      const { x, y } = local(e);
      const st = useEditor.getState();
      const h = hitTest(x, y);
      setPop(null);
      hideTip();
      hoverKey = '';
      cv.setPointerCapture(e.pointerId);
      if (h.type === 'ruler') {
        drag = { kind: 'scrub' };
        st.seek(tAt(x));
      } else if (h.type === 'boundary') {
        drag = { kind: 'boundary', index: h.index };
      } else if (h.type === 'page') {
        st.seek(st.edit.pages[h.index].start);
      } else if (h.type === 'frag') {
        st.seek(h.start + 0.001);
      } else if (h.type === 'badge') {
        setPop({ op: h.block.op, a: h.block.a, t: tAt(h.x) });
      } else if (h.type === 'cutEdge') {
        drag = { kind: 'cutEdge', edge: h.edge, op: h.block.op, at: h.edge === 'start' ? h.block.a : h.block.b, before: st.ops, delta: 0 };
      } else if (h.type === 'selEdge') {
        drag = { kind: 'selEdge', anchor: h.anchor };
      } else if (h.type !== 'none') {
        drag = { kind: 'select', x0: x, t0: tAt(x), moved: false, word: h.type === 'word' ? h : null };
      }
      if (drag) setDragging(drag.kind !== 'scrub');
    };

    const onMove = (e) => {
      const { x, y } = local(e);
      const st = useEditor.getState();
      if (!drag) {
        const h = hitTest(x, y);
        cv.style.cursor = cursorFor(h);
        const tip = hoverTip(h, x);
        const key = tip?.key || '';
        if (key !== hoverKey) {
          hoverKey = key;
          if (tip) showTip(tip.rect, tip.text);
          else hideTip();
        }
        return;
      }
      if (drag.kind !== 'scrub' && (x < 24 || x > width - 24)) {
        const dir = x < 24 ? -1 : 1;
        st.setView({ ...st.view, start: clampStart(st.view.start + (dir * 12) / st.view.pps) });
        useEditor.setState({ follow: false });
      }
      const t = M.clamp(tAt(x), 0, M.totalDT(st.edit.items));
      if (drag.kind === 'scrub') st.seek(t);
      else if (drag.kind === 'boundary') {
        const init = st.base.pages[drag.index]?.anchor;
        drag.t = snapT(t, e, init ? M.anchorToDT(st.edit.items, init) : null);
        st.previewEdit(M.setPageStart(st.edit, drag.index, drag.t));
      } else if (drag.kind === 'cutEdge') {
        // 拖动删除区块的边：往外拖扩大删除，往里拖恢复一部分（改的是这条删除记录的范围）
        drag.delta = snapT(t, e) - drag.at;
        st.moveCutEdge(drag.op, drag.edge, drag.delta, { preview: true, from: drag.before, at: drag.at });
      } else if (drag.kind === 'selEdge') {
        const s = snapT(t, e);
        st.setSel({ a: Math.min(drag.anchor, s), b: Math.max(drag.anchor, s) });
      } else if (drag.kind === 'select') {
        if (Math.abs(x - drag.x0) > 3) drag.moved = true;
        if (drag.moved) {
          const s = snapT(t, e);
          const a0 = snapT(drag.t0, e);
          st.setSel({ a: Math.min(a0, s), b: Math.max(a0, s) });
        }
      }
    };

    const onUp = (e) => {
      const st = useEditor.getState();
      if (drag?.kind === 'boundary' && drag.t != null) st.setPageStart(drag.index, drag.t);
      if (drag?.kind === 'cutEdge') {
        if (Math.abs(drag.delta) > 1e-4) st.moveCutEdge(drag.op, drag.edge, drag.delta, { from: drag.before, at: drag.at });
        else st.previewOps(drag.before);
      }
      if (drag?.kind === 'select' && !drag.moved) {
        st.setSel(null);
        st.seek(drag.word ? drag.word.start : drag.t0);
      }
      drag = null;
      setDragging(false);
      try {
        cv.releasePointerCapture(e.pointerId);
      } catch {}
    };

    const onLeave = () => {
      if (drag) return;
      hoverKey = '';
      hideTip();
    };

    const onDbl = (e) => {
      const { x, y } = local(e);
      const h = hitTest(x, y);
      if (h.type === 'word') useEditor.getState().setSel({ a: h.start - 0.03, b: h.end });
    };

    const onWheel = (e) => {
      e.preventDefault();
      setPop(null);
      hideTip();
      const st = useEditor.getState();
      const { x } = local(e);
      const { pps: P, start } = st.view;
      if (e.ctrlKey || e.metaKey) {
        const tc = start + x / P;
        const np = M.clamp(P * Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.003)), minPps, MAX_PPS);
        st.setView({ pps: np, start: clampStart(tc - x / np, np) });
      } else {
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        st.setView({ pps: P, start: clampStart(start + d / P) });
        useEditor.setState({ follow: false });
      }
    };

    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerup', onUp);
    cv.addEventListener('pointercancel', onUp);
    cv.addEventListener('pointerleave', onLeave);
    cv.addEventListener('dblclick', onDbl);
    cv.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      cv.removeEventListener('pointerdown', onDown);
      cv.removeEventListener('pointermove', onMove);
      cv.removeEventListener('pointerup', onUp);
      cv.removeEventListener('pointercancel', onUp);
      cv.removeEventListener('pointerleave', onLeave);
      cv.removeEventListener('dblclick', onDbl);
      cv.removeEventListener('wheel', onWheel);
    };
  }, [width, total, minPps]);

  // 小地图：点击 / 拖动定位
  useEffect(() => {
    const mini = miniRef.current;
    let down = false;
    const go = (e) => {
      const st = useEditor.getState();
      const r = mini.getBoundingClientRect();
      const t = ((e.clientX - r.left) / r.width) * total;
      const span = width / st.view.pps;
      st.setView({ ...st.view, start: clampStart(t - span / 2) });
      useEditor.setState({ follow: false });
    };
    const d = (e) => {
      down = true;
      mini.setPointerCapture(e.pointerId);
      hideTip();
      go(e);
    };
    const m = (e) => down && go(e);
    const u = () => (down = false);
    const enter = () =>
      !down &&
      showTip(mini, '全部音频的缩略图：蓝框是当前看到的范围，顶部的红 / 黄 / 绿短线是删除 / 替换 / 新增的位置；点击或拖动可以快速跳转', {
        delay: 600,
      });
    mini.addEventListener('pointerdown', d);
    mini.addEventListener('pointermove', m);
    mini.addEventListener('pointerup', u);
    mini.addEventListener('pointerenter', enter);
    mini.addEventListener('pointerleave', hideTip);
    return () => {
      mini.removeEventListener('pointerdown', d);
      mini.removeEventListener('pointermove', m);
      mini.removeEventListener('pointerup', u);
      mini.removeEventListener('pointerenter', enter);
      mini.removeEventListener('pointerleave', hideTip);
    };
  }, [total, width]);

  const zoomTo = (np) => useEditor.getState().zoomTo(np);
  const fit = () => useEditor.getState().setView({ pps: minPps, start: 0 });

  const pickFile = (mode) => {
    fileMode.current = mode;
    fileRef.current.value = '';
    fileRef.current.click();
  };

  const st = useEditor.getState();
  const toX = (t) => (t - (vstart ?? st.view.start)) * pps;
  const selPopX = sel ? M.clamp(toX((sel.a + sel.b) / 2), 240, width - 240) : 0;
  const block = pop ? findBlock(edit.items, pop) : null;
  const logZoom = (p) => Math.log(p);


  return (
    <div className="timeline-wrap">
      <div ref={barRef} className={`tl-toolbar d${density}`}>
        {/* 左：撤销 / 重做 */}
        <div className="tb-group">
          <Tip tip="撤销上一步" keys={['⌘', 'Z']}>
            <button className="tb-btn" disabled={!canUndo} onClick={() => st.undo()}>
              <Undo2 />
              <span className="tx">撤销</span>
            </button>
          </Tip>
          <Tip tip="重做刚才撤销的操作" keys={['⇧', '⌘', 'Z']}>
            <button className="tb-btn" disabled={!canRedo} onClick={() => st.redo()}>
              <Redo2 />
              <span className="tx">重做</span>
            </button>
          </Tip>
        </div>

        {/* 中：在播放头插入（删除 / 替换选区用选区上弹出的工具条） */}
        <div className="tb-insert">
          <Tip tip="下面三个按钮都插入到橙色竖线（播放头）的位置；要删除或替换某一段，先在波形上拖选，选区上会出现操作条">
            <span className="tb-cap">插入到播放头</span>
          </Tip>
          <Tip tip="选一个补录的视频 / 音频文件，插入到橙色竖线处（新增，绿色；首尾空白自动去掉）">
            <button className="tb-btn" disabled={!!busy} onClick={() => pickFile('insert')}>
              <SquarePlus />
              <span className="tx">补录文件</span>
            </button>
          </Tip>
          <Tip tip="在橙色竖线处插入一段空白（静音），可以填多少毫秒（灰色）">
            <button className="tb-btn" disabled={!!busy} onClick={onSilence}>
              <VolumeX />
              <span className="tx">空白</span>
            </button>
          </Tip>
          <Tip tip="用电脑麦克风录一段，插入到橙色竖线处（新增，绿色）。要重录选中的一段，用选区上的「重录」">
            <button className="tb-btn accent" disabled={!!busy} onClick={() => onRecord('insert')}>
              <Mic />
              <span className="tx">现场录音</span>
            </button>
          </Tip>
        </div>
        {busy && (
          <span className="tb-busy">
            <Loader2 size={14} className="spin" />
            {busy.text}
          </span>
        )}

        <div className="spacer" />

        {/* 右：成片长度｜贴合字词｜缩放｜快捷键 */}
        <Tip tip="去掉删除的部分、加上补录和空白之后，最终视频的长度">
          <span className="out-len">
            <span className="tx">成片</span>
            <b className="mono">{fmtTime(outTotal)}</b>
          </span>
        </Tip>
        <i className="tb-sep" />
        <Tip tip="贴合字词：开启后，拖动选区边缘、删除区块的红线或翻页把手时，会自动贴到最近的字词开头 / 结尾，方便刚好剪在两个词之间。拖动时按住 Option 可临时关闭">
          <label className="snap-toggle">
            <Switch on={snap} onChange={(v) => useEditor.setState({ snap: v })} />
            <span className="tx">贴合字词</span>
          </label>
        </Tip>
        <i className="tb-sep" />
        <div className="zoom-box">
          <Tip tip="缩小时间轴，看到更长的范围" keys={['-']}>
            <button className="icon-btn sm" onClick={() => zoomTo(pps / 1.5)}>
              <Minus />
            </button>
          </Tip>
          <input
            type="range"
            min={logZoom(minPps)}
            max={logZoom(MAX_PPS)}
            step={0.01}
            value={logZoom(pps)}
            onChange={(e) => zoomTo(Math.exp(Number(e.target.value)))}
            aria-label="时间轴缩放"
          />
          <Tip tip="放大时间轴，看清每个字词" keys={['=']}>
            <button className="icon-btn sm" onClick={() => zoomTo(pps * 1.5)}>
              <Plus />
            </button>
          </Tip>
          <Tip tip="缩放到能看到全部音频">
            <button className="icon-btn sm" onClick={fit}>
              <Maximize2 />
            </button>
          </Tip>
        </div>
        <Tip tip="快捷键和颜色说明">
          <button ref={helpBtn} className={`icon-btn sm ${help ? 'active' : ''}`} onClick={() => setHelp(!help)}>
            <Keyboard />
          </button>
        </Tip>
        {help && <ShortcutHelp anchor={helpBtn.current} onClose={() => setHelp(false)} />}
      </div>

      <div className="tl-grid">
        <div className="tl-gutter">
          <div className="lane-label mini" style={{ height: MINI_H }}>
            全部
          </div>
          <div style={{ position: 'relative', height: H }}>
            {LANES.map((l) => (
              <Tip key={l.label} tip={l.tip} side="top">
                <div className="lane-label" style={{ top: l.y, height: l.h }}>
                  {l.label}
                </div>
              </Tip>
            ))}
          </div>
        </div>
        <div className="tl-main" ref={mainRef}>
          <canvas ref={miniRef} className="tl-minimap" style={{ height: MINI_H }} />
          <div className="tl-canvas-box">
            <canvas ref={cvRef} style={{ height: H }} />

            {sel && !dragging && !block && (
              <div className="tl-pop" style={{ left: selPopX, top: WAVE_Y - 44 }}>
                <span className="label mono">{(sel.b - sel.a).toFixed(2)}s</span>
                <Tip tip="只播放这一段" keys={['S']}>
                  <button onClick={() => st.playRange(sel.a, sel.b)}>
                    <Play />
                    试听
                  </button>
                </Tip>
                {selAllCut ? (
                  <Tip tip="把这段已删除的内容恢复回来">
                    <button className="hot" onClick={() => st.restoreSelection()}>
                      <RotateCcw />
                      恢复
                    </button>
                  </Tip>
                ) : (
                  <Tip tip="删掉这一段（变成红色区块）" keys={['Delete']}>
                    <button className="hot red" onClick={() => st.cutSelection()}>
                      <Scissors />
                      删除
                    </button>
                  </Tip>
                )}
                <Tip tip="选一个补录文件替换这一段（黄色）">
                  <button disabled={!!busy} onClick={() => pickFile('replace')}>
                    <ArrowLeftRight />
                    替换为补录
                  </button>
                </Tip>
                <Tip tip="用麦克风重新录这一段（黄色）">
                  <button onClick={() => onRecord('replace')}>
                    <Mic />
                    重录
                  </button>
                </Tip>
                <Tip tip="取消选区" keys={['Esc']}>
                  <button onClick={() => st.setSel(null)}>
                    <X />
                  </button>
                </Tip>
              </div>
            )}

            {block && toX(block.b) > 0 && toX(block.a) < width && (
              <BlockPop
                block={block}
                x={M.clamp(toX(M.clamp(pop.t, block.a, block.b)), 330, width - 330)}
                onPlay={(a, b) => st.playRange(Math.max(0, a), b)}
                onClose={() => setPop(null)}
              />
            )}
          </div>
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="video/*,audio/*,.mov,.m4a,.mp3,.wav,.aac"
        hidden
        onChange={(e) => st.importRecording(e.target.files?.[0], fileMode.current)}
      />
    </div>
  );
}

// 点剪辑标记两端的图标后出现的操作条（对应「修改记录」里的那一处）
// 结构：这是什么（类型 + 时长）｜ 开头 / 结尾各一个微调器（箭头 = 往哪边挪，中间是当前位置）｜ 试听前后、回撤
const STEP = 0.05;
function BlockPop({ block: b, x, onPlay, onClose }) {
  const st = useEditor.getState();
  const op = useEditor((s) => s.ops.find((o) => o.id === b.op));
  const m = MARK[b.type];
  if (!op) return null;
  const isCut = b.type === 'cut';
  const isSilence = b.type === 'silence';
  const len = isCut ? b.b - b.a : op.rec ? op.rec.out - op.rec.in : b.b - b.a;
  const title = isCut ? '删除' : b.type === 'replace' ? '替换 · 新录音' : isSilence ? '空白' : '新增';
  const revert = () => {
    st.toggleOp(b.op, false);
    onClose();
  };
  const stepper = (label, value, left, right, tipL, tipR) => (
    <div className="pop-step">
      <span className="k">{label}</span>
      <Tip tip={tipL}>
        <button className="arrow" onClick={left}>
          <ChevronLeft />
        </button>
      </Tip>
      <span className="v mono">{value}</span>
      <Tip tip={tipR}>
        <button className="arrow" onClick={right}>
          <ChevronRight />
        </button>
      </Tip>
    </div>
  );
  return (
    <div className="tl-pop block-pop" style={{ left: x, top: WAVE_Y + 26 }}>
      <div className="pop-id">
        <span className="pop-mark" style={{ background: m.line }}>
          {m.icon}
        </span>
        <span className="pop-title">{title}</span>
        <span className="pop-len mono">{len.toFixed(1)}s</span>
      </div>
      <i className="pop-sep" />
      {isCut ? (
        <>
          {stepper(
            '开头',
            fmtTime(b.a),
            () => st.moveCutEdge(b.op, 'start', -STEP, { at: b.a }),
            () => st.moveCutEdge(b.op, 'start', STEP, { at: b.a }),
            `开头往前挪 ${STEP} 秒（多删一点）`,
            `开头往后挪 ${STEP} 秒（少删一点）`,
          )}
          {stepper(
            '结尾',
            fmtTime(b.b),
            () => st.moveCutEdge(b.op, 'end', -STEP, { at: b.b }),
            () => st.moveCutEdge(b.op, 'end', STEP, { at: b.b }),
            `结尾往前挪 ${STEP} 秒（少删一点）`,
            `结尾往后挪 ${STEP} 秒（多删一点）`,
          )}
        </>
      ) : isSilence ? (
        <SilenceLength len={len} onChange={(sec) => st.setSilenceLength(b.op, sec)} />
      ) : (
        <>
          {stepper(
            '开头',
            `${op.rec.in.toFixed(2)}s`,
            () => st.trimRecording(b.op, 'start', -STEP),
            () => st.trimRecording(b.op, 'start', STEP),
            `新录音的开头多保留 ${STEP} 秒`,
            `新录音的开头多去掉 ${STEP} 秒`,
          )}
          {stepper(
            '结尾',
            `${op.rec.out.toFixed(2)}s`,
            () => st.trimRecording(b.op, 'end', -STEP),
            () => st.trimRecording(b.op, 'end', STEP),
            `新录音的结尾多去掉 ${STEP} 秒`,
            `新录音的结尾多保留 ${STEP} 秒`,
          )}
        </>
      )}
      <i className="pop-sep" />
      <Tip
        tip={
          isCut
            ? '从删除前 2 秒播到删除后 2 秒（跳过删掉的部分），听听接得顺不顺'
            : isSilence
              ? '从空白前 2 秒播到后 2 秒，听听停顿长短合不合适'
              : '从新录音前 2 秒播到后 2 秒，听听接得顺不顺'
        }
      >
        <button onClick={() => onPlay(b.a - 2, b.b + 2)}>
          <Play />
          试听前后
        </button>
      </Tip>
      <Tip
        tip={
          isCut
            ? '回撤这处删除，把内容恢复回来（在「修改记录 › 已回撤」里还能重新应用）'
            : b.type === 'replace'
              ? '回撤这处替换，恢复原来的录音（在「修改记录 › 已回撤」里还能重新应用）'
              : isSilence
                ? '回撤这处空白（在「修改记录 › 已回撤」里还能重新应用）'
                : '回撤这处新增（在「修改记录 › 已回撤」里还能重新应用）'
        }
      >
        <button className="hot" onClick={revert}>
          <RotateCcw />
          回撤
        </button>
      </Tip>
      <Tip tip="关闭" keys={['Esc']}>
        <button className="close" onClick={onClose}>
          <X />
        </button>
      </Tip>
    </div>
  );
}

// 空白的长度：‹ › 每次 50 毫秒，也可以直接输入毫秒数
function SilenceLength({ len, onChange }) {
  const ms = Math.round(len * 1000);
  const [text, setTextState] = useState(null);
  const textRef = useRef(null); // 回车和失焦都会提交，用 ref 保证只提交一次
  const setText = (v) => {
    textRef.current = v;
    setTextState(v);
  };
  const commit = () => {
    const v = textRef.current;
    if (v == null) return;
    setText(null);
    if (v === '' || Number(v) === ms) return;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 10 || n > 60000) return toast('请输入 10 到 60000 之间的毫秒数', 'error', 1800);
    onChange(n / 1000);
  };
  return (
    <div className="pop-step">
      <span className="k">时长</span>
      <Tip tip="缩短 50 毫秒">
        <button className="arrow" onClick={() => onChange(Math.max(0.01, len - 0.05))}>
          <ChevronLeft />
        </button>
      </Tip>
      <Tip tip="直接输入毫秒数，回车确定">
        <input
          className="v mono pop-input"
          type="number"
          value={text ?? ms}
          onFocus={(e) => {
            setText(String(ms));
            e.target.select();
          }}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              commit();
              e.currentTarget.blur();
            }
            if (e.key === 'Escape') {
              setText(null);
              e.currentTarget.blur();
            }
          }}
        />
      </Tip>
      <span className="k">ms</span>
      <Tip tip="加长 50 毫秒">
        <button className="arrow" onClick={() => onChange(len + 0.05)}>
          <ChevronRight />
        </button>
      </Tip>
    </div>
  );
}

const HELP = [
  {
    title: '播放',
    rows: [
      ['播放 / 暂停', ['空格']],
      ['后退 / 前进 1 秒', ['←', '/', '→']],
      ['一次跳 5 秒', '按住 ⇧ 再按 ← / →'],
      ['上一页 / 下一页', ['↑', '/', '↓']],
    ],
  },
  {
    title: '剪辑',
    rows: [
      ['试听选区', ['S']],
      ['删除选区（再按一次恢复）', ['Delete']],
      ['取消选区', ['Esc']],
      ['撤销', ['⌘', 'Z']],
      ['重做', ['⇧', '⌘', 'Z']],
      ['选中一个词', '双击这个词'],
    ],
  },
  {
    title: '翻页',
    rows: [
      ['当前页的开始时间设为播放头', ['[']],
      ['当前页的结束时间设为播放头', [']']],
    ],
  },
  {
    title: '时间轴',
    rows: [
      ['放大 / 缩小', ['=', '/', '-']],
      ['按鼠标位置缩放', '⌘ + 滚轮 / 双指捏合'],
      ['临时不贴合字词', '拖动时按住 ⌥'],
    ],
  },
];

function ShortcutHelp({ anchor, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  useEffect(() => {
    const r = anchor?.getBoundingClientRect();
    if (r) setPos({ right: Math.max(8, window.innerWidth - r.right), bottom: window.innerHeight - r.top + 10, maxHeight: r.top - 20 });
    const onDown = (e) => !ref.current?.contains(e.target) && !anchor?.contains(e.target) && onClose();
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [anchor, onClose]);
  if (!pos) return null;
  return createPortal(
    <div className="help-pop" ref={ref} style={pos}>
      <div className="help-title">
        <Keyboard size={16} />
        快捷键和颜色说明
      </div>
      <div className="help-legend">
        <span className="help-group-title">颜色</span>
        {[
          ['cut', '删除', '不播放，生成时跳过'],
          ['replace', '替换', '原录音换成新录音'],
          ['insert', '新增', '插入的补录'],
          ['silence', '空白', '插入的静音'],
        ].map(([k, name, desc]) => (
          <span key={k} className="lg-item">
            <i style={{ background: MARK[k].line }} />
            <b>{name}</b>
            {desc}
          </span>
        ))}
      </div>
      <div className="help-cols">
        {[
          [HELP[0], HELP[2]],
          [HELP[1], HELP[3]],
        ].map((col, ci) => (
          <div key={ci}>
            {col.map((g) => (
              <div className="help-group" key={g.title}>
                <div className="help-group-title">{g.title}</div>
                {g.rows.map(([label, keys]) => (
                  <div className="help-row" key={label}>
                    <span>{label}</span>
                    {Array.isArray(keys) ? <Keys keys={keys} /> : <span className="help-text">{keys}</span>}
                  </div>
                ))}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}
