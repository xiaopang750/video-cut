import { spawn } from 'node:child_process';
import { FFMPEG, AUDIO_RATE, AUDIO_CHANNELS } from './config.js';
import { run } from './proc.js';

const BASE = ['-nostdin', '-hide_banner', '-y', '-v', 'error'];

// 读取时长与音视频流信息：直接解析 `ffmpeg -i` 的输出（省掉体积很大的 ffprobe 依赖）
export function probe(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ['-nostdin', '-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', () => {
      const dur = err.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!dur) return reject(new Error(`无法读取媒体信息: ${err.trim().split('\n').pop()}`));
      const audioLine = err.match(/Stream #\d+:\d+.*?: Audio: ([^\n]+)/);
      const videoLine = [...err.matchAll(/Stream #\d+:\d+.*?: Video: ([^\n]+)/g)].find((m) => !/attached pic/.test(m[1]));
      const size = videoLine?.[1].match(/, (\d{2,5})x(\d{2,5})/);
      resolve({
        duration: Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]),
        hasAudio: Boolean(audioLine),
        hasVideo: Boolean(videoLine),
        audio: audioLine && {
          codec: audioLine[1].split(/[ ,]/)[0],
          sampleRate: Number((audioLine[1].match(/(\d+) Hz/) || [])[1]) || null,
        },
        video: videoLine && { codec: videoLine[1].split(/[ ,]/)[0], width: Number(size?.[1]) || null, height: Number(size?.[2]) || null },
      });
    });
  });
}

// 任意音视频 -> 统一格式 PCM WAV（无损中间格式）
export async function extractWav(input, out) {
  await run(FFMPEG, [
    ...BASE, '-i', input, '-vn', '-sn', '-dn',
    '-ac', String(AUDIO_CHANNELS), '-ar', String(AUDIO_RATE), '-c:a', 'pcm_s16le',
    '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact', out,
  ]);
}

// 高码率 MP3（尽量保留原音质）
export async function encodeMp3(inWav, out, bitrate = '320k') {
  await run(FFMPEG, [...BASE, '-i', inWav, '-c:a', 'libmp3lame', '-b:a', bitrate, '-id3v2_version', '3', out]);
}

// 浏览器预览用：单声道无损 FLAC，时间轴与 WAV 采样级一致（MP3 会引入编码延迟）
export async function encodePreview(inWav, out) {
  await run(FFMPEG, [...BASE, '-i', inWav, '-ac', '1', '-c:a', 'flac', '-compression_level', '5', out]);
}

// 导出修改记录时把补录打包进 JSON：无损 FLAC，保留声道
export async function encodeFlac(inWav, out) {
  await run(FFMPEG, [...BASE, '-i', inWav, '-c:a', 'flac', '-compression_level', '8', out]);
}

// whisper 需要 16k 单声道
export async function toWhisperWav(inWav, out) {
  await run(FFMPEG, [...BASE, '-i', inWav, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-fflags', '+bitexact', out]);
}

export function parseFfTime(s) {
  const m = /(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s || '');
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}
