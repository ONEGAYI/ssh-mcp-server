import { it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import ssh2 from 'ssh2';
import { PassThrough } from 'node:stream';
import { SSHConnectionManager } from '../build/services/ssh-connection-manager.js';

it('sends helper input through stdin and returns separate streams without allocating a PTY', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const clients = new Set();
  let ptyRequests = 0;
  let received;
  const server = new ssh2.Server({ hostKeys: [privateKey] }, client => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('authentication', ctx => ctx.accept());
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('pty', accept => { ptyRequests++; accept(); });
      session.on('exec', (accept, reject, info) => {
        const stream = accept();
        if (info.command !== 'helper-probe') { stream.exit(0); stream.end(); return; }
        const chunks = [];
        stream.on('data', data => chunks.push(data));
        stream.on('end', () => {
          received = Buffer.concat(chunks).toString('utf8');
          stream.write('result α\n');
          stream.stderr.write('diagnostic\n');
          stream.exit(0);
          stream.end();
        });
      });
    }));
  });
  const manager = SSHConnectionManager.getInstance();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    manager.setConfig({ test: { host: '127.0.0.1', port: server.address().port, username: 'test', password: 'local-test-only' } });
    const result = await manager.executeInputCommand('helper-probe', Buffer.from('input 中文\n'), 'test');
    assert.equal(received, 'input 中文\n');
    assert.deepEqual(result, { stdout: 'result α\n', stderr: 'diagnostic\n', exitCode: 0, signal: undefined });
    assert.equal(ptyRequests, 0);
  } finally {
    manager.disconnect();
    for (const client of clients) client.end();
    await new Promise(resolve => server.close(resolve));
  }
});

it('classifies ordinary channel errors as retriable transport failures', async () => {
  const manager = SSHConnectionManager.getInstance();
  const original = manager.ensureConnected;
  const stream = new PassThrough();
  stream.stderr = new PassThrough();
  stream.close = () => {};
  manager.setConfig({ broken: { host: '127.0.0.1', port: 1, username: 'test', password: 'test-only' } });
  manager.ensureConnected = async () => ({ exec(command, options, callback) {
    callback(null, stream);
    queueMicrotask(() => stream.emit('error', new Error('channel interrupted')));
  } });
  try {
    await assert.rejects(manager.executeInputCommand('helper', Buffer.from('{}'), 'broken'), error => {
      assert.equal(error.retriable, true);
      assert.equal(error.code, 'COMMAND_EXECUTION_ERROR');
      return true;
    });
  } finally { manager.ensureConnected = original; stream.destroy(); stream.stderr.destroy(); }
});
