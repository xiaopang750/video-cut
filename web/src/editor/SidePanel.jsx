import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeftRight,
  BookOpenText,
  Download,
  FileUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Loader2,
  Lock,
  PencilLine,
  Redo2,
  RotateCcw,
  Scissors,
  SquarePlus,
  Trash2,
  VolumeX,
} from 'lucide-react';
import { api, urls } from '../api.js';
import { fmtTime, toast } from '../appStore.js';
import { confirmDialog, Tip } from '../components/ui.jsx';
import * as M from './editModel.js';
import { useEditor } from './store.js';

export const PAGE_BADGE = ['#4A92E0', '#FF7425'];

function confColor(c) {
  if (c == null) return '#C3CCD9';
  return c >= 0.8 ? '#2FA56B' : c >= 0.5 ? '#FFB060' : '#E5484D';
}

export default function SidePanel({ onEditPage }) {
  const [tab, setTab] = useState('pages');
  const pageCount = useEditor((s) => s.edit.pages.length);
  const records = useEditor((s) => s.ops.filter((o) => o.applied).length);
  return (
    <aside className="side">
      <div className="side-tabs">
        <Tip tip="每一页的时间、文字；播放时自动跟随当前页">
          <button className={tab === 'pages' ? 'on' : ''} onClick={() => setTab('pages')}>
            <BookOpenText size={16} />
            页面
            <span className="count-badge">{pageCount}</span>
          </button>
        </Tip>
        <Tip tip="和初始化时相比，时间轴上改过的每一处（删除、新增、替换、翻页）；每处都可以单独回撤">
          <button className={tab === 'records' ? 'on' : ''} onClick={() => setTab('records')}>
            <ClipboardList size={16} />
            修改记录
            {records > 0 && <span className="count-badge">{records}</span>}
          </button>
        </Tip>
      </div>
      {tab === 'pages' ? <PagesTab onEditPage={onEditPage} /> : <RecordsTab />}
    </aside>
  );
}

