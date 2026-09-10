#!/usr/bin/env node
// A real ZCode runtime, an isolated profile and a loopback-only fake model.
// No installed ZCode settings are changed and no model account is used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { isAbsolute, relative, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  cli: { type: 'string' }, restart: { type: 'boolean', default: false },
  recover: { type: 'boolean', default: false },
  workspace: { type: 'string' },
  output: { type: 'string', default: '.artifacts' },
} });
assert.ok(values.cli, 'Use --cli <absolute path to the installed zcode.cjs>');
const cli = resolve(values.cli);
const output = resolve(values.output);
mkdirSync(output, { recursive: true });
const root = mkdtempSync(resolve(output, 'zcode-background-'));
const releasePath = resolve(root, 'release');
const readyPath = resolve(root, 'ready');
const donePath = resolve(root, 'done.json');
const commandScript = resolve(root, 'wait-for-file.cjs');
writeFileSync(commandScript, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(readyPath)},'ready');
const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(releasePath)})){
clearInterval(timer);fs.writeFileSync(${JSON.stringify(donePath)},JSON.stringify({marker:'SSH_MCP_BG_OK',exitCode:0}));console.log('SSH_MCP_BG_OK');}},50);
setTimeout(()=>{clearInterval(timer);process.exitCode=2;},30000).unref();\n`);
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
let command = `node ${shellQuote(commandScript.replaceAll('\\', '/'))}`;
let remoteRuntime, remoteJob, remoteSession, remoteRelease, remoteCounter, waitCommand, ackCommand;
const jobCli = fileURLToPath(new URL('../../build/cli/job.js', import.meta.url));
const recoveryCli = fileURLToPath(new URL('../../build/cli/recovery.js', import.meta.url));
const argvCommand = args => args.map(value => shellQuote(/^[A-Za-z]:[\\/]/.test(value) ? value.replaceAll('\\', '/') : value)).join(' ');
if (values.workspace) {
  assert.ok(values.recover, 'Production remote integration currently requires --recover');
  const { createWorkspaceRuntime } = await import('../../build/services/workspace-runtime.js');
  remoteRuntime = await createWorkspaceRuntime(resolve(values.workspace));
  const localWithin = relative(remoteRuntime.config.localRoot, root);
  assert.ok(!isAbsolute(localWithin) && !localWithin.startsWith('..'), 'Probe output must be inside profile localRoot for the real recovery hook');
}
const result = { mode: values.recover ? 'recover' : values.restart ? 'restart' : 'normal', root,
  scope: values.workspace ? 'Real ZCode native background Shell + production recovery hook + persistent remote SSH task, with loopback fake model' : 'Native background waiter and recovery-hook integration; remote task deduplication is tested separately',
  requests: [], events: [] };
let requestCount = 0;
const model = createServer(async (req, res) => {
  try {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 4 * 1024 * 1024) throw new Error('Probe request too large');
    }
    if (req.url !== '/v1/messages') { res.writeHead(404).end(); return; }
    const body = JSON.parse(raw);
    requestCount++;
    const lastContent = body.messages?.at(-1)?.content;
    const texts = Array.isArray(lastContent) ? lastContent.map(block => block.text ?? block.content ?? '').filter(text => typeof text === 'string') : [];
    const lastText = texts.join('\n');
    const receiptId = /Command running in background with ID: (exec_[a-z0-9-]+)/.exec(lastText)?.[1];
    const tag = name => new RegExp(`<${name}>([^<]*)</${name}>`).exec(lastText)?.[1];
    const notification = lastText.includes('<task-notification>') ? {
      taskId: tag('task-id'), toolUseId: tag('tool-use-id'), status: tag('status'),
      outputFile: tag('output-file'), summary: tag('summary'),
    } : undefined;
    result.requests.push({ number: requestCount,
      hasCompletionNotification: JSON.stringify(body.messages).includes('task-notification'),
      hasRecoveryContext: values.workspace ? JSON.stringify(body.messages).includes(remoteJob ?? 'NO_JOB_REGISTERED') : JSON.stringify(body.messages).includes('SSH_MCP_PENDING_JOB_RESTORE'),
      receiptId, notification,
      tools: body.tools?.map(tool => tool.name) });
    const consuming = Boolean(values.workspace && notification);
    if (consuming) {
      assert.equal(notification.taskId, result.requests[3].receiptId);
      const nativeOutput = readFileSync(notification.outputFile, 'utf8');
      const packet = nativeOutput.split(/\r?\n/).filter(line => line.startsWith('{')).map(line => {
        try { return JSON.parse(line); } catch { return {}; }
      }).find(item => item.kind === 'task-result');
      assert.equal(packet?.task.jobId, remoteJob, 'Recovered notification must contain the original remote task result');
      assert.equal(packet.task.exitCode, 0);
      assert.ok(packet.task.eventId);
      result.remoteCompletion = packet.task;
      result.recoveredNotification = notification;
    }
    const useTool = requestCount === 1 || (values.recover && requestCount === 3) || consuming;
    const block = useTool
      ? { type: 'tool_use', id: `toolu_background_probe_${requestCount}`, name: 'Bash', input: {
        command: consuming ? ackCommand : requestCount === 3 && values.workspace ? waitCommand : command,
        run_in_background: !consuming, description: consuming ? 'Acknowledge inspected remote completion' : 'SSH MCP completion probe',
      } }
      : { type: 'text', text: requestCount === 2 ? 'MAIN_RETURNED' : values.recover && requestCount === 4 ? 'MAIN_RESUMED' : 'FOLLOWUP_OBSERVED' };
    const stopReason = useTool ? 'tool_use' : 'end_turn';
    const message = { id: `msg_probe_${requestCount}`, type: 'message', role: 'assistant',
      model: 'probe', content: [block], stop_reason: stopReason, stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 20 } };
    if (!body.stream) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(message)); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    emit('message_start', { message: { ...message, content: [], stop_reason: null } });
    emit('content_block_start', { index: 0, content_block: useTool ? { ...block, input: {} } : { type: 'text', text: '' } });
    emit('content_block_delta', { index: 0, delta: useTool
      ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
      : { type: 'text_delta', text: block.text } });
    emit('content_block_stop', { index: 0 });
    emit('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 20 } });
    emit('message_stop', {});
    res.end();
  } catch (error) { result.modelError = String(error); res.writeHead(500).end(); }
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
const baseURL = `http://127.0.0.1:${model.address().port}`;
const runtimeModel = { revision: 'ssh-mcp-local-probe-v1', generatedAt: Date.now(),
  model: { providerId: 'probe', modelId: 'probe' }, provider: {
    providerId: 'probe', kind: 'anthropic', baseURL, apiKey: { source: 'inline', value: 'local-probe-only' },
    models: [{ modelId: 'probe', supportsTools: true, contextWindow: 200000 }],
  } };
