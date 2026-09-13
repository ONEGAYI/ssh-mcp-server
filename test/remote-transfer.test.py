"""Ticket #13/#14 behavior tests: resumable verified transfers in both
directions, driven through the helper's public CLI (register/start/block/
fetch/verify/commit/status/resume). Runs on Linux (fcntl) with Python 3.6+."""
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest


HELPER = Path(__file__).resolve().parents[1] / 'remote' / 'agent.py'
CHUNK = 65536


class RemoteTransferTest(unittest.TestCase):
    def setUp(self):
        self.fixture = tempfile.TemporaryDirectory(prefix='ssh-mcp transfer ')
        self.root = Path(self.fixture.name)
        self.work = self.root / 'work'
        self.work.mkdir()

    def tearDown(self):
        self.fixture.cleanup()

    # --- helpers ---------------------------------------------------------------

    @property
    def state(self):
        return self.root / 'state'

    def call(self, action, request, session='session-one'):
        data = dict(request, workspaceRoot=str(self.work), sessionId=session)
        run = subprocess.run([sys.executable, str(HELPER), '--root', str(self.state), action],
                             input=json.dumps(data).encode('utf8'), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             timeout=30)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertTrue(run.stdout.startswith(b'SSH_MCP_V1 '), run.stdout)
        return json.loads(base64.b64decode(run.stdout.split(b' ', 1)[1]))

    def block(self, transfer_id, index, offset, data, checksum=None, session='session-one'):
        """One binary block exchange: a bounded JSON control line then raw bytes."""
        control = {'transferId': transfer_id, 'index': index, 'offset': offset,
                   'size': len(data), 'sha256': checksum or hashlib.sha256(data).hexdigest(),
                   'sessionId': session}
        payload = (json.dumps(control) + '\n').encode('utf8') + data
        run = subprocess.run([sys.executable, str(HELPER), '--root', str(self.state), 'transfer_block'],
                             input=payload, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertTrue(run.stdout.startswith(b'SSH_MCP_V1 '), run.stdout)
        return json.loads(base64.b64decode(run.stdout.split(b' ', 1)[1]))

    def source(self, size, mtime=1.0):
        return {'size': size, 'mtimeMs': mtime}

    def register(self, data, chunk=CHUNK, target='target.bin', mtime=1.0, **overrides):
        request = {'protocol': 2, 'direction': 'upload', 'targetPath': target,
                   'chunkSize': chunk, 'totalBytes': len(data),
                   'totalSha256': hashlib.sha256(data).hexdigest(),
                   'sourceIdentity': self.source(len(data), mtime),
                   'overwrite': False, 'create': False}
        request.update(overrides)
        return self.call('transfer_register', request)

    def start(self, transfer_id, mtime=1.0, size=None, record=None):
        if record is None:
            record = self.record(transfer_id)
        return self.call('transfer_start', {'protocol': 2, 'transferId': transfer_id,
                                            'sourceIdentity': self.source(record['totalBytes'] if size is None else size, mtime)})

    def record(self, transfer_id):
        return json.loads((self.state / 'transfers' / transfer_id / 'record.json').read_text())

    def chunks(self, transfer_id):
        path = self.state / 'transfers' / transfer_id / 'chunks.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines() if line]

    def temp_path(self, transfer_id, target='target.bin'):
        return self.work / ('.ssh-mcp-upload-' + transfer_id)

    def deliver(self, data, chunk=CHUNK, target='target.bin', **overrides):
        """Full happy path: register, start, all blocks, verify, commit."""
        registration = self.register(data, chunk=chunk, target=target, **overrides)
        self.assertTrue(registration['ok'], registration)
        transfer_id = registration['result']['transferId']
        started = self.start(transfer_id)
        self.assertTrue(started['ok'], started)
        for index, offset in enumerate(range(0, len(data), chunk)):
            sent = self.block(transfer_id, index, offset, data[offset:offset + chunk])
            self.assertTrue(sent['ok'], sent)
        verified = self.call('transfer_verify', {'transferId': transfer_id})
        self.assertTrue(verified['ok'], verified)
        committed = self.call('transfer_commit', {'transferId': transfer_id})
        self.assertTrue(committed['ok'], committed)
        return transfer_id, committed['result']

    # --- download direction helpers (issue #14) --------------------------------

    def dregister(self, data=None, source='source.bin', chunk=CHUNK, **overrides):
        """Register a download transfer over a fixture source file."""
        if data is not None:
            (self.work / source).write_bytes(data)
        request = {'protocol': 2, 'direction': 'download', 'sourcePath': source,
                   'chunkSize': chunk, 'overwrite': False, 'create': False,
                   'targetPath': 'C:/local/destination.bin'}
        request.update(overrides)
        return self.call('transfer_register', request)

    def dstart(self, transfer_id, source_version=None):
        if source_version is None:
            source_version = self.record(transfer_id)['sourceVersion']
        return self.call('transfer_start', {'protocol': 2, 'transferId': transfer_id,
                                            'sourceVersion': source_version})

    def fetch(self, transfer_id, index, offset, size, session='session-one'):
        """One framed fetch exchange; returns the raw stdout bytes."""
        control = json.dumps({'transferId': transfer_id, 'index': index, 'offset': offset,
                              'size': size, 'sessionId': session})
        run = subprocess.run([sys.executable, str(HELPER), '--root', str(self.state), 'transfer_fetch'],
                             input=(control + '\n').encode('utf8'), stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, timeout=30)
        self.assertEqual(run.returncode, 0, run.stderr)
        return run.stdout

    def parse_fetch(self, stdout):
        """Split the framed response: control line, exact bytes, envelope.

        Error paths carry no frame: the whole stdout is the envelope alone.
        """
        if stdout.startswith(b'SSH_MCP_V1 '):
            envelope = json.loads(base64.b64decode(stdout.split(b' ', 1)[1].strip()))
            return None, None, envelope
        self.assertTrue(stdout.startswith(b'{'), stdout[:80])
        head, remainder = stdout.split(b'\n', 1)
        control = json.loads(head.decode('utf8'))
        self.assertIn('size', control)
        payload = remainder[:control['size']]
        rest = remainder[control['size']:]
        self.assertTrue(rest.startswith(b'\n'), 'payload must be followed by a newline')
        envelope = json.loads(base64.b64decode(rest[1:].split(b' ', 1)[1].strip()))
        return control, payload, envelope

    def fetch_block(self, transfer_id, index, offset, data, session='session-one'):
        stdout = self.fetch(transfer_id, index, offset, len(data), session=session)
        return self.parse_fetch(stdout)

    def drain(self, transfer_id, data, chunk=CHUNK):
        """Fetch every remaining block; returns the receiver-side digest."""
        for offset in range(0, len(data), chunk):
            control, payload, envelope = self.fetch_block(
                transfer_id, offset // chunk, offset, data[offset:offset + chunk])
            self.assertTrue(envelope['ok'], envelope)
            self.assertEqual(payload, data[offset:offset + chunk])
        return hashlib.sha256(data).hexdigest()

    # --- registration and the register-then-execute protocol --------------------

    def test_register_persists_prepared_record_and_limits_active_transfers(self):
        data = b'hello transfer'
        registration = self.register(data)
        self.assertTrue(registration['ok'], registration)
        transfer_id = registration['result']['transferId']
        self.assertEqual(registration['result']['state'], 'prepared')
        self.assertEqual(registration['result']['confirmedOffset'], 0)
        record = self.record(transfer_id)
        self.assertEqual(record['state'], 'prepared')
        self.assertEqual(record['direction'], 'upload')
        self.assertEqual(record['chunkSize'], CHUNK)
        self.assertEqual(record['totalSha256'], hashlib.sha256(data).hexdigest())
        self.assertGreater(record['expiresAt'], record['registeredAt'])
        # At most two active transfers per workspace.
        second = self.register(b'second')
        third = self.register(b'third')
        self.assertTrue(second['ok'], second)
        self.assertEqual(third['ok'], False)
        self.assertEqual(third['error']['code'], 'TRANSFER_LIMIT_REACHED')
        # Completing the first registration frees the slot again.
        self.start(transfer_id)
        for index, offset in enumerate(range(0, len(data), CHUNK)):
            self.block(transfer_id, index, offset, data[offset:offset + CHUNK])
        self.call('transfer_verify', {'transferId': transfer_id})
        committed = self.call('transfer_commit', {'transferId': transfer_id})
        self.assertEqual(committed['result']['state'], 'completed')
        fourth = self.register(b'fourth', target='fourth.bin')
        self.assertTrue(fourth['ok'], fourth)

    def test_operations_on_unknown_identifiers_never_fall_back_to_creation(self):
        for action, request in (('transfer_start', {'sourceIdentity': self.source(1)}),
                                ('transfer_resume', {'sourceIdentity': self.source(1)}),
                                ('transfer_block', None),
                                ('transfer_verify', {}),
                                ('transfer_commit', {}),
                                ('transfer_status', {})):
            if action == 'transfer_block':
                response = self.block('f' * 32, 0, 0, b'data')
            else:
                response = self.call(action, dict(request, transferId='f' * 32, protocol=2))
            self.assertEqual(response['ok'], False, action)
            self.assertEqual(response['error']['code'], 'REQUEST_EXPIRED_OR_UNKNOWN', action)

    def test_register_rejects_invalid_parameters_and_targets(self):
        data = b'x' * 10
        cases = [
            ({'direction': 'sideways'}, 'INVALID_REQUEST'),
            ({'chunkSize': 1024}, 'INVALID_REQUEST'),
            ({'chunkSize': 'big'}, 'INVALID_REQUEST'),
            ({'totalBytes': 11}, 'INVALID_REQUEST'),
            ({'totalSha256': 'zz'}, 'INVALID_REQUEST'),
            ({'sourceIdentity': {'size': 'huge'}}, 'INVALID_REQUEST'),
            ({'sourceIdentity': None}, 'INVALID_REQUEST'),
            ({'overwrite': True}, 'INVALID_REQUEST'),
            ({'overwrite': True, 'create': True, 'expectedVersion': 'v'}, 'INVALID_REQUEST'),
            ({'expectedVersion': 'v'}, 'INVALID_REQUEST'),
            ({'targetPath': '../outside'}, 'PATH_NOT_ALLOWED'),
        ]
        for overrides, code in cases:
            response = self.register(data, **overrides)
            self.assertEqual(response['ok'], False, overrides)
            self.assertEqual(response['error']['code'], code, overrides)

    def test_register_early_checks_target_state_like_file_write(self):
        existing = self.work / 'existing.bin'
        existing.write_bytes(b'old content')
        # The create-only default refuses an existing target before any bytes move.
        refused = self.register(b'new content', target='existing.bin')
        self.assertEqual(refused['ok'], False)
        self.assertEqual(refused['error']['code'], 'FILE_CONFLICT')
        # Overwrite must bind the currently observed version.
        stale = self.register(b'new content', target='existing.bin', overwrite=True,
                              expectedVersion='m1-not-the-version')
        self.assertEqual(stale['error']['code'], 'FILE_CONFLICT')
        current = self.call('file_read', {'path': 'existing.bin', 'metadataOnly': True})
        self.assertTrue(current['ok'], current)
        accepted = self.register(b'new content', target='existing.bin', overwrite=True,
                                 expectedVersion=current['result']['version'])
        self.assertTrue(accepted['ok'], accepted)

    def test_protocol_version_is_required_for_creation(self):
        response = self.call('transfer_register', {'direction': 'upload', 'targetPath': 'x.bin',
                                                   'chunkSize': CHUNK, 'totalBytes': 1,
                                                   'totalSha256': hashlib.sha256(b'a').hexdigest(),
                                                   'sourceIdentity': self.source(1)})
        self.assertEqual(response['error']['code'], 'INVALID_PROTOCOL')

    # --- start, block exchange and confirmed offsets -----------------------------

    def test_start_is_idempotent_and_materializes_tracked_temp_file(self):
        data = b'z' * (CHUNK + 100)
        transfer_id = self.register(data)['result']['transferId']
        first = self.start(transfer_id)
        self.assertTrue(first['ok'], first)
        self.assertEqual(first['result']['state'], 'transferring')
        temp = self.temp_path(transfer_id)
        self.assertTrue(temp.exists())
        identity = temp.stat().st_ino
        # A repeated start observes instead of recreating.
        again = self.start(transfer_id)
        self.assertTrue(again['ok'], again)
        self.assertEqual(again['result']['state'], 'transferring')
        self.assertEqual(self.temp_path(transfer_id).stat().st_ino, identity)
        # The temp file is registered in the resource ledger before it exists.
        ledger = json.loads((self.state / 'ledger' / 'ledger.json').read_text())
        self.assertEqual(len(ledger['resources']), 1)
        resource = list(ledger['resources'].values())[0]
        self.assertEqual(resource['bytes'], len(data))

    def test_start_clears_its_own_crash_leftovers_before_materializing(self):
        # start 在 register_temp + O_EXCL 创建 temp 之后、保存 transferring
        # 之前崩溃会留下：账本残留登记 + 已存在 temp + record 仍 prepared。
        # 重试 start 必须清掉自己（tempPath 命名唯一属本事务，prepared 态
        # 从未接收任何块）的残留后再登记，而不是 O_EXCL 撞上旧文件裸崩。
        data = b'crash window'
        transfer_id = self.register(data)['result']['transferId']
        temp = self.temp_path(transfer_id)
        temp.write_bytes(b'')
        stale = self.call('resource_register', {'path': str(temp), 'bytes': len(data),
                                                'origin': 'transfer-upload'})['result']['resourceId']
        started = self.start(transfer_id)
        self.assertTrue(started['ok'], started)
        self.assertEqual(started['result']['state'], 'transferring')
        resources = json.loads((self.state / 'ledger' / 'ledger.json').read_text())['resources']
        self.assertEqual(len(resources), 1)
        self.assertNotIn(stale, resources)
        # 清理后传输照常完成。
        self.block(transfer_id, 0, 0, data)
        self.call('transfer_verify', {'transferId': transfer_id})
        committed = self.call('transfer_commit', {'transferId': transfer_id})
        self.assertTrue(committed['ok'], committed)
        self.assertEqual((self.work / 'target.bin').read_bytes(), data)

    def test_blocks_persist_verify_and_advance_the_confirmed_offset(self):
        data = bytes(range(256)) * 300  # 76800 bytes: one full chunk plus a short tail
        transfer_id = self.register(data)['result']['transferId']
        self.start(transfer_id)
        for index, offset in enumerate(range(0, len(data), CHUNK)):
            sent = self.block(transfer_id, index, offset, data[offset:offset + CHUNK])
            self.assertTrue(sent['ok'], sent)
            self.assertEqual(sent['result']['confirmedOffset'], offset + CHUNK if offset + CHUNK < len(data) else len(data))
        manifest = self.chunks(transfer_id)
        self.assertEqual(len(manifest), 2)
        self.assertEqual([entry['index'] for entry in manifest], [0, 1])
        self.assertEqual([entry['sha256'] for entry in manifest],
                         [hashlib.sha256(data[o:o + CHUNK]).hexdigest() for o in range(0, len(data), CHUNK)])
        self.assertEqual(self.temp_path(transfer_id).read_bytes(), data)

    def test_corrupt_or_misordered_blocks_never_advance_the_offset(self):
        data = b'A' * (CHUNK * 2)
        transfer_id = self.register(data)['result']['transferId']
        self.start(transfer_id)
        first = self.block(transfer_id, 0, 0, data[:CHUNK])
        self.assertTrue(first['ok'], first)
        # A corrupted checksum is refused and nothing is persisted.
        corrupt = self.block(transfer_id, 1, CHUNK, data[CHUNK:], checksum='0' * 64)
        self.assertEqual(corrupt['error']['code'], 'BLOCK_CHECKSUM_MISMATCH')
        self.assertEqual(len(self.chunks(transfer_id)), 1)
        self.assertEqual(self.temp_path(transfer_id).read_bytes(), data[:CHUNK])
        # Out-of-order, duplicate and short interior blocks are protocol errors.
        for control in ((2, CHUNK * 2, b'xx'), (0, 0, data[:CHUNK]), (1, CHUNK, b'too short')):
            index, offset, payload = control
            response = self.block(transfer_id, index, offset, payload)
            self.assertEqual(response['error']['code'], 'INVALID_REQUEST', control)
        self.assertEqual(self.record(transfer_id)['confirmedOffset'], CHUNK)

    def test_block_exchange_carries_raw_bytes_not_base64_json(self):
        # The receiving end must consume exactly `size` raw bytes after the
        # control line; a mismatched declared size fails the exchange loudly.
        data = b'\x00\xffbinary \n bytes' * 100
        transfer_id = self.register(data)['result']['transferId']
        self.start(transfer_id)
        control = json.dumps({'transferId': transfer_id, 'index': 0, 'offset': 0,
                              'size': len(data) + 5, 'sha256': hashlib.sha256(data).hexdigest(),
                              'sessionId': 'session-one'})
        run = subprocess.run([sys.executable, str(HELPER), '--root', str(self.state), 'transfer_block'],
                             input=(control + '\n').encode('utf8') + data, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, timeout=30)
        self.assertEqual(run.returncode, 0)
        envelope = json.loads(base64.b64decode(run.stdout.split(b' ', 1)[1]))
        self.assertEqual(envelope['ok'], False)
        self.assertEqual(envelope['error']['code'], 'INVALID_REQUEST')

    def test_source_identity_change_refuses_the_original_transfer(self):
        data = b'stable source'
        transfer_id = self.register(data, mtime=5.0)['result']['transferId']
        # Same size, different mtime: the registered transfer is refused.
        changed = self.start(transfer_id, mtime=9.5)
        self.assertEqual(changed['error']['code'], 'TRANSFER_SOURCE_CHANGED')
        matched = self.start(transfer_id, mtime=5.0)
        self.assertTrue(matched['ok'], matched)
        # A later resume with a changed source is also refused.
        resumed = self.call('transfer_resume', {'protocol': 2, 'transferId': transfer_id,
                                                'sourceIdentity': self.source(len(data), 7.0)})
        self.assertEqual(resumed['error']['code'], 'TRANSFER_SOURCE_CHANGED')

    # --- verify, commit and the completion receipt -------------------------------

    def test_verify_and_commit_create_the_target_atomically(self):
        data = os.urandom(CHUNK * 2 + 77)
        transfer_id, committed = self.deliver(data, target='created.bin')
        self.assertEqual(committed['state'], 'completed')
        self.assertEqual(committed['bytesWritten'], len(data))
        self.assertEqual(committed['sha256'], hashlib.sha256(data).hexdigest())
        self.assertEqual((self.work / 'created.bin').read_bytes(), data)
        self.assertFalse(self.temp_path(transfer_id, 'created.bin').exists())
        record = self.record(transfer_id)
        self.assertEqual(record['state'], 'completed')
        receipt = json.loads((self.state / 'transfers' / transfer_id / 'receipt.json').read_text())
        self.assertEqual(receipt['bytes'], len(data))
        # The committed target left the space measurement.
        ledger = json.loads((self.state / 'ledger' / 'ledger.json').read_text())
        self.assertEqual(ledger['resources'], {})

    def test_verify_refuses_incomplete_or_mismatched_content(self):
        data = b'v' * (CHUNK + 10)
        transfer_id = self.register(data)['result']['transferId']
        self.start(transfer_id)
        self.block(transfer_id, 0, 0, data[:CHUNK])
        early = self.call('transfer_verify', {'transferId': transfer_id})
        self.assertEqual(early['error']['code'], 'INVALID_STATE')
        self.block(transfer_id, 1, CHUNK, data[CHUNK:])
        # Tamper with persisted-but-confirmed data: the whole-file digest fails.
        with self.temp_path(transfer_id).open('r+b') as stream:
            stream.seek(5)
            stream.write(b'X')
        verified = self.call('transfer_verify', {'transferId': transfer_id})
        self.assertEqual(verified['error']['code'], 'VERIFY_MISMATCH')
        record = self.record(transfer_id)
        self.assertEqual(record['state'], 'failed')
        # A failed transfer does not resurrect through resume.
        resumed = self.call('transfer_resume', {'protocol': 2, 'transferId': transfer_id,
                                                'sourceIdentity': self.source(len(data))})
        self.assertEqual(resumed['result']['state'], 'failed')

    def test_commit_requires_verifying_state_and_rechecks_target_versions(self):
        data = b'commit checks'
        transfer_id = self.register(data)['result']['transferId']
        self.start(transfer_id)
        self.block(transfer_id, 0, 0, data)
        premature = self.call('transfer_commit', {'transferId': transfer_id})
        self.assertEqual(premature['error']['code'], 'INVALID_STATE')
        self.call('transfer_verify', {'transferId': transfer_id})
        # Replace the target between registration and commit: refusal, no overwrite.
        (self.work / 'target.bin').write_bytes(b'externally rewritten')
        committed = self.call('transfer_commit', {'transferId': transfer_id})
        self.assertEqual(committed['error']['code'], 'FILE_CONFLICT')
        self.assertEqual((self.work / 'target.bin').read_bytes(), b'externally rewritten')
        self.assertEqual(self.record(transfer_id)['state'], 'failed')

    def test_commit_overwrite_binds_the_observed_version_and_preserves_mode(self):
        target = self.work / 'mode.bin'
        target.write_bytes(b'original content')
        os.chmod(str(target), 0o640)
        observed = self.call('file_read', {'path': 'mode.bin', 'metadataOnly': True})['result']['version']
        data = b'replacement content'
        transfer_id, committed = self.deliver(data, target='mode.bin', overwrite=True, expectedVersion=observed)
        self.assertEqual(target.read_bytes(), data)
        self.assertEqual(oct(os.stat(str(target)).st_mode & 0o777), oct(0o640))

    def test_lost_commit_response_reconciles_by_identity_not_by_content(self):
        data = b'reconcile me'
        transfer_id, committed = self.deliver(data)
        self.assertEqual(committed['state'], 'completed')
        # Simulate a lost response: the receipt is gone while the intent exists.
        (self.state / 'transfers' / transfer_id / 'receipt.json').unlink()
        reconciled = self.call('transfer_commit', {'transferId': transfer_id})
        self.assertTrue(reconciled['ok'], reconciled)
        self.assertEqual(reconciled['result']['state'], 'completed')
        self.assertTrue((self.state / 'transfers' / transfer_id / 'receipt.json').exists())
        # An externally replaced target (new inode) with identical content is
        # NOT proof of our commit: the outcome stays unknown.
        (self.state / 'transfers' / transfer_id / 'receipt.json').unlink()
        target = self.work / 'target.bin'
        target.unlink()
        # The freshly freed inode is consumed first, so the recreation below
        # really is a different object.
        (self.work / '.inode-cushion').write_bytes(b'cushion')
        target.write_bytes(data)  # same bytes, different inode
        self.assertEqual(self.call('transfer_commit', {'transferId': transfer_id})['error']['code'],
                         'TRANSFER_STATE_UNKNOWN')
        # The same inode rewritten with different content is not our commit either.
        second_id, _ = self.deliver(b'second payload', target='other.bin')
        other = self.work / 'other.bin'
        with other.open('r+b') as stream:  # in-place rewrite keeps the inode
            stream.write(b'X' * 13)
        (self.state / 'transfers' / second_id / 'receipt.json').unlink()
        self.assertEqual(self.call('transfer_commit', {'transferId': second_id})['error']['code'],
                         'TRANSFER_STATE_UNKNOWN')

    def test_reconciliation_success_releases_the_ledger_resource(self):
        # 对账成功（rename 已发生、receipt 丢失）补 receipt 的路径同样要
        # 释放账本资源：否则 totalBytes 量级的登记永久留在 resources 里，
        # 配额永久泄漏（正常发布路径有 release，这里曾缺失）。
        data = b'reconcile release'
        transfer_id = self.register(data)['result']['transferId']
        self.start(transfer_id)
        self.block(transfer_id, 0, 0, data)
        self.call('transfer_verify', {'transferId': transfer_id})
        # 模拟崩溃窗口：rename 已发布、intent 已持久化、receipt 未写、
        # state 停在 committing。
        temp = self.temp_path(transfer_id)
        info = temp.stat()
        intent = {'schemaVersion': 1, 'targetPath': str(self.work / 'target.bin'),
                  'expectedVersion': None, 'overwrite': False, 'create': False,
                  'tempIdentity': '{}:{}'.format(info.st_dev, info.st_ino),
                  'totalSha256': hashlib.sha256(data).hexdigest(), 'totalBytes': len(data),
                  'plannedAt': time.time()}
        directory = self.state / 'transfers' / transfer_id
        (directory / 'intent.json').write_text(json.dumps(intent))
        record = self.record(transfer_id)
        record['state'] = 'committing'
        (directory / 'record.json').write_text(json.dumps(record))
        os.replace(str(temp), str(self.work / 'target.bin'))
        resources = json.loads((self.state / 'ledger' / 'ledger.json').read_text())['resources']
        self.assertEqual(len(resources), 1)
        committed = self.call('transfer_commit', {'transferId': transfer_id})
        self.assertTrue(committed['ok'], committed)
        self.assertEqual(committed['result']['state'], 'completed')
        resources = json.loads((self.state / 'ledger' / 'ledger.json').read_text())['resources']
        self.assertEqual(resources, {})

    def test_commit_on_vanished_overwrite_target_records_failed(self):
        # 发布段的 OSError（如 overwrite 目标被外部删除）必须落 failed
        # 留痕并转成 FILE_CONFLICT，而不是裸抛 HELPER_ERROR 把 state 卡死
        # 在 committing（重试永远 TRANSFER_STATE_UNKNOWN）。
        target = self.work / 'vanish.bin'
        target.write_bytes(b'original')
        observed = self.call('file_read', {'path': 'vanish.bin', 'metadataOnly': True})['result']['version']
        data = b'replacement'
        transfer_id = self.register(data, target='vanish.bin', overwrite=True,
                                    expectedVersion=observed)['result']['transferId']
        self.start(transfer_id)
        self.block(transfer_id, 0, 0, data)
        self.call('transfer_verify', {'transferId': transfer_id})
        target.unlink()  # commit 前目标被外部删除
        committed = self.call('transfer_commit', {'transferId': transfer_id})
        self.assertEqual(committed['error']['code'], 'FILE_CONFLICT')
        record = self.record(transfer_id)
        self.assertEqual(record['state'], 'failed')
        self.assertEqual(record['error']['code'], 'FILE_CONFLICT')
        # failed 留痕后重试得到明确的 INVALID_STATE，不再无限循环。
        again = self.call('transfer_commit', {'transferId': transfer_id})
        self.assertEqual(again['error']['code'], 'INVALID_STATE')

    def test_commit_post_publish_failure_keeps_committing_and_reconciles(self):
        # rename 已生效后的目录 fsync 失败不得报成"未生效"：状态留在
        # committing（重试走对象身份对账补回执并释放账本），错误码
        # COMMITTED_UNCONFIRMED 与 files.py 的 publish 语义对称。
        sys.path.insert(0, str(HELPER.parent))
        import errno as errno_module
        from unittest import mock
        import files as files_module
        import transfer as transfer_module
        try:
            data = b'post-publish-failure'
            transfer_id = self.register(data)['result']['transferId']
            self.start(transfer_id)
            self.block(transfer_id, 0, 0, data)
            self.call('transfer_verify', {'transferId': transfer_id})
            request = {'transferId': transfer_id, 'workspaceRoot': str(self.work), 'sessionId': 'session-one'}
            with mock.patch.object(files_module, 'sync_directory',
                                   side_effect=OSError(errno_module.ENOSPC, 'disk full')):
                with self.assertRaises(transfer_module.AgentError) as caught:
                    transfer_module.commit(self.state, dict(request))
            self.assertEqual(caught.exception.code, 'COMMITTED_UNCONFIRMED')
            # The rename already took effect: the target carries the verified content.
            self.assertEqual((self.work / 'target.bin').read_bytes(), data)
            # Not failed: the state stays committing so a retry reconciles.
            self.assertEqual(self.record(transfer_id)['state'], 'committing')
            reconciled = self.call('transfer_commit', {'transferId': transfer_id})
            self.assertTrue(reconciled['ok'], reconciled)
            self.assertEqual(reconciled['result']['state'], 'completed')
            self.assertTrue((self.state / 'transfers' / transfer_id / 'receipt.json').is_file())
        finally:
            sys.path.remove(str(HELPER.parent))

    def test_commit_is_idempotent_after_completion(self):
        data = b'idempotent'
        transfer_id, first = self.deliver(data)
        again = self.call('transfer_commit', {'transferId': transfer_id})
        self.assertTrue(again['ok'], again)
        self.assertEqual(again['result']['state'], 'completed')
        self.assertEqual(again['result']['bytesWritten'], first['bytesWritten'])

    # --- resume: verify persisted chunks and heal corruption ---------------------

    def test_resume_rereads_persisted_chunks_and_keeps_only_trusted_prefix(self):
        data = bytes((index * 7) % 256 for index in range(CHUNK * 3 + 5))
        transfer_id = self.register(data)['result']['transferId']
        self.start(transfer_id)
        for offset in range(0, CHUNK * 2, CHUNK):
            self.block(transfer_id, offset // CHUNK, offset, data[offset:offset + CHUNK])
        # Corrupt persisted confirmed data (simulating torn writes).
        with self.temp_path(transfer_id).open('r+b') as stream:
            stream.seek(CHUNK + 100)
            stream.write(b'corruption')
        resumed = self.call('transfer_resume', {'protocol': 2, 'transferId': transfer_id,
                                                'sourceIdentity': self.source(len(data))})
        self.assertTrue(resumed['ok'], resumed)
        # The damage rewinds to the last trusted boundary: the first chunk.
        self.assertEqual(resumed['result']['confirmedOffset'], CHUNK)
        self.assertEqual(len(self.chunks(transfer_id)), 1)
        # Completing from there yields byte-identical content.
        for offset in range(CHUNK, len(data), CHUNK):
            self.block(transfer_id, offset // CHUNK, offset, data[offset:offset + CHUNK])
        self.call('transfer_verify', {'transferId': transfer_id})
        committed = self.call('transfer_commit', {'transferId': transfer_id})
        self.assertTrue(committed['ok'], committed)
        self.assertEqual((self.work / 'target.bin').read_bytes(), data)

    def test_resume_shrinks_a_manifest_that_outran_the_temp_file(self):
        data = b'y' * (CHUNK * 2)
        transfer_id = self.register(data)['result']['transferId']
        self.start(transfer_id)
        self.block(transfer_id, 0, 0, data[:CHUNK])
        self.block(transfer_id, 1, CHUNK, data[CHUNK:])
        # The temp file lost its tail (crash before flush).
        with self.temp_path(transfer_id).open('r+b') as stream:
            stream.truncate(CHUNK + 10)
        resumed = self.call('transfer_resume', {'protocol': 2, 'transferId': transfer_id,
                                                'sourceIdentity': self.source(len(data))})
        self.assertEqual(resumed['result']['confirmedOffset'], CHUNK)
        self.assertEqual(self.temp_path(transfer_id).stat().st_size, CHUNK)

    def test_resume_after_full_confirmation_keeps_a_short_tail_intact(self):
        # 短尾块传输（totalBytes 非 chunkSize 整除）全部确认后断线，resume
        # 不得把可信偏移当作“满块数 × chunkSize”：那会零扩展 temp 并让
        # verify 永远尺寸不符。
        data = b't' * (CHUNK + 10)  # 块0：65536 字节满块；块1：10 字节短块
        transfer_id = self.register(data)['result']['transferId']
        self.start(transfer_id)
        self.block(transfer_id, 0, 0, data[:CHUNK])
        self.block(transfer_id, 1, CHUNK, data[CHUNK:])
        resumed = self.call('transfer_resume', {'protocol': 2, 'transferId': transfer_id,
                                                'sourceIdentity': self.source(len(data))})
        self.assertTrue(resumed['ok'], resumed)
        self.assertEqual(resumed['result']['confirmedOffset'], len(data))
        self.assertEqual(resumed['result']['chunkCount'], 2)
        self.assertEqual(self.temp_path(transfer_id).stat().st_size, len(data))
        verified = self.call('transfer_verify', {'transferId': transfer_id})
        self.assertTrue(verified['ok'], verified)
        committed = self.call('transfer_commit', {'transferId': transfer_id})
        self.assertTrue(committed['ok'], committed)
        self.assertEqual((self.work / 'target.bin').read_bytes(), data)

    def test_resume_tolerates_a_torn_manifest_tail(self):
        # 进程在 manifest 行追加中途被杀会留下撕裂半行：resume 必须把它
        # 视为清单结束并回到可信边界，而不是裸抛 JSON 解析错误。
        data = b'x' * (CHUNK + 10)
        transfer_id = self.register(data)['result']['transferId']
        self.start(transfer_id)
        self.block(transfer_id, 0, 0, data[:CHUNK])
        with (self.state / 'transfers' / transfer_id / 'chunks.jsonl').open('a') as stream:
            stream.write('{"ind')  # 崩溃留下的撕裂片段
        resumed = self.call('transfer_resume', {'protocol': 2, 'transferId': transfer_id,
                                                'sourceIdentity': self.source(len(data))})
        self.assertTrue(resumed['ok'], resumed)
        self.assertEqual(resumed['result']['confirmedOffset'], CHUNK)
        self.assertEqual(resumed['result']['chunkCount'], 1)
        # 半行之后追加的块会与撕裂行粘连成不可解析的行，同样不可信：
        # resume 回退到块0，重传即可完成。
        self.block(transfer_id, 1, CHUNK, data[CHUNK:])
        healed = self.call('transfer_resume', {'protocol': 2, 'transferId': transfer_id,
                                               'sourceIdentity': self.source(len(data))})
        self.assertTrue(healed['ok'], healed)
        self.assertEqual(healed['result']['confirmedOffset'], CHUNK)
        self.assertEqual(len(self.chunks(transfer_id)), 1)
        self.assertEqual(self.temp_path(transfer_id).stat().st_size, CHUNK)
        self.block(transfer_id, 1, CHUNK, data[CHUNK:])
        self.call('transfer_verify', {'transferId': transfer_id})
        committed = self.call('transfer_commit', {'transferId': transfer_id})
        self.assertTrue(committed['ok'], committed)
        self.assertEqual((self.work / 'target.bin').read_bytes(), data)

    def test_resume_refuses_prepared_transfers_that_never_started(self):
        transfer_id = self.register(b'never started')['result']['transferId']
        response = self.call('transfer_resume', {'protocol': 2, 'transferId': transfer_id,
                                                 'sourceIdentity': self.source(13)})
        self.assertEqual(response['error']['code'], 'INVALID_STATE')

    def test_resume_recreates_a_deleted_temp_file_from_scratch(self):
        data = b'restart from zero'
        transfer_id = self.register(data)['result']['transferId']
        self.start(transfer_id)
        self.block(transfer_id, 0, 0, data)
        self.temp_path(transfer_id).unlink()
        resumed = self.call('transfer_resume', {'protocol': 2, 'transferId': transfer_id,
                                                'sourceIdentity': self.source(len(data))})
        self.assertTrue(resumed['ok'], resumed)
        self.assertEqual(resumed['result']['confirmedOffset'], 0)
        sent = self.block(transfer_id, 0, 0, data)
        self.assertTrue(sent['ok'], sent)

    # --- status: bounded, read-only, non-renewing ---------------------------------

    def test_actions_reject_a_foreign_session(self):
        # 会话归属不只由 receive_block 核对：start/resume/verify/commit/
        # status（含 verify/commit 的幂等分支）都必须核对 sessionId。
        data = b'session bound'
        transfer_id = self.register(data)['result']['transferId']
        self.start(transfer_id)
        self.block(transfer_id, 0, 0, data)
        self.call('transfer_verify', {'transferId': transfer_id})
        cases = (('transfer_start', {'protocol': 2, 'transferId': transfer_id,
                                     'sourceIdentity': self.source(len(data))}),
                 ('transfer_resume', {'protocol': 2, 'transferId': transfer_id,
                                      'sourceIdentity': self.source(len(data))}),
                 ('transfer_verify', {'transferId': transfer_id}),
                 ('transfer_commit', {'transferId': transfer_id}),
                 ('transfer_status', {'transferId': transfer_id}))
        for action, request in cases:
            response = self.call(action, request, session='session-other')
            self.assertEqual(response['ok'], False, action)
            self.assertEqual(response['error']['code'], 'TRANSFER_SCOPE_MISMATCH', action)
        # 正确会话不受影响，传输照常完成。
        committed = self.call('transfer_commit', {'transferId': transfer_id})
        self.assertTrue(committed['ok'], committed)
        self.assertEqual(committed['result']['state'], 'completed')

    def test_status_reports_bounded_state_without_renewal(self):
        data = b'status probe'
        transfer_id = self.register(data)['result']['transferId']
        self.start(transfer_id)
        before = self.record(transfer_id)
        self.assertIsNone(before['lastProgressAt'])  # no progress yet, nothing to renew
        status = self.call('transfer_status', {'transferId': transfer_id})
        self.assertTrue(status['ok'], status)
        self.assertEqual(status['result']['state'], 'transferring')
        self.assertEqual(status['result']['confirmedOffset'], 0)
        self.assertEqual(status['result']['totalBytes'], len(data))
        self.assertNotIn('chunks', status['result'])
        after = self.record(transfer_id)
        self.assertEqual(after['expiresAt'], before['expiresAt'])
        # Real progress advances both progressed-at and the expiry horizon.
        self.block(transfer_id, 0, 0, data)
        moved = self.record(transfer_id)
        self.assertGreater(moved['lastProgressAt'], before['registeredAt'])
        self.assertGreater(moved['expiresAt'], before['expiresAt'])
        # And a status query after progress still renews nothing.
        self.call('transfer_status', {'transferId': transfer_id})
        self.assertEqual(self.record(transfer_id)['expiresAt'], moved['expiresAt'])

    # --- lifecycle edges ----------------------------------------------------------

    def test_quota_is_enforced_when_the_temp_materializes(self):
        directory = self.state / 'ledger'
        directory.mkdir(parents=True, exist_ok=True)
        (directory / 'policy.json').write_text(json.dumps({'spaceLimitBytes': 4096}))
        transfer_id = self.register(b'z' * 8192)['result']['transferId']
        started = self.start(transfer_id)
        self.assertEqual(started['error']['code'], 'WORKSPACE_QUOTA_EXCEEDED')
        self.assertFalse(self.temp_path(transfer_id).exists())
        # The failed start left the record observable for retry or expiry.
        self.assertEqual(self.record(transfer_id)['state'], 'prepared')

    # --- issue #15: explicit cancellation ---------------------------------------

    def test_cancel_stops_an_upload_and_releases_its_temp_data(self):
        data = b'c' * (CHUNK + 20)
        transfer_id = self.register(data)['result']['transferId']
        self.start(transfer_id)
        self.block(transfer_id, 0, 0, data[:CHUNK])
        cancelled = self.call('transfer_cancel', {'transferId': transfer_id})
        self.assertTrue(cancelled['ok'], cancelled)
        self.assertEqual(cancelled['result']['state'], 'cancelled')
        # 取消即释放：未提交临时数据立即删除，账本登记随之消失。
        self.assertFalse(self.temp_path(transfer_id).exists())
        ledger = json.loads((self.state / 'ledger' / 'ledger.json').read_text())
        self.assertEqual(ledger['resources'], {})
        # 已停止的传输不再接收块，也不经 resume 复活。
        refused = self.block(transfer_id, 1, CHUNK, data[CHUNK:])
        self.assertEqual(refused['error']['code'], 'INVALID_STATE')
        resumed = self.call('transfer_resume', {'protocol': 2, 'transferId': transfer_id,
                                                'sourceIdentity': self.source(len(data))})
        self.assertEqual(resumed['result']['state'], 'cancelled')
        # 活动槽已释放：可以注册新传输。
        fresh = self.register(b'fresh', target='fresh.bin')
        self.assertTrue(fresh['ok'], fresh)

    def test_cancel_is_idempotent_and_never_rolls_back_committed_targets(self):
        data = b'already committed'
        transfer_id, committed = self.deliver(data, target='committed.bin')
        # 取消请求不能否定已完成的提交：状态保持 completed，目标不回滚。
        cancelled = self.call('transfer_cancel', {'transferId': transfer_id})
        self.assertTrue(cancelled['ok'], cancelled)
        self.assertEqual(cancelled['result']['state'], 'completed')
        self.assertEqual((self.work / 'committed.bin').read_bytes(), data)
        again = self.call('transfer_cancel', {'transferId': transfer_id})
        self.assertEqual(again['result']['state'], 'completed')
        # failed 与已取消的传输重复取消同样幂等观察。
        failed_id = self.register(b'will fail', target='fail.bin')['result']['transferId']
        self.start(failed_id)
        self.block(failed_id, 0, 0, b'will fail')
        with self.temp_path(failed_id).open('r+b') as stream:
            stream.write(b'X')
        self.call('transfer_verify', {'transferId': failed_id})
        self.assertEqual(self.call('transfer_cancel', {'transferId': failed_id})['result']['state'],
                         'failed')

    def test_cancel_in_the_commit_window_reconciles_by_evidence(self):
        # 场景一：rename 已发生（发布完成）但 receipt 丢失——取消必须按
        # intent 身份+摘要证据认账为 completed，而不是回滚已提交目标。
        data = b'published before cancel'
        transfer_id = self.register(data)['result']['transferId']
        self.start(transfer_id)
        self.block(transfer_id, 0, 0, data)
        self.call('transfer_verify', {'transferId': transfer_id})
        temp = self.temp_path(transfer_id)
        info = temp.stat()
        intent = {'schemaVersion': 1, 'targetPath': str(self.work / 'target.bin'),
                  'expectedVersion': None, 'overwrite': False, 'create': False,
                  'tempIdentity': '{}:{}'.format(info.st_dev, info.st_ino),
                  'totalSha256': hashlib.sha256(data).hexdigest(), 'totalBytes': len(data),
                  'plannedAt': time.time()}
        directory = self.state / 'transfers' / transfer_id
        (directory / 'intent.json').write_text(json.dumps(intent))
        record = self.record(transfer_id)
        record['state'] = 'committing'
        (directory / 'record.json').write_text(json.dumps(record))
        os.replace(str(temp), str(self.work / 'target.bin'))
        reconciled = self.call('transfer_cancel', {'transferId': transfer_id})
        self.assertTrue(reconciled['ok'], reconciled)
        self.assertEqual(reconciled['result']['state'], 'completed')
        self.assertEqual((self.work / 'target.bin').read_bytes(), data)
        self.assertTrue((directory / 'receipt.json').exists())
        # 场景二：intent 已持久化但发布从未发生（temp 还在）——持锁观察即
        # 证明提交无法再启动，取消安全：删 temp、置 cancelled。
        second = self.register(data, target='late.bin')['result']['transferId']
        self.start(second)
        self.block(second, 0, 0, data)
        self.call('transfer_verify', {'transferId': second})
        temp = self.temp_path(second)
        info = temp.stat()
        directory = self.state / 'transfers' / second
        (directory / 'intent.json').write_text(json.dumps(dict(intent, targetPath=str(self.work / 'late.bin'),
                                                              tempIdentity='{}:{}'.format(info.st_dev, info.st_ino))))
        record = self.record(second)
        record['state'] = 'committing'
        (directory / 'record.json').write_text(json.dumps(record))
        stopped = self.call('transfer_cancel', {'transferId': second})
        self.assertTrue(stopped['ok'], stopped)
        self.assertEqual(stopped['result']['state'], 'cancelled')
        self.assertFalse(temp.exists())
        self.assertFalse((self.work / 'late.bin').exists())

    def test_cancel_rejects_foreign_sessions_and_unknown_identifiers(self):
        data = b'scoped cancel'
        transfer_id = self.register(data)['result']['transferId']
        self.start(transfer_id)
        foreign = self.call('transfer_cancel', {'transferId': transfer_id}, session='session-other')
        self.assertEqual(foreign['error']['code'], 'TRANSFER_SCOPE_MISMATCH')
        unknown = self.call('transfer_cancel', {'transferId': 'f' * 32})
        self.assertEqual(unknown['error']['code'], 'REQUEST_EXPIRED_OR_UNKNOWN')
        # 取消从未启动的（prepared）登记同样成立：无临时数据，直接终态。
        quiet = self.register(b'never started', target='quiet.bin')['result']['transferId']
        early = self.call('transfer_cancel', {'transferId': quiet})
        self.assertEqual(early['result']['state'], 'cancelled')

    # --- issue #15: acknowledgement ----------------------------------------------

    def test_ack_requires_a_terminal_state_and_is_idempotent(self):
        data = b'ack me'
        transfer_id = self.register(data)['result']['transferId']
        self.start(transfer_id)
        # 传输进行中不允许确认。
        premature = self.call('transfer_ack', {'transferId': transfer_id})
        self.assertEqual(premature['error']['code'], 'TRANSFER_NOT_FINISHED')
        self.assertFalse((self.state / 'transfers' / transfer_id / 'ack.json').exists())
        self.block(transfer_id, 0, 0, data)
        self.call('transfer_verify', {'transferId': transfer_id})
        self.call('transfer_commit', {'transferId': transfer_id})
        first = self.call('transfer_ack', {'transferId': transfer_id})
        self.assertTrue(first['ok'], first)
        self.assertTrue(first['result']['acknowledged'])
        self.assertEqual(first['result']['state'], 'completed')
        ack = json.loads((self.state / 'transfers' / transfer_id / 'ack.json').read_text())
        self.assertEqual(ack['transferId'], transfer_id)
        again = self.call('transfer_ack', {'transferId': transfer_id})
        self.assertTrue(again['result']['acknowledged'])
        # failed 与 cancelled 的结果同样可以（且应当被）确认消费。
        failed_id = self.register(b'fails later', target='f2.bin')['result']['transferId']
        self.start(failed_id)
        self.block(failed_id, 0, 0, b'fails later')
        with self.temp_path(failed_id).open('r+b') as stream:
            stream.write(b'X')
        self.call('transfer_verify', {'transferId': failed_id})
        self.assertEqual(self.call('transfer_ack', {'transferId': failed_id})['result']['state'], 'failed')
        scoped = self.register(b'scope', target='scope.bin')['result']['transferId']
        self.start(scoped)
        self.call('transfer_cancel', {'transferId': scoped})
        self.assertEqual(self.call('transfer_ack', {'transferId': scoped})['result']['state'], 'cancelled')
        # 会话与未知标识的边界。
        mismatched = self.call('transfer_ack', {'transferId': transfer_id}, session='session-other')
        self.assertEqual(mismatched['error']['code'], 'TRANSFER_SCOPE_MISMATCH')
        self.assertEqual(self.call('transfer_ack', {'transferId': 'f' * 32})['error']['code'],
                         'REQUEST_EXPIRED_OR_UNKNOWN')

    def test_verify_size_mismatch_records_failed_state(self):
        # 尺寸不符与摘要不符同样致命：该分支也必须落 failed 留痕，
        # 而不是让 record 停在 transferring。
        data = b's' * 100
        transfer_id = self.register(data)['result']['transferId']
        self.start(transfer_id)
        self.block(transfer_id, 0, 0, data)
        with self.temp_path(transfer_id).open('r+b') as stream:
            stream.truncate(150)  # 外部扩展
        verified = self.call('transfer_verify', {'transferId': transfer_id})
        self.assertEqual(verified['error']['code'], 'VERIFY_MISMATCH')
        record = self.record(transfer_id)
        self.assertEqual(record['state'], 'failed')
        self.assertEqual(record['error']['code'], 'VERIFY_MISMATCH')

    def test_empty_file_transfers_with_no_blocks(self):
        transfer_id, committed = self.deliver(b'')
        self.assertEqual(committed['bytesWritten'], 0)
        self.assertEqual(committed['sha256'], hashlib.sha256(b'').hexdigest())
        self.assertEqual((self.work / 'target.bin').read_bytes(), b'')

    # --- download direction: registration (issue #14) ---------------------------

    def test_download_register_digests_the_source_and_binds_its_version(self):
        data = os.urandom(CHUNK * 2 + 33)
        registration = self.dregister(data=data, chunk=CHUNK)
        self.assertTrue(registration['ok'], registration)
        result = registration['result']
        self.assertEqual(result['state'], 'prepared')
        self.assertEqual(result['direction'], 'download')
        self.assertEqual(result['totalBytes'], len(data))
        self.assertEqual(result['sha256'], hashlib.sha256(data).hexdigest())
        self.assertTrue(result['sourceVersion'].startswith('m1-'))
        self.assertTrue(result['sourcePath'].endswith('source.bin'))
        self.assertEqual(result['confirmedOffset'], 0)
        record = self.record(result['transferId'])
        self.assertEqual(record['state'], 'prepared')
        self.assertEqual(record['sourceVersion'], result['sourceVersion'])
        self.assertIsNone(record['tempPath'])
        self.assertIsNone(record['resourceId'])
        # The sender materializes nothing: no temp file, no ledger resource.
        self.assertEqual(list(self.work.glob('.ssh-mcp-upload-*')), [])
        ledger = json.loads((self.state / 'ledger' / 'ledger.json').read_text()) \
            if (self.state / 'ledger' / 'ledger.json').exists() else {'resources': {}}
        self.assertEqual(ledger['resources'], {})

    def test_download_register_validates_parameters_and_sources(self):
        (self.work / 'source.bin').write_bytes(b'payload')
        cases = [
            ({'direction': 'sideways'}, 'INVALID_REQUEST'),
            ({'totalBytes': 7}, 'INVALID_REQUEST'),
            ({'totalSha256': hashlib.sha256(b'payload').hexdigest()}, 'INVALID_REQUEST'),
            ({'sourceIdentity': {'size': 7, 'mtimeMs': 1.0}}, 'INVALID_REQUEST'),
            ({'sourcePath': 'missing.bin'}, 'PATH_NOT_FOUND'),
            ({'sourcePath': '../outside'}, 'PATH_NOT_ALLOWED'),
            ({'sourcePath': None}, 'INVALID_PATH'),
            ({'targetPath': None}, 'INVALID_REQUEST'),
            ({'overwrite': True}, 'INVALID_REQUEST'),
            ({'expectedVersion': 'l1-any'}, 'INVALID_REQUEST'),
            ({'create': True, 'overwrite': True, 'expectedVersion': 'l1-any'}, 'INVALID_REQUEST'),
        ]
        for overrides, code in cases:
            response = self.dregister(**overrides)
            self.assertEqual(response['ok'], False, overrides)
            self.assertEqual(response['error']['code'], code, overrides)
        missing_protocol = self.call('transfer_register', {
            'direction': 'download', 'sourcePath': 'source.bin', 'chunkSize': CHUNK,
            'targetPath': 'C:/local/destination.bin'})
        self.assertEqual(missing_protocol['error']['code'], 'INVALID_PROTOCOL')

    def test_download_register_refuses_a_source_that_moves_under_it(self):
        data = b'unstable source'
        (self.work / 'source.bin').write_bytes(data)
        # The stability double-check around the streamed digest runs inside the
        # helper process, so this exercises the module directly: the source
        # mutates right after the digest completes and the registration must
        # refuse to anchor a digest that no longer describes the file.
        sys.path.insert(0, str(HELPER.parent))
        import transfer as transfer_module
        from common import AgentError
        self.state.mkdir(mode=0o700, parents=True, exist_ok=True)  # main() prepares the state root
        request = {'protocol': 2, 'direction': 'download', 'sourcePath': 'source.bin',
                   'chunkSize': CHUNK, 'overwrite': False, 'create': False,
                   'targetPath': 'C:/local/destination.bin',
                   'workspaceRoot': str(self.work), 'sessionId': 'session-one'}
        original = transfer_module._observe_source
        def mutating_observe(path):
            result = original(path)
            # Grow the file and restamp it explicitly: on WSL's 9p mount a
            # same-size overwrite sometimes leaves the observing descriptor's
            # cached timestamps unchanged, making the stability window blind;
            # a size change is a deterministic signal on every filesystem.
            with open(str(path), 'r+b') as stream:
                stream.write(b'XX')
            os.utime(str(path), (123.0, 456.0))
            return result
        transfer_module._observe_source = mutating_observe
        try:
            with self.assertRaises(AgentError) as caught:
                transfer_module.register(self.state, request)
        finally:
            transfer_module._observe_source = original
        self.assertEqual(caught.exception.code, 'FILE_CONFLICT')
        # Nothing was anchored: no transfer directory exists.
        self.assertEqual(list((self.state / 'transfers').iterdir()), [])

    def test_download_shares_the_active_transfer_pool_with_uploads(self):
        upload_id = self.register(b'upload payload')['result']['transferId']
        download = self.dregister(data=b'download payload')
        self.assertTrue(download['ok'], download)
        download_id = download['result']['transferId']
        # Two active transfers (one per direction): the pool is full.
        third = self.dregister(data=b'third', source='other.bin')
        self.assertEqual(third['error']['code'], 'TRANSFER_LIMIT_REACHED')
        # Completing the download frees the shared slot again.
        self.dstart(download_id)
        self.drain(download_id, b'download payload')
        self.call('transfer_verify', {'transferId': download_id,
                                      'sha256': hashlib.sha256(b'download payload').hexdigest()})
        committed = self.call('transfer_commit', {'transferId': download_id})
        self.assertEqual(committed['result']['state'], 'completed')
        fourth = self.dregister(data=b'fourth', source='other.bin')
        self.assertTrue(fourth['ok'], fourth)

    # --- download direction: start and source stability -------------------------

    def test_download_start_is_idempotent_and_refuses_changed_sources(self):
        data = b'stable download source'
        transfer_id = self.dregister(data=data)['result']['transferId']
        first = self.dstart(transfer_id)
        self.assertTrue(first['ok'], first)
        self.assertEqual(first['result']['state'], 'transferring')
        again = self.dstart(transfer_id)
        self.assertEqual(again['result']['state'], 'transferring')
        # An echoed source version that no longer matches refuses the transfer.
        stale_echo = self.call('transfer_start', {'protocol': 2, 'transferId': transfer_id,
                                                  'sourceVersion': 'm1-not-the-version'})
        self.assertEqual(stale_echo['error']['code'], 'TRANSFER_SOURCE_CHANGED')
        # A live source mutation (same size, new mtime) is equally refused.
        os.utime(str(self.work / 'source.bin'), (1.0, 1.0))
        changed = self.dstart(transfer_id)
        self.assertEqual(changed['error']['code'], 'TRANSFER_SOURCE_CHANGED')
        resumed = self.call('transfer_resume', {'protocol': 2, 'transferId': transfer_id,
                                                'sourceVersion': self.record(transfer_id)['sourceVersion']})
        self.assertEqual(resumed['error']['code'], 'TRANSFER_SOURCE_CHANGED')

    def test_download_start_requires_protocol_and_valid_echo(self):
        transfer_id = self.dregister(data=b'x')['result']['transferId']
        bare = self.call('transfer_start', {'transferId': transfer_id})
        self.assertEqual(bare['error']['code'], 'INVALID_PROTOCOL')
        invalid = self.call('transfer_start', {'protocol': 2, 'transferId': transfer_id,
                                               'sourceVersion': 42})
        self.assertEqual(invalid['error']['code'], 'INVALID_REQUEST')
        missing = self.call('transfer_start', {'protocol': 2, 'transferId': transfer_id})
        self.assertEqual(missing['error']['code'], 'INVALID_REQUEST')

    def test_download_resume_refuses_prepared_and_reports_terminal_states(self):
        transfer_id = self.dregister(data=b'not yet started')['result']['transferId']
        refused = self.call('transfer_resume', {'protocol': 2, 'transferId': transfer_id,
                                                'sourceVersion': self.record(transfer_id)['sourceVersion']})
        self.assertEqual(refused['error']['code'], 'INVALID_STATE')
        self.dstart(transfer_id)
        accepted = self.call('transfer_resume', {'protocol': 2, 'transferId': transfer_id,
                                                 'sourceVersion': self.record(transfer_id)['sourceVersion']})
        self.assertTrue(accepted['ok'], accepted)
        self.assertEqual(accepted['result']['state'], 'transferring')

    # --- download direction: framed block fetch ---------------------------------

    def test_download_fetch_streams_framed_raw_blocks(self):
        data = b'\x00\xff\nbinary\r\npayload' * 6000  # spans several chunks with hostile bytes
        transfer_id = self.dregister(data=data)['result']['transferId']
        self.dstart(transfer_id)
        control, payload, envelope = self.fetch_block(transfer_id, 0, 0, data[:CHUNK])
        self.assertEqual(control['transferId'], transfer_id)
        self.assertEqual(control['index'], 0)
        self.assertEqual(control['offset'], 0)
        self.assertEqual(control['size'], CHUNK)
        self.assertEqual(control['sha256'], hashlib.sha256(data[:CHUNK]).hexdigest())
        self.assertEqual(payload, data[:CHUNK])
        self.assertTrue(envelope['ok'], envelope)
        self.assertEqual(envelope['result']['confirmedOffset'], CHUNK)
        self.assertFalse(envelope['result']['complete'])
        digest = self.drain(transfer_id, data)
        self.assertEqual(self.record(transfer_id)['confirmedOffset'], len(data))
        self.assertEqual(digest, hashlib.sha256(data).hexdigest())

    def test_download_fetch_rejects_unknown_scope_state_and_order(self):
        data = b'z' * (CHUNK * 2 + 10)
        transfer_id = self.dregister(data=data)['result']['transferId']
        unknown = self.parse_fetch(self.fetch('f' * 32, 0, 0, 16))[2]
        self.assertEqual(unknown['ok'], False)
        self.assertEqual(unknown['error']['code'], 'REQUEST_EXPIRED_OR_UNKNOWN')
        wrong_session = self.parse_fetch(self.fetch(transfer_id, 0, 0, CHUNK, session='other'))[2]
        self.assertEqual(wrong_session['error']['code'], 'TRANSFER_SCOPE_MISMATCH')
        not_started = self.parse_fetch(self.fetch(transfer_id, 0, 0, CHUNK))[2]
        self.assertEqual(not_started['error']['code'], 'INVALID_STATE')
        self.dstart(transfer_id)
        out_of_order = self.parse_fetch(self.fetch(transfer_id, 1, CHUNK, CHUNK))[2]
        self.assertEqual(out_of_order['error']['code'], 'INVALID_REQUEST')
        misaligned = self.parse_fetch(self.fetch(transfer_id, 0, 10, CHUNK - 10))[2]
        self.assertEqual(misaligned['error']['code'], 'INVALID_REQUEST')
        for size in (0, CHUNK + 1):
            bad_size = self.parse_fetch(self.fetch(transfer_id, 0, 0, size))[2]
            self.assertEqual(bad_size['error']['code'], 'INVALID_REQUEST', size)
        overrun = self.parse_fetch(self.fetch(transfer_id, 2, CHUNK * 2, CHUNK))[2]
        self.assertEqual(overrun['error']['code'], 'INVALID_REQUEST')
        # An upload transfer is not fetchable.
        upload_id = self.register(b'upload')['result']['transferId']
        wrong_direction = self.parse_fetch(self.fetch(upload_id, 0, 0, 6))[2]
        self.assertEqual(wrong_direction['error']['code'], 'INVALID_REQUEST')

    def test_download_fetch_allows_rewinding_to_a_served_boundary(self):
        data = b'r' * (CHUNK * 3)
        transfer_id = self.dregister(data=data)['result']['transferId']
        self.dstart(transfer_id)
        self.fetch_block(transfer_id, 0, 0, data[:CHUNK])
        self.fetch_block(transfer_id, 1, CHUNK, data[CHUNK:CHUNK * 2])
        # The response for block 1 was lost after the sender served it: the
        # receiver re-asserts its confirmed boundary and the sender rewinds.
        # The receiver may lag by any number of served blocks, so rewinding to
        # block 0 (two blocks back) is equally legitimate.
        control, payload, envelope = self.fetch_block(transfer_id, 0, 0, data[:CHUNK])
        self.assertTrue(envelope['ok'], envelope)
        self.assertEqual(envelope['result']['confirmedOffset'], CHUNK)
        self.assertEqual(self.record(transfer_id)['confirmedOffset'], CHUNK)
        # Serving continues in order from the rewound boundary.
        digest = self.drain(transfer_id, data, chunk=CHUNK)
        self.assertEqual(self.record(transfer_id)['confirmedOffset'], len(data))
        self.assertEqual(digest, hashlib.sha256(data).hexdigest())
        # A misaligned pair (index and offset disagree) is still refused.
        misaligned = self.parse_fetch(self.fetch(transfer_id, 0, 4, 16))[2]
        self.assertEqual(misaligned['error']['code'], 'INVALID_REQUEST')

    def test_download_fetch_fails_the_transfer_when_the_source_changes(self):
        data = b'v' * (CHUNK * 2)
        transfer_id = self.dregister(data=data)['result']['transferId']
        self.dstart(transfer_id)
        self.fetch_block(transfer_id, 0, 0, data[:CHUNK])
        (self.work / 'source.bin').write_bytes(b'X' * (CHUNK * 2))  # new content, same size
        response = self.parse_fetch(self.fetch(transfer_id, 1, CHUNK, CHUNK))[2]
        self.assertEqual(response['error']['code'], 'TRANSFER_SOURCE_CHANGED')
        record = self.record(transfer_id)
        self.assertEqual(record['state'], 'failed')
        self.assertEqual(record['error']['code'], 'TRANSFER_SOURCE_CHANGED')
        # The failed transfer neither serves blocks nor resurrects via resume.
        after = self.parse_fetch(self.fetch(transfer_id, 1, CHUNK, CHUNK))[2]
        self.assertEqual(after['error']['code'], 'INVALID_STATE')
        resumed = self.call('transfer_resume', {'protocol': 2, 'transferId': transfer_id,
                                                'sourceVersion': self.record(transfer_id)['sourceVersion']})
        self.assertEqual(resumed['result']['state'], 'failed')

    # --- download direction: verify and commit ----------------------------------

    def test_download_verify_compares_the_asserted_receiver_digest(self):
        data = b'd' * (CHUNK + 5)
        transfer_id = self.dregister(data=data)['result']['transferId']
        self.dstart(transfer_id)
        early = self.call('transfer_verify', {'transferId': transfer_id,
                                              'sha256': hashlib.sha256(data).hexdigest()})
        self.assertEqual(early['error']['code'], 'INVALID_STATE')
        self.drain(transfer_id, data)
        bad_digest = hashlib.sha256(b'other content').hexdigest()
        mismatch = self.call('transfer_verify', {'transferId': transfer_id, 'sha256': bad_digest})
        self.assertEqual(mismatch['error']['code'], 'VERIFY_MISMATCH')
        self.assertEqual(self.record(transfer_id)['state'], 'failed')
        # A fresh transfer verifies against the sender's register-time digest.
        transfer_id = self.dregister(data=data)['result']['transferId']
        self.dstart(transfer_id)
        self.drain(transfer_id, data)
        invalid = self.call('transfer_verify', {'transferId': transfer_id, 'sha256': 'zz'})
        self.assertEqual(invalid['error']['code'], 'INVALID_REQUEST')
        verified = self.call('transfer_verify', {'transferId': transfer_id,
                                                 'sha256': hashlib.sha256(data).hexdigest()})
        self.assertTrue(verified['ok'], verified)
        self.assertEqual(verified['result']['state'], 'verifying')

    def test_download_commit_records_completion_idempotently(self):
        data = b'commit me'
        transfer_id = self.dregister(data=data)['result']['transferId']
        premature = self.call('transfer_commit', {'transferId': transfer_id})
        self.assertEqual(premature['error']['code'], 'INVALID_STATE')
        self.dstart(transfer_id)
        self.drain(transfer_id, data)
        self.call('transfer_verify', {'transferId': transfer_id,
                                      'sha256': hashlib.sha256(data).hexdigest()})
        committed = self.call('transfer_commit', {'transferId': transfer_id})
        self.assertTrue(committed['ok'], committed)
        self.assertEqual(committed['result']['state'], 'completed')
        self.assertEqual(committed['result']['bytesWritten'], len(data))
        self.assertEqual(committed['result']['sha256'], hashlib.sha256(data).hexdigest())
        receipt = json.loads((self.state / 'transfers' / transfer_id / 'receipt.json').read_text())
        self.assertEqual(receipt['bytes'], len(data))
        again = self.call('transfer_commit', {'transferId': transfer_id})
        self.assertTrue(again['ok'], again)
        self.assertEqual(again['result']['state'], 'completed')

    def test_download_status_reports_the_sender_view_without_renewal(self):
        data = b'status probe download'
        transfer_id = self.dregister(data=data)['result']['transferId']
        self.dstart(transfer_id)
        before = self.record(transfer_id)
        status = self.call('transfer_status', {'transferId': transfer_id})
        self.assertTrue(status['ok'], status)
        self.assertEqual(status['result']['state'], 'transferring')
        self.assertEqual(status['result']['direction'], 'download')
        self.assertEqual(status['result']['confirmedOffset'], 0)
        self.assertNotIn('chunks', status['result'])
        self.assertEqual(self.record(transfer_id)['expiresAt'], before['expiresAt'])

    def test_download_empty_source_transfers_with_no_blocks(self):
        (self.work / 'source.bin').write_bytes(b'')
        transfer_id = self.dregister()['result']['transferId']
        self.dstart(transfer_id)
        verified = self.call('transfer_verify', {'transferId': transfer_id,
                                                 'sha256': hashlib.sha256(b'').hexdigest()})
        self.assertTrue(verified['ok'], verified)
        committed = self.call('transfer_commit', {'transferId': transfer_id})
        self.assertEqual(committed['result']['bytesWritten'], 0)


if __name__ == '__main__':
    unittest.main()
