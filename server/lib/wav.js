// PCM WAV 读写工具。所有中间音源统一为 44.1kHz / 立体声 / s16le，
// 剪辑拼接直接在 Node 里按采样切片完成（采样级精确，不经过有损重编码）。
import fs from 'node:fs';

export function readWavInfo(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(12);
    fs.readSync(fd, head, 0, 12, 0);
    if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error(`不是 WAV 文件: ${file}`);
    }
    const size = fs.fstatSync(fd).size;
    let pos = 12;
    let fmt = null;
    const hdr = Buffer.alloc(8);
    while (pos + 8 <= size) {
      fs.readSync(fd, hdr, 0, 8, pos);
      const id = hdr.toString('ascii', 0, 4);
      let len = hdr.readUInt32LE(4);
      if (id === 'fmt ') {
        const b = Buffer.alloc(Math.min(len, 40));
        fs.readSync(fd, b, 0, b.length, pos + 8);
        fmt = {
          format: b.readUInt16LE(0),
          channels: b.readUInt16LE(2),
          sampleRate: b.readUInt32LE(4),
          blockAlign: b.readUInt16LE(12),
          bits: b.readUInt16LE(14),
        };
      } else if (id === 'data') {
        if (!fmt) throw new Error('WAV 缺少 fmt 块');
        if (len === 0xffffffff || pos + 8 + len > size) len = size - pos - 8;
        const frames = Math.floor(len / fmt.blockAlign);
        return { ...fmt, dataOffset: pos + 8, dataSize: len, frames, duration: frames / fmt.sampleRate };
      }
      pos += 8 + len + (len & 1);
    }
    throw new Error('WAV 缺少 data 块');
  } finally {
    fs.closeSync(fd);
  }
}

function header({ sampleRate, channels, bits = 16 }, dataSize) {
  const b = Buffer.alloc(44);
  const blockAlign = (channels * bits) / 8;
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + dataSize, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * blockAlign, 28);
  b.writeUInt16LE(blockAlign, 32);
  b.writeUInt16LE(bits, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(dataSize, 40);
  return b;
}

class WavWriter {
  constructor(file, fmt) {
    this.fd = fs.openSync(file, 'w');
    this.fmt = fmt;
    this.size = 0;
    fs.writeSync(this.fd, header(fmt, 0));
  }
  write(buf) {
    fs.writeSync(this.fd, buf, 0, buf.length, 44 + this.size);
    this.size += buf.length;
  }
  close() {
    fs.writeSync(this.fd, header(this.fmt, this.size), 0, 44, 0);
    fs.closeSync(this.fd);
    return this.size;
  }
}

const CHUNK_FRAMES = 44100 * 4;

function copyRange(writer, file, info, fromFrame, toFrame, fadeFrames) {
  const fd = fs.openSync(file, 'r');
  try {
    const { blockAlign, channels } = info;
    const total = toFrame - fromFrame;
    const fade = Math.min(fadeFrames, Math.floor(total / 2));
    for (let f = fromFrame; f < toFrame; f += CHUNK_FRAMES) {
      const n = Math.min(CHUNK_FRAMES, toFrame - f);
      const buf = Buffer.alloc(n * blockAlign);
      fs.readSync(fd, buf, 0, buf.length, info.dataOffset + f * blockAlign);
      if (fade > 0) {
        // 片段首尾做极短淡入淡出，避免剪切点爆音
        for (let k = 0; k < n; k++) {
          const idx = f - fromFrame + k;
          let g = 1;
          if (idx < fade) g = idx / fade;
          else if (idx >= total - fade) g = (total - idx) / fade;
          else continue;
          for (let c = 0; c < channels; c++) {
            const o = k * blockAlign + c * 2;
            buf.writeInt16LE(Math.round(buf.readInt16LE(o) * g), o);
          }
        }
      }
      writer.write(buf);
    }
  } finally {
    fs.closeSync(fd);
  }
}

// 拼接多个同格式 WAV，返回每段在结果中的起止时间
export function concatWavs(files, out) {
  const infos = files.map(readWavInfo);
  const fmt = { sampleRate: infos[0].sampleRate, channels: infos[0].channels, bits: 16 };
  for (const inf of infos) {
    if (inf.sampleRate !== fmt.sampleRate || inf.channels !== fmt.channels || inf.bits !== 16) {
      throw new Error('待拼接的 WAV 格式不一致');
    }
  }
  const w = new WavWriter(out, fmt);
  const spans = [];
  let t = 0;
  files.forEach((f, i) => {
    copyRange(w, f, infos[i], 0, infos[i].frames, 0);
    spans.push({ start: t, end: t + infos[i].duration });
    t += infos[i].duration;
  });
  w.close();
  return { duration: t, spans };
}

// 按剪辑列表渲染：clips = [{ file, in, out }]（秒）
export function renderClips(clips, out, { fadeMs = 5 } = {}) {
  if (!clips.length) throw new Error('没有可用的音频片段');
  const infos = new Map();
  const info = (f) => {
    if (!infos.has(f)) infos.set(f, readWavInfo(f));
    return infos.get(f);
  };
  const first = info(clips[0].file);
  const fmt = { sampleRate: first.sampleRate, channels: first.channels, bits: 16 };
  const w = new WavWriter(out, fmt);
  let frames = 0;
  for (const c of clips) {
    const inf = info(c.file);
    if (inf.sampleRate !== fmt.sampleRate || inf.channels !== fmt.channels) throw new Error('音源格式不一致');
    const a = Math.max(0, Math.round(c.in * inf.sampleRate));
    const b = Math.min(inf.frames, Math.round(c.out * inf.sampleRate));
    if (b <= a) continue;
    copyRange(w, c.file, inf, a, b, Math.round((fadeMs / 1000) * inf.sampleRate));
    frames += b - a;
  }
  w.close();
  return { duration: frames / fmt.sampleRate };
}

// 16k 单声道 WAV -> 每 10ms 一帧的 RMS 能量包络
export function envelope(file16k, frameMs = 10) {
  const inf = readWavInfo(file16k);
  const buf = fs.readFileSync(file16k).subarray(inf.dataOffset, inf.dataOffset + inf.dataSize);
  const pcm = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
  const step = Math.round((inf.sampleRate * frameMs) / 1000) * inf.channels;
  const n = Math.floor(pcm.length / step);
  const env = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0;
    const o = f * step;
    for (let k = 0; k < step; k++) s += pcm[o + k] * pcm[o + k];
    env[f] = Math.sqrt(s / step);
  }
  return { env, fps: 1000 / frameMs, duration: inf.duration };
}
