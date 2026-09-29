// 导入绘本：选文件夹 → 确认视频顺序、图片顺序、文字稿（顺序可以拖动调整，文字和配图可以改）→ 上传并导入
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  ArrowUp,
  Check,
  FolderOpen,
  FolderPlus,
  FolderUp,
  GripVertical,
  Image as ImageIcon,
  ImageOff,
  Lightbulb,
  Loader2,
  Music,
  PencilLine,
  RotateCcw,
  Upload,
  Video,
  X,
  ZoomIn,
} from 'lucide-react';
import { api, uploadFolderFile } from '../api.js';
import { fmtDuration, navigate, timeAgo, toast } from '../appStore.js';
import { confirmDiscard, Modal, Tip } from '../components/ui.jsx';
import * as P from './importPlan.js';

const STEPS = ['视频顺序', '图片顺序', '文字稿'];
const norm = (s) => String(s || '').trim().toLowerCase();

// 文字稿第 i 页的手动修改：{ image?: File|null, blocks?: string[][] }
function applyOverride(pg, o) {
  if (!o) return pg;
  const out = { ...pg };
  if (o.image !== undefined) {
    out.image = o.image;
    out.manualImage = true;
  }
  if (o.blocks) {
    out.blocks = o.blocks;
    out.editedText = true;
  }
  return out;
}

