import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('exchanges structured helper requests over stdin and surfaces remote errors', async () => {
  let Client;
  try { ({ RemoteAgentClient: Client } = await import('../build/services/remote-agent-client.js')); }
  catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
  assert.equal(typeof Client, 'function', 'The remote helper client is not implemented');
  const directory = await mkdtemp(join(tmpdir(), 'ssh-mcp-client-'));
  try {
    const source = join(directory, 'agent.py');
    await writeFile(source, '# fixture helper\n');
    const requests = [];
    const transport = { async executeInputCommand(command, input) {
      requests.push({ command, input });
      if (command.includes(' -c ')) return { stdout: 'installed\n', stderr: '', exitCode: 0 };
      const request = JSON.parse(input.toString('utf8'));
      const response = request.jobId === 'missing'
        ? { ok: false, error: { code: 'JOB_NOT_FOUND', message: 'Task not found' } }
        : { ok: true, result: { jobId: request.jobId, state: 'running' } };
      return { stdout: 'SSH_MCP_V1 ' + Buffer.from(JSON.stringify(response)).toString('base64') + '\n', stderr: '', exitCode: 0 };
    } };
    const client = new Client(transport, { remoteStateDir: '/tmp/space and quote\' root', pythonPath: '/usr/bin/python3', helperSourcePath: source });
    assert.deepEqual(await client.call('status', { jobId: 'job-one' }), { jobId: 'job-one', state: 'running' });
    assert.ok(requests[0].input.toString().startsWith('{'), 'Helper installation must carry a complete module image');
    assert.equal(Buffer.from(JSON.parse(requests[0].input.toString()).files['agent.py'], 'base64').toString(), '# fixture helper\n');
    assert.equal(JSON.parse(requests[1].input.toString()).jobId, 'job-one');
    assert.ok(!requests[1].command.includes('job-one'), 'Request content belongs in stdin, not the shell');
    await assert.rejects(client.call('status', { jobId: 'missing' }), error => error.code === 'JOB_NOT_FOUND');
    assert.equal(requests.filter(request => request.command.includes(' -c ')).length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
