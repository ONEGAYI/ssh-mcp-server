"""Contract tests against the remote helper's public CLI (Python 3.6+)."""
import base64
import json
import os
from pathlib import Path
import subprocess
import signal
import sys
import tempfile
import time
import unittest


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


if __name__ == '__main__':
    unittest.main(verbosity=2)
