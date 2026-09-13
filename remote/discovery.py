"""Bounded stdlib discovery with pluggable literal-search backends (issues #11/#12).

Content search picks ripgrep > GNU grep > a built-in chunked scanner by remote
availability. All backends share one candidate filter (workspace boundary,
hidden files, .gitignore) and one line semantics (byte-level literal matching,
\\n line ends, UTF-8 validation, NUL rejection): an external backend only ever
receives line-aligned chunks through a controlled stdin stream, so the engine
choice cannot change results. Paths never enter shell text; the backend argv
list passes the pattern as one argument and reads data from stdin.

Filename find (issue #12) enumerates through `rg --files` (implicit filtering
disabled) plus a Python skeleton walk for directories and other entry kinds,
or a plain Python walk when rg is absent or fails; grep is never used for
filename enumeration. Both routes share the candidate filter and produce one
globally sorted stream, so results do not depend on installed backends.
"""
import base64
import bisect
import fnmatch
import hashlib
import heapq
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import stat
import subprocess
import time
from common import AgentError
from files import metadata


BLOCK_BYTES = 1024 * 1024
LINE_SOFT_LIMIT = 8 * BLOCK_BYTES
SNIPPET_CHARS = 2000
EXTERNAL_LINE_BYTES = 16384
PAGE_OUTPUT_BYTES = 65536
MAX_CANDIDATES = 50000
EXTERNAL_THRESHOLD_BYTES = BLOCK_BYTES
MAX_BACKEND_FAILURES = 3
# Policy hook (#18): these defaults become configurable once policy plumbing
# lands; requests may already tighten or widen them within the clamps below.
DEFAULT_SCAN_BUDGET_BYTES = 512 * 1024 * 1024
DEFAULT_SCAN_BUDGET_SECONDS = 10
EXTERNAL_BACKENDS = (('ripgrep', 'rg'), ('gnu-grep', 'grep'))


def available_search_backends():
    """Ordered (name, executable) pairs for what is actually usable remotely."""
    found = []
    for name, binary in EXTERNAL_BACKENDS:
        located = shutil.which(binary)
        if located:
            found.append((name, located))
    return found


def search_capabilities():
    names = [name for name, _ in available_search_backends()]
    find_engine = 'ripgrep-files' if 'ripgrep' in names else 'python-walk'
    return {'searchEngine': names[0] if names else 'python-literal',
            'searchBackends': names + ['python-literal'],
            'findEngine': find_engine,
            'findBackends': (['ripgrep-files'] if find_engine == 'ripgrep-files' else [])
                            + ['python-walk']}


# --- gitignore subset -----------------------------------------------------------
# Supports negation, directory-only rules, escaped characters, anchored and
# basename patterns, nesting (deeper files win) and the git rule that a file
# under an ignored directory cannot be re-included.

def parse_gitignore(text):
    rules = []
    for raw in text.split('\n'):
        line = raw.rstrip('\r')
        if not line.strip() or line.startswith('#'):
            continue
        while line.endswith(' ') and not line.endswith('\\ '):
            line = line[:-1]
        if not line:
            continue
        negated = line.startswith('!')
        if negated:
            line = line[1:]
        if not line:
            continue
        directory_only = line.endswith('/')
        body = line.rstrip('/')
        anchored = '/' in body
        body = body.lstrip('/')
        if not body:
            continue
        body = re.sub(r'\\(.)', r'\1', body)
        rules.append({'negated': negated, 'directory': directory_only,
                      'anchored': anchored, 'segments': body.split('/')})
    return rules


def segments_match(pattern, target):
    if not pattern:
        return not target
    if pattern[0] == '**':
        return any(segments_match(pattern[1:], target[skip:]) for skip in range(len(target) + 1))
    if not target:
        return False
    return fnmatch.fnmatchcase(target[0], pattern[0]) and segments_match(pattern[1:], target[1:])


def rule_decides(rule, base, relative, is_dir):
    if rule['directory'] and not is_dir:
        return False
    if rule['anchored']:
        if len(relative) <= len(base):
            return False
        return segments_match(rule['segments'], relative[len(base):])
    if not relative:
        return False
    return fnmatch.fnmatchcase(relative[-1], rule['segments'][0])


class IgnoreLayers:
    """Stacked .gitignore layers; deeper layers and later rules override."""

    def __init__(self):
        self.layers = []

    def enter(self, directory, relative):
        self.layers = self.layers[:len(relative)]
        rules = []
        ignore_file = directory / '.gitignore'
        try:
            if ignore_file.is_file():
                rules = parse_gitignore(ignore_file.read_text('utf8', errors='ignore'))
        except OSError:
            rules = []
        self.layers.append((relative, rules))

    def ignored(self, relative, is_dir):
        verdict = False
        for base, rules in self.layers:
            for rule in rules:
                if rule_decides(rule, base, relative, is_dir):
                    verdict = not rule['negated']
        return verdict


# --- candidate enumeration --------------------------------------------------------

def limits(request):
    limit = request.get('limit', 100)
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 1000:
        raise AgentError('INVALID_LIMIT', 'limit must be between 1 and 1000')
    return limit


