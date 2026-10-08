import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeTransferState, TransferStateWriteError } from '../build/services/transfer-state.js';

it('a locked state temporary file reports both its replacement and cleanup refusals', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-state-write-'));
  const target = join(root, 'record.json');
  const originalRename = fs.promises.rename, originalUnlink = fs.promises.unlink;
  try {
    await writeFile(target, JSON.stringify({ state: 'transferring', confirmedOffset: 3 }));
    fs.promises.rename = async (path, dest) => {
      if (dest !== target) return originalRename(path, dest);
      throw Object.assign(new Error('EPERM: rename blocked'), { code: 'EPERM', syscall: 'rename', path, dest });
    };
    fs.promises.unlink = async path => {
      if (!path.startsWith(target + '.')) return originalUnlink(path);
      throw Object.assign(new Error('EPERM: cleanup blocked'), { code: 'EPERM', syscall: 'unlink', path });
    };
    syncBuiltinESMExports();
    await assert.rejects(writeTransferState(target, { state: 'transferring', confirmedOffset: 4 }), error => {
      assert.ok(error instanceof TransferStateWriteError);
      assert.equal(error.syscall, 'rename');
      assert.equal(error.toJSON().cleanupError.code, 'EPERM');
      assert.equal(error.toJSON().cleanupError.syscall, 'unlink');
      return true;
    });
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { state: 'transferring', confirmedOffset: 3 });
  } finally {
    fs.promises.rename = originalRename; fs.promises.unlink = originalUnlink; syncBuiltinESMExports();
    await rm(root, { recursive: true });
  }
});

it('a transient Windows EBUSY replaces state atomically after the refusal clears', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-state-busy-'));
  const target = join(root, 'record.json');
  const originalRename = fs.promises.rename;
  let attempts = 0;
  try {
    await writeFile(target, '{"confirmedOffset":3}');
    fs.promises.rename = async (path, dest) => {
      if (dest === target && ++attempts === 1) throw Object.assign(new Error('busy'), { code: 'EBUSY', syscall: 'rename', path, dest });
      return originalRename(path, dest);
    };
    syncBuiltinESMExports();
    await writeTransferState(target, { confirmedOffset: 4 });
    assert.equal(attempts, 2);
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { confirmedOffset: 4 });
    assert.deepEqual(await readdir(root), ['record.json']);
  } finally { fs.promises.rename = originalRename; syncBuiltinESMExports(); await rm(root, { recursive: true }); }
});

it('an unrelated state-file EIO is not retried and preserves the old snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-state-eio-'));
  const target = join(root, 'record.json');
  const originalRename = fs.promises.rename;
  let attempts = 0;
  try {
    await writeFile(target, '{"confirmedOffset":3}');
    fs.promises.rename = async (path, dest) => {
      if (dest !== target) return originalRename(path, dest);
      attempts++;
      throw Object.assign(new Error('EIO'), { code: 'EIO', syscall: 'rename', path, dest });
    };
    syncBuiltinESMExports();
    await assert.rejects(writeTransferState(target, { confirmedOffset: 4 }), error => {
      assert.equal(error.code, 'EIO'); assert.equal(error.retriable, undefined); return true;
    });
    assert.equal(attempts, 1);
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { confirmedOffset: 3 });
    assert.deepEqual(await readdir(root), ['record.json']);
  } finally { fs.promises.rename = originalRename; syncBuiltinESMExports(); await rm(root, { recursive: true }); }
});
