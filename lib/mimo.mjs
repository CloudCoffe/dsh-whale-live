/**
 * 小米 MiMo-V2.5-TTS：对话式语音合成。
 *
 * 反直觉的地方 —— 它不用 /v1/audio/speech，而是**骑在 /v1/chat/completions 上**：
 *   messages[user]      = 语气/音色要求（voicedesign 模型必填，用来描述音色）
 *   messages[assistant] = 要念的正文（注意：正文必须在 assistant 里，放 user 里没用）
 *   audio.format        = wav | mp3 | pcm | pcm16（流式建议 pcm16）
 *   audio.voice         = 内置音色名 / 克隆模型的 DataURL 样本
 * 音频以 **base64 塞在返回消息里**（message.audio.data），不是二进制流。
 *
 * 实测（2026-10-28，本机，非流式）：短句 1.1~1.7s；这条 26 字 2.1~2.6s。
 * 流式（SSE + pcm16）：响应头 ~0.9s、首个音频分片 ~0.9s、总 1.8s 出完 5.12s 音频。
 * 输出统一 24000Hz 单声道 16bit，和 BreezeBlue 一致，口型模块可以直接复用。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { pcmToWav } from './tts.mjs';

const SAMPLE_RATE = 24000;

function buildMessages(text, voiceDesc) {
  const messages = [];
  if (voiceDesc) messages.push({ role: 'user', content: voiceDesc });
  messages.push({ role: 'assistant', content: text });
  return messages;
}

function pickAudioB64(json) {
  const msg = json?.choices?.[0]?.message ?? {};
  return msg.audio?.data ?? msg.audio?.audio ?? json?.audio?.data ?? null;
}

/** 非流式：一次拿整段 wav。慢一点，但最简单、最不容易坏。 */
async function requestOnce({ text, apiKey, baseUrl, model, voiceDesc, voice, stream, format, timeoutMs }) {
  const audio = { format };
  if (voice) audio.voice = voice;
  const body = { model, messages: buildMessages(text, voiceDesc), audio, stream };
  if (stream) body.stream = true;

  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** 把 SSE 里的 base64 音频分片攒成完整 PCM，顺便记下首包时间。onChunk 让它能边到边播。 */
async function collectStream(res, startedAt, onChunk) {
  const decoder = new TextDecoder();
  const parts = [];
  let buffer = '';
  let firstMs = -1;
  let events = 0;
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      events += 1;
      let json;
      try { json = JSON.parse(payload); } catch { continue; }
      const b64 = json?.choices?.[0]?.delta?.audio?.data ?? json?.choices?.[0]?.message?.audio?.data ?? json?.audio?.data;
      if (!b64) continue;
      const bytes = Buffer.from(b64, 'base64');
      if (!bytes.length) continue;
      if (firstMs < 0) firstMs = Date.now() - startedAt;
      parts.push(bytes);
      // 关键：拿到一片就抛给播放器，别等整段
      if (onChunk) { try { onChunk(bytes); } catch { /* 播放器出错不该影响合成 */ } }
    }
  }
  return { pcm: Buffer.concat(parts), firstMs, events };
}

/**
 * 合成一段话。返回 { wav, sampleRate, firstMs, totalMs, mode }。
 * 默认走流式（首包 ~0.9s）；流式失败自动退回非流式 wav 一次，并把原因带回 mode 里。
 */
