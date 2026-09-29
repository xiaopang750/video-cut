import { spawn } from 'node:child_process';

// 运行外部命令，按行回调 stdout/stderr，失败时带上 stderr 末尾便于排查
export function run(cmd, args, { cwd, onStdoutLine, onStderrLine, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderrTail = '';
    let outBuf = '';
    let errBuf = '';

    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (d) => {
      const s = d.toString('latin1');
      stdout += s;
      if (onStdoutLine) {
        outBuf += s;
        let i;
        while ((i = outBuf.search(/[\r\n]/)) >= 0) {
          const line = outBuf.slice(0, i);
          outBuf = outBuf.slice(i + 1);
          if (line) onStdoutLine(line);
        }
      }
    });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderrTail = (stderrTail + s).slice(-4000);
      if (onStderrLine) {
        errBuf += s;
        let i;
        while ((i = errBuf.search(/[\r\n]/)) >= 0) {
          const line = errBuf.slice(0, i);
          errBuf = errBuf.slice(i + 1);
          if (line) onStderrLine(line);
        }
      }
    });
    child.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(new Error(`无法启动 ${cmd}: ${err.message}`));
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (code === 0) resolve({ stdout, stderr: stderrTail });
      else {
        const err = new Error(`${cmd.split('/').pop()} 退出码 ${code}\n${stderrTail.trim().split('\n').slice(-6).join('\n')}`);
        err.code = code;
        reject(err);
      }
    });
  });
}
