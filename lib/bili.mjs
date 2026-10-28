/**
 * B站直播间采集：room_init → 弹幕服务器配置 → WebSocket 长连接 → 归一化事件。
 *
 * 实测要点（2026-10）：
 *  - xlive/.../getDanmuInfo 与 xlive/.../getList 已被风控（code -352），
 *    但 room/v1/Danmu/getConf、room/v1/Room/room_init、room/v1/room/get_user_recommend 仍然可用。
 *  - 二进制定长包头 16 字节：包长 / 包头长 / 协议版本 / 操作码 / 序号。
 *    protover 0=JSON, 1=int32 人气值, 2=zlib 嵌套, 3=brotli 嵌套。
 *  - 鉴权包 op=7，心跳 op=2（30 秒一次），普通消息 op=5。
 */
import zlib from 'node:zlib';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const OP = { HEARTBEAT: 2, MESSAGE: 5, AUTH: 7 };

function pack(jsonBody, op, proto = 1) {
  const body = Buffer.from(jsonBody, 'utf8');
  const head = Buffer.alloc(16);
  head.writeUInt32BE(16 + body.length, 0);
  head.writeUInt16BE(16, 4);
  head.writeUInt16BE(proto, 6);
  head.writeUInt32BE(op, 8);
  head.writeUInt32BE(1, 12);
  return Buffer.concat([head, body]);
}

function* unpack(buf) {
  let off = 0;
  while (off + 16 <= buf.length) {
    const total = buf.readUInt32BE(off);
    const hlen = buf.readUInt16BE(off + 4);
    const proto = buf.readUInt16BE(off + 6);
    const op = buf.readUInt32BE(off + 8);
    if (total < 16 || off + total > buf.length) return;
    yield { proto, op, body: buf.subarray(off + hlen, off + total) };
    off += total;
  }
}

function decodeInto(pkt, out, depth = 0) {
  if (depth > 3) return;
  if (pkt.proto === 2) {
    try {
      for (const inner of unpack(zlib.inflateSync(pkt.body))) decodeInto(inner, out, depth + 1);
    } catch { /* 解压失败忽略 */ }
    return;
  }
  if (pkt.proto === 3) {
    try {
      for (const inner of unpack(zlib.brotliDecompressSync(pkt.body))) decodeInto(inner, out, depth + 1);
    } catch { /* 解压失败忽略 */ }
    return;
  }
  if (pkt.proto === 1) {
    out.push({ kind: 'popularity', value: pkt.body.readUInt32BE(0) });
    return;
  }
  for (const line of pkt.body.toString('utf8').split('\0')) {
    const text = line.trim();
    if (!text) continue;
    if (text === '{"code":0}') { out.push({ kind: 'auth-ok' }); continue; }
    try { out.push({ kind: 'json', data: JSON.parse(text) }); } catch { /* 忽略坏帧 */ }
  }
}

/** 只取"是对象"的值，否则给 null（容错找字段用）。 */
function obj(v) {
  return (v && typeof v === 'object') ? v : null;
}

/* ---------- 极简 protobuf 读取（只为解 *_V2 这类把内容塞进 data.pb 的报文） ---------- */

function pbVarint(buf, pos) {
  let out = 0;
  let shift = 0;
  while (pos < buf.length) {
    const b = buf[pos];
    pos += 1;
    out += (b & 0x7f) * (2 ** shift);
    if (!(b & 0x80)) break;
    shift += 7;
    if (shift > 63) break;
  }
  return [out, pos];
}

/** 把一段 protobuf 解成 Map<字段号, 值[]>（值是 varint 数字、float 或 Buffer）。 */
function pbParse(buf) {
  const out = new Map();
  let pos = 0;
  while (pos < buf.length) {
    let key;
    [key, pos] = pbVarint(buf, pos);
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (!field) break;
    let value;
    if (wire === 0) { [value, pos] = pbVarint(buf, pos); }
    else if (wire === 2) {
      let len;
      [len, pos] = pbVarint(buf, pos);
      value = buf.subarray(pos, pos + len);
      pos += len;
    } else if (wire === 5) { value = buf.readFloatLE(pos); pos += 4; }
    else if (wire === 1) { value = buf.readDoubleLE(pos); pos += 8; }
    else break;
    if (!out.has(field)) out.set(field, []);
    out.get(field).push(value);
  }
  return out;
}

