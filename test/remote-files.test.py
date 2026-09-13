import base64
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor


HELPER = Path(__file__).resolve().parents[1] / 'remote' / 'agent.py'


class RemoteFilesTest(unittest.TestCase):
    def setUp(self):
        self.fixture = tempfile.TemporaryDirectory(prefix='ssh-mcp files ')
        self.root = Path(self.fixture.name)
        self.work = self.root / 'work'
        self.work.mkdir()

    def tearDown(self):
        self.fixture.cleanup()

    def call(self, action, request, session='session-one'):
        data = dict(request, workspaceRoot=str(self.work), sessionId=session)
        run = subprocess.run([sys.executable, str(HELPER), '--root', str(self.root / 'state'), action],
                             input=json.dumps(data), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             universal_newlines=True, timeout=10)
        self.assertEqual(run.returncode, 0, run.stderr)
        return json.loads(base64.b64decode(run.stdout.split(' ', 1)[1]))

    def scoped_call(self, action, request, scope, allowed=None, session='session-one'):
        data = dict(request, workspaceRoot=str(self.work), sessionId=session)
        if scope is not None:
            data['directoryScope'] = scope
        if allowed is not None:
            data['allowedRemotePaths'] = allowed
        run = subprocess.run([sys.executable, str(HELPER), '--root', str(self.root / 'state'), action],
                             input=json.dumps(data), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             universal_newlines=True, timeout=10)
        self.assertEqual(run.returncode, 0, run.stderr)
        return json.loads(base64.b64decode(run.stdout.split(' ', 1)[1]))

    def test_directory_scope_keeps_restrictions_by_default_and_only_opens_with_explicit_unrestricted(self):
        outside = self.root / 'outside'
        outside.mkdir()
        (outside / 'note.txt').write_text('outside-content\n')

        blocked = self.call('file_read', {'path': str(outside / 'note.txt')})
        self.assertFalse(blocked['ok'])
        self.assertEqual(blocked['error']['code'], 'PATH_NOT_ALLOWED')
        still_blocked = self.scoped_call('file_read', {'path': str(outside / 'note.txt')}, 'restricted')
        self.assertEqual(still_blocked['error']['code'], 'PATH_NOT_ALLOWED')

        opened = self.scoped_call('file_read', {'path': str(outside / 'note.txt')}, 'unrestricted')
        self.assertTrue(opened['ok'], opened)
        self.assertEqual(opened['result']['text'], 'outside-content\n')
        self.assertTrue(opened['result']['complete'])

        guarded = self.scoped_call('file_read', {'path': str(outside / 'note.txt')}, 'unrestricted',
                                   allowed=[str(self.work)])
        self.assertFalse(guarded['ok'])
        self.assertEqual(guarded['error']['code'], 'PATH_NOT_ALLOWED')

        invalid = self.scoped_call('file_read', {'path': 'any.txt'}, 'sometimes')
        self.assertFalse(invalid['ok'])
        self.assertEqual(invalid['error']['code'], 'INVALID_REQUEST')

        self.assertEqual(self.call('file_workspace', {})['result']['directoryScope'], 'restricted')
        self.assertEqual(self.scoped_call('file_workspace', {}, 'unrestricted')['result']['directoryScope'], 'unrestricted')

    def test_discovery_outside_workspace_reports_absolute_paths_only_when_unrestricted(self):
        outside = self.root / 'outside'
        outside.mkdir()
        (outside / 'needle.txt').write_text('find-this-needle\n')
        (self.work / 'inside.txt').write_text('find-this-needle\n')

        blocked = self.call('file_find', {'path': str(outside), 'pattern': '*.txt'})
        self.assertFalse(blocked['ok'])
        self.assertEqual(blocked['error']['code'], 'PATH_NOT_ALLOWED')

        found = self.scoped_call('file_find', {'path': str(outside), 'pattern': '*.txt'}, 'unrestricted')
        self.assertTrue(found['ok'], found)
        self.assertEqual(found['result']['entries'][0]['path'], str(outside / 'needle.txt'))

        search = self.scoped_call('file_search', {'path': str(outside), 'pattern': 'needle'}, 'unrestricted')
        self.assertTrue(search['ok'], search)
        self.assertEqual(search['result']['matches'][0]['path'], str(outside / 'needle.txt'))
        self.assertEqual(search['result']['matches'][0]['line'], 1)

        listed = self.call('file_list', {'path': '.'})
        self.assertTrue(listed['ok'])
        self.assertEqual([entry['path'] for entry in listed['result']['entries']], ['inside.txt'])

    def test_read_then_edit_preserves_encoding_permissions_and_invalidates_old_version(self):
        path = self.work / 'source.txt'
        path.write_bytes(b'\xef\xbb\xbfalpha\r\nbeta\r\n')
        path.chmod(0o755)
        read = self.call('file_read', {'path': 'source.txt'})
        self.assertTrue(read['ok'], read)
        self.assertEqual(read['result']['text'], 'alpha\r\nbeta\r\n')
        edited = self.call('file_edit', {'path': 'source.txt', 'readToken': read['result']['readToken'],
                                        'edits': [{'oldText': 'beta', 'newText': 'gamma'}]})
        self.assertTrue(edited['ok'], edited)
        self.assertEqual(path.read_bytes(), b'\xef\xbb\xbfalpha\r\ngamma\r\n')
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o755)
        stale = self.call('file_edit', {'path': 'source.txt', 'readToken': read['result']['readToken'],
                                       'edits': [{'oldText': 'gamma', 'newText': 'lost'}]})
        self.assertFalse(stale['ok'])
        self.assertEqual(stale['error']['code'], 'FILE_CONFLICT')
        renewed = edited['result']
        self.assertNotEqual(renewed['readToken'], read['result']['readToken'])
        self.assertTrue(renewed['complete'])
        again = self.call('file_edit', {'path': 'source.txt', 'readToken': renewed['readToken'],
                                       'edits': [{'oldText': 'gamma', 'newText': 'delta'}]})
        self.assertTrue(again['ok'], again)
        self.assertEqual(path.read_bytes(), b'\xef\xbb\xbfalpha\r\ndelta\r\n')

    def test_partial_read_only_authorizes_edits_inside_the_delivered_range(self):
        path = self.work / 'partial.txt'
        path.write_text('first\nmiddle\nlast\n')
        read = self.call('file_read', {'path': 'partial.txt', 'fromLine': 2, 'toLine': 2})
        self.assertTrue(read['ok'], read)
        self.assertEqual(read['result']['text'], 'middle\n')
        self.assertFalse(read['result']['complete'])
        blocked = self.call('file_edit', {'path': 'partial.txt', 'readToken': read['result']['readToken'],
                                         'edits': [{'oldText': 'first', 'newText': 'unread'}]})
        self.assertFalse(blocked['ok'])
        self.assertEqual(blocked['error']['code'], 'READ_REQUIRED')
        accepted = self.call('file_edit', {'path': 'partial.txt', 'readToken': read['result']['readToken'],
                                          'edits': [{'oldText': 'middle', 'newText': 'changed'}]})
        self.assertTrue(accepted['ok'], accepted)
        self.assertEqual(path.read_text(), 'first\nchanged\nlast\n')

    def test_create_conflict_paged_reads_and_full_overwrite(self):
        name = '中文 space;$(false).txt'
        created = self.call('file_write', {'path': name, 'text': 'one\r\ntwo\r\n', 'create': True})
        self.assertTrue(created['ok'], created)
        conflict = self.call('file_write', {'path': name, 'text': 'lost', 'create': True})
        self.assertEqual(conflict['error']['code'], 'FILE_CONFLICT')
        page = self.call('file_read', {'path': name, 'fromLine': 1, 'toLine': 1})['result']
        blocked = self.call('file_write', {'path': name, 'text': 'lost', 'readToken': page['readToken']})
        self.assertEqual(blocked['error']['code'], 'READ_REQUIRED')
        full = self.call('file_read', {'path': name, 'fromLine': 2})['result']
        self.assertEqual(full['readToken'], page['readToken'])
        self.assertTrue(full['complete'])
        updated = self.call('file_write', {'path': name, 'text': 'new\nlines\n', 'readToken': full['readToken']})
        self.assertTrue(updated['ok'], updated)
        self.assertEqual((self.work / name).read_bytes(), b'new\r\nlines\r\n')

    def test_binary_read_write_move_delete_share_full_read_guard(self):
        original = b'\x00\xff\x01'
        (self.work / 'binary').write_bytes(original)
        token = self.call('file_read', {'path': 'binary', 'encoding': 'base64'})['result']['readToken']
        write = self.call('file_write', {'path': 'binary', 'data': base64.b64encode(b'\xffNEW').decode(), 'readToken': token})
        self.assertTrue(write['ok'], write)
        stale = self.call('file_delete', {'path': 'binary', 'readToken': token})
        self.assertEqual(stale['error']['code'], 'FILE_CONFLICT')
        token = self.call('file_read', {'path': 'binary', 'encoding': 'base64'})['result']['readToken']
        (self.work / 'target').write_text('keep')
        conflict = self.call('file_move', {'path': 'binary', 'target': 'target', 'readToken': token})
        self.assertEqual(conflict['error']['code'], 'FILE_CONFLICT')
        self.assertEqual((self.work / 'target').read_text(), 'keep')
        moved = self.call('file_move', {'path': 'binary', 'target': 'new', 'readToken': token})
        self.assertTrue(moved['ok'], moved)
        self.assertFalse((self.work / 'binary').exists())
        fresh = self.call('file_read', {'path': 'new', 'encoding': 'base64'})['result']
        self.assertEqual(base64.b64decode(fresh['data']), b'\xffNEW')
        deleted = self.call('file_delete', {'path': 'new', 'readToken': fresh['readToken']})
        self.assertTrue(deleted['ok'], deleted)
        self.assertFalse((self.work / 'new').exists())

    def test_paths_links_and_external_changes_rejected_without_data_loss(self):
        path = self.work / 'a'
        path.write_text('old')
        token = self.call('file_read', {'path': 'a'})['result']['readToken']
        path.write_text('external')
        result = self.call('file_write', {'path': 'a', 'text': 'lost', 'readToken': token})
        self.assertEqual(result['error']['code'], 'FILE_CONFLICT')
        self.assertEqual(path.read_text(), 'external')
        (self.work / 'link').symlink_to(path)
        result = self.call('file_write', {'path': 'link', 'text': 'lost', 'readToken': token})
        self.assertEqual(result['error']['code'], 'UNSUPPORTED_LINK')
        outside = self.call('file_read', {'path': '../outside'})
        self.assertEqual(outside['error']['code'], 'PATH_NOT_ALLOWED')

    def test_discovery_pagination_search_and_directory_operations(self):
        self.assertTrue(self.call('file_mkdir', {'path': 'nested'})['ok'])
        (self.work / 'nested' / 'a.txt').write_text('needle\nother\n')
        (self.work / 'nested' / 'b.txt').write_text('needle too\n')
        first = self.call('file_list', {'path': 'nested', 'limit': 1})['result']
        self.assertEqual(len(first['entries']), 1)
        second = self.call('file_list', {'path': 'nested', 'limit': 1, 'cursor': first['nextCursor']})['result']
        self.assertNotEqual(first['entries'][0]['path'], second['entries'][0]['path'])
        self.assertIsNone(second['nextCursor'])
        found = self.call('file_find', {'path': '.', 'pattern': '*.txt'})['result']
        self.assertEqual(len(found['entries']), 2)
        search = self.call('file_search', {'path': '.', 'pattern': 'needle', 'limit': 1})['result']
        self.assertEqual(search['matches'][0]['line'], 1)
        self.assertTrue(search['truncated'])
        self.assertNotIn('readToken', search)
        self.assertEqual(search['engine'], 'python-literal')
        self.assertFalse(self.call('file_rmdir', {'path': 'nested'})['ok'])

    def test_overlapping_matches_rejected_and_serialized_read_is_bounded(self):
        (self.work / 'overlap').write_text('aaa')
        token = self.call('file_read', {'path': 'overlap'})['result']['readToken']
        edit = self.call('file_edit', {'path': 'overlap', 'readToken': token, 'edits': [{'oldText': 'aa', 'newText': 'X'}]})
        self.assertEqual(edit['error']['code'], 'EDIT_MATCH_ERROR')
        self.assertEqual((self.work / 'overlap').read_text(), 'aaa')
        (self.work / 'escaped').write_bytes(b'\0' * 65536)
        read = self.call('file_read', {'path': 'escaped'})['result']
        self.assertLessEqual(len(json.dumps(read, ensure_ascii=False).encode('utf8')), 65536)
        self.assertTrue(read['truncated'])
        self.assertFalse(read['complete'])

    def test_concurrent_creators_and_writers_cannot_overwrite_each_other(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda text: self.call('file_write', {'path': 'race', 'text': text, 'create': True}), ['a', 'b']))
        self.assertEqual(sum(result['ok'] for result in results), 1)
        token = self.call('file_read', {'path': 'race'})['result']['readToken']
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda text: self.call('file_write', {'path': 'race', 'text': text, 'readToken': token}), ['first', 'second']))
        self.assertEqual(sum(result['ok'] for result in results), 1)
        self.assertEqual([result['error']['code'] for result in results if not result['ok']], ['FILE_CONFLICT'])

    def test_edit_renews_disjoint_read_ranges_without_granting_unread_gaps(self):
        path = self.work / 'ranges.txt'
        original = '\ufeffunread header\r\n前 编辑甲 后\r\nsecret gap\r\n尾读乙\r\nunread tail\r\n'
        path.write_bytes(original.encode('utf8'))
        self.call('file_read', {'path': 'ranges.txt', 'fromLine': 2, 'toLine': 2})
        partial = self.call('file_read', {'path': 'ranges.txt', 'fromLine': 4, 'toLine': 4})['result']
        other = self.call('file_read', {'path': 'ranges.txt'}, session='session-two')['result']
        changed = self.call('file_edit', {'path': 'ranges.txt', 'readToken': partial['readToken'], 'edits': [
            {'oldText': '尾读乙', 'newText': '乙'},
            {'oldText': '编辑甲', 'newText': '扩大\n第二行'},
        ]})
        self.assertTrue(changed['ok'], changed)
        renewed = changed['result']
        self.assertFalse(renewed['complete'])
        for action, request in [
            ('file_edit', {'edits': [{'oldText': 'secret gap', 'newText': 'lost'}]}),
            ('file_write', {'text': 'lost'}),
        ]:
            denied = self.call(action, dict(request, path='ranges.txt', readToken=renewed['readToken']))
            self.assertEqual(denied['error']['code'], 'READ_REQUIRED')
        foreign = self.call('file_edit', {'path': 'ranges.txt', 'readToken': renewed['readToken'],
                                         'edits': [{'oldText': '乙', 'newText': 'lost'}]}, session='session-two')
        self.assertEqual(foreign['error']['code'], 'READ_SCOPE_MISMATCH')
        stale = self.call('file_edit', {'path': 'ranges.txt', 'readToken': other['readToken'],
                                       'edits': [{'oldText': '乙', 'newText': 'lost'}]}, session='session-two')
        self.assertEqual(stale['error']['code'], 'FILE_CONFLICT')
        again = self.call('file_edit', {'path': 'ranges.txt', 'readToken': renewed['readToken'], 'edits': [
            {'oldText': '扩大\r\n第二行', 'newText': '短'},
            {'oldText': '乙', 'newText': '后续编辑'},
        ]})
        self.assertTrue(again['ok'], again)
        self.assertFalse(again['result']['complete'])
        self.assertEqual(path.read_bytes(), '\ufeffunread header\r\n前 短 后\r\nsecret gap\r\n后续编辑\r\nunread tail\r\n'.encode('utf8'))
        # Re-reading another range must extend the renewed record, not reset it.
        page = self.call('file_read', {'path': 'ranges.txt', 'fromLine': 1, 'toLine': 1})['result']
        self.assertEqual(page['readToken'], again['result']['readToken'])
        self.assertFalse(page['complete'])
        path.write_bytes(path.read_bytes().replace(b'secret gap', b'external gap'))
        conflict = self.call('file_edit', {'path': 'ranges.txt', 'readToken': page['readToken'],
                                          'edits': [{'oldText': '短', 'newText': 'lost'}]})
        self.assertEqual(conflict['error']['code'], 'FILE_CONFLICT')

    def test_edit_deletion_retains_full_coverage_and_supports_empty_file(self):
        (self.work / 'emptying').write_text('remove me')
        token = self.call('file_read', {'path': 'emptying'})['result']['readToken']
        deleted_text = self.call('file_edit', {'path': 'emptying', 'readToken': token,
                                              'edits': [{'oldText': 'remove me', 'newText': ''}]})
        self.assertTrue(deleted_text['ok'], deleted_text)
        self.assertTrue(deleted_text['result']['complete'])
        self.assertEqual(deleted_text['result']['size'], 0)
        # Full coverage remains full; a complete read is not required again.
        rewritten = self.call('file_write', {'path': 'emptying', 'readToken': deleted_text['result']['readToken'], 'text': 'replacement'})
        self.assertTrue(rewritten['ok'], rewritten)

    def test_external_replacement_after_commit_does_not_receive_a_renewed_token(self):
        sys.path.insert(0, str(HELPER.parent))
        from files import FileService
        path = self.work / 'post-image'
        path.write_text('before')
        token = self.call('file_read', {'path': 'post-image'})['result']['readToken']

        class ExternalReplacement(FileService):
            def commit(inner, target, data, info=None, version=None):
                written = super(ExternalReplacement, inner).commit(target, data, info, version)
                other = target.with_name('external-temp')
                other.write_bytes(data)  # Same content, but a different file identity.
                other.replace(target)
                return written

        result = ExternalReplacement(self.root / 'state', str(self.work), 'session-one').edit({
            'path': 'post-image', 'readToken': token, 'edits': [{'oldText': 'before', 'newText': 'after'}]})
        self.assertTrue(result['written'])
        self.assertTrue(result['rereadRequired'])
        self.assertIsNone(result['readToken'])
        self.assertEqual(result['readTokenError'], 'FILE_CONFLICT')
        self.assertEqual(path.read_text(), 'after')

    def test_read_record_failure_does_not_report_a_committed_edit_as_failed(self):
        sys.path.insert(0, str(HELPER.parent))
        from files import FileService
        (self.work / 'record-failure').write_text('before')
        token = self.call('file_read', {'path': 'record-failure'})['result']['readToken']

        class RecordFailure(FileService):
            def save_read(inner, *args, **kwargs):
                raise OSError('injected storage failure')

        result = RecordFailure(self.root / 'state', str(self.work), 'session-one').edit({
            'path': 'record-failure', 'readToken': token, 'edits': [{'oldText': 'before', 'newText': 'after'}]})
        self.assertTrue(result['written'])
        self.assertTrue(result['rereadRequired'])
        self.assertIsNone(result['readToken'])
        self.assertEqual((self.work / 'record-failure').read_text(), 'after')

    def test_size_gate_rejects_directories_but_streams_oversized_reads_and_gates_commits(self):
        directory = self.call('file_read', {'path': '.'})
        self.assertEqual(directory['error']['code'], 'UNSUPPORTED_FILE')
        # Reads no longer carry a file-size cap (issue #9): a >16 MiB file
        # streams its first window instead of being rejected.
        oversized = self.work / 'oversized.bin'
        oversized.write_bytes(b'0' * (16 * 1024 * 1024 + 1))
        streamed = self.call('file_read', {'path': 'oversized.bin', 'offset': 16 * 1024 * 1024 - 10, 'maxBytes': 100})
        self.assertTrue(streamed['ok'], streamed)
        self.assertEqual(streamed['result']['endOffset'], 16 * 1024 * 1024 + 1)
        self.assertIsNone(streamed['result']['nextOffset'])
        self.assertFalse(streamed['result']['complete'])
        # The commit-side output gate still applies, even to creations.
        payload = base64.b64encode(b'0' * (16 * 1024 * 1024 + 1)).decode('ascii')
        rejected = self.call('file_write', {'path': 'created.bin', 'data': payload, 'create': True})
        self.assertEqual(rejected['error']['code'], 'FILE_TOO_LARGE')
        self.assertFalse((self.work / 'created.bin').exists())
        # Guarded mutations keep the whole-file bound until streaming
        # replacement lands (#10).
        edit = self.call('file_edit', {'path': 'oversized.bin', 'readToken': streamed['result']['readToken'],
                                       'edits': [{'oldText': '0', 'newText': 'x'}]})
        self.assertEqual(edit['error']['code'], 'FILE_TOO_LARGE')

    def helper_module(self):
        sys.path.insert(0, str(HELPER.parent))
        import files
        return files

    def service(self, session='session-one'):
        (self.root / 'state').mkdir(parents=True, exist_ok=True)
        return self.helper_module().FileService(self.root / 'state', str(self.work), session)

    def test_version_string_observes_linux_metadata_only(self):
        files = self.helper_module()
        path = self.work / 'versioned.txt'
        path.write_bytes(b'stable content\n')
        first = files.snapshot(path)
        second = files.snapshot(path)
        self.assertEqual(first[0], b'stable content\n')
        self.assertEqual(first[2], second[2])
        # The version is decided by the observed metadata alone: one stat
        # result, no content argument, scheme-prefixed for the new semantics.
        info = path.stat()
        self.assertTrue(files.content_version(info).startswith('m1-'))
        self.assertEqual(files.content_version(info), files.content_version(info))
        (self.work / 'other.txt').write_bytes(b'different bytes entirely\n')
        self.assertNotEqual(files.content_version(info), files.content_version((self.work / 'other.txt').stat()))
        # Same bytes, moved metadata: the version string must still change.
        stats = path.stat()
        os.utime(str(path), (stats.st_atime + 90, stats.st_mtime + 90))
        self.assertNotEqual(files.snapshot(path)[2], first[2])
        path.write_bytes(b'changed content\n')
        self.assertNotEqual(files.snapshot(path)[2], first[2])
        # A metadata-only touch must also invalidate a previously granted token.
        stale = self.call('file_read', {'path': 'versioned.txt'})['result']['readToken']
        stats = path.stat()
        os.utime(str(path), (stats.st_atime + 90, stats.st_mtime + 90))
        conflict = self.call('file_edit', {'path': 'versioned.txt', 'readToken': stale,
                                           'edits': [{'oldText': 'changed', 'newText': 'lost'}]})
        self.assertEqual(conflict['error']['code'], 'FILE_CONFLICT')
        self.assertEqual(path.read_bytes(), b'changed content\n')

    def test_metadata_only_reports_observed_version_without_content_or_grant(self):
        path = self.work / 'meta.txt'
        path.write_bytes(b'\xef\xbb\xbfhello\n')
        observed = self.call('file_read', {'path': 'meta.txt', 'metadataOnly': True})['result']
        self.assertTrue(observed['exists'])
        self.assertEqual(observed['size'], 9)
        self.assertTrue(observed['bom'])
        self.assertTrue(observed['version'].startswith('m1-'))
        for forbidden in ('text', 'data', 'readToken', 'complete'):
            self.assertNotIn(forbidden, observed)
        # The observed version is exactly what a content read would report.
        read = self.call('file_read', {'path': 'meta.txt'})['result']
        self.assertEqual(observed['version'], read['version'])
        # No credential was issued: any edit still demands a real read first.
        denied = self.call('file_edit', {'path': 'meta.txt', 'readToken': '0' * 32,
                                         'edits': [{'oldText': 'hello', 'newText': 'lost'}]})
        self.assertEqual(denied['error']['code'], 'READ_REQUIRED')
        # Absent targets report an explicit non-existence state, not an error.
        missing = self.call('file_read', {'path': 'absent.txt', 'metadataOnly': True})['result']
        self.assertFalse(missing['exists'])
        self.assertIsNone(missing['version'])
        self.assertIsNone(missing['size'])
        directory = self.call('file_read', {'path': '.', 'metadataOnly': True})
        self.assertFalse(directory['ok'])
        self.assertEqual(directory['error']['code'], 'UNSUPPORTED_FILE')
        # Content selectors are meaningless without content: reject mixing.
        mixed = self.call('file_read', {'path': 'meta.txt', 'metadataOnly': True, 'offset': 0})
        self.assertEqual(mixed['error']['code'], 'INVALID_REQUEST')

    def test_capabilities_report_streamed_read_and_the_write_side_gate(self):
        capabilities = self.call('file_workspace', {})['result']['capabilities']
        self.assertNotIn('maxGuardedFileBytes', capabilities)
        self.assertTrue(capabilities['streamedRead'])
        self.assertEqual(capabilities['maxCommitBytes'], 16 * 1024 * 1024)
        self.assertEqual(capabilities['readTokenTtlDays'], 3)

    def test_read_window_validates_offsets_lines_limits_and_encodings(self):
        path = self.work / 'window.txt'
        path.write_bytes('中文 text\n'.encode('utf8'))
        for request, code in [
            ({'path': 'window.txt', 'maxBytes': 0}, 'INVALID_LIMIT'),
            ({'path': 'window.txt', 'maxBytes': 1048577}, 'INVALID_LIMIT'),
            ({'path': 'window.txt', 'maxBytes': 'eight'}, 'INVALID_LIMIT'),
            ({'path': 'window.txt', 'maxBytes': 1}, 'INVALID_LIMIT'),
            ({'path': 'window.txt', 'offset': 99}, 'INVALID_OFFSET'),
            ({'path': 'window.txt', 'offset': 1}, 'INVALID_OFFSET'),
            ({'path': 'window.txt', 'fromLine': 0}, 'INVALID_LINE_RANGE'),
            ({'path': 'window.txt', 'fromLine': 5, 'toLine': 2}, 'INVALID_LINE_RANGE'),
            ({'path': 'window.txt', 'fromLine': '2'}, 'INVALID_LINE_RANGE'),
            ({'path': 'window.txt', 'encoding': 'latin1'}, 'UNSUPPORTED_ENCODING'),
        ]:
            result = self.call('file_read', request)
            self.assertFalse(result['ok'], request)
            self.assertEqual(result['error']['code'], code, request)
        (self.work / 'raw.bin').write_bytes(b'\xff\xfe\x00')
        refused = self.call('file_read', {'path': 'raw.bin'})
        self.assertEqual(refused['error']['code'], 'UNSUPPORTED_ENCODING')

    def test_read_window_paginates_by_byte_cursor_and_merges_coverage(self):
        (self.work / 'cursor.txt').write_bytes(b'hello cursor world')
        first = self.call('file_read', {'path': 'cursor.txt', 'offset': 0, 'maxBytes': 4})['result']
        self.assertEqual((first['text'], first['startOffset'], first['endOffset'], first['nextOffset'], first['truncated']),
                         ('hell', 0, 4, 4, True))
        second = self.call('file_read', {'path': 'cursor.txt', 'offset': first['nextOffset'], 'maxBytes': 8})['result']
        self.assertEqual((second['text'], second['startOffset'], second['nextOffset'], second['truncated']),
                         ('o cursor', 4, 12, True))
        third = self.call('file_read', {'path': 'cursor.txt', 'offset': second['nextOffset'], 'maxBytes': 8})['result']
        self.assertEqual(third['text'], ' world')
        self.assertIsNone(third['nextOffset'])
        self.assertFalse(third['truncated'])
        self.assertTrue(third['complete'])
        self.assertEqual(third['readToken'], first['readToken'])

    def test_read_window_skips_bom_bytes_but_counts_them_as_read(self):
        (self.work / 'bom.txt').write_bytes(b'\xef\xbb\xbfcontent')
        read = self.call('file_read', {'path': 'bom.txt'})['result']
        self.assertEqual((read['text'], read['bom'], read['startOffset'], read['truncated']),
                         ('content', True, 3, False))
        self.assertTrue(read['complete'])
        jumped = self.call('file_read', {'path': 'bom.txt', 'offset': 0})['result']
        self.assertEqual(jumped['startOffset'], 3)
        self.assertTrue(jumped['complete'])
        self.assertEqual(jumped['readToken'], read['readToken'])

    def test_edit_input_validation_rejects_malformed_requests_and_binary_targets(self):
        (self.work / 'edit-target.txt').write_text('value\n')
        token = self.call('file_read', {'path': 'edit-target.txt'})['result']['readToken']
        base = {'path': 'edit-target.txt', 'readToken': token}
        for edits, code in [
            ([], 'INVALID_EDIT'),
            ([{'oldText': 'value', 'newText': 'x'}] * 101, 'INVALID_EDIT'),
            (['value'], 'INVALID_EDIT'),
            ([{'oldText': '', 'newText': 'x'}], 'INVALID_EDIT'),
            ([{'oldText': 7, 'newText': 'x'}], 'INVALID_EDIT'),
        ]:
            result = self.call('file_edit', dict(base, edits=edits))
            self.assertFalse(result['ok'], repr(edits[:1]))
            self.assertEqual(result['error']['code'], code, repr(edits[:1]))
        self.assertEqual((self.work / 'edit-target.txt').read_text(), 'value\n')
        (self.work / 'binary-edit').write_bytes(b'\xff\xfe raw')
        raw_token = self.call('file_read', {'path': 'binary-edit', 'encoding': 'base64'})['result']['readToken']
        refused = self.call('file_edit', {'path': 'binary-edit', 'readToken': raw_token,
                                          'edits': [{'oldText': 'raw', 'newText': 'cooked'}]})
        self.assertEqual(refused['error']['code'], 'UNSUPPORTED_ENCODING')
        self.assertEqual((self.work / 'binary-edit').read_bytes(), b'\xff\xfe raw')

    def test_mutations_require_a_single_owned_link(self):
        path = self.work / 'linked.txt'
        path.write_text('content\n')
        os.link(str(path), str(self.work / 'second-link.txt'))
        token = self.call('file_read', {'path': 'linked.txt'})['result']['readToken']
        refused = self.call('file_edit', {'path': 'linked.txt', 'readToken': token,
                                          'edits': [{'oldText': 'content', 'newText': 'changed'}]})
        self.assertEqual(refused['error']['code'], 'UNSUPPORTED_METADATA')
        self.assertEqual(path.read_text(), 'content\n')

    # --- Streaming reads, cursors and credential lifetimes (issue #9) -------

    def call_at(self, clock, action, request, session='session-one'):
        data = dict(request, workspaceRoot=str(self.work), sessionId=session)
        run = subprocess.run([sys.executable, str(HELPER), '--root', str(self.root / 'state'), action],
                             input=json.dumps(data), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             universal_newlines=True, timeout=30,
                             env=dict(os.environ, SSH_MCP_TEST_CLOCK=str(float(clock))))
        self.assertEqual(run.returncode, 0, run.stderr)
        return json.loads(base64.b64decode(run.stdout.split(' ', 1)[1]))

    def write_fixed_lines(self, path, total_lines, line_bytes=64):
        """Write fixed-width ASCII lines and return the line-content oracle."""
        def line(index):
            prefix = 'L%06d ' % index
            return prefix + 'x' * (line_bytes - len(prefix) - 1) + '\n'
        with open(str(path), 'wb') as stream:
            batch = []
            for index in range(1, total_lines + 1):
                batch.append(line(index).encode('ascii'))
                if len(batch) >= 4096:
                    stream.write(b''.join(batch))
                    batch = []
            if batch:
                stream.write(b''.join(batch))
        return line

    def vm_rss_kb(self):
        with open('/proc/self/status') as stream:
            for row in stream:
                if row.startswith('VmRSS:'):
                    return int(row.split()[1])
        self.skipTest('VmRSS is unavailable on this platform')

    def read_rejects(self, service, request, code):
        try:
            service.read(request)
        except self.helper_module().AgentError as error:
            self.assertEqual(error.code, code, request)
            return error
        self.fail('Expected {} from {!r}'.format(code, request))

    def prefix_lines(self, line_of, upto, first_index=1):
        """Oracle for the first `upto` bytes of generated lines."""
        parts, index, remaining = [], first_index, upto
        while remaining > 0:
            row = line_of(index).encode('ascii')
            parts.append(row[:remaining])
            remaining -= len(row)
            index += 1
        return b''.join(parts).decode('ascii')

    def test_streamed_read_pages_large_files_with_byte_cursor(self):
        size = 64 * 1024 * 1024
        line_of = self.write_fixed_lines(self.work / 'large.txt', size // 64)
        service = self.service()
        first = service.read({'path': 'large.txt', 'offset': 0, 'maxBytes': 65536})
        self.assertEqual(first['startOffset'], 0)
        self.assertLessEqual(first['endOffset'], 65536 - 8192)  # serialized budget applies
        self.assertTrue(first['truncated'])
        self.assertEqual(first['nextOffset'], first['endOffset'])
        self.assertEqual(first['text'], self.prefix_lines(line_of, first['endOffset']))
        self.assertLessEqual(len(json.dumps(first, ensure_ascii=False).encode('utf8')), 65536)
        version = first['version']
        tokens = {first['readToken']}
        # Sampling pages across the file all continue the same version and
        # credential, and land exactly on the generated bytes.
        for offset in (size // 4, size // 2, size - 65536):
            page = service.read({'path': 'large.txt', 'offset': offset, 'maxBytes': 65536})
            self.assertEqual(page['version'], version)
            tokens.add(page['readToken'])
            delivered = page['endOffset'] - page['startOffset']
            self.assertEqual(page['text'], self.prefix_lines(line_of, delivered, offset // 64 + 1))
            if offset + delivered < size:
                self.assertEqual(page['nextOffset'], offset + delivered)
                self.assertTrue(page['truncated'])
            else:
                self.assertIsNone(page['nextOffset'])
                self.assertFalse(page['truncated'])
        self.assertEqual(len(tokens), 1)
        # The public CLI entry behaves identically on first and last pages.
        tail = self.call('file_read', {'path': 'large.txt', 'offset': size - 192, 'maxBytes': 192})['result']
        self.assertFalse(tail['truncated'])
        self.assertIsNone(tail['nextOffset'])
        self.assertEqual(tail['text'], ''.join(line_of(size // 64 - index) for index in (2, 1, 0)))

    def test_line_requests_scan_to_boundaries_without_transmitting_the_prefix(self):
        size = 64 * 1024 * 1024
        total = size // 64
        line_of = self.write_fixed_lines(self.work / 'lines.txt', total)
        service = self.service()
        middle = service.read({'path': 'lines.txt', 'fromLine': 500000, 'toLine': 500002})
        self.assertEqual(middle['text'], ''.join(line_of(index) for index in range(500000, 500003)))
        self.assertEqual((middle['startOffset'], middle['endOffset']), ((500000 - 1) * 64, 500002 * 64))
        self.assertEqual((middle['lineStart'], middle['lineEnd'], middle['lineEndComplete']), (500000, 500002, True))
        self.assertFalse(middle['truncated'])
        self.assertNotIn('x' * 64, middle['text'][:63])
        # toLine omitted means through the end of the file; the budget still
        # bounds what is delivered.
        tail = service.read({'path': 'lines.txt', 'fromLine': total - 3})
        self.assertEqual((tail['lineStart'], tail['lineEnd'], tail['lineEndComplete']), (total - 3, total, True))
        self.assertFalse(tail['truncated'])
        self.assertEqual(tail['text'], ''.join(line_of(index) for index in range(total - 3, total + 1)))
        # A budget-constrained middle window reports the partial last line.
        window = service.read({'path': 'lines.txt', 'fromLine': 10, 'maxBytes': 100})
        self.assertEqual(window['lineStart'], 10)
        self.assertTrue(window['truncated'])
        self.assertEqual(len(window['text'].encode('utf8')), 100)
        self.assertEqual(window['lineEnd'], 11)
        self.assertFalse(window['lineEndComplete'])
        self.assertEqual(window['text'], line_of(10) + line_of(11)[:36])

    def test_overlong_line_chunks_report_line_metadata_and_resume(self):
        head = b'short\n' + '中文行\n'.encode('utf8')
        giant = 'y' * (5 * 1024 * 1024)
        body = head + giant.encode('ascii') + b'\nend\n'
        (self.work / 'tenant.txt').write_bytes(body)
        service = self.service()
        page = service.read({'path': 'tenant.txt', 'fromLine': 3, 'toLine': 3})
        self.assertEqual(page['startOffset'], len(head))
        self.assertTrue(page['truncated'])
        self.assertEqual((page['lineStart'], page['lineEnd'], page['lineEndComplete']), (3, 3, False))
        self.assertTrue(page['text'])  # the chunk is nonempty
        self.assertTrue(set(page['text']) <= {'y'})  # only giant-line bytes
        delivered = page['text'].encode('utf8')
        offset = page['nextOffset']
        pages = 1
        while offset is not None:
            page = service.read({'path': 'tenant.txt', 'offset': offset, 'maxBytes': 1048576})
            delivered += page['text'].encode('utf8')
            offset = page['nextOffset']
            pages += 1
        self.assertGreater(pages, 10)  # the single line really was chunked
        # Byte-cursor pages run to end of file, so the whole tail arrived.
        self.assertEqual(delivered, giant.encode('ascii') + b'\nend\n')
        self.assertFalse(page['complete'])  # lines 1-2 were never read
        end = service.read({'path': 'tenant.txt', 'fromLine': 4, 'toLine': 4})
        self.assertEqual((end['text'], end['lineStart'], end['lineEndComplete']), ('end\n', 4, True))
        token = service.read({'path': 'tenant.txt', 'fromLine': 4, 'toLine': 4})['readToken']
        edited = self.call('file_edit', {'path': 'tenant.txt', 'readToken': token,
                                         'edits': [{'oldText': 'end', 'newText': 'END'}]})
        self.assertTrue(edited['ok'], edited)
        denied = self.call('file_edit', {'path': 'tenant.txt', 'readToken': token,
                                         'edits': [{'oldText': 'short', 'newText': 'lost'}]})
        self.assertEqual(denied['error']['code'], 'FILE_CONFLICT')  # token rotated after the edit

    def test_utf8_pages_never_split_multibyte_characters(self):
        row = ('结' * 20 + '\n').encode('utf8')
        (self.work / 'wide.txt').write_bytes(row * 20000)
        service = self.service()
        offset, parts = 0, []
        while True:
            page = service.read({'path': 'wide.txt', 'offset': offset, 'maxBytes': 100000})
            self.assertEqual(len(page['text'].encode('utf8')), page['endOffset'] - page['startOffset'])
            parts.append(page['text'])
            offset = page['nextOffset']
            if offset is None:
                break
        self.assertEqual(''.join(parts), (row * 20000).decode('utf8'))
        # BOM bytes are skipped for text but counted as read (first-version
        # behaviour) and stay visible in the delivered payload elsewhere.
        (self.work / 'bombed.txt').write_bytes(b'\xef\xbb\xbf' + row * 200)
        first = service.read({'path': 'bombed.txt', 'offset': 0, 'maxBytes': 61})
        self.assertEqual(first['startOffset'], 3)
        self.assertTrue(first['bom'])
        self.assertEqual(first['text'], row.decode('utf8'))

    def test_invalid_utf8_window_reports_encoding_and_allows_binary(self):
        (self.work / 'mixed.txt').write_bytes(b'good line\n' + b'\xff\xfe bad\n' + b'more\n')
        head = self.call('file_read', {'path': 'mixed.txt', 'fromLine': 1, 'toLine': 1})['result']
        self.assertEqual(head['text'], 'good line\n')
        invalid = self.call('file_read', {'path': 'mixed.txt', 'fromLine': 2, 'toLine': 2})
        self.assertFalse(invalid['ok'])
        self.assertEqual(invalid['error']['code'], 'UNSUPPORTED_ENCODING')
        self.assertIn('base64', invalid['error']['message'])
        binary = self.call('file_read', {'path': 'mixed.txt', 'encoding': 'base64'})['result']
        self.assertEqual(base64.b64decode(binary['data']), b'good line\n' + b'\xff\xfe bad\n' + b'more\n')
        # Byte cursors may not land inside a multibyte UTF-8 character.
        (self.work / 'char.txt').write_bytes('a中\n'.encode('utf8'))
        split = self.call('file_read', {'path': 'char.txt', 'offset': 2})
        self.assertEqual(split['error']['code'], 'INVALID_OFFSET')
        whole = self.call('file_read', {'path': 'char.txt', 'offset': 1})['result']
        self.assertEqual(whole['text'], '中\n')

    def test_read_token_expires_after_three_idle_days_and_never_revives_ranges(self):
        (self.work / 'aging.txt').write_text('alpha\nbeta\ngamma\n')
        day = 86400.0
        start = 1000000.0
        first = self.call_at(start, 'file_read', {'path': 'aging.txt', 'fromLine': 1, 'toLine': 1})['result']
        record = json.load(open(str(self.root / 'state' / 'reads' / (first['readToken'] + '.json'))))
        self.assertEqual(record['expiresAt'] - record['lastSuccessAt'], 3 * day)
        edited = self.call_at(start + 2 * day, 'file_edit', {'path': 'aging.txt', 'readToken': first['readToken'],
                                                             'edits': [{'oldText': 'alpha', 'newText': 'ALPHA'}]})['result']
        renewed = edited['readToken']
        record = json.load(open(str(self.root / 'state' / 'reads' / (renewed + '.json'))))
        self.assertEqual(record['expiresAt'] - record['lastSuccessAt'], 3 * day)
        # Three idle days pass: the credential is dead and named as expired.
        expired = self.call_at(start + 5 * day + 60, 'file_edit', {'path': 'aging.txt', 'readToken': renewed,
                                                                   'edits': [{'oldText': 'ALPHA', 'newText': 'lost'}]})
        self.assertEqual(expired['error']['code'], 'READ_TOKEN_EXPIRED')
        # Failed attempts do not renew anything.
        again = self.call_at(start + 8 * day, 'file_edit', {'path': 'aging.txt', 'readToken': renewed,
                                                            'edits': [{'oldText': 'ALPHA', 'newText': 'lost'}]})
        self.assertEqual(again['error']['code'], 'READ_TOKEN_EXPIRED')
        # A fresh read of one line builds a new credential without reviving
        # the ranges of the expired one.
        fresh = self.call_at(start + 8 * day, 'file_read', {'path': 'aging.txt', 'fromLine': 3, 'toLine': 3})['result']
        self.assertNotEqual(fresh['readToken'], renewed)
        blocked = self.call_at(start + 8 * day, 'file_edit', {'path': 'aging.txt', 'readToken': fresh['readToken'],
                                                              'edits': [{'oldText': 'ALPHA', 'newText': 'lost'}]})
        self.assertEqual(blocked['error']['code'], 'READ_REQUIRED')
        allowed = self.call_at(start + 8 * day, 'file_edit', {'path': 'aging.txt', 'readToken': fresh['readToken'],
                                                              'edits': [{'oldText': 'gamma', 'newText': 'GAMMA'}]})
        self.assertTrue(allowed['ok'], allowed)

    def test_external_change_rejects_stale_cursor_and_old_credentials(self):
        (self.work / 'moving.txt').write_text('page one\npage two\n')
        service = self.service()
        first = service.read({'path': 'moving.txt', 'offset': 0, 'maxBytes': 8})
        self.assertEqual(first['text'], 'page one')
        (self.work / 'moving.txt').write_text('page one\nREPLACED\n')
        self.read_rejects(service, {'path': 'moving.txt', 'offset': first['nextOffset'],
                                    'expectedVersion': first['version']}, 'FILE_CONFLICT')
        # Without an expectation the new version is simply observed; the old
        # credential does not silently extend into the new version.
        resumed = service.read({'path': 'moving.txt', 'offset': first['nextOffset']})
        self.assertEqual(resumed['text'], '\nREPLACED\n')
        self.assertNotEqual(resumed['version'], first['version'])
        conflict = self.call('file_edit', {'path': 'moving.txt', 'readToken': first['readToken'],
                                           'edits': [{'oldText': 'REPLACED', 'newText': 'lost'}]})
        self.assertEqual(conflict['error']['code'], 'FILE_CONFLICT')
        # Continuing with the fresh version's own cursor stays consistent.
        pinned = service.read({'path': 'moving.txt', 'offset': 0, 'maxBytes': 8, 'expectedVersion': resumed['version']})
        self.assertEqual(pinned['text'], 'page one')
        # A cursor bound to the new version is rejected once it changes again.
        (self.work / 'moving.txt').write_text('page one\nFINAL\n')
        self.read_rejects(service, {'path': 'moving.txt', 'offset': 0,
                                    'expectedVersion': resumed['version']}, 'FILE_CONFLICT')

    def test_streamed_reads_keep_helper_memory_bounded(self):
        size = 64 * 1024 * 1024
        self.write_fixed_lines(self.work / 'rss.txt', size // 64)
        service = self.service()
        base = self.vm_rss_kb()
        peak = base
        offset, pages, delivered = 0, 0, 0
        while offset is not None and pages < 40:
            page = service.read({'path': 'rss.txt', 'offset': offset, 'maxBytes': 1048576})
            delivered += len(page['text'].encode('utf8'))
            peak = max(peak, self.vm_rss_kb())
            offset = page['nextOffset']
            pages += 1
        self.assertEqual(pages, 40)
        self.assertGreater(delivered, 40 * 32768)  # real content streamed out
        # Scanning to a middle line must stream too, not buffer the prefix.
        before = self.vm_rss_kb()
        service.read({'path': 'rss.txt', 'fromLine': 1000000, 'toLine': 1000000})
        after = self.vm_rss_kb()
        self.assertLess(peak - base, 16 * 1024)
        self.assertLess(after - before, 16 * 1024)

    def test_200mib_file_reads_first_middle_and_last_with_cursor_continuation(self):
        size = 200 * 1024 * 1024
        line_of = self.write_fixed_lines(self.work / 'netlist.txt', size // 64)
        service = self.service()
        base = self.vm_rss_kb()
        for offset in (0, size // 2, size - 3 * 64):
            page = service.read({'path': 'netlist.txt', 'offset': offset, 'maxBytes': 192})
            expected = ''.join(line_of(index) for index in range(offset // 64 + 1, offset // 64 + 4))
            self.assertEqual(page['text'], expected)
            self.assertEqual(page['version'][:3], 'm1-')
        middle = service.read({'path': 'netlist.txt', 'offset': size // 2, 'maxBytes': 64})
        continuation = service.read({'path': 'netlist.txt', 'offset': middle['nextOffset'], 'maxBytes': 64,
                                     'expectedVersion': middle['version']})
        self.assertEqual(continuation['text'], line_of(size // 128 + 2))
        row = service.read({'path': 'netlist.txt', 'fromLine': size // 128 + 10, 'toLine': size // 128 + 10})
        self.assertEqual(row['text'], line_of(size // 128 + 10))
        self.assertLessEqual(self.vm_rss_kb() - base, 16 * 1024)


if __name__ == '__main__':
    unittest.main(verbosity=2)
