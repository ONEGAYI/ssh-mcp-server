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
