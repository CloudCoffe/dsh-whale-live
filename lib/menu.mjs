/**
 * 礼物/弹幕 → 表演 的映射表 + 触发队列（优先级、冷却、连击合并、防刷）。
 *
 * 表演能力来自大肥鱼模型现有资源：15 个表情热键 + 174 个参数 + 整层旋转（MoveModel）。
 * 倒立 = 模型整体旋转 180°，因为 Live2D 只做网格变形，没有骨骼翻转动作。
 */

export const DEFAULT_MENU = [
  {
    id: 'chat',
    match: { events: ['chat'] },
    title: '随口回一句',
    expr: '05 》《',
    seconds: 1.2,
    speech: '哼哼，收到啦~',
    replyWithLlm: true,
    priority: 10,
    cooldownMs: 2000,
  },
  {
    id: 'free-gift',
    match: { gifts: ['辣条', '小心心', '亿圆', '牛哇牛哇', '小星星'], tier: 0 },
    title: '点头比心',
    expr: '05 O O',
    seconds: 1.5,
    speech: '谢谢{user}的{gift}×{num}，我嚼嚼嚼！',
    priority: 25,
    cooldownMs: 4000,
  },
  {
    id: 'normal-gift',
    match: { gifts: ['玫瑰', '真棒', '干杯', '666', '打call', '花花'], tier: 1 },
    title: '脸红道谢',
    expr: '04 脸红',
    seconds: 2,
    speech: '谢谢{user}的{gift}，脸红啦~',
    priority: 40,
    cooldownMs: 6000,
  },
  {
    id: 'tip-ticket',
    // 人气票：免费刷量的东西，别让它蹭到"倒立"，冷却也放长一点防刷屏
    match: { gifts: ['人气票'] },
    title: '人气票：精神百倍',
    expr: '05 》《',
    seconds: 1.5,
    speech: '{user}投了人气票，大肥鱼精神多了！',
    priority: 28,
    cooldownMs: 12000,
  },
  {
    id: 'fan-badge',
    // 粉丝团灯牌：点亮类的，给个脸红道谢（比票更"值得"一点）
    match: { gifts: ['粉丝团灯牌', '灯牌', '点亮灯牌'] },
    title: '灯牌：点亮比心',
    expr: '04 脸红',
    seconds: 2,
    speech: '谢谢{user}点亮灯牌，大肥鱼给你比心~',
    priority: 42,
    cooldownMs: 20000,
  },
  {
    id: 'lollipop',
    match: { gifts: ['棒棒糖', '奶茶', '蛋糕', '糖果'], tier: 2 },
    title: '倒立 3 秒',
    expr: '05 O O',
    perform: { type: 'rotate', degrees: 180, seconds: 3 },
    speech: '谢谢{user}的{gift}！我给你们倒立三秒！',
    priority: 55,
    cooldownMs: 20000,
  },
  {
    id: 'big-gift',
    match: { gifts: ['小电视', '火箭', '飞船', '嘉年华', '星际战舰'], tier: 3 },
    title: '震惊 + 转圈',
    expr: '06 X X',
    perform: { type: 'rotate', degrees: 360, seconds: 2.5 },
    speech: '哇！{user}送出了{gift}！我原地转三圈给你们看！',
    priority: 75,
    cooldownMs: 30000,
  },
  {
    id: 'superchat',
    match: { events: ['superchat'] },
    title: '读醒目留言',
    expr: '08 担心嘴',
    seconds: 2,
    speech: '谢谢{user}的醒目留言：{text}',
    readAloud: true,
    priority: 85,
    cooldownMs: 0,
  },
  {
    id: 'guard-captain',
    match: { events: ['guard'], levels: [3] },
    title: '舰长上舰：转圈 + 敬礼',
    expr: '05 O O',
    perform: { type: 'rotate', degrees: 360, seconds: 2 },
    speech: '谢谢{user}上舰！大肥鱼给你敬个礼！',
    priority: 90,
    cooldownMs: 0,
  },
  {
    id: 'guard-admiral',
    match: { events: ['guard'], levels: [1, 2] },
    title: '提督/总督：大整活',
    expr: '06 X X',
    perform: { type: 'rotate', degrees: 720, seconds: 3 },
    speech: '提督大人{user}来了！大肥鱼原地起飞了！！',
    priority: 99,
    cooldownMs: 0,
  },
];

function giftTierByPrice(price) {
  // price 的单位是金瓜子（1 电池 = 100 金瓜子）。
  // 实测：小花花/人气票/粉丝团灯牌 都被报成 100 —— 所以 100 只是"1 电池级"，
  // 拿它当第 2 档会让一切陌生礼物都去倒立，这里按真实价位分：
  if (!price) return 0;
  if (price <= 100) return 1; // ≤1 电池
  if (price <= 1000) return 2; // ≤10 电池（约 ¥1）
  return 3; // 更贵
}

