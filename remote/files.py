"""Workspace file operations with server-issued read records and version checks."""
from contextlib import contextmanager
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import uuid
from common import AgentError, atomic_json, read_json


MAX_FILE_BYTES = 16 * 1024 * 1024
BOM = b'\xef\xbb\xbf'


def metadata(info):
    return [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_mode, info.st_nlink]


def snapshot(path):
    before = path.stat()
    if not stat.S_ISREG(before.st_mode):
        raise AgentError('UNSUPPORTED_FILE', 'Only regular files are supported')
    if before.st_size > MAX_FILE_BYTES:
        raise AgentError('FILE_TOO_LARGE', 'Guarded file operations currently support files up to 16 MiB')
    with path.open('rb') as stream:
        if metadata(os.fstat(stream.fileno())) != metadata(before):
            raise AgentError('FILE_CONFLICT', 'File identity changed while reading')
        data = stream.read(MAX_FILE_BYTES + 1)
        after = os.fstat(stream.fileno())
    if len(data) > MAX_FILE_BYTES or metadata(before) != metadata(after) or metadata(after) != metadata(path.stat()):
        raise AgentError('FILE_CONFLICT', 'File changed while reading')
    version = hashlib.sha256(json.dumps(metadata(after)).encode() + data).hexdigest()
    return data, after, version


def merge_ranges(ranges):
    merged = []
    for start, end in sorted(ranges):
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(end, merged[-1][1])
        else:
            merged.append([start, end])
    return merged


def covers(ranges, start, end):
    return any(left <= start and right >= end for left, right in ranges)


def remap_read_ranges(ranges, edits):
    """Shift known byte intervals across replacements fully contained in them.

    Each edit is (old_start, old_end, new_byte_count), in original coordinates.
    Replacement bytes are known because the caller supplied them. Unread gaps
    keep their byte lengths and never become authorized as a side effect.
    """
    def shifted(position):
        return position + sum(new_size - (end - start) for start, end, new_size in edits if end <= position)
    return merge_ranges([[shifted(start), shifted(end)] for start, end in ranges])


def newline_kind(data):
    crlf = data.count(b'\r\n')
    lf = data.count(b'\n') - crlf
    return 'mixed' if crlf and lf else 'CRLF' if crlf else 'LF'


def preserve_newlines(text, original):
    return text.replace('\r\n', '\n').replace('\n', '\r\n') if newline_kind(original) == 'CRLF' else text


def replaceable(info):
    if info.st_nlink != 1 or info.st_uid != os.getuid():
        raise AgentError('UNSUPPORTED_METADATA', 'Mutation requires an owned file with a single link')


