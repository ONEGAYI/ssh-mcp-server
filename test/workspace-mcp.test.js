import { it } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadWorkspaceConfig } from '../build/config/workspace.js';
import { TaskService } from '../build/services/task-service.js';

it('workspace MCP advertises guarded file tools without the legacy unguarded upload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ssh-mcp-tools-'));
  const client = new Client({ name: 'contract-test', version: '1' });
  try {
    await writeFile(join(directory, 'ssh.json'), JSON.stringify({ offline: { host: '127.0.0.1', port: 1, username: 'test', password: 'must-not-leak' } }));
    await writeFile(join(directory, 'workspace.json'), JSON.stringify({ workspaceId: 'contract', connectionName: 'offline', sshConfigFile: './ssh.json', remoteRoot: '/work', remoteStateDir: '/state' }));
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../build/index.js', import.meta.url)), '--workspace', join(directory, 'workspace.json')], stderr: 'pipe' }));
    const tools = await client.listTools();
    // Always-loaded definitions stay compact; detailed workflows live in remote_help.
    const definitionBytes = Buffer.byteLength(JSON.stringify(tools.tools), 'utf8');
    assert.ok(definitionBytes <= 16 * 1024, `workspace tool definitions exceed 16 KiB: ${definitionBytes}`);
    const fields = name => Object.keys(tools.tools.find(tool => tool.name === name).inputSchema.properties).sort();
    assert.deepEqual(fields('remote_list'), ['cursor', 'limit', 'path', 'pattern', 'sessionId']);
    assert.deepEqual(fields('remote_find'), ['cursor', 'includeHidden', 'limit', 'path', 'pattern', 'respectGitignore', 'sessionId']);
    assert.deepEqual(fields('remote_search'), ['cursor', 'filePattern', 'includeHidden', 'limit', 'path', 'pattern', 'respectGitignore', 'sessionId']);
    assert.deepEqual(fields('remote_ack'), ['jobId', 'jobIds', 'sessionId']);
    for (const name of ['remote_read', 'remote_edit', 'remote_write', 'remote_upload', 'remote_download', 'remote_pending', 'remote_wait']) {
      assert.ok(tools.tools.some(tool => tool.name === name), name);
    }
    assert.ok(!tools.tools.some(tool => tool.name === 'upload' || tool.name === 'execute_command'));
    // Issue #20 / ADR 0007: move/delete/mkdir/rmdir retired from the tool
    // list; directory management goes through remote shell commands instead.
    for (const retired of ['remote_move', 'remote_delete', 'remote_mkdir', 'remote_rmdir']) {
      assert.ok(!tools.tools.some(tool => tool.name === retired), retired + ' must no longer be advertised');
    }
    const read = tools.tools.find(tool => tool.name === 'remote_read');
    assert.ok(read.inputSchema.properties.metadataOnly, 'remote_read exposes metadataOnly');
    assert.ok(read.inputSchema.properties.expectedVersion, 'remote_read exposes expectedVersion');
    assert.ok(!/16 MiB/.test(read.description), 'remote_read no longer caps file size');
    const edit = tools.tools.find(tool => tool.name === 'remote_edit');
    assert.ok(!(edit.inputSchema.required ?? []).includes('readToken'), 'remote_edit permits implicit credentials');
    assert.match(edit.inputSchema.properties.readToken.description, /Omit.*latest.*file and session/);
    assert.match(edit.description, /Omit readToken.*latest/);
    // Issue #10: whole-file writes take an explicit overwrite bound to the
    // observed version instead of a read credential.
    const write = tools.tools.find(tool => tool.name === 'remote_write');
    assert.ok(write.inputSchema.properties.overwrite, 'remote_write exposes overwrite');
    assert.ok(write.inputSchema.properties.expectedVersion, 'remote_write exposes expectedVersion');
    assert.ok(!('readToken' in write.inputSchema.properties), 'remote_write no longer takes readToken');
    assert.match(write.description, /metadataOnly/);
    const upload = tools.tools.find(tool => tool.name === 'remote_upload');
    assert.ok(upload.inputSchema.properties.overwrite, 'remote_upload exposes overwrite');
    assert.ok(upload.inputSchema.properties.expectedVersion, 'remote_upload exposes expectedVersion');
    assert.ok(!('readToken' in upload.inputSchema.properties), 'remote_upload no longer takes readToken');
    const pending = await client.callTool({ name: 'remote_pending', arguments: { sessionId: 'new-session' } });
    assert.equal(pending.isError, undefined);
    assert.doesNotMatch(JSON.stringify(pending), /must-not-leak/);
  } finally {
    await client.close();
    const child = relative(tmpdir(), directory);
    assert.ok(child && !isAbsolute(child) && !child.startsWith('..'));
    await rm(directory, { recursive: true, force: true });
  }
});

