import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawnSync } from 'node:child_process';
import { loadWorkspaceConfig } from '../build/config/workspace.js';
import { TaskService } from '../build/services/task-service.js';
// Namespace import keeps the whole suite runnable while inspect/update land (ticket #18).
import * as setupServer from '../build/core/setup-server.js';
const { configureFromTool, setupFromTool } = setupServer;

it('named bindings coexist with legacy profiles and recover only their own tasks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-bindings-'));
  try {
    const auth = join(root, 'ssh.json');
    await writeFile(auth, JSON.stringify({ eda: { host: '127.0.0.1', port: 22, username: 'test', password: 'test' },
      other: { host: '127.0.0.2', port: 22, username: 'test', password: 'test' } }));
    const common = { localRoot: root, sshConfigFile: auth, remoteStateDir: '/state', localStateDir: join(root, 'state') };
    const inputs = [
      { ...common, connectionName: 'eda', remoteRoot: '/legacy' },
      { ...common, bindingName: 'eda-main', connectionName: 'eda', remoteRoot: '/main' },
      { ...common, bindingName: 'eda-tests', connectionName: 'eda', remoteRoot: '/tests' },
      { ...common, bindingName: 'builder', connectionName: 'other', remoteRoot: '/main' },
    ];
    const results = [];
    for (const input of inputs) results.push(await configureFromTool(input));
    assert.equal(new Set(results.map(r => r.profilePath)).size, 4);
    assert.equal(new Set(results.map(r => r.serverName)).size, 4);
    const before = await readFile(join(root, '.zcode/config.json'), 'utf8');
    for (const input of inputs) await configureFromTool(input);
    assert.equal(await readFile(join(root, '.zcode/config.json'), 'utf8'), before);
    await assert.rejects(configureFromTool({ ...inputs[1], remoteRoot: '/changed' }), { code: 'SETUP_CONFLICT' });
    const jobs = [];
    for (const result of results) {
      const config = await loadWorkspaceConfig(result.profilePath);
      let assigned = 0;
      const tasks = new TaskService({ call: async (action, r) => {
        if (action === 'task_register') return { jobId: config.workspaceId + '-job-' + (++assigned), state: 'prepared' };
        return { jobId: r.jobId, state: 'running' };
      } }, config.localStateDir, config.identity);
      jobs.push((await tasks.start({ sessionId: 'owner', cwd: config.remoteRoot, command: 'build-' + jobs.length })).jobId);
      await tasks.start({ sessionId: 'someone-else', cwd: config.remoteRoot, command: 'private-other-session' });
    }
    const hooks = JSON.parse(before).hooks.events.UserPromptSubmit.flatMap(g => g.hooks);
    assert.equal(hooks.length, 4);
    for (let i = 0; i < hooks.length; i++) {
      const run = spawnSync(hooks[i].command, hooks[i].args, { encoding: 'utf8', timeout: 10000,
        input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: root, session_id: 'owner' }) });
      const context = JSON.parse(run.stdout).hookSpecificOutput.additionalContext;
      assert.ok(context.includes(jobs[i]));
      for (const job of jobs.filter((_, j) => j !== i)) assert.ok(!context.includes(job));
      assert.doesNotMatch(context, /private-other-session/);
      assert.ok(context.includes(results[i].serverName), 'Recovery identifies the corresponding MCP server');
    }
    const guide = await readFile(join(root, 'AGENTS.md'), 'utf8');
    assert.match(guide, /绑定/);
    assert.ok(!guide.includes('/legacy'), 'Shared guidance must not pin future bindings to the first target');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('rejects unsafe binding names and explicit workspaceId collisions between bindings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-binding-rules-'));
  try {
    const auth = join(root, 'ssh.json');
    await writeFile(auth, JSON.stringify({ eda: { host: '127.0.0.1', port: 22, username: 'test', password: 'test' } }));
    const common = { localRoot: root, sshConfigFile: auth, connectionName: 'eda', remoteStateDir: '/state', localStateDir: join(root, 'state') };
    for (const bad of ['eda-main.json', '../escape', 'Eda-Main', 'eda main', '-eda', 'a'.repeat(65)]) {
      await assert.rejects(configureFromTool({ ...common, bindingName: bad, remoteRoot: '/main' }), { code: 'SETUP_INVALID_BINDING' }, bad);
    }
    await configureFromTool({ ...common, bindingName: 'eda-main', remoteRoot: '/main', workspaceId: 'shared-id' });
    await assert.rejects(configureFromTool({ ...common, bindingName: 'eda-tests', remoteRoot: '/tests', workspaceId: 'shared-id' }), { code: 'SETUP_CONFLICT' });
    await assert.rejects(readFile(join(root, '.ssh-mcp-workspace.eda-tests.json')), { code: 'ENOENT' },
      'a rejected binding must not leave a profile file behind');
    const distinct = await configureFromTool({ ...common, bindingName: 'eda-tests', remoteRoot: '/tests' });
    assert.notEqual(distinct.serverName, 'ssh-workspace-shared-id');
    assert.match(distinct.profilePath, /\.ssh-mcp-workspace\.eda-tests\.json$/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('setup reuses a startup SSH config and reveals connection names without credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-presets-'));
  const client = new Client({ name: 'preset-contract', version: '1' });
  try {
    const auth = join(root, 'ssh.json');
    await writeFile(auth, JSON.stringify({ eda: { host: '127.0.0.1', port: 22, username: 'test', password: 'never-show-secret' },
      build: { host: '127.0.0.2', port: 22, username: 'test', password: 'never-show-secret' } }));
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../build/index.js', import.meta.url)), '--setup', '--config-file', auth], stderr: 'pipe' }));
    const missing = await client.callTool({ name: 'remote_setup', arguments: {} });
    assert.equal(missing.isError, undefined, JSON.stringify(missing));
    assert.doesNotMatch(JSON.stringify(missing), /never-show-secret/);
    const discovery = JSON.parse(missing.content[0].text);
    assert.deepEqual(discovery.connections, ['eda', 'build']);
    assert.ok(!discovery.questions.some(q => q.fields.includes('privateKey')));
    assert.ok(discovery.questions.some(q => q.fields.includes('connectionName') && q.question.includes('无需另行查证')),
      'connection names are presented as complete choices needing no host lookup');
    const result = await client.callTool({ name: 'remote_setup', arguments: {
      localRoot: root, connectionName: 'build', remoteRoot: '/project', remoteStateDir: '/state' } });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    const profile = JSON.parse(await readFile(JSON.parse(result.content[0].text).profilePath, 'utf8'));
    assert.equal(profile.sshConfigFile, auth);
    assert.equal(profile.connectionName, 'build');
  } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
});

