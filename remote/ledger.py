"""Workspace resource ledger and cross-process space accounting (issue #8).

Each end of a workspace keeps one ledger under <stateRoot>/ledger/:
ledger.json (resources + reservations, atomic writes) and ledger.lock (flock
mutual exclusion for every mutation). A temporary file must be registered here
before it can exist on disk, so a crash never leaves an untracked temp behind.

Space accounting (per workspace, default 10 GiB, configurable through
<stateRoot>/ledger/policy.json until #18 lands the unified policy structure):
usedBytes = stateBytes + tempBytes + reservedBytes, where stateBytes is the
recursive size of the state root excluding the ledger directory itself (the
measuring instrument is not re-measured), tempBytes the sum of registered
resources and reservedBytes the sum of unconsumed reservations. Registering a
resource consumes bytes from the reservation it cites, so a reservation and
the usage it materialized into are never counted twice. Committed targets are
never counted: releasing the resource on commit removes it from measurement.

Occupancy evidence combines the holder PID, its boot-anchored start identity
(same model as agent.py's task workers) and the recorded object identity
(dev:ino). Age alone never flips an occupancy verdict and a reused PID never
passes as the original holder; deciding what to reclaim from that evidence is
#17's job, not this module's.

Lock ordering: slot locks (locks.py) may be acquired before the ledger lock;
the ledger lock is never held while acquiring slot locks, so the two lock
families cannot deadlock against each other.
Python 3.6 standard library only.
"""
from contextlib import contextmanager
import errno
import fcntl
import os
from pathlib import Path
import re
import stat as stat_module
import time
import uuid

from common import AgentError, atomic_json, read_json


DEFAULT_SPACE_LIMIT_BYTES = 10 * 1024 * 1024 * 1024
ID_PATTERN = re.compile(r'[a-f0-9]{32}')
SAFE_INTEGER_MAX = 9007199254740991


def process_identity(pid):
    """Boot-anchored start identity of a PID; None when it cannot be observed.

    Same evidence model as agent.py's worker identity: /proc stat starttime
    plus the kernel boot id, so a recycled PID never impersonates a holder.
    """
    try:
        fields = Path('/proc/{}/stat'.format(pid)).read_text().rsplit(')', 1)[1].split()
        if fields[0] in ('Z', 'X'):
            return None
        return Path('/proc/sys/kernel/random/boot_id').read_text().strip() + ':' + fields[19]
    except (OSError, ValueError, IndexError):
        return None


def ledger_directory(root):
    directory = Path(root) / 'ledger'
    directory.mkdir(mode=0o700, exist_ok=True)
    return directory


@contextmanager
def ledger_lock(root):
    """Serialize every ledger mutation across processes."""
    directory = ledger_directory(root)
    with (directory / 'ledger.lock').open('a') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        yield


def space_limit(root):
    """Current workspace space limit. Reloaded on every operation so policy
    changes apply to the next operation; #18 will feed this file from profiles."""
    policy_path = ledger_directory(root) / 'policy.json'
    if not policy_path.is_file():
        return DEFAULT_SPACE_LIMIT_BYTES
    try:
        policy = read_json(policy_path)
    except (OSError, ValueError):
        raise AgentError('INVALID_POLICY', 'Workspace policy is not valid JSON')
    if not isinstance(policy, dict):
        raise AgentError('INVALID_POLICY', 'Workspace policy must be an object')
    if 'spaceLimitBytes' not in policy:
        return DEFAULT_SPACE_LIMIT_BYTES
    limit = policy['spaceLimitBytes']
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= SAFE_INTEGER_MAX:
        raise AgentError('INVALID_POLICY', 'spaceLimitBytes must be a positive safe integer')
    return limit


def measure_state_bytes(root):
    """Recursive size of the state root, excluding the ledger directory.

    The ledger's own files are the accounting instrument; counting them would
    make every reservation change the measurement itself (self-referential
    churn) and their size is a bounded, negligible constant.
    """
    total = 0
    root_path = Path(root)
    for base, directories, files in os.walk(str(root_path)):
        if Path(base) == root_path:
            directories[:] = sorted(name for name in directories if name != 'ledger')
        else:
            directories.sort()
        for name in sorted(files):
            try:
                info = (Path(base) / name).lstat()
            except OSError:
                continue
            if stat_module.S_ISREG(info.st_mode):
                total += info.st_size
    return total


def empty_ledger():
    return {'schemaVersion': 1, 'resources': {}, 'reservations': {}}


def load(root):
    path = ledger_directory(root) / 'ledger.json'
    if not path.is_file():
        return empty_ledger()
    try:
        ledger = read_json(path)
    except (OSError, ValueError):
        raise AgentError('LEDGER_UNAVAILABLE', 'Workspace ledger could not be read')
    if (not isinstance(ledger, dict) or not isinstance(ledger.get('resources'), dict)
            or not isinstance(ledger.get('reservations'), dict)):
        raise AgentError('LEDGER_UNAVAILABLE', 'Workspace ledger has an unexpected shape')
    return ledger


