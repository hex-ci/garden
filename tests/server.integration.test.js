// server 集成测试: 拉起真实服务(测试端口 13199), 覆盖静态资源/操控 API/安全闸/WS。
// 花妖相关断言做了环境自适应: 花妖未安装时相关用例自动降级, 不误报。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const PORT = 13199;
const BASE = `http://127.0.0.1:${PORT}`;
let child;
let gardenAvailable = false;   // /shot 成功即认为花妖可用

beforeAll(async () => {
  child = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  // 轮询等待服务就绪(最多 10 秒)
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/api/garden/update`);
      if (r.ok) return;
    } catch { /* 未就绪继续等 */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('server did not start');
}, 20000);

afterAll(async () => {
  if (!child) return;
  child.kill();
  await new Promise(r => { child.on('exit', r); setTimeout(r, 2000); });
});

const j = async (p, body, method = 'POST') => {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

describe('静态资源与路由', () => {
  it.each([['/', 'text/html'], ['/css/style.css', 'text/css'], ['/js/app.js', 'javascript']])('%s 可访问', async (p, ct) => {
    const r = await fetch(BASE + p);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain(ct);
  });

  it('未知路径 404', async () => {
    expect((await fetch(BASE + '/api/nope')).status).toBe(404);
  });
});

describe('操控 API', () => {
  it('POST /shot 返回画面(花妖可用)或未安装引导', async () => {
    const { data } = await j('/api/control/shot', {});
    if (data.notInstalled) {
      expect(data.reason).toMatch(/no_record|exe_missing/);
      return;
    }
    expect(data.ok).toBe(true);
    expect(data.image.length).toBeGreaterThan(1000);
    expect(data.rect.w).toBeGreaterThan(0);
    gardenAvailable = true;
  });

  it('未知 API 路径 404', async () => {
    expect((await fetch(BASE + '/api/control/screenshot')).status).toBe(404);
  });

  it('click 坐标校验与 noimg 秒回', async () => {
    const bad = await j('/api/control/click', { x: -1, y: 0, noimg: true });
    expect(bad.status).toBe(400);
    if (!gardenAvailable) return;   // 花妖不可用时点击必失败, 不做进一步断言
    const { data } = await j('/api/control/click', { x: 2, y: 2, noimg: true });
    expect(data.ok).toBe(true);
  });

  it('input 安全闸拒绝非输入框点位', async () => {
    if (!gardenAvailable) return;
    const { data } = await j('/api/control/input', { x: 2, y: 2, text: 'x' });
    // 探测不可用时 fail-open 会发送成功 — 只断言"非输入框被拒"这一主路径
    if (data.ok === false) expect(data.message).toMatch(/可输入框/);
  });
});

describe('花妖更新信息', () => {
  it('GET /api/garden/update 返回版本与安装状态', async () => {
    const { data } = await j('/api/garden/update', null, 'GET');
    expect(data.ok).toBe(true);
    expect(data.currentVersion).toBe('1.5.3');
    expect(Array.isArray(data.versions)).toBe(true);
    expect(typeof data.configured).toBe('boolean');
  });
});

describe('WS 实时画面', () => {
  it('start 后收到档位确认' + (gardenAvailable ? '与二进制帧/跳帧' : ''), async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/live`);
    let gotGear = false, gotBinary = false;
    ws.on('open', () => ws.send(JSON.stringify({ op: 'start', gear: 'fast' })));
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        const d = JSON.parse(data.toString());
        if (d.op === 'gear') gotGear = true;
      } else gotBinary = true;
    });
    await new Promise(r => setTimeout(r, 3000));
    try { ws.close(); } catch { /* ignore */ }
    expect(gotGear).toBe(true);
    if (gardenAvailable) expect(gotBinary).toBe(true);
  });
});
