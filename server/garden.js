// 花妖进程与生命周期: 进程检测/结束/自动拉起/安装状态判定/版本记录(version.json 读写)
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { GARDEN_INSTALL_DIR, GARDEN_PROC_PREFIX, GARDEN_VERSIONS_FILE } from './config.js';

// 精确进程名兜底(不含版本号的老式命名), 带版本号的主进程走 GARDEN_PROC_PREFIX 前缀匹配
const GARDEN_PROC_NAMES = ['garden.exe', 'garden', 'hua-yao.exe', 'huayao.exe'];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 系统本地时间戳(跟随系统时区, 中国环境即东八区), 格式 YYYY-MM-DD HH:MM:SS
// 用于更新日志与版本信息, 避免 toISOString() 输出 UTC 导致显示时间不对
export function localTimestamp(d) {
  const dt = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}:${p(dt.getSeconds())}`;
}

export function readVersionInfo() {
  try {
    return JSON.parse(fs.readFileSync(GARDEN_VERSIONS_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export function writeVersionInfo(info) {
  try {
    fs.mkdirSync(GARDEN_INSTALL_DIR, { recursive: true });
    fs.writeFileSync(GARDEN_VERSIONS_FILE, JSON.stringify(info, null, 2), 'utf8');
  } catch { /* ignore */ }
}

// 从版本号推算下一个版本(末位 +1): "1.5.0" -> "1.5.1"
export function nextVersion(v) {
  const m = String(v || '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

// 解析版本号为 {major, minor, patch}, 非法返回 null
export function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v || ''));
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : null;
}

// 比较两个解析后的版本: a<b => -1, a>b => 1, 相等 => 0
export function versionCompare(a, b) {
  if (!a || !b) return 0;
  for (const k of ['major', 'minor', 'patch']) {
    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  }
  return 0;
}

// 找出正在运行的花妖进程并结束
export function killGardenProcesses() {
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

// 获取所有正在运行的花妖 exe 完整路径(普通权限下可读取同用户进程的 Path)
export function getGardenProcesses() {
  const list = [];
  try {
    const script = `Get-Process | Where-Object { $_.ProcessName -like '${GARDEN_PROC_PREFIX}*' } | ForEach-Object { $_.Path }`;
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
    for (const line of (r.stdout || '').split(/\r?\n/)) {
      const p = line.trim();
      if (p && fs.existsSync(p)) list.push(p);
    }
  } catch { /* ignore */ }
  return list;
}

// 获取第一个正在运行的花妖 exe 完整路径(用于更新失败时恢复旧版), 无则返回 null
export function getRunningGardenExe() {
  const list = getGardenProcesses();
  return list.length ? list[0] : null;
}

// 判定花妖安装状态(依据 version.json 记录 + 当前版本 exe 文件是否真实存在)
// reason: 'ok' = 已安装可用; 'no_record' = 从未通过操控台安装过; 'exe_missing' = 有记录但程序文件已丢失
export function getGardenInstallState() {
  const info = readVersionInfo();
  if (!info || !info.currentVersion) return { installed: false, reason: 'no_record', info: null, exe: null };
  const verEntry = (info.versions || []).find(v => v.version === info.currentVersion);
  const exe = (verEntry && verEntry.exe) || null;
  if (!exe || !fs.existsSync(exe)) return { installed: false, reason: 'exe_missing', info, exe };
  return { installed: true, reason: 'ok', info, exe };
}

// 未安装/程序丢失时的用户可读提示
export function gardenMissingMessage(reason) {
  return reason === 'exe_missing'
    ? '花妖程序文件已丢失（可能被移动或杀毒软件误删），请重新下载安装'
    : '花妖尚未安装，请先下载安装花妖程序';
}

// 确保花妖在运行: 进程已存在则不动; 不存在且有已安装版本则自动启动
// 带服务端锁防止并发触发重复启动(进程检测是主防线)
let gardenEnsureLock = false;

// 确保花妖在运行并等待就绪: 仅当"当前版本"对应的进程在运行时才算就绪; 没运行或运行的是
// 其他(旧)版本时, 一律结束旧进程并启动当前版本, 保证操控的始终是最新版。带锁防并发重复启动。
export async function ensureGardenRunning() {
  if (gardenEnsureLock) return { started: false, running: true, locked: true };
  gardenEnsureLock = true;
  try {
    const st = getGardenInstallState();
    if (!st.installed) {
      // 记录缺失/程序文件丢失时, 花妖进程可能仍在运行(如文件被删后进程尚未退出):
      // 此时程序实际可用, 放行截图等操作(degraded 降级模式), 只是无法自动拉起新进程
      const running = getGardenProcesses();
      if (running.length) return { started: false, running: true, degraded: true };
      return {
        started: false, running: false,
        notInstalled: true, reason: st.reason,
        error: gardenMissingMessage(st.reason),
      };
    }
    const exe = st.exe;

    // 按完整 exe 路径精确判断当前版本是否在运行(而非只看进程名前缀, 避免误认旧版本进程)
    const norm = (p) => path.resolve(p).toLowerCase();
    const running = getGardenProcesses();
    if (running.some(p => norm(p) === norm(exe))) return { started: false, running: true, exe };

    // 运行的是其他(旧)版本 -> 先结束, 确保只启动当前(最新)版本
    if (running.length) {
      killGardenProcesses();
      await sleep(500);
    }

    const child = spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    // 等待窗口就绪(最多 30 秒), 就绪后再等 1 秒让界面稳定, 避免截到启动到一半的画面
    const ready = await waitForGardenWindow(30000);
    if (ready) await sleep(1000);
    return { started: true, running: ready, ready, exe };
  } finally {
    gardenEnsureLock = false;
  }
}

// 轮询等待花妖窗口出现(窗口标题"花妖" + 进程名前缀匹配), 超时返回 false
// 用于启动新版程序后等待其就绪, 避免前端立即刷新截图时程序还没启动完
export async function waitForGardenWindow(timeoutMs = 15000) {
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