def save(root, ledger):
    try:
        atomic_json(ledger_directory(root) / 'ledger.json', ledger)
    except OSError as error:
        if error.errno == errno.ENOSPC:
            raise AgentError('STORAGE_FULL', 'Workspace ledger could not be persisted: the filesystem is full')
        raise


def _sums(root, ledger):
    state_bytes = measure_state_bytes(root)
    temp_bytes = sum(entry.get('bytes', 0) for entry in ledger['resources'].values())
    reserved_bytes = sum(entry.get('bytes', 0) for entry in ledger['reservations'].values())
    return {'stateBytes': state_bytes, 'tempBytes': temp_bytes, 'reservedBytes': reserved_bytes,
            'usedBytes': state_bytes + temp_bytes + reserved_bytes}


def _usage_snapshot(root, ledger):
    limit = space_limit(root)
    summary = _sums(root, ledger)
    summary.update(limitBytes=limit, resourceCount=len(ledger['resources']),
                   reservationCount=len(ledger['reservations']))
    return summary


def _require_quota(summary, limit, requested):
    if summary['usedBytes'] + requested > limit:
        raise AgentError('WORKSPACE_QUOTA_EXCEEDED',
                         'Workspace space limit is {} bytes (used {}, requesting {}); '
                         'rejecting the new usage'.format(limit, summary['usedBytes'], requested))


def _holder():
    return os.getpid(), process_identity(os.getpid())


def _byte_count(request, field, minimum):
    value = request.get(field)
    if not isinstance(value, int) or isinstance(value, bool) or not minimum <= value <= SAFE_INTEGER_MAX:
        raise AgentError('INVALID_REQUEST', '{} must be an integer between {} and {}'.format(field, minimum, SAFE_INTEGER_MAX))
    return value


def _require_id(value, label):
    if not isinstance(value, str) or not ID_PATTERN.fullmatch(value):
        raise AgentError('INVALID_REQUEST', '{} must be a 32-hex identifier'.format(label))


def reserve(root, request):
    """Reserve space for a known-size operation before it starts (spec 7.2).

    The check-and-add runs under the ledger lock, so concurrent reservations
    across processes cannot each pass the limit and overshoot combined.
    """
    requested = _byte_count(request, 'bytes', 1)
    note = request.get('note', '')
    if not isinstance(note, str) or len(note) > 200:
        raise AgentError('INVALID_REQUEST', 'note must be text of at most 200 characters')
    reservation_id = uuid.uuid4().hex
    with ledger_lock(root):
        ledger = load(root)
        limit = space_limit(root)
        summary = _sums(root, ledger)
        _require_quota(summary, limit, requested)
        pid, identity = _holder()
        ledger['reservations'][reservation_id] = {'bytes': requested, 'holderPid': pid,
                                                  'holderIdentity': identity, 'note': note,
                                                  'createdAt': time.time()}
        save(root, ledger)
    return {'reservationId': reservation_id, 'usedBytes': summary['usedBytes'] + requested,
            'limitBytes': limit}


def release_reservation(root, request):
    reservation_id = request.get('reservationId')
    _require_id(reservation_id, 'reservationId')
    with ledger_lock(root):
        ledger = load(root)
        if reservation_id not in ledger['reservations']:
            raise AgentError('RESOURCE_NOT_FOUND', 'Reservation is not registered')
        del ledger['reservations'][reservation_id]
        save(root, ledger)
    return {'released': True, 'reservationId': reservation_id}


