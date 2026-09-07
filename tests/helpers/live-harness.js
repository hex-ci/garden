// 测试用最小 live 服务 + WS 客户端: 用例只关心"发什么控制消息 / 收到什么帧"。
// capture 由各用例 vi.mock, 故 live.js 必须动态 import(mock 提升后仍生效)。
import http from 'node:http';
import WebSocket from 'ws';

export async function startLive(onLog = () => {}) {
  const { initLive } = await import('../../server/live.js');
  const server = http.createServer();
  initLive(server, { onLog });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

export function connectLive(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/live`);
  const frames = [], ctls = [], waiters = { frame: [], ctl: [] };
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const b = Buffer.from(data);
      frames.push(b);
      for (const w of waiters.frame.slice()) w(b);
    } else {
      let d;
      try { d = JSON.parse(data.toString()); } catch { return; }
      ctls.push(d);
      for (const w of waiters.ctl.slice()) w(d);
    }
  });

  // 等到第一帧满足 pred 的帧/消息(先查已收到的历史, 再等新的)
  function wait(list, key, pred, ms) {
    return new Promise((res, rej) => {
      const hit = list.find(pred);
      if (hit) return res(hit);
      const t = setTimeout(() => rej(new Error(`等待 ${key} 超时`)), ms);
      waiters[key].push(v => { if (pred(v)) { clearTimeout(t); res(v); } });
    });
  }

  return {
    ws,
    ready: new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); }),
    send: (o) => ws.send(JSON.stringify(o)),
    waitFrame: (pred, ms = 6000) => wait(frames, 'frame', pred, ms),
    waitCtl: (pred, ms = 6000) => wait(ctls, 'ctl', pred, ms),
    frames, ctls,
    close: () => { try { ws.close(); } catch { /* ignore */ } },
  };
}