it('setup MCP accepts bindingName and directoryScope through the protocol surface', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-protocol-bindings-'));
  const client = new Client({ name: 'protocol-binding', version: '1' });
  try {
    const auth = join(root, 'ssh.json');
    await writeFile(auth, JSON.stringify({ eda: { host: '127.0.0.1', port: 22, username: 'test', password: 'fixture' } }));
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../build/index.js', import.meta.url)), '--setup', '--config-file', auth], stderr: 'pipe' }));
    const tool = (await client.listTools()).tools.find(entry => entry.name === 'remote_setup');
    assert.ok(tool, 'remote_setup is advertised');
    assert.ok(!tool.description.includes('First-time'), 'setup must read as repeatable, not one-shot');
    assert.ok(tool.description.includes('bindingName'), 'the description points at additional bindings');
    assert.ok(!JSON.stringify(tool.inputSchema).includes('legacy'), 'field docs avoid maintainer jargon');
    const rejected = await client.callTool({ name: 'remote_setup', arguments: { localRoot: root, bindingName: 'eda-main',
      connectionName: 'eda', remoteRoot: '/main', remoteStateDir: '/state', directoryScope: 'sometimes' } });
    assert.ok(rejected.isError, JSON.stringify(rejected));
    const result = await client.callTool({ name: 'remote_setup', arguments: { localRoot: root, bindingName: 'eda-main',
      connectionName: 'eda', remoteRoot: '/main', remoteStateDir: '/state', directoryScope: 'unrestricted' } });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    const payload = JSON.parse(result.content[0].text);
    assert.match(payload.profilePath, /\.ssh-mcp-workspace\.eda-main\.json$/);
    const profile = JSON.parse(await readFile(payload.profilePath, 'utf8'));
    assert.equal(profile.bindingName, 'eda-main');
    assert.equal(profile.directoryScope, 'unrestricted');
  } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
});

