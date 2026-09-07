// 档位自适应回归(决策完全在服务端): 客户端只上报帧到达间隔, 服务端与自己实际调度的间隔比对后升降档。
// 历史双 bug: ①到达间隔由服务端节奏决定, 客户端无法区分"空闲地板慢"与"网络慢"; ②stats 消息刷新了活动时间 ->
// 空闲地板永不生效(挂机仍满档)。故升档需要 !idle 且连续 2 个健康周期(迟滞防振荡), 降档 1 个周期即降。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { startLive, connectLive } from './helpers/live-harness.js';

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

let live, cli;

beforeAll(async () => {
  h.frame = fakeFrame(W, H);
  live = await startLive();
  cli = connectLive(live.port);
  await cli.ready;
});

afterAll(async () => {
  cli?.close();
  if (live) await new Promise(r => live.server.close(r));
});

describe('档位自适应(服务端决策)', () => {
  it('start 指定档位后服务端确认同档', async () => {
    cli.send({ op: 'start', gear: 'mid' });
    const m = await cli.waitCtl(x => x.op === 'gear');
    expect(m.gear).toBe('mid');
  });

  it('到达间隔超过调度间隔 2.5 倍 -> 立即降一档', async () => {
    cli.send({ op: 'stats', interval: 2000, expect: 500 });   // 2000 > 500*2.5
    const m = await cli.waitCtl(x => x.op === 'gear' && x.gear === 'eco');
    expect(m.gear).toBe('eco');
  });

  it('连续 2 个健康周期才升档(迟滞防振荡)', async () => {
    cli.ctls.length = 0;                    // 丢弃历史控制消息(否则 start 的档位确认会被误当成升档)
    cli.send({ op: 'refresh' });            // 真实操作: 刷新活动时间并进入 200ms 突发(调度间隔记为 200)
    await new Promise(r => setTimeout(r, 400));
    cli.send({ op: 'stats', interval: 200, expect: 200 });
    await new Promise(r => setTimeout(r, 300));
    expect(cli.ctls.some(m => m.op === 'gear' && m.gear === 'mid')).toBe(false);   // 仅 1 个健康周期: 不升档
    cli.send({ op: 'stats', interval: 200, expect: 200 });
    const m = await cli.waitCtl(x => x.op === 'gear' && x.gear === 'mid', 3000);
    expect(m.gear).toBe('mid');             // 第 2 个健康周期: 升档
  });
});