export async function synthesizeMimo(text, {
  apiKey,
  baseUrl = 'https://api.xiaomimimo.com',
  model = 'mimo-v2.5-tts-voicedesign',
  voiceDesc = '',
  voice = '',
  stream = true,
  timeoutMs = 60_000,
  onChunk = null,
} = {}) {
  if (!apiKey) throw new Error('缺少 MiMo API Key');
  if (!text?.trim()) throw new Error('没有要念的字');

  const base = String(baseUrl).replace(/\/+$/, '');
  const startedAt = Date.now();

  if (stream) {
    try {
      const res = await requestOnce({
        text, apiKey, baseUrl: base, model, voiceDesc, voice,
        stream: true, format: 'pcm16', timeoutMs,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${detail.replace(/\s+/g, ' ').slice(0, 160)}`);
      }
      const { pcm, firstMs } = await collectStream(res, startedAt, onChunk);
      if (!pcm.length) throw new Error('流式返回里没有音频分片');
      return {
        wav: pcmToWav(pcm, SAMPLE_RATE),
        sampleRate: SAMPLE_RATE,
        firstMs,
        totalMs: Date.now() - startedAt,
        mode: 'stream',
      };
    } catch (err) {
      // 退到非流式再试一次；这次要是也失败，把两次的原因都说清楚
      const first = String(err?.message ?? err);
      const res = await requestOnce({
        text, apiKey, baseUrl: base, model, voiceDesc, voice,
        stream: false, format: 'wav', timeoutMs,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`流式失败（${first}）；非流式也失败（HTTP ${res.status} ${detail.replace(/\s+/g, ' ').slice(0, 140)}）`);
      }
      const json = await res.json();
      const b64 = pickAudioB64(json);
      if (!b64) throw new Error(`非流式返回里没有音频字段（流式失败原因：${first}）`);
      return {
        wav: Buffer.from(b64, 'base64'),
        sampleRate: SAMPLE_RATE,
        firstMs: Date.now() - startedAt,
        totalMs: Date.now() - startedAt,
        mode: 'fallback-none-stream',
      };
    }
  }

  const res = await requestOnce({
    text, apiKey, baseUrl: base, model, voiceDesc, voice,
    stream: false, format: 'wav', timeoutMs,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${detail.replace(/\s+/g, ' ').slice(0, 160)}`);
  }
  const json = await res.json();
  const b64 = pickAudioB64(json);
  if (!b64) throw new Error('返回里没有音频字段');
  return {
    wav: Buffer.from(b64, 'base64'),
    sampleRate: SAMPLE_RATE,
    firstMs: Date.now() - startedAt,
    totalMs: Date.now() - startedAt,
    mode: 'one-shot',
  };
}

/** 缓存文件路径（不含是否存在判断），供"先查缓存决定要不要走流式"用。 */
export function mimoCachePath(text, {
  cacheDir, model = 'mimo-v2.5-tts-voicedesign', voice = '', voiceDesc = '',
} = {}) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  const dir = cacheDir || path.join(os.tmpdir(), 'whale-mimo');
  const sig = crypto.createHash('sha1')
    .update(['mimo', model, voice, voiceDesc, clean].join('\u0001'))
    .digest('hex')
    .slice(0, 16);
  return { file: path.join(dir, `mimo-${sig}.wav`), dir, clean };
}

/** 合成并落盘（带磁盘缓存）。返回 wav 文件路径。 */
export async function prepareMimo(text, {
  cacheDir, log = () => {}, ...opts
} = {}) {
  const { file: cached, dir, clean } = mimoCachePath(text, { cacheDir, ...opts });
  if (!clean) throw new Error('没有要念的字');
  await fs.mkdir(dir, { recursive: true });

  try {
    await fs.access(cached);
    log(`MiMo 命中缓存（${clean.length} 字）`);
    return cached;
  } catch { /* 没缓存，继续合成 */ }

  const { wav, firstMs, totalMs, mode } = await synthesizeMimo(clean, opts);
  const tmp = `${cached}.part`;
  await fs.writeFile(tmp, wav);
  await fs.rename(tmp, cached).catch(async () => {
    await fs.copyFile(tmp, cached).catch(() => {});
    await fs.unlink(tmp).catch(() => {});
  });
  const secs = (wav.length - 44) / (SAMPLE_RATE * 2);
  log(`MiMo 合成 ${clean.length} 字 → ${secs.toFixed(2)} 秒音频（首包 ${firstMs}ms / 共 ${totalMs}ms / ${mode}）`);
  return cached;
}