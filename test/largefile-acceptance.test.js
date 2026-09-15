// Issue #21: cross-cutting final acceptance for the large-file feature set.
//
// The per-feature tickets (#9-#20) each shipped their own behaviour tests.
// This file covers the three gaps that only exist across features (spec
// section 10, large-file-spec.md):
//
//   1. Bounded network traffic for local operations -- a 1 MiB window read,
//      a line-located read, a search and a streamed edit of a 200 MiB file
//      must each move window-scale bytes, never file-scale bytes. Measured
//      at the SSH transport boundary by wrapping the public HelperTransport.
//   2. The 20 vs 200 MiB incremental peak-memory comparison: window read,
//      whole-file search, streamed edit commit, upload and download on both
//      the remote helper (incl. its scan child processes, via
//      getrusage(RUSAGE_CHILDREN).ru_maxrss around the real helper binary)
//      and the local Node driver (sampled process.memoryUsage() while the
//      real TransferService drives the transfer over SSH).
//   3. End-to-end crash recovery at 128 MiB: a killed local driver process,
//      a torn half-block on each end, and a fresh-process resume that
//      finishes with matching digests, no half files, and only the
//      unconfirmed tail (plus at most one incomplete block) retransferred.
//
// Gated on SSH_MCP_TEST_WORKSPACE (a real CentOS 7 VM). Run serially and
// separately from the other two VM suites to avoid helper-deploy races.

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open, readdir, rm, stat, appendFile } from 'node:fs/promises';
import { basename, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkspaceConfig } from '../build/config/workspace.js';
import { RemoteAgentClient } from '../build/services/remote-agent-client.js';

const profile = process.env.SSH_MCP_TEST_WORKSPACE;
const MiB = 1024 * 1024;

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** Run one registered shell command on the remote to a checked exit 0.
 * Returns the registered jobId so callers can acknowledge (and thereby
 * make reclaimable) the task record the run leaves behind (review R10). */
