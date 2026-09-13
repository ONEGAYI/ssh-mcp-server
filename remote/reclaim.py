"""Bounded expiry reclamation for task and transfer records (issue #16), plus
expired read credentials, stale helper images and crash-leftover temp
resources (issue #17).

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
  read credentials              their own recorded expiry (the same
                                expiresAt the read path enforces); a fresh
                                read never revives dead ranges
  helper images                 everything except the running image and the
                                images live processes still reference
  crash-leftover temps          verified by ownership (the ledger
                                registration), object identity and occupancy;
                                unknown occupancy keeps management fields only

Deleting a record never reopens execution: task_start without a
registration is REQUEST_EXPIRED_OR_UNKNOWN and every transfer action
requires the registered record, so reclaimed identifiers stay refused.

Every round is bounded by an item budget and a wall-clock budget, persists
a cursor after each considered entry, and holds the workspace maintenance
flock so two processes never reclaim the same workspace concurrently.
Query actions trigger a throttled lazy attempt (lazy_attempt) on top of the
hourly online maintenance driven by the local end. Each round persists its
counters (lastSummary, #19) so last_round_summary can feed the on-demand
storage report without re-walking anything.
Python 3.6 standard library only.
"""
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
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
HELPER_DIGEST = re.compile(r'[0-9a-f]{64}')
HELPER_DIGEST_BYTES = re.compile(rb'[0-9a-f]{64}')
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
        return _empty_maintenance_state()
    try:
        state = read_json(path)
    except (OSError, ValueError):
        # A corrupt bookkeeping file must never block reclamation.
        return _empty_maintenance_state()
    if not isinstance(state, dict):
        return _empty_maintenance_state()
    for key, default in _cursor_defaults().items():
        state.setdefault(key, default)
    return state


def _cursor_defaults():
    return {'schemaVersion': 1, 'lastRunAt': 0, 'lastCompletedAt': 0,
            'jobsCursor': None, 'transfersCursor': None, 'readsCursor': None,
            'helpersCursor': None, 'resourcesCursor': None, 'lastLazyAt': 0,
            'lastSummary': None}


def _empty_maintenance_state():
    return dict(_cursor_defaults())


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
            marker = read_json(path / 'unknown.json')
        except (OSError, ValueError):
            return
        if not isinstance(marker, dict) or not _numeric(marker.get('firstObservedAt')):
            return
        first_observed = marker['firstObservedAt']
        if now - first_observed >= periods['unknownRecordMs'] and _record_deletion_allowed(root, path):
            # Legacy (v1) records wait for protocol activation like terminal
            # ones (issue #20): removing one earlier would let its replayed
            # request rerun through the still-open legacy creation window.
            _remove_tree(path)
            summary['removedJobs'].append(name)


def _numeric(value):
    """Timestamp guards: type-invalid means undecidable, and an undecidable
    entry must be skipped and kept -- corruption never triggers deletion."""
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _process_terminal_job(root, path, state, periods, now, summary):
    ack = path / 'ack.json'
    name = path.name
    if ack.is_file():
        try:
            record = read_json(ack)
        except (OSError, ValueError):
            return
        if not isinstance(record, dict):
            return
        acknowledged = record.get('acknowledgedAt', 0)
        if not _numeric(acknowledged):
            return
        if now - acknowledged >= periods['confirmedTaskLogMs'] and not (path / 'purged.json').exists():
            _purge_job_logs(path, now)
            summary['purgedLogs'].append(name)
        if now - acknowledged >= periods['confirmedResultMs'] and _record_deletion_allowed(root, path):
            _remove_tree(path)
            summary['removedJobs'].append(name)
        return
    completed = state.get('completedAt')
    if _numeric(completed):
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
    """Delete the stopped transfer's temp, then release its ledger entry.

    File first, ledger second (same order as transfer.py's _release_temp and
    the local end's resetLocalTemp): an unlink failure or a crash between the
    two steps keeps the registration alive, so the retry re-releases
    idempotently instead of leaving an ownerless temp the ledger-driven
    generic resource pass would never revisit. False-on-doubt is preserved:
    after a successful unlink with a failed release the caller keeps the
    record and the next round retries the idempotent release."""
    import ledger
    temp = record.get('tempPath')
    if temp:
        try:
            os.unlink(temp)
        except FileNotFoundError:
            pass
    resource_id = record.get('resourceId')
    if resource_id:
        try:
            ledger.release(root, resource_id)
        except AgentError:
            return False
    return True


