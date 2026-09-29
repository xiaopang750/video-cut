import { create } from 'zustand';
import { api, urls, uploadRecording } from '../api.js';
import { toast } from '../appStore.js';
import { AudioEngine } from './audioEngine.js';
import * as M from './editModel.js';

// 时间约定：界面上的时间（播放头、选区、翻页点）都是「显示时间轴」上的秒数；
// 音频引擎只认成片时间，二者用 M.dtToOut / M.outToDT 互相换算。
//
// 剪辑状态 = 原始录音 + 修改记录 ops（按「处」记，只记和初始化时不一样的地方；
// 每条可单独回撤 / 重新应用，删除记录 = 回撤并去掉这条），edit（items + pages）由 M.replay 从 ops 推出来。
// ⌘Z 撤销的是「对修改记录的操作」（新增一处、调整、回撤、重新应用、删除记录），在内存里按步骤记。

const UNDO_MAX = 150;
const fmtClock = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${(t % 60).toFixed(1).padStart(4, '0')}`;
let engine = null;
let saveTimer = null;
let raf = 0;
let pausedDT = 0;
const frameSubs = new Set();

export const getEngine = () => engine;
export function onFrame(cb) {
  frameSubs.add(cb);
  return () => frameSubs.delete(cb);
}

// 每行文字在显示时间轴上的时间（用于"正在朗读"高亮）
let lineCache = { items: null, list: [] };
function lineRanges(st) {
  if (lineCache.items === st.edit.items) return lineCache.list;
  const list = [];
  for (const lt of st.lineTimes || []) {
    if (!lt || lt.block == null) continue;
    const a = M.sourceToDT(st.edit.items, 'main', lt.t0);
    const b = M.sourceToDT(st.edit.items, 'main', lt.t1);
    if (a == null || b == null) continue;
    list.push({ key: `${lt.seg}:${lt.block}:${lt.line}`, a, b });
  }
  list.sort((x, y) => x.a - y.a);
  lineCache = { items: st.edit.items, list };
  return list;
}

function clock() {
  raf = requestAnimationFrame(clock);
  if (!engine) return;
  const st = useEditor.getState();
  if (!st.edit) return;
  if (engine.playing && engine.position() >= engine.endPos - 0.0005) st.pause();
  const pos = st.position();
  const idx = M.pageIndexAt(st.edit.pages, pos);
  let reading = null;
  if (engine.playing) {
    for (const r of lineRanges(st)) {
      if (r.a > pos) break;
      if (pos <= r.b + 0.35) reading = r.key;
    }
  }
  if (idx !== st.current || reading !== st.reading) useEditor.setState({ current: idx, reading });
  for (const cb of frameSubs) cb(pos, engine.playing);
}

function scheduleSave() {
  useEditor.setState({ saveState: 'dirty' });
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => useEditor.getState().save(), 600);
}

const payload = (st) => ({
  version: 2,
  base: st.base,
  ops: st.ops,
  items: st.edit.items,
  pages: st.edit.pages,
  dismissed: st.edit.dismissed || [],
});


// 本地工具，挂到 window 上方便在控制台排查问题
const exposeForDebug = (store) => {
  window.__editor = store;
  window.__engine = () => engine;
  return store;
};

export const useEditor = exposeForDebug(
  create((set, get) => ({
    id: null,
    loaded: false,
    loadError: null,
    loadingText: '',
    project: null,
    segments: [],
    settings: null,
    sources: {},
    words: {},
    lineTimes: [],
    confidence: [],
    base: null,
    ops: [],
    edit: null,
    undoStack: [],
    redoStack: [],
    sel: null,
    pop: null, // 打开着的剪辑区块工具栏 { op, a, t }
    view: { pps: 80, start: 0 },
    playing: false,
    current: 0,
    reading: null,
    saveState: 'saved',
    snap: true,
    follow: true,
    busy: null,

    async load(id) {
      set({ id, loaded: false, loadError: null, loadingText: '读取项目' });
      try {
        const project = await api.project(id);
        if (!project.edit) throw new Error('这个项目还没有初始化，请先在列表页点「初始化」');
        const analysis = await api.analysis(id);
        engine?.dispose();
        engine = new AudioEngine();
        const ids = Object.keys(project.sources);
        for (let i = 0; i < ids.length; i++) {
          set({ loadingText: `加载音频 ${i + 1}/${ids.length}` });
          await engine.load(ids[i], urls.preview(id, ids[i]));
        }
        const words = {};
        for (const [sid, a] of Object.entries(analysis.sources)) words[sid] = { words: a.words || [], state: a.wordState || '' };

        const mainDur = project.sources.main.duration;
        let { base, ops } = project.edit;
        if (!base || !Array.isArray(ops)) {
          // 旧格式：先转成 items，再反推修改记录
          let { items, pages } = project.edit;
          if (!items?.length) {
            items = M.itemsFromClips(project.edit.clips, mainDur);
            pages = project.edit.pages.map((p, i) => ({ ...p, start: i === 0 ? 0 : M.outToDT(items, p.start) }));
          }
          const starts = analysis.pageStarts || [];
          base = {
            pages: pages.map((p) => {
              const segIndex = project.segments.findIndex((s) => s.id === p.seg);
              const t = starts[segIndex];
              return { seg: p.seg, anchor: Number.isFinite(t) ? { src: 'main', t } : M.dtToAnchor(items, p.start) };
            }),
          };
          ops = M.opsFromItems(items, pages, base, project.updatedAt || Date.now());
        }
        // 修改记录只记时间轴上的修改（文字 / 图片 / 设置是直接保存的）；
        // 旧版「删除记录但保留修改」留下的隐藏记录重新显示出来
        ops = M.pruneOps(
          base,
          ops.filter((o) => M.TIMELINE_OPS.has(o.type)).map(({ hidden, ...o }) => o),
          mainDur,
        );
        const derived = M.replay(base, ops, mainDur);
        pausedDT = 0;
        set({
          project,
          segments: project.segments,
          settings: project.settings,
          sources: project.sources,
          words,
          lineTimes: analysis.lineTimes,
          confidence: analysis.confidence,
          base,
          ops,
          edit: { ...derived, dismissed: project.edit.dismissed || [] },
          undoStack: [],
          redoStack: [],
          sel: null,
          pop: null,
          view: { pps: 80, start: 0 },
          playing: false,
          current: 0,
          saveState: 'saved',
          loaded: true,
        });
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(clock);
      } catch (e) {
        set({ loadError: e.message });
      }
    },

    unload() {
      get().flushSave();
      cancelAnimationFrame(raf);
      engine?.dispose();
      engine = null;
      set({ loaded: false, edit: null, project: null, playing: false });
    },

    // ---------- 修改记录 ----------
    derive(ops) {
      const st = get();
      return { ...M.replay(st.base, ops, st.sources.main.duration), dismissed: st.edit?.dismissed || [] };
    },
    // 所有对修改记录的改动都走这里：记一步撤销，重算当前状态，自动保存
    setOps(nextOps, { keepSel = false, before = null } = {}) {
      const st = get();
      if (engine?.playing) st.pause();
      set({
        ops: nextOps,
        edit: st.derive(nextOps),
        undoStack: [...st.undoStack.slice(-UNDO_MAX), before || st.ops],
        redoStack: [],
        sel: keepSel ? st.sel : null,
      });
      scheduleSave();
      return true;
    },
    // 拖动中的实时预览：不记撤销、不保存；松手时 setOps(最终, { before: 拖动前 })
    previewOps(nextOps) {
      set({ ops: nextOps, edit: get().derive(nextOps) });
    },
    previewEdit(edit) {
      set({ edit });
    },
    addOp(op, opts) {
      return get().setOps([...get().ops, { applied: true, time: Date.now(), ...op }], opts);
    },
    updateOp(id, patch, opts) {
      return get().setOps(
        get().ops.map((o) => (o.id === id ? { ...o, ...patch, mtime: Date.now() } : o)),
        opts,
      );
    },
    // 回撤 / 重新应用
    toggleOp(id, applied) {
      const ops = get().ops;
      const op = ops.find((o) => o.id === id);
      if (!op || op.applied === applied) return;
      if (applied && op.type === 'replace') {
        const err = M.replaceConflict(ops, op.range, op.id);
        if (err) return toast(`无法重新应用：${err}`, 'error', 4000);
      }
      let next;
      // 同一页的翻页记录只有一条；重新应用时把同一页别的记录去掉
      if (applied && op.type === 'page') next = [...ops.filter((o) => o.id !== id && !(o.type === 'page' && o.page === op.page)), { ...op, applied }];
      else next = ops.map((o) => (o.id === id ? { ...o, applied } : o));
      get().setOps(next, { keepSel: true });
      toast(applied ? '已重新应用这处修改' : '已回撤这处修改（在「已回撤」里可以重新应用）', 'success', 2000);
    },
    // 删除记录 = 回撤这处修改，并且不再保留这条记录（⌘Z 可以撤销）
    removeOp(id) {
      const op = get().ops.find((o) => o.id === id);
      if (!op) return;
      get().setOps(
        get().ops.filter((o) => o.id !== id),
        { keepSel: true },
      );
      toast(op.applied ? '已删除这条记录，这处修改也回撤了' : '已删除这条记录', 'success', 1800);
    },

    undo() {
      const st = get();
      if (!st.undoStack.length) return;
      if (engine?.playing) st.pause();
      const prev = st.undoStack[st.undoStack.length - 1];
      set({ ops: prev, edit: st.derive(prev), undoStack: st.undoStack.slice(0, -1), redoStack: [...st.redoStack, st.ops], sel: null });
      scheduleSave();
    },
    redo() {
      const st = get();
      if (!st.redoStack.length) return;
      if (engine?.playing) st.pause();
      const next = st.redoStack[st.redoStack.length - 1];
      set({ ops: next, edit: st.derive(next), redoStack: st.redoStack.slice(0, -1), undoStack: [...st.undoStack, st.ops], sel: null });
      scheduleSave();
    },

    async save() {
      const st = get();
      clearTimeout(saveTimer);
      saveTimer = null;
      if (!st.edit) return;
      set({ saveState: 'saving' });
      try {
        await api.saveEdit(st.id, payload(st));
        if (!saveTimer) set({ saveState: 'saved' });
      } catch (e) {
        set({ saveState: 'error' });
        toast(`保存失败：${e.message}`, 'error');
      }
    },
    flushSave() {
      const st = get();
      if (!saveTimer && st.saveState !== 'dirty') return;
      clearTimeout(saveTimer);
      saveTimer = null;
      if (st.edit) {
        const body = JSON.stringify(payload(st));
        fetch(`/api/projects/${st.id}/edit`, {
          method: 'PUT',
          keepalive: body.length < 60000,
          headers: { 'Content-Type': 'application/json' },
          body,
        }).catch(() => {});
      }
    },

    // ---------- 播放（时间都是显示时间）----------
    total() {
      return M.totalDT(get().edit.items);
    },
    totalOut() {
      return M.totalOut(get().edit.items);
    },
    clips() {
      return M.playedClips(get().edit.items);
    },
    position() {
      if (engine?.playing) return M.outToDT(get().edit.items, engine.position());
      return pausedDT;
    },
    play(from) {
      if (!engine) return;
      const items = get().edit.items;
      let dt = from ?? get().position();
      if (M.dtToOut(items, dt) >= M.totalOut(items) - 0.05) dt = 0;
      if (engine.play(get().clips(), M.dtToOut(items, dt))) set({ playing: true, follow: true });
    },
    playRange(a, b) {
      const items = get().edit.items;
      if (engine?.play(get().clips(), M.dtToOut(items, a), M.dtToOut(items, b))) set({ playing: true, follow: true });
    },
    pause() {
      if (!engine) return;
      const wasPlaying = engine.playing;
      const o = engine.position();
      engine.pause();
      if (wasPlaying) pausedDT = M.outToDT(get().edit.items, o);
      set({ playing: false });
    },
    toggle() {
      get().playing ? get().pause() : get().play();
    },
    seek(t) {
      if (!engine) return;
      const items = get().edit.items;
      const dt = M.clamp(t, 0, M.totalDT(items));
      pausedDT = dt;
      if (engine.playing) engine.play(get().clips(), M.dtToOut(items, dt));
      else engine.seek(M.dtToOut(items, dt));
    },
    jumpPage(delta) {
      const { edit } = get();
      const pos = get().position();
      const idx = M.pageIndexAt(edit.pages, pos);
      const target = M.clamp(delta < 0 && pos - edit.pages[idx].start > 0.6 ? idx : idx + delta, 0, edit.pages.length - 1);
      get().seek(edit.pages[target].start);
      get().reveal(edit.pages[target].start);
    },
    // 让时间点出现在可视范围内
    reveal(t) {
      const { view, tlWidth } = get();
      const span = tlWidth / view.pps;
      if (t < view.start || t > view.start + span * 0.9) set({ view: { ...view, start: Math.max(0, t - span * 0.2) } });
    },
    tlWidth: 1000,
    minPps() {
      return Math.max(0.5, (get().tlWidth - 40) / Math.max(1, get().total()));
    },
    // 缩放：播放头在视野内时以播放头为锚点
    zoomTo(np) {
      const st = get();
      const width = st.tlWidth;
      const total = st.total();
      np = M.clamp(np, st.minPps(), 1200);
      const pos = st.position();
      const { pps, start } = st.view;
      const anchor = pos >= start && pos <= start + width / pps ? pos : start + width / pps / 2;
      const ax = (anchor - start) * pps;
      const span = width / np;
      set({ view: { pps: np, start: M.clamp(anchor - ax / np, 0, Math.max(0, total - span * 0.85)) } });
    },

    setSel(sel) {
      set({ sel: sel && sel.b - sel.a > 0.005 ? sel : null });
    },
    setView(view) {
      set({ view });
    },

    // ---------- 剪辑动作（按「处」记录：新的一处生成一条记录，扩大 / 缩小 / 微调都改同一条）----------
    // 删除：内容仍显示为红色区块，播放和生成时跳过；和挨着的删除合并成一处
    cutSelection() {
      const { sel, edit, ops, base, sources } = get();
      if (!sel) return;
      if (M.isAllCut(edit.items, sel.a, sel.b)) return get().restoreSelection();
      const parts = M.dtRangeToSource(edit.items, sel.a, sel.b, true);
      if (!parts.length) return;
      const now = Date.now();
      let next = ops;
      const cut = [];
      const notes = [];
      for (const p of parts) {
        const op = next.find((o) => o.applied && o.rec?.src === p.src);
        if (!op) {
          cut.push(p);
          continue;
        }
        // 补录只能从两头删（相当于微调首尾，还是同一处）；整段都删 = 这一处不要补录了
        const { in: i0, out: o0 } = op.rec;
        const upd = (patch) => (next = next.map((o) => (o === op ? { ...o, ...patch, mtime: now } : o)));
        if (p.a <= i0 + 0.05 && p.b >= o0 - 0.05) {
          if (op.type === 'replace') {
            // 替换整段删掉：这一处变成「删除」原来那段录音
            const { rec, range, ...rest } = op;
            const asCut = { ...rest, type: 'cut', ranges: [{ src: 'main', a: range.a, b: range.b }], mtime: now };
            next = next.map((o) => (o === op ? asCut : o));
            notes.push('这一处替换改成了删除');
          } else {
            next = next.map((o) => (o === op ? { ...o, applied: false } : o));
            notes.push('已回撤这处新增');
          }
        } else if (p.a <= i0 + 0.05) {
          upd({ rec: { ...op.rec, in: p.b } });
          notes.push('剪掉了新录音的开头');
        } else if (p.b >= o0 - 0.05) {
          upd({ rec: { ...op.rec, out: p.a } });
          notes.push('剪掉了新录音的结尾');
        } else {
          return toast('新录音中间的内容不能单独删：可以从两头删（或微调首尾），也可以回撤后重新录', 'error', 4200);
        }
      }
      const newId = M.newId('op');
      if (cut.length) next = [...next, { id: newId, type: 'cut', ranges: M.unionRanges(cut), applied: true, time: now }];
      next = M.mergeTouchingCuts(base, next, sources.main.duration);
      const after = get().derive(next);
      if (M.totalOut(after.items) < 0.05) return toast('不能把音频全部删掉', 'error');
      get().setOps(next);
      const removed = M.totalOut(edit.items) - M.totalOut(after.items);
      if (cut.length && !next.some((o) => o.id === newId)) notes.unshift(`已删除 ${removed.toFixed(2)} 秒，和挨着的删除合并成一处`);
      else if (cut.length) notes.unshift(`已删除 ${removed.toFixed(2)} 秒（红色区块；「修改记录」里可以回撤）`);
      toast(notes.join('；'), 'success', 2800);
    },
    // 选区都在删除区块里：把选中的部分恢复（整处恢复 = 回撤；从中间恢复一段 = 分成前后两处）
    restoreSelection() {
      const { sel, edit, ops } = get();
      if (!sel) return;
      const sub = M.dtRangeToSource(edit.items, sel.a, sel.b, false);
      const now = Date.now();
      let changed = false;
      const next = [];
      for (const op of ops) {
        if (op.type !== 'cut' || !op.applied) {
          next.push(op);
          continue;
        }
        const remaining = M.subtractRanges(op.ranges, sub);
        if (Math.abs(M.sumRanges(remaining) - M.sumRanges(op.ranges)) < 0.002) {
          next.push(op);
          continue;
        }
        changed = true;
        if (!remaining.length) {
          next.push({ ...op, applied: false });
          continue;
        }
        remaining.forEach((r, i) => next.push({ ...op, ...(i ? { id: M.newId('op') } : {}), ranges: [r], mtime: now }));
      }
      if (changed) {
        get().setOps(next);
        toast('已恢复选中的部分', 'success', 1500);
      }
    },
    // 拖动 / 微调删除区块的边（at：拖的那条边在时间轴上的位置，用来确定是哪一段）
    moveCutEdge(opId, edge, delta, { preview = false, from = null, at = null } = {}) {
      const ops = from || get().ops;
      const op = ops.find((o) => o.id === opId);
      if (!op || !op.ranges?.length) return;
      const items = from ? get().derive(from).items : get().edit.items;
      let pick = 0;
      let best = Infinity;
      op.ranges.forEach((r, i) => {
        const segs = M.sourceRangeToDT(items, r.src, r.a, r.b);
        if (!segs.length) return;
        const v = edge === 'start' ? segs[0][0] : segs[segs.length - 1][1];
        const score = at != null ? Math.abs(v - at) : edge === 'start' ? v : -v;
        if (score < best) (best = score), (pick = i);
      });
      const durs = Object.fromEntries(Object.values(get().sources).map((s) => [s.id, s.duration]));
      const ranges = op.ranges.map((r, i) => {
        if (i !== pick) return r;
        if (edge === 'start') return { ...r, a: M.clamp(r.a + delta, 0, r.b - 0.02) };
        return { ...r, b: M.clamp(r.b + delta, r.a + 0.02, durs[r.src] ?? r.b + delta) };
      });
      let next = ops.map((o) => (o.id === opId ? { ...o, ranges, mtime: Date.now() } : o));
      if (preview) return get().previewOps(next);
      // 拖到和别的删除挨上了：合并成一处
      next = M.mergeTouchingCuts(get().base, next, get().sources.main.duration);
      get().setOps(next, { before: from || undefined });
    },
    // 微调补录的开头 / 结尾
    trimRecording(opId, side, delta) {
      const op = get().ops.find((o) => o.id === opId);
      if (!op?.rec) return;
      const dur = get().sources[op.rec.src]?.duration ?? op.rec.out;
      const rec =
        side === 'start'
          ? { ...op.rec, in: M.clamp(op.rec.in + delta, 0, op.rec.out - 0.05) }
          : { ...op.rec, out: M.clamp(op.rec.out + delta, op.rec.in + 0.05, dur) };
      get().updateOp(opId, { rec }, { keepSel: true });
    },

    // 录音要放的位置：新增 = 播放头处（记成原始录音上的锚点）；替换 = 选区对应的原始录音范围
    planRecording(mode) {
      const { sel, edit, ops } = get();
      if (mode === 'replace') {
        if (!sel) return { error: '先选出要替换的一段' };
        const range = M.replaceRange(edit.items, sel.a, sel.b);
        const err = range.error || M.replaceConflict(ops, range);
        return err ? { error: err } : { mode, range, a: sel.a, b: sel.b };
      }
      const pos = get().position();
      return { mode: 'insert', at: M.insertAnchor(edit.items, pos), pos };
    },
    recordingOp(source, plan, id = M.newId('g')) {
      const rec = { src: source.id, in: source.suggestedIn, out: source.suggestedOut };
      return plan.mode === 'replace' ? { id, type: 'replace', rec, range: plan.range } : { id, type: 'insert', rec, at: plan.at };
    },
    // 上传一段录音、识别、加载好（还没放到时间轴上）
    async uploadRec(file, onProgress) {
      const { id } = get();
      const res = await uploadRecording(id, file, onProgress);
      await engine.load(res.source.id, urls.preview(id, res.source.id));
      set((s) => ({
        sources: { ...s.sources, [res.source.id]: res.source },
        words: { ...s.words, [res.source.id]: { words: res.transcript.words, state: res.transcript.wordState } },
      }));
      return res.source;
    },
    // 放到时间轴上（生成一条新增 / 替换记录），并打开这段录音的工具栏
    placeRecording(source, plan) {
      const op = get().recordingOp(source, plan);
      get().addOp(op);
      const ext = M.opExtent(op, get().edit.items);
      if (ext) {
        get().seek(ext[0]);
        get().reveal(ext[0]);
        set({ pop: { op: op.id, a: ext[0], t: (ext[0] + ext[1]) / 2 } });
      }
      const L = (op.rec.out - op.rec.in).toFixed(1);
      toast(`${plan.mode === 'replace' ? '已替换（黄色）' : '已新增（绿色）'}：新录音 ${L} 秒，首尾空白已自动去掉`, 'success', 3200);
      return op.id;
    },
    // 录了没用上的：从服务器和内存里删掉
    async discardRecording(srcId) {
      if (!srcId) return;
      engine?.buffers.delete(srcId);
      engine?.peaks.delete(srcId);
      set((s) => {
        const sources = { ...s.sources };
        const words = { ...s.words };
        delete sources[srcId];
        delete words[srcId];
        return { sources, words };
      });
      await api.removeSource(get().id, srcId).catch(() => {});
    },
    // ---------- 修改记录导入（替换当前的记录，⌘Z 可以撤销）----------
    async applyImportedRecords({ ops, sources, words }) {
      const st = get();
      for (const sid of Object.keys(sources || {})) {
        if (!engine.buffers.has(sid)) await engine.load(sid, urls.preview(st.id, sid));
      }
      set((s) => ({ sources: { ...s.sources, ...sources }, words: { ...s.words, ...(words || {}) } }));
      const next = M.pruneOps(get().base, ops, get().sources.main.duration);
      get().setOps(next);
      await get().save();
      return next;
    },

    // ---------- 插入空白（位置规则和插入补录一样：橙色竖线处）----------
    async ensureSilence() {
      const st = get();
      let source = st.sources[M.SILENCE];
      if (!source) {
        source = (await api.silence(st.id)).source;
        set((s) => ({ sources: { ...s.sources, [M.SILENCE]: source } }));
      }
      if (!engine.buffers.has(M.SILENCE)) await engine.load(M.SILENCE, urls.preview(st.id, M.SILENCE));
      return source;
    },
    async insertSilence(ms) {
      const plan = get().planRecording('insert');
      if (engine?.playing) get().pause();
      try {
        const source = await get().ensureSilence();
        const len = M.clamp(ms / 1000, 0.01, source.duration);
        const op = { id: M.newId('g'), type: 'insert', rec: { src: M.SILENCE, in: 0, out: len }, at: plan.at };
        get().addOp(op);
        const ext = M.opExtent(op, get().edit.items);
        if (ext) {
          get().seek(ext[0]);
          get().reveal(ext[0]);
          set({ pop: { op: op.id, a: ext[0], t: (ext[0] + ext[1]) / 2 } });
        }
        toast(`已在 ${fmtClock(plan.pos)} 插入 ${Math.round(len * 1000)} 毫秒空白`, 'success', 2400);
        return true;
      } catch (e) {
        toast(e.message, 'error', 4000);
        return false;
      }
    },
    // 改空白的长度（秒）
    setSilenceLength(opId, sec) {
      const op = get().ops.find((o) => o.id === opId);
      if (!op?.rec) return;
      const max = get().sources[M.SILENCE]?.duration ?? 60;
      const len = M.clamp(sec, 0.01, max);
      if (Math.abs(op.rec.out - op.rec.in - len) < 1e-4) return;
      get().updateOp(opId, { rec: { ...op.rec, out: op.rec.in + len } }, { keepSel: true });
    },

    // 选文件补录：上传完直接放到时间轴上
    async importRecording(file, mode) {
      if (!file) return;
      const plan = get().planRecording(mode);
      if (plan.error) return toast(plan.error, 'error', 4000);
      if (engine?.playing) get().pause();
      set({ busy: { text: '上传录音 0%', progress: 0 } });
      try {
        const source = await get().uploadRec(file, (p) =>
          set({ busy: p < 1 ? { text: `上传录音 ${Math.round(p * 100)}%`, progress: p * 0.6 } : { text: '识别新录音…', progress: 0.7 } }),
        );
        get().placeRecording(source, plan);
      } catch (e) {
        toast(e.message, 'error', 5000);
      } finally {
        set({ busy: null });
      }
    },

    // ---------- 翻页 ----------
    // 每页只有一条翻页记录；调回初始化时的位置就不算修改，记录去掉
    setPageStart(idx, t) {
      const st = get();
      // 和已保存的状态比较（拖动时 edit 里是预览）
      const edit = st.derive(st.ops);
      if (idx <= 0 || idx >= edit.pages.length) return false;
      const s = M.clampPageStart(edit.pages, M.totalDT(edit.items), idx, t);
      if (Math.abs(s - edit.pages[idx].start) < 1e-3) {
        set({ edit });
        return false;
      }
      const others = st.ops.filter((o) => !(o.type === 'page' && o.page === idx));
      const initial = M.anchorToDT(edit.items, st.base.pages[idx].anchor);
      if (Math.abs(s - initial) < 0.002) return st.setOps(others, { keepSel: true });
      const rec = st.ops.findLast((o) => o.type === 'page' && o.page === idx);
      const to = M.dtToAnchor(edit.items, s);
      const now = Date.now();
      const op = rec ? { ...rec, to, applied: true, mtime: now } : { id: M.newId('op'), type: 'page', page: idx, to, applied: true, time: now };
      return st.setOps([...others, op], { keepSel: true });
    },
    // 第 idx 页的结束 = 下一页的开始
    setPageEnd(idx, t) {
      return get().setPageStart(idx + 1, t);
    },
    nudgePage(idx, edge, delta) {
      const { pages } = get().edit;
      const k = edge === 'start' ? idx : idx + 1;
      if (k <= 0 || k >= pages.length) return;
      if (!get().setPageStart(k, pages[k].start + delta)) toast('已经贴到相邻页了，不能再移动', 'info', 1600);
    },
    // 恢复这一页初始化时推荐的开始 / 结束时间
    restorePage(idx) {
      const st = get();
      const next = st.ops.filter((o) => !(o.type === 'page' && (o.page === idx || o.page === idx + 1)));
      if (next.length === st.ops.length) return;
      st.setOps(next, { keepSel: true });
      toast(`P${idx + 1} 已恢复成初始化时的开始 / 结束时间`, 'success', 1800);
    },
    // 快捷键 [ / ]：当前页的开始 / 结束设为播放头位置
    pageEdgeHere(edge) {
      const { edit } = get();
      const pos = get().position();
      const idx = M.pageIndexAt(edit.pages, pos);
      const k = edge === 'start' ? idx : idx + 1;
      if (k <= 0) return toast('第一页固定从 0 秒开始', 'info', 1600);
      if (k >= edit.pages.length) return toast('最后一页固定到音频结尾', 'info', 1600);
      if (get().setPageStart(k, pos)) toast(`P${idx + 1} 的${edge === 'start' ? '开始' : '结束'}时间设为 ${fmtClock(pos)}`, 'success', 1400);
    },
    // 预览视频等后台任务完成后，刷新音源信息
    async reloadSources() {
      const p = await api.project(get().id);
      set({ sources: p.sources, project: { ...get().project, sources: p.sources } });
    },

    // ---------- 文字 / 图片 / 设置（直接保存）----------
    async saveSegment(segId, patch) {
      const seg = await api.saveSegment(get().id, segId, patch);
      set((s) => ({ segments: s.segments.map((x) => (x.id === segId ? seg : x)) }));
      return seg;
    },
    async saveSettings(settings, asDefault) {
      const r = await api.saveSettings(get().id, settings, asDefault);
      set({ settings: r.settings });
      return r.settings;
    },
  })),
);
