#!/usr/bin/env node

/**
 * Python 契约套件并行运行器
 *
 * 八个 WSL/Unix 套件按文件独立进程并行执行（实测约 80s，串行约 173s；
 * 下限由最长的 remote-discovery 决定），日志按套件顺序回放，任一失败
 * 以退出码 1 结束。位置参数可指定子集（相对仓库根），缺省全量。
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('..', import.meta.url));

const suites = process.argv.length > 2
  ? process.argv.slice(2)
  : [
      'test/remote-agent.test.py',
      'test/remote-discovery.test.py',
      'test/remote-files.test.py',
      'test/remote-ledger.test.py',
      'test/remote-lifecycle-probe.test.py',
      'test/remote-reclaim.test.py',
      'test/remote-space-report.test.py',
      'test/remote-transfer.test.py',
    ];

const singleQuote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;

// One python process per suite; the waits run in list order but the suites
// themselves proceed concurrently, so the wall clock tracks the slowest one.
const script = [
  'logs=$(mktemp -d)',
  'fail=0',
  ...suites.map((suite, index) =>
    `python3 ${singleQuote(suite)} >"$logs/${index}.log" 2>&1 & p${index}=$!`),
  ...suites.map((_, index) => `wait $p${index} || fail=1`),
  // Replay in suite order so the combined output is stable regardless of
  // which parallel run finished first.
  ...suites.flatMap((suite, index) => [
    `echo ${singleQuote(`== ${suite}`)}`,
    `cat "$logs/${index}.log"`,
  ]),
  'rm -rf "$logs"',
  'exit $fail',
].join('\n');

console.log('🐍 并行运行 Python 套件...\n');

try {
  if (process.platform === 'win32') {
    // Feed the script over stdin: wsl.exe wraps its arguments in an extra
    // shell layer, which would expand $-substitutions (logs, pids) before
    // our bash ever sees them.
    execFileSync('wsl.exe', ['bash'], {
      stdio: ['pipe', 'inherit', 'inherit'],
      cwd: rootDir,
      input: script,
    });
  } else {
    execFileSync('bash', ['-c', script], {
      stdio: 'inherit',
      cwd: rootDir,
    });
  }
} catch (err) {
  process.exit(1);
}
