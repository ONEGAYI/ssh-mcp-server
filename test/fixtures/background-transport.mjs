// Isolate only the SSH boundary; exercise the real MCP, driver, CLI and filesystem.
import { readFile, writeFile, appendFile, mkdir, rename, open } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { RemoteAgentClient } from '../../build/services/remote-agent-client.js';

const root = process.env.SSH_MCP_BACKGROUND_FIXTURE;
if (process.env.SSH_MCP_BACKGROUND_INIT_FAILURE === '1' && process.argv[1].endsWith('transfer-worker.js')) {
  const profile = JSON.parse(await readFile(join(root, 'workspace.json'), 'utf8'));
  profile.connectionName = 'missing-connection';
  await writeFile(join(root, 'workspace.json'), JSON.stringify(profile));
}
const digest = data => createHash('sha256').update(data).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const stateFile = id => join(root, 'remote', id + '.json');
const binaryFile = id => join(root, 'remote', id + '.bin');
const save = record => writeFile(stateFile(record.transferId), JSON.stringify(record));
const load = async id => JSON.parse(await readFile(stateFile(id), 'utf8'));
const describe = record => ({ ...record, sha256: record.totalSha256 });
const missing = e => e.code === 'ENOENT';
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };

RemoteAgentClient.prototype.call = async function () { return { completed: true }; };
RemoteAgentClient.prototype.exchange = async function (action, input) {
  const split = input.indexOf(10);
  const request = JSON.parse(split < 0 ? input : input.subarray(0, split));
  await mkdir(join(root, 'remote'), { recursive: true });
  if (action === 'transfer_register') {
    await sleep(250);
    const id = request.transferId;
    assertId(id);
    let record;
    try { record = await load(id); }
    catch (e) {
      if (!missing(e)) throw e;
      const source = request.direction === 'download' ? await readFile(join(root, 'remote-source.bin')) : null;
      record = { ...request, state: 'prepared', confirmedOffset: 0,
        totalBytes: source ? source.length : request.totalBytes,
        totalSha256: source ? digest(source) : request.totalSha256, sourceVersion: 'm1-fixture' };
      await save(record);
      await appendFile(join(root, 'registrations.log'), id + '\n');
      if (process.env.SSH_MCP_BACKGROUND_LOST_REGISTER === '1') throw Object.assign(new Error('Lost registration response'), { code: 'COMMAND_TIMEOUT', retriable: true });
    }
    return describe(record);
  }
  const record = await load(request.transferId);
  if (action === 'transfer_status') return describe(record);
  if (action === 'transfer_start' || action === 'transfer_resume') {
    if (action === 'transfer_start' && process.env.SSH_MCP_BACKGROUND_LOST_START === '1' && !record.startFaultInjected) {
      record.startFaultInjected = true; await save(record);
      throw Object.assign(new Error('Start request was not executed'), { code: 'COMMAND_TIMEOUT', retriable: true });
    }
    if (action === 'transfer_resume' && record.state === 'prepared') throw Object.assign(new Error('Prepared transfer must start first'), { code: 'INVALID_STATE' });
    if (record.driverPid && record.driverPid !== process.pid && alive(record.driverPid)) throw new Error('Two simultaneous transfer drivers');
    record.driverPid = process.pid;
    if (record.state === 'prepared') record.state = 'transferring';
    await save(record);
    return describe(record);
  }
  if (action === 'transfer_block') {
    await sleep(120);
    const payload = input.subarray(split + 1);
    if (digest(payload) !== request.sha256 || request.offset !== record.confirmedOffset) throw new Error('Invalid block or duplicate writer');
    const handle = await open(binaryFile(record.transferId), record.confirmedOffset ? 'r+' : 'w');
    try { await handle.write(payload, 0, payload.length, request.offset); } finally { await handle.close(); }
    record.confirmedOffset += payload.length;
    await save(record);
    return { confirmedOffset: record.confirmedOffset };
  }
  if (action === 'transfer_verify') {
    if (record.direction === 'download' && process.env.SSH_MCP_BACKGROUND_LOST_VERIFY === '1' && !record.verifyFaultInjected) {
      record.verifyFaultInjected = true; await save(record);
      throw Object.assign(new Error('Verification response lost'), { code: 'COMMAND_TIMEOUT', retriable: true });
    }
    if (record.direction === 'upload' && digest(await readFile(binaryFile(record.transferId))) !== record.totalSha256) throw new Error('Whole-file mismatch');
    if (record.direction === 'download' && request.sha256 !== record.totalSha256) throw new Error('Receiver whole-file mismatch');
    return {};
  }
  if (action === 'transfer_commit') {
    if (record.direction === 'upload' && record.state !== 'completed') await rename(binaryFile(record.transferId), join(root, 'remote-target.bin'));
    record.state = 'completed';
    await save(record);
    return { path: '/work/target.bin', bytesWritten: record.totalBytes, sha256: record.totalSha256, committedAt: Date.now() / 1000 };
  }
  if (action === 'transfer_cancel') { if (record.state !== 'completed') record.state = 'cancelled'; await save(record); return describe(record); }
  if (action === 'transfer_ack') return { acknowledged: true, state: record.state };
  throw new Error('Unexpected transfer action: ' + action);
};
RemoteAgentClient.prototype.exchangeBinary = async function (action, input) {
  if (action !== 'transfer_fetch') throw new Error('Unexpected binary action');
  const request = JSON.parse(input);
  const record = await load(request.transferId);
  await sleep(120);
  const payload = (await readFile(join(root, 'remote-source.bin'))).subarray(request.offset, request.offset + request.size);
  record.confirmedOffset = request.offset + payload.length;
  await save(record);
  return { control: { index: request.index, offset: request.offset, sha256: digest(payload) }, payload,
    result: { confirmedOffset: record.confirmedOffset } };
};
function assertId(id) { if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('Registration did not preserve the local identifier'); }