async function runTask(runtime, command, timeoutMs = 120000) {
  const registration = await runtime.remote.call('task_register', { protocol: 2,
    cwd: runtime.config.remoteRoot, command });
  await runtime.remote.call('task_start', { protocol: 2, jobId: registration.jobId });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await runtime.remote.call('status', { jobId: registration.jobId });
    if (['exited', 'cancelled', 'interrupted'].includes(state.state)) {
      if (state.state !== 'exited' || state.exitCode !== 0) {
        let stderr = '';
        try {
          const output = await runtime.remote.call('output', { jobId: registration.jobId });
          stderr = Buffer.from(output.stderr.data, 'base64').toString('utf8').slice(0, 2000);
        } catch { /* logs may be absent */ }
        throw new Error('remote task failed: ' + JSON.stringify(state) + '\n' + stderr);
      }
      return registration.jobId;
    }
    if (Date.now() > deadline) throw new Error('remote task did not finish: ' + JSON.stringify(state));
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

/** Best-effort acknowledgement of every task record a case registered
 * (review R10): acknowledged records become reclaimable by the maintenance
 * round instead of piling up as unconfirmed terminal results. Swallows all
 * errors -- cleanup must never mask the assertions above. */
async function ackJobs(runtime, jobIds) {
  for (const jobId of jobIds) {
    await runtime.remote.call('ack', { jobId }).catch(() => undefined);
  }
}

/** Best-effort acknowledgement of remote transfer registrations that were
 * driven outside TransferService (the MEASURER talks to the helper
 * directly): the helper's transfer_ack needs the registering sessionId. */
async function ackRemoteTransfers(runtime, config, sessionId, transferIds) {
  for (const transferId of transferIds) {
    await runtime.remote.call('transfer_ack', { protocol: 2, transferId, sessionId,
      workspaceRoot: config.remoteRoot }).catch(() => undefined);
  }
}

/** The 64-byte fixed-line oracle shared with the 200 MiB VM cases. */
const lineOf = index => {
  const head = 'L' + String(index) + ' ';
  return head + 'x'.repeat(64 - head.length - 1) + '\n';
};

/** A transport wrapper that counts SSH-channel bytes in both directions. */
class CountingTransport {
  constructor(inner) { this.inner = inner; this.sent = 0; this.received = 0; }
  reset() { this.sent = 0; this.received = 0; }
  async executeInputCommand(command, input, name, options) {
    const result = await this.inner.executeInputCommand(command, input, name, options);
    this.sent += input.length;
    this.received += Buffer.byteLength(result.stdout);
    return result;
  }
  async executeBinaryInputCommand(command, input, name, options) {
    const result = await this.inner.executeBinaryInputCommand(command, input, name, options);
    this.sent += input.length;
    this.received += result.stdout.length;
    return result;
  }
}

/** The helper image digest, recomputed exactly like RemoteAgentClient.install. */
async function helperDigest() {
  const { readdir, readFile } = await import('node:fs/promises');
  const directory = new URL('../build/remote/', import.meta.url);
  const files = {};
  for (const name of (await readdir(directory)).filter(n => /^[a-zA-Z0-9_-]+\.py$/.test(n)).sort()) {
    files[name] = (await readFile(new URL(name, directory))).toString('base64');
  }
  return createHash('sha256').update(Buffer.from(JSON.stringify({ files }), 'utf8')).digest('hex');
}

// ---------------------------------------------------------------------------
// Case 1: local operations move window-scale bytes, never file-scale bytes
// ---------------------------------------------------------------------------

it('window read, line read, search and streamed edit of a 200 MiB file move window-scale bytes (#21)', { skip: !profile, timeout: 420000 }, async () => {
  const { createWorkspaceRuntime } = await import('../build/services/workspace-runtime.js');
  const config = await loadWorkspaceConfig(profile);
  const sessionId = 'acc21-' + createHash('sha256').update(String(Date.now()) + 'a').digest('hex').slice(0, 12);
  const remoteName = 'acc21-netlist-' + sessionId + '.txt';
  const lineCount = (200 * MiB) / 64;
  const runtime = await createWorkspaceRuntime(profile);
  const counting = new CountingTransport(runtime.ssh);
  const countingRemote = new RemoteAgentClient(counting, config);
  const base = { workspaceRoot: config.remoteRoot, sessionId, path: remoteName };
  const jobIds = []; // every registered task, acknowledged in finally (review R10)
  const task = async (command, timeoutMs) => {
    const jobId = await runTask(runtime, command, timeoutMs);
    jobIds.push(jobId);
    return jobId;
  };
  try {
    await task(
      `python3 -c "f = open('${remoteName}', 'wb'); ` +
      `[f.write(('L%d ' % i).encode('ascii') + b'x' * (64 - len('L%d ' % i) - 1) + b'\\n') for i in range(1, ${lineCount + 1})]; ` +
      `f.close()"`, 180000);
    const meta = await runtime.remote.call('file_read', { ...base, metadataOnly: true });
    assert.equal(meta.size, 200 * MiB);

    const budget = async (label, run, limitBytes) => {
      counting.reset();
      const result = await run();
      const both = counting.sent + counting.received;
      console.log(`[issue #21] ${label}: sent ${counting.sent} B, received ${counting.received} B (limit ${limitBytes} B)`);
      assert.ok(both <= limitBytes,
        `${label} moved ${both} bytes; a bounded local operation must stay under ${limitBytes}`);
      return result;
    };

    // A 1 MiB base64 window from the middle (grantRead=false is the transfer
    // path, so the delivery is not clipped by the 56 KiB text budget): the
    // exchange carries the window plus base64/JSON envelope overhead, not
    // the 200 MiB file.
    const windowOffset = 100 * MiB;
    const window = await budget('base64 window read 1 MiB', () =>
      countingRemote.call('file_read', { ...base, offset: windowOffset,
        maxBytes: MiB, encoding: 'base64', grantRead: false }), 4 * MiB);
    const oracle = Buffer.from(lineOf(windowOffset / 64 + 1) + lineOf(windowOffset / 64 + 2), 'utf8');
    assert.equal(window.endOffset - window.startOffset, MiB, 'the full 1 MiB window was delivered');
    assert.equal(Buffer.compare(Buffer.from(window.data, 'base64').subarray(0, 128), oracle.subarray(0, 128)), 0);

    // A text window read under the 56 KiB serialization budget.
    await budget('text window read 64 KiB', () =>
      countingRemote.call('file_read', { ...base, offset: 50 * MiB, maxBytes: 65536 }), 512 * 1024);

    // A line-located read in the second half: the line scan happens remotely;
    // only the located window travels back.
    const middleLine = Math.floor(lineCount / 2) + 7;
    const located = await budget('line-located read', () =>
      countingRemote.call('file_read', { ...base, fromLine: middleLine, toLine: middleLine }), 512 * 1024);
    assert.equal(located.text.trimEnd(), lineOf(middleLine).trimEnd());

    // A whole-file search that hits one late line.
    const hit = lineCount - 3;
    const search = await budget('search over 200 MiB', () =>
      countingRemote.call('file_search', { ...base, pattern: 'L' + hit + ' ' }), 512 * 1024);
    assert.equal(search.matches.length, 1);
    assert.equal(search.truncated, false);

    // A streamed edit commit: the request carries only oldText/newText and
    // the response only the bounded receipt -- yet the whole file changes.
    const target = Math.floor(lineCount / 3);
    const read = await budget('edit precondition read', () =>
      countingRemote.call('file_read', { ...base, offset: (target - 1) * 64, maxBytes: 64 }), 512 * 1024);
    assert.equal(read.text.trimEnd(), lineOf(target).trimEnd());
    const newText = 'L' + target + ' patched by #21 acceptance';
    await budget('streamed edit commit', () =>
      countingRemote.call('file_edit', { ...base, readToken: read.readToken,
        edits: [{ oldText: lineOf(target).trimEnd(), newText }] }), 512 * 1024);
    const after = await runtime.remote.call('file_read', { ...base, metadataOnly: true });
    assert.equal(after.size, 200 * MiB + newText.length - 63, 'the edit committed and grew the file');
    // Everything above stayed at least two orders of magnitude below the
    // 200 MiB file: window-scale traffic, not whole-file traffic.
    console.log('[issue #21] all local-operation exchanges stayed under 4 MiB on a 200 MiB file');
  } finally {
    await runTask(runtime, `rm -f '${remoteName}'`).then(jobId => jobIds.push(jobId)).catch(() => undefined);
    // Cleanup last, all errors swallowed (review R10): the registered task
    // records must not outlive the case as unconfirmed terminal results.
    await ackJobs(runtime, jobIds);
    runtime.close();
  }
});

// ---------------------------------------------------------------------------
// Case 2: 20 vs 200 MiB incremental peak-memory comparison
// ---------------------------------------------------------------------------

/** The remote measurer: drives the real helper binary for one plan and
 * reports the peak RSS over the helper processes it spawned (Linux wait4
 * rusage folds each helper's own scan children into that peak; KiB units). */
const MEASURER = `
import base64, hashlib, json, os, resource, subprocess, sys

HELPER, ROOT, WORK, SESSION, PLAN_B64 = sys.argv[1:6]
PLAN = json.loads(base64.b64decode(PLAN_B64).decode('utf8'))
PY = sys.executable
CHUNK = 1024 * 1024

def envelope(stdout_bytes):
    for line in stdout_bytes.decode('utf8', 'replace').split('\\n'):
        if line.startswith('SSH_MCP_V1 '):
            value = json.loads(base64.b64decode(line[11:]))
            if not value.get('ok'):
                raise RuntimeError('helper error: ' + json.dumps(value.get('error')))
            return value['result']
    raise RuntimeError('no envelope in helper output')

def call(action, request):
    payload = json.dumps(dict(request, workspaceRoot=WORK, sessionId=SESSION)).encode('utf8')
    run = subprocess.run([PY, HELPER, '--root', ROOT, action], input=payload,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if run.returncode != 0:
        raise RuntimeError('helper exit %d: %s' % (run.returncode, run.stderr.decode('utf8', 'replace')[:500]))
    return envelope(run.stdout)

kind = PLAN['kind']
path = PLAN.get('path')
info = {'kind': kind}

if kind == 'baseline':
    call('file_read', {'path': path, 'metadataOnly': True})
elif kind == 'read':
    call('file_read', {'path': path, 'offset': PLAN['offset'], 'maxBytes': PLAN['maxBytes'],
                       'encoding': PLAN.get('encoding', 'utf8'), 'grantRead': False})
elif kind == 'search':
    call('file_search', {'path': path, 'pattern': PLAN['pattern']})
elif kind == 'edit':
    read = call('file_read', {'path': path, 'offset': PLAN['offset'], 'maxBytes': 4096})
    result = call('file_edit', {'path': path, 'readToken': read['readToken'],
                                'edits': [{'oldText': PLAN['oldText'], 'newText': PLAN['newText']}]})
    info['bytesWritten'] = result.get('bytesWritten')
elif kind == 'upload':
    source = os.path.join(WORK, PLAN['source'])
    st = os.stat(source)
    identity = {'size': st.st_size, 'mtimeMs': st.st_mtime}
    digest = hashlib.sha256()
    with open(source, 'rb') as stream:
        for block in iter(lambda: stream.read(CHUNK), b''):
            digest.update(block)
    registered = call('transfer_register', {'protocol': 2, 'direction': 'upload',
        'targetPath': path, 'chunkSize': CHUNK, 'totalBytes': st.st_size,
        'totalSha256': digest.hexdigest(), 'sourceIdentity': identity,
        'overwrite': False, 'create': True})
    call('transfer_start', {'protocol': 2, 'transferId': registered['transferId'],
        'sourceIdentity': identity})
    offset, index = 0, 0
    with open(source, 'rb') as stream:
        while True:
            block = stream.read(CHUNK)
            if not block:
                break
            control = json.dumps({'transferId': registered['transferId'], 'index': index,
                'offset': offset, 'size': len(block),
                'sha256': hashlib.sha256(block).hexdigest(), 'sessionId': SESSION})
            run = subprocess.run([PY, HELPER, '--root', ROOT, 'transfer_block'],
                input=control.encode('utf8') + b'\\n' + block,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if run.returncode != 0:
                raise RuntimeError('block exit %d: %s' % (run.returncode, run.stderr.decode('utf8', 'replace')[:500]))
            envelope(run.stdout)
            offset += len(block)
            index += 1
    call('transfer_verify', {'protocol': 2, 'transferId': registered['transferId']})
    committed = call('transfer_commit', {'protocol': 2, 'transferId': registered['transferId']})
    info['bytesWritten'] = committed.get('bytesWritten')
    info['blocks'] = index
    info['transferId'] = registered['transferId']
elif kind == 'download':
    registered = call('transfer_register', {'protocol': 2, 'direction': 'download',
        'targetPath': 'receiver-side (not this host)', 'chunkSize': CHUNK,
        'sourcePath': path, 'overwrite': False, 'create': False})
    total = registered['totalBytes']
    call('transfer_start', {'protocol': 2, 'transferId': registered['transferId'],
        'sourceVersion': registered['sourceVersion']})
    offset, index, received = 0, 0, 0
    while offset < total:
        size = min(CHUNK, total - offset)
        control = json.dumps({'transferId': registered['transferId'], 'index': index,
            'offset': offset, 'size': size, 'sessionId': SESSION})
        run = subprocess.run([PY, HELPER, '--root', ROOT, 'transfer_fetch'],
            input=control.encode('utf8') + b'\\n',
            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if run.returncode != 0:
            raise RuntimeError('fetch exit %d: %s' % (run.returncode, run.stderr.decode('utf8', 'replace')[:500]))
        newline = run.stdout.index(b'\\n')
        head = run.stdout[:newline]
        if head.startswith(b'SSH_MCP_V1 '):
            raise RuntimeError('fetch answered an error envelope: ' + head.decode('utf8', 'replace')[:200])
        meta = json.loads(head.decode('utf8'))
        payload = run.stdout[newline + 1:newline + 1 + meta['size']]
        if hashlib.sha256(payload).hexdigest() != meta['sha256']:
            raise RuntimeError('fetched block digest mismatch')
        received += len(payload)
        offset += size
        index += 1
    call('transfer_verify', {'protocol': 2, 'transferId': registered['transferId'],
        'sha256': registered['sha256']})
    call('transfer_commit', {'protocol': 2, 'transferId': registered['transferId']})
    info['received'] = received
    info['blocks'] = index
    info['transferId'] = registered['transferId']
else:
    raise RuntimeError('unknown plan kind ' + kind)

peak_kb = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
print(json.dumps(dict(info, ok=True, peakRssKb=peak_kb)))
`;

/** Sample process.memoryUsage() while `run` executes; returns peak deltas. */
async function withMemorySampling(run) {
  const before = process.memoryUsage();
  let peakRss = before.rss, peakHeap = before.heapUsed;
  const sampler = setInterval(() => {
    const usage = process.memoryUsage();
    peakRss = Math.max(peakRss, usage.rss);
    peakHeap = Math.max(peakHeap, usage.heapUsed);
  }, 50);
  try {
    const result = await run();
    return { result, rssDelta: peakRss - before.rss, heapDelta: peakHeap - before.heapUsed };
  } finally { clearInterval(sampler); }
}

/** Spec judgement: every active operation stays under 64 MiB and a 10x file
 * must not cost near-10x memory (small increments get a fixed 4 MiB floor so
 * measurement noise on the 20 MiB side cannot fake a violation). */
export function assertMemoryBudget(label, inc20, inc200) {
  assert.ok(inc20 <= 64 * MiB, `${label}: 20 MiB increment ${inc20} exceeds 64 MiB`);
  assert.ok(inc200 <= 64 * MiB, `${label}: 200 MiB increment ${inc200} exceeds 64 MiB`);
  const ceiling = Math.max(Math.max(inc20, 0) * 5, 4 * MiB);
  assert.ok(inc200 <= ceiling,
    `${label}: 200 MiB increment ${inc200} vs 20 MiB ${inc20} scales with file size (ceiling ${ceiling})`);
  console.log(`[issue #21] memory ${label}: 20 MiB +${Math.round(inc20 / 1024)} KiB, ` +
    `200 MiB +${Math.round(inc200 / 1024)} KiB (within 64 MiB, no 10x scaling)`);
}

it('20 vs 200 MiB operations keep incremental peak memory bounded on both ends (#21)', { skip: !profile, timeout: 900000 }, async () => {
  const { createWorkspaceRuntime } = await import('../build/services/workspace-runtime.js');
  const config = await loadWorkspaceConfig(profile);
  const sessionId = 'mem21-' + createHash('sha256').update(String(Date.now()) + 'm').digest('hex').slice(0, 12);
  const runtime = await createWorkspaceRuntime(profile);
  const { FileService } = await import('../build/services/file-service.js');
  const { TransferService } = await import('../build/services/transfer-service.js');
  const files = new FileService(runtime.remote, runtime.config);
  const transfers = new TransferService(runtime.remote, runtime.config, files);
  const digest = await helperDigest();
  const helperArg = posix.join(config.remoteStateDir, 'helpers', digest, 'agent.py');
  const measurerB64 = Buffer.from(MEASURER, 'utf8').toString('base64');
  const names = { 20: `mem21-${sessionId}-20.txt`, 200: `mem21-${sessionId}-200.txt` };
  const uploaded = { 20: `mem21-${sessionId}-20-up.txt`, 200: `mem21-${sessionId}-200-up.txt` };
  const localUploads = { 20: join(config.localRoot, `mem21-${sessionId}-20.bin`),
    200: join(config.localRoot, `mem21-${sessionId}-200.bin`) };
  const localDownloads = { 20: join(config.localRoot, `mem21-${sessionId}-20-dl.bin`),
    200: join(config.localRoot, `mem21-${sessionId}-200-dl.bin`) };
  const markerOf = { 20: null, 200: null };
  // Bookkeeping for the finally cleanup (review R10): every task record and
  // transfer registration this case creates is acknowledged afterwards so
  // the shared VM workspace is not polluted across runs.
  const jobIds = [];
  const drivenTransferIds = []; // transfers driven through the real TransferService
  const measuredTransferIds = []; // transfers the MEASURER registered directly

  /** Execute one remote measurement plan through the registered-task path. */
  const measureRemotely = async plan => {
    const planB64 = Buffer.from(JSON.stringify(plan), 'utf8').toString('base64');
    const command = `echo ${measurerB64} | base64 -d | python3 - '${helperArg}' ` +
      `'${config.remoteStateDir}' '${config.remoteRoot}' '${sessionId}' ${planB64}`;
    const registration = await runtime.remote.call('task_register', { protocol: 2,
      cwd: runtime.config.remoteRoot, command });
    jobIds.push(registration.jobId);
    await runtime.remote.call('task_start', { protocol: 2, jobId: registration.jobId });
    const deadline = Date.now() + 300000;
    for (;;) {
      const state = await runtime.remote.call('status', { jobId: registration.jobId });
      if (['exited', 'cancelled', 'interrupted'].includes(state.state)) {
        if (state.state !== 'exited' || state.exitCode !== 0) {
          const output = await runtime.remote.call('output', { jobId: registration.jobId });
          throw new Error('measurer failed: ' + JSON.stringify(state) + '\n' +
            Buffer.from(output.stderr.data, 'base64').toString('utf8').slice(0, 1200));
        }
        const output = await runtime.remote.call('output', { jobId: registration.jobId });
        const stdout = Buffer.from(output.stdout.data, 'base64').toString('utf8');
        const measured = JSON.parse(stdout.trim().split('\n').pop());
        if (measured.transferId) measuredTransferIds.push(measured.transferId);
        return measured;
      }
      if (Date.now() > deadline) throw new Error('measurer task did not finish: ' + JSON.stringify(state));
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  };

  const hashFile = async path => {
    const hash = createHash('sha256');
    const handle = await open(path, 'r');
    const buffer = Buffer.alloc(MiB);
    try {
      for (let offset = 0;;) {
        const read = await handle.read(buffer, 0, buffer.length, offset);
        if (!read.bytesRead) break;
        hash.update(buffer.subarray(0, read.bytesRead));
        offset += read.bytesRead;
      }
    } finally { await handle.close(); }
    return hash.digest('hex');
  };

  try {
    // Remote fixtures: fixed 64-byte line files with one unique marker row.
    for (const mib of [20, 200]) {
      const totalLines = (mib * MiB) / 64;
      const patchAt = Math.floor(totalLines / 2);
      const marker = ('M' + patchAt + ' UNIQUE-MARKER FOR EDIT MEASUREMENT').slice(0, 60);
      markerOf[mib] = marker;
      jobIds.push(await runTask(runtime,
        `python3 -c "f = open('${names[mib]}', 'wb'); ` +
        `[f.write((('${marker}' + 'x' * (63 - len('${marker}')) + chr(10)).encode('ascii')) if i == ${patchAt} else ` +
        `(('L%d ' % i).encode('ascii') + b'x' * (64 - len('L%d ' % i) - 1) + b'\\n')) for i in range(1, ${totalLines + 1})]; ` +
        `f.close()"`, 240000));
      const meta = await runtime.remote.call('file_read', { workspaceRoot: config.remoteRoot,
        sessionId, path: names[mib], metadataOnly: true });
      assert.equal(meta.size, mib * MiB, names[mib]);
    }

    // --- remote side: helper (incl. scan children) peak RSS ------------------
    const baseline = await measureRemotely({ kind: 'baseline', path: names[20] });
    const remote = { baseline: baseline.peakRssKb * 1024 };
    console.log('[issue #21] remote helper idle baseline peak RSS: %d KiB', baseline.peakRssKb);
    for (const mib of [20, 200]) {
      const patchAt = Math.floor(((mib * MiB) / 64) / 2);
      const marker = markerOf[mib];
      remote['read' + mib] = (await measureRemotely({ kind: 'read', path: names[mib],
        offset: Math.floor(mib * MiB / 2), maxBytes: MiB, encoding: 'base64' })).peakRssKb * 1024;
      remote['search' + mib] = (await measureRemotely({ kind: 'search', path: names[mib],
        pattern: 'UNIQUE-MARKER' })).peakRssKb * 1024;
      const edit = await measureRemotely({ kind: 'edit', path: names[mib],
        offset: (patchAt - 1) * 64, maxBytes: 4096,
        oldText: marker, newText: marker.replace('UNIQUE-MARKER', 'EDITED-BY-21!') });
      remote['edit' + mib] = edit.peakRssKb * 1024;
      assert.equal(edit.bytesWritten, mib * MiB, 'same-length edit kept the file size');
      const upload = await measureRemotely({ kind: 'upload', source: names[mib], path: uploaded[mib] });
      remote['upload' + mib] = upload.peakRssKb * 1024;
      assert.equal(upload.bytesWritten, mib * MiB);
      const download = await measureRemotely({ kind: 'download', path: uploaded[mib] });
      remote['download' + mib] = download.peakRssKb * 1024;
      assert.equal(download.received, mib * MiB);
    }
    for (const op of ['read', 'search', 'edit', 'upload', 'download']) {
      const inc20 = remote[op + '20'] - remote.baseline;
      const inc200 = remote[op + '200'] - remote.baseline;
      console.log(`[issue #21] remote ${op} peak RSS: 20 MiB ${Math.round(remote[op + '20'] / 1024)} KiB, ` +
        `200 MiB ${Math.round(remote[op + '200'] / 1024)} KiB (baseline ${Math.round(remote.baseline / 1024)} KiB)`);
      assertMemoryBudget('remote ' + op, inc20, inc200);
    }

    // --- local side: the real TransferService driver over SSH ----------------
    // A 256-byte-period tile so both ends can verify digests deterministically.
    const tile = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const tile1m = Buffer.concat(Array.from({ length: Math.floor(MiB / 256) }, () => tile));
    const digestOf = size => {
      const hash = createHash('sha256');
      for (let offset = 0; offset < size; offset += tile1m.length) {
        hash.update(tile1m.subarray(0, Math.min(tile1m.length, size - offset)));
      }
      return hash.digest('hex');
    };
    for (const mib of [20, 200]) {
      const handle = await open(localUploads[mib], 'wx', 0o600);
      try { for (let i = 0; i < mib; i++) await handle.writeFile(tile1m); await handle.sync(); }
      finally { await handle.close(); }
      assert.equal(await hashFile(localUploads[mib]), digestOf(mib * MiB), 'local fixture digest oracle');
    }
    const local = {};
    for (const mib of [20, 200]) {
      const size = mib * MiB;
      const up = await withMemorySampling(() => transfers.upload(sessionId,
        { localPath: localUploads[mib], path: uploaded[mib] + '.local.bin', budgetMs: 400000 }));
      assert.equal(up.result.state, 'completed', JSON.stringify(up.result));
      assert.equal(up.result.sha256, digestOf(size));
      drivenTransferIds.push(up.result.transferId);
      local['upload' + mib] = up;
      const down = await withMemorySampling(() => transfers.download(sessionId,
        { path: uploaded[mib] + '.local.bin', localPath: localDownloads[mib], budgetMs: 400000 }));
      assert.equal(down.result.state, 'completed', JSON.stringify(down.result));
      assert.equal(down.result.sha256, digestOf(size));
      assert.equal(await hashFile(localDownloads[mib]), digestOf(size));
      drivenTransferIds.push(down.result.transferId);
      local['download' + mib] = down;
    }
    for (const op of ['upload', 'download']) {
      assertMemoryBudget('local ' + op + ' rss', local[op + '20'].rssDelta, local[op + '200'].rssDelta);
      assertMemoryBudget('local ' + op + ' heap', local[op + '20'].heapDelta, local[op + '200'].heapDelta);
    }
    console.log('[issue #21] method: remote = getrusage(RUSAGE_CHILDREN).ru_maxrss (KiB) around the real helper ' +
      'processes spawned per plan, scan children fold into the same peak via wait4; local = process.memoryUsage() ' +
      'sampled every 50 ms while the real TransferService drove the transfer, baseline subtracted.');
  } finally {
    await runTask(runtime, `rm -f '${names[20]}' '${names[200]}' '${uploaded[20]}' '${uploaded[200]}' ` +
      `'${uploaded[20]}.local.bin' '${uploaded[200]}.local.bin'`)
      .then(jobId => jobIds.push(jobId)).catch(() => undefined);
    for (const target of [...Object.values(localUploads), ...Object.values(localDownloads)]) {
      await rm(target, { force: true }).catch(() => undefined);
    }
    // Cleanup last, all errors swallowed (review R10): acknowledge the
    // transfer registrations (local mirrors + remote records, including the
    // MEASURER's direct helper registrations) and every task record, so the
    // shared VM workspace does not accumulate reclaim-blocking residue like
    // the 125-task/35-transfer pollution seen in the wt21 workspace.
    for (const transferId of drivenTransferIds) {
      await transfers.acknowledge(sessionId, transferId).catch(() => undefined);
    }
    await ackRemoteTransfers(runtime, config, sessionId, measuredTransferIds);
    await ackJobs(runtime, jobIds);
    runtime.close();
  }
});

// ---------------------------------------------------------------------------
// Case 3: end-to-end crash recovery with a killed driver and torn half-blocks
// ---------------------------------------------------------------------------

const jobJsPath = () => fileURLToPath(new URL('../build/cli/job.js', import.meta.url));

/** Spawn the job CLI as its own process; used for kill-and-resume drills. */
function cliJob(args, session) {
  return spawn(process.execPath, [jobJsPath(), ...args, '--workspace', profile, '--session', session],
    { stdio: ['ignore', 'pipe', 'pipe'] });
}

const lastJsonPacket = text => {
  const packets = text.split(/\r?\n/).filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  assert.ok(packets.length, 'expected a JSON packet in: ' + text);
  return packets[packets.length - 1];
};

const collectOutput = child => {
  let out = '', err = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { err += chunk; });
  return { done: new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code, signal, out, err }));
  }) };
};

