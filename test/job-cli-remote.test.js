import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkspaceConfig } from '../build/config/workspace.js';

const profile = process.env.SSH_MCP_TEST_WORKSPACE;
it('runs a real remote task and preserves its pending result until explicit acknowledgement', { skip: !profile }, () => {
  const session = 'test-' + randomUUID();
  const invoke = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL('../build/cli/job.js', import.meta.url)),
    ...args, '--workspace', profile, '--session', session], { encoding: 'utf8', timeout: 45000 });
  const run = invoke('run', '--command', "printf 'CLI_OK\\n'; exit 7");
  assert.equal(run.status, 7, run.stdout + '\n' + run.stderr);
  const packets = run.stdout.split(/\r?\n/).filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  const outcome = packets.find(packet => packet.kind === 'task-result');
  assert.equal(outcome.task.exitCode, 7);
  assert.match(run.stdout, /CLI_OK/);
  const pending = invoke('pending');
  assert.equal(pending.status, 0, pending.stderr);
  assert.equal(JSON.parse(pending.stdout).tasks[0].jobId, outcome.task.jobId);
  const ack = invoke('ack', '--job-id', outcome.task.jobId);
  assert.equal(ack.status, 0, ack.stderr);
  assert.deepEqual(JSON.parse(invoke('pending').stdout).tasks, []);
});

it('a real workspace executes a registered task once and rejects legacy direct starts', { skip: !profile, timeout: 90000 }, async () => {
  const { createWorkspaceRuntime } = await import('../build/services/workspace-runtime.js');
  const session = 'test-' + randomUUID();
  const marker = '/tmp/ssh-mcp-ticket07-' + session + '.count';
  const runtime = await createWorkspaceRuntime(profile);
  const waitTerminal = async jobId => {
    const deadline = Date.now() + 30000;
    for (;;) {
      const state = await runtime.remote.call('status', { jobId });
      if (['exited', 'cancelled', 'interrupted'].includes(state.state)) return state;
      if (Date.now() > deadline) throw new Error('task did not finish: ' + JSON.stringify(state));
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
  try {
    // Idempotently activate the v2 protocol first, so this test does not depend on
    // a previously registered task having activated the workspace state.
    const active = await runtime.remote.call('handshake', { protocol: 2 });
    assert.equal(active.status, 'active');
    // The legacy bare-start entry must not create or execute tasks anymore.
    await assert.rejects(() => runtime.remote.call('start', { jobId: 'legacy-direct-' + randomUUID(),
      cwd: runtime.config.remoteRoot, command: "printf LEGACY_RAN >> " + marker }), error => {
      assert.equal(error.code, 'PROTOCOL_UPGRADE_REQUIRED');
      return true;
    });
    // Register-then-execute: the id is assigned remotely, and replaying the start
    // observes the same task instead of executing the command a second time.
    const registration = await runtime.remote.call('task_register', { protocol: 2,
      cwd: runtime.config.remoteRoot, command: "printf ONCE >> " + marker + "; cat " + marker });
    assert.ok(registration.jobId, 'registration must return the remote-assigned id');
    const first = await runtime.remote.call('task_start', { protocol: 2, jobId: registration.jobId });
    const second = await runtime.remote.call('task_start', { protocol: 2, jobId: registration.jobId });
    assert.equal(second.jobId, first.jobId);
    await waitTerminal(registration.jobId);
    const output = await runtime.remote.call('output', { jobId: registration.jobId });
    assert.equal(Buffer.from(output.stdout.data, 'base64').toString(), 'ONCE');
    // Unknown identifiers never take a creation branch on the real remote either.
    await assert.rejects(() => runtime.remote.call('task_start', { protocol: 2, jobId: 'unknown-' + randomUUID() }),
      error => { assert.equal(error.code, 'REQUEST_EXPIRED_OR_UNKNOWN'); return true; });
    // Remove the marker through the same registered-task path.
    const cleanup = await runtime.remote.call('task_register', { protocol: 2,
      cwd: runtime.config.remoteRoot, command: 'rm -f ' + marker });
    await runtime.remote.call('task_start', { protocol: 2, jobId: cleanup.jobId });
    await waitTerminal(cleanup.jobId);
  } finally { runtime.close(); }
});

/** Shared fixture for the issue #15 CLI cases: a fresh runtime, a remote
 * zero-filled source of `sizeBytes` and its digest, and a job CLI invoker. */
async function transferFixture(sizeBytes) {
  const { createWorkspaceRuntime } = await import('../build/services/workspace-runtime.js');
  const config = await loadWorkspaceConfig(profile);
  const session = 'test15-' + randomUUID();
  const runtime = await createWorkspaceRuntime(profile);
  const remoteName = 'src15-' + session + '.bin';
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
  await runTask(`python3 -c "f = open('${remoteName}', 'wb'); f.write(b'\\\\0' * ${sizeBytes}); f.close()"`);
  // The digest of a zero-filled file of this size, computed independently.
  const digest = createHash('sha256').update(Buffer.alloc(sizeBytes)).digest('hex');
  const invoke = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL('../build/cli/job.js', import.meta.url)),
    ...args, '--workspace', profile, '--session', session], { encoding: 'utf8', timeout: 120000 });
  const lastJson = run => {
    const packets = run.stdout.split(/\r?\n/).filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    assert.ok(packets.length, 'expected a JSON packet in: ' + run.stdout + run.stderr);
    return packets[packets.length - 1];
  };
  return { config, session, runtime, remoteName, digest, invoke, lastJson, runTask };
}

