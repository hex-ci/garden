# CODEBUDDY.md This file provides guidance to CodeBuddy when working with code in this repository.

## 项目概述

这是"花妖"(HuaYao)游戏**远程操控台**：通过浏览器实时查看"花妖"桌面程序的画面，单击画面即可在花妖窗口对应位置执行鼠标点击。打开页面即为全屏操控界面。

技术栈为 **Node.js 后端 + HTML5 前端 + AutoHotkey v2 脚本**，仅依赖 `yauzl`（纯 Node ZIP 解压，用于花妖更新，替代系统 tar/powershell）。后端用 `child_process` spawn 一次性的 AHK 脚本执行"截图/点击"，前端只负责展示画面和收集点击坐标。

> 演进说明：早期有基于像素颜色识别的"启动/停止/重新登录"按钮，但因花妖 UI 有持续动画、按钮颜色不稳定，自动识别经常误判。这些功能已**全部删除**，改为让用户通过操控画面直接点击操作，更直观可靠。当前**只保留远程操控这一个核心功能**。

## 常用命令

- **启动服务**：`npm start`（等价于 `node start.js`）。`start.js` 会检测是否管理员，非管理员在 Windows 下弹 UAC 提权后以管理员重新启动（因为更新花妖写防火墙规则需要管理员权限），之后加载 `server.js`。监听 `0.0.0.0:13000`（可用 `.env` 或环境变量 `PORT`/`HOST` 覆盖），浏览器访问 `http://localhost:13000`。首次部署需 `npm install` 安装 `yauzl`（其余逻辑零依赖）。本地配置统一放 `.env`（零依赖加载器，已被 .gitignore 排除），模板见 `.env.example`。
- **无测试、无 Lint、无构建步骤**：前端是纯静态 `index.html`，后端用 Node 原生 `http` 模块，唯一第三方依赖 `yauzl`（解压 zip）。
- **改代码后需重启服务才生效**：结束旧 node 进程（`Get-CimInstance Win32_Process -Filter "Name='node.exe'"` 找到 server.js/start.js 的 PID，`Stop-Process`）再 `npm start`。
- **手动运行 AHK 脚本调试**：可 `AutoHotkey.exe control-shot.ahk` 单独跑，脚本会把结果写入 `screenshots/` 下的 JSON，方便检查。

## 架构

### 三层协作模型（重点）

核心架构是 **Node.js 后端 ↔ 文件系统 ↔ AHK 脚本** 的松耦合协作，没有共享内存或 IPC，一切状态通过文件传递：

1. **Node.js 后端 (`server.js`)** 提供 REST API，收到请求后 `spawn` 一个对应的 AHK 脚本，等待进程退出后读取结果文件拼装响应。
2. **AHK 脚本** 执行真实窗口操作（截图 / 点击），结束前把窗口矩形和操作结果写入 `screenshots/control-meta.json`（截图写入 `screenshots/control.png`）。
3. **后端读取 meta 文件**，返回给前端。AHK 写的 JSON 带 UTF-8 BOM，后端 `readControlMeta` 先剥离 `\uFEFF` 再 `JSON.parse`。

关键点：**AHK 脚本是"一次性执行"的**（`#SingleInstance Off`，跑完即退出），每次 API 调用都重新 spawn 一个新进程。后端用 30 秒超时兜底，避免脚本卡死导致请求挂起。脚本 `#Include garden-lib.ahk`，库内部自动 `#Include image-put.ahk`。

### API（全部为远程操控相关）

