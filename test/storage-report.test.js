import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

let buildStorageReport;
try {
  ({ buildStorageReport } = await import(new URL('../build/services/storage-report.js', import.meta.url).href));
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}

const DAY = 86400000;

function hex32() { return randomUUID().replaceAll('-', ''); }

/** A local fixture shaped like one workspace identity directory plus a
 * profile file, so the report's local half exercises the real on-disk layout. */
async function buildFixture(policy = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-report-'));
  const profilePath = join(root, 'profile.json');
  await writeFile(profilePath, JSON.stringify({ workspaceId: 'report-test', policy }));
  const identity = 'identity-report';
  const identityDir = join(root, 'state', createHash('sha256').update(identity).digest('hex').slice(0, 24));
  const config = { workspaceId: 'report-test', identity, profilePath, localStateDir: join(root, 'state') };
  return { root, identityDir, config };
}

async function writeLocalLedger(identityDir, resources, reservations) {
  await mkdir(join(identityDir, 'ledger'), { recursive: true });
  await writeFile(join(identityDir, 'ledger', 'ledger.json'),
    JSON.stringify({ schemaVersion: 1, resources, reservations }));
}

function tempResource(path, bytes) {
  return { kind: 'temp-file', path, bytes, identity: null, holderPid: 4242,
    origin: 'test', reservationId: null, createdAt: Date.now() - DAY };
}