it('a CLI background waiter drives a real transfer to completion across process restarts (issue #15)', { skip: !profile, timeout: 240000 }, async () => {
  const size = 64 * 1024 * 1024; // 64 blocks at the default 1 MiB chunk size
  const { config, runtime, remoteName, digest, invoke, lastJson, runTask } = await transferFixture(size);
  const localPath = join(config.localRoot, 'dl15-done-' + remoteName);
  try {
    // One bounded start registers the transfer and drives within 1 s; a real
    // link moves a few MiB per second at one block per exchange, so this
    // always stops partway through 64 MiB.
    const started = invoke('transfer', 'start', '--direction', 'download', '--remote', remoteName,
      '--local', localPath, '--budget', '1000');
    assert.equal(started.status, 0, started.stdout + '\n' + started.stderr);
    const start = lastJson(started);
    assert.ok(['transfer-started', 'transfer-result'].includes(start.kind), start.kind);
    // A separate process (the ZCode background waiter) reattaches to the same
    // durable id and drives the remaining blocks to a terminal result. This is
    // exactly what a host restart recovers through: the id, not the process.
    const waited = invoke('transfer', 'wait', '--transfer-id', start.transferId);
    assert.equal(waited.status, 0, waited.stdout + '\n' + waited.stderr);
    const result = lastJson(waited);
    assert.equal(result.kind, 'transfer-result');
    assert.equal(result.state, 'completed');
    assert.equal(result.sha256, digest);
    assert.equal(result.acknowledgementRequired, true);
    // The published local file matches the remote digest, no half files stay.
    const local = await readFile(localPath);
    assert.equal(local.length, size);
    assert.equal(createHash('sha256').update(local).digest('hex'), digest);
    assert.equal((await readdir(config.localRoot)).includes('.ssh-mcp-download-' + start.transferId), false);
    // The result stays pending until the explicit CLI acknowledgement.
    const pending = invoke('transfer', 'pending');
    assert.equal(pending.status, 0, pending.stderr);
    const listed = JSON.parse(pending.stdout).transfers;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].transferId, start.transferId);
    assert.equal(listed[0].state, 'completed');
    const ack = invoke('transfer', 'ack', '--transfer-id', start.transferId);
    assert.equal(ack.status, 0, ack.stdout + ack.stderr);
    assert.equal(JSON.parse(ack.stdout).acknowledged, true);
    assert.deepEqual(JSON.parse(invoke('transfer', 'pending').stdout).transfers, []);
  } finally {
    await rm(localPath, { force: true });
    await runTask(`rm -f '${remoteName}'`).catch(() => undefined);
    runtime.close();
  }
});

