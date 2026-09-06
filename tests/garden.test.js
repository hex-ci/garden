// garden.js 纯函数单元测试(版本号工具/提示文案)
import { describe, it, expect } from 'vitest';
import { nextVersion, parseVersion, versionCompare, gardenMissingMessage } from '../server/garden.js';

describe('版本号工具', () => {
  it('nextVersion 末位 +1', () => {
    expect(nextVersion('1.5.3')).toBe('1.5.4');
    expect(nextVersion('1.5.9')).toBe('1.5.10');
    expect(nextVersion('1.9.9')).toBe('1.9.10');
  });

  it('nextVersion 非法输入返回 null', () => {
    expect(nextVersion('')).toBe(null);
    expect(nextVersion('bad')).toBe(null);
    expect(nextVersion(null)).toBe(null);
  });

  it('parseVersion 解析合法版本', () => {
    expect(parseVersion('1.5.3')).toEqual({ major: 1, minor: 5, patch: 3 });
  });

  it('parseVersion 拒绝非法版本', () => {
    expect(parseVersion('1.5')).toBe(null);
    expect(parseVersion('v1.5.3')).toBe(null);
    expect(parseVersion(null)).toBe(null);
  });

  it('versionCompare 三向比较', () => {
    expect(versionCompare(parseVersion('1.5.3'), parseVersion('1.5.3'))).toBe(0);
    expect(versionCompare(parseVersion('1.5.3'), parseVersion('1.5.4'))).toBe(-1);
    expect(versionCompare(parseVersion('2.0.0'), parseVersion('1.9.9'))).toBe(1);
    expect(versionCompare(null, parseVersion('1.0.0'))).toBe(0);
  });

  it('gardenMissingMessage 按原因给对应文案', () => {
    expect(gardenMissingMessage('exe_missing')).toContain('丢失');
    expect(gardenMissingMessage('no_record')).toContain('尚未安装');
  });
});
