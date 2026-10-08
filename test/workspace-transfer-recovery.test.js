import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadWorkspaceConfig, identityStateDirectory } from '../build/config/workspace.js';
import { FileService } from '../build/services/file-service.js';
import { readFile } from 'node:fs/promises';

async function fixture(terminal = false, retriable = true) {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-transfer-recovery-'));
  const profile = join(root, 'workspace.json');
  await writeFile(join(root, 'ssh.json'), JSON.stringify({ offline: {
    host: '127.0.0.1', port: 1, username: 'fixture', password: 'fixture-only',
  } }));
  await writeFile(profile, JSON.stringify({ workspaceId: 'recovery', connectionName: 'offline',
    sshConfigFile: './ssh.json', remoteRoot: '/work', remoteStateDir: '/state', localStateDir: './state' }));
  const config = await loadWorkspaceConfig(profile);
  const seed = async (id, sessionId) => {
    const directory = join(identityStateDirectory(config.localStateDir, config.identity), 'transfers', id);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'record.json'), JSON.stringify({ schemaVersion: 1, transferId: id,
      workspaceId: config.workspaceId, sessionId, direction: 'upload', localPath: join(root, 'source.bin'),
      remotePath: '/work/target.bin', totalBytes: 1024, totalSha256: 'f'.repeat(64), chunkSize: 65536,
      sourceIdentity: { size: 1024, mtimeMs: 1 }, overwrite: false, create: false, expectedVersion: null,
      createdAt: '2026-10-08T00:00:00.000Z' }));
  };
  const preload = join(root, 'preload.mjs');
  const remoteUrl = new URL('../build/services/remote-agent-client.js', import.meta.url).href;
  await writeFile(preload, `import { RemoteAgentClient } from ${JSON.stringify(remoteUrl)};
RemoteAgentClient.prototype.call = async function () { throw new Error('Unexpected SSH access'); };
RemoteAgentClient.prototype.exchange = async function (action) {
  if (${terminal}) return { state: 'completed', confirmedOffset: 1024, transferId: '${'a'.repeat(32)}', acknowledged: action === 'transfer_ack' };
  throw Object.assign(new Error('Injected transport break'), { code: 'PROBE_TRANSPORT_BREAK', retriable: ${retriable}, transferId: '${'a'.repeat(32)}' });
};`);
  const client = new Client({ name: 'transfer-recovery-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: ['--import', pathToFileURL(preload).href, fileURLToPath(new URL('../build/index.js', import.meta.url)), '--workspace', profile], stderr: 'pipe' }));
  return { root, client, seed, async close() { await client.close(); await rm(root, { recursive: true }); } };
}

it('MCP discovers only this session transfers offline and preserves error recovery identifiers', async () => {
  const f = await fixture();
  try {
    const ownId = 'a'.repeat(32);
    await f.seed(ownId, 'session-own');
    await f.seed('b'.repeat(32), 'session-other');
    const tools = (await f.client.listTools()).tools;
    assert.ok(tools.some(tool => tool.name === 'remote_transfer_pending'));
    const listed = await f.client.callTool({ name: 'remote_transfer_pending', arguments: { sessionId: 'session-own' } });
    assert.equal(listed.isError, undefined, listed.content[0].text);
    const data = JSON.parse(listed.content[0].text);
    assert.deepEqual(data.transfers.map(entry => entry.transferId), [ownId]);
    assert.equal(data.nextOffset, null);
    const failed = await f.client.callTool({ name: 'remote_upload', arguments: { sessionId: 'session-own', action: 'status', transferId: ownId } });
    assert.equal(failed.isError, true);
    const fault = JSON.parse(failed.content[0].text);
    assert.equal(fault.transferId, ownId);
    assert.equal(fault.retriable, true);
    assert.equal(fault.code, 'PROBE_TRANSPORT_BREAK');
  } finally { await f.close(); }
});

it('terminal MCP results require explicit acknowledgement and advertise the next action', async () => {
  const f = await fixture(true);
  try {
    const transferId = 'a'.repeat(32);
    await f.seed(transferId, 'session-own');
    const result = await f.client.callTool({ name: 'remote_upload', arguments: { action: 'status', sessionId: 'session-own', transferId } });
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.acknowledgementRequired, true);
    assert.deepEqual(body.nextAction, { tool: 'remote_upload', arguments: { action: 'ack', sessionId: 'session-own', transferId } });
    const pending = async () => JSON.parse((await f.client.callTool({ name: 'remote_transfer_pending', arguments: { sessionId: 'session-own' } })).content[0].text).transfers;
    assert.equal((await pending()).length, 1, 'status must not consume the result');
    const ack = await f.client.callTool({ name: body.nextAction.tool, arguments: body.nextAction.arguments });
    assert.equal(ack.isError, undefined, ack.content[0].text);
    assert.equal((await pending()).length, 0);
  } finally { await f.close(); }
});

it('remote_help explains background transfer start, recovery, acknowledgement and allowed local paths', async () => {
  const f = await fixture();
  try {
    const guide = JSON.parse((await f.client.callTool({ name: 'remote_help', arguments: {} })).content[0].text).guide;
    for (const keyword of ['transfer start', 'transfer wait', 'remote_transfer_pending', 'allowedLocalPaths', '--force-local']) assert.ok(guide.includes(keyword), keyword);
  } finally { await f.close(); }
});

it('local path refusals explain the allowed root without granting temporary-directory access', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-path-guidance-'));
  try {
    const localRoot = join(root, 'work');
    await mkdir(localRoot);
    const outside = join(root, 'archive.tar.gz');
    await writeFile(outside, 'fixture');
    const files = new FileService({}, { localRoot, connectionName: 'test', sshConfigs: { test: { allowedLocalPaths: [] } } });
    await assert.rejects(files.localPath(outside, false), error => {
      assert.equal(error.code, 'PATH_NOT_ALLOWED');
      assert.ok(error.message.includes(localRoot));
      assert.match(error.message, /allowedLocalPaths/);
      return true;
    });
  } finally { await rm(root, { recursive: true }); }
});

it('MCP start returns a recoverable preparing identifier before contacting SSH', async () => {
  const f = await fixture(false, false);
  try {
    const source = join(f.root, 'source.bin');
    await writeFile(source, 'source for detached preparation');
    const started = await f.client.callTool({ name: 'remote_upload', arguments: {
      sessionId: 'session-own', action: 'start', localPath: source, path: 'target.bin',
    } }, undefined, { timeout: 1000 });
    assert.equal(started.isError, undefined, started.content[0].text);
    const body = JSON.parse(started.content[0].text);
    assert.equal(body.state, 'preparing');
    assert.match(body.transferId, /^[a-f0-9]{32}$/);
    const config = await loadWorkspaceConfig(join(f.root, 'workspace.json'));
    const directory = join(identityStateDirectory(config.localStateDir, config.identity), 'transfers', body.transferId);
    const stored = JSON.parse(await readFile(join(directory, 'record.json'), 'utf8'));
    assert.equal(stored.sessionId, 'session-own');
    await f.client.close();
    // The independent worker must persist its failure even after the MCP exits.
    const deadline = Date.now() + 3000;
    for (;;) {
      const observed = JSON.parse(await readFile(join(directory, 'record.json'), 'utf8'));
      if (observed.state === 'failed') { assert.equal(observed.error.code, 'PROBE_TRANSPORT_BREAK'); break; }
      assert.ok(Date.now() < deadline, 'worker did not record its outcome');
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  } finally { await f.close(); }
});
