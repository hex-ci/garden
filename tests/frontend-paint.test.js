// 前端 canvas 合成回归: 全帧/补丁帧上屏后, 交互基准(imgNatural)必须保持正确
// 历史 bug: paintFull 里先 bmp.close() 再读 bmp.width —— ImageBitmap.close() 之后宽高归零,
// 导致 imgNatural={0,0} -> renderInfo() 恒为 null -> 点击映射/缩放/平移全部失效(画面却能正常显示, 极难察觉)。
// 这里直接执行 public/js/app.js 里的真实函数源码(仅注入外部依赖替身), 保证改动前端即被测试覆盖。
import { describe, it, expect } from 'vitest';
import { appSrc, htmlSrc, extractFn, execSource } from './helpers/frontend-source.js';

// 用最小替身执行真实源码: 只注入 paintFull 依赖的外部符号
function makePaintFull() {
  const cv = { width: 300, height: 150, style: {} };
  const drawn = [];
  const ctx = { drawImage: (...a) => drawn.push(a) };
  const empty = { style: { display: 'flex' } };
  const inputBtn = { disabled: true };
  let applied = 0;
  const factory = new Function(
    'cv', 'ctx', 'empty', 'inputBtn', 'applyTransform', 'updateCursor', 'manual',
    'let imgNatural=null;\n' + extractFn('paintFull') +
    '\n return { paintFull, get imgNatural(){ return imgNatural; } };'
  );
  const api = factory(cv, ctx, empty, inputBtn, () => { applied++; }, () => {}, false);
  api.cv = cv; api.empty = empty; api.inputBtn = inputBtn; api.drawn = drawn;
  api.appliedCount = () => applied;   // 挂属性而非展开: 展开会求值并丢掉 imgNatural getter
  return api;
}

// close() 后宽高归零 —— 真实 ImageBitmap 的行为
function imageBitmapStub(w, h) {
  return { width: w, height: h, close() { this.width = 0; this.height = 0; } };
}

describe('canvas 合成: 全帧上屏', () => {
  it('ImageBitmap 释放(close)后仍记录正确基准尺寸', () => {
    const t = makePaintFull();
    t.paintFull(imageBitmapStub(390, 844));
    expect(t.cv.width).toBe(390);
    expect(t.cv.height).toBe(844);
    expect(t.imgNatural).toEqual({ w: 390, h: 844 });   // 归零会让点击/缩放全部失效
  });

  it('普通 Image(无 close)同样记录正确', () => {
    const t = makePaintFull();
    t.paintFull({ width: 390, height: 844 });
    expect(t.imgNatural).toEqual({ w: 390, h: 844 });
  });

  it('尺寸变化时同步画布位图, 并把画面画到原点', () => {
    const t = makePaintFull();
    t.paintFull({ width: 800, height: 600 });
    expect(t.cv.width).toBe(800);
    expect(t.cv.height).toBe(600);
    expect(t.drawn.length).toBe(1);
    expect(t.drawn[0][1]).toBe(0);
    expect(t.drawn[0][2]).toBe(0);
  });

  it('全帧后隐藏空态、解禁输入并刷新布局', () => {
    const t = makePaintFull();
    t.paintFull(imageBitmapStub(390, 844));
    expect(t.empty.style.display).toBe('none');
    expect(t.inputBtn.disabled).toBe(false);
    expect(t.appliedCount()).toBe(1);
  });
});

describe('canvas 合成: 补丁帧上屏', () => {
  function makePaintPatch(initial) {
    const drawn = [];
    const ctx = { drawImage: (...a) => drawn.push(a) };
    const factory = new Function(
      'ctx', 'initial',
      'let imgNatural=initial;\n' + extractFn('paintPatch') +
      '\n return { paintPatch, get imgNatural(){ return imgNatural; } };'
    );
    const api = factory(ctx, initial);
    api.drawn = drawn;   // 同上: 不展开, 保留 imgNatural getter
    return api;
  }

  it('按 x/y 叠加且不改动基准尺寸', () => {
    const base = { w: 390, h: 844 };
    const t = makePaintPatch(base);
    t.paintPatch(imageBitmapStub(40, 12), 10, 20);
    expect(t.drawn.length).toBe(1);
    expect(t.drawn[0][1]).toBe(10);
    expect(t.drawn[0][2]).toBe(20);
    expect(t.imgNatural).toBe(base);
  });

  it('无基准(还没首帧)时丢弃补丁', () => {
    const t = makePaintPatch(null);
    t.paintPatch(imageBitmapStub(40, 12), 0, 0);
    expect(t.drawn.length).toBe(0);
  });
});

