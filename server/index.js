import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { createCanvas } from '@napi-rs/canvas';
import { PORT, ROOT, DATA_DIR, WORK_DIR, OUTPUT_DIR, WEB_DIST, ensureDir, toolStatus } from './lib/config.js';
import * as store from './lib/store.js';
import { enqueue, sseHandler, jobFor, cancelJobs, broadcast } from './lib/jobs.js';
import {
  importFolder,
  initProject,
  addRecording,
  analysisFor,
  pageAssets,
  sourcePreview,
  sourceVideo,
  ensureProxy,
  outputDir,
  removeRecording,
  ensureSilenceSource,
  exportRecords,
  importRecords,
  safeName,
} from './lib/project.js';
import { startUpload, addUploadFile, finishUpload, cancelUpload, cleanStaleUploads } from './lib/upload.js';
import { rtfToText, parseScript } from './lib/rtf.js';
import { renderVideo } from './lib/render.js';
import { exportPdf } from './lib/pdf.js';
import { composePage, thumbnail } from './lib/compose.js';
import { DEFAULT_SETTINGS, LAYOUT_PRESETS, mergeSettings, resolveSize } from './lib/settings.js';

const app = express();
// 导入修改记录时 JSON 里带着录音（base64），单独放宽大小限制
const jsonBody = express.json({ limit: '20mb' });
app.use((req, res, next) => (req.path.endsWith('/records/import') ? next() : jsonBody(req, res, next)));

