; HuaYaoLib.ahk
; 花妖脚本的公共库(截图/远程操控)
; 调用脚本只需 #Include 本文件,本文件会自动引入 ImagePut
; 调用脚本需定义以下全局变量:
;   global WinTitle    := "花妖"
;   global DryRun      := true
;   global LogFileName := "garden_xxx.log"

; 关闭"变量未赋值"的警告弹窗(调用方在主脚本顶部定义这些全局变量,此处无法静态识别)
#Warn VarUnset, Off

; 引入 ImagePut 库(用于精确截图)
#Include image-put.ahk

/**
 * 写日志到 %TEMP%\LogFileName
 * 每次脚本启动时覆盖旧日志(配合 ResetLog)
 */
LogMsg(msg) {
    global LogFileName
    logFile := A_Temp "\" LogFileName
    ts := A_Now " " A_MSec "ms"
    try FileAppend("[" ts "] " msg "`n", logFile)
}

/**
 * 重置日志文件(启动时调用,覆盖旧内容)
 */
ResetLog() {
    global LogFileName
    logFile := A_Temp "\" LogFileName
    try FileDelete(logFile)
}

/**
 * 屏幕中央显示大字号彩色标签,8 秒后自动关闭
 * DryRun=false 时静默,不显示任何调试信息
 */
ShowBigLabel(text, bgColor := "Yellow", textColor := "Black") {
    global DryRun
    if !DryRun
        return
    g := Gui("+AlwaysOnTop -Caption +ToolWindow")
    g.BackColor := bgColor
    g.SetFont("s24 bold c" textColor)
    g.Add("Text", "Background" bgColor " Center w600 h80", "  " text "  ")
    g.Show("Center w640 h120")
    WinSetAlwaysOnTop(1, g)
    SetTimer () => g.Destroy(), -8000
}

/**
 * 用 ImagePut 把指定屏幕矩形区域保存为图像文件
 * @param rect     [x, y, w, h] 屏幕像素坐标
 * @param filepath 输出文件路径
 */
CaptureRectToFile(rect, filepath) {
    try {
        ImagePut("File", rect, filepath, 100)
    } catch {
        return false
    }
    return FileExist(filepath)
}

/**
 * 扫描图像,返回最大连续色块的 (x, y, w, h);失败返回 0
 *
 * @param imagePath     图像文件路径
 * @param isColor       颜色判断函数对象: isColor(r, g, b) => true/false
 * @param phasePrefix   日志前缀,如 "蓝色"/"红色"
 * @param minW          最小宽度过滤(0=不限制)
 * @param minH          最小高度过滤(0=不限制)
 * @param minY          起始 y 坐标(0=从顶开始),用于跳过窗口装饰条/标题栏
 */
