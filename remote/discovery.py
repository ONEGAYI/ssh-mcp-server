"""Bounded stdlib discovery. Literal search deliberately does not emulate ripgrep."""
import base64
import fnmatch
import hashlib
import json
import os
from pathlib import Path
import stat
from common import AgentError


def limits(request):
    limit = request.get('limit', 100)
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 1000:
        raise AgentError('INVALID_LIMIT', 'limit must be between 1 and 1000')
    return limit


def candidates(service, root, recursive):
    if not root.is_dir():
        return [root]
    result = []
    for current, directories, files in os.walk(str(root), followlinks=False):
        directories[:] = sorted(name for name in directories if name != '.git')
        for name in sorted(directories + files):
            result.append(Path(current) / name)
            if len(result) > 50000:
                raise AgentError('SCAN_LIMIT', 'More than 50000 entries; narrow the search directory')
        if not recursive:
            break
    return sorted(result, key=str)


def discover(service, action, request):
    root = service.path(request.get('path', '.'))
    if not root.exists():
        raise AgentError('PATH_NOT_FOUND', 'Search path does not exist')
    limit = limits(request)
    pattern = request.get('pattern', '*')
    if not isinstance(pattern, str) or not pattern or len(pattern) > 4096:
        raise AgentError('INVALID_PATTERN', 'Provide a nonempty pattern up to 4096 characters')
    paths = candidates(service, root, action != 'file_list')
    if action == 'file_search':
        matches, skipped, scanned, bytes_scanned = [], 0, 0, 0
        output_bytes = 0
        for path in paths:
            if path.is_symlink() or not path.is_file():
                continue
            if not fnmatch.fnmatch(path.name, request.get('filePattern', '*')):
                continue
            size = path.stat().st_size
            if size > 16 * 1024 * 1024:
                skipped += 1
                continue
            if bytes_scanned + size > 64 * 1024 * 1024:
                return {'matches': matches, 'truncated': True, 'reason': 'SCAN_BYTE_LIMIT',
                        'engine': 'python-literal', 'skippedFiles': skipped, 'scannedFiles': scanned}
            # Bound the actual read too: another writer can grow a file after stat.
            with path.open('rb') as stream:
                data = stream.read(min(16 * 1024 * 1024, 64 * 1024 * 1024 - bytes_scanned) + 1)
            if len(data) > 16 * 1024 * 1024 or bytes_scanned + len(data) > 64 * 1024 * 1024:
                skipped += 1
                continue
            bytes_scanned += len(data)
            try:
                text = data.decode('utf-8-sig')
            except UnicodeDecodeError:
                skipped += 1
                continue
            if '\0' in text:
                skipped += 1
                continue
            scanned += 1
            for number, line in enumerate(text.splitlines(), 1):
                if pattern not in line:
                    continue
                item = {'path': str(path.relative_to(service.workspace)), 'line': number,
                        'text': line[:2000], 'lineTruncated': len(line) > 2000}
                item_bytes = len(json.dumps(item, ensure_ascii=False).encode('utf8'))
                if len(matches) == limit or output_bytes + item_bytes > 65536:
                    return {'matches': matches, 'truncated': True, 'reason': 'RESULT_LIMIT',
                            'engine': 'python-literal', 'skippedFiles': skipped, 'scannedFiles': scanned}
                matches.append(item)
                output_bytes += item_bytes
        return {'matches': matches, 'truncated': False, 'engine': 'python-literal',
                'skippedFiles': skipped, 'scannedFiles': scanned, 'ignores': ['.git'], 'gitignoreSupported': False}
    entries = []
    for path in paths:
        relative = str(path.relative_to(service.workspace))
        if action == 'file_find' and not (fnmatch.fnmatch(path.name, pattern) or fnmatch.fnmatch(relative, pattern)):
            continue
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
        if byte_count + count > 65536:
            break
        page.append(item)
        byte_count += count
    end = offset + len(page)
    cursor = base64.b64encode(json.dumps({'digest': digest, 'offset': end}).encode()).decode() if end < len(entries) else None
    return {'entries': page, 'nextCursor': cursor, 'truncated': cursor is not None, 'totalEntries': len(entries)}