const upload = multer({
  dest: ensureDir(path.join(WORK_DIR, '.uploads')),
  limits: { fileSize: 4 * 1024 * 1024 * 1024 },
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function mustProject(id) {
  const p = store.getProject(id);
  if (!p) throw Object.assign(new Error('项目不存在'), { status: 404 });
  return p;
}

// 只保留磁盘上确实存在的产物（用户可能手动删过 output 里的文件）
function existingOutputs(p) {
  const out = { ...(p.output || {}) };
  for (const k of ['video', 'audio', 'pdf', 'original']) {
    if (out[k] && !fs.existsSync(path.resolve(ROOT, out[k]))) delete out[k];
  }
  return out;
}

function summary(p) {
  const duration = p.sources?.main?.duration ?? p.media.videos.reduce((s, v) => s + (v.duration || 0), 0);
  const job = jobFor(p.id);
  return {
    id: p.id,
    name: p.name,
    folder: p.folder,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    status: p.status,
    error: p.error,
    videos: p.media.videos.length,
    images: p.media.images.length,
    pages: p.segments.length,
    duration,
    cover: p.media.images[0] || null,
    analysis: p.analysis,
    output: existingOutputs(p),
    edited: Boolean(p.edit && p.edit.rev > 1),
    uploaded: Boolean(p.uploaded),
    job: job ? { id: job.id, type: job.type, status: job.status, progress: job.progress, message: job.message } : null,
  };
}

// ---------- 基础 ----------

app.get('/api/status', (req, res) => res.json({ ...toolStatus(), root: ROOT }));
app.get('/api/events', sseHandler);

const FONT_CANDIDATES = [
  'PingFang SC', 'Hiragino Sans GB', 'Heiti SC', 'Songti SC', 'Kaiti SC', 'Yuanti SC', 'Lantinghei SC',
  'Libian SC', 'Weibei SC', 'Wawati SC', 'Xingkai SC', 'HanziPen SC', 'Hannotate SC', 'LXGW WenKai',
  'Noto Sans CJK SC', 'Noto Sans SC', 'Source Han Sans SC', 'STHeiti',
];
// families 列表不完整（ttc 字体集合只列出一个名字），用"渲染宽度是否不同于兜底字体"来判断是否可用
let fontCache = null;
function availableFonts() {
  if (fontCache) return fontCache;
  const ctx = createCanvas(10, 10).getContext('2d');
  const sample = '绘本精读 Picture Book 123';
  ctx.font = '40px "__no_such_font__"';
  const fallback = ctx.measureText(sample).width;
  fontCache = FONT_CANDIDATES.filter((f) => {
    ctx.font = `40px "${f}"`;
    return Math.abs(ctx.measureText(sample).width - fallback) > 0.5;
  });
  if (!fontCache.length) fontCache = ['sans-serif'];
  return fontCache;
}
app.get('/api/fonts', (req, res) => res.json(availableFonts()));

app.get('/api/defaults', (req, res) => res.json({ settings: store.getDefaults(), presets: LAYOUT_PRESETS, builtin: DEFAULT_SETTINGS }));
app.put('/api/defaults', (req, res) => {
  const s = mergeSettings(DEFAULT_SETTINGS, req.body || {});
  store.setDefaults(s);
  res.json({ settings: s });
});

// 导入前预览文字稿：返回按 #pic#序号 切好的每一段（和导入时用同一个解析器）
app.post('/api/parse-script', express.raw({ type: () => true, limit: '10mb' }), (req, res) => {
  const text = rtfToText(Buffer.isBuffer(req.body) ? req.body : Buffer.from(''));
  res.json({ pages: parseScript(text) });
});

// ---------- 项目 ----------

app.get('/api/projects', (req, res) => res.json(store.listProjects().map(summary)));

app.get('/api/projects/:id', (req, res) => {
  const p = mustProject(req.params.id);
  res.json({ ...p, summary: summary(p) });
});

// 从浏览器上传整个文件夹导入
app.post('/api/uploads', (req, res) => res.json(startUpload(req.body?.name)));
app.post(
  '/api/uploads/:uid/files',
  upload.single('file'),
  wrap(async (req, res) => {
    if (!req.file) throw Object.assign(new Error('没有收到文件'), { status: 400 });
    const name = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    try {
      res.json(addUploadFile(req.params.uid, req.file.path, name));
    } finally {
      fs.rmSync(req.file.path, { force: true });
    }
  }),
);
app.post(
  '/api/uploads/:uid/finish',
  wrap(async (req, res) => {
    const { name, order, pages } = req.body || {};
    const folder = finishUpload(req.params.uid, name);
    const clean = (list) => (Array.isArray(list) ? list.filter((f) => typeof f === 'string') : null);
    let p;
    try {
      // 项目名 = 最终的目录名（重名时带序号），生成的视频也按它放到 output/ 下，不会互相覆盖
      p = await importFolder(folder, {
        order: order ? { videos: clean(order.videos), images: clean(order.images), script: typeof order.script === 'string' ? order.script : null } : null,
        pages: Array.isArray(pages) ? pages : null,
      });
    } catch (e) {
      // 导入失败（比如没有带声音的视频）：刚上传的目录删掉，方便重新选
      fs.rmSync(path.join(DATA_DIR, folder), { recursive: true, force: true });
      throw e;
    }
    store.updateProject(p.id, (q) => {
      q.uploaded = true;
    });
    if (req.body?.init && p.status === 'new') queueInit(p.id);
    broadcast({ type: 'projects' });
    res.json(summary(store.getProject(p.id)));
  }),
);
app.delete('/api/uploads/:uid', (req, res) => {
  cancelUpload(req.params.uid);
  res.json({ ok: true });
});

app.delete('/api/projects/:id', (req, res) => {
  const p = mustProject(req.params.id);
  cancelJobs(p.id);
  store.deleteProject(p.id);
  if (req.query.outputs === '1') fs.rmSync(outputDir(p), { recursive: true, force: true });
  // 上传导入的素材是程序复制到 data/ 里的，可以跟着删；用户自己放进 data/ 的从来不删
  if (req.query.source === '1' && p.uploaded && p.folder && !p.folder.includes('..')) {
    fs.rmSync(path.join(DATA_DIR, p.folder), { recursive: true, force: true });
  }
  broadcast({ type: 'projects' });
  res.json({ ok: true });
});

function queueInit(id) {
  const p = store.getProject(id);
  store.updateProject(id, (q) => {
    if (q.status !== 'ready') q.status = 'queued';
    q.error = null;
  });
  return enqueue(id, 'init', (ctx) => initProject(id, ctx), { label: `初始化《${p.name}》` });
}

app.post('/api/projects/:id/init', (req, res) => {
  mustProject(req.params.id);
  res.json(queueInit(req.params.id));
});

app.post('/api/projects/:id/cancel', (req, res) => {
  mustProject(req.params.id);
  cancelJobs(req.params.id);
  store.updateProject(req.params.id, (q) => {
    if (q.status === 'queued') q.status = q.edit ? 'ready' : 'new';
  });
  res.json({ ok: true });
});

app.get('/api/projects/:id/analysis', (req, res) => {
  mustProject(req.params.id);
  res.json(analysisFor(req.params.id));
});

// ---------- 编辑 ----------

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

const ITEM_KINDS = new Set(['keep', 'cut', 'old', 'new', 'insert']);
const PLAYED_KINDS = new Set(['keep', 'new', 'insert']);

app.put('/api/projects/:id/edit', (req, res) => {
  const { items, clips, pages, dismissed, base, ops } = req.body || {};
  const out = store.updateProject(req.params.id, (p) => {
    if (!p.edit) throw Object.assign(new Error('项目还没有初始化'), { status: 400 });
    // 还没刷新的旧版页面发来的是旧格式（只有成片顺序的 clips）：照旧保存，新版页面打开时会自动转换
    if (!Array.isArray(items) && Array.isArray(clips) && clips.length && Array.isArray(pages)) {
      for (const c of clips) {
        if (!p.sources[c.src] || !isNum(c.in) || !isNum(c.out) || c.out <= c.in) {
          throw Object.assign(new Error('剪辑片段数据有误'), { status: 400 });
        }
      }
      p.edit = {
        rev: (p.edit.rev || 0) + 1,
        clips: clips.map((c) => ({ id: String(c.id), src: c.src, in: c.in, out: c.out })),
        pages: pages.filter((pg) => isNum(pg.start)).map((pg) => ({ seg: pg.seg, start: pg.start })),
        dismissed: Array.isArray(dismissed) ? dismissed.map(String) : p.edit.dismissed || [],
      };
      return { rev: p.edit.rev };
    }
    if (!Array.isArray(items) || !items.length || !Array.isArray(pages)) {
      throw Object.assign(new Error('剪辑数据不完整'), { status: 400 });
    }
    for (const it of items) {
      if (!ITEM_KINDS.has(it.kind) || !p.sources[it.src] || !isNum(it.in) || !isNum(it.out) || it.out <= it.in) {
        throw Object.assign(new Error('剪辑片段数据有误'), { status: 400 });
      }
    }
    if (!items.some((it) => PLAYED_KINDS.has(it.kind))) throw Object.assign(new Error('不能把音频全部删掉'), { status: 400 });
    for (const pg of pages) {
      if (!isNum(pg.start) || !p.segments.some((s) => s.id === pg.seg)) {
        throw Object.assign(new Error('页面数据有误'), { status: 400 });
      }
    }
    const clean = items.map((it) => ({
      id: String(it.id),
      kind: it.kind,
      src: it.src,
      in: it.in,
      out: it.out,
      ...(it.orig ? { orig: String(it.orig) } : {}),
      ...(it.group ? { group: String(it.group) } : {}),
    }));
    // 新版编辑器：原始状态 + 修改记录（每条可回撤 / 重新应用），items / pages 是它们推出来的结果
    const hasOps = base && Array.isArray(base.pages) && Array.isArray(ops);
    if (hasOps && !ops.every((o) => o && typeof o.id === 'string' && typeof o.type === 'string' && isNum(o.time))) {
      throw Object.assign(new Error('修改记录格式有误'), { status: 400 });
    }
    p.edit = {
      rev: (p.edit.rev || 0) + 1,
      ...(hasOps ? { base, ops } : {}),
      items: clean,
      // 实际播放的片段（成片顺序），兼容旧格式读取
      clips: clean.filter((it) => PLAYED_KINDS.has(it.kind)).map(({ id, src, in: i, out }) => ({ id, src, in: i, out })),
      pages: pages.map((pg) => ({ seg: pg.seg, start: pg.start })),
      dismissed: Array.isArray(dismissed) ? dismissed.map(String) : p.edit.dismissed || [],
    };
    return { rev: p.edit.rev };
  });
  res.json(out);
});

app.put('/api/projects/:id/segments/:segId', (req, res) => {
  const { blocks, image } = req.body || {};
  const seg = store.updateProject(req.params.id, (p) => {
    const s = p.segments.find((x) => x.id === req.params.segId);
    if (!s) throw Object.assign(new Error('页面不存在'), { status: 404 });
    if (blocks !== undefined) {
      if (!Array.isArray(blocks) || !blocks.every((b) => Array.isArray(b) && b.every((l) => typeof l === 'string'))) {
        throw Object.assign(new Error('文字格式有误'), { status: 400 });
      }
      s.blocks = blocks.map((b) => b.map((l) => l.trim()).filter(Boolean)).filter((b) => b.length);
      s.edited = true;
    }
    if (image !== undefined) {
      if (image !== null && !p.media.images.includes(image)) throw Object.assign(new Error('图片不存在'), { status: 400 });
      s.image = image;
    }
    return s;
  });
  res.json(seg);
});

app.put('/api/projects/:id/settings', (req, res) => {
  const settings = mergeSettings(DEFAULT_SETTINGS, req.body?.settings || {});
  store.updateProject(req.params.id, (p) => {
    p.settings = settings;
  });
  if (req.body?.asDefault) store.setDefaults(settings);
  res.json({ settings });
});

app.post(
  '/api/projects/:id/recordings',
  upload.single('file'),
  wrap(async (req, res) => {
    mustProject(req.params.id);
    if (!req.file) throw Object.assign(new Error('没有收到文件'), { status: 400 });
    try {
      const name = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
      res.json(await addRecording(req.params.id, req.file.path, name));
    } finally {
      fs.rmSync(req.file.path, { force: true });
    }
  }),
);

// ---------- 媒体 ----------

// 修改记录导出 / 导入（JSON 文件，带着用到的补录）
app.get(
  '/api/projects/:id/records/export',
  wrap(async (req, res) => {
    const p = mustProject(req.params.id);
    const data = await exportRecords(p.id);
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    res.attachment(`${safeName(p.name)}-修改记录-${stamp}.json`);
    res.type('application/json').send(JSON.stringify(data));
  }),
);
app.post(
  '/api/projects/:id/records/import',
  express.json({ limit: '500mb' }),
  wrap(async (req, res) => {
    mustProject(req.params.id);
    res.json(await importRecords(req.params.id, req.body));
  }),
);

// 插入空白：确保项目里有静音音源（第一次用时生成）
app.post(
  '/api/projects/:id/silence',
  wrap(async (req, res) => {
    mustProject(req.params.id);
    res.json({ source: await ensureSilenceSource(req.params.id) });
  }),
);

// 删掉没用上的补录（现场录音录完没用 / 重新录）
app.delete('/api/projects/:id/sources/:src', (req, res) => {
  mustProject(req.params.id);
  removeRecording(req.params.id, req.params.src);
  res.json({ ok: true });
});

app.get('/api/projects/:id/sources/:src/preview', (req, res) => {
  const p = mustProject(req.params.id);
  if (!p.sources?.[req.params.src]) return res.status(404).end();
  res.set('Cache-Control', 'private, max-age=3600');
  res.sendFile(sourcePreview(p.id, req.params.src));
});

app.get('/api/projects/:id/sources/:src/video', (req, res) => {
  const p = mustProject(req.params.id);
  const file = sourceVideo(p.id, req.params.src);
  if (!p.sources?.[req.params.src]?.video || !fs.existsSync(file)) return res.status(404).json({ error: '没有预览视频' });
  res.set('Cache-Control', 'private, max-age=3600');
  res.sendFile(file);
});

app.post('/api/projects/:id/proxy', (req, res) => {
  const p = mustProject(req.params.id);
  if (!p.sources?.main) throw Object.assign(new Error('项目还没有初始化'), { status: 400 });
  res.json(enqueue(p.id, 'proxy', (ctx) => ensureProxy(p.id, ctx), { label: `生成原始视频预览《${p.name}》` }));
});

app.get(
  '/api/projects/:id/images/:file',
  wrap(async (req, res) => {
    const p = mustProject(req.params.id);
    if (!p.media.images.includes(req.params.file)) return res.status(404).end();
    const w = Math.min(2000, Math.max(64, Number(req.query.w) || 480));
    const file = await thumbnail(path.join(ROOT, 'data', p.folder, req.params.file), w, store.projectPath(p.id, 'cache'));
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(file);
  }),
);

const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 20);

function pruneCache(dir, keep = 400) {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('page-'))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(keep)) fs.rmSync(path.join(dir, f), { force: true });
  } catch {}
}

