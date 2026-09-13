import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawnSync } from 'node:child_process';
import { loadWorkspaceConfig } from '../build/config/workspace.js';
import { TaskService } from '../build/services/task-service.js';
import { configureFromTool } from '../build/core/setup-server.js';

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
        if (action === 'task_register') return { jobId: r.workspaceId + '-job-' + (++assigned), state: 'prepared' };
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
