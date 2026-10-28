/**
 * VTube Studio 公共 API 客户端（ws://127.0.0.1:8001）。
 *
 * 首次连接会弹出授权窗口（VTS 设置里必须先勾选 "Allow Plugin API access"），
 * 拿到 authenticationToken 后写入本地文件，之后每次连接直接复用。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
// ⚠️ 必须用 ws，不能用 Node 自带的全局 WebSocket：
//   实测对 VTube Studio 发请求时，全局 WebSocket 收到的全是**空帧**（string(0)），
//   表现成"请求超时"；换 ws 后一切正常。ws 已随插件一起带上（vendor/ws，MIT，零依赖）。
import WebSocket from '../vendor/ws/wrapper.mjs';

const API_NAME = 'VTubeStudioPublicAPI';
const API_VERSION = '1.0';

export function createVts({
  port = 8001,
  pluginName = 'DSH Whale Live',
  pluginDeveloper = 'DeepSeek Harness',
  tokenPath,
  log = () => {},
} = {}) {
  let ws = null;
  let seq = 0;
  let connected = false;
  let authenticated = false;
  let lastError = '';
  let model = null; // 当前加载的模型 {loaded, name, id}，来自 HotkeysInCurrentModelResponse
  const pending = new Map();
  const listeners = new Set();

  function emit(state) {
    for (const fn of listeners) { try { fn(state); } catch { /* ignore */ } }
  }

  function state() {
    return { port, connected, authenticated, lastError, model };
  }

  function requestId() {
    seq += 1;
    return `whale${seq}${Date.now().toString(36)}`;
  }

  function call(messageType, data = {}, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== 1) {
        reject(new Error('VTS 未连接（请先启动 VTube Studio 并允许插件访问）'));
        return;
      }
      const requestID = requestId();
      const expected = `${messageType.replace(/Request$/, '')}Response`;
      const timer = setTimeout(() => {
        pending.delete(requestID);
        reject(new Error(`VTS 请求超时: ${messageType}`));
      }, timeoutMs);
      pending.set(requestID, {
        expected,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try {
        ws.send(JSON.stringify({ apiName: API_NAME, apiVersion: API_VERSION, requestID, messageType, data }));
      } catch (err) {
        clearTimeout(timer);
        pending.delete(requestID);
        reject(err);
      }
    });
  }

  async function readToken() {
    if (!tokenPath) return '';
    try {
      const raw = await fs.readFile(tokenPath, 'utf8');
      return JSON.parse(raw)?.authenticationToken ?? '';
    } catch { return ''; }
  }

  async function writeToken(token) {
    if (!tokenPath || !token) return;
    try {
      await fs.mkdir(path.dirname(tokenPath), { recursive: true });
      await fs.writeFile(tokenPath, JSON.stringify({ authenticationToken: token }, null, 2), 'utf8');
    } catch (err) {
      log(`保存 VTS 令牌失败: ${err?.message ?? err}`);
    }
  }

  async function authenticate() {
    const saved = await readToken();
    if (saved) {
      try {
        const res = await call('AuthenticationRequest', { pluginName, pluginDeveloper, authenticationToken: saved }, 8000);
        if (res?.data?.authenticated) { authenticated = true; log('VTS 鉴权成功（复用令牌）'); emit(state()); return; }
        log('VTS 令牌已失效，重新申请授权');
      } catch (err) {
        log(`VTS 令牌鉴权失败: ${err?.message ?? err}`);
      }
    }
    log('向 VTS 申请授权 —— 请在 VTube Studio 弹窗里点 "Allow"');
    const res = await call('AuthenticationTokenRequest', { pluginName, pluginDeveloper }, 120_000);
    const token = res?.data?.authenticationToken;
    if (!token) throw new Error('VTS 没有返回授权令牌（弹窗可能被拒绝）');
    await writeToken(token);
    const ok = await call('AuthenticationRequest', { pluginName, pluginDeveloper, authenticationToken: token }, 8000);
    if (!ok?.data?.authenticated) throw new Error('VTS 鉴权被拒绝');
    authenticated = true;
    log('VTS 鉴权成功');
    emit(state());
  }

  /** 补一次鉴权：socket 还开着但没授权时走这条路（否则 connect 会误判"已连上"直接返回）。 */
  async function ensureAuthenticated() {
    try {
      await authenticate();
      lastError = '';
      emit(state());
    } catch (err) {
      lastError = err?.message ?? String(err);
      log(`VTS 鉴权失败: ${lastError}`);
      emit(state());
      throw new Error(lastError);
    }
  }

  async function connect() {
    // ⚠️ 这里以前只看 socket 开着就返回 ⇒ 授权失败后再点"连接 VTS"，它会直接返回
    //    "connected: true, authenticated: false"，永远不去用那份已保存的令牌。
    if (ws && ws.readyState === 1) {
      if (!authenticated) await ensureAuthenticated();
      return state();
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(`ws://127.0.0.1:${port}`, { perMessageDeflate: false });
      ws = socket;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        lastError = err?.message ?? String(err);
        log(`VTS 连接失败: ${lastError}`);
        emit(state());
        reject(new Error(lastError));
      };
      socket.onopen = () => {
        connected = true;
        emit(state());
        ensureAuthenticated()
          .then(() => { settled = true; resolve(state()); })
          .catch(fail);
      };
      socket.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
        // ⭐ APIError 必须先接住：以前只认"期望的那个 Response"，于是 VTS 回错误帧时
        //    请求会一直挂到超时，报出来的却是"请求超时"，完全看不出真实原因（例如模型没加载）。
        if (msg.messageType === 'APIError') {
          lastError = `VTS 错误 ${msg.data?.errorID ?? ''}: ${msg.data?.message ?? ''}`.trim();
          const waiting = pending.get(msg.requestID);
          if (waiting) { pending.delete(msg.requestID); waiting.reject(new Error(lastError)); }
          emit(state());
          return;
        }
        const waiter = pending.get(msg.requestID);
        if (waiter && (!waiter.expected || waiter.expected === msg.messageType)) {
          pending.delete(msg.requestID);
          waiter.resolve(msg);
        }
      };
      socket.onclose = () => {
        connected = false;
        authenticated = false;
        ws = null;
        for (const [, w] of pending) w.reject(new Error('VTS 连接已关闭'));
        pending.clear();
        emit(state());
      };
      socket.onerror = () => fail(new Error(
        `无法连接 VTS（端口 ${port}）—— 确认 VTube Studio 正在运行，`
        + '并且在 VTS「设置 → Plugin API」里打开了 Allow Plugin API access（端口要与这里一致）',
      ));
    });
  }

  async function disconnect() {
    if (ws) { try { ws.close(); } catch { /* ignore */ } }
    ws = null;
    connected = false;
    authenticated = false;
  }

  async function listHotkeys() {
    // ⚠️ 接口名是 HotkeysInCurrentModelRequest。写成 HotkeyListRequest 的话，
    //   VTS 会回 `APIError 7: Unknown messageType: HotkeyListRequest`（1.35.10 实测）。
    const res = await call('HotkeysInCurrentModelRequest', {});
    model = {
      loaded: !!res?.data?.modelLoaded,
      name: res?.data?.modelName ?? '',
      id: res?.data?.modelID ?? '',
    };
    return res?.data?.availableHotkeys ?? [];
  }

  async function triggerHotkey(hotkeyID) {
    return call('HotkeyTriggerRequest', { hotkeyID });
  }

  return {
    connect,
    disconnect,
    state,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    call,
    listHotkeys,
    /** 按名字模糊触发一个热键（如 "04 脸红"）。 */
    async triggerByName(name) {
      const hotkeys = await listHotkeys();
      const q = String(name).toLowerCase();
      const hit = hotkeys.find((h) => String(h.name ?? '').toLowerCase() === q)
        ?? hotkeys.find((h) => String(h.name ?? '').toLowerCase().includes(q));
      if (!hit) throw new Error(`模型里没有名为「${name}」的热键`);
      await triggerHotkey(hit.hotkeyID);
      return { hotkeyID: hit.hotkeyID, name: hit.name };
    },
    /** 清掉所有表情。 */
    async clearExpressions() {
      const hotkeys = await listHotkeys();
      const hit = hotkeys.find((h) => String(h.type ?? '').toLowerCase() === 'removeallexpressions');
      if (hit) await triggerHotkey(hit.hotkeyID);
    },
    /** 直接写入 Live2D 参数（口型、手势等）。 */
    async injectParameters(values) {
      const parameterValues = values.map((v) => ({ id: v.id, value: Number(v.value) || 0, weight: v.weight ?? 1 }));
      return call('InjectParameterDataRequest', { parameterValues, mode: 'set', faceFound: false });
    },
    /** 旋转/移动整个模型：整层旋转做「倒立」这类动作。 */
    async moveModel({ rotation = 0, positionX, positionY, size, seconds = 0.3 }) {
      const values = { rotation };
      if (typeof positionX === 'number') values.positionX = positionX;
      if (typeof positionY === 'number') values.positionY = positionY;
      if (typeof size === 'number') values.size = size;
      return call('MoveModelRequest', { timeInSeconds: seconds, values, faceFound: false });
    },
    async expressions() {
      const res = await call('ExpressionStateRequest', { details: true });
      return res?.data ?? {};
    },
  };
}