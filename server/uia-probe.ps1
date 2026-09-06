# UIA 只读探测: 判断屏幕坐标 (Px, Py) 处是否为目标窗口的可编辑控件。
# 只读 UIA 查询, 不发送任何窗口消息, 对界面零扰动。
#
# 用法:
#   powershell -NoProfile -ExecutionPolicy Bypass -File uia-probe.ps1 -TargetPid 9688 -Px 978 -Py 415
#
# 输出(stdout 单行 JSON):
#   可编辑字段 : {"editable":true,"kind":"text"|"number","controlType":"ControlType.X"}
#   不可编辑   : {"editable":false,"kind":"","controlType":"..."}
#   失败       : {"editable":false,"unavailable":true,"error":"..."}
#
# 重要: 本文件必须保存为带 BOM 的 UTF-8。
# PS 5.1 会把无 BOM 的 UTF-8 按 GBK 解析, 中文乱码可吞引号导致静默解析失败。

param(
  [int]$TargetPid,
  [double]$Px,
  [double]$Py
)

$ErrorActionPreference = 'Stop'

try {
  # 重定向 stdout 用 UTF-8, 保证 Node 侧 JSON 解析稳定
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8

  try {
    Add-Type -TypeDefinition 'using System.Runtime.InteropServices;public class DPI{[DllImport("user32.dll")]public static extern bool SetProcessDPIAware();}'
    [DPI]::SetProcessDPIAware() | Out-Null
  } catch {}

  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase

  $root = [System.Windows.Automation.AutomationElement]::RootElement

  # 按进程定位顶层窗口(取有名字的那个; 重试)
  $win = $null

  for ($i = 0; $i -lt 5 -and -not $win; $i++) {
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $TargetPid)
    $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
    foreach ($w in $wins) { if ($w.Current.Name) { $win = $w; break } }
    if (-not $win) { Start-Sleep -Milliseconds 300 }
  }

  if (-not $win) { throw 'window not found' }

  # WebView2 渲染元素的 PID 报的是 msedgewebview2, 一并放行
  $wvPids = @{}

  try { Get-Process msedgewebview2 -ErrorAction Stop | ForEach-Object { $wvPids[[int]$_.Id] = $true } } catch {}

  # 快路径: FromPoint 命中测试直达最深元素(可能命中遮挡窗口, 按 PID 过滤)
  $el = $null

  try {
    $pt = New-Object System.Windows.Point($Px, $Py)
    $e = [System.Windows.Automation.AutomationElement]::FromPoint($pt)
    if ($e) {
      $epid = [int]$e.Current.ProcessId
      if ($epid -eq $TargetPid -or $wvPids.ContainsKey($epid)) { $el = $e }
    }
  } catch {}

  # 兜底: 全树"包含点且面积最小"搜索
  if (-not $el) {
    for ($i = 0; $i -lt 5; $i++) {
      $all = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
      $best = [double]::MaxValue

      foreach ($e in $all) {
        $r = $e.Current.BoundingRectangle
        if ($r.Width -le 0 -or $r.Height -le 0) { continue }
        if ($Px -ge $r.X -and $Px -lt $r.X + $r.Width -and $Py -ge $r.Y -and $Py -lt $r.Y + $r.Height) {
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
  # 排除"切换"等自带可写空 Value 的非输入控件
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
}