export default function ImportDialog({ onClose, onImported }) {
  const [plan, setPlan] = useState(null); // 选中的文件夹整理结果
  const [name, setName] = useState('');
  const [videos, setVideos] = useState([]);
  const [images, setImages] = useState([]);
  const [scriptName, setScriptName] = useState(null);
  const [overrides, setOverrides] = useState({});
  const [step, setStep] = useState(0);
  const [init, setInit] = useState(true);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const [projects, setProjects] = useState([]);
  const [preview, setPreview] = useState(null);
  const run = useRef({});
  const panelRef = useRef(null);
  useDragAutoScroll(panelRef);
  const info = useMediaInfo(plan);
  const parsed = useParsedScript(plan, scriptName);

  useEffect(() => {
    api
      .projects()
      .then(setProjects)
      .catch(() => {});
  }, []);
  // 换了文字稿（重新解析）后，之前对文字 / 配图的修改作废
  useEffect(() => setOverrides({}), [parsed.pages]);

  const accept = (files, folder) => {
    const p = P.classify(files);
    setError(null);
    if (!p.videos.length) {
      setError(p.files.length ? '这个文件夹里没有视频 / 录音文件，无法导入' : '这个文件夹里没有找到视频、图片或文字稿');
      return;
    }
    setPlan(p);
    setVideos(p.videos);
    setImages(p.images);
    setScriptName(p.script?.name || null);
    setName(folder || '新绘本');
    setStep(0);
  };

  // 同名的绘本是不是已经导入过（先简单按名字判断）
  const dup = useMemo(() => {
    const n = norm(name);
    if (!n) return null;
    return projects.find((p) => norm(p.name) === n || norm(p.folder) === n || norm(p.name).replace(/ \(\d+\)$/, '') === n) || null;
  }, [projects, name]);

  const scriptFile = plan?.scripts.find((f) => f.name === scriptName) || null;
  const basePages = useMemo(() => P.mapPages(scriptFile ? parsed.pages : [], images), [scriptFile, parsed.pages, images]);
  const pages = useMemo(() => basePages.map((pg, i) => applyOverride(pg, overrides[i])), [basePages, overrides]);
  const videoMoves = useMemo(() => P.moves(videos, P.defaultVideoOrder(videos)), [videos]);
  const imageMoves = useMemo(() => P.moves(images, P.defaultImageOrder(images)), [images]);
  const edits = Object.keys(overrides).length;

  const upload = async () => {
    const total = plan.files.reduce((s, f) => s + f.size, 0);
    const r = (run.current = { cancelled: false });
    setError(null);
    setProgress({ bytes: 0, total, file: '' });
    try {
      const { uid } = await api.startUpload(name);
      r.uid = uid;
      const stored = {};
      let done = 0;
      // 小文件先传，进度更顺
      for (const f of [...plan.files].sort((a, b) => a.size - b.size)) {
        if (r.cancelled) throw Object.assign(new Error('已取消'), { aborted: true });
        const up = uploadFolderFile(uid, f, (loaded) => setProgress({ bytes: done + loaded, total, file: f.name }));
        r.abort = up.abort;
        stored[f.name] = (await up.promise).file;
        done += f.size;
      }
      setProgress({ bytes: total, total, file: '' });
      const order = {
        videos: videos.map((f) => stored[f.name]).filter(Boolean),
        images: images.map((f) => stored[f.name]).filter(Boolean),
        script: scriptFile ? stored[scriptFile.name] : null,
      };
      // 改过文字 / 配图时，把确认后的每一页一起交给服务端
      const finalPages = scriptFile && edits ? pages.map((pg) => ({ blocks: pg.blocks, image: pg.image ? stored[pg.image.name] : null })) : null;
      const p = await api.finishUpload(uid, name, init, order, finalPages);
      toast(`已导入《${p.name}》${init ? '，正在初始化' : ''}`, 'success');
      onImported(p.id);
      onClose();
    } catch (e) {
      if (r.uid) api.cancelUpload(r.uid).catch(() => {});
      setProgress(null);
      if (!e.aborted) setError(e.message);
    }
  };
  const cancel = () => {
    run.current.cancelled = true;
    run.current.abort?.();
  };
  const close = async () => {
    if (progress) {
      if (!(await confirmDiscard(true, { title: '正在上传，确定取消吗？', message: '已经传上去的文件会被删掉。', okText: '取消上传', cancelText: '继续上传' }))) return;
      cancel();
    }
    onClose();
  };

  if (!plan) return <PickFolder onClose={close} onPicked={accept} error={error} />;

  const busy = Boolean(progress);
  const counts = [`${videos.length} 段`, `${images.length} 张`, scriptFile ? `${pages.length} 页` : '无'];
  const changed = [videoMoves.moved > 0, imageMoves.moved > 0, edits > 0];
  return (
    <Modal
      wide
      title="确认后导入"
      icon={<FolderPlus color="var(--sea)" />}
      onClose={close}
      footer={
        <>
          <label className="check">
            <input type="checkbox" checked={init} disabled={busy} onChange={(e) => setInit(e.target.checked)} />
            导入后立即初始化（识别 + 自动对齐）
          </label>
          <div className="spacer" />
          {busy ? (
            <button className="btn btn-ghost" onClick={cancel}>
              取消上传
            </button>
          ) : (
            <>
              {step > 0 && (
                <button className="btn btn-ghost" onClick={() => setStep(step - 1)}>
                  <ArrowLeft />
                  上一步
                </button>
              )}
              {step < STEPS.length - 1 ? (
                <button className="btn btn-primary" onClick={() => setStep(step + 1)}>
                  下一步：{STEPS[step + 1]}
                  <ArrowRight />
                </button>
              ) : (
                <Tip tip={dup ? '已经有同名的绘本了，这次会另存成一本新的' : '把这些文件上传到 data 目录，然后导入'}>
                  <button className="btn btn-primary" disabled={!name.trim()} onClick={upload}>
                    <Upload />
                    {dup ? '仍然导入' : '确认并上传'}
                  </button>
                </Tip>
              )}
            </>
          )}
        </>
      }
    >
      <div className="imp-head">
        <div className="imp-name">
          <label className="field-label">绘本名称</label>
          <input className="input" value={name} disabled={busy} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="imp-steps">
          {STEPS.map((label, i) => (
            <button key={label} className={`imp-step ${i === step ? 'on' : ''} ${i < step ? 'done' : ''}`} disabled={busy} onClick={() => setStep(i)}>
              <span className="num">{i < step ? <Check size={13} /> : i + 1}</span>
              {label}
              <span className="cnt">{counts[i]}</span>
              {changed[i] && (
                <Tip tip="这一步有调整">
                  <i className="changed-dot" />
                </Tip>
              )}
            </button>
          ))}
        </div>
        {!busy && (
          <Tip tip="换一个文件夹">
            <button className="btn btn-ghost btn-sm" onClick={() => setPlan(null)}>
              <FolderOpen />
              重新选择
            </button>
          </Tip>
        )}
      </div>

      {dup && !busy && (
        <div className="imp-dup">
          <AlertTriangle size={18} />
          <div>
            <b>
              已经导入过同名的绘本《{dup.name}》（{timeAgo(dup.createdAt)}导入）
            </b>
            <div>如果是同一本，直接打开它就行；如果是新录的一版，可以改个名字，或者「仍然导入」存成新的一本。</div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => (dup.status === 'ready' ? navigate(`/edit/${dup.id}`) : onClose())}>
            打开已有的
          </button>
        </div>
      )}

      {progress && (
        <div className="upload-progress" style={{ marginBottom: 12 }}>
          <div className="bar">
            <i style={{ width: `${(progress.bytes / Math.max(1, progress.total)) * 100}%` }} />
          </div>
          <div className="muted mono">
            {progress.bytes >= progress.total ? '上传完成，正在导入…' : `上传中 ${P.fmtBytes(progress.bytes)} / ${P.fmtBytes(progress.total)} · ${progress.file}`}
          </div>
        </div>
      )}
      {error && <div className="card-error">{error}</div>}

      <div ref={panelRef} className={`imp-panel ${busy ? 'locked' : ''}`}>
        {step === 0 && <VideosPanel videos={videos} setVideos={setVideos} moves={videoMoves} info={info} onPreview={setPreview} />}
        {step === 1 && (
          <ImagesPanel images={images} setImages={setImages} moves={imageMoves} info={info} pages={scriptFile ? pages : null} onPreview={setPreview} />
        )}
        {step === 2 && (
          <ScriptPanel
            scripts={plan.scripts}
            scriptName={scriptName}
            setScriptName={setScriptName}
            parsed={parsed}
            pages={pages}
            basePages={basePages}
            overrides={overrides}
            setOverrides={setOverrides}
            images={images}
            info={info}
            onPreview={setPreview}
          />
        )}
      </div>
      {preview && <PreviewFile file={preview} onClose={() => setPreview(null)} />}
    </Modal>
  );
}

