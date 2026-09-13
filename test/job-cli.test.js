import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkspaceConfig } from '../build/config/workspace.js';

const jobCli = fileURLToPath(new URL('../build/cli/job.js', import.meta.url));

function writeProfile(root) {
  writeFileSync(join(root, 'ssh.json'), JSON.stringify({ vm: { host: '127.0.0.1', port: 1, username: 'test', password: 'fixture' } }));
  const profile = join(root, 'workspace.json');
  writeFileSync(profile, JSON.stringify({ workspaceId: 'offline-registry', connectionName: 'vm',
    sshConfigFile: 'ssh.json', remoteRoot: '/work', remoteStateDir: '/tmp/agent-state', localStateDir: 'state' }));
  return profile;
}

it('lists local pending tasks without connecting to an unavailable SSH server', () => {
  const root = mkdtempSync(join(tmpdir(), 'ssh-mcp-job-cli-'));
  try {
    const profile = writeProfile(root);
    const run = spawnSync(process.execPath, [jobCli,
      'pending', '--workspace', profile, '--session', 'session-one'], { encoding: 'utf8', timeout: 3000 });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}\n${run.error ?? ''}`);
    assert.deepEqual(JSON.parse(run.stdout).tasks, []);
  } finally {
    const child = relative(tmpdir(), root);
    assert.ok(child && !isAbsolute(child) && !child.startsWith('..'));
    rmSync(root, { recursive: true, force: true });
  }
});

it('lists this session pending transfers offline and validates transfer options', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ssh-mcp-job-cli-'));
  try {
    const profile = writeProfile(root);
    const config = await loadWorkspaceConfig(profile);
    const transferId = 'a'.repeat(32);
    const directory = join(config.localStateDir,
      createHash('sha256').update(config.identity).digest('hex').slice(0, 24), 'transfers', transferId);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'record.json'), JSON.stringify({
      schemaVersion: 1, transferId, workspaceId: config.workspaceId, sessionId: 'session-one',
      direction: 'download', localPath: join(root, 'dest.bin'), remotePath: '/work/src.bin',
      totalBytes: 12345, totalSha256: 'f'.repeat(64), chunkSize: 65536,
      overwrite: false, create: false, expectedVersion: null, createdAt: '2026-09-13T00:00:00.000Z',
      state: 'transferring', confirmedOffset: 4096,
    }));
    const invoke = (...args) => spawnSync(process.execPath, [jobCli,
      ...args, '--workspace', profile, '--session', 'session-one'], { encoding: 'utf8', timeout: 5000 });
    const pending = invoke('transfer', 'pending');
    assert.equal(pending.status, 0, `${pending.stdout}\n${pending.stderr}\n${pending.error ?? ''}`);
    const listed = JSON.parse(pending.stdout).transfers;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].transferId, transferId);
    assert.equal(listed[0].state, 'transferring');
    assert.equal(listed[0].direction, 'download');
    assert.equal(listed[0].confirmedOffset, 4096);
    // Another session's registration never shows.
    const other = spawnSync(process.execPath, [jobCli, 'transfer', 'pending',
      '--workspace', profile, '--session', 'session-two'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(other.status, 0, other.stderr);
    assert.deepEqual(JSON.parse(other.stdout).transfers, []);
    // Follow-up subcommands require the durable identifier.
    for (const sub of ['wait', 'status', 'resume', 'cancel', 'ack']) {
      const missing = invoke('transfer', sub);
      assert.notEqual(missing.status, 0, sub);
      assert.match(missing.stdout + missing.stderr, /transfer-id/, sub);
    }
  } finally {
    const child = relative(tmpdir(), root);
    assert.ok(child && !isAbsolute(child) && !child.startsWith('..'));
    rmSync(root, { recursive: true, force: true });
  }
});