async function ackFixture(t, jobs, { foreign = [], preloadSetup = '', beforeExchange = '' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ssh-mcp-ack-'));
  const client = new Client({ name: 'contract-test', version: '1' });
  t.after(async () => {
    await client.close();
    const child = relative(tmpdir(), directory);
    assert.ok(child && !isAbsolute(child) && !child.startsWith('..'));
    await rm(directory, { recursive: true, force: true });
  });
  const profile = join(directory, 'workspace.json');
  await writeFile(join(directory, 'ssh.json'), JSON.stringify({ offline: { host: '127.0.0.1', port: 1, username: 'test', password: 'fixture-only' } }));
  await writeFile(profile, JSON.stringify({ workspaceId: 'ack-contract', connectionName: 'offline',
    sshConfigFile: './ssh.json', remoteRoot: '/work', remoteStateDir: '/state', localStateDir: './state' }));
  const config = await loadWorkspaceConfig(profile);
  const tasks = new TaskService({
    async call(action, request) {
      if (action === 'task_register') return { jobId: request.command };
      assert.equal(action, 'task_start');
    },
  }, config.localStateDir, config.identity);
  for (const id of jobs) await tasks.start({ sessionId: 'owner', command: id, cwd: '/work' });
  for (const id of foreign) await tasks.start({ sessionId: 'other', command: id, cwd: '/work' });

  const preload = join(directory, 'preload.mjs');
  const remoteUrl = new URL('../build/services/remote-agent-client.js', import.meta.url).href;
  await writeFile(preload, `import { RemoteAgentClient } from ${JSON.stringify(remoteUrl)};
const directory = ${JSON.stringify(directory)};
${preloadSetup}
RemoteAgentClient.prototype.call = async function (action, { jobId }) {
  ${beforeExchange}
  if (action === 'maintenance') return {};
  if (action === 'status') return { jobId, state: jobId === 'running' ? 'running' : 'exited', completedAt: Date.now() / 1000 };
  if (action === 'ack') return { jobId, acknowledged: true };
  throw new Error('Unexpected SSH action: ' + action);
};`);
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: ['--import', pathToFileURL(preload).href, fileURLToPath(new URL('../build/index.js', import.meta.url)), '--workspace', profile], stderr: 'pipe' }));

  const call = (name, args, sessionId = 'owner', options) =>
    client.callTool({ name, arguments: { sessionId, ...args } }, undefined, options);
  const read = result => JSON.parse(result.content[0].text);
  const pending = async (sessionId) =>
    read(await call('remote_pending', {}, sessionId)).tasks.map(task => task.jobId).sort();
  return { directory, client, call, read, pending };
}

it('remote_ack confirms a batch independently without changing the single-task contract', async t => {
  const { call, read, pending } = await ackFixture(t, ['done-a', 'running', 'done-b', 'single'], { foreign: ['foreign'] });
  const acknowledgement = await call('remote_ack', { jobIds: ['done-a', 'running', 'foreign', 'done-b', 'done-a'] });
  assert.equal(acknowledgement.isError, undefined, acknowledgement.content[0].text);
  const { acknowledged, failed, unattempted } = read(acknowledgement);
  assert.deepEqual(acknowledged, ['done-a', 'done-b']);
  assert.deepEqual(failed.map(({ jobId, code }) => [jobId, code]),
    [['running', 'TASK_NOT_FINISHED'], ['foreign', 'TASK_SCOPE_MISMATCH']]);
  assert.deepEqual(unattempted, []);

  for (const args of [{}, { jobId: 'single', jobIds: ['single'] }, { jobIds: [] }, { jobIds: Array(51).fill('single') }]) {
    const invalid = await call('remote_ack', args);
    assert.equal(invalid.isError, true, invalid.content[0].text);
    assert.match(invalid.content[0].text, /Input validation error/);
  }
  assert.deepEqual(await pending(), ['running', 'single']);
  assert.deepEqual(await pending('other'), ['foreign']);
  assert.deepEqual(read(await call('remote_ack', { jobId: 'single' })), { acknowledged: true, jobId: 'single' });
  assert.deepEqual(await pending(), ['running']);
});

// Trigger the production deadline signal at a known exchange, without waiting 45 seconds.
const ackDeadlineSetup = `
const deadline = new AbortController();
const realTimeout = AbortSignal.timeout;
AbortSignal.timeout = ms => ms === 45_000 ? deadline.signal : realTimeout(ms);
`;