// ---------- 第 0 步：选文件夹 ----------
function PickFolder({ onClose, onPicked, error }) {
  const inputRef = useRef(null);
  const [drag, setDrag] = useState(false);
  const pick = () => {
    inputRef.current.value = '';
    inputRef.current.click();
  };
  return (
    <Modal title="导入绘本" icon={<FolderPlus color="var(--sea)" />} onClose={onClose}>
      <input
        ref={inputRef}
        type="file"
        webkitdirectory=""
        directory=""
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files || [])];
          onPicked(files, files[0]?.webkitRelativePath?.split('/')[0] || '');
        }}
      />
      <div
        className={`dropzone ${drag ? 'over' : ''}`}
        onClick={pick}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={async (e) => {
          e.preventDefault();
          setDrag(false);
          const { files, folder } = await P.filesFromDrop(e.dataTransfer);
          onPicked(files, folder);
        }}
      >
        <div className="dz-icon">
          <FolderUp size={30} />
        </div>
        <b>把绘本文件夹拖到这里</b>
        <span>
          或者 <u>点击选择文件夹</u>
        </span>
        <small>文件夹里放：朗读视频、绘本照片（IMG_序号）、文字稿（zimu.rtf）</small>
      </div>
      {error && (
        <div className="card-error" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}
      <p className="muted upload-note" style={{ marginTop: 12 }}>
        下一步会让你确认视频顺序、图片顺序和文字稿，确认后才上传。
      </p>
    </Modal>
  );
}

function Guide({ children }) {
  return (
    <div className="imp-guide">
      <Lightbulb size={17} />
      <div>{children}</div>
    </div>
  );
}

// 挪动过的项：显示原来是第几个
function MovedBadge({ from, to, axis }) {
  if (from === to) return null;
  const earlier = from > to;
  const Icon = axis === 'x' ? (earlier ? ArrowLeft : ArrowRight) : earlier ? ArrowUp : ArrowDown;
  return (
    <Tip tip={`原来是第 ${from + 1} 个，${earlier ? '往前' : '往后'}挪了 ${Math.abs(from - to)} 位`}>
      <span className="moved-badge">
        <Icon size={12} />
        原第 {from + 1}
      </span>
    </Tip>
  );
}

// ---------- 拖动排序 ----------
function useSortable(list, setList, axis) {
  const [drag, setDrag] = useState(null); // { from, over, after }
  const target = (d) => {
    let to = d.over + (d.after ? 1 : 0);
    if (d.from < to) to--;
    return to;
  };
  const bind = (i) => ({
    draggable: true,
    onDragStart: (e) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(i));
      setDrag({ from: i, over: i, after: false });
    },
    onDragOver: (e) => {
      if (!drag) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const r = e.currentTarget.getBoundingClientRect();
      const after = axis === 'x' ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2;
      if (drag.over !== i || drag.after !== after) setDrag({ ...drag, over: i, after });
    },
    onDrop: (e) => {
      e.preventDefault();
      if (!drag) return;
      const to = target(drag);
      if (to !== drag.from) setList(P.move(list, drag.from, to));
      setDrag(null);
    },
    onDragEnd: () => setDrag(null),
  });
  const cls = (i) => {
    if (!drag) return '';
    if (drag.from === i) return 'dragging';
    if (drag.over === i && target(drag) !== drag.from) return drag.after ? 'drop-after' : 'drop-before';
    return '';
  };
  return { bind, cls, dragging: Boolean(drag) };
}

function OrderBar({ label, moved, unit, onReset, resetText }) {
  return (
    <div className="imp-bar">
      <span className="muted">
        {label}
        {moved > 0 && (
          <span className="moved-sum">
            · 和默认顺序相比挪动了 {moved} {unit}（橙色标出）
          </span>
        )}
      </span>
      {moved > 0 && (
        <button className="btn btn-ghost btn-sm" onClick={onReset}>
          <RotateCcw />
          {resetText}
        </button>
      )}
    </div>
  );
}

