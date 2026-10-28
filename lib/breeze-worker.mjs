/**
 * 常驻 BreezeBlue 合成进程的 Node 侧管理器。
 *
 * 背景（2026-10 实测，本机）：这台机器开着系统代理 127.0.0.1:7890，
 * - PowerShell / .NET HttpClient 会自动走代理 → 到 api.breeze.blue 只要 0.85~1.7 秒出首包；
 * - Node 自己的 fetch / https 不走代理 → 直连要 12~88 秒，还经常 ECONNRESET。
 * 所以合成一律交给 PowerShell 干。但每次新起进程都得重新握手，于是把进程留着常驻。
 *
 * 协议见 lib/breeze-worker.ps1 头部注释：stdin 一行 base64 JSON，stdout 一行 JSON。
 * 请求是**串行**的（一个工作进程一次只处理一条），和插件的表演队列本来就串行，不冲突。
 */
import { spawn } from 'node:child_process';

export function createBreezeWorker({ script, log = () => {} } = {}) {
  let proc = null;
  let buf = '';
  let waiter = null;
  let chain = Promise.resolve();
  let disposed = false;

  function spawnWorker() {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        const fn = waiter;
        waiter = null;
        fn?.(line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      const text = String(d).trim();
      if (text) log(`工作进程 stderr: ${text.slice(0, 200)}`);
    });
    child.on('error', (err) => {
      log(`工作进程启动失败: ${err?.message ?? err}`);
      proc = null;
    });
    child.on('exit', (code) => {
      if (proc === child) proc = null;
      // 有人正在等的话立刻叫醒他，别让他等到超时
      const fn = waiter;
      waiter = null;
      fn?.('');
    });
    proc = child;
    return child;
  }

  function doRequest(payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (disposed) { reject(new Error('工作进程已卸载')); return; }
      let child;
      try { child = proc ?? spawnWorker(); } catch (err) { reject(err); return; }

      const timer = setTimeout(() => {
        waiter = null;
        try { child.kill(); } catch { /* 已经死了 */ }
        reject(new Error(`合成超时（${timeoutMs}ms）`));
      }, timeoutMs);

      waiter = (line) => {
        clearTimeout(timer);
        if (!line) { reject(new Error('工作进程意外退出')); return; }
        try {
          resolve(JSON.parse(line));
        } catch {
          reject(new Error(`工作进程返回了看不懂的东西: ${line.slice(0, 120)}`));
        }
      };

      try {
        const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
        child.stdin.write(`${encoded}\n`, 'utf8');
      } catch (err) {
        clearTimeout(timer);
        waiter = null;
        reject(err);
      }
    });
  }

  return {
    /** 串行发一条合成请求；返回 {ok, ms, firstMs, bytes} 或 {ok:false, error}。 */
    request(payload, { timeoutMs = 60_000 } = {}) {
      const run = () => doRequest(payload, timeoutMs);
      const p = chain.then(run, run);
      chain = p.then(() => {}, () => {});
      return p;
    },
    /** 预热：起进程 + 打一条空请求试探（失败不影响后续）。 */
    async warm() {
      if (disposed) return false;
      try { if (!proc) spawnWorker(); return true; } catch { return false; }
    },
    state() {
      return { alive: Boolean(proc), pid: proc?.pid ?? null, disposed };
    },
    dispose() {
      disposed = true;
      const child = proc;
      proc = null;
      if (!child) return;
      try { child.stdin.write('QUIT\n'); } catch { /* ignore */ }
      setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 800).unref?.();
    },
  };
}