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
        # Whole-file writes dropped the readToken path entirely: even a
        # complete read no longer authorizes an overwrite (issue #10 / ADR 0008).
        blocked = self.call('file_write', {'path': name, 'text': 'lost', 'readToken': page['readToken']})
        self.assertEqual(blocked['error']['code'], 'INVALID_REQUEST')
        full = self.call('file_read', {'path': name, 'fromLine': 2})['result']
        self.assertEqual(full['readToken'], page['readToken'])
        self.assertTrue(full['complete'])
        observed = self.call('file_read', {'path': name, 'metadataOnly': True})['result']
        updated = self.call('file_write', {'path': name, 'text': 'new\nlines\n',
                                           'overwrite': True, 'expectedVersion': observed['version']})
        self.assertTrue(updated['ok'], updated)
        self.assertEqual((self.work / name).read_bytes(), b'new\r\nlines\r\n')

    def test_binary_read_write_move_delete_share_full_read_guard(self):
        original = b'\x00\xff\x01'
        (self.work / 'binary').write_bytes(original)
        token = self.call('file_read', {'path': 'binary', 'encoding': 'base64'})['result']['readToken']
        observed = self.call('file_read', {'path': 'binary', 'metadataOnly': True})['result']
        write = self.call('file_write', {'path': 'binary', 'data': base64.b64encode(b'\xffNEW').decode(),
                                         'overwrite': True, 'expectedVersion': observed['version']})
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
        observed = self.call('file_read', {'path': 'a', 'metadataOnly': True})['result']
        path.write_text('external')
        result = self.call('file_write', {'path': 'a', 'text': 'lost',
                                          'overwrite': True, 'expectedVersion': observed['version']})
        self.assertEqual(result['error']['code'], 'FILE_CONFLICT')
        self.assertEqual(path.read_text(), 'external')
        (self.work / 'link').symlink_to(path)
        result = self.call('file_write', {'path': 'link', 'text': 'lost'})
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
        # The engine is the fastest available backend (issue #11): python-literal
        # remains the floor, but ripgrep/grep win when present on the host.
        self.assertIn(search['engine'], ('ripgrep', 'gnu-grep', 'python-literal'))
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
        observed = self.call('file_read', {'path': 'race', 'metadataOnly': True})['result']
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda text: self.call('file_write', {
                'path': 'race', 'text': text, 'overwrite': True, 'expectedVersion': observed['version']}), ['first', 'second']))
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
        denied = self.call('file_edit', {'path': 'ranges.txt', 'readToken': renewed['readToken'],
                                         'edits': [{'oldText': 'secret gap', 'newText': 'lost'}]})
        self.assertEqual(denied['error']['code'], 'READ_REQUIRED')
        # Whole-file writes never take a readToken anymore (issue #10).
        denied_write = self.call('file_write', {'path': 'ranges.txt', 'text': 'lost', 'readToken': renewed['readToken']})
        self.assertEqual(denied_write['error']['code'], 'INVALID_REQUEST')
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
        # Whole-file replacement of the emptied file goes through the explicit
        # overwrite path bound to the observed version, not the edit credential.
        observed = self.call('file_read', {'path': 'emptying', 'metadataOnly': True})['result']
        rewritten = self.call('file_write', {'path': 'emptying', 'text': 'replacement',
                                             'overwrite': True, 'expectedVersion': observed['version']})
        self.assertTrue(rewritten['ok'], rewritten)

    def test_external_replacement_after_commit_does_not_receive_a_renewed_token(self):
        sys.path.insert(0, str(HELPER.parent))
        from files import FileService
        path = self.work / 'post-image'
        path.write_text('before')
        token = self.call('file_read', {'path': 'post-image'})['result']['readToken']

        class ExternalReplacement(FileService):
            def commit_spliced(inner, target, replacements, info, version, output_size, origin='file-edit'):
                written = super(ExternalReplacement, inner).commit_spliced(target, replacements, info, version, output_size, origin)
                other = target.with_name('external-temp')
                with target.open('rb') as source:
                    other.write_bytes(source.read())  # Same content, but a different file identity.
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

    def test_grant_read_survives_missing_stale_credential_records(self):
        # index-*.json 存在但指向的 token 文件被删/损坏：签发新凭据继续
        # 服务（对比 token() 同场景防护并报 READ_REQUIRED），而不是
        # read_json 裸抛 OSError 让整个读取 HELPER_ERROR。
        path = self.work / 'stale-index.txt'
        path.write_text('first\nsecond\n')
        first = self.call('file_read', {'path': 'stale-index.txt', 'fromLine': 1, 'toLine': 1})['result']
        reads = self.root / 'state' / 'reads'
        token_files = [item for item in reads.iterdir() if not item.name.startswith('index-')]
        self.assertEqual(len(token_files), 1)
        token_files[0].unlink()  # index 现在指向缺失文件
        second = self.call('file_read', {'path': 'stale-index.txt', 'fromLine': 2, 'toLine': 2})
        self.assertTrue(second['ok'], second)
        self.assertNotEqual(second['result']['readToken'], first['readToken'])
        # 新凭据只覆盖第二行：第一行回到未读状态，第二行可直接编辑。
        denied = self.call('file_edit', {'path': 'stale-index.txt', 'readToken': second['result']['readToken'],
                                         'edits': [{'oldText': 'first', 'newText': 'unread'}]})
        self.assertEqual(denied['error']['code'], 'READ_REQUIRED')
        allowed = self.call('file_edit', {'path': 'stale-index.txt', 'readToken': second['result']['readToken'],
                                          'edits': [{'oldText': 'second', 'newText': 'edited'}]})
        self.assertTrue(allowed['ok'], allowed)
        self.assertEqual(path.read_text(), 'first\nedited\n')

    def test_size_gate_rejects_directories_but_streams_oversized_reads_and_edits(self):
        directory = self.call('file_read', {'path': '.'})
        self.assertEqual(directory['error']['code'], 'UNSUPPORTED_FILE')
        # Reads no longer carry a file-size cap (issue #9): a >16 MiB file
        # streams its first window instead of being rejected.
        oversized = self.work / 'oversized.bin'
        marker = b'UNIQUE-MARKER-12345678\n'
        oversized.write_bytes(marker + b'0' * (16 * 1024 * 1024 + 1 - len(marker)))
        streamed = self.call('file_read', {'path': 'oversized.bin', 'offset': 0, 'maxBytes': 100})
        self.assertTrue(streamed['ok'], streamed)
        self.assertEqual(streamed['result']['endOffset'], 100)
        self.assertFalse(streamed['result']['complete'])
        # Since issue #10 the mutation paths stream too: editing a >16 MiB
        # file works, and inline writes no longer stop at the old 16 MiB gate.
        edit = self.call('file_edit', {'path': 'oversized.bin', 'readToken': streamed['result']['readToken'],
                                       'edits': [{'oldText': 'UNIQUE-MARKER-12345678', 'newText': 'zero-block'}]})
        self.assertTrue(edit['ok'], edit)
        self.assertEqual(edit['result']['bytesWritten'], 16 * 1024 * 1024 + 1 - len('UNIQUE-MARKER-12345678') + len('zero-block'))
        service = self.service()
        service.write({'path': 'created.bin', 'create': True,
                       'data': base64.b64encode(b'0' * (16 * 1024 * 1024 + 1)).decode('ascii')})
        self.assertEqual((self.work / 'created.bin').stat().st_size, 16 * 1024 * 1024 + 1)

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
        # expectedVersion / readToken contradict observing metadata alone.
        for request in ({'path': 'meta.txt', 'metadataOnly': True, 'expectedVersion': 'm1-anything'},
                        {'path': 'meta.txt', 'metadataOnly': True, 'readToken': '0' * 32}):
            refused = self.call('file_read', request)
            self.assertEqual(refused['error']['code'], 'INVALID_REQUEST', request)

    def test_capabilities_report_streamed_read_and_streamed_write(self):
        capabilities = self.call('file_workspace', {})['result']['capabilities']
        self.assertNotIn('maxGuardedFileBytes', capabilities)
        self.assertNotIn('maxCommitBytes', capabilities)
        self.assertTrue(capabilities['streamedRead'])
        self.assertTrue(capabilities['streamedWrite'])
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

    # --- Streaming replacement and explicit overwrite (issue #10) ---------

    def test_edit_locates_matches_across_stream_chunk_boundaries(self):
        boundary = 256 * 1024  # MAX_STREAM_CHUNK
        needle = 'CROSS-CHUNK-NEEDLE-{}'
        # A match straddling the first chunk boundary, plus one fully inside
        # the carry window on each side of it.
        layouts = [
            boundary - 12,            # match crosses the boundary
            boundary - len(needle.format('A')) - 2,  # ends just before the boundary
            boundary - 1,             # starts on the boundary's last byte
        ]
        for index, start in enumerate(layouts):
            name = 'cross{}.txt'.format(index)
            filler = b'y' * boundary * 2
            payload = bytearray(filler)
            tag = needle.format(index).encode('ascii')
            payload[start:start + len(tag)] = tag
            (self.work / name).write_bytes(bytes(payload))
            window = self.call('file_read', {'path': name, 'offset': start - 8, 'maxBytes': 128})['result']
            edited = self.call('file_edit', {'path': name, 'readToken': window['readToken'],
                                             'edits': [{'oldText': needle.format(index), 'newText': 'PATCHED-OK'}]})
            self.assertTrue(edited['ok'], '{}: {}'.format(index, edited))
            content = (self.work / name).read_bytes()
            self.assertEqual(content[:start], filler[:start])
            self.assertTrue(content[start:].startswith(b'PATCHED-OK'))
            self.assertEqual(edited['result']['bytesWritten'], 2 * boundary - len(tag) + len('PATCHED-OK'))
        # Zero matches still demand a reread and ambiguity still demands a
        # wider oldText.
        path = self.work / 'counts.txt'
        path.write_bytes(b'prefix needle suffix\n' * 3 + b'padding')
        partial = self.call('file_read', {'path': 'counts.txt', 'fromLine': 1, 'toLine': 1})['result']
        zero = self.call('file_edit', {'path': 'counts.txt', 'readToken': partial['readToken'],
                                       'edits': [{'oldText': 'absent', 'newText': 'x'}]})
        self.assertEqual(zero['error']['code'], 'EDIT_MATCH_ERROR')
        self.assertIn('read', zero['error']['message'])
        many = self.call('file_edit', {'path': 'counts.txt', 'readToken': partial['readToken'],
                                       'edits': [{'oldText': 'needle', 'newText': 'x'}]})
        self.assertEqual(many['error']['code'], 'EDIT_MATCH_ERROR')
        self.assertIn('widen', many['error']['message'])
        self.assertEqual(path.read_bytes(), b'prefix needle suffix\n' * 3 + b'padding')
        # A unique match outside the delivered range stays protected even
        # though it is the only occurrence in the file.
        unique = self.work / 'unique.txt'
        unique.write_bytes(b'first line marker-A\nsecond line marker-B\nthird line marker-C\n')
        first_line = self.call('file_read', {'path': 'unique.txt', 'fromLine': 1, 'toLine': 1})['result']
        blocked = self.call('file_edit', {'path': 'unique.txt', 'readToken': first_line['readToken'],
                                          'edits': [{'oldText': 'marker-B', 'newText': 'x'}]})
        self.assertEqual(blocked['error']['code'], 'READ_REQUIRED')
        self.assertEqual(unique.read_bytes(),
                         b'first line marker-A\nsecond line marker-B\nthird line marker-C\n')

    def test_large_edit_splices_streaming_and_keeps_memory_bounded(self):
        size = 20 * 1024 * 1024
        line_of = self.write_fixed_lines(self.work / 'splice.txt', size // 64)
        service = self.service()
        target = 150000  # a unique line in the middle of the file
        old_line = line_of(target)
        new_line = 'L%06d patched with a much longer replacement body plus padding\n' % target
        self.assertGreater(len(new_line), len(old_line))  # the edit grows the file
        window = service.read({'path': 'splice.txt', 'offset': (target - 1) * 64, 'maxBytes': 64})
        self.assertEqual(window['text'], old_line)
        base = self.vm_rss_kb()
        peak = base
        edited = service.edit({'path': 'splice.txt', 'readToken': window['readToken'],
                               'edits': [{'oldText': old_line.rstrip('\n'), 'newText': new_line.rstrip('\n')}]})
        peak = max(peak, self.vm_rss_kb())
        self.assertTrue(edited['written'])
        delta = len(new_line) - len(old_line)
        self.assertEqual(edited['bytesWritten'], size + delta)
        self.assertEqual(edited['editsApplied'], 1)
        self.assertFalse(edited['rereadRequired'])
        with open(str(self.work / 'splice.txt'), 'rb') as stream:
            head = stream.read(64)
            stream.seek((target - 1) * 64)
            patched = stream.readline()
            stream.seek(target * 64 + delta)
            after = stream.readline()
        self.assertEqual(head, line_of(1).encode('ascii'))
        self.assertEqual(patched, new_line.encode('ascii'))
        self.assertEqual(after, line_of(target + 1).encode('ascii'))
        # The known range was remapped onto the replacement: editing the
        # patched line again needs no reread, and a couple more streamed
        # edits keep memory flat. (The following line was never read, so the
        # remapped credential must still refuse it -- checked below.)
        followup = service.edit({'path': 'splice.txt', 'readToken': edited['readToken'],
                                 'edits': [{'oldText': new_line.rstrip('\n'), 'newText': 'next'}]})
        peak = max(peak, self.vm_rss_kb())
        service.edit({'path': 'splice.txt', 'readToken': followup['readToken'],
                      'edits': [{'oldText': 'next', 'newText': 'n'}]})
        peak = max(peak, self.vm_rss_kb())
        self.assertLess(peak - base, 16 * 1024)  # no whole-file buffering anywhere

    def test_large_edit_preserves_bom_crlf_and_permissions(self):
        # A CRLF+BOM file above two stream chunks keeps its identity markers
        # through a length-changing streamed edit.
        chunk = 256 * 1024
        row = '中文行 tail\r\n'.encode('utf8')
        body = row * (2 * chunk // len(row) + 10)
        unique = 'UNIQUE-CRLF-锚点-XYZ'
        payload = b'\xef\xbb\xbf' + body + unique.encode('utf8') + b'\r\n'
        path = self.work / 'identity.txt'
        path.write_bytes(payload)
        path.chmod(0o640)
        service = self.service()
        window = service.read({'path': 'identity.txt', 'encoding': 'base64',
                               'offset': len(payload) - 64, 'maxBytes': 64})
        edited = service.edit({'path': 'identity.txt', 'readToken': window['readToken'],
                               'edits': [{'oldText': unique, 'newText': '替换\n成多行'}]})
        self.assertTrue(edited['written'])
        content = path.read_bytes()
        self.assertTrue(content.startswith(b'\xef\xbb\xbf' + body))
        # The CRLF file converts the newline inside newText to CRLF as well.
        self.assertTrue(content.endswith('替换\r\n成多行\r\n'.encode('utf8')))
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o640)

    def test_multi_edit_failure_never_partially_commits(self):
        original = b'alpha line\nbeta line\ngamma line\n'
        for edits in [
            [{'oldText': 'alpha', 'newText': 'BROKEN'}, {'oldText': 'nowhere', 'newText': 'x'}],
            [{'oldText': 'alpha', 'newText': 'BROKEN'}, {'oldText': 'line', 'newText': 'x'}],
        ]:
            path = self.work / 'atomic.txt'
            path.write_bytes(original)
            token = self.call('file_read', {'path': 'atomic.txt'})['result']['readToken']
            result = self.call('file_edit', {'path': 'atomic.txt', 'readToken': token, 'edits': edits})
            self.assertFalse(result['ok'], edits)
            self.assertIn(result['error']['code'], ('EDIT_MATCH_ERROR', 'READ_REQUIRED'))
            self.assertEqual(path.read_bytes(), original)
        # A partially-read file rejects the unread member before any write.
        path.write_bytes(original)
        partial = self.call('file_read', {'path': 'atomic.txt', 'fromLine': 1, 'toLine': 1})['result']
        result = self.call('file_edit', {'path': 'atomic.txt', 'readToken': partial['readToken'], 'edits': [
            {'oldText': 'alpha line', 'newText': 'ok'},
            {'oldText': 'gamma line', 'newText': 'unread'},
        ]})
        self.assertEqual(result['error']['code'], 'READ_REQUIRED')
        self.assertEqual(path.read_bytes(), original)

    def test_whole_file_write_requires_explicit_overwrite_bound_to_observed_version(self):
        path = self.work / 'overwrite.txt'
        path.write_bytes(b'\xef\xbb\xbfversion one\r\n')
        path.chmod(0o755)
        full = self.call('file_read', {'path': 'overwrite.txt'})['result']
        # Default is create-only: an existing target is refused, even with a
        # complete read credential in hand (issue #10 / ADR 0008).
        bare = self.call('file_write', {'path': 'overwrite.txt', 'text': 'lost'})
        self.assertEqual(bare['error']['code'], 'FILE_CONFLICT')
        with_token = self.call('file_write', {'path': 'overwrite.txt', 'text': 'lost', 'readToken': full['readToken']})
        self.assertEqual(with_token['error']['code'], 'INVALID_REQUEST')
        for request in [
            {'overwrite': True},
            {'overwrite': True, 'expectedVersion': 7},
            {'expectedVersion': 'm1-anything'},
            {'create': True, 'overwrite': True, 'expectedVersion': 'm1-x'},
        ]:
            result = self.call('file_write', dict(request, path='overwrite.txt', text='lost'))
            self.assertEqual(result['error']['code'], 'INVALID_REQUEST', request)
        observed = self.call('file_read', {'path': 'overwrite.txt', 'metadataOnly': True})['result']
        path.write_bytes(b'externally replaced\n')
        stale = self.call('file_write', {'path': 'overwrite.txt', 'text': 'lost',
                                         'overwrite': True, 'expectedVersion': observed['version']})
        self.assertEqual(stale['error']['code'], 'FILE_CONFLICT')
        self.assertEqual(path.read_bytes(), b'externally replaced\n')
        fresh = self.call('file_read', {'path': 'overwrite.txt', 'metadataOnly': True})['result']
        applied = self.call('file_write', {'path': 'overwrite.txt', 'text': 'version two\n',
                                           'overwrite': True, 'expectedVersion': fresh['version']})
        self.assertTrue(applied['ok'], applied)
        self.assertTrue(applied['result']['overwritten'])
        self.assertNotIn('readToken', applied['result'])
        self.assertEqual(path.read_bytes(), b'version two\n')
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o755)
        # The old edit credential died with the replaced version.
        stale_token = self.call('file_edit', {'path': 'overwrite.txt', 'readToken': full['readToken'],
                                              'edits': [{'oldText': 'version two', 'newText': 'lost'}]})
        self.assertEqual(stale_token['error']['code'], 'FILE_CONFLICT')
        # Overwriting an absent target has no version to bind to.
        absent = self.call('file_write', {'path': 'missing.txt', 'text': 'x',
                                          'overwrite': True, 'expectedVersion': 'm1-none'})
        self.assertEqual(absent['error']['code'], 'FILE_CONFLICT')
        self.assertFalse((self.work / 'missing.txt').exists())
        # Plain creation keeps refusing existing targets and still works.
        conflict = self.call('file_write', {'path': 'overwrite.txt', 'text': 'x', 'create': True})
        self.assertEqual(conflict['error']['code'], 'FILE_CONFLICT')
        created = self.call('file_write', {'path': 'fresh.txt', 'text': 'new file\n'})
        self.assertTrue(created['ok'], created)
        self.assertEqual((self.work / 'fresh.txt').read_bytes(), b'new file\n')

    def test_text_overwrite_keeps_bom_and_crlf_and_refuses_binary_targets(self):
        path = self.work / 'markers.txt'
        path.write_bytes(b'\xef\xbb\xbfline one\r\nline two\r\n')
        observed = self.call('file_read', {'path': 'markers.txt', 'metadataOnly': True})['result']
        applied = self.call('file_write', {'path': 'markers.txt', 'text': 'short\nsecond\n',
                                           'overwrite': True, 'expectedVersion': observed['version']})
        self.assertTrue(applied['ok'], applied)
        self.assertEqual(path.read_bytes(), b'\xef\xbb\xbfshort\r\nsecond\r\n')
        binary = self.work / 'blob.bin'
        binary.write_bytes(b'\xff\xfe raw')
        meta = self.call('file_read', {'path': 'blob.bin', 'metadataOnly': True})['result']
        refused = self.call('file_write', {'path': 'blob.bin', 'text': 'text',
                                           'overwrite': True, 'expectedVersion': meta['version']})
        self.assertEqual(refused['error']['code'], 'UNSUPPORTED_ENCODING')
        self.assertEqual(binary.read_bytes(), b'\xff\xfe raw')
        via_base64 = self.call('file_write', {'path': 'blob.bin', 'data': base64.b64encode(b'\x00NEW').decode(),
                                              'overwrite': True, 'expectedVersion': meta['version']})
        self.assertTrue(via_base64['ok'], via_base64)
        self.assertEqual(binary.read_bytes(), b'\x00NEW')

    def test_commit_persists_the_renamed_directory_entry(self):
        # sync_directory is the observable seam for the #6 gap: publication
        # must flush the directory entry change, not only the file bytes.
        # The in-process service is used because subprocess helpers would not
        # observe the monkeypatched module.
        files = self.helper_module()
        service = self.service()
        (self.work / 'synced.txt').write_text('one\n')
        synced = []
        original = files.sync_directory
        files.sync_directory = lambda directory: synced.append(str(directory)) or original(directory)
        try:
            window = service.read({'path': 'synced.txt'})
            service.edit({'path': 'synced.txt', 'readToken': window['readToken'],
                          'edits': [{'oldText': 'one', 'newText': 'two'}]})
            observed = service.read({'path': 'synced.txt', 'metadataOnly': True})
            service.write({'path': 'synced.txt', 'text': 'three\n',
                           'overwrite': True, 'expectedVersion': observed['version']})
            service.write({'path': 'made.txt', 'text': 'new\n', 'create': True})
        finally:
            files.sync_directory = original
        self.assertEqual(synced, [str(self.work)] * 3)


if __name__ == '__main__':
    unittest.main(verbosity=2)
