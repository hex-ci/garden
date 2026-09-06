// 花妖版本更新流水线: 下载 → 校验 → 解压 → 定位 → 切换 → 防火墙 → 启动 → 记录版本
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { spawn, spawnSync } from 'node:child_process';
import yauzl from 'yauzl';
import { GARDEN_DOWNLOAD_URL, GARDEN_EXE_NAME, GARDEN_INSTALL_DIR, GARDEN_LOG_FILE, ROOT } from './config.js';
import { getRunningGardenExe, killGardenProcesses, localTimestamp, parseVersion, readVersionInfo, sleep, versionCompare, waitForGardenWindow, writeVersionInfo } from './garden.js';

// 版本号形如 "1.5.0"; 文件名模板中的 {v} 被替换为目标版本号
const VERSION_RE = /^\d+\.\d+\.\d+$/;

// 更新日志(落在安装目录, 已 gitignore)
function updateLog(line) {
  try {
    fs.appendFileSync(GARDEN_LOG_FILE, `[${localTimestamp()}] ${line}\n`, 'utf8');
  } catch { /* ignore */ }
  console.log('[更新] ' + line);
}

// 校验 zip 文件头魔数, 避免下载到错误页面/损坏文件后盲目解压
function isValidZip(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    const sig = buf.readUInt32LE(0);
    // PK\x03\x04 本地文件头 / PK\x05\x06 空包 EOCD / PK\x01\x02 中心目录
    return sig === 0x04034B50 || sig === 0x06054B50 || sig === 0x02014B50;
  } catch {
    return false;
  }
}