function PagesTab({ onEditPage }) {
  const edit = useEditor((s) => s.edit);
  const segments = useEditor((s) => s.segments);
  const current = useEditor((s) => s.current);
  const reading = useEditor((s) => s.reading);
  const confidence = useEditor((s) => s.confidence);
  const projectId = useEditor((s) => s.id);
  const ops = useEditor((s) => s.ops);
  const total = useMemo(() => M.totalDT(edit.items), [edit.items]);
  // 哪些页的开始时间被调整过（和初始化时不一样）
  const moved = useMemo(() => new Set(ops.filter((o) => o.type === 'page' && o.applied).map((o) => o.page)), [ops]);
  const listRef = useRef(null);

  useEffect(() => {
    listRef.current?.querySelector('.page-card.current')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [current]);

  return (
    <>
      <div className="side-hint pad">播放时自动跟随 · 点卡片跳到那一页</div>
      <div className="side-scroll" ref={listRef}>
        {edit.pages.map((pg, i) => {
          const segIndex = segments.findIndex((s) => s.id === pg.seg);
          const end = i + 1 < edit.pages.length ? edit.pages[i + 1].start : total;
          return (
            <PageCard
              key={pg.seg}
              i={i}
              count={edit.pages.length}
              seg={segments[segIndex]}
              segIndex={segIndex}
              start={pg.start}
              end={end}
              outDur={M.pageOutDuration(edit.items, edit.pages, i)}
              startMoved={moved.has(i)}
              endMoved={moved.has(i + 1)}
              isCurrent={i === current}
              readingKey={i === current ? reading : null}
              conf={confidence[segIndex]}
              projectId={projectId}
              onEditPage={onEditPage}
            />
          );
        })}
      </div>
    </>
  );
}

// ---------- 修改记录 ----------
const OP_TYPES = {
  cut: { name: '删除', color: '#E5484D', icon: Scissors },
  insert: { name: '新增', color: '#2FA56B', icon: SquarePlus },
  replace: { name: '替换', color: '#E0A100', icon: ArrowLeftRight },
  page: { name: '翻页', color: '#4A92E0', icon: BookOpenText },
  silence: { name: '空白', color: '#6F7C91', icon: VolumeX },
};
const typeOf = (op) => (op.type === 'insert' && op.rec?.src === M.SILENCE ? 'silence' : op.type);

const stamp = (ts) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

function describe(op, st) {
  const items = st.edit.items;
  const T = fmtTime;
  const recName = (src) => st.sources[src]?.name || '补录';
  const recLen = () => `${(op.rec.out - op.rec.in).toFixed(1)} 秒`;
  const ext = M.opExtent(op, items) || [0, 0];
  switch (op.type) {
    case 'cut':
      return `${T(ext[0])} – ${T(ext[1])}，删掉 ${M.sumRanges(op.ranges).toFixed(1)} 秒`;
    case 'insert':
      if (op.rec.src === M.SILENCE) return `在 ${T(ext[0])} 插入空白 ${Math.round((op.rec.out - op.rec.in) * 1000)} 毫秒`;
      return `在 ${T(ext[0])} 新增「${recName(op.rec.src)}」${recLen()}`;
    case 'replace': {
      const segs = M.sourceRangeToDT(items, 'main', op.range.a, op.range.b);
      const a = segs[0]?.[0] ?? ext[0];
      const b = segs[segs.length - 1]?.[1] ?? ext[1];
      return `${T(a)} – ${T(b)} 换成「${recName(op.rec.src)}」${recLen()}`;
    }
    case 'page': {
      const init = st.base.pages[op.page]?.anchor;
      const from = init ? T(M.anchorToDT(items, init)) : '';
      return `P${op.page + 1} 开始（P${op.page} 结束）${from} → ${T(M.anchorToDT(items, op.to))}`;
    }
    default:
      return '修改';
  }
}

function RecordRow({ op, st }) {
  const t = OP_TYPES[typeOf(op)] || OP_TYPES.cut;
  const Icon = t.icon;
  const locate = () => {
    const s = useEditor.getState();
    const ext = M.opExtent(op, s.edit.items);
    if (!ext) return;
    s.seek(ext[0]);
    s.reveal(ext[0]);
    s.setSel(ext[1] - ext[0] > 0.01 ? { a: ext[0], b: ext[1] } : null);
  };
  const remove = async () => {
    const ok = await confirmDialog({
      title: '删除这条修改记录？',
      message: op.applied
        ? '删除记录会同时回撤这处修改：这里恢复成初始化时的样子，而且之后不能再重新应用。（删错了可以按 ⌘Z 撤销）'
        : '这处修改已经回撤了。删除后这条记录不再显示，也不能再重新应用。',
      okText: op.applied ? '回撤并删除记录' : '删除记录',
      danger: true,
    });
    if (ok) useEditor.getState().removeOp(op.id);
  };
  return (
    <div className={`rec-row ${op.applied ? '' : 'reverted'}`}>
      <Tip tip="点击定位到时间轴上的这个位置">
        <div className="rec-main" onClick={locate}>
          <span className="rec-type" style={{ background: t.color }}>
            <Icon size={13} />
            {t.name}
          </span>
          <div className="rec-text">{describe(op, st)}</div>
          <div className="rec-meta">
            <span className="mono">{stamp(op.time)}</span>
            {op.mtime && <span className="rec-adjusted">调整于 {stamp(op.mtime).slice(6)}</span>}
          </div>
        </div>
      </Tip>
      <div className="rec-actions">
        {op.applied ? (
          <Tip tip="回撤这处修改，这里恢复成初始化时的样子（之后在「已回撤」里还能重新应用）">
            <button className="btn btn-ghost btn-sm" onClick={() => useEditor.getState().toggleOp(op.id, false)}>
              <RotateCcw />
              回撤
            </button>
          </Tip>
        ) : (
          <Tip tip="重新应用这处修改">
            <button className="btn btn-primary btn-sm" onClick={() => useEditor.getState().toggleOp(op.id, true)}>
              <Redo2 />
              重新应用
            </button>
          </Tip>
        )}
        <Tip tip={op.applied ? '删除这条记录（等于回撤这处修改，而且不能再重新应用）' : '删除这条记录'}>
          <button className="icon-btn sm" onClick={remove}>
            <Trash2 />
          </button>
        </Tip>
      </div>
    </div>
  );
}

function RecordsTab() {
  const ops = useEditor((s) => s.ops);
  useEditor((s) => s.edit); // 位置描述随剪辑变化
  const st = useEditor.getState();
  const [showReverted, setShowReverted] = useState(false);
  const byTime = (a, b) => (b.time || 0) - (a.time || 0);
  const active = useMemo(() => ops.filter((o) => o.applied).sort(byTime), [ops]);
  const reverted = useMemo(() => ops.filter((o) => !o.applied).sort(byTime), [ops]);

  return (
    <>
      <div className="side-hint pad rec-head">
        <span>{active.length ? `和初始化时相比，改了 ${active.length} 处 · 扩大、缩小、微调都算同一处` : '和初始化时相比，还没有修改'}</span>
        <RecordsIO count={ops.length} />
      </div>
      <div className="side-scroll">
        {active.map((op) => (
          <RecordRow key={op.id} op={op} st={st} />
        ))}
        {!active.length && !reverted.length && (
          <div className="side-empty">
            还没有修改记录
            <br />
            时间轴上的每一处删除、新增、替换、调整翻页都会记在这里
          </div>
        )}
        {reverted.length > 0 && (
          <div className="rec-group">
            <Tip tip="回撤了的修改不算改动；需要的话可以在这里重新应用">
              <button className={`rec-group-head ${showReverted ? 'open' : ''}`} onClick={() => setShowReverted(!showReverted)}>
                <ChevronDown size={15} />
                已回撤 {reverted.length} 处
                <span className="muted">（不算修改，可以重新应用）</span>
              </button>
            </Tip>
            {showReverted && reverted.map((op) => <RecordRow key={op.id} op={op} st={st} />)}
          </div>
        )}
      </div>
    </>
  );
}

// 修改记录导出 / 导入：一个 JSON 文件（带着用到的补录），导出到浏览器的「下载」里
const fmtDate = (ts) => new Date(ts).toLocaleString('zh-CN', { hour12: false });
function RecordsIO({ count }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(null);
  const doExport = async () => {
    const st = useEditor.getState();
    setBusy('export');
    try {
      await st.save(); // 先把最新的修改存好
      const a = document.createElement('a');
      a.href = urls.recordsExport(st.id);
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast('正在导出修改记录，文件会保存到「下载」里', 'success', 3000);
    } finally {
      setTimeout(() => setBusy(null), 800);
    }
  };
  const doImport = async (file) => {
    if (!file) return;
    const st = useEditor.getState();
    let text;
    let data;
    try {
      text = await file.text();
      data = JSON.parse(text);
    } catch {
      return toast('读不出这个文件，请选导出的修改记录 JSON', 'error', 3500);
    }
    if (data?.type !== 'huiben-edit-records' || !Array.isArray(data.ops)) return toast('这不是修改记录文件', 'error', 3000);
    const applied = data.ops.filter((o) => o.applied !== false).length;
    const recs = Object.values(data.sources || {}).filter((s) => s.kind === 'recording').length;
    const theirs = data.project?.mainDuration;
    const mine = st.sources.main?.duration;
    const warn = [];
    if (theirs && mine && Math.abs(theirs - mine) > 0.5) warn.push(`这份记录对应的原始录音长 ${fmtTime(theirs)}，当前项目是 ${fmtTime(mine)}，位置可能对不上。`);
    if (data.project?.pages && data.project.pages !== st.segments.length) warn.push(`页数不一样（记录里 ${data.project.pages} 页，当前 ${st.segments.length} 页），超出的翻页记录会跳过。`);
    const ok = await confirmDialog({
      title: '导入修改记录？',
      message: (
        <>
          来自《{data.project?.name || '未知'}》，导出于 {data.exportedAt ? fmtDate(data.exportedAt) : '—'}，共 {data.ops.length} 处修改（{applied} 处生效
          {recs ? `，带着 ${recs} 段补录` : ''}）。
          <br />
          导入会<b>替换</b>当前的修改记录（当前 {count} 条），导入后可以按 ⌘Z 撤销。
          {warn.map((w) => (
            <span key={w} className="import-warn">
              <br />⚠ {w}
            </span>
          ))}
        </>
      ),
      okText: '导入',
    });
    if (!ok) return;
    setBusy('import');
    try {
      const res = await api.importRecords(st.id, text);
      const next = await st.applyImportedRecords(res);
      toast(`已导入 ${next.length} 处修改${res.dropped ? `，${res.dropped} 条对不上已跳过` : ''}（可以 ⌘Z 撤销）`, 'success', 4000);
    } catch (e) {
      toast(e.message, 'error', 5000);
    } finally {
      setBusy(null);
    }
  };
  return (
    <span className="rec-io">
      <Tip tip="把修改记录导出成一个 JSON 文件（带着用到的补录），保存到浏览器的「下载」里">
        <button className="btn btn-ghost btn-sm" disabled={!!busy || !count} onClick={doExport}>
          {busy === 'export' ? <Loader2 className="spin" /> : <Download />}
          导出
        </button>
      </Tip>
      <Tip tip="从导出的 JSON 文件恢复修改记录（会替换当前的记录）">
        <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => fileRef.current.click()}>
          {busy === 'import' ? <Loader2 className="spin" /> : <FileUp />}
          导入
        </button>
      </Tip>
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          doImport(f);
        }}
      />
    </span>
  );
}

