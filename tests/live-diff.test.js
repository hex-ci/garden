// live 变化检测单元回归: 全量像素比对(替代原采样哈希)的正确性与灵敏度
// 采样哈希只覆盖 0.073% 字节, 几十像素的小变化(数字/进度)有 7 成概率漏检导致画面不刷新;
// diffRect 必须能稳定检出任意大小的变化, 并给出最小包围盒(用于只传变化区域)。
import { describe, it, expect } from 'vitest';
import { diffRect } from '../server/live.js';

const W = 390, H = 844;

function makeFrame() {
  const b = Buffer.alloc(W * H * 4, 0);
  for (let i = 0; i < b.length; i += 4) { b[i] = 40; b[i + 1] = 60; b[i + 2] = 80; b[i + 3] = 255; }
  return b;
}

function mark(b, x0, y0, rw, rh) {
  for (let y = y0; y < y0 + rh; y++) {
    for (let x = x0; x < x0 + rw; x++) {
      const o = (y * W + x) * 4;
      b[o] = 200; b[o + 1] = 10; b[o + 2] = 30;
    }
  }
}

describe('diffRect 变化检测', () => {
  it('画面完全没变 -> null(只发心跳)', () => {
    expect(diffRect(makeFrame(), makeFrame(), W, H)).toBe(null);
  });

  it('单个像素变化也能检出(采样哈希的漏检场景)', () => {
    const a = makeFrame(), b = makeFrame();
    mark(b, 123, 456, 1, 1);
    expect(diffRect(a, b, W, H)).toEqual({ x: 123, y: 456, w: 1, h: 1 });
  });

  it('一处小区域(60x30) -> 精确包围盒', () => {
    const a = makeFrame(), b = makeFrame();
    mark(b, 80, 250, 60, 30);
    expect(diffRect(a, b, W, H)).toEqual({ x: 80, y: 250, w: 60, h: 30 });
  });

  it('上下两处散落变化 -> 包围盒覆盖全部(不漏检)', () => {
    const a = makeFrame(), b = makeFrame();
    mark(b, 40, 80, 20, 14);
    mark(b, 300, 700, 20, 14);
    expect(diffRect(a, b, W, H)).toEqual({ x: 40, y: 80, w: 300 - 40 + 20, h: 700 - 80 + 14 });
  });

  it('仅 alpha 变化不算变化(截图 alpha 恒 255, 比对它只会引入假帧)', () => {
    const a = makeFrame(), b = makeFrame();
    for (let i = 3; i < b.length; i += 4) b[i] = 128;
    expect(diffRect(a, b, W, H)).toBe(null);
  });

  it('整屏全变 -> 包围盒为整屏', () => {
    const a = makeFrame(), b = makeFrame();
    mark(b, 0, 0, W, H);
    expect(diffRect(a, b, W, H)).toEqual({ x: 0, y: 0, w: W, h: H });
  });
});
