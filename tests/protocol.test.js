// 跨端协议一致性: 后端真实发出的二进制帧, 交给前端真实解析函数(从 app.js 截取)去解析, 断言两端对同一帧的理解一致。
// 历史 bug: 后端 writeUInt16LE(小端) 而前端 getUint16 默认大端 -> 390 被读成 34305 -> w/h 与 canvas 不符 ->
// 补丁帧被判"基准失效"全部丢弃并反复索要关键帧, 退化成每帧 27.5KB 全帧(实测 45KB/s, 画面却照常显示)。
// 这类"两端不一致"单看任一端都发现不了, 必须把真实帧喂给真实解析函数。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { extractFn } from './helpers/frontend-source.js';
import { startLive, connectLive } from './helpers/live-harness.js';

const W = 390, H = 844;
const DIRTY = { x: 80, y: 300, w: 60, h: 30 };

// 假帧: 全帧载荷 'FULL', 补丁载荷 'P:x,y,w,h'(记录被裁剪的区域)
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
const parseFrameHead = new Function(extractFn('parseFrameHead') + '\n return parseFrameHead;')();
const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);

beforeAll(async () => {
  h.frame = fakeFrame(W, H, null);
  live = await startLive();
  cli = connectLive(live.port);
  await cli.ready;
  cli.send({ op: 'start', gear: 'fast' });
});

afterAll(async () => {
  cli?.close();
  if (live) await new Promise(r => live.server.close(r));
});

describe('跨端协议: 后端真实帧 -> 前端真实解析', () => {
  it('全帧: 解析出的 w/h 与后端一致, 载荷紧跟 13 字节头', async () => {
    const b = await cli.waitFrame(x => (x[0] & 2) !== 0);
    const f = parseFrameHead(view(b));
    expect({ w: f.w, h: f.h }).toEqual({ w: W, h: H });
    expect(b.subarray(13).toString()).toBe('FULL');
  });

  it('补丁帧: 解析出的 x/y 与后端裁剪区域一致, 载荷紧跟 21 字节头', async () => {
    h.frame = fakeFrame(W, H, DIRTY);
    const b = await cli.waitFrame(x => (x[0] & 4) !== 0);
    const f = parseFrameHead(view(b));
    expect({ x: f.x, y: f.y }).toEqual({ x: DIRTY.x, y: DIRTY.y });
    expect(b.subarray(21).toString()).toBe(`P:${DIRTY.x},${DIRTY.y},${DIRTY.w},${DIRTY.h}`);
  });

  it('心跳帧仅 13 字节, 解析不越界', async () => {
    h.frame = fakeFrame(W, H, null);
    const b = await cli.waitFrame(x => (x[0] & 1) !== 0);
    expect(b.length).toBe(13);
    const f = parseFrameHead(view(b));   // 无条件读 x/y 会在这里抛 RangeError
    expect(f.x).toBe(0);
    expect(f.y).toBe(0);
  });

  it('usable 判定成立(帧头 w/h 与 canvas 基准一致)—— 曾因字节序恒假而丢弃全部补丁', async () => {
    h.frame = fakeFrame(W, H, DIRTY);
    const b = await cli.waitFrame(x => (x[0] & 4) !== 0);
    const f = parseFrameHead(view(b));
    const natural = { w: W, h: H };          // 前端 canvas 首帧铺满后的 imgNatural
    expect(natural.w === f.w && natural.h === f.h).toBe(true);
  });
});
