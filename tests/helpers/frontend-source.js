// 前端无构建步骤: 测试直接从源码截取真实函数执行(改了前端就会被测试覆盖, 而不是测一份复印的逻辑)。
// 协议类测试还需要"后端真实帧 + 前端真实解析"对照, 故把源码读取/函数截取抽成共享工具。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const appSrc = readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
export const htmlSrc = readFileSync(path.join(root, 'public/index.html'), 'utf8');

// 按花括号配对截取函数源码
export function extractFn(name, src = appSrc) {
  const i = src.indexOf('function ' + name);
  if (i < 0) throw new Error('未找到函数: ' + name);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return src.slice(i, j + 1);
  }
  throw new Error('括号不匹配: ' + name);
}

// 执行真实源码: 声明区(prelude, 用于 let 基准变量) + 若干函数源码, 返回指定符号
export function execSource(decls, fnNames, ret, prelude = '') {
  const body = prelude + '\n' + fnNames.map(n => extractFn(n)).join('\n');
  return new Function(...Object.keys(decls), body + '\n return ' + ret + ';')(...Object.values(decls));
}