it('aggregates local ledger usage and maintenance counters, never per-item listings', async () => {
  assert.ok(buildStorageReport, 'storage report service is not implemented');
  const fixture = await buildFixture({ limits: { localWorkspaceBytes: 8192 } });
  try {
    // One registered sibling temp (a download receive file next to its target)
    // plus one state file: usedBytes must be the ledger's three-way sum.
    await writeLocalLedger(fixture.identityDir,
      { [hex32()]: tempResource(join(fixture.root, '.ssh-mcp-download-x'), 1500) }, {});
    await writeFile(join(fixture.identityDir, 'tasks.json'), 'x'.repeat(120));
    // The maintenance record keeps per-item id lists internally; the report
    // must aggregate them into counters so the reply stays bounded.
    const removed = Array.from({ length: 200 }, () => 'job-' + hex32());
    await writeFile(join(fixture.identityDir, 'maintenance.json'), JSON.stringify({ schemaVersion: 1,
      lastCompletedAt: 1697000000000,
      lastLocalSummary: { removedTasks: removed, removedTransfers: [], itemsConsidered: 205 } }));
    const remoteStorage = { stateBytes: 10, tempBytes: 0, reservedBytes: 0, usedBytes: 10,
      limitBytes: 10 * 1024 ** 3, resourceCount: 0, reservationCount: 0,
      maintenance: { lastCompletedAt: 1697000001, lastRunAt: 1697000001, removedJobs: 0,
        purgedLogs: 1, markedUnknown: 0, removedTransfers: 0, itemsConsidered: 3 } };
    const files = { call: async () => ({ storage: remoteStorage }) };
    const report = await buildStorageReport(fixture.config, files, 'session-report');
    const local = report.storage.local;
    assert.equal(local.tempBytes, 1500);
    assert.equal(local.reservedBytes, 0);
    assert.equal(local.usedBytes, local.stateBytes + 1500);
    assert.equal(local.limitBytes, 8192);
    assert.ok(local.stateBytes >= 120, 'state scan counts the identity directory contents');
    assert.equal(local.maintenance.lastCompletedAt, 1697000000000);
    assert.equal(local.maintenance.removedTasks, 200, 'per-item lists aggregate into counters');
    assert.equal(local.maintenance.itemsConsidered, 205);
    assert.equal(JSON.stringify(local.maintenance).includes('job-'), false,
      'no per-item identifiers may leak into the bounded report');
    // The remote half passes through with its second-precision maintenance
    // timestamps normalized to milliseconds (the helper's clock is time.time()).
    assert.deepEqual(report.storage.remote, { ...remoteStorage,
      maintenance: { ...remoteStorage.maintenance, lastCompletedAt: 1697000001000, lastRunAt: 1697000001000 } });
    assert.ok(Buffer.byteLength(JSON.stringify(report), 'utf8') <= 4096,
      'the whole report must stay within the 4 KiB budget');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

it('remote maintenance timestamps land in the same millisecond magnitude as the local ones (review R3)', async () => {
  assert.ok(buildStorageReport, 'storage report service is not implemented');
  const fixture = await buildFixture();
  try {
    // The local maintenance record is a real executed round (milliseconds).
    const now = Date.now();
    await mkdir(fixture.identityDir, { recursive: true });
    await writeFile(join(fixture.identityDir, 'maintenance.json'), JSON.stringify({ schemaVersion: 1,
      lastCompletedAt: now - 3600000, lastRunAt: now - 3500000,
      lastLocalSummary: { removedTasks: [], removedTransfers: [], reclaimedResources: [], itemsConsidered: 0 } }));
    // The remote helper reports seconds (reclaim.py's clock is time.time()).
    const nowSeconds = Math.floor(now / 1000);
    const remoteStorage = { stateBytes: 10, tempBytes: 0, reservedBytes: 0, usedBytes: 10,
      limitBytes: 10 * 1024 ** 3, resourceCount: 0, reservationCount: 0,
      maintenance: { lastCompletedAt: nowSeconds, lastRunAt: nowSeconds, removedJobs: 0, itemsConsidered: 3 } };
    const files = { call: async () => ({ storage: remoteStorage }) };
    const report = await buildStorageReport(fixture.config, files, 'session-report');
    const local = report.storage.local;
    const remote = report.storage.remote;
    // The local end reports its own lastRunAt alongside lastCompletedAt.
    assert.equal(typeof local.maintenance.lastRunAt, 'number');
    assert.ok(local.maintenance.lastRunAt > 0 && local.maintenance.lastRunAt <= Date.now());
    // The remote seconds are normalized to milliseconds: same magnitude as
    // the local figures, no 1000x skew between the two ends.
    assert.equal(remote.maintenance.lastCompletedAt, nowSeconds * 1000);
    assert.equal(remote.maintenance.lastRunAt, nowSeconds * 1000);
    assert.ok(Math.abs(remote.maintenance.lastCompletedAt - local.maintenance.lastCompletedAt) < DAY,
      'both ends must report comparable millisecond timestamps');
    // Already-millisecond values (a future helper switch or a pre-normalized
    // value) pass through unchanged -- never scaled a second time.
    const milliStorage = structuredClone(remoteStorage);
    milliStorage.maintenance.lastCompletedAt = nowSeconds * 1000;
    milliStorage.maintenance.lastRunAt = nowSeconds * 1000;
    const milliReport = await buildStorageReport(fixture.config,
      { call: async () => ({ storage: milliStorage }) }, 'session-report');
    assert.equal(milliReport.storage.remote.maintenance.lastCompletedAt, nowSeconds * 1000);
    assert.equal(milliReport.storage.remote.maintenance.lastRunAt, nowSeconds * 1000);
    // Zero (never ran) stays zero instead of being inflated.
    const zeroStorage = structuredClone(remoteStorage);
    zeroStorage.maintenance.lastCompletedAt = 0;
    zeroStorage.maintenance.lastRunAt = 0;
    const zeroReport = await buildStorageReport(fixture.config,
      { call: async () => ({ storage: zeroStorage }) }, 'session-report');
    assert.equal(zeroReport.storage.remote.maintenance.lastCompletedAt, 0);
    assert.equal(zeroReport.storage.remote.maintenance.lastRunAt, 0);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

it('a failing or legacy remote end reports unknown with a bounded reason, never numbers', async () => {
  assert.ok(buildStorageReport, 'storage report service is not implemented');
  const fixture = await buildFixture();
  try {
    const long = 'e'.repeat(5000);
    const failing = { call: async () => { const error = new Error('connect failed ' + long); throw error; } };
    const report = await buildStorageReport(fixture.config, failing, 'session-report');
    const remote = report.storage.remote;
    assert.equal(remote.status, 'unknown');
    assert.equal(typeof remote.reason, 'string');
    assert.ok(remote.reason.length <= 200, 'the reason is trimmed to a bounded length');
    assert.ok(remote.reason.includes('connect failed'));
    for (const field of ['usedBytes', 'limitBytes', 'stateBytes', 'tempBytes', 'reservedBytes']) {
      assert.equal(field in remote, false, `${field} must not appear on an unknown end`);
    }
    assert.equal(typeof report.storage.local.usedBytes, 'number',
      'the local half still reports real numbers');
    assert.ok(Buffer.byteLength(JSON.stringify(report), 'utf8') <= 4096);
    // A reachable helper that predates the storage section is also unknown:
    // absence of data is never guessed into zeros.
    const legacy = { call: async () => ({ capabilities: {} }) };
    const legacyReport = await buildStorageReport(fixture.config, legacy, 'session-report');
    assert.equal(legacyReport.storage.remote.status, 'unknown');
    assert.equal('usedBytes' in legacyReport.storage.remote, false);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
