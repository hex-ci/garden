// 花妖窗口原生交互模块：抓帧（node-screenshots）+ 消息点击（koffi PostMessage）
// 背景：RDP 最小化/窗口遮挡时，屏幕级截图与真实鼠标注入均不可用。
//   抓帧走窗口级捕获（XCap 内部 PrintWindow 语义，已实测最小化/遮挡均可用）；
//   点击走投递到 WebView2 渲染子窗口（Chrome_RenderWidgetHostHWND）的消息点击（已实测后台可送达）。
// 坐标系：截图像素坐标 = 花妖窗口客户区坐标（截取的就是客户区，无标题栏）。

import koffi from 'koffi';
import nodeScreenshots from 'node-screenshots';

const { Window } = nodeScreenshots;

const user32 = koffi.load('user32.dll');

const PostMessageW = user32.func('int PostMessageW(intptr hwnd, uint msg, uintptr wp, uintptr lp)');
const ClientToScreen = user32.func('bool ClientToScreen(intptr hwnd, void *pt)');
const ShowWindow = user32.func('bool ShowWindow(intptr hwnd, int cmd)');
const IsWindow = user32.func('bool IsWindow(intptr hwnd)');
const IsWindowVisible = user32.func('bool IsWindowVisible(intptr hwnd)');
const IsIconic = user32.func('bool IsIconic(intptr hwnd)');
const GetWindowThreadProcessId = user32.func('uint GetWindowThreadProcessId(intptr hwnd, void *pid)');
const GetWindow = user32.func('intptr GetWindow(intptr hwnd, uint cmd)');
const GetClassNameW = user32.func('int GetClassNameW(intptr hwnd, void *buf, int max)');

const GW_CHILD = 5, GW_HWNDNEXT = 2;
const SW_SHOWNOACTIVATE = 4;   // 恢复/显示窗口但不抢前台
const WM_MOUSEMOVE = 0x0200, WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202;
const WM_CHAR = 0x0102, WM_LBUTTONDBLCLK = 0x0203;
const RWHWND_CLASS = 'Chrome_RenderWidgetHostHWND';   // WebView2 渲染输入窗口（消息点击的投递目标）
const TITLE_KEY = '花妖';
const CAPTURE_TIMEOUT = 3000;  // 单次抓帧/编码超时（防 RDP 会话切换瞬间死锁）
const CAPTURE_ATTEMPTS = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cached = null;   // { win, hwnd, pid, rwhwnd, ts }

function withTimeout(promise, ms, tag) {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(tag + ' 超时(' + ms + 'ms)')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isAlive(hwnd) {
  try { return !!IsWindow(hwnd); } catch { return false; }
}

function pidOf(hwnd) {
  try {
    const b = Buffer.alloc(4);
    GetWindowThreadProcessId(hwnd, b);
    return b.readUInt32LE(0);
  } catch { return 0; }
}

function windowClass(hwnd) {
  try {
    const b = Buffer.alloc(512);
    GetClassNameW(hwnd, b, 256);
    return b.toString('utf16le').split('\0')[0];
  } catch { return ''; }
}

// 深度优先查找 WebView2 渲染输入子窗口（消息点击的投递目标）
function findRenderWidgetHwnd(hwnd, depth = 0) {
  if (depth > 6) return 0;
  let child = Number(GetWindow(hwnd, GW_CHILD)) || 0;
  while (child) {
    if (windowClass(child) === RWHWND_CLASS) return child;
    const sub = findRenderWidgetHwnd(child, depth + 1);
    if (sub) return sub;
    child = Number(GetWindow(child, GW_HWNDNEXT)) || 0;
  }
  return 0;
}

// 查找并缓存花妖窗口（标题精确匹配"花妖"；模糊包含会误抓标题含"花妖"的浏览器窗口,
// 例如操控台页面标题"花妖 · 操控台 - Microsoft Edge"。PID 用于缓存有效性校验, 花妖重启后自动失效重建）
function findWindow() {
  const win = Window.all().find((w) => (w.title() || '') === TITLE_KEY);
  if (!win) return null;
  const hwnd = Number(win.id());
  const pid = Number(win.pid()) || pidOf(hwnd);
  cached = { win, hwnd, pid, rwhwnd: findRenderWidgetHwnd(hwnd), ts: Date.now() };
  return cached;
}

function getWindow() {
  if (cached && cached.hwnd && isAlive(cached.hwnd) && pidOf(cached.hwnd) === cached.pid) return cached;
  return findWindow();
}

// 当前花妖进程 PID（供 UIA 等外部流程定位窗口）
function getTargetPid() {
  const w = getWindow();
  return w ? w.pid : 0;
}

// 窗口可见但不抢前台（托盘隐藏/最小化时恢复显示）
function ensureVisible(hwnd) {
  try {
    if (!IsWindowVisible(hwnd) || IsIconic(hwnd)) ShowWindow(hwnd, SW_SHOWNOACTIVATE);
  } catch { }
}

// 客户区原点（屏幕坐标）
function clientOrigin(hwnd) {
  const pt = Buffer.alloc(8);
  try {
    if (!ClientToScreen(hwnd, pt)) return { x: 0, y: 0 };
  } catch { return { x: 0, y: 0 }; }
  return { x: pt.readInt32LE(0), y: pt.readInt32LE(4) };
}

// 抓取原始图像(不编码): 返回 { img, width, height, origin, hwnd }, 编码方式由调用方选择
// 带超时+重试+窗口对象自愈（应对 RDP 会话切换瞬间死锁、花妖重启后 HWND 变化）
async function captureImage() {
  let lastErr = null;
  for (let attempt = 1; attempt <= CAPTURE_ATTEMPTS; attempt++) {
    try {
      const w = getWindow();
      if (!w) throw new Error('未找到花妖窗口');
      ensureVisible(w.hwnd);
      const img = await withTimeout(w.win.captureImage(), CAPTURE_TIMEOUT, '抓帧');
      if (!img || img.width < 10) throw new Error('截图像素数据异常');
      return { img, width: img.width, height: img.height, origin: clientOrigin(w.hwnd), hwnd: w.hwnd };
    } catch (e) {
      lastErr = e;
      cached = null;   // 下一轮重新查找窗口（应对花妖重启/HWND 变化）
      await sleep(300);
    }
  }
  throw lastErr || new Error('截图失败');
}

// 消息点击：sx/sy 为截图像素坐标（=客户区坐标）
// 投递目标为 WebView2 渲染子窗口（已实测后台可送达；顶层窗口/浅层子窗口均无效）
function clientClick(sx, sy) {
  const w = getWindow();
  if (!w) throw new Error('未找到花妖窗口');
  ensureVisible(w.hwnd);
  const rwh = w.rwhwnd || findRenderWidgetHwnd(w.hwnd);
  if (!rwh) throw new Error('未找到 WebView2 输入通道');
  w.rwhwnd = rwh;
  const origin = clientOrigin(w.hwnd);
  const screenX = origin.x + sx, screenY = origin.y + sy;
  const ro = clientOrigin(rwh);
  const cx = screenX - ro.x, cy = screenY - ro.y;
  const lp = ((cy & 0xffff) << 16) | (cx & 0xffff);
  PostMessageW(rwh, WM_MOUSEMOVE, 0, lp);
  PostMessageW(rwh, WM_LBUTTONDOWN, 1, lp);
  PostMessageW(rwh, WM_LBUTTONUP, 0, lp);
  return true;
}

// 花妖重启/窗口变化后调用，强制下次重新查找
function invalidate() { cached = null; }

// 同步等待（输入节奏控制）
const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { } };

