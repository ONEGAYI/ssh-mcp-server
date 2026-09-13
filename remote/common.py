"""Shared persistence and errors; compatible with Python 3.6."""
import json
import os
import tempfile


class AgentError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _sync_parent_directory(path):
    """Best-effort durability of the rename's directory entry.

    os.replace makes the new name visible, but after a power loss the entry
    itself needs a parent-directory fsync to be durable. Filesystems that
    cannot open or fsync a directory (special mounts) fail silently -- on a
    normal Linux filesystem the sync applies.
    """
    try:
        descriptor = os.open(str(path.parent), os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    except OSError:
        pass


def atomic_json(path, value):
    descriptor, temporary = tempfile.mkstemp(prefix='.pending-', dir=str(path.parent))
    try:
        with os.fdopen(descriptor, 'w') as stream:
            json.dump(value, stream, ensure_ascii=True, sort_keys=True)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, str(path))
        _sync_parent_directory(path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_json(path):
    with path.open('r') as stream:
        return json.load(stream)