- `POST /api/control/shot` → 运行 `control-shot.ahk`，把花妖窗口置于前台并截图。截图前会先 `ensureGardenRunning()`：按**当前版本 exe 完整路径精确匹配**检测运行情况——当前版本没在运行（被杀/退出）或跑的是其他旧版本时，结束旧进程并重新启动 `version.json` 记录的当前版本 exe，保证操控的始终是最新版（进程路径匹配 + 服务端锁防重复启动）；等待窗口就绪后截图，响应带 `autoStarted`/`ensureError` 字段供前端提示。**未安装兜底**：花妖从未安装（无版本记录）或当前版本 exe 文件丢失时，不做无意义的截图（AHK 必然失败且提示误导），直接返回 `{ok:false, notInstalled:true, reason:'no_record'|'exe_missing', message}` 供前端展示安装引导；版本记录丢失但花妖进程仍在运行时按降级模式放行截图（`degraded`）。
- `POST /api/control/restart` → 重启花妖：`killGardenProcesses()` 结束进程 → 等 600ms → `ensureGardenRunning()` 启动当前版本并等待窗口就绪。前端顶栏「⏻」按钮调用，成功后自动刷新画面。未安装/程序文件丢失时拒绝重启（不执行 kill），返回 `notInstalled` 标记，前端提示并自动打开安装面板——程序文件丢失但进程还在跑时尤其要避免把唯一实例杀掉后无法恢复。
- `POST /api/control/click` → 接收 `{x, y}`（截图像素坐标），运行 `control-click.ahk <x> <y>` 执行点击。
- `POST /api/control/input` → 接收 `{x, y, text, clear}`（截图像素坐标 + 文本 + 是否清空），先把 `text` 写入 `screenshots/input-text.txt`（UTF-8 无 BOM，避免命令行转义），再运行 `control-input.ahk <x> <y> <clear>` 输入文本。
- `GET /api/control/screenshot` → 返回最新 `control.png`。
- `GET /api/garden/update` → 返回当前版本信息、更新历史、下载地址配置，并带 `installed`（当前版本 exe 是否真实存在）与 `installReason`（`ok`/`no_record`/`exe_missing`），前端据此区分"首次安装/重新安装/日常更新"语义。
- `POST /api/garden/update` → 更新花妖程序。body 传 `{version:"1.5.1"}` 或 `{auto:true}`（自动推算下一版本，末位 +1）。流程：下载 zip → 校验 zip 文件头 → **用 yauzl 解压**（纯 Node 实现，不依赖系统 tar/powershell）到安装目录 `v<版本>/` → 定位主程序 → 结束后正在运行的花妖 → **预先用 `netsh advfirewall` 添加防火墙放行规则（避免首次启动弹 Windows"允许联网"对话框，需管理员权限）** → 启动主程序 → 等待窗口就绪 → 写 `version.json` 与 `update.log`。任一准备步骤失败时旧版花妖不受影响；启动阶段失败会尝试恢复旧版。

**坐标映射机制**：`control-shot.ahk` 把窗口矩形 `(x, y, w, h)` 写入 `control-meta.json`；前端拿到矩形后在截图内计算点击的"截图像素坐标"并传给后端；`control-click.ahk` 重新读取窗口当前位置，把截图像素坐标加上窗口偏移映射为屏幕坐标再点击，随后自动重新截图形成"所见即所得"反馈闭环。因此**窗口移动不影响坐标映射正确性**。

### 前端（index.html）

单文件内联 CSS/JS，**移动优先 (mobile-first)**，打开即进入操控界面。核心是**双模式**（底部按钮 `modeBtn` 切换，`applyMode()` 统一处理）：

- **直接点击模式（默认）**：单指轻点画面 = 立即点击花妖（tap 且无移动才触发）；双指捏合 = 缩放。
- **手动点击模式**：单指拖动 = 移动绿色虚拟光标（1:1 图像像素，`moveCursorTo` 裁剪边界）；底部大「点击」按钮在光标位置确认发送 `/api/control/click`；光标含坐标标签（画面→屏幕）。
- **缩放平移实现**：CSS `transform` + `transform-origin:0 0`，`renderInfo()` 统一计算映射，捏合中心缩放保持画面点不动。
- **桌面增强**（检测到 `hover+pointer:fine` 时启用）：鼠标悬停=光标跟随（手动模式）或更新位置提示（直接模式）、单击=直接点击、滚轮缩放、按住拖动平移。桌面端默认直接模式单击即点。
- **文本输入**：底部第二行常驻「⌨ 输入」按钮。点击画面（`doClick`）时把截图像素坐标存入 `target` 作为"目标输入框"依据；点「输入」弹出底部输入面板（textarea 自动聚焦唤起系统键盘），回车/软键盘发送键确认、Shift+回车换行、可选"发送前清空"开关（默认追加）。发送走 `POST /api/control/input`，成功后面板关闭并刷新画面。键盘弹出时用 `visualViewport` 把面板顶到键盘上方（iOS 适配）。
- 状态信息只显示**非花妖状态**（截图是否成功、窗口矩形、光标坐标），不判断花妖运行状态。移动端用 toast 提示，桌面端用状态栏。
- **未安装引导**：截图接口返回 `notInstalled` 时，画面区显示引导卡 `setupCard`（区分"尚未安装"与"程序文件丢失"两种文案/图标，内联 lucide 风格 SVG），按钮跳转更新面板；面板按 `installed`/`installReason` 动态切换标题与按钮文案（安装花妖/重新安装花妖/更新花妖版本），未安装时禁用"自动下一版本"（无当前版本可推算），下载源未配置时引导卡上直接禁用安装按钮并提示配置 `.env`。

