// 从浏览器上传整个绘本文件夹：先逐个文件传到 data/.upload-xxx（隐藏目录），
// 全部传完再改名成 data/<绘本名>，然后照常导入。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, ensureDir } from './config.js';
import { MEDIA_RE, IMAGE_RE, SCRIPT_RE } from './project.js';

const STAGE_PREFIX = '.upload-';
const stages = new Map(); // uid -> { dir, name, files, bytes, startedAt }

const cleanName = (s) =>
  String(s || '')
    .replace(/[/\\:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 80);

export const acceptedFile = (name) => MEDIA_RE.test(name) || IMAGE_RE.test(name) || SCRIPT_RE.test(name);

function moveFile(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.copyFileSync(from, to);
    fs.rmSync(from, { force: true });
  }
}

// 启动时清掉上次没传完的临时目录
export function cleanStaleUploads() {
  if (!fs.existsSync(DATA_DIR)) return;
  for (const d of fs.readdirSync(DATA_DIR)) {
    if (d.startsWith(STAGE_PREFIX)) fs.rmSync(path.join(DATA_DIR, d), { recursive: true, force: true });
  }
}

export function startUpload(name) {
  const uid = crypto.randomBytes(6).toString('hex');
  const dir = ensureDir(path.join(DATA_DIR, `${STAGE_PREFIX}${uid}`));
  stages.set(uid, { dir, name: cleanName(name) || '绘本', files: 0, startedAt: Date.now() });
  return { uid };
}

function mustStage(uid) {
  const st = stages.get(uid);
  if (!st) throw Object.assign(new Error('上传已失效，请重新选择文件夹'), { status: 404 });
  return st;
}

export function addUploadFile(uid, tmpPath, originalName) {
  const st = mustStage(uid);
  const base = cleanName(path.basename(originalName || ''));
  if (!base || !acceptedFile(base)) {
    fs.rmSync(tmpPath, { force: true });
    throw Object.assign(new Error(`不支持的文件：${originalName}`), { status: 400 });
  }
  moveFile(tmpPath, path.join(st.dir, base));
  st.files++;
  // 返回实际保存的文件名（特殊字符会被替换），导入时按它记顺序
  return { ok: true, file: base };
}

// 传完：改名成 data/<绘本名>（重名时加序号），返回最终的目录名
export function finishUpload(uid, name) {
  const st = mustStage(uid);
  if (!st.files) throw Object.assign(new Error('没有收到任何文件'), { status: 400 });
  const want = cleanName(name) || st.name;
  let folder = want;
  for (let k = 2; fs.existsSync(path.join(DATA_DIR, folder)); k++) folder = `${want} (${k})`;
  fs.renameSync(st.dir, path.join(DATA_DIR, folder));
  stages.delete(uid);
  return folder;
}

export function cancelUpload(uid) {
  const st = stages.get(uid);
  if (!st) return;
  fs.rmSync(st.dir, { recursive: true, force: true });
  stages.delete(uid);
}
