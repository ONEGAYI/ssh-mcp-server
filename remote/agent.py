#!/usr/bin/env python3
"""SSH remote helper. Python 3.6 standard library only; no network listener."""
import argparse
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import signal
import subprocess
import sys
import time
from common import AgentError, atomic_json, read_json


PROTOCOL = 'SSH_MCP_V1 '
TERMINAL = frozenset(('exited', 'cancelled', 'interrupted'))


def process_identity(pid):
    try:
        fields = Path('/proc/{}/stat'.format(pid)).read_text().rsplit(')', 1)[1].split()
        if fields[0] in ('Z', 'X'):
            return None
        return Path('/proc/sys/kernel/random/boot_id').read_text().strip() + ':' + fields[19]
    except (OSError, ValueError, IndexError):
        return None


def job_path(root, job_id):
    if not isinstance(job_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', job_id):
        raise AgentError('INVALID_JOB_ID', 'Invalid task identifier')
    path = root / 'jobs' / job_id
    if path.is_symlink():
        raise AgentError('INVALID_STATE_PATH', 'Task directory must not be a symlink')
    return path


def describe(root, job_id):
    path = job_path(root, job_id)
    if not (path / 'state.json').is_file():
        raise AgentError('JOB_NOT_FOUND', 'Task record not found')
    state = read_json(path / 'state.json')
    if state['state'] == 'starting' and time.time() - state['createdAt'] > 30:
        state = dict(state, state='unknown', reason='START_STATE_UNKNOWN')
    if state['state'] == 'running' and process_identity(state['workerPid']) != state['workerIdentity']:
        state = dict(state, state='unknown', reason='WORKER_UNAVAILABLE')
    state['cancelRequested'] = (path / 'cancel.json').exists()
    return state


def start(root, request):
    job_id = request.get('jobId')
    path = job_path(root, job_id)
    command = request.get('command')
    cwd = request.get('cwd')
    environment = request.get('env', {})
    if not isinstance(command, str) or not command or '\0' in command:
        raise AgentError('INVALID_COMMAND', 'Command must be nonempty text without NUL')
    if not isinstance(cwd, str) or not os.path.isabs(cwd) or '\0' in cwd:
        raise AgentError('INVALID_CWD', 'Working directory must be an absolute directory')
    if not isinstance(environment, dict) or any(
            not isinstance(key, str) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', key)
            or not isinstance(value, str) or '\0' in value for key, value in environment.items()):
        raise AgentError('INVALID_ENV', 'Environment must contain valid variable names and string values')
    timeout_ms = request.get('executionTimeoutMs')
    if timeout_ms is not None and (not isinstance(timeout_ms, int) or isinstance(timeout_ms, bool) or not 1 <= timeout_ms <= 9007199254740991):
        raise AgentError('INVALID_TIMEOUT', 'executionTimeoutMs must be a positive safe integer')
    output_limit = request.get('maxOutputBytes', 256 * 1024 * 1024)
    if not isinstance(output_limit, int) or isinstance(output_limit, bool) or not 1 <= output_limit <= 9007199254740991:
        raise AgentError('INVALID_LIMIT', 'maxOutputBytes must be a positive safe integer')
    normalized = {'jobId': job_id, 'command': command, 'cwd': cwd, 'env': environment,
                  'executionTimeoutMs': timeout_ms, 'maxOutputBytes': output_limit}
    digest = hashlib.sha256(json.dumps(normalized, sort_keys=True).encode('utf8')).hexdigest()
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    locks = root / 'locks'
    locks.mkdir(mode=0o700, exist_ok=True)
    with (locks / job_id).open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if path.exists():
            if not (path / 'request.json').is_file():
                raise AgentError('START_STATE_UNKNOWN', 'Existing task has an incomplete startup record; do not rerun')
            if read_json(path / 'request.json') != normalized:
                raise AgentError('REQUEST_CONFLICT', 'Task identifier was already used with different parameters')
            return describe(root, job_id)
        if not os.path.isdir(cwd):
            raise AgentError('INVALID_CWD', 'Working directory must exist when starting a new task')
        path.mkdir(mode=0o700)
        atomic_json(path / 'request.json', normalized)
        state = {'schemaVersion': 1, 'jobId': job_id, 'state': 'starting', 'createdAt': time.time(), 'requestHash': digest}
        atomic_json(path / 'state.json', state)
        with (path / 'launcher.log').open('ab') as log:
            subprocess.Popen([sys.executable, os.path.abspath(__file__), '--root', str(root), '_worker', '--job-id', job_id],
                             stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True, close_fds=True)
        return describe(root, job_id)


def worker(root, job_id):
    path = job_path(root, job_id)
    # Never run a second worker for the same task, including after a crash.
    with (path / 'worker.claim').open('x') as claim:
        claim.write(str(os.getpid()))
    request = read_json(path / 'request.json')
    state = read_json(path / 'state.json')
    state.update(state='running', startedAt=time.time(), workerPid=os.getpid(), workerIdentity=process_identity(os.getpid()))
    atomic_json(path / 'state.json', state)
    process = None
    try:
        with (path / 'stdout').open('wb', buffering=0) as stdout, (path / 'stderr').open('wb', buffering=0) as stderr:
            process = subprocess.Popen(['/bin/bash', '-c', request['command']], cwd=request['cwd'],
                                       env=dict(os.environ, **request['env']), stdin=subprocess.DEVNULL,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True, close_fds=True)
            state.update(pid=process.pid, processIdentity=process_identity(process.pid))
            atomic_json(path / 'state.json', state)
            code, reason, truncated = collect_process(process, path, request, stdout, stderr)
        state.update(state='cancelled' if reason == 'CANCELLED' else 'exited', exitCode=code,
                     completedAt=time.time(), outputTruncated=truncated)
        if reason:
            state['reason'] = reason
    except Exception as error:
        if process is not None and process.returncode is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
        state.update(state='interrupted', reason='EXECUTION_ERROR', error=str(error), completedAt=time.time())
    atomic_json(path / 'state.json', state)


def collect_process(process, path, request, stdout, stderr):
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ, stdout)
    selector.register(process.stderr, selectors.EVENT_READ, stderr)
    reason = None
    stopped_at = None
    finished_at = None
    killed = False
    truncated = False
    written = 0
    deadline = time.monotonic() + request['executionTimeoutMs'] / 1000.0 if request['executionTimeoutMs'] else None
    try:
        while True:
            now = time.monotonic()
            # Observe without reaping. The retained child (even a zombie) anchors
            # the process-group ID until cancellation of descendants is finished.
            exited = os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None
            if not exited:
                if reason is None and (path / 'cancel.json').exists():
                    reason = 'CANCELLED'
                if reason is None and deadline and now >= deadline:
                    reason = 'EXECUTION_TIMEOUT'
            elif finished_at is None:
                finished_at = now
            try:
                if reason and stopped_at is None:
                    os.killpg(process.pid, signal.SIGTERM)
                    stopped_at = now
                elif stopped_at is not None and now - stopped_at >= 1 and not killed:
                    os.killpg(process.pid, signal.SIGKILL)
                    killed = True
            except ProcessLookupError:
                stopped_at = stopped_at or now
                killed = True
            cancelling = stopped_at is not None and not killed
            if exited and not selector.get_map() and not cancelling:
                break
            if finished_at is not None and now - finished_at >= 1 and selector.get_map() and not cancelling:
                # A descendant may retain a pipe after the main command has exited.
                truncated = True
                break
            for key, _ in selector.select(0.05):
                data = os.read(key.fileobj.fileno(), 65536)
                if not data:
                    selector.unregister(key.fileobj)
                    continue
                remaining = max(0, request['maxOutputBytes'] - written)
                accepted = data[:remaining]
                key.data.write(accepted)
                written += len(accepted)
                if len(data) > len(accepted):
                    truncated = True
                    reason = reason or 'OUTPUT_LIMIT'
        return process.wait(), reason, truncated
    finally:
        selector.close()
        process.stdout.close()
        process.stderr.close()


