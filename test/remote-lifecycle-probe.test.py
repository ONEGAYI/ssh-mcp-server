"""Linux-only public CLI checks for the stage-0 remote lifecycle probe."""
import os
from pathlib import Path
import subprocess
import signal
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / 'scripts' / 'probes' / 'remote-task-lifecycle.sh'


def wait_for(path, seconds=5):
    deadline = time.monotonic() + seconds
    while not path.exists() and time.monotonic() < deadline:
        time.sleep(0.025)
    if not path.exists():
        raise AssertionError('Timed out waiting for {}'.format(path.name))


class LifecycleProbeTest(unittest.TestCase):
    def stop_own_worker(self, job):
        if not (job / 'worker-pid').exists():
            return
        pid = int((job / 'worker-pid').read_text())
        try:
            # Only signal this fixture's detached process group, never a reused PID.
            command = Path('/proc/{}/cmdline'.format(pid)).read_bytes()
            if str(job.parent).encode() in command and b'worker' in command and os.getpgid(pid) == pid:
                os.killpg(pid, signal.SIGKILL)
        except (FileNotFoundError, ProcessLookupError):
            pass

    def test_command_outlives_launcher_and_result_is_read_by_new_process(self):
        with tempfile.TemporaryDirectory(prefix='ssh-mcp lifecycle ') as tmp:
            root = Path(tmp)
            # A gate, rather than a guessed command duration, controls completion.
            command = "printf ready > ready; deadline=$((SECONDS+20)); while [ ! -f release ]; do [ $SECONDS -lt $deadline ] || exit 98; sleep 0.05; done; printf 'hello\\n'; printf 'warning\\n' >&2; exit 7"
            job = root / 'job-one'
            try:
                launched = subprocess.run(['/usr/bin/bash', str(RUNNER), 'start', str(root), 'job-one', command],
                                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=5)
                self.assertEqual(launched.returncode, 0, launched.stderr)
                wait_for(job / 'ready')
                running = subprocess.check_output(['/usr/bin/bash', str(RUNNER), 'inspect', str(root), 'job-one'],
                                                  universal_newlines=True, timeout=5)
                self.assertIn('state=running', running)
            finally:
                if job.exists():
                    (job / 'release').touch()
                    try:
                        wait_for(job / 'exit-code')
                    finally:
                        self.stop_own_worker(job)
            inspected = subprocess.check_output(['/usr/bin/bash', str(RUNNER), 'inspect', str(root), 'job-one'],
                                                universal_newlines=True, timeout=5)
            self.assertIn('state=exited', inspected)
            self.assertIn('exitCode=7', inspected)
            self.assertEqual((job / 'stdout').read_bytes(), b'hello\n')
            self.assertEqual((job / 'stderr').read_bytes(), b'warning\n')

    def test_dead_worker_is_not_reported_as_running(self):
        with tempfile.TemporaryDirectory(prefix='ssh-mcp dead worker ') as tmp:
            root = Path(tmp)
            job = root / 'job-dead'
            try:
                subprocess.check_call(['/usr/bin/bash', str(RUNNER), 'start', str(root), 'job-dead', 'sleep 20'],
                                      stdout=subprocess.DEVNULL, timeout=5)
                wait_for(job / 'running')
                self.stop_own_worker(job)
                deadline = time.monotonic() + 2
                while time.monotonic() < deadline:
                    inspected = subprocess.check_output(['/usr/bin/bash', str(RUNNER), 'inspect', str(root), 'job-dead'],
                                                        universal_newlines=True, timeout=5)
                    if 'state=unknown' in inspected:
                        break
                    time.sleep(0.025)
                self.assertIn('state=unknown', inspected)
            finally:
                self.stop_own_worker(job)


if __name__ == '__main__':
    unittest.main(verbosity=2)