def iter_paths(root, recursive, include_hidden=True, respect_gitignore=False):
    """Shared candidate filter for search and find: one sorted entry list.

    Always prunes .git, drops dot-prefixed entries when include_hidden is off,
    and applies the layered .gitignore subset when explicitly requested.
    """
    if not root.is_dir():
        return [root]
    results = []
    ignore = IgnoreLayers() if respect_gitignore else None

    def recurse(directory, relative):
        if ignore is not None:
            ignore.enter(directory, relative)
        try:
            with os.scandir(str(directory)) as scanner:
                entries = sorted(scanner, key=lambda entry: entry.name)
        except OSError:
            return
        for entry in entries:
            name = entry.name
            if name == '.git' or (name.startswith('.') and not include_hidden):
                continue
            child = relative + [name]
            try:
                is_dir = entry.is_dir(follow_symlinks=False)
            except OSError:
                continue
            if ignore is not None and ignore.ignored(child, is_dir):
                continue
            results.append(Path(entry.path))
            if len(results) > MAX_CANDIDATES:
                raise AgentError('SCAN_LIMIT', 'More than {} entries; narrow the search directory'.format(MAX_CANDIDATES))
            if recursive and is_dir:
                recurse(Path(entry.path), child)

    recurse(root, [])
    return sorted(results, key=str)


def candidates(service, root, recursive):
    """Legacy enumeration for file_list/file_find (behavior unchanged)."""
    return iter_paths(root, recursive)


def stream_paths(root, include_hidden=True, respect_gitignore=False,
                 skip_files=False, budget=None):
    """Lazily yield filtered candidates in globally sorted order (issue #12).

    A k-way merge over per-directory sorted listings: the output equals
    sorted(iter_paths(...), key=str) item for item without materializing the
    tree, so a budget stop always leaves a true sorted prefix behind and the
    cursor can resume by position without rescanning results. The exclusion
    rules match iter_paths exactly (.git prune, hidden toggle, layered
    .gitignore applied when entering each directory). skip_files drops
    regular files: used when rg already enumerated the files, so only
    directories and other entry kinds come from the walk.
    """
    if not root.is_dir():
        yield root
        return
    ignore = IgnoreLayers() if respect_gitignore else None
    heap = []  # (path string, path, is_dir, layer snapshot, relative chain)

    def push_children(directory, relative, layers):
        try:
            with os.scandir(str(directory)) as scanner:
                entries = sorted(scanner, key=lambda entry: entry.name)
        except OSError:
            return
        for entry in entries:
            name = entry.name
            if name == '.git' or (name.startswith('.') and not include_hidden):
                continue
            child = relative + [name]
            try:
                is_dir = entry.is_dir(follow_symlinks=False)
            except OSError:
                continue
            if skip_files and not is_dir and entry.is_file(follow_symlinks=False):
                continue
            if ignore is not None and ignore.ignored(child, is_dir):
                continue
            path = Path(entry.path)
            heapq.heappush(heap, (str(path), path, is_dir, layers, child))

    if ignore is not None:
        ignore.enter(root, [])
        push_children(root, [], list(ignore.layers))
    else:
        push_children(root, [], None)
    while heap:
        if budget is not None:
            budget.check_time()
        _, path, is_dir, layers, relative = heapq.heappop(heap)
        yield path
        if is_dir:
            if ignore is not None:
                ignore.layers = list(layers)
                ignore.enter(path, relative)
                push_children(path, relative, list(ignore.layers))
            else:
                push_children(path, relative, None)


def display(service, path):
    """Relative to the workspace root when inside it, otherwise the absolute path (unrestricted scope)."""
    try:
        return str(path.relative_to(service.workspace))
    except ValueError:
        return str(path)


# --- search scanning primitives ---------------------------------------------------

class SkipFile(Exception):
    def __init__(self, reason):
        Exception.__init__(self, reason)
        self.reason = reason  # 'binary' | 'encoding' | 'io'


class BudgetStop(Exception):
    def __init__(self, reason):
        Exception.__init__(self, reason)
        self.reason = reason  # 'bytes' | 'time'


class BackendFailure(Exception):
    pass


class Budget:
    def __init__(self, byte_limit, seconds):
        self.remaining = byte_limit
        self.consumed = 0
        self.deadline = time.monotonic() + seconds

    def check_time(self):
        if time.monotonic() >= self.deadline:
            raise BudgetStop('time')

    def add(self, count):
        """Record read bytes; the overrun check stays with the emitter so a
        budget smaller than one block still makes progress per page."""
        self.consumed += count
        self.remaining -= count

    def ensure_within(self):
        if self.remaining < 0:
            raise BudgetStop('bytes')
        self.check_time()


def require_utf8(data):
    try:
        data.decode('utf8')
    except UnicodeDecodeError:
        raise SkipFile('encoding')


