"""Resumable verified transfer transactions, both directions (issues #13/#14).

Both ends of a workspace keep small records under <stateRoot>/transfers/
<transferId>/: record.json (identity, state machine, confirmed offset),
chunks.jsonl (one appended line per verified block, read back streaming) and,
at commit time, intent.json (the persisted plan) plus receipt.json (the
durable outcome). Received bytes materialize in a temp file next to the
target, registered in the resource ledger before it can exist (issue #8).

Register-then-execute (issue #7 shape): transfer_register durably assigns the
identifier, and every later action accepts only that registered identifier --
a missing record is REQUEST_EXPIRED_OR_UNKNOWN and never falls back to
creation. Queries observe without starting anything or renewing expiry.

Uploads (issue #13) carry blocks as one bounded JSON control line followed by
exactly `size` raw bytes on the helper's stdin binary stream; downloads
(issue #14) reverse the roles. The remote end is the sender: it binds the
source through a metadata-only m1- version observed while streaming the
register-time digest, serves blocks framed on stdout (control line + exact
bytes + the regular SSH_MCP_V1 envelope), and lets the receiver -- the local
Node driver -- verify each digest, persist, advance the confirmed offset and
finally publish under the issue #10 overwrite contract. A fetch may rewind to
any already-served boundary: the receiver's confirmed position is
authoritative, so a response lost after the sender advanced is simply
re-served. No whole-file base64 ever enters JSON, no model-driven per-block
calls, one block in flight per transfer.

The final SHA-256 is computed independently on both ends over the full
content: the sender streams it at registration, the receiver recomputes it at
verify and asserts it (transfer_verify compares the assertion). The full file
is never shipped across the wire for checking.

Commit follows the issue #10 skeleton. On upload the remote publishes the
temp (intent first, atomic replacement, receipt last; a lost response
reconciles by object identity). On download the receiver publishes locally
and the sender records the asserted outcome idempotently so the shared
active-transfer slot frees. Cancel (issue #15) only deletes uncommitted data
after the per-transfer lock confirms nothing is in flight, never rolls back
a publication the persisted evidence proves happened, and reports unknown
when the commit-window evidence is inconclusive. Acknowledgement consumes a
terminal result and is kept separate from status, which stays read-only.
Python 3.6 standard library only.
"""
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import stat as stat_module
import time
import uuid

from common import AgentError, atomic_json, read_json
import ledger
from locks import acquire_slots


PROTOCOL = 2
MIN_CHUNK = 65536
MAX_CHUNK = 8 * 1024 * 1024
TRANSFER_TTL_SECONDS = 3 * 24 * 3600
HEX64 = re.compile(r'[0-9a-f]{64}')
ACTIVE_STATES = frozenset(('prepared', 'transferring', 'verifying', 'committing'))
MAX_ACTIVE_TRANSFERS = 2
STREAM_CHUNK = 256 * 1024
# Terminal states a result acknowledgement may consume (issue #15). `unknown`
# is deliberately absent: an unverified outcome must never be acknowledged.
TERMINAL_STATES = frozenset(('completed', 'failed', 'cancelled', 'interrupted'))


def _now():
    clock = os.environ.get('SSH_MCP_TEST_CLOCK')
    return float(clock) if clock is not None else time.time()


def _transfer_id(value):
    if not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{32}', value):
        raise AgentError('INVALID_REQUEST', 'transferId must be a 32-hex identifier')
    return value


def transfers_directory(root):
    directory = Path(root) / 'transfers'
    directory.mkdir(mode=0o700, exist_ok=True)
    return directory


def transfer_path(root, transfer_id):
    path = transfers_directory(root) / _transfer_id(transfer_id)
    if path.is_symlink():
        raise AgentError('INVALID_STATE_PATH', 'Transfer directory must not be a symlink')
    return path


def _load_record(root, transfer_id):
    path = transfer_path(root, transfer_id)
    if not (path / 'record.json').is_file():
        raise AgentError('REQUEST_EXPIRED_OR_UNKNOWN',
                         'No registration for this transfer identifier; register it explicitly first')
    return read_json(path / 'record.json')


def _save_record(root, transfer_id, record):
    atomic_json(transfer_path(root, transfer_id) / 'record.json', record)


def describe(record):
    """The bounded observation: identity, state, progress and horizons."""
    result = {'schemaVersion': 1, 'transferId': record['transferId'], 'direction': record['direction'],
              'state': record['state'], 'targetPath': record['targetPath'],
              'chunkSize': record['chunkSize'], 'totalBytes': record['totalBytes'],
              'sha256': record['totalSha256'], 'confirmedOffset': record['confirmedOffset'],
              'chunkCount': record['chunkCount'], 'overwrite': record['overwrite'], 'create': record['create'],
              'registeredAt': record['registeredAt'], 'expiresAt': record['expiresAt']}
    if record['direction'] == 'download':
        result['sourcePath'] = record['sourcePath']
        result['sourceVersion'] = record['sourceVersion']
    for field in ('startedAt', 'lastProgressAt', 'completedAt', 'error'):
        if record.get(field) is not None:
            result[field] = record[field]
    return result


def _require_protocol(request):
    if request.get('protocol') != PROTOCOL:
        raise AgentError('INVALID_PROTOCOL', 'This action requires protocol version 2')


def _require_int(value, field, minimum, maximum):
    if not isinstance(value, int) or isinstance(value, bool) or not minimum <= value <= maximum:
        raise AgentError('INVALID_REQUEST', '{} must be an integer between {} and {}'.format(field, minimum, maximum))
    return value


