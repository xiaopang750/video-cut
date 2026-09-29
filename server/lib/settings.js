// 合成与输出的默认参数。文字、水印的尺寸以「参考图 750px 宽」为单位（doc/pic.png 实测），
// 实际绘制时按 输出宽度/750 缩放。
// 画面固定 3:4、750×1000（和参考图 doc/pic.png 完全一致），合成图、视频、PDF 都用这个尺寸
export const LAYOUT_PRESETS = {
  '3:4': { width: 750, height: 1000 },
};

export const DEFAULT_SETTINGS = {
  layout: {
    preset: '3:4',
    photoRatio: 0.6933, // 照片高度 = 宽度 × 比例（参考图 520/750）
    photoFit: 'cover', // cover 裁切铺满 | contain 完整显示
    photoFocus: 'centre', // centre | top | bottom
    background: '#F2F1EA',
  },
  text: {
    fontFamily: 'PingFang SC',
    color: '#000000',
    scale: 1,
    enSize: 23,
    zhSize: 22,
    linePitch: 31,
    blockGap: 11,
  },
  watermark: {
    enabled: true,
    title: '2_100本绘本精读',
    highlight: '100',
    highlightColor: '#40A053',
    subtitle: 'PDF 38.30MB',
    icon: 'pdf',
  },
  video: {
    fps: 30,
    transition: 'fade', // none | fade
    transitionDuration: 0.3,
    crf: 20,
    audioBitrate: '256k',
    loudnorm: false,
  },
  pdf: {
    mode: 'long', // long 整本拼成一张长图 | pages 一图一页
  },
  asr: {
    language: 'auto', // auto | en | zh
  },
};

function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

export function mergeSettings(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = isObj(v) && isObj(base[k]) ? mergeSettings(base[k], v) : v;
  }
  return out;
}

export function resolveSize() {
  return { ...LAYOUT_PRESETS['3:4'] };
}
