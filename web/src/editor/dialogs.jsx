import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  Download,
  FolderOpen,
  Loader2,
  Mic,
  Music,
  PencilLine,
  Play,
  RotateCcw,
  Save,
  Settings2,
  Square,
  Upload,
  VolumeX,
} from 'lucide-react';
import { api, urls } from '../api.js';
import { fmtDuration, fmtTime, toast, useApp } from '../appStore.js';
import { confirmDiscard, Modal, Seg, Switch, Tip } from '../components/ui.jsx';
import * as M from './editModel.js';
import { PAGE_BADGE } from './SidePanel.jsx';
import { peakRange } from './audioEngine.js';
import { getEngine, useEditor } from './store.js';

// 防抖的草稿预览图
function useDraftPreview(projectId, body, enabled = true) {
  const [url, setUrl] = useState(null);
  const [loading, setLoading] = useState(false);
  const key = JSON.stringify(body);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const u = await api.previewPage(projectId, JSON.parse(key));
        if (!alive) return URL.revokeObjectURL(u);
        setUrl((old) => {
          if (old) URL.revokeObjectURL(old);
          return u;
        });
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        alive && setLoading(false);
      }
    }, 280);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [projectId, key, enabled]);
  return { url, loading };
}

// 合成画面固定 3:4（750×1000）
const RATIO = '3 / 4';

function PreviewBox({ url, loading, ratio, caption }) {
  return (
    <div>
      <div className="page-preview" style={{ '--page-ratio': ratio, width: '100%', height: 'auto' }}>
        {url && <img src={url} alt="" style={{ position: 'static', display: 'block', opacity: loading ? 0.6 : 1 }} />}
        {loading && <Loader2 className="spin" size={22} style={{ position: 'absolute', right: 12, top: 12, color: 'var(--sea)' }} />}
      </div>
      {caption && <p className="preview-caption">{caption}</p>}
    </div>
  );
}

// ---------------- 修改某一页（文字 / 图片）----------------
const textOf = (seg) => (seg?.blocks || []).map((b) => b.join('\n')).join('\n\n');
const parseBlocks = (text) =>
  text
    .split(/\n\s*\n/)
    .map((b) =>
      b
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    )
    .filter((b) => b.length);

