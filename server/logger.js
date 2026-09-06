// 操作日志: 记录每次点击/输入/截图请求与结果, 供远程调试真实用户操作。
// .env 可配 CONTROL_LOG=0 进入静默模式(仅记录失败与安全闸拦截), 默认 1=全量记录。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

const CONTROL_LOG = path.join(ROOT, 'data', 'logs', 'control.log');
const CONTROL_LOG_VERBOSE = (process.env.CONTROL_LOG ?? '1') !== '0';

export function logControl(msg) {
  try {
    if (!CONTROL_LOG_VERBOSE && !/FAIL|unavailable|reject|error/i.test(msg)) return;
    fs.mkdirSync(path.dirname(CONTROL_LOG), { recursive: true });
    if (fs.existsSync(CONTROL_LOG) && fs.statSync(CONTROL_LOG).size > 1024 * 1024) {
      fs.writeFileSync(CONTROL_LOG, new Date().toISOString() + ' (rotated: 1MB cap)\n');
    }
    fs.appendFileSync(CONTROL_LOG, new Date().toISOString().slice(11, 23) + ' ' + msg + '\n');
  } catch { }
}
