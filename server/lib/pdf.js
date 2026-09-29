// 导出 PDF：把合成好的每一页按顺序拼起来。
// long：整本拼成一张长页（代表整个故事）；pages：一图一页。
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { rel } from './config.js';
import { composePage } from './compose.js';
import { resolveSize } from './settings.js';
import * as store from './store.js';
import { outputDir, safeName, pageAssets } from './project.js';

// Acrobat 对单页尺寸的上限是 14400pt
const MAX_PT = 14400;

export async function exportPdf(id, { report, signal, mode }) {
  const p = store.getProject(id);
  const settings = p.settings;
  const pages = pageAssets(p);
  if (!pages.length) throw new Error('文字稿里没有找到页面');
  const pdfMode = mode || settings.pdf?.mode || 'long';
  const { width: W, height: H } = resolveSize();
  const cacheDir = store.projectPath(id, 'cache');

  const jpgs = [];
  for (let i = 0; i < pages.length; i++) {
    if (signal?.aborted) throw new Error('已取消');
    report(0.02 + (0.8 * i) / pages.length, `合成第 ${i + 1}/${pages.length} 页`);
    jpgs.push(await composePage(pages[i], settings, { width: W, height: H, cacheDir, quality: 90 }));
  }

  report(0.85, '生成 PDF');
  const doc = await PDFDocument.create();
  doc.setTitle(p.name);
  doc.setCreator('绘本剪辑台');
  if (pdfMode === 'pages') {
    const k = 0.75;
    for (const buf of jpgs) {
      const img = await doc.embedJpg(buf);
      doc.addPage([W * k, H * k]).drawImage(img, { x: 0, y: 0, width: W * k, height: H * k });
    }
  } else {
    const n = jpgs.length;
    const k = Math.min(0.75, MAX_PT / (H * n));
    const page = doc.addPage([W * k, H * n * k]);
    for (let i = 0; i < n; i++) {
      const img = await doc.embedJpg(jpgs[i]);
      page.drawImage(img, { x: 0, y: (n - 1 - i) * H * k, width: W * k, height: H * k });
    }
  }
  const bytes = await doc.save();
  const out = path.join(outputDir(p), `${safeName(p.name)}${pdfMode === 'pages' ? '-分页' : ''}.pdf`);
  fs.writeFileSync(out, bytes);
  const info = { pdf: rel(out), pdfMode, pdfAt: Date.now(), pdfPages: pages.length };
  store.updateProject(id, (q) => {
    q.output = { ...(q.output || {}), ...info };
  });
  report(1, '完成');
  return info;
}