def _validate_source_identity(value):
    if not isinstance(value, dict):
        raise AgentError('INVALID_REQUEST', 'sourceIdentity must carry the observed size and mtime')
    size, mtime = value.get('size'), value.get('mtimeMs')
    if not isinstance(size, int) or isinstance(size, bool) or size < 0:
        raise AgentError('INVALID_REQUEST', 'sourceIdentity.size must be a nonnegative integer')
    if not isinstance(mtime, (int, float)) or isinstance(mtime, bool):
        raise AgentError('INVALID_REQUEST', 'sourceIdentity.mtimeMs must be a number')
    return {'size': size, 'mtimeMs': mtime}


def _match_source(record, source_identity):
    expected = record['sourceIdentity']
    if (source_identity['size'] != expected['size']
            or abs(source_identity['mtimeMs'] - expected['mtimeMs']) > 1e-9):
        raise AgentError('TRANSFER_SOURCE_CHANGED',
                         'The local source changed since registration; refuse to mix versions, register a new transfer')


def _require_session(record, request):
    """Every action (not just block exchange) belongs to the registering session."""
    if request.get('sessionId') != record['sessionId']:
        raise AgentError('TRANSFER_SCOPE_MISMATCH', 'Transfer belongs to a different session')


def _validate_source_version(value):
    if not isinstance(value, str) or not value:
        raise AgentError('INVALID_REQUEST', 'sourceVersion must be the observed m1- version echoed by registration')
    return value


def _match_source_version(record, echoed):
    if echoed != record['sourceVersion']:
        raise AgentError('TRANSFER_SOURCE_CHANGED',
                         'The remote source changed since registration; refuse to mix versions, register a new transfer')


def _require_live_source(record):
    """Refuse unless the live file still is the registered source version."""
    from files import current_version
    source = Path(record['sourcePath'])
    try:
        version = current_version(source)
    except FileNotFoundError:
        version = None
    if version != record['sourceVersion']:
        raise AgentError('TRANSFER_SOURCE_CHANGED',
                         'The remote source no longer matches the registered version; register a new transfer')


def _observe_source(path):
    """Version and stream-digest the download source in one stable window.

    The metadata-only version (spec 4.1) is observed before and re-checked
    after the streamed SHA-256, so the registered digest always describes one
    stable source version even if the file is rewritten mid-read.
    """
    from files import content_version, metadata, require_regular_file, same_object
    try:
        stream = path.open('rb')
    except FileNotFoundError:
        raise AgentError('PATH_NOT_FOUND', 'Download source does not exist')
    except IsADirectoryError:
        raise AgentError('UNSUPPORTED_FILE', 'Only regular files are supported')
    with stream:
        before = os.fstat(stream.fileno())
        require_regular_file(before)
        if not same_object(before, path):
            raise AgentError('FILE_CONFLICT', 'Source identity changed while observing')
        version = content_version(before)
        digest = hashlib.sha256()
        while True:
            block = stream.read(STREAM_CHUNK)
            if not block:
                break
            digest.update(block)
        after = os.fstat(stream.fileno())
        if metadata(before) != metadata(after) or not same_object(after, path):
            raise AgentError('FILE_CONFLICT', 'Source changed while digesting; register again after it settles')
    return version, before.st_size, digest.hexdigest()


def _active_transfer_count(root):
    count = 0
    for candidate in sorted(transfers_directory(root).iterdir()):
        if candidate.is_symlink() or not candidate.is_dir():
            continue
        try:
            record = read_json(candidate / 'record.json')
        except (OSError, ValueError):
            continue
        if isinstance(record, dict) and record.get('state') in ACTIVE_STATES:
            count += 1
    return count