def feed_units(stream, start_byte, start_line, needle_len, budget):
    """Generate (data, unit) pairs of line-aligned chunks from start_byte.

    Unit data always ends with \\n so a backend counts lines the same way the
    helper does. Lines longer than LINE_SOFT_LIMIT are reported as overlapping
    bounded fragments (needle_len - 1 bytes of overlap, so a match crossing a
    fragment edge is never missed). Raises SkipFile/BudgetStop from the reads.
    """
    state = {'file_byte': start_byte, 'file_line': start_line}

    def generate():
        stream.seek(start_byte)
        counter = [1]  # stream-relative line number where the next unit starts
        pending = b''
        pending_start = start_byte
        pending_line = start_line
        long_start = None

        def unit_for(data, file_byte, file_line, long_line, line_start):
            unit = {'stream_line': counter[0], 'file_byte': file_byte, 'file_line': file_line,
                    'long': long_line, 'line_start': line_start}
            counter[0] += data.count(b'\n')
            state['file_byte'] = file_byte + len(data)
            state['file_line'] = file_line + data.count(b'\n')
            return unit

        while True:
            budget.check_time()
            try:
                chunk = stream.read(BLOCK_BYTES)
            except OSError:
                raise SkipFile('io')
            if chunk:
                budget.add(len(chunk))
            if b'\0' in chunk:
                raise SkipFile('binary')
            buffer = pending + chunk
            cut = buffer.rfind(b'\n')
            if cut >= 0:
                data = buffer[:cut + 1]
                require_utf8(data)
                yield (data, unit_for(data, pending_start, pending_line, False, pending_start))
                pending = buffer[cut + 1:]
                pending_start = state['file_byte']
                pending_line = state['file_line']
                long_start = None
            else:
                pending = buffer
                if pending and long_start is None:
                    long_start = pending_start
            if not chunk:
                if pending:
                    # Final unterminated line: report it as one bounded chunk.
                    require_utf8(pending)
                    yield (pending + b'\n', unit_for(pending, pending_start, pending_line, False, pending_start))
                break
            while len(pending) >= BLOCK_BYTES:
                fragment = pending[:BLOCK_BYTES]
                unit = {'stream_line': counter[0], 'file_byte': pending_start,
                        'file_line': pending_line, 'long': True, 'line_start': long_start}
                counter[0] += 1  # the appended \n makes the fragment one stream line
                state['file_byte'] = pending_start + len(fragment)
                state['file_line'] = pending_line
                yield (fragment + b'\n', unit)
                overlap = min(max(needle_len - 1, 0), BLOCK_BYTES - 1)
                pending = pending[len(fragment) - overlap:]
                pending_start = state['file_byte']
            # The overrun check runs after this block is reported, so a page
            # budget smaller than one block still advances the cursor.
            budget.ensure_within()

    return generate(), state


def line_snippet(raw):
    shown = raw[:EXTERNAL_LINE_BYTES].decode('utf8', 'replace')
    truncated = len(raw) > EXTERNAL_LINE_BYTES or len(shown) > SNIPPET_CHARS
    return shown[:SNIPPET_CHARS], truncated


def python_scan(feeder, needle, sink, units, current):
    """Built-in chunked scanner: same units and line semantics as backends."""
    for data, unit in feeder:
        units.append(unit)
        current['unit_index'] = len(units) - 1
        parts = data.split(b'\n')
        if parts and parts[-1] == b'':
            parts.pop()
        for offset, raw in enumerate(parts):
            file_line = unit['file_line'] if unit['long'] else unit['file_line'] + offset
            if needle not in raw:
                continue
            text, truncated = line_snippet(raw)
            if not sink(file_line, text, truncated, current['unit_index']):
                return 'page'
    return None


def external_scan(binary, needle_text, feeder, sink, units, current, budget):
    """Feed line-aligned chunks to rg/grep through stdin and parse "N:line".

    Writes are non-blocking with bounded buffers; reads cap any single backend
    output line so a giant match line cannot grow memory without bound. The
    process exits 0/1 normally; higher codes or signals raise BackendFailure.
    """
    # bytes argv: a C-locale remote (no LANG/LC_* from sshd) runs Python 3.6
    # with an ascii filesystem encoding, and str argv would raise
    # UnicodeEncodeError in Popen for any non-ASCII pattern. The explicit
    # utf8 + surrogateescape round-trips both JSON-sourced text and
    # surrogate-escaped filesystem paths without consulting the locale.
    argv = [binary.encode('utf8', 'surrogateescape'), b'-F', b'-a', b'-n', b'--color=never', b'--',
            needle_text.encode('utf8'), b'-']
    process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, close_fds=True)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    selector.register(process.stderr, selectors.EVENT_READ)
    selector.register(process.stdin, selectors.EVENT_WRITE)
    os.set_blocking(process.stdin.fileno(), False)
    os.set_blocking(process.stdout.fileno(), False)
    os.set_blocking(process.stderr.fileno(), False)
    pending_exception = None
    stop_reason = None
    killed = False
    send = b''
    writing = True
    buffer = b''
    dropping = False
    stderr_tail = b''
    stream_lines = [0]
    drained_deadline = None

    def halt(reason):
        """Stop feeding: drop unwritten bytes, close stdin, keep draining output.

        Output produced after a halt still flows through the sink: when the page
        budget stopped us the sink rejects and records the resume anchor; when a
        scan budget stopped us the page may still accept every drained hit.
        """
        nonlocal stop_reason, writing, send
        stop_reason = reason if reason else stop_reason
        writing = False
        send = b''
        try:
            selector.unregister(process.stdin)
        except (KeyError, ValueError, OSError):
            pass
        try:
            process.stdin.close()
        except OSError:
            pass

    def process_buffer():
        """Parse complete and synthetic lines out of the read buffer.

        Runs after every read and again each loop turn: a synthetic line for an
        oversized output line must flush even when the backend has no more
        bytes to send. `dropping` then discards the original line's tail bytes
        until its real newline.
        """
        nonlocal buffer, dropping, stop_reason
        while True:
            if dropping:
                cut = buffer.find(b'\n')
                if cut < 0:
                    buffer = b''
                    break
                buffer = buffer[cut + 1:]
                dropping = False
                continue
            cut = buffer.find(b'\n')
            if cut >= 0:
                line, buffer = buffer[:cut], buffer[cut + 1:]
            elif len(buffer) > EXTERNAL_LINE_BYTES:
                # Bounded prefix of an unfinished oversized line; the line
                # number lives at its start, so parse the prefix now.
                line = buffer[:EXTERNAL_LINE_BYTES]
                buffer = b''
                dropping = True
            else:
                break
            number, _, text = line.partition(b':')
            if not number.isdigit():
                continue
            position = bisect.bisect_right(stream_lines, int(number)) - 1
            if position <= 0:
                continue
            unit = units[position - 1]
            stream_line = int(number)
            file_line = unit['file_line'] if unit['long'] else \
                unit['file_line'] + (stream_line - unit['stream_line'])
            shown, truncated = line_snippet(text)
            if not sink(file_line, shown, truncated, position - 1):
                if stop_reason is None:
                    stop_reason = 'page'

    try:
        while True:
            if writing and not send and pending_exception is None and stop_reason is None:
                try:
                    data, unit = next(feeder)
                except StopIteration:
                    writing = False
                    try:
                        selector.unregister(process.stdin)
                    except (KeyError, ValueError, OSError):
                        pass
                    try:
                        process.stdin.close()
                    except OSError:
                        pass
                except (SkipFile, BudgetStop) as stop:
                    pending_exception = stop
                    halt(stop.reason if isinstance(stop, BudgetStop) else None)
                else:
                    send = data
                    units.append(unit)
                    stream_lines.append(unit['stream_line'])
            for key, _ in selector.select(0.05):
                try:
                    data = os.read(key.fileobj.fileno(), 65536)
                except (BlockingIOError, OSError):
                    continue
                if not data:
                    selector.unregister(key.fileobj)
                    continue
                if key.fileobj is process.stderr:
                    stderr_tail = (stderr_tail + data)[-4096:]
                    continue
                if dropping:
                    # Oversized-line tail: discard at read level up to its
                    # real newline instead of buffering megabytes.
                    cut = data.find(b'\n')
                    if cut >= 0:
                        buffer = data[cut + 1:]
                        dropping = False
                    continue
                buffer += data
            process_buffer()
            if send:
                try:
                    written = os.write(process.stdin.fileno(), send)
                    send = send[written:]
                except (BlockingIOError, ValueError):
                    pass
                except OSError:
                    writing = False
                    send = b''
                    try:
                        selector.unregister(process.stdin)
                    except (KeyError, ValueError, OSError):
                        pass
                    try:
                        process.stdin.close()
                    except OSError:
                        pass
            now = time.monotonic()
            if writing and now >= budget.deadline:
                halt('time')
            if not writing and selector.get_map():
                if drained_deadline is None:
                    drained_deadline = now + 10.0
                elif now >= drained_deadline:
                    process.kill()
                    killed = True
            if not writing and not selector.get_map() and not send:
                break
    finally:
        selector.close()
        for stream in (process.stdout, process.stderr, process.stdin):
            try:
                stream.close()
            except OSError:
                pass
        try:
            returncode = process.wait(timeout=2.0)
        except subprocess.TimeoutExpired:
            process.kill()
            returncode = process.wait()
    if pending_exception is not None:
        raise pending_exception
    if (returncode > 1 or returncode < 0) and not killed:
        raise BackendFailure(stderr_tail.decode('utf8', 'replace')[-200:])
    if killed and stop_reason is None:
        stop_reason = 'time'
    return stop_reason, killed