// 拖动时指针靠近弹窗内容区的上 / 下边缘，自动滚动（从最下面拖到最上面也行）
function useDragAutoScroll(ref) {
  useEffect(() => {
    let active = false;
    let y = 0;
    let raf = 0;
    const body = () => ref.current?.closest('.modal-body');
    const tick = () => {
      raf = 0;
      const el = body();
      if (!active || !el) return;
      const r = el.getBoundingClientRect();
      const EDGE = 80;
      let v = 0;
      if (y < r.top + EDGE) v = -Math.min(1.5, (r.top + EDGE - y) / EDGE);
      else if (y > r.bottom - EDGE) v = Math.min(1.5, (y - (r.bottom - EDGE)) / EDGE);
      if (v) el.scrollTop += v * 22;
      raf = requestAnimationFrame(tick);
    };
    const start = (e) => {
      if (!body()?.contains(e.target)) return;
      active = true;
      y = e.clientY;
      if (!raf) raf = requestAnimationFrame(tick);
    };
    const over = (e) => {
      if (active && (e.clientX || e.clientY)) y = e.clientY;
    };
    const stop = () => {
      active = false;
    };
    document.addEventListener('dragstart', start, true);
    document.addEventListener('dragover', over, true);
    document.addEventListener('dragend', stop, true);
    document.addEventListener('drop', stop, true);
    return () => {
      document.removeEventListener('dragstart', start, true);
      document.removeEventListener('dragover', over, true);
      document.removeEventListener('dragend', stop, true);
      document.removeEventListener('drop', stop, true);
      cancelAnimationFrame(raf);
    };
  }, [ref]);
}

// 不拖也能换位：输入「和第几个交换」
function SwapPopover({ index, total, onDone }) {
  const [v, setV] = useState('');
  const ok = () => {
    const n = Number(v);
    if (!v) return onDone(null);
    if (!Number.isInteger(n) || n < 1 || n > total) return toast(`请输入 1 到 ${total} 之间的数字`, 'error', 1800);
    onDone(n === index + 1 ? null : n - 1);
  };
  const keep = (e) => e.preventDefault(); // 点按钮时输入框不失焦
  return (
    <div className="swap-pop" onMouseDown={(e) => e.stopPropagation()}>
      <span>和第</span>
      <input
        autoFocus
        type="number"
        min={1}
        max={total}
        value={v}
        placeholder={`1-${total}`}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => onDone(null)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') ok();
          if (e.key === 'Escape') {
            e.stopPropagation();
            onDone(null);
          }
        }}
      />
      <span>个交换</span>
      <button className="ok" onMouseDown={keep} onClick={ok}>
        <Check size={13} />
      </button>
      <button onMouseDown={keep} onClick={() => onDone(null)}>
        <X size={13} />
      </button>
    </div>
  );
}

// 可以拖动、也可以输入序号换位的卡片（视频 / 图片共用）
function OrderCard({ i, total, from, sortable, flash, onSwap, children }) {
  const [swapping, setSwapping] = useState(false);
  return (
    <div className={`imp-card ${from !== i ? 'moved' : ''} ${flash ? 'flash' : ''} ${sortable.cls(i)}`} {...(swapping ? {} : sortable.bind(i))}>
      <div className="card-top">
        <Tip tip="不想拖的话：点这里输入要和第几个交换">
          <button className="ord-btn" onClick={() => setSwapping(true)}>
            {i + 1}
            <ArrowLeftRight size={11} />
          </button>
        </Tip>
        <Tip tip="按住卡片拖到新位置">
          <span className="drag-hint">
            <GripVertical size={14} />
            拖动
          </span>
        </Tip>
      </div>
      {swapping && (
        <SwapPopover
          index={i}
          total={total}
          onDone={(to) => {
            setSwapping(false);
            if (to != null) onSwap(i, to);
          }}
        />
      )}
      {children}
      {from !== i && (
        <div className="moved-row">
          <MovedBadge from={from} to={i} axis="x" />
        </div>
      )}
    </div>
  );
}

// 换位后两张卡片闪一下，看得出换了谁
function useSwap(list, setList) {
  const [flash, setFlash] = useState([]);
  const timer = useRef(0);
  const onSwap = (a, b) => {
    setList(P.swap(list, a, b));
    setFlash([list[a], list[b]]);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setFlash([]), 1400);
    toast(`第 ${a + 1} 个和第 ${b + 1} 个交换了位置`, 'success', 1600);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return { flash, onSwap };
}

