/**
 * 观众记忆：记住直播间里的每一个人说过什么、说过几句，沉淀出「老面孔」。
 *
 * 为什么不是直接把 dsh-fish-memory 搬过来：
 *   dsh-fish-memory 是**会话级**记忆（给模型用的，一个会话一个 JSON，
 *   靠「鲜活度 + 证据命中」召回），它记的是「我和 ta 聊了什么」。
 *   直播间要的正好反过来 —— 记的是**别人**，而且是可数的（谁来了几次、说了几句），
 *   要在人一进房就立刻判断「这人是不是熟脸」，不能走"够不够特别"那套召回。
 *   所以这里只借它两条思路：
 *     - 「记重点，别全存」：每人只留最近 3 句原文，其他只留计数；
 *     - 「会淡忘」：够久没来、又没说过几句的，容量满了先清掉。
 *
 * 数据落在 whale-live/audience.json，一次直播跑完也不会丢 —— 这就是"沉淀"。
 * 写盘是防抖的（4 秒一次），断电最多丢 4 秒的计数，不会丢整个文件。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

const SAVE_DEBOUNCE_MS = 4000;
/** 每人最多留几句原文（再多也没用 —— 回弹幕时只会带最近 3 句）。 */
const TEXTS_KEEP = 3;
const TEXT_MAX = 80;

/** 欢迎台词。{user} 昵称 / {visits} 第几天来 / {count} 说过几句。 */
const WELCOME_LINES = [
  '欢迎{user}来看大肥鱼！',
  '{user}来啦，大肥鱼等你半天了！',
  '欢迎{user}！这是你第{visits}天来看大肥鱼～',
];

const pad = (n) => String(n).padStart(2, '0');
/** 本地日期（主播那边的时间），用来数"来过几天"。 */
const dayOf = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const str = (v, max = 0) => {
  const s = String(v ?? '').trim();
  return max > 0 ? s.slice(0, max) : s;
};

const emptyData = () => ({ version: 1, updatedAt: null, totalMessages: 0, viewers: {} });

/**
 * @param {object} opts
 * @param {string} opts.file        存档路径（audience.json）
 * @param {number} [opts.topN]      前几名算"熟面孔"（进场要欢迎）
 * @param {number} [opts.minCount]  至少说过几句才算（防止第一天来的人就被当熟脸）
 * @param {number} [opts.welcomeCooldownMs] 同一个人两次欢迎的最短间隔
 * @param {number} [opts.maxViewers] 最多记多少人（超了先清淡掉的）
 * @param {(msg: string) => void} [opts.log]
 */