class FileService:
    def __init__(self, state_root, workspace_root, session_id, allowed_roots=None, directory_scope='restricted'):
        if not isinstance(workspace_root, str) or not os.path.isabs(workspace_root):
            raise AgentError('INVALID_WORKSPACE', 'Workspace must have an absolute remote root')
        if directory_scope not in ('restricted', 'unrestricted'):
            raise AgentError('INVALID_REQUEST', "directoryScope must be 'restricted' or 'unrestricted'")
        if not isinstance(session_id, str) or not session_id or len(session_id) > 256 or '\0' in session_id:
            raise AgentError('INVALID_SESSION', 'A session identifier is required')
        self.workspace = Path(workspace_root).resolve(strict=True)
        self.root = state_root
        self.session = session_id
        # An explicit unrestricted choice only drops the workspace boundary;
        # every other guard (tokens, ranges, change checks) and any explicit
        # allowedRemotePaths restriction stay in force.
        self.unrestricted = directory_scope == 'unrestricted'
        self.allowed_roots = [Path(value).resolve(strict=False) for value in (allowed_roots or [])]
        self.reads = state_root / 'reads'
        self.reads.mkdir(mode=0o700, exist_ok=True)

    def path(self, value, writing=False):
        if not isinstance(value, str) or not value or '\0' in value:
            raise AgentError('INVALID_PATH', 'Path must be nonempty text without NUL')
        original = Path(os.path.abspath(str(self.workspace / value)))
        resolved = original.resolve(strict=False)
        if not self.unrestricted and os.path.commonpath([str(self.workspace), str(resolved)]) != str(self.workspace):
            raise AgentError('PATH_NOT_ALLOWED', 'Path is outside the remote workspace')
        if self.allowed_roots and not any(os.path.commonpath([str(root), str(resolved)]) == str(root) for root in self.allowed_roots):
            raise AgentError('PATH_NOT_ALLOWED', 'Path is outside configured allowedRemotePaths')
        if writing:
            for candidate in [original] + list(original.parents):
                if candidate.is_symlink():
                    raise AgentError('UNSUPPORTED_LINK', 'Mutations through symlinks are not supported')
        return resolved

    @contextmanager
    def lock(self, path):
        locks = self.root / 'file-locks'
        locks.mkdir(mode=0o700, exist_ok=True)
        key = hashlib.sha256(str(path).encode('utf8')).hexdigest()
        with (locks / key).open('a') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX)
            yield

    def token(self, value, path, version):
        if not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{32}', value):
            raise AgentError('READ_REQUIRED', 'Read the file with this tool before modifying it')
        try:
            token = read_json(self.reads / (value + '.json'))
        except OSError:
            raise AgentError('READ_REQUIRED', 'Read record is unavailable')
        if token['session'] != self.session or token['path'] != str(path):
            raise AgentError('READ_SCOPE_MISMATCH', 'Read record belongs to a different file or session')
        if token['version'] != version:
            raise AgentError('FILE_CONFLICT', 'File changed since it was read; read it again')
        return token

    def read_index(self, path):
        key = hashlib.sha256((self.session + '\0' + str(path)).encode('utf8')).hexdigest()
        return self.reads / ('index-' + key + '.json')

    def save_read(self, path, version, size, ranges, key=None):
        key = key or uuid.uuid4().hex
        record = {'session': self.session, 'path': str(path), 'version': version, 'ranges': ranges, 'size': size}
        atomic_json(self.reads / (key + '.json'), record)
        atomic_json(self.read_index(path), {'readToken': key})
        return {'readToken': key, 'version': version, 'size': size, 'complete': covers(ranges, 0, size)}

    def read(self, request):
        path = self.path(request.get('path'))
        with self.lock(path):
            data, info, version = snapshot(path)
            binary = request.get('encoding', 'utf8') == 'base64'
            if request.get('encoding', 'utf8') not in ('base64', 'utf8'):
                raise AgentError('UNSUPPORTED_ENCODING', 'Choose utf8 or base64')
            if not binary:
                try:
                    data.decode('utf-8-sig')
                except UnicodeDecodeError:
                    raise AgentError('UNSUPPORTED_ENCODING', 'Text reads require UTF-8; use base64 for binary')
            limit = request.get('maxBytes', 65536)
            if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 1048576:
                raise AgentError('INVALID_LIMIT', 'maxBytes must be between 1 and 1048576')
            bom_size = len(BOM) if not binary and data.startswith(BOM) else 0
            if 'offset' in request or binary:
                offset = request.get('offset', 0)
                if not isinstance(offset, int) or isinstance(offset, bool) or not 0 <= offset <= len(data):
                    raise AgentError('INVALID_OFFSET', 'Byte offset is outside the file')
                start, end = max(bom_size, offset), len(data)
                if not binary and start < len(data) and data[start] & 0xc0 == 0x80:
                    raise AgentError('INVALID_OFFSET', 'Offset must be at a UTF-8 character boundary')
            else:
                lines = data[bom_size:].splitlines(keepends=True)
                first, last = request.get('fromLine', 1), request.get('toLine', max(1, len(lines)))
                if any(not isinstance(value, int) or isinstance(value, bool) or value < 1 for value in (first, last)) or last < first:
                    raise AgentError('INVALID_LINE_RANGE', 'Line ranges are one-based and inclusive')
                start = bom_size + sum(len(line) for line in lines[:first - 1])
                end = bom_size + sum(len(line) for line in lines[:last])
            chunk = data[start:min(end, start + limit)]
            shown = base64.b64encode(chunk).decode('ascii') if binary else chunk.decode('utf8', errors='ignore')
            if request.get('grantRead', True) is not False:
                # Budget serialized tool content, not just source bytes. Reserve
                # room for paths, version and cursor metadata before granting reads.
                budget = 65536 - 8192
                if len(json.dumps(shown, ensure_ascii=False).encode('utf8')) > budget:
                    low, high = 0, len(shown)
                    while low < high:
                        middle = (low + high + 1) // 2
                        if len(json.dumps(shown[:middle], ensure_ascii=False).encode('utf8')) <= budget:
                            low = middle
                        else:
                            high = middle - 1
                    if binary:
                        chunk = chunk[:(low // 4) * 3]
                        shown = base64.b64encode(chunk).decode('ascii')
                    else:
                        shown = shown[:low]
            delivered_end = start + (len(chunk) if binary else len(shown.encode('utf8')))
            if delivered_end == start and start < end:
                raise AgentError('INVALID_LIMIT', 'maxBytes is too small for the next UTF-8 character')
            result = {'path': str(path), 'data' if binary else 'text': shown, 'encoding': 'base64' if binary else 'utf8',
                      'newline': None if binary else newline_kind(data), 'version': version,
                      'size': len(data), 'bom': data.startswith(BOM), 'startOffset': start, 'endOffset': delivered_end,
                      'nextOffset': delivered_end if delivered_end < end else None, 'truncated': delivered_end < end}
            if request.get('grantRead', True) is False:
                return result
            index_path = self.read_index(path)
            key, previous = None, []
            if index_path.exists():
                candidate = read_json(index_path)['readToken']
                old = read_json(self.reads / (candidate + '.json'))
                if old['session'] == self.session and old['path'] == str(path) and old['version'] == version:
                    key, previous = candidate, old['ranges']
            ranges = merge_ranges(previous + [[0, bom_size], [start, delivered_end]])
            return dict(result, **self.save_read(path, version, len(data), ranges, key))

    def edit(self, request):
        path = self.path(request.get('path'), writing=True)
        with self.lock(path):
            data, info, version = snapshot(path)
            token = self.token(request.get('readToken'), path, version)
            replaceable(info)
            try:
                text = data.decode('utf-8-sig')
            except UnicodeDecodeError:
                raise AgentError('UNSUPPORTED_ENCODING', 'Text edits require UTF-8')
            edits = request.get('edits')
            if not isinstance(edits, list) or not edits or len(edits) > 100:
                raise AgentError('INVALID_EDIT', 'Provide between 1 and 100 exact replacements')
            replacements = []
            byte_edits = []
            for edit in edits:
                if not isinstance(edit, dict):
                    raise AgentError('INVALID_EDIT', 'Each edit must be an object')
                old, new = edit.get('oldText'), edit.get('newText')
                if not isinstance(old, str) or not old or not isinstance(new, str):
                    raise AgentError('INVALID_EDIT', 'Replacement text must be strings with a nonempty oldText')
                start = text.find(old)
                if start < 0 or text.find(old, start + 1) >= 0:
                    raise AgentError('EDIT_MATCH_ERROR', 'oldText must match exactly once')
                byte_start = (len(BOM) if data.startswith(BOM) else 0) + len(text[:start].encode('utf8'))
                if not covers(token['ranges'], byte_start, byte_start + len(old.encode('utf8'))):
                    raise AgentError('READ_REQUIRED', 'The edited range has not been delivered by a read')
                normalized_new = preserve_newlines(new, data)
                replacements.append((start, start + len(old), normalized_new))
                byte_edits.append((byte_start, byte_start + len(old.encode('utf8')), len(normalized_new.encode('utf8'))))
            replacements.sort()
            if any(left[1] > right[0] for left, right in zip(replacements, replacements[1:])):
                raise AgentError('INVALID_EDIT', 'Replacement ranges must not overlap')
            for start, end, new in reversed(replacements):
                text = text[:start] + new + text[end:]
            updated = (BOM if data.startswith(BOM) else b'') + text.encode('utf8')
            written_info = self.commit(path, updated, info, version)
            result = {'path': str(path), 'written': True, 'bytesWritten': len(updated), 'editsApplied': len(replacements)}
            try:
                observed, observed_info, new_version = snapshot(path)
                # Confirm our exact post-image, not arbitrary bytes seen after an
                # external replacement. ctime may legitimately change on rename.
                fields = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_mode', 'st_nlink', 'st_uid', 'st_gid')
                if observed != updated or any(getattr(observed_info, field) != getattr(written_info, field) for field in fields):
                    raise AgentError('FILE_CONFLICT', 'File changed after the edit was committed')
                ranges = remap_read_ranges(token['ranges'], byte_edits)
                result.update(self.save_read(path, new_version, len(updated), ranges))
                result['rereadRequired'] = False
            except (OSError, AgentError) as error:
                # The write already happened. Do not report it as a failed edit
                # or give a credential authorizing unverified external content.
                result.update(readToken=None, rereadRequired=True, readTokenError=getattr(error, 'code', 'READ_RECORD_UNAVAILABLE'),
                              message='Edit committed, but read-token renewal could not be confirmed. Read the current file before further editing.')
            return result

    def commit(self, path, data, info=None, version=None):
        if len(data) > MAX_FILE_BYTES:
            raise AgentError('FILE_TOO_LARGE', 'Content exceeds 16 MiB')
        fd, temporary = tempfile.mkstemp(prefix='.ssh-mcp-', dir=str(path.parent))
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(data)
                if info is not None:
                    os.fchown(stream.fileno(), -1, info.st_gid)
                    os.fchmod(stream.fileno(), stat.S_IMODE(info.st_mode))
                stream.flush()
                os.fsync(stream.fileno())
                written_info = os.fstat(stream.fileno())
            self.path(str(path), writing=True)
            if version is not None:
                if snapshot(path)[2] != version:
                    raise AgentError('FILE_CONFLICT', 'File changed before committing the write')
                os.replace(temporary, str(path))
            else:
                try:
                    os.link(temporary, str(path))
                except FileExistsError:
                    raise AgentError('FILE_CONFLICT', 'Creation target already exists')
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        return written_info

    def full_read(self, request, path, version, size, field='readToken'):
        token = self.token(request.get(field), path, version)
        if not covers(token['ranges'], 0, size):
            raise AgentError('READ_REQUIRED', 'This operation requires a complete read of the current file')

    def write(self, request):
        path = self.path(request.get('path'), writing=True)
        with self.lock(path):
            creating = request.get('create', False)
            if not isinstance(creating, bool):
                raise AgentError('INVALID_REQUEST', 'create must be boolean')
            info, version, old = None, None, b''
            if creating:
                if path.exists():
                    raise AgentError('FILE_CONFLICT', 'Creation target already exists')
            else:
                old, info, version = snapshot(path)
                self.full_read(request, path, version, len(old))
                replaceable(info)
            if ('text' in request) == ('data' in request):
                raise AgentError('INVALID_CONTENT', 'Provide exactly one of UTF-8 text or base64 data')
            if 'text' in request:
                if not isinstance(request['text'], str):
                    raise AgentError('INVALID_CONTENT', 'text must be a string')
                try:
                    old.decode('utf-8-sig')
                except UnicodeDecodeError:
                    raise AgentError('UNSUPPORTED_ENCODING', 'Use base64 to replace a binary file')
                text = preserve_newlines(request['text'], old)
                data = (BOM if old.startswith(BOM) and not text.startswith('\ufeff') else b'') + text.encode('utf8')
            else:
                try:
                    data = base64.b64decode(request['data'], validate=True)
                except (ValueError, TypeError):
                    raise AgentError('INVALID_CONTENT', 'data must be valid base64')
            self.commit(path, data, info, version)
            return {'path': str(path), 'written': True, 'created': creating, 'bytesWritten': len(data)}

    def delete(self, request):
        path = self.path(request.get('path'), writing=True)
        with self.lock(path):
            data, info, version = snapshot(path)
            self.full_read(request, path, version, len(data))
            replaceable(info)
            if snapshot(path)[2] != version:
                raise AgentError('FILE_CONFLICT', 'File changed before deletion')
            path.unlink()
            return {'path': str(path), 'deleted': True}

    def move(self, request):
        source = self.path(request.get('path'), writing=True)
        target = self.path(request.get('target'), writing=True)
        if source == target:
            raise AgentError('INVALID_PATH', 'Source and destination must differ')
        left, right = sorted((source, target), key=str)
        with self.lock(left), self.lock(right):
            data, info, version = snapshot(source)
            self.full_read(request, source, version, len(data))
            replaceable(info)
            if info.st_dev != target.parent.stat().st_dev:
                raise AgentError('CROSS_DEVICE_MOVE', 'Cross-filesystem moves are not supported')
            target_version = None
            if target.exists():
                if not request.get('targetReadToken'):
                    raise AgentError('FILE_CONFLICT', 'Destination exists; read it before requesting replacement')
                target_data, target_info, target_version = snapshot(target)
                self.full_read(request, target, target_version, len(target_data), 'targetReadToken')
                replaceable(target_info)
            if snapshot(source)[2] != version:
                raise AgentError('FILE_CONFLICT', 'Source changed before move')
            if target_version is not None:
                if snapshot(target)[2] != target_version:
                    raise AgentError('FILE_CONFLICT', 'Destination changed before move')
                os.replace(str(source), str(target))
            else:
                try:
                    os.link(str(source), str(target))
                except FileExistsError:
                    raise AgentError('FILE_CONFLICT', 'Destination appeared before move')
                # link+unlink never overwrites a destination. A crash between the two
                # leaves both names, explicitly detectable as a multi-link file.
                source.unlink()
            return {'path': str(source), 'target': str(target), 'moved': True}

    def call(self, action, request):
        if action == 'file_workspace':
            import platform
            import shutil
            return {'remoteRoot': str(self.workspace), 'directoryScope': 'unrestricted' if self.unrestricted else 'restricted',
                    'python': platform.python_version(),
                    'runtimeLibc': os.confstr('CS_GNU_LIBC_VERSION'),
                    'ruleFiles': [str(path.relative_to(self.workspace)) for path in
                                  [self.workspace / 'AGENTS.md', self.workspace / 'CLAUDE.md'] if path.is_file()],
                    'instructions': 'Read applicable root and nested AGENTS.md/CLAUDE.md with file_read before editing.',
                    'capabilities': {'interactiveInput': False, 'pty': False, 'reattachTerminal': False,
                                     'persistentTasks': True, 'maxGuardedFileBytes': MAX_FILE_BYTES,
                                     'searchEngine': 'python-literal', 'gitignoreSearch': False, 'rgPath': shutil.which('rg')}}
        if action in ('file_list', 'file_find', 'file_search'):
            from discovery import discover
            return discover(self, action, request)
        if action in ('file_mkdir', 'file_rmdir'):
            path = self.path(request.get('path'), writing=True)
            if path == self.workspace:
                raise AgentError('PATH_NOT_ALLOWED', 'Cannot create or remove the workspace root')
            with self.lock(path):
                if action == 'file_mkdir':
                    path.mkdir(mode=0o700)
                else:
                    path.rmdir()
            return {'path': str(path), 'changed': True}
        if action == 'file_read':
            return self.read(request)
        if action == 'file_edit':
            return self.edit(request)
        if action == 'file_write':
            return self.write(request)
        if action == 'file_delete':
            return self.delete(request)
        if action == 'file_move':
            return self.move(request)
        raise AgentError('UNSUPPORTED_ACTION', 'Unknown file operation')