// 消息文本输入（纯 Windows 消息: 无 UIA/无 PowerShell/无系统焦点依赖, 后台与遮挡均可用）
// append=true: 点击定位光标 -> END 到末尾 -> WM_CHAR 逐字符追加
// append=false: 点击 + 两击 WM_LBUTTONDBLCLK 全选(第2/3击必须为 DBLCLK, Chromium 靠它计数)
//              -> WM_CHAR 覆盖
// 是否可输入由调用方先用 uia-probe 判定; 本函数只负责投递, 不做任何探测
// sx/sy 为截图像素坐标(=窗口客户区坐标); 成功返回 true, 缺失/投递失败抛错
function sendTextInput(sx, sy, text, append) {
  const w = getWindow();
  if (!w) throw new Error('未找到花妖窗口');
  ensureVisible(w.hwnd);
  const rwhwnd = w.rwhwnd || findRenderWidgetHwnd(w.hwnd);
  if (!rwhwnd) throw new Error('未找到 WebView2 输入通道');
  w.rwhwnd = rwhwnd;
  const origin = clientOrigin(w.hwnd);
  const ro = clientOrigin(rwhwnd);
  const cx = origin.x + sx - ro.x;
  const cy = origin.y + sy - ro.y;
  const lpClick = ((cy & 0xffff) << 16) | (cx & 0xffff);
  const post = (msg, wp, lp) => {
    if (!PostMessageW(rwhwnd, msg, wp, lp >>> 0)) {
      throw new Error('消息投递失败 (msg=0x' + msg.toString(16) + ')');
    }
  };
  // 点击定位光标
  post(WM_MOUSEMOVE, 0, lpClick);
  sleepSync(30);
  post(WM_LBUTTONDOWN, 1, lpClick);
  post(WM_LBUTTONUP, 0, lpClick);
  sleepSync(200);
  if (append) {
    post(0x0100, 0x23, 0x01004F01);   // WM_KEYDOWN END: 光标移到末尾
    post(0x0101, 0x23, 0xC04F0001);   // WM_KEYUP END
    sleepSync(40);
  } else {
    post(WM_LBUTTONDBLCLK, 1, lpClick); // 全选: 第2击
    post(WM_LBUTTONUP, 0, lpClick);
    sleepSync(60);
    post(WM_LBUTTONDBLCLK, 1, lpClick); // 第3击: 选区扩大到整行
    post(WM_LBUTTONUP, 0, lpClick);
    sleepSync(250);
  }
  for (let i = 0; i < text.length; i++) {
    post(WM_CHAR, text.charCodeAt(i), 0);   // WM_CHAR 按 UTF-16 码元逐个投递
  }
  sleepSync(250);
  return true;
}

export {
  captureImage,
  clientClick,
  clientOrigin,
  sendTextInput,
  getTargetPid,
  invalidate,
  getWindow,
};
