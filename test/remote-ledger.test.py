"""Ticket #8 behavior tests: temp-resource ledger, fixed lock slots and the
cross-process workspace space ledger, driven through the helper's public CLI.
Runs on Linux (fcntl) with Python 3.6+."""
import base64
import errno
from concurrent.futures import ThreadPoolExecutor
import fcntl
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock


HELPER = Path(__file__).resolve().parents[1] / 'remote' / 'agent.py'
STATE = 'state'


class RemoteLedgerTest(unittest.TestCase):
    def setUp(self):
        self.fixture = tempfile.TemporaryDirectory(prefix='ssh-mcp ledger ')
        self.root = Path(self.fixture.name)
        self.work = self.root / 'work'
        self.work.mkdir()

    def tearDown(self):
        self.fixture.cleanup()

    # --- helpers ---------------------------------------------------------------

    @property
    def state(self):
        return self.root / STATE

    def call(self, action, request, session='session-one'):
        data = dict(request, workspaceRoot=str(self.work), sessionId=session)
        run = subprocess.run([sys.executable, str(HELPER), '--root', str(self.state), action],
                             input=json.dumps(data), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             universal_newlines=True, timeout=15)
        self.assertEqual(run.returncode, 0, run.stderr)
        return json.loads(base64.b64decode(run.stdout.split(' ', 1)[1]))

    def set_limit(self, limit):
        directory = self.state / 'ledger'
        directory.mkdir(parents=True, exist_ok=True)
        (directory / 'policy.json').write_text(json.dumps({'spaceLimitBytes': limit}))

    def ledger_json(self):
        return json.loads((self.state / 'ledger' / 'ledger.json').read_text())

    def temp_files(self):
        return sorted(path.name for path in self.work.iterdir() if path.name.startswith('.ssh-mcp-'))

    # --- space ledger: reservations and quota ----------------------------------

    def test_concurrent_reservations_never_exceed_the_workspace_limit(self):
        self.set_limit(8192)
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda index: self.call('resource_reserve', {'bytes': 4096, 'note': 'child {}'.format(index)}), range(4)))
        accepted = [result for result in results if result['ok']]
        rejected = [result for result in results if not result['ok']]
        self.assertEqual(len(accepted), 2, results)
        self.assertEqual({result['error']['code'] for result in rejected}, {'WORKSPACE_QUOTA_EXCEEDED'})
        self.assertIn('limit', rejected[0]['error']['message'])
        usage = self.call('resource_usage', {})['result']
        self.assertEqual(usage['reservedBytes'], 8192)
        self.assertEqual(usage['usedBytes'], usage['stateBytes'] + 8192)
        self.assertEqual(usage['limitBytes'], 8192)
        self.assertEqual(usage['resourceCount'], 0)
        # Releasing one reservation frees room for exactly one more.
        released = self.call('resource_release', {'reservationId': accepted[0]['result']['reservationId']})
        self.assertTrue(released['ok'], released)
        again = self.call('resource_reserve', {'bytes': 4096, 'note': 'after release'})
        self.assertTrue(again['ok'], again)
        self.assertFalse(self.call('resource_release', {'reservationId': accepted[0]['result']['reservationId']})['ok'])

    def test_reservation_consumption_avoids_double_counting(self):
        # 额度收紧到“刚好被预留占满”（state 目录自身不计量）：
        # 引用预留的登记净增 0，必须放行，配额与返回值都不得重复叠加。
        self.set_limit(4096)
        reservation = self.call('resource_reserve', {'bytes': 4096})['result']['reservationId']
        before = self.call('resource_usage', {})['result']
        self.assertEqual(before['reservedBytes'], 4096)
        self.assertEqual(before['usedBytes'], before['stateBytes'] + 4096)
        self.assertEqual(before['usedBytes'], before['limitBytes'])
        resource = self.call('resource_register', {'path': str(self.work / 'transfer.part'), 'bytes': 1500,
                                                   'origin': 'test', 'reservationId': reservation})
        self.assertTrue(resource['ok'], resource)
        self.assertEqual(resource['result']['usedBytes'], before['usedBytes'])
        after = self.call('resource_usage', {})['result']
        self.assertEqual(after['tempBytes'], 1500)
        self.assertEqual(after['reservedBytes'], 4096 - 1500)
        self.assertEqual(after['usedBytes'], before['usedBytes'])
        self.assertLessEqual(after['usedBytes'], after['limitBytes'])
        # A fully consumed reservation no longer exists and cannot be referenced again.
        drained = self.call('resource_register', {'path': str(self.work / 'more.part'), 'bytes': 2596,
                                                  'origin': 'test', 'reservationId': reservation})
        self.assertTrue(drained['ok'], drained)
        self.assertEqual(self.call('resource_usage', {})['result']['reservedBytes'], 0)
        expired = self.call('resource_register', {'path': str(self.work / 'final.part'), 'bytes': 10,
                                                  'origin': 'test', 'reservationId': reservation})
        self.assertFalse(expired['ok'])
        self.assertEqual(expired['error']['code'], 'RESOURCE_NOT_FOUND')
        self.assertEqual(self.call('resource_usage', {})['result']['usedBytes'], before['usedBytes'])
        for payload in (resource, drained):
            forgot = self.call('resource_forget', {'resourceId': payload['result']['resourceId']})
            self.assertTrue(forgot['ok'], forgot)
        final = self.call('resource_usage', {})['result']
        self.assertEqual(final['tempBytes'], 0)
        self.assertEqual(final['usedBytes'], before['usedBytes'] - 4096)

    def test_register_quota_checks_the_net_increase_over_a_partial_reservation(self):
        # 预留只覆盖一部分时，quota 检查与返回的 usedBytes 都按净增量
        # （超出预留的部分）核算：预留占满剩余额度后仍可兑现更大登记。
        self.set_limit(1500)
        reservation = self.call('resource_reserve', {'bytes': 1000})['result']['reservationId']
        resource = self.call('resource_register', {'path': str(self.work / 'grow.part'), 'bytes': 1500,
                                                   'origin': 'test', 'reservationId': reservation})
        self.assertTrue(resource['ok'], resource)
        usage = self.call('resource_usage', {})['result']
        self.assertEqual(usage['tempBytes'], 1500)
        self.assertEqual(usage['reservedBytes'], 0)
        self.assertEqual(resource['result']['usedBytes'], usage['usedBytes'])
        self.assertLessEqual(usage['usedBytes'], usage['limitBytes'])

    def test_invalid_ledger_requests_and_policy_are_rejected(self):
        for request in ({'bytes': 0}, {'bytes': -5}, {'bytes': 'big'}, {}):
            result = self.call('resource_reserve', request)
            self.assertFalse(result['ok'], request)
            self.assertEqual(result['error']['code'], 'INVALID_REQUEST')
        relative = self.call('resource_register', {'path': 'relative.part', 'bytes': 10})
        self.assertEqual(relative['error']['code'], 'INVALID_REQUEST')
        (self.state / 'ledger').mkdir(parents=True, exist_ok=True)
        (self.state / 'ledger' / 'policy.json').write_text('{"spaceLimitBytes": "big"}')
        broken = self.call('resource_usage', {})
        self.assertFalse(broken['ok'])
        self.assertEqual(broken['error']['code'], 'INVALID_POLICY')

    def test_quota_rejects_new_usage_with_explicit_code_and_no_partial_temp(self):
        self.set_limit(4096)
        denied = self.call('file_write', {'path': 'blocked.txt', 'text': 'x' * 8192, 'create': True})
        self.assertFalse(denied['ok'], denied)
        self.assertEqual(denied['error']['code'], 'WORKSPACE_QUOTA_EXCEEDED')
        self.assertEqual(self.temp_files(), [])
        self.assertFalse((self.work / 'blocked.txt').exists())
        self.assertEqual(self.call('resource_usage', {})['result']['tempBytes'], 0)
        # Smaller known-size writes still fit; rejection only blocks the new usage.
        allowed = self.call('file_write', {'path': 'blocked.txt', 'text': 'y' * 100, 'create': True})
        self.assertTrue(allowed['ok'], allowed)

    def test_committed_targets_leave_the_space_measurement(self):
        self.set_limit(4096)
        first = self.call('file_write', {'path': 'a.txt', 'text': 'a' * 2048, 'create': True})
        self.assertTrue(first['ok'], first)
        usage = self.call('resource_usage', {})['result']
        self.assertEqual(usage['tempBytes'], 0)
        self.assertLess(usage['usedBytes'], 1024, usage)
        # If committed targets stayed counted this second write would exceed the limit.
        second = self.call('file_write', {'path': 'b.txt', 'text': 'b' * 2048, 'create': True})
        self.assertTrue(second['ok'], second)
        self.assertEqual((self.work / 'b.txt').read_text(), 'b' * 2048)

    # --- registration must precede any temp file that could be left behind ----

    def test_temporary_registration_precedes_temporary_creation(self):
        # Part A: while another process holds the ledger lock, a write must not
        # create any temp file - registration and the quota gate happen first.
        self.state.mkdir(parents=True, exist_ok=True)
        (self.state / 'ledger').mkdir(parents=True, exist_ok=True)
        guard = (self.state / 'ledger' / 'ledger.lock').open('a')
        try:
            fcntl.flock(guard, fcntl.LOCK_EX)
            process = subprocess.Popen([sys.executable, str(HELPER), '--root', str(self.state), 'file_write'],
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       universal_newlines=True)
            process.stdin.write(json.dumps({'path': 'slow.txt', 'text': 'z' * 4096, 'create': True,
                                            'workspaceRoot': str(self.work), 'sessionId': 'session-one'}))
            process.stdin.close()
            time.sleep(0.6)
            self.assertIsNone(process.poll(), 'helper should still be waiting on the ledger lock')
            self.assertEqual(self.temp_files(), [])
        finally:
            fcntl.flock(guard, fcntl.LOCK_UN)
            guard.close()
        output = process.stdout.read()
        process.wait(timeout=15)
        self.assertEqual(process.returncode, 0)
        self.assertTrue(json.loads(base64.b64decode(output.split(' ', 1)[1]))['ok'], output)

        # Part B: the moment a temp file becomes observable, its registration
        # must already be durable; killing the writer leaves both behind for #17.
        for attempt in range(3):
            process = subprocess.Popen([sys.executable, str(HELPER), '--root', str(self.state), 'file_write'],
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       universal_newlines=True)
            process.stdin.write(json.dumps({'path': 'crash-{}.txt'.format(attempt), 'text': 'c' * (14 * 1024 * 1024),
                                            'create': True, 'workspaceRoot': str(self.work), 'sessionId': 'session-one'}))
            process.stdin.close()
            observed = None
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                temps = self.temp_files()
                if temps:
                    observed = self.work / temps[0]
                    break
                if process.poll() is not None:
                    break
                time.sleep(0.001)
            if observed is None:
                process.stdin.close()
                process.stdout.read()
                process.wait(timeout=15)
                process.stdout.close()
                process.stderr.close()
                continue
            registered = self.ledger_json()['resources']
            entry = next((value for value in registered.values() if value['path'] == str(observed)), None)
            if entry is not None:
                # The writer may finish between observation and the kill; that is
                # fine - the invariant under test is registration-before-existence.
                os.kill(process.pid, signal.SIGKILL)
                process.stdout.read()
                process.wait(timeout=15)
                process.stdout.close()
                process.stderr.close()
                self.assertEqual(entry['bytes'], 14 * 1024 * 1024)
                self.assertEqual(entry['kind'], 'temp-file')
                usage = self.call('resource_usage', {})['result']
                if observed.exists():
                    self.assertEqual(usage['tempBytes'], 14 * 1024 * 1024)
                return
            self.fail('temp file {} existed without a ledger registration'.format(observed))
        self.fail('no write stayed observable long enough to check crash registration')

    # --- occupancy evidence: PID reuse and age must not misjudge ----------------

    def test_pid_reuse_and_stale_age_do_not_misjudge_occupancy(self):
        target = self.work / 'held.part'
        target.write_bytes(b'partial')
        resource = self.call('resource_register', {'path': str(target), 'bytes': 7, 'origin': 'test'})['result']
        entry_id = resource['resourceId']
        # The one-shot helper process that registered the resource is gone.
        gone = self.call('resource_inspect', {'resourceId': entry_id})['result']
        self.assertTrue(gone['exists'])
        self.assertFalse(gone['holderAlive'])

        ledger = self.ledger_json()
        # PID reuse: the recorded pid now belongs to a live but different process.
        ledger['resources'][entry_id]['holderPid'] = os.getpid()
        (self.state / 'ledger' / 'ledger.json').write_text(json.dumps(ledger))
        reused = self.call('resource_inspect', {'resourceId': entry_id})['result']
        self.assertFalse(reused['holderAlive'], 'a reused PID must not be reported as the holder')

        # A genuinely live holder with a matching identity stays occupied no
        # matter how old the record is; age alone never flips the verdict.
        child = subprocess.Popen(['sleep', '30'])
        try:
            stat_fields = Path('/proc/{}/stat'.format(child.pid)).read_text().rsplit(')', 1)[1].split()
            identity = Path('/proc/sys/kernel/random/boot_id').read_text().strip() + ':' + stat_fields[19]
            ledger = self.ledger_json()
            ledger['resources'][entry_id].update(holderPid=child.pid, holderIdentity=identity,
                                                 createdAt=time.time() - 30 * 86400)
            (self.state / 'ledger' / 'ledger.json').write_text(json.dumps(ledger))
            held = self.call('resource_inspect', {'resourceId': entry_id})['result']
            self.assertTrue(held['holderAlive'], 'an old record with a live matching holder is still occupied')
        finally:
            child.kill()
            child.wait()

    def test_inspect_reports_object_identity_evidence(self):
        target = self.work / 'identity.part'
        target.write_bytes(b'payload')
        resource = self.call('resource_register', {'path': str(target), 'bytes': 7, 'origin': 'test'})['result']
        stats = target.stat()
        identity = '{}:{}'.format(stats.st_dev, stats.st_ino)
        inspect = self.call('resource_inspect', {'resourceId': resource['resourceId']})['result']
        self.assertIsNone(inspect['identityMatches'])
        # A committed write attaches the observed identity; replicate that via the module.
        sys.path.insert(0, str(HELPER.parent))
        import ledger as ledger_module
        with ledger_module.ledger_lock(self.state):
            state = ledger_module.load(self.state)
            state['resources'][resource['resourceId']]['identity'] = identity
            ledger_module.save(self.state, state)
        confirmed = self.call('resource_inspect', {'resourceId': resource['resourceId']})['result']
        self.assertTrue(confirmed['identityMatches'])
        # Object identity is dev:ino: an in-place rewrite keeps it, a
        # replacement through a new inode must not match anymore.
        replacement = self.work / 'identity.replacement'
        replacement.write_bytes(b'a different object')
        os.replace(str(replacement), str(target))
        replaced = self.call('resource_inspect', {'resourceId': resource['resourceId']})['result']
        self.assertFalse(replaced['identityMatches'])
        target.unlink()
        missing = self.call('resource_inspect', {'resourceId': resource['resourceId']})['result']
        self.assertFalse(missing['exists'])
        self.assertIsNone(missing['identityMatches'])
        self.assertFalse(self.call('resource_inspect', {'resourceId': 'f' * 32})['ok'])

    # --- fixed lock slots and the protocol switch -------------------------------

    def test_lock_switch_refused_until_legacy_locks_drain(self):
        target = self.work / 'switch.txt'
        target.write_text('content\n')
        legacy = self.state / 'file-locks' / hashlib.sha256(str(target.resolve()).encode('utf8')).hexdigest()
        legacy.parent.mkdir(parents=True, exist_ok=True)
        holder = legacy.open('a')
        try:
            fcntl.flock(holder, fcntl.LOCK_EX)
            blocked = self.call('file_read', {'path': 'switch.txt'})
            self.assertFalse(blocked['ok'], blocked)
            self.assertEqual(blocked['error']['code'], 'LOCK_SWITCH_BLOCKED')
            self.assertFalse((self.state / 'file-locks' / 'slots.json').exists())
        finally:
            fcntl.flock(holder, fcntl.LOCK_UN)
            holder.close()
        switched = self.call('file_read', {'path': 'switch.txt'})
        self.assertTrue(switched['ok'], switched)
        marker = json.loads((self.state / 'file-locks' / 'slots.json').read_text())
        self.assertEqual(marker['protocol'], 'fixed-slots')
        self.assertEqual(marker['slots'], 256)
        names = sorted(path.name for path in (self.state / 'file-locks').iterdir())
        self.assertTrue(all(name.startswith('slot-') or name in ('slots.json', '.switch.lock')
                            or name == legacy.name for name in names), names)
        # The only 64-hex file may be the legacy lock this test created itself.
        self.assertEqual([name for name in names if len(name) == 64], [legacy.name],
                         'per-path lock files must not be recreated')
        sys.path.insert(0, str(HELPER.parent))
        import locks as locks_module
        for index in range(4):
            self.assertLess(locks_module.slot_index('/workspace/file-{}'.format(index)), 256)

    def test_same_slot_targets_are_deduplicated_for_multi_target_locks(self):
        sys.path.insert(0, str(HELPER.parent))
        import locks as locks_module
        first, second = 'same-slot-a', 'same-slot-b'
        for index in range(10000):
            if locks_module.slot_index(str(self.work / first)) == locks_module.slot_index(str(self.work / second)):
                break
            second = 'same-slot-b-{}'.format(index)
        self.assertEqual(locks_module.slot_index(str(self.work / first)), locks_module.slot_index(str(self.work / second)))
        (self.work / first).write_text('left')
        (self.work / second).write_text('right')
        left = self.call('file_read', {'path': first})['result']['readToken']
        right = self.call('file_read', {'path': second})['result']['readToken']
        # Without dedupe the two flock calls would target the same slot file and
        # the move would deadlock against itself; the timeout guards the claim.
        moved = self.call('file_move', {'path': first, 'target': second, 'readToken': left, 'targetReadToken': right})
        self.assertTrue(moved['ok'], moved)
        self.assertEqual((self.work / second).read_text(), 'left')
        self.assertFalse((self.work / first).exists())

    # --- physical ENOSPC maps to an explicit failure ----------------------------

    def test_enospc_maps_to_storage_full_and_releases_the_registration(self):
        sys.path.insert(0, str(HELPER.parent))
        import files as files_module
        target = self.work / 'nospace.txt'
        target.write_text('before')
        token = self.call('file_read', {'path': 'nospace.txt'})['result']['readToken']
        failure = OSError(errno.ENOSPC, 'No space left on device')
        with mock.patch('files.write_temporary', side_effect=failure):
            service = files_module.FileService(self.state, str(self.work), 'session-one')
            with self.assertRaises(files_module.AgentError) as raised:
                service.edit({'path': 'nospace.txt', 'readToken': token,
                              'edits': [{'oldText': 'before', 'newText': 'after'}]})
        self.assertEqual(raised.exception.code, 'STORAGE_FULL')
        self.assertEqual(target.read_text(), 'before')
        self.assertEqual(self.temp_files(), [])
        usage = self.call('resource_usage', {})['result']
        self.assertEqual(usage['tempBytes'], 0)
        self.assertEqual(usage['resourceCount'], 0)


if __name__ == '__main__':
    unittest.main(verbosity=2)