def _sorted_names(directory):
    if not directory.is_dir():
        return []
    return sorted(candidate.name for candidate in directory.iterdir()
                  if not candidate.is_symlink())


def _process_read_entry(root, name, now, summary):
    """Reclaim one expired read credential or its dangling index (issue #17).

    The expiry verdict is the same expiresAt the read path itself enforces,
    so an accelerated test clock moves both in lockstep. Sorted order puts
    every token file (<32 hex>.json) before its index-... twin, so a token
    removed here leaves the index dangling for the same round to collect."""
    reads = Path(root) / 'reads'
    path = reads / name
    if name.startswith('index-'):
        try:
            index = read_json(path)
        except (OSError, ValueError):
            return
        if not isinstance(index, dict):
            # Valid JSON but not an object is corrupt (jobs/transfers rule):
            # skipped, never fatal for the round.
            return
        token_key = index.get('readToken')
        if not isinstance(token_key, str) or not re.fullmatch(r'[a-f0-9]{32}', token_key):
            # The key feeds a path join: only a real 32-hex token key ever
            # materializes into a path (same guard as transferId); anything
            # else -- including traversal attempts -- is corrupt and skipped.
            return
        token_path = reads / (token_key + '.json')
        if token_path.is_file():
            try:
                record = read_json(token_path)
            except (OSError, ValueError):
                return
            if not isinstance(record, dict):
                return
            expires = record.get('expiresAt')
            if _numeric(expires) and now <= expires:
                return  # live credential: its index stays
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        summary['removedReadIndexes'].append(name)
        return
    try:
        record = read_json(path)
    except (OSError, ValueError):
        return
    if not isinstance(record, dict):
        # Valid JSON but not an object is corrupt (jobs/transfers rule):
        # skipped, never fatal for the round.
        return
    expires = record.get('expiresAt')
    if _numeric(expires) and now > expires:
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        summary['removedReadTokens'].append(name[:-len('.json')])


def _current_helper_digest():
    """Digest of the helper image this maintenance process itself runs from.

    Images are deployed as <stateRoot>/helpers/<digest>/<module>.py, and this
    module lives inside the running image, so its own directory name is the
    current version. Returns None in development layouts (repo checkout)."""
    name = Path(os.path.abspath(__file__)).parent.name
    return name if HELPER_DIGEST.fullmatch(name) else None


def _referenced_helper_digests(root):
    """Digests that any live process still references through its command line.

    Running task workers are spawned as <image>/agent.py --root ... _worker,
    concurrent helper exchanges run <image>/agent.py <action>, and even the
    image installer passes the target path as an argument -- all of them show
    up in /proc/<pid>/cmdline. The helpers directory is mode 0o700 under a
    private state root, so another user's process cannot legally reference an
    image; a cmdline we cannot read therefore never hides a real dependency.
    """
    prefix = (str(Path(root) / 'helpers') + os.sep).encode('utf8')
    referenced = set()
    try:
        processes = os.listdir('/proc')
    except OSError:
        return referenced
    for entry in processes:
        if not entry.isdigit():
            continue
        try:
            raw = Path('/proc', entry, 'cmdline').read_bytes()
        except OSError:
            continue
        for argument in raw.split(b'\0'):
            if not argument.startswith(prefix):
                continue
            digest = argument[len(prefix):].split(b'/')[0]
            if HELPER_DIGEST_BYTES.fullmatch(digest):
                referenced.add(digest.decode('ascii'))
    return referenced


def _reclaim_stale_helper(root, digest, summary):
    """Remove one unreferenced helper image directory (issue #17)."""
    keep = _referenced_helper_digests(root)
    current = _current_helper_digest()
    if current:
        keep.add(current)
    if digest in keep:
        return
    shutil.rmtree(str(Path(root) / 'helpers' / digest), ignore_errors=False)
    summary['removedHelpers'].append(digest)


