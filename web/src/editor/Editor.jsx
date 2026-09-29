import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  AudioLines,
  Check,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  CloudUpload,
  Columns2,
  Film,
  Image as ImageIcon,
  Loader2,
  Pause,
  Play,
  Settings2,
  X,
  ZoomIn,
} from 'lucide-react';
import { api, hashOf, urls } from '../api.js';
import { fmtTime, navigate, toast, useApp } from '../appStore.js';
import { Loading, Seg, Tip } from '../components/ui.jsx';
import * as M from './editModel.js';
import { onFrame, useEditor } from './store.js';
import Timeline from './Timeline.jsx';
import SidePanel from './SidePanel.jsx';
import { PageEditDialog, RecordDialog, RenderDialog, SettingsDialog, SilenceDialog } from './dialogs.jsx';

const PAGE_RATIO = 3 / 4; // 合成画面固定 3:4（750×1000）

export default function Editor({ id }) {
  const loaded = useEditor((s) => s.loaded && s.id === id);
  const loadError = useEditor((s) => s.loadError);
  const loadingText = useEditor((s) => s.loadingText);

  useEffect(() => {
    useEditor.getState().load(id);
    const flush = () => useEditor.getState().flushSave();
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      useEditor.getState().unload();
    };
  }, [id]);

  if (loadError) {
    return (
      <div className="loading-screen">
        <div style={{ textAlign: 'center' }}>
          <AlertCircle size={40} color="var(--danger)" />
          <p>{loadError}</p>
          <button className="btn btn-primary" onClick={() => navigate('/')}>
            <ArrowLeft />
            返回列表
          </button>
        </div>
      </div>
    );
  }
  if (!loaded) return <Loading text={loadingText || '加载中'} />;
  return <EditorBody />;
}

const VIEW_KEY = 'video-cut:stage-view';
function readView() {
  try {
    return localStorage.getItem(VIEW_KEY) || 'both';
  } catch {
    return 'both';
  }
}

function EditorBody() {
  const [dialog, setDialog] = useState(null);
  const [view, setView] = useState(readView);
  const [zoom, setZoom] = useState(false);
  const changeView = (v) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {}
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      if (document.querySelector('.modal-mask, .zoom-mask')) return;
      const st = useEditor.getState();
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key;
      if (e.code === 'Space') {
        e.preventDefault();
        // 避免空格同时"点击"刚才聚焦的按钮
        if (document.activeElement?.tagName === 'BUTTON') document.activeElement.blur();
        st.toggle();
      } else if ((k === 'Backspace' || k === 'Delete') && st.sel) {
        e.preventDefault();
        st.cutSelection();
      } else if (mod && k.toLowerCase() === 'z') {
        e.preventDefault();
        e.shiftKey ? st.redo() : st.undo();
      } else if (mod && k.toLowerCase() === 'y') {
        e.preventDefault();
        st.redo();
      } else if (mod) {
        return;
      } else if (k === 'Escape') {
        if (st.pop) useEditor.setState({ pop: null });
        else st.setSel(null);
      }
      else if (k === 'ArrowLeft' || k === 'ArrowRight') {
        e.preventDefault();
        const t = st.position() + (k === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 5 : 1);
        st.seek(t);
        st.reveal(M.clamp(t, 0, st.total()));
      } else if (k === 'ArrowUp' || k === 'ArrowDown') {
        e.preventDefault();
        st.jumpPage(k === 'ArrowUp' ? -1 : 1);
      } else if (k === '[') st.pageEdgeHere('start');
      else if (k === ']') st.pageEdgeHere('end');
      else if (k === '=' || k === '+') st.zoomTo(st.view.pps * 1.5);
      else if (k === '-' || k === '_') st.zoomTo(st.view.pps / 1.5);
      else if (k.toLowerCase() === 's' && st.sel) st.playRange(st.sel.a, st.sel.b);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="editor">
      <TopBar
        view={view}
        onView={changeView}
        onSettings={() => setDialog({ kind: 'settings' })}
        onRender={() => setDialog({ kind: 'render' })}
      />
      <div className="editor-main">
        <Stage view={view} onZoom={() => setZoom(true)} />
        <SidePanel onEditPage={(index) => setDialog({ kind: 'page', index })} />
      </div>
      <Timeline onRecord={(mode) => setDialog({ kind: 'record', mode })} onSilence={() => setDialog({ kind: 'silence' })} />

      {zoom && <PageZoom onClose={() => setZoom(false)} />}
      {dialog?.kind === 'page' && <PageEditDialog index={dialog.index} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'settings' && <SettingsDialog onClose={() => setDialog(null)} initialTab={dialog.tab} />}
      {dialog?.kind === 'render' && (
        <RenderDialog onClose={() => setDialog(null)} onOpenSettings={() => setDialog({ kind: 'settings', tab: 'output' })} />
      )}
      {dialog?.kind === 'record' && <RecordDialog mode={dialog.mode} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'silence' && <SilenceDialog onClose={() => setDialog(null)} />}
    </div>
  );
}

