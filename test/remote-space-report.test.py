"""Ticket #19 behavior tests: the on-demand storage summary attached to the
file_workspace helper action. includeStorage defaults to absent (no
statistics, no extra work); when enabled the reply is a bounded (< 4 KiB)
ledger + maintenance summary that reuses the accounting semantics of
remote/ledger.py: registered sibling temps counted, committed targets
excluded, reservations never double counted with the usage they materialized
into. Driven through the helper's public CLI. Runs on Linux (fcntl) with
Python 3.6+."""
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest


HELPER = Path(__file__).resolve().parents[1] / 'remote' / 'agent.py'
DAY = 86400
GIB = 1024 ** 3


class RemoteSpaceReportTest(unittest.TestCase):
    def setUp(self):
        self.fixture = tempfile.TemporaryDirectory(prefix='ssh-mcp space ')
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
        data = dict(request, workspaceRoot=str(self.work), sessionId=session)
        env = dict(os.environ)
        if clock is not None:
            env['SSH_MCP_TEST_CLOCK'] = repr(clock)
        run = subprocess.run([sys.executable, str(HELPER), '--root', str(self.state), action],
                             input=json.dumps(data).encode('utf8'), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             timeout=60, env=env)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertTrue(run.stdout.startswith(b'SSH_MCP_V1 '), run.stdout)
        return json.loads(base64.b64decode(run.stdout.split(b' ', 1)[1]))

    def storage(self, **extra):
        payload = self.call('file_workspace', dict(extra, includeStorage=True))
        self.assertTrue(payload['ok'], payload)
        return payload['result']['storage']

    # --- the default call stays free of statistics -------------------------------

    def test_default_workspace_call_has_no_storage_section(self):
        payload = self.call('file_workspace', {})
        self.assertTrue(payload['ok'], payload)
        self.assertNotIn('storage', payload['result'])
        self.assertIn('capabilities', payload['result'])

    # --- enabled: bounded, categorized, ledger-consistent ------------------------

    def test_include_storage_returns_bounded_summary(self):
        storage = self.storage()
        for field in ('stateBytes', 'tempBytes', 'reservedBytes', 'usedBytes',
                      'limitBytes', 'resourceCount', 'reservationCount', 'maintenance'):
            self.assertIn(field, storage, field)
        self.assertEqual(storage['limitBytes'], 10 * GIB)
        self.assertEqual(storage['usedBytes'],
                         storage['stateBytes'] + storage['tempBytes'] + storage['reservedBytes'])
        self.assertEqual(storage['resourceCount'], 0)
        self.assertEqual(storage['reservationCount'], 0)
        serialized = json.dumps(storage, separators=(',', ':'), sort_keys=True).encode('utf8')
        self.assertLessEqual(len(serialized), 4096, len(serialized))

    def test_include_storage_rejects_non_boolean_flag(self):
        payload = self.call('file_workspace', {'includeStorage': 'yes'})
        self.assertFalse(payload['ok'], payload)
        self.assertEqual(payload['error']['code'], 'INVALID_REQUEST')

    def test_storage_limit_reflects_the_policy_file(self):
        directory = self.state / 'ledger'
        directory.mkdir(parents=True, exist_ok=True)
        (directory / 'policy.json').write_text(json.dumps({'spaceLimitBytes': 8192}))
        self.assertEqual(self.storage()['limitBytes'], 8192)

    # --- 计量口径与账本一致：目标旁临时计入、预留不双重计数、提交移出 ----------------

    def test_measurement_counts_registered_sibling_temps_without_double_counting(self):
        # 目标同目录临时文件（.ssh-mcp-upload-<id> 命名）必须计入；引用预留的
        # 登记按净增量计，预留与已写占用不双重计数（与 resource_usage 同口径）。
        target = self.work / ('.ssh-mcp-upload-' + 'a' * 32)
        target.write_bytes(b'x' * 1500)
        reservation = self.call('resource_reserve', {'bytes': 1500})['result']['reservationId']
        resource = self.call('resource_register', {'path': str(target), 'bytes': 1500,
                                                   'origin': 'test', 'reservationId': reservation})
        self.assertTrue(resource['ok'], resource)
        storage = self.storage()
        self.assertEqual(storage['tempBytes'], 1500)
        self.assertEqual(storage['reservedBytes'], 0)
        self.assertEqual(storage['usedBytes'], storage['stateBytes'] + 1500)
        self.assertEqual(storage['resourceCount'], 1)
        # 提交注销登记后，正式目标移出计量。
        self.assertTrue(self.call('resource_forget', {'resourceId': resource['result']['resourceId']})['ok'])
        after = self.storage()
        self.assertEqual(after['tempBytes'], 0)
        self.assertEqual(after['usedBytes'], after['stateBytes'])
        # 未引用预留的登记单独计入 reservedBytes，释放后回落。
        held = self.call('resource_reserve', {'bytes': 700})['result']['reservationId']
        self.assertEqual(self.storage()['reservedBytes'], 700)
        self.assertTrue(self.call('resource_release', {'reservationId': held})['ok'])
        self.assertEqual(self.storage()['reservedBytes'], 0)

    # --- 最近清理时间与计数来自持久化的维护轮结果 ----------------------------------

    def test_maintenance_section_reports_last_round_counts(self):
        # 任何清理轮尚未发生时，时间与计数为零，不猜数。
        fresh = self.storage()
        self.assertEqual(fresh['maintenance']['lastCompletedAt'], 0)
        self.assertEqual(fresh['maintenance']['lastRunAt'], 0)
        for field in ('removedJobs', 'purgedLogs', 'markedUnknown', 'removedTransfers', 'itemsConsidered'):
            self.assertIn(field, fresh['maintenance'], field)
        # 真实跑一轮：注册并确认一个任务，加速时钟跨过确认日志期限后维护清理，
        # 汇总必须报告该轮持久化的计数与时间。
        registered = self.call('task_register', {'protocol': 2, 'command': 'printf hi',
                                                 'cwd': str(self.work), 'env': {}})
        self.assertTrue(registered['ok'], registered)
        job_id = registered['result']['jobId']
        self.assertTrue(self.call('task_start', {'protocol': 2, 'jobId': job_id})['ok'])
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            observed = self.call('status', {'jobId': job_id})['result']
            if observed['state'] in ('exited', 'cancelled', 'interrupted'):
                break
            time.sleep(0.05)
        else:
            self.fail('task did not finish: ' + json.dumps(observed))
        self.assertTrue(self.call('ack', {'jobId': job_id})['ok'])
        future = time.time() + 3.2 * DAY
        self.assertTrue(self.call('maintenance', {}, clock=future)['ok'])
        storage = self.storage()
        self.assertEqual(storage['maintenance']['purgedLogs'], 1)
        self.assertEqual(storage['maintenance']['removedJobs'], 0)
        self.assertGreater(storage['maintenance']['lastRunAt'], 0)
        self.assertGreater(storage['maintenance']['lastCompletedAt'], 0)
        self.assertGreaterEqual(storage['maintenance']['itemsConsidered'], 1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