/** 在一份菜单里找到匹配的条目。名字命中优先，价格档只在没有名字命中时兜底。 */
export function matchMenu(event, menu = DEFAULT_MENU) {
  if (!event) return null;
  const structural = (entry) => {
    const m = entry.match ?? {};
    if (m.events && !m.events.includes(event.kind)) return false;
    if (m.levels && event.kind === 'guard' && !m.levels.includes(Number(event.level))) return false;
    if (m.gifts && event.kind !== 'gift') return false;
    if (event.kind === 'gift' && !m.gifts) return false;
    return true;
  };

  if (event.kind === 'gift') {
    const name = String(event.gift ?? '');
    const byName = menu.find((entry) => {
      const m = entry.match ?? {};
      if (!m.gifts || !structural(entry)) return false;
      return m.gifts.some((g) => name.includes(g) || g.includes(name));
    });
    if (byName) return byName;
    return menu.find((entry) => {
      const m = entry.match ?? {};
      return structural(entry) && typeof m.tier === 'number' && giftTierByPrice(event.price) === m.tier;
    }) ?? null;
  }

  return menu.find((entry) => structural(entry)) ?? null;
}

export function renderSpeech(template, event) {
  return String(template ?? '')
    .replaceAll('{user}', event.user ?? '观众')
    .replaceAll('{gift}', event.gift ?? '礼物')
    .replaceAll('{num}', String(event.num ?? 1))
    .replaceAll('{text}', event.text ?? '');
}

/**
 * 串行执行的优先级队列。
 * - 高优先级可以插队；队列满时丢弃优先级最低的
 * - 按条目 + 用户做冷却，避免连刷触发爆炸
 */
export function createQueue({ maxSize = 10, log = () => {} } = {}) {
  /** @type {Array<{priority:number,key:string,userKey:string,run:Function}>} */
  let items = [];
  let running = false;
  let disposed = false;
  const cooldowns = new Map();
  const stats = { accepted: 0, dropped: 0, done: 0, failed: 0, merged: 0, stale: 0 };

  function cooling(key, ms) {
    if (!ms) return false;
    const until = cooldowns.get(key) ?? 0;
    return Date.now() < until;
  }

  function mark(key, ms) {
    if (ms) cooldowns.set(key, Date.now() + ms);
  }

  async function pump() {
    if (running || disposed) return;
    running = true;
    while (items.length && !disposed) {
      items.sort((a, b) => b.priority - a.priority);
      const task = items.shift();
      try {
        await task.run();
        stats.done += 1;
      } catch (err) {
        stats.failed += 1;
        log(`表演执行失败（${task.key}）: ${err?.message ?? err}`);
      }
    }
    running = false;
  }

  return {
    enqueue({ priority = 10, key = 'task', userKey = '', cooldownMs = 0, run }) {
      if (disposed) return { accepted: false, reason: '插件已卸载' };
      if (cooling(key, cooldownMs)) {
        stats.dropped += 1;
        return { accepted: false, reason: `冷却中（${key}）` };
      }
      if (userKey && cooling(userKey, 800)) {
        stats.merged += 1;
        return { accepted: false, reason: '连刷合并' };
      }
      if (items.length >= maxSize) {
        items.sort((a, b) => b.priority - a.priority);
        const lowest = items[items.length - 1];
        if (!lowest || lowest.priority >= priority) {
          stats.dropped += 1;
          return { accepted: false, reason: '队列已满，跳过低优先级' };
        }
        items.pop();
        stats.dropped += 1;
      }
      mark(key, cooldownMs);
      if (userKey) mark(userKey, 800);
      items.push({ priority, key, userKey, run });
      stats.accepted += 1;
      void pump();
      return { accepted: true };
    },
    snapshot() {
      return {
        ...stats,
        pending: items.length,
        running,
        current: items[0]?.key ?? null,
        cooldowns: cooldowns.size,
      };
    },
    /**
     * 丢掉还没开跑的某类任务。
     * 弹幕用得上：一次回复要"合成 4 秒 + 播放 3 秒"，房间一热闹就会越说越落后，
     * 与其把十分钟前的弹幕念出来，不如只回最新那条 —— 旧的任务直接当过期处理。
     */
    dropKey(key) {
      const before = items.length;
      items = items.filter((t) => t.key !== key);
      const dropped = before - items.length;
      if (dropped) {
        stats.stale += dropped;
        stats.dropped += dropped;
      }
      return dropped;
    },
    clear() {
      items = [];
    },
    dispose() {
      disposed = true;
      items = [];
    },
  };
}