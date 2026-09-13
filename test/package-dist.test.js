import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

test('the dist manifest covers the README, build output and runtime metadata', async () => {
  const { collectDist } = await import('../scripts/package-dist.mjs');
  const entries = await collectDist(root);
  const paths = entries.map(entry => entry.path);
  // A distribution must explain itself: the fork's Chinese README plus the
  // retained upstream English one, the license, and enough metadata for
  // `npm install --omit=dev` on the target machine.
  for (const required of ['README.md', 'README_EN.md', 'LICENSE', 'package.json',
    'build/index.js', 'build/cli/job.js', 'build/remote/agent.py', 'build/remote/reclaim.py']) {
    assert.ok(paths.includes(required), `dist is missing ${required}`);
  }
});

test('package-dist produces a tarball containing the README and the server entry', { timeout: 120000 }, async () => {
  const output = await mkdtemp(join(tmpdir(), 'pkg-dist-'));
  // --no-build: npm test has just rebuilt build/ via scripts/build.js.
  execFileSync(process.execPath, ['scripts/package-dist.mjs', '--no-build', '--output', output],
    { cwd: root, stdio: 'pipe' });
  const archives = (await readdir(output)).filter(name => name.endsWith('.tar.gz'));
  assert.equal(archives.length, 1, `expected exactly one tarball, found ${archives.join(', ')}`);
  // Relative name + cwd: a Windows drive letter in the argument reads as a
  // remote host to GNU tar.
  const listing = execFileSync('tar', ['-tzf', archives[0]], { cwd: output, encoding: 'utf8' });
  assert.match(listing, /README\.md$/m);
  assert.match(listing, /build\/index\.js$/m);
});
