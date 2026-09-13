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
import uuid
from common import AgentError, atomic_json, read_json


PROTOCOL = 'SSH_MCP_V1 '
PROTOCOL_VERSION = 2
TERMINAL = frozenset(('exited', 'cancelled', 'interrupted'))
# Task log writes are an unbounded unknown increment: past this many bytes
# the worker re-checks the workspace quota (spec 7.2) before saving more.
LOG_QUOTA_CHECK_BYTES = 1024 * 1024
# Query actions that also trigger a throttled lazy reclamation round (#16).
LAZY_ACTIONS = frozenset(('status', 'output', 'transfer_status',
                          'file_read', 'file_list', 'file_find', 'file_search'))


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
        # A durable registration without a startup record is an observable,
        # not-yet-executed task. It must not be reported as missing.
        if (path / 'registration.json').is_file():
            registration = read_json(path / 'registration.json')
            return {'schemaVersion': 1, 'jobId': job_id, 'state': 'prepared',
                    'registeredAt': registration.get('registeredAt'),
                    'cancelRequested': (path / 'cancel.json').exists()}
        raise AgentError('JOB_NOT_FOUND', 'Task record not found')
    state = read_json(path / 'state.json')
    if state['state'] == 'starting' and time.time() - state['createdAt'] > 30:
        state = dict(state, state='unknown', reason='START_STATE_UNKNOWN')
    if state['state'] == 'running' and process_identity(state['workerPid']) != state['workerIdentity']:
        state = dict(state, state='unknown', reason='WORKER_UNAVAILABLE')
    state['cancelRequested'] = (path / 'cancel.json').exists()
    return state


def request_digest(normalized):
    return hashlib.sha256(json.dumps(normalized, sort_keys=True).encode('utf8')).hexdigest()


def validate_task_request(request):
    """Validate the common task parameters; return the normalized request body."""
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
    return {'command': command, 'cwd': cwd, 'env': environment,
            'executionTimeoutMs': timeout_ms, 'maxOutputBytes': output_limit}


def require_protocol(request):
    if request.get('protocol') != PROTOCOL_VERSION:
        raise AgentError('INVALID_PROTOCOL', 'This action requires protocol version 2')


def read_protocol_state(root):
    """Return the persisted activation record, or None before activation.

    An unreadable activation record must never re-open the legacy creation
    entry, so corruption is raised instead of ignored."""
    path = root / 'protocol.json'
    if not path.is_file():
        return None
    try:
        state = read_json(path)
    except ValueError:
        raise AgentError('PROTOCOL_STATE_UNKNOWN', 'Protocol activation record is unreadable; resolve it before starting new tasks')
    if not isinstance(state, dict) or state.get('protocol') != PROTOCOL_VERSION:
        raise AgentError('PROTOCOL_STATE_UNKNOWN', 'Protocol activation record is invalid; resolve it before starting new tasks')
    return state


def legacy_pending_jobs(root):
    """Legacy (v1) task directories that have not reached a terminal state."""
    jobs = root / 'jobs'
    pending = []
    if not jobs.exists():
        return pending
    for candidate in sorted(jobs.iterdir()):
        if candidate.is_symlink() or not candidate.is_dir():
            continue
        path = job_path(root, candidate.name)
        if (path / 'registration.json').is_file():
            continue
        try:
            state = read_json(path / 'state.json')
            finished = isinstance(state, dict) and state.get('state') in TERMINAL
        except (OSError, ValueError):
            finished = False
        if not finished:
            pending.append(candidate.name)
    return pending


def ensure_protocol_active(root):
    """Idempotently activate the v2 register-then-execute protocol.

    Activation is refused while legacy tasks are still running: never kill
    them silently, and never let both protocols accept new writes at once."""
    state = read_protocol_state(root)
    if state is not None:
        return state
    locks = root / 'locks'
    locks.mkdir(mode=0o700, exist_ok=True)
    with (locks / 'protocol').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = read_protocol_state(root)
        if state is not None:
            return state
        pending = legacy_pending_jobs(root)
        if pending:
            raise AgentError('LEGACY_TASKS_PENDING',
                             'Legacy tasks are still running: {}'.format(', '.join(pending[:5])))
        state = {'schemaVersion': 1, 'protocol': PROTOCOL_VERSION, 'activatedAt': time.time()}
        atomic_json(root / 'protocol.json', state)
        return state