export function createAudienceMemory({
  file,
  topN = 5,
  minCount = 3,
  welcomeCooldownMs = 30 * 60_000,
  maxViewers = 2000,
  log = () => {},
} = {}) {
  let topLimit = Math.max(1, Number(topN) || 5);
  let floor = Math.max(1, Number(minCount) || 3);
  let cooldown = Math.max(0, Number(welcomeCooldownMs) || 0);
  let cap = Math.max(10, Number(maxViewers) || 2000);

  let data = emptyData();
  let dirty = false;
  let timer = null;
  let welcomeIdx = 0;
  let lastSaveError = '';
  let lastSavedAt = 0;
  /** 排行榜缓存：进场事件一阵一阵来，别每次都全表排序。 */
  let rankedCache = null;

  function load() {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      if (!raw || typeof raw !== 'object') return;
      const viewers = (raw.viewers && typeof raw.viewers === 'object') ? raw.viewers : {};
      const clean = {};
      for (const [key, v] of Object.entries(viewers)) {
        if (!v || typeof v !== 'object') continue;
        const count = Math.max(0, Math.floor(Number(v.count) || 0));
        const entry = {
          uid: Number(v.uid) || 0,
          name: str(v.name, 40),
          count,
          visits: Math.max(0, Math.floor(Number(v.visits) || 0)),
          firstAt: Number(v.firstAt) || 0,
          lastAt: Number(v.lastAt) || 0,
          lastDay: str(v.lastDay, 10),
          lastText: str(v.lastText, TEXT_MAX),
          texts: Array.isArray(v.texts) ? v.texts.map((t) => str(t, TEXT_MAX)).filter(Boolean).slice(-TEXTS_KEEP) : [],
          welcomeAt: Number(v.welcomeAt) || 0,
          welcomed: Math.max(0, Math.floor(Number(v.welcomed) || 0)),
        };
        if (!entry.name && !entry.uid) continue;
        clean[key] = entry;
      }
      data = {
        version: 1,
        updatedAt: raw.updatedAt ? String(raw.updatedAt) : null,
        totalMessages: Math.max(0, Number(raw.totalMessages) || 0),
        viewers: clean,
      };
      if (Object.keys(clean).length) {
        log(`观众记忆已载入：${Object.keys(clean).length} 人 / ${data.totalMessages} 条发言`);
      }
    } catch (err) {
      // 第一次跑没有这个文件是正常的；有文件却读不出来才值得说一声
      if (existsSync(file)) log(`观众记忆读不出来（这次当空的用，不会覆盖旧文件以外的数据）：${err?.message ?? err}`);
    }
  }

  function save() {
    if (!dirty) return false;
    try {
      data.updatedAt = new Date().toISOString();
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(data), 'utf8');
      renameSync(tmp, file);
      dirty = false;
      lastSaveError = '';
      lastSavedAt = Date.now();
      return true;
    } catch (err) {
      lastSaveError = String(err?.message ?? err);
      log(`观众记忆写盘失败：${lastSaveError}`);
      return false;
    }
  }

  function markDirty() {
    dirty = true;
    rankedCache = null;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      save();
    }, SAVE_DEBOUNCE_MS);
    timer.unref?.();
  }

  /** 同一个人的稳定键：优先 uid，没有 uid 才退回昵称。 */
  const keyOf = (event) => {
    const uid = Number(event?.uid ?? 0);
    if (uid > 0) return `u${uid}`;
    const name = str(event?.user, 40);
    return name ? `n:${name}` : '';
  };

  function touch(event) {
    const key = keyOf(event);
    if (!key) return null;
    const name = str(event?.user, 40);
    const now = Date.now();
    const today = dayOf(now);
    let v = data.viewers[key];
    if (!v) {
      v = data.viewers[key] = {
        uid: Math.max(0, Number(event?.uid) || 0),
        name,
        count: 0,
        visits: 0,
        firstAt: now,
        lastAt: now,
        lastDay: '',
        lastText: '',
        texts: [],
        welcomeAt: 0,
        welcomed: 0,
      };
    }
    if (name && name !== v.name) v.name = name; // 改名了跟着改
    v.lastAt = now;
    if (v.lastDay !== today) { v.visits += 1; v.lastDay = today; }
    return v;
  }

  /**
   * 容量满了才动手，而且从**最末尾**清 —— 排序本来就是「说得最少、最久没来」在最后，
   * 所以自然先淡掉那些来过一次、没说过话的人。前 topN 永远不动（他们是"沉淀"下来的）。
   */
  function prune() {
    let total = Object.keys(data.viewers).length;
    if (total <= cap) return 0;
    const start = total;
    const list = ranked();
    const protect = new Set(list.slice(0, topLimit).map((r) => r.key));
    let removed = 0;
    for (let i = list.length - 1; i >= 0 && total > cap; i -= 1) {
      const item = list[i];
      if (protect.has(item.key)) continue;
      delete data.viewers[item.key];
      total -= 1;
      removed += 1;
    }
    if (removed) {
      log(`观众记忆超容量（${start} > ${cap}），淡掉 ${removed} 个`);
      rankedCache = null;
    }
    return removed;
  }

  function ranked() {
    const list = [];
    for (const [key, v] of Object.entries(data.viewers)) {
      list.push({
        key,
        uid: v.uid ?? 0,
        name: v.name ?? '',
        count: v.count ?? 0,
        visits: v.visits ?? 0,
        lastAt: v.lastAt ?? 0,
        lastText: v.lastText ?? '',
      });
    }
    list.sort((a, b) => (b.count - a.count) || (b.lastAt - a.lastAt));
    return list;
  }

  function rankedNow() {
    if (!rankedCache) rankedCache = ranked();
    return rankedCache;
  }

  /** 1 起的名次；查不到给 0。 */
  function rankOf(key) {
    if (!key) return 0;
    const idx = rankedNow().findIndex((r) => r.key === key);
    return idx < 0 ? 0 : idx + 1;
  }

  /**
   * 记一条：弹幕算发言（count+1），进场/关注只算"来过"。
   * 复读的「666」也记 —— 人家确实发了，回不回是另一回事。
   */
  function remember(event) {
    const kind = String(event?.kind ?? '');
    if (kind !== 'chat' && kind !== 'enter' && kind !== 'follow') return null;
    const v = touch(event);
    if (!v) return null;
    if (kind === 'chat') {
      const text = str(event?.text, TEXT_MAX);
      v.count += 1;
      data.totalMessages += 1;
      if (text) {
        v.lastText = text;
        // 原文每人只留最近 3 句（滚动丢掉最老的）。
        // 不按"够不够格"筛 —— 恰恰是新熟脸最需要被记得"上次说了啥"，
        // 而那时候他的历史只有两三句，筛掉就等于什么都没有。
        v.texts.push(text);
        if (v.texts.length > TEXTS_KEEP) v.texts = v.texts.slice(-TEXTS_KEEP);
      }
    }
    prune();
    markDirty();
    return v;
  }

  /**
   * 进场判定：这个人该不该欢迎、为什么。
   * @returns {{welcome: boolean, reason: string, key: string, name?: string, rank?: number, count?: number, visits?: number}}
   */
  function checkEnter(event) {
    const key = keyOf(event);
    if (!key) return { welcome: false, reason: '匿名（没昵称也没 uid）', key: '' };
    const v = data.viewers[key];
    const name = str(event?.user, 40) || v?.name || '';
    if (!v) return { welcome: false, reason: '新面孔（还没记着）', key, name };
    // 进场本身也记一笔（来过几天），但不加发言次数
    if (v.count < floor) return { welcome: false, reason: `只说过 ${v.count} 句`, key, name, count: v.count };
    const rank = rankOf(key);
    if (rank > topLimit) return { welcome: false, reason: `排第 ${rank}，不在前 ${topLimit}`, key, name, rank, count: v.count };
    if (v.welcomeAt && Date.now() - v.welcomeAt < cooldown) {
      const left = Math.ceil((cooldown - (Date.now() - v.welcomeAt)) / 60000);
      return { welcome: false, reason: `刚欢迎过（还差 ${left} 分钟）`, key, name, rank, count: v.count };
    }
    return { welcome: true, reason: `第 ${rank} 名老面孔（${v.count} 句 / 来过 ${v.visits} 天）`, key, name, rank, count: v.count, visits: v.visits };
  }

  /** 打过招呼之后调一下，免得人进进出出被欢迎好几遍。 */
  function markWelcomed(key) {
    const v = data.viewers[key];
    if (!v) return false;
    v.welcomeAt = Date.now();
    v.welcomed = (v.welcomed ?? 0) + 1;
    markDirty();
    return true;
  }

  /** 挑一句欢迎台词（不连着说同一句；只来过一天的不说"第几天"）。 */
  function pickWelcome(info = {}) {
    const visits = Math.max(1, Number(info.visits) || 1);
    const pool = visits >= 2 ? WELCOME_LINES : WELCOME_LINES.slice(0, 2);
    const line = pool[welcomeIdx++ % pool.length] ?? WELCOME_LINES[0];
    return line
      .replaceAll('{user}', info.name || '你')
      .replaceAll('{visits}', String(visits))
      .replaceAll('{count}', String(info.count ?? 0));
  }

  /**
   * 回弹幕时用得上的"我记得你"。
   * 只有够格的老面孔才给（否则模型会对着每个陌生人瞎套近乎）。
   */
  function flavor(event) {
    const key = keyOf(event);
    if (!key) return null;
    const v = data.viewers[key];
    if (!v || v.count < floor) return null;
    const rank = rankOf(key);
    return {
      key,
      name: v.name,
      count: v.count,
      visits: v.visits ?? 1,
      rank,
      isTop: rank > 0 && rank <= topLimit,
      recent: (v.texts ?? []).slice(-3),
    };
  }

  /** 手动查一个人（工具/面板用）：给昵称或 uid 都行。 */
  function find(query) {
    const q = str(query, 40);
    if (!q) return null;
    const asUid = Number(q);
    const key = Number.isFinite(asUid) && asUid > 0 ? `u${asUid}` : `n:${q}`;
    if (data.viewers[key]) return { key, ...data.viewers[key], rank: rankOf(key) };
    const hit = Object.entries(data.viewers).find(([, v]) => v.name === q)
      ?? Object.entries(data.viewers).find(([, v]) => v.name.includes(q));
    if (!hit) return null;
    return { key: hit[0], ...hit[1], rank: rankOf(hit[0]) };
  }

  function reset() {
    const before = Object.keys(data.viewers).length;
    data = emptyData();
    rankedCache = null;
    dirty = true;
    save();
    log(`观众记忆已清空（清掉 ${before} 个人）`);
    return before;
  }

  function configure({ topN: n, minCount: m, welcomeCooldownMs: cd, maxViewers: mx } = {}) {
    if (Number.isFinite(Number(n))) topLimit = Math.max(1, Math.floor(Number(n)));
    if (Number.isFinite(Number(m))) floor = Math.max(1, Math.floor(Number(m)));
    if (Number.isFinite(Number(cd))) cooldown = Math.max(0, Math.floor(Number(cd)));
    if (Number.isFinite(Number(mx))) cap = Math.max(10, Math.floor(Number(mx)));
    rankedCache = null;
  }

  load();

  return {
    remember,
    checkEnter,
    markWelcomed,
    pickWelcome,
    flavor,
    find,
    reset,
    configure,
    save,
    get state() {
      const top = rankedNow().slice(0, topLimit).map((r, i) => ({
        rank: i + 1,
        uid: r.uid,
        name: r.name,
        count: r.count,
        visits: r.visits,
        lastAt: r.lastAt ? new Date(r.lastAt).toISOString() : '',
        lastText: r.lastText,
      }));
      return {
        file,
        viewers: Object.keys(data.viewers).length,
        messages: data.totalMessages,
        topN: topLimit,
        minCount: floor,
        welcomeCooldownMin: Math.round(cooldown / 60000),
        maxViewers: cap,
        top,
        updatedAt: data.updatedAt,
        lastSavedAt: lastSavedAt ? new Date(lastSavedAt).toISOString() : '',
        lastSaveError,
      };
    },
    dispose() {
      if (timer) { clearTimeout(timer); timer = null; }
      return save();
    },
  };
}