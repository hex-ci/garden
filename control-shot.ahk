#Requires AutoHotkey v2.0
#SingleInstance Off

; 远程操控模式: 把花妖窗口置于前台并截图
; 输出: screenshots\control\control.png + screenshots\control\control-meta.json(窗口矩形)
; 供网页操控界面显示画面并映射点击坐标
#Include garden-lib.ahk

DryRun := false
SetTitleMatchMode(3)

WinTitle := "花妖"
LogFileName := "garden-control-shot.log"

CoordMode("Mouse", "Screen")

; 记住操作前的窗口,截图结束后恢复焦点,减少对网页操作的打扰
prevHwnd := WinExist("A")

EnsureScreenshotDir()
ResetLog()
LogMsg("=== 操控截图脚本开始 ===")

; 确保花妖窗口可见并激活(处理最小化到托盘/最小化, 失败给出友好提示不中断)
if !EnsureHuaYaoWindow(&wx, &wy, &ww, &wh, &errMsg) {
    WriteControlMeta(0, 0, 0, 0, false, errMsg)
    LogMsg("窗口不可用: " errMsg)
    RestorePrevWindow(prevHwnd)
    ExitApp(2)
}
LogMsg("窗口位置: " wx "," wy "  尺寸: " ww "x" wh)

if !SaveControlScreenshot(wx, wy, ww, wh) {
    WriteControlMeta(wx, wy, ww, wh, false, "截图失败")
    RestorePrevWindow(prevHwnd)
    ExitApp(2)
}

WriteControlMeta(wx, wy, ww, wh, true, "画面已刷新")
LogMsg("截图成功")
RestorePrevWindow(prevHwnd)
ExitApp 0
