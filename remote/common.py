"""Shared persistence and errors; compatible with Python 3.6."""
import json
import os
import tempfile


class AgentError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def atomic_json(path, value):
    descriptor, temporary = tempfile.mkstemp(prefix='.pending-', dir=str(path.parent))
    try:
        with os.fdopen(descriptor, 'w') as stream:
            json.dump(value, stream, ensure_ascii=True, sort_keys=True)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, str(path))
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_json(path):
    with path.open('r') as stream:
        return json.load(stream)