// 顶栏：返回 / 标题 / 保存状态 | 播放控制 | 画面切换 / 设置 / 生成
function TopBar({ view, onView, onSettings, onRender }) {
  const project = useEditor((s) => s.project);
  const saveState = useEditor((s) => s.saveState);
  const playing = useEditor((s) => s.playing);
  const a = project.analysis;
  const lang = { en: '英文', zh: '中文' }[a?.language] || a?.language;
  return (
    <header className="topbar">
      <Tip tip="返回绘本列表（修改已自动保存）" side="bottom">
        <button
          className="icon-btn"
          onClick={() => {
            useEditor.getState().flushSave();
            navigate('/');
          }}
        >
          <ArrowLeft />
        </button>
      </Tip>
      <div className="topbar-title">
        <h2>{project.name}</h2>
        {a && (
          <div className="muted" style={{ fontSize: 12 }}>
            {lang} · {a.words} 个词 · 自动对齐 {Math.round((a.confidence || 0) * 100)}%
          </div>
        )}
      </div>
      <span className="save-state">
        {saveState === 'saving' || saveState === 'dirty' ? (
          <>
            <CloudUpload />
            保存中…
          </>
        ) : saveState === 'error' ? (
          <span style={{ color: 'var(--danger)' }}>保存失败</span>
        ) : (
          <>
            <Check />
            已自动保存
          </>
        )}
      </span>
      <div className="spacer" />
      <div className="transport">
        <Tip tip="上一页" keys={['↑']} side="bottom">
          <button className="icon-btn" onClick={() => useEditor.getState().jumpPage(-1)}>
            <ChevronLeft />
          </button>
        </Tip>
        <Tip tip={playing ? '暂停' : '播放'} keys={['空格']} side="bottom">
          <button className="play-btn" onClick={() => useEditor.getState().toggle()}>
            {playing ? <Pause /> : <Play style={{ marginLeft: 2 }} />}
          </button>
        </Tip>
        <Tip tip="下一页" keys={['↓']} side="bottom">
          <button className="icon-btn" onClick={() => useEditor.getState().jumpPage(1)}>
            <ChevronRight />
          </button>
        </Tip>
        <TimeDisplay />
      </div>
      <div className="spacer" />
      <Seg
        value={view}
        onChange={onView}
        options={[
          { value: 'both', label: '对照', icon: <Columns2 />, tip: '左边原始视频、右边合成画面，同步播放' },
          { value: 'video', label: '原始视频', icon: <Film />, tip: '只看录制的原始视频（多段已按顺序合并）' },
          { value: 'page', label: '合成画面', icon: <ImageIcon />, tip: '只看合成画面，图最大' },
        ]}
      />
      <Tip tip="字体字号、水印、翻页效果等" side="bottom">
        <button className="btn btn-ghost" onClick={onSettings}>
          <Settings2 />
          画面设置
        </button>
      </Tip>
      <Tip tip="剪辑和翻页都调好了？生成最终视频" side="bottom">
        <button className="btn btn-accent" onClick={onRender}>
          <Clapperboard />
          确认生成
        </button>
      </Tip>
    </header>
  );
}

