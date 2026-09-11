import base64
import json
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


if __name__ == '__main__':
    unittest.main(verbosity=2)
