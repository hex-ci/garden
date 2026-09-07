// 后台暂停回归: 页面切后台发 stop(保连接只停推帧), 回前台发 start 恢复。
// 旧做法是直接断开再重连, 代价是重连必收一次 27.5KB 全帧 + 握手 + 2s 延迟;
// 保连接恢复时若画面没变只需 13B 心跳 —— 这里就锁住这一点。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { startLive, connectLive } from './helpers/live-harness.js';

const W = 390, H = 844;

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

let live, cli;

beforeAll(async () => {
  h.frame = fakeFrame(W, H, null);
  live = await startLive();
  cli = connectLive(live.port);
  await cli.ready;
});

afterAll(async () => {
  cli?.close();
  if (live) await new Promise(r => live.server.close(r));
});

describe('后台暂停: stop/start 保连接', () => {
  it('start 后正常收帧', async () => {
    cli.send({ op: 'start', gear: 'fast' });
    await cli.waitFrame(() => true, 3000);
    expect(cli.frames.length).toBeGreaterThan(0);
  });

  it('stop 后不再推帧', async () => {
    cli.send({ op: 'stop' });
    await new Promise(r => setTimeout(r, 300));   // 放过在途帧
    const n = cli.frames.length;
    await new Promise(r => setTimeout(r, 1200));  // fast 档 200ms/帧, 足够跑好几帧
    expect(cli.frames.length).toBe(n);
  });

  it('暂停期间别的客户端有操作(refresh)也不被唤醒', async () => {
    cli.send({ op: 'refresh' });   // noteActivity -> kick 所有客户端, 暂停中的要跳过
    await new Promise(r => setTimeout(r, 300));
    const n = cli.frames.length;
    await new Promise(r => setTimeout(r, 800));
    expect(cli.frames.length).toBe(n);
  });

  it('start 恢复: 画面未变则只发 13B 心跳(不是 27KB 全帧)', async () => {
    cli.frames.length = 0;   // 丢掉历史帧(否则会匹配到首次 start 的全帧)
    cli.send({ op: 'start', gear: 'fast' });
    const b = await cli.waitFrame(() => true, 3000);
    expect(b[0] & 1).toBeTruthy();   // flags&1 = 跳帧心跳
    expect(b.length).toBe(13);
  });

  it('恢复后画面变化照常推补丁, 坐标正确', async () => {
    h.frame = fakeFrame(W, H, { x: 10, y: 20, w: 30, h: 40 });
    const b = await cli.waitFrame(x => (x[0] & 4) !== 0, 3000);
    expect(b.readUInt16LE(13)).toBe(10);
    expect(b.readUInt16LE(15)).toBe(20);
  });
});