// 可以直接输入的时间：点一下变成输入框，回车确定，Esc 取消
function TimeField({ value, onCommit, locked, lockTip }) {
  const [text, setText] = useState(null);
  if (locked) {
    return (
      <Tip tip={lockTip}>
        <span className="time-field locked mono">
          <Lock size={11} />
          {fmtTime(value)}
        </span>
      </Tip>
    );
  }
  const commit = () => {
    const m = String(text).trim().match(/^(?:(\d+):)?(\d+(?:\.\d*)?)$/);
    setText(null);
    if (m) onCommit((Number(m[1]) || 0) * 60 + Number(m[2]));
    else toast('时间格式不对，例如 1:02.5 或 62.5', 'error', 2000);
  };
  if (text != null) {
    return (
      <input
        className="time-field editing mono"
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setText(null);
        }}
      />
    );
  }
  return (
    <Tip tip="点击直接输入时间（例如 1:02.5）">
      <button className="time-field mono" onClick={() => setText(fmtTime(value))}>
        {fmtTime(value)}
      </button>
    </Tip>
  );
}

function EdgeStepper({ label, value, moved, locked, lockTip, onNudge, onCommit, earlierTip, laterTip }) {
  return (
    <div className={`edge-stepper ${moved ? 'moved' : ''}`}>
      <span className="edge-label">
        {label}
        {moved && (
          <Tip tip="和初始化时推荐的时间不一样">
            <i className="moved-dot" />
          </Tip>
        )}
      </span>
      {!locked && (
        <Tip tip={earlierTip}>
          <button className="step" onClick={() => onNudge(-0.1)}>
            <ChevronLeft size={15} />
          </button>
        </Tip>
      )}
      <TimeField value={value} onCommit={onCommit} locked={locked} lockTip={lockTip} />
      {!locked && (
        <Tip tip={laterTip}>
          <button className="step" onClick={() => onNudge(0.1)}>
            <ChevronRight size={15} />
          </button>
        </Tip>
      )}
    </div>
  );
}