def register(root, request):
    """Register a temp resource before the file can exist on disk.

    Registration is the quota gate for materialization: known-size writes go
    straight through here, and a cited reservation is consumed by the same
    amount so reservation and usage are never double counted.
    """
    path = request.get('path')
    if not isinstance(path, str) or not path.startswith('/') or '\0' in path:
        raise AgentError('INVALID_REQUEST', 'path must be an absolute path')
    requested = _byte_count(request, 'bytes', 0)
    origin = request.get('origin', 'unspecified')
    if not isinstance(origin, str) or len(origin) > 64:
        raise AgentError('INVALID_REQUEST', 'origin must be text of at most 64 characters')
    reservation_id = request.get('reservationId')
    if reservation_id is not None:
        _require_id(reservation_id, 'reservationId')
    session = request.get('session')
    if session is not None and (not isinstance(session, str) or len(session) > 256):
        raise AgentError('INVALID_REQUEST', 'session must be text of at most 256 characters')
    resource_id = uuid.uuid4().hex
    with ledger_lock(root):
        ledger = load(root)
        reservation = None
        if reservation_id is not None:
            # Existence first: a dangling reservation id must surface as
            # RESOURCE_NOT_FOUND, never leak into a quota verdict.
            reservation = ledger['reservations'].get(reservation_id)
            if reservation is None:
                raise AgentError('RESOURCE_NOT_FOUND', 'Reservation is not registered or was fully consumed')
        # The summary already counts the cited reservation inside reservedBytes,
        # so both the quota gate and the reported usage move by the net increase
        # only -- the full amount on top of the reservation would double count.
        net = requested if reservation is None else max(0, requested - reservation['bytes'])
        limit = space_limit(root)
        summary = _sums(root, ledger)
        _require_quota(summary, limit, net)
        if reservation is not None:
            reservation['bytes'] -= requested
            if reservation['bytes'] <= 0:
                del ledger['reservations'][reservation_id]
        pid, identity = _holder()
        ledger['resources'][resource_id] = {'kind': 'temp-file', 'path': path, 'bytes': requested,
                                            'identity': None, 'holderPid': pid, 'holderIdentity': identity,
                                            'session': session, 'origin': origin,
                                            'reservationId': reservation_id, 'createdAt': time.time()}
        save(root, ledger)
    return {'resourceId': resource_id, 'usedBytes': summary['usedBytes'] + net, 'limitBytes': limit}


def register_temp(root, path, byte_count, session, origin):
    """Convenience entry for the real write paths (files.py commit)."""
    return register(root, {'path': path, 'bytes': byte_count, 'origin': origin,
                           'session': session})['resourceId']


def attach_identity(root, resource_id, identity):
    """Record the observed object identity (dev:ino) of a materialized temp."""
    _require_id(resource_id, 'resourceId')
    with ledger_lock(root):
        ledger = load(root)
        resource = ledger['resources'].get(resource_id)
        if resource is None:
            raise AgentError('RESOURCE_NOT_FOUND', 'Resource is not registered')
        resource['identity'] = identity
        save(root, ledger)
    return {'resourceId': resource_id, 'identity': identity}


def find_by_path(root, path):
    """Read-only lookup: ids of resources registered for exactly this path.

    Callers use it to find their own crash leftovers before re-registering a
    temp; it never mutates and holds no lock while iterating.
    """
    ledger = load(root)
    return [resource_id for resource_id, entry in sorted(ledger['resources'].items())
            if entry.get('path') == path]


def release(root, resource_id):
    """Remove a resource from the ledger; idempotent.

    Called on commit (the formal target leaves measurement with the entry) and
    on failure cleanup. A crash before the call leaves the entry behind as the
    recovery record for #17.
    """
    _require_id(resource_id, 'resourceId')
    with ledger_lock(root):
        ledger = load(root)
        if ledger['resources'].pop(resource_id, None) is None:
            return {'released': False, 'resourceId': resource_id}
        save(root, ledger)
    return {'released': True, 'resourceId': resource_id}


def inspect(root, request):
    """Gather occupancy evidence for one resource. No age-based verdicts."""
    resource_id = request.get('resourceId')
    _require_id(resource_id, 'resourceId')
    ledger = load(root)
    resource = ledger['resources'].get(resource_id)
    if resource is None:
        raise AgentError('RESOURCE_NOT_FOUND', 'Resource is not registered')
    exists = os.path.exists(resource['path'])
    identity_matches = None
    if exists and resource.get('identity'):
        try:
            info = os.stat(resource['path'])
            identity_matches = resource['identity'] == '{}:{}'.format(info.st_dev, info.st_ino)
        except OSError:
            identity_matches = None
    observed = process_identity(resource.get('holderPid'))
    holder_alive = observed is not None and observed == resource.get('holderIdentity')
    return {'resourceId': resource_id, 'kind': resource.get('kind'), 'path': resource['path'],
            'bytes': resource.get('bytes', 0), 'exists': exists,
            'identity': resource.get('identity'), 'identityMatches': identity_matches,
            'holderPid': resource.get('holderPid'), 'holderIdentity': resource.get('holderIdentity'),
            'holderAlive': holder_alive, 'createdAt': resource.get('createdAt')}


def usage(root):
    with ledger_lock(root):
        return _usage_snapshot(root, load(root))


def resource_action(root, action, request):
    handlers = {'resource_reserve': reserve, 'resource_release': release_reservation,
                'resource_register': register, 'resource_forget': lambda inner, payload:
                    release(inner, payload.get('resourceId')),
                'resource_inspect': inspect, 'resource_usage': lambda inner, payload: usage(inner)}
    handler = handlers.get(action)
    if handler is None:
        raise AgentError('UNSUPPORTED_ACTION', 'Unknown resource operation')
    return handler(root, request)
