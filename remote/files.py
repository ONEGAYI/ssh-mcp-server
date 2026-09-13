"""Workspace file operations with server-issued read records and version checks.

Internal boundaries (issue #6), each replaceable without rewriting callers:
version observation (metadata-only since issue #9, spec 4.1), content reading
(bounded streaming windows since issue #9, spec 4.2), replacement planning
(chunked whole-file matching since issue #10, spec 4.3), and commit (streamed
same-directory splicing with directory fsync since issue #10).
"""
from contextlib import contextmanager
import base64
import codecs
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import time
import uuid
from common import AgentError, atomic_json, read_json
import ledger
from locks import acquire_slots


MAX_FILE_BYTES = 16 * 1024 * 1024
MAX_STREAM_CHUNK = 256 * 1024
READ_BUDGET = 65536 - 8192
READ_TOKEN_TTL_SECONDS = 3 * 24 * 3600
BOM = b'\xef\xbb\xbf'


def _now():
    """Clock for credential lifetimes. SSH_MCP_TEST_CLOCK is the narrow
    test-only injection point for expiry behaviour (spec 10)."""
    clock = os.environ.get('SSH_MCP_TEST_CLOCK')
    return float(clock) if clock is not None else time.time()


# --- Version observation ------------------------------------------------------
# Observes the file identity and derives the version string. Since issue #9
# the version binds Linux metadata only; the full-content hash is gone.

def metadata(info):
    return [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_mode, info.st_nlink]


def version_fields(info):
    """The spec 4.1 metadata set: device, inode, size, mtime_ns, ctime_ns."""
    return [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns]


def require_regular_file(info):
    """Snapshot gate: only regular files participate in file tools."""
    if not stat.S_ISREG(info.st_mode):
        raise AgentError('UNSUPPORTED_FILE', 'Only regular files are supported')


def require_snapshot_size(info):
    """Whole-file gate for the mutation paths that still buffer full content.

    Since issue #10 edit and whole-file write stream instead; the bound now
    only guards delete/move, which keep their first-version snapshot planning.
    """
    if info.st_size > MAX_FILE_BYTES:
        raise AgentError('FILE_TOO_LARGE', 'Guarded mutations currently support files up to 16 MiB')


def content_version(info):
    """Version string binding Linux metadata alone (spec 4.1).

    The m1- prefix separates this scheme from the pre-#9 content hashes, so
    credentials issued under the old scheme can never compare equal.
    """
    return 'm1-' + hashlib.sha256(json.dumps(version_fields(info)).encode('utf8')).hexdigest()


def same_object(info, path):
    """Confirm the resolved path still names the observed object."""
    return metadata(info) == metadata(path.stat())


def current_version(path):
    """Version observed right now, from descriptor metadata alone."""
    with path.open('rb') as stream:
        info = os.fstat(stream.fileno())
    if not same_object(info, path):
        raise AgentError('FILE_CONFLICT', 'File identity changed while observing')
    return content_version(info)


def verify_stable_read(before, after, data, path):
    """Post-read stability check across the three observed stats."""
    if len(data) > MAX_FILE_BYTES or metadata(before) != metadata(after) or metadata(after) != metadata(path.stat()):
        raise AgentError('FILE_CONFLICT', 'File changed while reading')


# --- Content reading ------------------------------------------------------------
# Turns the file into delivered windows through bounded streaming buffers
# (spec 4.2): line requests scan to their boundaries sequentially, byte
# cursors read directly, and nothing buffers or returns the whole file.

def read_whole_file(stream, expected):
    """Read the entire file between two descriptor identity checks.

    Snapshot-only helper for the mutation paths that still plan in memory.
    """
    if metadata(os.fstat(stream.fileno())) != metadata(expected):
        raise AgentError('FILE_CONFLICT', 'File identity changed while reading')
    data = stream.read(MAX_FILE_BYTES + 1)
    return data, os.fstat(stream.fileno())


def snapshot(path):
    """Observe the metadata version and read the whole current content.

    Couples version observation with a whole-file read under three-way stat
    identity checks. Edit and whole-file write moved to their streaming paths
    in issue #10; delete and move still plan through this boundary.
    """
    before = path.stat()
    require_regular_file(before)
    require_snapshot_size(before)
    with path.open('rb') as stream:
        data, after = read_whole_file(stream, before)
    verify_stable_read(before, after, data, path)
    return data, after, content_version(after)


