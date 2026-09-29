// 后台任务：全局串行队列（初始化/渲染都很吃 CPU/GPU，本地单机依次执行更稳），
// 进度通过 SSE 推给前端。
import crypto from 'node:crypto';

const clients = new Set();
const jobs = new Map(); // jobId -> job
const queue = [];
let running = null;

function publicJob(j) {
  const { fn, controller, ...rest } = j;
  return rest;
}

export function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(data);
}

export function sseHandler(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`data: ${JSON.stringify({ type: 'hello', jobs: activeJobs() })}\n\n`);
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
}

export function activeJobs() {
  return [...jobs.values()].filter((j) => j.status === 'queued' || j.status === 'running').map(publicJob);
}

export function jobFor(projectId, type) {
  return [...jobs.values()].find(
    (j) => j.projectId === projectId && (!type || j.type === type) && (j.status === 'queued' || j.status === 'running'),
  );
}

export function enqueue(projectId, type, fn, { label } = {}) {
  const existing = jobFor(projectId, type);
  if (existing) return publicJob(existing);
  const job = {
    id: crypto.randomUUID(),
    projectId,
    type,
    label: label || type,
    status: 'queued',
    progress: 0,
    message: '排队中',
    error: null,
    result: null,
    createdAt: Date.now(),
    fn,
    controller: new AbortController(),
  };
  jobs.set(job.id, job);
  queue.push(job);
  broadcast({ type: 'job', job: publicJob(job) });
  pump();
  return publicJob(job);
}

export function cancelJobs(projectId) {
  for (const j of jobs.values()) {
    if (j.projectId !== projectId) continue;
    if (j.status === 'queued') {
      j.status = 'error';
      j.error = '已取消';
      queue.splice(queue.indexOf(j), 1);
      broadcast({ type: 'job', job: publicJob(j) });
    } else if (j.status === 'running') j.controller.abort();
  }
}

let lastEmit = 0;
function makeReporter(job) {
  return (progress, message) => {
    if (progress != null) job.progress = Math.max(0, Math.min(1, progress));
    if (message) job.message = message;
    const now = Date.now();
    if (now - lastEmit > 150 || message) {
      lastEmit = now;
      broadcast({ type: 'job', job: publicJob(job) });
    }
  };
}

async function pump() {
  if (running || !queue.length) return;
  const job = queue.shift();
  running = job;
  job.status = 'running';
  job.startedAt = Date.now();
  job.message = '开始处理';
  broadcast({ type: 'job', job: publicJob(job) });
  try {
    job.result = (await job.fn({ report: makeReporter(job), signal: job.controller.signal })) ?? null;
    job.status = 'done';
    job.progress = 1;
    job.message = '完成';
  } catch (err) {
    job.status = 'error';
    job.error = job.controller.signal.aborted ? '已取消' : err.message || String(err);
    job.message = '失败';
    console.error(`[job ${job.type}] ${job.projectId}:`, err);
  }
  job.finishedAt = Date.now();
  broadcast({ type: 'job', job: publicJob(job) });
  running = null;
  // 清理较早的已结束任务
  const done = [...jobs.values()].filter((j) => j.status === 'done' || j.status === 'error');
  for (const j of done.slice(0, Math.max(0, done.length - 50))) jobs.delete(j.id);
  pump();
}

// whisper 同时只跑一个（录音导入是同步请求，不走队列，但要和初始化互斥）
let whisperLock = Promise.resolve();
export function withWhisperLock(fn) {
  const next = whisperLock.then(fn, fn);
  whisperLock = next.catch(() => {});
  return next;
}