def register(root, request):
    """Durably assign a transfer identity; no bytes move and no temp exists."""
    _require_protocol(request)
    service = _file_service(root, request)
    direction = request.get('direction')
    if direction not in ('upload', 'download'):
        raise AgentError('INVALID_REQUEST', "direction must be 'upload' or 'download' for this action")
    chunk = _require_int(request.get('chunkSize'), 'chunkSize', MIN_CHUNK, MAX_CHUNK)
    overwriting = request.get('overwrite', False)
    creating = request.get('create', False)
    if not isinstance(overwriting, bool) or not isinstance(creating, bool):
        raise AgentError('INVALID_REQUEST', 'create and overwrite must be boolean')
    expected = request.get('expectedVersion')
    if overwriting and creating:
        raise AgentError('INVALID_REQUEST', 'Choose create (target must be absent) or overwrite (bound to its observed version), not both')
    if overwriting and not isinstance(expected, str):
        raise AgentError('INVALID_REQUEST', 'overwrite requires the expectedVersion observed for the target')
    if not overwriting and expected is not None:
        raise AgentError('INVALID_REQUEST', 'expectedVersion only pairs with overwrite=true')
    if direction == 'upload':
        total = _require_int(request.get('totalBytes'), 'totalBytes', 0, 9007199254740991)
        digest = request.get('totalSha256')
        if not isinstance(digest, str) or not HEX64.fullmatch(digest):
            raise AgentError('INVALID_REQUEST', 'totalSha256 must be a 64-hex digest')
        source = _validate_source_identity(request.get('sourceIdentity'))
        if source['size'] != total:
            raise AgentError('INVALID_REQUEST', 'sourceIdentity.size must equal totalBytes (one stat, one registration)')
        target = service.path(request.get('targetPath'), writing=True)
        from files import content_version, current_version, replaceable
        # Fail fast on the target state (issue #10 semantics); the authoritative
        # recheck still happens inside commit.
        if overwriting:
            try:
                info = target.stat()
            except FileNotFoundError:
                raise AgentError('FILE_CONFLICT', 'Overwrite target does not exist; keep overwrite bound to an existing observed version or create instead')
            if not stat_module.S_ISREG(info.st_mode):
                raise AgentError('UNSUPPORTED_FILE', 'Only regular files are supported')
            replaceable(info)
            if current_version(target) != expected:
                raise AgentError('FILE_CONFLICT', 'File changed since the observed version; read the metadata again and re-issue the upload')
        elif target.exists():
            raise AgentError('FILE_CONFLICT',
                             'Target already exists; uploads default to create-only. To replace it, observe the version '
                             'with a metadataOnly read and re-issue with overwrite=true and that expectedVersion')
    else:
        # Downloads compute their own facts about the source: the caller cannot
        # assert a size or digest for a file only the remote end can see.
        for field in ('totalBytes', 'totalSha256', 'sourceIdentity'):
            if request.get(field) is not None:
                raise AgentError('INVALID_REQUEST',
                                 '{} is derived from the remote source; do not send it'.format(field))
        reported_target = request.get('targetPath')
        if not isinstance(reported_target, str) or not reported_target:
            raise AgentError('INVALID_REQUEST', 'targetPath must report the local destination of the download')
        source = service.path(request.get('sourcePath'), writing=False)
        version, total, digest = _observe_source(source)
    transfer_id = uuid.uuid4().hex
    path = transfer_path(root, transfer_id)
    with acquire_slots(root, ['transfer-registry']):
        if direction == 'download':
            # The digest streamed outside the lock: re-verify cheaply that the
            # live file still is the observed version before anchoring it.
            from files import current_version
            if current_version(source) != version:
                raise AgentError('FILE_CONFLICT', 'Source changed while registering; register again after it settles')
        if _active_transfer_count(root) >= MAX_ACTIVE_TRANSFERS:
            raise AgentError('TRANSFER_LIMIT_REACHED',
                             'At most {} active transfers are allowed per workspace'.format(MAX_ACTIVE_TRANSFERS))
        now = _now()
        record = {'schemaVersion': 1, 'transferId': transfer_id, 'direction': direction,
                  'sessionId': service.session,
                  'chunkSize': chunk, 'totalBytes': total, 'totalSha256': digest,
                  'overwrite': overwriting, 'create': creating,
                  'expectedVersion': expected if overwriting else None,
                  'state': 'prepared', 'confirmedOffset': 0, 'chunkCount': 0,
                  'resourceId': None,
                  'registeredAt': now, 'startedAt': None, 'lastProgressAt': None,
                  'expiresAt': now + TRANSFER_TTL_SECONDS, 'completedAt': None, 'error': None}
        if direction == 'upload':
            record.update(targetPath=str(target), sourceIdentity=source,
                          tempPath=str(target.parent / ('.ssh-mcp-upload-' + transfer_id)))
        else:
            # The sender materializes nothing remotely; the receiver owns the
            # temp, the manifest and the publication.
            record.update(targetPath=reported_target, sourcePath=str(source),
                          sourceVersion=version, tempPath=None)
        try:
            path.mkdir(mode=0o700)
        except FileExistsError:
            raise AgentError('REQUEST_CONFLICT', 'Transfer identifier was already assigned')
        _save_record(root, transfer_id, record)
    return describe(record)