# --- search orchestration -----------------------------------------------------------

def optional_bool(request, name, default):
    value = request.get(name, default)
    if not isinstance(value, bool):
        raise AgentError('INVALID_REQUEST', '{} must be boolean'.format(name))
    return value


def bounded_number(request, name, default, minimum, maximum):
    value = request.get(name, default)
    if value is None:
        value = default
    if not isinstance(value, int) or isinstance(value, bool) or not minimum <= value <= maximum:
        raise AgentError('INVALID_LIMIT', '{} must be between {} and {}'.format(name, minimum, maximum))
    return value


def file_version(path):
    try:
        return hashlib.sha256(json.dumps(metadata(path.stat())).encode('utf8')).hexdigest()
    except (OSError, ValueError):
        return None


def serialized_size(items):
    return sum(len(json.dumps(item, ensure_ascii=False).encode('utf8')) for item in items)


def resume_point(units, state, kept_hit, rejected_hit, matches, mark, killed=False):
    """Where the next page restarts inside the current file.

    The anchor is the last produced hit, kept or rejected: rewind to the block
    (or oversized line start) that produced it so nothing accepted-then-
    dropped is lost; kept hits filter duplicates by line number on rescan.
    Without any produced hit, continue at the exact scanned position. After a
    killed drain the scanned position is not trustworthy (output was cut), so
    rewind to the last fed unit instead.
    """
    anchor = kept_hit if kept_hit['line'] else rejected_hit
    if anchor['line']:
        unit = units[anchor['unit_index']]
        if unit['long']:
            rewind = len(matches)
            for position in range(mark, len(matches)):
                if matches[position]['line'] >= unit['file_line']:
                    rewind = position
                    break
            del matches[rewind:]
            return {'byteOffset': unit['line_start'], 'line': unit['file_line'],
                    'lastLine': unit['file_line'] - 1}
        return {'byteOffset': unit['file_byte'], 'line': unit['file_line'],
                'lastLine': kept_hit['line']}
    if killed and units:
        last = units[-1]
        return {'byteOffset': last['file_byte'], 'line': last['file_line'], 'lastLine': 0}
    return {'byteOffset': state['file_byte'], 'line': state['file_line'], 'lastLine': 0}


def encode_cursor(cursor):
    return base64.b64encode(json.dumps(cursor, separators=(',', ':')).encode('utf8')).decode('ascii')


def partial_result(matches, reason, cursor, engine, scanned_files, bytes_scanned, skipped, fallback_files):
    result = {'matches': matches, 'truncated': reason is not None, 'engine': engine,
              'nextCursor': encode_cursor(cursor) if cursor else None,
              'scannedFiles': scanned_files, 'bytesScanned': bytes_scanned,
              'skippedFiles': sum(skipped.values()), 'skippedDetail': skipped,
              'fallbackFiles': fallback_files,
              'ignores': ['.git'], 'gitignoreSupported': True}
    if reason:
        result['reason'] = reason
    return result


