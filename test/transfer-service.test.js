// Ticket #13 behavior tests: the local upload transfer driver. A fake SSH
// transport implements the remote helper protocol (SSH_MCP_V1 envelope over
// exec stdin) against the real filesystem, so the driver loop, the wire
// format, budget handling and resume behavior are exercised end to end
// without a real SSH hop.
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileService } from '../build/services/file-service.js';
import { RemoteAgentClient } from '../build/services/remote-agent-client.js';
import { TransferService } from '../build/services/transfer-service.js';

const CHUNK = 64 * 1024;

class FakeRemote {
  constructor() {
    this.workspace = join(tmpdir(), 'ssh-mcp-transfer-fake-' + randomUUID());
    this.stateRoot = join(tmpdir(), 'ssh-mcp-transfer-state-' + randomUUID());
    mkdirSync(this.workspace, { recursive: true });
    mkdirSync(this.stateRoot, { recursive: true });
    this.records = new Map();
    this.counter = 0;
    this.activeLimit = 2;
    this.blockDelayMs = 0;
    this.failAt = null; // {index, mode: 'before'|'after'}
    this.exchanges = []; // every executeInputCommand call
  }

  async cleanup() {
    await rm(this.workspace, { recursive: true, force: true });
    await rm(this.stateRoot, { recursive: true, force: true });
  }

  describe(record) {
    return { schemaVersion: 1, transferId: record.transferId, direction: record.direction,
      state: record.state, targetPath: record.targetPath, chunkSize: record.chunkSize,
      totalBytes: record.totalBytes, sha256: record.totalSha256,
      confirmedOffset: record.confirmedOffset, chunkCount: record.chunkCount,
      overwrite: record.overwrite, create: record.create,
      registeredAt: record.registeredAt, expiresAt: record.expiresAt };
  }

  load(id) {
    const record = this.records.get(id);
    if (!record) { const error = new Error('No registration'); error.code = 'REQUEST_EXPIRED_OR_UNKNOWN'; throw error; }
    return record;
  }

  tempPath(record) {
    return join(this.workspace, '.ssh-mcp-upload-' + record.transferId);
  }

  targetPath(record) {
    return join(this.workspace, ...record.targetPath.split('/'));
  }

  async handle(action, input) {
    if (action === 'transfer_register') return this.register(JSON.parse(input.toString('utf8')));
    if (action === 'transfer_block') return this.block(input);
    const request = JSON.parse(input.toString('utf8'));
    if (action === 'transfer_start') return this.start(request);
    if (action === 'transfer_resume') return this.resume(request);
    if (action === 'transfer_verify') return this.verify(request);
    if (action === 'transfer_commit') return this.commit(request);
    if (action === 'transfer_status') return this.describe(this.load(request.transferId));
    const error = new Error('Unknown action ' + action); error.code = 'UNSUPPORTED_ACTION'; throw error;
  }

