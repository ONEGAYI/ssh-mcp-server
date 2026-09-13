import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MODULE_URL = new URL('../build/services/space-ledger.js', import.meta.url).href;

let SpaceLedger, DEFAULT_SPACE_LIMIT_BYTES, workspaceLedgerDirectory;
try {
  ({ SpaceLedger, DEFAULT_SPACE_LIMIT_BYTES, workspaceLedgerDirectory } = await import(MODULE_URL));
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}

function fixture() {
  return mkdtemp(join(tmpdir(), 'ssh-mcp-space-'));
}

function spawnReserver(directory, limit, bytes) {
  const script = `
    import { SpaceLedger } from ${JSON.stringify(MODULE_URL)};
    const ledger = new SpaceLedger(process.env.LEDGER_DIR, Number(process.env.LEDGER_LIMIT));
    try {
      const reserved = await ledger.reserve(Number(process.env.LEDGER_BYTES), 'concurrent child');
      console.log(JSON.stringify({ ok: true, id: reserved.reservationId }));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, code: error.code }));
    }`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script],
      { env: { ...process.env, LEDGER_DIR: directory, LEDGER_LIMIT: String(limit), LEDGER_BYTES: String(bytes) } });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error('child failed: ' + output)));
  });
}

it('exposes the 10 GiB default limit and a shared per-workspace ledger directory', async () => {
  assert.equal(typeof SpaceLedger, 'function', 'SpaceLedger is not implemented');
  assert.equal(DEFAULT_SPACE_LIMIT_BYTES, 10 * 1024 ** 3);
  const directory = workspaceLedgerDirectory(join(tmpdir(), 'state'), 'identity-fixture');
  const expected = join(tmpdir(), 'state', createHash('sha256').update('identity-fixture').digest('hex').slice(0, 24), 'ledger');
  assert.equal(directory, expected);
});

