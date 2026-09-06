// UIA 只读探测封装: 调用同目录的 uia-probe.ps1(参数经 -File 命名参数传入), 解析 JSON 输出。
// 只读不写、fail-open(失败/超时 => unavailable, 由调用方放行)。
// ps1 文件保持纯 ASCII(英文注释), 规避 PS5.1 按 GBK 读无 BOM UTF-8 的编码坑。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PS1 = path.join(HERE, 'uia-probe.ps1');
const PROBE_TIMEOUT = 10000;

// 探测屏幕坐标处是否为可编辑控件。返回 { editable, kind, controlType } 或 { unavailable: true, error }
function runUiaProbe(pid, px, py) {
  return new Promise((resolve) => {
    let out = '', settled = false;
    const p = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1,
       '-TargetPid', String(pid), '-Px', String(px), '-Py', String(py)],
      { windowsHide: true });
    const finish = (r) => { if (!settled) { settled = true; resolve(r); } };
    const timer = setTimeout(() => { try { p.kill(); } catch { } finish({ editable: false, unavailable: true, error: 'probe timeout' }); }, PROBE_TIMEOUT);
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', (e) => { clearTimeout(timer); finish({ editable: false, unavailable: true, error: e.message }); });
    p.on('exit', () => {
      clearTimeout(timer);
      const line = out.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.startsWith('{')).pop();
      if (!line) return finish({ editable: false, unavailable: true, error: 'probe 无输出' });
      try { finish(JSON.parse(line)); } catch { finish({ editable: false, unavailable: true, error: 'probe 解析失败' }); }
    });
  });
}

export {
  runUiaProbe,
};
