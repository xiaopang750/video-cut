// 路径与外部工具定位。所有依赖都优先使用项目目录内的版本，方便整体拷贝到其他机器。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DATA_DIR = path.join(ROOT, 'data');
export const WORK_DIR = path.join(ROOT, 'workspace');
export const OUTPUT_DIR = path.join(ROOT, 'output');
export const VENDOR_DIR = path.join(ROOT, 'vendor');
export const WEB_DIST = path.join(ROOT, 'web', 'dist');
export const PORT = Number(process.env.PORT || 3031);

// 统一的中间音频格式：所有音源都转成这个格式，剪辑时可以直接按采样拼接
export const AUDIO_RATE = 44100;
export const AUDIO_CHANNELS = 2;

function firstExisting(candidates) {
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

function tryRequire(name) {
  try {
    return require(name);
  } catch {
    return null;
  }
}

export const FFMPEG =
  firstExisting([process.env.FFMPEG_PATH, path.join(VENDOR_DIR, 'bin', 'ffmpeg'), tryRequire('ffmpeg-static')]) ||
  'ffmpeg';

export const WHISPER_BIN = firstExisting([process.env.WHISPER_BIN, path.join(VENDOR_DIR, 'bin', 'whisper-cli')]);

const MODEL_DIR = path.join(VENDOR_DIR, 'models');
// 按优先级挑选模型：large-v3-turbo 在 Apple Silicon 上又快又准
const MODEL_PREFERENCE = [
  'ggml-large-v3-turbo.bin',
  'ggml-large-v3-turbo-q8_0.bin',
  'ggml-large-v3-turbo-q5_0.bin',
  'ggml-large-v3.bin',
  'ggml-large-v3-q5_0.bin',
  'ggml-medium.bin',
  'ggml-small.bin',
  'ggml-base.bin',
];

export function whisperModel() {
  if (process.env.WHISPER_MODEL && fs.existsSync(process.env.WHISPER_MODEL)) return process.env.WHISPER_MODEL;
  for (const name of MODEL_PREFERENCE) {
    const p = path.join(MODEL_DIR, name);
    if (fs.existsSync(p)) return p;
  }
  if (!fs.existsSync(MODEL_DIR)) return null;
  const any = fs.readdirSync(MODEL_DIR).find((f) => /^ggml-(?!silero).*\.bin$/.test(f));
  return any ? path.join(MODEL_DIR, any) : null;
}

// whisper.cpp 的 DTW 预设名与模型对应，例如 ggml-large-v3-turbo-q5_0.bin -> large.v3.turbo
export function dtwPresetFor(modelPath) {
  const m = path.basename(modelPath || '').match(/^ggml-(tiny|base|small|medium|large-v1|large-v2|large-v3-turbo|large-v3)(\.en)?/);
  if (!m) return null;
  return m[1].replace(/-/g, '.') + (m[2] || '');
}

export function toolStatus() {
  const model = whisperModel();
  return {
    ffmpeg: FFMPEG,
    whisper: WHISPER_BIN,
    model: model ? path.basename(model) : null,
    ready: Boolean(WHISPER_BIN && model),
  };
}

export function rel(p) {
  return path.relative(ROOT, p);
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