/** A 1 MiB tile whose bytes repeat with period 256; both ends can build it. */
const TILE_1M = Buffer.concat(Array.from({ length: 4096 },
  () => Buffer.from(Array.from({ length: 256 }, (_, i) => i))));
const tileDigest = size => {
  const hash = createHash('sha256');
  for (let offset = 0; offset < size; offset += TILE_1M.length) {
    hash.update(TILE_1M.subarray(0, Math.min(TILE_1M.length, size - offset)));
  }
  return hash.digest('hex');
};

it('killed local drivers and torn half-blocks recover with matching digests and bounded retransfer (#21)', { skip: !profile, timeout: 900000 }, async () => {
  const { createWorkspaceRuntime } = await import('../build/services/workspace-runtime.js');
  const config = await loadWorkspaceConfig(profile);
  const sessionId = 'rec21-' + createHash('sha256').update(String(Date.now()) + 'r').digest('hex').slice(0, 12);
  const runtime = await createWorkspaceRuntime(profile);
  const size = 128 * MiB;
  const chunk = MiB;
  const invokeSync = (...args) => {
    const run = spawnSync(process.execPath, [jobJsPath(), ...args,
      '--workspace', profile, '--session', sessionId], { encoding: 'utf8', timeout: 240000 });
    assert.equal(run.status, 0, run.stdout + '\n' + run.stderr);
    return lastJsonPacket(run.stdout);
  };
  const remoteName = `rec21-${sessionId}-src.bin`;
  const localPath = join(config.localRoot, `rec21-${sessionId}-dl.bin`);
  const uploadLocal = join(config.localRoot, `rec21-${sessionId}-up.bin`);
  const uploadRemote = `rec21-${sessionId}-up.bin`;
  // Cleanup bookkeeping (review R10): surfaced so the finally block can
  // acknowledge the transfers even when the drill fails midway, plus every
  // task record the case registers.
  let downloadId = null;
  let uploadId = null;
  const jobIds = [];
  const task = async (command, timeoutMs) => {
    const jobId = await runTask(runtime, command, timeoutMs);
    jobIds.push(jobId);
    return jobId;
  };
  const ackTransferQuiet = id => {
    if (!id) return;
    // A quiet CLI ack: cleanup must never fail the case (review R10).
    spawnSync(process.execPath, [jobJsPath(), 'transfer', 'ack', '--transfer-id', id,
      '--workspace', profile, '--session', sessionId], { encoding: 'utf8', timeout: 60000 });
  };

  try {
    // ================= download direction =================================
    const blocks = Math.floor(size / chunk);
    await task(`python3 -c "t = bytes(range(256)) * 4096; ` +
      `f = open('${remoteName}', 'wb'); [f.write(t) for _ in range(${blocks})]; f.close()"`, 240000);
    const expected = tileDigest(size);

    // Step 1: a separate process starts the transfer on a small budget and
    // stops partway with durable confirmed progress.
    const start = invokeSync('transfer', 'start', '--direction', 'download', '--remote', remoteName,
      '--local', localPath, '--budget', '3000');
    const transferId = start.transferId;
    downloadId = transferId;
    assert.ok(['transfer-started', 'transfer-result'].includes(start.kind), start.kind);
    const firstOffset = start.confirmedOffset;
    assert.ok(firstOffset > 0 && firstOffset < size, 'expected a partway stop, got ' + JSON.stringify(start));
    const tempPath = join(config.localRoot, '.ssh-mcp-download-' + transferId);

    // Step 2: inject the torn half-block a SIGKILL would leave behind -- the
    // receive temp grew past the confirmed offset but no block was recorded.
    await appendFile(tempPath, Buffer.alloc(400000, 0x6b));
    assert.ok((await stat(tempPath)).size > firstOffset, 'the torn tail exists');

    // Step 3: a fresh driver resumes; 1.5 s in, the local process is killed
    // exactly the way a host restart loses the waiter.
    const killed = cliJob(['transfer', 'resume', '--transfer-id', transferId, '--budget', '400000'], sessionId);
    const killedOut = collectOutput(killed);
    await new Promise(resolve => setTimeout(resolve, 1500));
    killed.kill('SIGKILL');
    assert.equal((await killedOut.done).signal, 'SIGKILL', 'the driver died to the kill, not on its own');
    // No formal target exists while the transfer is interrupted.
    assert.equal((await readdir(config.localRoot)).includes(basename(localPath)), false,
      'no half file may be published while interrupted');

    // Step 4: the replacement process resumes to completion.
    const beforeResume = invokeSync('transfer', 'status', '--transfer-id', transferId);
    const resumedAt = beforeResume.confirmedOffset;
    assert.ok(resumedAt >= firstOffset - chunk && resumedAt < size,
      `the healed boundary sits at or before the torn tail: ${resumedAt} vs ${firstOffset}`);
    const finished = invokeSync('transfer', 'resume', '--transfer-id', transferId, '--budget', '400000');
    assert.equal(finished.kind, 'transfer-result');
    assert.equal(finished.state, 'completed', JSON.stringify(finished));
    assert.equal(finished.sha256, expected, 'the end-to-end digest matches the independent oracle');
    assert.equal(finished.bytesWritten, size);
    const expectedRefetch = Math.ceil((size - resumedAt) / chunk);
    assert.ok(finished.blocksFetched <= expectedRefetch + 1,
      `resume fetched ${finished.blocksFetched} blocks but only ${expectedRefetch} (+1 incomplete) remained`);
    assert.equal((await readdir(config.localRoot)).includes(basename(tempPath)), false,
      'the receive temp is gone after the commit');
    // Replayed resumes observe; they never re-drive a settled transfer.
    const replay = invokeSync('transfer', 'resume', '--transfer-id', transferId);
    assert.equal(replay.state, 'completed');
    assert.equal(replay.blocksFetched ?? 0, 0, 'a settled transfer is never re-driven');
    assert.equal(await hashOf(localPath), expected, 'the published local file streams to the oracle digest');
    invokeSync('transfer', 'ack', '--transfer-id', transferId);
    console.log('[issue #21] 128 MiB download recovery: stopped at %d B, resumed after kill at %d B, refetched %d blocks (bound %d)',
      firstOffset, resumedAt, finished.blocksFetched, expectedRefetch + 1);

    // ================= upload direction ===================================
    const handle = await open(uploadLocal, 'wx', 0o600);
    try { for (let i = 0; i < size / chunk; i++) await handle.writeFile(TILE_1M); await handle.sync(); }
    finally { await handle.close(); }
    const uploadStart = invokeSync('transfer', 'start', '--direction', 'upload', '--remote', uploadRemote,
      '--local', uploadLocal, '--budget', '3000');
    assert.ok(['transfer-started', 'transfer-result'].includes(uploadStart.kind), uploadStart.kind);
    uploadId = uploadStart.transferId;
    const uploadFirst = uploadStart.confirmedOffset;
    assert.ok(uploadFirst > 0 && uploadFirst < size, 'expected a partway upload stop: ' + JSON.stringify(uploadStart));

    // Torn half-block on the remote end: corrupt 16 bytes inside the last
    // confirmed block AND leave unconfirmed trailing bytes in the temp. The
    // heal must rewind to the last trusted boundary and retransfer from there.
    await task(
      `python3 -c "p = '${config.remoteRoot}/.ssh-mcp-upload-${uploadId}'; ` +
      `f = open(p, 'r+b'); f.seek(${uploadFirst} - 512); d = f.read(16); ` +
      `f.seek(${uploadFirst} - 512); f.write(bytes(b ^ 0xff for b in d)); ` +
      `f.seek(${uploadFirst}); f.write(b'z' * 300000); f.close()"`);
    // No formal target exists while the upload is interrupted.
    await task(`test ! -e '${uploadRemote}'`);

    // Kill a resuming driver mid-flight, then let a fresh process finish.
    const killedUp = cliJob(['transfer', 'resume', '--transfer-id', uploadId, '--budget', '400000'], sessionId);
    const killedUpOut = collectOutput(killedUp);
    await new Promise(resolve => setTimeout(resolve, 1500));
    killedUp.kill('SIGKILL');
    assert.equal((await killedUpOut.done).signal, 'SIGKILL');
    const uploadBefore = invokeSync('transfer', 'status', '--transfer-id', uploadId);
    const uploadResumedAt = uploadBefore.confirmedOffset;
    assert.ok(uploadResumedAt >= uploadFirst - 2 * chunk && uploadResumedAt < size,
      `the post-heal boundary is a sane in-range checkpoint: ${uploadResumedAt} vs ${uploadFirst}`);
    // The corrupted block forced a heal rewind on the killed driver's resume;
    // the final completed digest below is the proof the rewind landed (a
    // trusted-but-corrupt block would have failed the whole-file verify).
    const uploadDone = invokeSync('transfer', 'resume', '--transfer-id', uploadId, '--budget', '400000');
    assert.equal(uploadDone.kind, 'transfer-result');
    assert.equal(uploadDone.state, 'completed', JSON.stringify(uploadDone));
    assert.equal(uploadDone.sha256, expected);
    const uploadRemaining = Math.ceil((size - uploadResumedAt) / chunk);
    assert.ok(uploadDone.blocksSent <= uploadRemaining + 1,
      `upload resume sent ${uploadDone.blocksSent} blocks but only ${uploadRemaining} (+1) remained`);
    await task(`sha256sum '${uploadRemote}' > '${uploadRemote}.sha256'`);
    const digestRead = await runtime.remote.call('file_read', { workspaceRoot: config.remoteRoot,
      sessionId, path: uploadRemote + '.sha256' });
    assert.equal(digestRead.text.trim().split(' ')[0], expected, 'the remote committed target matches');
    // The upload temp must be released once the commit has published it.
    await task(`test ! -e '.ssh-mcp-upload-${uploadId}'`);
    invokeSync('transfer', 'ack', '--transfer-id', uploadId);
    console.log('[issue #21] 128 MiB upload recovery: stopped at %d B, healed+resumed at %d B, resent %d blocks (bound %d)',
      uploadFirst, uploadResumedAt, uploadDone.blocksSent, uploadRemaining + 1);
  } finally {
    await rm(localPath, { force: true }).catch(() => undefined);
    await rm(uploadLocal, { force: true }).catch(() => undefined);
    // Fault-injection leftovers the drill may not have settled: the receive
    // temp of a download that never finished and the remote upload temp of a
    // drive that died before the heal (review R10).
    if (downloadId) {
      await rm(join(config.localRoot, '.ssh-mcp-download-' + downloadId), { force: true }).catch(() => undefined);
    }
    await runTask(runtime, `rm -f '${remoteName}' '${uploadRemote}' '${uploadRemote}.sha256'` +
      (uploadId ? ` '.ssh-mcp-upload-${uploadId}'` : ''))
      .then(jobId => jobIds.push(jobId)).catch(() => undefined);
    // Cleanup last, all errors swallowed (review R10): acknowledge both
    // transfers (even on a midway failure) and every task record so the
    // shared VM workspace is not polluted for later runs.
    ackTransferQuiet(downloadId);
    ackTransferQuiet(uploadId);
    await ackJobs(runtime, jobIds);
    runtime.close();
  }
});