def _transfer_managed_resource_ids(root):
    """Resource ids whose reclamation belongs to their transfer records.

    A transfer's temp and its ledger entry live across many short helper
    processes, so the recorded holder is always a dead process while the
    transfer itself is perfectly alive. Living transfer records manage their
    resources with transfer-specific evidence (the slot lock plus their own
    TTL in _process_transfer); the generic resource pass must never race
    them. A record already gone leaves its entry to the generic pass, which
    is exactly the crash-leftover case."""
    transfers = Path(root) / 'transfers'
    managed = set()
    if not transfers.is_dir():
        return managed
    for directory in transfers.iterdir():
        if directory.is_symlink() or not directory.is_dir():
            continue
        try:
            resource_id = read_json(directory / 'record.json').get('resourceId')
        except (OSError, ValueError):
            continue
        if isinstance(resource_id, str) and resource_id:
            managed.add(resource_id)
    return managed


def _process_resource(root, resource_id, summary, managed):
    """Verify and reclaim one crash-leftover ledger registration (issue #17).

    Evidence model (spec 7.2): ownership is the ledger registration itself,
    occupancy is the holder PID plus its boot-anchored start identity (a
    reused PID or a missing process never passes as the holder, and age never
    enters the verdict), and the object at the registered path must match the
    recorded dev:ino identity before the file is deleted. Anything that
    cannot be verified -- a holder that was never anchored, or a file whose
    identity was never attached -- stays behind as management fields only;
    files without any registration are never this function's business.
    """
    if resource_id in managed:
        return  # a living transfer record owns this entry and its evidence
    import ledger
    with ledger.ledger_lock(root):
        data = ledger.load(root)
        entry = data['resources'].get(resource_id)
        if not isinstance(entry, dict):
            return
        holder_identity = entry.get('holderIdentity')
        if not holder_identity:
            summary['unknownResources'].append(resource_id)
            return
        observed = ledger.process_identity(entry.get('holderPid'))
        if observed is not None and observed == holder_identity:
            summary['activeResources'] += 1
            return
        path = entry.get('path')
        if isinstance(path, str) and os.path.exists(path):
            registered_identity = entry.get('identity')
            if not registered_identity:
                # The object was never identity-anchored: unverifiable.
                summary['unknownResources'].append(resource_id)
                return
            try:
                info = os.stat(path)
            except OSError:
                summary['unknownResources'].append(resource_id)
                return
            if '{}:{}'.format(info.st_dev, info.st_ino) == registered_identity:
                try:
                    os.unlink(path)
                except FileNotFoundError:
                    pass
            # A mismatching identity means the name no longer denotes our
            # object: release the registration but never delete the file.
        del data['resources'][resource_id]
        ledger.save(root, data)
        summary['reclaimedResources'].append(resource_id)


def _ledger_resource_ids(root):
    import ledger
    try:
        data = ledger.load(root)
    except AgentError:
        return []
    resources = data.get('resources')
    if not isinstance(resources, dict):
        return []
    # Real registrations are always 32-hex ids; anything else is not ours.
    return sorted(name for name in resources if ledger.ID_PATTERN.fullmatch(name))


def _run_cursor_section(root, state, cursor_key, names, process,
                        items, options, deadline):
    """One budgeted, cursor-persisted pass; returns (items, exhausted)."""
    cursor = state.get(cursor_key)
    for name in names:
        if cursor is not None and name <= cursor:
            continue
        if items >= options['maxItemsPerRun'] or time.monotonic() >= deadline:
            return items, True
        try:
            process(name)
        except (OSError, AgentError):
            # One unreadable or refused entry (e.g. LOCK_SWITCH_BLOCKED from
            # ensure_slot_protocol, INVALID_REQUEST/STORAGE_FULL from the
            # ledger) never aborts the round: the cursor advances past it so
            # a permanently broken entry is skipped instead of stalling the
            # remaining entries and every later section, round after round.
            pass
        items += 1
        state[cursor_key] = name
        _save_maintenance_state(root, state)
    state[cursor_key] = None
    _save_maintenance_state(root, state)
    return items, False


