import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawnSync } from 'node:child_process';

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
    const result = await client.callTool({ name: 'remote_setup', arguments: {
      localRoot: root, connectionName: 'build', remoteRoot: '/project', remoteStateDir: '/state' } });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    const profile = JSON.parse(await readFile(JSON.parse(result.content[0].text).profilePath, 'utf8'));
    assert.equal(profile.sshConfigFile, auth);
    assert.equal(profile.connectionName, 'build');
  } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
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