def _materialize(root, record):
    """Register the temp in the ledger, then create it exclusively."""
    # The temp path is named after this transfer alone and a prepared record
    # has never accepted a block, so anything already registered or on disk
    # under that name is this very transaction's leftover from a crash
    # between registration and the first save -- clear it before retrying.
    for stale in ledger.find_by_path(root, record['tempPath']):
        ledger.release(root, stale)
    try:
        os.unlink(record['tempPath'])
    except FileNotFoundError:
        pass
    resource_id = ledger.register_temp(root, record['tempPath'], record['totalBytes'],
                                       record['sessionId'], 'transfer-upload')
    try:
        descriptor = os.open(record['tempPath'], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except BaseException:
        ledger.release(root, resource_id)
        raise
    try:
        info = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    ledger.attach_identity(root, resource_id, '{}:{}'.format(info.st_dev, info.st_ino))
    record['resourceId'] = resource_id
    return record


def _read_manifest(root, transfer_id):
    """Stream the chunk manifest one line at a time; never a whole-file load.

    A process killed mid-append leaves a torn final line: the first line that
    fails to parse ends the manifest (the torn line and anything after it is
    not trusted). The record for that chunk advances only after the manifest
    append, so dropping the torn tail equals treating the chunk as
    unconfirmed and _heal's truncation rewinds accordingly.
    """
    path = transfer_path(root, transfer_id) / 'chunks.jsonl'
    if not path.is_file():
        return
    with path.open('r') as stream:
        for line in stream:
            line = line.strip()
            if line:
                try:
                    yield json.loads(line)
                except ValueError:
                    return


def _truncate_manifest(root, transfer_id, keep):
    """Atomically rewrite the manifest, keeping only the first `keep` lines."""
    directory = transfer_path(root, transfer_id)
    kept = []
    for index, entry in enumerate(_read_manifest(root, transfer_id)):
        if index >= keep:
            break
        kept.append(entry)
    temporary = directory / '.manifest-pending'
    with temporary.open('w') as stream:
        for entry in kept:
            stream.write(json.dumps(entry, ensure_ascii=True, sort_keys=True) + '\n')
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(str(temporary), str(directory / 'chunks.jsonl'))


def _digest_window(path, offset, size):
    """SHA-256 of [offset, offset+size) read through a bounded buffer."""
    digest = hashlib.sha256()
    remaining = size
    with open(str(path), 'rb') as stream:
        stream.seek(offset)
        while remaining > 0:
            block = stream.read(min(STREAM_CHUNK, remaining))
            if not block:
                raise AgentError('TRANSFER_DATA_SHORT', 'Persisted transfer data ended early')
            digest.update(block)
            remaining -= len(block)
    return digest.hexdigest()


def _heal(root, transfer_id, record):
    """Re-verify persisted chunks and rewind to the last trusted boundary.

    Each manifest entry is re-digested from the temp file; the first entry
    whose bytes are missing or wrong truncates both the manifest and the file
    to that boundary. A deleted temp restarts from zero.
    """
    temp = Path(record['tempPath'])
    trusted = 0
    trusted_offset = 0
    if temp.exists():
        for entry in _read_manifest(root, transfer_id):
            size = entry['size']
            try:
                current = _digest_window(temp, entry['offset'], size)
            except AgentError:
                break
            if current != entry['sha256']:
                break
            trusted += 1
            # The trusted boundary is the sum of the verified entries' sizes
            # (the final block may be short), never trusted * chunk_size --
            # that would extend the temp past the real content when every
            # block is already confirmed.
            trusted_offset += size
        if trusted_offset != temp.stat().st_size:
            with temp.open('r+b') as stream:
                stream.truncate(trusted_offset)
                stream.flush()
                os.fsync(stream.fileno())
    else:
        trusted_offset = 0
        descriptor = os.open(str(temp), os.O_WRONLY | os.O_CREAT, 0o600)
        os.close(descriptor)
    if trusted != record['chunkCount']:
        _truncate_manifest(root, transfer_id, trusted)
        record['chunkCount'] = trusted
        record['confirmedOffset'] = trusted_offset
    return record


def _validate_source_echo(record, request):
    """Check whichever source identity the registered direction echoes."""
    if record['direction'] == 'download':
        return _validate_source_version(request.get('sourceVersion'))
    return _validate_source_identity(request.get('sourceIdentity'))


def _match_source_echo(record, request, echoed):
    if record['direction'] == 'download':
        _match_source_version(record, echoed)
        # The live file is re-observed while the transfer can still move;
        # terminal records stay observable instead of raising over a source
        # that no longer matters to them.
        if record['state'] not in ('failed', 'completed', 'cancelled', 'unknown'):
            _require_live_source(record)
    else:
        _match_source(record, echoed)


def start(root, request):
    """Idempotently move prepared -> transferring; later calls only observe.

    Uploads re-heal persisted data on every call so a crash between writes can
    never turn into a trusted-but-wrong confirmed offset; downloads have no
    remote data to heal and instead re-observe the live source version.
    """
    _require_protocol(request)
    transfer_id = _transfer_id(request.get('transferId'))
    with acquire_slots(root, [transfer_id]):
        record = _load_record(root, transfer_id)
        _require_session(record, request)
        echoed = _validate_source_echo(record, request)
        _match_source_echo(record, request, echoed)
        if record['state'] == 'prepared':
            if record['direction'] == 'upload':
                _materialize(root, record)
            record.update(state='transferring', startedAt=_now())
            _save_record(root, transfer_id, record)
            return describe(record)
        if record['state'] in ('transferring', 'interrupted'):
            if record['state'] == 'interrupted':
                record['state'] = 'transferring'
            if record['direction'] == 'upload':
                _heal(root, transfer_id, record)
            _save_record(root, transfer_id, record)
            return describe(record)
        return describe(record)


def resume(root, request):
    """Re-attach to a started transfer: verify the source, heal, report."""
    _require_protocol(request)
    transfer_id = _transfer_id(request.get('transferId'))
    with acquire_slots(root, [transfer_id]):
        record = _load_record(root, transfer_id)
        _require_session(record, request)
        echoed = _validate_source_echo(record, request)
        _match_source_echo(record, request, echoed)
        if record['state'] == 'prepared':
            raise AgentError('INVALID_STATE', 'This transfer never started; call transfer_start first')
        if record['state'] in ('transferring', 'interrupted'):
            if record['state'] == 'interrupted':
                record['state'] = 'transferring'
            if record['direction'] == 'upload':
                _heal(root, transfer_id, record)
            _save_record(root, transfer_id, record)
        return describe(record)


def receive_block(root, transfer_id, control, payload):
    """Verify and persist one block, then advance the confirmed offset."""
    index = control.get('index')
    offset = control.get('offset')
    checksum = control.get('sha256')
    if not isinstance(index, int) or isinstance(index, bool) or index < 0:
        raise AgentError('INVALID_REQUEST', 'index must be a nonnegative integer')
    if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
        raise AgentError('INVALID_REQUEST', 'offset must be a nonnegative integer')
    if not isinstance(checksum, str) or not HEX64.fullmatch(checksum):
        raise AgentError('INVALID_REQUEST', 'sha256 must be a 64-hex digest')
    size = len(payload)
    if size < 1:
        raise AgentError('INVALID_REQUEST', 'Blocks must carry at least one byte')
    with acquire_slots(root, [transfer_id]):
        record = _load_record(root, transfer_id)
        _require_session(record, control)
        if record['state'] != 'transferring':
            raise AgentError('INVALID_STATE', 'This transfer is not accepting blocks in state {}'.format(record['state']))
        if index != record['chunkCount'] or offset != record['confirmedOffset']:
            raise AgentError('INVALID_REQUEST', 'Blocks are accepted strictly in order; resume first if the offset moved')
        if size > record['chunkSize']:
            raise AgentError('INVALID_REQUEST', 'Block exceeds the registered chunk size')
        end = offset + size
        if end > record['totalBytes'] or (end < record['totalBytes'] and size != record['chunkSize']):
            raise AgentError('INVALID_REQUEST', 'Only the final block may be shorter than the chunk size')
        if hashlib.sha256(payload).hexdigest() != checksum:
            raise AgentError('BLOCK_CHECKSUM_MISMATCH', 'Block digest mismatch; resend the block')
        # Persist first, then confirm: the manifest line and the record only
        # advance after the bytes are on disk.
        try:
            with open(record['tempPath'], 'r+b') as stream:
                stream.seek(offset)
                stream.write(payload)
                stream.flush()
        except FileNotFoundError:
            raise AgentError('INVALID_STATE', 'Received data file is missing; resume the transfer first')
        except OSError as error:
            if error.errno == errno.ENOSPC:
                raise AgentError('STORAGE_FULL', 'Remote filesystem reported ENOSPC while receiving a block')
            raise
        manifest = transfer_path(root, transfer_id) / 'chunks.jsonl'
        with manifest.open('a') as stream:
            stream.write(json.dumps({'index': index, 'offset': offset, 'size': size,
                                     'sha256': checksum}, ensure_ascii=True, sort_keys=True) + '\n')
            stream.flush()
        now = _now()
        record.update(chunkCount=index + 1, confirmedOffset=end, lastProgressAt=now,
                      expiresAt=now + TRANSFER_TTL_SECONDS)
        _save_record(root, transfer_id, record)
    return {'transferId': transfer_id, 'index': index, 'confirmedOffset': end,
            'totalBytes': record['totalBytes'], 'complete': end >= record['totalBytes']}


def fetch_exchange(root, stdin):
    """Serve one download block on a framed stdout channel (issue #14).

    The request mirrors the upload block channel: one bounded JSON control
    line on stdin. The response inverts it onto stdout -- control line,
    exactly `size` raw bytes, a newline, then the regular SSH_MCP_V1 envelope
    -- so binary content never passes through a base64 JSON payload.

    The receiver's confirmed position is authoritative: a request at the
    sender's next boundary serves the next block, and a request at any
    already-served boundary (a response lost after the sender advanced)
    rewinds and re-serves. The live source is version-checked before and
    after the read; a change fails the whole transfer rather than mixing
    versions.
    """
    line = stdin.readline()
    if not line:
        raise AgentError('INVALID_REQUEST', 'Block fetch requires a control line')
    try:
        control = json.loads(line.decode('utf8'))
    except ValueError:
        raise AgentError('INVALID_REQUEST', 'Block fetch control line must be JSON')
    if not isinstance(control, dict):
        raise AgentError('INVALID_REQUEST', 'Block fetch control frame must be an object')
    index = control.get('index')
    offset = control.get('offset')
    size = control.get('size')
    for name, value in (('index', index), ('offset', offset), ('size', size)):
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            raise AgentError('INVALID_REQUEST', '{} must be a nonnegative integer'.format(name))
    transfer_id = _transfer_id(control.get('transferId'))
    with acquire_slots(root, [transfer_id]):
        record = _load_record(root, transfer_id)
        if record['direction'] != 'download':
            raise AgentError('INVALID_REQUEST', 'Only download transfers serve blocks')
        if control.get('sessionId') != record['sessionId']:
            raise AgentError('TRANSFER_SCOPE_MISMATCH', 'Transfer belongs to a different session')
        if record['state'] != 'transferring':
            raise AgentError('INVALID_STATE', 'This transfer is not serving blocks in state {}'.format(record['state']))
        chunk_size = record['chunkSize']
        next_block = index == record['chunkCount'] and offset == record['confirmedOffset']
        # Rewind: the receiver asserts a boundary at or before the served one.
        rewind = index < record['chunkCount'] and offset == index * chunk_size
        if not (next_block or rewind):
            raise AgentError('INVALID_REQUEST',
                             'Blocks are served strictly in order from the receiver confirmed offset; resume first if the offset moved')
        if offset != index * chunk_size or size < 1 or size > chunk_size:
            raise AgentError('INVALID_REQUEST', 'The block must align to its index and fit the registered chunk size')
        end = offset + size
        if end > record['totalBytes'] or (end < record['totalBytes'] and size != chunk_size):
            raise AgentError('INVALID_REQUEST', 'Only the final block may be shorter than the chunk size')

        def fail(error):
            record.update(state='failed', error={'code': error.code, 'message': str(error)}, completedAt=_now())
            _save_record(root, transfer_id, record)
            raise error

        try:
            _require_live_source(record)
        except AgentError as error:
            fail(error)
        source = Path(record['sourcePath'])
        try:
            stream = source.open('rb')
        except OSError as error:
            fail(AgentError('TRANSFER_SOURCE_CHANGED', 'The download source became unreadable: {}'.format(error)))
        with stream:
            stream.seek(offset)
            payload = stream.read(size)
        if len(payload) != size:
            fail(AgentError('TRANSFER_DATA_SHORT',
                            'The source no longer holds the requested bytes; the transfer cannot continue'))
        try:
            _require_live_source(record)
        except AgentError as error:
            fail(error)
        checksum = hashlib.sha256(payload).hexdigest()
        now = _now()
        record.update(chunkCount=index + 1, confirmedOffset=end, lastProgressAt=now,
                      expiresAt=now + TRANSFER_TTL_SECONDS)
        _save_record(root, transfer_id, record)
    control_frame = {'transferId': transfer_id, 'index': index, 'offset': offset,
                     'size': size, 'sha256': checksum}
    result = {'transferId': transfer_id, 'index': index, 'confirmedOffset': end,
              'totalBytes': record['totalBytes'], 'complete': end >= record['totalBytes']}
    return control_frame, payload, result


def verify(root, request):
    """Compare the two independent full-content digests.

    Uploads stream the persisted temp's digest here; downloads receive the
    receiver's recomputed digest as an assertion and compare it to the digest
    the sender streamed at registration. Both directions transition into
    verifying only when the two ends agree.
    """
    transfer_id = _transfer_id(request.get('transferId'))
    with acquire_slots(root, [transfer_id]):
        record = _load_record(root, transfer_id)
        _require_session(record, request)
        if record['state'] == 'verifying':
            return describe(record)
        if record['state'] in ('committing', 'completed'):
            return describe(record)
        if record['direction'] == 'download':
            asserted = request.get('sha256')
            if not isinstance(asserted, str) or not HEX64.fullmatch(asserted):
                raise AgentError('INVALID_REQUEST', 'Download verify carries the receiver-computed sha256')
            if record['state'] != 'transferring' or record['confirmedOffset'] != record['totalBytes']:
                raise AgentError('INVALID_STATE', 'Verify requires the receiver to confirm all blocks first')
            if asserted != record['totalSha256']:
                record.update(state='failed', error={'code': 'VERIFY_MISMATCH',
                                                     'message': 'Receiver digest does not match the registered source digest'},
                              completedAt=_now())
                _save_record(root, transfer_id, record)
                raise AgentError('VERIFY_MISMATCH', 'Receiver digest does not match the registered source digest')
            record['state'] = 'verifying'
            _save_record(root, transfer_id, record)
            return describe(record)
        if record['state'] != 'transferring' or record['confirmedOffset'] != record['totalBytes']:
            raise AgentError('INVALID_STATE', 'Verify requires all blocks confirmed first')
        temp = Path(record['tempPath'])
        actual_size = temp.stat().st_size
        if actual_size != record['totalBytes']:
            record.update(state='failed',
                          error={'code': 'VERIFY_MISMATCH',
                                 'message': 'Received size {} does not match {}'.format(actual_size, record['totalBytes'])},
                          completedAt=_now())
            _save_record(root, transfer_id, record)
            raise AgentError('VERIFY_MISMATCH', 'Received size {} does not match {}'.format(actual_size, record['totalBytes']))
        digest = hashlib.sha256()
        with temp.open('rb') as stream:
            while True:
                block = stream.read(STREAM_CHUNK)
                if not block:
                    break
                digest.update(block)
        actual = digest.hexdigest()
        if actual != record['totalSha256']:
            record.update(state='failed', error={'code': 'VERIFY_MISMATCH',
                                                 'message': 'Whole-file digest mismatch after all blocks verified'},
                          completedAt=_now())
            _save_record(root, transfer_id, record)
            raise AgentError('VERIFY_MISMATCH', 'Whole-file digest mismatch after all blocks verified')
        # Durability point: everything the commit will publish is now on disk.
        with temp.open('rb') as stream:
            os.fsync(stream.fileno())
        record['state'] = 'verifying'
        _save_record(root, transfer_id, record)
        return describe(record)


def _receipt_result(record, receipt):
    return {'schemaVersion': 1, 'transferId': record['transferId'], 'direction': record['direction'],
            'state': 'completed', 'path': record['targetPath'], 'bytesWritten': receipt['bytes'],
            'sha256': record['totalSha256'], 'created': record['create'], 'overwritten': record['overwrite'],
            'committedAt': receipt['committedAt']}


def commit(root, request):
    """Publish the verified temp under the explicit target contract.

    Uploads publish here (intent first, action second, receipt last; a retry
    after a lost response reconciles by object identity because rename keeps
    the inode). Downloads publish on the receiver's machine; the sender only
    records the asserted outcome so the shared active slot frees -- the local
    receipt on the receiver stays the authoritative proof.
    """
    transfer_id = _transfer_id(request.get('transferId'))
    record = None
    with acquire_slots(root, [transfer_id]):
        record = _load_record(root, transfer_id)
        _require_session(record, request)
        directory = transfer_path(root, transfer_id)
        if record['direction'] == 'download':
            if record['state'] in ('completed', 'committing'):
                receipt_path = directory / 'receipt.json'
                if receipt_path.is_file():
                    return _receipt_result(record, read_json(receipt_path))
                # A committing download without a receipt: the receiver asserts
                # completion; record it now (idempotent on retry).
                receipt = {'schemaVersion': 1, 'committedAt': _now(), 'bytes': record['totalBytes'],
                           'targetIdentity': request.get('targetIdentity')}
                atomic_json(receipt_path, receipt)
                record.update(state='completed', completedAt=receipt['committedAt'])
                _save_record(root, transfer_id, record)
                return _receipt_result(record, receipt)
            if record['state'] != 'verifying':
                raise AgentError('INVALID_STATE', 'Commit requires a verified transfer in state verifying')
            receipt = {'schemaVersion': 1, 'committedAt': _now(), 'bytes': record['totalBytes'],
                       'targetIdentity': request.get('targetIdentity')}
            atomic_json(directory / 'receipt.json', receipt)
            record.update(state='completed', completedAt=receipt['committedAt'])
            _save_record(root, transfer_id, record)
            return _receipt_result(record, receipt)
        if record['state'] in ('completed', 'committing'):
            receipt_path = directory / 'receipt.json'
            if receipt_path.is_file():
                return _receipt_result(record, read_json(receipt_path))
            intent = read_json(directory / 'intent.json')
            try:
                info = os.stat(record['targetPath'])
                matches = '{}:{}'.format(info.st_dev, info.st_ino) == intent['tempIdentity']
            except OSError:
                matches = False
            if matches:
                # Identity survived the rename, but an external writer may have
                # rewritten the same inode: confirm the content too.
                matches = _digest_window(record['targetPath'], 0, info.st_size) == intent['totalSha256']
            if not matches:
                # Identical content under a different identity is not proof of
                # our commit; do not cover it again.
                raise AgentError('TRANSFER_STATE_UNKNOWN',
                                 'Commit outcome cannot be reconciled with the persisted intent; inspect the target manually')
            receipt = {'schemaVersion': 1, 'committedAt': _now(), 'bytes': intent['totalBytes'],
                       'targetIdentity': intent['tempIdentity']}
            if record['resourceId']:
                # Same cleanup as the regular publish path: the committed
                # target must leave space measurement.
                ledger.release(root, record['resourceId'])
            atomic_json(receipt_path, receipt)
            record.update(state='completed', completedAt=receipt['committedAt'])
            _save_record(root, transfer_id, record)
            return _receipt_result(record, receipt)
        if record['state'] != 'verifying':
            raise AgentError('INVALID_STATE', 'Commit requires a verified transfer in state verifying')
    # The target lock joins the transfer lock for the publication itself
    # (acquire_slots orders both, so the pairing cannot deadlock).
    with acquire_slots(root, [transfer_id, record['targetPath']]):
        record = _load_record(root, transfer_id)
        if record['state'] != 'verifying':
            # A concurrent caller moved the state on between the two lock
            # scopes; this retry observes whatever they recorded instead of
            # acting twice (never recurse under the held flock).
            if record['state'] in ('completed', 'committing'):
                receipt_path = transfer_path(root, transfer_id) / 'receipt.json'
                if receipt_path.is_file():
                    return _receipt_result(record, read_json(receipt_path))
            raise AgentError('INVALID_STATE', 'Commit requires a verified transfer in state verifying')
        from files import current_version, replaceable, sync_directory
        temp = Path(record['tempPath'])
        info = temp.stat()
        if info.st_size != record['totalBytes']:
            raise AgentError('VERIFY_MISMATCH', 'Verified temp changed size before commit')
        temp_identity = '{}:{}'.format(info.st_dev, info.st_ino)
        intent = {'schemaVersion': 1, 'targetPath': record['targetPath'],
                  'expectedVersion': record['expectedVersion'], 'overwrite': record['overwrite'],
                  'create': record['create'], 'tempIdentity': temp_identity,
                  'totalSha256': record['totalSha256'], 'totalBytes': record['totalBytes'],
                  'plannedAt': _now()}
        atomic_json(transfer_path(root, transfer_id) / 'intent.json', intent)
        record['state'] = 'committing'
        _save_record(root, transfer_id, record)
        committed = False
        try:
            target = Path(record['targetPath'])
            if record['overwrite']:
                target_info = target.stat()
                replaceable(target_info)
                if current_version(target) != record['expectedVersion']:
                    raise AgentError('FILE_CONFLICT', 'Target changed since the observed version; refusing to overwrite')
                # Preserve the replaced target's ownership and mode (#10).
                with temp.open('r+b') as stream:
                    os.fchown(stream.fileno(), -1, target_info.st_gid)
                    os.fchmod(stream.fileno(), stat_module.S_IMODE(target_info.st_mode))
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(str(temp), str(target))
                committed = True
            else:
                if target.exists():
                    raise AgentError('FILE_CONFLICT', 'Creation target appeared before commit')
                os.link(str(temp), str(target))
                committed = True
                os.unlink(str(temp))
            sync_directory(target.parent)
        except AgentError as error:
            record.update(state='failed', error={'code': error.code, 'message': str(error)}, completedAt=_now())
            _save_record(root, transfer_id, record)
            raise
        except OSError as error:
            if committed:
                # The rename already took effect: a failure here (directory
                # fsync, temp cleanup) must not strand the transfer in a
                # "failed / never took effect" shape. Keep the state at
                # committing so a retry reconciles by object identity and
                # completes the receipt (COMMITTED_UNCONFIRMED parity with
                # files.py publish).
                raise AgentError('COMMITTED_UNCONFIRMED',
                                 'The commit took effect at {} but post-commit durability failed: {}. '
                                 'Do not start a new transfer; re-issue commit or status to reconcile'.format(record['targetPath'], error))
            # Publication-stage OS failures before the target took effect
            # (vanished overwrite target, create target appearing
            # concurrently, permission errors, ...) leave the same failed
            # trail instead of stranding the state in committing with a raw
            # HELPER_ERROR on every retry.
            record.update(state='failed',
                          error={'code': 'FILE_CONFLICT',
                                 'message': 'Commit publish failed before the target took effect: {}'.format(error)},
                          completedAt=_now())
            _save_record(root, transfer_id, record)
            raise AgentError('FILE_CONFLICT',
                             'Commit publish failed before the target took effect: {}'.format(error))
        if record['resourceId']:
            ledger.release(root, record['resourceId'])
        receipt = {'schemaVersion': 1, 'committedAt': _now(), 'bytes': record['totalBytes'],
                   'targetIdentity': temp_identity}
        atomic_json(transfer_path(root, transfer_id) / 'receipt.json', receipt)
        record.update(state='completed', completedAt=receipt['committedAt'])
        _save_record(root, transfer_id, record)
        return _receipt_result(record, receipt)


def status(root, request):
    """Read-only bounded observation; starts nothing, renews nothing."""
    transfer_id = _transfer_id(request.get('transferId'))
    record = _load_record(root, transfer_id)
    _require_session(record, request)
    return describe(record)


def _release_temp(root, record):
    """Delete the uncommitted temp and release its ledger registration."""
    if record.get('resourceId'):
        ledger.release(root, record['resourceId'])
        record['resourceId'] = None
    if record.get('tempPath'):
        try:
            os.unlink(record['tempPath'])
        except FileNotFoundError:
            pass


def _publish_evidence_matches(record, intent):
    """Object identity plus content digest: the only accepted proof that the
    intent's publication actually took effect (spec 6.2)."""
    try:
        info = os.stat(record['targetPath'])
    except OSError:
        return False
    if '{}:{}'.format(info.st_dev, info.st_ino) != intent['tempIdentity']:
        return False
    try:
        return _digest_window(record['targetPath'], 0, info.st_size) == intent['totalSha256']
    except (AgentError, OSError):
        return False


def cancel(root, request):
    """Stop a not-yet-committed transfer and release its uncommitted data.

    Issue #15 semantics: a cancellation only takes effect once the transfer is
    provably stopped. The per-transfer flock serializes against any in-flight
    block exchange, so observing the record under the lock is the "no blocks
    in flight" evidence -- no data is deleted before that confirmation.

    A completed commit is never rolled back; a cancel racing the commit window
    reconciles by the persisted evidence (intent identity plus digest against
    the live target) instead of trusting the cancel request itself. When the
    evidence is inconclusive the state stays untouched and unknown is reported
    rather than guessing.
    """
    transfer_id = _transfer_id(request.get('transferId'))
    with acquire_slots(root, [transfer_id]):
        record = _load_record(root, transfer_id)
        _require_session(record, request)
        state = record['state']
        if state == 'completed':
            # Committed targets are never rolled back; observe idempotently.
            return describe(record)
        if state in ('failed', 'cancelled'):
            return describe(record)
        if state == 'committing':
            directory = transfer_path(root, transfer_id)
            intent = read_json(directory / 'intent.json')
            if _publish_evidence_matches(record, intent):
                # The rename already happened before the cancel arrived: the
                # publication stands. Complete the receipt trail exactly like
                # the lost-response reconciliation in commit().
                if record['resourceId']:
                    ledger.release(root, record['resourceId'])
                    record['resourceId'] = None
                receipt = {'schemaVersion': 1, 'committedAt': _now(), 'bytes': intent['totalBytes'],
                           'targetIdentity': intent['tempIdentity']}
                atomic_json(directory / 'receipt.json', receipt)
                record.update(state='completed', completedAt=receipt['committedAt'])
                _save_record(root, transfer_id, record)
                return describe(record)
            if not os.path.exists(record['tempPath']):
                # Neither published nor holding the temp: the outcome cannot
                # be established from evidence. Report unknown, delete nothing.
                raise AgentError('TRANSFER_STATE_UNKNOWN',
                                 'Cancel raced the commit window without evidence of the outcome; inspect the target manually')
            # The intent exists but the publication never took effect, and the
            # held lock proves it cannot start now: safe to release.
            _release_temp(root, record)
            record.update(state='cancelled', completedAt=_now())
            _save_record(root, transfer_id, record)
            return describe(record)
        if state == 'unknown':
            raise AgentError('TRANSFER_STATE_UNKNOWN',
                             'The outcome is not yet verified; resolve it before cancelling')
        # prepared / transferring / verifying / interrupted: stopped or
        # stoppable under this lock. Uploads hold the received temp; download
        # senders materialize nothing (the receiver cleans its own side).
        if record['direction'] == 'upload':
            _release_temp(root, record)
        record.update(state='cancelled', completedAt=_now())
        _save_record(root, transfer_id, record)
        return describe(record)


def acknowledge(root, request):
    """Consume a terminal result (issue #15); idempotent, never a status query.

    Only a verified terminal state may be acknowledged. `unknown` is refused:
    acknowledging it would launder an unresolved outcome into a consumed one.
    """
    transfer_id = _transfer_id(request.get('transferId'))
    with acquire_slots(root, [transfer_id]):
        record = _load_record(root, transfer_id)
        _require_session(record, request)
        if record['state'] not in TERMINAL_STATES:
            raise AgentError('TRANSFER_NOT_FINISHED',
                             'Only a terminal transfer result can be acknowledged (state: {})'.format(record['state']))
        ack_path = transfer_path(root, transfer_id) / 'ack.json'
        if not ack_path.is_file():
            atomic_json(ack_path, {'schemaVersion': 1, 'transferId': transfer_id,
                                   'state': record['state'], 'acknowledgedAt': _now()})
        return {'acknowledged': True, 'transferId': transfer_id, 'state': record['state']}


def _file_service(root, request):
    from files import FileService
    return FileService(root, request.get('workspaceRoot'), request.get('sessionId'),
                       request.get('allowedRemotePaths'), request.get('directoryScope') or 'restricted')


def block_exchange(root, stdin):
    """Read one control line plus exactly `size` raw bytes from stdin.

    This is the wire format of the binary block stream (spec 6.2): a bounded
    JSON control frame, a newline, then the block's raw bytes -- never base64
    inside JSON, never the whole file in one request.
    """
    line = stdin.readline()
    if not line:
        raise AgentError('INVALID_REQUEST', 'Block exchange requires a control line')
    try:
        control = json.loads(line.decode('utf8'))
    except ValueError:
        raise AgentError('INVALID_REQUEST', 'Block control line must be JSON')
    if not isinstance(control, dict):
        raise AgentError('INVALID_REQUEST', 'Block control frame must be an object')
    size = control.get('size')
    if not isinstance(size, int) or isinstance(size, bool) or not 1 <= size <= MAX_CHUNK:
        raise AgentError('INVALID_REQUEST', 'size must be a positive integer up to the chunk size')
    payload = bytearray()
    while len(payload) < size:
        chunk = stdin.read(size - len(payload))
        if not chunk:
            raise AgentError('INVALID_REQUEST', 'Block exchange ended before the declared size')
        payload.extend(chunk)
    return receive_block(root, _transfer_id(control.get('transferId')), control, bytes(payload))


def transfer_action(root, action, request):
    handlers = {'transfer_register': register, 'transfer_start': start,
                'transfer_resume': resume, 'transfer_verify': verify,
                'transfer_commit': commit, 'transfer_status': status,
                'transfer_cancel': cancel, 'transfer_ack': acknowledge}
    handler = handlers.get(action)
    if handler is None:
        raise AgentError('UNSUPPORTED_ACTION', 'Unknown transfer operation')
    return handler(root, request)