// 下载 URL 到本地临时文件(跟随重定向), 返回临时文件路径
function downloadToTemp(url) {
  return new Promise((resolve, reject) => {
    const tmp = path.join(ROOT, `.garden-dl-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
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

// 解压 zip(纯 Node 实现, 基于 yauzl, 不依赖系统 tar/powershell)
// 使用 lazyEntries + 逐条处理, 正确解析含 data-descriptor 的 zip, 失败/损坏返回 false
function extractZip(zipFile, destDir) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
    try { fs.mkdirSync(destDir, { recursive: true }); } catch { /* ignore */ }
    yauzl.open(zipFile, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
      if (err || !zipfile) { finish(false); return; }
      zipfile.on('error', () => finish(false));
      zipfile.on('end', () => finish(true));
      zipfile.on('entry', (entry) => {
        const target = path.join(destDir, entry.fileName);
        if (entry.fileName.endsWith('/')) {
          try { fs.mkdirSync(target, { recursive: true }); } catch { /* ignore */ }
          zipfile.readEntry();
          return;
        }
        try { fs.mkdirSync(path.dirname(target), { recursive: true }); } catch { /* ignore */ }
        zipfile.openReadStream(entry, (err2, stream) => {
          if (err2 || !stream) { finish(false); return; }
          const ws = fs.createWriteStream(target);
          stream.on('error', () => finish(false));
          ws.on('error', () => finish(false));
          ws.on('finish', () => zipfile.readEntry());
          stream.pipe(ws);
        });
      });
      zipfile.readEntry();
    });
  });
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
export function addFirewallRule(exePath) {
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

// 执行更新: 完整流水线。任一准备步骤失败都不影响运行中的花妖; 切换阶段失败尝试恢复旧版。
// 返回 { ok, message, version?, steps, info? } 或 { ok:false, error, message, steps }
export async function performUpdate(targetVersion) {
  const steps = [];
  const log = (s) => { steps.push(s); updateLog(s); };
  const info = { lastVersion: null, currentVersion: null, lastUpdated: null, versions: [] };
  const prev = readVersionInfo();
  if (prev) Object.assign(info, prev);
  info.versions = Array.isArray(info.versions) ? info.versions : [];
  // 记录旧版 exe(kill 之前先探测运行中的 + 版本记录里的), 更新失败时用于恢复
  const runningExe = getRunningGardenExe();
  const oldExe = ((info.versions.find(v => v.version === info.currentVersion)) || {}).exe || null;
  const backupExe = runningExe || oldExe;
  let oldKilled = false;
  let zipFile = null; // 下载临时文件(无论成功/失败, finally 兜底清理)
  let tmpDir = null;  // 解压临时目录(同上)

  try {
    const ver = String(targetVersion || '').trim();
    if (!VERSION_RE.test(ver)) {
      return { ok: false, error: 'bad version', message: '版本号格式应为 x.y.z，例如 1.5.0' };
    }
    // 禁止降级: 花妖是游戏辅助工具, 旧版本可能已被游戏限制, 没有回退意义, 一律不允许降级
    if (info.currentVersion && versionCompare(parseVersion(ver), parseVersion(info.currentVersion)) < 0) {
      return { ok: false, error: 'downgrade blocked',
        message: `不允许降级: 当前版本 ${info.currentVersion}，目标 ${ver} 是更低版本` };
    }
    if (!GARDEN_DOWNLOAD_URL) {
      throw new Error('未配置下载地址，请在 .env 中设置 GARDEN_DOWNLOAD_URL（{v} 占位版本号）');
    }
    const url = GARDEN_DOWNLOAD_URL.replace(/\{v\}/g, ver);
    log(`开始更新到版本 ${ver}，下载地址: ${url}`);

    // ---- 先完成所有可能失败的准备步骤(下载/校验/解压/定位), 全部成功后才动运行中的花妖 ----
    // 1) 下载 + 校验
    log('正在下载压缩包…');
    zipFile = await downloadToTemp(url);
    const zip = zipFile;
    let zipSize = 0;
    try { zipSize = fs.statSync(zip).size; } catch { /* ignore */ }
    if (zipSize <= 0) throw new Error('下载内容为空');
    if (!isValidZip(zip)) throw new Error('下载的文件不是有效的 zip 压缩包(可能是版本号错误或文件损坏)');

    // 2) 解压到临时目录(不能直接解压到正式目录: 同版本更新时旧 exe 正被运行进程占用会写入失败)
    log(`下载完成(${Math.round(zipSize / 1024)} KB)，正在解压…`);
    const verDir = path.join(GARDEN_INSTALL_DIR, `v${ver}`);
    tmpDir = path.join(GARDEN_INSTALL_DIR, `.tmp-${ver}-${Date.now()}`);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    const extracted = await extractZip(zip, tmpDir);
    try { fs.unlinkSync(zip); } catch { /* ignore */ }
    if (!extracted) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      throw new Error('解压失败(压缩包可能已损坏)');
    }

    // 3) 定位新版主程序(解压产物校验), 找不到说明包内容不对
    const tmpExe = findGardenExe(tmpDir, ver);
    if (!tmpExe) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      throw new Error(`解压后未找到可执行文件(${GARDEN_EXE_NAME.replace(/\{v\}/g, ver)})`);
    }
    log(`新版程序就绪: ${tmpExe}`);

    // ---- 准备就绪, 开始切换 ----
    // 4) 结束正在运行的花妖(释放旧 exe 文件占用)
    const killed = killGardenProcesses();
    oldKilled = true;
    log(killed.length ? `已结束运行中的花妖进程: ${killed.join(', ')}` : '未发现运行中的花妖进程');
    await sleep(500); // 等进程完全退出、文件句柄释放

    // 5) 把临时目录移入正式版本目录(此时旧目录可安全删除)
    try { fs.rmSync(verDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.renameSync(tmpDir, verDir); } catch (e) {
      throw new Error('安装目录移动失败: ' + e.message, { cause: e });
    }
    const exe = path.join(verDir, path.relative(tmpDir, tmpExe));
    log(`已安装到: ${exe}`);

    // 6) 预先放行防火墙, 避免首次启动弹出 Windows "允许联网" 对话框
    const fw = addFirewallRule(exe);
    log(fw ? '已预添加防火墙放行规则' : '未能添加防火墙规则(服务可能需要以管理员身份运行), 若弹出联网提示请手动允许');

    // 7) 启动新版
    const child = spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    log(`已启动新版花妖 (PID ${child.pid})`);

    // 8) 等待新版花妖窗口就绪后再返回, 避免前端立即刷新截图时程序还没启动完
    const winReady = await waitForGardenWindow();
    if (winReady) {
      await sleep(1000); // 窗口出现后再等 1 秒, 让界面稳定
      log('新版花妖窗口已就绪');
    } else {
      log('等待新版花妖窗口超时(可稍后手动刷新画面)');
    }

    // 9) 记录版本信息
    const now = localTimestamp(); // 本地时区(东八区)时间, 与日志一致
    // 区分动作语义: 首次安装 / 同版本重装(程序丢失后恢复) / 日常更新
    const verAction = !info.currentVersion ? '已安装'
      : (info.currentVersion === ver ? '已重新安装' : '已更新到');
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
    return { ok: true, message: `${verAction} ${ver} 并启动`, version: ver, steps, info };
  } catch (e) {
    log(`更新失败: ${e.message}`);
    // 兜底: 若旧版已被结束但更新中途失败, 尝试恢复旧版, 避免操控台失联
    if (oldKilled && backupExe && fs.existsSync(backupExe)) {
      try {
        const rc = spawn(backupExe, [], { cwd: path.dirname(backupExe), detached: true, stdio: 'ignore', windowsHide: false });
        rc.unref();
        log(`已尝试恢复旧版花妖: ${backupExe}`);
      } catch { /* ignore */ }
    }
    return { ok: false, error: 'update failed', message: e.message, steps };
  } finally {
    // 兜底清理: 无论成功/失败/异常, 确保下载临时文件与解压临时目录都被清除
    if (zipFile) { try { fs.unlinkSync(zipFile); } catch { /* ignore */ } }
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
}
