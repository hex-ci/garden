// 操控台服务核心: Express 应用(路由/静态资源/JSON 解析) + WS 挂载;
// 业务能力分属同级模块: capture(抓帧交互)/live(实时画面)/uia-probe(安全闸)/garden(生命周期)/updater(版本更新)/config(配置)/logger(日志)
import express from 'express';
import * as capture from './capture.js';
import { runUiaProbe } from './uia-probe.js';
import { initLive, noteActivity } from './live.js';
import {
  HOST,
  PORT,
  PUBLIC_DIR,
  GARDEN_DOWNLOAD_URL,
  GARDEN_INSTALL_DIR,
} from './config.js';
import { logControl } from './logger.js';
import {
  ensureGardenRunning,
  getGardenInstallState,
  getGardenProcesses,
  gardenMissingMessage,
  killGardenProcesses,
  nextVersion,
  readVersionInfo,
  sleep,
} from './garden.js';
import { performUpdate } from './updater.js';

const app = express();

app.use(express.json({ limit: '1mb' }));

// 所有 API 响应禁用缓存, 避免浏览器缓存接口结果
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// 抓帧到内存, 返回 { rect: {x,y,w,h}, png: Buffer }
let probeCache = { key: '', at: 0, result: null };

async function captureShot() {
  const frame = await capture.captureFrame();

  return {
    rect: {
      x: frame.origin.x,
      y: frame.origin.y,
      w: frame.width,
      h: frame.height,
    },
    png: frame.png,
  };
}

// ---- 操控 API ----
// 刷新画面: 确保花妖在运行(未安装/程序丢失返回引导标记)后抓帧
app.post('/api/control/shot', async (req, res) => {
  const ensured = await ensureGardenRunning();
  if (ensured.notInstalled) {
    return res.json({ ok: false, notInstalled: true, reason: ensured.reason, message: ensured.error });
  }
  // 刚拉起但窗口尚未就绪: 不截图, 提示稍后刷新, 避免截到未启动完的画面
  if (ensured.started && !ensured.ready) {
    return res.json({ ok: false, autoStarted: true, message: '花妖正在启动，请稍后再刷新画面' });
  }
  try {
    const ts0 = Date.now();
    const cap = await captureShot();
    logControl(`shot ok capMs=${Date.now() - ts0} rect=${cap.rect.x},${cap.rect.y} ${cap.rect.w}x${cap.rect.h}`);
    res.json({
      ok: true,
      message: '画面已刷新',
      rect: cap.rect,
      image: cap.png.toString('base64'),
      ...(ensured.started ? { autoStarted: true } : {}),
      ...(ensured.error ? { ensureError: ensured.error } : {}),
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: '截图失败: ' + e.message });
  }
});

// 重启花妖: 结束进程后重新启动当前版本(复用 killGardenProcesses + ensureGardenRunning)
app.post('/api/control/restart', async (req, res) => {
  // 未安装/程序文件丢失时无法重启: 直接返回引导标记, 不做无意义的 kill
  const preState = getGardenInstallState();
  if (!preState.installed) {
    const stillRunning = getGardenProcesses().length > 0;
    const msg = gardenMissingMessage(preState.reason) +
      (stillRunning ? '；为避免唯一运行中的实例被关闭后无法恢复，已跳过本次重启' : '');
    return res.json({ ok: false, notInstalled: true, reason: preState.reason, message: msg });
  }
  const killed = killGardenProcesses();
  await sleep(600); // 等进程退出、文件句柄释放
  const ensured = await ensureGardenRunning();
  capture.invalidate(); // 花妖重启后窗口句柄变化, 强制重新查找
  if (ensured.error) return res.status(500).json({ ok: false, message: ensured.error });
  if (ensured.started && !ensured.ready) {
    return res.json({ ok: false, message: '花妖正在启动，请稍后再刷新画面' });
  }
  res.json({
    ok: true,
    killed: killed.length,
    autoStarted: !!ensured.started,
    message: killed.length ? '花妖已重新启动' : '花妖未在运行，已启动最新版',
  });
});

// 消息点击(后台可送达)。实时模式(noimg)下跳过等待与抓帧: 秒回确认, 画面由实时突发帧呈现
app.post('/api/control/click', async (req, res) => {
  const x = Math.round(Number(req.body.x));
  const y = Math.round(Number(req.body.y));
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 99999 || y > 99999) {
    return res.status(400).json({ ok: false, error: 'invalid coords', message: '坐标参数无效' });
  }
  try {
    const t0 = Date.now();
    capture.clientClick(x, y);
    noteActivity();   // 实时画面短时突发提速
    if (req.body.noimg === true) {
      logControl(`click(${x},${y}) ok noimg total=${Date.now() - t0}ms`);
      return res.json({ ok: true, message: '已点击 (' + x + ',' + y + ')' });
    }
    await sleep(150);
    const cap = await captureShot();
    logControl(`click(${x},${y}) ok total=${Date.now() - t0}ms`);
    res.json({
      ok: true,
      message: '已点击 (' + x + ',' + y + ')',
      rect: cap.rect,
      image: cap.png.toString('base64'),
    });
  } catch (e) {
    logControl(`click(${x},${y}) FAIL ${e.message}`);
    res.status(500).json({ ok: false, message: '点击失败: ' + e.message });
  }
});