// ---------- 第 1 步：视频顺序 ----------
function VideosPanel({ videos, setVideos, moves, info, onPreview }) {
  const sortable = useSortable(videos, setVideos, 'x');
  const { flash, onSwap } = useSwap(videos, setVideos);
  const total = videos.reduce((s, f) => s + (info[f.name]?.duration || 0), 0);
  return (
    <>
      <Guide>
        视频会<b>按下面的顺序（从左到右）拼接</b>成一整段朗读录音，默认按文件名排序。顺序不对的话，<b>按住视频拖到新位置</b>；不想拖的话，
        <b>点左上角的序号，输入要和第几个交换</b>。点画面可以播放看看是哪一段。
      </Guide>
      <OrderBar
        label={`共 ${videos.length} 段${total ? ` · 总长 ${fmtDuration(total)}` : ''}`}
        moved={moves.moved}
        unit="段"
        onReset={() => setVideos(P.defaultVideoOrder(videos))}
        resetText="恢复按文件名排序"
      />
      <div className={`imp-grid videos ${sortable.dragging ? 'sorting' : 'hint'}`}>
        {videos.map((f, i) => {
          const m = info[f.name];
          const audio = P.AUDIO_RE.test(f.name);
          return (
            <OrderCard key={f.name} i={i} total={videos.length} from={moves.orig.get(f)} sortable={sortable} flash={flash.includes(f)} onSwap={onSwap}>
              <Tip tip={audio ? '播放这段录音' : '播放这段视频'}>
                <button className="pic video" onClick={() => onPreview(f)}>
                  {m?.thumb ? <img src={m.thumb} alt="" draggable={false} /> : audio ? <Music size={22} /> : m ? <Video size={22} /> : <Loader2 className="spin" size={16} />}
                  {m?.duration ? <span className="dur mono">{fmtDuration(m.duration)}</span> : null}
                </button>
              </Tip>
              <div className="nm" title={f.name}>
                {f.name}
              </div>
              <div className="sub">{P.fmtBytes(f.size)}</div>
            </OrderCard>
          );
        })}
      </div>
    </>
  );
}

// ---------- 第 2 步：图片顺序 ----------
function ImagesPanel({ images, setImages, moves, info, pages, onPreview }) {
  const sortable = useSortable(images, setImages, 'x');
  const { flash, onSwap } = useSwap(images, setImages);
  const usedBy = useMemo(() => {
    const m = {};
    (pages || []).forEach((pg, i) => {
      if (pg.image) (m[pg.image.name] ||= []).push(i + 1);
    });
    return m;
  }, [pages]);
  return (
    <>
      <Guide>
        默认按<b>文件名里的序号从小到大</b>排列。顺序不对的话，<b>按住图片拖到新位置</b>（会出现橙色竖线，表示放到哪里）；不想拖的话，
        <b>点左上角的序号，输入要和第几个交换</b>。点图片可以看大图。
        {pages ? '有文字稿时，每一页用哪张图在下一步里确认。' : '没有文字稿时，每张图就是一页，按这个顺序。'}
      </Guide>
      <OrderBar
        label={`共 ${images.length} 张`}
        moved={moves.moved}
        unit="张"
        onReset={() => setImages(P.defaultImageOrder(images))}
        resetText="恢复按序号排序"
      />
      {images.length ? (
        <div className={`imp-grid ${sortable.dragging ? 'sorting' : 'hint'}`}>
          {images.map((f, i) => {
            const thumb = info[f.name]?.thumb;
            const used = usedBy[f.name];
            return (
              <OrderCard key={f.name} i={i} total={images.length} from={moves.orig.get(f)} sortable={sortable} flash={flash.includes(f)} onSwap={onSwap}>
                <Tip tip="看大图">
                  <button className="pic" onClick={() => onPreview(f)}>
                    {thumb ? <img src={thumb} alt="" draggable={false} /> : info[f.name] ? <ImageIcon size={22} /> : <Loader2 className="spin" size={16} />}
                  </button>
                </Tip>
                <div className="nm" title={f.name}>
                  {f.name}
                </div>
                {pages && <div className={`use ${used ? '' : 'none'}`}>{used ? `用在 P${used.join('、P')}` : '文字稿没用到'}</div>}
              </OrderCard>
            );
          })}
        </div>
      ) : (
        <div className="side-empty">这个文件夹里没有图片</div>
      )}
    </>
  );
}

// ---------- 第 3 步：文字稿（文字和配图可以改）----------
const blocksToText = (blocks) => blocks.map((b) => b.join('\n')).join('\n\n');
const textToBlocks = (text) =>
  text
    .split(/\n\s*\n/)
    .map((g) =>
      g
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    )
    .filter((g) => g.length);
