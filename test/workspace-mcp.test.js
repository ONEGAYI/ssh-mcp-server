import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

it('workspace MCP advertises guarded file tools without the legacy unguarded upload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ssh-mcp-tools-'));
  const client = new Client({ name: 'contract-test', version: '1' });
  try {
    await writeFile(join(directory, 'ssh.json'), JSON.stringify({ offline: { host: '127.0.0.1', port: 1, username: 'test', password: 'must-not-leak' } }));
    await writeFile(join(directory, 'workspace.json'), JSON.stringify({ workspaceId: 'contract', connectionName: 'offline', sshConfigFile: './ssh.json', remoteRoot: '/work', remoteStateDir: '/state' }));
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../build/index.js', import.meta.url)), '--workspace', join(directory, 'workspace.json')], stderr: 'pipe' }));
    const tools = await client.listTools();
    for (const name of ['remote_read', 'remote_edit', 'remote_write', 'remote_upload', 'remote_download', 'remote_move', 'remote_delete', 'remote_pending', 'remote_wait']) {
      assert.ok(tools.tools.some(tool => tool.name === name), name);
    }
    assert.ok(!tools.tools.some(tool => tool.name === 'upload' || tool.name === 'execute_command'));
    const read = tools.tools.find(tool => tool.name === 'remote_read');
    assert.ok(read.inputSchema.properties.metadataOnly, 'remote_read exposes metadataOnly');
    assert.ok(read.inputSchema.properties.expectedVersion, 'remote_read exposes expectedVersion');
    assert.ok(!/16 MiB/.test(read.description), 'remote_read no longer caps file size');
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
