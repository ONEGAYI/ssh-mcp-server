// Ticket #13/#14 behavior tests: the local transfer driver for both
// directions. A fake SSH transport implements the remote helper protocol
// (SSH_MCP_V1 envelope over exec stdin, plus the framed binary stdout of
// download fetches) against the real filesystem, so the driver loop, the wire
// formats, budget handling, healing and resume behavior are exercised end to
// end without a real SSH hop.
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
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
    this.failAt = null; // {index, mode: 'before'|'after'} on upload blocks
    this.fetchDelayMs = 0;
    this.failFetchAt = null; // {index, mode: 'before'|'after'} on download fetches
    this.corruptFetchAt = null; // {index} serve corrupted bytes once under the good digest
    this.exchanges = []; // every executeInputCommand call
  }

  async cleanup() {
    await rm(this.workspace, { recursive: true, force: true });
    await rm(this.stateRoot, { recursive: true, force: true });
  }

  describe(record) {
    const result = { schemaVersion: 1, transferId: record.transferId, direction: record.direction,
      state: record.state, targetPath: record.targetPath, chunkSize: record.chunkSize,
      totalBytes: record.totalBytes, sha256: record.totalSha256,
      confirmedOffset: record.confirmedOffset, chunkCount: record.chunkCount,
      overwrite: record.overwrite, create: record.create,
      registeredAt: record.registeredAt, expiresAt: record.expiresAt };
    if (record.direction === 'download') {
      result.sourcePath = record.sourcePath;
      result.sourceVersion = record.sourceVersion;
    }
    return result;
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

  sourceFile(record) {
    return join(this.workspace, ...record.sourcePath.replace(/^\//, '').split('/'));
  }

  async sourceVersionOf(source) {
    const info = await stat(source);
    return 'm1-' + createHash('sha256').update(`${info.size}:${info.mtimeMs}`).digest('hex');
  }

  async handle(action, input) {
    if (action === 'transfer_register') return this.register(JSON.parse(input.toString('utf8')));
    if (action === 'transfer_block') return this.block(input);
    if (action === 'transfer_fetch') return this.fetchBlock(input);
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
    if (this.records.size >= this.activeLimit) {
      const error = new Error('limit'); error.code = 'TRANSFER_LIMIT_REACHED'; throw error;
    }
    if (request.direction === 'download') return this.registerDownload(request);
    return this.registerUpload(request);
  }

  async registerUpload(request) {
    if (request.direction !== 'upload') { const error = new Error('direction'); error.code = 'INVALID_REQUEST'; throw error; }
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

  async registerDownload(request) {
    const transferId = String(++this.counter).padStart(32, '0');
    const source = this.sourceFile({ sourcePath: request.sourcePath });
    let content;
    try { content = await readFile(source); }
    catch (error) { const missing = new Error('no source'); missing.code = 'PATH_NOT_FOUND'; throw missing; }
    const record = { schemaVersion: 1, transferId, direction: 'download', sessionId: request.sessionId,
      sourcePath: request.sourcePath, sourceVersion: await this.sourceVersionOf(source),
      targetPath: request.targetPath, chunkSize: request.chunkSize, totalBytes: content.length,
      totalSha256: createHash('sha256').update(content).digest('hex'),
      overwrite: request.overwrite, create: request.create, expectedVersion: request.expectedVersion ?? null,
      state: 'prepared', confirmedOffset: 0, chunkCount: 0, resourceId: null,
      registeredAt: Date.now(), expiresAt: Date.now() + 3 * 24 * 3600 * 1000 };
    this.records.set(transferId, record);
    await mkdir(join(this.stateRoot, 'transfers', transferId), { recursive: true });
    await writeFile(join(this.stateRoot, 'transfers', transferId, 'record.json'), JSON.stringify(record));
    return this.describe(record);
  }

  async start(request) {
    const record = this.load(request.transferId);
    if (record.direction === 'download') {
      await this.assertDownloadSource(record, request.sourceVersion);
    } else if (this.sourceMismatch(record, request.sourceIdentity)) {
      const error = new Error('source changed'); error.code = 'TRANSFER_SOURCE_CHANGED'; throw error;
    }
    if (record.state === 'prepared') {
      if (record.direction === 'upload') {
        const descriptor = await open(this.tempPath(record), 'wx', 0o600);
        await descriptor.close();
      }
      record.state = 'transferring';
      await this.persist(record);
    }
    return this.describe(record);
  }

  async assertDownloadSource(record, echoed) {
    if (typeof echoed !== 'string' || echoed !== record.sourceVersion) {
      const error = new Error('source changed'); error.code = 'TRANSFER_SOURCE_CHANGED'; throw error;
    }
    if (await this.sourceVersionOf(this.sourceFile(record)) !== record.sourceVersion) {
      const error = new Error('source changed on disk'); error.code = 'TRANSFER_SOURCE_CHANGED'; throw error;
    }
  }

  async resume(request) {
    const record = this.load(request.transferId);
    if (record.direction === 'download') await this.assertDownloadSource(record, request.sourceVersion);
    else if (this.sourceMismatch(record, request.sourceIdentity)) {
      const error = new Error('source changed'); error.code = 'TRANSFER_SOURCE_CHANGED'; throw error;
    }
    if (record.state === 'prepared') { const error = new Error('not started'); error.code = 'INVALID_STATE'; throw error; }
    return this.describe(record);
  }

  async persist(record) {
    await writeFile(join(this.stateRoot, 'transfers', record.transferId, 'record.json'), JSON.stringify(record));
  }

  sourceMismatch(record, sourceIdentity) {
    return sourceIdentity.size !== record.sourceIdentity.size
      || sourceIdentity.mtimeMs !== record.sourceIdentity.mtimeMs;
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
    await this.persist(record);
    if (this.failAt && this.failAt.index === control.index && this.failAt.mode === 'after') {
      const error = new Error('connection dropped'); error.code = 'CONNECTION_DROPPED'; error.retriable = true; throw error;
    }
    return { transferId: control.transferId, index: control.index,
      confirmedOffset: record.confirmedOffset, totalBytes: record.totalBytes,
      complete: record.confirmedOffset >= record.totalBytes };
  }

  async fetchBlock(input) {
    const control = JSON.parse(input.toString('utf8').trim());
    const record = this.load(control.transferId);
    if (record.direction !== 'download') {
      const error = new Error('wrong direction'); error.code = 'INVALID_REQUEST'; throw error;
    }
    if (control.sessionId !== record.sessionId) {
      const error = new Error('scope'); error.code = 'TRANSFER_SCOPE_MISMATCH'; throw error;
    }
    if (record.state !== 'transferring') { const error = new Error('state'); error.code = 'INVALID_STATE'; throw error; }
    const nextBlock = control.index === record.chunkCount && control.offset === record.confirmedOffset;
    const rewind = control.index < record.chunkCount && control.offset === control.index * record.chunkSize;
    if (!nextBlock && !rewind) {
      const error = new Error('order'); error.code = 'INVALID_REQUEST'; throw error;
    }
    if (control.offset !== control.index * record.chunkSize
        || control.size < 1 || control.size > record.chunkSize
        || control.offset + control.size > record.totalBytes
        || (control.offset + control.size < record.totalBytes && control.size !== record.chunkSize)) {
      const error = new Error('bounds'); error.code = 'INVALID_REQUEST'; throw error;
    }
    if (await this.sourceVersionOf(this.sourceFile(record)) !== record.sourceVersion) {
      record.state = 'failed';
      record.error = { code: 'TRANSFER_SOURCE_CHANGED', message: 'source changed while serving' };
      await this.persist(record);
      const error = new Error('source changed'); error.code = 'TRANSFER_SOURCE_CHANGED'; throw error;
    }
    if (this.failFetchAt && this.failFetchAt.index === control.index && this.failFetchAt.mode === 'before') {
      const error = new Error('connection dropped'); error.code = 'CONNECTION_DROPPED'; error.retriable = true; throw error;
    }
    if (this.fetchDelayMs) await new Promise(resolve => setTimeout(resolve, this.fetchDelayMs));
    const source = await open(this.sourceFile(record), 'r');
    let payload;
    try {
      const buffer = Buffer.alloc(control.size);
      const read = await source.read(buffer, 0, control.size, control.offset);
      if (read.bytesRead !== control.size) {
        const error = new Error('short read'); error.code = 'TRANSFER_DATA_SHORT'; throw error;
      }
      payload = buffer;
    } finally { await source.close(); }
    const declared = createHash('sha256').update(payload).digest('hex');
    if (this.corruptFetchAt && this.corruptFetchAt.index === control.index) {
      this.corruptFetchAt = null;
      payload = Buffer.from(payload); // corrupt a byte under the good digest
      payload[0] = payload[0] ^ 0xff;
    }
    record.chunkCount = control.index + 1;
    record.confirmedOffset = control.offset + payload.length;
    record.lastProgressAt = Date.now();
    await this.persist(record);
    if (this.failFetchAt && this.failFetchAt.index === control.index && this.failFetchAt.mode === 'after') {
      const error = new Error('connection dropped'); error.code = 'CONNECTION_DROPPED'; error.retriable = true; throw error;
    }
    return { __framed: true,
      control: { transferId: control.transferId, index: control.index, offset: control.offset,
        size: payload.length, sha256: declared },
      payload,
      result: { transferId: control.transferId, index: control.index,
        confirmedOffset: record.confirmedOffset, totalBytes: record.totalBytes,
        complete: record.confirmedOffset >= record.totalBytes } };
  }

  async verify(request) {
    const record = this.load(request.transferId);
    if (record.direction === 'download') {
      if (record.state === 'verifying' || record.state === 'completed') return this.describe(record);
      if (record.state !== 'transferring' || record.confirmedOffset !== record.totalBytes) {
        const error = new Error('state'); error.code = 'INVALID_STATE'; throw error;
      }
      if (request.sha256 !== record.totalSha256) {
        record.state = 'failed';
        await this.persist(record);
        const error = new Error('mismatch'); error.code = 'VERIFY_MISMATCH'; throw error;
      }
      record.state = 'verifying';
      await this.persist(record);
      return this.describe(record);
    }
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
    if (record.direction === 'download') {
      // The receiver publishes locally; the sender records the asserted outcome.
      record.state = 'completed';
      record.completedAt = Date.now();
      await this.persist(record);
      return { schemaVersion: 1, transferId: record.transferId, direction: record.direction,
        state: 'completed', path: record.targetPath, bytesWritten: record.totalBytes,
        sha256: record.totalSha256, committedAt: record.completedAt };
    }
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

async function buildHarness(limitBytes = 10 * 1024 ** 3) {
  const fake = new FakeRemote();
  const parseAction = command => command.trim().split(' ').pop().replace(/'/g, '');
  const envelope = (ok, payload) => 'SSH_MCP_V1 '
    + Buffer.from(JSON.stringify(ok ? { ok: true, result: payload } : { ok: false, error: payload })).toString('base64') + '\n';
  const transport = {
    async executeInputCommand(command, input, name, options = {}) {
      fake.exchanges.push({ command, input, options, action: parseAction(command) });
      if (command.includes(' -c ')) return { stdout: 'installed\n', stderr: '', exitCode: 0 };
      try {
        const result = await fake.handle(parseAction(command), input);
        return { stdout: envelope(true, result), stderr: '', exitCode: 0 };
      } catch (error) {
        if (error.retriable) throw error; // simulate the SSH layer dropping the channel
        return { stdout: envelope(false, { code: error.code ?? 'HELPER_ERROR', message: error.message }), stderr: '', exitCode: 0 };
      }
    },
    async executeBinaryInputCommand(command, input, name, options = {}) {
      fake.exchanges.push({ command, input, options, action: parseAction(command) });
      if (command.includes(' -c ')) return { stdout: Buffer.from('installed\n'), stderr: '', exitCode: 0 };
      try {
        const result = await fake.handle(parseAction(command), input);
        if (result && result.__framed) {
          const head = Buffer.from(JSON.stringify(result.control) + '\n');
          const tail = Buffer.from('\n' + envelope(true, result.result));
          return { stdout: Buffer.concat([head, result.payload, tail]), stderr: '', exitCode: 0 };
        }
        return { stdout: Buffer.from(envelope(true, result)), stderr: '', exitCode: 0 };
      } catch (error) {
        if (error.retriable) throw error;
        return { stdout: Buffer.from(envelope(false, { code: error.code ?? 'HELPER_ERROR', message: error.message })), stderr: '', exitCode: 0 };
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
    pythonPath: '/usr/bin/python3', policy: { limits: { localWorkspaceBytes: limitBytes } },
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

// --- download direction (issue #14) -----------------------------------------

function localLedgerPath(fake) {
  return join(fake.stateRoot, 'local-state',
    createHash('sha256').update('identity-13').digest('hex').slice(0, 24), 'ledger');
}

async function localTemps(directory) {
  const { readdir } = await import('node:fs/promises');
  return (await readdir(directory)).filter(name => name.startsWith('.ssh-mcp-download-'));
}

it('downloads complete with verified digests and commit the binary-identical local target', async () => {
  const { fake, transfers } = await buildHarness();
  try {
    const data = Buffer.concat([Buffer.alloc(CHUNK, 7), Buffer.alloc(CHUNK + 100, 9), Buffer.from(randomUUID())]);
    const name = 'dl-src-' + randomUUID() + '.bin';
    const source = await writeSource(fake.workspace, name, data);
    const destName = 'dl-dest-' + randomUUID() + '.bin';
    const outcome = await transfers.download('session-a', { path: name, localPath: destName, chunkSize: CHUNK });
    assert.equal(outcome.state, 'completed');
    assert.equal(outcome.bytesWritten, data.length);
    assert.equal(outcome.sha256, createHash('sha256').update(data).digest('hex'));
    assert.equal(outcome.blocksFetched, 3);
    assert.equal(outcome.budgetExhausted, undefined);
    assert.equal('readToken' in outcome, false); // downloads never grant read coverage
    const committed = await readFile(join(fake.workspace, destName));
    assert.ok(committed.equals(data));
    // No formal half file: the temp is gone and the ledger no longer measures it.
    assert.deepEqual(await localTemps(fake.workspace), []);
    const ledger = JSON.parse(await readFile(join(localLedgerPath(fake), 'ledger.json'), 'utf8'));
    assert.deepEqual(ledger.resources, {});
    // The local side keeps the durable receiver record.
    const record = JSON.parse(await readFile(join(fake.stateRoot, 'local-state',
      createHash('sha256').update('identity-13').digest('hex').slice(0, 24),
      'transfers', outcome.transferId, 'record.json'), 'utf8'));
    assert.equal(record.direction, 'download');
    assert.equal(record.sessionId, 'session-a');
    assert.equal(record.state, 'completed');
    assert.equal(record.totalSha256, outcome.sha256);
    assert.ok(record.sourceVersion.startsWith('m1-'));
  } finally { await fake.cleanup(); }
});

it('download fetch exchanges carry one control line and the extended timeout', async () => {
  const { fake, transfers } = await buildHarness();
  try {
    const data = Buffer.alloc(CHUNK + 5, 0xab);
    const name = 'wire-dl-' + randomUUID() + '.bin';
    await writeSource(fake.workspace, name, data);
    await transfers.download('session-a', { path: name, localPath: 'wire-dl-dest.bin', chunkSize: CHUNK });
    const fetches = fake.exchanges.filter(exchange => exchange.action === 'transfer_fetch');
    assert.equal(fetches.length, 2);
    for (const [position, exchange] of fetches.entries()) {
      const control = JSON.parse(exchange.input.toString('utf8').trim());
      assert.equal(control.index, position);
      assert.equal(control.offset, position * CHUNK);
      assert.equal(control.sessionId, 'session-a');
      assert.equal(control.size, Math.min(CHUNK, data.length - position * CHUNK));
      assert.equal('sha256' in control, false); // the digest arrives with the response, not the request
      assert.equal(exchange.options.timeout, 60000); // per-fetch budget, not the 30 s default
    }
    for (const action of ['transfer_verify', 'transfer_commit']) {
      const exchange = fake.exchanges.find(item => item.action === action);
      assert.equal(exchange.options.timeout, 60000);
    }
  } finally { await fake.cleanup(); }
});

it('a corrupted fetched block is refused, not persisted, and refetched in drive', async () => {
  const { fake, transfers } = await buildHarness();
  try {
    const data = Buffer.alloc(CHUNK * 3, 0x33);
    const name = 'corrupt-dl-' + randomUUID() + '.bin';
    await writeSource(fake.workspace, name, data);
    fake.corruptFetchAt = { index: 1 };
    const outcome = await transfers.download('session-a', { path: name, localPath: 'corrupt-dl.bin', chunkSize: CHUNK });
    assert.equal(outcome.state, 'completed');
    const committed = await readFile(join(fake.workspace, 'corrupt-dl.bin'));
    assert.ok(committed.equals(data));
    const indexes = fake.exchanges.filter(exchange => exchange.action === 'transfer_fetch')
      .map(exchange => JSON.parse(exchange.input.toString('utf8').trim()).index);
    assert.deepEqual(indexes, [0, 1, 1, 2]); // the corrupted block was re-requested once
  } finally { await fake.cleanup(); }
});

it('a lost fetch response after the sender advanced resumes through a rewind fetch', async () => {
  const { fake, transfers } = await buildHarness();
  try {
    const data = Buffer.alloc(CHUNK * 4, 0x44);
    const name = 'lost-dl-' + randomUUID() + '.bin';
    await writeSource(fake.workspace, name, data);
    fake.failFetchAt = { index: 2, mode: 'after' };
    let transferId;
    await assert.rejects(transfers.download('session-a', {
      path: name, localPath: 'lost-dl.bin', chunkSize: CHUNK,
    }), error => (transferId = error.transferId, true));
    fake.failFetchAt = null;
    const resumed = await transfers.resume('session-a', transferId);
    assert.equal(resumed.state, 'completed');
    assert.equal(resumed.blocksFetched, 2); // the lost block and the final one
    const indexes = fake.exchanges.filter(exchange => exchange.action === 'transfer_fetch')
      .map(exchange => JSON.parse(exchange.input.toString('utf8').trim()).index);
    // Initial 0,1; three refused attempts of 2; the rewind fetch of 2; then 3.
    assert.deepEqual(indexes, [0, 1, 2, 2, 2, 2, 3]);
    const committed = await readFile(join(fake.workspace, 'lost-dl.bin'));
    assert.ok(committed.equals(data));
  } finally { await fake.cleanup(); }
});

it('local temp corruption heals on resume from the last trusted boundary', async () => {
  const { fake, transfers } = await buildHarness();
  try {
    const data = Buffer.alloc(CHUNK * 4 + 9, 0x66);
    const name = 'heal-dl-' + randomUUID() + '.bin';
    await writeSource(fake.workspace, name, data);
    fake.fetchDelayMs = 400;
    const partial = await transfers.download('session-a', { path: name, localPath: 'heal-dl.bin', chunkSize: CHUNK, budgetMs: 1000 });
    assert.equal(partial.state, 'transferring');
    assert.equal(partial.budgetExhausted, true);
    fake.fetchDelayMs = 0;
    // Simulate torn writes inside already-confirmed data.
    const temp = join(fake.workspace, '.ssh-mcp-download-' + partial.transferId);
    const handle = await open(temp, 'r+');
    try { await handle.write(Buffer.from('corruption!'), 0, 11, CHUNK + 100); } finally { await handle.close(); }
    const resumed = await transfers.resume('session-a', partial.transferId);
    assert.equal(resumed.state, 'completed');
    assert.equal(resumed.sha256, createHash('sha256').update(data).digest('hex'));
    const committed = await readFile(join(fake.workspace, 'heal-dl.bin'));
    assert.ok(committed.equals(data));
  } finally { await fake.cleanup(); }
});

it('download budget exhaustion returns bounded progress and resume finishes without refetching', async () => {
  const { fake, transfers } = await buildHarness();
  try {
    const data = Buffer.alloc(CHUNK * 4 + 9, 0x77);
    const name = 'budget-dl-' + randomUUID() + '.bin';
    await writeSource(fake.workspace, name, data);
    fake.fetchDelayMs = 400;
    const partial = await transfers.download('session-a', {
      path: name, localPath: 'budget-dl.bin', chunkSize: CHUNK, budgetMs: 1000,
    });
    assert.equal(partial.state, 'transferring');
    assert.equal(partial.budgetExhausted, true);
    assert.ok(partial.confirmedOffset > 0 && partial.confirmedOffset < data.length);
    const status = await transfers.status('session-a', partial.transferId);
    assert.equal(status.state, 'transferring');
    assert.equal(status.confirmedOffset, partial.confirmedOffset);
    assert.equal(status.totalBytes, data.length);
    fake.fetchDelayMs = 0;
    const done = await transfers.resume('session-a', partial.transferId);
    assert.equal(done.state, 'completed');
    assert.equal(done.sha256, createHash('sha256').update(data).digest('hex'));
    const indexes = fake.exchanges.filter(exchange => exchange.action === 'transfer_fetch')
      .map(exchange => JSON.parse(exchange.input.toString('utf8').trim()).index);
    assert.deepEqual(indexes, [0, 1, 2, 3, 4]); // five blocks, each fetched exactly once
  } finally { await fake.cleanup(); }
});

it('download enforces the local target overwrite contract', async () => {
  const { fake, transfers } = await buildHarness();
  try {
    const data = Buffer.alloc(300, 0x88);
    const name = 'target-dl-' + randomUUID() + '.bin';
    await writeSource(fake.workspace, name, data);
    const dest = join(fake.workspace, 'target-dl.bin');
    await writeFile(dest, Buffer.from('original local content'));
    // Existing target without overwrite: refusal that reports the observed version.
    await assert.rejects(transfers.download('session-a', { path: name, localPath: 'target-dl.bin' }),
      error => error.code === 'FILE_CONFLICT' && /l1-\d+:\d+(\.\d+)?/.test(error.message));
    // overwrite needs expectedVersion; expectedVersion needs overwrite.
    await assert.rejects(transfers.download('session-a', { path: name, localPath: 'target-dl.bin', overwrite: true }),
      error => error.code === 'INVALID_REQUEST');
    await assert.rejects(transfers.download('session-a', { path: name, localPath: 'target-dl.bin', expectedVersion: 'l1-1:2' }),
      error => error.code === 'INVALID_REQUEST');
    await assert.rejects(transfers.download('session-a', {
      path: name, localPath: 'target-dl.bin', overwrite: true, expectedVersion: 'l1-1:2',
    }), error => error.code === 'FILE_CONFLICT');
    // The observed version from the refusal message authorizes the replacement.
    let observed;
    await assert.rejects(transfers.download('session-a', { path: name, localPath: 'target-dl.bin' }),
      error => (observed = /l1-\d+:\d+(\.\d+)?/.exec(error.message)?.[0], true));
    const replaced = await transfers.download('session-a', {
      path: name, localPath: 'target-dl.bin', overwrite: true, expectedVersion: observed,
    });
    assert.equal(replaced.state, 'completed');
    const committed = await readFile(dest);
    assert.ok(committed.equals(data));
    // An overwrite bound to a version that no longer describes the target is refused.
    await writeFile(dest, Buffer.from('moved underneath'));
    await assert.rejects(transfers.download('session-a', {
      path: name, localPath: 'target-dl.bin', overwrite: true, expectedVersion: observed,
    }), error => error.code === 'FILE_CONFLICT');
  } finally { await fake.cleanup(); }
});

it('a local target appearing mid-download refuses the commit without clobbering', async () => {
  const { fake, transfers } = await buildHarness();
  try {
    const data = Buffer.alloc(CHUNK * 4, 0x99); // four fetches outrun a 1 s budget at 400 ms each
    const name = 'appear-dl-' + randomUUID() + '.bin';
    await writeSource(fake.workspace, name, data);
    fake.fetchDelayMs = 400;
    const partial = await transfers.download('session-a', {
      path: name, localPath: 'appear-dl.bin', chunkSize: CHUNK, budgetMs: 1000,
    });
    assert.equal(partial.state, 'transferring');
    fake.fetchDelayMs = 0;
    const intruder = Buffer.from('externally created');
    await writeFile(join(fake.workspace, 'appear-dl.bin'), intruder);
    await assert.rejects(transfers.resume('session-a', partial.transferId),
      error => error.code === 'FILE_CONFLICT');
    assert.deepEqual(await readFile(join(fake.workspace, 'appear-dl.bin')), intruder);
    // The failed receiver keeps its records; the formal target was never touched.
    const record = JSON.parse(await readFile(join(fake.stateRoot, 'local-state',
      createHash('sha256').update('identity-13').digest('hex').slice(0, 24),
      'transfers', partial.transferId, 'record.json'), 'utf8'));
    assert.equal(record.state, 'failed');
  } finally { await fake.cleanup(); }
});

it('downloads register their temporary in the ledger before creation and refuse over-quota cleanly', async () => {
  const { fake, transfers } = await buildHarness(2048);
  try {
    const data = Buffer.alloc(5000, 7);
    const name = 'quota-dl-' + randomUUID() + '.bin';
    await writeSource(fake.workspace, name, data);
    await assert.rejects(transfers.download('session-a', { path: name, localPath: 'quota-dl.bin', chunkSize: CHUNK }),
      error => error.code === 'WORKSPACE_QUOTA_EXCEEDED');
    assert.deepEqual(await localTemps(fake.workspace), []);
    const { SpaceLedger } = await import('../build/services/space-ledger.js');
    const usage = await new SpaceLedger(localLedgerPath(fake), 2048).usage();
    assert.equal(usage.tempBytes, 0);
  } finally { await fake.cleanup(); }
});

it('committed downloads leave the space measurement and clean their registrations', async () => {
  const { fake, transfers } = await buildHarness(8192);
  try {
    const data = Buffer.alloc(3000, 9);
    for (const name of ['first-dl.bin', 'second-dl.bin']) {
      const source = 'committed-' + randomUUID() + '.bin';
      await writeSource(fake.workspace, source, data);
      const outcome = await transfers.download('session-a', { path: source, localPath: name, chunkSize: CHUNK });
      assert.equal(outcome.state, 'completed');
      assert.equal(outcome.bytesWritten, data.length);
      assert.deepEqual(await readFile(join(fake.workspace, name)), data);
    }
    // Both committed files together exceed half the limit: they must not be counted.
    const { SpaceLedger } = await import('../build/services/space-ledger.js');
    const usage = await new SpaceLedger(localLedgerPath(fake), 8192).usage();
    assert.equal(usage.tempBytes, 0);
    assert.equal(usage.resourceCount, 0);
    assert.deepEqual(await localTemps(fake.workspace), []);
  } finally { await fake.cleanup(); }
});

it('local ENOSPC while receiving maps to STORAGE_FULL, clears the temp and stays resumable', async () => {
  const { fake, transfers } = await buildHarness(1 << 20);
  const scratch = await open(join(fake.workspace, 'probe'), 'w');
  const handlePrototype = Object.getPrototypeOf(scratch);
  await scratch.close();
  const original = handlePrototype.write;
  try {
    const data = Buffer.alloc(CHUNK * 2 + 500, 5);
    const name = 'enospc-' + randomUUID() + '.bin';
    await writeSource(fake.workspace, name, data);
    let failed = false;
    handlePrototype.write = async function (buffer, ...rest) {
      if (!failed && buffer.length > 1000) {
        failed = true;
        throw Object.assign(new Error('simulated no space'), { code: 'ENOSPC' });
      }
      return original.call(this, buffer, ...rest);
    };
    await assert.rejects(transfers.download('session-a', { path: name, localPath: 'enospc.bin', chunkSize: CHUNK }),
      error => error.code === 'STORAGE_FULL');
    handlePrototype.write = original;
    assert.deepEqual(await localTemps(fake.workspace), []);
    const { SpaceLedger } = await import('../build/services/space-ledger.js');
    assert.equal((await new SpaceLedger(localLedgerPath(fake), 1 << 20).usage()).resourceCount, 0);
  } finally {
    handlePrototype.write = original;
    await fake.cleanup();
  }
});

it('download resume and status are session-scoped and unknown ids are refused', async () => {
  const { fake, transfers } = await buildHarness();
  try {
    const data = Buffer.alloc(CHUNK * 3, 0x11);
    const name = 'scope-dl-' + randomUUID() + '.bin';
    await writeSource(fake.workspace, name, data);
    fake.fetchDelayMs = 400;
    const partial = await transfers.download('session-a', { path: name, localPath: 'scope-dl.bin', chunkSize: CHUNK, budgetMs: 1000 });
    fake.fetchDelayMs = 0;
    await assert.rejects(transfers.resume('session-b', partial.transferId),
      error => error.code === 'TRANSFER_SCOPE_MISMATCH');
    await assert.rejects(transfers.status('session-b', partial.transferId),
      error => error.code === 'TRANSFER_SCOPE_MISMATCH');
    await assert.rejects(transfers.status('session-a', 'f'.repeat(32)),
      error => error.code === 'TRANSFER_NOT_FOUND');
    const done = await transfers.resume('session-a', partial.transferId);
    assert.equal(done.state, 'completed');
  } finally { await fake.cleanup(); }
});
