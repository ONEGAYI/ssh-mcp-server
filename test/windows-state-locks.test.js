import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, toNamespacedPath } from 'node:path';

const windows = process.platform === 'win32';
const maintenanceURL = new URL('../build/services/maintenance.js', import.meta.url).href;
const ledgerURL = new URL('../build/services/space-ledger.js', import.meta.url).href;

function startWorker(script, input) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(input)], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const closed = once(child, 'close');
  return {
    child,
    first: Promise.race([
      once(child, 'message').then(([message]) => message),
      closed.then(([code, signal]) => { throw new Error(`fixture exited before replying: ${code ?? signal}`); }),
    ]),
    closed,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
    },
  };
}

const maintenanceWorker = `
import { MaintenanceService } from ${JSON.stringify(maintenanceURL)};
const { config, hold, offset } = JSON.parse(process.argv[1]);
const now = Date.now.bind(Date);
Date.now = () => now() + offset;
const remote = { async call() {
  if (hold) {
    process.send('held');
    await new Promise(resolve => process.once('message', resolve));
  }
  return { completed: true };
} };
try {
  const outcome = await new MaintenanceService(config, remote).maybeMaintain();
  process.send(outcome.skipped ?? 'completed');
} finally { process.disconnect(); }
`;

const ledgerWorker = `
import { SpaceLedger } from ${JSON.stringify(ledgerURL)};
const { directory, hold } = JSON.parse(process.argv[1]);
const ledger = new SpaceLedger(directory, async () => {
  if (hold) {
    process.send('held');
    await new Promise(resolve => process.once('message', resolve));
  }
  return 10;
});
try {
  const result = await ledger.reserve(6, 'worker');
  process.send({ id: result.reservationId });
} catch (error) { process.send({ code: error.code }); }
finally { process.disconnect(); }
`;

it('Windows maintenance excludes aliases and elects one holder after a crash even with an old reused PID', {
  skip: !windows, timeout: 10000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-win-maint-lock-'));
  const localStateDir = join(root, 'state');
  const identity = 'win-maint-lock';
  const identityDir = join(localStateDir, createHash('sha256').update(identity).digest('hex').slice(0, 24));
  const profilePath = join(root, 'profile.json');
  const config = { localStateDir, identity, profilePath };
  const workers = [];
  try {
    await mkdir(identityDir, { recursive: true });
    await writeFile(profilePath, '{}');
    const alias = join(root, 'state-alias');
    await symlink(localStateDir, alias, 'junction');
    const aliased = { ...config, localStateDir: toNamespacedPath(alias.toUpperCase()) };
    const holder = startWorker(maintenanceWorker, { config, hold: true, offset: 0 });
    workers.push(holder);
    assert.equal(await holder.first, 'held');
    // The first worker has stamped both schedules. Advance the contender's
    // clock so it must reach lock admission rather than the interval check.
    const offset = 2 * 3600000;
    const waiter = startWorker(maintenanceWorker, { config: aliased, hold: false, offset });
    workers.push(waiter);
    assert.equal(await waiter.first, 'busy');
    await holder.stop(); // hard exit: the holder cannot run its finally

    const legacyFile = join(identityDir, 'maintenance.lock');
    const legacy = JSON.stringify({ pid: process.pid, acquiredAt: Date.now() - offset });
    await writeFile(legacyFile, legacy);
    const first = startWorker(maintenanceWorker, { config, hold: true, offset });
    const second = startWorker(maintenanceWorker, { config: aliased, hold: true, offset });
    workers.push(first, second);
    const replies = await Promise.all([first.first, second.first]);
    assert.deepEqual(replies.slice().sort(), ['busy', 'held']);
    const winner = replies[0] === 'held' ? first : second;
    winner.child.send('finish');
    assert.equal((await winner.closed)[0], 0);
    assert.equal(await readFile(legacyFile, 'utf8'), legacy);
  } finally {
    await Promise.all(workers.map(worker => worker.stop()));
    await rm(root, { recursive: true });
  }
});

it('Windows distinct NTFS directory identities do not contend even when their names fold alike', {
  skip: !windows, timeout: 10000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-win-lock-identities-'));
  const profilePath = join(root, 'profile.json');
  const workers = [];
  try {
    await writeFile(profilePath, '{}');
    // JavaScript lowercases both names to the same string. NTFS does not
    // treat the composed U+0130 and the U+0069 U+0307 pair as one entry.
    const first = join(root, '\u0130');
    const second = join(root, 'i\u0307');
    await mkdir(first);
    await mkdir(second);
    for (const localStateDir of [first, second]) {
      const config = { localStateDir, identity: 'shared-binding', profilePath };
      const worker = startWorker(maintenanceWorker, { config, hold: true, offset: 0 });
      workers.push(worker);
      assert.equal(await worker.first, 'held');
    }
    for (const worker of workers) worker.child.send('finish');
    assert.deepEqual((await Promise.all(workers.map(worker => worker.closed))).map(([code]) => code), [0, 0]);
  } finally {
    await Promise.all(workers.map(worker => worker.stop()));
    await rm(root, { recursive: true });
  }
});

it('Windows ledger still returns LEDGER_BUSY, then accepts exactly one reservation after owner death', {
  skip: !windows, timeout: 20000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-win-ledger-lock-'));
  const directory = join(root, 'ledger');
  const workers = [];
  try {
    const holder = startWorker(ledgerWorker, { directory, hold: true });
    workers.push(holder);
    assert.equal(await holder.first, 'held');
    const waiter = startWorker(ledgerWorker, { directory: directory.toUpperCase(), hold: false });
    workers.push(waiter);
    assert.deepEqual(await waiter.first, { code: 'LEDGER_BUSY' });
    await holder.stop();

    const legacyFile = join(directory, 'ledger.lock');
    const legacy = JSON.stringify({ pid: process.pid, acquiredAt: Date.now() - 3600000 });
    await writeFile(legacyFile, legacy);
    const first = startWorker(ledgerWorker, { directory, hold: false });
    const second = startWorker(ledgerWorker, { directory: directory.toUpperCase(), hold: false });
    workers.push(first, second);
    const replies = await Promise.all([first.first, second.first]);
    assert.equal(replies.filter(reply => reply.id).length, 1, JSON.stringify(replies));
    assert.equal(replies.find(reply => !reply.id)?.code, 'WORKSPACE_QUOTA_EXCEEDED');
    assert.equal(await readFile(legacyFile, 'utf8'), legacy);
    const state = JSON.parse(await readFile(join(directory, 'ledger.json'), 'utf8'));
    const [reservation] = Object.values(state.reservations);
    assert.equal(reservation.bytes, 6);
    assert.equal(Object.keys(state.reservations).length, 1);
  } finally {
    await Promise.all(workers.map(worker => worker.stop()));
    await rm(root, { recursive: true });
  }
});
