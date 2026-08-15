# CODEBUDDY.md This file provides guidance to CodeBuddy when working with code in this repository.

## 项目概述

这是"花妖"(HuaYao)游戏**远程操控台**：通过浏览器实时查看"花妖"桌面程序的画面，单击画面即可在花妖窗口对应位置执行鼠标点击。打开页面即为全屏操控界面。

技术栈为 **Node.js 后端 + HTML5 前端 + AutoHotkey v2 脚本**，无任何第三方 npm 依赖。后端用 `child_process` spawn 一次性的 AHK 脚本执行"截图/点击"，前端只负责展示画面和收集点击坐标。

> 演进说明：早期有基于像素颜色识别的"启动/停止/重新登录"按钮，但因花妖 UI 有持续动画、按钮颜色不稳定，自动识别经常误判。这些功能已**全部删除**，改为让用户通过操控画面直接点击操作，更直观可靠。当前**只保留远程操控这一个核心功能**。

## 常用命令

- **启动服务**：`npm start`（等价于 `node server.js`）。监听 `0.0.0.0:13000`（可用 `.env` 或环境变量 `PORT`/`HOST` 覆盖），浏览器访问 `http://localhost:13000`。无需 `npm install`。本地配置统一放 `.env`（零依赖加载器，已被 .gitignore 排除），模板见 `.env.example`。
- **无测试、无 Lint、无构建步骤**：前端是纯静态 `index.html`，后端是无依赖的 Node 原生 `http` 模块，没有测试框架或构建链。
- **改代码后需重启服务才生效**：结束旧 node 进程（`Get-CimInstance Win32_Process -Filter "Name='node.exe'"` 找到 server.js 的 PID，`Stop-Process`）再 `node server.js`。
- **手动运行 AHK 脚本调试**：可 `AutoHotkey.exe control-shot.ahk` 单独跑，脚本会把结果写入 `screenshots/` 下的 JSON，方便检查。

## 架构

### 三层协作模型（重点）

核心架构是 **Node.js 后端 ↔ 文件系统 ↔ AHK 脚本** 的松耦合协作，没有共享内存或 IPC，一切状态通过文件传递：

1. **Node.js 后端 (`server.js`)** 提供 REST API，收到请求后 `spawn` 一个对应的 AHK 脚本，等待进程退出后读取结果文件拼装响应。
2. **AHK 脚本** 执行真实窗口操作（截图 / 点击），结束前把窗口矩形和操作结果写入 `screenshots/control-meta.json`（截图写入 `screenshots/control.png`）。
3. **后端读取 meta 文件**，返回给前端。AHK 写的 JSON 带 UTF-8 BOM，后端 `readControlMeta` 先剥离 `\uFEFF` 再 `JSON.parse`。

关键点：**AHK 脚本是"一次性执行"的**（`#SingleInstance Off`，跑完即退出），每次 API 调用都重新 spawn 一个新进程。后端用 30 秒超时兜底，避免脚本卡死导致请求挂起。脚本 `#Include garden-lib.ahk`，库内部自动 `#Include image-put.ahk`。

### API（全部为远程操控相关）

- `POST /api/control/shot` → 运行 `control-shot.ahk`，把花妖窗口置于前台并截图。
- `POST /api/control/click` → 接收 `{x, y}`（截图像素坐标），运行 `control-click.ahk <x> <y>` 执行点击。
- `POST /api/control/input` → 接收 `{x, y, text, clear}`（截图像素坐标 + 文本 + 是否清空），先把 `text` 写入 `screenshots/input-text.txt`（UTF-8 无 BOM，避免命令行转义），再运行 `control-input.ahk <x> <y> <clear>` 输入文本。
- `GET /api/control/screenshot` → 返回最新 `control.png`。

**坐标映射机制**：`control-shot.ahk` 把窗口矩形 `(x, y, w, h)` 写入 `control-meta.json`；前端拿到矩形后在截图内计算点击的"截图像素坐标"并传给后端；`control-click.ahk` 重新读取窗口当前位置，把截图像素坐标加上窗口偏移映射为屏幕坐标再点击，随后自动重新截图形成"所见即所得"反馈闭环。因此**窗口移动不影响坐标映射正确性**。

### 前端（index.html）

单文件内联 CSS/JS，**移动优先 (mobile-first)**，打开即进入操控界面。核心是**双模式**（底部按钮 `modeBtn` 切换，`applyMode()` 统一处理）：

