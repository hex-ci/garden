#Requires AutoHotkey v2.0
#SingleInstance Off

; 远程操控模式: 按截图坐标向花妖窗口投递消息点击(后台点击), 点击后自动重新截图形成反馈闭环
; 用法: control-click.ahk <sx> <sy>
;   sx/sy 为截图像素坐标, 原点 = 窗口左上角(即 screenshots\control.png 内的坐标)
;   脚本把截图坐标(窗口矩形系)换算为窗口客户区坐标后, 用 ControlClick(NA) 投递点击消息:
;   不移动真实鼠标、不要求窗口在前台, 远程桌面最小化/窗口被遮挡时也能正常点击(2026-09-05 实测)
#Include garden-lib.ahk

DryRun := false
SetTitleMatchMode(3)

WinTitle := "花妖"
LogFileName := "garden-control-click.log"

sx := 0
sy := 0
try {
    sx := Integer(A_Args[1])
    sy := Integer(A_Args[2])
} catch {
    WriteControlMeta(0, 0, 0, 0, false, "点击参数无效")
    ExitApp(2)
}

prevHwnd := WinExist("A")

EnsureScreenshotDir()
ResetLog()
LogMsg("=== 操控点击脚本开始: 截图坐标 (" sx "," sy ") ===")

; 确保花妖窗口可见(处理托盘隐藏/最小化, 失败给出友好提示不中断)
; 后台消息点击无需激活窗口, activate=false 避免抢焦点
if !EnsureHuaYaoWindow(&wx, &wy, &ww, &wh, &errMsg, false) {
    WriteControlMeta(0, 0, 0, 0, false, errMsg)
    RestorePrevWindow(prevHwnd)
    ExitApp(2)
}
hwnd := WinExist(WinTitle)

; 截图坐标基于窗口矩形(含标题栏), 消息点击坐标基于窗口客户区: 先算客户区原点偏移
DllCall("GetClientRect", "ptr", hwnd, "ptr", rc := Buffer(16))
pt := Buffer(8)
NumPut("int", 0, "int", 0, pt, 0)
DllCall("ClientToScreen", "ptr", hwnd, "ptr", pt)
offX := NumGet(pt, 0, "int") - wx
offY := NumGet(pt, 4, "int") - wy

ccx := sx - offX
ccy := sy - offY
LogMsg("客户区坐标: " ccx "," ccy " (客户区偏移 " offX "," offY ")")

; 后台消息点击(ControlClick NA): 直接向窗口投递点击消息, 不移动真实鼠标、不依赖窗口前台。
; 模拟真实鼠标(SendInput)在远程桌面最小化时会失效, 消息点击不受影响(2026-09-05 实测验证)。
ControlClick("X" ccx " Y" ccy, hwnd, , "Left", 1, "NA")
LogMsg("已点击 (" sx "," sy ")")

; 给程序响应留出时间, 再截图反馈, 形成"所见即所得"闭环
Sleep(400)
if !EnsureHuaYaoWindow(&wx, &wy, &ww, &wh, &errMsg, false) {
    WriteControlMeta(0, 0, 0, 0, false, errMsg)
    RestorePrevWindow(prevHwnd)
    ExitApp(2)
}
if SaveControlScreenshot(wx, wy, ww, wh)
    WriteControlMeta(wx, wy, ww, wh, true, "已点击 (" sx "," sy ")")
else
    WriteControlMeta(wx, wy, ww, wh, false, "反馈截图失败")

RestorePrevWindow(prevHwnd)
ExitApp 0
