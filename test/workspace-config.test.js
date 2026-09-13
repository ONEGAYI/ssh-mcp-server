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

it('resolves workspace policy defaults and reloads the latest value on every read', async () => {
  let load, loadPolicy;
  try { ({ loadWorkspaceConfig: load } = await import('../build/config/workspace.js')); }
  catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
  try { ({ loadPolicy } = await import('../build/config/policy.js')); }
  catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
  assert.equal(typeof loadPolicy, 'function', 'Workspace policy loader is not implemented');
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-policy-'));
  try {
    await writeFile(join(root, 'ssh.json'), JSON.stringify({ vm: { host: '127.0.0.1', port: 22, username: 'test', password: 'fixture' } }));
    const profile = { workspaceId: 'policy-test', connectionName: 'vm', sshConfigFile: 'ssh.json',
      remoteRoot: '/work', remoteStateDir: '/state' };
    const profilePath = join(root, 'workspace.json');
    await writeFile(profilePath, JSON.stringify(profile));
    const defaults = (await load(profilePath)).policy;
    assert.equal(defaults.limits.localWorkspaceBytes, 10737418240);
    assert.equal(defaults.limits.remoteWorkspaceBytes, 10737418240);
    assert.equal(defaults.retention.confirmedTaskLogMs, 3 * 86400000);
    assert.equal(defaults.retention.confirmedResultMs, 30 * 86400000);
    assert.equal(defaults.retention.readTokenMs, 3 * 86400000);
    assert.equal(defaults.search.respectGitignore, false);
    assert.equal(defaults.search.includeHidden, true);
    assert.equal(defaults.search.scanBudgetBytes, 536870912);
    assert.equal(defaults.maintenance.intervalMs, 3600000);
    await writeFile(profilePath, JSON.stringify({ ...profile, policy: { limits: { remoteWorkspaceBytes: 1 },
      maintenance: { intervalMs: 60000 } } }));
    const overridden = (await load(profilePath)).policy;
    assert.equal(overridden.limits.remoteWorkspaceBytes, 1);
    assert.equal(overridden.limits.localWorkspaceBytes, 10737418240, 'unnamed leaves keep their defaults');
    assert.equal(overridden.maintenance.intervalMs, 60000);
    const first = await loadPolicy(profilePath);
    assert.equal(first.maintenance.intervalMs, 60000);
    await writeFile(profilePath, JSON.stringify({ ...profile, policy: { maintenance: { intervalMs: 120000 } } }));
    const second = await loadPolicy(profilePath);
    assert.equal(second.maintenance.intervalMs, 120000, 'policy reads are fresh, not cached across operations');
    assert.equal(first.maintenance.intervalMs, 60000, 'earlier reads are independent snapshots');
  } finally { await rm(root, { recursive: true, force: true }); }
});