// 文本输入: 安全闸(只读探测)通过后才发消息; noimg 模式秒回, 画面由实时突发帧呈现
app.post('/api/control/input', async (req, res) => {
  const x = Math.round(Number(req.body.x));
  const y = Math.round(Number(req.body.y));
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 99999 || y > 99999) {
    return res.status(400).json({ ok: false, error: 'invalid coords', message: '坐标参数无效' });
  }
  if (typeof req.body.text !== 'string' || !req.body.text.trim()) {
    return res.status(400).json({ ok: false, error: 'empty text', message: '请输入要发送的文本' });
  }
  if (req.body.text.length > 2000) {
    return res.status(400).json({ ok: false, error: 'text too long', message: '文本过长(最多 2000 字符)' });
  }
  // clear: 兼容布尔 true/false 与字符串 "1"/"0"; clear=true 覆盖原内容, 否则追加
  const clear = req.body.clear === true || req.body.clear === '1' || req.body.clear === 1;
  try {
    const t0 = Date.now();
    // 发送前安全闸: 只读探测点击处是否为可输入框(不是则一个消息都不发, 界面零扰动)
    const w = capture.getWindow();
    if (!w) throw new Error('未找到花妖窗口');
    const origin = capture.clientOrigin(w.hwnd);
    const pid = capture.getTargetPid();
    const ck = pid + ':' + (origin.x + x) + ':' + (origin.y + y);
    const nowMs = Date.now();
    let probe;
    if (probeCache.result && probeCache.key === ck && nowMs - probeCache.at < 4000) {
      probe = probeCache.result;
    } else {
      probe = await runUiaProbe(pid, origin.x + x, origin.y + y);
      probeCache = { key: ck, at: nowMs, result: probe };
    }
    if (probe.unavailable) {
      logControl(`input(${x},${y}) probe unavailable: ${probe.error || 'unknown'} (fail-open)`);
    } else if (!probe.editable) {
      logControl(`input(${x},${y}) gate reject kind=${probe.kind} type=${probe.controlType}`);
      return res.json({ ok: false, message: '点击位置不是可输入框，未发送' });
    }
    // 纯消息文本输入(点击+END/三击全选+WM_CHAR), 后台可送达, 不抢系统焦点
    await capture.sendTextInput(x, y, req.body.text, !clear);
    noteActivity();   // 实时画面短时突发提速
    if (req.body.noimg === true) {
      logControl(`input(${x},${y}) clear=${clear} ok noimg total=${Date.now() - t0}ms`);
      return res.json({ ok: true, message: '文本已发送' + (clear ? '(已清空)' : '') });
    }
    await sleep(250);   // 让渲染器消化输入后再抓帧反馈
    const t1 = Date.now();
    const cap = await captureShot();
    logControl(`input(${x},${y}) clear=${clear} ok msg total=${Date.now() - t0}ms capMs=${Date.now() - t1}`);
    res.json({
      ok: true,
      message: '文本已发送' + (clear ? '(已清空)' : ''),
      rect: cap.rect,
      image: cap.png.toString('base64'),
    });
  } catch (e) {
    logControl(`input(${x},${y}) FAIL ${e.message}`);
    res.status(500).json({ ok: false, message: '文本输入失败: ' + e.message });
  }
});

// ---- 花妖程序更新 ----
// 查看当前版本信息与下载地址配置
app.get('/api/garden/update', (req, res) => {
  const info = readVersionInfo() || {};
  const st = getGardenInstallState();
  res.json({
    ok: true,
    currentVersion: info.currentVersion || null,
    lastVersion: info.lastVersion || null,
    lastUpdated: info.lastUpdated || null,
    versions: Array.isArray(info.versions) ? info.versions : [],
    installed: st.installed,
    installReason: st.reason,
    downloadUrl: GARDEN_DOWNLOAD_URL || null,
    configured: !!GARDEN_DOWNLOAD_URL,
    installDir: GARDEN_INSTALL_DIR,
  });
});

// 执行更新; body: { version } 或 { auto: true }(自动探测下一版本)
app.post('/api/garden/update', async (req, res) => {
  let target = req.body.version;
  if (req.body.auto === true || req.body.auto === '1' || req.body.auto === 1) {
    const info = readVersionInfo() || {};
    const base = info.currentVersion || info.lastVersion || '0.0.0';
    target = nextVersion(base);
    if (!target) {
      return res.status(400).json({ ok: false, error: 'bad version', message: '无法从当前版本推算下一版本，请手动指定版本号' });
    }
  }
  const result = await performUpdate(target);
  res.status(result.ok ? 200 : 400).json(result);
});

// ---- 前端静态资源(public/) + 404 ----
app.use(express.static(PUBLIC_DIR, { etag: false, lastModified: false, setHeaders: (res) => res.setHeader('Cache-Control', 'no-store') }));

app.use((req, res) => {
  res.status(404).type('text/plain; charset=utf-8').send('Not Found');
});

// 兜底错误处理: JSON 解析失败 / 未捕获异常
app.use((err, req, res, next) => {   // eslint-disable-line no-unused-vars
  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ ok: false, error: 'bad json', message: '请求体不是有效 JSON' });
  }
  console.error(err);
  res.status(500).json({ ok: false, message: '服务器内部错误' });
});

const server = app.listen(PORT, HOST, () => {
  console.log('花妖操控台已启动 ->  http://' + (HOST === '0.0.0.0' ? 'localhost' : HOST) + ':' + PORT);
});

// 实时画面 WebSocket(同端口, /api/live)
initLive(server, { onLog: logControl });

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
