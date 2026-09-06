// 实时画面推送 (WebSocket): WS 挂在现有 HTTP 端口上, 路径 /api/live
// 设计要点(见 CODEBUDDY.md): 轮询抓帧 + 变化才发帧(原始帧采样哈希), 全自动双向档位,
// 操作突发(REST 点击/输入成功后短时高速), 操作反馈帧主动推送(~140ms), 无操作 3 分钟回落省流。
// 帧格式(二进制): [u8 flags][u32 seq][u32 ts][u16 w][u16 h] + JPEG 载荷; flags&1 = 跳帧(无载荷)。
// 控制消息为 JSON 文本: 客户端 {op:'start'|'gear'|'stop'|'refresh'|'stats'}, 服务端 {op:'gear'|'error'}。
import { WebSocketServer } from 'ws';
import * as capture from './capture.js';

const GEARS = { eco: 2000, mid: 500, fast: 200 };   // 各档轮询间隔 ms
const GEAR_ORDER = ['eco', 'mid', 'fast'];          // 档位顺序(低→高)
const BURST_MS = 2000;                // 操作后突发高速轮询时长
const BURST_INTERVAL = 200;           // 突发期轮询间隔
const FEEDBACK_DELAY = 140;           // 操作后主动推反馈帧的延迟(留时间给渲染器消化操作)
const IDLE_DOWN_MS = Number(process.env.LIVE_IDLE_MS) || 3 * 60 * 1000;   // 无操作回落省流档(默认 3 分钟, LIVE_IDLE_MS 可配)
const MAX_BUFFERED = 512 * 1024;      // 客户端积压上限(背压保护: 网络跟不上就暂缓发帧)
const HASH_STEP = 4093;               // 原始帧变化检测的采样步长(字节)

let onLog = () => { };
let burstUntil = 0;
let lastActivity = Date.now();
const clients = new Set();

// REST 点击/输入成功后调用: 突发提速 + 主动推反馈帧(不等下一个轮询 tick)
export function noteActivity() {
  burstUntil = Date.now() + BURST_MS;
  lastActivity = Date.now();
  kick();
}

// 操作反馈: 所有空闲客户端 ~140ms 后抓帧推送; 忙碌客户端标记 kickPending, 完成后补推
function kick() {
  for (const st of clients) {
    if (st.closed) continue;
    if (st.busy) { st.kickPending = true; continue; }
    if (st.pushTimer) clearTimeout(st.pushTimer);
    if (st.timer) { clearTimeout(st.timer); st.timer = null; }
    st.pushTimer = setTimeout(() => { st.pushTimer = null; tick(st); }, FEEDBACK_DELAY);
  }
}

function makeHead(st, flags, w, h) {
  const head = Buffer.alloc(13);
  head.writeUInt8(flags, 0);
  head.writeUInt32LE(++st.seq, 1);
  head.writeUInt32LE(Date.now() >>> 0, 5);
  head.writeUInt16LE(w, 9);
  head.writeUInt16LE(h, 11);
  return head;
}

// 抓帧 + 变化检测 + 发送(轮询与操作反馈共用)
async function pushFrame(st) {
  // 背压保护: 客户端积压超过上限(网络跟不上)时暂缓发帧
  if (st.busy || st.ws.bufferedAmount > MAX_BUFFERED) return;
  st.busy = true;
  try {
    const fr = await capture.captureImage();
    const raw = fr.img.toRawSync();
    let h = 0;
    for (let i = 0; i + 2 < raw.length; i += HASH_STEP) {
      h = (h * 31 + raw[i]) | 0;
      h = (h * 31 + raw[i + 1]) | 0;
      h = (h * 31 + raw[i + 2]) | 0;
    }
    if (h === st.lastHash) {
      st.ws.send(makeHead(st, 1, fr.width, fr.height));
    } else {
      st.lastHash = h;
      const jpg = await fr.img.toJpeg();
      if (st.ws.readyState === 1) st.ws.send(Buffer.concat([makeHead(st, 0, fr.width, fr.height), jpg]));
    }
    st.busy = false;
  } catch (e) {
    st.lastHash = null;
    st.busy = false;
    if (!st.closed && st.ws.readyState === 1) st.ws.send(JSON.stringify({ op: 'error', message: String(e.message || e) }));
  }
}

