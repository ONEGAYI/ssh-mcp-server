import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkspaceConfig } from '../build/config/workspace.js';
import { TaskService } from '../build/services/task-service.js';

it('injects only the current session pending tasks and ignores unrelated local workspaces', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-hook-'));
  try {
    await writeFile(join(root, 'ssh.json'), JSON.stringify({ vm: { host: '127.0.0.1', port: 1, username: 'test', password: 'fixture' } }));
    const profile = join(root, 'workspace.json');
    await writeFile(profile, JSON.stringify({ workspaceId: 'hook', connectionName: 'vm', sshConfigFile: 'ssh.json',
      remoteRoot: '/work', remoteStateDir: '/tmp/state', localStateDir: 'state' }));
    const config = await loadWorkspaceConfig(profile);
    let assigned = 0;
    const tasks = new TaskService({ async call(action, data) {
      if (action === 'task_register') return { jobId: 'job-hook-' + (++assigned), state: 'prepared' };
      return { jobId: data.jobId, state: 'running' };
    } }, config.localStateDir, config.identity);
    const own = await tasks.start({ sessionId: 'session-own', command: 'own-build', cwd: '/work' });
    const other = await tasks.start({ sessionId: 'session-other', command: 'other-private-command', cwd: '/work' });
    const invoke = cwd => spawnSync(process.execPath, [fileURLToPath(new URL('../build/cli/recovery.js', import.meta.url)), '--workspace', profile], {
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'session-own', cwd }), encoding: 'utf8', timeout: 3000,
    });
    const run = invoke(root);
    assert.equal(run.status, 0, run.stdout + '\n' + run.stderr);
    const context = JSON.parse(run.stdout).hookSpecificOutput.additionalContext;
    assert.ok(context.includes(own.jobId));
    assert.ok(!context.includes(other.jobId));
    assert.ok(!context.includes('other-private-command'));
    assert.deepEqual(JSON.parse(invoke(tmpdir()).stdout), {});
  } finally {
    const child = relative(tmpdir(), root);
    assert.ok(child && !isAbsolute(child) && !child.startsWith('..'));
    await rm(root, { recursive: true, force: true });
  }
});
