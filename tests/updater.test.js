// updater.js 单元测试(zip 校验/解压/exe 定位, 使用临时目录夹具)
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isValidZip, extractZip, findGardenExe } from '../server/updater.js';

// 空 zip 的 EOCD 记录(22 字节): PK\x05\x06 + 全零字段 —— yauzl 可正常打开
const EMPTY_ZIP = Buffer.from([0x50, 0x4B, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

let dir;

beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-test-')); });
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('isValidZip', () => {
  it('空 zip(EOCD) 判为有效', () => {
    const f = path.join(dir, 'empty.zip');
    fs.writeFileSync(f, EMPTY_ZIP);
    expect(isValidZip(f)).toBe(true);
  });

  it('非 zip 内容判为无效', () => {
    const f = path.join(dir, 'bad.zip');
    fs.writeFileSync(f, '<html>hello</html>');
    expect(isValidZip(f)).toBe(false);
  });

  it('文件不存在判为无效', () => {
    expect(isValidZip(path.join(dir, 'nope.zip'))).toBe(false);
  });
});

describe('extractZip', () => {
  it('空 zip 解压成功并创建目标目录', async () => {
    const f = path.join(dir, 'e2.zip');
    fs.writeFileSync(f, EMPTY_ZIP);
    const dest = path.join(dir, 'dest1');
    expect(await extractZip(f, dest)).toBe(true);
    expect(fs.existsSync(dest)).toBe(true);
  });

  it('损坏文件解压返回 false', async () => {
    const f = path.join(dir, 'bad2.zip');
    fs.writeFileSync(f, 'not a zip');
    const dest = path.join(dir, 'dest2');
    expect(await extractZip(f, dest)).toBe(false);
  });
});

describe('findGardenExe', () => {
  it('优先精确匹配模板名', () => {
    const root = path.join(dir, 'app1');
    fs.mkdirSync(path.join(root, 'v1.5.3'), { recursive: true });
    fs.writeFileSync(path.join(root, 'v1.5.3', 'garden-v1.5.3-x64.exe'), 'x');
    fs.writeFileSync(path.join(root, 'v1.5.3', 'uninstall.exe'), 'x');
    expect(findGardenExe(root, '1.5.3')).toBe(path.join(root, 'v1.5.3', 'garden-v1.5.3-x64.exe'));
  });

  it('精确名缺失时回退任意 exe', () => {
    const root = path.join(dir, 'app2');
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'sub', 'whatever.exe'), 'x');
    expect(findGardenExe(root, '9.9.9')).toBe(path.join(root, 'sub', 'whatever.exe'));
  });

  it('没有任何 exe 返回 null', () => {
    const root = path.join(dir, 'app3');
    fs.mkdirSync(root, { recursive: true });
    expect(findGardenExe(root, '1.0.0')).toBe(null);
  });
});