def handshake(root, request):
    require_protocol(request)
    state = ensure_protocol_active(root)
    return {'protocol': state['protocol'], 'status': 'active', 'activatedAt': state['activatedAt']}


def task_register(root, request):
    require_protocol(request)
    normalized = validate_task_request(request)
    ensure_protocol_active(root)
    job_id = str(uuid.uuid4())
    path = job_path(root, job_id)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        raise AgentError('REQUEST_CONFLICT', 'Task identifier was already assigned')
    registration = dict(normalized, schemaVersion=1, requestHash=request_digest(normalized),
                        registeredAt=time.time())
    atomic_json(path / 'registration.json', registration)
    return {'jobId': job_id, 'state': 'prepared', 'registeredAt': registration['registeredAt']}


def task_start(root, request):
    require_protocol(request)
    job_id = request.get('jobId')
    path = job_path(root, job_id)
    locks = root / 'locks'
    locks.mkdir(mode=0o700, exist_ok=True)
    with (locks / job_id).open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if not (path / 'registration.json').is_file():
            # Unknown or removed identifiers never fall back to creation.
            raise AgentError('REQUEST_EXPIRED_OR_UNKNOWN',
                             'No registration for this task identifier; register it explicitly first')
        if (path / 'request.json').is_file():
            # At most one execution per registration, including lost responses.
            if not (path / 'state.json').is_file():
                # Crash between the two writes: request.json was persisted but
                # state.json was not, so the worker was never spawned (the
                # state write precedes the spawn). Finish the startup here
                # instead of reporting prepared forever.
                registration = read_json(path / 'registration.json')
                state = {'schemaVersion': 1, 'jobId': job_id, 'state': 'starting', 'createdAt': time.time(),
                         'requestHash': registration['requestHash']}
                atomic_json(path / 'state.json', state)
                with (path / 'launcher.log').open('ab') as log:
                    subprocess.Popen([sys.executable, os.path.abspath(__file__), '--root', str(root), '_worker', '--job-id', job_id],
                                     stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True, close_fds=True)
            return describe(root, job_id)
        if (path / 'state.json').is_file():
            raise AgentError('START_STATE_UNKNOWN', 'Existing task has an incomplete startup record; do not rerun')
        registration = read_json(path / 'registration.json')
        if not os.path.isdir(registration['cwd']):
            raise AgentError('INVALID_CWD', 'Working directory must exist when starting a new task')
        normalized = {'jobId': job_id, 'command': registration['command'], 'cwd': registration['cwd'],
                      'env': registration['env'], 'executionTimeoutMs': registration['executionTimeoutMs'],
                      'maxOutputBytes': registration['maxOutputBytes']}
        atomic_json(path / 'request.json', normalized)
        state = {'schemaVersion': 1, 'jobId': job_id, 'state': 'starting', 'createdAt': time.time(),
                 'requestHash': registration['requestHash']}
        atomic_json(path / 'state.json', state)
        with (path / 'launcher.log').open('ab') as log:
            subprocess.Popen([sys.executable, os.path.abspath(__file__), '--root', str(root), '_worker', '--job-id', job_id],
                             stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True, close_fds=True)
        return describe(root, job_id)


def start(root, request):
    """Legacy entry: replay observations for existing tasks only.

    Before the v2 protocol is activated this can still create tasks (upgrade
    window); afterwards creation is refused so no client can bypass
    registration."""
    job_id = request.get('jobId')
    path = job_path(root, job_id)
    normalized = dict(validate_task_request(request), jobId=job_id)
    digest = request_digest(normalized)
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
        # Serialize the creation check with activation so both protocols can
        # never accept new writes at once. Lock order: job lock, then protocol lock.
        with (locks / 'protocol').open('a') as protocol_lock:
            fcntl.flock(protocol_lock, fcntl.LOCK_EX)
            if read_protocol_state(root) is not None:
                raise AgentError('PROTOCOL_UPGRADE_REQUIRED',
                                 'The register-then-execute protocol is active; create tasks through task_register')
            if not os.path.isdir(normalized['cwd']):
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
            code, reason, truncated = collect_process(root, process, path, request, stdout, stderr)
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