def read_window(stream, start, length, chunk_size=MAX_STREAM_CHUNK):
    """Read up to `length` bytes at `start` through bounded chunks."""
    if length <= 0:
        return b''
    stream.seek(start)
    parts = []
    remaining = length
    while remaining > 0:
        block = stream.read(min(chunk_size, remaining))
        if not block:
            break
        parts.append(block)
        remaining -= len(block)
    return b''.join(parts)


def scan_to_line_start(stream, first, bom_size, chunk_size=MAX_STREAM_CHUNK):
    """Byte offset where 1-based line `first` starts, or None past the end.

    Line numbers are located by sequential newline scanning, never treated
    as byte offsets; nothing before the target line is returned or kept.
    """
    if first <= 1:
        return bom_size
    stream.seek(bom_size)
    consumed = bom_size
    seen = 0
    while True:
        block = stream.read(chunk_size)
        if not block:
            return None
        count = block.count(b'\n')
        if seen + count >= first - 1:
            index = -1
            for _ in range(first - 1 - seen):
                index = block.index(b'\n', index + 1)
            return consumed + index + 1
        seen += count
        consumed += len(block)


def scan_to_line_end(stream, last, bom_size, size, chunk_size=MAX_STREAM_CHUNK):
    """End byte after the newline of 1-based line `last`, or the file end
    when the file has fewer lines."""
    stream.seek(bom_size)
    consumed = bom_size
    seen = 0
    while True:
        block = stream.read(chunk_size)
        if not block:
            return size
        count = block.count(b'\n')
        if seen + count >= last:
            index = -1
            for _ in range(last - seen):
                index = block.index(b'\n', index + 1)
            return consumed + index + 1
        seen += count
        consumed += len(block)


def decode_utf8_prefix(chunk):
    """Decode the longest valid UTF-8 prefix so characters are never split.

    Returns (text, trimmed_bytes). Bytes are trimmed only when they form an
    incomplete multibyte sequence at the tail; genuinely invalid content in
    the window raises instead of being silently swallowed.
    """
    if not chunk:
        return '', 0
    for trim in (0, 1, 2, 3):
        try:
            text = chunk[:len(chunk) - trim].decode('utf8') if trim else chunk.decode('utf8')
        except UnicodeDecodeError:
            continue
        if trim == 0:
            return text, 0
        lead = chunk[len(chunk) - trim]
        expected = 2 if 0xc0 <= lead < 0xe0 else 3 if lead < 0xf0 else 4
        if 0xc0 <= lead < 0xf8 and trim < expected:
            return text, trim
    raise AgentError('UNSUPPORTED_ENCODING', 'Text reads require UTF-8; use base64 for binary')


def utf8_stream_validator():
    """Incremental strict UTF-8 decoder used as a streaming text gate.

    Feeding every chunk (then flush) proves the whole file decodes without
    ever holding the decoded text: text edits and text whole-file writes keep
    refusing binary targets, but no longer need the file in memory.
    """
    decoder = codecs.getincrementaldecoder('utf8')()

    def feed(chunk, final=False):
        try:
            decoder.decode(chunk, final)
        except UnicodeDecodeError:
            raise AgentError('UNSUPPORTED_ENCODING', 'Text edits require UTF-8; use base64 for binary')
        return chunk
    return feed


class NewlineCensus(object):
    """Global CRLF/LF census over streamed chunks (replaces whole-text
    newline_kind for the streaming paths). Correct across chunk boundaries:
    a CR at the tail of one chunk followed by a LF at the head of the next
    still counts as one CRLF."""

    def __init__(self):
        self.crlf = 0
        self.lf = 0
        self._pending_cr = False

    def feed(self, chunk):
        self.lf += chunk.count(b'\n')
        self.crlf += chunk.count(b'\r\n')
        if self._pending_cr and chunk.startswith(b'\n'):
            self.crlf += 1
        self._pending_cr = chunk.endswith(b'\r')
        return chunk

    def kind(self):
        return 'mixed' if self.crlf and self.lf - self.crlf else 'CRLF' if self.crlf else 'LF'


def validate_read_request(request):
    """Validate the shared read gates; returns the maxBytes budget.

    maxBytes is a delivery budget (not a file-size cap), bounded to 1 MiB.
    """
    limit = request.get('maxBytes', 65536)
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 1048576:
        raise AgentError('INVALID_LIMIT', 'maxBytes must be between 1 and 1048576')
    return limit


