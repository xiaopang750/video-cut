import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  Check,
  Clapperboard,
  Download,
  FileText,
  FolderOpen,
  FolderPlus,
  Images,
  Loader2,
  MoreHorizontal,
  Play,
  RefreshCw,
  Sparkles,
  Trash2,
  Video,
  Wand2,
} from 'lucide-react';
import { api, urls } from '../api.js';
import { fmtDuration, navigate, timeAgo, toast, useApp } from '../appStore.js';
import { confirmDialog, MenuButton, Modal, PALETTE, Seg, Tip } from '../components/ui.jsx';
import ImportDialog from './ImportDialog.jsx';

const STATUS = {
  new: { text: '未初始化', cls: 'gray' },
  queued: { text: '排队中', cls: '', pulse: true },
  processing: { text: '处理中', cls: '', pulse: true },
  ready: { text: '可以编辑', cls: 'green' },
  error: { text: '出错了', cls: 'red' },
};

function isActive(job) {
  return job && (job.status === 'queued' || job.status === 'running');
}

export default function ProjectList() {
  const [projects, setProjects] = useState(null);
  const [status, setStatus] = useState(null);
  const [showImport, setShowImport] = useState(false);
  const [pdfFor, setPdfFor] = useState(null);
  const [fresh, setFresh] = useState(null); // 刚导入的项目：排在最前面并高亮一下
  const version = useApp((s) => s.projectsVersion);

  const load = useCallback(() => {
    api
      .projects()
      // 按创建时间倒序（新导入的在最前面）
      .then((list) => setProjects([...list].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))))
      .catch((e) => toast(e.message, 'error'));
  }, []);
  const onImported = (id) => {
    setFresh(id);
    load();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    setTimeout(() => setFresh((f) => (f === id ? null : f)), 4000);
  };
  useEffect(load, [load, version]);
  useEffect(() => {
    api.status().then(setStatus).catch(() => {});
  }, []);

  return (
    <div className="list-page">
      <header className="list-head">
        <div className="brand">
          <img className="brand-logo" src="/favicon.svg" alt="" />
          <div>
            <h1>绘本剪辑台</h1>
            <p>朗读录音 × 绘本图文，一页一页对齐成视频</p>
            <div className="palette-strip">
              {PALETTE.map((c) => (
                <i key={c} style={{ background: c }} />
              ))}
            </div>
          </div>
        </div>
        <div className="spacer" />
        <Tip tip="重新读取项目列表">
          <button className="btn btn-ghost" onClick={load}>
            <RefreshCw />
            刷新
          </button>
        </Tip>
        <Tip tip="选择电脑上的绘本文件夹，确认视频、图片顺序和文字稿后导入" side="bottom">
          <button className="btn btn-primary btn-lg" onClick={() => setShowImport(true)}>
            <FolderPlus />
            导入绘本
          </button>
        </Tip>
      </header>

      {status && !status.ready && (
        <div className="warn-banner">
          <AlertTriangle size={18} />
          没有找到语音识别组件（whisper-cli / 模型），请在项目目录运行 <code>npm run setup</code> 后重启服务。
        </div>
      )}

      {projects === null ? null : projects.length === 0 ? (
        <div className="empty">
          <div className="empty-art">
            {PALETTE.map((c) => (
              <i key={c} style={{ background: c }} />
            ))}
          </div>
          <h2>还没有绘本项目</h2>
          <div>点「导入绘本」，选择电脑上的绘本文件夹（朗读视频、IMG_序号 图片、zimu.rtf）</div>
          <button className="btn btn-primary btn-lg" onClick={() => setShowImport(true)}>
            <FolderPlus />
            导入绘本
          </button>
        </div>
      ) : (
        <div className="project-grid">
          {projects.map((p, i) => (
            <ProjectCard key={p.id} p={p} index={i} fresh={p.id === fresh} onChanged={load} onPdf={() => setPdfFor(p)} />
          ))}
        </div>
      )}

      {showImport && <ImportDialog onClose={() => setShowImport(false)} onImported={onImported} />}
      {pdfFor && <PdfDialog project={pdfFor} onClose={() => setPdfFor(null)} />}
    </div>
  );
}