def file_search(service, root, request):
    limit = limits(request)
    pattern = request.get('pattern')
    if not isinstance(pattern, str) or not pattern or len(pattern) > 4096 \
            or '\n' in pattern or '\0' in pattern:
        raise AgentError('INVALID_PATTERN', 'Provide a nonempty single-line pattern up to 4096 characters')
    try:
        needle = pattern.encode('utf8')
    except UnicodeEncodeError:
        raise AgentError('INVALID_PATTERN', 'Pattern must be valid UTF-8 text')
    file_pattern = request.get('filePattern', '*')
    if not isinstance(file_pattern, str) or not file_pattern or len(file_pattern) > 4096:
        raise AgentError('INVALID_PATTERN', 'filePattern must be nonempty text up to 4096 characters')
    include_hidden = optional_bool(request, 'includeHidden', True)
    respect_gitignore = optional_bool(request, 'respectGitignore', False)
    budget_bytes = bounded_number(request, 'scanBudgetBytes', DEFAULT_SCAN_BUDGET_BYTES,
                                  64 * 1024, 2 * 1024 * 1024 * 1024)
    budget_seconds = bounded_number(request, 'scanBudgetSeconds', DEFAULT_SCAN_BUDGET_SECONDS, 1, 60)
    if any(part == '.git' for part in root.parts):
        raise AgentError('PATH_NOT_ALLOWED', 'The .git directory is always excluded from search')

    files = [path for path in iter_paths(root, True, include_hidden, respect_gitignore)
             if not path.is_symlink() and path.is_file()
             and fnmatch.fnmatch(path.name, file_pattern)]
    listing_digest = hashlib.sha256(
        json.dumps([str(path) for path in files]).encode('utf8')).hexdigest()
    binding = [str(service.workspace), service.session, str(root), 'file_search', pattern,
               file_pattern, include_hidden, respect_gitignore, budget_bytes, budget_seconds,
               listing_digest]
    query = hashlib.sha256(json.dumps(binding, sort_keys=True).encode('utf8')).hexdigest()

    start_index, resume = 0, None
    incoming = request.get('cursor')
    if incoming:
        try:
            cursor = json.loads(base64.b64decode(incoming, validate=True).decode('utf8'))
            if cursor.get('v') != 1 or cursor.get('query') != query:
                raise ValueError()
            start_index = cursor['next']
            resume = cursor.get('resume')
            if not isinstance(start_index, int) or isinstance(start_index, bool) \
                    or not 0 <= start_index <= len(files):
                raise ValueError()
            if resume is not None and (not isinstance(resume, dict) or start_index >= len(files)
                                        or str(files[start_index]) != resume.get('path')):
                raise ValueError()
        except (ValueError, KeyError, TypeError):
            raise AgentError('STALE_CURSOR', 'Query or directory changed; restart the search')
        if resume is not None and file_version(files[start_index]) != resume.get('version'):
            raise AgentError('CURSOR_CONFLICT', 'The file changed while paging; restart the search')

    primary = available_search_backends()
    primary_name = primary[0][0] if primary else None
    primary_binary = primary[0][1] if primary else None
    budget = Budget(budget_bytes, budget_seconds)
    matches = []
    page = {'output': 0}
    skipped = {'binary': 0, 'encoding': 0, 'io': 0}
    counters = {'scanned': 0, 'fallback': 0, 'backend_failures': 0, 'external_used': 0}

    def make_sink(path, last_line):
        kept = {'unit_index': None, 'line': 0}
        rejected = {'unit_index': None, 'line': 0}

        def sink(file_line, text, truncated, unit_index):
            if file_line <= last_line:
                return True
            item = {'path': display(service, path), 'line': file_line,
                    'text': text[:SNIPPET_CHARS], 'lineTruncated': bool(truncated)}
            size = len(json.dumps(item, ensure_ascii=False).encode('utf8'))
            if len(matches) >= limit or page['output'] + size > PAGE_OUTPUT_BYTES:
                rejected.update(unit_index=unit_index, line=file_line)
                return False
            matches.append(item)
            page['output'] += size
            kept.update(unit_index=unit_index, line=file_line)
            return True
        return sink, kept, rejected

    def run_python_scan(path, start_byte, start_line, last_line):
        """In-process scan used for small files and after a backend failure.

        Returns {'outcome','reason','units','kept','rejected','state'}.
        """
        current = {'unit_index': None}
        sink, kept, rejected = make_sink(path, last_line)
        units = []
        empty_state = {'file_byte': start_byte, 'file_line': start_line}
        try:
            stream = path.open('rb')
        except OSError:
            return {'outcome': 'skip', 'reason': 'io', 'units': units,
                    'kept': kept, 'rejected': rejected, 'state': empty_state}
        try:
            feeder, state = feed_units(stream, start_byte, start_line, len(needle), budget)
            try:
                outcome = python_scan(feeder, needle, sink, units, current)
            except SkipFile as skip:
                return {'outcome': 'skip', 'reason': skip.reason, 'units': units,
                        'kept': kept, 'rejected': rejected, 'state': state}
            except BudgetStop as stop:
                return {'outcome': stop.reason, 'reason': None, 'units': units,
                        'kept': kept, 'rejected': rejected, 'state': state}
            return {'outcome': outcome, 'reason': None, 'units': units,
                    'kept': kept, 'rejected': rejected, 'state': state}
        finally:
            stream.close()

    def attempt(path, start_byte, start_line, last_line):
        """One file scan with the preferred backend; never raises scan errors."""
        current = {'unit_index': None}
        sink, kept, rejected = make_sink(path, last_line)
        units = []
        empty_state = {'file_byte': start_byte, 'file_line': start_line}
        try:
            size = path.stat().st_size
        except OSError:
            return {'outcome': 'skip', 'reason': 'io', 'units': units,
                    'kept': kept, 'rejected': rejected, 'state': empty_state}
        use_external = primary_binary is not None and size >= EXTERNAL_THRESHOLD_BYTES \
            and counters['backend_failures'] < MAX_BACKEND_FAILURES
        try:
            stream = path.open('rb')
        except OSError:
            return {'outcome': 'skip', 'reason': 'io', 'units': units,
                    'kept': kept, 'rejected': rejected, 'state': empty_state}
        try:
            feeder, state = feed_units(stream, start_byte, start_line, len(needle), budget)
            if use_external:
                try:
                    outcome, killed = external_scan(primary_binary, pattern, feeder, sink, units, current, budget)
                except BackendFailure as failure:
                    # A crashed backend must not look like "no matches": the
                    # caller drops this file's partial hits and rescans in-process.
                    return {'outcome': 'backend', 'reason': str(failure), 'units': units,
                            'kept': kept, 'rejected': rejected, 'state': state}
                counters['external_used'] += 1
                return {'outcome': outcome, 'reason': None, 'units': units,
                        'kept': kept, 'rejected': rejected, 'state': state, 'killed': killed}
            outcome = python_scan(feeder, needle, sink, units, current)
            return {'outcome': outcome, 'reason': None, 'units': units,
                    'kept': kept, 'rejected': rejected, 'state': state}
        except SkipFile as skip:
            return {'outcome': 'skip', 'reason': skip.reason, 'units': units,
                    'kept': kept, 'rejected': rejected, 'state': state}
        except BudgetStop as stop:
            return {'outcome': stop.reason, 'reason': None, 'units': units,
                    'kept': kept, 'rejected': rejected, 'state': state}
        finally:
            stream.close()

    index = start_index
    while index < len(files):
        path = files[index]
        if resume is not None:
            start_byte, start_line, last_line = resume['byteOffset'], resume['line'], resume['lastLine']
        else:
            start_byte, start_line, last_line = 0, 1, 0
        mark = len(matches)
        result = attempt(path, start_byte, start_line, last_line)
        if result['outcome'] == 'backend':
            counters['fallback'] += 1
            counters['backend_failures'] += 1
            del matches[mark:]
            page['output'] = serialized_size(matches)
            result = run_python_scan(path, start_byte, start_line, last_line)
        if result['outcome'] == 'skip':
            del matches[mark:]
            page['output'] = serialized_size(matches)
            skipped[result['reason']] = skipped.get(result['reason'], 0) + 1
            index += 1
            resume = None
            continue
        if result['outcome'] is None:
            counters['scanned'] += 1
            index += 1
            resume = None
            continue
        position = resume_point(result['units'], result['state'], result['kept'], result['rejected'],
                                matches, mark, result.get('killed', False))
        cursor = {'v': 1, 'query': query, 'next': index,
                  'resume': dict(position, path=str(path), version=file_version(path))}
        reason = {'page': 'RESULT_LIMIT', 'bytes': 'SCAN_BYTE_LIMIT',
                  'time': 'SCAN_TIME_LIMIT'}[result['outcome']]
        return partial_result(matches, reason, cursor,
                              primary_name if primary_name and counters['external_used'] > 0 else 'python-literal',
                              counters['scanned'], budget.consumed, skipped, counters['fallback'])
    return partial_result(matches, None, None,
                          primary_name if primary_name and counters['external_used'] > 0 else 'python-literal',
                          counters['scanned'], budget.consumed, skipped, counters['fallback'])