describe('前端结构: canvas 而非 <img>', () => {
  it('index.html 使用 canvas 承载画面', () => {
    expect(htmlSrc).toMatch(/<canvas[^>]+id="ctrlImg"/);
  });

  it('app.js 不残留 <img> 元素用法', () => {
    expect(appSrc).not.toMatch(/[^.\w]img\s*\.\s*(src|onload|naturalWidth|naturalHeight|style)\b/);
  });

  // 画面只有 WS 一个来源: 一旦有人把 REST 取图加回来, 就会出现"REST 图与 WS 帧争抢 canvas 基准"的旧病
  it('不残留 REST 取图路径', () => {
    expect(appSrc).not.toMatch(/api\/control\/shot/);
    expect(appSrc).not.toMatch(/showImage/);
    expect(appSrc).not.toMatch(/data:image\/jpeg;base64/);
  });
});

// 历史 bug: 帧头按大端解析(漏传 littleEndian) —— 服务端 writeUInt16LE 写的小端被读成大端,
// 390 变成 34305 -> 与 canvas 尺寸不符 -> 补丁帧被判"基准失效"而全部丢弃并反复索要关键帧,
// 退化成每帧 27.5KB 全帧(实测 45KB/s, 而补丁路径仅 ~2KB/s)。画面仍能显示, 极难察觉。
describe('实时帧头解析: 服务端小端写入', () => {
  function makeHeadParser() {
    return new Function(extractFn('parseFrameHead') + '\n return parseFrameHead;')();
  }

  // 复刻服务端帧头: [u8 flags][u32 seq][u32 ts][u16 w][u16 h] (+补丁时 [u16 x][u16 y][u16 w][u16 h])
  function frameHead(flags, w, h, x, y, withRect) {
    const b = Buffer.alloc(withRect ? 21 : 13);
    b.writeUInt8(flags, 0);
    b.writeUInt32LE(1, 1);
    b.writeUInt32LE(2, 5);
    b.writeUInt16LE(w, 9);
    b.writeUInt16LE(h, 11);
    if (withRect) { b.writeUInt16LE(x, 13); b.writeUInt16LE(y, 15); }
    return new DataView(b.buffer, b.byteOffset, b.byteLength);
  }

  it('整幅尺寸按小端解析', () => {
    const f = makeHeadParser()(frameHead(2, 390, 844, 0, 0, false));
    expect(f.w).toBe(390);
    expect(f.h).toBe(844);
  });

  it('补丁帧坐标按小端解析', () => {
    const f = makeHeadParser()(frameHead(4, 390, 844, 332, 12, true));
    expect(f.x).toBe(332);
    expect(f.y).toBe(12);
  });

  it('心跳帧只有 13 字节头, 读 x/y 不越界', () => {
    const f = makeHeadParser()(frameHead(1, 390, 844, 0, 0, false));
    expect(f.flags).toBe(1);
    expect(f.x).toBe(0);
  });

  it('所有 getUint16 都显式指定小端', () => {
    const calls = appSrc.match(/getUint16\([^)]*\)/g) || [];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c).toMatch(/,\s*true\s*\)/);
  });
});

// 解码是异步的(createImageBitmap), 补丁必须严格按到达顺序叠加: 乱序会让旧补丁盖在新补丁上, 画面局部错乱。
// enqueuePaint 用 Promise 链串行化; 这里故意让三个补丁的解码耗时递减(30/1/10ms), 制造天然的乱序风险。
describe('canvas 合成: 补丁按序上屏', () => {
  it('解码耗时不同仍按入队顺序叠加', async () => {
    const drawn = [];
    const ctx = { drawImage: (bmp, x, y) => drawn.push({ id: bmp.id, x, y }) };
    const api = execSource(
      {
        ctx,
        initial: { w: 390, h: 844 },
        toBitmap: async (bmp) => { await new Promise(r => setTimeout(r, bmp.d)); return bmp; },
      },
      ['enqueuePaint', 'paintPatch'],
      '{ enqueuePaint, paintPatch, toBitmap, get chain(){ return paintChain; } }',
      'let imgNatural=initial;\nlet paintChain=Promise.resolve();'
    );
    api.enqueuePaint(async () => api.paintPatch(await api.toBitmap({ id: 1, d: 30 }), 10, 20));
    api.enqueuePaint(async () => api.paintPatch(await api.toBitmap({ id: 2, d: 1 }), 30, 40));
    api.enqueuePaint(async () => api.paintPatch(await api.toBitmap({ id: 3, d: 10 }), 50, 60));
    await api.chain;
    expect(drawn.map(d => d.id)).toEqual([1, 2, 3]);
    expect(drawn.map(d => [d.x, d.y])).toEqual([[10, 20], [30, 40], [50, 60]]);
  });
});