const sameBlocks = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function ScriptPanel({ scripts, scriptName, setScriptName, parsed, pages, basePages, overrides, setOverrides, images, info, onPreview }) {
  const [chooseFor, setChooseFor] = useState(null); // 正在给第几页选图
  const [editing, setEditing] = useState(null); // { i, text }
  const [dragImg, setDragImg] = useState(null); // 从上面图片条拖出来的图
  const [dropOn, setDropOn] = useState(null);

  // 改一页：和文字稿原来的一样就不算修改
  const patch = (i, p) =>
    setOverrides((m) => {
      const cur = { ...(m[i] || {}), ...p };
      if (cur.image !== undefined && cur.image === basePages[i].image) delete cur.image;
      if (cur.blocks && sameBlocks(cur.blocks, basePages[i].blocks)) delete cur.blocks;
      const next = { ...m };
      if (Object.keys(cur).length) next[i] = cur;
      else delete next[i];
      return next;
    });
  const reset = (i, key) =>
    setOverrides((m) => {
      const cur = { ...(m[i] || {}) };
      delete cur[key];
      const next = { ...m };
      if (Object.keys(cur).length) next[i] = cur;
      else delete next[i];
      return next;
    });
  const saveText = () => {
    patch(editing.i, { blocks: textToBlocks(editing.text) });
    setEditing(null);
  };

  if (!scriptName) {
    return (
      <>
        <Guide>没有找到文字稿（rtf / txt）：每张图算一页，按上一步的图片顺序，文字可以导入后在编辑器里补。</Guide>
        <ScriptPicker scripts={scripts} scriptName={scriptName} setScriptName={setScriptName} />
      </>
    );
  }

  const missing = pages.filter((p) => !p.image && p.note === 'missing' && !p.manualImage);
  const unused = images.filter((f) => !pages.some((p) => p.image === f));
  const edits = Object.keys(overrides).length;
  return (
    <>
      <Guide>
        文字稿按 <code>#pic#序号</code> 切成 <b>{pages.length} 页</b>。请看看<b>每页的文字和图片是否对得上</b>。对不上的话有三种改法：<b>点这一页的图片</b>从列表里选；
        <b>在图片下面输入第几张</b>（编号见上面的图片条）；或者<b>把上面的图片拖到这一页上</b>。点图片条里的图可以放大看。点「改文字」可以修改这一页的文字；改过的地方会标出来，也能一键恢复。
      </Guide>
      <ScriptPicker scripts={scripts} scriptName={scriptName} setScriptName={setScriptName} />
      {parsed.loading ? (
        <div className="muted" style={{ padding: 20 }}>
          <Loader2 className="spin" size={16} /> 正在读取文字稿…
        </div>
      ) : parsed.error ? (
        <div className="card-error">文字稿读取失败：{parsed.error}</div>
      ) : (
        <>
          <div className="imp-strip">
            <span className="strip-label">
              <GripVertical size={14} />
              拖到下面某一页上换图；点一下放大看
            </span>
            <div className="strip">
              {images.map((f, k) => (
                <Tip key={f.name} tip={`第 ${k + 1} 张 · ${f.name}：点一下放大，按住拖到某一页上换图`}>
                  <div
                    className={`strip-img ${dragImg === f ? 'dragging' : ''}`}
                    draggable
                    onClick={() => onPreview(f)}
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'copy';
                      e.dataTransfer.setData('text/plain', f.name);
                      setDragImg(f);
                    }}
                    onDragEnd={() => {
                      setDragImg(null);
                      setDropOn(null);
                    }}
                  >
                    {info[f.name]?.thumb ? <img src={info[f.name].thumb} alt="" draggable={false} /> : <ImageIcon size={16} />}
                    <span className="no">{k + 1}</span>
                    <span className="zoom">
                      <ZoomIn size={14} />
                    </span>
                  </div>
                </Tip>
              ))}
            </div>
            {edits > 0 && (
              <button className="btn btn-ghost btn-sm" onClick={() => setOverrides({})}>
                <RotateCcw />
                全部恢复（{edits} 页改过）
              </button>
            )}
          </div>
          {(missing.length > 0 || unused.length > 0) && (
            <div className="imp-warn">
              <AlertTriangle size={16} />
              <div>
                {missing.length > 0 && (
                  <div>
                    有 {missing.length} 页找不到对应的图片（{[...new Set(missing.map((p) => `#pic#${p.imageNo}`))].join('、')}）：点这一页的图片选一张，或者先不配图，导入后在编辑器里再选。
                  </div>
                )}
                {unused.length > 0 && <div>这些图片没有用到：{unused.map((f) => f.name).join('、')}</div>}
              </div>
            </div>
          )}
          <div className="imp-pages">
            {pages.map((pg, i) => {
              const thumb = pg.image && info[pg.image.name]?.thumb;
              const lines = pg.blocks.flat();
              const isEditing = editing?.i === i;
              return (
                <div
                  key={i}
                  className={`imp-page ${pg.note === 'missing' && !pg.image ? 'bad' : ''} ${pg.manualImage || pg.editedText ? 'changed' : ''} ${dropOn === i ? 'drop' : ''}`}
                  onDragOver={(e) => {
                    if (!dragImg) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'copy';
                    if (dropOn !== i) setDropOn(i);
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget) && dropOn === i) setDropOn(null);
                  }}
                  onDrop={(e) => {
                    if (!dragImg) return;
                    e.preventDefault();
                    patch(i, { image: dragImg });
                    setDragImg(null);
                    setDropOn(null);
                  }}
                >
                  <span className="page-no">P{i + 1}</span>
                  <div className="pic-col">
                    <Tip tip="从列表里换一张图">
                      <button className="pic" onClick={() => setChooseFor(i)}>
                        {thumb ? <img src={thumb} alt="" /> : pg.image ? <ImageIcon size={18} /> : <span>缺图</span>}
                        <span className="pic-edit">
                          <PencilLine size={12} />
                          换图
                        </span>
                      </button>
                    </Tip>
                    <ImageNoField value={pg.image ? images.indexOf(pg.image) + 1 : ''} total={images.length} onCommit={(n) => patch(i, { image: images[n - 1] })} />
                  </div>
                  {isEditing ? (
                    <div className="txt-edit">
                      <textarea
                        className="textarea"
                        autoFocus
                        rows={Math.min(14, editing.text.split('\n').length + 1)}
                        value={editing.text}
                        onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') {
                            e.stopPropagation();
                            setEditing(null);
                          }
                          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveText();
                        }}
                      />
                      <div className="txt-edit-bar">
                        <span className="muted">每行一句；空一行表示分组（通常英文一行 + 中文一行）。⌘↩ 完成</span>
                        <button className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>
                          取消
                        </button>
                        <button className="btn btn-primary btn-sm" onClick={saveText}>
                          <Check />
                          完成
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="txt">
                      {lines.length ? (
                        lines.map((l, k) => (
                          <span key={k} className={/[一-鿿]/.test(l) ? 'zh' : ''}>
                            {l}
                          </span>
                        ))
                      ) : (
                        <span className="muted">（这一页没有文字）</span>
                      )}
                    </div>
                  )}
                  <div className="side">
                    {!isEditing && (
                      <button className="btn btn-ghost btn-sm" onClick={() => setEditing({ i, text: blocksToText(pg.blocks) })}>
                        <PencilLine />
                        改文字
                      </button>
                    )}
                    <PageTags pg={pg} base={basePages[i]} onReset={(key) => reset(i, key)} />
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
      {chooseFor != null && (
        <ChooseImage
          page={chooseFor}
          current={pages[chooseFor].image}
          original={basePages[chooseFor].image}
          images={images}
          info={info}
          onPreview={onPreview}
          onPick={(f) => {
            patch(chooseFor, { image: f });
            setChooseFor(null);
          }}
          onClose={() => setChooseFor(null)}
        />
      )}
    </>
  );
}