- **直接点击模式（默认）**：单指轻点画面 = 立即点击花妖（tap 且无移动才触发）；双指捏合 = 缩放。
- **手动点击模式**：单指拖动 = 移动绿色虚拟光标（1:1 图像像素，`moveCursorTo` 裁剪边界）；底部大「点击」按钮在光标位置确认发送 `/api/control/click`；光标含坐标标签（画面→屏幕）。
- **缩放平移实现**：CSS `transform` + `transform-origin:0 0`，`renderInfo()` 统一计算映射，捏合中心缩放保持画面点不动。
- **桌面增强**（检测到 `hover+pointer:fine` 时启用）：鼠标悬停=光标跟随（手动模式）或更新位置提示（直接模式）、单击=直接点击、滚轮缩放、按住拖动平移。桌面端默认直接模式单击即点。
- **文本输入**：底部第二行常驻「⌨ 输入」按钮。点击画面（`doClick`）时把截图像素坐标存入 `target` 作为"目标输入框"依据；点「输入」弹出底部输入面板（textarea 自动聚焦唤起系统键盘），回车/软键盘发送键确认、Shift+回车换行、可选"发送前清空"开关（默认追加）。发送走 `POST /api/control/input`，成功后面板关闭并刷新画面。键盘弹出时用 `visualViewport` 把面板顶到键盘上方（iOS 适配）。
- 状态信息只显示**非花妖状态**（截图是否成功、窗口矩形、光标坐标），不判断花妖运行状态。移动端用 toast 提示，桌面端用状态栏。

### 文件职责

- `server.js`：HTTP 服务器 + 零依赖 `.env` 加载器 + AHK 定位（优先 `AHK_EXE` 环境变量，回退常见安装路径）+ 子进程管理 + 3 个操控 API。可配置项：`PORT`/`HOST`/`AHK_EXE`。花妖窗口标题(`"花妖"`)与标准尺寸(406x883)为固定常量，硬编码于脚本中，不做外部化。
- `index.html`：全屏操控界面（内联 CSS/JS），缩放/平移/准星/方向键微调等交互都在此实现。
- `garden-lib.ahk`：公共库 —— `LogMsg`/`ResetLog`/`ShowBigLabel`/`CaptureRectToFile`/`SaveControlScreenshot`/`WriteControlMeta`/`EnsureHuaYaoWindow` 等工具函数。`EnsureHuaYaoWindow` 统一处理花妖窗口可见性：开启 `DetectHiddenWindows` 匹配托盘隐藏窗口、`WinShow`/`WinRestore` 恢复显示，矩形无效(0x0，Tauri 隐藏恢复后位置丢失)时自动 `WinMove` 重定位到屏幕居中(406x883)，全程 try/catch 失败返回友好提示而非报错中断。三个控制脚本(shot/click/input)均调用它。还残留 `ScanColorBlocks`/`CaptureRectToFile` 等旧状态识别的死代码（无调用方，可安全删除，不影响功能）。
- `control-shot.ahk`：把花妖窗口置于前台并截图，写 `control.png` + `control-meta.json`。
- `control-click.ahk`：按截图像素坐标映射到屏幕坐标后点击，点击后再截图反馈。
- `control-input.ahk`：接收 `<sx> <sy> <clear>`，先点击目标坐标确保输入框焦点，再从 `input-text.txt` 读文本写入剪贴板后 `Ctrl+V` 粘贴（clear=1 先 `Ctrl+A` 全选覆盖，clear=0 先 `^{End}` 定位到末尾追加），最后截图反馈。
- `image-put.ahk`：第三方库（上游名为 `ImagePut.ahk`），用于精确截图和 GDI+ 操作，勿修改。同步上游更新时注意替换回原名。
- `status.json` / `screenshots/`：运行时生成的状态与截图文件（前端已不读 `status.json`）。

### 环境要求

- AutoHotkey v2（脚本第一行 `#Requires AutoHotkey v2.0`）。后端启动时探测 AHK，找不到则截图/操控功能不可用（页面仍能打开并提示）。
- 目标游戏窗口标题固定为 `"花妖"`，尺寸通常为 406x883。
- `index.html` 与 `server.js` 中的路径基于 `__dirname` / `A_ScriptDir`，不要改变脚本/页面文件与 `screenshots/` 的相对位置。
