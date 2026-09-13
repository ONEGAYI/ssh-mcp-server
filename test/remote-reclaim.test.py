"""Ticket #16 behavior tests: expiry reclamation of task and transfer
results with lazy cleanup and bounded maintenance, driven through the
helper's public CLI. The accelerated clock is SSH_MCP_TEST_CLOCK; record
timestamps stay real so only the reclamation verdicts move. Runs on Linux
(fcntl) with Python 3.6+.

Ticket #17 adds the same-driven reclamation of expired read credentials,
stale helper images and crash-leftover temp resources (spec 7.1/7.2)."""
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest


HELPER = Path(__file__).resolve().parents[1] / 'remote' / 'agent.py'
CHUNK = 65536
DAY = 86400


class RemoteReclaimTest(unittest.TestCase):
    def setUp(self):
        self.fixture = tempfile.TemporaryDirectory(prefix='ssh-mcp reclaim ')
        self.root = Path(self.fixture.name)
        self.work = self.root / 'work'
        self.work.mkdir()

    def tearDown(self):
        self.fixture.cleanup()

    # --- helpers ---------------------------------------------------------------

    @property
    def state(self):
        return self.root / 'state'

    def call(self, action, request, session='session-one', clock=None):
        return self.call_via(HELPER, action, request, session=session, clock=clock)

    def call_via(self, helper, action, request, session='session-one', clock=None):
        data = dict(request, workspaceRoot=str(self.work), sessionId=session)
        env = dict(os.environ)
        if clock is not None:
            env['SSH_MCP_TEST_CLOCK'] = repr(clock)
        run = subprocess.run([sys.executable, str(helper), '--root', str(self.state), action],
                             input=json.dumps(data).encode('utf8'), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             timeout=60, env=env)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertTrue(run.stdout.startswith(b'SSH_MCP_V1 '), run.stdout)
        return json.loads(base64.b64decode(run.stdout.split(b' ', 1)[1]))

    def maintenance(self, clock=None, **overrides):
        return self.call('maintenance', overrides, clock=clock)

    def run_task(self, command, name='probe'):
        """Register and execute one v2 task, wait for its terminal state."""
        marker = self.work / (name + '.count')
        registered = self.call('task_register', {'protocol': 2, 'command': command, 'cwd': str(self.work),
                                                 'env': {}})
        self.assertTrue(registered['ok'], registered)
        job_id = registered['result']['jobId']
        started = self.call('task_start', {'protocol': 2, 'jobId': job_id})
        self.assertTrue(started['ok'], started)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            state = self.call('status', {'jobId': job_id})['result']
            if state['state'] in ('exited', 'cancelled', 'interrupted'):
                return job_id, state
            time.sleep(0.025)
        self.fail('Task did not finish: ' + json.dumps(state))

    def wait_exit(self, job_id):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            state = self.call('status', {'jobId': job_id})['result']
            if state['state'] in ('exited', 'cancelled', 'interrupted'):
                return state
            time.sleep(0.025)
        self.fail('Task did not finish')

    def register_upload(self, size, target='target.bin'):
        request = {'protocol': 2, 'direction': 'upload', 'targetPath': target,
                   'chunkSize': CHUNK, 'totalBytes': size,
                   'totalSha256': hashlib.sha256(b'').hexdigest(),
                   'sourceIdentity': {'size': size, 'mtimeMs': 1.0},
                   'overwrite': False, 'create': False}
        return self.call('transfer_register', request)

    def job_dir(self, job_id):
        return self.state / 'jobs' / job_id

    # --- acknowledged task logs: 3 days ---------------------------------------

    def test_maintenance_purges_acknowledged_logs_after_3_days(self):
        job_id, _ = self.run_task("printf 'log line\\n'")
        self.assertTrue(self.call('ack', {'jobId': job_id})['ok'])
        started_at = time.time()
        result = self.maintenance(clock=started_at + 3.1 * DAY)['result']
        self.assertEqual(result['purgedLogs'], [job_id], result)
        directory = self.job_dir(job_id)
        self.assertFalse((directory / 'stdout').exists())
        self.assertFalse((directory / 'stderr').exists())
        self.assertTrue((directory / 'purged.json').is_file())
        # The deduplication record survives so the old request cannot rerun.
        self.assertTrue((directory / 'registration.json').is_file())
        self.assertTrue((directory / 'request.json').is_file())
        purged = self.call('output', {'jobId': job_id})
        self.assertFalse(purged['ok'])
        self.assertEqual(purged['error']['code'], 'LOGS_PURGED')
        replay = self.call('task_start', {'protocol': 2, 'jobId': job_id})
        self.assertTrue(replay['ok'], replay)
        self.assertEqual(replay['result']['state'], 'exited')

    def test_acknowledged_logs_within_retention_are_kept(self):
        job_id, _ = self.run_task("printf 'log line\\n'")
        self.assertTrue(self.call('ack', {'jobId': job_id})['ok'])
        result = self.maintenance(clock=time.time() + DAY)['result']
        self.assertEqual(result['purgedLogs'], [], result)
        self.assertTrue((self.job_dir(job_id) / 'stdout').exists())

    # --- acknowledged task records: 30 days -----------------------------------

    def test_maintenance_removes_acknowledged_task_records_after_30_days(self):
        job_id, _ = self.run_task('printf once > once.marker')
        self.assertTrue(self.call('ack', {'jobId': job_id})['ok'])
        result = self.maintenance(clock=time.time() + 30.1 * DAY)['result']
        self.assertEqual(result['removedJobs'], [job_id], result)
        self.assertFalse(self.job_dir(job_id).exists())
        missing = self.call('status', {'jobId': job_id})
        self.assertFalse(missing['ok'])
        self.assertEqual(missing['error']['code'], 'JOB_NOT_FOUND')
        # A replayed old request must be refused, never rerun.
        replay = self.call('task_start', {'protocol': 2, 'jobId': job_id})
        self.assertFalse(replay['ok'])
        self.assertEqual(replay['error']['code'], 'REQUEST_EXPIRED_OR_UNKNOWN')
        self.assertEqual(len(list(self.work.glob('once.marker'))), 1)

    def test_unacknowledged_terminal_results_expire_30_days_after_completion(self):
        job_id, _ = self.run_task('printf done')
        # No ack here: the retention clock starts at completion.
        result = self.maintenance(clock=time.time() + 30.1 * DAY)['result']
        self.assertEqual(result['removedJobs'], [job_id], result)
        self.assertFalse(self.job_dir(job_id).exists())
        replay = self.call('task_start', {'protocol': 2, 'jobId': job_id})
        self.assertEqual(replay['error']['code'], 'REQUEST_EXPIRED_OR_UNKNOWN')

    # --- unknown-shape task records: 30 days from first observation -----------

    def _plant_stuck_starting_task(self, job_id):
        """A registration whose startup never completed (describe: unknown)."""
        directory = self.job_dir(job_id)
        directory.mkdir(parents=True)
        registration = {'command': 'sleep 5', 'cwd': str(self.work), 'env': {},
                        'executionTimeoutMs': None, 'maxOutputBytes': 268435456,
                        'schemaVersion': 1, 'requestHash': '0' * 64,
                        'registeredAt': time.time() - 2 * DAY}
        (directory / 'registration.json').write_text(json.dumps(registration))
        (directory / 'request.json').write_text(json.dumps(dict(registration, jobId=job_id)))
        state = {'schemaVersion': 1, 'jobId': job_id, 'state': 'starting',
                 'createdAt': time.time() - 120, 'requestHash': '0' * 64}
        (directory / 'state.json').write_text(json.dumps(state))

    def test_unknown_task_records_expire_30_days_after_first_observation(self):
        job_id = 'stuck-starting'
        self._plant_stuck_starting_task(job_id)
        observed = self.call('status', {'jobId': job_id})['result']
        self.assertEqual(observed['state'], 'unknown')
        # First maintenance visit marks the unknown phase, deletes nothing.
        first = self.maintenance(clock=time.time())['result']
        self.assertEqual(first['removedJobs'], [])
        marker = self.job_dir(job_id) / 'unknown.json'
        self.assertTrue(marker.is_file())
        first_observed = json.loads(marker.read_text())['firstObservedAt']
        # Queries never renew the observation.
        for _ in range(3):
            self.call('status', {'jobId': job_id})
        self.assertEqual(json.loads(marker.read_text())['firstObservedAt'], first_observed)
        # Still kept one day later; removed 30 days after the first observation.
        self.assertEqual(self.maintenance(clock=time.time() + DAY)['result']['removedJobs'], [])
        expired = self.maintenance(clock=time.time() + 30.1 * DAY)['result']
        self.assertEqual(expired['removedJobs'], [job_id], expired)
        replay = self.call('task_start', {'protocol': 2, 'jobId': job_id})
        self.assertEqual(replay['error']['code'], 'REQUEST_EXPIRED_OR_UNKNOWN')

    # --- legacy (v1) records: observable migration, activation-gated removal ---

    def _plant_legacy_v1_record(self, job_id, state_overrides):
        """A first-version task directory: request.json + state.json and NO
        registration.json -- the shape the retired legacy 'start' entry
        created before the register-then-execute protocol."""
        directory = self.job_dir(job_id)
        directory.mkdir(parents=True)
        request = {'jobId': job_id, 'command': 'sleep 5', 'cwd': str(self.work), 'env': {},
                   'executionTimeoutMs': None, 'maxOutputBytes': 268435456}
        (directory / 'request.json').write_text(json.dumps(request))
        state = {'schemaVersion': 1, 'jobId': job_id, 'state': 'running',
                 'createdAt': time.time() - 2 * DAY, 'requestHash': '0' * 64,
                 'startedAt': time.time() - 2 * DAY, 'workerPid': 999999,
                 'workerIdentity': 'legacy-boot:1', 'pid': 999998,
                 'processIdentity': 'legacy-boot:2'}
        state.update(state_overrides)
        (directory / 'state.json').write_text(json.dumps(state))

    def test_legacy_v1_terminal_record_waits_for_activation_and_expires_from_original_time(self):
        finished_at = time.time() - 29 * DAY
        self._plant_legacy_v1_record('v1-exited', {'state': 'exited', 'exitCode': 0,
                                                   'completedAt': finished_at})
        # Before activation the legacy start entry can still create tasks, so
        # deleting the v1 record would let its replayed request rerun through
        # the upgrade window (contracts: v1 records are only removed once the
        # v2 protocol is active).
        blocked = self.maintenance(clock=finished_at + 30.1 * DAY)['result']
        self.assertEqual(blocked['removedJobs'], [], blocked)
        self.assertTrue(self.job_dir('v1-exited').exists())
        # Activation ends the creation window; the record then expires against
        # its ORIGINAL completion time, not a fresh 30 days from activation.
        self.assertTrue(self.call('handshake', {'protocol': 2})['ok'])
        kept = self.maintenance(clock=finished_at + 29.9 * DAY)['result']
        self.assertEqual(kept['removedJobs'], [], kept)
        expired = self.maintenance(clock=finished_at + 30.1 * DAY)['result']
        self.assertEqual(expired['removedJobs'], ['v1-exited'], expired)
        self.assertFalse(self.job_dir('v1-exited').exists())
        # The migration is idempotent: another round changes nothing.
        self.assertEqual(self.maintenance(clock=finished_at + 30.2 * DAY)['result']['removedJobs'], [])
        # And the retired legacy creation entry stays refused after activation.
        replay = self.call('start', {'jobId': 'v1-exited', 'cwd': str(self.work), 'command': 'printf x'})
        self.assertEqual(replay['error']['code'], 'PROTOCOL_UPGRADE_REQUIRED')

    def test_legacy_v1_unfinished_record_is_observable_and_removal_gates_on_activation(self):
        # A v1 record whose worker is gone cannot prove how the task ended.
        # It stays observable, enters the unknown phase from the first
        # maintenance observation (the migration observation time), and is
        # only removed after activation -- never while the legacy creation
        # window is still open.
        self._plant_legacy_v1_record('v1-lost', {})
        observed = self.call('status', {'jobId': 'v1-lost'})['result']
        self.assertEqual(observed['state'], 'unknown')
        self.maintenance(clock=time.time())
        marker = self.job_dir('v1-lost') / 'unknown.json'
        self.assertTrue(marker.is_file())
        first_observed = json.loads(marker.read_text())['firstObservedAt']
        # Past the 30-day unknown expiry but BEFORE activation: nothing is
        # deleted and the record remains queryable.
        kept = self.maintenance(clock=first_observed + 30.1 * DAY)['result']
        self.assertEqual(kept['removedJobs'], [], kept)
        still_there = self.call('status', {'jobId': 'v1-lost'})['result']
        self.assertEqual(still_there['state'], 'unknown')
        # A dead worker cannot write anything anymore, so it must not block
        # the protocol switch forever (live legacy tasks still do); after
        # activation the record expires from its first observation and the
        # legacy creation entry is refused for the removed identifier.
        activated = self.call('handshake', {'protocol': 2})
        self.assertTrue(activated['ok'], activated)
        expired = self.maintenance(clock=first_observed + 30.2 * DAY)['result']
        self.assertEqual(expired['removedJobs'], ['v1-lost'], expired)
        replay = self.call('start', {'jobId': 'v1-lost', 'cwd': str(self.work), 'command': 'printf x'})
        self.assertEqual(replay['error']['code'], 'PROTOCOL_UPGRADE_REQUIRED')

    # --- transfers -------------------------------------------------------------

    def test_interrupted_transfer_data_and_records_expire_3_days_after_last_progress(self):
        registered = self.register_upload(CHUNK * 4)
        transfer_id = registered['result']['transferId']
        started = self.call('transfer_start', {'protocol': 2, 'transferId': transfer_id,
                                               'sourceIdentity': {'size': CHUNK * 4, 'mtimeMs': 1.0}})
        self.assertTrue(started['ok'], started)
        block = b'a' * CHUNK
        control = {'transferId': transfer_id, 'index': 0, 'offset': 0,
                   'sha256': hashlib.sha256(block).hexdigest()}
        payload = (json.dumps(dict(control, sessionId='session-one', size=len(block))) + '\n').encode('utf8') + block
        run = subprocess.run([sys.executable, str(HELPER), '--root', str(self.state), 'transfer_block'],
                             input=payload, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
        self.assertTrue(run.stdout.startswith(b'SSH_MCP_V1 '), run.stderr)
        record_before = json.loads((self.state / 'transfers' / transfer_id / 'record.json').read_text())
        temp = Path(record_before['tempPath'])
        self.assertTrue(temp.exists())
        # Queries observe without renewing anything (spec 7.1).
        self.call('transfer_status', {'transferId': transfer_id})
        record_after = json.loads((self.state / 'transfers' / transfer_id / 'record.json').read_text())
        self.assertEqual(record_after['lastProgressAt'], record_before['lastProgressAt'])
        self.assertEqual(record_after['expiresAt'], record_before['expiresAt'])
        base = time.time()
        result = self.maintenance(clock=base + 3.1 * DAY)['result']
        self.assertEqual(result['removedTransfers'], [transfer_id], result)
        self.assertFalse(temp.exists())
        self.assertFalse((self.state / 'transfers' / transfer_id).exists())
        # The ledger entry for the stopped transfer is released with its temp.
        usage = self.call('resource_usage', {})
        self.assertEqual(usage['result']['resourceCount'], 0, usage)
        replay = self.call('transfer_resume', {'protocol': 2, 'transferId': transfer_id,
                                               'sourceIdentity': {'size': CHUNK * 4, 'mtimeMs': 1.0}})
        self.assertFalse(replay['ok'])
        self.assertEqual(replay['error']['code'], 'REQUEST_EXPIRED_OR_UNKNOWN')

    def test_never_started_transfers_expire_3_days_after_registration(self):
        registered = self.register_upload(CHUNK)
        transfer_id = registered['result']['transferId']
        result = self.maintenance(clock=time.time() + 3.1 * DAY)['result']
        self.assertEqual(result['removedTransfers'], [transfer_id], result)

    def test_terminal_transfer_records_expire_30_days_after_ack(self):
        registered = self.register_upload(0)
        transfer_id = registered['result']['transferId']
        started = self.call('transfer_start', {'protocol': 2, 'transferId': transfer_id,
                                               'sourceIdentity': {'size': 0, 'mtimeMs': 1.0}})
        self.assertTrue(started['ok'], started)
        self.call('transfer_verify', {'transferId': transfer_id})
        committed = self.call('transfer_commit', {'transferId': transfer_id})
        self.assertTrue(committed['ok'], committed)
        acknowledged = self.call('transfer_ack', {'transferId': transfer_id})
        self.assertTrue(acknowledged['ok'], acknowledged)
        result = self.maintenance(clock=time.time() + 30.1 * DAY)['result']
        self.assertEqual(result['removedTransfers'], [transfer_id], result)
        missing = self.call('transfer_status', {'transferId': transfer_id})
        self.assertEqual(missing['error']['code'], 'REQUEST_EXPIRED_OR_UNKNOWN')

    def test_active_transfers_within_ttl_are_kept(self):
        registered = self.register_upload(CHUNK)
        transfer_id = registered['result']['transferId']
        self.call('transfer_start', {'protocol': 2, 'transferId': transfer_id,
                                     'sourceIdentity': {'size': CHUNK, 'mtimeMs': 1.0}})
        result = self.maintenance(clock=time.time() + DAY)['result']
        self.assertEqual(result['removedTransfers'], [])
        self.assertTrue((self.state / 'transfers' / transfer_id / 'record.json').is_file())

    def test_agent_error_in_one_entry_is_skipped_and_the_round_continues(self):
        # A transfer whose processing raises AgentError must be skipped with
        # the cursor advancing -- never abort the round and stall every other
        # section on the same broken entry forever. Reaching that path for
        # real: a live process still holding a legacy per-path lock makes
        # ensure_slot_protocol refuse with LOCK_SWITCH_BLOCKED (issue #8's
        # upgrade gate), which _process_transfer does not catch itself.
        transfers = self.state / 'transfers'
        expired = time.time() - 4 * DAY
        names = ['0' * 32, 'f' * 32]
        for name in names:
            directory = transfers / name
            directory.mkdir(parents=True)
            (directory / 'record.json').write_text(json.dumps(
                {'schemaVersion': 1, 'state': 'transferring', 'lastProgressAt': expired,
                 'registeredAt': expired, 'resourceId': None, 'tempPath': None}))
        # The reads section runs after transfers: an expired credential there
        # proves the later sections were not stalled by the poison entry.
        reads = self.state / 'reads'
        reads.mkdir(parents=True)
        token = 'd' * 32
        (reads / (token + '.json')).write_text(json.dumps(
            {'session': 'session-one', 'path': str(self.work / 'x'), 'version': 1,
             'ranges': [[0, 1]], 'size': 1, 'lastSuccessAt': expired,
             'expiresAt': expired}))
        locks = self.state / 'file-locks'
        locks.mkdir(parents=True)
        with (locks / 'legacy-a').open('a') as guard:
            fcntl.flock(guard, fcntl.LOCK_EX)
            result = self.maintenance(clock=time.time())
            self.assertTrue(result['ok'], result)  # the round survives the entry
        body = result['result']
        self.assertEqual(body['removedTransfers'], [], body)  # every transfer hit the refusal
        for name in names:
            self.assertTrue((transfers / name).is_dir())  # skipped, kept
        self.assertEqual(body['removedReadTokens'], [token], body)  # later sections ran
        self.assertFalse((reads / (token + '.json')).exists())

    def test_interrupted_transfer_release_deletes_the_file_before_the_ledger_entry(self):
        # R7（reclaim 侧）：维护释放同样先删文件、后注销账本——与 transfer
        # 侧 _release_temp 及本机 resetLocalTemp 统一。unlink 失败（非
        # FileNotFoundError 的 OSError，此处 EACCES）时登记必须保留供重试，
        # 不得留下无主孤儿临时文件；unlink 成功而 release 失败时文件已删，
        # False-on-doubt 让下一轮幂等重试注销。in-process 驱动以注入故障。
        sys.path.insert(0, str(HELPER.parent))
        try:
            import reclaim as reclaim_module
            import ledger as ledger_module
            from common import AgentError
        finally:
            sys.path.remove(str(HELPER.parent))
        temp = self.work / '.ssh-mcp-stuck'
        temp.write_bytes(b'stuck upload temp')
        registered = self.call('resource_register', {'path': str(temp), 'bytes': 16,
                                                     'origin': 'transfer'})['result']
        resource_id = registered['resourceId']
        record = {'resourceId': resource_id, 'tempPath': str(temp)}

        # 场景一：unlink 失败——账本登记原样保留，失败可重试而非孤儿。
        original_unlink = os.unlink

        def denied(path):
            raise PermissionError(13, 'Permission denied')
        os.unlink = denied
        try:
            with self.assertRaises(OSError):
                reclaim_module._release_transfer_temp(self.state, record)
        finally:
            os.unlink = original_unlink
        self.assertTrue(temp.exists())
        ledger_data = json.loads((self.state / 'ledger' / 'ledger.json').read_text())
        self.assertIn(resource_id, ledger_data['resources'])

        # 场景二：unlink 成功而账本注销失败（STORAGE_FULL 等 AgentError）。
        original_release = ledger_module.release

        def failing_release(root, resource_id):
            raise AgentError('STORAGE_FULL', 'ledger cannot be persisted')
        ledger_module.release = failing_release
        try:
            self.assertFalse(reclaim_module._release_transfer_temp(self.state, record))
        finally:
            ledger_module.release = original_release
        self.assertFalse(temp.exists())
        ledger_data = json.loads((self.state / 'ledger' / 'ledger.json').read_text())
        self.assertIn(resource_id, ledger_data['resources'])

        # 场景三（正常路径）：删文件与注销一并完成。
        self.assertTrue(reclaim_module._release_transfer_temp(self.state, record))
        self.assertFalse(temp.exists())
        after = json.loads((self.state / 'ledger' / 'ledger.json').read_text())
        self.assertNotIn(resource_id, after['resources'])

    # --- bounds: budget, cursor, mutex ----------------------------------------

    def test_maintenance_respects_the_item_budget_and_resumes_from_the_cursor(self):
        identifiers = []
        for index in range(3):
            job_id, _ = self.run_task('printf x', name='bounded-{}'.format(index))
            self.call('ack', {'jobId': job_id})
            identifiers.append(job_id)
        future = time.time() + 30.1 * DAY
        first = self.maintenance(clock=future, maxItemsPerRun=2)['result']
        self.assertEqual(len(first['removedJobs']), 2, first)
        self.assertFalse(first['completed'])
        self.assertTrue(first['jobsCursor'])
        remaining = sorted(set(identifiers) - set(first['removedJobs']))
        self.assertTrue((self.job_dir(remaining[0])).exists())
        second = self.maintenance(clock=future, maxItemsPerRun=2)['result']
        self.assertEqual(second['removedJobs'], remaining, second)
        self.assertTrue(second['completed'])
        self.assertIsNone(second['jobsCursor'])
        state = json.loads((self.state / 'maintenance.json').read_text())
        self.assertTrue(state['lastCompletedAt'] > 0)

    def test_maintenance_is_serialized_by_its_lock(self):
        locks = self.state / 'locks'
        locks.mkdir(parents=True)
        with (locks / 'maintenance').open('a') as guard:
            fcntl.flock(guard, fcntl.LOCK_EX)
            busy = self.maintenance(clock=time.time())['result']
            self.assertEqual(busy['skipped'], 'busy', busy)
        result = self.maintenance(clock=time.time())['result']
        self.assertNotEqual(result.get('skipped'), 'busy')

    # --- lazy cleanup on query actions ----------------------------------------

    def test_lazy_maintenance_runs_on_query_actions(self):
        job_id, _ = self.run_task('printf lazy')
        self.call('ack', {'jobId': job_id})
        # A status query must opportunistically trigger the bounded cleanup.
        observed = self.call('status', {'jobId': job_id}, clock=time.time() + 3.1 * DAY)
        self.assertTrue(observed['ok'], observed)
        self.assertTrue((self.job_dir(job_id) / 'purged.json').is_file())
        self.assertFalse((self.job_dir(job_id) / 'stdout').exists())

    # --- task log quota --------------------------------------------------------

    def test_task_log_writes_stop_at_the_workspace_quota(self):
        usage = self.call('resource_usage', {})['result']
        limit = usage['usedBytes'] + 1024 * 1024
        (self.state / 'ledger').mkdir(parents=True, exist_ok=True)
        (self.state / 'ledger' / 'policy.json').write_text(json.dumps({'spaceLimitBytes': limit}))
        job_id, state = self.run_task('head -c 4194304 /dev/zero | tr "\\0" x')
        self.assertEqual(state['exitCode'], 0, state)
        self.assertTrue(state['outputTruncated'], state)
        self.assertEqual(state['reason'], 'STORAGE_LIMIT', state)
        stdout = self.job_dir(job_id) / 'stdout'
        self.assertLessEqual(stdout.stat().st_size, 2 * 1024 * 1024)
        self.assertGreater(stdout.stat().st_size, 0)

    # --- issue #17: expired read credentials -----------------------------------

    def test_expired_read_tokens_and_indexes_are_reclaimed_and_rereading_restores_only_the_new_window(self):
        source = self.work / 'credential.txt'
        source.write_text('alpha window text\n' + 'padding line ' * 20 + '\ntail target line\n')
        first = self.call('file_read', {'path': 'credential.txt', 'offset': 0, 'maxBytes': 4096})['result']
        token = first['readToken']
        self.assertTrue(token)
        reads = self.state / 'reads'
        self.assertTrue((reads / (token + '.json')).is_file())
        indexes = [path.name for path in reads.iterdir() if path.name.startswith('index-')]
        self.assertTrue(indexes)
        # Three idle days later the maintenance round reclaims the credential
        # records physically, together with the dangling session-path index.
        result = self.maintenance(clock=time.time() + 3.1 * DAY)['result']
        self.assertEqual(result['removedReadTokens'], [token], result)
        self.assertFalse((reads / (token + '.json')).exists())
        self.assertEqual(result['removedReadIndexes'], indexes, result)
        self.assertFalse((reads / indexes[0]).exists())
        # The reclaimed credential no longer authorizes an edit.
        rejected = self.call('file_edit', {'path': 'credential.txt', 'readToken': token,
                                           'edits': [{'oldText': 'alpha', 'newText': 'beta'}]})
        self.assertFalse(rejected['ok'])
        self.assertIn(rejected['error']['code'], ('READ_REQUIRED', 'READ_TOKEN_EXPIRED'))
        # Recovery is one fresh read of just the needed fragment.
        second = self.call('file_read', {'path': 'credential.txt', 'offset': 0, 'maxBytes': 24})['result']
        edited = self.call('file_edit', {'path': 'credential.txt', 'readToken': second['readToken'],
                                         'edits': [{'oldText': 'alpha', 'newText': 'beta'}]})
        self.assertTrue(edited['ok'], edited)
        # The dead credential's old ranges are not revived: the tail that the
        # expired token once covered is still unauthorized for the new one.
        denied = self.call('file_edit', {'path': 'credential.txt',
                                         'readToken': edited['result']['readToken'],
                                         'edits': [{'oldText': 'tail target line', 'newText': 'x'}]})
        self.assertFalse(denied['ok'])
        self.assertEqual(denied['error']['code'], 'READ_REQUIRED')

    def test_active_read_tokens_within_ttl_survive_maintenance(self):
        source = self.work / 'fresh.txt'
        source.write_text('fresh window\n')
        read = self.call('file_read', {'path': 'fresh.txt'})['result']
        result = self.maintenance(clock=time.time() + DAY)['result']
        self.assertEqual(result['removedReadTokens'], [], result)
        self.assertTrue((self.state / 'reads' / (read['readToken'] + '.json')).is_file())
        edited = self.call('file_edit', {'path': 'fresh.txt', 'readToken': read['readToken'],
                                         'edits': [{'oldText': 'fresh', 'newText': 'cooled'}]})
        self.assertTrue(edited['ok'], edited)

    def test_non_dict_read_records_are_skipped_without_aborting_the_round(self):
        # A reads/ entry that is valid JSON but not an object (a list, a
        # number, ...) is corrupt, not fatal: like the jobs/transfers
        # sections, the round must skip it and still reclaim the genuinely
        # expired credential sorted right behind it.
        reads = self.state / 'reads'
        reads.mkdir(parents=True)
        bad, good = '0' * 32, 'a' * 32  # sorted: the corrupt entry comes first
        now = time.time()
        (reads / (bad + '.json')).write_text('[1, 2]')
        (reads / (good + '.json')).write_text(json.dumps(
            {'session': 'session-one', 'path': str(self.work / 'x'), 'version': 1,
             'ranges': [[0, 1]], 'size': 1, 'lastSuccessAt': now,
             'expiresAt': now - 1}))
        result = self.maintenance(clock=now)
        self.assertTrue(result['ok'], result)  # the round itself must survive
        self.assertEqual(result['result']['removedReadTokens'], [good], result)
        self.assertFalse((reads / (good + '.json')).exists())
        self.assertTrue((reads / (bad + '.json')).is_file())  # corrupt: skipped, kept

    def test_read_index_with_a_non_hex_token_key_is_skipped(self):
        # The index's readToken feeds a path join, so anything that is not a
        # 32-hex key (here a traversal attempt) is corrupt and skipped: the
        # index is never used for access and never deleted by that branch.
        reads = self.state / 'reads'
        reads.mkdir(parents=True)
        index_name = 'index-' + 'c' * 64 + '.json'
        (reads / index_name).write_text(json.dumps({'readToken': '../../evil'}))
        result = self.maintenance(clock=time.time())
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['result']['removedReadIndexes'], [], result)
        self.assertTrue((reads / index_name).is_file())
        # Nothing outside reads/ was touched through the forged key.
        self.assertFalse((self.root / 'evil.json').exists())

    def test_malformed_timestamp_fields_skip_entries_without_aborting_the_round(self):
        # Review round 2 N1: timestamps read via record.get(...) feed numeric
        # comparisons; a syntactically valid JSON object whose timestamp is a
        # string raises TypeError, which escapes every (OSError, ValueError,
        # AgentError) guard and kills the whole round with the cursor stuck.
        # Type-invalid means undecidable, and undecidable entries are skipped
        # and KEPT -- corruption must never trigger a destructive branch.
        now = time.time()
        # reads: an expired-shape credential whose expiresAt is a string.
        reads = self.state / 'reads'
        reads.mkdir(parents=True)
        token = 'd' * 32
        (reads / (token + '.json')).write_text(json.dumps(
            {'session': 'session-one', 'path': str(self.work / 'x'), 'version': 1,
             'ranges': [[0, 1]], 'size': 1, 'lastSuccessAt': now,
             'expiresAt': '2026-01-01T00:00:00Z'}))
        # jobs: a stuck-starting task whose unknown.json marker carries a
        # string firstObservedAt.
        job_id = 'stuck-malformed'
        self._plant_stuck_starting_task(job_id)
        self.call('status', {'jobId': job_id})
        marker = self.job_dir(job_id) / 'unknown.json'
        marker.write_text(json.dumps({'schemaVersion': 1, 'firstObservedAt': 'soon'}))
        # jobs: an acknowledged task whose ack.json carries a string timestamp.
        acked, _ = self.run_task("printf 'log'")
        self.assertTrue(self.call('ack', {'jobId': acked})['ok'])
        (self.job_dir(acked) / 'ack.json').write_text(
            json.dumps({'jobId': acked, 'acknowledgedAt': 'yesterday'}))
        result = self.maintenance(clock=now + 40 * DAY)
        self.assertTrue(result['ok'], result)  # the round must survive all three
        summary = result['result']
        self.assertNotIn(token, summary['removedReadTokens'], summary)
        self.assertTrue((reads / (token + '.json')).is_file())
        self.assertNotIn(job_id, summary['removedJobs'], summary)
        self.assertTrue(self.job_dir(job_id).exists())
        self.assertEqual(summary['purgedLogs'], [], summary)
        self.assertTrue((self.job_dir(acked) / 'stdout').exists())
        # The next healthy entry still gets processed (the round continued).
        healthy, _ = self.run_task('printf healthy')
        self.assertTrue(self.call('ack', {'jobId': healthy})['ok'])
        again = self.maintenance(clock=now + 80 * DAY)['result']
        self.assertEqual(again['removedJobs'], [healthy], again)

    # --- issue #17: stale helper images ----------------------------------------

    def test_stale_helper_images_are_reclaimed_but_live_references_and_the_current_image_survive(self):
        helpers = self.state / 'helpers'
        stale = helpers / ('a' * 64)
        active = helpers / ('b' * 64)
        current = helpers / ('c' * 64)
        for directory in (stale, active, current):
            shutil.copytree(str(HELPER.parent), str(directory))
        # A name that is not a content-addressed image digest is never ours.
        (helpers / 'not-a-digest').mkdir()
        # A live process whose command line references the "active" image --
        # the same evidence a running task worker provides (it is spawned as
        # <image>/agent.py --root ... _worker ...).
        holder = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)',
                                   str(active / 'agent.py')])
        try:
            # The maintenance round itself runs from the "current" image.
            result = self.call_via(current / 'agent.py', 'maintenance', {}, clock=time.time())['result']
            self.assertEqual(result['removedHelpers'], ['a' * 64], result)
            self.assertFalse(stale.exists())
            self.assertTrue(active.exists())
            self.assertTrue(current.exists())
            self.assertTrue((helpers / 'not-a-digest').is_dir())
        finally:
            holder.terminate()
            holder.wait()

    # --- issue #17: crash-leftover temp resources -------------------------------

    def test_crash_leftover_temp_with_dead_holder_is_reclaimed_after_verification(self):
        temp = self.work / '.ssh-mcp-crash'
        temp.write_bytes(b'crash leftover')
        registered = self.call('resource_register', {'path': str(temp), 'bytes': 15,
                                                     'origin': 'file-edit'})['result']
        resource_id = registered['resourceId']
        # Complete the crash picture: the object identity was attached before
        # the holder died (the public actions do not expose attach itself).
        ledger_path = self.state / 'ledger' / 'ledger.json'
        data = json.loads(ledger_path.read_text())
        info = temp.stat()
        data['resources'][resource_id]['identity'] = '{}:{}'.format(info.st_dev, info.st_ino)
        ledger_path.write_text(json.dumps(data))
        # The registering helper subprocess has exited, so the holder is dead;
        # ownership, object identity and occupancy all verify -> reclaim.
        result = self.maintenance(clock=time.time())['result']
        self.assertIn(resource_id, result['reclaimedResources'], result)
        self.assertFalse(temp.exists())
        usage = self.call('resource_usage', {})['result']
        self.assertEqual(usage['resourceCount'], 0, usage)

    def test_live_and_unverifiable_temp_registrations_are_kept(self):
        sys.path.insert(0, str(HELPER.parent))
        try:
            import ledger as ledger_module
        finally:
            sys.path.remove(str(HELPER.parent))
        holder = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'])
        live_temp = self.work / '.ssh-mcp-live'
        live_temp.write_bytes(b'live')
        unverifiable_temp = self.work / '.ssh-mcp-unverified'
        unverifiable_temp.write_bytes(b'unverified')
        live_identity = '9:9'  # never compared while the holder is alive
        live_id, unknown_id = '1' * 32, '2' * 32
        ledger_path = self.state / 'ledger' / 'ledger.json'
        ledger_path.parent.mkdir(parents=True, exist_ok=True)
        ledger_path.write_text(json.dumps({'schemaVersion': 1, 'reservations': {}, 'resources': {
            live_id: {'kind': 'temp-file', 'path': str(live_temp), 'bytes': 4, 'identity': live_identity,
                      'holderPid': holder.pid, 'holderIdentity': ledger_module.process_identity(holder.pid),
                      'session': None, 'origin': 'file-edit', 'reservationId': None,
                      'createdAt': time.time()},
            unknown_id: {'kind': 'temp-file', 'path': str(unverifiable_temp), 'bytes': 11, 'identity': None,
                         'holderPid': 4194303, 'holderIdentity': 'boot:41', 'session': None,
                         'origin': 'file-edit', 'reservationId': None, 'createdAt': time.time()},
        }}))
        try:
            result = self.maintenance(clock=time.time())['result']
            self.assertEqual(result['reclaimedResources'], [], result)
            self.assertIn(unknown_id, result['unknownResources'], result)
            # The live holder and the unverifiable object both stay untouched.
            self.assertTrue(live_temp.exists())
            self.assertTrue(unverifiable_temp.exists())
            after = json.loads(ledger_path.read_text())['resources']
            self.assertIn(live_id, after)
            self.assertIn(unknown_id, after)
            # Unknown occupancy keeps management fields only: no result body
            # may hide inside the resource ledger.
            self.assertLessEqual(set(after[unknown_id].keys()),
                                 {'kind', 'path', 'bytes', 'identity', 'holderPid', 'holderIdentity',
                                  'session', 'origin', 'reservationId', 'createdAt'})
            # ...and the kept bytes still count against the workspace quota.
            usage = self.call('resource_usage', {})['result']
            self.assertGreaterEqual(usage['tempBytes'], 15, usage)
        finally:
            holder.terminate()
            holder.wait()

    def test_transfer_managed_resources_are_left_to_the_transfer_records(self):
        # A living transfer record manages its temp and ledger entry with
        # transfer-specific evidence (slot lock plus its own TTL); the generic
        # resource pass must never race it, even though the registering helper
        # process (the recorded holder) is long gone.
        registered = self.register_upload(CHUNK)
        transfer_id = registered['result']['transferId']
        started = self.call('transfer_start', {'protocol': 2, 'transferId': transfer_id,
                                               'sourceIdentity': {'size': CHUNK, 'mtimeMs': 1.0}})
        self.assertTrue(started['ok'], started)
        record = json.loads((self.state / 'transfers' / transfer_id / 'record.json').read_text())
        temp = Path(record['tempPath'])
        block = b'z' * CHUNK
        payload = (json.dumps({'transferId': transfer_id, 'index': 0, 'offset': 0,
                               'sha256': hashlib.sha256(block).hexdigest(),
                               'sessionId': 'session-one', 'size': len(block)}) + '\n').encode('utf8') + block
        run = subprocess.run([sys.executable, str(HELPER), '--root', str(self.state), 'transfer_block'],
                             input=payload, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
        self.assertTrue(run.stdout.startswith(b'SSH_MCP_V1 '), run.stderr)
        result = self.maintenance(clock=time.time())['result']
        self.assertEqual(result['reclaimedResources'], [], result)
        self.assertTrue(temp.exists())
        usage = self.call('resource_usage', {})['result']
        self.assertGreaterEqual(usage['resourceCount'], 1, usage)
        # The transfer itself stays resumable.
        resumed = self.call('transfer_resume', {'protocol': 2, 'transferId': transfer_id,
                                                'sourceIdentity': {'size': CHUNK, 'mtimeMs': 1.0}})
        self.assertTrue(resumed['ok'], resumed)

    def test_files_without_a_ledger_registration_are_never_deleted(self):
        stray = self.work / '.ssh-mcp-not-in-ledger'
        stray.write_bytes(b'owned by nobody we know')
        result = self.maintenance(clock=time.time())['result']
        self.assertTrue(stray.exists())
        self.assertEqual(result['reclaimedResources'], [], result)

    def test_regular_operation_temps_are_cleaned_up_immediately(self):
        source = self.work / 'clean.txt'
        source.write_text('to be edited\n')
        read = self.call('file_read', {'path': 'clean.txt'})['result']
        edited = self.call('file_edit', {'path': 'clean.txt', 'readToken': read['readToken'],
                                         'edits': [{'oldText': 'edited', 'newText': 'replaced'}]})
        self.assertTrue(edited['ok'], edited)
        written = self.call('file_write', {'path': 'created.txt', 'text': 'created\n', 'create': True})
        self.assertTrue(written['ok'], written)
        # Successful operations leave no temp behind and no ledger entry -- no
        # three-day wait applies to temps the operation itself owns.
        self.assertEqual(list(self.work.glob('.ssh-mcp-*')), [])
        usage = self.call('resource_usage', {})['result']
        self.assertEqual(usage['resourceCount'], 0, usage)


if __name__ == '__main__':
    unittest.main()
