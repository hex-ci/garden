// 环境与配置: .env 加载(零依赖解析) + 全局常量。所有模块从此处取配置。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ROOT = 项目根目录(server/ 的上一级); .env / data/ / public/ 均相对它解析
export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ---- 本地环境配置加载(零依赖 .env 解析) ----
// 优先级: 系统环境变量 > .env 文件 > 代码内默认值。.env 已被 .gitignore 排除, 不随仓库分发。
function loadEnvFile() {
  const envFile = path.join(ROOT, '.env');
  try {
    if (!fs.existsSync(envFile)) return;
    const lines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const [, key, raw] = m;
      if (!(key in process.env)) process.env[key] = raw.replace(/^["']|["']$/g, '');
    }
  } catch { /* .env 加载失败不影响启动 */ }
}

loadEnvFile();

// ---- HTTP 服务 ----
export const HOST = process.env.HOST || '0.0.0.0';
export const PORT = Number(process.env.PORT) || 13000;

// ---- 前端静态资源 ----
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const INDEX_FILE = path.join(PUBLIC_DIR, 'index.html');

// ---- 花妖程序更新(可配置, 地址可能随 CDN 变动而改) ----
// GARDEN_DOWNLOAD_URL: 完整下载地址, 其中 {v} 会被替换为目标版本号。
//   真实 CDN 地址属敏感信息, 不内置默认值, 必须由用户在 .env 中自行配置;
//   未配置时更新功能不可用(后端返回提示, 前端面板也会提示)。
// GARDEN_INSTALL_DIR:  解压/安装目录(相对 ROOT 或绝对路径), 默认 ROOT 下 data/garden/
// GARDEN_EXE_NAME:     解压后需要启动的主程序文件名, 其中 {v} 会被替换为目标版本号
export const GARDEN_DOWNLOAD_URL = (process.env.GARDEN_DOWNLOAD_URL || '').trim();
export const GARDEN_INSTALL_DIR = path.resolve(ROOT, process.env.GARDEN_INSTALL_DIR || 'data/garden');
export const GARDEN_EXE_NAME = process.env.GARDEN_EXE_NAME || 'garden-v{v}-x64.exe';
export const GARDEN_VERSIONS_FILE = path.join(GARDEN_INSTALL_DIR, 'version.json');
export const GARDEN_LOG_FILE = path.join(GARDEN_INSTALL_DIR, 'update.log');

// 从 exe 名模板推导进程名前缀(用于匹配带版本号的运行进程): "garden-v{v}-x64.exe" -> "garden-v"
export const GARDEN_PROC_PREFIX = GARDEN_EXE_NAME.split('{v}')[0].toLowerCase();