const pbNum = (m, f) => {
  const v = m?.get(f)?.[0];
  return typeof v === 'number' ? Math.round(v) : undefined;
};
const pbStr = (m, f) => {
  const v = m?.get(f)?.[0];
  if (!Buffer.isBuffer(v)) return undefined;
  const txt = v.toString('utf8');
  return /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(txt) ? undefined : txt;
};
const pbMsg = (m, f) => {
  const v = m?.get(f)?.[0];
  return Buffer.isBuffer(v) ? pbParse(v) : undefined;
};

/**
 * 从 SEND_GIFT_V2 的 data.pb 里抠礼物事件。
 * 字段编号是实测解出来的（VTS 那套文档里没有，B站 也没公开）：
 *   #10 = 礼物主体；#10.#2 名字 / #4 数量 / #5 单价 / #8 货币 / #12 连击ID / #13 连击数
 *   #10.#29 = 送礼人 {#1 昵称, #2 uid}；#15.#2 = 用户信息兜底；#2 = 打码昵称兜底
 */
function giftFromPb(base64) {
  try {
    const root = pbParse(Buffer.from(String(base64), 'base64'));
    const g = pbMsg(root, 10);
    if (!g) return null;
    const sender = pbMsg(g, 29) ?? pbMsg(g, 33);
    const userInfo = pbMsg(pbMsg(root, 15) ?? new Map(), 2);
    return {
      user: pbStr(sender, 1) ?? pbStr(userInfo, 1) ?? pbStr(root, 2) ?? '',
      uid: pbNum(sender, 2) ?? pbNum(pbMsg(g, 33) ?? new Map(), 1) ?? 0,
      gift: pbStr(g, 2) ?? '',
      num: pbNum(g, 4) ?? 1,
      price: pbNum(g, 5) ?? 0,
      coinType: pbStr(g, 8) ?? '',
      comboId: pbStr(g, 12) ?? '',
      comboCount: pbNum(g, 13) ?? 0,
    };
  } catch {
    return null;
  }
}