mkdirSync(resolve(root, '.zcode/cli'), { recursive: true });
const recoveryFlag = resolve(root, 'pending-recovery');
const hookScript = resolve(root, 'recovery-hook.cjs');
writeFileSync(hookScript, `const fs=require('node:fs');let input='';
process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{
const event=JSON.parse(input);if(fs.existsSync(${JSON.stringify(recoveryFlag)})){
process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'UserPromptSubmit',
additionalContext:'SSH_MCP_PENDING_JOB_RESTORE: Reattach the persisted task with the background Shell waiter; do not restart its command.'}}));}});\n`);
writeFileSync(resolve(root, '.zcode/cli/config.json'), JSON.stringify({
  storage: { dir: resolve(root, 'state') }, hooks: { enabled: values.recover,
    events: { UserPromptSubmit: [{ hooks: [{ type: 'process', command: process.execPath,
      args: values.workspace ? [recoveryCli, '--workspace', resolve(values.workspace)] : [hookScript] }] }] },
  }, mcp: { servers: {} },
}));
const env = {};
for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP']) {
  if (process.env[key] !== undefined) env[key] = process.env[key];
}
Object.assign(env, { HOME: root, USERPROFILE: root, ZCODE_STORAGE_DIR: resolve(root, 'state'),
  ZCODE_MODEL: 'probe/probe', ZCODE_BASE_URL: baseURL, ANTHROPIC_API_KEY: 'local-probe-only', NO_PROXY: '127.0.0.1,localhost' });