ScanColorBlocks(imagePath, isColor, phasePrefix := "色块", minW := 0, minH := 0, minY := 0) {
    LogMsg("ScanColorBlocks: 开始 " imagePath " (" phasePrefix ")")
    if minY > 0
        LogMsg("跳过 y<" minY " 的顶部区域")

    ; 用 ImagePut 自己的 startup 机制启动 GDI+(维护引用计数)
    ImagePut.gdiplusStartup()

    pBitmap := 0
    try {
        pBitmap := ImagePut.FileToBitmap(imagePath)
        if !pBitmap {
            LogMsg("ImagePut.FileToBitmap 失败")
            return 0
        }

        W := 0, H := 0
        DllCall("gdiplus\GdipGetImageWidth", "Ptr", pBitmap, "UInt*", &W)
        DllCall("gdiplus\GdipGetImageHeight", "Ptr", pBitmap, "UInt*", &H)
        if W <= 0 || H <= 0
            return 0
        LogMsg("图片尺寸: " W "x" H)

        ; LockBits 锁内存(32bpp ARGB)
        bd := Buffer(48, 0)
        rect := Buffer(16, 0)
        NumPut "UInt", 0, rect, 0
        NumPut "UInt", 0, rect, 4
        NumPut "UInt", W, rect, 8
        NumPut "UInt", H, rect, 12

        lockRes := DllCall("gdiplus\GdipBitmapLockBits"
            , "Ptr", pBitmap
            , "Ptr", rect
            , "UInt", 1        ; ImageLockModeRead
            , "Int", 0x26200A  ; PixelFormat32bppARGB
            , "Ptr", bd)
        if lockRes != 0 {
            LogMsg("GdipBitmapLockBits 失败: " lockRes)
            return 0
        }

        try {
            scan0 := NumGet(bd, 16, "Ptr")
            stride := NumGet(bd, 8, "Int")

            ; Phase 1: 逐行统计目标颜色像素数
            rowCount := Buffer(H * 4, 0)
            idx := 0
            total := 0
            loop H {
                y := A_Index - 1
                if minY > 0 && y < minY {
                    idx += W * 4
                    continue
                }
                c := 0
                loop W {
                    b := NumGet(scan0 + idx, 0, "UChar")
                    g := NumGet(scan0 + idx + 1, 0, "UChar")
                    r := NumGet(scan0 + idx + 2, "UChar")
                    if isColor(r, g, b)
                        c++
                    idx += 4
                }
                NumPut "UInt", c, rowCount, (A_Index - 1) * 4
                total += c
            }
            if total = 0 {
                LogMsg("Phase 1 完成: 0 个" phasePrefix "像素")
                return 0
            }
            LogMsg("Phase 1 完成, 总" phasePrefix "像素: " total)

            ; Phase 2: 找 y 方向连续色块段
            threshold := 5
            yMin := yMax := yTotal := 0
            bestYMin := bestYMax := bestYTotal := 0
            loop H {
                y := A_Index - 1
                c := NumGet(rowCount, y * 4, "UInt")
                if c >= threshold {
                    if yMin = 0 {
                        yMin := y
                        yMax := y
                        yTotal := c
                    } else {
                        yMax := y
                        yTotal += c
                    }
                } else if yMin {
                    if yTotal > bestYTotal {
                        bestYMin := yMin
                        bestYMax := yMax
                        bestYTotal := yTotal
                    }
                    yMin := yMax := yTotal := 0
                }
            }
            if yMin && yTotal > bestYTotal {
                bestYMin := yMin
                bestYMax := yMax
                bestYTotal := yTotal
            }
            if bestYTotal = 0 {
                LogMsg("Phase 2: 未找到" phasePrefix " y 段")
                return 0
            }
            LogMsg("Phase 2: " phasePrefix " y 段 y=" bestYMin "-" bestYMax " total=" bestYTotal)

            ; Phase 3: 在中心行扫描所有 x 段
            probeY := (bestYMin + bestYMax) // 2
            rowStart := probeY * stride
            btnH := bestYMax - bestYMin + 1

            xSegments := []
            xMin := xMax := 0
            loop W {
                x := A_Index - 1
                b := NumGet(scan0 + rowStart + x * 4, 0, "UChar")
                g := NumGet(scan0 + rowStart + x * 4 + 1, "UChar")
                r := NumGet(scan0 + rowStart + x * 4 + 2, "UChar")
                if isColor(r, g, b) {
                    if !xMin {
                        xMin := x
                        xMax := x
                    } else {
                        xMax := x
                    }
                } else if xMin {
                    xSegments.Push({xMin: xMin, xMax: xMax, w: xMax - xMin + 1})
                    xMin := xMax := 0
                }
            }
            if xMin
                xSegments.Push({xMin: xMin, xMax: xMax, w: xMax - xMin + 1})

            if xSegments.Length = 0
                return 0

            ; 选满足最小尺寸的最宽 x 段(避免把小红点等噪点识别为按钮)
            bestSeg := 0
            for seg in xSegments {
                if minW > 0 && seg.w < minW
                    continue
                if minH > 0 && btnH < minH
                    continue
                if !bestSeg || seg.w > bestSeg.w
                    bestSeg := seg
            }

            if !bestSeg {
                LogMsg("Phase 3: 所有 x 段都不满足最小尺寸 " minW "x" minH)
                return 0
            }

            return {
                x: bestSeg.xMin,
                y: bestYMin,
                w: bestSeg.w,
                h: btnH
            }
        } finally {
            DllCall("gdiplus\GdipBitmapUnlockBits", "Ptr", pBitmap, "Ptr", bd)
        }
    } finally {
        if pBitmap {
            try DllCall("gdiplus\GdipDisposeImage", "Ptr", pBitmap)
        }
        ; 跳过 GdiplusShutdown(ImagePut 已管理 GDI+ 生命周期)
    }
}

/**
 * 确保截图目录存在(位于脚本所在目录下的 screenshots)
 */
EnsureScreenshotDir() {
    dir := A_ScriptDir "\screenshots"
    if !DirExist(dir)
        try DirCreate(dir)
}

; ===== 远程操控模式辅助 =====
; 截图保存到 screenshots\control.png, 窗口矩形写入 screenshots\control-meta.json
; 供 Node.js 后端读取窗口矩形, 将截图坐标映射为屏幕坐标执行点击
;
; @param x, y, w, h 窗口在屏幕上的位置与尺寸(像素)
; @returns 成功返回 true
SaveControlScreenshot(x, y, w, h) {
    dir := A_ScriptDir "\screenshots"
    if !DirExist(dir)
        try DirCreate(dir)
    filepath := dir "\control.png"
    try {
        ImagePut("File", [x, y, w, h], filepath, 100)
    } catch {
        return false
    }
    return FileExist(filepath)
}

/**
 * 写入操控模式元数据(窗口矩形 + 操作结果),供 Node.js 后端读取
 * @param ok      操作是否成功
 * @param message 操作描述(如"截图成功"/"已点击 (x, y)")
 */
