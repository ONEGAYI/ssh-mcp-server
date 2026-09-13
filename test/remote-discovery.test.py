"""Behavior tests for issue #11: multi-backend content search with resumable pagination.

Runs the real helper CLI (remote/agent.py) like remote-files.test.py. Fake
ripgrep/grep executables are generated at runtime into tmpdir directories and
selected through PATH, so backend availability, preference order and crash
fallback are all exercised without installing anything.
"""
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


HELPER = Path(__file__).resolve().parents[1] / 'remote' / 'agent.py'
NEEDLE = 'NEEDLE-7f3a-中文'

# A drop-in stand-in for ripgrep/grep supporting exactly the flags the helper
# uses: literal fixed-string, case-sensitive, binary-as-text, line numbers on
# stdin, output "N:line" per matching line. Honors two test env vars:
# SSH_MCP_FAKE_BACKEND_LOG (append argv per invocation) and
# SSH_MCP_FAKE_BACKEND_CRASH (exit 3 before doing any work).
FAKE_BACKEND = """#!/usr/bin/env python3
import os
import sys

args = sys.argv[1:]
if os.environ.get('SSH_MCP_FAKE_BACKEND_CRASH'):
    sys.stderr.write('fake backend crash on demand')
    sys.exit(3)
log = os.environ.get('SSH_MCP_FAKE_BACKEND_LOG')
if log:
    with open(log, 'a') as stream:
        stream.write(os.path.basename(sys.argv[0]) + ' ' + ' '.join(args) + chr(10))
if '--' in args:
    rest = args[args.index('--') + 1:]
else:
    rest = args
pattern = rest[0].encode('utf8', 'surrogateescape') if rest else b''
data = sys.stdin.buffer.read()
lines = data.split(b'\\n')
if lines and lines[-1] == b'':
    lines.pop()
matched = []
for number, line in enumerate(lines, 1):
    if pattern and pattern in line:
        matched.append(('%d:' % number).encode('ascii') + line)
if matched:
    sys.stdout.buffer.write(b'\\n'.join(matched) + b'\\n')
"""


def make_backend_dir(root, names):
    directory = Path(tempfile.mkdtemp(prefix='ssh-mcp backends ', dir=str(root)))
    for name in names:
        script = directory / name
        script.write_text(FAKE_BACKEND)
        script.chmod(0o755)
    return directory


