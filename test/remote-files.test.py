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

    def call(self, action, request):
        data = dict(request, workspaceRoot=str(self.work), sessionId='session-one')
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


if __name__ == '__main__':
    unittest.main(verbosity=2)