app.get(
  '/api/projects/:id/pages/:segId.jpg',
  wrap(async (req, res) => {
    const p = mustProject(req.params.id);
    const asset = pageAssets(p).find((a) => a.id === req.params.segId);
    if (!asset) return res.status(404).end();
    const size = resolveSize(p.settings);
    const w = Math.min(size.width, Math.max(120, Number(req.query.w) || size.width));
    const { layout, text, watermark } = p.settings;
    const cacheDir = ensureDir(store.projectPath(p.id, 'cache'));
    const key = hash(JSON.stringify([asset, layout, text, watermark, size, w]));
    const file = path.join(cacheDir, `page-${key}.jpg`);
    if (!fs.existsSync(file)) {
      let buf = await composePage(asset, p.settings, { ...size, cacheDir });
      if (w < size.width) buf = await sharp(buf).resize({ width: w }).jpeg({ quality: 88 }).toBuffer();
      fs.writeFileSync(file, buf);
      pruneCache(cacheDir);
    }
    res.set('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache');
    res.sendFile(file);
  }),
);

// 草稿预览：用传入的设置 / 文字 / 图片合成一页（不保存），用于设置面板和文字编辑的实时预览
app.post(
  '/api/projects/:id/preview',
  wrap(async (req, res) => {
    const p = mustProject(req.params.id);
    const { segId, settings: draft, blocks, image } = req.body || {};
    const settings = mergeSettings(p.settings, draft || {});
    const base = pageAssets(p).find((a) => a.id === segId) || pageAssets(p)[0];
    if (!base) return res.status(404).end();
    const asset = { ...base };
    if (Array.isArray(blocks)) asset.blocks = blocks;
    if (image !== undefined) asset.photo = image && p.media.images.includes(image) ? path.join(ROOT, 'data', p.folder, image) : null;
    const size = resolveSize(settings);
    const w = Math.min(size.width, Math.max(120, Number(req.body?.w) || 540));
    let buf = await composePage(asset, settings, { ...size, cacheDir: store.projectPath(p.id, 'cache') });
    if (w < size.width) buf = await sharp(buf).resize({ width: w }).jpeg({ quality: 86 }).toBuffer();
    res.type('jpeg').send(buf);
  }),
);

