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
    assert.equal(hiddenRead.data.code, 'INVALID_REQUEST');
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
    // Since #10 the overwrite is explicit and bound to the metadataOnly version.
    const writeMeta = await call('remote_read', { path, metadataOnly: true });
    const overwritten = await call('remote_write', { path, data: Buffer.from('changed content\n').toString('base64'),
      overwrite: true, expectedVersion: writeMeta.data.version });
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

it('real workspace edits a 200 MiB file through the streamed replacement path', { skip: !profile, timeout: 300000 }, async () => {
  const { createWorkspaceRuntime } = await import('../build/services/workspace-runtime.js');
  const sessionId = 'mcp-' + randomUUID();
  const remoteName = 'netlist-' + sessionId + '.txt';
  const lineCount = (200 * 1024 * 1024) / 64; // fixed 64-byte lines
  const lineOf = index => { const head = 'L' + String(index) + ' '; return head + 'x'.repeat(64 - head.length - 1) + '\n'; };
  const target = Math.floor(lineCount / 2);
  const runtime = await createWorkspaceRuntime(profile);
  const client = new Client({ name: 'remote-contract', version: '1' });
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: { sessionId, ...args } });
    return { error: result.isError, data: JSON.parse(result.content[0].text) };
  };
  const runTask = async command => {
    const registration = await runtime.remote.call('task_register', { protocol: 2,
      cwd: runtime.config.remoteRoot, command });
    await runtime.remote.call('task_start', { protocol: 2, jobId: registration.jobId });
    const deadline = Date.now() + 120000;
    for (;;) {
      const state = await runtime.remote.call('status', { jobId: registration.jobId });
      if (['exited', 'cancelled', 'interrupted'].includes(state.state)) {
        assert.equal(state.state, 'exited', JSON.stringify(state));
        return state;
      }
      if (Date.now() > deadline) throw new Error('task did not finish: ' + JSON.stringify(state));
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  };
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../build/index.js', import.meta.url)), '--workspace', profile], stderr: 'pipe' }));
    // Generate the 200 MiB fixture on the remote side itself: fixed 64-byte
    // lines ('L<n> ' head + x padding + newline), matching lineOf exactly.
    await runTask(`python3 -c "f = open('${remoteName}', 'wb');\\n` +
      `[f.write(('L%d ' % i).encode('ascii') + b'x' * (64 - len('L%d ' % i) - 1) + b'\\n') for i in range(1, ${lineCount + 1})];\\n` +
      `f.close()"`);
    const meta = await call('remote_read', { path: remoteName, metadataOnly: true });
    assert.equal(meta.data.size, 200 * 1024 * 1024, JSON.stringify(meta));
    // Read only the target window; the edit request itself carries nothing but
    // oldText/newText, so no whole-file transfer happens on the edit path.
    const window = await call('remote_read', { path: remoteName, offset: (target - 1) * 64, maxBytes: 64 });
    assert.equal(window.data.text, lineOf(target));
    const replacement = 'L' + String(target) + ' patched replacement line padding well beyond the original width\n';
    const delta = Buffer.byteLength(replacement) - 64;
    assert.ok(delta > 0, 'the streamed edit must grow the file');
    const edited = await call('remote_edit', { path: remoteName, readToken: window.data.readToken,
      edits: [{ oldText: lineOf(target).trimEnd(), newText: replacement.trimEnd() }] });
    assert.equal(edited.error, undefined, JSON.stringify(edited));
    assert.equal(edited.data.rereadRequired, false);
    assert.equal(edited.data.bytesWritten, 200 * 1024 * 1024 + delta);
    assert.equal(edited.data.editsApplied, 1);
    // The spliced file: untouched head, patched line, shifted tail.
    const head = await call('remote_read', { path: remoteName, offset: 0, maxBytes: 64 });
    assert.equal(head.data.text, lineOf(1));
    const patched = await call('remote_read', { path: remoteName, offset: (target - 1) * 64, maxBytes: 256 });
    assert.ok(patched.data.text.startsWith(replacement.trimEnd()), patched.data.text.slice(0, 80));
    const tail = await call('remote_read', { path: remoteName, offset: target * 64 + delta, maxBytes: 64 });
    assert.equal(tail.data.text, lineOf(target + 1));
    const finalMeta = await call('remote_read', { path: remoteName, metadataOnly: true });
    assert.equal(finalMeta.data.size, 200 * 1024 * 1024 + delta);
  } finally {
    await client.close().catch(() => undefined);
    await runTask(`rm -f '${remoteName}'`).catch(() => undefined);
    runtime.close();
  }
});
