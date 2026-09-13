import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadWorkspaceConfig } from '../build/config/workspace.js';

const profile = process.env.SSH_MCP_TEST_WORKSPACE;
it('real workspace MCP protects uploads and transfers binary data without granting hidden read coverage', { skip: !profile, timeout: 90000 }, async () => {
  const config = await loadWorkspaceConfig(profile);
  const sessionId = 'mcp-' + randomUUID();
  const path = sessionId + '.txt';
  const localPath = join(config.localRoot, sessionId + '.bin');
  const downloaded = join(config.localRoot, sessionId + '-download.bin');
  const client = new Client({ name: 'remote-contract', version: '1' });
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: { sessionId, ...args } });
    return { error: result.isError, data: JSON.parse(result.content[0].text) };
  };
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../build/index.js', import.meta.url)), '--workspace', profile], stderr: 'pipe' }));
    assert.equal((await call('remote_workspace')).data.capabilities.persistentTasks, true);
    // metadataOnly observes the version (or absence) without content or a credential.
    const absent = await call('remote_read', { path: 'never-created-' + sessionId, metadataOnly: true });
    assert.equal(absent.error, undefined, JSON.stringify(absent));
    assert.equal(absent.data.exists, false);
    assert.equal(absent.data.version, null);
    assert.equal((await call('remote_write', { path, text: 'hello\nworld\n', create: true })).error, undefined);
    const meta = await call('remote_read', { path, metadataOnly: true });
    assert.equal(meta.error, undefined, JSON.stringify(meta));
    assert.equal(meta.data.exists, true);
    assert.ok(String(meta.data.version).startsWith('m1-'));
    assert.equal('readToken' in meta.data, false);
    assert.equal('text' in meta.data, false);
    const partial = await call('remote_read', { path, fromLine: 1, toLine: 1 });
    const transfer = await call('remote_download', { path, localPath: downloaded });
    assert.equal(transfer.error, undefined, JSON.stringify(transfer));
    assert.equal(await readFile(downloaded, 'utf8'), 'hello\nworld\n');
    const hiddenRead = await call('remote_write', { path, text: 'lost', readToken: partial.data.readToken });
    assert.equal(hiddenRead.data.code, 'READ_REQUIRED');
    const binary = Buffer.from([0, 255, 1, 128]);
    await writeFile(localPath, binary);
    const blocked = await call('remote_upload', { path, localPath });
    assert.equal(blocked.data.code, 'READ_REQUIRED');
    const full = await call('remote_read', { path });
    const edited = await call('remote_edit', { path, readToken: full.data.readToken,
      edits: [{ oldText: 'hello', newText: 'hello 中文' }] });
    assert.equal(edited.error, undefined, JSON.stringify(edited));
    assert.equal(edited.data.rereadRequired, false);
    assert.equal(edited.data.complete, true);
    assert.notEqual(edited.data.readToken, full.data.readToken);
    const repeated = await call('remote_edit', { path, readToken: edited.data.readToken,
      edits: [{ oldText: 'hello 中文', newText: 'second edit without read' }] });
    assert.equal(repeated.error, undefined, JSON.stringify(repeated));
    assert.equal(repeated.data.rereadRequired, false);
    const upload = await call('remote_upload', { path, localPath, readToken: repeated.data.readToken });
    assert.equal(upload.error, undefined, JSON.stringify(upload));
    const binaryRead = await call('remote_read', { path, encoding: 'base64' });
    assert.deepEqual(Buffer.from(binaryRead.data.data, 'base64'), binary);
    // Stale cursors bound to an old version are rejected after a new write.
    const beforeWrite = await call('remote_read', { path, offset: 0, maxBytes: 2, encoding: 'base64' });
    const overwritten = await call('remote_write', { path, data: Buffer.from('changed content\n').toString('base64'), readToken: binaryRead.data.readToken });
    assert.equal(overwritten.error, undefined, JSON.stringify(overwritten));
    const staleCursor = await call('remote_read', { path, offset: beforeWrite.data.nextOffset, expectedVersion: beforeWrite.data.version });
    assert.equal(staleCursor.data.code, 'FILE_CONFLICT');
    const finalRead = await call('remote_read', { path });
    assert.equal((await call('remote_delete', { path, readToken: finalRead.data.readToken })).error, undefined);
  } finally {
    await client.close();
    for (const target of [localPath, downloaded]) await unlink(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
});