const PageCard = memo(function PageCard({ i, count, seg, segIndex, start, end, outDur, startMoved, endMoved, isCurrent, readingKey, conf, projectId, onEditPage }) {
  const warn = outDur < 0.3;
  const st = () => useEditor.getState();
  const onClick = () => {
    st().seek(start + 0.001);
    st().reveal(start);
  };
  const stop = (e) => e.stopPropagation();
  return (
    <div className={`page-card ${isCurrent ? 'current' : ''} ${warn ? 'warn' : ''}`} onClick={onClick}>
      <div className="page-card-top">
        <div className="page-thumb">
          {seg?.image && <img src={urls.image(projectId, seg.image, 160)} alt="" loading="lazy" />}
        </div>
        <div className="page-info">
          <div className="page-time">
            <span className="page-no" style={{ background: PAGE_BADGE[i % 2] }}>
              P{i + 1}
            </span>
            <span className="mono">
              {fmtTime(start)} – {fmtTime(end)}
            </span>
            <Tip tip={warn ? '这一页没有可播放的音频（可能整页都被删除了），生成的视频里不会出现' : `成片里这一页显示 ${outDur.toFixed(1)} 秒（删除的部分不算）`}>
              <span className="mono" style={{ color: warn ? 'var(--danger)' : undefined }}>
                {warn ? '无音频' : `${outDur.toFixed(1)}s`}
              </span>
            </Tip>
            {conf != null && (
              <Tip tip={`自动对齐时，这一页文字和录音的匹配度：${Math.round(conf * 100)}%`}>
                <span className="conf-dot" style={{ background: confColor(conf) }} />
              </Tip>
            )}
          </div>
          <div className="page-lines">
            {(seg?.blocks || []).map((block, b) =>
              block.map((line, l) => {
                const zh = /[一-鿿]/.test(line) && !/^[\x00-\x7f]*$/.test(line);
                const key = `${segIndex}:${b}:${l}`;
                return (
                  <span key={key} className={`ln ${zh ? 'zh' : ''} ${readingKey === key ? 'reading' : ''}`}>
                    {line}
                  </span>
                );
              }),
            )}
            {!seg?.blocks?.length && <span className="ln zh">（这一页没有文字）</span>}
          </div>
        </div>
        <Tip tip="修改这一页的文字 / 换图片">
          <button
            className="icon-btn sm page-edit"
            onClick={(e) => {
              stop(e);
              onEditPage(i);
            }}
          >
            <PencilLine />
          </button>
        </Tip>
      </div>

      {isCurrent && (
        <div className="page-adjust" onClick={stop}>
          <EdgeStepper
            label="开始"
            value={start}
            moved={startMoved}
            locked={i === 0}
            lockTip="第 1 页固定从 0 秒开始"
            onNudge={(d) => st().nudgePage(i, 'start', d)}
            onCommit={(t) => st().setPageStart(i, t)}
            earlierTip="开始时间提前 0.1 秒（上一页的结尾也跟着提前）"
            laterTip="开始时间推后 0.1 秒（上一页的结尾也跟着推后）"
          />
          <EdgeStepper
            label="结束"
            value={end}
            moved={endMoved}
            locked={i === count - 1}
            lockTip="最后一页固定到音频结尾"
            onNudge={(d) => st().nudgePage(i, 'end', d)}
            onCommit={(t) => st().setPageEnd(i, t)}
            earlierTip="结束时间提前 0.1 秒（下一页的开始也跟着提前）"
            laterTip="结束时间推后 0.1 秒（下一页的开始也跟着推后）"
          />
          <Tip tip={startMoved || endMoved ? '恢复成初始化时自动对齐的开始 / 结束时间' : '这一页的时间没有改过'}>
            <button className="btn btn-ghost btn-sm restore-btn" disabled={!startMoved && !endMoved} onClick={() => st().restorePage(i)}>
              <RotateCcw />
              恢复
            </button>
          </Tip>
        </div>
      )}
    </div>
  );
});
