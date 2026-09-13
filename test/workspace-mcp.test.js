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
