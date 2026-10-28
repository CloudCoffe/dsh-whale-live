/**
 * 语音文本裁剪：超长就在标点处截断，只念前半句。
 *
 * 为什么值得做：MiMo 的首包时间随字数线性增长
 * （11 字 1.1s / 25 字 2.0s / 65 字 3.4s），长句等于让观众干等。
 * 截断能把开口时间摁在 2 秒以内。
 *
 * 找断点的顺序（越靠前越优先）：
 *   1. max 之内最后一个**句末**标点（。！？；…），且不能早于一半 —— 最自然的收尾；
 *   2. max 之后 max+OVERSHOOT 之内的**第一个**句末标点 —— 宁可多说几个字也别切词；
 *   3. max 之内最后一个**逗号类**软断点，同样不能早于一半；
 *   4. 都没有 → 按字数硬切（至少长度可控）。
 *
 * 第 2 条是关键：只在"向后找"上开一个小窗口，就不会出现
 * "……玩哦，真" 这种断在词中间的结果。
 */

const BREAK_HARD = /[。！？!?；;…—]/;
const BREAK_SOFT = /[，,、]/;
const OVERSHOOT = 8;

/**
 * 念之前先把"写着好看、念出来难听"的符号改掉。
 *
 * 主要是省略号：文字里「除非你送我一个蛋糕……」很自然，但 TTS 会把它读成一段很长的空白。
 * 实测同样 20 个字，带「……」的版本音频 6.9 秒，换成逗号后 4.5 秒 —— 观众只会觉得卡了。
 */
export function normalizeForSpeech(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/(?:…|\.{3,})+/g, '，') // 省略号 → 逗号（短停顿）
    .replace(/[~～]+/g, '，') // 波浪号常被拖成长音
    .replace(/！{2,}/g, '！')
    .replace(/？{2,}/g, '？')
    .replace(/\s+([，。！？；：,.!?;:])/g, '$1')
    .trim();
}

export function clampSpeech(text, maxChars) {
  const clean = normalizeForSpeech(text);
  const max = Number(maxChars) > 0 ? Number(maxChars) : 0;
  if (!clean || !max || clean.length <= max) {
    return { text: clean, truncated: false, original: clean.length };
  }

  const findLast = (re, end, floor) => {
    for (let i = Math.min(end, clean.length - 1); i >= floor; i -= 1) {
      if (re.test(clean[i])) return i;
    }
    return -1;
  };
  const findNext = (re, from, until) => {
    for (let i = from; i < Math.min(until, clean.length); i += 1) {
      if (re.test(clean[i])) return i;
    }
    return -1;
  };

  const half = Math.floor(max * 0.5);
  let cut = findLast(BREAK_HARD, max, half);
  if (cut < 0) cut = findNext(BREAK_HARD, max, max + OVERSHOOT);
  if (cut < 0) cut = findLast(BREAK_SOFT, max, half);

  const out = cut >= 0 ? clean.slice(0, cut + 1) : clean.slice(0, max);
  return { text: out, truncated: true, original: clean.length };
}