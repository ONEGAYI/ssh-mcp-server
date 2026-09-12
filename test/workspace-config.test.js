import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';

it('resolves local config references and isolates state by the actual SSH target', async () => {
  let load;
  try { ({ loadWorkspaceConfig: load } = await import('../build/config/workspace.js')); }
  catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
  assert.equal(typeof load, 'function', 'Workspace configuration loader is not implemented');
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-workspace-'));
  try {
    await writeFile(join(root, 'ssh.json'), JSON.stringify({ vm: { host: '127.0.0.1', port: 22, username: 'test', password: 'fixture' } }));
    const profile = { workspaceId: 'test', connectionName: 'vm', sshConfigFile: 'ssh.json',
      remoteRoot: '/work', remoteStateDir: '/home/test/.state', localStateDir: 'state' };
    await writeFile(join(root, 'workspace.json'), JSON.stringify(profile));
    const first = await load(join(root, 'workspace.json'));
    assert.equal(first.sshConfigFile, join(root, 'ssh.json'));
    assert.equal(first.localStateDir, join(root, 'state'));
    assert.equal(first.sshConfigs.vm.host, '127.0.0.1');
    await writeFile(join(root, 'ssh.json'), JSON.stringify({ vm: { host: '127.0.0.2', port: 22, username: 'test', password: 'fixture' } }));
    const second = await load(join(root, 'workspace.json'));
    assert.notEqual(first.identity, second.identity);
    assert.notEqual(first.remoteStateDir, second.remoteStateDir);
  } finally {
    const child = relative(tmpdir(), root);
    assert.ok(child && !isAbsolute(child) && !child.startsWith('..'));
    await rm(root, { recursive: true, force: true });
  }
});
