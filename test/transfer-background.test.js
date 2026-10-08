import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadWorkspaceConfig, identityStateDirectory } from '../build/config/workspace.js';

const entry = fileURLToPath(new URL('../build/index.js', import.meta.url));
const cli = fileURLToPath(new URL('../build/cli/job.js', import.meta.url));
const preload = new URL('./fixtures/background-transport.mjs', import.meta.url).href;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(lostRegister = false, lostVerify = false, initFailure = false, lostStart = false) {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-background-'));
  const profile = join(root, 'workspace.json');
  const sessionId = 'background-session';
  await writeFile(join(root, 'ssh.json'), JSON.stringify({ fake: { host: '127.0.0.1', port: 1, username: 'fixture', password: 'fixture-only' } }));
  await writeFile(profile, JSON.stringify({ workspaceId: 'background-test', connectionName: 'fake', sshConfigFile: './ssh.json', remoteRoot: '/work', remoteStateDir: '/state', localStateDir: './state' }));
  const config = await loadWorkspaceConfig(profile);
  const records = join(identityStateDirectory(config.localStateDir, config.identity), 'transfers');
  const env = { ...process.env, SSH_MCP_BACKGROUND_FIXTURE: root, SSH_MCP_BACKGROUND_LOST_REGISTER: lostRegister ? '1' : '0', SSH_MCP_BACKGROUND_LOST_VERIFY: lostVerify ? '1' : '0', SSH_MCP_BACKGROUND_INIT_FAILURE: initFailure ? '1' : '0', SSH_MCP_BACKGROUND_LOST_START: lostStart ? '1' : '0' };
  const client = new Client({ name: 'background-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', preload, entry, '--workspace', profile], env, stderr: 'pipe' }));
  const call = async (name, args) => {
    const reply = await client.callTool({ name, arguments: { sessionId, ...args } }, undefined, { timeout: 1000 });
    assert.equal(reply.isError, undefined, reply.content[0].text);
    return JSON.parse(reply.content[0].text);
  };
  const wait = id => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', preload, cli, 'transfer', 'wait', '--workspace', profile, '--session', sessionId, '--transfer-id', id, '--wait-timeout', '10000'], { env, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    child.on('error', reject); child.on('exit', code => {
      try { assert.equal(code, 0, stderr + stdout); const result = JSON.parse(stdout); assert.equal(result.state, 'completed'); resolve(result); }
      catch (e) { reject(e); }
    });
  });
  return { root, profile, records, client, call, wait, env, async close() { await client.close(); await rm(root, { recursive: true }); } };
}

it('wait and resume return an unknown publication outcome without requesting acknowledgement or reattachment', async () => {
  const f = await fixture();
  try {
    const transferId = 'e'.repeat(32);
    const directory = join(f.records, transferId);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'record.json'), JSON.stringify({
      schemaVersion: 1, transferId, workspaceId: 'background-test', sessionId: 'background-session', background: true,
      direction: 'download', state: 'unknown', totalBytes: 100, confirmedOffset: 100,
      localPath: join(f.root, 'target.bin'), remotePath: '/work/source.bin',
      expiresAt: Date.now() + 86400000,
      error: { code: 'TRANSFER_STATE_UNKNOWN', message: 'Publication must be verified manually', retriable: false },
    }));
    for (const action of ['wait', 'resume']) {
      const run = await new Promise((resolve, reject) => {
        const args = ['--import', preload, cli, 'transfer', action, '--workspace', f.profile,
          '--session', 'background-session', '--transfer-id', transferId];
        if (action === 'wait') args.push('--wait-timeout', '200');
        const child = spawn(process.execPath, args, { env: f.env, windowsHide: true, timeout: 5000 });
        let stdout = '', stderr = '';
        child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
        child.on('error', reject); child.on('exit', code => resolve({ code, stdout, stderr }));
      });
      assert.equal(run.code, 1, run.stdout + run.stderr);
      const result = JSON.parse(run.stdout);
      assert.equal(result.kind, 'transfer-result');
      assert.equal(result.state, 'unknown');
      assert.equal(result.acknowledgementRequired, false);
      assert.equal(result.error.code, 'TRANSFER_STATE_UNKNOWN');
      assert.doesNotMatch(JSON.stringify(result), /Reattach/);
    }
    assert.equal(JSON.parse(await readFile(join(directory, 'record.json'), 'utf8')).state, 'unknown');
    await assert.rejects(readFile(join(directory, 'ack.json')), { code: 'ENOENT' });
  } finally { await f.close(); }
});