# --- filename find (issue #12) -----------------------------------------------------

def rg_list(binary, root, budget):
    """Enumerate files through `rg --files` with rg's implicit filtering off.

    The argv list passes the root as one argument (never shell text) and asks
    for NUL-separated output; --hidden and --no-ignore neutralize rg's own
    hidden/gitignore defaults so the common filter stays the only authority.
    Output is drained incrementally with the scan budget as the deadline and
    the candidate cap as the memory bound. Returns the sorted list of absolute
    Path objects. Raises BackendFailure on abnormal exits; BudgetStop and the
    candidate-cap error propagate to the caller.
    """
    # bytes argv for the same C-locale reason as external_scan: the root may
    # carry non-ASCII text (Chinese workspace paths) or surrogate escapes.
    argv = [binary.encode('utf8', 'surrogateescape'), b'--files', b'--hidden', b'--no-ignore',
            b'--no-messages', b'-0', b'--', str(root).encode('utf8', 'surrogateescape')]
    process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, close_fds=True)
    chunks = []
    tail = b''
    found = 0
    exceeded = False
    selector = selectors.DefaultSelector()
    try:
        selector.register(process.stdout, selectors.EVENT_READ)
        os.set_blocking(process.stdout.fileno(), False)
        while selector.get_map():
            budget.check_time()
            for key, _ in selector.select(0.05):
                try:
                    data = os.read(key.fileobj.fileno(), 65536)
                except (BlockingIOError, OSError):
                    continue
                if not data:
                    selector.unregister(key.fileobj)
                    continue
                tail += data
                cut = tail.rfind(b'\0')
                if cut >= 0:
                    complete, tail = tail[:cut], tail[cut + 1:]
                    found += complete.count(b'\0') + 1
                    chunks.append(complete)
            if found > MAX_CANDIDATES:
                exceeded = True
                break
        if not exceeded and tail:
            chunks.append(tail)
    finally:
        selector.close()
        if process.poll() is None:
            process.kill()
        try:
            process.stdout.close()
        except OSError:
            pass
        returncode = process.wait()
    if exceeded:
        raise AgentError('SCAN_LIMIT', 'More than {} entries; narrow the search directory'.format(MAX_CANDIDATES))
    if returncode > 1 or returncode < 0:
        raise BackendFailure('rg --files exited with {}'.format(returncode))
    lines = [line for line in (b'\0'.join(chunks).split(b'\0') if chunks else []) if line]
    return sorted((Path(line.decode('utf8', 'surrogateescape')) for line in lines), key=str)


