// 空闲地板回归: 无操作超过 LIVE_IDLE_MS -> 轮询抬到省流档并把档位同步降为 eco(徽标跟着降为 1 格)。
// 历史 bug: stats 上报消息刷新了 lastActivity -> 客户端一直上报, 空闲地板永不生效(挂机也满档, 白耗流量)。
// 这里把 LIVE_IDLE_MS 压到 600ms 以便在测试内验证(必须在 import live.js 之前设置)。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { startLive, connectLive } from './helpers/live-harness.js';

process.env.LIVE_IDLE_MS = '600';

const W = 390, H = 844;
function fakeFrame(w, h) {
  const raw = Buffer.alloc(w * h * 4, 7);
  return {
    img: {
      width: w, height: h,
      toRawSync: () => raw,
      toJpeg: async () => Buffer.from('FULL'),
      cropSync: () => ({ toJpegSync: () => Buffer.from('P') }),
    },
    width: w, height: h, origin: { x: 0, y: 0 }, hwnd: 1,
  };
}

const h = vi.hoisted(() => ({ frame: null }));
vi.mock('../server/capture.js', () => ({ captureImage: async () => h.frame }));

let live;

beforeAll(async () => {
  h.frame = fakeFrame(W, H);
  live = await startLive();
});

afterAll(async () => {
  if (live) await new Promise(r => live.server.close(r));
});

async function freshClient(gear = 'fast') {
  const c = connectLive(live.port);
  await c.ready;
  c.send({ op: 'start', gear });
  return c;
}

describe('空闲地板(LIVE_IDLE_MS=600ms)', () => {
  it('无操作超过阈值 -> 强制降为省流档并通知客户端', async () => {
    const c = await freshClient('fast');
    try {
      const m = await c.waitCtl(x => x.op === 'gear' && x.gear === 'eco', 6000);
      expect(m.gear).toBe('eco');
    } finally { c.close(); }
  });

  it('stats 上报不算活动: 客户端持续上报仍会进入空闲地板', async () => {
    const c = await freshClient('fast');
    const timer = setInterval(() => c.send({ op: 'stats', interval: 200, expect: 200 }), 150);
    try {
      const m = await c.waitCtl(x => x.op === 'gear' && x.gear === 'eco', 6000);
      expect(m.gear).toBe('eco');
    } finally { clearInterval(timer); c.close(); }
  });
});