it('an upload continues after the MCP exits and a background waiter returns its verified result', async () => {
  const f = await fixture();
  try {
    const data = Buffer.alloc(65536 * 4 + 31, 0xa7);
    const localPath = join(f.root, 'source.bin');
    await writeFile(localPath, data);
    const started = await f.call('remote_upload', { action: 'start', localPath, path: 'target.bin', chunkSize: 65536 });
    assert.equal(started.state, 'preparing');
    const pending = await f.call('remote_transfer_pending', {});
    assert.equal(pending.transfers[0].transferId, started.transferId);
    await f.client.close();
    const done = await f.wait(started.transferId);
    assert.equal(done.transferId, started.transferId);
    assert.equal(done.acknowledgementRequired, true);
    assert.deepEqual(await readFile(join(f.root, 'remote-target.bin')), data);
  } finally { await f.close(); }
});

it('a download reports unknown total size during preparation and commits identical bytes', async () => {
  const f = await fixture();
  try {
    const data = Buffer.alloc(65536 * 3 + 17, 0x93);
    await writeFile(join(f.root, 'remote-source.bin'), data);
    const localPath = join(f.root, 'download.bin');
    const started = await f.call('remote_download', { action: 'start', path: 'source.bin', localPath, chunkSize: 65536 });
    assert.equal(started.totalBytesKnown, false);
    assert.equal(started.state, 'preparing');
    await f.wait(started.transferId);
    assert.deepEqual(await readFile(localPath), data);
    const status = await f.call('remote_download', { action: 'status', transferId: started.transferId });
    assert.equal(status.state, 'completed');
    assert.equal(status.totalBytesKnown, true);
    assert.equal(status.acknowledgementRequired, true);
    await f.call(status.nextAction.tool, status.nextAction.arguments);
    assert.deepEqual((await f.call('remote_transfer_pending', {})).transfers, []);
  } finally { await f.close(); }
});

it('a lost registration response resumes the same identifier without a second registration', async () => {
  const f = await fixture(true);
  try {
    const data = Buffer.alloc(65536 + 7, 0x42);
    const localPath = join(f.root, 'source.bin');
    await writeFile(localPath, data);
    const started = await f.call('remote_upload', { action: 'start', localPath, path: 'target.bin', chunkSize: 65536 });
    await f.wait(started.transferId);
    assert.deepEqual((await readFile(join(f.root, 'registrations.log'), 'utf8')).trim().split('\n'), [started.transferId]);
    assert.deepEqual(await readFile(join(f.root, 'remote-target.bin')), data);
  } finally { await f.close(); }
});

it('cancellation is confirmed by the upload driver and never reports the request itself as success', async () => {
  const f = await fixture();
  try {
    const localPath = join(f.root, 'source.bin');
    await writeFile(localPath, Buffer.alloc(65536 * 8, 0x61));
    const started = await f.call('remote_upload', { action: 'start', localPath, path: 'target.bin', chunkSize: 65536 });
    const deadline = Date.now() + 3000;
    while (JSON.parse(await readFile(join(f.records, started.transferId, 'record.json'), 'utf8')).confirmedOffset === 0) {
      assert.ok(Date.now() < deadline); await pause(20);
    }
    const requested = await f.call('remote_upload', { action: 'cancel', transferId: started.transferId });
    assert.equal(requested.state, 'cancelling');
    assert.equal(requested.acknowledgementRequired, false);
    for (;;) {
      const status = await f.call('remote_upload', { action: 'status', transferId: started.transferId });
      if (status.state === 'cancelled') { assert.equal(status.acknowledgementRequired, true); break; }
      assert.ok(Date.now() < deadline, 'driver never confirmed cancellation'); await pause(20);
    }
    await assert.rejects(readFile(join(f.root, 'remote-target.bin')), e => e.code === 'ENOENT');
  } finally { await f.close(); }
});