export function PageEditDialog({ index: startIndex, onClose }) {
  const projectId = useEditor((s) => s.id);
  const project = useEditor((s) => s.project);
  const settings = useEditor((s) => s.settings);
  const segments = useEditor((s) => s.segments);
  const pages = useEditor((s) => s.edit.pages);
  const [index, setIndex] = useState(startIndex);
  const seg = segments.find((s) => s.id === pages[index]?.seg);
  const [text, setText] = useState(() => textOf(seg));
  const [image, setImage] = useState(seg?.image || null);
  const [saving, setSaving] = useState(false);
  const stripRef = useRef(null);

  useEffect(() => {
    setText(textOf(seg));
    setImage(seg?.image || null);
    stripRef.current?.querySelector('.strip-item.on')?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }, [seg?.id]);

  const blocks = useMemo(() => parseBlocks(text), [text]);
  const dirty = text !== textOf(seg) || image !== (seg?.image || null);
  const pv = useDraftPreview(projectId, { segId: seg?.id, blocks, image, w: 540 }, Boolean(seg));

  // 每张图被哪些页用着
  const usage = useMemo(() => {
    const m = {};
    pages.forEach((p, k) => {
      const s = segments.find((x) => x.id === p.seg);
      const img = k === index ? image : s?.image;
      if (img) (m[img] ||= []).push(k + 1);
    });
    return m;
  }, [pages, segments, index, image]);

  const save = async () => {
    if (!dirty) return true;
    setSaving(true);
    try {
      await useEditor.getState().saveSegment(seg.id, { blocks, image });
      toast(`P${index + 1} 已保存`, 'success', 1400);
      return true;
    } catch (e) {
      toast(e.message, 'error');
      return false;
    } finally {
      setSaving(false);
    }
  };
  const go = async (to) => {
    if (to < 0 || to >= pages.length || to === index) return;
    if (await save()) setIndex(to);
  };
  const close = async () => {
    if (await confirmDiscard(dirty)) onClose();
  };
  if (!seg) return null;
  const others = usage[image]?.filter((n) => n !== index + 1) || [];

  return (
    <Modal
      wide
      title={`修改第 ${index + 1} 页`}
      icon={<PencilLine color="var(--sea)" />}
      onClose={close}
      headerExtra={
        <div className="row" style={{ gap: 4, marginLeft: 8 }}>
          <Tip tip="上一页（有修改会先自动保存）">
            <button className="icon-btn sm" disabled={index === 0} onClick={() => go(index - 1)}>
              <ChevronLeft />
            </button>
          </Tip>
          <span className="mono muted" style={{ fontSize: 12.5 }}>
            {index + 1} / {pages.length}
          </span>
          <Tip tip="下一页（有修改会先自动保存）">
            <button className="icon-btn sm" disabled={index === pages.length - 1} onClick={() => go(index + 1)}>
              <ChevronRight />
            </button>
          </Tip>
        </div>
      }
      footer={
        <>
          <span className="muted" style={{ fontSize: 12.5 }}>
            {dirty ? '有未保存的修改' : '空行分组：通常一组 = 英文一行 + 中文一行'}
          </span>
          <div className="spacer" />
          <button className="btn btn-ghost" onClick={close}>
            关闭
          </button>
          <Tip tip="保存这一页的文字和图片">
            <button
              className="btn btn-primary"
              disabled={saving || !dirty}
              onClick={async () => {
                if (await save()) onClose();
              }}
            >
              {saving ? <Loader2 className="spin" /> : <Save />}
              保存
            </button>
          </Tip>
        </>
      }
    >
      <div className="page-strip" ref={stripRef}>
        {pages.map((p, k) => {
          const s = segments.find((x) => x.id === p.seg);
          const img = k === index ? image : s?.image;
          return (
            <Tip key={p.seg} tip={k === index ? '正在修改这一页' : `切换到第 ${k + 1} 页（${s?.blocks?.[0]?.[0] || '无文字'}）`}>
              <button className={`strip-item ${k === index ? 'on' : ''}`} onClick={() => go(k)}>
                {img ? <img src={urls.image(projectId, img, 160)} alt="" /> : <span className="strip-empty" />}
                <span className="strip-no" style={{ background: PAGE_BADGE[k % 2] }}>
                  P{k + 1}
                </span>
              </button>
            </Tip>
          );
        })}
      </div>

      <div className="settings-grid">
        <div>
          <div className="field">
            <label>文字</label>
            <textarea className="textarea" style={{ minHeight: 210 }} value={text} onChange={(e) => setText(e.target.value)} />
          </div>
          <div className="field">
            <label>图片</label>
            <div className="current-image">
              {image ? <img src={urls.image(projectId, image, 480)} alt="" /> : <div className="strip-empty" />}
              <div className="current-image-info">
                <span className="pill green">
                  <Check size={13} />
                  第 {index + 1} 页当前使用
                </span>
                <b>{image || '没有图片'}</b>
                <span className="muted">{others.length ? `P${others.join('、P')} 也用这张` : '只有这一页用这张'}</span>
                {image !== (seg.image || null) && (
                  <Tip tip={`换回原来的 ${seg.image}`}>
                    <button className="btn btn-ghost btn-sm" onClick={() => setImage(seg.image || null)}>
                      <RotateCcw />
                      换回原图
                    </button>
                  </Tip>
                )}
              </div>
            </div>
            <div className="hint" style={{ margin: '4px 0 2px' }}>
              想换图？点下面任意一张（图片按序号排列）：
            </div>
            <div className="image-picker">
              {project.media.images.map((img) => {
                const on = img === image;
                const used = usage[img] || [];
                return (
                  <Tip key={img} tip={on ? '这一页正在用这张' : `把第 ${index + 1} 页换成 ${img}`}>
                    <button type="button" className={`pick-item ${on ? 'on' : ''}`} onClick={() => setImage(img)}>
                      <img src={urls.image(projectId, img, 200)} alt="" loading="lazy" />
                      <span className="pick-name">{img.replace(/\.[^.]+$/, '')}</span>
                      {on ? (
                        <span className="pick-badge on">
                          <Check size={12} />
                          当前
                        </span>
                      ) : used.length ? (
                        <span className="pick-badge">P{used.join('/')}</span>
                      ) : (
                        <span className="pick-badge idle">未使用</span>
                      )}
                      {!on && <span className="pick-hover">换成这张</span>}
                    </button>
                  </Tip>
                );
              })}
            </div>
          </div>
        </div>
        <div className="settings-preview">
          <PreviewBox url={pv.url} loading={pv.loading} ratio={RATIO} caption="合成效果预览（保存后生效）" />
        </div>
      </div>
    </Modal>
  );
}

// ---------------- 设置 ----------------
function setPath(obj, path, value) {
  const [k, ...rest] = path;
  return { ...obj, [k]: rest.length ? setPath(obj[k] || {}, rest, value) : value };
}

