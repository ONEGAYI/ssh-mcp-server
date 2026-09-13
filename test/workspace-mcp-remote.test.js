import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { writeFile, readFile, open, rm, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadWorkspaceConfig } from '../build/config/workspace.js';

const profile = process.env.SSH_MCP_TEST_WORKSPACE;
it('real workspace MCP protects uploads and transfers binary data without granting hidden read coverage', { skip: !profile, timeout: 90000 }, async () => {
  const { createWorkspaceRuntime } = await import('../build/services/workspace-runtime.js');
  const config = await loadWorkspaceConfig(profile);
  const sessionId = 'mcp-' + randomUUID();
  const path = sessionId + '.txt';
  const localPath = join(config.localRoot, sessionId + '.bin');
  const downloaded = join(config.localRoot, sessionId + '-download.bin');
  const runtime = await createWorkspaceRuntime(profile);
  const client = new Client({ name: 'remote-contract', version: '1' });
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: { sessionId, ...args } });
    return { error: result.isError, data: JSON.parse(result.content[0].text) };
  };
  // Issue #20: remote_delete/remote_move are retired (ADR 0007); the test
  // cleans up through a registered execute task, the shell replacement path.
  const runTask = async command => {
    const registration = await runtime.remote.call('task_register', { protocol: 2,
      cwd: runtime.config.remoteRoot, command });
    await runtime.remote.call('task_start', { protocol: 2, jobId: registration.jobId });
    const deadline = Date.now() + 120000;
    for (;;) {
      const state = await runtime.remote.call('status', { jobId: registration.jobId });
      if (['exited', 'cancelled', 'interrupted'].includes(state.state)) {
        assert.equal(state.state, 'exited', JSON.stringify(state));
        assert.equal(state.exitCode, 0, JSON.stringify(state));
        return state;
      }
      if (Date.now() > deadline) throw new Error('task did not finish: ' + JSON.stringify(state));
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  };
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../build/index.js', import.meta.url)), '--workspace', profile], stderr: 'pipe' }));
    assert.equal((await call('remote_workspace')).data.capabilities.persistentTasks, true);
    // Issue #19: the default workspace reply stays free of statistics; the
    // opt-in storage report is a bounded two-end ledger + maintenance summary.
    const plainWorkspace = await call('remote_workspace');
    assert.equal('storage' in plainWorkspace.data, false, 'default call must not attach statistics');
    const storage = await call('remote_workspace', { includeStorage: true });
    assert.equal(storage.error, undefined, JSON.stringify(storage));
    const report = storage.data.storage;
    for (const end of ['local', 'remote']) {
      assert.equal(typeof report[end].usedBytes, 'number', end);
      assert.equal(report[end].usedBytes,
        report[end].stateBytes + report[end].tempBytes + report[end].reservedBytes, end);
      assert.equal(typeof report[end].limitBytes, 'number', end);
      assert.equal(typeof report[end].maintenance.lastCompletedAt, 'number', end);
    }
    assert.equal('status' in report.remote, false, 'a reachable end reports numbers, not unknown');
    assert.ok(Buffer.byteLength(JSON.stringify(storage.data), 'utf8') <= 4096, 'the report stays within the 4 KiB budget');
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
    await runTask(`rm -f '${searchPath}'`);
    const partial = await call('remote_read', { path, fromLine: 1, toLine: 1 });
    const transfer = await call('remote_download', { path, localPath: downloaded });
    assert.equal(transfer.error, undefined, JSON.stringify(transfer));
    assert.equal(transfer.data.state, 'completed', JSON.stringify(transfer.data));
    assert.equal(transfer.data.bytesWritten, 'hello\nworld\n'.length, JSON.stringify(transfer.data));
    assert.equal('readToken' in transfer.data, false); // downloads never grant read coverage
    assert.equal(await readFile(downloaded, 'utf8'), 'hello\nworld\n');
    const hiddenRead = await call('remote_write', { path, text: 'lost', readToken: partial.data.readToken });
    // The write schema strips the legacy readToken; the create-only default
    // then refuses the existing target with guidance toward the overwrite path.
    assert.equal(hiddenRead.data.code, 'FILE_CONFLICT');
    const binary = Buffer.from([0, 255, 1, 128]);
    await writeFile(localPath, binary);
    // Edit chain: full read, first edit, then a follow-up edit with the
    // renewed token and no reread.
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
    // Uploading over an existing target without an explicit overwrite is
    // refused by the create-only default (issue #10 / ADR 0008).
    const blocked = await call('remote_upload', { path, localPath });
    assert.equal(blocked.data.code, 'FILE_CONFLICT');
    const uploadMeta = await call('remote_read', { path, metadataOnly: true });
    const upload = await call('remote_upload', { path, localPath,
      overwrite: true, expectedVersion: uploadMeta.data.version });
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
    await runTask(`rm -f '${path}'`);
  } finally {
    await client.close();
    await runTask(`rm -f '${path}'`).catch(() => undefined);
    runtime.close();
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
        assert.equal(state.exitCode, 0, JSON.stringify(state));
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
    await runTask(`python3 -c "f = open('${remoteName}', 'wb'); ` +
      `[f.write(('L%d ' % i).encode('ascii') + b'x' * (64 - len('L%d ' % i) - 1) + b'\\n') for i in range(1, ${lineCount + 1})]; ` +
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

it('real workspace uploads 200 MiB resumably and resends only unconfirmed data (issue #13)', { skip: !profile, timeout: 300000 }, async () => {
  const { createWorkspaceRuntime } = await import('../build/services/workspace-runtime.js');
  const sessionId = 'mcp-' + randomUUID();
  const remoteName = 'big-upload-' + sessionId + '.bin';
  const localPath = join((await loadWorkspaceConfig(profile)).localRoot, remoteName);
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
        assert.equal(state.exitCode, 0, JSON.stringify(state));
        return state;
      }
      if (Date.now() > deadline) throw new Error('task did not finish: ' + JSON.stringify(state));
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  };
  const startedAt = Date.now();
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../build/index.js', import.meta.url)), '--workspace', profile], stderr: 'pipe' }));
    // A 200 MiB deterministic fixture: one random MiB tile repeated, digested
    // while it is written.
    const tile = randomBytes(1024 * 1024);
    const digest = createHash('sha256');
    const handle = await open(localPath, 'wx', 0o600);
    try {
      for (let index = 0; index < 200; index++) { await handle.writeFile(tile); digest.update(tile); }
      await handle.sync();
    } finally { await handle.close(); }
    const totalSha256 = digest.digest('hex');
    const size = (await stat(localPath)).size;
    assert.equal(size, 200 * 1024 * 1024);
    // First drive stops on a small budget: durable progress, no completion,
    // and the tool returns the persistent identifier plus bounded state.
    let partial;
    for (let attempt = 0; attempt < 5; attempt++) {
      const step = attempt === 0
        ? await call('remote_upload', { localPath, path: remoteName, budgetMs: 1000 })
        : await call('remote_upload', { action: 'resume', transferId: partial.data.transferId, budgetMs: 1000 });
      assert.equal(step.error, undefined, JSON.stringify(step));
      partial = step;
      if (partial.data.state !== 'transferring' || partial.data.budgetExhausted !== true) break;
      if (partial.data.confirmedOffset > 0 && partial.data.confirmedOffset < size) break;
    }
    assert.equal(partial.data.state, 'transferring', JSON.stringify(partial.data));
    assert.equal(partial.data.budgetExhausted, true, JSON.stringify(partial.data));
    const confirmedBefore = partial.data.confirmedOffset;
    assert.ok(confirmedBefore > 0 && confirmedBefore < size, 'expected a mid-transfer stop, got ' + JSON.stringify(partial.data));
    // Queries observe without side effects and without renewing anything.
    const observed = await call('remote_upload', { action: 'status', transferId: partial.data.transferId });
    assert.equal(observed.data.state, 'transferring');
    assert.equal(observed.data.confirmedOffset, confirmedBefore);
    assert.equal(observed.data.totalBytes, size);
    // Resume finishes the upload; only the unconfirmed tail is resent.
    const done = await call('remote_upload', { action: 'resume', transferId: partial.data.transferId, budgetMs: 240000 });
    assert.equal(done.error, undefined, JSON.stringify(done));
    assert.equal(done.data.state, 'completed');
    assert.equal(done.data.bytesWritten, size);
    assert.equal(done.data.sha256, totalSha256);
    const expectedBlocks = Math.ceil((size - confirmedBefore) / (1024 * 1024));
    assert.equal(done.data.blocksSent, expectedBlocks,
      'resume must send only the unconfirmed blocks');
    // Independent remote-side digest over the committed target.
    await runTask(`sha256sum '${remoteName}' > '${remoteName}.sha256'`);
    const remoteDigest = await call('remote_read', { path: remoteName + '.sha256' });
    assert.equal(remoteDigest.error, undefined, JSON.stringify(remoteDigest));
    assert.equal(remoteDigest.data.text.trim().split(' ')[0], totalSha256);
    const meta = await call('remote_read', { path: remoteName, metadataOnly: true });
    assert.equal(meta.data.size, size);
    console.log('[issue #13] 200 MiB upload: stopped at %d bytes, resumed %d blocks, total wall time %d ms',
      confirmedBefore, done.data.blocksSent, Date.now() - startedAt);
  } finally {
    await client.close().catch(() => undefined);
    await rm(localPath, { force: true });
    await runTask(`rm -f '${remoteName}' '${remoteName}.sha256'`).catch(() => undefined);
    runtime.close();
  }
});