function ProjectCard({ p, index, fresh, onChanged, onPdf }) {
  const liveJob = useApp((s) => s.jobs[p.id]);
  const job = isActive(liveJob) ? liveJob : isActive(p.job) ? p.job : null;
  const initJob = job && job.type === 'init' ? job : null;
  const st = initJob ? STATUS[job.status === 'queued' ? 'queued' : 'processing'] : STATUS[p.status] || STATUS.new;
  const ready = p.status === 'ready';
  const hasVideo = Boolean(p.output?.video);
  const hasPdf = Boolean(p.output?.pdf);

  const doInit = async (again) => {
    if (again) {
      const ok = await confirmDialog({
        title: '重新初始化？',
        message: '会重新提取音频、重新识别并对齐，当前的剪辑（删除的片段、页面位置、导入的新录音）都会被重置。',
        okText: '重新初始化',
        danger: true,
      });
      if (!ok) return;
    }
    try {
      await api.init(p.id);
      onChanged();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const doDelete = async () => {
    const r = await confirmDialog({
      title: `删除《${p.name}》？`,
      message: p.uploaded
        ? '会删除这个项目的剪辑记录和中间文件。'
        : '会删除这个项目的剪辑记录和中间文件。data 目录里的原始视频、图片、文字稿不会被删除。',
      okText: '删除',
      danger: true,
      checkboxes: [
        { key: 'outputs', label: '同时删除 output 目录里已生成的视频 / 音频 / PDF' },
        ...(p.uploaded ? [{ key: 'source', label: `同时删除上传时保存到 data/${p.folder} 的素材（视频、图片、文字稿）` }] : []),
      ],
    });
    if (!r) return;
    try {
      await api.remove(p.id, r.checks);
      toast('已删除', 'success');
      onChanged();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const openEditor = () => ready && navigate(`/edit/${p.id}`);

  return (
    <div className={`project-card ${fresh ? 'fresh' : ''}`} style={{ animationDelay: `${Math.min(index, 10) * 50}ms` }}>
      {fresh && <span className="fresh-tag">刚导入</span>}
      <div className="cover" onClick={openEditor}>
        {p.cover ? <img src={urls.image(p.id, p.cover, 640)} alt="" loading="lazy" /> : null}
        <span className={`pill ${st.cls}`}>
          <span className={`dot ${st.pulse ? 'pulse' : ''}`} />
          {st.text}
        </span>
        <div className="cover-stats">
          <span>
            <BookOpen /> {p.pages} 页
          </span>
          <span>
            <Video /> {p.videos} 段
          </span>
          <span>
            <Images /> {p.images} 图
          </span>
        </div>
      </div>
      <div className="card-body">
        <Tip tip={p.name}>
          <h3 className="card-title">{p.name}</h3>
        </Tip>
        <div className="card-meta">
          <Tip tip={`创建于 ${new Date(p.createdAt).toLocaleString('zh-CN')}`}>
            <span>{timeAgo(p.createdAt)}创建</span>
          </Tip>
          <span>·</span>
          <span>{fmtDuration(p.duration)}</span>
          {p.analysis?.confidence != null && (
            <>
              <span>·</span>
              <span>对齐 {Math.round(p.analysis.confidence * 100)}%</span>
            </>
          )}
        </div>

        {(hasVideo || hasPdf) && (
          <div className="card-outputs">
            {hasVideo && (
              <div className="out-row">
                <span className="out-icon video">
                  <Clapperboard size={14} />
                </span>
                <span className="out-name">视频已生成</span>
                <span className="out-when">{p.output.renderedAt ? timeAgo(p.output.renderedAt) : ''}</span>
                <Tip tip="在新标签页里播放">
                  <a className="icon-btn sm" href={urls.file(p.id, 'video')} target="_blank" rel="noreferrer">
                    <Play />
                  </a>
                </Tip>
                <Tip tip="下载视频">
                  <a className="icon-btn sm" href={urls.file(p.id, 'video', true)}>
                    <Download />
                  </a>
                </Tip>
              </div>
            )}
            {hasPdf && (
              <div className="out-row">
                <span className="out-icon pdf">
                  <FileText size={14} />
                </span>
                <span className="out-name">PDF 已生成</span>
                <Tip tip={`${p.output.pdfMode === 'pages' ? `分页（一图一页），共 ${p.output.pdfPages || ''} 页` : '整本长图（一页到底）'}${p.output.pdfAt ? `，${new Date(p.output.pdfAt).toLocaleString('zh-CN')} 生成` : ''}`}>
                  <span className="out-when">{p.output.pdfAt ? timeAgo(p.output.pdfAt) : ''}</span>
                </Tip>
                <Tip tip="在新标签页里打开 PDF">
                  <a className="icon-btn sm" href={urls.file(p.id, 'pdf')} target="_blank" rel="noreferrer">
                    <BookOpen />
                  </a>
                </Tip>
                <Tip tip="下载 PDF">
                  <a className="icon-btn sm" href={urls.file(p.id, 'pdf', true)}>
                    <Download />
                  </a>
                </Tip>
              </div>
            )}
          </div>
        )}

        {job && (
          <div className="card-job">
            <div className="row">
              <Loader2 size={14} className="spin" />
              <span>
                {job.type === 'init' ? '初始化' : job.type === 'render' ? '生成视频' : '导出 PDF'} · {job.message}
              </span>
              <span className="spacer" />
              <span className="mono">{Math.round((job.progress || 0) * 100)}%</span>
            </div>
            <div className={`progress ${job.type === 'init' ? '' : 'orange'}`}>
              <i style={{ width: `${Math.max(3, (job.progress || 0) * 100)}%` }} />
            </div>
          </div>
        )}
        {!job && p.error && <div className="card-error">{p.error}</div>}

        <div className="card-actions">
          {initJob ? (
            <Tip tip="停止这次初始化">
              <button
                className="btn btn-ghost"
                onClick={() => api.cancel(p.id).then(onChanged).catch((e) => toast(e.message, 'error'))}
              >
                取消
              </button>
            </Tip>
          ) : ready ? (
            <Tip tip="剪辑音频、调整每一页的翻页时间">
              <button className="btn btn-primary" onClick={openEditor}>
                <Wand2 />
                进入编辑
              </button>
            </Tip>
          ) : (
            <Tip tip="提取音频 → 语音识别 → 文字自动对齐到每一页（约 1 分钟）">
              <button className="btn btn-accent" onClick={() => doInit(false)}>
                <Sparkles />
                {p.status === 'error' ? '重新初始化' : '初始化'}
              </button>
            </Tip>
          )}
          <Tip tip={hasPdf ? 'PDF 已生成：打开、下载或重新导出' : '把每一页的图文按顺序合成 PDF'}>
            <button className={`btn btn-ghost ${hasPdf ? 'has-out' : ''}`} style={{ flex: 'none' }} onClick={onPdf}>
              <FileText />
              PDF
              {hasPdf && <Check size={14} className="out-check" />}
            </button>
          </Tip>
          <MenuButton
            tip="更多操作"
            button={
              <button className="icon-btn">
                <MoreHorizontal />
              </button>
            }
            items={[
              (hasVideo || hasPdf || p.output?.original) && { group: true, label: '生成的文件' },
              hasVideo && {
                label: '播放视频',
                icon: <Play />,
                onClick: () => window.open(urls.file(p.id, 'video'), '_blank'),
              },
              hasVideo && {
                label: '下载视频',
                icon: <Download />,
                onClick: () => (location.href = urls.file(p.id, 'video', true)),
              },
              hasPdf && {
                label: '打开 PDF',
                icon: <BookOpen />,
                onClick: () => window.open(urls.file(p.id, 'pdf'), '_blank'),
              },
              hasPdf && {
                label: '下载 PDF',
                icon: <Download />,
                onClick: () => (location.href = urls.file(p.id, 'pdf', true)),
              },
              p.output?.original && {
                label: '下载原始音频（MP3）',
                icon: <Download />,
                onClick: () => (location.href = urls.file(p.id, 'original', true)),
              },
              {
                label: '在访达中显示',
                icon: <FolderOpen />,
                onClick: () => api.reveal(p.id, hasVideo ? 'video' : undefined).catch((e) => toast(e.message, 'error')),
              },
              '-',
              ready && !initJob && { label: '重新初始化', icon: <RefreshCw />, onClick: () => doInit(true) },
              { label: '删除项目', icon: <Trash2 />, danger: true, onClick: doDelete },
            ]}
          />
        </div>
      </div>
    </div>
  );
}

function PdfDialog({ project, onClose }) {
  const [mode, setMode] = useState(project.output?.pdfMode || 'long');
  const [started, setStarted] = useState(false);
  const job = useApp((s) => s.jobs[project.id]);
  const pdfJob = started && job?.type === 'pdf' ? job : null;
  const done = pdfJob?.status === 'done';
  const failed = pdfJob?.status === 'error';
  const running = started && !done && !failed;
  // 已经生成过的 PDF（重新导出完成后显示新的）
  const prev = project.output?.pdf ? { mode: project.output.pdfMode, at: project.output.pdfAt, pages: project.output.pdfPages } : null;
  const result = done ? { mode: pdfJob.result?.pdfMode || mode, at: pdfJob.result?.pdfAt || Date.now(), pages: pdfJob.result?.pdfPages } : null;
  const ready = result || (!started && prev);

  useEffect(() => {
    useApp.setState({ pdfWatch: project.id });
    return () => useApp.setState({ pdfWatch: null });
  }, [project.id]);

  const start = async () => {
    try {
      setStarted(true);
      await api.pdf(project.id, mode);
    } catch (e) {
      setStarted(false);
      toast(e.message, 'error');
    }
  };
  const close = () => {
    if (running) toast('PDF 会在后台继续生成，好了会提示你，也可以在项目卡片上下载', 'info', 3500);
    onClose();
  };
  const modeText = (m, pages) => (m === 'pages' ? `分页（一图一页）${pages ? ` · ${pages} 页` : ''}` : '整本长图（一页到底）');

  return (
    <Modal
      title={`导出 PDF《${project.name}》`}
      icon={<FileText color="var(--sunset)" />}
      onClose={close}
      footer={
        <>
          {ready && (
            <Tip tip="在访达里打开 output 目录并选中这个 PDF">
              <button className="btn btn-ghost" onClick={() => api.reveal(project.id, 'pdf').catch((e) => toast(e.message, 'error'))}>
                <FolderOpen />
                在访达中显示
              </button>
            </Tip>
          )}
          <div className="spacer" />
          {!running && !result && (
            <Tip tip={prev ? '按下面选的排版方式重新生成，覆盖原来的 PDF' : '按上面选的排版方式生成，保存到 output 目录'}>
              <button className={`btn ${prev ? 'btn-ghost' : 'btn-accent'}`} onClick={start}>
                <Clapperboard />
                {prev ? '重新导出' : '开始导出'}
              </button>
            </Tip>
          )}
          {ready && (
            <>
              <Tip tip="下载到浏览器的下载目录">
                <a className="btn btn-ghost" href={urls.file(project.id, 'pdf', true)}>
                  <Download />
                  下载
                </a>
              </Tip>
              <Tip tip="在新标签页里打开">
                <a className="btn btn-primary" href={urls.file(project.id, 'pdf')} target="_blank" rel="noreferrer">
                  <BookOpen />
                  打开 PDF
                </a>
              </Tip>
            </>
          )}
        </>
      }
    >
      {ready && (
        <div className="pdf-ready">
          <span className="out-icon pdf">
            <Check size={16} />
          </span>
          <div>
            <b>{result ? 'PDF 已生成' : '已经生成过 PDF'}</b>
            <div className="muted">
              {modeText(ready.mode, ready.pages)}
              {ready.at ? ` · ${timeAgo(ready.at)}` : ''} · 保存在 output/{project.name}/
            </div>
          </div>
        </div>
      )}
      {running ? (
        <div className="big-progress">
          <div className="pct">{`${Math.round((pdfJob?.progress || 0) * 100)}%`}</div>
          <div className="progress orange">
            <i style={{ width: `${Math.max(3, (pdfJob?.progress || 0) * 100)}%` }} />
          </div>
          <div className="muted">{pdfJob?.message || '排队中'}</div>
        </div>
      ) : (
        !result && (
          <>
            <p className="muted" style={{ marginTop: prev ? 14 : 0, lineHeight: 1.7 }}>
              {prev ? '需要换个排版或者内容有改动，可以重新导出：' : '把每一页（照片 + 中英文字 + 水印）按顺序合成，代表整个故事。'}
            </p>
            <div className="field">
              <label>排版方式</label>
              <Seg
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'long', label: '整本长图（一页到底）', tip: '所有页从上到下拼成一张长图，放在一个 PDF 页面里' },
                  { value: 'pages', label: '分页（一图一页）', tip: '每一页图文单独占一个 PDF 页面' },
                ]}
              />
            </div>
            {failed && <div className="card-error">{pdfJob.error}</div>}
          </>
        )
      )}
    </Modal>
  );
}