/** 把 B站 原始 cmd 归一化成直播事件。 */
export function normalize(raw) {
  const d = raw?.data ?? raw ?? {};
  const base = { at: Date.now(), raw: d };
  switch (raw?.cmd) {
    case 'DANMU_MSG': {
      const info = d.info ?? [];
      return {
        ...base, kind: 'chat',
        text: String(info[1] ?? d.msg ?? ''),
        user: String(info[2]?.[1] ?? d.uname ?? ''),
        uid: Number(info[2]?.[0] ?? d.uid ?? 0),
        medal: info[3]?.[1] ?? '',
        medalLevel: info[3]?.[0] ?? 0,
        isAdmin: Boolean(info[2]?.[2]),
      };
    }
    case 'SEND_GIFT':
    case 'SEND_GIFT_V2':
    case 'COMBO_SEND': {
      // ⚠️ 实测：这间房收到的礼物报文 cmd 是 **SEND_GIFT_V2**（旧文档只写 SEND_GIFT），
      //    只认 SEND_GIFT 的话礼物会静默消失（掉进 kind:'other' 被丢掉）。
      //    连击礼物还会走 COMBO_SEND（字段名是 gift_name / combo_num）。
      //    三种 cmd 字段层级还不完全一样，所以下面每个字段都容错找一遍：
      //    可能嵌在 data.data 里，也可能被拆到 gift / sender_uinfo 里。
      const g0 = obj(d.data) ?? d;
      const g = obj(g0.data) ?? g0; // 兼容 data.data 与 data.data.data 两种层级
      const gift = obj(g.gift) ?? g;
      const user = obj(g.sender_uinfo) ?? obj(g.user) ?? g;
      let uname = String(user.uname ?? user.user_name ?? g.uname ?? '');
      let gname = String(gift.giftName ?? gift.gift_name ?? g.giftName ?? g.gift_name ?? '');
      let num = Number(gift.num ?? g.num ?? g.combo_num ?? 1);
      let price = Number(gift.price ?? g.price ?? 0);
      let coinType = g.coin_type ?? '';
      let uid = Number(user.uid ?? g.uid ?? 0);
      let comboId = g.batch_combo_id ?? '';
      let comboCount = Number(g.combo_num ?? g.batch_combo_num ?? 0);
      // 真机上 SEND_GIFT_V2 的 JSON 层只有 {dmscore, pb}，礼物内容全在 data.pb 的
      // protobuf 里 —— JSON 找不到名字就必须去解 pb，否则礼物只剩"价格 0 的未知礼物"。
      if ((!gname || !uname) && typeof d.pb === 'string') {
        const fromPb = giftFromPb(d.pb);
        if (fromPb) {
          uname = uname || fromPb.user;
          gname = gname || fromPb.gift;
          num = fromPb.num ?? num;
          price = fromPb.price ?? price;
          coinType = coinType || fromPb.coinType;
          uid = uid || fromPb.uid;
          comboId = comboId || fromPb.comboId;
          comboCount = comboCount || fromPb.comboCount;
        }
      }
      return {
        ...base, kind: 'gift',
        // 解析不出来时给占位：宁可说"神秘观众/礼物"，也别说成「谢谢的×1」
        user: uname || '神秘观众',
        uid,
        gift: gname || '礼物',
        // 标记：字段没解析出来 ⇒ 报文结构又变了，上层据此把原始报文存下来备查
        unknownShape: !uname || !gname,
        num,
        price,
        coinType,
        totalCoin: Number(g.total_coin ?? 0) || price * num,
        comboId,
        comboCount,
        guardLevel: Number(g.guard_level ?? 0),
      };
    }
    case 'SUPER_CHAT_MESSAGE': {
      const s = d.data ?? {};
      return {
        ...base, kind: 'superchat',
        user: String(s.user_info?.uname ?? ''),
        uid: Number(s.user_info?.uid ?? 0),
        text: String(s.message ?? ''),
        price: Number(s.price ?? 0),
        seconds: Number(s.time ?? 0),
        id: String(s.id ?? ''),
      };
    }
    case 'GUARD_BUY': {
      const g = d.data ?? {};
      return {
        ...base, kind: 'guard',
        user: String(g.username ?? ''),
        uid: Number(g.uid ?? 0),
        gift: String(g.gift_name ?? ''),
        num: Number(g.num ?? 1),
        price: Number(g.price ?? 0),
        level: Number(g.guard_level ?? 0),
      };
    }
    case 'INTERACT_WORD': {
      const w = d.data ?? {};
      const type = Number(w.msg_type ?? 0);
      return {
        ...base, kind: type === 2 ? 'follow' : 'enter',
        user: String(w.uname ?? ''),
        uid: Number(w.uid ?? 0),
        msgType: type,
      };
    }
    case 'LIKE_INFO_V3_CLICK': {
      const w = d.data ?? {};
      return { ...base, kind: 'like', user: String(w.uname ?? ''), uid: Number(w.uid ?? 0) };
    }
    case 'WATCHED_CHANGE': {
      const w = d.data ?? {};
      return { ...base, kind: 'watched', text: String(w.text_small ?? '') };
    }
    case 'LIVE': {
      return { ...base, kind: 'live-on' };
    }
    case 'PREPARING': {
      return { ...base, kind: 'live-off' };
    }
    default: {
      const cmd = String(raw?.cmd ?? '');
      // 兜底：人气票 / 粉丝团灯牌 / 上舰 这类事件可能是 *_V2 的 protobuf 版本，
      // cmd 名不固定，但只要 pb 里能解出礼物结构，就当礼物处理（宁可多表演，也别漏）。
      if (typeof d.pb === 'string' && /GIFT|TOAST|GUARD|POPULARITY|WISH|BOX/i.test(cmd)) {
        const fromPb = giftFromPb(d.pb);
        if (fromPb?.gift) {
          return {
            ...base, kind: 'gift',
            user: fromPb.user || '神秘观众',
            uid: fromPb.uid ?? 0,
            gift: fromPb.gift,
            num: fromPb.num ?? 1,
            price: fromPb.price ?? 0,
            coinType: fromPb.coinType ?? '',
            totalCoin: (fromPb.price ?? 0) * (fromPb.num ?? 1),
            comboId: fromPb.comboId ?? '',
            comboCount: fromPb.comboCount ?? 0,
            guardLevel: 0,
            viaPb: true,
          };
        }
      }
      return { ...base, kind: 'other', cmd };
    }
  }
}

