/**
 * 大肥鱼直播面板（Client 半边）
 * - 侧边栏加一枚鲸鱼图标（sidebar.panellist）
 * - 主区域一页面板（main，key = whale-live）：状态、控制、礼物菜单、实时事件流
 * 数据来自 Host 的 /api/whale-live 路由。
 * 可见文案一律走 Client locale 服务（ctx.locale），样式只用主题 token。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-whale-live',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const PANEL_KEY = 'whale-live';
    const NS = 'whale-live';

    const CSS = `
.whale-live-root { padding: 20px 24px 32px; overflow: auto; height: 100%; box-sizing: border-box; color: var(--dsw-alias-label-primary); }
.whale-live-title { font-size: 18px; font-weight: 600; margin: 0 0 4px; }
.whale-live-sub { font-size: 12px; color: var(--dsw-alias-label-secondary); margin: 0 0 16px; }
.whale-live-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; margin-bottom: 16px; }
.whale-live-card { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 12px 14px; }
.whale-live-card h4 { margin: 0 0 6px; font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.whale-live-card b { font-size: 15px; font-weight: 600; }
.whale-live-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
.whale-live-btn { font: inherit; font-size: 13px; padding: 6px 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); cursor: pointer; }
.whale-live-btn:hover { border-color: var(--dsw-alias-brand-primary); }
.whale-live-btn[disabled] { opacity: 0.55; cursor: default; }
.whale-live-btn.primary { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-1); font-weight: 500; }
.whale-live-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; background: var(--dsw-alias-state-idle-primary); }
.whale-live-dot.on { background: var(--dsw-alias-state-success-primary); }
.whale-live-dot.err { background: var(--dsw-alias-state-error-primary); }
.whale-live-section { margin-bottom: 18px; }
.whale-live-section h3 { font-size: 14px; font-weight: 600; margin: 0 0 8px; }
.whale-live-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.whale-live-table th, .whale-live-table td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); vertical-align: top; }
.whale-live-table th { color: var(--dsw-alias-label-secondary); font-weight: 500; background: var(--dsw-alias-bg-layer-2); }
.whale-live-table tr:hover td { background: var(--dsw-alias-bg-layer-2); }
.whale-live-feed { list-style: none; margin: 0; padding: 0; font-size: 12.5px; max-height: 320px; overflow: auto; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; }
.whale-live-feed li { padding: 7px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); display: flex; gap: 8px; align-items: baseline; }
.whale-live-feed li:last-child { border-bottom: 0; }
.whale-live-kind { flex: 0 0 58px; color: var(--dsw-alias-label-secondary); }
.whale-live-act { color: var(--dsw-alias-brand-primary); }
.whale-live-time { margin-left: auto; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.whale-live-warn { color: var(--dsw-alias-state-warn-primary); font-size: 12.5px; }
.whale-live-err { color: var(--dsw-alias-state-error-primary); font-size: 12.5px; }
.whale-live-hint { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-top: 6px; }
`;

    /** 面板文案（zh 与 en 一一对应；不依赖插值语法，数字一律在调用处拼接）。 */
    const DICT = {
      zh: {
        title: '大肥鱼直播',
        'room.label': '房间',
        'mode.dry': '干跑模式（只记录，不驱动皮套、不出声）',
        'mode.live': '真实驱动模式',
        'last.prefix': '最近表演：',
        'panel.error': '面板读不到插件状态：',
        'panel.errorHint': '（Host 里可能没装成）',
        'card.bili': 'B站采集',
        'card.vts': 'VTube Studio',
        'card.queue': '触发队列',
        'card.messages': '消息统计',
        'bili.off': '未启动',
        'bili.connecting': '连接中…',
        'bili.on': '已连接',
        'live.on': '直播间开播中',
        'live.off': '直播间未开播',
        'vts.disabled': '配置里已关闭',
        'vts.authed': '已授权',
        'vts.unauth': '未授权',
        'vts.off': '未连接',
        'vts.port': '端口',
        'queue.unit': '个待办',
        'queue.done': '已执行',
        'queue.dropped': '丢弃',
        'stats.received': '收到',
        'stats.unit': '条',
        'stats.performed': '表演',
        'stats.spoken': '语音',
        'btn.dryToLive': '切到真实驱动',
        'btn.liveToDry': '切回干跑',
        'btn.start': '开始监听',
        'btn.starting': '启动中…',
        'btn.stop': '停止',
        'btn.vtsConnect': '连接 VTS',
        'btn.hotkeys': '读取模型热键',
        'btn.probe': '语音自检',
        'btn.testGift': '试送礼：棒棒糖',
        'btn.testChat': '试弹幕',
        'btn.chatOn': '弹幕回复：开',
        'btn.chatOff': '弹幕回复：关',
        'btn.giftOn': '礼物感谢：开',
        'btn.giftOff': '礼物感谢：关',
        'card.chat': '弹幕对话',
        'chat.off': '已关闭',
        'chat.replied': '已回',
        'chat.throttle': '限流',
        'err.prefix': '最近错误：',
        'menu.title': '礼物 / 事件 → 表演 菜单',
        'menu.col.what': '观众做什么',
        'menu.col.perform': '大肥鱼表演什么',
        'menu.col.speech': '台词',
        'menu.col.priority': '优先级',
        'feed.title': '实时事件流',
        'feed.empty': '还没有事件。点「开始监听」后会实时显示弹幕和礼物。',
        'test.user': '面板测试',
        'test.text': '大肥鱼你好可爱',
        'kind.chat': '弹幕',
        'kind.gift': '礼物',
        'kind.superchat': 'SC',
        'kind.guard': '上舰',
        'kind.enter': '进场',
        'kind.follow': '关注',
        'kind.like': '点赞',
        'kind.watched': '人气',
        'kind.other': '其他',
        'card.memory': '观众记忆',
        'memory.off': '已关闭',
        'memory.people': '人',
        'memory.messages': '条发言',
        'memory.topN': '名',
        'memory.title': '记忆里的老面孔（进场会语音欢迎）',
        'memory.col.rank': '#',
        'memory.col.name': '观众',
        'memory.col.count': '发言',
        'memory.col.visits': '来过',
        'memory.col.last': '最近一句',
        'memory.empty': '还没有记忆。开始监听后，观众说的每句话都会记下来 —— 超过门槛的人就沉淀成老面孔。',
        'btn.testEnter': '试进场',
        'btn.memoryOn': '观众记忆：开',
        'btn.memoryOff': '观众记忆：关',
        'btn.watermarkHidden': '水印：已隐藏',
        'btn.watermarkShown': '水印：显示中',
      },
      en: {
        title: 'Whale Live',
        'room.label': 'Room',
        'mode.dry': 'Dry run (records only — no avatar, no audio)',
        'mode.live': 'Live drive mode',
        'last.prefix': 'Last performance: ',
        'panel.error': 'The panel cannot read plugin state: ',
        'panel.errorHint': ' (the host half may not be active)',
        'card.bili': 'Bilibili intake',
        'card.vts': 'VTube Studio',
        'card.queue': 'Trigger queue',
        'card.messages': 'Messages',
        'bili.off': 'Not started',
        'bili.connecting': 'Connecting…',
        'bili.on': 'Connected',
        'live.on': 'Room is live',
        'live.off': 'Room is offline',
        'vts.disabled': 'Disabled in config',
        'vts.authed': 'Authorised',
        'vts.unauth': 'Not authorised',
        'vts.off': 'Not connected',
        'vts.port': 'Port',
        'queue.unit': 'queued',
        'queue.done': 'done',
        'queue.dropped': 'dropped',
        'stats.received': 'Received',
        'stats.unit': 'messages',
        'stats.performed': 'performed',
        'stats.spoken': 'spoken',
        'btn.dryToLive': 'Switch to live drive',
        'btn.liveToDry': 'Back to dry run',
        'btn.start': 'Start listening',
        'btn.starting': 'Starting…',
        'btn.stop': 'Stop',
        'btn.vtsConnect': 'Connect VTS',
        'btn.hotkeys': 'Read model hotkeys',
        'btn.probe': 'Voice check',
        'btn.testGift': 'Test gift: lollipop',
        'btn.testChat': 'Test comment',
        'btn.chatOn': 'Replies: ON',
        'btn.chatOff': 'Replies: OFF',
        'btn.giftOn': 'Gifts: ON',
        'btn.giftOff': 'Gifts: OFF',
        'card.chat': 'Chat replies',
        'chat.off': 'off',
        'chat.replied': 'replied',
        'chat.throttle': 'throttle',
        'err.prefix': 'Last error: ',
        'menu.title': 'Gift / event → performance menu',
        'menu.col.what': 'Viewer action',
        'menu.col.perform': 'What the whale performs',
        'menu.col.speech': 'Line',
        'menu.col.priority': 'Priority',
        'feed.title': 'Live event feed',
        'feed.empty': 'No events yet. Press “Start listening” to stream comments and gifts in real time.',
        'test.user': 'Panel test',
        'test.text': 'Hello whale, you are cute',
        'kind.chat': 'chat',
        'kind.gift': 'gift',
        'kind.superchat': 'SC',
        'kind.guard': 'guard',
        'kind.enter': 'enter',
        'kind.follow': 'follow',
        'kind.like': 'like',
        'kind.watched': 'views',
        'kind.other': 'other',
        'card.memory': 'Audience memory',
        'memory.off': 'off',
        'memory.people': 'people',
        'memory.messages': 'messages',
        'memory.topN': 'top',
        'memory.title': 'Regulars in memory (they get a voice welcome on entry)',
        'memory.col.rank': '#',
        'memory.col.name': 'Viewer',
        'memory.col.count': 'Sent',
        'memory.col.visits': 'Days',
        'memory.col.last': 'Last line',
        'memory.empty': 'No memory yet. Once listening starts, every comment is recorded — those above the threshold settle in as regulars.',
        'btn.testEnter': 'Test entry',
        'btn.memoryOn': 'Memory: ON',
        'btn.memoryOff': 'Memory: OFF',
        'btn.watermarkHidden': 'Watermark: hidden',
        'btn.watermarkShown': 'Watermark: visible',
      },
    };

    const KIND_KEY = {
      chat: 'kind.chat', gift: 'kind.gift', superchat: 'kind.superchat', guard: 'kind.guard',
      enter: 'kind.enter', follow: 'kind.follow', like: 'kind.like', watched: 'kind.watched', other: 'kind.other',
    };

    function useWhaleState() {
      const [state, setState] = React.useState(null);
      const [busy, setBusy] = React.useState('');
      const load = React.useCallback(async () => {
        try {
          const res = await fetch('/api/whale-live?action=state', { cache: 'no-store' });
          setState(await res.json());
        } catch (err) {
          setState({ ok: false, error: String(err?.message ?? err) });
        }
      }, []);
      React.useEffect(() => {
        let alive = true;
        const tick = () => { if (alive) void load(); };
        tick();
        const timer = setInterval(tick, 2500);
        return () => { alive = false; clearInterval(timer); };
      }, [load]);
      const act = React.useCallback(async (action, params = {}) => {
        setBusy(action);
        try {
          const q = new URLSearchParams({ action, ...params });
          await fetch(`/api/whale-live?${q.toString()}`, { cache: 'no-store' });
        } catch { /* 面板只做提示，不阻塞 */ }
        setBusy('');
        await load();
      }, [load]);
      return { state, act, busy };
    }

    function PanelIcon(props) {
      const color = props?.active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)';
      const size = props?.size ?? 16;
      return h('svg', { width: size, height: size, viewBox: '0 0 64 64', 'aria-hidden': true, style: { display: 'block' } },
        h('ellipse', { cx: 30, cy: 34, rx: 22, ry: 17, fill: color, opacity: props?.active ? 1 : 0.85 }),
        h('path', { d: 'M48 30c6-8 12-9 14-7-3 3-5 6-5 9 0 3 2 6 5 9-2 2-8 1-14-6z', fill: color }),
        h('circle', { cx: 20, cy: 31, r: 3.2, fill: 'var(--dsw-alias-bg-base)' }),
        h('path', { d: 'M26 22c1-5 4-8 7-8 0 4-2 7-4 9z', fill: color, opacity: 0.6 }));
    }

    function Dot({ on, err }) {
      return h('span', { className: `whale-live-dot${err ? ' err' : on ? ' on' : ''}` });
    }

    function Card({ title, value, extra, on, err }) {
      return h('div', { className: 'whale-live-card' },
        h('h4', null, title),
        h('b', null, on === undefined ? value : h(React.Fragment, null, h(Dot, { on, err }), value)),
        extra ? h('div', { className: 'whale-live-hint' }, extra) : null);
    }

    function MenuTable({ menu, t }) {
      return h('table', { className: 'whale-live-table' },
        h('thead', null, h('tr', null,
          h('th', { style: { width: '22%' } }, t('menu.col.what')),
          h('th', { style: { width: '26%' } }, t('menu.col.perform')),
          h('th', null, t('menu.col.speech')),
          h('th', { style: { width: '70px' } }, t('menu.col.priority')))),
        h('tbody', null, (menu ?? []).map((m) => h('tr', { key: m.id },
          h('td', null, m.trigger),
          h('td', null, h('div', null, m.title), m.performance ? h('div', { className: 'whale-live-hint' }, m.performance) : null),
          h('td', null, m.speech),
          h('td', null, String(m.priority ?? ''))))));
    }

    function makePanel(t) {
      return function Panel() {
        const { state, act, busy } = useWhaleState();
        const s = state ?? {};
        const bili = s.bili ?? {};
        const vts = s.vts ?? {};
        const queue = s.queue ?? {};
        const room = s.room ?? {};
        const events = s.events ?? [];

        return h('div', { className: 'whale-live-root' },
          h('style', null, CSS),
          h('h2', { className: 'whale-live-title' }, t('title')),
          h('p', { className: 'whale-live-sub' },
            `${t('room.label')} ${room.roomId ?? '—'} · `,
            s.dryRun ? t('mode.dry') : t('mode.live'),
            s.lastAction ? ` · ${t('last.prefix')}${s.lastAction.title}` : ''),

          s.ok === false
            ? h('div', { className: 'whale-live-err' }, `${t('panel.error')}${s.error ?? ''}${t('panel.errorHint')}`)
            : null,

          h('div', { className: 'whale-live-cards' },
            h(Card, {
              title: t('card.bili'),
              value: bili.running ? (bili.connected ? t('bili.on') : t('bili.connecting')) : t('bili.off'),
              on: Boolean(bili.connected),
              extra: room.live ? t('live.on') : t('live.off'),
            }),
            h(Card, {
              title: t('card.vts'),
              value: vts.enabled === false ? t('vts.disabled') : (vts.authenticated ? t('vts.authed') : vts.connected ? t('vts.unauth') : t('vts.off')),
              on: Boolean(vts.authenticated),
              err: Boolean(vts.lastError),
              extra: vts.enabled === false ? '' : `${t('vts.port')} ${vts.port ?? ''}`,
            }),
            h(Card, {
              title: t('card.queue'),
              value: `${queue.pending ?? 0} ${t('queue.unit')}`,
              extra: `${t('queue.done')} ${queue.done ?? 0} · ${t('queue.dropped')} ${queue.dropped ?? 0}`,
            }),
            h(Card, {
              title: t('card.messages'),
              value: `${t('stats.received')} ${s.stats?.received ?? 0} ${t('stats.unit')}`,
              extra: `${t('stats.performed')} ${s.stats?.performed ?? 0} · ${t('stats.spoken')} ${s.stats?.spoken ?? 0}`,
            }),
            h(Card, {
              title: t('card.chat'),
              value: s.chat?.enabled === false ? t('chat.off') : `${t('chat.replied')} ${s.stats?.replied ?? 0}`,
              on: s.chat?.enabled !== false,
              extra: `${t('chat.throttle')} ${Math.round((s.chat?.cooldownMs ?? 0) / 1000)}s · ${s.chat?.model || ''}`,
            }),
            h(Card, {
              title: t('card.memory'),
              value: s.memory?.enabled === false
                ? t('memory.off')
                : `${s.memory?.viewers ?? 0} ${t('memory.people')}`,
              on: s.memory?.enabled !== false,
              extra: `${s.memory?.messages ?? 0} ${t('memory.messages')} · ${s.memory?.topN ?? 5} ${t('memory.topN')}`,
            })),

          h('div', { className: 'whale-live-row' },
            h('button', {
              className: 'whale-live-btn primary', disabled: Boolean(busy),
              onClick: () => act('set-config', { dryRun: String(!s.dryRun) }),
            }, s.dryRun ? t('btn.dryToLive') : t('btn.liveToDry')),
            h('button', { className: 'whale-live-btn', disabled: Boolean(busy), onClick: () => act('start') }, busy === 'start' ? t('btn.starting') : t('btn.start')),
            h('button', { className: 'whale-live-btn', disabled: Boolean(busy), onClick: () => act('stop') }, t('btn.stop')),
            h('button', { className: 'whale-live-btn', disabled: Boolean(busy), onClick: () => act('vts-connect') }, t('btn.vtsConnect')),
            h('button', { className: 'whale-live-btn', disabled: Boolean(busy), onClick: () => act('vts-hotkeys') }, t('btn.hotkeys')),
            h('button', { className: 'whale-live-btn', disabled: Boolean(busy), onClick: () => act('probe-voice') }, t('btn.probe')),
            h('button', { className: 'whale-live-btn', disabled: Boolean(busy), onClick: () => act('test-gift', { gift: '棒棒糖', user: t('test.user') }) }, t('btn.testGift')),
            h('button', { className: 'whale-live-btn', disabled: Boolean(busy), onClick: () => act('test-chat', { text: t('test.text') }) }, t('btn.testChat')),
            h('button', { className: 'whale-live-btn', disabled: Boolean(busy), onClick: () => act('test-enter') }, t('btn.testEnter')),
            h('button', {
              className: 'whale-live-btn', disabled: Boolean(busy),
              onClick: () => act('set-config', { chatEnabled: String(s.chat?.enabled === false) }),
            }, s.chat?.enabled === false ? t('btn.chatOff') : t('btn.chatOn')),
            h('button', {
              className: 'whale-live-btn', disabled: Boolean(busy),
              onClick: () => act('set-config', { giftEnabled: String(s.chat?.giftEnabled === false) }),
            }, s.chat?.giftEnabled === false ? t('btn.giftOff') : t('btn.giftOn')),
            h('button', {
              className: 'whale-live-btn', disabled: Boolean(busy),
              onClick: () => act('set-config', { memoryEnabled: String(s.memory?.enabled === false) }),
            }, s.memory?.enabled === false ? t('btn.memoryOff') : t('btn.memoryOn')),
            h('button', {
              className: 'whale-live-btn', disabled: Boolean(busy),
              // 走 watermark 动作：它既切当前这一帧，也把选择记进配置（下次复位不会又关回去）
              onClick: () => act('watermark', { text: s.watermark?.hidden === false ? 'hide' : 'show' }),
            }, s.watermark?.hidden === false ? t('btn.watermarkShown') : t('btn.watermarkHidden'))),

          (bili.lastError || vts.lastError)
            ? h('div', { className: 'whale-live-warn' }, `${t('err.prefix')}${bili.lastError || vts.lastError}`)
            : null,

          h('div', { className: 'whale-live-section' },
            h('h3', null, t('memory.title')),
            (s.memory?.top ?? []).length
              ? h('table', { className: 'whale-live-table' },
                h('thead', null, h('tr', null,
                  h('th', { style: { width: '40px' } }, t('memory.col.rank')),
                  h('th', null, t('memory.col.name')),
                  h('th', { style: { width: '90px' } }, t('memory.col.count')),
                  h('th', { style: { width: '80px' } }, t('memory.col.visits')),
                  h('th', null, t('memory.col.last')))),
                h('tbody', null, s.memory.top.map((m) => h('tr', { key: `mem-${m.rank}-${m.uid || m.name}` },
                  h('td', null, String(m.rank)),
                  h('td', null, m.name),
                  h('td', null, String(m.count)),
                  h('td', null, String(m.visits)),
                  h('td', null, m.lastText ?? '')))))
              : h('div', { className: 'whale-live-hint' }, t('memory.empty'))),

          h('div', { className: 'whale-live-section' },
            h('h3', null, t('menu.title')),
            h(MenuTable, { menu: s.menu, t })),

          h('div', { className: 'whale-live-section' },
            h('h3', null, t('feed.title')),
            events.length
              ? h('ul', { className: 'whale-live-feed' }, events.map((e, i) => h('li', { key: `${e.at}-${i}` },
                h('span', { className: 'whale-live-kind' }, t(KIND_KEY[e.kind] ?? 'kind.other')),
                h('span', null, e.user ?? ''),
                h('span', null, e.gift ? `${e.gift}×${e.num ?? 1}` : (e.text ?? '')),
                e.title ? h('span', { className: 'whale-live-act' }, ` → ${e.title}`) : null,
                h('span', { className: 'whale-live-time' }, e.at ? String(e.at).slice(11, 19) : ''))))
              : h('div', { className: 'whale-live-hint' }, t('feed.empty'))));
      };
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const dispose = [];
        // 同一份文案按常见 locale id 各注册一次，避免猜错活跃 id 的写法（zh-CN / zh / en-US / en）
        for (const [id, base] of Object.entries({ 'zh-CN': 'zh', zh: 'zh', 'en-US': 'en', en: 'en' })) {
          try { dispose.push(ctx.locale.register(NS, id, DICT[base])); } catch { /* 该 id 已被占，跳过 */ }
        }
        // 查不到时 locale 服务会把键原样返回 —— 这时回落到中文原文，界面绝不露键名
        const rawT = ctx.locale.bind(NS);
        const t = (key) => {
          const v = rawT(key);
          return v === key ? (DICT.zh[key] ?? key) : v;
        };
        const Panel = makePanel(t);

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_KEY, order: 30,
          // thunk：每次投影都重读，切语言时标签跟着变
          label: () => t('title'),
        }, PanelIcon));
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_KEY }, Panel));

        const cleanup = () => { for (const off of dispose) { try { off(); } catch { /* 已注销 */ } } };
        if (typeof ctx.effect === 'function') ctx.effect(() => cleanup);
        else return cleanup;
      },
    };
  },
});