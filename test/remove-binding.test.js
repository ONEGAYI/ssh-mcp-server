// Issue #28/#32/#33: the remove action's contract. Removal is a local-only
// decommission: revision-guarded, hard-blocked by unacknowledged work from any
// session, surgical against sibling bindings and foreign config, and honest
// about what stays (external SSH configs, the remote state directory).
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { legacyV3 } from './legacy-doc-generations.mjs';
import { loadWorkspaceConfig, identityStateDirectory } from '../build/config/workspace.js';
import { TaskService } from '../build/services/task-service.js';
import { removeWorkspaceBinding } from '../build/services/workspace-setup.js';
import * as setupServer from '../build/core/setup-server.js';
const { configureFromTool, setupFromTool } = setupServer;

function fakeRemote() {
  let sequence = 0;
  return {
    async call(action, request) {
      if (action === 'task_register') return { jobId: 'job-' + (++sequence), state: 'prepared' };
      if (action === 'task_start') return { jobId: request.jobId, state: 'running' };
      if (action === 'status') return { jobId: request.jobId, state: 'exited', exitCode: 0, completedAt: 100 };
      if (action === 'ack') return { acknowledged: true, jobId: request.jobId };
      throw new Error('Unexpected action ' + action);
    },
  };
}

it('remove takes out exactly one binding and reports the remote directory without connecting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-remove-'));
  try {
    const ssh = join(root, 'ssh.json');
    await writeFile(ssh, JSON.stringify({
      eda: { host: '127.0.0.1', port: 22, username: 'test', password: 'secret-never-shown' },
      other: { host: '127.0.0.2', port: 22, username: 'test', password: 'secret-never-shown' } }));
    const common = { localRoot: root, sshConfigFile: ssh, remoteStateDir: '/state', localStateDir: join(root, 'state') };
    const main = await configureFromTool({ ...common, bindingName: 'eda-main', connectionName: 'eda', remoteRoot: '/main' });
    const build = await configureFromTool({ ...common, bindingName: 'builder', connectionName: 'other', remoteRoot: '/build' });
    // A finished, acknowledged task leaves removable state behind on the main binding.
    const configMain = await loadWorkspaceConfig(main.profilePath);
    const tasks = new TaskService(fakeRemote(), configMain.localStateDir, configMain.identity);
    const done = await tasks.start({ sessionId: 'owner', cwd: '/main', command: 'make' });
    await tasks.acknowledge(done.jobId, 'owner');
    // The sibling keeps unfinished work from yet another session: it must not block this removal.
    const configBuild = await loadWorkspaceConfig(build.profilePath);
    await new TaskService(fakeRemote(), configBuild.localStateDir, configBuild.identity)
      .start({ sessionId: 'someone-else', cwd: '/build', command: 'make test' });

    const inspected = await setupFromTool({ action: 'inspect', localRoot: root, bindingName: 'eda-main' });
    const removed = await setupFromTool({ action: 'remove', localRoot: root, bindingName: 'eda-main', revision: inspected.revision });

    assert.equal(removed.status, 'removed');
    assert.equal(removed.serverName, main.serverName);
    assert.deepEqual(removed.unhooked, { mcpServerEntry: true, recoveryHooks: 1 });
    assert.equal(removed.connectionFile.removed, false, 'the external SSH config stays');
    assert.ok(await readFile(ssh, 'utf8'), 'the external SSH config file survives');
    assert.equal(removed.remoteStateDir, configMain.remoteStateDir);
    assert.match(removed.instructions, /No SSH connection/, 'the report states the zero-connection promise');
    assert.match(removed.instructions, /manual/, 'the report explains the remote directory needs manual cleanup');
    assert.match(removed.instructions, /gitignore/, 'the report keeps the .gitignore suggestion from the #28 decisions');
    assert.equal(removed.lastBinding, false);
    assert.ok(!('legacyDocs' in removed), 'shared documents are untouched while a sibling binding remains');
    assert.doesNotMatch(JSON.stringify(removed), /secret-never-shown/, 'no credentials leak into the report');
    await assert.rejects(readFile(main.profilePath), { code: 'ENOENT' }, 'the removed profile is gone');
    assert.equal(JSON.parse(await readFile(build.profilePath, 'utf8')).bindingName, 'builder');
    const config = JSON.parse(await readFile(join(root, '.zcode', 'config.json'), 'utf8'));
    assert.ok(!config.mcp.servers[main.serverName], 'the removed MCP entry is gone');
    assert.ok(config.mcp.servers[build.serverName], 'the sibling MCP entry stays');
    const groups = config.hooks.events.UserPromptSubmit;
    assert.equal(groups.length, 1, 'only the sibling recovery hook group stays');
    assert.equal(groups[0].hooks[0].args.at(-1), build.profilePath);
    await assert.rejects(readdir(identityStateDirectory(configMain.localStateDir, configMain.identity)), { code: 'ENOENT' },
      'the removed binding local identity directory is deleted');
    const kept = await readdir(join(identityStateDirectory(configBuild.localStateDir, configBuild.identity), 'tasks'));
    assert.equal(kept.length, 1, 'the sibling task registration survives');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('remove hard-rejects while any session has unacknowledged tasks or transfers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-remove-pending-'));
  try {
    const ssh = join(root, 'ssh.json');
    await writeFile(ssh, JSON.stringify({ eda: { host: '127.0.0.1', port: 22, username: 'test', password: 'x' } }));
    const configured = await configureFromTool({ localRoot: root, sshConfigFile: ssh, connectionName: 'eda',
      remoteRoot: '/work', remoteStateDir: '/state', localStateDir: join(root, 'state') });
    const inspected = await setupFromTool({ action: 'inspect', localRoot: root });
    const remove = () => setupFromTool({ action: 'remove', localRoot: root, revision: inspected.revision });
    const config = await loadWorkspaceConfig(configured.profilePath);

    // Another conversation's unfinished task blocks removal (binding-level, not session-filtered).
    const tasks = new TaskService(fakeRemote(), config.localStateDir, config.identity);
    const other = await tasks.start({ sessionId: 'someone-else', cwd: '/work', command: 'build' });
    await assert.rejects(remove(), error => error.code === 'SETUP_PENDING_OPERATIONS'
      && error.message.includes(other.jobId) && /acknowledge|cancel/i.test(error.message),
      'the rejection names the pending work and the resolution path');
    assert.ok(await readFile(configured.profilePath, 'utf8'), 'a rejected removal leaves the profile in place');

    // Acknowledged task, but a pending transfer still blocks.
    await tasks.acknowledge(other.jobId, 'someone-else');
    const transferId = 'a'.repeat(32);
    const transferDir = join(identityStateDirectory(config.localStateDir, config.identity), 'transfers', transferId);
    await mkdir(transferDir, { recursive: true });
    await writeFile(join(transferDir, 'record.json'), JSON.stringify({ schemaVersion: 1, transferId,
      workspaceId: config.workspaceId, sessionId: 'someone-else', direction: 'upload', localPath: 'x',
      remotePath: '/x', totalBytes: 1, totalSha256: '0'.repeat(64), chunkSize: 1, overwrite: false,
      create: true, expectedVersion: null, createdAt: new Date().toISOString() }));
    await assert.rejects(remove(), error => error.code === 'SETUP_PENDING_OPERATIONS' && error.message.includes(transferId));

    // Acknowledging the transfer unblocks removal.
    await writeFile(join(transferDir, 'ack.json'), JSON.stringify({ transferId, state: 'completed', acknowledgedAt: new Date().toISOString() }));
    assert.equal((await remove()).status, 'removed');
    await assert.rejects(readFile(configured.profilePath), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('remove is revision-guarded and reports missing bindings without side effects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-remove-revision-'));
  try {
    const ssh = join(root, 'ssh.json');
    await writeFile(ssh, JSON.stringify({ eda: { host: '127.0.0.1', port: 22, username: 'test', password: 'x' } }));
    await configureFromTool({ localRoot: root, sshConfigFile: ssh, connectionName: 'eda',
      remoteRoot: '/work', remoteStateDir: '/state', localStateDir: join(root, 'state') });
    const first = await setupFromTool({ action: 'inspect', localRoot: root });
    await assert.rejects(setupFromTool({ action: 'remove', localRoot: root, bindingName: 'ghost', revision: first.revision }),
      { code: 'SETUP_PROFILE_NOT_FOUND' });
    await assert.rejects(setupFromTool({ action: 'remove', localRoot: root }), { code: 'SETUP_REVISION_REQUIRED' });
    // A policy update moves the revision on: the stale token must be refused.
    await setupFromTool({ action: 'update', localRoot: root, revision: first.revision, policy: { search: { scanBudgetBytes: 1048576 } } });
    await assert.rejects(setupFromTool({ action: 'remove', localRoot: root, revision: first.revision }), { code: 'SETUP_CONFLICT' });
    const second = await setupFromTool({ action: 'inspect', localRoot: root });
    assert.equal((await setupFromTool({ action: 'remove', localRoot: root, revision: second.revision })).status, 'removed');
    await assert.rejects(setupFromTool({ action: 'remove', localRoot: root, revision: second.revision }),
      { code: 'SETUP_PROFILE_NOT_FOUND' }, 'a repeated removal is a plain not-found');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('remove keeps empty nodes and foreign entries, deletes the generated connection file, and aborts before any deletion when the project config is invalid', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-remove-nodes-'));
  try {
    await mkdir(join(root, '.zcode'));
    const configPath = join(root, '.zcode', 'config.json');
    await writeFile(configPath, JSON.stringify({ mcp: { servers: { existing: { command: 'keep' } } }, hooks: { enabled: true, events: { Stop: [] } } }));
    // Inline SSH fields make configure generate .ssh-mcp-connection.json (port 1 is never contacted).
    await configureFromTool({ localRoot: root, host: '127.0.0.1', port: 1, username: 'test', sshAgent: 'pageant',
      remoteRoot: '/work', remoteStateDir: '/state', localStateDir: join(root, 'state') });
    const profilePath = join(root, '.ssh-mcp-workspace.json');
    const generated = join(root, '.ssh-mcp-connection.json');
    const inspected = await setupFromTool({ action: 'inspect', localRoot: root });
    const remove = () => setupFromTool({ action: 'remove', localRoot: root, revision: inspected.revision });

    // An invalid project config stops removal before any file is touched.
    const good = await readFile(configPath, 'utf8');
    await writeFile(configPath, '{"mcp":{"servers":"not-an-object"}}');
    await assert.rejects(remove(), { code: 'SETUP_INVALID_CONFIG' });
    assert.ok(await readFile(profilePath, 'utf8'), 'the profile survives an aborted removal');
    await writeFile(configPath, good);

    const removed = await remove();
    assert.equal(removed.status, 'removed');
    assert.equal(removed.connectionFile.removed, true, 'the generated connection file is deleted');
    assert.ok(removed.connectionFile.path.endsWith('.ssh-mcp-connection.json'));
    await assert.rejects(readFile(generated), { code: 'ENOENT' });
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    assert.deepEqual(config.mcp.servers, { existing: { command: 'keep' } }, 'foreign servers stay, the node survives empty-free');
    assert.deepEqual(config.hooks.events.UserPromptSubmit, [], 'an emptied hook event stays as an empty node');
    assert.deepEqual(config.hooks.events.Stop, []);
    assert.equal(config.hooks.enabled, true);
    assert.equal(removed.lastBinding, true, 'the kept foreign server is not a workspace binding');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('remove reclaims legacy generated documents only when the last binding goes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-remove-docs-'));
  try {
    const ssh = join(root, 'ssh.json');
    await writeFile(ssh, JSON.stringify({
      eda: { host: '127.0.0.1', port: 22, username: 'test', password: 'x' },
      other: { host: '127.0.0.2', port: 22, username: 'test', password: 'x' } }));
    const common = { localRoot: root, sshConfigFile: ssh, remoteStateDir: '/state', localStateDir: join(root, 'state') };
    await configureFromTool({ ...common, bindingName: 'eda-main', connectionName: 'eda', remoteRoot: '/main' });
    await configureFromTool({ ...common, bindingName: 'builder', connectionName: 'other', remoteRoot: '/build' });
    await writeFile(join(root, 'AGENTS.md'), legacyV3);
    await writeFile(join(root, 'CLAUDE.md'), '@AGENTS.md\n');
    await writeFile(join(root, 'SSH-WORKSPACE-GUIDE.md'), legacyV3);

    const first = await setupFromTool({ action: 'remove', localRoot: root, bindingName: 'eda-main',
      revision: (await setupFromTool({ action: 'inspect', localRoot: root, bindingName: 'eda-main' })).revision });
    assert.equal(first.lastBinding, false);
    assert.ok(!('legacyDocs' in first));
    for (const name of ['AGENTS.md', 'CLAUDE.md', 'SSH-WORKSPACE-GUIDE.md']) {
      assert.ok(await readFile(join(root, name), 'utf8'), name + ' stays while a binding remains');
    }
    const last = await setupFromTool({ action: 'remove', localRoot: root, bindingName: 'builder',
      revision: (await setupFromTool({ action: 'inspect', localRoot: root, bindingName: 'builder' })).revision });
    assert.equal(last.lastBinding, true);
    assert.equal(last.legacyDocs.removed.length, 3, 'all three generated documents are reclaimed and reported');
    for (const name of ['AGENTS.md', 'CLAUDE.md', 'SSH-WORKSPACE-GUIDE.md']) {
      await assert.rejects(readFile(join(root, name)), { code: 'ENOENT' }, name + ' is reclaimed with the last binding');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('remove recognizes its hook and MCP entry through path spellings that differ in text but not on disk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-semantic-'));
  try {
    await configureFromTool({ localRoot: root, host: '127.0.0.1', port: 1, username: 'test', sshAgent: 'pageant',
      remoteRoot: '/work', remoteStateDir: '/state', localStateDir: join(root, 'state') });
    const profilePath = join(root, '.ssh-mcp-workspace.json');
    // Point the integration at the same profile through a spelling configure would not have written.
    let variant;
    if (process.platform === 'win32') variant = profilePath.replace('ssh-mcp-semantic', 'SSH-MCP-Semantic');
    else { variant = join(root, 'profile-link.json'); await symlink('.ssh-mcp-workspace.json', variant); }
    const configPath = join(root, '.zcode', 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    for (const server of Object.values(config.mcp.servers)) {
      const at = server.args.indexOf('--workspace');
      if (at >= 0) server.args[at + 1] = variant;
    }
    for (const group of config.hooks.events.UserPromptSubmit) {
      for (const hook of group.hooks) {
        const at = hook.args.indexOf('--workspace');
        if (at >= 0) hook.args[at + 1] = variant;
      }
    }
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');

    const removed = await setupFromTool({ action: 'remove', localRoot: root,
      revision: (await setupFromTool({ action: 'inspect', localRoot: root })).revision });
    assert.deepEqual(removed.unhooked, { mcpServerEntry: true, recoveryHooks: 1 },
      'both entries are matched by file identity, not by exact text');
    const after = JSON.parse(await readFile(configPath, 'utf8'));
    assert.deepEqual(after.mcp.servers, {});
    assert.deepEqual(after.hooks.events.UserPromptSubmit, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('the manual CLI previews a removal and executes it with the printed revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-remove-cli-'));
  const cli = fileURLToPath(new URL('../scripts/setup-workspace.mjs', import.meta.url));
  try {
    await writeFile(join(root, 'ssh.json'), JSON.stringify({ offline: { host: 'localhost', port: 22, username: 'test', password: 'test-only' } }));
    const profile = join(root, 'profile.json');
    await writeFile(profile, JSON.stringify({ workspaceId: 'cli-remove', connectionName: 'offline', sshConfigFile: 'ssh.json',
      remoteRoot: '/work', remoteStateDir: '/state', localStateDir: './state' }));
    await mkdir(join(root, '.zcode'));
    await writeFile(join(root, '.zcode', 'config.json'), JSON.stringify({ mcp: { servers: {} } }));
    const run = args => spawnSync(process.execPath, [cli, '--workspace', profile, ...args], { encoding: 'utf8', timeout: 10000 });

    assert.equal(run(['--apply']).status, 0, 'integration first');
    const previewRun = run(['--remove']);
    assert.equal(previewRun.status, 0, previewRun.stderr);
    const preview = JSON.parse(previewRun.stdout);
    assert.equal(preview.status, 'removal_preview');
    assert.equal(typeof preview.revision, 'string');
    assert.deepEqual(preview.pending, { tasks: [], transfers: [], registryIssues: [] });
    assert.equal(preview.wouldRemove.lastBinding, true);
    assert.ok(await readFile(profile, 'utf8'), 'a preview deletes nothing');

    const stale = run(['--remove', '--revision', 'wrong-token']);
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /SETUP_CONFLICT/);

    const done = run(['--remove', '--revision', preview.revision]);
    assert.equal(done.status, 0, done.stderr);
    assert.equal(JSON.parse(done.stdout).status, 'removed');
    await assert.rejects(readFile(profile), { code: 'ENOENT' });
    const config = JSON.parse(await readFile(join(root, '.zcode', 'config.json'), 'utf8'));
    assert.ok(!config.mcp.servers['ssh-workspace-cli-remove']);
    assert.deepEqual(config.hooks.events.UserPromptSubmit, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('the setup tool advertises remove as a destructive, revision-guarded action', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-remove-surface-'));
  const client = new Client({ name: 'remove-contract', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../build/index.js', import.meta.url)), '--setup'], stderr: 'pipe' }));
    const tool = (await client.listTools()).tools.find(entry => entry.name === 'remote_setup');
    assert.ok(tool, 'remote_setup is advertised');
    assert.ok(JSON.stringify(tool.inputSchema).includes('remove'), 'the action enum lists remove');
    assert.equal(tool.annotations.destructiveHint, true, 'a tool that can remove a binding is marked destructive');
    const rejected = await client.callTool({ name: 'remote_setup', arguments: { action: 'remove', localRoot: root } });
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /SETUP_REVISION_REQUIRED/);
  } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
});

it('remove refuses cleanly when the SSH config is unreadable or the profile is invalid', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-remove-invalid-'));
  try {
    const ssh = join(root, 'ssh.json');
    await writeFile(ssh, JSON.stringify({ eda: { host: '127.0.0.1', port: 22, username: 'test', password: 'x' } }));
    const configured = await configureFromTool({ localRoot: root, sshConfigFile: ssh, connectionName: 'eda',
      remoteRoot: '/work', remoteStateDir: '/state', localStateDir: join(root, 'state') });
    const revision = (await setupFromTool({ action: 'inspect', localRoot: root })).revision;
    // The identity derivation needs the referenced SSH config; without it the
    // profile must survive untouched.
    await rm(ssh);
    await assert.rejects(setupFromTool({ action: 'remove', localRoot: root, revision }),
      (error) => error.code === 'SETUP_INVALID_SSH_CONFIG' && /left untouched/.test(error.message));
    assert.ok(await readFile(configured.profilePath, 'utf8'), 'an aborted removal leaves the profile in place');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('remove rejects invalid profiles without touching them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-remove-badjson-'));
  try {
    await writeFile(join(root, 'ssh.json'), JSON.stringify({ eda: { host: '127.0.0.1', port: 22, username: 'test', password: 'x' } }));
    const profile = join(root, '.ssh-mcp-workspace.json');
    await writeFile(profile, 'not json at all');
    await assert.rejects(setupFromTool({ action: 'remove', localRoot: root, revision: 'any' }), { code: 'SETUP_INVALID_CONFIG' });
    await writeFile(profile, JSON.stringify({ workspaceId: 'x' }));
    await assert.rejects(setupFromTool({ action: 'remove', localRoot: root, revision: 'any' }), { code: 'SETUP_INVALID_CONFIG' },
      'a structurally invalid profile is rejected before anything else');
    assert.equal(await readFile(profile, 'utf8'), JSON.stringify({ workspaceId: 'x' }), 'the profile content survives');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('removal treats a torn registration record as reported damage but a torn acknowledgement as pending work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-remove-registry-'));
  try {
    const ssh = join(root, 'ssh.json');
    await writeFile(ssh, JSON.stringify({ eda: { host: '127.0.0.1', port: 22, username: 'test', password: 'x' } }));
    const configured = await configureFromTool({ localRoot: root, sshConfigFile: ssh, connectionName: 'eda',
      remoteRoot: '/work', remoteStateDir: '/state', localStateDir: join(root, 'state') });
    const inspected = await setupFromTool({ action: 'inspect', localRoot: root });
    const remove = () => setupFromTool({ action: 'remove', localRoot: root, revision: inspected.revision });
    const config = await loadWorkspaceConfig(configured.profilePath);
    const identityDirectory = identityStateDirectory(config.localStateDir, config.identity);

    // A torn record.json cannot assert pendingness either way: it must surface
    // as a registry issue, never silently block or silently vanish.
    const torn = join(identityDirectory, 'tasks', 'torn-record-job');
    await mkdir(torn, { recursive: true });
    await writeFile(join(torn, 'record.json'), '{"schemaVersion":1,"sessionId":"se');
    // A torn ack.json counts as unacknowledged and must block removal.
    const tasks = new TaskService(fakeRemote(), config.localStateDir, config.identity);
    const blocked = await tasks.start({ sessionId: 'owner', cwd: '/work', command: 'build' });
    await writeFile(join(identityDirectory, 'tasks', blocked.jobId, 'ack.json'), '{"jobId":"' + blocked.jobId);

    await assert.rejects(remove(), error => error.code === 'SETUP_PENDING_OPERATIONS' && error.message.includes(blocked.jobId),
      'the torn acknowledgement keeps the task counted as pending');
    assert.ok(await readFile(configured.profilePath, 'utf8'), 'the blocked removal changed nothing');

    await tasks.acknowledge(blocked.jobId, 'owner');
    const removed = await remove();
    assert.equal(removed.status, 'removed', 'the torn record alone never blocks removal');
    assert.ok(removed.registryIssues.some(issue => issue.source === 'tasks' && issue.id === 'torn-record-job'),
      'the torn registration is reported as damage instead of being ignored');
    await assert.rejects(readFile(configured.profilePath), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('removal preview explains a squatted server entry instead of showing a bare false', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-remove-squat-'));
  try {
    await configureFromTool({ localRoot: root, host: '127.0.0.1', port: 1, username: 'test', sshAgent: 'pageant',
      remoteRoot: '/work', remoteStateDir: '/state', localStateDir: join(root, 'state') });
    const profilePath = join(root, '.ssh-mcp-workspace.json');
    // Point the generated server entry at some other workspace: same name,
    // not our binding.
    const configPath = join(root, '.zcode', 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    const serverName = Object.keys(config.mcp.servers).find(name => name.startsWith('ssh-workspace-'));
    const at = config.mcp.servers[serverName].args.indexOf('--workspace');
    config.mcp.servers[serverName].args[at + 1] = join(root, 'some-other-profile.json');
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');

    const preview = await removeWorkspaceBinding(profilePath);
    assert.equal(preview.status, 'removal_preview');
    assert.equal(preview.wouldRemove.mcpServerEntry, false);
    assert.match(preview.note, /left untouched/, 'the preview says why the entry stays');

    const removed = await removeWorkspaceBinding(profilePath, preview.revision);
    assert.equal(removed.status, 'removed');
    assert.equal(removed.unhooked.mcpServerEntry, false);
    assert.match(removed.unhooked.note, /left untouched/);
    assert.deepEqual(removed.unhooked.recoveryHooks, 1, 'our own recovery hook still goes');
    const after = JSON.parse(await readFile(configPath, 'utf8'));
    assert.ok(after.mcp.servers[serverName], 'the squatted entry survives the removal');
    assert.deepEqual(after.hooks.events.UserPromptSubmit, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