it('setup rejects an empty connection library instead of asking an unanswerable question', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-empty-library-'));
  try {
    const auth = join(root, 'ssh.json');
    await writeFile(auth, JSON.stringify({}));
    await assert.rejects(configureFromTool({ localRoot: root, sshConfigFile: auth, remoteRoot: '/work', remoteStateDir: '/state' }),
      (error) => error.code === 'SETUP_INVALID_SSH_CONFIG' && /contains no connections/.test(error.message),
      'the error names the empty library itself, not missing host parameters');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('setup MCP asks for missing inputs and prepares project integration without manual setup commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-setup-api-'));
  const client = new Client({ name: 'setup-contract', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../build/index.js', import.meta.url)), '--setup'], stderr: 'pipe' }));
    assert.ok((await client.listTools()).tools.some(tool => tool.name === 'remote_setup'));
    const call = async args => {
      const result = await client.callTool({ name: 'remote_setup', arguments: args });
      assert.equal(result.isError, undefined, JSON.stringify(result));
      return JSON.parse(result.content[0].text);
    };
    const missing = await call({});
    assert.equal(missing.status, 'needs_input');
    assert.ok(missing.questions.some(item => item.fields.includes('remoteRoot')));
    assert.ok(missing.questions.some(item => item.fields.includes('sshConfigFile')));
    assert.match(missing.instructions, /local SSH configs/, 'missing-input guidance must steer agents to ask the user instead of probing');
    assert.match(missing.instructions, /complete connection choice/, 'a preset connection name needs no host lookup');
    await mkdir(join(root, '.zcode'));
    await writeFile(join(root, '.zcode', 'config.json'), JSON.stringify({ mcp: { servers: { existing: { command: 'keep-me' } } }, hooks: { events: { Stop: [] } } }));
    await writeFile(join(root, 'AGENTS.md'), 'existing project rules');
    const auth = join(root, 'ssh.json');
    await writeFile(auth, JSON.stringify({ target: { host: '127.0.0.1', port: 1, username: 'test', password: 'do-not-echo' } }));
    const input = { localRoot: root, remoteRoot: '/work', remoteStateDir: '/state', sshConfigFile: auth, connectionName: 'target' };
    const configured = await call(input);
    assert.equal(configured.status, 'configured');
    assert.doesNotMatch(JSON.stringify(configured), /do-not-echo/);
    assert.equal(configured.sshVerified, false);
    const configPath = join(root, '.zcode', 'config.json');
    const before = await readFile(configPath, 'utf8');
    await call(input);
    assert.equal(await readFile(configPath, 'utf8'), before, 'Repeated setup must be idempotent');
    const config = JSON.parse(before);
    assert.equal(config.mcp.servers.existing.command, 'keep-me');
    assert.equal(config.hooks.events.UserPromptSubmit.length, 1);
    assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), 'existing project rules');
    const hook = config.hooks.events.UserPromptSubmit[0].hooks[0];
    const result = spawnSync(hook.command, hook.args, { encoding: 'utf8', timeout: 10000,
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: root, session_id: 'real-session' }) });
    assert.equal(result.status, 0, result.stderr);
    assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /real-session/);
    const bound = new Client({ name: 'bound-contract', version: '1' });
    try {
      await bound.connect(new StdioClientTransport(configured.mcpServer));
      assert.ok((await bound.listTools()).tools.some(tool => tool.name === 'remote_read'));
    } finally { await bound.close(); }
  } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
});

it('setup refuses a project config directory redirected outside the selected workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-link-'));
  const project = join(root, 'project');
  const outside = join(root, 'outside');
  const client = new Client({ name: 'link-contract', version: '1' });
  try {
    await mkdir(project); await mkdir(outside);
    await writeFile(join(outside, 'config.json'), '{}');
    await symlink(outside, join(project, '.zcode'), process.platform === 'win32' ? 'junction' : 'dir');
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../build/index.js', import.meta.url)), '--setup'], stderr: 'pipe' }));
    const result = await client.callTool({ name: 'remote_setup', arguments: { localRoot: project, remoteRoot: '/work', remoteStateDir: '/state',
      host: '127.0.0.1', username: 'test', sshAgent: 'pageant' } });
    assert.equal(result.isError, true);
    assert.equal(await readFile(join(outside, 'config.json'), 'utf8'), '{}');
  } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
});

