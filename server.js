'use strict';

const http = require('http');
const https = require('https');
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

// ---- 花妖程序更新(可配置, 地址可能随 CDN 变动而改) ----
// GARDEN_DOWNLOAD_URL: 完整下载地址, 其中 {v} 会被替换为目标版本号。
//   真实 CDN 地址属敏感信息, 不内置默认值, 必须由用户在 .env 中自行配置;
//   未配置时更新功能不可用(后端返回提示, 前端面板也会提示)。
// GARDEN_INSTALL_DIR:  解压/安装目录(相对 ROOT 或绝对路径), 默认 ROOT 下 hua-yao/
// GARDEN_EXE_NAME:     解压后需要启动的主程序文件名, 其中 {v} 会被替换为目标版本号
const GARDEN_DOWNLOAD_URL = (process.env.GARDEN_DOWNLOAD_URL || '').trim();
const GARDEN_INSTALL_DIR = path.resolve(ROOT, process.env.GARDEN_INSTALL_DIR || 'hua-yao');
const GARDEN_EXE_NAME = process.env.GARDEN_EXE_NAME || 'garden-v{v}-x64.exe';
const GARDEN_VERSIONS_FILE = path.join(GARDEN_INSTALL_DIR, 'version.json');
const GARDEN_LOG_FILE = path.join(GARDEN_INSTALL_DIR, 'update.log');
// 从 exe 名模板推导进程名前缀(用于匹配带版本号的运行进程): "garden-v{v}-x64.exe" -> "garden-v"
const GARDEN_PROC_PREFIX = GARDEN_EXE_NAME.split('{v}')[0].toLowerCase();

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
const CONTROL_IMG = path.join(SCREENSHOTS_DIR, 'control.png');
const CONTROL_META = path.join(SCREENSHOTS_DIR, 'control-meta.json');
const CONTROL_TEXT = path.join(SCREENSHOTS_DIR, 'input-text.txt'); // 文本输入: 后端写、AHK 读的临时文本文件

if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

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

// ===== 花妖程序更新 =====
// 版本号形如 "1.5.0"; 文件名模板中的 {v} 被替换为目标版本号
const VERSION_RE = /^\d+\.\d+\.\d+$/;
// 精确进程名兜底(不含版本号的老式命名), 带版本号的主进程走 GARDEN_PROC_PREFIX 前缀匹配
const GARDEN_PROC_NAMES = ['garden.exe', 'garden', 'hua-yao.exe', 'huayao.exe'];