// ---------- 生成 ----------

app.post('/api/projects/:id/render', (req, res) => {
  const p = mustProject(req.params.id);
  if (!p.edit) throw Object.assign(new Error('项目还没有初始化'), { status: 400 });
  res.json(enqueue(p.id, 'render', (ctx) => renderVideo(p.id, ctx), { label: `生成视频《${p.name}》` }));
});

app.post('/api/projects/:id/pdf', (req, res) => {
  const p = mustProject(req.params.id);
  const mode = req.body?.mode === 'pages' ? 'pages' : req.body?.mode === 'long' ? 'long' : undefined;
  res.json(enqueue(p.id, 'pdf', (ctx) => exportPdf(p.id, { ...ctx, mode }), { label: `导出 PDF《${p.name}》` }));
});

const OUTPUT_KINDS = { video: 'video', audio: 'audio', pdf: 'pdf', original: 'original' };
function outputFile(p, kind) {
  const relPath = p.output?.[OUTPUT_KINDS[kind]];
  if (!relPath) return null;
  const abs = path.resolve(ROOT, relPath);
  if (!abs.startsWith(OUTPUT_DIR + path.sep) || !fs.existsSync(abs)) return null;
  return abs;
}

app.get('/api/projects/:id/files/:kind', (req, res) => {
  const p = mustProject(req.params.id);
  const file = outputFile(p, req.params.kind);
  if (!file) return res.status(404).json({ error: '文件还没有生成' });
  if (req.query.dl) res.attachment(path.basename(file));
  res.sendFile(file);
});

