import { it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { setupFromTool } from '../build/core/setup-server.js';
import { loadWorkspaceConfig } from '../build/config/workspace.js';

it('updates session context per binding without changing identity or requiring SSH details', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-context-config-'));
  try {
    const auth = join(root, 'ssh.json');
    await writeFile(auth, JSON.stringify({ vm: { host: '127.0.0.1', port: 1, username: 'fixture', password: 'secret' } }));
    const common = { localRoot: root, sshConfigFile: auth, connectionName: 'vm', remoteStateDir: '/state' };
    const first = await setupFromTool({ ...common, bindingName: 'first', remoteRoot: '/first' });
    const second = await setupFromTool({ ...common, bindingName: 'second', remoteRoot: '/second' });
    const original = await loadWorkspaceConfig(first.profilePath);
    const inspected = await setupFromTool({ action: 'inspect', localRoot: root, bindingName: 'first' });
    assert.deepEqual(inspected.config.sessionStart, { enabled: false, timeoutMs: 5000, maxBytes: 8192 });
    const changed = await setupFromTool({ action: 'update', localRoot: root, bindingName: 'first',
      revision: inspected.revision, sessionStart: { enabled: true, maxBytes: 0 } });
    const after = await loadWorkspaceConfig(first.profilePath);
    assert.equal(after.identity, original.identity);
    assert.deepEqual(after.sessionStart, { enabled: true, timeoutMs: 5000, maxBytes: 0 });
    assert.equal((await loadWorkspaceConfig(second.profilePath)).sessionStart.enabled, false);
    const disabled = await setupFromTool({ action: 'update', localRoot: root, bindingName: 'first',
      revision: changed.revision, sessionStart: { enabled: false } });
    assert.deepEqual((await setupFromTool({ action: 'inspect', localRoot: root, bindingName: 'first' })).config.sessionStart,
      { enabled: false, timeoutMs: 5000, maxBytes: 0 });
    assert.ok(disabled.changed.includes('sessionStart.enabled'));
    await setupFromTool({ action: 'update', localRoot: root, bindingName: 'first', revision: disabled.revision, clients: ['zcode', 'codex'] });
    assert.equal((await loadWorkspaceConfig(first.profilePath)).identity, original.identity);
    assert.match(await readFile(join(root, '.codex/config.toml'), 'utf8'), new RegExp(first.serverName));
    assert.doesNotMatch(await readFile(join(root, '.codex/config.toml'), 'utf8'), new RegExp(second.serverName));
    assert.equal(JSON.parse(await readFile(auth, 'utf8')).vm.password, 'secret');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('rolls back profile and all written integrations if a client switch cannot be saved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-context-write-failure-'));
  try {
    const auth = join(root, 'ssh.json');
    await writeFile(auth, JSON.stringify({ vm: { host: '127.0.0.1', port: 1, username: 'test', password: 'fixture' } }));
    const configured = await setupFromTool({ localRoot: root, sshConfigFile: auth, connectionName: 'vm', remoteRoot: '/work', remoteStateDir: '/state' });
    const beforeProfile = await readFile(configured.profilePath, 'utf8');
    const beforeZcode = await readFile(join(root, '.zcode/config.json'), 'utf8');
    for (const destination of [join(root, '.zcode/config.json'), join(root, '.codex/hooks.json')]) {
      const inspected = await setupFromTool({ action: 'inspect', localRoot: root });
      let failed = false;
      const mocks = ['rename', 'link'].map(method => {
        const original = fs[method];
        return mock.method(fs, method, async (source, target, ...rest) => {
          if (target === destination && !failed) { failed = true; throw Object.assign(new Error('fixture denied save'), { code: 'EACCES' }); }
          return original(source, target, ...rest);
        });
      });
      syncBuiltinESMExports();
      try {
        await assert.rejects(setupFromTool({ action: 'update', localRoot: root, revision: inspected.revision, clients: ['codex'] }), { code: 'EACCES' });
        assert.equal(failed, true, 'fixture must reach the filesystem write boundary');
      } finally { for (const entry of mocks) entry.mock.restore(); syncBuiltinESMExports(); }
      assert.equal(await readFile(configured.profilePath, 'utf8'), beforeProfile);
      assert.equal(await readFile(join(root, '.zcode/config.json'), 'utf8'), beforeZcode);
      await assert.rejects(readFile(join(root, '.codex/config.toml')), { code: 'ENOENT' });
      await assert.rejects(readFile(join(root, '.codex/hooks.json')), { code: 'ENOENT' });
    }
    const retry = await setupFromTool({ action: 'inspect', localRoot: root });
    await setupFromTool({ action: 'update', localRoot: root, revision: retry.revision, clients: ['codex'] });
    assert.ok(!(await readFile(join(root, '.zcode/config.json'), 'utf8')).includes(configured.serverName));
    assert.ok((await readFile(join(root, '.codex/config.toml'), 'utf8')).includes(configured.serverName));
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('Codex-only bindings survive CRLF TOML and ignore unrelated broken ZCode config on removal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-codex-crlf-'));
  try {
    const auth = join(root, 'ssh.json');
    await writeFile(auth, JSON.stringify({ vm: { host: '127.0.0.1', port: 1, username: 'test', password: 'fixture' } }));
    const input = { localRoot: root, sshConfigFile: auth, connectionName: 'vm', remoteRoot: '/work', remoteStateDir: '/state', clients: ['codex'] };
    const configured = await setupFromTool(input);
    const path = join(root, '.codex/config.toml');
    await writeFile(path, (await readFile(path, 'utf8')).replace(/\n/g, '\r\n'));
    await setupFromTool(input);
    await mkdir(join(root, '.zcode'));
    await writeFile(join(root, '.zcode/config.json'), '{unrelated broken ZCode config');
    const inspected = await setupFromTool({ action: 'inspect', localRoot: root });
    const removed = await setupFromTool({ action: 'remove', localRoot: root, revision: inspected.revision });
    assert.equal(removed.unhooked.codex.mcpServerEntry, true);
    assert.equal(removed.unhooked.codex.recoveryHooks, 1);
    assert.equal(removed.unhooked.codex.sessionStartHooks, 1);
    assert.equal(await readFile(join(root, '.zcode/config.json'), 'utf8'), '{unrelated broken ZCode config');
    assert.ok(!(await readFile(path, 'utf8')).includes(configured.serverName));
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('rejects invalid or colliding Codex config before changing an existing binding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-client-conflict-'));
  try {
    const auth = join(root, 'ssh.json');
    await writeFile(auth, JSON.stringify({ vm: { host: '127.0.0.1', port: 1, username: 'test', password: 'fixture' } }));
    const configured = await setupFromTool({ localRoot: root, sshConfigFile: auth, connectionName: 'vm', remoteRoot: '/work', remoteStateDir: '/state' });
    const before = await readFile(configured.profilePath, 'utf8');
    const zcode = await readFile(join(root, '.zcode/config.json'), 'utf8');
    const inspected = await setupFromTool({ action: 'inspect', localRoot: root });
    await mkdir(join(root, '.codex'));
    await writeFile(join(root, '.codex/config.toml'), `[mcp_servers.${configured.serverName}]\ncommand = "foreign"\n`);
    await assert.rejects(setupFromTool({ action: 'update', localRoot: root, revision: inspected.revision, clients: ['codex'] }), { code: 'SETUP_CONFLICT' });
    assert.equal(await readFile(configured.profilePath, 'utf8'), before);
    assert.equal(await readFile(join(root, '.zcode/config.json'), 'utf8'), zcode);
    await writeFile(join(root, '.codex/config.toml'), 'broken = [');
    await assert.rejects(setupFromTool({ action: 'update', localRoot: root, revision: inspected.revision, clients: ['codex'] }), { code: 'SETUP_INVALID_CONFIG' });
    assert.equal(await readFile(configured.profilePath, 'utf8'), before);
    for (const sessionStart of [{ timeoutMs: 0 }, { maxBytes: -1 }, { maxBytes: 1023 }, { maxBytes: 16385 }, { enabled: 'yes' }, { unknown: true }]) {
      await assert.rejects(setupFromTool({ action: 'update', localRoot: root, revision: inspected.revision, sessionStart }));
      assert.equal(await readFile(configured.profilePath, 'utf8'), before);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('installs both client integrations idempotently and removes only the addressed binding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-two-clients-'));
  try {
    await mkdir(join(root, '.codex'));
    const foreign = '# keep this comment\nmodel = "fixture-model"\n[mcp_servers.foreign]\ncommand = "foreign-server"\n';
    await writeFile(join(root, '.codex/config.toml'), foreign);
    await writeFile(join(root, '.codex/hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'foreign-hook' }] }] } }));
    const auth = join(root, 'ssh.json');
    await writeFile(auth, JSON.stringify({ vm: { host: '127.0.0.1', port: 1, username: 'test', password: 'fixture' } }));
    const input = { localRoot: root, sshConfigFile: auth, connectionName: 'vm', remoteRoot: '/work', remoteStateDir: '/state', clients: ['zcode', 'codex'] };
    const a = await setupFromTool({ ...input, bindingName: 'a' });
    const b = await setupFromTool({ ...input, bindingName: 'b' });
    const files = ['.zcode/config.json', '.codex/config.toml', '.codex/hooks.json'];
    const before = await Promise.all(files.map(file => readFile(join(root, file), 'utf8')));
    await setupFromTool({ ...input, bindingName: 'a' });
    assert.deepEqual(await Promise.all(files.map(file => readFile(join(root, file), 'utf8'))), before);
    assert.ok(before[1].startsWith(foreign), 'user TOML and comments stay byte-for-byte');
    assert.ok(before[1].includes(a.serverName) && before[1].includes(b.serverName));
    const hooks = JSON.parse(before[2]).hooks;
    assert.equal(hooks.UserPromptSubmit.length, 2);
    assert.equal(hooks.SessionStart.length, 2);
    assert.equal(hooks.Stop[0].hooks[0].command, 'foreign-hook');
    const handler = hooks.UserPromptSubmit[0].hooks[0];
    const run = process.platform === 'win32'
      ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', handler.commandWindows.split(' ').at(-1)], {
        input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'codex-session', cwd: root }), encoding: 'utf8', timeout: 5000 })
      : spawnSync('/bin/sh', ['-c', handler.command], { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'codex-session', cwd: root }), encoding: 'utf8', timeout: 5000 });
    assert.equal(run.status, 0, run.stderr);
    const context = JSON.parse(run.stdout).hookSpecificOutput.additionalContext;
    assert.match(context, /codex-session/);
    assert.match(context, /Codex/);
    assert.doesNotMatch(context, /run_in_background/);
    const inspected = await setupFromTool({ action: 'inspect', localRoot: root, bindingName: 'a' });
    await setupFromTool({ action: 'remove', localRoot: root, bindingName: 'a', revision: inspected.revision });
    const remaining = await readFile(join(root, '.codex/config.toml'), 'utf8');
    assert.ok(remaining.startsWith(foreign));
    assert.ok(!remaining.includes(a.serverName) && remaining.includes(b.serverName));
    const remainingHooks = JSON.parse(await readFile(join(root, '.codex/hooks.json'), 'utf8')).hooks;
    assert.equal(remainingHooks.UserPromptSubmit.length, 1);
    assert.equal(remainingHooks.SessionStart.length, 1);
    assert.equal(remainingHooks.Stop[0].hooks[0].command, 'foreign-hook');
  } finally { await rm(root, { recursive: true, force: true }); }
});
