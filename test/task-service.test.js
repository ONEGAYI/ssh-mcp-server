import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { TaskService } from '../build/services/task-service.js';
import { RemoteAgentError } from '../build/services/remote-agent-client.js';

it('a new local service restores a task without restarting it and keeps the result pending until acknowledged', async () => {
  let Service;
  try { ({ TaskService: Service } = await import('../build/services/task-service.js')); }
  catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
  assert.equal(typeof Service, 'function', 'Task service is not implemented');
  const directory = await mkdtemp(join(tmpdir(), 'ssh-mcp-tasks-'));
  let starts = 0, jobId;
  const remote = { async call(action, request) {
    if (action === 'start') { starts++; jobId = request.jobId; return { jobId, state: 'running' }; }
    if (action === 'status') return { jobId, state: 'exited', exitCode: 7, completedAt: 100 };
    if (action === 'ack') return { acknowledged: true, jobId };
    if (action === 'output') return { jobId, state: 'exited', terminal: true,
      stdout: { data: Buffer.from('result').toString('base64'), nextOffset: 6, hasMore: false },
      stderr: { data: '', nextOffset: 0, hasMore: false } };
    throw new Error('Unexpected action');
  } };
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
    assert.equal(starts, 1);
    assert.equal((await restored.pending('session-one')).length, 1);
    await restored.acknowledge(created.jobId, 'session-one');
    assert.deepEqual(await new Service(remote, directory, 'workspace-one').pending('session-one'), []);
  } finally {
    const child = relative(tmpdir(), directory);
    assert.ok(child && !isAbsolute(child) && !child.startsWith('..'));
    await rm(directory, { recursive: true, force: true });
  }
});

it('reconciles a lost startup receipt using the original id and surfaces unknown worker state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ssh-mcp-reconcile-'));
  const ids = [];
  let first = true;
  const remote = { async call(action, request) {
    if (action === 'start') {
      ids.push(request.jobId);
      if (first) { first = false; throw Object.assign(new Error('receipt lost'), { retriable: true }); }
      return { jobId: request.jobId, state: 'running' };
    }
    if (action === 'output') return { jobId: request.jobId, state: 'unknown', terminal: false,
      stdout: { data: '', nextOffset: 0, hasMore: false }, stderr: { data: '', nextOffset: 0, hasMore: false } };
    if (action === 'status') return { jobId: request.jobId, state: 'unknown', reason: 'WORKER_UNAVAILABLE' };
    throw new Error(action);
  } };
  try {
    const service = new TaskService(remote, directory, 'binding');
    await assert.rejects(service.start({ sessionId: 'owner', command: 'side-effect', cwd: '/work' }), { code: 'START_UNCONFIRMED' });
    const restored = new TaskService(remote, directory, 'binding');
    const [task] = await restored.pending('owner');
    const result = await restored.wait(task.jobId, { waitTimeoutMs: 100 });
    assert.equal(ids.length, 2);
    assert.equal(ids[0], ids[1]);
    assert.equal(result.task.reason, 'WORKER_UNAVAILABLE');
    assert.equal(result.timedOut, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('wait timeout bounds observation even when a remote query remains pending', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ssh-mcp-wait-'));
  const remote = { async call(action, request) {
    if (action === 'start') return { jobId: request.jobId, state: 'running' };
    return new Promise(resolve => setTimeout(() => resolve({ jobId: request.jobId, state: 'running' }), 500));
  } };
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
  const remote = { async call(action, request) {
    if (action === 'start') throw new RemoteAgentError('INVALID_CWD', 'Missing cwd');
    throw new Error('A rejected task must not query remote ' + action);
  } };
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
