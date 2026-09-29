// 基于文件的项目存储：workspace/<id>/project.json（本地单用户，不需要数据库）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WORK_DIR, ensureDir } from './config.js';
import { DEFAULT_SETTINGS, mergeSettings } from './settings.js';

ensureDir(WORK_DIR);

export const projectDir = (id) => path.join(WORK_DIR, id);
export const projectPath = (id, ...p) => path.join(WORK_DIR, id, ...p);

export function newId(prefix) {
  return `${prefix}${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
}

function writeJsonAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

function readJsonFile(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function listProjects() {
  if (!fs.existsSync(WORK_DIR)) return [];
  return fs
    .readdirSync(WORK_DIR)
    .map((id) => readJsonFile(path.join(WORK_DIR, id, 'project.json')))
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function getProject(id) {
  if (!/^[\w-]+$/.test(id)) return null;
  const p = readJsonFile(projectPath(id, 'project.json'));
  if (p) p.settings = mergeSettings(DEFAULT_SETTINGS, p.settings);
  return p;
}

export function saveProject(p) {
  p.updatedAt = Date.now();
  writeJsonAtomic(projectPath(p.id, 'project.json'), p);
  return p;
}

// 读-改-写，避免并发请求互相覆盖（单进程内同步执行即可保证原子）
export function updateProject(id, fn) {
  const p = getProject(id);
  if (!p) throw Object.assign(new Error('项目不存在'), { status: 404 });
  const r = fn(p);
  saveProject(p);
  return r === undefined ? p : r;
}

export function deleteProject(id) {
  if (!/^[\w-]+$/.test(id)) return;
  fs.rmSync(projectDir(id), { recursive: true, force: true });
}

export function readData(id, name, fallback = null) {
  return readJsonFile(projectPath(id, name), fallback);
}

export function writeData(id, name, data) {
  writeJsonAtomic(projectPath(id, name), data);
}

const DEFAULTS_FILE = path.join(WORK_DIR, 'defaults.json');

export function getDefaults() {
  return mergeSettings(DEFAULT_SETTINGS, readJsonFile(DEFAULTS_FILE, {}));
}

export function setDefaults(settings) {
  writeJsonAtomic(DEFAULTS_FILE, settings);
}
