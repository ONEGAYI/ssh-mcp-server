import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { RemoteAgentError } from '../build/services/remote-agent-client.js';
import * as contextModule from '../build/services/session-context.js';

it('injects only AGENTS and skill metadata from shared plus the current host directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-session-context-'));
  try {
    const profilePath = join(root, 'workspace.json');
    await writeFile(join(root, 'ssh.json'), JSON.stringify({ vm: { host: '127.0.0.1', port: 1, username: 'test', password: 'fixture' } }));
    const profile = { workspaceId: 'context', bindingName: 'eda', sshConfigFile: 'ssh.json', connectionName: 'vm',
      remoteRoot: '/remote project', remoteStateDir: '/state', clients: ['zcode', 'codex'], sessionStart: { enabled: true } };
    await writeFile(profilePath, JSON.stringify(profile));
    const calls = [];
    let closed = 0;
    const files = { async call(action, sessionId, request) {
      calls.push(request.path);
      assert.equal(sessionId, 'real-session');
      if (action === 'file_list') return { entries: [{ path: request.path + '/fixture', type: 'directory' }], truncated: false };
      assert.equal(request.grantRead, false);
      return { text: request.path === 'AGENTS.md' ? '远端工程规则' :
        '\ufeff---\nname: "same-name"\ndescription: >-\n  编译与检查\n  当前工程\n---\nPRIVATE SKILL BODY', truncated: false };
    } };
    const open = async () => ({ files, close() { closed++; } });
    const input = { hook_event_name: 'SessionStart', cwd: root, session_id: 'real-session', source: 'startup' };
    const codex = await contextModule.sessionStartContext(profilePath, 'codex', input, open);
    assert.ok(codex.hookSpecificOutput, 'enabled SessionStart must inject remote context');
    const text = codex.hookSpecificOutput.additionalContext;
    assert.match(text, /远端工程规则/);
    assert.match(text, /same-name/);
    assert.match(text, /编译与检查 当前工程/);
    assert.match(text, /\/remote project\/\.agents\/skills\/fixture\/SKILL.md/);
    assert.doesNotMatch(text, /PRIVATE SKILL BODY|\.codex\/skills|\.zcode\/skills/);
    assert.ok(!calls.some(path => path.includes('.zcode') || path.includes('.codex')));
    assert.equal(closed, 1);
    calls.length = 0;
    const zcode = await contextModule.sessionStartContext(profilePath, 'zcode', { ...input, source: 'compact' }, open);
    assert.match(zcode.hookSpecificOutput.additionalContext, /\.zcode\/skills\/fixture\/SKILL.md/);
    assert.ok(calls.includes('.agents/skills') && calls.includes('.zcode/skills'));
    assert.equal(closed, 2);
    await writeFile(profilePath, JSON.stringify({ ...profile, sessionStart: { enabled: false } }));
    assert.deepEqual(await contextModule.sessionStartContext(profilePath, 'codex', input, async () => { throw new Error('disabled must not connect'); }), {});
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const proxyMode of [false, true]) it(`the real CLI exits within its context timeout during ${proxyMode ? 'HTTP proxy setup' : 'SSH handshake'}`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-context-handshake-'));
  const sockets = new Set();
  const socketErrors = [];
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('error', error => socketErrors.push(error));
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const profilePath = join(root, 'workspace.json');
    await writeFile(join(root, 'ssh.json'), JSON.stringify({ vm: { host: '127.0.0.1', port: proxyMode ? 22 : server.address().port, username: 'test', password: 'fixture',
      ...(proxyMode ? { proxy: `http://127.0.0.1:${server.address().port}` } : {}) } }));
    await writeFile(profilePath, JSON.stringify({ workspaceId: 'handshake', sshConfigFile: 'ssh.json', connectionName: 'vm', remoteRoot: '/work', remoteStateDir: '/state',
      clients: ['codex'], sessionStart: { enabled: true, timeoutMs: 100 } }));
    const run = await new Promise(resolve => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('../build/cli/session-start.js', import.meta.url)), '--workspace', profilePath, '--client', 'codex']);
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const timer = setTimeout(() => { child.kill(); resolve({ timedOut: true, stdout, stderr }); }, 2000);
      child.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr, timedOut: false }); });
      child.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', cwd: root, session_id: 'real-session' }));
    });
    assert.equal(run.timedOut, false, 'pending SSH handshake must not keep the hook process alive after its configured timeout');
    assert.equal(run.status, 0, run.stderr);
    assert.match(JSON.parse(run.stdout).hookSpecificOutput.additionalContext, /CONTEXT_TIMEOUT/);
    assert.ok(socketErrors.every(error => error.code === 'ECONNRESET'), 'only the expected reset from hook exit is allowed');
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

