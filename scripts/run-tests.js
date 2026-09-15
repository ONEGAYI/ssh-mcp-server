#!/usr/bin/env node

/**
 * 测试运行器
 * 使用 Node.js 内置的测试框架运行所有测试
 */

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('..', import.meta.url));

// The three VM suites deploy remote helpers and must not race each other
// (their own headers ask to run serially and separately). When the VM
// workspace variable is set, run them first with file-level concurrency 1;
// the remaining local suites keep the default parallel scheduling.
const vmSuites = [
  'test/largefile-acceptance.test.js',
  'test/job-cli-remote.test.js',
  'test/workspace-mcp-remote.test.js',
];
// Truthiness matches the suites' own `skip: !profile` gate, so an empty
// string does not trigger the two-step VM path over fully skipped suites.
const vmMode = !!process.env.SSH_MCP_TEST_WORKSPACE;

console.log('🧪 运行测试...\n');

try {
  execFileSync(process.execPath, ['scripts/build.js'], {
    stdio: 'inherit',
    cwd: rootDir
  });
  if (vmMode) {
    console.log('🖥️  检测到 SSH_MCP_TEST_WORKSPACE，VM 套件串行优先...\n');
    execFileSync(process.execPath, ['--test', '--test-concurrency=1', ...vmSuites], {
      stdio: 'inherit',
      cwd: rootDir
    });
    const localSuites = readdirSync(join(rootDir, 'test'))
      .filter((file) => file.endsWith('.test.js') && !vmSuites.includes('test/' + file))
      .map((file) => join('test', file));
    execFileSync(process.execPath, ['--test', ...localSuites], {
      stdio: 'inherit',
      cwd: rootDir
    });
  } else {
    execFileSync(process.execPath, ['--test', 'test/**/*.test.js'], {
      stdio: 'inherit',
      cwd: rootDir
    });
  }
} catch (err) {
  process.exit(1);
}