def output(root, request):
    state = describe(root, request.get('jobId'))
    path = job_path(root, request['jobId'])
    if (path / 'purged.json').exists():
        raise AgentError('LOGS_PURGED', 'Acknowledged logs were explicitly cleaned; the task outcome and deduplication record remain')
    limit = request.get('maxBytes', 65536)
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 1048576:
        raise AgentError('INVALID_LIMIT', 'maxBytes must be between 1 and 1048576')
    result = {'jobId': request['jobId'], 'state': state['state'], 'terminal': state['state'] in TERMINAL}
    for name in ('stdout', 'stderr'):
        offset = request.get(name + 'Offset', 0)
        if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
            raise AgentError('INVALID_OFFSET', 'Output offsets must be nonnegative integers')
        target = path / name
        size = target.stat().st_size if target.exists() else 0
        if request.get('tail', False):
            offset = max(0, size - limit)
        if offset > size:
            raise AgentError('INVALID_OFFSET', 'Output offset is beyond current log size')
        data = b''
        if target.exists():
            with target.open('rb') as stream:
                stream.seek(offset)
                data = stream.read(min(limit, size - offset))
        result[name] = {'data': base64.b64encode(data).decode('ascii'), 'startOffset': offset, 'nextOffset': offset + len(data),
                        'hasMore': offset + len(data) < size, 'totalBytes': size}
    return result