it('setup accepts host and SSH agent details without requiring a separate SSH config file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-inline-'));
  const client = new Client({ name: 'inline-contract', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../build/index.js', import.meta.url)), '--setup'], stderr: 'pipe' }));
    const result = await client.callTool({ name: 'remote_setup', arguments: { localRoot: root, remoteRoot: '/work', remoteStateDir: '/state',
      host: '127.0.0.1', port: 1, username: 'test', sshAgent: 'pageant' } });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    const configured = JSON.parse(result.content[0].text);
    assert.equal(configured.status, 'configured');
    const profile = JSON.parse(await readFile(configured.profilePath, 'utf8'));
    const auth = JSON.parse(await readFile(profile.sshConfigFile, 'utf8'))[profile.connectionName];
    assert.equal(auth.host, '127.0.0.1');
    assert.equal(auth.port, 1);
    assert.equal(auth.agent, 'pageant');
    assert.equal(auth.password, undefined);
  } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
});

const dayMs = 86400000;
const gib = 10737418240;

it('inspect returns sanitized configuration with a revision and effective policy defaults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-inspect-'));
  try {
    const auth = join(root, 'ssh.json');
    await writeFile(auth, JSON.stringify({ eda: { host: '127.0.0.1', port: 22, username: 'test', password: 'inspect-secret' } }));
    const configured = await configureFromTool({ localRoot: root, bindingName: 'eda-main', sshConfigFile: auth,
      connectionName: 'eda', remoteRoot: '/main', remoteStateDir: '/state' });
    const missing = await setupFromTool({ action: 'inspect' });
    assert.equal(missing.status, 'needs_input', 'inspect without a project directory asks for one instead of guessing');
    const inspected = await setupFromTool({ action: 'inspect', localRoot: root, bindingName: 'eda-main' });
    assert.equal(inspected.status, 'inspected');
    assert.equal(inspected.profilePath, configured.profilePath);
    assert.match(inspected.revision, /^[0-9a-f]{64}$/, 'revision identifies the inspected profile content');
    assert.equal(inspected.config.workspaceId, JSON.parse(await readFile(configured.profilePath, 'utf8')).workspaceId);
    assert.equal(inspected.config.remoteRoot, '/main');
    assert.equal(inspected.config.remoteStateDir, '/state');
    assert.equal(inspected.config.directoryScope, 'restricted', 'absent scope resolves to restricted');
    assert.equal(inspected.config.pythonPath, '/usr/bin/python3', 'absent pythonPath resolves to the default');
    assert.equal(inspected.config.policy.limits.localWorkspaceBytes, gib);
    assert.equal(inspected.config.policy.limits.remoteWorkspaceBytes, gib);
    assert.equal(inspected.config.policy.retention.confirmedTaskLogMs, 3 * dayMs);
    assert.equal(inspected.config.policy.retention.confirmedResultMs, 30 * dayMs);
    assert.equal(inspected.config.policy.retention.unconfirmedResultMs, 30 * dayMs);
    assert.equal(inspected.config.policy.retention.unknownRecordMs, 30 * dayMs);
    assert.equal(inspected.config.policy.retention.interruptedTransferDataMs, 3 * dayMs);
    assert.equal(inspected.config.policy.retention.readTokenMs, 3 * dayMs);
    assert.equal(inspected.config.policy.search.respectGitignore, false);
    assert.equal(inspected.config.policy.search.includeHidden, true);
    assert.equal(inspected.config.policy.search.scanBudgetBytes, 536870912);
    assert.equal(inspected.config.policy.search.timeBudgetMs, 10000);
    assert.equal(inspected.config.policy.search.pageSizeBytes, 65536);
    assert.equal(inspected.config.policy.maintenance.intervalMs, 3600000);
    assert.equal(inspected.config.policy.maintenance.maxItemsPerRun, 100);
    assert.equal(inspected.config.policy.maintenance.timeBudgetMs, 2000);
    assert.equal(inspected.authentication.source, auth, 'inspect names where credentials live without opening them');
    assert.ok(inspected.authentication.note.length > 0);
    assert.doesNotMatch(JSON.stringify(inspected), /inspect-secret/, 'credentials must never be echoed');
    assert.equal(JSON.parse(await readFile(configured.profilePath, 'utf8')).policy, undefined,
      'defaults are effective values, not materialized into the profile');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('update changes only named fields and preserves everything else', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-update-'));
  try {
    const auth = join(root, 'ssh.json');
    await writeFile(auth, JSON.stringify({ eda: { host: '127.0.0.1', port: 22, username: 'test', password: 'update-secret' } }));
    const configured = await configureFromTool({ localRoot: root, sshConfigFile: auth, connectionName: 'eda',
      remoteRoot: '/main', remoteStateDir: '/state', pythonPath: '/usr/bin/python39', localStateDir: join(root, 'state'),
      policy: { limits: { localWorkspaceBytes: 1073741824 } } });
    const before = await setupFromTool({ action: 'inspect', localRoot: root });
    const updated = await setupFromTool({ action: 'update', localRoot: root, revision: before.revision,
      policy: { search: { scanBudgetBytes: 1048576 } } });
    assert.equal(updated.status, 'updated');
    assert.notEqual(updated.revision, before.revision);
    assert.deepEqual(updated.changed, ['policy.search.scanBudgetBytes']);
    assert.equal(updated.policy.search.scanBudgetBytes, 1048576, 'response reports the effective policy after the change');
    assert.equal(updated.policy.limits.localWorkspaceBytes, 1073741824, 'unrelated stored policy survives');
    assert.match(updated.effective, /never recalculated/, 'the result explains that retention changes are not retroactive');
    const profile = JSON.parse(await readFile(configured.profilePath, 'utf8'));
    assert.equal(profile.policy.search.scanBudgetBytes, 1048576);
    assert.equal(profile.policy.limits.localWorkspaceBytes, 1073741824, 'only named policy leaves change');
    assert.equal(profile.pythonPath, '/usr/bin/python39');
    assert.equal(profile.localStateDir, join(root, 'state'));
    assert.equal(profile.remoteRoot, '/main');
    assert.equal(profile.remoteStateDir, '/state');
    assert.equal(profile.connectionName, 'eda');
    assert.equal(profile.sshConfigFile, auth);
    const after = await setupFromTool({ action: 'inspect', localRoot: root });
    assert.equal(after.revision, updated.revision);
    assert.equal(after.config.policy.search.scanBudgetBytes, 1048576);
    assert.equal(after.config.policy.limits.localWorkspaceBytes, 1073741824);
    assert.equal(after.config.policy.search.pageSizeBytes, 65536, 'defaults still fill unnamed policy leaves');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('update rejects stale revisions and concurrent changes without half-writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-update-conflict-'));
  try {
    const auth = join(root, 'ssh.json');
    await writeFile(auth, JSON.stringify({ eda: { host: '127.0.0.1', port: 22, username: 'test', password: 'conflict-secret' } }));
    const configured = await configureFromTool({ localRoot: root, sshConfigFile: auth, connectionName: 'eda',
      remoteRoot: '/main', remoteStateDir: '/state' });
    const profilePath = configured.profilePath;
    const first = await setupFromTool({ action: 'inspect', localRoot: root });
    const request = { action: 'update', localRoot: root, revision: first.revision, policy: { retention: { readTokenMs: 3600000 } } };
    await setupFromTool(request);
    const afterFirst = await readFile(profilePath, 'utf8');
    await assert.rejects(setupFromTool(request), { code: 'SETUP_CONFLICT' },
      'a second writer reusing the inspected revision must be rejected, not merged');
    assert.equal(await readFile(profilePath, 'utf8'), afterFirst, 'a rejected update leaves no half-written profile');
    const applied = await setupFromTool({ action: 'inspect', localRoot: root });
    const tampered = JSON.parse(afterFirst);
    tampered.pythonPath = '/usr/bin/python3.11';
    await writeFile(profilePath, JSON.stringify(tampered, null, 2) + '\n');
    await assert.rejects(setupFromTool({ action: 'update', localRoot: root, revision: applied.revision,
      policy: { search: { includeHidden: false } } }), { code: 'SETUP_CONFLICT' },
      'an external edit invalidates the inspected revision');
    assert.equal(JSON.parse(await readFile(profilePath, 'utf8')).pythonPath, '/usr/bin/python3.11',
      'the external edit itself stays intact');
    const leftovers = (await readdir(root)).filter(name => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], 'failed updates must not leave temporary files behind');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('update refuses identity and authentication changes and points at new bindings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-update-identity-'));
  try {
    const auth = join(root, 'ssh.json');
    await writeFile(auth, JSON.stringify({ eda: { host: '127.0.0.1', port: 22, username: 'test', password: 'identity-secret' },
      other: { host: '127.0.0.2', port: 22, username: 'test', password: 'identity-secret' } }));
    const configured = await configureFromTool({ localRoot: root, bindingName: 'eda-main', sshConfigFile: auth,
      connectionName: 'eda', remoteRoot: '/main', remoteStateDir: '/state' });
    const original = await readFile(configured.profilePath, 'utf8');
    const inspected = await setupFromTool({ action: 'inspect', localRoot: root, bindingName: 'eda-main' });
    const attempts = [
      { remoteRoot: '/elsewhere' }, { remoteStateDir: '/other-state' }, { localStateDir: join(root, 'moved-state') },
      { connectionName: 'other' }, { sshConfigFile: join(root, 'other.json') }, { host: '10.0.0.9' }, { port: 2222 },
      { username: 'attacker' }, { privateKey: join(root, 'key') }, { sshAgent: 'other-agent' }, { workspaceId: 'brand-new' },
    ];
    for (const attempt of attempts) {
      await assert.rejects(setupFromTool({ action: 'update', localRoot: root, bindingName: 'eda-main',
        revision: inspected.revision, ...attempt }),
        error => error.code === 'SETUP_IDENTITY_LOCKED' && /new binding/.test(error.message), JSON.stringify(attempt));
    }
    assert.equal(await readFile(configured.profilePath, 'utf8'), original, 'rejected identity changes leave the profile untouched');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('directoryScope updates in place without rekeying the binding identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-update-scope-'));
  try {
    const auth = join(root, 'ssh.json');
    await writeFile(auth, JSON.stringify({ eda: { host: '127.0.0.1', port: 22, username: 'test', password: 'scope-secret' } }));
    const configured = await configureFromTool({ localRoot: root, sshConfigFile: auth, connectionName: 'eda',
      remoteRoot: '/home/user', remoteStateDir: '/state' });
    const before = await loadWorkspaceConfig(configured.profilePath);
    assert.equal(before.directoryScope, 'restricted');
    let inspected = await setupFromTool({ action: 'inspect', localRoot: root });
    const opened = await setupFromTool({ action: 'update', localRoot: root, revision: inspected.revision,
      directoryScope: 'unrestricted' });
    assert.deepEqual(opened.changed, ['directoryScope']);
    assert.equal(JSON.parse(await readFile(configured.profilePath, 'utf8')).directoryScope, 'unrestricted');
    const flipped = await loadWorkspaceConfig(configured.profilePath);
    assert.equal(flipped.directoryScope, 'unrestricted');
    assert.equal(flipped.identity, before.identity, 'scope deliberately stays out of identity so task ownership survives');
    inspected = await setupFromTool({ action: 'inspect', localRoot: root });
    const closed = await setupFromTool({ action: 'update', localRoot: root, revision: inspected.revision, directoryScope: 'restricted' });
    const stored = JSON.parse(await readFile(configured.profilePath, 'utf8'));
    assert.equal(stored.directoryScope, undefined, 'restricted is stored as the canonical absent value');
    assert.equal(closed.policy.maintenance.intervalMs, 3600000);
    assert.equal((await loadWorkspaceConfig(configured.profilePath)).identity, before.identity);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('update validates its inputs and reports missing bindings and revisions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-update-invalid-'));
  try {
    const auth = join(root, 'ssh.json');
    await writeFile(auth, JSON.stringify({ eda: { host: '127.0.0.1', port: 22, username: 'test', password: 'invalid-secret' } }));
    const configured = await configureFromTool({ localRoot: root, sshConfigFile: auth, connectionName: 'eda',
      remoteRoot: '/main', remoteStateDir: '/state' });
    const profilePath = configured.profilePath;
    const inspected = await setupFromTool({ action: 'inspect', localRoot: root });
    const revision = inspected.revision;
    await assert.rejects(setupFromTool({ action: 'update', localRoot: root }), { code: 'SETUP_REVISION_REQUIRED' },
      'update without a revision is a usage error, not a silent overwrite');
    for (const bad of [
      { policy: { search: { scanBudgetBytes: -1 } } }, { policy: { search: { scanBudgetBytes: 'big' } } },
      { policy: { quotas: {} } }, { policy: { limits: { localWorkspaceBytes: 0 } } },
      { policy: { retention: { readTokenMs: 1.5 } } },
    ]) {
      await assert.rejects(setupFromTool({ action: 'update', localRoot: root, revision, ...bad }),
        { code: 'SETUP_INVALID_POLICY' }, JSON.stringify(bad));
    }
    await assert.rejects(setupFromTool({ action: 'update', localRoot: root, revision, directoryScope: 'sometimes' }),
      { code: 'SETUP_INVALID_SCOPE' });
    await assert.rejects(setupFromTool({ action: 'update', localRoot: root, revision, pythonPath: 'python3' }),
      { code: 'SETUP_INVALID_PATH' });
    assert.equal(JSON.parse(await readFile(profilePath, 'utf8')).policy, undefined,
      'all rejected updates together leave no policy behind');
    const empty = await mkdtemp(join(tmpdir(), 'ssh-mcp-update-missing-'));
    try {
      await assert.rejects(setupFromTool({ action: 'inspect', localRoot: empty }), { code: 'SETUP_PROFILE_NOT_FOUND' });
      await assert.rejects(setupFromTool({ action: 'update', localRoot: empty, revision: '0'.repeat(64) }),
        { code: 'SETUP_PROFILE_NOT_FOUND' });
    } finally { await rm(empty, { recursive: true, force: true }); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('update preserves authentication files byte-for-byte and never echoes them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-update-auth-'));
  try {
    // Explicit host auth makes setup generate .ssh-mcp-connection.json; updates must not touch it.
    await writeFile(join(root, 'id_test'), 'PRIVATE KEY MATERIAL update-auth-marker');
    const configured = await configureFromTool({ localRoot: root, remoteRoot: '/work', remoteStateDir: '/state',
      host: '127.0.0.1', username: 'test', privateKey: join(root, 'id_test'), localStateDir: join(root, 'state') });
    const connectionPath = join(root, '.ssh-mcp-connection.json');
    const connectionBefore = await readFile(connectionPath, 'utf8');
    const inspected = await setupFromTool({ action: 'inspect', localRoot: root });
    assert.doesNotMatch(JSON.stringify(inspected), /update-auth-marker/, 'inspect never reads private key contents');
    await setupFromTool({ action: 'update', localRoot: root, revision: inspected.revision,
      policy: { limits: { remoteWorkspaceBytes: 2147483648 } } });
    assert.equal(await readFile(connectionPath, 'utf8'), connectionBefore,
      'a policy update must not rewrite generated authentication parameters');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('setup MCP exposes inspect and update through the protocol surface', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-protocol-update-'));
  const client = new Client({ name: 'protocol-update', version: '1' });
  try {
    const auth = join(root, 'ssh.json');
    await writeFile(auth, JSON.stringify({ eda: { host: '127.0.0.1', port: 22, username: 'test', password: 'protocol-secret' } }));
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../build/index.js', import.meta.url)), '--setup', '--config-file', auth], stderr: 'pipe' }));
    const tool = (await client.listTools()).tools.find(entry => entry.name === 'remote_setup');
    assert.ok(tool, 'remote_setup is advertised');
    const properties = Object.keys(tool.inputSchema.properties);
    for (const field of ['action', 'revision', 'policy']) assert.ok(properties.includes(field), `${field} is part of the schema`);
    const created = await client.callTool({ name: 'remote_setup', arguments: { localRoot: root, bindingName: 'eda-main',
      connectionName: 'eda', remoteRoot: '/main', remoteStateDir: '/state' } });
    assert.equal(created.isError, undefined, JSON.stringify(created));
    const profilePath = JSON.parse(created.content[0].text).profilePath;
    const inspected = await client.callTool({ name: 'remote_setup', arguments: { action: 'inspect', localRoot: root, bindingName: 'eda-main' } });
    assert.equal(inspected.isError, undefined, JSON.stringify(inspected));
    assert.doesNotMatch(JSON.stringify(inspected), /protocol-secret/);
    const revision = JSON.parse(inspected.content[0].text).revision;
    const noRevision = await client.callTool({ name: 'remote_setup', arguments: { action: 'update', localRoot: root,
      bindingName: 'eda-main', policy: { search: { timeBudgetMs: 20000 } } } });
    assert.ok(noRevision.isError, JSON.stringify(noRevision));
    assert.equal(JSON.parse(noRevision.content[0].text).code, 'SETUP_REVISION_REQUIRED');
    const updated = await client.callTool({ name: 'remote_setup', arguments: { action: 'update', localRoot: root,
      bindingName: 'eda-main', revision, policy: { search: { timeBudgetMs: 20000 } } } });
    assert.equal(updated.isError, undefined, JSON.stringify(updated));
    assert.equal(JSON.parse(await readFile(profilePath, 'utf8')).policy.search.timeBudgetMs, 20000);
  } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
});