app.post('/api/projects/:id/reveal', (req, res) => {
  const p = mustProject(req.params.id);
  const file = outputFile(p, req.body?.kind) || outputDir(p);
  if (process.platform === 'darwin') spawn('open', fs.statSync(file).isDirectory() ? [file] : ['-R', file]).unref();
  else if (process.platform === 'win32') spawn('explorer', [`/select,${file}`]).unref();
  else spawn('xdg-open', [path.dirname(file)]).unref();
  res.json({ ok: true, path: file });
});

// ---------- 前端 ----------

if (fs.existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST, { index: false, maxAge: '1h' }));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(WEB_DIST, 'index.html')));
} else {
  app.get('/', (req, res) => res.type('text').send('前端还没有构建，请先运行 npm run build'));
}

app.use((err, req, res, next) => {
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || String(err) });
});

cleanStaleUploads();

// 服务重启时，之前没跑完的任务不会继续，把状态复原
for (const p of store.listProjects()) {
  if (p.status === 'processing' || p.status === 'queued') {
    store.updateProject(p.id, (q) => {
      q.status = q.edit ? 'ready' : 'new';
      if (p.status === 'processing') q.error = '上次处理被中断，请重新初始化';
    });
  }
}

app.listen(PORT, () => {
  const t = toolStatus();
  console.log(`绘本剪辑台已启动: http://localhost:${PORT}`);
  console.log(`  ffmpeg:  ${t.ffmpeg}`);
  console.log(`  whisper: ${t.whisper || '未找到（请运行 npm run setup）'}  模型: ${t.model || '未找到'}`);
});