def apply_delivery_budget(shown, chunk, binary):
    """Cap serialized tool content, not just source bytes (spec 4.2).

    Model-visible deliveries reserve room for paths, version and cursor
    metadata; the transfer path (grantRead=false) skips this budget so
    download chunks keep their caller-chosen size. Returns
    (shown, delivered_bytes).
    """
    if len(json.dumps(shown, ensure_ascii=False).encode('utf8')) <= READ_BUDGET:
        return shown, len(chunk)
    low, high = 0, len(shown)
    while low < high:
        middle = (low + high + 1) // 2
        if len(json.dumps(shown[:middle], ensure_ascii=False).encode('utf8')) <= READ_BUDGET:
            low = middle
        else:
            high = middle - 1
    if binary:
        chunk = chunk[:(low // 4) * 3]
        return base64.b64encode(chunk).decode('ascii'), len(chunk)
    shown = shown[:low]
    return shown, len(shown.encode('utf8'))


def line_metadata(payload, line_start, delivered_end, size):
    """Report (lineEnd, lineEndComplete) for a delivered line-mode window."""
    breaks = payload.count(b'\n')
    line_end = line_start + breaks - (1 if payload.endswith(b'\n') else 0)
    complete = payload.endswith(b'\n') or delivered_end >= size
    return line_end, complete


# --- Byte-range and content helpers ------------------------------------------------

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


def preserve_newlines_census(text, census):
    """CRLF preservation driven by the streamed census (issue #10)."""
    return text.replace('\r\n', '\n').replace('\n', '\r\n') if census.kind() == 'CRLF' else text


def replaceable(info):
    if info.st_nlink != 1 or info.st_uid != os.getuid():
        raise AgentError('UNSUPPORTED_METADATA', 'Mutation requires an owned file with a single link')


# --- Replacement planning -----------------------------------------------------
# Decides what to replace and where. Since issue #10 the plan is built by one
# chunked pass over the file (spec 4.3): nothing buffers the whole text.

def validate_edits(edits):
    """Validate an edit list; returns [(oldText, newText)] pairs."""
    if not isinstance(edits, list) or not edits or len(edits) > 100:
        raise AgentError('INVALID_EDIT', 'Provide between 1 and 100 exact replacements')
    pairs = []
    for edit in edits:
        if not isinstance(edit, dict):
            raise AgentError('INVALID_EDIT', 'Each edit must be an object')
        old, new = edit.get('oldText'), edit.get('newText')
        if not isinstance(old, str) or not old or not isinstance(new, str):
            raise AgentError('INVALID_EDIT', 'Replacement text must be strings with a nonempty oldText')
        pairs.append((old, new))
    return pairs


def locate_replacements(stream, pairs, ranges, chunk_size=MAX_STREAM_CHUNK):
    """Plan replacements by streaming the whole file once (spec 4.3).

    Byte-level matching over chunked reads with an overlap carry reproduces
    the first-version whole-text semantics: UTF-8 is self-synchronizing, so
    the byte spans of oldText.encode('utf8') are exactly the whole-text spans,
    and each edit must match exactly once with the whole span inside ranges
    granted by reads. The same pass validates the file is UTF-8 (text edits
    keep refusing binary targets) and takes the newline census that CRLF
    preservation needs. Nothing but the carry tail is held between chunks.

    Returns (replacements, byte_edits): sorted (start, end, new_bytes) byte
    spans ready to splice, plus the original-coordinate facts credential
    renewal needs.
    """
    patterns = [old.encode('utf8') for old, new in pairs]
    carry = max(max(len(pattern) for pattern in patterns) - 1, 1)
    validate_chunk = utf8_stream_validator()
    census = NewlineCensus()
    found = [[] for _ in patterns]  # first two absolute starts per pattern
    search_from = [0] * len(patterns)
    stream.seek(0)
    tail = b''
    position = 0  # absolute offset of the bytes consumed from previous buffers
    while True:
        block = stream.read(chunk_size)
        if not block:
            break
        buffer = tail + block if tail else block
        buffer_start = position - len(tail)
        validate_chunk(census.feed(block))
        for index, pattern in enumerate(patterns):
            matches = found[index]
            relative = max(0, search_from[index] - buffer_start)
            while len(matches) < 2:
                at = buffer.find(pattern, relative)
                if at < 0:
                    break
                matches.append(buffer_start + at)
                search_from[index] = buffer_start + at + 1
                relative = at + 1
        position += len(block)
        tail = buffer[-carry:] if carry else b''
    validate_chunk(b'', True)
    replacements = []
    for index, (old, new) in enumerate(pairs):
        matches = found[index]
        if not matches:
            raise AgentError('EDIT_MATCH_ERROR', 'oldText was not found; read the current file around the target and retry')
        if len(matches) > 1:
            raise AgentError('EDIT_MATCH_ERROR', 'oldText matches more than once; widen it with surrounding context until it is unique')
        start = matches[0]
        end = start + len(patterns[index])
        if not covers(ranges, start, end):
            raise AgentError('READ_REQUIRED', 'The edited range has not been delivered by a read')
        replacements.append((start, end, preserve_newlines_census(new, census).encode('utf8')))
    replacements.sort()
    if any(left[1] > right[0] for left, right in zip(replacements, replacements[1:])):
        raise AgentError('INVALID_EDIT', 'Replacement ranges must not overlap')
    return replacements, [(start, end, len(new_bytes)) for start, end, new_bytes in replacements]


def splice_stream(source, replacements, sink, chunk_size=MAX_STREAM_CHUNK):
    """Copy source into sink, splicing the sorted replacement spans in order.

    A length-changing rewrite of a whole file stays bounded in memory: only
    chunk-sized copies and the replacement bytes themselves pass through, so
    the cost of a variable-length edit is disk I/O, never a whole-file
    network transfer or buffer (spec 4.3).
    """
    position = 0
    for start, end, new_bytes in replacements:
        source.seek(position)
        remaining = start - position
        while remaining > 0:
            block = source.read(min(chunk_size, remaining))
            if not block:
                raise AgentError('FILE_CONFLICT', 'File shrank while splicing the replacement')
            sink.write(block)
            remaining -= len(block)
        sink.write(new_bytes)
        position = end
    source.seek(position)
    while True:
        block = source.read(chunk_size)
        if not block:
            break
        sink.write(block)


def compose_content(request, has_bom, census):
    """Build full replacement bytes from exactly one of text or base64
    data, preserving the prior BOM and newline style (streamed census)."""
    if ('text' in request) == ('data' in request):
        raise AgentError('INVALID_CONTENT', 'Provide exactly one of UTF-8 text or base64 data')
    if 'text' in request:
        if not isinstance(request['text'], str):
            raise AgentError('INVALID_CONTENT', 'text must be a string')
        text = preserve_newlines_census(request['text'], census) if census else request['text']
        return (BOM if has_bom and not text.startswith('\ufeff') else b'') + text.encode('utf8')
    try:
        return base64.b64decode(request['data'], validate=True)
    except (ValueError, TypeError):
        raise AgentError('INVALID_CONTENT', 'data must be valid base64')


# --- Commit ---------------------------------------------------------------------
# Materializes and atomically publishes new content. Since issue #10 the
# content reaches the temp file through a producer callback that streams it
# (whole-buffer writes and spliced rewrites share one flow) and publication
# flushes the directory entry, closing the #6 durability gap.

def write_temporary(path, info, produce):
    """Materialize content at a pre-registered same-directory temp path.

    The caller registers the exact path in the resource ledger before calling
    (issue #8), so a crash can never leave an untracked temp file behind, and
    hands a producer that streams the bytes into the sink (issue #10), so no
    whole-file buffer is needed on either path. This creates the file
    exclusively, preserves group and mode, fsyncs, and reports the written
    identity; publication stays with commit.
    """
    descriptor = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            produce(stream)
            if info is not None:
                os.fchown(stream.fileno(), -1, info.st_gid)
                os.fchmod(stream.fileno(), stat.S_IMODE(info.st_mode))
            stream.flush()
            os.fsync(stream.fileno())
            written_info = os.fstat(stream.fileno())
    except BaseException:
        if os.path.exists(str(path)):
            os.unlink(str(path))
        raise
    return written_info


def sync_directory(directory):
    """Flush a directory entry change to disk (spec 4.3, the #6 gap).

    fsync on the file only persists its bytes. The rename/link that publishes
    it changes the parent directory, and without an explicit directory fsync
    a crash could lose the publication (or resurrect the replaced target);
    after this call the committed name is durable.
    """
    descriptor = os.open(str(directory), os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def verify_committed_image(observed_info, written_info):
    """Confirm our exact post-image identity, not arbitrary bytes seen after
    an external replacement. ctime may legitimately change on rename; the
    streamed paths verify identity plus size instead of comparing whole
    contents (issue #10), which still detects any external replacement
    because it necessarily changes the object identity or size."""
    fields = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_mode', 'st_nlink', 'st_uid', 'st_gid')
    if any(getattr(observed_info, field) != getattr(written_info, field) for field in fields):
        raise AgentError('FILE_CONFLICT', 'File changed after the edit was committed')


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
    def lock(self, *paths):
        """Guard targets through fixed lock slots, deduplicated and acquired
        in one global order (issue #8); slot files are never deleted."""
        with acquire_slots(self.root, [str(path) for path in paths]):
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
        if _now() > token.get('expiresAt', 0):
            # Three idle days killed the credential (spec 4.2); failed and
            # query-only calls never renewed it. Expired ranges stay dead.
            raise AgentError('READ_TOKEN_EXPIRED', 'Read credential expired after three idle days; read the file again')
        return token

    def read_index(self, path):
        key = hashlib.sha256((self.session + '\0' + str(path)).encode('utf8')).hexdigest()
        return self.reads / ('index-' + key + '.json')

    def save_read(self, path, version, size, ranges, key=None):
        key = key or uuid.uuid4().hex
        now = _now()
        record = {'session': self.session, 'path': str(path), 'version': version, 'ranges': ranges, 'size': size,
                  'lastSuccessAt': now, 'expiresAt': now + READ_TOKEN_TTL_SECONDS}
        atomic_json(self.reads / (key + '.json'), record)
        atomic_json(self.read_index(path), {'readToken': key})
        return {'readToken': key, 'version': version, 'size': size, 'complete': covers(ranges, 0, size)}

    def grant_read(self, path, version, size, bom_size, start, delivered_end):
        """Merge the delivered window into the session's read credential.

        Only actually delivered bytes count (spec 4.2). An expired prior
        record is never merged back: the fresh credential starts from this
        window alone so dead ranges cannot revive.
        """
        index_path = self.read_index(path)
        key, previous = None, []
        if index_path.exists():
            candidate = read_json(index_path)['readToken']
            old = read_json(self.reads / (candidate + '.json'))
            if (old['session'] == self.session and old['path'] == str(path) and old['version'] == version
                    and _now() <= old.get('expiresAt', 0)):
                key, previous = candidate, old['ranges']
        ranges = merge_ranges(previous + [[0, bom_size], [start, delivered_end]])
        return self.save_read(path, version, size, ranges, key)

    def observe_metadata(self, path):
        """metadataOnly read: the observed version or explicit absence.

        Returns no content and grants no read coverage (spec 4.1); remote
        writes and uploads bind their overwrite checks to this version.
        """
        try:
            stream = path.open('rb')
        except FileNotFoundError:
            return {'path': str(path), 'exists': False, 'version': None, 'size': None, 'bom': None}
        except IsADirectoryError:
            raise AgentError('UNSUPPORTED_FILE', 'Only regular files are supported')
        with stream:
            info = os.fstat(stream.fileno())
            require_regular_file(info)
            if not same_object(info, path):
                raise AgentError('FILE_CONFLICT', 'File changed while observing')
            has_bom = info.st_size >= 3 and read_window(stream, 0, len(BOM)) == BOM
            return {'path': str(path), 'exists': True, 'version': content_version(info),
                    'size': info.st_size, 'bom': has_bom}

    def read(self, request):
        """Stream a bounded window of the file (spec 4.2).

        Byte cursors and metadataOnly answer in O(window); line requests
        scan sequentially to their boundaries. Nothing before the window is
        delivered, cached or indexed.
        """
        path = self.path(request.get('path'))
        encoding = request.get('encoding', 'utf8')
        if encoding not in ('base64', 'utf8'):
            raise AgentError('UNSUPPORTED_ENCODING', 'Choose utf8 or base64')
        binary = encoding == 'base64'
        metadata_only = request.get('metadataOnly', False)
        if not isinstance(metadata_only, bool):
            raise AgentError('INVALID_REQUEST', 'metadataOnly must be boolean')
        if metadata_only:
            if any(key in request for key in ('offset', 'fromLine', 'toLine', 'maxBytes')) or 'encoding' in request:
                raise AgentError('INVALID_REQUEST', 'metadataOnly observes the version; drop the content selectors')
            return self.observe_metadata(path)
        limit = validate_read_request(request)
        expected = request.get('expectedVersion')
        if expected is not None and not isinstance(expected, str):
            raise AgentError('INVALID_REQUEST', 'expectedVersion must be text')
        with self.lock(path):
            try:
                stream = path.open('rb')
            except FileNotFoundError:
                raise AgentError('PATH_NOT_FOUND', 'File does not exist')
            except IsADirectoryError:
                raise AgentError('UNSUPPORTED_FILE', 'Only regular files are supported')
            with stream:
                before = os.fstat(stream.fileno())
                require_regular_file(before)
                if not same_object(before, path):
                    raise AgentError('FILE_CONFLICT', 'File changed while reading')
                version = content_version(before)
                size = before.st_size
                if expected is not None and expected != version:
                    # A cursor issued for another version is refused, not
                    # silently continued into changed content (spec 4.2).
                    raise AgentError('FILE_CONFLICT', 'File changed since this cursor was issued')
                has_bom = size >= 3 and read_window(stream, 0, len(BOM)) == BOM
                bom_size = 3 if has_bom and not binary else 0
                line_window = False
                if 'offset' in request or binary:
                    offset = request.get('offset', 0)
                    if not isinstance(offset, int) or isinstance(offset, bool) or not 0 <= offset <= size:
                        raise AgentError('INVALID_OFFSET', 'Byte offset is outside the file')
                    start = max(bom_size, offset)
                    if not binary and start < size:
                        stream.seek(start)
                        lead = stream.read(1)
                        if lead and lead[0] & 0xc0 == 0x80:
                            raise AgentError('INVALID_OFFSET', 'Offset must be at a UTF-8 character boundary')
                    end = size
                else:
                    first, last = request.get('fromLine', 1), request.get('toLine')
                    if not isinstance(first, int) or isinstance(first, bool) or first < 1:
                        raise AgentError('INVALID_LINE_RANGE', 'Line ranges are one-based and inclusive')
                    if last is None:
                        last = first + size + 1  # sentinel: deliver through end of file
                    if not isinstance(last, int) or isinstance(last, bool) or last < 1 or last < first:
                        raise AgentError('INVALID_LINE_RANGE', 'Line ranges are one-based and inclusive')
                    line_window = True
                    start = scan_to_line_start(stream, first, bom_size)
                    if start is None:
                        start = end = size  # past the last line: empty delivery
                    else:
                        end = scan_to_line_end(stream, last, bom_size, size)
                chunk = read_window(stream, start, min(end - start, limit))
                budgeted = request.get('grantRead', True) is not False
                if binary:
                    shown = base64.b64encode(chunk).decode('ascii')
                    if budgeted:
                        shown, delivered = apply_delivery_budget(shown, chunk, binary)
                    else:
                        delivered = len(chunk)
                    payload = chunk[:delivered]
                else:
                    text, trimmed = decode_utf8_prefix(chunk)
                    shown, source = text, chunk[:len(chunk) - trimmed]
                    if budgeted:
                        shown, delivered = apply_delivery_budget(text, source, binary)
                    else:
                        delivered = len(source)
                    payload = shown.encode('utf8')
                delivered_end = start + delivered
                if delivered_end == start and start < end:
                    raise AgentError('INVALID_LIMIT', 'maxBytes is too small for the next UTF-8 character')
                after = os.fstat(stream.fileno())
                if metadata(before) != metadata(after) or not same_object(after, path):
                    raise AgentError('FILE_CONFLICT', 'File changed while reading')
                result = {'path': str(path), 'data' if binary else 'text': shown, 'encoding': encoding,
                          'newline': None if binary or not (payload.count(b'\n') or payload.count(b'\r'))
                                     else newline_kind(payload),
                          'version': version, 'size': size, 'bom': has_bom,
                          'startOffset': start, 'endOffset': delivered_end,
                          'nextOffset': delivered_end if delivered_end < end else None,
                          'truncated': delivered_end < end}
                if line_window and start is not None:
                    line_end, complete = line_metadata(payload, first, delivered_end, size)
                    result.update(lineStart=first, lineEnd=line_end, lineEndComplete=complete)
                if request.get('grantRead', True) is False:
                    return result
                return dict(result, **self.grant_read(path, version, size, bom_size, start, delivered_end))

    def edit(self, request):
        path = self.path(request.get('path'), writing=True)
        pairs = validate_edits(request.get('edits'))
        with self.lock(path):
            with path.open('rb') as stream:
                info = os.fstat(stream.fileno())
                require_regular_file(info)
                if not same_object(info, path):
                    raise AgentError('FILE_CONFLICT', 'File identity changed while observing')
                version = content_version(info)
                token = self.token(request.get('readToken'), path, version)
                replaceable(info)
                replacements, byte_edits = locate_replacements(stream, pairs, token['ranges'])
                if metadata(os.fstat(stream.fileno())) != metadata(info) or not same_object(info, path):
                    raise AgentError('FILE_CONFLICT', 'File changed while locating replacements')
            output_size = info.st_size + sum(len(new_bytes) - (end - start) for start, end, new_bytes in replacements)
            written_info = self.commit_spliced(path, replacements, info, version, output_size, origin='file-edit')
            result = {'path': str(path), 'written': True, 'bytesWritten': output_size, 'editsApplied': len(replacements)}
            return self.renew_after_edit(path, token, byte_edits, output_size, written_info, result)

    def renew_after_edit(self, path, token, byte_edits, output_size, written_info, result):
        """Verify the committed image and renew the read credential.

        The write already happened: verification failures never turn the
        edit into a reported failure, they only invalidate the credential
        and require a fresh read.
        """
        try:
            with path.open('rb') as stream:
                observed_info = os.fstat(stream.fileno())
                if not same_object(observed_info, path):
                    raise AgentError('FILE_CONFLICT', 'File identity changed after the edit')
                new_version = content_version(observed_info)
            verify_committed_image(observed_info, written_info)
            ranges = remap_read_ranges(token['ranges'], byte_edits)
            result.update(self.save_read(path, new_version, output_size, ranges))
            result['rereadRequired'] = False
        except (OSError, AgentError) as error:
            result.update(readToken=None, rereadRequired=True, readTokenError=getattr(error, 'code', 'READ_RECORD_UNAVAILABLE'),
                          message='Edit committed, but read-token renewal could not be confirmed. Read the current file before further editing.')
        return result

    def publish(self, path, info, version, origin, produce, output_size):
        """Atomically install produced content at path through a same-directory
        temp file (streamed since issue #10; no output size gate anymore).

        Owns the workspace quota gate, the in-lock pre-replace version
        re-check, replace-versus-link publication and the directory fsync that
        makes the published name durable. The temp file is registered in the
        resource ledger (and quota-checked) before it can exist; a successful
        publication releases the registration so the committed target leaves
        the space measurement (issue #8).
        """
        temporary = path.parent / ('.ssh-mcp-' + uuid.uuid4().hex)
        resource_id = ledger.register_temp(self.root, str(temporary), output_size, self.session, origin)
        try:
            written_info = write_temporary(temporary, info, produce)
            ledger.attach_identity(self.root, resource_id, '{}:{}'.format(written_info.st_dev, written_info.st_ino))
            self.path(str(path), writing=True)
            if version is not None:
                if current_version(path) != version:
                    raise AgentError('FILE_CONFLICT', 'File changed before committing the write')
                os.replace(str(temporary), str(path))
            else:
                try:
                    os.link(str(temporary), str(path))
                except FileExistsError:
                    raise AgentError('FILE_CONFLICT', 'Creation target already exists')
            sync_directory(path.parent)
            return written_info
        except OSError as error:
            if error.errno == errno.ENOSPC:
                raise AgentError('STORAGE_FULL', 'Remote filesystem reported ENOSPC while committing the write')
            raise
        finally:
            if os.path.exists(str(temporary)):
                os.unlink(str(temporary))
            ledger.release(self.root, resource_id)

    def commit(self, path, data, info=None, version=None, origin='file'):
        """Publish buffered content (whole-file writes)."""
        return self.publish(path, info, version, origin, lambda sink: sink.write(data), len(data))

    def commit_spliced(self, path, replacements, info, version, output_size, origin='file-edit'):
        """Publish a spliced rewrite: re-reads the current source in bounded
        chunks and never buffers or transfers the whole file (spec 4.3)."""
        def produce(sink):
            with path.open('rb') as source:
                splice_stream(source, replacements, sink)
        return self.publish(path, info, version, origin, produce, output_size)

    def full_read(self, request, path, version, size, field='readToken'):
        token = self.token(request.get(field), path, version)
        if not covers(token['ranges'], 0, size):
            raise AgentError('READ_REQUIRED', 'This operation requires a complete read of the current file')

    def write(self, request):
        path = self.path(request.get('path'), writing=True)
        if 'readToken' in request:
            raise AgentError('INVALID_REQUEST',
                             'Whole-file writes no longer take readToken; observe the target with a metadataOnly read '
                             'and pass overwrite=true with that expectedVersion to replace it')
        creating = request.get('create', False)
        overwriting = request.get('overwrite', False)
        if not isinstance(creating, bool) or not isinstance(overwriting, bool):
            raise AgentError('INVALID_REQUEST', 'create and overwrite must be boolean')
        if creating and overwriting:
            raise AgentError('INVALID_REQUEST', 'Choose create (target must be absent) or overwrite (bound to its observed version), not both')
        expected = request.get('expectedVersion')
        if overwriting and not isinstance(expected, str):
            raise AgentError('INVALID_REQUEST', 'overwrite requires the expectedVersion observed through a metadataOnly read')
        if not overwriting and expected is not None:
            raise AgentError('INVALID_REQUEST', 'expectedVersion only pairs with overwrite=true')
        with self.lock(path):
            info = None
            version = None
            has_bom = False
            census = None
            if overwriting:
                # Explicit whole-file replacement (ADR 0008): the observed
                # metadata version is the guard; no prior read of the old
                # content is required or sufficient.
                try:
                    stream = path.open('rb')
                except FileNotFoundError:
                    raise AgentError('FILE_CONFLICT', 'Overwrite target does not exist; keep overwrite bound to an existing observed version or create instead')
                with stream:
                    info = os.fstat(stream.fileno())
                    require_regular_file(info)
                    if not same_object(info, path):
                        raise AgentError('FILE_CONFLICT', 'File identity changed while observing')
                    version = content_version(info)
                    replaceable(info)
                    if version != expected:
                        raise AgentError('FILE_CONFLICT', 'File changed since the observed version; read the metadata again and re-issue the overwrite')
                    if 'text' in request:
                        # Text replacement keeps refusing binary targets and
                        # keeps BOM/CRLF style: one streamed pass collects both.
                        census = NewlineCensus()
                        validate_chunk = utf8_stream_validator()
                        stream.seek(0)
                        head = stream.read(len(BOM))
                        has_bom = head == BOM
                        if head:
                            validate_chunk(census.feed(head))
                        while True:
                            block = stream.read(MAX_STREAM_CHUNK)
                            if not block:
                                break
                            validate_chunk(census.feed(block))
                        validate_chunk(b'', True)
            elif path.exists():
                raise AgentError('FILE_CONFLICT',
                                 'Target already exists; whole-file writes default to create-only. To replace it, '
                                 'observe the version with a metadataOnly read and re-issue with overwrite=true and that expectedVersion')
            data = compose_content(request, has_bom, census)
            self.commit(path, data, info, version, origin='file-write')
            return {'path': str(path), 'written': True, 'created': creating, 'overwritten': overwriting,
                    'bytesWritten': len(data)}

    def delete(self, request):
        path = self.path(request.get('path'), writing=True)
        with self.lock(path):
            data, info, version = snapshot(path)
            self.full_read(request, path, version, len(data))
            replaceable(info)
            if current_version(path) != version:
                raise AgentError('FILE_CONFLICT', 'File changed before deletion')
            path.unlink()
            return {'path': str(path), 'deleted': True}

    def move(self, request):
        source = self.path(request.get('path'), writing=True)
        target = self.path(request.get('target'), writing=True)
        if source == target:
            raise AgentError('INVALID_PATH', 'Source and destination must differ')
        left, right = sorted((source, target), key=str)
        with self.lock(left, right):
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
            if current_version(source) != version:
                raise AgentError('FILE_CONFLICT', 'Source changed before move')
            if target_version is not None:
                if current_version(target) != target_version:
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
            from discovery import search_capabilities, DEFAULT_SCAN_BUDGET_BYTES, DEFAULT_SCAN_BUDGET_SECONDS
            capabilities = search_capabilities()
            return {'remoteRoot': str(self.workspace), 'directoryScope': 'unrestricted' if self.unrestricted else 'restricted',
                    'python': platform.python_version(),
                    'runtimeLibc': os.confstr('CS_GNU_LIBC_VERSION'),
                    'ruleFiles': [str(path.relative_to(self.workspace)) for path in
                                  [self.workspace / 'AGENTS.md', self.workspace / 'CLAUDE.md'] if path.is_file()],
                    'instructions': 'Read applicable root and nested AGENTS.md/CLAUDE.md with file_read before editing.',
                    'capabilities': {'interactiveInput': False, 'pty': False, 'reattachTerminal': False,
                                     'persistentTasks': True, 'streamedRead': True, 'streamedWrite': True,
                                     'readTokenTtlDays': READ_TOKEN_TTL_SECONDS // 86400,
                                     'searchEngine': capabilities['searchEngine'],
                                     'searchBackends': capabilities['searchBackends'],
                                     'gitignoreSearch': True,
                                     'searchScanBudgetBytes': DEFAULT_SCAN_BUDGET_BYTES,
                                     'searchScanBudgetSeconds': DEFAULT_SCAN_BUDGET_SECONDS,
                                     'rgPath': shutil.which('rg'), 'grepPath': shutil.which('grep')}}
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
