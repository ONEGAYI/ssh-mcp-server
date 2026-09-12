import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, relative, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';

it('unrestricted scope flows to helper calls while legacy profiles stay restricted and identity-stable', async () => {
  const { loadWorkspaceConfig } = await import('../build/config/workspace.js');
  const { FileService } = await import('../build/services/file-service.js');
  const { configureFromTool } = await import('../build/core/setup-server.js');
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-scope-'));
  try {
    const auth = join(root, 'ssh.json');
    await writeFile(auth, JSON.stringify({ vm: { host: '127.0.0.1', port: 22, username: 'test', password: 'fixture' } }));
    const common = { localRoot: root, sshConfigFile: auth, connectionName: 'vm', remoteStateDir: '/state', localStateDir: join(root, 'state') };

    const legacy = await configureFromTool({ ...common, remoteRoot: '/work' });
    assert.equal('directoryScope' in JSON.parse(await readFile(legacy.profilePath, 'utf8')), false,
      're-running legacy setups must keep producing byte-identical profiles');
    const open = await configureFromTool({ ...common, bindingName: 'open', remoteRoot: '/home/eda', directoryScope: 'unrestricted' });
    assert.equal(JSON.parse(await readFile(open.profilePath, 'utf8')).directoryScope, 'unrestricted');
    await assert.rejects(configureFromTool({ ...common, bindingName: 'bad', remoteRoot: '/x', directoryScope: 'sometimes' }), { code: 'SETUP_INVALID_SCOPE' });

    const legacyConfig = await loadWorkspaceConfig(legacy.profilePath);
    const openConfig = await loadWorkspaceConfig(open.profilePath);
    assert.equal(legacyConfig.directoryScope, 'restricted');
    assert.equal(openConfig.directoryScope, 'unrestricted');

    const manual = join(root, 'manual.json');
    const base = { workspaceId: 'scope-check', connectionName: 'vm', sshConfigFile: auth, remoteRoot: '/work', remoteStateDir: '/state', localStateDir: 'state' };
    await writeFile(manual, JSON.stringify(base));
    const before = await loadWorkspaceConfig(manual);
    await writeFile(manual, JSON.stringify({ ...base, directoryScope: 'unrestricted' }));
    assert.equal((await loadWorkspaceConfig(manual)).identity, before.identity,
      'adding a scope field must not rekey existing task ownership');

    const calls = [];
    const remote = { async call(action, request) { calls.push({ action, request }); return {}; } };
    await new FileService(remote, openConfig).call('file_read', 'session', { path: '/etc/hosts' });
    await new FileService(remote, legacyConfig).call('file_read', 'session', { path: 'file.txt' });
    assert.equal(calls[0].request.directoryScope, 'unrestricted');
    assert.equal(calls[1].request.directoryScope, 'restricted');
    assert.equal(calls[0].request.workspaceRoot, '/home/eda');
  } finally {
    const child = relative(tmpdir(), root);
    assert.ok(child && !isAbsolute(child) && !child.startsWith('..'));
    await rm(root, { recursive: true, force: true });
  }
});

it('recovery context states the binding directory scope', async () => {
  const { configureFromTool } = await import('../build/core/setup-server.js');
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-scope-hook-'));
  try {
    const auth = join(root, 'ssh.json');
    await writeFile(auth, JSON.stringify({ vm: { host: '127.0.0.1', port: 22, username: 'test', password: 'fixture' } }));
    const open = await configureFromTool({ localRoot: root, sshConfigFile: auth, connectionName: 'vm',
      remoteRoot: '/home/eda', remoteStateDir: '/state', localStateDir: join(root, 'state'),
      bindingName: 'open', directoryScope: 'unrestricted' });
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('../build/cli/recovery.js', import.meta.url)), '--workspace', open.profilePath], {
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'session-a', cwd: root }), encoding: 'utf8', timeout: 10000,
    });
    assert.equal(run.status, 0, run.stdout + '\n' + run.stderr);
    const context = JSON.parse(run.stdout).hookSpecificOutput.additionalContext;
    assert.ok(context.includes('unrestricted'), context);
    assert.ok(context.includes('连接：vm'), 'Recovery identifies the preset connection of this binding');
  } finally {
    const child = relative(tmpdir(), root);
    assert.ok(child && !isAbsolute(child) && !child.startsWith('..'));
    await rm(root, { recursive: true, force: true });
  }
});