// 读/写更新日志与版本信息(均落在安装目录, 已 .gitignore)
function updateLog(line) {
  try {
    fs.appendFileSync(GARDEN_LOG_FILE, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch { /* ignore */ }
  console.log('[更新] ' + line);
}
function readVersionInfo() {
  try {
    return JSON.parse(fs.readFileSync(GARDEN_VERSIONS_FILE, 'utf8'));
  } catch {
    return null;
  }
}
function writeVersionInfo(info) {
  try {
    fs.mkdirSync(GARDEN_INSTALL_DIR, { recursive: true });
    fs.writeFileSync(GARDEN_VERSIONS_FILE, JSON.stringify(info, null, 2), 'utf8');
  } catch { /* ignore */ }
}
// 从版本号推算下一个版本(末位 +1): "1.5.0" -> "1.5.1"
function nextVersion(v) {
  const m = String(v || '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

// 找出正在运行的花妖进程并结束
function killGardenProcesses() {
  const found = [];
  try {
    const r = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, encoding: 'utf8' });
    const out = r.stdout || '';
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/"([^"]+)\.exe"/i);
      if (!m) continue;
      const name = m[1].toLowerCase();
      // 精确名兜底 + 前缀匹配(覆盖 garden-v1.4.9-x64 这类带版本号的进程名)
      const isMatch = GARDEN_PROC_NAMES.includes(name) ||
        (GARDEN_PROC_PREFIX && name.startsWith(GARDEN_PROC_PREFIX));
      if (isMatch) {
        found.push(name);
        try { spawnSync('taskkill', ['/F', '/IM', `${name}.exe`], { windowsHide: true }); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  return found;
}

// 下载 URL 到本地临时文件(跟随重定向), 返回临时文件路径
function downloadToTemp(url) {
  return new Promise((resolve, reject) => {
    const tmp = path.join(ROOT, `.garden-dl-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
    const file = fs.createWriteStream(tmp);
    const req = https.get(url, { headers: { 'User-Agent': 'garden-control/1.0' } }, (res) => {
      // 重定向跟随(最多 5 次)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(tmp);
        const next = new URL(res.headers.location, url).toString();
        resolve(downloadToTemp(next));
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(tmp);
        reject(new Error(`下载失败(HTTP ${res.statusCode})`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(tmp)));
      file.on('error', (e) => { try { fs.unlinkSync(tmp); } catch {} reject(e); });
    });
    req.on('error', (e) => { try { fs.unlinkSync(tmp); } catch {} reject(e); });
    req.setTimeout(120000, () => { req.destroy(new Error('下载超时')); });
  });
}

// 解压 zip(优先系统 tar, 回退 PowerShell)
function extractZip(zipFile, destDir) {
  try {
    fs.mkdirSync(destDir, { recursive: true });
  } catch { /* ignore */ }
  // Windows 10+ 自带 tar 支持解压 zip
  const r = spawnSync('tar', ['-xf', zipFile, '-C', destDir], { windowsHide: true });
  if (r.status === 0) return true;
  // 回退: PowerShell Expand-Archive
  const ps = spawnSync('powershell', ['-NoProfile', '-Command',
    `Expand-Archive -LiteralPath '${zipFile.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`],
    { windowsHide: true });
  return ps.status === 0;
}

// 在安装目录内查找启动程序(优先按配置名精确匹配, 回退任意 .exe)
function findGardenExe(dir, ver) {
  const prefer = GARDEN_EXE_NAME.replace(/\{v\}/g, ver).toLowerCase();
  const walk = (d, depth) => {
    if (depth > 4) return null;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return null; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        const hit = walk(p, depth + 1);
        if (hit) return hit;
      } else if (e.name.toLowerCase().endsWith('.exe')) {
        if (e.name.toLowerCase() === prefer) return p;
      }
    }
    // 第二遍: 任意 .exe 兜底
    for (const e of entries) {
      if (e.isDirectory()) continue;
      if (e.name.toLowerCase().endsWith('.exe')) return path.join(d, e.name);
    }
    return null;
  };
  return walk(dir, 0);
}

// 预先添加 Windows 防火墙放行规则, 避免新版 exe 首次启动弹出"允许联网"对话框
// 需要管理员权限; 失败返回 false(由调用方提示)
function addFirewallRule(exePath) {
  const ruleName = 'Garden HuaYao';
  try {
    // 先删除同名旧规则(可能不存在, 忽略), 再分别添加入站/出站允许规则
    spawnSync('netsh', ['advfirewall', 'firewall', 'delete', 'rule', `name=${ruleName}`], { windowsHide: true });
    spawnSync('netsh', ['advfirewall', 'firewall', 'delete', 'rule', `name=${ruleName}-out`], { windowsHide: true });
    const inR = spawnSync('netsh', ['advfirewall', 'firewall', 'add', 'rule',
      `name=${ruleName}`, 'dir=in', 'action=allow', `program=${exePath}`, 'enable=yes', 'profile=any'], { windowsHide: true });
    const outR = spawnSync('netsh', ['advfirewall', 'firewall', 'add', 'rule',
      `name=${ruleName}-out`, 'dir=out', 'action=allow', `program=${exePath}`, 'enable=yes', 'profile=any'], { windowsHide: true });
    return inR.status === 0 && outR.status === 0;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 轮询等待新版花妖窗口出现(窗口标题"花妖" + 进程名前缀匹配), 超时返回 false
// 用于启动新版程序后等待其就绪, 避免前端立即刷新截图时程序还没启动完
async function waitForGardenWindow(timeoutMs = 15000) {
  // 用 [char] 拼出"花妖", 避免命令行中文编码问题
  const titleCode = '([string][char]0x82B1 + [char]0x5996)';
  const script = `$t = ${titleCode}; $p = Get-Process | Where-Object { $_.ProcessName -like '${GARDEN_PROC_PREFIX}*' -and $_.MainWindowTitle -eq $t } | Select-Object -First 1; if ($p) { Write-Output 'READY' }`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
      if ((r.stdout || '').includes('READY')) return true;
    } catch { /* ignore */ }
    await sleep(600);
  }
  return false;
}

async function performUpdate(targetVersion) {
  const steps = [];
  const log = (s) => { steps.push(s); updateLog(s); };
  const info = { lastVersion: null, currentVersion: null, lastUpdated: null, versions: [] };
  const prev = readVersionInfo();
  if (prev) Object.assign(info, prev);
  info.versions = Array.isArray(info.versions) ? info.versions : [];

  try {
    const ver = String(targetVersion || '').trim();
    if (!VERSION_RE.test(ver)) {
      return { ok: false, error: 'bad version', message: '版本号格式应为 x.y.z，例如 1.5.0' };
    }
    if (!GARDEN_DOWNLOAD_URL) {
      throw new Error('未配置下载地址，请在 .env 中设置 GARDEN_DOWNLOAD_URL（{v} 占位版本号）');
    }
    const url = GARDEN_DOWNLOAD_URL.replace(/\{v\}/g, ver);
    log(`开始更新到版本 ${ver}，下载地址: ${url}`);

    // 1) 结束正在运行的花妖
    const killed = killGardenProcesses();
    log(killed.length ? `已结束运行中的花妖进程: ${killed.join(', ')}` : '未发现运行中的花妖进程');

    // 2) 下载
    log('正在下载压缩包…');
    const zip = await downloadToTemp(url);

    // 3) 解压
    log('下载完成，正在解压…');
    const verDir = path.join(GARDEN_INSTALL_DIR, `v${ver}`);
    try { fs.rmSync(verDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (!extractZip(zip, verDir)) {
      try { fs.unlinkSync(zip); } catch {}
      throw new Error('解压失败');
    }
    try { fs.unlinkSync(zip); } catch { /* ignore */ }

    // 4) 定位并启动新版花妖
    const exe = findGardenExe(verDir, ver);
    if (!exe) throw new Error(`解压后未找到可执行文件(${GARDEN_EXE_NAME.replace(/\{v\}/g, ver)})`);
    log(`找到启动程序: ${exe}`);
    // 预先放行防火墙, 避免首次启动弹出 Windows "允许联网" 对话框
    const fw = addFirewallRule(exe);
    log(fw ? '已预添加防火墙放行规则' : '未能添加防火墙规则(服务可能需要以管理员身份运行), 若弹出联网提示请手动允许');
    const child = spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    log(`已启动新版花妖 (PID ${child.pid})`);

    // 等待新版花妖窗口就绪后再返回, 避免前端立即刷新截图时程序还没启动完
    const winReady = await waitForGardenWindow();
    if (winReady) {
      await sleep(1000); // 窗口出现后再等 1 秒, 让界面稳定
      log('新版花妖窗口已就绪');
    } else {
      log('等待新版花妖窗口超时(可稍后手动刷新画面)');
    }

    // 5) 记录版本信息
    const now = new Date().toISOString();
    if (info.currentVersion !== ver) {
      info.lastVersion = info.currentVersion; // 仅版本变化时才更新"上一版本"
    }
    info.currentVersion = ver;
    info.lastUpdated = now;
    // versions 按版本去重: 同版本重复更新只覆盖最近一次时间, 不堆叠相同记录
    const entry = { version: ver, updatedAt: now, exe };
    const idx = info.versions.findIndex(h => h.version === ver);
    if (idx >= 0) info.versions[idx] = entry;
    else info.versions.push(entry);
    writeVersionInfo(info);

    log(`更新完成: 当前版本 ${ver}`);
    return { ok: true, message: `已更新到 ${ver} 并启动`, version: ver, steps, info };
  } catch (e) {
    log(`更新失败: ${e.message}`);
    return { ok: false, error: 'update failed', message: e.message, steps };
  }
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

  // ---- 花妖程序更新 ----
  // 查看当前版本信息与下载地址配置
  if (req.method === 'GET' && url === '/api/garden/update') {
    const info = readVersionInfo() || {};
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({
      ok: true,
      currentVersion: info.currentVersion || null,
      lastVersion: info.lastVersion || null,
      lastUpdated: info.lastUpdated || null,
      versions: Array.isArray(info.versions) ? info.versions : [],
      downloadUrl: GARDEN_DOWNLOAD_URL || null,
      configured: !!GARDEN_DOWNLOAD_URL,
      installDir: GARDEN_INSTALL_DIR,
    }));
  }

  // 执行更新; body: { version } 或 { auto: true }(自动探测下一版本)
  if (req.method === 'POST' && url === '/api/garden/update') {
    const body = await readJsonBody(req);
    let target = body.version;
    if (body.auto === true || body.auto === '1' || body.auto === 1) {
      const info = readVersionInfo() || {};
      const base = info.currentVersion || info.lastVersion || '0.0.0';
      target = nextVersion(base);
      if (!target) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: 'bad version', message: '无法从当前版本推算下一版本，请手动指定版本号' }));
      }
    }
    const result = await performUpdate(target);
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(result));
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