// 每页图片下面：直接输入用第几张图（编号和上面的图片条一致）
function ImageNoField({ value, total, onCommit }) {
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
    if (v === '' || Number(v) === value) return;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > total) return toast(`请输入 1 到 ${total} 之间的数字`, 'error', 1800);
    onCommit(n);
  };
  return (
    <Tip tip="输入用第几张图（编号见上面的图片条），回车确定">
      <label className="img-no">
        第
        <input
          type="number"
          min={1}
          max={total}
          value={text ?? value}
          placeholder="—"
          onFocus={(e) => {
            setText(String(value || ''));
            e.target.select();
          }}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commit();
              e.currentTarget.blur();
            }
            if (e.key === 'Escape') {
              e.stopPropagation();
              setText(null);
              e.currentTarget.blur();
            }
          }}
        />
        张
      </label>
    </Tip>
  );
}

function ScriptPicker({ scripts, scriptName, setScriptName }) {
  if (scripts.length < 2 && !(scripts.length === 1 && !scriptName)) return null;
  return (
    <div className="imp-bar">
      <span className="muted">用哪个文件做文字稿：</span>
      <select className="select" style={{ width: 'auto', height: 32 }} value={scriptName || ''} onChange={(e) => setScriptName(e.target.value || null)}>
        {scripts.map((f) => (
          <option key={f.name} value={f.name}>
            {f.name}
          </option>
        ))}
        <option value="">不用文字稿</option>
      </select>
    </div>
  );
}