class RemoteDiscoveryTest(unittest.TestCase):
    def setUp(self):
        self.fixture = tempfile.TemporaryDirectory(prefix='ssh-mcp discovery ')
        self.root = Path(self.fixture.name)
        self.work = self.root / 'work'
        self.work.mkdir()
        self.bin_rg_and_grep = make_backend_dir(self.root, ['rg', 'grep'])
        self.bin_grep_only = make_backend_dir(self.root, ['grep'])
        self.bin_empty = make_backend_dir(self.root, [])

    def tearDown(self):
        self.fixture.cleanup()

    def call(self, action, request, backends='system', session='session-one', timeout=30):
        """backends: 'system' uses the ambient PATH; otherwise a controlled bin dir."""
        env = dict(os.environ)
        if backends == 'rg+grep':
            env['PATH'] = str(self.bin_rg_and_grep)
        elif backends == 'grep':
            env['PATH'] = str(self.bin_grep_only)
        elif backends == 'none':
            env['PATH'] = str(self.bin_empty)
        data = dict(request, workspaceRoot=str(self.work), sessionId=session)
        run = subprocess.run([sys.executable, str(HELPER), '--root', str(self.root / 'state'), action],
                             input=json.dumps(data), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             universal_newlines=True, timeout=timeout, env=env)
        self.assertEqual(run.returncode, 0, run.stderr)
        return json.loads(base64.b64decode(run.stdout.split(' ', 1)[1]))

    def call_env(self, action, request, env, timeout=30):
        data = dict(request, workspaceRoot=str(self.work), sessionId='session-one')
        run = subprocess.run([sys.executable, str(HELPER), '--root', str(self.root / 'state'), action],
                             input=json.dumps(data), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             universal_newlines=True, timeout=timeout, env=env)
        self.assertEqual(run.returncode, 0, run.stderr)
        return json.loads(base64.b64decode(run.stdout.split(' ', 1)[1]))

    # --- helpers -------------------------------------------------------------

    def write(self, relative, content):
        target = self.work / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, str):
            content = content.encode('utf8')
        target.write_bytes(content)
        return target

    def hits(self, result):
        return [(match['path'], match['line']) for match in result['matches']]

    def big_file(self, relative, total_bytes, needle_lines):
        """Deterministic line-numbered filler; needle_lines = set of line numbers to hit."""
        path = self.work / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        number, written = 0, 0
        with open(str(path), 'w', encoding='utf8') as stream:
            while written < total_bytes:
                number += 1
                if number in needle_lines:
                    line = 'entry {:09d} contains {} payload'.format(number, NEEDLE)
                else:
                    line = 'entry {:09d} padding-padding-padding-padding'.format(number)
                stream.write(line + '\n')
                written += len(line.encode('utf8')) + 1
        return path

    # --- backend selection and engine reporting ------------------------------

    def test_backend_preference_is_rg_over_grep_over_python_and_engine_reports_actual_use(self):
        self.write('small.txt', 'tiny needle-free line\n')
        self.big_file('large.log', 2 * 1024 * 1024, {5})
        for backends, engine in [('rg+grep', 'ripgrep'), ('grep', 'gnu-grep'), ('none', 'python-literal')]:
            result = self.call('file_search', {'path': '.', 'pattern': NEEDLE}, backends=backends)
            self.assertTrue(result['ok'], (backends, result))
            self.assertEqual(result['result']['engine'], engine)
            self.assertEqual(self.hits(result['result']), [('large.log', 5)])
        # Small-file-only pages never spawn an external backend, so the engine
        # reports the built-in scan even when rg is available.
        small = self.call('file_search', {'path': 'small.txt', 'pattern': 'needle'}, backends='rg+grep')['result']
        self.assertEqual(small['engine'], 'python-literal')

    def test_preferred_backend_is_actually_invoked(self):
        self.big_file('large.log', 2 * 1024 * 1024, {5})
        log = self.root / 'backend-calls.log'
        env = dict(os.environ)
        env['PATH'] = str(self.bin_rg_and_grep)
        env['SSH_MCP_FAKE_BACKEND_LOG'] = str(log)
        self.call_env('file_search', {'path': 'large.log', 'pattern': NEEDLE}, env)
        content = log.read_text()
        self.assertTrue(content.startswith('rg '), content)
        self.assertNotIn('\ngrep ', content)
        self.assertIn(NEEDLE, content)

        log_grep = self.root / 'grep-calls.log'
        env_grep = dict(os.environ)
        env_grep['PATH'] = str(self.bin_grep_only)
        env_grep['SSH_MCP_FAKE_BACKEND_LOG'] = str(log_grep)
        self.call_env('file_search', {'path': 'large.log', 'pattern': NEEDLE}, env_grep)
        self.assertTrue(log_grep.read_text().startswith('grep '))

    def test_results_are_identical_across_backends_including_real_ones(self):
        self.write('plain.txt', 'alpha\n{} middle\nomega\n'.format(NEEDLE))
        self.write('.hidden.txt', 'hidden {}\n'.format(NEEDLE))
        self.write('crlf.txt', 'line\r\n{} with crlf\r\n'.format(NEEDLE))
        self.write('utf8-deep.txt', '中文首行\n第二{}行\n'.format(NEEDLE))
        self.write('skipped.bin', b'\x00binary\x00{}\x00'.format(NEEDLE.encode('utf8')))
        self.write('invalid.utf8', b'ok line\n{} \xff\xfe broken\n'.format(NEEDLE.encode('utf8')))
        # A multi-megabyte file forces the external-backend path.
        self.big_file('large.log', 3 * 1024 * 1024, {7, 31234})
        request = {'path': '.', 'pattern': NEEDLE, 'limit': 1000}
        results = []
        for backends in ('rg+grep', 'grep', 'none', 'system'):
            result = self.call('file_search', request, backends=backends)
            self.assertTrue(result['ok'], (backends, result))
            results.append(result['result'])
            self.assertEqual(result['result']['skippedFiles'], 2, backends)
        for other in results[1:]:
            self.assertEqual(results[0]['matches'], other['matches'])
        expected = {('plain.txt', 2), ('.hidden.txt', 1), ('crlf.txt', 2), ('utf8-deep.txt', 2),
                    ('large.log', 7), ('large.log', 31234)}
        self.assertEqual(set(self.hits(results[0])), expected)
        text = [match['text'] for match in results[0]['matches'] if match['path'] == 'plain.txt']
        self.assertEqual(text, ['{} middle'.format(NEEDLE)])

    def test_backend_crash_falls_back_without_losing_matches_or_faking_no_match(self):
        self.big_file('large.log', 2 * 1024 * 1024, {3, 9999})
        env = dict(os.environ)
        env['PATH'] = str(self.bin_rg_and_grep)
        env['SSH_MCP_FAKE_BACKEND_CRASH'] = '1'
        result = self.call_env('file_search', {'path': 'large.log', 'pattern': NEEDLE}, env)['result']
        # Matches survive through the built-in fallback; the crash is visible in
        # the counters instead of being reported as "no matches".
        self.assertEqual(self.hits(result), [('large.log', 3), ('large.log', 9999)])
        self.assertGreaterEqual(result['fallbackFiles'], 1)
        self.assertFalse(result['truncated'])
        self.assertEqual(result['engine'], 'python-literal')
        baseline = self.call('file_search', {'path': 'large.log', 'pattern': NEEDLE}, backends='none')['result']
        self.assertEqual(result['matches'], baseline['matches'])

    # --- pagination and cursors ------------------------------------------------

    def test_pagination_returns_all_hits_in_order_without_rescanning_finished_files(self):
        # a.log is a large hit-free file: if later pages rescanned it, their
        # byte counts would include its size again.
        self.big_file('a.log', 1536 * 1024, set())
        self.write('b.txt', 'first {}\nsecond {}\n'.format(NEEDLE, NEEDLE))
        self.write('c.txt', 'c {} one\nc {} two\n'.format(NEEDLE, NEEDLE))
        collected, cursor, pages, byte_counts = [], None, 0, []
        while True:
            request = {'path': '.', 'pattern': NEEDLE, 'limit': 1}
            if cursor:
                request['cursor'] = cursor
            result = self.call('file_search', request)['result']
            collected.extend(self.hits(result))
            byte_counts.append(result['bytesScanned'])
            pages += 1
            self.assertLessEqual(pages, 8)
            cursor = result.get('nextCursor')
            if not cursor:
                self.assertFalse(result['truncated'])
                break
            self.assertTrue(result['truncated'])
        self.assertEqual(collected, [('b.txt', 1), ('b.txt', 2), ('c.txt', 1), ('c.txt', 2)])
        # Page 1 must actually read a.log; later pages must not rescan it.
        self.assertGreaterEqual(byte_counts[0], 1536 * 1024)
        for count in byte_counts[1:]:
            self.assertLess(count, 64 * 1024, byte_counts)

    def test_budget_exhaustion_reports_partial_with_resumable_cursor(self):
        self.big_file('large.log', 4 * 1024 * 1024, {3, 30000})
        first = self.call('file_search', {'path': 'large.log', 'pattern': NEEDLE,
                                          'scanBudgetBytes': 64 * 1024})['result']
        self.assertTrue(first['truncated'])
        self.assertEqual(first['reason'], 'SCAN_BYTE_LIMIT')
        self.assertIsNotNone(first['nextCursor'])
        collected, cursor, pages = list(self.hits(first)), first['nextCursor'], 1
        while cursor:
            result = self.call('file_search', {'path': 'large.log', 'pattern': NEEDLE,
                                               'scanBudgetBytes': 1024 * 1024,
                                               'cursor': cursor})['result']
            collected.extend(self.hits(result))
            pages += 1
            self.assertLessEqual(pages, 30)
            cursor = result.get('nextCursor')
        self.assertEqual(collected, [('large.log', 3), ('large.log', 30000)])

    def test_cursor_rejects_changed_query_directory_and_changed_file(self):
        self.write('a.txt', 'x {} x\n'.format(NEEDLE))
        self.write('b.txt', 'y {} y\n'.format(NEEDLE))
        first = self.call('file_search', {'path': '.', 'pattern': NEEDLE, 'limit': 1})['result']
        cursor = first['nextCursor']
        self.assertTrue(first['truncated'])
        # A different query string cannot reuse the cursor.
        other = self.call('file_search', {'path': '.', 'pattern': 'other', 'cursor': cursor})
        self.assertEqual(other['error']['code'], 'STALE_CURSOR')
        # Directory contents changed between pages.
        self.write('new.txt', 'z\n')
        stale = self.call('file_search', {'path': '.', 'pattern': NEEDLE, 'cursor': cursor})
        self.assertEqual(stale['error']['code'], 'STALE_CURSOR')
        (self.work / 'new.txt').unlink()
        # Changing the resume file's content while paging is a cursor conflict.
        fresh = self.call('file_search', {'path': '.', 'pattern': NEEDLE, 'limit': 1})['result']
        resumed = fresh['nextCursor']
        target = self.work / self.hits(fresh)[-1][0]
        target.write_text('rewritten longer content {}\n'.format(NEEDLE))
        conflict = self.call('file_search', {'path': '.', 'pattern': NEEDLE, 'cursor': resumed})
        self.assertEqual(conflict['error']['code'], 'CURSOR_CONFLICT')

    def test_time_budget_is_reported_as_partial(self):
        # In-process test: inject a time source that expires immediately.
        sys.path.insert(0, str(HELPER.parent))
        import discovery
        from files import FileService
        self.big_file('large.log', 2 * 1024 * 1024, {3})
        service = FileService(self.root / 'state', str(self.work), 'session-one')
        original = discovery.time.monotonic
        ticks = [0]

        def fast_clock():
            ticks[0] += 5.0
            return ticks[0]
        try:
            discovery.time.monotonic = fast_clock
            result = discovery.discover(service, 'file_search', {'path': 'large.log', 'pattern': NEEDLE})
        finally:
            discovery.time.monotonic = original
        self.assertTrue(result['truncated'])
        self.assertEqual(result['reason'], 'SCAN_TIME_LIMIT')
        self.assertIsNotNone(result['nextCursor'])

    # --- filters ----------------------------------------------------------------

    def test_gitignore_semantics_when_explicitly_enabled(self):
        self.write('logs/keep.log', 'keep {}\n'.format(NEEDLE))
        self.write('logs/skip.log', 'skip {}\n'.format(NEEDLE))
        self.write('build/artifact.txt', 'build {}\n'.format(NEEDLE))
        self.write('#hash.txt', 'hash {}\n'.format(NEEDLE))
        self.write('escaped space.txt', 'escape {}\n'.format(NEEDLE))
        self.write('nested/inner.txt', 'inner {}\n'.format(NEEDLE))
        self.write('nested/deep/kept.txt', 'deep {}\n'.format(NEEDLE))
        self.write('excluded/kept-child.txt', 'reincluded {}\n'.format(NEEDLE))
        self.write('.gitignore', 'logs/skip.log\nbuild/\n\\#hash.txt\nescaped\\ space.txt\n'
                                 'nested/inner.txt\nexcluded/\n!excluded/kept-child.txt\n')
        # A deeper .gitignore negates the shallower rule for inner.txt.
        self.write('nested/.gitignore', '!inner.txt\n')
        default = self.call('file_search', {'path': '.', 'pattern': NEEDLE})['result']
        self.assertEqual(set(self.hits(default)), {
            ('logs/keep.log', 1), ('logs/skip.log', 1), ('build/artifact.txt', 1), ('#hash.txt', 1),
            ('escaped space.txt', 1), ('nested/inner.txt', 1), ('nested/deep/kept.txt', 1),
            ('excluded/kept-child.txt', 1)})
        filtered = self.call('file_search', {'path': '.', 'pattern': NEEDLE, 'respectGitignore': True})['result']
        # kept-child.txt stays excluded: an ignored parent directory cannot be
        # re-included for its children; inner.txt returns via the nested negation.
        self.assertEqual(set(self.hits(filtered)), {
            ('logs/keep.log', 1), ('nested/inner.txt', 1), ('nested/deep/kept.txt', 1)})

    def test_hidden_files_default_included_and_toggle_excludes_git_always(self):
        self.write('.dotfile', 'hidden {}\n'.format(NEEDLE))
        self.write('.dotdir/inner.txt', 'dotdir {}\n'.format(NEEDLE))
        self.write('visible.txt', 'visible {}\n'.format(NEEDLE))
        self.write('.git/config', 'git {}\n'.format(NEEDLE))
        default = self.call('file_search', {'path': '.', 'pattern': NEEDLE})['result']
        self.assertEqual(set(self.hits(default)), {('.dotfile', 1), ('.dotdir/inner.txt', 1), ('visible.txt', 1)})
        hidden_off = self.call('file_search', {'path': '.', 'pattern': NEEDLE, 'includeHidden': False})['result']
        self.assertEqual(self.hits(hidden_off), [('visible.txt', 1)])
        explicit_git = self.call('file_search', {'path': '.git', 'pattern': NEEDLE})
        self.assertEqual(explicit_git['error']['code'], 'PATH_NOT_ALLOWED')

    def test_no_match_is_complete_and_search_never_issues_read_tokens(self):
        self.write('content.txt', 'nothing relevant\n')
        result = self.call('file_search', {'path': 'content.txt', 'pattern': 'absent'})['result']
        self.assertEqual(result['matches'], [])
        self.assertFalse(result['truncated'])
        self.assertIsNone(result.get('nextCursor'))
        hit = self.call('file_search', {'path': 'content.txt', 'pattern': 'nothing'})['result']
        self.assertNotIn('readToken', hit)

    def test_pattern_validation_rejects_multiline_and_oversized_patterns(self):
        for pattern in ('with\nnewline', 'with\0nul', '', 'x' * 4097):
            result = self.call('file_search', {'path': '.', 'pattern': pattern})
            self.assertEqual(result['error']['code'], 'INVALID_PATTERN', repr(pattern[:20]))

    # --- capabilities -----------------------------------------------------------

    def test_workspace_capabilities_report_available_backends(self):
        for backends, engine in [('rg+grep', 'ripgrep'), ('grep', 'gnu-grep'), ('none', 'python-literal')]:
            result = self.call('file_workspace', {}, backends=backends)['result']
            self.assertEqual(result['capabilities']['searchEngine'], engine)
            self.assertEqual(result['capabilities']['searchBackends'][0], engine)
            self.assertIn('python-literal', result['capabilities']['searchBackends'])
            self.assertTrue(result['capabilities']['gitignoreSearch'])

    # --- large files --------------------------------------------------------------

    def test_64mib_file_search_across_blocks_long_lines_and_pagination(self):
        # ~52 MiB of regular lines, then a 1.5 MiB single line (spans two read
        # blocks), then an unterminated >8 MiB segment (forces bounded fragment
        # reporting). The needle appears at row 1, the middle row, the last
        # regular row and inside both giant lines.
        path = self.work / 'huge.log'
        expected, number, written = [], 0, 0
        target_regular = 52 * 1024 * 1024
        with open(str(path), 'w', encoding='utf8') as stream:
            while written < target_regular:
                number += 1
                marker = NEEDLE if number in (1, 312345, 556789) else 'padding'
                line = 'row {:07d} {} content\n'.format(number, marker)
                if number in (1, 312345, 556789):
                    expected.append(number)
                stream.write(line)
                written += len(line.encode('utf8')) + 1
            long_line = number + 1
            stream.write('single-line ' + 'x' * (1536 * 1024) + ' {} '.format(NEEDLE) + 'y' * 64 + '\n')
            expected.append(long_line)
            stream.write('segment-start\n')
            segment_line = long_line + 1
            stream.write('a' * (4 * 1024 * 1024) + ' {} '.format(NEEDLE) + 'b' * (5 * 1024 * 1024))
            expected.append(segment_line)
        collected, texts = [], {}
        cursor, pages = None, 0
        while True:
            request = {'path': 'huge.log', 'pattern': NEEDLE, 'limit': 2,
                       'scanBudgetSeconds': 30}
            if cursor:
                request['cursor'] = cursor
            result = self.call('file_search', request, timeout=300)['result']
            for match in result['matches']:
                collected.append((match['line'], match['lineTruncated']))
                texts[match['line']] = match['text']
            pages += 1
            self.assertLessEqual(pages, 10)
            cursor = result.get('nextCursor')
            if not cursor:
                break
        self.assertEqual([line for line, _ in collected], expected)
        truncated = dict(collected)
        self.assertTrue(truncated[long_line])
        self.assertTrue(truncated[segment_line])
        for number in (1, 312345, 556789):
            self.assertEqual(texts[number], 'row {:07d} {} content'.format(number, NEEDLE))

    def test_200mib_file_is_searchable(self):
        path = self.work / 'netlist.log'
        per_line = 96
        lines = 200 * 1024 * 1024 // per_line
        hits = {1, lines // 2, lines}
        with open(str(path), 'w', encoding='utf8') as stream:
            for number in range(1, lines + 1):
                if number in hits:
                    stream.write('cell {:09d} nets {} value\n'.format(number, NEEDLE))
                else:
                    stream.write('cell {:09d} nets 0000000000 value\n'.format(number))
        collected, cursor, pages = [], None, 0
        while True:
            request = {'path': 'netlist.log', 'pattern': NEEDLE, 'limit': 2,
                       'scanBudgetSeconds': 60}
            if cursor:
                request['cursor'] = cursor
            result = self.call('file_search', request, timeout=300)['result']
            collected.extend(self.hits(result))
            pages += 1
            self.assertLessEqual(pages, 8)
            cursor = result.get('nextCursor')
            if not cursor:
                break
        self.assertEqual(collected, [('netlist.log', 1), ('netlist.log', lines // 2), ('netlist.log', lines)])


if __name__ == '__main__':
    unittest.main(verbosity=2)