/**
 * @param {object} opts
 * @param {number} opts.roomId
 * @param {(e: object) => void} opts.onEvent
 * @param {(s: object) => void} opts.onStatus
 * @param {(msg: string) => void} opts.log
 */
export function createBiliLive({ roomId, onEvent = () => {}, onStatus = () => {}, log = () => {} }) {
  let ws = null;
  let heartbeat = null;
  let reconnectTimer = null;
  let offlineTimer = null;
  let running = false;
  let attempts = 0;
  let buvid = '';
  let cookie = '';
  let realRoomId = Number(roomId);
  let uid = 0;
  let live = false;
  let lastError = '';
  let messages = 0;
  // 收到过的 cmd 计数：排查"某类事件为什么没触发"时直接看这个（无事件流污染）
  const cmdCounts = Object.create(null);
  const MAX_CMDS = 80;
  function trackCmd(cmd) {
    const c = String(cmd ?? '');
    if (!c) return;
    if (cmdCounts[c] === undefined && Object.keys(cmdCounts).length >= MAX_CMDS) return;
    cmdCounts[c] = (cmdCounts[c] ?? 0) + 1;
  }
  // 没认出来的 cmd，把它的原始报文留一份（每类只留第一份，截断）：出问题时一眼定位。
  const rawSamples = Object.create(null);
  function trackSample(cmd, payload) {
    const c = String(cmd ?? '');
    if (!c || rawSamples[c]) return;
    try {
      const s = JSON.stringify(payload);
      rawSamples[c] = s.length > 1600 ? `${s.slice(0, 1600)}…` : s;
    } catch { rawSamples[c] = '(无法序列化)'; }
  }

  const headers = () => ({
    'User-Agent': UA,
    Referer: `https://live.bilibili.com/${realRoomId || roomId}`,
    Origin: 'https://live.bilibili.com',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    ...(cookie ? { Cookie: cookie } : {}),
  });

  async function ensureFingerprint() {
    if (buvid) return;
    const res = await fetch('https://api.bilibili.com/x/frontend/finger/spi', {
      headers: { 'User-Agent': UA },
    });
    const j = await res.json();
    buvid = j?.data?.b_3 ?? '';
    cookie = `buvid3=${j?.data?.b_3 ?? ''}; buvid4=${j?.data?.b_4 ?? ''}; b_nut=${Math.floor(Date.now() / 1000)}`;
  }

  async function jget(url) {
    const res = await fetch(url, { headers: headers() });
    return res.json();
  }

  function status(extra = {}) {
    onStatus({
      running, live, roomId: realRoomId, uid, messages, lastError,
      attempts, connected: ws?.readyState === 1, ...extra,
    });
  }

  async function resolveRoom() {
    const j = await jget(`https://api.live.bilibili.com/room/v1/Room/room_init?id=${roomId}`);
    if (j.code !== 0) throw new Error(`room_init 失败: ${j.code} ${j.message ?? ''}`);
    realRoomId = Number(j.data.room_id);
    uid = Number(j.data.uid);
    live = Number(j.data.live_status) === 1;
    return j.data;
  }

  async function fetchConf() {
    const j = await jget(
      `https://api.live.bilibili.com/room/v1/Danmu/getConf?room_id=${realRoomId}&platform=pc&player=web`,
    );
    if (j.code !== 0) throw new Error(`getConf 失败: ${j.code} ${j.message ?? ''}`);
    const srv = (j.data.host_server_list ?? j.data.host_list ?? [])[0];
    if (!srv) throw new Error('getConf 未返回弹幕服务器');
    return { token: j.data.token, host: srv.host, port: srv.wss_port ?? 443 };
  }

  function scheduleReconnect(reason) {
    if (!running || reconnectTimer) return;
    attempts += 1;
    const delay = Math.min(30_000, 2_000 * attempts);
    log(`弹幕连接断开（${reason}），${Math.round(delay / 1000)}s 后重连（第 ${attempts} 次）`);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; void connect(); }, delay);
  }

  async function connect() {
    if (!running) return;
    try {
      await ensureFingerprint();
      await resolveRoom();
      if (!live) {
        log(`房间 ${realRoomId} 当前未开播，60 秒后重试`);
        status({ note: '未开播' });
        offlineTimer = setTimeout(() => { offlineTimer = null; void connect(); }, 60_000);
        return;
      }
      const { token, host, port } = await fetchConf();
      log(`连接弹幕服务器 ${host}:${port}（房间 ${realRoomId}）`);
      const socket = new WebSocket(`wss://${host}:${port}/sub`);
      socket.binaryType = 'arraybuffer';
      ws = socket;

      socket.onopen = () => {
        attempts = 0;
        lastError = '';
        socket.send(pack(JSON.stringify({
          uid: 0, roomid: realRoomId, protover: 3, buvid, platform: 'web', type: 2, key: token,
        }), OP.AUTH));
        heartbeat = setInterval(() => {
          try { socket.send(pack('', OP.HEARTBEAT)); } catch { /* 断开后由 onclose 处理 */ }
        }, 30_000);
        log('弹幕已连接');
        status({ note: '已连接' });
      };

      socket.onmessage = async (ev) => {
        const buf = ev.data instanceof ArrayBuffer
          ? Buffer.from(ev.data)
          : Buffer.from(await (ev.data?.arrayBuffer?.() ?? new ArrayBuffer(0)));
        if (!buf.length) return;
        const frames = [];
        for (const pkt of unpack(buf)) decodeInto(pkt, frames);
        for (const f of frames) {
          if (f.kind === 'auth-ok') { log('弹幕鉴权通过'); continue; }
          if (f.kind !== 'json') continue;
          messages += 1;
          trackCmd(f.data?.cmd);
          const event = normalize(f.data);
          if (event.kind !== 'other') {
            // 礼物解析出来是空字段 ⇒ 报文结构和预期不一样，也留一份原始样本备查
            if (event.kind === 'gift' && event.unknownShape) {
              trackSample(`${f.data?.cmd ?? 'gift'}__empty`, f.data);
            }
            onEvent(event);
          } else {
            trackSample(event.cmd ?? f.data?.cmd, f.data);
          }
        }
        status({ note: '已连接' });
      };

      socket.onclose = (ev) => {
        if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
        ws = null;
        if (!running) return;
        lastError = `连接关闭 code=${ev?.code ?? '?'}`;
        status({ note: lastError });
        scheduleReconnect(lastError);
      };

      socket.onerror = (ev) => {
        lastError = ev?.message ?? 'WebSocket 错误';
        log(`弹幕连接错误: ${lastError}`);
        status({ note: lastError });
      };
    } catch (err) {
      lastError = err?.message ?? String(err);
      log(`采集失败: ${lastError}`);
      status({ note: lastError });
      scheduleReconnect(lastError);
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      status({ note: '启动中' });
      void connect();
    },
    stop() {
      running = false;
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (offlineTimer) { clearTimeout(offlineTimer); offlineTimer = null; }
      try { ws?.close(); } catch { /* ignore */ }
      ws = null;
      status({ note: '已停止' });
    },
    get running() { return running; },
    get info() { return { roomId: realRoomId, uid, live, messages, lastError, connected: ws?.readyState === 1, cmds: { ...cmdCounts }, samples: { ...rawSamples } }; },
  };
}