def _run_round(root, request):
    """One bounded round; the caller already holds the maintenance lock."""
    periods = _resolve_periods(root, request)
    options = _resolve_options(root, request)
    now = _now()
    deadline = time.monotonic() + options['timeBudgetMs'] / 1000.0
    state = _load_maintenance_state(root)
    summary = {'removedJobs': [], 'purgedLogs': [], 'markedUnknown': [],
               'removedTransfers': [], 'removedReadTokens': [],
               'removedReadIndexes': [], 'removedHelpers': [],
               'reclaimedResources': [], 'unknownResources': [],
               'activeResources': 0, 'itemsConsidered': 0}
    items = 0

    items, exhausted = _run_cursor_section(
        root, state, 'jobsCursor', _sorted_names(Path(root) / 'jobs'),
        lambda name: _process_job(root, name, periods, now, summary),
        items, options, deadline)
    if not exhausted:
        items, exhausted = _run_cursor_section(
            root, state, 'transfersCursor', _sorted_names(Path(root) / 'transfers'),
            lambda name: _process_transfer(root, name, periods, now, summary),
            items, options, deadline)
    if not exhausted:
        items, exhausted = _run_cursor_section(
            root, state, 'readsCursor',
            [name for name in _sorted_names(Path(root) / 'reads') if name.endswith('.json')],
            lambda name: _process_read_entry(root, name, now, summary),
            items, options, deadline)
    if not exhausted:
        items, exhausted = _run_cursor_section(
            root, state, 'helpersCursor',
            [name for name in _sorted_names(Path(root) / 'helpers')
             if HELPER_DIGEST.fullmatch(name)],
            lambda name: _reclaim_stale_helper(root, name, summary),
            items, options, deadline)
    if not exhausted:
        managed = _transfer_managed_resource_ids(root)
        items, exhausted = _run_cursor_section(
            root, state, 'resourcesCursor', _ledger_resource_ids(root),
            lambda name: _process_resource(root, name, summary, managed),
            items, options, deadline)

    summary['itemsConsidered'] = items
    summary['completed'] = not exhausted
    summary['jobsCursor'] = state.get('jobsCursor')
    summary['transfersCursor'] = state.get('transfersCursor')
    state['lastRunAt'] = now
    if not exhausted:
        state['lastCompletedAt'] = now
    # The persisted round summary keeps counters only (#19): the in-memory
    # summary's per-item name lists must never grow the state file. All five
    # sections feed it -- the storage report must see credential, helper and
    # resource reclamation alongside the job/transfer counters (#17).
    state['lastSummary'] = {'removedJobs': len(summary['removedJobs']),
                            'purgedLogs': len(summary['purgedLogs']),
                            'markedUnknown': len(summary['markedUnknown']),
                            'removedTransfers': len(summary['removedTransfers']),
                            'removedReadTokens': len(summary['removedReadTokens']),
                            'removedReadIndexes': len(summary['removedReadIndexes']),
                            'removedHelpers': len(summary['removedHelpers']),
                            'reclaimedResources': len(summary['reclaimedResources']),
                            'unknownResources': len(summary['unknownResources']),
                            'itemsConsidered': items}
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


def last_round_summary(root):
    """Bounded view of the last reclamation round for the space report (#19).

    Times and counters come straight from the persisted maintenance state;
    a workspace that never ran a round reports zeros, never a guess. The
    counters describe the LAST round only -- a round stopped by a budget
    resumes in the next one, so totals across rounds are not implied.
    """
    state = _load_maintenance_state(root)
    summary = state.get('lastSummary')
    if not isinstance(summary, dict):
        summary = {}
    view = {'lastCompletedAt': state.get('lastCompletedAt', 0),
            'lastRunAt': state.get('lastRunAt', 0)}
    for key in ('removedJobs', 'purgedLogs', 'markedUnknown', 'removedTransfers',
                'removedReadTokens', 'removedReadIndexes', 'removedHelpers',
                'reclaimedResources', 'unknownResources', 'itemsConsidered'):
        value = summary.get(key, 0)
        view[key] = value if isinstance(value, int) and not isinstance(value, bool) else 0
    return view


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