it('real workspace downloads 200 MiB resumably with matching digests and no half files (issue #14)', { skip: !profile, timeout: 300000 }, async () => {
  const { createWorkspaceRuntime } = await import('../build/services/workspace-runtime.js');
  const sessionId = 'mcp-' + randomUUID();
  const remoteName = 'big-download-' + sessionId + '.bin';
  const localPath = join((await loadWorkspaceConfig(profile)).localRoot, remoteName);
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
        assert.equal(state.exitCode, 0, JSON.stringify(state));
        return state;
      }
      if (Date.now() > deadline) throw new Error('task did not finish: ' + JSON.stringify(state));
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  };
  const startedAt = Date.now();
  let partial = null; // visible to the finally for temp cleanup
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../build/index.js', import.meta.url)), '--workspace', profile], stderr: 'pipe' }));
    const size = 200 * 1024 * 1024;
    // Generate the fixture remotely (1 MiB tile repeated) and hash it there:
    // the remote digest is the sender's register-time truth to match against.
    await runTask(`python3 -c "import os; t = os.urandom(1024 * 1024); ` +
      `f = open('${remoteName}', 'wb'); [f.write(t) for _ in range(200)]; f.close()"`);
    await runTask(`sha256sum '${remoteName}' > '${remoteName}.sha256'`);
    const digestRead = await call('remote_read', { path: remoteName + '.sha256' });
    assert.equal(digestRead.error, undefined, JSON.stringify(digestRead));
    const remoteDigest = digestRead.data.text.trim().split(' ')[0];
    // First drive stops on a small budget: durable progress, no completion,
    // and the tool returns the persistent identifier plus bounded state.
    for (let attempt = 0; attempt < 5; attempt++) {
      const step = attempt === 0
        ? await call('remote_download', { path: remoteName, localPath, budgetMs: 1000 })
        : await call('remote_download', { action: 'resume', transferId: partial.data.transferId, budgetMs: 1000 });
      assert.equal(step.error, undefined, JSON.stringify(step));
      partial = step;
      if (partial.data.state !== 'transferring' || partial.data.budgetExhausted !== true) break;
      if (partial.data.confirmedOffset > 0 && partial.data.confirmedOffset < size) break;
    }
    assert.equal(partial.data.state, 'transferring', JSON.stringify(partial.data));
    assert.equal(partial.data.budgetExhausted, true, JSON.stringify(partial.data));
    const confirmedBefore = partial.data.confirmedOffset;
    assert.ok(confirmedBefore > 0 && confirmedBefore < size, 'expected a mid-transfer stop, got ' + JSON.stringify(partial.data));
    assert.equal('readToken' in partial.data, false);
    // Queries observe without side effects and without renewing anything.
    const observed = await call('remote_download', { action: 'status', transferId: partial.data.transferId });
    assert.equal(observed.data.state, 'transferring');
    assert.equal(observed.data.confirmedOffset, confirmedBefore);
    assert.equal(observed.data.totalBytes, size);
    // Resume finishes the download in bounded steps, each call staying under
    // the MCP client's 60 s request timeout; only the unconfirmed tail is
    // ever refetched, so the summed block count pins the precision.
    let done, refetched = 0;
    for (let attempt = 0; attempt < 10; attempt++) {
      const step = await call('remote_download', { action: 'resume', transferId: partial.data.transferId, budgetMs: 50000 });
      assert.equal(step.error, undefined, JSON.stringify(step));
      done = step;
      refetched += done.data.blocksFetched ?? 0;
      if (done.data.state === 'completed') break;
      assert.equal(done.data.state, 'transferring', JSON.stringify(done.data));
      assert.equal(done.data.budgetExhausted, true, JSON.stringify(done.data));
    }
    assert.equal(done.data.state, 'completed', JSON.stringify(done.data));
    assert.equal(done.data.bytesWritten, size);
    assert.equal(done.data.sha256, remoteDigest);
    assert.equal('readToken' in done.data, false);
    const expectedBlocks = Math.ceil((size - confirmedBefore) / (1024 * 1024));
    assert.equal(refetched, expectedBlocks,
      'resume must fetch only the unconfirmed blocks');
    // Independent local digest over the committed target, streamed.
    const localHash = createHash('sha256');
    const local = await open(localPath, 'r');
    try {
      const buffer = Buffer.alloc(1024 * 1024);
      for (let offset = 0; offset < size;) {
        const read = await local.read(buffer, 0, buffer.length, offset);
        if (!read.bytesRead) throw new Error('local download ended early');
        localHash.update(buffer.subarray(0, read.bytesRead));
        offset += read.bytesRead;
      }
    } finally { await local.close(); }
    assert.equal(localHash.digest('hex'), remoteDigest);
    // No formal half file: this transfer's receive temp is gone after commit.
    // Temps of OTHER interrupted transfers are intentionally retained for
    // their 3-day resume window, so the check is scoped to this transfer.
    const { readdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    assert.equal((await readdir(dirname(localPath)))
      .includes('.ssh-mcp-download-' + partial.data.transferId), false,
      'download temp files must not remain after commit');
    const stoppedAtMs = Date.now() - startedAt;
    console.log('[issue #14] 200 MiB download: stopped at %d bytes, resumed %d blocks, total wall time %d ms',
      confirmedBefore, refetched, stoppedAtMs);
  } finally {
    await client.close().catch(() => undefined);
    await rm(localPath, { force: true });
    await rm(join((await import('node:path')).dirname(localPath), '.ssh-mcp-download-' + (partial ? partial.data.transferId : '')), { force: true });
    await runTask(`rm -f '${remoteName}' '${remoteName}.sha256'`).catch(() => undefined);
    runtime.close();
  }
});