function startRuntime() {
  const child = spawn(process.execPath, [cli, 'app-server', '--cwd', root, '--surface', 'desktop'], {
    env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  const waiters = new Set();
  const completedTurns = [];
  let id = 0, buffer = '', stderr = '', exited = false;
  const closed = new Promise(resolve => child.once('exit', (code, signal) => {
    exited = true;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('ZCode runtime exited')); }
    pending.clear();
    for (const item of waiters) item.reject(new Error('ZCode runtime exited'));
    resolve({ code, signal });
  }));
  child.on('error', error => { result.spawnError = String(error); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.method === 'session/requestRuntimePreferences') {
        child.stdin.write(JSON.stringify({ id: message.id, result: { nativeSearchEnhancementsEnabled: false } }) + '\n');
      } else if (pending.has(message.id)) {
        const entry = pending.get(message.id); pending.delete(message.id); clearTimeout(entry.timer);
        message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
      } else if (message.method === 'session/event') {
        const event = message.params;
        if (event.type === 'turn.completed') {
          const response = event.payload.response;
          completedTurns.push(response);
          result.events.push({ type: event.type, sessionId: event.sessionId, response });
          for (const entry of waiters) if (entry.response === response) { waiters.delete(entry); entry.resolve(); }
        }
      }
    }
  });
  return {
    rpc(method, params) {
      return new Promise((resolve, reject) => {
        if (exited) { reject(new Error('ZCode runtime already exited')); return; }
        const requestId = ++id;
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`RPC timeout: ${method}`)); }, 15000);
        pending.set(requestId, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ id: requestId, method, params }) + '\n');
      });
    },
    waitTurn(response, timeoutMs = 15000) {
      if (completedTurns.includes(response)) return Promise.resolve(true);
      return new Promise((resolve, reject) => {
        const entry = { response, resolve: () => { clearTimeout(timer); resolve(true); },
          reject: error => { clearTimeout(timer); waiters.delete(entry); reject(error); } };
        const timer = setTimeout(() => { waiters.delete(entry); resolve(false); }, timeoutMs);
        waiters.add(entry);
      });
    },
    async stop(force = false) {
      if (!exited) { if (force) child.kill(); else child.stdin.end(); }
      const timer = setTimeout(() => { if (!exited) child.kill(); }, 2000);
      const exit = await closed; clearTimeout(timer);
      result.runtimeExits ??= []; result.runtimeExits.push(exit);
      if (stderr) result.stderr = stderr;
    },
  };
}

