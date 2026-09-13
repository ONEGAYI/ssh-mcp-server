import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const MODULE_URL = new URL('../build/services/maintenance.js', import.meta.url).href;
let MaintenanceService;
try { ({ MaintenanceService } = await import(MODULE_URL)); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

const DAY = 86400000;

function hex32() { return randomUUID().replaceAll('-', ''); }

async function buildFixture(policy = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-maint-'));
  const stateRoot = join(root, 'state');
  const profilePath = join(root, 'profile.json');
  await writeFile(profilePath, JSON.stringify({ workspaceId: 'maint-test', policy }));
  const identity = 'identity-maintenance';
  const identityDir = join(stateRoot, createHash('sha256').update(identity).digest('hex').slice(0, 24));
  const config = { workspaceId: 'maint-test', identity, profilePath, localStateDir: stateRoot };
  return { root, stateRoot, identityDir, config };
}

async function writeTask(identityDir, jobId, files) {
  const directory = join(identityDir, 'tasks', jobId);
  await mkdir(directory, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    await writeFile(join(directory, name), JSON.stringify(value));
  }
  return directory;
}

async function writeTransfer(identityDir, transferId, record, extra = {}) {
  const directory = join(identityDir, 'transfers', transferId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'record.json'), JSON.stringify(record));
  for (const [name, value] of Object.entries(extra)) {
    await writeFile(join(directory, name), JSON.stringify(value));
  }
  return directory;
}

function recordingRemote(outcome = { completed: true }) {
  const remote = {
    calls: [],
    async call(action, request, options) {
      remote.calls.push({ action, request, options });
      if (typeof outcome === 'function') return outcome(action, request);
      return outcome;
    },
  };
  return remote;
}

async function readMaintenanceState(identityDir) {
  return JSON.parse(await readFile(join(identityDir, 'maintenance.json'), 'utf8'));
}

