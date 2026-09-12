import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

it('lists local pending tasks without connecting to an unavailable SSH server', () => {
  const root = mkdtempSync(join(tmpdir(), 'ssh-mcp-job-cli-'));
  try {
    writeFileSync(join(root, 'ssh.json'), JSON.stringify({ vm: { host: '127.0.0.1', port: 1, username: 'test', password: 'fixture' } }));
    writeFileSync(join(root, 'workspace.json'), JSON.stringify({ workspaceId: 'offline-registry', connectionName: 'vm',
      sshConfigFile: 'ssh.json', remoteRoot: '/work', remoteStateDir: '/tmp/agent-state', localStateDir: 'state' }));
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('../build/cli/job.js', import.meta.url)),
      'pending', '--workspace', join(root, 'workspace.json'), '--session', 'session-one'], { encoding: 'utf8', timeout: 3000 });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}\n${run.error ?? ''}`);
    assert.deepEqual(JSON.parse(run.stdout).tasks, []);
  } finally {
    const child = relative(tmpdir(), root);
    assert.ok(child && !isAbsolute(child) && !child.startsWith('..'));
    rmSync(root, { recursive: true, force: true });
  }
});