it('reports missing, oversized and timed-out context and closes the SSH runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-context-failure-'));
  try {
    const profilePath = join(root, 'workspace.json');
    await writeFile(join(root, 'ssh.json'), JSON.stringify({ vm: { host: '127.0.0.1', port: 1, username: 'test', password: 'fixture' } }));
    const profile = { workspaceId: 'errors', sshConfigFile: 'ssh.json', connectionName: 'vm', remoteRoot: '/work', remoteStateDir: '/state',
      clients: ['codex'], sessionStart: { enabled: true, timeoutMs: 100, maxBytes: 1024 } };
    await writeFile(profilePath, JSON.stringify(profile));
    const input = { hook_event_name: 'SessionStart', cwd: root, session_id: 'real-session', source: 'resume' };
    let closed = 0;
    const missing = await contextModule.sessionStartContext(profilePath, 'codex', input, async () => ({
      files: { async call() { throw new RemoteAgentError('PATH_NOT_FOUND', 'private diagnostics'); } }, close() { closed++; } }));
    assert.match(missing.hookSpecificOutput.additionalContext, /PATH_NOT_FOUND/);
    assert.doesNotMatch(missing.hookSpecificOutput.additionalContext, /private diagnostics/);
    const oversized = await contextModule.sessionStartContext(profilePath, 'codex', input, async () => ({
      files: { async call() { return { text: 'SECRET PARTIAL RULES', truncated: true }; } }, close() { closed++; } }));
    assert.match(oversized.hookSpecificOutput.additionalContext, /CONTEXT_TOO_LARGE/);
    assert.doesNotMatch(oversized.hookSpecificOutput.additionalContext, /SECRET PARTIAL RULES/);
    const start = Date.now();
    const timeout = await contextModule.sessionStartContext(profilePath, 'codex', input, async () => ({
      files: { call() { return new Promise(() => {}); } }, close() { closed++; } }));
    assert.match(timeout.hookSpecificOutput.additionalContext, /CONTEXT_TIMEOUT/);
    assert.ok(Date.now() - start < 1500, 'timeout must bound startup delay');
    assert.equal(closed, 3);
    await writeFile(profilePath, JSON.stringify({ ...profile, remoteRoot: '/a'.repeat(600) }));
    const longPath = await contextModule.sessionStartContext(profilePath, 'codex', input, async () => ({
      files: { async call() { return { text: 'RULES', truncated: false }; } }, close() {} }));
    assert.ok(Buffer.byteLength(longPath.hookSpecificOutput.additionalContext, 'utf8') <= 1024,
      'failure diagnostics must also respect the configured context byte limit');
    assert.deepEqual(await contextModule.sessionStartContext(profilePath, 'codex', { ...input, cwd: tmpdir() }, async () => { throw new Error('outside must not connect'); }), {});
    assert.deepEqual(await contextModule.sessionStartContext(profilePath, 'zcode', input, async () => { throw new Error('wrong host must not connect'); }), {});
  } finally { await rm(root, { recursive: true, force: true }); }
});