  async register(request) {
    if (request.protocol !== 2) { const error = new Error('protocol'); error.code = 'INVALID_PROTOCOL'; throw error; }
    if (request.direction !== 'upload') { const error = new Error('direction'); error.code = 'INVALID_REQUEST'; throw error; }
    if (this.records.size >= this.activeLimit) {
      const error = new Error('limit'); error.code = 'TRANSFER_LIMIT_REACHED'; throw error;
    }
    const transferId = String(++this.counter).padStart(32, '0');
    const target = request.targetPath.replace(/^\//, '');
    const record = { schemaVersion: 1, transferId, direction: 'upload', sessionId: request.sessionId,
      targetPath: target, chunkSize: request.chunkSize, totalBytes: request.totalBytes,
      totalSha256: request.totalSha256, sourceIdentity: request.sourceIdentity,
      overwrite: request.overwrite, create: request.create, expectedVersion: request.expectedVersion ?? null,
      state: 'prepared', confirmedOffset: 0, chunkCount: 0, resourceId: null,
      registeredAt: Date.now(), expiresAt: Date.now() + 3 * 24 * 3600 * 1000 };
    if (record.overwrite) {
      const error = new Error('target state'); error.code = 'FILE_CONFLICT';
      try { await stat(this.targetPath(record)); throw error; } catch (missing) {
        if (missing.code === 'FILE_CONFLICT') throw error;
      }
    } else {
      try {
        await stat(this.targetPath(record));
        const error = new Error('exists'); error.code = 'FILE_CONFLICT'; throw error;
      } catch (missing) { if (missing.code === 'FILE_CONFLICT') throw missing; }
    }
    this.records.set(transferId, record);
    await mkdir(join(this.stateRoot, 'transfers', transferId), { recursive: true });
    await writeFile(join(this.stateRoot, 'transfers', transferId, 'record.json'), JSON.stringify(record));
    return this.describe(record);
  }

  sourceMismatch(record, sourceIdentity) {
    return sourceIdentity.size !== record.sourceIdentity.size
      || sourceIdentity.mtimeMs !== record.sourceIdentity.mtimeMs;
  }

  async start(request) {
    const record = this.load(request.transferId);
    if (this.sourceMismatch(record, request.sourceIdentity)) {
      const error = new Error('source changed'); error.code = 'TRANSFER_SOURCE_CHANGED'; throw error;
    }
    if (record.state === 'prepared') {
      const descriptor = await open(this.tempPath(record), 'wx', 0o600);
      await descriptor.close();
      record.state = 'transferring';
    }
    return this.describe(record);
  }

  async resume(request) {
    const record = this.load(request.transferId);
    if (this.sourceMismatch(record, request.sourceIdentity)) {
      const error = new Error('source changed'); error.code = 'TRANSFER_SOURCE_CHANGED'; throw error;
    }
    if (record.state === 'prepared') { const error = new Error('not started'); error.code = 'INVALID_STATE'; throw error; }
    return this.describe(record);
  }

  async block(input) {
    const split = input.indexOf('\n'.charCodeAt(0));
    const control = JSON.parse(input.subarray(0, split).toString('utf8'));
    const payload = input.subarray(split + 1);
    const record = this.load(control.transferId);
    if (control.sessionId !== record.sessionId) {
      const error = new Error('scope'); error.code = 'TRANSFER_SCOPE_MISMATCH'; throw error;
    }
    if (record.state !== 'transferring') { const error = new Error('state'); error.code = 'INVALID_STATE'; throw error; }
    if (control.index !== record.chunkCount || control.offset !== record.confirmedOffset) {
      const error = new Error('order'); error.code = 'INVALID_REQUEST'; throw error;
    }
    if (createHash('sha256').update(payload).digest('hex') !== control.sha256) {
      const error = new Error('digest'); error.code = 'BLOCK_CHECKSUM_MISMATCH'; throw error;
    }
    if (this.failAt && this.failAt.index === control.index && this.failAt.mode === 'before') {
      const error = new Error('connection dropped'); error.code = 'CONNECTION_DROPPED'; error.retriable = true; throw error;
    }
    if (this.blockDelayMs) await new Promise(resolve => setTimeout(resolve, this.blockDelayMs));
    const handle = await open(this.tempPath(record), 'r+');
    try { await handle.write(payload, 0, payload.length, control.offset); } finally { await handle.close(); }
    record.chunkCount = control.index + 1;
    record.confirmedOffset = control.offset + payload.length;
    await writeFile(join(this.stateRoot, 'transfers', control.transferId, 'record.json'), JSON.stringify(record));
    if (this.failAt && this.failAt.index === control.index && this.failAt.mode === 'after') {
      const error = new Error('connection dropped'); error.code = 'CONNECTION_DROPPED'; error.retriable = true; throw error;
    }
    return { transferId: control.transferId, index: control.index,
      confirmedOffset: record.confirmedOffset, totalBytes: record.totalBytes,
      complete: record.confirmedOffset >= record.totalBytes };
  }

  async verify(request) {
    const record = this.load(request.transferId);
    if (record.state !== 'transferring' || record.confirmedOffset !== record.totalBytes) {
      const error = new Error('state'); error.code = 'INVALID_STATE'; throw error;
    }
    const content = await readFile(this.tempPath(record));
    if (createHash('sha256').update(content).digest('hex') !== record.totalSha256) {
      const error = new Error('mismatch'); error.code = 'VERIFY_MISMATCH'; throw error;
    }
    record.state = 'verifying';
    return this.describe(record);
  }

  async commit(request) {
    const record = this.load(request.transferId);
    if (record.state !== 'verifying') { const error = new Error('state'); error.code = 'INVALID_STATE'; throw error; }
    const { rename } = await import('node:fs/promises');
    await rename(this.tempPath(record), this.targetPath(record));
    record.state = 'completed';
    record.completedAt = Date.now();
    return { schemaVersion: 1, transferId: record.transferId, direction: record.direction,
      state: 'completed', path: this.targetPath(record), bytesWritten: record.totalBytes,
      sha256: record.totalSha256, created: record.create, overwritten: record.overwrite,
      committedAt: record.completedAt };
  }
}

async function buildHarness() {
  const fake = new FakeRemote();
  const transport = {
    async executeInputCommand(command, input, name, options = {}) {
      fake.exchanges.push({ command, input, options, action: command.trim().split(' ').pop().replace(/'/g, '') });
      if (command.includes(' -c ')) return { stdout: 'installed\n', stderr: '', exitCode: 0 };
      try {
        const result = await fake.handle(fake.exchanges[fake.exchanges.length - 1].action, input);
        const payload = Buffer.from(JSON.stringify({ ok: true, result })).toString('base64');
        return { stdout: 'SSH_MCP_V1 ' + payload + '\n', stderr: '', exitCode: 0 };
      } catch (error) {
        if (error.retriable) throw error; // simulate the SSH layer dropping the channel
        const payload = Buffer.from(JSON.stringify({ ok: false, error: { code: error.code ?? 'HELPER_ERROR', message: error.message } })).toString('base64');
        return { stdout: 'SSH_MCP_V1 ' + payload + '\n', stderr: '', exitCode: 0 };
      }
    },
  };
  const remote = new RemoteAgentClient(transport, { remoteStateDir: '/fake/remote-state', pythonPath: '/usr/bin/python3' });
  const config = {
    workspaceId: 'test-workspace', identity: 'identity-13', profilePath: '/tmp/profile.json',
    connectionName: 'default', sshConfigFile: '/tmp/ssh.json',
    sshConfigs: { default: { allowedLocalPaths: [], allowedRemotePaths: [] } },
    remoteRoot: fake.workspace, remoteStateDir: fake.stateRoot, directoryScope: 'restricted',
    localStateDir: join(fake.stateRoot, 'local-state'), localRoot: fake.workspace,
    pythonPath: '/usr/bin/python3', policy: { limits: { localWorkspaceBytes: 10 * 1024 ** 3 } },
  };
  const files = new FileService(remote, config);
  const transfers = new TransferService(remote, config, files);
  return { fake, transfers, files };
}

async function writeSource(directory, name, data) {
  const target = join(directory, name);
  const handle = await open(target, 'wx', 0o600);
  try { await handle.writeFile(data); } finally { await handle.close(); }
  const info = await stat(target);
  return { target, identity: { size: info.size, mtimeMs: info.mtimeMs } };
}

it('uploads complete with verified digests and commit the binary-identical target', async () => {
  const { fake, transfers } = await buildHarness();
  try {
    const data = Buffer.from(randomUUID() + randomUUID()); // 72 bytes
    const big = Buffer.concat([Buffer.alloc(CHUNK, 7), Buffer.alloc(CHUNK + 100, 9), data]); // 3 blocks
    const source = await writeSource(fake.workspace, 'source-' + randomUUID() + '.bin', big);
    const outcome = await transfers.upload('session-a', {
      localPath: source.target, path: 'dest-' + randomUUID() + '.bin', chunkSize: CHUNK,
    });
    assert.equal(outcome.state, 'completed');
    assert.equal(outcome.bytesWritten, big.length);
    assert.equal(outcome.sha256, createHash('sha256').update(big).digest('hex'));
    assert.equal(outcome.blocksSent, 3);
    assert.equal(outcome.budgetExhausted, undefined);
    const committed = await readFile(outcome.path);
    assert.ok(committed.equals(big));
    // The local side keeps a small durable transfer record.
    const recordPath = join(fake.stateRoot, 'local-state',
      createHash('sha256').update('identity-13').digest('hex').slice(0, 24),
      'transfers', outcome.transferId, 'record.json');
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    assert.equal(record.direction, 'upload');
    assert.equal(record.sessionId, 'session-a');
    assert.equal(record.sourceIdentity.size, big.length);
  } finally { await fake.cleanup(); }
});

it('block exchanges carry a bounded control line plus raw bytes with an extended timeout', async () => {
  const { fake, transfers } = await buildHarness();
  try {
    const data = Buffer.alloc(CHUNK + 5, 0xab);
    const source = await writeSource(fake.workspace, 'wire-' + randomUUID() + '.bin', data);
    await transfers.upload('session-a', { localPath: source.target, path: 'wire-dest.bin', chunkSize: CHUNK });
    const blocks = fake.exchanges.filter(exchange => exchange.action === 'transfer_block');
    assert.equal(blocks.length, 2);
    for (const [position, exchange] of blocks.entries()) {
      const split = exchange.input.indexOf('\n'.charCodeAt(0));
      const control = JSON.parse(exchange.input.subarray(0, split).toString('utf8'));
      const payload = exchange.input.subarray(split + 1);
      assert.equal(control.index, position);
      assert.equal(control.offset, position * CHUNK);
      assert.equal(control.sha256, createHash('sha256').update(payload).digest('hex'));
      assert.equal(control.sessionId, 'session-a');
      assert.ok(payload.equals(data.subarray(position * CHUNK, position * CHUNK + control.size)));
      assert.equal(exchange.options.timeout, 60000); // per-block budget, not the 30 s default
    }
    for (const action of ['transfer_verify', 'transfer_commit']) {
      const exchange = fake.exchanges.find(item => item.action === action);
      assert.equal(exchange.options.timeout, 60000);
    }
  } finally { await fake.cleanup(); }
});

it('a transport break after persistence resumes from the confirmed offset only', async () => {
  const { fake, transfers } = await buildHarness();
  try {
    const data = Buffer.alloc(CHUNK * 4, 0x11);
    const source = await writeSource(fake.workspace, 'after-' + randomUUID() + '.bin', data);
    fake.failAt = { index: 2, mode: 'after' };
    let transferId;
    await assert.rejects(transfers.upload('session-a', {
      localPath: source.target, path: 'after-dest.bin', chunkSize: CHUNK,
    }), error => (error.code === 'CONNECTION_DROPPED' || error.message.includes('dropped'))
      && (transferId = error.transferId, true));
    fake.failAt = null;
    const resumed = await transfers.resume('session-a', transferId);
    assert.equal(resumed.state, 'completed');
    assert.equal(resumed.blocksSent, 1); // only the fourth block remained
    const blockCalls = fake.exchanges.filter(exchange => exchange.action === 'transfer_block');
    assert.deepEqual(blockCalls.map(exchange => JSON.parse(exchange.input.subarray(0, exchange.input.indexOf(10)).toString('utf8')).index), [0, 1, 2, 3]);
    const committed = await readFile(join(fake.workspace, 'after-dest.bin'));
    assert.ok(committed.equals(data));
  } finally { await fake.cleanup(); }
});

it('a transport break before persistence resends exactly the lost block', async () => {
  const { fake, transfers } = await buildHarness();
  try {
    const data = Buffer.alloc(CHUNK * 3, 0x22);
    const source = await writeSource(fake.workspace, 'before-' + randomUUID() + '.bin', data);
    fake.failAt = { index: 1, mode: 'before' };
    let transferId;
    await assert.rejects(transfers.upload('session-a', {
      localPath: source.target, path: 'before-dest.bin', chunkSize: CHUNK,
    }), error => (transferId = error.transferId, true));
    fake.failAt = null;
    const resumed = await transfers.resume('session-a', transferId);
    assert.equal(resumed.state, 'completed');
    assert.equal(resumed.blocksSent, 2); // the lost block and the final one
    const committed = await readFile(join(fake.workspace, 'before-dest.bin'));
    assert.ok(committed.equals(data));
  } finally { await fake.cleanup(); }
});

it('budget exhaustion returns bounded progress and resume finishes without re-sending', async () => {
  const { fake, transfers } = await buildHarness();
  try {
    const data = Buffer.alloc(CHUNK * 4 + 9, 0x33);
    const source = await writeSource(fake.workspace, 'budget-' + randomUUID() + '.bin', data);
    fake.blockDelayMs = 400;
    const partial = await transfers.upload('session-a', {
      localPath: source.target, path: 'budget-dest.bin', chunkSize: CHUNK, budgetMs: 1000,
    });
    assert.equal(partial.state, 'transferring');
    assert.equal(partial.budgetExhausted, true);
    assert.ok(partial.confirmedOffset > 0 && partial.confirmedOffset < data.length);
    const status = await transfers.status('session-a', partial.transferId);
    assert.equal(status.state, 'transferring');
    assert.equal(status.confirmedOffset, partial.confirmedOffset);
    assert.equal(status.totalBytes, data.length);
    fake.blockDelayMs = 0;
    const done = await transfers.resume('session-a', partial.transferId);
    assert.equal(done.state, 'completed');
    assert.equal(done.sha256, createHash('sha256').update(data).digest('hex'));
    const totalBlocks = fake.exchanges.filter(exchange => exchange.action === 'transfer_block').length;
    assert.equal(totalBlocks, 5); // four full chunks plus the short tail, each exactly once
  } finally { await fake.cleanup(); }
});

it('a changed local source refuses to resume the original transfer', async () => {
  const { fake, transfers } = await buildHarness();
  try {
    const data = Buffer.alloc(CHUNK * 2, 0x44);
    const source = await writeSource(fake.workspace, 'stable-' + randomUUID() + '.bin', data);
    fake.failAt = { index: 1, mode: 'after' };
    let transferId;
    await assert.rejects(transfers.upload('session-a', {
      localPath: source.target, path: 'stable-dest.bin', chunkSize: CHUNK,
    }), error => (transferId = error.transferId, true));
    fake.failAt = null;
    const handle = await open(source.target, 'r+');
    try {
      const stamp = Buffer.from('mutation!');
      await handle.write(stamp, 0, stamp.length, CHUNK + 10);
      const info = await stat(source.target);
      // Restore the recorded size so only the mtime betrays the rewrite.
      // (Content and mtime both moved; either is enough to refuse.)
      source.identity = { size: info.size, mtimeMs: info.mtimeMs };
    } finally { await handle.close(); }
    await assert.rejects(transfers.resume('session-a', transferId),
      error => error.code === 'FILE_CONFLICT' && /source changed/i.test(error.message));
  } finally { await fake.cleanup(); }
});

it('resume and status are scoped to the owning session', async () => {
  const { fake, transfers } = await buildHarness();
  try {
    const data = Buffer.alloc(100, 0x55);
    const source = await writeSource(fake.workspace, 'scope-' + randomUUID() + '.bin', data);
    const outcome = await transfers.upload('session-a', {
      localPath: source.target, path: 'scope-dest.bin', chunkSize: CHUNK,
    });
    const transferId = outcome.transferId;
    await assert.rejects(transfers.resume('session-b', transferId),
      error => error.code === 'TRANSFER_SCOPE_MISMATCH');
    await assert.rejects(transfers.status('session-b', transferId),
      error => error.code === 'TRANSFER_SCOPE_MISMATCH');
    await assert.rejects(transfers.status('session-a', 'f'.repeat(32)),
      error => error.code === 'TRANSFER_NOT_FOUND');
  } finally { await fake.cleanup(); }
});
