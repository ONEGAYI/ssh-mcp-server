import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { TaskService } from '../build/services/task-service.js';
import { RemoteAgentError } from '../build/services/remote-agent-client.js';

/** Fake remote implementing the register-then-execute protocol for local-service tests. */
function fakeRemote(handlers = {}) {
  const calls = [];
  let sequence = 0;
  const remote = {
    calls,
    async call(action, request) {
      calls.push([action, request]);
      if (handlers[action]) return handlers[action](request, sequence++);
      if (action === 'task_register') return { jobId: 'job-' + (++sequence), state: 'prepared' };
      if (action === 'task_start') return { jobId: request.jobId, state: 'running' };
      if (action === 'status') return { jobId: request.jobId, state: 'exited', exitCode: 7, completedAt: 100 };
      if (action === 'ack') return { acknowledged: true, jobId: request.jobId };
      if (action === 'output') return { jobId: request.jobId, state: 'exited', terminal: true,
        stdout: { data: Buffer.from('result').toString('base64'), nextOffset: 6, hasMore: false },
        stderr: { data: '', nextOffset: 0, hasMore: false } };
      throw new Error('Unexpected action ' + action);
    },
  };
  return remote;
}

it('a new local service restores a task without restarting it and keeps the result pending until acknowledged', async () => {
  let Service;
  try { ({ TaskService: Service } = await import('../build/services/task-service.js')); }
  catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
  assert.equal(typeof Service, 'function', 'Task service is not implemented');
  const directory = await mkdtemp(join(tmpdir(), 'ssh-mcp-tasks-'));
  const remote = fakeRemote();
  try {
    const first = new Service(remote, directory, 'workspace-one');
    const created = await first.start({ sessionId: 'session-one', cwd: '/work', command: 'build' });
    const restored = new Service(remote, directory, 'workspace-one');
    assert.equal((await restored.pending('session-one'))[0].jobId, created.jobId);
    assert.deepEqual(await restored.pending('different-session'), []);
    const chunks = [];
    const result = await restored.wait(created.jobId, { onOutput: (stream, data) => chunks.push([stream, data.toString()]) });
    assert.equal(result.task.exitCode, 7);
    assert.deepEqual(chunks, [['stdout', 'result']]);
    assert.equal(remote.calls.filter(([action]) => action === 'task_register').length, 1);
    assert.equal(remote.calls.filter(([action]) => action === 'task_start').length, 1);
    assert.equal((await restored.pending('session-one')).length, 1);
    await restored.acknowledge(created.jobId, 'session-one');
    assert.deepEqual(await new Service(remote, directory, 'workspace-one').pending('session-one'), []);
  } finally {
    const child = relative(tmpdir(), directory);
    assert.ok(child && !isAbsolute(child) && !child.startsWith('..'));
    await rm(directory, { recursive: true, force: true });
  }
});

