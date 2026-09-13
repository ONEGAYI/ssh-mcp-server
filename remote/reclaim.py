"""Bounded expiry reclamation for task and transfer records (issue #16).

Retention rules (spec 7.1 / ADR 0010), evaluated against an injectable
clock so tests never wait real days:

  acknowledged task logs        3 days from the acknowledgement
  acknowledged task/transfer    30 days from the acknowledgement
    records
  finished unacknowledged       30 days from completion
    results
  unknown-shape task records    30 days from the FIRST unknown observation
                                (queries never renew it)
  interrupted transfer data     3 days from the last real progress (or the
  and their records               registration, when nothing ever moved)

Deleting a record never reopens execution: task_start without a
registration is REQUEST_EXPIRED_OR_UNKNOWN and every transfer action
requires the registered record, so reclaimed identifiers stay refused.

Every round is bounded by an item budget and a wall-clock budget, persists
a cursor after each considered entry, and holds the workspace maintenance
flock so two processes never reclaim the same workspace concurrently.
Query actions trigger a throttled lazy attempt (lazy_attempt) on top of the
hourly online maintenance driven by the local end. Ledger entries left
pointing at orphaned temps by older crashes are #17's verified-reclamation
domain; this module only releases what a per-transfer lock proves stopped.
Python 3.6 standard library only.
"""
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import shutil
import time

from common import AgentError, atomic_json, read_json


DAY_MS = 86400 * 1000
DEFAULT_RETENTION_MS = {
    'confirmedTaskLogMs': 3 * DAY_MS,
    'confirmedResultMs': 30 * DAY_MS,
    'unconfirmedResultMs': 30 * DAY_MS,
    'unknownRecordMs': 30 * DAY_MS,
    'interruptedTransferDataMs': 3 * DAY_MS,
}
DEFAULT_MAX_ITEMS = 100
DEFAULT_TIME_BUDGET_MS = 2000
LAZY_THROTTLE_SECONDS = 60
TRANSFER_TERMINAL = frozenset(('completed', 'failed', 'cancelled', 'interrupted'))
TASK_TERMINAL = frozenset(('exited', 'cancelled', 'interrupted'))
# Query actions that opportunistically trigger the throttled lazy round.
LAZY_ACTIONS = frozenset(('status', 'output', 'transfer_status',
                          'file_read', 'file_list', 'file_find', 'file_search'))


def _now():
    """Injectable clock (same pattern as transfer.py) for expiry verdicts."""
    clock = os.environ.get('SSH_MCP_TEST_CLOCK')
    return float(clock) if clock is not None else time.time()


def _maintenance_state_path(root):
    return Path(root) / 'maintenance.json'


def _load_maintenance_state(root):
    path = _maintenance_state_path(root)
    if not path.is_file():
        return {'schemaVersion': 1, 'lastRunAt': 0, 'lastCompletedAt': 0,
                'jobsCursor': None, 'transfersCursor': None, 'lastLazyAt': 0}
    try:
        state = read_json(path)
    except (OSError, ValueError):
        # A corrupt bookkeeping file must never block reclamation.
        return {'schemaVersion': 1, 'lastRunAt': 0, 'lastCompletedAt': 0,
                'jobsCursor': None, 'transfersCursor': None, 'lastLazyAt': 0}
    if not isinstance(state, dict):
        return {'schemaVersion': 1, 'lastRunAt': 0, 'lastCompletedAt': 0,
                'jobsCursor': None, 'transfersCursor': None, 'lastLazyAt': 0}
    state.setdefault('schemaVersion', 1)
    state.setdefault('lastRunAt', 0)
    state.setdefault('lastCompletedAt', 0)
    state.setdefault('jobsCursor', None)
    state.setdefault('transfersCursor', None)
    state.setdefault('lastLazyAt', 0)
    return state


def _save_maintenance_state(root, state):
    atomic_json(_maintenance_state_path(root), state)


