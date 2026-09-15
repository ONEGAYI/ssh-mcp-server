import { it } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

/** Python availability gate: the parallel runner shells out to python3,
 * through wsl.exe on Windows. Suites stay skipped where neither exists. */
function pythonAvailable() {
  if (process.platform === 'win32') {
    const probe = spawnSync('wsl.exe', ['python3', '--version'], { encoding: 'utf8', timeout: 15000 });
    return probe.status === 0;
  }
  return spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0;
}
const available = pythonAvailable();

function writeMiniSuite(directory, name, body) {
  writeFileSync(join(directory, `test/${name}`),
    `import unittest\n\nclass Mini(unittest.TestCase):\n${body}\n\nif __name__ == '__main__':\n    unittest.main()\n`);
}

it('runs the given python suites in parallel and propagates any failure', { skip: !available }, () => {
  const fixture = mkdtempSync(join(tmpdir(), 'ssh-mcp py-runner 空格 '));
  try {
    mkdirSync(join(fixture, 'scripts'));
    mkdirSync(join(fixture, 'test'));
    copyFileSync(new URL('../scripts/run-python-tests.js', import.meta.url), join(fixture, 'scripts/run-python-tests.js'));
    writeMiniSuite(fixture, 'mini-ok-a.test.py', '    def test_ok(self):\n        self.assertTrue(True)');
    writeMiniSuite(fixture, 'mini-ok-b.test.py', '    def test_ok(self):\n        self.assertTrue(True)');
    writeMiniSuite(fixture, 'mini-fail.test.py', '    def test_boom(self):\n        self.fail("boom marker")');
    const suites = ['test/mini-ok-a.test.py', 'test/mini-ok-b.test.py', 'test/mini-fail.test.py'];

    // The failing suite decides the exit code while both passing suites still report OK.
    const failed = spawnSync(process.execPath,
      [join(fixture, 'scripts/run-python-tests.js'), ...suites],
      { cwd: resolve(fixture), encoding: 'utf8', timeout: 60000 });
    assert.equal(failed.status, 1, `${failed.stdout}\n${failed.stderr}\n${failed.error ?? ''}`);
    assert.match(failed.stdout, /boom marker/);
    assert.equal(failed.stdout.match(/^OK$/gm).length, 2, failed.stdout);

    // With only the passing suites the same command exits zero.
    const passed = spawnSync(process.execPath,
      [join(fixture, 'scripts/run-python-tests.js'), 'test/mini-ok-a.test.py', 'test/mini-ok-b.test.py'],
      { cwd: resolve(fixture), encoding: 'utf8', timeout: 60000 });
    assert.equal(passed.status, 0, `${passed.stdout}\n${passed.stderr}\n${passed.error ?? ''}`);
    assert.equal(passed.stdout.match(/^OK$/gm).length, 2, passed.stdout);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