def filter_rg_lines(root, lines, include_hidden, respect_gitignore):
    """Apply the shared candidate filter to sorted `rg --files` paths.

    rg enumerated with its implicit filtering disabled, so hidden and ignored
    entries arrive here; the same rules as iter_paths decide: any .git
    segment drops the path, dot-prefixed segments drop it without hidden
    files, and layered .gitignore state advances along the sorted directory
    chains (a file under an ignored directory stays excluded, a deeper
    .gitignore can negate a shallower rule).
    """
    kept = []
    ignore = IgnoreLayers() if respect_gitignore else None
    stack = []  # directory names whose ignore layers are currently loaded
    if ignore is not None:
        ignore.enter(root, [])
    for line in lines:
        try:
            parts = line.relative_to(root).parts
        except ValueError:
            continue
        if any(part == '.git' for part in parts):
            continue
        if not include_hidden and any(part.startswith('.') for part in parts):
            continue
        if ignore is not None:
            directories = parts[:-1]
            common = 0
            while common < len(stack) and common < len(directories) \
                    and stack[common] == directories[common]:
                common += 1
            del stack[common:]
            ignore.layers = ignore.layers[:common + 1]
            excluded = False
            for depth in range(common, len(directories)):
                chain = directories[:depth + 1]
                if ignore.ignored(chain, True):
                    excluded = True
                    break
                ignore.enter(root.joinpath(*chain), chain)
                stack.append(directories[depth])
            if excluded or ignore.ignored(parts, False):
                continue
        kept.append(line)
    return kept


def dedupe_merge(first, second):
    """Merge two str-sorted path iterables, dropping adjacent duplicates."""
    previous = None
    for path in heapq.merge(first, second, key=str):
        current = str(path)
        if current == previous:
            continue
        previous = current
        yield path