### 文件职责

- `server.js`：HTTP 服务器 + 零依赖 `.env` 加载器 + AHK 定位（优先 `AHK_EXE` 环境变量，回退常见安装路径）+ 子进程管理 + 3 个操控 API + 花妖更新（下载/校验/yauzl 解压/防火墙/拉起）。可配置项：`PORT`/`HOST`/`AHK_EXE`/`GARDEN_DOWNLOAD_URL` 等。花妖窗口标题(`"花妖"`)与标准尺寸(406x883)为固定常量，硬编码于脚本中，不做外部化。
- `index.html`：全屏操控界面（内联 CSS/JS），缩放/平移/准星/方向键微调等交互都在此实现。
- `garden-lib.ahk`：公共库 —— `LogMsg`/`ResetLog`/`ShowBigLabel`/`CaptureRectToFile`/`SaveControlScreenshot`/`WriteControlMeta`/`EnsureHuaYaoWindow` 等工具函数。`EnsureHuaYaoWindow` 统一处理花妖窗口可见性：开启 `DetectHiddenWindows` 匹配托盘隐藏窗口、`WinShow`/`WinRestore` 恢复显示，矩形无效(0x0，Tauri 隐藏恢复后位置丢失)时自动 `WinMove` 重定位到屏幕居中(406x883)，全程 try/catch 失败返回友好提示而非报错中断。三个控制脚本(shot/click/input)均调用它。还残留 `ScanColorBlocks`/`CaptureRectToFile` 等旧状态识别的死代码（无调用方，可安全删除，不影响功能）。
- `control-shot.ahk`：把花妖窗口置于前台并截图，写 `control.png` + `control-meta.json`。
- `control-click.ahk`：按截图像素坐标映射到屏幕坐标后点击，点击后再截图反馈。
- `control-input.ahk`：接收 `<sx> <sy> <clear>`，先点击目标坐标确保输入框焦点，再从 `input-text.txt` 读文本写入剪贴板后 `Ctrl+V` 粘贴（clear=1 先 `Ctrl+A` 全选覆盖，clear=0 先 `^{End}` 定位到末尾追加），最后截图反馈。
- `image-put.ahk`：第三方库（上游名为 `ImagePut.ahk`），用于精确截图和 GDI+ 操作，勿修改。同步上游更新时注意替换回原名。
- `status.json` / `screenshots/`：运行时生成的状态与截图文件（前端已不读 `status.json`）。
- `hua-yao/`：花妖程序安装目录（下载解压产物，已 .gitignore）。内含 `version.json`（版本信息）与 `update.log`（更新日志）。

### 版本更新可配置项（`.env`）

- `GARDEN_DOWNLOAD_URL`：完整下载地址，`{v}` 占位替换为目标版本号。**无默认值**——真实 CDN 地址属敏感信息，代码与模板均不内置，必须由用户在本地 `.env` 自行配置；未配置时更新功能不可用（前端面板会提示、`POST` 接口返回错误）。
- `GARDEN_INSTALL_DIR`：安装目录，默认项目下 `hua-yao/`。
- `GARDEN_EXE_NAME`：解压后要启动的主程序名（`{v}` 占位替换为目标版本号），默认 `garden-v{v}-x64.exe`（找不到时回退到目录内任意 `.exe`）。运行进程结束按 `GARDEN_EXE_NAME` 的 `{v}` 前缀匹配（如 `garden-v` 覆盖 `garden-v1.4.9-x64`）。

### 环境要求

- AutoHotkey v2（脚本第一行 `#Requires AutoHotkey v2.0`）。后端启动时探测 AHK，找不到则截图/操控功能不可用（页面仍能打开并提示）。
- 目标游戏窗口标题固定为 `"花妖"`，尺寸通常为 406x883。
- `index.html` 与 `server.js` 中的路径基于 `__dirname` / `A_ScriptDir`，不要改变脚本/页面文件与 `screenshots/` 的相对位置。