it('a killed download driver is recovered by concurrent waiters with one receiver and the original id', async () => {
  const f = await fixture();
  try {
    const data = Buffer.alloc(65536 * 8 + 1, 0xc1);
    await writeFile(join(f.root, 'remote-source.bin'), data);
    const localPath = join(f.root, 'download.bin');
    const started = await f.call('remote_download', { action: 'start', path: 'source.bin', localPath, chunkSize: 65536 });
    const directory = join(f.records, started.transferId);
    const deadline = Date.now() + 3000;
    while (JSON.parse(await readFile(join(directory, 'record.json'), 'utf8')).confirmedOffset === 0) {
      assert.ok(Date.now() < deadline); await pause(20);
    }
    const holder = JSON.parse(await readFile(join(directory, 'driver.json'), 'utf8'));
    process.kill(holder.pid, 'SIGKILL');
    await pause(50);
    await writeFile(join(directory, 'reap-' + holder.token + '.json'), JSON.stringify(holder));
    // A live unrelated PID must not be mistaken for the old transfer driver.
    await writeFile(join(directory, 'driver.json'), JSON.stringify({ ...holder, pid: process.pid }));
    const outcomes = await Promise.all([f.wait(started.transferId), f.wait(started.transferId)]);
    assert.deepEqual(outcomes.map(outcome => outcome.transferId), [started.transferId, started.transferId]);
    assert.deepEqual(await readFile(localPath), data);
    assert.deepEqual((await readFile(join(f.root, 'registrations.log'), 'utf8')).trim().split('\n'), [started.transferId]);
  } finally { await f.close(); }
});

it('a transport break during download verification stays resumable instead of consuming a failed result', async () => {
  const f = await fixture(false, true);
  try {
    const data = Buffer.alloc(65536 + 51, 0x37);
    await writeFile(join(f.root, 'remote-source.bin'), data);
    const localPath = join(f.root, 'download.bin');
    const started = await f.call('remote_download', { action: 'start', path: 'source.bin', localPath, chunkSize: 65536 });
    await f.wait(started.transferId);
    assert.deepEqual(await readFile(localPath), data);
  } finally { await f.close(); }
});

it('an upload prepared before remote start can resume the original identifier', async () => {
  const f = await fixture(false, false, false, true);
  try {
    const data = Buffer.alloc(65536 + 1, 0x57);
    const localPath = join(f.root, 'source.bin');
    await writeFile(localPath, data);
    const started = await f.call('remote_upload', { action: 'start', localPath, path: 'target.bin', chunkSize: 65536 });
    await f.wait(started.transferId);
    assert.deepEqual(await readFile(join(f.root, 'remote-target.bin')), data);
  } finally { await f.close(); }
});

it('worker initialization failures are durable and visible instead of leaving silent preparing records', async () => {
  const f = await fixture(false, false, true);
  try {
    const localPath = join(f.root, 'source.bin');
    await writeFile(localPath, 'init failure source');
    const started = await f.call('remote_upload', { action: 'start', localPath, path: 'target.bin' });
    const deadline = Date.now() + 3000;
    for (;;) {
      const status = await f.call('remote_upload', { action: 'status', transferId: started.transferId });
      if (status.state === 'failed') { assert.equal(status.error.code, 'INVALID_CONFIG'); break; }
      assert.ok(Date.now() < deadline, 'initialization failure was hidden'); await pause(30);
    }
  } finally { await f.close(); }
});
