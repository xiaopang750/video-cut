import { useEffect, useState } from 'react';
import { subscribe } from './api.js';
import { onRoute, useApp } from './appStore.js';
import { ConfirmHost, Toasts, TooltipHost } from './components/ui.jsx';
import ProjectList from './pages/ProjectList.jsx';
import Editor from './editor/Editor.jsx';

export default function App() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => onRoute(() => setPath(location.pathname)), []);

  useEffect(
    () =>
      subscribe((ev) => {
        const app = useApp.getState();
        if (ev.type === 'hello') ev.jobs.forEach((j) => app.setJob(j));
        if (ev.type === 'job') {
          const prev = app.jobs[ev.job.projectId];
          app.setJob(ev.job);
          if (ev.job.status === 'done' || ev.job.status === 'error') {
            app.bumpProjects();
            // 初始化通常在后台跑，完成时给个提示（生成视频 / PDF 各自的对话框里有提示）
            const changed = prev?.id === ev.job.id && prev.status !== ev.job.status;
            if (changed && ev.job.type === 'init') {
              if (ev.job.status === 'done') app.toast(`${ev.job.label} 完成，可以进入编辑了`, 'success', 4000);
              else app.toast(`${ev.job.label} 失败：${ev.job.error}`, 'error', 6000);
            }
            if (changed && ev.job.type === 'render' && app.renderWatch !== ev.job.projectId) {
              if (ev.job.status === 'done') app.toast(`${ev.job.label} 完成，已保存到 output 目录`, 'success', 5000);
              else app.toast(`${ev.job.label} 失败：${ev.job.error}`, 'error', 6000);
            }
            if (changed && ev.job.type === 'pdf' && app.pdfWatch !== ev.job.projectId) {
              if (ev.job.status === 'done') app.toast(`${ev.job.label} 完成，可以在项目卡片上打开或下载`, 'success', 5000);
              else app.toast(`${ev.job.label} 失败：${ev.job.error}`, 'error', 6000);
            }
          }
        }
        if (ev.type === 'projects') app.bumpProjects();
      }),
    [],
  );

  const m = path.match(/^\/edit\/([\w-]+)/);
  return (
    <>
      <div className="sky-bg" />
      {m ? <Editor key={m[1]} id={m[1]} /> : <ProjectList />}
      <Toasts />
      <ConfirmHost />
      <TooltipHost />
    </>
  );
}
