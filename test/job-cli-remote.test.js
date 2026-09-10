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
