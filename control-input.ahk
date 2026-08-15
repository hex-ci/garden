#Requires AutoHotkey v2.0
#SingleInstance Off

; 远程操控模式: 向花妖窗口的输入框输入文本
; 用法: control-input.ahk <sx> <sy> <clear>
;   sx/sy 为截图像素坐标(目标输入框位置), 原点 = 窗口左上角(即 screenshots\control.png 内的坐标)
;   clear=1 先 Ctrl+A 全选再粘贴(覆盖原内容); clear=0 定位到文本末尾追加
;   待输入文本从 screenshots\input-text.txt 读取(UTF-8 无 BOM, 由后端写入)
#Include garden-lib.ahk

DryRun := false
SetTitleMatchMode(3)

WinTitle := "花妖"
LogFileName := "garden-control-input.log"

sx := 0
sy := 0
clear := false
try {
    sx := Integer(A_Args[1])
    sy := Integer(A_Args[2])
    clear := (A_Args[3] = "1")
} catch {
    WriteControlMeta(0, 0, 0, 0, false, "输入参数无效")
    ExitApp(2)
}

CoordMode("Mouse", "Screen")
SetMouseDelay(30)

prevHwnd := WinExist("A")

EnsureScreenshotDir()
ResetLog()
LogMsg("=== 操控输入脚本开始: 截图坐标 (" sx "," sy ") clear=" (clear ? 1 : 0) " ===")

; 确保花妖窗口可见并激活(处理最小化到托盘/最小化, 失败给出友好提示不中断)
if !EnsureHuaYaoWindow(&wx, &wy, &ww, &wh, &errMsg) {
    WriteControlMeta(0, 0, 0, 0, false, errMsg)
    RestorePrevWindow(prevHwnd)
    ExitApp(2)
}

; 读取待输入文本(后端通过临时文件传递, 避免命令行转义问题, 支持任意字符)
textFile := A_ScriptDir "\screenshots\input-text.txt"
if !FileExist(textFile) {
    WriteControlMeta(0, 0, 0, 0, false, "找不到文本文件")
    ExitApp(2)
}
text := FileRead(textFile, "UTF-8")
if text = "" {
    WriteControlMeta(0, 0, 0, 0, false, "文本为空")
    ExitApp(2)
}
LogMsg("待输入文本长度: " StrLen(text))

; 重新点击目标坐标, 确保目标输入框获得焦点(兜底用户中途切换焦点)
cx := wx + sx
cy := wy + sy
LogMsg("屏幕坐标: " cx "," cy)
MouseMove(cx, cy)
Sleep(50)
Click(cx, cy)
Sleep(250)
LogMsg("已点击 (" cx "," cy ") 确保焦点")

; 输入文本: 写入剪贴板后 Ctrl+V 粘贴, 对中文/特殊字符最可靠
try {
    A_Clipboard := text
    Sleep(80)
    if clear {
        Send("^a")        ; 全选 -> 粘贴覆盖原内容
        Sleep(60)
    } else {
        Send("^{End}")    ; 定位到整个文本末尾 -> 粘贴追加
        Sleep(60)
    }
    Send("^v")
    LogMsg("已输入 " StrLen(text) " 字符 (" (clear ? "清空" : "追加") ")")
} catch as err {
    WriteControlMeta(0, 0, 0, 0, false, "文本输入失败: " err.Message)
    RestorePrevWindow(prevHwnd)
    ExitApp(2)
}

; 给程序响应留出时间, 再截图反馈, 形成"所见即所得"闭环
Sleep(400)
if !EnsureHuaYaoWindow(&wx, &wy, &ww, &wh, &errMsg) {
    WriteControlMeta(0, 0, 0, 0, false, errMsg)
    RestorePrevWindow(prevHwnd)
    ExitApp(2)
}
if SaveControlScreenshot(wx, wy, ww, wh)
    WriteControlMeta(wx, wy, ww, wh, true, "已输入文本 (" sx "," sy ")" (clear ? " [清空]" : " [追加]"))
else
    WriteControlMeta(wx, wy, ww, wh, false, "反馈截图失败")

RestorePrevWindow(prevHwnd)
ExitApp 0