// 每页右边的标签：配的是哪张图、是不是手动改过（改过的可以恢复）
function PageTags({ pg, base, onReset }) {
  const tags = [];
  if (pg.manualImage) {
    tags.push(
      <span key="img" className="tag manual">
        {pg.image ? `手动配图 ${pg.image.name}` : '手动设为不配图'}
        <Tip tip={base.image ? `恢复成文字稿里的 ${base.image.name}` : '恢复成文字稿里的配图'}>
          <button onClick={() => onReset('image')}>
            <RotateCcw size={11} />
          </button>
        </Tip>
      </span>,
    );
  } else if (pg.note === 'missing') tags.push(<span key="img" className="tag missing">找不到 #pic#{pg.imageNo}</span>);
  else if (pg.note === 'inherit') tags.push(<span key="img" className="tag">{pg.image ? `沿用 ${pg.image.name}` : '没有图'}</span>);
  else if (pg.note === 'ordinal') tags.push(<span key="img" className="tag ordinal">第 {pg.imageNo} 张图 · {pg.image?.name}</span>);
  else if (pg.image) tags.push(<span key="img" className="tag">{pg.image.name}</span>);
  if (pg.editedText) {
    tags.push(
      <span key="txt" className="tag manual">
        改过文字
        <Tip tip="恢复成文字稿里的文字">
          <button onClick={() => onReset('blocks')}>
            <RotateCcw size={11} />
          </button>
        </Tip>
      </span>,
    );
  }
  return <div className="tags">{tags}</div>;
}

// 给某一页选图
function ChooseImage({ page, current, original, images, info, onPick, onPreview, onClose }) {
  return (
    <Modal wide title={`给 P${page + 1} 选一张图`} icon={<ImageIcon color="var(--sea)" />} onClose={onClose}>
      <div className="choose-grid">
        {images.map((f, k) => (
          <div key={f.name} className={`choose-item ${f === current ? 'on' : ''}`} role="button" tabIndex={0} onClick={() => onPick(f)}>
            <div className="pic">{info[f.name]?.thumb ? <img src={info[f.name].thumb} alt="" /> : <ImageIcon size={22} />}</div>
            <span className="nm">
              第 {k + 1} 张 · {f.name}
            </span>
            {f === current && <span className="flag">当前</span>}
            {f === original && f !== current && <span className="flag orig">文字稿原来的</span>}
            <Tip tip="放大看">
              <button
                className="zoom-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onPreview(f);
                }}
              >
                <ZoomIn size={15} />
              </button>
            </Tip>
          </div>
        ))}
        <button className={`choose-item none ${current === null ? 'on' : ''}`} onClick={() => onPick(null)}>
          <div className="pic">
            <ImageOff size={24} />
          </div>
          <span className="nm">先不配图</span>
          {current === null && <span className="flag">当前</span>}
        </button>
      </div>
    </Modal>
  );
}

// 点缩略图：播放视频 / 看大图
function PreviewFile({ file, onClose }) {
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  const isImage = P.IMAGE_RE.test(file.name);
  const isAudio = P.AUDIO_RE.test(file.name);
  return (
    <Modal wide title={file.name} onClose={onClose}>
      <div className="imp-preview">
        {isImage ? <img src={url} alt="" /> : isAudio ? <audio src={url} controls autoPlay /> : <video src={url} controls autoPlay playsInline />}
      </div>
    </Modal>
  );
}

// 缩略图、时长：选好文件夹后在后台慢慢生成
function useMediaInfo(plan) {
  const [info, setInfo] = useState({});
  useEffect(() => {
    if (!plan) return undefined;
    let cancelled = false;
    const urls = [];
    setInfo({});
    (async () => {
      for (const f of plan.videos) {
        const r = await P.mediaInfo(f);
        if (r.thumb) urls.push(r.thumb);
        if (cancelled) return;
        setInfo((m) => ({ ...m, [f.name]: r }));
      }
      for (const f of plan.images) {
        const thumb = await P.imageThumb(f);
        if (thumb) urls.push(thumb);
        if (cancelled) return;
        setInfo((m) => ({ ...m, [f.name]: { thumb } }));
      }
    })();
    return () => {
      cancelled = true;
      setTimeout(() => urls.forEach((u) => URL.revokeObjectURL(u)), 0);
    };
  }, [plan]);
  return info;
}

// 文字稿交给服务端解析（和导入时用同一个解析器）
function useParsedScript(plan, scriptName) {
  const [state, setState] = useState({ pages: [], loading: false, error: null });
  useEffect(() => {
    const file = plan?.scripts.find((f) => f.name === scriptName);
    if (!file) {
      setState({ pages: [], loading: false, error: null });
      return undefined;
    }
    let cancelled = false;
    setState({ pages: [], loading: true, error: null });
    fetch('/api/parse-script', { method: 'POST', body: file })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((j) => !cancelled && setState({ pages: j.pages || [], loading: false, error: null }))
      .catch((e) => !cancelled && setState({ pages: [], loading: false, error: e.message }));
    return () => {
      cancelled = true;
    };
  }, [plan, scriptName]);
  return state;
}
