#Requires AutoHotkey v2.0
#SingleInstance Off

; 远程操控模式: 按截图坐标点击花妖窗口, 点击后自动重新截图形成反馈闭环
; 用法: control-click.ahk <sx> <sy>
;   sx/sy 为截图像素坐标, 原点 = 窗口左上角(即 screenshots\control\control.png 内的坐标)
;   脚本会重新读取窗口矩形, 把截图坐标映射为屏幕坐标后执行点击
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

CoordMode("Mouse", "Screen")
SetMouseDelay(30)

prevHwnd := WinExist("A")

EnsureScreenshotDir()
ResetLog()
LogMsg("=== 操控点击脚本开始: 截图坐标 (" sx "," sy ") ===")

; 确保花妖窗口可见并激活(处理最小化到托盘/最小化, 失败给出友好提示不中断)
if !EnsureHuaYaoWindow(&wx, &wy, &ww, &wh, &errMsg) {
    WriteControlMeta(0, 0, 0, 0, false, errMsg)
    RestorePrevWindow(prevHwnd)
    ExitApp(2)
}

cx := wx + sx
cy := wy + sy
LogMsg("屏幕坐标: " cx "," cy)

; 模拟真实鼠标点击: 移动 -> 按下 -> 抬起
MouseMove(cx, cy)
Sleep(50)
Click(cx, cy)
LogMsg("已点击 (" cx "," cy ")")

; 给程序响应留出时间, 再截图反馈, 形成"所见即所得"闭环
Sleep(400)
if !EnsureHuaYaoWindow(&wx, &wy, &ww, &wh, &errMsg) {
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