it('remote_ack batch deadline returns known results and separates the in-flight job from unattempted jobs', async t => {
  const { call, read, pending } = await ackFixture(t, ['done', 'running', 'slow', 'later'], {
    preloadSetup: ackDeadlineSetup,
    beforeExchange: `
if (action === 'ack' && jobId === 'slow') {
  deadline.abort(new DOMException('Batch deadline reached', 'TimeoutError'));
  await new Promise(() => {});
}
`,
  });
  const response = await call('remote_ack', { jobIds: ['done', 'running', 'slow', 'later'] }, 'owner', { timeout: 2000 });
  assert.equal(response.isError, undefined, response.content[0].text);
  const { acknowledged, failed, unattempted } = read(response);
  assert.deepEqual(acknowledged, ['done']);
  assert.deepEqual(failed.map(({ jobId, code }) => [jobId, code]), [
    ['running', 'TASK_NOT_FINISHED'], ['slow', 'ACK_OUTCOME_UNKNOWN'],
  ]);
  assert.deepEqual(unattempted, ['later']);
  assert.deepEqual(await pending(), ['later', 'running', 'slow']);
});

it('remote_ack batch deadline also covers maintenance before the first job', async t => {
  const { call, read, pending } = await ackFixture(t, ['later'], {
    preloadSetup: ackDeadlineSetup,
    beforeExchange: `
if (action === 'maintenance') {
  deadline.abort(new DOMException('Batch deadline reached', 'TimeoutError'));
  await new Promise(() => {});
}
`,
  });
  const response = await call('remote_ack', { jobIds: ['later'] }, 'owner', { timeout: 2000 });
  assert.equal(response.isError, undefined, response.content[0].text);
  assert.deepEqual(read(response), { acknowledged: [], failed: [], unattempted: ['later'] });
  assert.deepEqual(await pending(), ['later']);
});

async function waitForAckTest(check) {
  for (let i = 0; i < 200; ++i) {
    if (await check()) return;
    await delay(10);
  }
  assert.fail('Timed out waiting for the acknowledgement fixture');
}

it('remote_ack batch stops before the next task when the MCP request is cancelled', async t => {
  const mcpUrl = import.meta.resolve('@modelcontextprotocol/sdk/server/mcp.js');
  const { directory, client, call, pending } = await ackFixture(t, ['slow', 'later'], {
    preloadSetup: `
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { McpServer } from ${JSON.stringify(mcpUrl)};
const registerTool = McpServer.prototype.registerTool;
McpServer.prototype.registerTool = function (name, config, handler) {
  return registerTool.call(this, name, config, name !== 'remote_ack' ? handler : async (...args) => {
    try { return await handler(...args); }
    finally { await writeFile(join(directory, 'handler-finished'), ''); }
  });
};
`,
    beforeExchange: `
if (action === 'ack' && jobId === 'slow') {
  await writeFile(join(directory, 'ack-started'), '');
  while (!await access(join(directory, 'release')).then(() => true, () => false)) await delay(5);
}
if (action === 'status' && jobId === 'later') await writeFile(join(directory, 'next-started'), '');
`,
  });
  const exists = name => access(join(directory, name)).then(() => true, () => false);
  const controller = new AbortController();
  const cancelled = assert.rejects(call('remote_ack', { jobIds: ['slow', 'later'] },
    'owner', { signal: controller.signal, timeout: 5000 }), /cancel batch on purpose/);
  await waitForAckTest(() => exists('ack-started'));
  controller.abort(new Error('cancel batch on purpose'));
  await cancelled;
  await client.ping(); // The server has received the preceding cancellation notification.
  await writeFile(join(directory, 'release'), '');
  await waitForAckTest(() => exists('handler-finished'));
  await waitForAckTest(async () => !(await pending()).includes('slow'));
  assert.equal(await exists('next-started'), false);
  assert.deepEqual(await pending(), ['later']);
});

