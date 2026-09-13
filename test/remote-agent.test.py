"""Contract tests against the remote helper's public CLI (Python 3.6+)."""
import base64
import json
import os
from pathlib import Path
import shutil
import subprocess
import signal
import sys
import tempfile
import time
import unittest
from unittest import mock


HELPER = Path(__file__).resolve().parents[1] / 'remote' / 'agent.py'


class RemoteAgentTest(unittest.TestCase):
    def setUp(self):
        self.fixture = tempfile.TemporaryDirectory(prefix='ssh-mcp remote agent ')
        self.root = Path(self.fixture.name)

    def tearDown(self):
        # Stop only processes recorded by this private test fixture.
        for state_file in (self.root / 'state' / 'jobs').glob('*/state.json'):
            try:
                state = json.loads(state_file.read_text())
                for pid_key, identity_key in (('pid', 'processIdentity'), ('workerPid', 'workerIdentity')):
                    pid = state.get(pid_key)
                    if not pid:
                        continue
                    fields = Path('/proc/{}/stat'.format(pid)).read_text().rsplit(')', 1)[1].split()
                    identity = Path('/proc/sys/kernel/random/boot_id').read_text().strip() + ':' + fields[19]
                    if identity == state.get(identity_key) and os.getpgid(pid) == pid:
                        os.killpg(pid, signal.SIGKILL)
            except (FileNotFoundError, ProcessLookupError):
                pass
        self.fixture.cleanup()

    def call(self, action, data):
        run = subprocess.run([sys.executable, str(HELPER), '--root', str(self.root / 'state'), action],
                             input=json.dumps(data), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             universal_newlines=True, timeout=10)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertTrue(run.stdout.startswith('SSH_MCP_V1 '), run.stdout)
        return json.loads(base64.b64decode(run.stdout.split(' ', 1)[1]))

    def wait_exit(self, job_id):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            response = self.call('status', {'jobId': job_id})
            self.assertTrue(response['ok'], response)
            if response['result']['state'] == 'exited':
                return response['result']
            time.sleep(0.025)
        self.fail('Task did not exit')

    def test_task_preserves_cwd_environment_streams_and_exit_result(self):
        work = self.root / 'work 空格'
        work.mkdir()
        started = self.call('start', {'jobId': 'job-one', 'cwd': str(work),
                                     'command': 'printf "%s\\n" "$PROBE_TEXT"; pwd; printf "warning\\n" >&2; exit 7',
                                     'env': {'PROBE_TEXT': 'hello'}})
        self.assertTrue(started['ok'], started)
        self.assertEqual(started['result']['jobId'], 'job-one')
        ended = self.wait_exit('job-one')
        self.assertEqual(ended['exitCode'], 7)
        output = self.call('output', {'jobId': 'job-one'})
        self.assertTrue(output['ok'], output)
        self.assertEqual(base64.b64decode(output['result']['stdout']['data']), ('hello\n' + str(work) + '\n').encode())
        self.assertEqual(base64.b64decode(output['result']['stderr']['data']), b'warning\n')
        self.assertTrue(output['result']['terminal'])

    def test_retrying_start_returns_original_task_without_reexecuting_command(self):
        request = {'jobId': 'job-retry', 'cwd': str(self.root), 'command': 'printf x >> counter'}
        first = self.call('start', request)
        self.assertTrue(first['ok'], first)
        self.wait_exit('job-retry')
        second = self.call('start', request)
        self.assertTrue(second['ok'], second)
        self.assertEqual(second['result']['jobId'], 'job-retry')
        self.assertEqual((self.root / 'counter').read_text(), 'x')
        conflict = self.call('start', dict(request, command='printf y >> counter'))
        self.assertFalse(conflict['ok'])
        self.assertEqual(conflict['error']['code'], 'REQUEST_CONFLICT')

    def test_cancel_terminates_the_task_and_reports_observed_result(self):
        started = self.call('start', {'jobId': 'job-cancel', 'cwd': str(self.root),
                                     'command': 'printf ready > ready; sleep 30'})
        self.assertTrue(started['ok'], started)
        deadline = time.monotonic() + 5
        while not (self.root / 'ready').exists() and time.monotonic() < deadline:
            time.sleep(0.025)
        self.assertTrue((self.root / 'ready').exists())
        cancelled = self.call('cancel', {'jobId': 'job-cancel'})
        self.assertTrue(cancelled['ok'], cancelled)
        while time.monotonic() < deadline:
            state = self.call('status', {'jobId': 'job-cancel'})['result']
            if state['state'] == 'cancelled':
                break
            time.sleep(0.025)
        self.assertEqual(state['state'], 'cancelled')
        self.assertLess(state['exitCode'], 0)

    def test_explicit_execution_deadline_stops_a_long_command(self):
        started = self.call('start', {'jobId': 'job-deadline', 'cwd': str(self.root),
                                     'command': 'sleep 30', 'executionTimeoutMs': 100})
        self.assertTrue(started['ok'], started)
        ended = self.wait_exit('job-deadline')
        self.assertEqual(ended['reason'], 'EXECUTION_TIMEOUT')
        self.assertLess(ended['exitCode'], 0)

    def test_output_budget_bounds_persisted_bytes_and_reports_the_reason(self):
        started = self.call('start', {'jobId': 'job-budget', 'cwd': str(self.root),
                                     'command': "printf '%2048s' x; sleep 30", 'maxOutputBytes': 1024})
        self.assertTrue(started['ok'], started)
        ended = self.wait_exit('job-budget')
        self.assertEqual(ended['reason'], 'OUTPUT_LIMIT')
        output = self.call('output', {'jobId': 'job-budget'})['result']
        total = len(base64.b64decode(output['stdout']['data'])) + len(base64.b64decode(output['stderr']['data']))
        self.assertEqual(total, 1024)

    def test_cancel_reaps_resistant_group_after_shell_exits(self):
        command = "trap 'exit 0' TERM; /bin/bash -c 'trap \"\" TERM; echo $$ > resistant.pid; while :; do sleep 1; done' & wait"
        started = self.call('start', {'jobId': 'job-group', 'cwd': str(self.root), 'command': command})
        self.assertTrue(started['ok'], started)
        deadline = time.monotonic() + 5
        while not (self.root / 'resistant.pid').exists() and time.monotonic() < deadline:
            time.sleep(0.025)
        pid = int((self.root / 'resistant.pid').read_text())
        try:
            self.assertTrue(self.call('cancel', {'jobId': 'job-group'})['ok'])
            while time.monotonic() < deadline:
                state = self.call('status', {'jobId': 'job-group'})['result']
                if state['state'] == 'cancelled':
                    break
                time.sleep(0.025)
            self.assertEqual(state['state'], 'cancelled')
            proc = Path('/proc/{}/stat'.format(pid))
            if proc.exists():
                self.assertIn(proc.read_text().rsplit(')', 1)[1].split()[0], ('Z', 'X'))
        finally:
            # This test-created descendant may survive the deliberately failing implementation.
            try:
                if Path('/proc/{}/stat'.format(pid)).exists():
                    os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def test_log_cleanup_requires_ack_and_preserves_start_deduplication(self):
        request = {'jobId': 'job-cleanup', 'cwd': str(self.root), 'command': 'printf x >> counter; printf log'}
        self.assertTrue(self.call('start', request)['ok'])
        self.wait_exit('job-cleanup')
        self.assertEqual(self.call('cleanup', {'retentionDays': 0})['result']['purgedJobs'], [])
        self.assertTrue(self.call('ack', {'jobId': 'job-cleanup'})['ok'])
        cleaned = self.call('cleanup', {'retentionDays': 0})
        self.assertEqual(cleaned['result']['purgedJobs'], ['job-cleanup'])
        self.assertEqual(self.call('output', {'jobId': 'job-cleanup'})['error']['code'], 'LOGS_PURGED')
        self.assertTrue(self.call('start', request)['ok'])
        self.assertEqual((self.root / 'counter').read_text(), 'x')

    def test_atomic_json_syncs_the_parent_directory_entry(self):
        # os.replace 之后的目录项掉电持久性需要父目录 fsync 兜底；
        # atomic_json 必须经过该辅助（打开失败时静默跳过不影响调用）。
        sys.path.insert(0, str(HELPER.parent))
        import common as common_module
        target = self.root / 'state' / 'nested' / 'state.json'
        target.parent.mkdir(parents=True)
        with mock.patch.object(common_module, '_sync_parent_directory',
                               wraps=common_module._sync_parent_directory) as observed:
            common_module.atomic_json(target, {'b': 2, 'a': 1})
        observed.assert_called_once_with(target)
        self.assertEqual(json.loads(target.read_text()), {'a': 1, 'b': 2})

    def test_protocol_v2_registers_before_executing_and_rejects_unregistered_ids(self):
        registered = self.call('task_register', {'protocol': 2, 'cwd': str(self.root),
                                                 'command': 'printf once >> v2-counter'})
        self.assertTrue(registered['ok'], registered)
        self.assertIn('jobId', registered['result'])
        job_id = registered['result']['jobId']
        started = self.call('task_start', {'protocol': 2, 'jobId': job_id})
        self.assertTrue(started['ok'], started)
        self.assertEqual(self.wait_exit(job_id)['state'], 'exited')
        # Retrying the start (a lost response must not execute the task twice).
        for _ in range(2):
            retried = self.call('task_start', {'protocol': 2, 'jobId': job_id})
            self.assertTrue(retried['ok'], retried)
        self.assertEqual((self.root / 'v2-counter').read_text(), 'once')
        # Unknown identifiers are rejected; execution never falls back to creation.
        missing = self.call('task_start', {'protocol': 2, 'jobId': 'never-registered'})
        self.assertFalse(missing['ok'])
        self.assertEqual(missing['error']['code'], 'REQUEST_EXPIRED_OR_UNKNOWN')
        # Once the v2 protocol is active the legacy entry cannot create tasks.
        legacy = self.call('start', {'jobId': 'legacy-fresh', 'cwd': str(self.root), 'command': 'printf x'})
        self.assertFalse(legacy['ok'])
        self.assertEqual(legacy['error']['code'], 'PROTOCOL_UPGRADE_REQUIRED')

    def test_task_start_recovers_from_a_crash_between_the_two_startup_writes(self):
        # 崩溃窗口：request.json 已写、state.json 未写。该窗口内 worker 必然
        # 从未 spawn（state.json 写在 spawn 之前），task_start 必须补写状态并
        # 启动 worker，而不是永远回报 prepared 让任务既不执行也不报错。
        registered = self.call('task_register', {'protocol': 2, 'cwd': str(self.root),
                                                 'command': 'printf once >> crash-counter'})
        self.assertTrue(registered['ok'], registered)
        job_id = registered['result']['jobId']
        job = self.root / 'state' / 'jobs' / job_id
        registration = json.loads((job / 'registration.json').read_text())
        request = {'jobId': job_id, 'command': registration['command'], 'cwd': registration['cwd'],
                   'env': registration['env'], 'executionTimeoutMs': registration['executionTimeoutMs'],
                   'maxOutputBytes': registration['maxOutputBytes']}
        (job / 'request.json').write_text(json.dumps(request))
        started = self.call('task_start', {'protocol': 2, 'jobId': job_id})
        self.assertTrue(started['ok'], started)
        ended = self.wait_exit(job_id)
        self.assertEqual(ended['exitCode'], 0)
        self.assertEqual((self.root / 'crash-counter').read_text(), 'once')

    def test_protocol_handshake_blocks_activation_until_legacy_tasks_drain(self):
        # Before activation the legacy entry still works (upgrade window).
        started = self.call('start', {'jobId': 'legacy-running', 'cwd': str(self.root), 'command': 'sleep 30'})
        self.assertTrue(started['ok'], started)
        blocked = self.call('handshake', {'protocol': 2})
        self.assertFalse(blocked['ok'])
        self.assertEqual(blocked['error']['code'], 'LEGACY_TASKS_PENDING')
        rejected = self.call('task_register', {'protocol': 2, 'cwd': str(self.root), 'command': 'printf y'})
        self.assertFalse(rejected['ok'])
        self.assertEqual(rejected['error']['code'], 'LEGACY_TASKS_PENDING')
        # Drain the legacy task without killing it silently: cancel and observe.
        self.assertTrue(self.call('cancel', {'jobId': 'legacy-running'})['ok'])
        deadline = time.monotonic() + 5
        state = None
        while time.monotonic() < deadline:
            state = self.call('status', {'jobId': 'legacy-running'})['result']
            if state['state'] == 'cancelled':
                break
            time.sleep(0.025)
        self.assertEqual(state['state'], 'cancelled')
        active = self.call('handshake', {'protocol': 2})
        self.assertTrue(active['ok'], active)
        self.assertEqual(active['result']['status'], 'active')
        repeated = self.call('handshake', {'protocol': 2})
        self.assertTrue(repeated['ok'], repeated)
        self.assertEqual(repeated['result']['status'], 'active')
        # Observed legacy tasks stay queryable and their replay entry stays idempotent.
        replay = self.call('start', {'jobId': 'legacy-running', 'cwd': str(self.root), 'command': 'sleep 30'})
        self.assertTrue(replay['ok'], replay)
        self.assertEqual(replay['result']['state'], 'cancelled')
        fresh = self.call('start', {'jobId': 'legacy-after', 'cwd': str(self.root), 'command': 'printf z'})
        self.assertFalse(fresh['ok'])
        self.assertEqual(fresh['error']['code'], 'PROTOCOL_UPGRADE_REQUIRED')

    def test_deleted_task_records_reject_old_ids_and_new_ids_differ(self):
        registered = self.call('task_register', {'protocol': 2, 'cwd': str(self.root), 'command': 'printf done'})
        self.assertTrue(registered['ok'], registered)
        job_id = registered['result']['jobId']
        self.assertTrue(self.call('task_start', {'protocol': 2, 'jobId': job_id})['ok'])
        self.wait_exit(job_id)
        shutil.rmtree(str(self.root / 'state' / 'jobs' / job_id))
        restart = self.call('task_start', {'protocol': 2, 'jobId': job_id})
        self.assertFalse(restart['ok'])
        self.assertEqual(restart['error']['code'], 'REQUEST_EXPIRED_OR_UNKNOWN')
        recreated = self.call('start', {'jobId': job_id, 'cwd': str(self.root), 'command': 'printf done'})
        self.assertFalse(recreated['ok'])
        self.assertEqual(recreated['error']['code'], 'PROTOCOL_UPGRADE_REQUIRED')
        fresh = self.call('task_register', {'protocol': 2, 'cwd': str(self.root), 'command': 'printf done'})
        self.assertTrue(fresh['ok'], fresh)
        self.assertNotEqual(fresh['result']['jobId'], job_id)

    def test_v2_actions_require_explicit_protocol_and_registration_reports_prepared(self):
        missing = self.call('task_register', {'cwd': str(self.root), 'command': 'printf x'})
        self.assertFalse(missing['ok'])
        self.assertEqual(missing['error']['code'], 'INVALID_PROTOCOL')
        unversioned = self.call('task_start', {'jobId': 'anything'})
        self.assertFalse(unversioned['ok'])
        self.assertEqual(unversioned['error']['code'], 'INVALID_PROTOCOL')
        registered = self.call('task_register', {'protocol': 2, 'cwd': str(self.root), 'command': 'printf x'})
        self.assertTrue(registered['ok'], registered)
        observed = self.call('status', {'jobId': registered['result']['jobId']})
        self.assertTrue(observed['ok'], observed)
        self.assertEqual(observed['result']['state'], 'prepared')


if __name__ == '__main__':
    unittest.main(verbosity=2)