it('a CLI cancel stops a real download and releases its uncommitted temp data (issue #15)', { skip: !profile, timeout: 180000 }, async () => {
  const size = 64 * 1024 * 1024;
  const { config, runtime, remoteName, invoke, lastJson, runTask } = await transferFixture(size);
  const localPath = join(config.localRoot, 'dl15-cancel-' + remoteName);
  const probePath = join(config.localRoot, 'dl15-probe-' + remoteName);
  try {
    const started = invoke('transfer', 'start', '--direction', 'download', '--remote', remoteName,
      '--local', localPath, '--budget', '1000');
    assert.equal(started.status, 0, started.stdout + '\n' + started.stderr);
    const start = lastJson(started);
    if (start.state === 'transferring') {
      // The uncommitted receive temp exists while the transfer is mid-flight.
      assert.equal((await readdir(config.localRoot)).includes('.ssh-mcp-download-' + start.transferId), true);
      const cancelled = invoke('transfer', 'cancel', '--transfer-id', start.transferId);
      assert.equal(cancelled.status, 0, cancelled.stdout + cancelled.stderr);
      const outcome = JSON.parse(cancelled.stdout);
      assert.equal(outcome.state, 'cancelled');
      // The cancel released the local uncommitted data and no formal target
      // ever appeared.
      assert.equal((await readdir(config.localRoot)).includes('.ssh-mcp-download-' + start.transferId), false,
        'the uncommitted temp must be released by the cancel');
      assert.equal((await readdir(config.localRoot)).includes('dl15-cancel-' + remoteName), false,
        'no half file may be published');
      // The remote active slot freed: a fresh registration is accepted.
      const probe = invoke('transfer', 'start', '--direction', 'download', '--remote', remoteName,
        '--local', probePath, '--budget', '1000');
      const probeOutcome = lastJson(probe);
      assert.ok(probeOutcome.transferId, 'a fresh transfer must register after the cancel freed the slot');
      // Clean the probe up through the same public path (cancel is idempotent
      // whether it stopped or completed), then consume both results.
      invoke('transfer', 'cancel', '--transfer-id', probeOutcome.transferId);
      invoke('transfer', 'ack', '--transfer-id', probeOutcome.transferId);
      // The cancelled result is still consumable through acknowledgement.
      const ack = invoke('transfer', 'ack', '--transfer-id', start.transferId);
      assert.equal(ack.status, 0, ack.stdout + ack.stderr);
      assert.equal(JSON.parse(ack.stdout).state, 'cancelled');
      assert.deepEqual(JSON.parse(invoke('transfer', 'pending').stdout).transfers, []);
    } else {
      // The 1 s budget completed everything (an unusually fast link): the
      // cancel contract still must not roll the commit back.
      assert.equal(start.state, 'completed');
      const cancelled = invoke('transfer', 'cancel', '--transfer-id', start.transferId);
      assert.equal(JSON.parse(cancelled.stdout).state, 'completed');
      assert.equal((await readFile(localPath)).length, size);
    }
  } finally {
    await rm(localPath, { force: true });
    await rm(probePath, { force: true });
    await runTask(`rm -f '${remoteName}'`).catch(() => undefined);
    runtime.close();
  }
});

// --- issue #16: expiry reclamation on a real workspace ------------------------

const waitTerminal16 = async (runtime, jobId) => {
  const deadline = Date.now() + 60000;
  for (;;) {
    const state = await runtime.remote.call('status', { jobId });
    if (['exited', 'cancelled', 'interrupted'].includes(state.state)) return state;
    if (Date.now() > deadline) throw new Error('task did not finish: ' + JSON.stringify(state));
    await new Promise(resolve => setTimeout(resolve, 150));
  }
};

it('expiry reclamation purges logs then records and refuses replayed old requests (#16)', { skip: !profile, timeout: 180000 }, async () => {
  const { createWorkspaceRuntime } = await import('../build/services/workspace-runtime.js');
  const session = 'test16-' + randomUUID();
  const marker = '/tmp/ssh-mcp-ticket16-' + session + '.count';
  const runtime = await createWorkspaceRuntime(profile);
  try {
    const active = await runtime.remote.call('handshake', { protocol: 2 });
    assert.equal(active.status, 'active');
    const registration = await runtime.remote.call('task_register', { protocol: 2,
      cwd: runtime.config.remoteRoot, command: "printf 'ONCE\\n' >> " + marker + "; cat " + marker });
    await runtime.remote.call('task_start', { protocol: 2, jobId: registration.jobId });
    const ended = await waitTerminal16(runtime, registration.jobId);
    assert.equal(ended.state, 'exited');
    await runtime.remote.call('ack', { jobId: registration.jobId });
    // Log layer first (the 3-day rule, accelerated to zero): the acknowledged
    // logs go, the deduplication record stays and still answers.
    const logRound = await runtime.remote.call('maintenance', {
      retentionMs: { confirmedTaskLogMs: 0, confirmedResultMs: 30 * 86400000 } });
    assert.ok(logRound.purgedLogs.includes(registration.jobId), JSON.stringify(logRound));
    const observed = await runtime.remote.call('status', { jobId: registration.jobId });
    assert.equal(observed.state, 'exited');
    await assert.rejects(() => runtime.remote.call('output', { jobId: registration.jobId }),
      error => { assert.equal(error.code, 'LOGS_PURGED'); return true; });
    // Record layer (the 30-day rule, accelerated to zero): the record goes.
    const recordRound = await runtime.remote.call('maintenance', {
      retentionMs: { confirmedTaskLogMs: 0, confirmedResultMs: 0 } });
    assert.ok(recordRound.removedJobs.includes(registration.jobId), JSON.stringify(recordRound));
    await assert.rejects(() => runtime.remote.call('status', { jobId: registration.jobId }),
      error => { assert.equal(error.code, 'JOB_NOT_FOUND'); return true; });
    // The replayed old request is refused, never rerun: the marker accumulated
    // exactly one line.
    await assert.rejects(() => runtime.remote.call('task_start', { protocol: 2, jobId: registration.jobId }),
      error => { assert.equal(error.code, 'REQUEST_EXPIRED_OR_UNKNOWN'); return true; });
    const check = await runtime.remote.call('task_register', { protocol: 2,
      cwd: runtime.config.remoteRoot, command: 'wc -l < ' + marker });
    await runtime.remote.call('task_start', { protocol: 2, jobId: check.jobId });
    const counted = await waitTerminal16(runtime, check.jobId);
    assert.equal(counted.exitCode, 0, JSON.stringify(counted));
    const output = await runtime.remote.call('output', { jobId: check.jobId });
    assert.equal(Buffer.from(output.stdout.data, 'base64').toString().trim(), '1');
    const cleanup = await runtime.remote.call('task_register', { protocol: 2,
      cwd: runtime.config.remoteRoot, command: 'rm -f ' + marker });
    await runtime.remote.call('task_start', { protocol: 2, jobId: cleanup.jobId });
    await waitTerminal16(runtime, cleanup.jobId);
  } finally { runtime.close(); }
});