it('concurrent reservations across separate processes never exceed the workspace limit', async () => {
  assert.ok(SpaceLedger, 'SpaceLedger is not implemented');
  const root = await fixture();
  try {
    const ledger = new SpaceLedger(join(root, 'ledger'), 10_000);
    const results = await Promise.all([
      spawnReserver(join(root, 'ledger'), 10_000, 6000),
      spawnReserver(join(root, 'ledger'), 10_000, 6000),
      spawnReserver(join(root, 'ledger'), 10_000, 6000),
    ]);
    assert.equal(results.filter(result => result.ok).length, 1, JSON.stringify(results));
    assert.deepEqual(results.filter(result => !result.ok).map(result => result.code), ['WORKSPACE_QUOTA_EXCEEDED', 'WORKSPACE_QUOTA_EXCEEDED']);
    const usage = await ledger.usage();
    assert.equal(usage.reservedBytes, 6000);
    assert.equal(usage.usedBytes, usage.stateBytes + 6000);
    assert.equal(usage.limitBytes, 10_000);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('registering a resource consumes the reservation it cites without double counting', async () => {
  assert.ok(SpaceLedger);
  const root = await fixture();
  try {
    const ledger = new SpaceLedger(join(root, 'ledger'), 1 << 20);
    const reservationId = await ledger.reserve(4096, 'transfer plan');
    const before = await ledger.usage();
    assert.equal(before.reservedBytes, 4096);
    const resourceId = await ledger.register(join(root, 'transfer.part'), 1500, 'local-transfer', reservationId);
    const middle = await ledger.usage();
    assert.equal(middle.tempBytes, 1500);
    assert.equal(middle.reservedBytes, 2596);
    assert.equal(middle.usedBytes, before.usedBytes);
    await ledger.register(join(root, 'rest.part'), 2596, 'local-transfer', reservationId);
    assert.equal((await ledger.usage()).reservedBytes, 0);
    await assert.rejects(ledger.register(join(root, 'final.part'), 10, 'local-transfer', reservationId),
      error => error.code === 'RESOURCE_NOT_FOUND');
    await ledger.release(resourceId);
    const after = await ledger.usage();
    assert.equal(after.tempBytes, 2596); // only the second registration remains
    assert.equal(after.usedBytes, before.usedBytes - 1500);
    await assert.rejects(ledger.releaseReservation(reservationId), error => error.code === 'RESOURCE_NOT_FOUND');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('rejects invalid ledger input with explicit codes', async () => {
  assert.ok(SpaceLedger);
  const root = await fixture();
  try {
    const ledger = new SpaceLedger(join(root, 'ledger'), 1 << 20);
    for (const bytes of [0, -5, 'big', 1.5]) {
      await assert.rejects(ledger.reserve(bytes, 'note'), error => error.code === 'INVALID_REQUEST', String(bytes));
    }
    await assert.rejects(ledger.register('relative.part', 10), error => error.code === 'INVALID_REQUEST');
    await assert.rejects(ledger.inspect('f'.repeat(32)), error => error.code === 'RESOURCE_NOT_FOUND');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('a stale lock left by a dead holder is reclaimed, never while the holder lives', async () => {
  assert.ok(SpaceLedger);
  const root = await fixture();
  const directory = join(root, 'ledger');
  try {
    // A dead holder (already exited child pid) must not block the ledger forever;
    // reservations themselves are never auto-reclaimed (#16/#17 own expiry).
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)']);
    await new Promise(resolve => dead.on('close', resolve));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'ledger.lock'), JSON.stringify({ pid: dead.pid, acquiredAt: Date.now() }));
    const ledger = new SpaceLedger(directory, 1 << 20);
    const reservationId = await ledger.reserve(512, 'after stale lock');
    assert.match(reservationId, /^[0-9a-f]{32}$/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('local inspect reports object identity and holder evidence without age judgments', async () => {
  assert.ok(SpaceLedger);
  const root = await fixture();
  try {
    const ledger = new SpaceLedger(join(root, 'ledger'), 1 << 20);
    const target = join(root, 'held.part');
    await writeFile(target, 'payload');
    const resourceId = await ledger.register(target, 7, 'test');
    const stats = await stat(target);
    await ledger.attachIdentity(resourceId, `${stats.dev}:${stats.ino}`);
    const live = await ledger.inspect(resourceId);
    assert.equal(live.exists, true);
    assert.equal(live.identityMatches, true);
    assert.equal(live.holderAlive, true); // the registering test process is alive
    // A different object at the same path must not pass as the registered one.
    const replacement = join(root, 'other.part');
    await writeFile(replacement, 'another object');
    await rename(replacement, target);
    assert.equal((await ledger.inspect(resourceId)).identityMatches, false);
    await rm(target, { force: true });
    const missing = await ledger.inspect(resourceId);
    assert.equal(missing.exists, false);
    assert.equal(missing.identityMatches, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

function downloadConfig(root, limitBytes) {
  return {
    remoteRoot: '/remote', connectionName: 'fixture', directoryScope: 'restricted',
    sshConfigs: { fixture: {} }, localRoot: join(root, 'work'), localStateDir: join(root, 'state'),
    identity: 'ticket-08-identity', policy: { spaceLimitBytes: limitBytes },
  };
}

function stubRemote(payload) {
  const version = 'v1';
  return {
    calls: [],
    async call(action, request) {
      this.calls.push({ action, request });
      assert.equal(action, 'file_read');
      assert.equal(request.grantRead, false);
      const offset = request.offset ?? 0;
      const chunk = payload.subarray(offset, offset + request.maxBytes);
      return { data: chunk.toString('base64'), encoding: 'base64', version, size: payload.length,
        startOffset: offset, endOffset: offset + chunk.length,
        nextOffset: offset + chunk.length < payload.length ? offset + chunk.length : null, truncated: false };
    },
  };
}

async function localTemps(work) {
  return (await readdir(work)).filter(name => name.startsWith('.ssh-mcp-download-'));
}

it('download registers its temporary before creation and rejects over-quota transfers cleanly', async () => {
  assert.ok(SpaceLedger);
  let FileService;
  try { ({ FileService } = await import('../build/services/file-service.js')); }
  catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
  assert.ok(FileService, 'FileService is not built');
  const root = await fixture();
  try {
    await mkdir(join(root, 'work'), { recursive: true });
    const remote = stubRemote(Buffer.alloc(5000, 7));
    const files = new FileService(remote, downloadConfig(root, 2048));
    await assert.rejects(files.download('session', { path: 'big.bin', localPath: 'big.bin' }),
      error => error.code === 'WORKSPACE_QUOTA_EXCEEDED');
    assert.equal((await localTemps(join(root, 'work'))).length, 0);
    const ledger = new SpaceLedger(join(root, 'state',
      createHash('sha256').update('ticket-08-identity').digest('hex').slice(0, 24), 'ledger'), 2048);
    const usage = await ledger.usage();
    assert.equal(usage.tempBytes, 0);
    assert.equal(usage.limitBytes, 2048);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('committed downloads leave the space measurement and clean their registrations', async () => {
  assert.ok(SpaceLedger);
  let FileService;
  try { ({ FileService } = await import('../build/services/file-service.js')); }
  catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
  assert.ok(FileService);
  const root = await fixture();
  try {
    await mkdir(join(root, 'work'), { recursive: true });
    const payload = Buffer.alloc(3000, 9);
    const ledger = new SpaceLedger(join(root, 'state',
      createHash('sha256').update('ticket-08-identity').digest('hex').slice(0, 24), 'ledger'), 8192);
    for (const name of ['first.bin', 'second.bin']) {
      const files = new FileService(stubRemote(payload), downloadConfig(root, 8192));
      const result = await files.download('session', { path: 'payload.bin', localPath: name });
      assert.equal(result.bytesWritten, 3000);
      assert.deepEqual(await readFile(join(root, 'work', name)), payload);
    }
    // Both committed files together exceed half the limit: they must not be counted.
    const usage = await ledger.usage();
    assert.equal(usage.tempBytes, 0);
    assert.equal(usage.resourceCount, 0);
    assert.equal((await localTemps(join(root, 'work'))).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('local ENOSPC while writing the temp maps to STORAGE_FULL and clears the registration', async () => {
  assert.ok(SpaceLedger);
  let FileService;
  try { ({ FileService } = await import('../build/services/file-service.js')); }
  catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
  assert.ok(FileService);
  const root = await fixture();
  await mkdir(join(root, 'work'), { recursive: true });
  const scratch = await open(join(root, 'probe'), 'w');
  const handlePrototype = Object.getPrototypeOf(scratch);
  await scratch.close();
  const original = handlePrototype.writeFile;
  try {
    const payload = Buffer.alloc(3000, 5);
    // Fail exactly one large temp write; ledger writes stay below the threshold.
    let failed = false;
    handlePrototype.writeFile = async function (data, options) {
      if (!failed && data.length > 1000) {
        failed = true;
        throw Object.assign(new Error('simulated no space'), { code: 'ENOSPC' });
      }
      return original.call(this, data, options);
    };
    const files = new FileService(stubRemote(payload), downloadConfig(root, 1 << 20));
    await assert.rejects(files.download('session', { path: 'nospace.bin', localPath: 'nospace.bin' }),
      error => error.code === 'STORAGE_FULL');
    handlePrototype.writeFile = original;
    assert.equal((await localTemps(join(root, 'work'))).length, 0);
    const ledger = new SpaceLedger(join(root, 'state',
      createHash('sha256').update('ticket-08-identity').digest('hex').slice(0, 24), 'ledger'), 1 << 20);
    assert.equal((await ledger.usage()).resourceCount, 0);
  } finally {
    handlePrototype.writeFile = original;
    await rm(root, { recursive: true, force: true });
  }
});