/** Streamed SHA-256 of a local file (used by case 3 for the final oracle). */
async function hashOf(path) {
  const { createHash } = await import('node:crypto');
  const { open } = await import('node:fs/promises');
  const hash = createHash('sha256');
  const handle = await open(path, 'r');
  const buffer = Buffer.alloc(MiB);
  try {
    for (let offset = 0;;) {
      const read = await handle.read(buffer, 0, buffer.length, offset);
      if (!read.bytesRead) break;
      hash.update(buffer.subarray(0, read.bytesRead));
      offset += read.bytesRead;
    }
  } finally { await handle.close(); }
  return hash.digest('hex');
}

// Mechanism check (not VM-gated): the acceptance thresholds are real red
// lines -- violating inputs must throw, so a green VM run means the measured
// numbers actually satisfied the spec, not that the assertion is vacuous.
it('the memory budget assertion rejects violations (mechanism red check)', () => {
  const Mi = 1024 * 1024;
  // Over the absolute 64 MiB budget on the 200 MiB side.
  assert.throws(() => assertMemoryBudget('x', 1 * Mi, 100 * Mi), /exceeds 64 MiB/);
  // Over the absolute budget on the 20 MiB side.
  assert.throws(() => assertMemoryBudget('x', 70 * Mi, 80 * Mi), /exceeds 64 MiB/);
  // Near-10x scaling: 20 MiB +1 MiB must not grow to +60 MiB (ceiling 5 MiB).
  assert.throws(() => assertMemoryBudget('x', 1 * Mi, 60 * Mi), /scales with file size/);
  // Noise-floor passes: tiny increments on both sides stay within 4 MiB.
  assertMemoryBudget('x', 0, 3 * Mi);
  // A proportional small increase passes: +1 MiB -> +4 MiB stays under 5x.
  assertMemoryBudget('x', 1 * Mi, 4 * Mi);
  // Negative deltas (measurement noise) pass both gates.
  assertMemoryBudget('x', -512 * 1024, -256 * 1024);
});
