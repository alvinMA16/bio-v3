import json
from pathlib import Path
import tempfile
import unittest
from archive_run import checksum, verify, archive

class ArchiveTests(unittest.TestCase):
    def test_verification_detects_changed_file(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            data=root/'data.json'
            data.write_text('{}')
            (root/'manifest.json').write_text(json.dumps({'files':{'data.json':checksum(data)}}))
            self.assertEqual(verify(root),1)
            data.write_text('{"changed":true}')
            with self.assertRaises(ValueError):verify(root)

    def test_reject_path_traversal_id(self):
        with self.assertRaises(ValueError):archive(Path('/tmp/nonexistent'), '../escape')

if __name__=='__main__':unittest.main()
