import { create } from 'zustand';

let toastSeq = 0;

// 全局：后台任务进度（SSE 推送）、轻提示
export const useApp = create((set, get) => ({
  jobs: {}, // projectId -> 最新任务
  toasts: [],
  projectsVersion: 0,
  renderWatch: null, // 正开着「生成视频」对话框的项目，完成提示由对话框显示
  pdfWatch: null, // 正开着「导出 PDF」对话框的项目

  setJob(job) {
    set((s) => ({ jobs: { ...s.jobs, [job.projectId]: job } }));
  },
  bumpProjects() {
    set((s) => ({ projectsVersion: s.projectsVersion + 1 }));
  },
  toast(message, type = 'info', ms = 3200) {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { id, message, type }] }));
    if (ms) setTimeout(() => get().dismissToast(id), ms);
    return id;
  },
  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

export const toast = (...args) => useApp.getState().toast(...args);

// 极简路由
const listeners = new Set();
export function navigate(to) {
  if (to === location.pathname) return;
  history.pushState(null, '', to);
  listeners.forEach((f) => f());
}
window.addEventListener('popstate', () => listeners.forEach((f) => f()));
export function onRoute(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function fmtTime(t, withMs = true) {
  if (!Number.isFinite(t)) t = 0;
  const neg = t < 0;
  t = Math.abs(t);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  const ss = withMs ? s.toFixed(1).padStart(4, '0') : String(Math.floor(s)).padStart(2, '0');
  return `${neg ? '-' : ''}${String(m).padStart(2, '0')}:${ss}`;
}

export function fmtDuration(t) {
  if (!t) return '0 秒';
  const m = Math.floor(t / 60);
  const s = Math.round(t - m * 60);
  return m ? `${m} 分 ${s} 秒` : `${s} 秒`;
}

export function timeAgo(ts) {
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return '刚刚';
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}