def cancel(root, request):
    state = describe(root, request.get('jobId'))
    if state['state'] in TERMINAL:
        return state
    if state['state'] == 'unknown':
        raise AgentError('WORKER_UNAVAILABLE', 'Cannot confirm task control; do not signal an unverified PID')
    atomic_json(job_path(root, request['jobId']) / 'cancel.json', {'requestedAt': time.time()})
    return describe(root, request['jobId'])


def acknowledge(root, request):
    state = describe(root, request.get('jobId'))
    if state['state'] not in TERMINAL:
        raise AgentError('TASK_NOT_FINISHED', 'Only a terminal result can be acknowledged')
    path = job_path(root, request['jobId'])
    if not (path / 'ack.json').exists():
        atomic_json(path / 'ack.json', {'acknowledgedAt': time.time(), 'jobId': request['jobId']})
    return {'acknowledged': True, 'jobId': request['jobId']}


def cleanup(root, request):
    days = request.get('retentionDays', 7)
    if not isinstance(days, (int, float)) or isinstance(days, bool) or not 0 <= days <= 36500:
        raise AgentError('INVALID_RETENTION', 'retentionDays must be between 0 and 36500')
    cutoff = time.time() - days * 86400
    purged = []
    jobs = root / 'jobs'
    if not jobs.exists():
        return {'purgedJobs': purged}
    for candidate in sorted(jobs.iterdir()):
        if candidate.is_symlink() or not candidate.is_dir():
            continue
        path = job_path(root, candidate.name)
        ack = path / 'ack.json'
        if not ack.exists() or (path / 'purged.json').exists():
            continue
        if describe(root, path.name)['state'] not in TERMINAL or read_json(ack)['acknowledgedAt'] > cutoff:
            continue
        # Preserve request/state/claim as a permanent no-rerun record. Never recurse
        # over caller-selected paths or remove unacknowledged results.
        atomic_json(path / 'purged.json', {'purgedAt': time.time()})
        for name in ('stdout', 'stderr', 'launcher.log'):
            try:
                (path / name).unlink()
            except FileNotFoundError:
                pass
        purged.append(path.name)
    return {'purgedJobs': purged, 'retentionDays': days}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('action')
    parser.add_argument('--job-id')
    args = parser.parse_args()
    os.umask(0o077)
    root = Path(args.root)
    if not root.is_absolute() or str(root) == '/' or root.is_symlink():
        raise AgentError('INVALID_STATE_PATH', 'State root must be a private absolute directory')
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if args.action == '_worker':
        worker(root, args.job_id)
        return
    request = json.loads(sys.stdin.buffer.read().decode('utf8'))
    if not isinstance(request, dict):
        raise AgentError('INVALID_REQUEST', 'Request must be an object')
    if args.action == 'start':
        result = start(root, request)
    elif args.action == 'status':
        result = describe(root, request.get('jobId'))
    elif args.action == 'output':
        result = output(root, request)
    elif args.action == 'cancel':
        result = cancel(root, request)
    elif args.action == 'ack':
        result = acknowledge(root, request)
    elif args.action == 'cleanup':
        result = cleanup(root, request)
    elif args.action.startswith('file_'):
        from files import FileService
        result = FileService(root, request.get('workspaceRoot'), request.get('sessionId'),
                             request.get('allowedRemotePaths'), request.get('directoryScope') or 'restricted').call(args.action, request)
    else:
        raise AgentError('UNSUPPORTED_ACTION', 'Unknown helper action')
    emit({'ok': True, 'result': result})


def emit(value):
    payload = json.dumps(value, ensure_ascii=True, separators=(',', ':')).encode('utf8')
    print(PROTOCOL + base64.b64encode(payload).decode('ascii'))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        emit({'ok': False, 'error': {'code': getattr(error, 'code', 'HELPER_ERROR'), 'message': str(error)}})
