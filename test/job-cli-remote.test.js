import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

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
    assert.equal(Buffer.from(output.stdout.data, 'base64').toString(), 'ONCE\n');
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
