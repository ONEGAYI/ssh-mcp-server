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
    async call(action, request) {
      remote.calls.push({ action, request });
      if (typeof outcome === 'function') return outcome(action, request);
      return outcome;
    },
  };
  return remote;
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
    assert.equal(await stat(join(fixture.identityDir, 'maintenance.json')).then(() => true, () => false), false,
      'no completion timestamp after a failed remote round');
    failing = false;
    const second = await service.maybeMaintain();
    assert.equal(second.remoteError, undefined);
    const state = JSON.parse(await readFile(join(fixture.identityDir, 'maintenance.json'), 'utf8'));
    assert.ok(state.lastCompletedAt > 0);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