it('real workspace MCP cancels mid-flight transfers, never rolls back commits and acknowledges results (issue #15)', { skip: !profile, timeout: 180000 }, async () => {
  const { createWorkspaceRuntime } = await import('../build/services/workspace-runtime.js');
  const config = await loadWorkspaceConfig(profile);
  const sessionId = 'mcp15-' + randomUUID();
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
  const localPath = join(config.localRoot, sessionId + '-up.bin');
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../build/index.js', import.meta.url)), '--workspace', profile], stderr: 'pipe' }));
    // A multi-block upload stopped mid-flight by the budget: 512 blocks at a
    // 64 KiB chunk make one exchange per block, so a 1 s budget always stops
    // partway on a real link (33 MiB/s sustained would be needed to finish).
    const data = Buffer.alloc(32 * 1024 * 1024, 0x5f);
    await writeFile(localPath, data);
    const remoteName = sessionId + '-up.bin';
    let partial;
    for (let attempt = 0; attempt < 6; attempt++) {
      const step = attempt === 0
        ? await call('remote_upload', { localPath, path: remoteName, chunkSize: 65536, budgetMs: 1000 })
        : await call('remote_upload', { action: 'resume', transferId: partial.data.transferId, chunkSize: 65536, budgetMs: 1000 });
      assert.equal(step.error, undefined, JSON.stringify(step));
      partial = step;
      if (partial.data.state === 'transferring' && partial.data.budgetExhausted === true
        && partial.data.confirmedOffset > 0 && partial.data.confirmedOffset < data.length) break;
    }
    assert.equal(partial.data.state, 'transferring', JSON.stringify(partial.data));
    // Cancel confirms the stop and reports it; status stays read-only.
    const cancelled = await call('remote_upload', { action: 'cancel', transferId: partial.data.transferId });
    assert.equal(cancelled.error, undefined, JSON.stringify(cancelled));
    assert.equal(cancelled.data.state, 'cancelled');
    const observed = await call('remote_upload', { action: 'status', transferId: partial.data.transferId });
    assert.equal(observed.data.state, 'cancelled');
    // A cancelled transfer never resurrects through resume.
    const dead = await call('remote_upload', { action: 'resume', transferId: partial.data.transferId });
    assert.equal(dead.data.state, 'cancelled');
    // The uncommitted remote temp is gone (runTask's cwd is the remote root,
    // where the target and its sibling temp live).
    await runTask(`test ! -e '.ssh-mcp-upload-${partial.data.transferId}'`);
    const smallPath = join(config.localRoot, sessionId + '-small.bin');
    await writeFile(smallPath, Buffer.from('committed before cancel'));
    const done = await call('remote_upload', { localPath: smallPath, path: sessionId + '-small-remote.txt' });
    assert.equal(done.data.state, 'completed');
    // A late cancel never rolls back the committed target.
    const kept = await call('remote_upload', { action: 'cancel', transferId: done.data.transferId });
    assert.equal(kept.error, undefined, JSON.stringify(kept));
    assert.equal(kept.data.state, 'completed');
    const readBack = await call('remote_read', { path: sessionId + '-small-remote.txt' });
    assert.equal(readBack.data.text, 'committed before cancel');
    // Acknowledgements consume the terminal results, idempotently.
    const acked = await call('remote_upload', { action: 'ack', transferId: partial.data.transferId });
    assert.equal(acked.data.acknowledged, true);
    assert.equal(acked.data.state, 'cancelled');
    assert.equal((await call('remote_upload', { action: 'ack', transferId: partial.data.transferId })).data.acknowledged, true);
    assert.equal((await call('remote_upload', { action: 'ack', transferId: done.data.transferId })).data.state, 'completed');
    // Unknown identifiers never fall back to anything.
    const unknown = await call('remote_upload', { action: 'cancel', transferId: 'f'.repeat(32) });
    assert.equal(unknown.data.code, 'TRANSFER_NOT_FOUND');
    const unknownAck = await call('remote_download', { action: 'ack', transferId: 'f'.repeat(32) });
    assert.equal(unknownAck.data.code, 'TRANSFER_NOT_FOUND');
  } finally {
    await client.close().catch(() => undefined);
    await rm(localPath, { force: true });
    await rm(join(config.localRoot, sessionId + '-small.bin'), { force: true });
    await runTask(`rm -f '${sessionId}-up.bin' '${sessionId}-small-remote.txt'`).catch(() => undefined);
    runtime.close();
  }
});