it('registration precedes execution and the local record carries the remote-assigned id', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ssh-mcp-register-'));
  let assigned = 'job-remote-1';
  let recordAtStart;
  const remote = fakeRemote({
    task_register: () => ({ jobId: assigned, state: 'prepared', registeredAt: 1 }),
    task_start: async request => {
      recordAtStart = await readFile(join(directory, createHash('sha256').update('binding').digest('hex').slice(0, 24), 'tasks', request.jobId, 'record.json'), 'utf8');
      return { jobId: request.jobId, state: 'running' };
    },
  });
  try {
    const service = new TaskService(remote, directory, 'binding');
    const record = await service.start({ sessionId: 'owner', command: 'side-effect', cwd: '/work' });
    assert.equal(record.jobId, assigned);
    const stored = JSON.parse(recordAtStart);
    assert.equal(stored.jobId, assigned);
    assert.equal(stored.protocol, 2);
    const [, registerRequest] = remote.calls.find(([action]) => action === 'task_register');
    assert.equal(registerRequest.protocol, 2);
    assert.ok(!registerRequest.jobId, 'registration must not accept a caller-chosen id');
    const [startAction, startRequest] = remote.calls.find(([action]) => action === 'task_start');
    assert.equal(startAction, 'task_start');
    assert.deepEqual(Object.keys(startRequest).sort(), ['jobId', 'protocol']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('a lost registration response leaves no local record and no retry anchor', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ssh-mcp-lost-register-'));
  const remote = fakeRemote({
    task_register: () => { throw Object.assign(new Error('register response lost'), { retriable: true }); },
  });
  try {
    const service = new TaskService(remote, directory, 'binding');
    await assert.rejects(service.start({ sessionId: 'owner', command: 'build', cwd: '/work' }),
      /register response lost/);
    assert.deepEqual(await service.pending('owner'), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('a registration-time rejection is surfaced without creating a pending task', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ssh-mcp-register-reject-'));
  const remote = fakeRemote({
    task_register: () => { throw new RemoteAgentError('INVALID_COMMAND', 'Command must be nonempty text without NUL'); },
  });
  try {
    const service = new TaskService(remote, directory, 'binding');
    await assert.rejects(service.start({ sessionId: 'owner', command: '', cwd: '/work' }), { code: 'INVALID_COMMAND' });
    assert.deepEqual(await service.pending('owner'), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('reconciles a lost startup receipt using the original id and surfaces unknown worker state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ssh-mcp-reconcile-'));
  const starts = [];
  let first = true;
  const remote = fakeRemote({
    task_register: request => ({ jobId: 'job-retry', state: 'prepared' }),
    task_start: request => {
      starts.push(request.jobId);
      if (first) { first = false; throw Object.assign(new Error('receipt lost'), { retriable: true }); }
      return { jobId: request.jobId, state: 'running' };
    },
    output: request => ({ jobId: request.jobId, state: 'unknown', terminal: false,
      stdout: { data: '', nextOffset: 0, hasMore: false }, stderr: { data: '', nextOffset: 0, hasMore: false } }),
    status: request => ({ jobId: request.jobId, state: 'unknown', reason: 'WORKER_UNAVAILABLE' }),
  });
  try {
    const service = new TaskService(remote, directory, 'binding');
    await assert.rejects(service.start({ sessionId: 'owner', command: 'side-effect', cwd: '/work' }), { code: 'START_UNCONFIRMED' });
    const restored = new TaskService(remote, directory, 'binding');
    const [task] = await restored.pending('owner');
    const result = await restored.wait(task.jobId, { waitTimeoutMs: 100 });
    assert.equal(remote.calls.filter(([action]) => action === 'task_register').length, 1);
    assert.equal(starts.length, 2);
    assert.equal(starts[0], starts[1]);
    assert.equal(result.task.reason, 'WORKER_UNAVAILABLE');
    assert.equal(result.timedOut, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('a remotely deleted task record is rejected instead of restarted, and stays acknowledgeable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ssh-mcp-expired-'));
  const remote = fakeRemote({
    task_register: () => ({ jobId: 'job-expired', state: 'prepared' }),
    task_start: () => { throw new RemoteAgentError('REQUEST_EXPIRED_OR_UNKNOWN', 'No registration for this task identifier'); },
    status: () => { throw new RemoteAgentError('REQUEST_EXPIRED_OR_UNKNOWN', 'Task record not found'); },
  });
  try {
    const service = new TaskService(remote, directory, 'binding');
    await assert.rejects(service.start({ sessionId: 'owner', command: 'side-effect', cwd: '/work' }), { code: 'START_REJECTED' });
    const restored = new TaskService(remote, directory, 'binding');
    const [task] = await restored.pending('owner');
    assert.equal(task.jobId, 'job-expired');
    const result = await restored.wait(task.jobId);
    assert.equal(result.task.reason, 'START_REJECTED');
    await restored.acknowledge(task.jobId, 'owner');
    assert.deepEqual(await restored.pending('owner'), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('legacy records without a protocol marker keep reconciling through the legacy replay entry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ssh-mcp-legacy-record-'));
  const legacy = { schemaVersion: 1, jobId: 'job-legacy-1', workspaceId: 'binding',
    sessionId: 'owner', command: 'legacy-command', cwd: '/work', createdAt: '2026-09-01T00:00:00.000Z' };
  const seen = [];
  const remote = fakeRemote({
    start: request => { seen.push(request); return { jobId: request.jobId, state: 'running' }; },
    output: request => ({ jobId: request.jobId, state: 'exited', terminal: true,
      stdout: { data: '', nextOffset: 0, hasMore: false }, stderr: { data: '', nextOffset: 0, hasMore: false } }),
    status: () => ({ jobId: 'job-legacy-1', state: 'exited', exitCode: 0, completedAt: 5 }),
  });
  try {
    const tasksHome = join(directory, createHash('sha256').update('binding').digest('hex').slice(0, 24), 'tasks', legacy.jobId);
    await mkdir(tasksHome, { recursive: true });
    await writeFile(join(tasksHome, 'record.json'), JSON.stringify(legacy));
    const service = new TaskService(remote, directory, 'binding');
    await service.wait(legacy.jobId);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].command, 'legacy-command');
    assert.ok(!('protocol' in seen[0]), 'legacy replay must keep using the legacy entry shape');
    assert.equal(remote.calls.filter(([action]) => action === 'task_start').length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('wait timeout bounds observation even when a remote query remains pending', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ssh-mcp-wait-'));
  const remote = fakeRemote({
    output: () => new Promise(resolve => setTimeout(() => resolve({ jobId: 'job-1', state: 'running',
      stdout: { data: '', nextOffset: 0, hasMore: false }, stderr: { data: '', nextOffset: 0, hasMore: false } }), 500)),
  });
  try {
    const service = new TaskService(remote, directory, 'binding');
    const task = await service.start({ sessionId: 'owner', command: 'sleep', cwd: '/work' });
    const before = Date.now();
    const result = await service.wait(task.jobId, { waitTimeoutMs: 30 });
    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - before < 350);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('one interrupted registration cannot hide valid tasks and definite startup rejection can be acknowledged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ssh-mcp-registry-'));
  const remote = fakeRemote({
    task_start: () => { throw new RemoteAgentError('INVALID_CWD', 'Working directory must exist when starting a new task'); },
  });
  try {
    const service = new TaskService(remote, directory, 'binding');
    await assert.rejects(service.start({ sessionId: 'owner', command: 'build', cwd: '/missing' }), { code: 'START_REJECTED' });
    await mkdir(join(directory, createHash('sha256').update('binding').digest('hex').slice(0, 24), 'tasks', 'interrupted-before-record'));
    const [task] = await service.pending('owner');
    assert.ok(task.jobId);
    assert.equal(service.registryIssues.length, 1);
    const result = await service.wait(task.jobId);
    assert.equal(result.task.reason, 'START_REJECTED');
    await service.acknowledge(task.jobId, 'owner');
    assert.deepEqual(await service.pending('owner'), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('the drain gate rejection is surfaced without a local record', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ssh-mcp-drain-'));
  const remote = fakeRemote({
    task_register: () => { throw new RemoteAgentError('LEGACY_TASKS_PENDING', 'Legacy tasks still running: job-old'); },
  });
  try {
    const service = new TaskService(remote, directory, 'binding');
    await assert.rejects(service.start({ sessionId: 'owner', command: 'build', cwd: '/work' }), { code: 'LEGACY_TASKS_PENDING' });
    assert.deepEqual(await service.pending('owner'), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('pendingAcross lists unacknowledged work from every session for removal checks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ssh-mcp-tasks-across-'));
  const remote = fakeRemote();
  try {
    const service = new TaskService(remote, directory, 'workspace-one');
    const mine = await service.start({ sessionId: 'session-one', cwd: '/work', command: 'build' });
    const theirs = await service.start({ sessionId: 'session-two', cwd: '/work', command: 'test' });
    assert.deepEqual((await service.pending('session-two')).map(record => record.jobId), [theirs.jobId]);
    const across = await service.pendingAcross();
    assert.deepEqual(across.map(record => record.jobId).sort(), [mine.jobId, theirs.jobId].sort(),
      'removal checks see every session, not just the current one');
    await service.acknowledge(mine.jobId, 'session-one');
    assert.deepEqual((await service.pendingAcross()).map(record => record.jobId), [theirs.jobId]);
    await service.acknowledge(theirs.jobId, 'session-two');
    assert.deepEqual(await service.pendingAcross(), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('terminal status carries a stable eventId bound to the completion identity', async () => {
  // contracts.md completion hand-off: results carry one stable event id and
  // consumers deduplicate by it. Pin the generating factors (workspaceId /
  // jobId / state / completedAt) and the terminal stability, so a unit or
  // serialization-order change cannot turn one completion into two events.
  const directory = await mkdtemp(join(tmpdir(), 'ssh-mcp-event-'));
  const remote = fakeRemote();
  try {
    const service = new TaskService(remote, directory, 'binding');
    const created = await service.start({ sessionId: 'session-one', cwd: '/work', command: 'build' });
    const first = await service.status(created.jobId);
    const second = await service.status(created.jobId);
    assert.equal(first.eventId, second.eventId, 'the same terminal task must yield one event id');
    assert.match(first.eventId, /^[a-f0-9]{64}$/);
    assert.equal(first.eventId, createHash('sha256')
      .update(JSON.stringify(['binding', created.jobId, 'exited', 100])).digest('hex'));
    await service.acknowledge(created.jobId, 'session-one');
    const completion = JSON.parse(await readFile(
      join(directory, createHash('sha256').update('binding').digest('hex').slice(0, 24),
        'tasks', created.jobId, 'completion.json'), 'utf8'));
    assert.equal(completion.eventId, first.eventId);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
