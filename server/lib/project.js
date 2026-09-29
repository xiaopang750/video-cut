// 项目流水线：扫描 data 目录 -> 导入 -> 初始化（提取音频、识别、对齐）-> 新录音导入
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, OUTPUT_DIR, ensureDir, rel } from './config.js';
import { rtfToText, parseScript } from './rtf.js';
import { probe, extractWav, encodeMp3, encodePreview, encodeFlac, toWhisperWav } from './media.js';
import { concatWavs, readWavInfo } from './wav.js';
import { transcribe, analyzeEnvelope } from './whisper.js';
import { alignProject, alignRecording, buildPrompt } from './align.js';
import * as store from './store.js';
import { withWhisperLock } from './jobs.js';
import { buildProxy, firstAudioPts } from './proxy.js';
import { findImageByReference, imageReferenceOrdinal, lastImageNumber } from '../../shared/imageReference.js';

export const MEDIA_RE = /\.(mov|mp4|m4v|avi|mkv|webm|3gp|mts|m4a|mp3|wav|aac|flac|ogg|opus|amr)$/i;
export const IMAGE_RE = /\.(jpe?g|png|webp|heic|heif)$/i;
export const SCRIPT_RE = /\.(rtf|txt|md)$/i;

const natural = (a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
export const imageNo = (f) => lastImageNumber(f);
const pad = (n) => String(n).padStart(3, '0');

export function safeName(s) {
  return String(s).replace(/[/\\:*?"<>|\u0000-\u001f]+/g, '_').trim() || 'untitled';
}

export function outputDir(project) {
  return ensureDir(path.join(OUTPUT_DIR, safeName(project.name)));
}

export const sourceWav = (id, src) => store.projectPath(id, 'sources', `${src}.wav`);
export const sourcePreview = (id, src) => store.projectPath(id, 'sources', `${src}.flac`);
export const sourceVideo = (id, src) => store.projectPath(id, 'sources', `${src}.video.mp4`);

// 合并预览视频需要的每段信息（音轨在容器里的起点 + 在音频时间轴上的位置）
async function proxyItems(folder, videos, fragments) {
  const items = [];
  for (let i = 0; i < fragments.length; i++) {
    const v = videos[i];
    const file = path.join(DATA_DIR, folder, v.file);
    const hasVideo = v.hasVideo ?? (await probe(file).catch(() => null))?.hasVideo;
    items.push({
      file: hasVideo ? file : null,
      audioStart: hasVideo ? await firstAudioPts(file) : 0,
      start: fragments[i].start,
      duration: fragments[i].end - fragments[i].start,
    });
  }
  return items;
}

export function scanFolder(folder) {
  const dir = path.join(DATA_DIR, folder);
  const files = fs.readdirSync(dir).filter((f) => !f.startsWith('.') && fs.statSync(path.join(dir, f)).isFile());
  const videos = files.filter((f) => MEDIA_RE.test(f)).sort(natural);
  const images = files
    .filter((f) => IMAGE_RE.test(f))
    .sort((a, b) => Number(imageNo(a)) - Number(imageNo(b)) || Number(/\.hei[cf]$/i.test(a)) - Number(/\.hei[cf]$/i.test(b)) || natural(a, b));
  const scripts = files.filter((f) => SCRIPT_RE.test(f));
  const script = scripts.find((f) => /zimu|字幕|文字|文稿|script/i.test(f)) || scripts[0] || null;
  return { videos, images, script, scripts };
}

// 文字稿的每一段配哪张图（导入确认弹窗里的预览用同样的规则，见 web/src/pages/importPlan.js）：
// #pic#引用 先按完整文件名逐层 fallback（后缀 / IMG_ 前缀 / _2 重复序号）；
// 再兼容旧版的末尾数字匹配；仍找不到且引用是有效序号时，当作「第几张图」（按确认后的图片顺序）；
// 没有标记的段落沿用上一页的图
export function mapScriptImages(parsed, images) {
  let lastImage = images[0] || null;
  return parsed.map((s) => {
    let image = lastImage;
    if (s.imageNo) {
      const k = imageReferenceOrdinal(s.imageNo);
      image = findImageByReference(s.imageNo, images) || (k >= 1 && k <= images.length ? images[k - 1] : null);
    }
    if (image) lastImage = image;
    return { ...s, image };
  });
}

function loadSegments(folder, script, images) {
  const parsed = script ? parseScript(rtfToText(fs.readFileSync(path.join(DATA_DIR, folder, script)))) : [];
  // 没有文字稿（或文字稿里没有内容）时：每张图一页，文字留空，可以在编辑器里补
  if (!parsed.length) {
    const list = images.length ? images : [null];
    return list.map((img, i) => ({ id: `s${i + 1}`, imageNo: img ? imageNo(img) : null, image: img, blocks: [] }));
  }
  return mapScriptImages(parsed, images).map((s, i) => ({ id: `s${i + 1}`, imageNo: s.imageNo, image: s.image, blocks: s.blocks }));
}

// 导入时在确认弹窗里改过文字 / 配图：直接按确认后的每一页生成（重新初始化也用它，不再重新解析文字稿）
export function cleanImportPages(pages, images) {
  if (!Array.isArray(pages) || !pages.length) return null;
  const out = [];
  for (const pg of pages) {
    const blocks = Array.isArray(pg?.blocks)
      ? pg.blocks
          .filter(Array.isArray)
          .map((b) => b.filter((l) => typeof l === 'string').map((l) => l.trim()).filter(Boolean))
          .filter((b) => b.length)
      : [];
    const image = typeof pg?.image === 'string' && images.includes(pg.image) ? pg.image : null;
    out.push({ blocks, image });
  }
  return out;
}
const segmentsFromPages = (pages) => pages.map((pg, i) => ({ id: `s${i + 1}`, imageNo: pg.image ? imageNo(pg.image) : null, image: pg.image, blocks: pg.blocks }));

// 按导入时确认的顺序排（order 里没有的文件放在后面，保持原来的顺序）
function applyOrder(list, want) {
  if (!Array.isArray(want) || !want.length) return list;
  const rank = new Map(want.map((f, i) => [f, i]));
  return list
    .map((f, i) => ({ f, r: rank.has(f) ? rank.get(f) : want.length + i }))
    .sort((a, b) => a.r - b.r)
    .map((x) => x.f);
}

async function scanMedia(folder, order) {
  const scanned = scanFolder(folder);
  const videos = applyOrder(scanned.videos, order?.videos);
  const images = applyOrder(scanned.images, order?.images);
  const script = order?.script && scanned.scripts.includes(order.script) ? order.script : scanned.script;
  const media = { videos: [], images, script };
  for (const v of videos) {
    try {
      const info = await probe(path.join(DATA_DIR, folder, v));
      if (info.hasAudio) media.videos.push({ file: v, duration: +info.duration.toFixed(3), hasVideo: info.hasVideo });
    } catch (e) {
      console.warn('probe failed', v, e.message);
    }
  }
  return media;
}

export async function importFolder(folder, { name, order, pages } = {}) {
  const dir = path.join(DATA_DIR, folder);
  if (!folder || folder.includes('..') || !fs.existsSync(dir)) throw Object.assign(new Error('目录不存在'), { status: 404 });
  const existing = store.listProjects().find((p) => p.folder === folder);
  if (existing) return existing;
  const media = await scanMedia(folder, order);
  if (!media.videos.length) throw Object.assign(new Error('目录里没有找到带音频的视频/音频文件'), { status: 400 });
  const importPages = cleanImportPages(pages, media.images);
  const project = {
    id: store.newId('p'),
    name: name || folder,
    folder,
    order: order || null,
    importPages,
    createdAt: Date.now(),
    status: 'new',
    error: null,
    media,
    segments: importPages ? segmentsFromPages(importPages) : loadSegments(folder, media.script, media.images),
    sources: {},
    edit: null,
    analysis: null,
    settings: store.getDefaults(),
    output: {},
  };
  store.saveProject(project);
  return project;
}

/** 初始化：提取并合并音频 -> 识别 -> 对齐 -> 生成初始剪辑 */
export async function initProject(id, { report, signal }) {
  const p0 = store.getProject(id);
  // 在临时目录里生成，成功后再替换，失败/取消不会破坏已有的剪辑
  const srcDir = store.projectPath(id, 'sources.tmp');
  const asrDir = store.projectPath(id, 'asr.tmp');
  fs.rmSync(srcDir, { recursive: true, force: true });
  fs.rmSync(asrDir, { recursive: true, force: true });
  ensureDir(srcDir);
  ensureDir(asrDir);
  const prevStatus = p0.status;
  store.updateProject(id, (q) => {
    q.status = 'processing';
    q.error = null;
  });
  try {
    report(0.01, '扫描素材');
    const media = await scanMedia(p0.folder, p0.order);
    if (!media.videos.length) throw new Error('没有找到带音频的视频');
    const importPages = cleanImportPages(p0.importPages, media.images);
    const segments = importPages ? segmentsFromPages(importPages) : loadSegments(p0.folder, media.script, media.images);

    const n = media.videos.length;
    const frag44 = [];
    const frag16 = [];
    for (let i = 0; i < n; i++) {
      if (signal.aborted) throw new Error('已取消');
      report(0.02 + (0.2 * i) / n, `提取音频 ${i + 1}/${n}`);
      const w44 = path.join(srcDir, `frag-${pad(i + 1)}.wav`);
      const w16 = path.join(asrDir, `frag-${pad(i + 1)}.wav`);
      await extractWav(path.join(DATA_DIR, p0.folder, media.videos[i].file), w44);
      await toWhisperWav(w44, w16);
      frag44.push(w44);
      frag16.push(w16);
    }
    report(0.23, '合并音频');
    const mainWav = path.join(srcDir, 'main.wav');
    const { duration, spans } = concatWavs(frag44, mainWav);
    const main16k = path.join(asrDir, 'main16k.wav');
    concatWavs(frag16, main16k);
    frag44.forEach((f) => fs.rmSync(f, { force: true }));
    const fragments = spans.map((s, i) => ({ file: media.videos[i].file, start: +s.start.toFixed(3), end: +s.end.toFixed(3) }));

    report(0.26, '生成预览音频');
    await encodePreview(mainWav, path.join(srcDir, 'main.flac'));
    report(0.29, '导出原始音频 MP3');
    const originalMp3 = path.join(outputDir(p0), `${safeName(p0.name)}-原始音频.mp3`);
    await encodeMp3(mainWav, originalMp3, '320k');

    // 原始视频预览和语音识别并行（一个吃 GPU，一个主要是视频解码）
    let proxyDone = false;
    const proxyPromise = proxyItems(p0.folder, media.videos, fragments)
      .then((items) => buildProxy(items, path.join(srcDir, 'main.video.mp4'), { workDir: path.join(srcDir, 'vtmp'), signal }))
      .catch((e) => {
        console.warn('原始视频预览生成失败：', e.message);
        return null;
      })
      .finally(() => (proxyDone = true));

    report(0.32, '语音识别准备中');
    const items = frag16.map((f, i) => ({ wav16k: f, offset: spans[i].start, duration: spans[i].end - spans[i].start }));
    const tr = await withWhisperLock(() =>
      transcribe(items, {
        language: p0.settings.asr?.language || 'auto',
        prompt: buildPrompt(segments, p0.name),
        signal,
        onProgress: (f) => report(0.32 + 0.6 * f, `语音识别 ${Math.round(f * 100)}%`),
      }),
    );

    if (!proxyDone) report(0.92, '生成原始视频预览');
    const proxy = await proxyPromise;
    fs.rmSync(path.join(srcDir, 'vtmp'), { recursive: true, force: true });

    report(0.93, '文字与音频对齐');
    const envInfo = analyzeEnvelope(main16k);
    const al = alignProject({ segments, words: tr.words, duration, fragments, envInfo });
    if (signal.aborted) throw new Error('已取消');

    // 生成成功：替换正式目录（旧的新录音也随之清空，因为剪辑会重置）
    for (const [tmp, final] of [
      [srcDir, store.projectPath(id, 'sources')],
      [asrDir, store.projectPath(id, 'asr')],
    ]) {
      fs.rmSync(final, { recursive: true, force: true });
      fs.renameSync(tmp, final);
    }
    fs.rmSync(store.projectPath(id, 'uploads'), { recursive: true, force: true });
    store.writeData(id, 'transcript.json', { main: tr });
    store.writeData(id, 'align.json', al);

    const conf = al.confidence.filter((c) => c != null);
    store.updateProject(id, (q) => {
      q.media = media;
      q.segments = segments;
      q.sources = {
        main: { id: 'main', kind: 'main', name: '原始录音', duration, fragments, video: proxy, createdAt: Date.now() },
      };
      q.edit = {
        rev: 1,
        items: [{ id: 'c1', kind: 'keep', src: 'main', in: 0, out: duration }],
        clips: [{ id: 'c1', src: 'main', in: 0, out: duration }],
        pages: segments.map((s, i) => ({ seg: s.id, start: al.pageStarts[i] })),
        dismissed: [],
      };
      q.analysis = {
        language: tr.language,
        lag: tr.lag,
        model: tr.model,
        words: tr.words.length,
        suggestions: al.suggestions.length,
        confidence: conf.length ? +(conf.reduce((a, b) => a + b, 0) / conf.length).toFixed(2) : null,
      };
      q.output = { ...(q.output || {}), original: rel(originalMp3) };
      q.status = 'ready';
      q.initializedAt = Date.now();
    });
    report(1, '完成');
  } catch (err) {
    fs.rmSync(srcDir, { recursive: true, force: true });
    fs.rmSync(asrDir, { recursive: true, force: true });
    store.updateProject(id, (q) => {
      // 之前已经初始化过的项目保持可编辑，只提示错误
      q.status = q.edit && prevStatus === 'ready' ? 'ready' : 'error';
      q.error = err.message;
    });
    throw err;
  }
}

/** 插入空白用的静音音源：整个项目共用一段 60 秒的静音，每次插入只取其中需要的长度 */
export const SILENCE_ID = 'silence';
const SILENCE_SECONDS = 60;
export async function ensureSilenceSource(id) {
  const p = store.getProject(id);
  if (!p?.edit) throw Object.assign(new Error('项目还没有初始化'), { status: 400 });
  const wav = sourceWav(id, SILENCE_ID);
  const preview = sourcePreview(id, SILENCE_ID);
  if (p.sources[SILENCE_ID] && fs.existsSync(wav) && fs.existsSync(preview)) return p.sources[SILENCE_ID];
  // 和其他音源一样：44.1kHz、双声道、16 位
  const rate = 44100;
  const channels = 2;
  const dataBytes = SILENCE_SECONDS * rate * channels * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);
  ensureDir(path.dirname(wav));
  fs.writeFileSync(wav, Buffer.concat([header, Buffer.alloc(dataBytes)]));
  await encodePreview(wav, preview);
  const source = { id: SILENCE_ID, kind: 'silence', name: '空白', duration: SILENCE_SECONDS, createdAt: Date.now() };
  store.updateProject(id, (q) => {
    q.sources[SILENCE_ID] = source;
  });
  return source;
}

// ---------- 修改记录导出 / 导入（JSON）----------
export const RECORDS_TYPE = 'huiben-edit-records';

/** 导出：修改记录 + 用到的补录（无损 FLAC，base64），换台电脑重新导入绘本后也能用 */
export async function exportRecords(id) {
  const p = store.getProject(id);
  if (!p?.edit) throw Object.assign(new Error('项目还没有初始化'), { status: 400 });
  const ops = p.edit.ops || [];
  const used = new Set();
  for (const o of ops) {
    if (o.rec?.src) used.add(o.rec.src);
    for (const r of o.ranges || []) if (r.src !== 'main') used.add(r.src);
  }
  const transcript = store.readData(id, 'transcript.json', {});
  const sources = {};
  for (const sid of used) {
    const src = p.sources[sid];
    if (!src) continue;
    if (src.kind === 'silence') {
      sources[sid] = { kind: 'silence' };
      continue;
    }
    const tmp = store.projectPath(id, 'cache', `export-${sid}.flac`);
    ensureDir(path.dirname(tmp));
    await encodeFlac(sourceWav(id, sid), tmp);
    sources[sid] = {
      kind: 'recording',
      name: src.name,
      duration: src.duration,
      suggestedIn: src.suggestedIn,
      suggestedOut: src.suggestedOut,
      words: transcript[sid]?.words || [],
      wordState: transcript[sid]?.wordState || '',
      language: transcript[sid]?.language || null,
      audio: { format: 'flac', base64: fs.readFileSync(tmp).toString('base64') },
    };
    fs.rmSync(tmp, { force: true });
  }
  return {
    type: RECORDS_TYPE,
    version: 1,
    exportedAt: Date.now(),
    project: {
      name: p.name,
      mainDuration: p.sources.main?.duration ?? null,
      pages: p.segments.length,
      segments: p.segments.map((s) => s.id),
    },
    base: p.edit.base || null,
    ops,
    sources,
  };
}

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** 导入：恢复里面的补录（这台电脑上已有的直接用），把修改记录里的音源 id 换成新的 */
export async function importRecords(id, data) {
  const p = store.getProject(id);
  if (!p?.edit) throw Object.assign(new Error('项目还没有初始化'), { status: 400 });
  if (data?.type !== RECORDS_TYPE || !Array.isArray(data.ops)) throw Object.assign(new Error('这不是修改记录文件'), { status: 400 });
  const idMap = { main: 'main' };
  const added = {};
  const words = {};
  for (const [sid, src] of Object.entries(data.sources || {})) {
    if (src?.kind === 'silence') {
      const s = await ensureSilenceSource(id);
      idMap[sid] = s.id;
      added[s.id] = s;
      continue;
    }
    const mine = p.sources[sid];
    if (mine?.kind === 'recording' && Math.abs(mine.duration - num(src?.duration, -1)) < 0.05) {
      idMap[sid] = sid; // 同一台电脑、同一个项目：录音还在
      continue;
    }
    if (!src?.audio?.base64) continue;
    const tmp = store.projectPath(id, 'cache', `import-${Date.now()}-${sid}.flac`);
    ensureDir(path.dirname(tmp));
    fs.writeFileSync(tmp, Buffer.from(src.audio.base64, 'base64'));
    try {
      const rid = store.newId('r');
      const wav = sourceWav(id, rid);
      await extractWav(tmp, wav);
      const info = readWavInfo(wav);
      await encodePreview(wav, sourcePreview(id, rid));
      const source = {
        id: rid,
        kind: 'recording',
        name: String(src.name || '导入的录音'),
        duration: info.duration,
        createdAt: Date.now(),
        suggestedIn: num(src.suggestedIn, 0),
        suggestedOut: num(src.suggestedOut, info.duration),
        coversSegments: [],
        video: null,
      };
      const tr = {
        words: Array.isArray(src.words) ? src.words : [],
        wordState: typeof src.wordState === 'string' ? src.wordState : '',
        language: src.language || null,
      };
      const transcript = store.readData(id, 'transcript.json', {});
      transcript[rid] = tr;
      store.writeData(id, 'transcript.json', transcript);
      store.updateProject(id, (q) => {
        q.sources[rid] = source;
      });
      idMap[sid] = rid;
      added[rid] = source;
      words[rid] = { words: tr.words, state: tr.wordState };
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  // 换音源 id；用到的录音没法恢复的记录跳过
  const ops = [];
  let dropped = 0;
  for (const o of data.ops) {
    if (!o || typeof o.id !== 'string' || !['cut', 'insert', 'replace', 'page'].includes(o.type)) {
      dropped++;
      continue;
    }
    const op = { ...o, time: num(o.time, Date.now()), applied: o.applied !== false };
    delete op.hidden;
    if (op.rec) {
      if (!idMap[op.rec.src]) {
        dropped++;
        continue;
      }
      op.rec = { ...op.rec, src: idMap[op.rec.src] };
    }
    if (op.ranges) {
      op.ranges = op.ranges.filter((r) => idMap[r.src]).map((r) => ({ ...r, src: idMap[r.src] }));
      if (!op.ranges.length) {
        dropped++;
        continue;
      }
    }
    if (op.type === 'page' && !(op.page > 0 && op.page < p.segments.length)) {
      dropped++;
      continue;
    }
    ops.push(op);
  }
  return { ops, sources: added, words, dropped };
}

/** 删掉一段没有用上的补录（现场录音录完没用、重新录时） */
export function removeRecording(id, rid) {
  const p = store.getProject(id);
  const src = p?.sources?.[rid];
  if (!src || src.kind !== 'recording') throw Object.assign(new Error('录音不存在'), { status: 404 });
  const used = (p.edit?.ops || []).some((o) => o.rec?.src === rid) || (p.edit?.items || []).some((it) => it.src === rid);
  if (used) throw Object.assign(new Error('这段录音已经用在剪辑里了'), { status: 409 });
  for (const f of [sourceWav(id, rid), sourcePreview(id, rid), sourceVideo(id, rid), store.projectPath(id, 'asr', `${rid}.wav`)]) {
    fs.rmSync(f, { force: true });
  }
  const upDir = store.projectPath(id, 'uploads');
  if (fs.existsSync(upDir)) for (const f of fs.readdirSync(upDir)) if (f.startsWith(`${rid}.`)) fs.rmSync(path.join(upDir, f), { force: true });
  const transcript = store.readData(id, 'transcript.json', {});
  delete transcript[rid];
  store.writeData(id, 'transcript.json', transcript);
  store.updateProject(id, (q) => {
    delete q.sources[rid];
  });
}

/** 导入一段新录音（视频或音频），识别后返回音源信息 */
export async function addRecording(id, uploadPath, originalName) {
  const p = store.getProject(id);
  if (!p?.edit) throw Object.assign(new Error('项目还没有初始化'), { status: 400 });
  const rid = store.newId('r');
  const wav = sourceWav(id, rid);
  try {
    await extractWav(uploadPath, wav);
  } catch (e) {
    throw Object.assign(new Error(`无法读取这个文件的音频：${e.message.split('\n')[0]}`), { status: 400 });
  }
  const info = readWavInfo(wav);
  const media = await probe(uploadPath).catch(() => null);
  if (info.duration < 0.3) {
    fs.rmSync(wav, { force: true });
    throw Object.assign(new Error('录音太短了'), { status: 400 });
  }
  await encodePreview(wav, sourcePreview(id, rid));
  const w16 = store.projectPath(id, 'asr', `${rid}.wav`);
  await toWhisperWav(wav, w16);
  const tr = await withWhisperLock(() =>
    transcribe([{ wav16k: w16, offset: 0, duration: info.duration }], {
      language: p.analysis?.language || p.settings.asr?.language || 'auto',
      prompt: buildPrompt(p.segments, p.name),
    }),
  );
  const al = alignRecording({ segments: p.segments, words: tr.words });
  let video = null;
  if (media?.hasVideo) {
    video = await buildProxy(
      [{ file: uploadPath, audioStart: await firstAudioPts(uploadPath), start: 0, duration: info.duration }],
      sourceVideo(id, rid),
      { workDir: store.projectPath(id, 'sources', `${rid}-vtmp`) },
    ).catch((e) => {
      console.warn('补录视频预览生成失败：', e.message);
      return null;
    });
    fs.rmSync(store.projectPath(id, 'sources', `${rid}-vtmp`), { recursive: true, force: true });
  }
  const first = tr.words[0];
  const last = tr.words[tr.words.length - 1];
  const source = {
    id: rid,
    kind: 'recording',
    name: originalName || '新录音',
    duration: info.duration,
    createdAt: Date.now(),
    suggestedIn: first ? +Math.max(0, first.t0 - 0.3).toFixed(3) : 0,
    suggestedOut: last ? +Math.min(info.duration, last.t1 + 0.45).toFixed(3) : info.duration,
    coversSegments: al.segments,
    video,
  };
  const transcript = store.readData(id, 'transcript.json', {});
  transcript[rid] = { ...tr, wordState: al.wordState };
  store.writeData(id, 'transcript.json', transcript);
  store.updateProject(id, (q) => {
    q.sources[rid] = source;
  });
  const keep = store.projectPath(id, 'uploads', `${rid}${path.extname(originalName || '') || '.bin'}`);
  ensureDir(path.dirname(keep));
  fs.renameSync(uploadPath, keep);
  return { source, transcript: { words: tr.words, wordState: al.wordState, language: tr.language } };
}

/** 给已初始化的项目补生成原始视频预览 */
export async function ensureProxy(id, { report, signal }) {
  const p = store.getProject(id);
  const main = p?.sources?.main;
  if (!main?.fragments) throw new Error('项目还没有初始化');
  report(0.02, '准备原始视频');
  const items = await proxyItems(p.folder, p.media.videos, main.fragments);
  const video = await buildProxy(items, sourceVideo(id, 'main'), {
    workDir: store.projectPath(id, 'sources', 'vtmp'),
    signal,
    onProgress: (f) => report(0.05 + f * 0.93, `生成原始视频预览 ${Math.round(f * 100)}%`),
  });
  fs.rmSync(store.projectPath(id, 'sources', 'vtmp'), { recursive: true, force: true });

  // 之前上传的补录如果是视频，也补上预览
  const recVideos = {};
  for (const src of Object.values(p.sources)) {
    if (src.kind !== 'recording' || src.video) continue;
    const upDir = store.projectPath(id, 'uploads');
    const file = fs.existsSync(upDir) && fs.readdirSync(upDir).find((f) => f.startsWith(`${src.id}.`));
    if (!file) continue;
    const full = path.join(upDir, file);
    if (!(await probe(full).catch(() => null))?.hasVideo) continue;
    const tmp = store.projectPath(id, 'sources', `${src.id}-vtmp`);
    recVideos[src.id] = await buildProxy(
      [{ file: full, audioStart: await firstAudioPts(full), start: 0, duration: src.duration }],
      sourceVideo(id, src.id),
      { workDir: tmp, signal },
    ).catch(() => null);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  store.updateProject(id, (q) => {
    if (q.sources?.main) q.sources.main.video = video;
    for (const [rid, v] of Object.entries(recVideos)) if (v && q.sources[rid]) q.sources[rid].video = v;
  });
  report(1, '完成');
  return video;
}

/** 编辑器需要的分析数据：每个音源的词 + 匹配状态 + 建议 */
export function analysisFor(id) {
  const transcript = store.readData(id, 'transcript.json', {});
  const al = store.readData(id, 'align.json', null);
  const sources = {};
  for (const [sid, tr] of Object.entries(transcript)) {
    sources[sid] = {
      words: tr.words,
      wordState: sid === 'main' ? al?.wordState || '' : tr.wordState || '',
      language: tr.language,
    };
  }
  return {
    sources,
    suggestions: al?.suggestions || [],
    confidence: al?.confidence || [],
    lineTimes: al?.lineTimes || [],
    pageStarts: al?.pageStarts || [],
  };
}

/** 合成所需的每页素材 */
export function pageAssets(p) {
  return p.segments.map((s) => ({
    id: s.id,
    photo: s.image ? path.join(DATA_DIR, p.folder, s.image) : null,
    blocks: s.blocks,
  }));
}