def _policy_overrides(root):
    """Optional retention/maintenance overrides from ledger/policy.json."""
    path = Path(root) / 'ledger' / 'policy.json'
    if not path.is_file():
        return {}
    try:
        policy = read_json(path)
    except (OSError, ValueError):
        return {}
    return policy if isinstance(policy, dict) else {}


def _valid_period_ms(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0


def _resolve_periods(root, request):
    """Request overrides beat policy.json, which beats the spec defaults.

    The request carries the local end's freshly loaded policy (loadPolicy),
    so profile changes apply from the next maintenance round without a
    remote restart. Returned values are in seconds."""
    policy = _policy_overrides(root)
    policy_retention = policy.get('retentionMs')
    if not isinstance(policy_retention, dict):
        policy_retention = {}
    request_retention = request.get('retentionMs')
    if not isinstance(request_retention, dict):
        request_retention = {}
    periods = {}
    for key, default_ms in DEFAULT_RETENTION_MS.items():
        chosen = default_ms
        if key in policy_retention and _valid_period_ms(policy_retention[key]):
            chosen = policy_retention[key]
        if key in request_retention:
            if not _valid_period_ms(request_retention[key]):
                raise AgentError('INVALID_REQUEST',
                                 'retentionMs.{} must be a nonnegative number of milliseconds'.format(key))
            chosen = request_retention[key]
        periods[key] = chosen / 1000.0
    return periods


def _resolve_options(root, request):
    policy = _policy_overrides(root)
    policy_maintenance = policy.get('maintenance')
    if not isinstance(policy_maintenance, dict):
        policy_maintenance = {}
    options = {}
    for key, default, low, high in (('maxItemsPerRun', DEFAULT_MAX_ITEMS, 1, 100000),
                                    ('timeBudgetMs', DEFAULT_TIME_BUDGET_MS, 1, 3600000)):
        chosen = default
        if key in policy_maintenance and _valid_period_ms(policy_maintenance[key]):
            chosen = policy_maintenance[key]
        if key in request:
            value = request.get(key)
            if not isinstance(value, int) or isinstance(value, bool) or not low <= value <= high:
                raise AgentError('INVALID_REQUEST',
                                 '{} must be an integer between {} and {}'.format(key, low, high))
            chosen = value
        options[key] = chosen
    return options


@contextmanager
def _try_flock(path):
    """Yield True when the exclusive lock was acquired without blocking."""
    descriptor = os.open(str(path), os.O_WRONLY | os.O_CREAT, 0o600)
    stream = os.fdopen(descriptor, 'a')
    try:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            yield False
            return
        yield True
    finally:
        stream.close()


def _maintenance_lock(root):
    locks = Path(root) / 'locks'
    locks.mkdir(mode=0o700, parents=True, exist_ok=True)
    return locks / 'maintenance'


def _remove_tree(path):
    shutil.rmtree(str(path), ignore_errors=False)


def _purge_job_logs(path, now):
    atomic_json(path / 'purged.json', {'schemaVersion': 1, 'purgedAt': now})
    for name in ('stdout', 'stderr', 'launcher.log'):
        try:
            (path / name).unlink()
        except FileNotFoundError:
            pass


def _process_job(root, name, periods, now, summary):
    """Reclaim one task directory under its job lock; conservative by design."""
    import agent
    try:
        path = agent.job_path(root, name)
    except AgentError:
        return
    locks = Path(root) / 'locks'
    with _try_flock(locks / name) as held:
        if not held:
            return
        state_file = path / 'state.json'
        if not state_file.is_file():
            # A prepared registration has no expiry in the spec; keep it.
            return
        try:
            state = read_json(state_file)
        except (OSError, ValueError):
            return
        if not isinstance(state, dict):
            return
        if state.get('state') in TASK_TERMINAL:
            _process_terminal_job(root, path, state, periods, now, summary)
            return
        # Non-terminal: only the observed-unknown shape carries an expiry.
        try:
            observed = agent.describe(root, name)
        except AgentError:
            return
        if observed.get('state') != 'unknown':
            return
        marker = path / 'unknown.json'
        if not marker.is_file():
            # First observation only; queries and failures never renew it.
            atomic_json(marker, {'schemaVersion': 1, 'firstObservedAt': now})
            summary['markedUnknown'].append(name)
            return
        try:
            first_observed = read_json(marker).get('firstObservedAt', 0)
        except (OSError, ValueError):
            return
        if now - first_observed >= periods['unknownRecordMs']:
            _remove_tree(path)
            summary['removedJobs'].append(name)


def _process_terminal_job(root, path, state, periods, now, summary):
    ack = path / 'ack.json'
    name = path.name
    if ack.is_file():
        try:
            acknowledged = read_json(ack).get('acknowledgedAt', 0)
        except (OSError, ValueError):
            return
        if now - acknowledged >= periods['confirmedTaskLogMs'] and not (path / 'purged.json').exists():
            _purge_job_logs(path, now)
            summary['purgedLogs'].append(name)
        if now - acknowledged >= periods['confirmedResultMs'] and _record_deletion_allowed(root, path):
            _remove_tree(path)
            summary['removedJobs'].append(name)
        return
    completed = state.get('completedAt')
    if isinstance(completed, (int, float)) and not isinstance(completed, bool):
        if now - completed >= periods['unconfirmedResultMs'] and _record_deletion_allowed(root, path):
            _remove_tree(path)
            summary['removedJobs'].append(name)


def _record_deletion_allowed(root, path):
    """Legacy (v1) records are only deleted once the v2 protocol is active.

    Before activation the legacy start entry can still create tasks, so
    deleting a v1 record would let a replayed old request rerun through the
    upgrade window. Logs are safe to purge either way; the deduplication
    record survives until activation."""
    return (path / 'registration.json').is_file() or (Path(root) / 'protocol.json').is_file()


def _process_transfer(root, name, periods, now, summary):
    from locks import ensure_slot_protocol, lock_directory, slot_index
    path = Path(root) / 'transfers' / name
    if not path.is_dir() or path.is_symlink():
        return
    ensure_slot_protocol(root)
    slot = lock_directory(root) / ('slot-{:03d}'.format(slot_index(name)))
    with _try_flock(slot) as held:
        if not held:
            # Something is moving this transfer right now; never judge it.
            return
        record_file = path / 'record.json'
        if not record_file.is_file():
            return
        try:
            record = read_json(record_file)
        except (OSError, ValueError):
            return
        if not isinstance(record, dict):
            return
        if record.get('state') in TRANSFER_TERMINAL:
            ack = path / 'ack.json'
            if ack.is_file():
                try:
                    acknowledged = read_json(ack).get('acknowledgedAt', 0)
                except (OSError, ValueError):
                    return
                if now - acknowledged >= periods['confirmedResultMs']:
                    _remove_tree(path)
                    summary['removedTransfers'].append(name)
                return
            completed = record.get('completedAt')
            if isinstance(completed, (int, float)) and not isinstance(completed, bool):
                if now - completed >= periods['unconfirmedResultMs']:
                    _remove_tree(path)
                    summary['removedTransfers'].append(name)
            return
        # Non-terminal: expired interrupted data. The per-transfer lock is
        # the same no-blocks-in-flight evidence cancel uses, so releasing
        # the temp here mirrors issue #15 instead of guessing.
        last_progress = record.get('lastProgressAt')
        if not isinstance(last_progress, (int, float)) or isinstance(last_progress, bool):
            last_progress = record.get('registeredAt', 0)
        if now - last_progress < periods['interruptedTransferDataMs']:
            return
        if not _release_transfer_temp(root, record):
            return
        _remove_tree(path)
        summary['removedTransfers'].append(name)


def _release_transfer_temp(root, record):
    """Release the stopped transfer's temp and ledger entry; False on doubt."""
    import ledger
    resource_id = record.get('resourceId')
    if resource_id:
        try:
            ledger.release(root, resource_id)
        except AgentError:
            return False
    temp = record.get('tempPath')
    if temp:
        try:
            os.unlink(temp)
        except FileNotFoundError:
            pass
    return True


def _sorted_names(directory):
    if not directory.is_dir():
        return []
    return sorted(candidate.name for candidate in directory.iterdir()
                  if not candidate.is_symlink())


def _run_round(root, request):
    """One bounded round; the caller already holds the maintenance lock."""
    periods = _resolve_periods(root, request)
    options = _resolve_options(root, request)
    now = _now()
    deadline = time.monotonic() + options['timeBudgetMs'] / 1000.0
    state = _load_maintenance_state(root)
    summary = {'removedJobs': [], 'purgedLogs': [], 'markedUnknown': [],
               'removedTransfers': [], 'itemsConsidered': 0}
    items = 0
    exhausted = False

    jobs_cursor = state.get('jobsCursor')
    for name in _sorted_names(Path(root) / 'jobs'):
        if jobs_cursor is not None and name <= jobs_cursor:
            continue
        if items >= options['maxItemsPerRun'] or time.monotonic() >= deadline:
            exhausted = True
            break
        try:
            _process_job(root, name, periods, now, summary)
        except OSError:
            pass  # one unreadable entry never aborts the round
        items += 1
        jobs_cursor = name
        state['jobsCursor'] = jobs_cursor
        _save_maintenance_state(root, state)
    if not exhausted:
        jobs_cursor = None
        state['jobsCursor'] = None
        _save_maintenance_state(root, state)

    transfers_cursor = state.get('transfersCursor')
    if not exhausted:
        for name in _sorted_names(Path(root) / 'transfers'):
            if transfers_cursor is not None and name <= transfers_cursor:
                continue
            if items >= options['maxItemsPerRun'] or time.monotonic() >= deadline:
                exhausted = True
                break
            try:
                _process_transfer(root, name, periods, now, summary)
            except OSError:
                pass
            items += 1
            transfers_cursor = name
            state['transfersCursor'] = transfers_cursor
            _save_maintenance_state(root, state)
        if not exhausted:
            state['transfersCursor'] = None
            _save_maintenance_state(root, state)

    summary['itemsConsidered'] = items
    summary['completed'] = not exhausted
    summary['jobsCursor'] = state.get('jobsCursor')
    summary['transfersCursor'] = state.get('transfersCursor')
    state['lastRunAt'] = now
    if not exhausted:
        state['lastCompletedAt'] = now
    _save_maintenance_state(root, state)
    return summary


def run_maintenance(root, request):
    """Public helper action: one bounded, mutually exclusive round."""
    if not isinstance(request, dict):
        raise AgentError('INVALID_REQUEST', 'Maintenance request must be an object')
    with _try_flock(_maintenance_lock(root)) as held:
        if not held:
            return {'skipped': 'busy', 'reason': 'Another process is maintaining this workspace'}
        return _run_round(root, request)


def lazy_attempt(root):
    """Throttled opportunistic round attached to query actions.

    The throttle clock is the same injectable clock as the expiry verdicts,
    so an accelerated test clock (or a real offline gap) reopens the lazy
    path exactly when new data may have expired. Failures are swallowed:
    the query's own result must never depend on cleanup."""
    try:
        state = _load_maintenance_state(root)
        if _now() - state.get('lastLazyAt', 0) < LAZY_THROTTLE_SECONDS:
            return
        with _try_flock(_maintenance_lock(root)) as held:
            if not held:
                return
            state = _load_maintenance_state(root)
            if _now() - state.get('lastLazyAt', 0) < LAZY_THROTTLE_SECONDS:
                return
            _run_round(root, {})
            state['lastLazyAt'] = _now()
            _save_maintenance_state(root, state)
    except Exception:
        return
