'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = __dirname;

// ---- 本地环境配置加载(零依赖 .env 解析) ----
// 优先级: 系统环境变量 > .env 文件 > 代码内默认值。.env 已被 .gitignore 排除, 不随仓库分发。
function loadEnvFile() {
  const envFile = path.join(ROOT, '.env');
  try {
    if (!fs.existsSync(envFile)) return;
    const lines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const [, key, raw] = m;
      if (!(key in process.env)) process.env[key] = raw.replace(/^["']|["']$/g, '');
    }
  } catch { /* .env 加载失败不影响启动 */ }
}
loadEnvFile();

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT) || 13000;
const SCREENSHOTS_DIR = path.join(ROOT, 'screenshots');
const INDEX_FILE = path.join(ROOT, 'index.html');

// ---- 定位 AutoHotkey 可执行文件 ----
const AHK = (function findAhk() {
  const candidates = [
    process.env.AHK_EXE,
    'autohotkey',
    'AutoHotkey',
    'C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey.exe',
    'C:\\Program Files (x86)\\AutoHotkey\\v2\\AutoHotkey.exe',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['/ErrorStdOut'], { windowsHide: true, timeout: 5000 });
      if (r.error && r.error.code === 'ENOENT') continue;
      return c;
    } catch {
      continue;
    }
  }
  return null;
})();

// ---- 远程操控模式: 截图 + 坐标点击 ----
const CONTROL_DIR = path.join(SCREENSHOTS_DIR, 'control');
const CONTROL_IMG = path.join(CONTROL_DIR, 'control.png');
const CONTROL_META = path.join(CONTROL_DIR, 'control-meta.json');
const CONTROL_TEXT = path.join(CONTROL_DIR, 'input-text.txt'); // 文本输入: 后端写、AHK 读的临时文本文件

if (!fs.existsSync(CONTROL_DIR)) fs.mkdirSync(CONTROL_DIR, { recursive: true });

function readControlMeta() {
  try {
    let raw = fs.readFileSync(CONTROL_META, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // 去掉 AHK 写入的 UTF-8 BOM
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function controlShotState() {
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(CONTROL_IMG).mtimeMs; } catch { /* ignore */ }
  return { meta: readControlMeta(), mtimeMs, hasImage: mtimeMs > 0 };
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

const children = [];
// 运行 AHK 脚本,返回的 Promise 在脚本进程退出后 resolve
function runAhk(scriptName, args = []) {
  return new Promise((resolve) => {
    if (!AHK) { resolve(false); return; }
    const child = spawn(AHK, [path.join(ROOT, scriptName), ...args], { windowsHide: true });
    children.push(child);
    let settled = false;
    let timer = null;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const i = children.indexOf(child);
      if (i >= 0) children.splice(i, 1);
      resolve(ok);
    };
    child.on('error', () => done(false));
    child.on('exit', () => done(true));
    // 安全超时:避免脚本异常卡死导致请求永久挂起
    timer = setTimeout(() => done(true), 30000);
  });
}

// 统一的操控动作处理: 运行 AHK 脚本 -> 读取最新窗口矩形与截图 -> 返回前端所需信息
async function controlAction(res, script, args) {
  const ok = await runAhk(script, args);
  const st = controlShotState();
  const meta = st.meta || {};
  const body = {
    ok,
    ahkAvailable: !!AHK,
    message: meta.message || (ok ? '操作完成' : '操作失败'),
    rect: meta.w ? { x: meta.x, y: meta.y, w: meta.w, h: meta.h } : null,
    screenshot: st.hasImage ? { mtimeMs: st.mtimeMs } : null,
  };
  res.writeHead(ok ? 200 : 500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function serveFile(res, fp, contentType) {
  fs.readFile(fp, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    return serveFile(res, INDEX_FILE, 'text/html; charset=utf-8');
  }

  // ---- 远程操控模式(主功能) ----
  if (req.method === 'GET' && url === '/api/control/screenshot') {
    const st = controlShotState();
    if (!st.hasImage) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ error: 'no control screenshot', message: st.meta ? st.meta.message : '暂无截图' }));
    }
    return serveFile(res, CONTROL_IMG, 'image/png');
  }

  if (req.method === 'POST' && url === '/api/control/shot') {
    return controlAction(res, 'control-shot.ahk', []);
  }

  if (req.method === 'POST' && url === '/api/control/click') {
    const body = await readJsonBody(req);
    const x = Math.round(Number(body.x));
    const y = Math.round(Number(body.y));
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 99999 || y > 99999) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: 'invalid coords', message: '坐标参数无效' }));
    }
    return controlAction(res, 'control-click.ahk', [String(x), String(y)]);
  }

  if (req.method === 'POST' && url === '/api/control/input') {
    const body = await readJsonBody(req);
    const x = Math.round(Number(body.x));
    const y = Math.round(Number(body.y));
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 99999 || y > 99999) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: 'invalid coords', message: '坐标参数无效' }));
    }
    if (typeof body.text !== 'string' || !body.text.trim()) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: 'empty text', message: '请输入要发送的文本' }));
    }
    if (body.text.length > 2000) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: 'text too long', message: '文本过长(最多 2000 字符)' }));
    }
    // clear: 兼容布尔 true/false 与字符串 "1"/"0"
    const clear = body.clear === true || body.clear === '1' || body.clear === 1;
    // 文本走临时文件传递, 避免命令行参数对中文/换行/引号的转义问题
    try {
      fs.writeFileSync(CONTROL_TEXT, body.text, 'utf8'); // UTF-8 无 BOM
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, message: '写入文本文件失败: ' + e.message }));
    }
    return controlAction(res, 'control-input.ahk', [String(x), String(y), clear ? '1' : '0']);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

server.listen(PORT, HOST, () => {
  console.log('花妖操控台已启动 ->  http://' + (HOST === '0.0.0.0' ? 'localhost' : HOST) + ':' + PORT);
  if (!AHK) console.log('警告: 未检测到 AutoHotkey，截图/操控功能将不可用。');
});

function shutdown() {
  for (const c of children) { try { c.kill(); } catch { /* ignore */ } }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
