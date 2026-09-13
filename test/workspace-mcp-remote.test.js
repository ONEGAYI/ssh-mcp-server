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
    assert.equal((await call('remote_write', { path, text: 'hello\nworld\n', create: true })).error, undefined);
    // Issue #11: multi-backend search end to end. The VM typically lacks rg
    // but has GNU grep, exercising the fallback order; the reported engine
    // must be one of the three backends and pagination must round-trip.
    const searchPath = sessionId + '-search.txt';
    assert.equal((await call('remote_write', { path: searchPath, create: true, text: 'filler\nneedle one\nmore filler\nneedle two\n' })).error, undefined);
    const caps = (await call('remote_workspace')).data.capabilities;
    assert.ok(['ripgrep', 'gnu-grep', 'python-literal'].includes(caps.searchEngine), caps.searchEngine);
    assert.ok(Array.isArray(caps.searchBackends) && caps.searchBackends.includes('python-literal'));
    const page1 = await call('remote_search', { path: searchPath, pattern: 'needle', limit: 1 });
    assert.equal(page1.error, undefined, JSON.stringify(page1));
    assert.ok(['ripgrep', 'gnu-grep', 'python-literal'].includes(page1.data.engine));
    assert.equal(page1.data.matches.length, 1);
    assert.equal(page1.data.truncated, true);
    assert.ok(page1.data.nextCursor);
    const page2 = await call('remote_search', { path: searchPath, pattern: 'needle', limit: 1, cursor: page1.data.nextCursor });
    assert.equal(page2.error, undefined, JSON.stringify(page2));
    assert.deepEqual(page2.data.matches.map(match => match.line), [4]);
    assert.equal(page2.data.truncated, false);
    assert.equal('readToken' in page1.data, false);
    const searchRead = await call('remote_read', { path: searchPath });
    await call('remote_delete', { path: searchPath, readToken: searchRead.data.readToken });
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
    assert.equal((await call('remote_delete', { path, readToken: binaryRead.data.readToken })).error, undefined);
  } finally {
    await client.close();
    for (const target of [localPath, downloaded]) await unlink(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
});