it('an interrupted transfer expires after its TTL and its identifier is refused afterwards (#16)', { skip: !profile, timeout: 180000 }, async () => {
  const { createWorkspaceRuntime } = await import('../build/services/workspace-runtime.js');
  const config = await loadWorkspaceConfig(profile);
  const session = 'test16-' + randomUUID();
  const runtime = await createWorkspaceRuntime(profile);
  const target = 'expired16-' + session + '.bin';
  try {
    const registered = await runtime.remote.call('transfer_register', { protocol: 2,
      direction: 'upload', targetPath: target, chunkSize: 65536, totalBytes: 4096,
      totalSha256: createHash('sha256').update(Buffer.alloc(4096)).digest('hex'),
      sourceIdentity: { size: 4096, mtimeMs: 1 }, overwrite: false, create: false,
      sessionId: session, workspaceRoot: config.remoteRoot });
    const started = await runtime.remote.call('transfer_start', { protocol: 2,
      transferId: registered.transferId, sourceIdentity: { size: 4096, mtimeMs: 1 }, sessionId: session });
    assert.equal(started.state, 'transferring');
    // Status observes without renewing anything (queries are not progress).
    const observed = await runtime.remote.call('transfer_status', { transferId: registered.transferId, sessionId: session });
    assert.equal(observed.expiresAt, started.expiresAt);
    // Accelerated expiry: zero retention after the (zero) real progress
    // reclaims the interrupted data and its record.
    const round = await runtime.remote.call('maintenance', { retentionMs: { interruptedTransferDataMs: 0 } });
    assert.ok(round.removedTransfers.includes(registered.transferId), JSON.stringify(round));
    await assert.rejects(() => runtime.remote.call('transfer_resume', { protocol: 2,
      transferId: registered.transferId, sourceIdentity: { size: 4096, mtimeMs: 1 }, sessionId: session }),
      error => { assert.equal(error.code, 'REQUEST_EXPIRED_OR_UNKNOWN'); return true; });
    await assert.rejects(() => runtime.remote.call('transfer_status', { transferId: registered.transferId, sessionId: session }),
      error => { assert.equal(error.code, 'REQUEST_EXPIRED_OR_UNKNOWN'); return true; });
  } finally { runtime.close(); }
});

it('the CLI maintain entry runs a real both-ends round and the persisted timestamp throttles it (#16)', { skip: !profile, timeout: 180000 }, async () => {
  const config = await loadWorkspaceConfig(profile);
  const identityDir = join(config.localStateDir,
    createHash('sha256').update(config.identity).digest('hex').slice(0, 24));
  const invoke = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL('../build/cli/job.js', import.meta.url)),
    ...args, '--workspace', profile, '--session', 'maintain-16'], { encoding: 'utf8', timeout: 120000 });
  // Simulate the offline catch-up: the last completed round lies two hours
  // behind, so the first trigger after reconnecting must run a real round.
  await mkdir(identityDir, { recursive: true });
  await writeFile(join(identityDir, 'maintenance.json'),
    JSON.stringify({ schemaVersion: 1, lastCompletedAt: Date.now() - 2 * 3600000 }));
  const first = invoke('maintain');
  assert.equal(first.status, 0, first.stdout + '\n' + first.stderr);
  const outcome = JSON.parse(first.stdout);
  assert.equal(outcome.skipped, undefined, JSON.stringify(outcome));
  assert.ok(outcome.local, 'a local summary must be reported');
  assert.ok(outcome.lastCompletedAt > Date.now() - 3600000, JSON.stringify(outcome));
  const state = JSON.parse(await readFile(join(identityDir, 'maintenance.json'), 'utf8'));
  assert.ok(state.lastCompletedAt > 0);
  // Within the interval the next trigger is throttled away.
  const second = invoke('maintain');
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.equal(JSON.parse(second.stdout).skipped, 'interval');
});
