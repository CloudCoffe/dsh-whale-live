/**
 * 梗库查询：直接读 astrbot_plugin_memewiki 那份 SQLite（6668 条，2026-10 快照）。
 *
 * 为什么读它的库而不是接它的 API：
 *   - 它是 AstrBot（Python）插件，DSH 这边没法直接调它的代码；
 *   - 但它的 `data/memes.db` 是一份标准 SQLite，Node 24 自带的 `node:sqlite` 能直接读；
 *   - 本地查一次 **1 毫秒级**，比任何网络方案都适合直播（弹幕等不起）。
 *
 * ⚠️ 在线兜底（cnmeme.wiki）**默认关**：那台是 Cloudflare，Node 不走系统代理就连不上
 *   （`UND_ERR_CONNECT_TIMEOUT`），和当年 BreezeBlue 是同一个坑。要开就得绕 PowerShell，
 *   一次多花 1 秒左右 —— 对直播来说不划算。所以没命中就让大模型自己判断。
 *
 * 匹配规则沿用 memewiki 的原逻辑：**弹幕里必须完整出现某个词条标题**，取最长的那个。
 * 例：「尊嘟假嘟是什么梗」→ 命中「尊嘟假嘟」；「你是什么」不会命中「你是什么冠军」。
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';

const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 400;

/**
 * `node:sqlite` 在 Node 22 要开 flag、23.4+ 才默认可用。
 * 这里**延迟加载**：宿主万一没有这个内置模块，只是"查梗功能不可用"，
 * 不能连累整个插件加载失败（静态 import 会直接抛在模块加载期）。
 */
let DatabaseSync = null;
let sqliteError = '';
function loadSqlite() {
  if (DatabaseSync) return DatabaseSync;
  try {
    const req = createRequire(import.meta.url);
    ({ DatabaseSync } = req('node:sqlite'));
  } catch (err) {
    sqliteError = `这个 Node 没有 node:sqlite（${err?.message ?? err}）`;
    return null;
  }
  return DatabaseSync;
}

export function createMemeWiki({ dbPath = '', log = () => {} } = {}) {
  let db = null;
  let error = '';
  let count = 0;
  let builtAt = '';
  let stmtTitle = null;
  let stmtFind = null;
  const cache = new Map();
  let lastHit = null;

  function open() {
    if (db || error) return db;
    if (!dbPath) { error = '没配梗库路径'; return null; }
    if (!loadSqlite()) { error = sqliteError; return null; }
    try {
      if (!fs.existsSync(dbPath)) { error = `梗库文件不存在：${dbPath}`; return null; }
      db = new DatabaseSync(dbPath, { readOnly: true });
      count = db.prepare('SELECT COUNT(*) AS n FROM memes').get().n;
      try {
        builtAt = db.prepare("SELECT value FROM meta WHERE key = 'built_at'").get()?.value ?? '';
      } catch { /* meta 表可能没有 */ }
      stmtTitle = db.prepare('SELECT title FROM memes WHERE lower(title) = lower(?)');
      // instr(?1, title) > 0：弹幕里包含这个词条标题；排序取最长的（更具体的优先）
      // lower() 两侧都套：弹幕里常写小写 yyds，词库标题是 YYDS，不这样对不上
      stmtFind = db.prepare(
        'SELECT title FROM memes WHERE length(title) >= 2 AND instr(lower(?), lower(title)) > 0 '
        + 'ORDER BY length(title) DESC LIMIT 1',
      );
      log(`梗库已加载：${count} 条${builtAt ? `（构建于 ${builtAt}）` : ''}`);
      return db;
    } catch (err) {
      error = `梗库打不开：${err?.message ?? err}`;
      log(error);
      db = null;
      return null;
    }
  }

  /** 弹幕里出现的最长词条标题（没有就是 null）。 */
  function findTitle(text) {
    const clean = String(text ?? '').trim();
    if (!clean || !open()) return null;
    try {
      const exact = stmtTitle.get(clean);
      if (exact) return exact.title;
      const hit = stmtFind.get(clean);
      return hit ? hit.title : null;
    } catch (err) {
      log(`梗库查询失败：${err?.message ?? err}`);
      return null;
    }
  }

  function lookup(title) {
    const key = String(title ?? '').trim();
    if (!key) return null;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.entry;
    if (!open()) return null;
    try {
      const row = db.prepare(
        'SELECT title, tags, usage, origin, other, summary FROM memes WHERE lower(title) = lower(?) LIMIT 1',
      ).get(key);
      if (!row) return null;
      const entry = {
        title: row.title,
        tags: row.tags || '',
        usage: (row.usage || '').trim(),
        origin: (row.origin || '').trim(),
        fallbackText: (row.other || row.summary || '').trim(),
      };
      if (cache.size >= CACHE_MAX) cache.clear();
      cache.set(key, { at: Date.now(), entry });
      return entry;
    } catch (err) {
      log(`梗库取词失败：${err?.message ?? err}`);
      return null;
    }
  }

  /** 一步到位：弹幕 → 命中的词条（含解释）。 */
  function query(text) {
    const title = findTitle(text);
    if (!title) return { hit: false };
    const entry = lookup(title);
    if (!entry) return { hit: false };
    lastHit = { at: new Date().toISOString(), title, text: String(text ?? '').slice(0, 80) };
    return { hit: true, entry };
  }

  /**
   * 给大模型的梗资料。**只喂解释，不喂整段原文** —— 词条里常有几百字长段落，
   * 全塞进去既费 token 又会让它照着念（大肥鱼要的是"一句话抖机灵"，不是百科播报）。
   */
  function contextFor(entry, maxChars = 220) {
    if (!entry) return '';
    const usage = (entry.usage || entry.fallbackText || '').replace(/\s+/g, ' ');
    const origin = (entry.origin || '').replace(/\s+/g, ' ');
    const parts = [`词条：${entry.title}`];
    if (entry.tags) parts.push(`类型：${entry.tags.split('、').slice(0, 4).join('、')}`);
    if (usage) parts.push(`用法：${usage.slice(0, maxChars)}`);
    if (origin) parts.push(`来源：${origin.slice(0, Math.round(maxChars * 0.7))}`);
    return parts.join('\n');
  }

  return {
    get ready() { return Boolean(open()); },
    get state() {
      open(); // 状态查询本身也顺手把库打开，别报 ready:false
      return { ready: Boolean(db), entries: count, builtAt, dbPath, error, lastHit };
    },
    findTitle,
    lookup,
    query,
    contextFor,
    dispose() {
      try { db?.close(); } catch { /* ignore */ }
      db = null;
      cache.clear();
    },
  };
}