function scheduleNext(st, interval) {
  if (st.closed || st.ws.readyState !== 1) return;
  st.lastInterval = interval;   // 记录实际调度间隔, 供档位自适应判断(客户端上报值与服务端节奏比对)
  // 抓帧期间有操作进来: 立刻补一帧反馈(短延迟), 覆盖抓帧时未包含的操作效果
  if (st.kickPending) {
    st.kickPending = false;
    st.timer = setTimeout(() => { st.timer = null; tick(st); }, FEEDBACK_DELAY);
    return;
  }
  if (!st.timer && !st.pushTimer) st.timer = setTimeout(() => { st.timer = null; tick(st); }, interval);
}

async function tick(st) {
  if (st.closed || st.ws.readyState !== 1) return;
  // 空闲地板: 3 分钟无操作 → 轮询抬到省流档, 档位同步降为 eco 并通知客户端(徽标降为 1 格);
  // 交互恢复后由自适应自动爬升(省流→均衡→流畅)
  const idle = Date.now() - lastActivity > IDLE_DOWN_MS;
  if (idle && st.gear !== 'eco') {
    st.gear = 'eco';
    st.healthyRuns = 0;
    if (st.ws.readyState === 1) st.ws.send(JSON.stringify({ op: 'gear', gear: 'eco' }));
  }
  const interval = Date.now() < burstUntil ? BURST_INTERVAL : (idle ? Math.max(GEARS[st.gear], GEARS.eco) : GEARS[st.gear]);
  await pushFrame(st);
  scheduleNext(st, interval);
}

export function initLive(httpServer, opts = {}) {
  onLog = opts.onLog || onLog;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  httpServer.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname !== '/api/live') return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    const st = { ws, seq: 0, gear: 'mid', timer: null, pushTimer: null, busy: false, lastHash: null, kickPending: false, closed: false, lastInterval: GEARS.mid, healthyRuns: 0 };
    clients.add(st);
    lastActivity = Date.now();   // 新连接视为一次活动(用户刚打开页面, 先给正常节奏)
    onLog(`live client connected (total=${clients.size})`);

    const sendCtl = (o) => { if (!st.closed && ws.readyState === 1) ws.send(JSON.stringify(o)); };
    const stopTimers = () => { if (st.timer) { clearTimeout(st.timer); st.timer = null; } if (st.pushTimer) { clearTimeout(st.pushTimer); st.pushTimer = null; } };

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let m; try { m = JSON.parse(data.toString()); } catch { return; }
      // 注意: stats 等常规消息不刷新 lastActivity(否则空闲地板永不生效);
      // 只有 noteActivity(REST 操作/refresh op, 即真实用户操作)才算活动
      if (m.op === 'start' && GEARS[m.gear]) {
        st.gear = m.gear;
        sendCtl({ op: 'gear', gear: st.gear });
        stopTimers();
        tick(st);
      } else if (m.op === 'gear' && GEARS[m.gear]) {
        st.gear = m.gear;
        sendCtl({ op: 'gear', gear: st.gear });
      } else if (m.op === 'refresh') {
        noteActivity();   // 程序化刷新 = 触发一次突发推帧
      } else if (m.op === 'stats') {
        // 档位自适应(服务端决策): 客户端上报的帧到达间隔与本端实际调度间隔比对。
        // 到达间隔由服务端节奏决定, 只有服务端能区分"空闲地板慢"与"网络慢"。
        const exp = st.lastInterval || GEARS[st.gear];
        const avg = Number(m.interval) || 0;
        const idle = Date.now() - lastActivity > IDLE_DOWN_MS;
        if (avg > exp * 2.5 && st.gear !== 'eco') {
          st.healthyRuns = 0;
          st.gear = GEAR_ORDER[GEAR_ORDER.indexOf(st.gear) - 1];
          sendCtl({ op: 'gear', gear: st.gear });
        } else if (!idle && avg > 0 && avg < exp * 1.3 && st.gear !== 'fast') {
          if (++st.healthyRuns >= 2) {   // 连续 2 个健康周期才升档(迟滞防振荡)
            st.healthyRuns = 0;
            st.gear = GEAR_ORDER[GEAR_ORDER.indexOf(st.gear) + 1];
            sendCtl({ op: 'gear', gear: st.gear });
          }
        } else {
          st.healthyRuns = 0;
        }
        onLog(`live stats interval=${m.interval}ms exp=${exp}ms avg判断=${avg > exp * 2.5 ? '降' : (!idle && avg < exp * 1.3 ? '升候选' : '稳')} gear=${st.gear} idle=${idle}`);
      } else if (m.op === 'stop') {
        stopTimers();
      }
    });
    ws.on('close', () => { st.closed = true; stopTimers(); clients.delete(st); onLog(`live client closed (total=${clients.size})`); });
    ws.on('error', () => { st.closed = true; stopTimers(); });
  });
}