export function SettingsDialog({ onClose, initialTab = 'layout' }) {
  const projectId = useEditor((s) => s.id);
  const saved = useEditor((s) => s.settings);
  const segId = useEditor((s) => s.edit.pages[s.current]?.seg);
  const [draft, setDraft] = useState(saved);
  const [tab, setTab] = useState(initialTab);
  const [asDefault, setAsDefault] = useState(false);
  const [fonts, setFonts] = useState(['PingFang SC']);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    api.fonts().then(setFonts).catch(() => {});
  }, []);
  const pv = useDraftPreview(projectId, { segId, settings: draft, w: 540 });
  const up = (path, value) => setDraft((d) => setPath(d, path, value));
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const L = draft.layout;
  const T = draft.text;
  const WM = draft.watermark;
  const V = draft.video;

  const close = async () => {
    if (await confirmDiscard(dirty)) onClose();
  };
  const save = async () => {
    setSaving(true);
    try {
      await useEditor.getState().saveSettings(draft, asDefault);
      toast(asDefault ? '已保存，并设为新项目的默认设置' : '设置已保存', 'success');
      onClose();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      wide
      title="画面与输出设置"
      icon={<Settings2 color="var(--sea)" />}
      onClose={close}
      footer={
        <>
          <label className="check">
            <input type="checkbox" checked={asDefault} onChange={(e) => setAsDefault(e.target.checked)} />
            同时作为以后新导入项目的默认设置
          </label>
          <div className="spacer" />
          <button className="btn btn-ghost" onClick={close}>
            取消
          </button>
          <Tip tip="保存后，编辑器预览和之后生成的视频 / PDF 都会用新设置">
            <button className="btn btn-primary" disabled={saving} onClick={save}>
              {saving ? <Loader2 className="spin" /> : <Save />}
              保存设置
            </button>
          </Tip>
        </>
      }
    >
      <div className="tabs-inline">
        {[
          ['layout', '画面'],
          ['text', '文字'],
          ['watermark', '水印'],
          ['output', '输出 / 识别'],
        ].map(([k, label]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      <div className="settings-grid">
        <div>
          {tab === 'layout' && (
            <>
              <div className="field">
                <label>画面尺寸</label>
                <div className="fixed-size">3:4 · 750 × 1000（固定，和参考图一致；视频、PDF 都用这个尺寸）</div>
              </div>
              <div className="field">
                <label>照片高度（相对画面宽度）· {Math.round(L.photoRatio * 100)}%</label>
                <input type="range" min={0.45} max={1.1} step={0.005} value={L.photoRatio} onChange={(e) => up(['layout', 'photoRatio'], Number(e.target.value))} />
                <span className="hint">参考图为 69%（照片原始比例 4:3 = 75%）</span>
              </div>
              <div className="form-row">
                <div className="field">
                  <label>照片填充</label>
                  <Seg
                    value={L.photoFit}
                    onChange={(v) => up(['layout', 'photoFit'], v)}
                    options={[
                      { value: 'cover', label: '裁切铺满', tip: '铺满照片区域，超出部分裁掉' },
                      { value: 'contain', label: '完整显示', tip: '完整显示照片，空白处用背景色填充' },
                    ]}
                  />
                </div>
                <div className="field">
                  <label>裁切位置</label>
                  <Seg
                    value={L.photoFocus}
                    onChange={(v) => up(['layout', 'photoFocus'], v)}
                    options={[
                      { value: 'top', label: '偏上' },
                      { value: 'centre', label: '居中' },
                      { value: 'bottom', label: '偏下' },
                    ]}
                  />
                </div>
              </div>
              <div className="field">
                <label>文字区背景色</label>
                <div className="row">
                  <input type="color" value={L.background} onChange={(e) => up(['layout', 'background'], e.target.value)} />
                  <input className="input mono" style={{ width: 120 }} value={L.background} onChange={(e) => up(['layout', 'background'], e.target.value)} />
                  <Tip tip="恢复成参考图的米白色 #F2F1EA">
                    <button className="btn btn-ghost btn-sm" onClick={() => up(['layout', 'background'], '#F2F1EA')}>
                      <RotateCcw />
                      参考图米白
                    </button>
                  </Tip>
                </div>
              </div>
            </>
          )}
          {tab === 'text' && (
            <>
              <div className="field">
                <label>字体</label>
                <select className="select" value={T.fontFamily} onChange={(e) => up(['text', 'fontFamily'], e.target.value)}>
                  {[...new Set([T.fontFamily, ...fonts])].map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>文字大小 · {Math.round(T.scale * 100)}%</label>
                <input type="range" min={0.6} max={1.6} step={0.01} value={T.scale} onChange={(e) => up(['text', 'scale'], Number(e.target.value))} />
                <span className="hint">文字太多放不下时会自动缩小</span>
              </div>
              <div className="field">
                <label>文字颜色</label>
                <div className="row">
                  <input type="color" value={T.color} onChange={(e) => up(['text', 'color'], e.target.value)} />
                  <input className="input mono" style={{ width: 120 }} value={T.color} onChange={(e) => up(['text', 'color'], e.target.value)} />
                </div>
              </div>
              <div className="form-row">
                <div className="field">
                  <label>行距 · {T.linePitch}</label>
                  <input type="range" min={24} max={44} step={1} value={T.linePitch} onChange={(e) => up(['text', 'linePitch'], Number(e.target.value))} />
                </div>
                <div className="field">
                  <label>组间距 · {T.blockGap}</label>
                  <input type="range" min={0} max={36} step={1} value={T.blockGap} onChange={(e) => up(['text', 'blockGap'], Number(e.target.value))} />
                </div>
              </div>
            </>
          )}
          {tab === 'watermark' && (
            <>
              <div className="field">
                <div className="row">
                  <label style={{ fontWeight: 600 }}>左下角水印卡片</label>
                  <div className="spacer" />
                  <Switch on={WM.enabled} onChange={(v) => up(['watermark', 'enabled'], v)} />
                </div>
              </div>
              <div className="field">
                <label>标题</label>
                <input className="input" value={WM.title} onChange={(e) => up(['watermark', 'title'], e.target.value)} />
              </div>
              <div className="form-row">
                <div className="field">
                  <label>高亮文字</label>
                  <input className="input" value={WM.highlight} onChange={(e) => up(['watermark', 'highlight'], e.target.value)} />
                </div>
                <div className="field">
                  <label>高亮颜色</label>
                  <input type="color" value={WM.highlightColor} onChange={(e) => up(['watermark', 'highlightColor'], e.target.value)} />
                </div>
              </div>
              <div className="field">
                <label>副标题</label>
                <input className="input" value={WM.subtitle} onChange={(e) => up(['watermark', 'subtitle'], e.target.value)} />
              </div>
              <div className="field">
                <label>图标</label>
                <Seg
                  value={WM.icon}
                  onChange={(v) => up(['watermark', 'icon'], v)}
                  options={[
                    { value: 'pdf', label: 'PDF 文件图标' },
                    { value: 'none', label: '不显示' },
                  ]}
                />
              </div>
            </>
          )}
          {tab === 'output' && (
            <>
              <div className="field">
                <label>翻页效果</label>
                <Seg
                  value={V.transition}
                  onChange={(v) => up(['video', 'transition'], v)}
                  options={[
                    { value: 'fade', label: '淡入淡出', tip: '翻页时两页交叉淡化' },
                    { value: 'none', label: '直接切换' },
                  ]}
                />
              </div>
              {V.transition === 'fade' && (
                <div className="field">
                  <label>淡入淡出时长 · {V.transitionDuration.toFixed(2)} 秒</label>
                  <input type="range" min={0.1} max={1} step={0.05} value={V.transitionDuration} onChange={(e) => up(['video', 'transitionDuration'], Number(e.target.value))} />
                </div>
              )}
              <div className="form-row">
                <div className="field">
                  <label>画质</label>
                  <Seg
                    value={V.crf}
                    onChange={(v) => up(['video', 'crf'], v)}
                    options={[
                      { value: 16, label: '高' },
                      { value: 20, label: '标准' },
                      { value: 24, label: '小文件' },
                    ]}
                  />
                </div>
                <div className="field">
                  <label>音频码率</label>
                  <Seg
                    value={V.audioBitrate}
                    onChange={(v) => up(['video', 'audioBitrate'], v)}
                    options={[
                      { value: '320k', label: '320k' },
                      { value: '256k', label: '256k' },
                      { value: '192k', label: '192k' },
                    ]}
                  />
                </div>
              </div>
              <div className="field">
                <div className="row">
                  <label style={{ fontWeight: 600 }}>音量标准化（loudnorm，-16 LUFS）</label>
                  <div className="spacer" />
                  <Switch on={V.loudnorm} onChange={(v) => up(['video', 'loudnorm'], v)} />
                </div>
                <span className="hint">原始录音和补录的音量差别大时建议打开；默认关闭以保留原音质</span>
              </div>
              <div className="field">
                <label>PDF 默认排版</label>
                <Seg
                  value={draft.pdf.mode}
                  onChange={(v) => up(['pdf', 'mode'], v)}
                  options={[
                    { value: 'long', label: '整本长图' },
                    { value: 'pages', label: '一图一页' },
                  ]}
                />
              </div>
              <div className="field">
                <label>语音识别语言</label>
                <Seg
                  value={draft.asr?.language || 'auto'}
                  onChange={(v) => up(['asr', 'language'], v)}
                  options={[
                    { value: 'auto', label: '自动检测' },
                    { value: 'en', label: '英文' },
                    { value: 'zh', label: '中文 / 中英混读', tip: '中英文混着读时选这个' },
                  ]}
                />
                <span className="hint">改完后需要回到列表「重新初始化」才会用新语言重新识别</span>
              </div>
            </>
          )}
        </div>
        <div className="settings-preview">
          <PreviewBox url={pv.url} loading={pv.loading} ratio={RATIO} caption="预览当前页（750×1000）" />
        </div>
      </div>
    </Modal>
  );
}

// ---------------- 生成视频 ----------------
export function RenderDialog({ onClose, onOpenSettings }) {
  const id = useEditor((s) => s.id);
  const edit = useEditor((s) => s.edit);
  const settings = useEditor((s) => s.settings);
  const job = useApp((s) => s.jobs[id]);
  const [started, setStarted] = useState(false);
  const [result, setResult] = useState(null);
  const renderJob = started && job?.type === 'render' ? job : null;

  // 对话框开着时，完成提示由对话框自己显示
  useEffect(() => {
    useApp.setState({ renderWatch: id });
    return () => useApp.setState({ renderWatch: null });
  }, [id]);

  const total = M.totalOut(edit.items);
  const blockList = M.blocks(edit.items);
  const cuts = blockList.filter((b) => b.type === 'cut').length;
  const recs = blockList.length - cuts;
  const warnings = useMemo(() => {
    const w = [];
    edit.pages.forEach((p, i) => {
      const d = M.pageOutDuration(edit.items, edit.pages, i);
      if (d < 0.3) w.push(`P${i + 1} 没有分配到音频（可能整页都在删除区块里），生成的视频里不会出现这一页`);
      else if (d < 1.2) w.push(`P${i + 1} 只有 ${d.toFixed(1)} 秒，可能一闪而过`);
    });
    return w;
  }, [edit]);

  useEffect(() => {
    if (renderJob?.status === 'done') setResult(renderJob.result);
    if (renderJob?.status === 'error') toast(renderJob.error, 'error', 6000);
  }, [renderJob?.status]);

  const start = async () => {
    try {
      setResult(null);
      setStarted(true);
      await useEditor.getState().save();
      await api.render(id);
    } catch (e) {
      setStarted(false);
      toast(e.message, 'error');
    }
  };

  const running = renderJob && (renderJob.status === 'queued' || renderJob.status === 'running');
  const close = () => {
    if (running) toast('视频会在后台继续生成，好了会提示你', 'info', 3500);
    onClose();
  };
  const v = settings.video;

  return (
    <Modal
      wide={Boolean(result)}
      title={result ? '生成完成' : running ? '正在生成视频' : '确认生成视频'}
      icon={<Clapperboard color="var(--sunset)" />}
      onClose={close}
      footer={
        result ? (
          <>
            <Tip tip="在访达里打开 output 目录并选中视频">
              <button className="btn btn-ghost" onClick={() => api.reveal(id, 'video')}>
                <FolderOpen />
                在访达中显示
              </button>
            </Tip>
            <Tip tip="剪辑后的音频（320k MP3）">
              <a className="btn btn-ghost" href={urls.file(id, 'audio', true)}>
                <Music />
                下载音频 MP3
              </a>
            </Tip>
            <div className="spacer" />
            <button
              className="btn btn-ghost"
              onClick={() => {
                setResult(null);
                setStarted(false);
              }}
            >
              重新生成
            </button>
            <Tip tip="下载到浏览器的下载目录">
              <a className="btn btn-primary" href={urls.file(id, 'video', true)}>
                <Download />
                下载视频
              </a>
            </Tip>
          </>
        ) : running ? (
          <>
            <span className="muted" style={{ fontSize: 12.5 }}>
              可以关掉这个窗口继续编辑，生成会在后台进行
            </span>
            <div className="spacer" />
            <button className="btn btn-ghost" onClick={close}>
              后台生成
            </button>
          </>
        ) : (
          <>
            <Tip tip="调整画面比例、翻页效果、音量标准化等">
              <button className="btn btn-ghost" onClick={onOpenSettings}>
                <Settings2 />
                调整画面 / 输出设置
              </button>
            </Tip>
            <div className="spacer" />
            <button className="btn btn-ghost" onClick={onClose}>
              再改改
            </button>
            <Tip tip="按当前的剪辑和翻页时间生成 MP4 视频">
              <button className="btn btn-accent btn-lg" onClick={start}>
                <Clapperboard />
                开始生成
              </button>
            </Tip>
          </>
        )
      }
    >
      {result ? (
        <div>
          <video className="video-result" src={`${urls.file(id, 'video')}?t=${result.renderedAt}`} controls autoPlay />
          <p className="muted" style={{ marginBottom: 0 }}>
            {fmtDuration(result.duration)} · {result.pages} 页 · {result.size.width}×{result.size.height} · 已保存到 <code>output/</code> 目录
          </p>
        </div>
      ) : running ? (
        <div className="big-progress">
          <div className="pct">{Math.round((renderJob.progress || 0) * 100)}%</div>
          <div className="progress orange">
            <i style={{ width: `${Math.max(3, (renderJob.progress || 0) * 100)}%` }} />
          </div>
          <div className="muted">{renderJob.message}</div>
        </div>
      ) : (
        <>
          <div className="render-stats">
            <div className="stat">
              <b>{fmtTime(total, false)}</b>
              <span>剪辑后时长</span>
            </div>
            <div className="stat">
              <b>{edit.pages.length}</b>
              <span>页图文</span>
            </div>
            <div className="stat">
              <b>
                {cuts}
                {recs ? ` / ${recs}` : ''}
              </b>
              <span>{recs ? '删除 / 补录' : '处删除'}</span>
            </div>
          </div>
          {warnings.length > 0 && (
            <div className="warn-list">
              {warnings.map((w) => (
                <div key={w} className="row" style={{ alignItems: 'flex-start' }}>
                  <AlertTriangle size={15} style={{ flex: 'none', marginTop: 2 }} />
                  {w}
                </div>
              ))}
            </div>
          )}
          <p className="muted" style={{ lineHeight: 1.8, margin: 0 }}>
            画面 750×1000（3:4）· 翻页{v.transition === 'fade' ? `淡入淡出 ${v.transitionDuration}s` : '直接切换'} · AAC {v.audioBitrate}
            {v.loudnorm ? ' · 音量标准化' : ''}
            <br />
            生成的视频、剪辑后的 MP3 会保存到项目的 <code>output/</code> 目录。
          </p>
          {renderJob?.status === 'error' && (
            <div className="card-error" style={{ marginTop: 12 }}>
              {renderJob.error}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

// ---------------- 现场录音 ----------------
// ---------- 现场录音 ----------
// 录完先上传识别（自动去掉首尾空白），在预览框里「试听前后」确认接得顺，再放到时间轴上
const CTX = 2;

export function RecordDialog({ mode, onClose }) {
  const [state, setState] = useState('idle'); // idle | rec | processing | review
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [progress, setProgress] = useState(0);
  const [source, setSource] = useState(null);
  const [error, setError] = useState(null);
  const refs = useRef({});
  const alive = useRef(true);
  const pending = useRef(null); // 已上传、还没放到时间轴上的录音
  // 位置在打开弹窗时就定下来（新增 = 播放头处；替换 = 选区）
  const plan = useMemo(() => useEditor.getState().planRecording(mode), [mode]);

  const stopMic = () => {
    const r = refs.current;
    cancelAnimationFrame(r.raf);
    if (r.rec?.state === 'recording') {
      r.rec.onstop = null;
      r.rec.stop();
    }
    r.stream?.getTracks().forEach((t) => t.stop());
    r.ctx?.close();
    refs.current = {};
  };
  useEffect(
    () => () => {
      alive.current = false;
      stopMic();
      getEngine()?.stopPreview();
    },
    [],
  );

  const process = async (blob) => {
    setState('processing');
    setProgress(0);
    const ext = blob.type.includes('mp4') ? 'm4a' : 'webm';
    const file = new File([blob], `现场录音-${new Date().toLocaleTimeString('zh-CN').replace(/:/g, '')}.${ext}`, { type: blob.type });
    try {
      const src = await useEditor.getState().uploadRec(file, setProgress);
      if (!alive.current) return useEditor.getState().discardRecording(src.id);
      pending.current = src.id;
      setSource(src);
      setState('review');
    } catch (e) {
      if (!alive.current) return;
      setError(e.message);
      setState('idle');
    }
  };

  const start = async () => {
    setError(null);
    try {
      useEditor.getState().pause();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 256000 } : undefined);
      const chunks = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = () => process(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
      const ctx = new AudioContext();
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(an);
      const buf = new Float32Array(an.fftSize);
      const t0 = performance.now();
      const tick = () => {
        an.getFloatTimeDomainData(buf);
        let s = 0;
        for (const v of buf) s += v * v;
        setLevel(Math.min(1, Math.sqrt(s / buf.length) * 5));
        setElapsed((performance.now() - t0) / 1000);
        refs.current.raf = requestAnimationFrame(tick);
      };
      tick();
      refs.current = { stream, rec, ctx };
      rec.start(250);
      setState('rec');
    } catch (e) {
      setError(`无法使用麦克风：${e.message}`);
    }
  };

  const stop = () => {
    const r = refs.current;
    cancelAnimationFrame(r.raf);
    if (r.rec?.state === 'recording') r.rec.stop();
    r.stream?.getTracks().forEach((t) => t.stop());
    r.ctx?.close();
    refs.current = {};
    setLevel(0);
  };

  const discard = () => {
    getEngine()?.stopPreview();
    const id = pending.current;
    pending.current = null;
    if (id) useEditor.getState().discardRecording(id);
  };
  const redo = () => {
    discard();
    setSource(null);
    setElapsed(0);
    setState('idle');
  };
  const close = async () => {
    if (state !== 'idle') {
      const ok = await confirmDiscard(true, { title: '不要这段录音了？', message: '关闭后这段录音会被丢弃。', okText: '丢弃录音', cancelText: '继续' });
      if (!ok) return;
    }
    stopMic();
    discard();
    onClose();
  };
  const use = () => {
    getEngine()?.stopPreview();
    pending.current = null;
    useEditor.getState().placeRecording(source, plan);
    onClose();
  };

  const where =
    plan.mode === 'replace' ? `替换 ${fmtTime(plan.a)} – ${fmtTime(plan.b)}（选区）` : plan.pos != null ? `插入到 ${fmtTime(plan.pos)}（橙色竖线处）` : '';

  return (
    <Modal
      title={mode === 'replace' ? '重录选中的这一段（替换，黄色）' : '从橙色竖线（播放头）处插入录音（新增，绿色）'}
      icon={<Mic color="var(--sunset)" />}
      onClose={close}
      footer={
        state === 'review' ? (
          <>
            <Tip tip="不要这段，重新录">
              <button className="btn btn-ghost" onClick={redo}>
                <RotateCcw />
                重新录
              </button>
            </Tip>
            <div className="spacer" />
            <Tip tip={mode === 'replace' ? '用这段录音替换选中的部分' : '把这段录音插到橙色竖线的位置'}>
              <button className="btn btn-primary" onClick={use}>
                <Upload />
                {mode === 'replace' ? '替换选区' : '插入到时间轴'}
              </button>
            </Tip>
          </>
        ) : null
      }
    >
      {plan.error ? (
        <div className="card-error">{plan.error}</div>
      ) : state === 'review' && source ? (
        <RecordPreview source={source} plan={plan} where={where} />
      ) : (
        <div className="recorder">
          {state === 'processing' ? (
            <>
              <Loader2 className="spin" size={40} color="var(--sunset)" />
              <div className="muted">{progress < 1 ? `上传录音 ${Math.round(progress * 100)}%` : '识别中，自动去掉首尾空白…'}</div>
            </>
          ) : (
            <>
              <Tip tip={state === 'rec' ? '结束录音' : '开始录音'}>
                <button className={`rec-btn ${state === 'rec' ? 'on' : ''}`} onClick={state === 'rec' ? stop : start}>
                  {state === 'rec' ? <Square /> : <Mic />}
                </button>
              </Tip>
              <div className="mono" style={{ fontSize: 22, fontWeight: 700 }}>
                {fmtTime(elapsed)}
              </div>
              <div className="rec-level">
                <i style={{ width: `${level * 100}%` }} />
              </div>
              <div className="muted">{state === 'rec' ? '录音中，点方块结束' : `点麦克风开始录音 · ${where}`}</div>
            </>
          )}
          {error && <div className="card-error">{error}</div>}
        </div>
      )}
    </Modal>
  );
}

// 预览框：把新录音放进去之后的效果（前 2 秒 + 新录音 + 后 2 秒）
function RecordPreview({ source, plan, where }) {
  const cvRef = useRef(null);
  const [pos, setPos] = useState(null);
  const raf = useRef(0);
  const color = plan.mode === 'replace' ? '#E0A100' : '#2FA56B';

  const pv = useMemo(() => {
    const st = useEditor.getState();
    const op = { ...st.recordingOp(source, plan, '__preview'), applied: true, time: Date.now() };
    const d = st.derive([...st.ops, op]);
    const ext = M.opExtent(op, d.items) || [0, 0];
    const clips = M.playedClips(d.items);
    const starts = [];
    let acc = 0;
    for (const c of clips) {
      starts.push(acc);
      acc += c.out - c.in;
    }
    const recA = M.dtToOut(d.items, ext[0]);
    const recB = M.dtToOut(d.items, ext[1]);
    return { clips, starts, recA, recB, from: Math.max(0, recA - CTX), to: Math.min(acc, recB + CTX) };
  }, [source, plan]);

  const text = useMemo(() => {
    const ws = useEditor.getState().words[source.id]?.words || [];
    return ws
      .filter((w) => w.t1 > source.suggestedIn && w.t0 < source.suggestedOut)
      .map((w) => w.text)
      .join(/[一-鿿]/.test(ws[0]?.text || '') ? '' : ' ');
  }, [source]);

  // 画波形：成片时间 [from, to]，新录音那段上色
  useEffect(() => {
    const cv = cvRef.current;
    const eng = getEngine();
    if (!cv || !eng) return;
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth;
    const H = cv.clientHeight;
    cv.width = W * dpr;
    cv.height = H * dpr;
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const span = Math.max(0.01, pv.to - pv.from);
    const X = (t) => ((t - pv.from) / span) * W;
    ctx.fillStyle = plan.mode === 'replace' ? 'rgba(245,184,0,0.12)' : 'rgba(47,165,107,0.12)';
    ctx.fillRect(X(pv.recA), 0, X(pv.recB) - X(pv.recA), H);
    const loudAt = (t0, t1) => {
      let k = pv.starts.length - 1;
      while (k > 0 && pv.starts[k] > t0) k--;
      const c = pv.clips[k];
      const pk = c && eng.peaks.get(c.src);
      if (!pk) return 0;
      const a = c.in + (t0 - pv.starts[k]);
      return peakRange(pk, a, a + (t1 - t0)).loud;
    };
    for (let x = 0; x < W; x += 4) {
      const t0 = pv.from + (x / W) * span;
      const t1 = pv.from + ((x + 3) / W) * span;
      const h = Math.max(2, Math.min(1, loudAt(t0, t1)) * (H - 10));
      const inRec = t0 >= pv.recA && t0 < pv.recB;
      ctx.fillStyle = inRec ? color : pos != null && t0 < pos ? '#6F8CB5' : '#B9C7DA';
      ctx.fillRect(x, (H - h) / 2, 3, h);
    }
    ctx.fillStyle = color;
    ctx.fillRect(X(pv.recA) - 1, 0, 2, H);
    ctx.fillRect(X(pv.recB) - 1, 0, 2, H);
    if (pos != null) {
      ctx.fillStyle = '#FF7425';
      ctx.fillRect(X(pos) - 1, 0, 2, H);
    }
  }, [pv, pos, color, plan.mode]);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const play = (a, b) => {
    const eng = getEngine();
    if (!eng) return;
    useEditor.getState().pause();
    if (!eng.preview(pv.clips, a, b)) return;
    cancelAnimationFrame(raf.current);
    const tick = () => {
      const p = eng.previewPosition();
      setPos(p);
      if (p != null) raf.current = requestAnimationFrame(tick);
    };
    tick();
  };
  const stopPlay = () => {
    getEngine()?.stopPreview();
    cancelAnimationFrame(raf.current);
    setPos(null);
  };

  const before = pv.recA - pv.from;
  const after = pv.to - pv.recB;
  return (
    <div className="rec-preview">
      <div className="rp-head">
        <b>新录音 {(pv.recB - pv.recA).toFixed(1)} 秒</b>
        <span className="muted">（首尾空白已自动去掉）· {where}</span>
      </div>
      <canvas ref={cvRef} className="rp-wave" />
      <div className="rp-labels" style={{ gridTemplateColumns: `${Math.max(before, 0.001)}fr ${Math.max(pv.recB - pv.recA, 0.001)}fr ${Math.max(after, 0.001)}fr` }}>
        <span>{before > 0.05 ? `前 ${before.toFixed(1)} 秒` : ''}</span>
        <span style={{ color }}>新录音</span>
        <span>{after > 0.05 ? `后 ${after.toFixed(1)} 秒` : ''}</span>
      </div>
      <div className="rp-actions">
        {pos != null ? (
          <button className="btn btn-ghost btn-sm" onClick={stopPlay}>
            <Square />
            停止
          </button>
        ) : (
          <>
            <Tip tip="从插入位置前 2 秒开始，连着新录音一直播到后面 2 秒，听听接得顺不顺">
              <button className="btn btn-accent btn-sm" onClick={() => play(pv.from, pv.to)}>
                <Play />
                试听前后
              </button>
            </Tip>
            <Tip tip="只播放新录音">
              <button className="btn btn-ghost btn-sm" onClick={() => play(pv.recA, pv.recB)}>
                只听新录音
              </button>
            </Tip>
          </>
        )}
      </div>
      {text && <div className="rp-text">识别到：{text}</div>}
    </div>
  );
}

// ---------- 插入空白 ----------
const SILENCE_PRESETS = [200, 300, 500, 800, 1000, 2000];

export function SilenceDialog({ onClose }) {
  const [ms, setMs] = useState('500');
  const [busy, setBusy] = useState(false);
  const pos = useMemo(() => useEditor.getState().position(), []);
  const n = Number(ms);
  const valid = Number.isFinite(n) && n >= 10 && n <= 60000;
  const insert = async () => {
    if (!valid || busy) return;
    setBusy(true);
    const ok = await useEditor.getState().insertSilence(n);
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Modal
      title="插入空白"
      icon={<VolumeX color="var(--sea)" />}
      onClose={onClose}
      footer={
        <>
          <div className="spacer" />
          <button className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={!valid || busy} onClick={insert}>
            {busy ? <Loader2 className="spin" /> : <VolumeX />}
            插入空白
          </button>
        </>
      }
    >
      <p className="muted" style={{ marginTop: 0, lineHeight: 1.7 }}>
        在橙色竖线（播放头）<b className="mono">{fmtTime(pos)}</b> 处插入一段静音，位置规则和「插入补录」一样。插入后是灰色区块，点它可以试听前后、改时长或回撤。
      </p>
      <div className="field">
        <label>空白多长</label>
        <div className="silence-input">
          <input
            className="input mono"
            type="number"
            min={10}
            max={60000}
            step={50}
            autoFocus
            value={ms}
            onChange={(e) => setMs(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && insert()}
          />
          <span>毫秒</span>
          <span className="muted">= {valid ? (n / 1000).toFixed(2) : '—'} 秒</span>
        </div>
        <div className="silence-presets">
          {SILENCE_PRESETS.map((v) => (
            <button key={v} className={`chip ${n === v ? 'on' : ''}`} onClick={() => setMs(String(v))}>
              {v >= 1000 ? `${v / 1000} 秒` : `${v} 毫秒`}
            </button>
          ))}
        </div>
        {!valid && ms !== '' && <div className="hint" style={{ color: 'var(--danger)' }}>请输入 10 到 60000 之间的毫秒数</div>}
      </div>
    </Modal>
  );
}
