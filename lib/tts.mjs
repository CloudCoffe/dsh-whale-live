/**
 * 语音层（本地兜底）：Windows 自带 SAPI 合成 WAV → 播放的同时把音频包络写进口型参数。
 *
 * 云端合成在 lib/mimo.mjs；这里只在 MiMo 不可用时顶上（离线、没 key、接口挂了）。
 *
 * ⚠️ 口型参数必须用 VTS 的**追踪参数** `MouthOpen`，不能写模型里的 `ParamMouthOpenY`：
 *   实测（VTS 1.35.10 + 大肥鱼）注入 ParamMouthOpenY 会被拒 ——
 *   `APIError 453: ... you can't inject data directly for Live2D parameters,
 *    only for tracking parameters`。换成 MouthOpen 立刻成功。
 * 不依赖第三方包，也不需要联网。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const PS = 'powershell.exe';

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function runPs(script, stdin) {
  return new Promise((resolve, reject) => {
    const child = spawn(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `PowerShell 退出码 ${code}`));
    });
    if (stdin !== undefined) {
      child.stdin.end(stdin, 'utf8');
    } else {
      child.stdin.end();
    }
  });
}

/** 检查系统语音是否可用。 */
export async function probeVoice() {
  try {
    const out = await runPs(
      "Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }",
    );
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch (err) {
    return { error: err?.message ?? String(err) };
  }
}

/** 合成一段 WAV，返回文件路径。 */
export async function synthesize(text, { rate = 0, voice = '', outDir } = {}) {
  const dir = outDir ?? path.join(os.tmpdir(), 'dsh-whale-live');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `say-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.wav`);
  const script = [
    'Add-Type -AssemblyName System.Speech',
    '$ErrorActionPreference = "Stop"',
    '$text = [Console]::In.ReadToEnd()',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    `$s.Rate = ${Number(rate) || 0}`,
    voice ? `$s.SelectVoice(${psQuote(voice)})` : '',
    `$s.SetOutputToWaveFile(${psQuote(file)})`,
    '$s.Speak($text)',
    '$s.Dispose()',
    `Write-Output ${psQuote(file)}`,
  ].filter(Boolean).join('; ');
  await runPs(script, text);
  return file;
}

/** 读取 16-bit PCM WAV 的包络（每 40ms 一个 0..1 的值）。 */
export async function readEnvelope(file, frameMs = 40) {
  const buf = await fs.readFile(file);
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return null;
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = { start: body, size: Math.min(size, buf.length - body) };
      break;
    }
    off = body + size + (size % 2);
  }
  if (!fmt || !data || fmt.bits !== 16) return null;
  const { channels, sampleRate } = fmt;
  const bytesPerFrame = 2 * channels;
  const framesPerBlock = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const out = [];
  let peak = 1;
  for (let pos = data.start; pos + bytesPerFrame <= data.start + data.size; pos += bytesPerFrame * framesPerBlock) {
    let sum = 0;
    let n = 0;
    const end = Math.min(pos + bytesPerFrame * framesPerBlock, data.start + data.size);
    for (let p = pos; p + 2 <= end; p += 2) {
      const v = buf.readInt16LE(p) / 32768;
      sum += v * v;
      n += 1;
    }
    const rms = n ? Math.sqrt(sum / n) : 0;
    out.push(rms);
    if (rms > peak) peak = rms;
  }
  return out.map((v) => Math.min(1, v / (peak || 1)));
}

/** VTS 的追踪参数名（不能用模型的 Live2D 参数名，见文件头说明）。 */
const MOUTH_PARAM = 'MouthOpen';

/** 播放 WAV，同时按包络驱动口型参数。 */
export async function playWithLipSync(file, { inject, onTick, log = () => {}, keepFile = false } = {}) {
  const envelope = inject ? await readEnvelope(file).catch(() => null) : null;
  const started = Date.now();
  let timer = null;
  let idx = 0;
  if (inject && envelope?.length) {
    const step = 40;
    timer = setInterval(() => {
      idx = Math.floor((Date.now() - started) / step);
      const v = envelope[idx] ?? 0;
      onTick?.(v);
      Promise.resolve(inject([{ id: MOUTH_PARAM, value: v }])).catch(() => { /* 忽略瞬时失败 */ });
    }, step);
  }
  try {
    await runPs(`(New-Object Media.SoundPlayer ${psQuote(file)}).PlaySync()`);
  } catch (err) {
    log(`播放失败: ${err?.message ?? err}`);
  } finally {
    if (timer) clearInterval(timer);
    if (inject) {
      try { await inject([{ id: MOUTH_PARAM, value: 0 }]); } catch { /* ignore */ }
    }
    if (!keepFile) await fs.unlink(file).catch(() => {});
  }
  return Date.now() - started;
}

export async function speak(text, { inject, rate = 0, voice = '', outDir, log = () => {} } = {}) {
  const clean = String(text ?? '').replace(/[<>]/g, '').slice(0, 200);
  if (!clean.trim()) return 0;
  const file = await synthesize(clean, { rate, voice, outDir });
  return playWithLipSync(file, { inject, log });
}

/* ------------------------------------------------------------------ *
 * 通用 PCM 工具（云端 TTS 返回的都是裸 PCM，SAPI 那条路吃 WAV 文件）
 * ------------------------------------------------------------------ */

/** 裸 PCM（16bit 单声道）→ WAV 文件内容：Media.SoundPlayer 只吃 WAV。 */
export function pcmToWav(pcm, sampleRate = 24000, channels = 1, bits = 16) {
  const blockAlign = (channels * bits) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
