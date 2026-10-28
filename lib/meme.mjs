/**
 * 梗库查询：本地 SQLite 优先，没命中再"悄悄"去 cnmeme.wiki 预查后台补进来。
 *
 * 本地库来自 `astrbot_plugin_memewiki`（AstrBot 的「梗百科」插件）那份 `data/memes.db`：
 * 6668 条、`node:sqlite` 直读、单次查询 1 毫秒级 —— 直播等不起网络，所以**先本地**。
 *
 * 在线那一路为什么是"后台"而不是"当场"：
 *   实测 cnmeme.wiki 一次 1.5~3.7 秒，而且模糊搜索常给出不相干的结果
 *   （查「家人们谁懂啊」返回「假装自己是探店博主」）。当场等三秒还答错，比不答更糟。
 *   所以流程是：本地没命中 → 把这条弹幕里"像是在问的那个词"丢进队列 → 后台逐条查
 *   → **只收标题对得上的** → 写进本地缓存。同一个梗第二次出现时就已经是 0 延迟了。
 *
 * 匹配规则沿用 memewiki 的原逻辑：**弹幕里必须完整出现某个标题**，取最长的那个。
 * 例：「尊嘟假嘟是什么梗」→ 命中「尊嘟假嘟」；「你是什么」不会命中「你是什么冠军」。
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { httpGetJsonViaProxy } from './proxy.mjs';

const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 400;

/** 在线预查的节奏：慢一点没关系，但别把人家 API 打爆，也别让队列无限长。 */
const ONLINE = {
  gapMs: 4000,       // 两次请求之间至少隔 4 秒
  timeoutMs: 12_000,
  queueMax: 60,
  retryHours: 24,    // 没查到时隔一天再试（新梗是慢慢进库的）
  maxTries: 3,       // 试满 3 次就别再浪费请求了
  pumpMs: 5000,      // 队列空转的检查间隔
  refreshMs: 6 * 3600_000,
};

const API = 'https://cnmeme.wiki/api/v1/public/memes';

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

