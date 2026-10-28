/**
 * 用 ffplay 做"边下边播"。
 *
 * 为什么需要它：MiMo 的 SSE 流式在 0.9 秒就吐第一个音频分片，但 SoundPlayer 只能播**完整文件**，
 * 于是那 0.9 秒白等了 —— 必须等 1.8 秒全到齐才能出声。ffplay 能吃 stdin 的裸 PCM，
 * 喂一片播一片，开口时间直接对齐首包。
 *
 * 附带两个好处：
 *   1. 口型跟着**播放位置**走（不是文件解析），更准；
 *   2. 能中途 kill 掉 —— 来了新弹幕可以打断这句，不用排队等它念完。
 *
 * ⚠️ 播放位置 vs 数据到达：音频是以约 3 倍实时速度灌进来的，ffplay 内部会积压缓冲。
 *   所以口型**绝不能**用"数据到哪就算哪"，必须按"开始播放后的真实流逝时间"去缓冲区里取帧。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const PCM_SAMPLE_RATE = 24000;

/** 找 ffplay：DSH 宿主进程的 PATH 是启动时快照的，装完新工具它看不见，所以直接查已知位置。 */
export function resolveFfplay() {
  const candidates = [
    process.env.FFPLAY_PATH,
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'ffplay.exe')
      : '',
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages')
      : '',
    'ffplay',
  ].filter(Boolean);

  for (const c of candidates) {
    if (c === 'ffplay') return { ok: true, path: 'ffplay', note: '走 PATH' };
    if (c.endsWith('Packages')) continue; // 目录，不是可执行文件
    try {
      if (fs.existsSync(c)) return { ok: true, path: c, note: '找到了' };
    } catch { /* ignore */ }
  }
  return { ok: false, path: '', note: '没有 ffplay，退到整段播放' };
}

/**
 * 开一个 PCM 播放会话。
 *   write(buf)  喂一片 PCM（16bit 单声道 24kHz）
 *   end()       数据喂完，等它自然播完
 *   stop()      立刻掐断（打断用）
 *   read(pos,n) 按字节偏移从已收到的数据里取一段（给口型用）
 *   startedAt   第一片数据写入的时刻
 *   done        Promise，播完或被杀掉后 resolve
 */
export function createPcmSession({ sampleRate = PCM_SAMPLE_RATE, ffplayPath = 'ffplay', log = () => {} } = {}) {
  // 动态扩容的缓冲区：口型要按播放位置回读，不能只存最近一片
  let store = Buffer.alloc(1 << 18);
  let length = 0;
  const append = (buf) => {
    if (length + buf.length > store.length) {
      let cap = store.length;
      while (cap < length + buf.length) cap *= 2;
      const next = Buffer.alloc(cap);
      store.copy(next, 0, 0, length);
      store = next;
    }
    buf.copy(store, length);
    length += buf.length;
  };

  // ⚠️ ffplay 没有 -ac / -ar 这类**输出**参数（那是 ffmpeg 的）。
  //    裸 PCM 必须用 demuxer 的参数：-sample_rate / -ch_layout。
  //    写错会 direct 退出（exit 1），而且如果 loglevel=quiet 连错误都看不见 —— 踩过。
  const proc = spawn(ffplayPath, [
    '-nodisp', '-autoexit', '-loglevel', 'error',
    '-f', 's16le', '-sample_rate', String(sampleRate), '-ch_layout', 'mono', '-i', 'pipe:0',
  ], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });

  let finished = false;
  let killed = false;
  let startedAt = 0;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });

  const settle = (reason) => {
    if (finished) return;
    finished = true;
    resolveDone({ killed, reason, bytes: length });
  };

  proc.on('error', (err) => {
    log(`ffplay 起不来：${err?.message ?? err}`);
    settle('spawn-error');
  });
  proc.on('exit', () => settle('exit'));
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (d) => {
    const t = String(d).trim();
    if (t) log(`ffplay: ${t.slice(0, 160)}`);
  });
  proc.stdin.on('error', () => { /* 被 kill 时 EPIPE，正常 */ });

  return {
    write(buf) {
      if (finished || !buf?.length) return;
      append(buf);
      if (!startedAt) startedAt = Date.now();
      try { proc.stdin.write(buf); } catch { /* 已经死了 */ }
    },
    end() {
      if (finished) return;
      try { proc.stdin.end(); } catch { /* ignore */ }
    },
    stop() {
      if (finished) return;
      killed = true;
      try { proc.stdin.end(); } catch { /* ignore */ }
      try { proc.kill(); } catch { /* ignore */ }
      settle('killed');
    },
    read(pos, n) {
      if (pos < 0 || pos >= length) return null;
      return store.subarray(pos, Math.min(length, pos + n));
    },
    get startedAt() { return startedAt; },
    get bytes() { return length; },
    done,
  };
}

/** 一段 PCM 的响度 → 0..1 的口型开合量（和 playWithLipSync 同一套换算）。 */
export function rmsLevel(frame) {
  if (!frame?.length) return 0;
  const n = Math.floor(frame.length / 2);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const v = frame.readInt16LE(i * 2) / 32768;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / n);
  return Math.max(0, Math.min(1, rms * 3.2));
}