it('reclaims expired local task records, keeps fresh ones, and drives the remote round', async () => {
  assert.ok(MaintenanceService, 'MaintenanceService is not implemented');
  const fixture = await buildFixture();
  const remote = recordingRemote();
  try {
    const acknowledgedOld = await writeTask(fixture.identityDir, 'job-old-ack', {
      'record.json': { schemaVersion: 1, jobId: 'job-old-ack', workspaceId: 'maint-test' },
      'ack.json': { jobId: 'job-old-ack', acknowledgedAt: new Date(Date.now() - 40 * DAY).toISOString() },
    });
    const acknowledgedFresh = await writeTask(fixture.identityDir, 'job-new-ack', {
      'record.json': { schemaVersion: 1, jobId: 'job-new-ack', workspaceId: 'maint-test' },
      'ack.json': { jobId: 'job-new-ack', acknowledgedAt: new Date().toISOString() },
    });
    const service = new MaintenanceService(fixture.config, remote);
    const result = await service.maybeMaintain();
    assert.equal(result.skipped, undefined, JSON.stringify(result));
    assert.equal(await stat(acknowledgedOld).then(() => true, () => false), false, 'expired record must be removed');
    assert.equal(await stat(acknowledgedFresh).then(() => true, () => false), true, 'fresh record must stay');
    assert.deepEqual(result.local.removedTasks, ['job-old-ack']);
    // The remote round carries the freshly loaded policy retention in milliseconds.
    assert.equal(remote.calls.length, 1);
    assert.equal(remote.calls[0].action, 'maintenance');
    assert.equal(remote.calls[0].request.retentionMs.confirmedResultMs, 30 * DAY);
    assert.ok(remote.calls[0].request.maxItemsPerRun >= 1);
    const state = JSON.parse(await readFile(join(fixture.identityDir, 'maintenance.json'), 'utf8'));
    assert.ok(state.lastCompletedAt > Date.now() - DAY);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

it('expires finished but unacknowledged results from completion; unstarted records stay', async () => {
  const fixture = await buildFixture();
  const remote = recordingRemote();
  try {
    const old = await writeTask(fixture.identityDir, 'job-unacked', {
      'record.json': { schemaVersion: 1, jobId: 'job-unacked', workspaceId: 'maint-test' },
      'completion.json': { jobId: 'job-unacked', state: 'exited', completedAt: (Date.now() - 40 * DAY) / 1000 },
    });
    const rejected = await writeTask(fixture.identityDir, 'job-rejected', {
      'record.json': { schemaVersion: 1, jobId: 'job-rejected', workspaceId: 'maint-test' },
      'rejected.json': { jobId: 'job-rejected', completedAt: (Date.now() - 40 * DAY) / 1000 },
    });
    const prepared = await writeTask(fixture.identityDir, 'job-prepared', {
      'record.json': { schemaVersion: 1, jobId: 'job-prepared', workspaceId: 'maint-test' },
      'started.json': { confirmed: true },
    });
    const service = new MaintenanceService(fixture.config, remote);
    const result = await service.maybeMaintain();
    assert.equal(await stat(old).then(() => true, () => false), false);
    assert.equal(await stat(rejected).then(() => true, () => false), false);
    assert.equal(await stat(prepared).then(() => true, () => false), true, 'spec sets no expiry for prepared records');
    assert.deepEqual(result.local.removedTasks.sort(), ['job-rejected', 'job-unacked']);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

it('expires local transfer records by terminal retention and stalled TTL, releasing receiver temps', async () => {
  const fixture = await buildFixture();
  const remote = recordingRemote();
  try {
    const acknowledged = hex32();
    const stalled = hex32();
    const active = hex32();
    const untimestamped = hex32();
    await writeTransfer(fixture.identityDir, acknowledged, {
      schemaVersion: 1, transferId: acknowledged, workspaceId: 'maint-test', sessionId: 's',
      direction: 'download', state: 'completed', completedAt: Date.now() - 40 * DAY,
    }, { 'ack.json': { transferId: acknowledged, acknowledgedAt: new Date(Date.now() - 40 * DAY).toISOString() } });
    const tempPath = join(fixture.root, 'stalled.temp');
    await writeFile(tempPath, 'stalled bytes');
    await writeTransfer(fixture.identityDir, stalled, {
      schemaVersion: 1, transferId: stalled, workspaceId: 'maint-test', sessionId: 's',
      direction: 'download', state: 'transferring', tempPath, resourceId: null,
      registeredAt: Date.now() - 4 * DAY, expiresAt: Date.now() - DAY,
    });
    await writeTransfer(fixture.identityDir, active, {
      schemaVersion: 1, transferId: active, workspaceId: 'maint-test', sessionId: 's',
      direction: 'download', state: 'transferring', tempPath: null, resourceId: null,
      registeredAt: Date.now(), expiresAt: Date.now() + 3 * DAY,
    });
    // No usable expiresAt: this end never guesses an expiry for active shapes.
    await writeTransfer(fixture.identityDir, untimestamped, {
      schemaVersion: 1, transferId: untimestamped, workspaceId: 'maint-test', sessionId: 's',
      direction: 'download', state: 'transferring', tempPath: null, resourceId: null,
      registeredAt: Date.now() - 40 * DAY,
    });
    const service = new MaintenanceService(fixture.config, remote);
    const result = await service.maybeMaintain();
    assert.equal(await stat(join(fixture.identityDir, 'transfers', acknowledged)).then(() => true, () => false), false);
    assert.equal(await stat(join(fixture.identityDir, 'transfers', stalled)).then(() => true, () => false), false);
    assert.equal(await stat(join(fixture.identityDir, 'transfers', active)).then(() => true, () => false), true);
    assert.equal(await stat(join(fixture.identityDir, 'transfers', untimestamped)).then(() => true, () => false), true);
    assert.equal(await stat(tempPath).then(() => true, () => false), false, 'stalled receiver temp must be released');
    assert.deepEqual(result.local.removedTransfers.sort(), [acknowledged, stalled].sort());
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

it('expires stalled upload mirror records by their recorded TTL like downloads (review R1)', async () => {
  const fixture = await buildFixture();
  const remote = recordingRemote();
  const staleUpload = hex32();
  const liveUpload = hex32();
  const untimestampedUpload = hex32();
  try {
    // Upload mirrors carry no state of their own; the expiry is the recorded
    // TTL, exactly like a stalled download receiver record.
    await writeTransfer(fixture.identityDir, staleUpload, {
      schemaVersion: 1, transferId: staleUpload, workspaceId: 'maint-test', sessionId: 's',
      direction: 'upload', registeredAt: Date.now() - 4 * DAY, expiresAt: Date.now() - DAY,
    });
    await writeTransfer(fixture.identityDir, liveUpload, {
      schemaVersion: 1, transferId: liveUpload, workspaceId: 'maint-test', sessionId: 's',
      direction: 'upload', registeredAt: Date.now(), expiresAt: Date.now() + 3 * DAY,
    });
    // Pre-R1 upload records have no expiresAt: kept conservatively.
    await writeTransfer(fixture.identityDir, untimestampedUpload, {
      schemaVersion: 1, transferId: untimestampedUpload, workspaceId: 'maint-test', sessionId: 's',
      direction: 'upload', registeredAt: Date.now() - 40 * DAY,
    });
    const result = await new MaintenanceService(fixture.config, remote).maybeMaintain();
    assert.equal(await stat(join(fixture.identityDir, 'transfers', staleUpload)).then(() => true, () => false), false,
      'an expired upload mirror must be reclaimed');
    assert.equal(await stat(join(fixture.identityDir, 'transfers', liveUpload)).then(() => true, () => false), true);
    assert.equal(await stat(join(fixture.identityDir, 'transfers', untimestampedUpload)).then(() => true, () => false), true);
    assert.deepEqual(result.local.removedTransfers, [staleUpload]);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

it('unknown download records are non-terminal: they expire by their TTL, not the terminal retention (review R2)', async () => {
  const fixture = await buildFixture();
  const remote = recordingRemote();
  const expiredUnknown = hex32();
  const freshUnknown = hex32();
  try {
    for (const [id, offset] of [[expiredUnknown, -DAY], [freshUnknown, 3 * DAY]]) {
      await writeTransfer(fixture.identityDir, id, {
        schemaVersion: 1, transferId: id, workspaceId: 'maint-test', sessionId: 's',
        direction: 'download', state: 'unknown', tempPath: null, resourceId: null,
        completedAt: Date.now() - DAY, error: { code: 'TRANSFER_STATE_UNKNOWN', message: 'inspect manually' },
        registeredAt: Date.now() - 4 * DAY, expiresAt: Date.now() + offset,
      });
    }
    const result = await new MaintenanceService(fixture.config, remote).maybeMaintain();
    assert.equal(await stat(join(fixture.identityDir, 'transfers', expiredUnknown)).then(() => true, () => false), false,
      'an unknown record past its TTL is reclaimed with the retention window');
    assert.equal(await stat(join(fixture.identityDir, 'transfers', freshUnknown)).then(() => true, () => false), true,
      'a fresh unknown record stays for manual inspection');
    assert.deepEqual(result.local.removedTransfers, [expiredUnknown]);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

it('throttles by the persisted maintenance interval', async () => {
  const fixture = await buildFixture();
  const remote = recordingRemote();
  try {
    await mkdir(fixture.identityDir, { recursive: true });
    await writeFile(join(fixture.identityDir, 'maintenance.json'),
      JSON.stringify({ schemaVersion: 1, lastCompletedAt: Date.now() }));
    const result = await new MaintenanceService(fixture.config, remote).maybeMaintain();
    assert.equal(result.skipped, 'interval');
    assert.equal(remote.calls.length, 0);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

it('skips while another live process holds the maintenance lock', async () => {
  const fixture = await buildFixture();
  const remote = recordingRemote();
  try {
    await mkdir(fixture.identityDir, { recursive: true });
    const handle = await open(join(fixture.identityDir, 'maintenance.lock'), 'wx', 0o600);
    await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }));
    await handle.close();
    const result = await new MaintenanceService(fixture.config, remote).maybeMaintain();
    assert.equal(result.skipped, 'busy');
    assert.equal(remote.calls.length, 0);
    // A stale lock from a dead holder is reclaimed on the next attempt.
    await writeFile(join(fixture.identityDir, 'maintenance.lock'),
      JSON.stringify({ pid: 300000, acquiredAt: Date.now() }));
    const recovered = await new MaintenanceService(fixture.config, remote).maybeMaintain();
    assert.equal(recovered.skipped, undefined);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

it('a failed remote round keeps the timestamp unset so the next trigger retries (offline catch-up)', async () => {
  const fixture = await buildFixture();
  let failing = true;
  const remote = recordingRemote((action) => {
    if (failing) { const error = new Error('connection down'); error.retriable = true; throw error; }
    return { completed: true };
  });
  try {
    const service = new MaintenanceService(fixture.config, remote);
    const first = await service.maybeMaintain();
    assert.equal(first.remoteError, 'connection down');
    assert.equal(await stat(join(fixture.identityDir, 'maintenance.json')).then(() => true, () => false), true,
      'the attempt itself is recorded (lastRunAt / lastRemoteAttemptAt) even when the remote round fails');
    const afterFailure = await readMaintenanceState(fixture.identityDir);
    assert.equal(afterFailure.lastCompletedAt, 0, 'no completion timestamp after a failed remote round');
    assert.ok(afterFailure.lastRemoteAttemptAt > 0);
    // The five-minute failure backoff has elapsed by the next trigger: the
    // retry runs for real and completes.
    afterFailure.lastRemoteAttemptAt = Date.now() - 6 * 60_000;
    await writeFile(join(fixture.identityDir, 'maintenance.json'), JSON.stringify(afterFailure));
    failing = false;
    const second = await service.maybeMaintain();
    assert.equal(second.remoteError, undefined);
    const state = await readMaintenanceState(fixture.identityDir);
    assert.ok(state.lastCompletedAt > 0);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

it('records lastRunAt for every executed round, whether the remote round succeeds or fails (review R3)', async () => {
  assert.ok(MaintenanceService, 'MaintenanceService is not implemented');
  const fixture = await buildFixture();
  const remote = recordingRemote();
  try {
    await new MaintenanceService(fixture.config, remote).maybeMaintain();
    const state = await readMaintenanceState(fixture.identityDir);
    assert.equal(typeof state.lastRunAt, 'number');
    assert.ok(state.lastRunAt > 0 && state.lastRunAt <= Date.now(), 'the executed round stamps lastRunAt');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
  const failing = await buildFixture();
  const down = recordingRemote(() => { const error = new Error('connection down'); throw error; });
  try {
    await new MaintenanceService(failing.config, down).maybeMaintain();
    const state = await readMaintenanceState(failing.identityDir);
    assert.equal(typeof state.lastRunAt, 'number');
    assert.ok(state.lastRunAt > 0 && state.lastRunAt <= Date.now(), 'a failed round is still a run');
  } finally { await rm(failing.root, { recursive: true, force: true }); }
});

it('passes the remote call a timeout that covers the configured time budget (review R6)', async () => {
  assert.ok(MaintenanceService, 'MaintenanceService is not implemented');
  const bigBudget = await buildFixture({ maintenance: { timeBudgetMs: 3_600_000 } });
  const remote = recordingRemote();
  try {
    await new MaintenanceService(bigBudget.config, remote).maybeMaintain();
    assert.equal(remote.calls.length, 1);
    assert.ok(remote.calls[0].options && typeof remote.calls[0].options.timeoutMs === 'number',
      'the maintenance call must carry an explicit exchange timeout');
    assert.ok(remote.calls[0].options.timeoutMs >= 3_600_000 + 15_000,
      'the timeout must cover the full remote budget plus slack, not the 30 s command default');
  } finally { await rm(bigBudget.root, { recursive: true, force: true }); }
  const smallBudget = await buildFixture({ maintenance: { timeBudgetMs: 2_000 } });
  const smallRemote = recordingRemote();
  try {
    await new MaintenanceService(smallBudget.config, smallRemote).maybeMaintain();
    assert.ok(smallRemote.calls[0].options.timeoutMs >= 60_000,
      'small budgets still get the one-minute floor');
  } finally { await rm(smallBudget.root, { recursive: true, force: true }); }
});

it('a half-written lock file is cleaned up so the next attempt is not permanently busy (review R8)', async () => {
  const fixture = await buildFixture();
  const remote = recordingRemote();
  const scratch = await open(join(fixture.root, 'probe'), 'w');
  const handlePrototype = Object.getPrototypeOf(scratch);
  await scratch.close();
  const original = handlePrototype.writeFile;
  try {
    // ENOSPC/EIO shape: the exclusive lock file opens fine but its content
    // write fails, leaving a zero-byte lock behind unless cleaned up.
    let injected = false;
    handlePrototype.writeFile = async function (buffer, ...rest) {
      if (!injected) {
        injected = true;
        throw Object.assign(new Error('simulated no space'), { code: 'ENOSPC' });
      }
      return original.call(this, buffer, ...rest);
    };
    await assert.rejects(new MaintenanceService(fixture.config, remote).maybeMaintain(),
      error => error.code === 'ENOSPC');
    handlePrototype.writeFile = original;
    // The failed writer removed its own half-written lock...
    await assert.rejects(stat(join(fixture.identityDir, 'maintenance.lock')),
      error => error.code === 'ENOENT', 'the half-written lock must be cleaned up');
    // ...so the next trigger acquires the lock instead of reading a corrupt
    // holder forever and skipping as busy.
    const recovered = await new MaintenanceService(fixture.config, remote).maybeMaintain();
    assert.equal(recovered.skipped, undefined, JSON.stringify(recovered));
    assert.equal(remote.calls.length, 1, 'the remote round ran once the lock healed');
  } finally {
    handlePrototype.writeFile = original;
    await rm(fixture.root, { recursive: true, force: true });
  }
});

it('backs off the remote round for five minutes after a failure while local reclamation continues (review R12)', async () => {
  const fixture = await buildFixture();
  let failing = true;
  const remote = recordingRemote((action) => {
    if (failing) { const error = new Error('connection down'); error.retriable = true; throw error; }
    return { completed: true };
  });
  try {
    const service = new MaintenanceService(fixture.config, remote);
    const first = await service.maybeMaintain();
    assert.equal(first.remoteError, 'connection down');
    assert.equal(remote.calls.length, 1);
    // A task that expires during the offline window.
    await writeTask(fixture.identityDir, 'job-backoff', {
      'record.json': { schemaVersion: 1, jobId: 'job-backoff', workspaceId: 'maint-test' },
      'ack.json': { jobId: 'job-backoff', acknowledgedAt: new Date(Date.now() - 40 * DAY).toISOString() },
    });
    // Immediate retrigger: the remote round is skipped for the backoff
    // window (no per-tool-call 30 s connection timeout stacking)...
    const second = await service.maybeMaintain();
    assert.equal(remote.calls.length, 1, 'the backoff window must not retry the remote round');
    assert.equal(second.remoteSkipped, 'backoff');
    assert.equal(second.remoteError, undefined);
    // ...while local reclamation keeps running normally.
    assert.deepEqual(second.local.removedTasks, ['job-backoff']);
    assert.equal(await stat(join(fixture.identityDir, 'tasks', 'job-backoff')).then(() => true, () => false), false);
    // No completion was recorded for the skipped round: the catch-up duty stands.
    assert.equal((await readMaintenanceState(fixture.identityDir)).lastCompletedAt, 0);
    // Once the backoff window lapses, the remote round retries (offline
    // reconnect semantics preserved) and completes.
    failing = false;
    const state = await readMaintenanceState(fixture.identityDir);
    state.lastRemoteAttemptAt = Date.now() - 6 * 60_000;
    await writeFile(join(fixture.identityDir, 'maintenance.json'), JSON.stringify(state));
    const third = await service.maybeMaintain();
    assert.equal(remote.calls.length, 2);
    assert.equal(third.remoteError, undefined);
    assert.ok((await readMaintenanceState(fixture.identityDir)).lastCompletedAt > 0);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

it('leaves local resources to living transfer records even when their holder is gone', async () => {
  const fixture = await buildFixture();
  const remote = recordingRemote();
  const tempPath = join(fixture.root, 'managed.part');
  await writeFile(tempPath, 'receiver bytes');
  const { dev, ino } = await stat(tempPath);
  const transferId = hex32();
  const resourceId = hex32();
  try {
    // A living (non-terminal, within TTL) transfer record still manages its
    // receiver temp, even though the registering helper process is dead.
    await writeTransfer(fixture.identityDir, transferId, {
      schemaVersion: 1, transferId, workspaceId: 'maint-test', sessionId: 's',
      direction: 'download', state: 'transferring', tempPath, resourceId,
      registeredAt: Date.now(), expiresAt: Date.now() + 3 * DAY,
    });
    await writeLedger(fixture.identityDir, {
      [resourceId]: { kind: 'temp-file', path: tempPath, bytes: 13, identity: `${dev}:${ino}`,
        holderPid: 300000, origin: 'file-download', reservationId: null, createdAt: Date.now() },
    });
    const result = await new MaintenanceService(fixture.config, remote).maybeMaintain();
    assert.deepEqual(result.local.reclaimedResources, [], JSON.stringify(result.local));
    assert.equal(await stat(tempPath).then(() => true, () => false), true, 'transfer temp must stay');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

// --- issue #17: crash-leftover local ledger resources ---------------------------

async function writeLedger(identityDir, resources) {
  await mkdir(join(identityDir, 'ledger'), { recursive: true });
  await writeFile(join(identityDir, 'ledger', 'ledger.json'),
    JSON.stringify({ schemaVersion: 1, resources, reservations: {} }));
}

async function readLedgerResources(identityDir) {
  try { return JSON.parse(await readFile(join(identityDir, 'ledger', 'ledger.json'), 'utf8')).resources; }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

it('reclaims crash-leftover local resources whose holder is proven dead, verifying the object identity', async () => {
  assert.ok(MaintenanceService, 'MaintenanceService is not implemented');
  const fixture = await buildFixture();
  const remote = recordingRemote();
  const tempPath = join(fixture.root, 'stalled-download.part');
  await writeFile(tempPath, 'leftover receiver bytes');
  const { dev, ino } = await stat(tempPath);
  const deadId = hex32();
  try {
    await writeLedger(fixture.identityDir, {
      [deadId]: { kind: 'temp-file', path: tempPath, bytes: 23, identity: `${dev}:${ino}`,
        holderPid: 300000, origin: 'file-download', reservationId: null, createdAt: Date.now() - 86400000 },
    });
    const result = await new MaintenanceService(fixture.config, remote).maybeMaintain();
    assert.equal(result.skipped, undefined, JSON.stringify(result));
    assert.deepEqual(result.local.reclaimedResources, [deadId], JSON.stringify(result.local));
    assert.equal(await stat(tempPath).then(() => true, () => false), false, 'verified leftover temp must be deleted');
    assert.deepEqual(await readLedgerResources(fixture.identityDir), {});
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

it('keeps live and unverifiable local ledger resources and releases entries whose object vanished', async () => {
  const fixture = await buildFixture();
  const remote = recordingRemote();
  const livePath = join(fixture.root, 'live.part');
  const unverifiedPath = join(fixture.root, 'unverified.part');
  const replacedPath = join(fixture.root, 'replaced.part');
  await writeFile(livePath, 'live');
  await writeFile(unverifiedPath, 'unverified');
  await writeFile(replacedPath, 'now a foreign object');
  const { dev, ino } = await stat(replacedPath);
  const liveId = hex32(), unverifiedId = hex32(), replacedId = hex32(), vanishedId = hex32();
  try {
    await writeLedger(fixture.identityDir, {
      [liveId]: { kind: 'temp-file', path: livePath, bytes: 4, identity: '9:9',
        holderPid: process.pid, origin: 'file-download', reservationId: null, createdAt: Date.now() },
      [unverifiedId]: { kind: 'temp-file', path: unverifiedPath, bytes: 10, identity: null,
        holderPid: 300000, origin: 'file-download', reservationId: null, createdAt: Date.now() },
      [replacedId]: { kind: 'temp-file', path: replacedPath, bytes: 6, identity: `${dev}:${ino}x`,
        holderPid: 300000, origin: 'file-download', reservationId: null, createdAt: Date.now() },
      [vanishedId]: { kind: 'temp-file', path: join(fixture.root, 'gone.part'), bytes: 6, identity: '5:5',
        holderPid: 300000, origin: 'file-download', reservationId: null, createdAt: Date.now() },
    });
    const result = await new MaintenanceService(fixture.config, remote).maybeMaintain();
    const kept = await readLedgerResources(fixture.identityDir);
    // The live holder's registration and temp stay untouched.
    assert.ok(kept[liveId], 'live registration must stay');
    assert.equal(await stat(livePath).then(() => true, () => false), true);
    // An object that was never identity-anchored stays unknown: management
    // fields only, no result body, and its bytes keep counting.
    assert.ok(kept[unverifiedId], 'unverifiable registration must stay');
    assert.deepEqual(Object.keys(kept[unverifiedId]).sort(),
      ['bytes', 'createdAt', 'holderPid', 'identity', 'kind', 'origin', 'path', 'reservationId']);
    assert.equal(await stat(unverifiedPath).then(() => true, () => false), true);
    // A path naming a different object than the registration recorded is no
    // longer ours: release the entry, never delete the foreign file.
    assert.equal(kept[replacedId], undefined);
    assert.equal(await stat(replacedPath).then(() => true, () => false), true);
    // A registration whose file is already gone just leaves the ledger.
    assert.equal(kept[vanishedId], undefined);
    assert.deepEqual(result.local.reclaimedResources.sort(), [replacedId, vanishedId].sort());
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