/** 比较用的规范化：小写 + 去掉空白/标点/符号。中文标点也算，不然「尊嘟假嘟？」对不上。 */
function norm(s) {
  return String(s ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

/** 「他到底在问哪个词」—— 只在本地没命中时才用，所以宁可保守：猜不准就不查。 */
function extractCandidate(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return '';
  // 长的放前面：「是什么意思」要先于「什么意思」命中，否则会切出「已老实是」这种残词
  const cue = /(是什么意思|是什么梗|什么意思啊|什么意思|是啥意思|啥意思|什么梗|啥梗|什么来头|哪来的|怎么火的|怎么来的|是啥|是什么)/;
  const hit = raw.match(cue);
  let head = hit ? raw.slice(0, hit.index) : raw;
  head = head.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  // 去不掉的口语前缀 / 后缀（「主播这个班味到底是啥意思」→「班味」）
  head = head.replace(/^(主播|大肥鱼|老师|请问|问一下|想问|话说|那个|这个|这|那|有没有人|有人|谁知道|知道)+/u, '');
  head = head.replace(/(就是|到底是|究竟|是)+$/u, '');
  head = head.replace(/(到底|究竟|呀|啊|哦|的|了|吗|呢|吧|嘛|哈)+$/u, '');
  if (!hit) {
    // 没有提问词：只接受"短得像一个词"的整句（如「班味」「尊嘟假嘟」）
    // 「你吃饭了没有」这种 6 个字的口水话别去占一次请求
    if (head.length > 5) return '';
  }
  if (head.length < 2 || head.length > 12) return '';
  if (!/[\p{L}\p{N}]/u.test(head)) return '';
  return head;
}

export function createMemeWiki({
  dbPath = '', online = true, proxy = '', cachePath = '', log = () => {},
} = {}) {
  let db = null;
  let error = '';
  let count = 0;
  let builtAt = '';
  let stmtTitle = null;
  let stmtFind = null;
  const cache = new Map();
  let lastHit = null;

  /** 在线补进来的词条，key 是规范化后的词 */
  const onlineEntries = new Map();
  /** 查过但没查到：{ at, tries, nextAt } */
  const misses = new Map();
  const queue = [];
  const queued = new Set();
  let pumping = false;
  let lastOnline = null;
  let lastPumpAt = 0;
  let timer = null;
  let refreshTimer = null;

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
      // instr(lower(?), lower(title)) > 0：弹幕里包含这个词条标题；排序取最长的（更具体的优先）
      // 两侧都套 lower()：弹幕常写小写 yyds，词库标题是 YYDS，不对齐就查不到
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

  /* ---------------- 本地库 ---------------- */

  function findLocalTitle(text) {
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

  function localLookup(title) {
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
        source: 'local',
      };
      if (cache.size >= CACHE_MAX) cache.clear();
      cache.set(key, { at: Date.now(), entry });
      return entry;
    } catch (err) {
      log(`梗库取词失败：${err?.message ?? err}`);
      return null;
    }
  }

  /* ---------------- 在线缓存 ---------------- */

  function loadCacheFile() {
    if (!cachePath) return;
    try {
      if (!fs.existsSync(cachePath)) return;
      const j = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      for (const [k, v] of Object.entries(j.entries ?? {})) onlineEntries.set(k, v);
      for (const [k, v] of Object.entries(j.misses ?? {})) misses.set(k, v);
    } catch (err) {
      log(`在线缓存读不出来（忽略，从空开始）：${err?.message ?? err}`);
    }
  }

  let saveTimer = null;
  function saveCacheFile() {
    if (!cachePath || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        const payload = {
          savedAt: new Date().toISOString(),
          entries: Object.fromEntries(onlineEntries),
          misses: Object.fromEntries(misses),
        };
        fs.writeFileSync(cachePath, JSON.stringify(payload, null, 2), 'utf8');
      } catch (err) {
        log(`在线缓存写不进去：${err?.message ?? err}`);
      }
    }, 800);
    saveTimer.unref?.();
  }

  /** 只收标题对得上的：不然「家人们谁懂啊」会被塞一条「假装自己是探店博主」。 */
  function pickRelevant(term, items) {
    const want = norm(term);
    if (!want) return null;
    let best = null;
    let bestScore = 0;
    for (const it of Array.isArray(items) ? items : []) {
      const t = String(it?.title ?? '');
      const nt = norm(t);
      if (nt.length < 2) continue;
      let score = 0;
      if (nt === want) score = 100;
      else if (want.includes(nt)) score = 60 + nt.length;       // 弹幕里带了完整标题
      // 标题以问的词开头也算（词库喜欢用整句当标题：问「偷感」→ 词条「偷感很重」）
      // 但**不能**用"标题里包含词"：问「班味」会匹配到「黑丝班味论」，相关却不是一个梗
      else if (nt.startsWith(want)) score = 40 + want.length;
      if (score > bestScore) { bestScore = score; best = it; }
    }
    if (!best) return null;
    const tags = Array.isArray(best.tags) ? best.tags.join('、') : String(best.tags ?? '');
    return {
      title: String(best.title ?? ''),
      tags,
      usage: '',
      origin: '',
      fallbackText: String(best.summary ?? '').trim(),
      source: 'cnmeme',
    };
  }

  async function fetchOne(term) {
    try {
      const url = `${API}?q=${encodeURIComponent(term)}&limit=5`;
      const j = await httpGetJsonViaProxy(url, { proxy, timeoutMs: ONLINE.timeoutMs });
      const entry = pickRelevant(term, j?.items);
      const key = norm(term);
      if (entry) {
        onlineEntries.set(key, entry);
        misses.delete(key);
        lastOnline = { at: new Date().toISOString(), term, title: entry.title, ok: true };
        log(`在线补到梗：「${term}」→「${entry.title}」`);
        saveCacheFile();
        return entry;
      }
      const prev = misses.get(key);
      const tries = (prev?.tries ?? 0) + 1;
      misses.set(key, { at: Date.now(), tries, nextAt: Date.now() + ONLINE.retryHours * 3600_000 });
      lastOnline = { at: new Date().toISOString(), term, title: '', ok: false, reason: '标题都对不上' };
      saveCacheFile();
      return null;
    } catch (err) {
      const key = norm(term);
      const prev = misses.get(key);
      misses.set(key, {
        at: Date.now(),
        tries: (prev?.tries ?? 0) + 1,
        nextAt: Date.now() + ONLINE.retryHours * 3600_000,
      });
      lastOnline = { at: new Date().toISOString(), term, title: '', ok: false, reason: err?.message ?? String(err) };
      log(`在线查梗失败「${term}」：${err?.message ?? err}`);
      saveCacheFile();
      return null;
    }
  }

  async function pump() {
    if (pumping || !online || !queue.length) return;
    pumping = true;
    try {
      while (queue.length) {
        const wait = ONLINE.gapMs - (Date.now() - lastPumpAt);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        const term = queue.shift();
        queued.delete(norm(term));
        lastPumpAt = Date.now();
        await fetchOne(term);
      }
    } finally {
      pumping = false;
    }
  }

  /** 本地没命中时调用：猜一下观众在问什么，丢进后台队列。 */
  function noteMiss(text) {
    if (!online) return null;
    const term = extractCandidate(text);
    const key = norm(term);
    if (!term || key.length < 2) return null;
    if (onlineEntries.has(key)) return null;
    const miss = misses.get(key);
    if (miss && (miss.tries >= ONLINE.maxTries || (miss.nextAt ?? 0) > Date.now())) return null;
    if (queued.has(key) || queue.length >= ONLINE.queueMax) return null;
    queue.push(term);
    queued.add(key);
    return term;
  }

  /** 隔一阵把"以前没查到、但可能已经进库了"的词重新排一次队。 */
  function refreshMisses() {
    if (!online) return 0;
    const nowMs = Date.now();
    let n = 0;
    for (const [key, m] of misses) {
      if (m.tries >= ONLINE.maxTries) continue;
      if ((m.nextAt ?? 0) > nowMs) continue;
      if (queued.has(key)) continue;
      queue.push(key);
      queued.add(key);
      n += 1;
    }
    if (n) log(`重试 ${n} 个以前没查到的词`);
    return n;
  }

  function findOnlineTitle(text) {
    if (!onlineEntries.size) return null;
    const n = norm(text);
    if (!n) return null;
    let best = null;
    for (const [key, entry] of onlineEntries) {
      if (key.length < 2) continue;
      if (!n.includes(key)) continue;
      if (!best || key.length > best.key.length) best = { key, entry };
    }
    return best ? best.entry : null;
  }

  /* ---------------- 对外 ---------------- */

  /** 一步到位：弹幕 → 命中的词条（先本地，再在线缓存）。 */
  function query(text) {
    const title = findLocalTitle(text);
    let entry = title ? localLookup(title) : null;
    if (!entry) entry = findOnlineTitle(text);
    if (!entry) {
      noteMiss(text);
      return { hit: false, queued: queue.length };
    }
    lastHit = { at: new Date().toISOString(), title: entry.title, text: String(text ?? '').slice(0, 80), source: entry.source };
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

  /* ---------------- 启动 ---------------- */

  loadCacheFile();
  if (online) {
    timer = setInterval(() => { pump().catch((err) => log(`在线队列出错：${err?.message ?? err}`)); }, ONLINE.pumpMs);
    timer.unref?.();
    refreshTimer = setInterval(() => { refreshMisses(); }, ONLINE.refreshMs);
    refreshTimer.unref?.();
  }

  return {
    get ready() { return Boolean(open()); },
    get state() {
      open(); // 状态查询本身也顺手把库打开，别报 ready:false
      return {
        ready: Boolean(db),
        entries: count,
        builtAt,
        dbPath,
        error,
        lastHit,
        online: {
          enabled: online,
          proxy: proxy || '(直连)',
          cached: onlineEntries.size,
          missed: misses.size,
          queue: queue.length,
          last: lastOnline,
        },
      };
    },
    findTitle: findLocalTitle,
    lookup: localLookup,
    query,
    noteMiss,
    contextFor,
    refreshMisses,
    /** 测试用：直接等一次在线查询的结果 */
    async lookupOnline(term) {
      if (!online) return null;
      return fetchOne(String(term ?? ''));
    },
    dispose() {
      if (timer) clearInterval(timer);
      if (refreshTimer) clearInterval(refreshTimer);
      if (saveTimer) clearTimeout(saveTimer);
      try { db?.close(); } catch { /* ignore */ }
      db = null;
      cache.clear();
      queue.length = 0;
      queued.clear();
    },
  };
}