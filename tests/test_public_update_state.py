import concurrent.futures
import importlib.util
from pathlib import Path
import tempfile
import sys
sys.dont_write_bytecode = True
import unittest

spec = importlib.util.spec_from_file_location('state', Path(__file__).resolve().parents[1] / 'skills/openclaw/scripts/skill-update-state.py')
state = importlib.util.module_from_spec(spec)
spec.loader.exec_module(state)


class StateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = Path(self.temp.name) / 'state.sqlite3'

    def call(self, action='claim', **kw):
        return state.operate(self.db, 'installation', action, **kw)

    def test_only_one_concurrent_claim(self):
        with concurrent.futures.ThreadPoolExecutor(8) as pool:
            results = list(pool.map(lambda _: self.call(now=100), range(8)))
        self.assertEqual(1, sum(r['status'] == 'claimed' for r in results))

    def test_week_boundary(self):
        token = self.call(now=100)['token']
        self.call('finish', token=token, outcome='unchanged', revision='abc', now=101)
        self.assertEqual('not_due', self.call(now=100 + state.WEEK)['status'])
        self.assertEqual('claimed', self.call(now=101 + state.WEEK)['status'])

    def test_stale_owner_cannot_finish_or_renew(self):
        token = self.call(now=100)['token']
        new = self.call(now=100 + state.LEASE)['token']
        self.assertNotEqual(token, new)
        for action in ['finish', 'renew']:
            with self.assertRaises(ValueError):
                self.call(action, token=token, outcome='updated', revision='abc', now=100 + state.LEASE)

    def test_renew(self):
        token = self.call(now=100)['token']
        self.call('renew', token=token, now=1000)
        self.assertEqual('busy', self.call(now=2000)['status'])

    def test_error_retries_earlier(self):
        token = self.call(now=100)['token']
        self.call('finish', token=token, outcome='error', now=101)
        self.assertEqual('not_due', self.call(now=3600)['status'])
        self.assertEqual('claimed', self.call(now=3701)['status'])

    def test_opt_out_revokes_owner(self):
        token = self.call(now=100)['token']
        self.call('disable', now=101)
        self.assertEqual('disabled', self.call(now=102)['status'])
        with self.assertRaises(ValueError):
            self.call('renew', token=token, now=102)
        self.call('enable', now=103)
        self.assertEqual('claimed', self.call(now=104)['status'])

    def test_separate_installations(self):
        self.call(now=100)
        self.assertEqual('claimed', state.operate(self.db, 'other', 'claim', now=100)['status'])

    def test_success_requires_revision(self):
        token = self.call(now=100)['token']
        with self.assertRaises(ValueError):
            self.call('finish', token=token, outcome='updated', now=101)
        self.assertEqual('busy', self.call(now=102)['status'])

    def offer(self):
        token = self.call(now=100)['token']
        self.call('finish', token=token, outcome='available', revision='abc', now=101)

    def test_offer_waits_without_installing_or_reprompting(self):
        self.offer()
        self.assertEqual('not_due', self.call(now=102)['status'])
        later = self.call(now=101 + state.WEEK)
        self.assertEqual('abc', later['offered_revision'])
        with self.assertRaises(ValueError):
            self.call('finish', token=later['token'], outcome='updated', revision='abc', now=102 + state.WEEK)

    def test_approval_resumes_immediately_and_only_that_revision(self):
        self.offer()
        token = self.call(approved_revision='abc', now=102)['token']
        with self.assertRaises(ValueError):
            self.call('finish', token=token, outcome='updated', revision='newer', now=103)
        self.call('finish', token=token, outcome='updated', revision='abc', now=104)
        with self.assertRaises(ValueError):
            self.call(approved_revision='abc', now=105)

    def test_unoffered_approval_cannot_bypass_schedule(self):
        with self.assertRaises(ValueError):
            self.call(approved_revision='abc', now=100)
        self.offer()
        with self.assertRaises(ValueError):
            self.call(approved_revision='newer', now=102)

    def test_approval_does_not_bypass_opt_out_or_other_owner(self):
        self.offer()
        self.call(approved_revision='abc', now=102)
        self.assertEqual('busy', self.call(approved_revision='abc', now=103)['status'])
        self.call('disable', now=104)
        self.assertEqual('disabled', self.call(approved_revision='abc', now=105)['status'])


if __name__ == '__main__':
    unittest.main()
