async function request(method, url, body) {
  const isForm = body instanceof FormData;
  const res = await fetch(url, {
    method,
    headers: body && !isForm ? { 'Content-Type': 'application/json' } : undefined,
    body: isForm ? body : body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      msg = (await res.json()).error || msg;
    } catch {}
    throw new Error(msg);
  }
  return (res.headers.get('content-type') || '').includes('json') ? res.json() : res;
}

const P = (id) => `/api/projects/${encodeURIComponent(id)}`;

export const api = {
  status: () => request('GET', '/api/status'),
  fonts: () => request('GET', '/api/fonts'),
  defaults: () => request('GET', '/api/defaults'),
  projects: () => request('GET', '/api/projects'),
  project: (id) => request('GET', P(id)),
  analysis: (id) => request('GET', `${P(id)}/analysis`),
  remove: (id, { outputs, source } = {}) => {
    const q = [outputs && 'outputs=1', source && 'source=1'].filter(Boolean).join('&');
    return request('DELETE', `${P(id)}${q ? `?${q}` : ''}`);
  },
  silence: (id) => request('POST', `${P(id)}/silence`),
  // 修改记录导入：body 是导出的 JSON 原文
  importRecords: (id, text) =>
    fetch(`${P(id)}/records/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text }).then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `导入失败 (${r.status})`);
      return j;
    }),
  removeSource: (id, src) => request('DELETE', `${P(id)}/sources/${encodeURIComponent(src)}`),
  startUpload: (name) => request('POST', '/api/uploads', { name }),
  finishUpload: (uid, name, init, order, pages) => request('POST', `/api/uploads/${uid}/finish`, { name, init, order, pages }),
  cancelUpload: (uid) => request('DELETE', `/api/uploads/${uid}`),
  init: (id) => request('POST', `${P(id)}/init`),
  cancel: (id) => request('POST', `${P(id)}/cancel`),
  saveEdit: (id, edit) => request('PUT', `${P(id)}/edit`, edit),
  saveSegment: (id, segId, patch) => request('PUT', `${P(id)}/segments/${segId}`, patch),
  saveSettings: (id, settings, asDefault) => request('PUT', `${P(id)}/settings`, { settings, asDefault }),
  render: (id) => request('POST', `${P(id)}/render`),
  proxy: (id) => request('POST', `${P(id)}/proxy`),
  pdf: (id, mode) => request('POST', `${P(id)}/pdf`, { mode }),
  reveal: (id, kind) => request('POST', `${P(id)}/reveal`, { kind }),
  // 返回 objectURL
  async previewPage(id, body) {
    const res = await request('POST', `${P(id)}/preview`, body);
    return URL.createObjectURL(await res.blob());
  },
};

export const urls = {
  image: (id, file, w = 480) => `${P(id)}/images/${encodeURIComponent(file)}?w=${w}`,
  page: (id, segId, w, v) => `${P(id)}/pages/${segId}.jpg?w=${w}${v ? `&v=${v}` : ''}`,
  preview: (id, src) => `${P(id)}/sources/${src}/preview`,
  video: (id, src, v) => `${P(id)}/sources/${src}/video${v ? `?v=${v}` : ''}`,
  file: (id, kind, dl) => `${P(id)}/files/${kind}${dl ? '?dl=1' : ''}`,
  recordsExport: (id) => `${P(id)}/records/export`,
};

// 上传文件（带进度）；返回 { promise, abort }
function xhrUpload(url, file, onProgress) {
  const xhr = new XMLHttpRequest();
  const promise = new Promise((resolve, reject) => {
    xhr.open('POST', url);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded, e.total);
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data?.error || `上传失败 (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('上传失败，请检查服务是否在运行'));
    xhr.onabort = () => reject(Object.assign(new Error('已取消'), { aborted: true }));
    const fd = new FormData();
    fd.append('file', file, file.name || 'file');
    xhr.send(fd);
  });
  return { promise, abort: () => xhr.abort() };
}

// 上传绘本文件夹里的一个文件
export const uploadFolderFile = (uid, file, onProgress) => xhrUpload(`/api/uploads/${uid}/files`, file, onProgress);

// 上传录音（带进度）
export function uploadRecording(id, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${P(id)}/recordings`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data?.error || `上传失败 (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('上传失败，请检查服务是否在运行'));
    const fd = new FormData();
    fd.append('file', file, file.name || 'recording.webm');
    xhr.send(fd);
  });
}

// SSE：任务进度实时推送，断线自动重连
export function subscribe(onEvent) {
  let es;
  let closed = false;
  let timer;
  const connect = () => {
    es = new EventSource('/api/events');
    es.onmessage = (e) => {
      try {
        onEvent(JSON.parse(e.data));
      } catch {}
    };
    es.onerror = () => {
      es.close();
      if (!closed) timer = setTimeout(connect, 1500);
    };
  };
  connect();
  return () => {
    closed = true;
    clearTimeout(timer);
    es?.close();
  };
}

// 简单字符串哈希，用于图片缓存版本号
export function hashOf(value) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