def file_find(service, root, request):
    """Filename lookup with backend selection, shared filters and budgets.

    Enumeration runs rg --files for the file entries plus a Python skeleton
    walk for directories and other entry kinds, or a plain Python walk when
    rg is unavailable or fails; grep is never used for filename enumeration.
    Both routes feed one globally sorted, filtered stream, so the glob
    contract (basename or relative-path matching, entry shape) never depends
    on which backends exist. Pages reuse the search budget machinery: limit
    plus the 64 KiB page cap, byte budget charged by the path bytes of each
    candidate newly considered this page, time budget bounding enumeration;
    partial pages carry a reason and a cursor that resumes after the last
    considered candidate without rescanning returned entries.
    """
    limit = limits(request)
    pattern = request.get('pattern', '*')
    if not isinstance(pattern, str) or not pattern or len(pattern) > 4096:
        raise AgentError('INVALID_PATTERN', 'Provide a nonempty pattern up to 4096 characters')
    include_hidden = optional_bool(request, 'includeHidden', True)
    respect_gitignore = optional_bool(request, 'respectGitignore', False)
    budget_bytes = bounded_number(request, 'scanBudgetBytes', DEFAULT_SCAN_BUDGET_BYTES,
                                  64 * 1024, 2 * 1024 * 1024 * 1024)
    budget_seconds = bounded_number(request, 'scanBudgetSeconds', DEFAULT_SCAN_BUDGET_SECONDS, 1, 60)
    if any(part == '.git' for part in root.parts):
        raise AgentError('PATH_NOT_ALLOWED', 'The .git directory is always excluded from search')

    binding = [str(service.workspace), service.session, str(root), 'file_find', pattern,
               include_hidden, respect_gitignore, budget_bytes, budget_seconds]
    query = hashlib.sha256(json.dumps(binding, sort_keys=True).encode('utf8')).hexdigest()
    after = None
    incoming = request.get('cursor')
    if incoming:
        try:
            cursor = json.loads(base64.b64decode(incoming, validate=True).decode('utf8'))
            if cursor.get('v') != 2 or cursor.get('q') != query:
                raise ValueError()
            after = cursor.get('after')
            if after is not None and not isinstance(after, str):
                raise ValueError()
        except (ValueError, KeyError, TypeError):
            raise AgentError('STALE_CURSOR', 'Query or directory changed; restart the search')

    budget = Budget(budget_bytes, budget_seconds)
    rg_binary = shutil.which('rg')
    stream = None
    engine = 'python-walk'
    if rg_binary is not None:
        try:
            files = filter_rg_lines(root, rg_list(rg_binary, root, budget),
                                    include_hidden, respect_gitignore)
        except BudgetStop:
            # rg --files enumeration is eager and shares the page's time
            # budget: exhausting it before any candidate was considered is a
            # normal budget stop (empty partial page, cursor unchanged from
            # the request), not a helper error. It must not reach the
            # BackendFailure fallback either -- a timeout is not a crash.
            return {'entries': [], 'nextCursor': encode_cursor({'v': 2, 'q': query, 'after': after}),
                    'truncated': True, 'totalEntries': None, 'engine': 'ripgrep-files',
                    'reason': 'SCAN_TIME_LIMIT'}
        except (BackendFailure, OSError):
            # A crashed or unspawnable rg must not look like an empty tree:
            # fall back to the plain Python walk for this page.
            stream = None
        else:
            skeleton = stream_paths(root, include_hidden, respect_gitignore,
                                    skip_files=True, budget=budget)
            stream = dedupe_merge(files, skeleton)
            engine = 'ripgrep-files'
    if stream is None:
        stream = stream_paths(root, include_hidden, respect_gitignore, budget=budget)

    entries = []
    page_bytes = 0
    yielded = 0
    matched_total = 0
    exhausted = False
    reason = None
    last = after
    try:
        for path in stream:
            yielded += 1
            if yielded > MAX_CANDIDATES:
                raise AgentError('SCAN_LIMIT',
                                 'More than {} entries; narrow the search directory'.format(MAX_CANDIDATES))
            current = str(path)
            relative = display(service, path)
            matched = fnmatch.fnmatch(path.name, pattern) or fnmatch.fnmatch(relative, pattern)
            if matched:
                matched_total += 1
            if after is not None and current <= after:
                continue
            # Candidates considered this page charge the enumeration budget by
            # their path bytes; the overrun check runs after each charge so a
            # budget smaller than the tree still advances the cursor. Entries
            # already returned by earlier pages skip without recharging. The
            # cursor moves past a fully considered candidate *before* the
            # overrun check, so a stop right after admitting (or charging) it
            # cannot hand back a cursor that re-serves it; an unadmitted
            # candidate (RESULT_LIMIT) keeps the previous cursor so the next
            # page reconsiders it.
            budget.add(len(current.encode('utf8')))
            if not matched:
                last = current
                budget.ensure_within()
                continue
            try:
                info = path.lstat()
            except OSError:
                # The entry vanished between enumeration and this stat: it
                # can no longer appear, so advance the cursor past it and
                # skip it -- consistent with file_search's silent exclusion.
                last = current
                continue
            kind = 'symlink' if stat.S_ISLNK(info.st_mode) else \
                'directory' if stat.S_ISDIR(info.st_mode) else \
                'file' if stat.S_ISREG(info.st_mode) else 'other'
            item = {'path': relative, 'type': kind, 'size': info.st_size}
            size = len(json.dumps(item, ensure_ascii=False).encode('utf8'))
            if len(entries) >= limit or page_bytes + size > PAGE_OUTPUT_BYTES:
                reason = 'RESULT_LIMIT'
                break
            entries.append(item)
            page_bytes += size
            last = current
            budget.ensure_within()
        else:
            exhausted = True
    except BudgetStop as stop:
        # A continuation page that spent its whole budget skipping already
        # returned candidates would hand back the request cursor unchanged:
        # every retry re-enumerates and times out the same way, so the query
        # could never finish. Fail explicitly instead. First pages (no
        # cursor) keep the plain partial semantics.
        if last == after and after is not None:
            raise AgentError('SCAN_TIME_LIMIT',
                             'Time budget exhausted before advancing past already returned '
                             'entries; narrow the search directory')
        reason = {'bytes': 'SCAN_BYTE_LIMIT', 'time': 'SCAN_TIME_LIMIT'}[stop.reason]
    # A stop always leaves a continuable cursor: `after` anchors the resume
    # point (None restarts the enumeration, e.g. a time stop before any
    # admission); only a naturally exhausted stream has no next page.
    cursor = encode_cursor({'v': 2, 'q': query, 'after': last}) if not exhausted else None
    result = {'entries': entries, 'nextCursor': cursor, 'truncated': cursor is not None,
              'totalEntries': matched_total if exhausted else None, 'engine': engine}
    if reason:
        result['reason'] = reason
    return result


def discover(service, action, request):
    root = service.path(request.get('path', '.'))
    if not root.exists():
        raise AgentError('PATH_NOT_FOUND', 'Search path does not exist')
    if action == 'file_search':
        return file_search(service, root, request)
    if action == 'file_find':
        return file_find(service, root, request)
    limit = limits(request)
    pattern = request.get('pattern', '*')
    if not isinstance(pattern, str) or not pattern or len(pattern) > 4096:
        raise AgentError('INVALID_PATTERN', 'Provide a nonempty pattern up to 4096 characters')
    paths = candidates(service, root, False)
    entries = []
    for path in paths:
        relative = display(service, path)
        info = path.lstat()
        kind = 'symlink' if stat.S_ISLNK(info.st_mode) else 'directory' if stat.S_ISDIR(info.st_mode) else 'file' if stat.S_ISREG(info.st_mode) else 'other'
        entries.append({'path': relative, 'type': kind, 'size': info.st_size})
    binding = [str(service.workspace), service.session, str(root), action, pattern, entries]
    digest = hashlib.sha256(json.dumps(binding, sort_keys=True).encode('utf8')).hexdigest()
    offset = 0
    if request.get('cursor'):
        try:
            cursor = json.loads(base64.b64decode(request['cursor'], validate=True).decode('utf8'))
            offset = cursor['offset']
            if cursor['digest'] != digest or not isinstance(offset, int) or not 0 <= offset <= len(entries):
                raise ValueError()
        except (ValueError, KeyError, TypeError):
            raise AgentError('STALE_CURSOR', 'Directory or query changed; restart listing')
    page, byte_count = [], 0
    for item in entries[offset:offset + limit]:
        count = len(json.dumps(item, ensure_ascii=False).encode('utf8'))
        if byte_count + count > PAGE_OUTPUT_BYTES:
            break
        page.append(item)
        byte_count += count
    end = offset + len(page)
    cursor = base64.b64encode(json.dumps({'digest': digest, 'offset': end}).encode()).decode() if end < len(entries) else None
    return {'entries': page, 'nextCursor': cursor, 'truncated': cursor is not None, 'totalEntries': len(entries)}