let runtime;
try {
  runtime = startRuntime();
  const workspace = { workspacePath: root, workspaceKey: 'ssh-mcp-background-probe' };
  const created = await runtime.rpc('session/create', {
    workspace, runtimeModel, mode: 'yolo', titleGenerationEnabled: false, toolAllowlist: ['Bash'], mcpServers: [],
  });
  const sessionId = created.session.sessionId;
  remoteSession = sessionId;
  if (remoteRuntime) {
    remoteRelease = posix.join(remoteRuntime.config.remoteRoot, `probe-${sessionId}.release`);
    remoteCounter = posix.join(remoteRuntime.config.remoteRoot, `probe-${sessionId}.counter`);
    const remoteCommand = `printf x >> ${shellQuote(remoteCounter)}; printf 'REMOTE_READY\\n'; while ! test -f ${shellQuote(remoteRelease)}; do sleep 0.1; done; printf 'SSH_MCP_BG_OK\\n'`;
    command = argvCommand([process.execPath, jobCli, 'run', '--workspace', resolve(values.workspace), '--session', sessionId,
      '--command', remoteCommand, '--execution-timeout', '120000']);
  }
  result.sessionId = sessionId;
  await runtime.rpc('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous' });
  await runtime.rpc('session/send', { sessionId, content: 'Run the isolated background completion probe.' });
  assert.equal(await runtime.waitTurn('MAIN_RETURNED'), true, 'Main turn did not finish');
  assert.equal(requestCount, 2, 'The command must still be waiting when the main turn ends');
  assert.equal(existsSync(donePath), false, 'The command completed before the main turn ended');
  // The native tool can return before the command's process has fully started.
  if (remoteRuntime) {
    for (let i = 0; i < 100; i++) {
      const registered = await remoteRuntime.tasks.pending(sessionId);
      if (registered.length) {
        remoteJob = registered[0].jobId;
        try {
          const state = await remoteRuntime.tasks.status(remoteJob);
          if (state.state === 'running') break;
        } catch { /* Startup may still be in progress. */ }
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(remoteJob, 'Native Shell did not register a real remote task');
    assert.equal((await remoteRuntime.tasks.status(remoteJob)).state, 'running');
    result.remoteJobId = remoteJob;
    waitCommand = argvCommand([process.execPath, jobCli, 'wait', '--workspace', resolve(values.workspace), '--session', sessionId, '--job-id', remoteJob]);
    ackCommand = argvCommand([process.execPath, jobCli, 'ack', '--workspace', resolve(values.workspace), '--session', sessionId, '--job-id', remoteJob]);
  } else {
    for (let i = 0; i < 100 && !existsSync(readyPath); i++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(existsSync(readyPath), true, 'The background command did not actually start');
  }
  if (values.restart || values.recover) {
    await runtime.stop(true);
    runtime = startRuntime();
    const resumed = await runtime.rpc('session/resume', { sessionId, workspace, runtimeModel, toolAllowlist: ['Bash'], mcpServers: [] });
    result.resumedSessionId = resumed.session?.sessionId;
    assert.equal(result.resumedSessionId, sessionId, 'The original session was not restored');
    result.resumedBackgroundJobs = resumed.projection?.backgroundTasks ?? resumed.state?.backgroundJobs;
    await runtime.rpc('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous' });
  }
  if (values.recover) {
    writeFileSync(recoveryFlag, 'pending');
    await runtime.rpc('session/send', { sessionId, content: 'Continue the original task.' });
    assert.equal(await runtime.waitTurn('MAIN_RESUMED'), true, 'Resumed turn did not finish');
    assert.equal(result.requests[2]?.hasRecoveryContext, true, 'Recovery hook context was not delivered');
  }
  writeFileSync(releasePath, 'release');
  if (remoteRuntime) await remoteRuntime.remote.call('file_write', { workspaceRoot: remoteRuntime.config.remoteRoot,
    sessionId, path: remoteRelease, text: 'release', create: true });
  result.followupObserved = await runtime.waitTurn('FOLLOWUP_OBSERVED', values.restart ? 6000 : 15000);
  result.completionNotificationObserved = result.requests.some(item => item.hasCompletionNotification);
  if (result.followupObserved) {
    if (!values.workspace) assert.equal(existsSync(donePath), true, 'A failure notification was mistaken for command success');
    const receipt = result.requests[values.recover ? 3 : 1];
    const notification = result.recoveredNotification ?? result.requests.at(-1).notification;
    assert.ok(receipt.receiptId, 'Missing native background task receipt');
    assert.equal(notification?.taskId, receipt.receiptId, 'Completion belongs to a different waiter');
    assert.equal(notification.toolUseId, values.recover ? 'toolu_background_probe_3' : 'toolu_background_probe_1');
    assert.equal(notification.status, 'completed');
    assert.match(notification.summary, /exit code 0/);
    const pathWithinProbe = relative(root, resolve(notification.outputFile));
    assert.ok(pathWithinProbe && !isAbsolute(pathWithinProbe) && !pathWithinProbe.startsWith('..'), 'Unexpected output path');
    assert.match(readFileSync(notification.outputFile, 'utf8'), /SSH_MCP_BG_OK/);
    result.waiterCompletionVerified = true;
    if (remoteRuntime) {
      const counter = await remoteRuntime.remote.call('file_read', { workspaceRoot: remoteRuntime.config.remoteRoot, sessionId, path: remoteCounter });
      assert.equal(counter.text, 'x', 'The remote side effect ran more than once');
      assert.deepEqual(await remoteRuntime.tasks.pending(sessionId), [], 'Model acknowledgement did not clear the original pending result');
      result.remoteExecutedOnce = true;
      result.resultAcknowledged = true;
    }
  }
  if (!result.followupObserved || !result.completionNotificationObserved) {
    result.gap = 'No automatic completion follow-up observed within the probe window';
    process.exitCode = 2;
  }
} catch (error) { result.error = String(error); process.exitCode = 1; }
finally {
  writeFileSync(releasePath, 'release');
  if (remoteRuntime && remoteJob && !result.resultAcknowledged) await remoteRuntime.tasks.cancel(remoteJob).catch(() => {});
  await runtime?.stop();
  remoteRuntime?.close();
  model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
  writeFileSync(resolve(root, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
