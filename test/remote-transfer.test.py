"""Ticket #13 behavior tests: resumable verified upload transfers, driven
through the helper's public CLI (register/start/block/verify/commit/status/
resume). Runs on Linux (fcntl) with Python 3.6+."""
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
            ({'direction': 'download'}, 'INVALID_REQUEST'),
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

    def test_cancel_and_ack_are_reserved_for_issue_15(self):
        transfer_id = self.register(b'future')['result']['transferId']
        for action in ('transfer_cancel', 'transfer_ack'):
            response = self.call(action, {'transferId': transfer_id})
            self.assertEqual(response['ok'], False)
            self.assertEqual(response['error']['code'], 'UNSUPPORTED_ACTION')

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


if __name__ == '__main__':
    unittest.main()