WriteControlMeta(x, y, w, h, ok, message) {
    dir := A_ScriptDir "\screenshots"
    if !DirExist(dir)
        try DirCreate(dir)
    filepath := dir "\control-meta.json"
    ts := A_Now
    json := "{" chr(10)
    json .= "  " chr(34) "timestamp" chr(34) ": " chr(34) ts chr(34) "," chr(10)
    json .= "  " chr(34) "ok" chr(34) ": " (ok ? "true" : "false") "," chr(10)
    json .= "  " chr(34) "x" chr(34) ": " x "," chr(10)
    json .= "  " chr(34) "y" chr(34) ": " y "," chr(10)
    json .= "  " chr(34) "w" chr(34) ": " w "," chr(10)
    json .= "  " chr(34) "h" chr(34) ": " h "," chr(10)
    json .= "  " chr(34) "message" chr(34) ": " chr(34) message chr(34) chr(10)
    json .= "}" chr(10)
    try FileDelete(filepath)
    try FileAppend(json, filepath, "UTF-8-RAW")
    LogMsg("控制元数据: ok=" ok " rect=" x "," y " " w "x" h " - " message)
}

; ===== 恢复之前的窗口焦点 =====
RestorePrevWindow(hwnd) {
    if hwnd && WinExist("ahk_id " hwnd)
        try WinActivate(hwnd)
}

; ===== 确保花妖窗口可见且激活(处理最小化到托盘/最小化) =====
; 调用脚本需定义全局 WinTitle。
; 背景: AHK 的 DetectHiddenWindows 默认 Off, 花妖最小化到系统托盘(窗口被隐藏)
; 时 WinExist 匹配不到, 会误报"找不到花妖窗口"。本函数:
;   1) 开启 DetectHiddenWindows 以匹配隐藏窗口
;   2) 窗口隐藏(托盘) -> WinShow 恢复显示; 最小化(任务栏) -> WinRestore 还原
;   3) WinActivate/WinWaitActive 全程 try/catch, 失败返回友好提示而非让脚本报错中断
; @param wx wy ww wh 输出窗口矩形(按引用传参)
; @param errMsg      失败时的中文提示(按引用传参)
; @returns true=成功; false=失败
EnsureHuaYaoWindow(&wx, &wy, &ww, &wh, &errMsg) {
    DetectHiddenWindows(true)
    hwnd := WinExist(WinTitle)
    if !hwnd {
        errMsg := "找不到花妖窗口，请先打开花妖，或从系统托盘点击花妖图标恢复"
        return false
    }
    ; 窗口存在但被隐藏(托盘)或最小化 -> 先恢复显示
    if !DllCall("IsWindowVisible", "Ptr", hwnd) {
        LogMsg("花妖窗口隐藏，尝试从托盘恢复显示")
        try WinShow(hwnd)
    }
    if WinGetMinMax(hwnd) = -1 {
        LogMsg("花妖窗口已最小化，尝试还原")
        try WinRestore(hwnd)
    }
    Sleep(150)
    ; 激活窗口(失败也不中断脚本, 给出可操作的提示)
    try {
        WinActivate(hwnd)
        WinWaitActive(hwnd, , 1)
    } catch {
        errMsg := "无法激活花妖窗口，请从系统托盘点击花妖图标恢复"
        return false
    }
    WinGetPos(&wx, &wy, &ww, &wh, hwnd)
    ; Tauri 窗口从托盘隐藏恢复后, 矩形可能仍是 0x0(位置信息丢失)。
    ; 此时主动 WinMove 到屏幕居中并设为标准尺寸, 使其恢复可操控。
    if (ww <= 0 || wh <= 0) {
        LogMsg("窗口矩形无效(" ww "x" wh ")，尝试自动重定位窗口")
        ; 取主显示器工作区, 失败则回退到全屏
        try MonitorGetWorkArea(, &mL, &mT, &mR, &mB)
        catch {
            mL := 0, mT := 0, mR := A_ScreenWidth, mB := A_ScreenHeight
        }
        DEF_W := 406, DEF_H := 883   ; 花妖标准窗口尺寸
        px := mL + (mR - mL - DEF_W) // 2
        py := mT + (mB - mT - DEF_H) // 2
        try WinMove(px, py, DEF_W, DEF_H, hwnd)
        Sleep(200)
        WinGetPos(&wx, &wy, &ww, &wh, hwnd)
        if (ww <= 0 || wh <= 0) {
            errMsg := "花妖窗口无法恢复位置，请从托盘恢复并重新打开窗口"
            return false
        }
        LogMsg("已自动重定位窗口到 " px "," py " " DEF_W "x" DEF_H)
    }
    LogMsg("花妖窗口就绪: " wx "," wy " " ww "x" wh)
    return true
}
