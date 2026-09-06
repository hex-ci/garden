# CODEBUDDY.md This file provides guidance to CodeBuddy when working with code in this repository.

## 项目概述

这是"花妖"(HuaYao)游戏**远程操控台**：通过浏览器实时查看"花妖"桌面程序（Tauri + WebView2）的画面，单击画面即可在花妖窗口对应位置执行点击，还支持向输入框发送文本。核心特性是**全后台操控**——RDP 最小化、窗口被完全遮挡、花妖在后台时，截图/点击/输入均正常工作。

技术栈：Node.js 原生 `http` 后端 + 单文件 HTML5 前端，**全 ESM**（package.json `"type": "module"`，相对导入必须带 `.js` 扩展名；CJS 依赖用默认导入解构）。运行时依赖仅 4 个且全为纯 JS/预编译：`koffi`（Win32 API 调用）、`node-screenshots`（窗口截图，含原生 `toJpeg()`/`crop()`）、`ws`（WebSocket，纯 JS）、`yauzl`（纯 Node ZIP 解压，用于花妖更新）。UIA 能力一律通过**系统自带 PowerShell + .NET UIA** 实现，**禁止引入任何编译型/原生依赖**（项目原则：简洁优先，用户明确裁定）。

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
- `POST /api/control/click`：`{x,y,noimg?}`（截图像素坐标）→ `clientClick` + `noteActivity()`。**noimg=true（实时模式）时跳过等待与抓帧直接秒回**（实测 ~40ms），画面由实时突发帧呈现；否则等待+重截图返回 image，形成"所见即所得"闭环。窗口移动不影响映射（每次实时求原点）。
- `POST /api/control/input`：`{x,y,text,clear,noimg?}` → **先跑安全闸**（`uia-probe`，不可编辑则拒绝且一个消息都不发；**同点位结果缓存 4s**，命中时省去 ~700ms PS 冷启动，实测后续探测 3ms）→ `sendTextInput`（内置 ~0.5-0.7s 消息节奏等待）+ `noteActivity()`；noimg 时无截图返回，前端发送按钮显示"发送中…"加载态；否则重截图反馈。
- `POST /api/control/restart` / `GET|POST /api/garden/update`：重启与版本更新（下载 zip → yauzl 校验解压 → `netsh advfirewall` 预放行防火墙 → 拉起 → 写 `hua-yao/version.json`；启动失败回滚旧版）。
- **`WS /api/live`（实时画面，live.js）**：**常开，前端无开关按钮**（实时是唯一画面模式）。轮询抓帧 + **变化才发帧**——原始 BGRA 隔点采样哈希（~1ms），画面没变只发 13 字节跳帧心跳，挂机静态画面近零流量。二进制帧格式 `[u8 flags][u32 seq][u32 ts][u16 w][u16 h] + JPEG`（flags&1=跳帧）；控制消息 JSON（start/gear/stop/refresh/stats ↔ gear/error）。三档轮询 eco 2s / mid 0.5s / fast 0.2s（**无档位按钮，档位决策完全在服务端**：客户端每 5s 上报帧到达间隔，服务端与**自己实际调度的间隔**比对——>2.5× 降一档（1 个周期即降），<1.3× 且非空闲 连续 2 周期升一档（迟滞防振荡），空闲 3 分钟地板期禁止升档。**为什么必须在服务端决策**：到达间隔由服务端调度节奏决定，客户端无法区分"空闲地板慢"与"网络慢"；且 stats 消息不得刷新 lastActivity，否则空闲地板永不生效——这两点曾导致"挂机升档+降不回来"的双 bug）。当前档位以信号条徽标浮动在画布右上角（1-3 格 = 省流/均衡/流畅，`pointer-events:none` 不挡操作）；**操作反馈帧主动推送**——`noteActivity()` 触发所有客户端 ~140ms（渲染器消化操作）后立即抓帧推送，实测点击→看到结果稳定 174ms（旧轮询机制为 15~215ms 随机）；REST 点击/输入成功调 `noteActivity()` 触发全客户端 2s 突发（200ms），WS 的 `refresh` op 等价；空闲 3 分钟（`LIVE_IDLE_MS` 可配）把轮询抬到省流档**并强制降档为 eco 通知客户端**（徽标同步 1 格；此前只抬间隔不改档位，导致徽标停在满格——自适应基准被地板抬高后降档分支永不触发），交互后由自适应自动爬升；客户端积压 >512KB 暂缓发帧（背压）。**实时是唯一模式**（常开无任何控件；首帧就绪后自动连接，断线自动重连）：WS 连接期间点击/输入带 `noimg:true` 秒回、无加载蒙层，涟漪+突发帧承担反馈；WS 断开期间自动回退旧的"等图+蒙层"路径。刷新按钮已移除——`doShot` 仅用于首次加载与重启/更新后的程序化刷新（实时连接中会转为 refresh 突发）。前端用 `URL.createObjectURL(blob)` 渲染，复用现有缩放/点击映射。JPEG 编码用 node-screenshots 原生 `toJpeg()`（q 固定 ~75，实测 51KB/帧、5-9ms），不引图像处理依赖。
- 操作日志 `logControl()` → `logs/control.log`；配置项见 `.env.example`（`GARDEN_DOWNLOAD_URL` 无默认值，真实下载源属敏感信息不入库）。

### index.html —— 前端（单文件内联）

移动优先双模式（直接点击/手动瞄准光标）、双指捏合缩放平移、文本输入面板（`visualViewport` 适配软键盘）、未安装引导卡。坐标全部使用"截图像素坐标"，由后端换算为屏幕/RWH 客户区坐标。

## 关键约束

- 花妖窗口标题固定 `"花妖"`（客户端区约 390x844）；`hua-yao/` 为安装目录（gitignored）。
- 截图**不落盘**：抓帧在内存中完成，base64 随 API 响应直出；`screenshots/` 目录不再创建（gitignore 条目仅作历史遗留兼容）。
- `.codebuddy/`、`logs/`、`.env`、`hua-yao/` 均已 gitignore；**绝不提交任何真实下载源/凭证**。
- 依赖保持最小集（koffi/node-screenshots/yauzl），新增能力优先考虑"系统能力 + 消息机制"，引入新 npm 依赖或任何需要编译的东西前必须与用户确认。
