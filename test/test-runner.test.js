import { it } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

it('runs build and tests from the project directory even when its path contains spaces and Unicode', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'ssh-mcp runner 空格 '));
  try {
    mkdirSync(join(fixture, 'scripts'));
    mkdirSync(join(fixture, 'test'));
    writeFileSync(join(fixture, 'package.json'), JSON.stringify({ type: 'module' }));
    copyFileSync(new URL('../scripts/run-tests.js', import.meta.url), join(fixture, 'scripts/run-tests.js'));
    writeFileSync(join(fixture, 'scripts/build.js'),
      `import {writeFileSync} from 'node:fs'; writeFileSync('built.json', JSON.stringify(process.cwd()));`);
    writeFileSync(join(fixture, 'test/fixture.test.js'),
      `import {readFileSync,realpathSync,writeFileSync} from 'node:fs'; import assert from 'node:assert/strict';
assert.equal(realpathSync(JSON.parse(readFileSync('built.json','utf8'))), ${JSON.stringify(realpathSync(fixture))});
writeFileSync('tested.txt', 'FIXTURE_TEST_PASSED');`);
    const { NODE_TEST_CONTEXT, ...childEnv } = process.env;
    const result = spawnSync(process.execPath, [join(fixture, 'scripts/run-tests.js')], {
      cwd: resolve(tmpdir()), encoding: 'utf8', timeout: 15000,
      env: childEnv,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error ?? ''}`);
    assert.equal(readFileSync(join(fixture, 'tested.txt'), 'utf8'), 'FIXTURE_TEST_PASSED');
  } finally {
    const resolvedFixture = realpathSync(fixture);
    const resolvedTemp = realpathSync(tmpdir());
    assert.ok(resolvedFixture.startsWith(resolvedTemp + (process.platform === 'win32' ? '\\' : '/')));
    rmSync(resolvedFixture, { recursive: true, force: true });
  }
});
