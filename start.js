'use strict';

// 花妖操控台启动器
// 在 Windows 下检测是否已具备管理员权限：若没有，弹 UAC 提权后以管理员身份重新启动。
// 原因：更新花妖时需要写入防火墙放行规则(netsh advfirewall)，否则新版花妖首次启动
// 会弹出 Windows"允许联网"对话框，干扰操控台的正常逻辑。

const { spawn, spawnSync } = require('child_process');

function isElevated() {
  try {
    const r = spawnSync('net', ['session'], { windowsHide: true });
    return r.status === 0;
  } catch {
    return false;
  }
}

function q(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

if (isElevated() || process.platform !== 'win32') {
  // 已是管理员(或非 Windows 无 UAC 概念)：直接加载服务
  require('./server.js');
} else {
  console.log('正在请求管理员权限（用于写入防火墙放行规则）…');
  const ps = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `Start-Process -FilePath ${q(process.execPath)} -ArgumentList ${q(__filename)} -WorkingDirectory ${q(__dirname)} -Verb RunAs`],
    { stdio: 'inherit', windowsHide: false });
  ps.on('error', () => {
    console.error('无法弹出提权窗口，请手动右键「以管理员身份运行」命令窗口后再 npm start。');
    process.exit(1);
  });
  ps.on('exit', (code) => process.exit(code == null ? 0 : code));
}
