/**
 * 走系统代理的 HTTP GET（只为了那几台在 Cloudflare 后面的站）。
 *
 * 为什么不用 `fetch`：Node 的网络栈**不读系统代理**（`HTTP_PROXY` 也不管用），
 * 直连 cnmeme.wiki 是 `UND_ERR_CONNECT_TIMEOUT`；而 PowerShell / .NET 自动走代理。
 * 同一个请求：PowerShell 3.4s，Node 直连直接超时 —— 这是这台机器上最坑的一条。
 *
 * 所以这里手写一条 CONNECT 隧道：
 *   net.connect(代理) → `CONNECT host:443` → 200 → tls.connect 套上去 → 手发 HTTP/1.1
 * 只支持 GET + JSON，一次一条连接（不 keep-alive）：够用，代码也短。
 */
import net from 'node:net';
import tls from 'node:tls';

/**
 * @param {string} url  http(s) 绝对地址
 * @param {{proxy?: string, timeoutMs?: number}} opts  proxy 形如 http://127.0.0.1:7890
 * @returns {Promise<any>} 解析后的 JSON
 */
export function httpGetJsonViaProxy(url, { proxy = '', timeoutMs = 12_000 } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try { target = new URL(url); } catch (err) { reject(new Error(`地址不合法: ${url}`)); return; }
    if (!/^https?:$/.test(target.protocol)) { reject(new Error(`只支持 http/https: ${url}`)); return; }

    const proxyUrl = proxy ? new URL(proxy) : null;
    const proxyPort = proxyUrl ? Number(proxyUrl.port || 80) : 0;
    const proxyHost = proxyUrl ? proxyUrl.hostname : '';
    const isHttps = target.protocol === 'https:';
    const port = Number(target.port || (isHttps ? 443 : 80));
    const host = target.hostname;
    const path = `${target.pathname}${target.search}`;

    let sock = net.connect(proxyPort, proxyHost);
    let settled = false;
    const done = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); try { sock.destroy(); } catch { /* ignore */ } fn(arg); };
    const fail = (err) => done(reject, err instanceof Error ? err : new Error(String(err)));
    const timer = setTimeout(() => fail(new Error(`代理请求超时 ${timeoutMs}ms`)), timeoutMs);

    sock.setNoDelay(true);
    sock.on('error', (err) => fail(new Error(`连代理失败: ${err.message}`)));
    sock.on('connect', () => {
      sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
    });

    let head = Buffer.alloc(0);
    const onHead = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const idx = head.indexOf('\r\n\r\n');
      if (idx < 0) return; // 等更多
      sock.off('data', onHead);
      const first = head.subarray(0, idx).toString('latin1').split('\r\n')[0];
      if (!/^HTTP\/1\.[01] 200/.test(first)) { fail(new Error(`代理拒绝 CONNECT：${first}`)); return; }
      const rest = head.subarray(idx + 4); // 已经跟着发过来的数据

      const send = (stream) => {
        stream.write(
          `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nAccept: application/json\r\n`
          + 'User-Agent: dsh-whale-live/0.2 (+https://github.com/CloudCoffe/dsh-whale-live)\r\n'
          + 'Connection: close\r\n\r\n',
        );
        let raw = rest;
        stream.on('data', (c) => { raw = Buffer.concat([raw, c]); });
        stream.on('error', (err) => fail(new Error(`读响应失败: ${err.message}`)));
        stream.on('end', () => {
          if (settled) return;
          const text = raw.toString('utf8');
          const split = text.indexOf('\r\n\r\n');
          if (split < 0) { fail(new Error('响应没有 body')); return; }
          const headers = text.slice(0, split);
          let body = text.slice(split + 4);
          if (/transfer-encoding:\s*chunked/i.test(headers)) {
            // 极简 chunked 解码：去掉长度行，按块拼接
            const parts = body.split('\r\n');
            const out = [];
            let expectLen = null;
            for (const line of parts) {
              const t = line.trim();
              if (expectLen !== null) {
                if (t.length) out.push(line.slice(0, expectLen));
                expectLen = null;
                continue;
              }
              if (/^[0-9a-f]+$/i.test(t)) { expectLen = parseInt(t, 16); if (expectLen === 0) break; }
            }
            body = out.join('');
          }
          try { done(resolve, JSON.parse(body)); } catch { fail(new Error(`不是 JSON：${body.slice(0, 120)}`)); }
        });
      };

      if (isHttps) {
        const secure = tls.connect({ socket: sock, servername: host }, () => send(secure));
        secure.on('error', (err) => fail(new Error(`TLS 失败: ${err.message}`)));
      } else {
        send(sock);
      }
    };
    sock.on('data', onHead);
  });
}