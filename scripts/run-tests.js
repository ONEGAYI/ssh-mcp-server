#!/usr/bin/env node

/**
 * 测试运行器
 * 使用 Node.js 内置的测试框架运行所有测试
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('..', import.meta.url));

console.log('🧪 运行测试...\n');

try {
  execFileSync(process.execPath, ['scripts/build.js'], {
    stdio: 'inherit',
    cwd: rootDir
  });
  execFileSync(process.execPath, ['--test', 'test/**/*.test.js'], {
    stdio: 'inherit',
    cwd: rootDir
  });
} catch (err) {
  process.exit(1);
}
