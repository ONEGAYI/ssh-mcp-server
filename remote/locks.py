"""Fixed reusable lock slots for workspace targets (issue #8).

Replaces per-path lock files with a fixed set of slot files addressed by a
stable hash of the target identity, so locks never accumulate per historical
path. Slot files are reused and never deleted or rebuilt while in use.

Migration from the legacy per-path locks is a one-time protocol switch guarded
by a persistent marker: the switch is refused while any legacy lock file is
still held by a live process, so the old and the new protocol never protect
the same target without mutual exclusion.

Lock ordering (see also ledger.py): slot locks are resource locks and may be
acquired before the workspace ledger lock; the reverse direction is forbidden.
The dedicated switch lock is only ever held while probing legacy locks
non-blocking and never together with slot or ledger locks.
Python 3.6 standard library only.
"""
from contextlib import contextmanager
import fcntl
import hashlib
import time

from common import AgentError, atomic_json


LOCK_SLOT_COUNT = 256
SWITCH_LOCK_NAME = '.switch.lock'
SLOTS_MARKER_NAME = 'slots.json'


def slot_index(target):
    """Map a stable target identity (the resolved path string) to a slot."""
    digest = hashlib.sha256(str(target).encode('utf8')).hexdigest()
    return int(digest, 16) % LOCK_SLOT_COUNT


def lock_directory(root):
    directory = root / 'file-locks'
    directory.mkdir(mode=0o700, exist_ok=True)
    return directory


def ensure_slot_protocol(root):
    """Switch the workspace to fixed lock slots exactly once.

    Refuses with LOCK_SWITCH_BLOCKED while another process still holds any
    legacy per-path lock: both protocols must never guard the same target at
    the same time. A legacy writer that starts after this probe cannot be
    detected without its cooperation; upgrades stop old clients first.
    """
    directory = lock_directory(root)
    marker = directory / SLOTS_MARKER_NAME
    if marker.is_file():
        return
    with (directory / SWITCH_LOCK_NAME).open('a') as guard:
        fcntl.flock(guard, fcntl.LOCK_EX)
        if marker.is_file():
            return
        for candidate in sorted(directory.iterdir()):
            name = candidate.name
            if name == SWITCH_LOCK_NAME or name == SLOTS_MARKER_NAME or name.startswith('slot-'):
                continue
            if candidate.is_symlink() or not candidate.is_file():
                continue
            with candidate.open('a') as probe:
                try:
                    fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    fcntl.flock(probe, fcntl.LOCK_UN)
                except OSError:
                    raise AgentError('LOCK_SWITCH_BLOCKED',
                                     'Refusing to switch to fixed lock slots while a legacy per-path lock is still held; drain old writers first')
        atomic_json(marker, {'schemaVersion': 1, 'protocol': 'fixed-slots',
                             'slots': LOCK_SLOT_COUNT, 'switchedAt': time.time()})


@contextmanager
def acquire_slots(root, targets):
    """Acquire the lock slots for every target, deduplicated and in a single
    global order (ascending slot index) so concurrent multi-target operations
    cannot deadlock. Slot files are created once and never removed."""
    ensure_slot_protocol(root)
    directory = lock_directory(root)
    indices = sorted({slot_index(target) for target in targets})
    handles = []
    try:
        for index in indices:
            stream = (directory / ('slot-{:03d}'.format(index))).open('a')
            fcntl.flock(stream, fcntl.LOCK_EX)
            handles.append(stream)
        yield
    finally:
        for stream in reversed(handles):
            stream.close()
