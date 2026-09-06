# CODEBUDDY.md This file provides guidance to CodeBuddy when working with code in this repository.

## 项目概述

这是"花妖"(HuaYao)游戏**远程操控台**：通过浏览器实时查看"花妖"桌面程序（Tauri + WebView2）的画面，单击画面即可在花妖窗口对应位置执行点击，还支持向输入框发送文本。核心特性是**全后台操控**——RDP 最小化、窗口被完全遮挡、花妖在后台时，截图/点击/输入均正常工作。

技术栈：Node.js 原生 `http` 后端 + 单文件 HTML5 前端。运行时依赖仅 3 个且全部预编译：`koffi`（Win32 API 调用）、`node-screenshots`（窗口截图）、`yauzl`（纯 Node ZIP 解压，用于花妖更新）。UIA 能力一律通过**系统自带 PowerShell + .NET UIA** 实现，**禁止引入任何编译型/原生依赖**（项目原则：简洁优先，用户明确裁定）。

## 常用命令

- **启动服务**：`npm start`（等价 `node start.js`）。`start.js` 检测管理员权限，非管理员弹 UAC 提权重启（更新花妖写防火墙规则需要），然后加载 `server.js`。监听 `0.0.0.0:13000`，`.env` 可覆盖 `PORT`/`HOST`。首次部署 `npm install`。
- **无测试、无 Lint、无构建步骤**。改代码后需重启 node 进程才生效。
- **调试**：`logs/control.log`（已 gitignore）记录每次 click/input/shot 的坐标、耗时、结果与安全闸判定，是远程排查的第一入口；默认全量记录，`.env` 设 `CONTROL_LOG=0` 切静默模式（仅失败/拦截），超 1MB 自动滚动。调试协作模式：加日志 → 用户浏览器真实操作 → 读日志定位。

## 架构

### capture.js —— 后台操控核心（koffi/Win32）

窗口与消息层的全部能力都在这里，服务器无状态调用：

- `getWindow()`：定位花妖顶层窗口（标题 `"花妖"`，按进程/窗口匹配），带缓存，`invalidate()` 失效。
- `findRenderWidgetHwnd(hwnd)`：递归找 WebView2 渲染子窗口（类名 `Chrome_RenderWidgetHostHWND`）——**消息点击/键盘的唯一正确投递目标**，直接发主窗口对 WebView2 无效。
- `clientOrigin(hwnd)`：`ClientToScreen` 求客户区原点。**必须传具体 hwnd**，漏传会得到 (0,0) 导致坐标全错（历史 bug）。
- `clientClick(sx, sy)`：把截图像素坐标换算为 RWH 客户区坐标后 `PostMessage` 投递鼠标消息（MOUSEMOVE/BUTTONDOWN/BUTTONUP）。后台可送达，不移动真实鼠标、不抢焦点。
- `captureFrame()`：按窗口抓帧（PrintWindow 路线，node-screenshots）。RDP 最小化后 Windows 挂起屏幕渲染，抓屏幕必黑，**按窗口抓取不受影响**。
- `sendTextInput(sx, sy, text, append)`：**纯消息文本输入（v3，当前方案）**——消息点击定位光标 → append：END 键移到末尾；clear：三击全选（第 2/3 击用 `WM_LBUTTONDBLCLK`，间隔须在双击窗口内）→ 逐字符 `WM_CHAR`。毫秒级、不依赖系统焦点、任何遮挡状态不受影响。

**消息输入的边界（实测结论，勿走回头路）**：
- `WM_CHAR` 打字有效（Unicode 码点直发，中文 OK）；但退格/Ctrl+A/Shift+Home 等**编辑控制键消息 Chromium 不认**（`WM_KEYDOWN`、`WM_CHAR 0x08` 均无效），所以 clear 靠三击全选覆盖，不能靠键盘删除。
- 后台 `PostMessage` 点击**不会转移系统焦点**（前台窗口不变，UIA `FocusedElement` 永远指向前台），但 WebView2 处理投递消息不需要系统焦点。
- UIA `ValuePattern.SetValue` 写值可用但有两个代价：窗口被完全遮挡时渲染节流导致 **~2s 确认等待**，且 Chromium 会自己激活抢前台（无法从后台进程阻止/归还）。当前架构仅在将来需要兜底时才考虑，正常路径零 UIA 写操作。

### uia-probe.js —— 输入前安全闸（PowerShell/只读 UIA）

`runUiaProbe(pid, px, py)`：判断屏幕坐标处是否为花妖的可输入控件，**只读不写、零消息、界面零扰动**。实现：spawn `powershell.exe -EncodedCommand`（UTF-16LE，不落盘，规避 PS5.1 无 BOM 读 UTF-8 中文乱码问题），脚本内 FromPoint 快路径（校验元素 PID 属花妖或 msedgewebview2 渲染进程）+ 全树"包含点且面积最小"搜索兜底，向上找可写 Value/Range 模式且控件类型限定 编辑/组合框/微调/文档（排除"切换"等自带可写空 Value 的非输入控件）。返回 `{editable, kind, controlType}` 或 `{unavailable}`；探测失败**放行**（可用性优先）。成本 ~700ms/次（PS 冷启动）。

### server.js —— HTTP 服务与花妖生命周期

- `POST /api/control/shot`：确保花妖在运行（`ensureGardenRunning`：当前版本 exe 路径精确匹配，异常时重启；未安装返回 `notInstalled` 供前端安装引导）→ **内存抓帧不落盘** → 返回窗口矩形 + base64 PNG（`image` 字段，前端直接 `img.src='data:image/png;base64,'` 渲染，省一次 GET 往返）。`GET /api/control/screenshot` 返回最近一帧内存 PNG（`image/png`），便于浏览器直接打开调试。
- `POST /api/control/click`：`{x,y}`（截图像素坐标）→ `clientClick` → 250ms 后自动重截图，形成"所见即所得"闭环。窗口移动不影响映射（每次实时求原点）。
- `POST /api/control/input`：`{x,y,text,clear}` → **先跑安全闸**（`uia-probe`，不可编辑则拒绝且一个消息都不发）→ `sendTextInput` → 重截图反馈。
- `POST /api/control/restart` / `GET|POST /api/garden/update`：重启与版本更新（下载 zip → yauzl 校验解压 → `netsh advfirewall` 预放行防火墙 → 拉起 → 写 `hua-yao/version.json`；启动失败回滚旧版）。
- 操作日志 `logControl()` → `logs/control.log`；配置项见 `.env.example`（`GARDEN_DOWNLOAD_URL` 无默认值，真实下载源属敏感信息不入库）。

### index.html —— 前端（单文件内联）

移动优先双模式（直接点击/手动瞄准光标）、双指捏合缩放平移、文本输入面板（`visualViewport` 适配软键盘）、未安装引导卡。坐标全部使用"截图像素坐标"，由后端换算为屏幕/RWH 客户区坐标。

## 关键约束

- 花妖窗口标题固定 `"花妖"`（客户端区约 390x844）；`hua-yao/` 为安装目录（gitignored）。
- 截图**不落盘**：抓帧在内存中完成，base64 随 API 响应直出；`screenshots/` 目录不再创建（gitignore 条目仅作历史遗留兼容）。
- `.codebuddy/`、`logs/`、`.env`、`hua-yao/` 均已 gitignore；**绝不提交任何真实下载源/凭证**。
- 依赖保持最小集（koffi/node-screenshots/yauzl），新增能力优先考虑"系统能力 + 消息机制"，引入新 npm 依赖或任何需要编译的东西前必须与用户确认。