// 舞台：按可用空间算出两个画面的精确尺寸（合成画面严格 3:4，视频按原比例），图尽量大
function Stage({ view, onZoom }) {
  const ref = useRef(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const mainVideo = useEditor((s) => s.sources.main?.video);
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  const vr = mainVideo?.width && mainVideo?.height ? mainVideo.width / mainVideo.height : 9 / 16;
  const gap = 18;
  let h;
  if (view === 'both') h = Math.min(box.h, (box.w - gap) / (vr + PAGE_RATIO));
  else if (view === 'video') h = Math.min(box.h, box.w / vr);
  else h = Math.min(box.h, box.w / PAGE_RATIO);
  h = Math.max(0, Math.floor(h));
  return (
    <section className="stage" ref={ref} style={{ gap }}>
      {h > 0 && view !== 'page' && <VideoPane width={Math.floor(h * vr)} height={h} />}
      {h > 0 && view !== 'video' && <PagePane width={Math.floor(h * PAGE_RATIO)} height={h} onZoom={onZoom} />}
    </section>
  );
}

function usePageImages() {
  const id = useEditor((s) => s.id);
  const pages = useEditor((s) => s.edit.pages);
  const segments = useEditor((s) => s.segments);
  const settings = useEditor((s) => s.settings);
  return useMemo(() => {
    const look = [settings.layout, settings.text, settings.watermark];
    return pages.map((pg) => {
      const seg = segments.find((s) => s.id === pg.seg);
      return { seg: pg.seg, src: urls.page(id, pg.seg, 750, hashOf([seg?.blocks, seg?.image, look])) };
    });
  }, [id, pages.length, segments, settings]);
}

function PagePane({ width, height, onZoom }) {
  const pages = useEditor((s) => s.edit.pages);
  const current = useEditor((s) => s.current);
  const imgs = usePageImages();
  return (
    <div className="page-box" style={{ width, height }} onClick={onZoom}>
        {/* 每页一张合成图，全部叠放、只显示当前页 —— 切页时自然交叉淡化，也顺便预加载 */}
        {imgs.map((im, i) => (
          <img key={im.seg} src={im.src} alt="" style={{ opacity: i === current ? 1 : 0 }} loading={Math.abs(i - current) > 3 ? 'lazy' : 'eager'} />
        ))}
        <span className="pane-tag">
          合成画面 · 第 {current + 1} / {pages.length} 页
        </span>
      <span className="zoom-hint">
        <ZoomIn size={15} />
        点击看大图
      </span>
    </div>
  );
}

// 大图：跟着播放翻页，←/→ 翻页，空格播放，Esc 关闭
function PageZoom({ onClose }) {
  const pages = useEditor((s) => s.edit.pages);
  const current = useEditor((s) => s.current);
  const playing = useEditor((s) => s.playing);
  const imgs = usePageImages();
  useEffect(() => {
    const onKey = (e) => {
      const st = useEditor.getState();
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') st.jumpPage(-1);
      else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') st.jumpPage(1);
      else if (e.code === 'Space') st.toggle();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="zoom-mask" onClick={onClose}>
      <div className="zoom-frame" onClick={(e) => e.stopPropagation()}>
        {imgs.map((im, i) => (
          <img key={im.seg} src={im.src} alt="" style={{ opacity: i === current ? 1 : 0 }} />
        ))}
      </div>
      <div className="zoom-bar" onClick={(e) => e.stopPropagation()}>
        <Tip tip="上一页" keys={['←']}>
          <button className="icon-btn" onClick={() => useEditor.getState().jumpPage(-1)}>
            <ChevronLeft />
          </button>
        </Tip>
        <Tip tip={playing ? '暂停' : '播放'} keys={['空格']}>
          <button className="play-btn" onClick={() => useEditor.getState().toggle()}>
            {playing ? <Pause /> : <Play style={{ marginLeft: 2 }} />}
          </button>
        </Tip>
        <Tip tip="下一页" keys={['→']}>
          <button className="icon-btn" onClick={() => useEditor.getState().jumpPage(1)}>
            <ChevronRight />
          </button>
        </Tip>
        <span className="zoom-page">
          第 {current + 1} / {pages.length} 页
        </span>
        <TimeDisplay />
        <Tip tip="关闭大图" keys={['Esc']}>
          <button className="icon-btn" onClick={onClose}>
            <X />
          </button>
        </Tip>
      </div>
    </div>
  );
}

function findSpan(list, t) {
  let lo = 0;
  let hi = list.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].start <= t + 1e-6) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

// 原始视频：按剪辑后的时间轴同步（视频静音，声音统一由 Web Audio 播放）
function VideoPane({ width, height }) {
  const id = useEditor((s) => s.id);
  const mainVideo = useEditor((s) => s.sources.main?.video);
  const job = useApp((s) => s.jobs[id]);
  const proxyJob = job?.type === 'proxy' ? job : null;
  const proxyRunning = proxyJob && (proxyJob.status === 'queued' || proxyJob.status === 'running');
  const ref = useRef(null);
  const [info, setInfo] = useState({ kind: 'loading' });
  const requested = useRef(false);

  // 老项目没有预览视频时，自动在后台生成
  useEffect(() => {
    if (mainVideo || proxyRunning || requested.current) return;
    requested.current = true;
    api.proxy(id).catch((e) => toast(e.message, 'error'));
  }, [mainVideo, proxyRunning, id]);
  useEffect(() => {
    if (proxyJob?.status === 'done') useEditor.getState().reloadSources();
  }, [proxyJob?.status]);

  useEffect(() => {
    let lastKey = '';
    let srcUrl = null;
    return onFrame((pos, playing) => {
      const v = ref.current;
      if (!v) return;
      const st = useEditor.getState();
      const loc = M.dtToSource(st.edit.items, pos);
      if (!loc) return;
      const source = st.sources[loc.src];
      const vid = source?.video;
      const frags = st.sources.main?.fragments || [];
      const fragIndex = loc.src === 'main' && frags.length ? findSpan(frags, loc.time) : -1;
      // 这一段本来就是音频文件（没有画面）
      const noPicture = loc.src === 'main' && st.project?.media?.videos?.[fragIndex]?.hasVideo === false;
      const kind = noPicture ? 'audio' : vid ? 'video' : loc.src === 'main' ? 'pending' : 'audio';
      const key = `${kind}|${loc.src}|${fragIndex}`;
      if (key !== lastKey) {
        lastKey = key;
        setInfo({ kind, src: loc.src, fragIndex, frag: frags[fragIndex], fragCount: frags.length, name: source?.name, vid });
      }
      if (!vid || noPicture) {
        if (!v.paused) v.pause();
        return;
      }
      const url = urls.video(st.id, loc.src, vid.v);
      if (srcUrl !== url) {
        srcUrl = url;
        v.src = url;
      }
      if (v.readyState < 1) return;
      const seg = vid.segs[findSpan(vid.segs, loc.time)];
      const vt = seg.vstart + (loc.time - seg.start);
      if (playing) {
        const diff = v.currentTime - vt;
        if (v.paused) {
          v.currentTime = vt;
          v.play().catch(() => {});
        } else if (Math.abs(diff) > 0.3) v.currentTime = vt; // 跨过删除区块时直接跳
        else v.playbackRate = Math.abs(diff) > 0.04 ? (diff > 0 ? 0.94 : 1.06) : 1; // 小偏差慢慢追
      } else {
        if (!v.paused) v.pause();
        v.playbackRate = 1;
        if (!v.seeking && Math.abs(v.currentTime - vt) > 0.02) v.currentTime = vt;
      }
    });
  }, []);

  const label =
    info.src === M.SILENCE
      ? '插入的空白'
      : info.src && info.src !== 'main'
        ? `补录 · ${info.name || ''}`
      : info.fragIndex >= 0
        ? `原始${info.kind === 'audio' ? '录音' : '视频'} · 第 ${info.fragIndex + 1} / ${info.fragCount} 段`
        : '原始视频';

  return (
    <div className="video-box" style={{ width, height }}>
      <video ref={ref} muted playsInline preload="auto" style={{ opacity: info.kind === 'video' ? 1 : 0 }} />
      <Tip tip={info.frag ? `${info.frag.file}（在整段录音里 ${fmtTime(info.frag.start)} – ${fmtTime(info.frag.end)}）` : label}>
        <span className="pane-tag">{label}</span>
      </Tip>
      {info.kind === 'pending' && (
        <div className="video-empty">
          <Loader2 className="spin" size={22} />
          <div>正在生成原始视频预览{proxyRunning ? ` ${Math.round((proxyJob.progress || 0) * 100)}%` : '…'}</div>
          <div className="muted" style={{ fontSize: 12 }}>
            只需要生成一次，大约半分钟
          </div>
        </div>
      )}
      {info.kind === 'audio' && (
        <div className="video-empty">
          <AudioLines size={26} />
          <div>{info.src === 'main' ? '这一段是录音文件，没有画面' : info.src === M.SILENCE ? '这里是插入的空白（静音）' : '这段是补录的音频，没有画面'}</div>
        </div>
      )}
    </div>
  );
}

function TimeDisplay() {
  const ref = useRef(null);
  useEffect(
    () =>
      onFrame((pos) => {
        if (!ref.current) return;
        const total = useEditor.getState().total();
        const txt = `${fmtTime(pos)}`;
        if (ref.current.firstChild.textContent !== txt) ref.current.firstChild.textContent = txt;
        const tt = ` / ${fmtTime(total)}`;
        if (ref.current.lastChild.textContent !== tt) ref.current.lastChild.textContent = tt;
      }),
    [],
  );
  return (
    <div className="time-display" ref={ref}>
      <b>00:00.0</b>
      <span> / 00:00.0</span>
    </div>
  );
}