it('workspace MCP storage report keeps the local end and marks an unreachable remote unknown (issue #19)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ssh-mcp-storage-'));
  const client = new Client({ name: 'contract-test', version: '1' });
  try {
    // port 1 on loopback: connection refused, a real unreachable remote end.
    await writeFile(join(directory, 'ssh.json'), JSON.stringify({ offline: { host: '127.0.0.1', port: 1, username: 'test', password: 'must-not-leak' } }));
    await writeFile(join(directory, 'workspace.json'), JSON.stringify({ workspaceId: 'storage-contract', connectionName: 'offline', sshConfigFile: './ssh.json', remoteRoot: '/work', remoteStateDir: '/state', localStateDir: './state' }));
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../build/index.js', import.meta.url)), '--workspace', join(directory, 'workspace.json')], stderr: 'pipe' }));
    const tools = await client.listTools();
    const workspace = tools.tools.find(tool => tool.name === 'remote_workspace');
    assert.ok(workspace.inputSchema.properties.includeStorage, 'remote_workspace exposes includeStorage');
    const report = await client.callTool({ name: 'remote_workspace', arguments: { sessionId: 'contract-session', includeStorage: true } });
    assert.equal(report.isError, undefined, report.content?.[0]?.text);
    const data = JSON.parse(report.content[0].text);
    assert.equal(typeof data.storage.local.usedBytes, 'number');
    assert.equal(typeof data.storage.local.limitBytes, 'number');
    assert.equal(data.storage.local.usedBytes,
      data.storage.local.stateBytes + data.storage.local.tempBytes + data.storage.local.reservedBytes);
    assert.equal(data.storage.remote.status, 'unknown');
    for (const field of ['usedBytes', 'limitBytes', 'stateBytes', 'tempBytes', 'reservedBytes']) {
      assert.equal(field in data.storage.remote, false, `${field} must not appear on an unknown end`);
    }
    assert.ok(!JSON.stringify(data).includes('must-not-leak'));
    assert.ok(Buffer.byteLength(JSON.stringify(data), 'utf8') <= 4096, 'the report stays within the 4 KiB budget');
  } finally {
    await client.close();
    const child = relative(tmpdir(), directory);
    assert.ok(child && !isAbsolute(child) && !child.startsWith('..'));
    await rm(directory, { recursive: true, force: true });
  }
});

it('workspace MCP serves the full usage guide through remote_help with zero remote interaction (issue #30)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ssh-mcp-help-'));
  const client = new Client({ name: 'contract-test', version: '1' });
  try {
    // port 1 on loopback: connection refused; the guide must still be served.
    await writeFile(join(directory, 'ssh.json'), JSON.stringify({ offline: { host: '127.0.0.1', port: 1, username: 'test', password: 'must-not-leak' } }));
    await writeFile(join(directory, 'workspace.json'), JSON.stringify({ workspaceId: 'help-contract', connectionName: 'offline', sshConfigFile: './ssh.json', remoteRoot: '/work', remoteStateDir: '/state', localStateDir: './state' }));
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../build/index.js', import.meta.url)), '--workspace', join(directory, 'workspace.json')], stderr: 'pipe' }));
    assert.match(client.getInstructions(), /remote_help/, 'server instructions point agents to remote_help');
    const tools = await client.listTools();
    const help = tools.tools.find(tool => tool.name === 'remote_help');
    assert.ok(help, 'remote_help is advertised');
    assert.deepEqual(Object.keys(help.inputSchema.properties ?? {}), [], 'remote_help takes no parameters');
    assert.deepEqual(help.inputSchema.required ?? [], [], 'remote_help requires nothing');
    const result = await client.callTool({ name: 'remote_help', arguments: {} });
    assert.equal(result.isError, undefined, result.content?.[0]?.text);
    const data = JSON.parse(result.content[0].text);
    assert.equal(typeof data.guide, 'string');
    assert.match(data.guide, /省略 readToken.*当前会话.*文件.*最新/);
    assert.match(data.guide, /Codex/, 'shared guide covers the Codex host workflow');
    for (const name of ['remote_upload', 'remote_download']) {
      assert.match(tools.tools.find(tool => tool.name === name).description, /Codex/, `${name} describes the current-host waiting workflow`);
    }
    assert.ok(data.guide.length > 200, 'the full guide is served, not a stub');
    for (const keyword of ['remote_workspace', 'remote_read', 'sessionId', '后台', 'wait', 'remote_ack', 'jobIds']) {
      assert.ok(data.guide.includes(keyword), `guide covers ${keyword}`);
    }
    assert.ok(data.guide.includes('你正在通过 SSH 远端绑定'), 'the guide addresses the agent directly');
    assert.ok(!data.guide.includes('本目录可配置'), 'the guide does not speak about the directory in document voice');
    assert.ok(!JSON.stringify(data).includes('must-not-leak'));
    assert.ok(!('storage' in data) && !('status' in data), 'the guide carries no remote-end state');
    // A real maintenance round writes maintenance.json before anything can fail
    // (review R3), so its absence proves remote_help triggered no round.
    const stateRoot = join(directory, 'state');
    const identities = await readdir(stateRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of identities) {
      if (!entry.isDirectory()) continue;
      const stamped = await access(join(stateRoot, entry.name, 'maintenance.json')).then(() => true, () => false);
      assert.equal(stamped, false, 'remote_help must not trigger a maintenance round');
    }
  } finally {
    await client.close();
    const child = relative(tmpdir(), directory);
    assert.ok(child && !isAbsolute(child) && !child.startsWith('..'));
    await rm(directory, { recursive: true, force: true });
  }
});
