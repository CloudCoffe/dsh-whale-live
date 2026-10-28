/**
 * 语音层：Windows 自带 SAPI 合成 WAV → 播放的同时把音频包络写进口型参数做口型。
 *
 * ⚠️ 口型参数必须用 VTS 的**追踪参数** `MouthOpen`，不能写模型里的 `ParamMouthOpenY`：
 *   实测（VTS 1.35.10 + 大肥鱼）注入 ParamMouthOpenY 会被拒 ——
 *   `APIError 453: ... you can't inject data directly for Live2D parameters,
 *    only for tracking parameters`。换成 MouthOpen 立刻成功。
 * 不依赖第三方包，也不需要联网。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
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
 * BreezeBlue 云端 TTS（提示词设计音色，音色不依赖本地模型/训练素材）
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

/**
 * 调 BreezeBlue 合成一段 24kHz PCM。
 *
 * ⚠️ 两个实测出来的坑（2026-10，本机）：
 *  1. **不用 Node 自己的网络栈**：同一请求 PowerShell 直连 3.4s 稳定返回，而
 *     Node 的 fetch 要 12.6s（IPv6 先试再回退），node:https+keepAlive 直接
 *     ECONNRESET / 88s 超时。所以这里 shell 出 PowerShell 走 Invoke-WebRequest。
 *     API Key 只从 stdin 传，不进命令行（进程列表里看不到）。
 *  2. **只用 `delivery=sync`**：`/stream` 从本机会被严重节流（首包 2.2s，之后
 *     每 44ms 音频要等 ~1.3s，5.9 秒台词拖成 171 秒）。
 */
export async function synthesizeBreeze(text, {
  apiKey, voiceId, baseUrl = 'https://api.breeze.blue', model = 'breeze-tts-2',
  languageCode = 'zh', instructions = '', guidanceScale = 4, timeoutMs = 45_000, worker = null,
  speed = 0,
} = {}) {
  if (!apiKey) throw new Error('缺少 BreezeBlue API Key');
  if (!voiceId) throw new Error('缺少 BreezeBlue 音色 ID');
  const optsSpeed = Number(speed) > 0 ? Number(speed) : 0;

  // 首选：常驻工作进程（连接是热的，首包 ~0.85s）。协议见 lib/breeze-worker.ps1。
  if (worker) {
    const outFile = path.join(os.tmpdir(), `breeze-req-${process.pid}-${Date.now()}.pcm`);
    try {
      const r = await worker.request({
        key: apiKey,
        voice: voiceId,
        text,
        model,
        lang: languageCode,
        instructions,
        guidance: guidanceScale,
        speed: optsSpeed,
        out: outFile,
      }, { timeoutMs });
      if (!r?.ok) throw new Error(r?.error ? String(r.error).slice(0, 200) : '工作进程没有返回结果');
      const pcm = await fs.readFile(outFile);
      if (!pcm.length) throw new Error('返回音频为空');
      return { pcm, sampleRate: 24000, firstMs: r.firstMs, totalMs: r.ms };
    } catch (err) {
      if (err?.code === 'ENOENT') throw new Error('工作进程没写出音频文件');
      throw err;
    } finally {
      await fs.unlink(outFile).catch(() => {});
    }
  }

  // 兜底：一次性 PowerShell（工作进程起不来时用，慢一点但独立）
  const base = String(baseUrl).replace(/\/+$/, '');
  const url = `${base}/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=pcm`;
  const payload = { text, model_id: model, language_code: languageCode };
  if (instructions) payload.instructions = instructions;
  const vs = {};
  if (guidanceScale) vs.guidance_scale = Number(guidanceScale);
  if (optsSpeed) vs.speed = optsSpeed;
  if (Object.keys(vs).length) payload.voice_settings = vs;

  const out = path.join(os.tmpdir(), `breeze-req-${process.pid}-${Date.now()}.pcm`);
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$in = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(([Console]::In.ReadToEnd()).Trim())) | ConvertFrom-Json',
    '$h = @{ "xi-api-key" = [string]$in.key; "Content-Type" = "application/json" }',
    'try {',
    `  Invoke-WebRequest -Uri ${psQuote(url)} -Headers $h -Method Post -Body ([Text.Encoding]::UTF8.GetBytes([string]$in.body)) -OutFile ${psQuote(out)} -TimeoutSec ${Math.round(timeoutMs / 1000)} -UseBasicParsing | Out-Null`,
    '} catch {',
    '  $resp = $_.Exception.Response',
    '  if ($resp) { $sr = New-Object System.IO.StreamReader($resp.GetResponseStream()); [Console]::Error.Write($sr.ReadToEnd()) }',
    '  else { [Console]::Error.Write($_.Exception.Message) }',
    '  exit 1',
    '}',
  ].join('; ');
  // stdin 走 base64：PowerShell 5.1 的控制台输入按本地代码页解码，直接塞中文会被弄坏
  const stdin = Buffer.from(JSON.stringify({ key: apiKey, body: JSON.stringify(payload) }), 'utf8').toString('base64');
  try {
    await runPs(script, stdin);
    const pcm = await fs.readFile(out);
    if (!pcm.length) throw new Error('返回音频为空');
    return { pcm, sampleRate: 24000 };
  } catch (err) {
    const raw = String(err?.message ?? err);
    let msg = raw;
    try {
      const j = JSON.parse(raw.slice(raw.indexOf('{')));
      msg = `HTTP 错误：${j.detail ?? j.error ?? raw.slice(0, 160)}`;
    } catch { msg = raw.slice(0, 200) || '请求失败'; }
    throw new Error(msg);
  } finally {
    await fs.unlink(out).catch(() => {});
  }
}

/** 只合成不出声，返回缓存 WAV 路径；同一句话走磁盘缓存，避免重复计费。 */
export async function prepareBreeze(text, opts = {}) {
  const { log = () => {}, cacheDir, voiceId, instructions = '', guidanceScale = 4 } = opts;
  const clean = String(text ?? '').replace(/[<>]/g, '').slice(0, 300);
  if (!clean.trim()) throw new Error('文本为空');
  const dir = cacheDir ?? path.join(os.tmpdir(), 'dsh-whale-live');
  await fs.mkdir(dir, { recursive: true });
  const sig = createHash('sha1')
    .update(`${voiceId}|${instructions}|${guidanceScale}|${clean}`)
    .digest('hex')
    .slice(0, 20);
  const cached = path.join(dir, `breeze-${sig}.wav`);
  let hit = true;
  try { await fs.access(cached); } catch { hit = false; }
  if (!hit) {
    const { pcm, sampleRate, firstMs, totalMs } = await synthesizeBreeze(clean, opts);
    const tmp = path.join(dir, `breeze-${Date.now()}.part`);
    await fs.writeFile(tmp, pcmToWav(pcm, sampleRate));
    await fs.rename(tmp, cached).catch(async () => {
      await fs.copyFile(tmp, cached).catch(() => {});
      await fs.unlink(tmp).catch(() => {});
    });
    log(`BreezeBlue 合成 ${clean.length} 字 → ${(pcm.length / (sampleRate * 2)).toFixed(2)} 秒音频`
      + `（首包 ${firstMs ?? '-'}ms / 共 ${totalMs ?? '-'}ms）`);
  } else {
    log('BreezeBlue 命中缓存');
  }
  return cached;
}

/** 用 BreezeBlue 说话（合成 + 播放）。 */
export async function speakBreeze(text, opts = {}) {
  const file = await prepareBreeze(text, opts);
  return playWithLipSync(file, { inject: opts.inject, log: opts.log ?? (() => {}), keepFile: true });
}