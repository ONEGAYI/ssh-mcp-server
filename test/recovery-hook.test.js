import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

it('lists the session pending transfers with a reattach template and no network', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-hook-transfer-'));
  try {
    await writeFile(join(root, 'ssh.json'), JSON.stringify({ vm: { host: '127.0.0.1', port: 1, username: 'test', password: 'fixture' } }));
    const profile = join(root, 'workspace.json');
    await writeFile(profile, JSON.stringify({ workspaceId: 'hook-transfer', connectionName: 'vm', sshConfigFile: 'ssh.json',
      remoteRoot: '/work', remoteStateDir: '/tmp/state', localStateDir: 'state' }));
    const config = await loadWorkspaceConfig(profile);
    const writeTransferRecord = async (transferId, sessionId, state) => {
      const directory = join(config.localStateDir,
        createHash('sha256').update(config.identity).digest('hex').slice(0, 24), 'transfers', transferId);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'record.json'), JSON.stringify({
        schemaVersion: 1, transferId, workspaceId: config.workspaceId, sessionId,
        direction: 'download', localPath: join(root, 'dest.bin'), remotePath: '/work/src.bin',
        totalBytes: 4096, totalSha256: 'f'.repeat(64), chunkSize: 65536,
        overwrite: false, create: false, expectedVersion: null, createdAt: '2026-09-13T00:00:00.000Z',
        state, confirmedOffset: 1024,
      }));
    };
    await writeTransferRecord('b'.repeat(32), 'session-own', 'transferring');
    await writeTransferRecord('c'.repeat(32), 'session-other', 'transferring');
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('../build/cli/recovery.js', import.meta.url)), '--workspace', profile], {
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'session-own', cwd: root }), encoding: 'utf8', timeout: 3000,
    });
    assert.equal(run.status, 0, run.stdout + '\n' + run.stderr);
    const context = JSON.parse(run.stdout).hookSpecificOutput.additionalContext;
    assert.ok(context.includes('b'.repeat(32)), 'own transfer must be listed');
    assert.ok(context.includes('"transfer","wait"'), 'the reattach argv template must appear');
    assert.ok(!context.includes('c'.repeat(32)), "another session's transfer must stay hidden");
    assert.ok(/未完成|传输/.test(context), 'transfer guidance must be present');
  } finally {
    const child = relative(tmpdir(), root);
    assert.ok(child && !isAbsolute(child) && !child.startsWith('..'));
    await rm(root, { recursive: true, force: true });
  }
});