def workspace_log_quota_exceeded(root):
    """True when the workspace space limit is already consumed.

    Used by the task worker to stop persisting new log bytes (spec 7.2):
    the pipe keeps draining so the child never blocks, the stoppage is
    recorded as an explicit STORAGE_LIMIT truncation, and a broken ledger
    never costs log data -- on doubt, keep writing."""
    try:
        import ledger
        usage = ledger.usage(root)
        return usage['usedBytes'] > usage['limitBytes']
    except Exception:
        return False


def collect_process(root, process, path, request, stdout, stderr):
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ, stdout)
    selector.register(process.stderr, selectors.EVENT_READ, stderr)
    reason = None
    stopped_at = None
    finished_at = None
    killed = False
    truncated = False
    written = 0
    quota_blocked = False
    next_quota_check = 0
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
                # STORAGE_LIMIT only stops persisting log bytes (the child keeps
                # running and its output keeps draining, spec 7.2); every other
                # recorded reason (cancel, timeout, output budget) stops the task.
                if reason and reason != 'STORAGE_LIMIT' and stopped_at is None:
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
                if written >= next_quota_check:
                    # Bounded-block quota admission for the unknown increment.
                    next_quota_check = written + LOG_QUOTA_CHECK_BYTES
                    if not quota_blocked and workspace_log_quota_exceeded(root):
                        quota_blocked = True
                        truncated = True
                        reason = reason or 'STORAGE_LIMIT'
                remaining = max(0, request['maxOutputBytes'] - written)
                accepted = b'' if quota_blocked else data[:remaining]
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
    if args.action == 'transfer_block':
        # Block exchanges frame their own stdin: a JSON control line followed
        # by exactly `size` raw bytes, so the generic JSON parse never sees
        # the binary tail.
        from transfer import block_exchange
        result = block_exchange(root, sys.stdin.buffer)
        emit({'ok': True, 'result': result})
        return
    if args.action == 'transfer_fetch':
        # Download fetches invert the framing onto stdout: a JSON control
        # line, exactly `size` raw bytes, a newline, then the regular
        # envelope -- so binary blocks never ride inside base64 JSON. An
        # error keeps the envelope-only shape.
        from transfer import fetch_exchange
        control, payload, result = fetch_exchange(root, sys.stdin.buffer)
        sys.stdout.buffer.write(json.dumps(control, ensure_ascii=True, sort_keys=True).encode('utf8'))
        sys.stdout.buffer.write(b'\n')
        sys.stdout.buffer.write(payload)
        sys.stdout.buffer.write(b'\n')
        sys.stdout.buffer.flush()
        emit({'ok': True, 'result': result})
        return
    request = json.loads(sys.stdin.buffer.read().decode('utf8'))
    if not isinstance(request, dict):
        raise AgentError('INVALID_REQUEST', 'Request must be an object')
    if args.action == 'handshake':
        result = handshake(root, request)
    elif args.action == 'task_register':
        result = task_register(root, request)
    elif args.action == 'task_start':
        result = task_start(root, request)
    elif args.action == 'start':
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
    elif args.action == 'maintenance':
        from reclaim import run_maintenance
        result = run_maintenance(root, request)
    elif args.action.startswith('resource_'):
        from ledger import resource_action
        result = resource_action(root, args.action, request)
    elif args.action.startswith('transfer_'):
        from transfer import transfer_action
        result = transfer_action(root, args.action, request)
    elif args.action.startswith('file_'):
        from files import FileService
        result = FileService(root, request.get('workspaceRoot'), request.get('sessionId'),
                             request.get('allowedRemotePaths'), request.get('directoryScope') or 'restricted').call(args.action, request)
    else:
        raise AgentError('UNSUPPORTED_ACTION', 'Unknown helper action')
    if args.action in LAZY_ACTIONS:
        # Opportunistic bounded reclamation after the query's own result is
        # settled (spec 7.2): cleanup must never fail or delay the answer.
        from reclaim import lazy_attempt
        lazy_attempt(root)
    emit({'ok': True, 'result': result})


def emit(value):
    payload = json.dumps(value, ensure_ascii=True, separators=(',', ':')).encode('utf8')
    print(PROTOCOL + base64.b64encode(payload).decode('ascii'))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        emit({'ok': False, 'error': {'code': getattr(error, 'code', 'HELPER_ERROR'), 'message': str(error)}})
