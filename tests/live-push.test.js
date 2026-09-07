// live 推帧链路回归: 首帧必为全帧 / 小变化只发补丁(矩形正确) / 无变化只发心跳 / 大面积变化回退全帧
// 抓帧用可控假帧(mock capture.js), 不依赖花妖窗口, 覆盖 pushFrame 的四种发帧决策。
// 轮询在后台持续跑(200ms/tick), 帧到达时序不确定, 故断言"等待满足条件的帧"而非"下一帧"。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import WebSocket from 'ws';

const W = 390, H = 844;

// 假帧: 原始像素 + 可识别载荷(全帧 'FULL', 补丁 'P:x,y,w,h' 记录被裁剪的区域)
function fakeFrame(w, h, dirty) {
  const raw = Buffer.alloc(w * h * 4, 7);
  if (dirty) {
    for (let y = dirty.y; y < dirty.y + dirty.h; y++) {
      for (let x = dirty.x; x < dirty.x + dirty.w; x++) {
        const o = (y * w + x) * 4; raw[o] = 200; raw[o + 1] = 200; raw[o + 2] = 200;
      }
    }
  }
  return {
    img: {
      width: w, height: h,
      toRawSync: () => raw,
      toJpeg: async () => Buffer.from('FULL'),
      cropSync: (x, y, cw, ch) => ({ toJpegSync: () => Buffer.from(`P:${x},${y},${cw},${ch}`) }),
    },
    width: w, height: h, origin: { x: 0, y: 0 }, hwnd: 1,
  };
}

const h = vi.hoisted(() => ({ frame: null }));
vi.mock('../server/capture.js', () => ({ captureImage: async () => h.frame }));

const { initLive } = await import('../server/live.js');

let server, port, ws;
let frames = [], pending = null;

function push(f) {
  frames.push(f);
  if (pending) { const p = pending; pending = null; p(f); }
}

function nextFrame(ms) {
  return new Promise((res, rej) => {
    if (frames.length) return res(frames.shift());
    pending = res;
    setTimeout(() => { if (pending === res) { pending = null; rej(new Error('等待帧超时')); } }, ms);
  });
}

// 等到第一帧满足 pred 的帧(跳过期间穿插的心跳), 避免依赖具体到达时序
async function waitFor(pred, ms = 6000) {
  const deadline = Date.now() + ms;
  let last = null;
  while (Date.now() < deadline) {
    last = await nextFrame(Math.min(1000, Math.max(100, deadline - Date.now())));
    if (pred(last)) return last;
  }
  throw new Error('未等到期望帧, 最后收到: ' + JSON.stringify(last));
}

beforeAll(async () => {
  server = http.createServer();
  initLive(server, { onLog: () => { } });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  h.frame = fakeFrame(W, H, null);   // 初始静止画面
  ws = new WebSocket(`ws://127.0.0.1:${port}/api/live`);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    const b = Buffer.from(data);
    const f = { flags: b[0], w: b.readUInt16LE(9), h: b.readUInt16LE(11), payload: b.subarray((b[0] & 4) ? 21 : 13).toString() };
    if (f.flags & 4) { f.x = b.readUInt16LE(13); f.y = b.readUInt16LE(15); f.pw = b.readUInt16LE(17); f.ph = b.readUInt16LE(19); }
    push(f);
  });
  ws.send(JSON.stringify({ op: 'start', gear: 'fast' }));
});

afterAll(async () => {
  try { ws && ws.close(); } catch { /* ignore */ }
  await new Promise(r => server.close(r));
});

describe('live 推帧决策', () => {
  it('首帧无基准 -> 全帧(flags&2)', async () => {
    const f = await waitFor(x => (x.flags & 2) !== 0);
    expect(f.w).toBe(W); expect(f.h).toBe(H);
    expect(f.payload).toBe('FULL');
  });

  it('画面无变化 -> 13 字节心跳(flags&1, 无载荷)', async () => {
    const f = await waitFor(x => (x.flags & 1) !== 0);
    expect(f.payload).toBe('');
  });

  it('小区域变化 -> 只发补丁, 矩形精确(flags&4)', async () => {
    h.frame = fakeFrame(W, H, { x: 80, y: 300, w: 60, h: 30 });
    const f = await waitFor(x => (x.flags & 4) !== 0);
    expect({ x: f.x, y: f.y, w: f.pw, h: f.ph }).toEqual({ x: 80, y: 300, w: 60, h: 30 });
    expect(f.payload).toBe('P:80,300,60,30');   // 载荷就是该区域, 不是整帧
    expect(f.w).toBe(W); expect(f.h).toBe(H);   // 头部 w/h 恒为整幅尺寸
  });

  it('变化超过整屏 90% -> 回退全帧(补丁已无收益)', async () => {
    h.frame = fakeFrame(W, H, { x: 0, y: 0, w: W, h: H - 20 });   // ~98%
    const f = await waitFor(x => (x.flags & 2) !== 0);
    expect(f.payload).toBe('FULL');
  });
});
