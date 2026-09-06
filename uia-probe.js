// UIA 只读探测 (PowerShell 路线): 判断屏幕坐标处是否为花妖的可输入控件。
// 只做只读 UIA 查询, 不发送任何窗口消息, 对界面零扰动。
// 通过 EncodedCommand 投递 (UTF-16LE), 不落盘, 无编码坑, 零外部依赖 (系统自带 PowerShell + .NET UIA)。
import { spawn } from 'node:child_process';

// 生成探测脚本 (PowerShell 源码), pid 为花妖进程号, px/py 为屏幕物理坐标
function buildProbeScript(pid, px, py) {
  return `
$ErrorActionPreference = 'Stop'
try {
  try {
    Add-Type -TypeDefinition 'using System.Runtime.InteropServices;public class DPI{[DllImport("user32.dll")]public static extern bool SetProcessDPIAware();}'
    [DPI]::SetProcessDPIAware() | Out-Null
  } catch {}
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase

  $pid2 = [int]${pid}
  $px = [double]${px}
  $py = [double]${py}
  $root = [System.Windows.Automation.AutomationElement]::RootElement

  # 按进程定位顶层窗口 (取有名字的那个; 重试)
  $win = $null
  for ($i = 0; $i -lt 5 -and -not $win; $i++) {
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $pid2)
    $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
    foreach ($w in $wins) { if ($w.Current.Name) { $win = $w; break } }
    if (-not $win) { Start-Sleep -Milliseconds 300 }
  }
  if (-not $win) { throw 'window not found' }

  # WebView2 渲染进程的元素 PID 报的是 msedgewebview2, 一并放行
  $wvPids = @{}
  try { Get-Process msedgewebview2 -ErrorAction Stop | ForEach-Object { $wvPids[[int]$_.Id] = $true } } catch {}

  # FromPoint 快路径: 命中测试直达最深元素 (被其他窗口遮挡时会命中别的窗口, 需过滤)
  $el = $null
  try {
    $pt = New-Object System.Windows.Point($px, $py)
    $e = [System.Windows.Automation.AutomationElement]::FromPoint($pt)
    if ($e) {
      $epid = [int]$e.Current.ProcessId
      if ($epid -eq $pid2 -or $wvPids.ContainsKey($epid)) { $el = $e }
    }
  } catch {}

  # 全树"包含点且面积最小"搜索兜底
  if (-not $el) {
    for ($i = 0; $i -lt 5; $i++) {
      $all = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
      $best = [double]::MaxValue
      foreach ($e in $all) {
        $r = $e.Current.BoundingRectangle
        if ($r.Width -le 0 -or $r.Height -le 0) { continue }
        if ($px -ge $r.X -and $px -lt $r.X + $r.Width -and $py -ge $r.Y -and $py -lt $r.Y + $r.Height) {
          $a = $r.Width * $r.Height
          if ($a -lt $best) { $best = $a; $el = $e }
        }
      }
      if ($el) { break }
      Start-Sleep -Milliseconds 200
    }
  }
  if (-not $el) { @{ editable = $false; kind = ''; controlType = ''; outside = $true } | ConvertTo-Json -Compress; exit }

  # 向上找可写 Value/Range 模式; 控件类型限定 编辑(50004)/组合框(50003)/微调(50016)/文档(50030),
  # 排除"切换"等自带可写 Value 空值的非输入控件
  $kind = ''
  $ctName = ''
  $e2 = $el
  for ($d = 0; $d -le 15 -and $e2; $d++) {
    $ct = $e2.Current.ControlType
    $ctName = $ct.ProgrammaticName
    if ($ct.Id -in 50004, 50003, 50016, 50030) {
      try {
        $v = [System.Windows.Automation.ValuePattern]$e2.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        if (-not $v.Current.IsReadOnly) { $kind = 'text'; break }
      } catch {}
      try {
        $r2 = [System.Windows.Automation.RangeValuePattern]$e2.GetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern)
        if (-not $r2.Current.IsReadOnly) { $kind = 'number'; break }
      } catch {}
    }
    $e2 = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($e2)
  }
  @{ editable = ($kind -ne ''); kind = $kind; controlType = $ctName } | ConvertTo-Json -Compress
} catch {
  @{ editable = $false; unavailable = $true; error = $_.Exception.Message } | ConvertTo-Json -Compress
}`;
}

// 探测屏幕坐标处是否为可编辑控件。返回 { editable, kind, controlType } 或 { unavailable: true, error }
function runUiaProbe(pid, px, py) {
  return new Promise((resolve) => {
    const b64 = Buffer.from(buildProbeScript(pid, px, py), 'utf16le').toString('base64');
    let out = '', settled = false;
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64], { windowsHide: true });
    const finish = (r) => { if (!settled) { settled = true; resolve(r); } };
    const timer = setTimeout(() => { try { p.kill(); } catch { } finish({ editable: false, unavailable: true, error: 'probe timeout' }); }, 10000);
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
  buildProbeScript,
  runUiaProbe,
};
