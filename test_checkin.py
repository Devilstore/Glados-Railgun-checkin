import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from checkin import API, Checker, CheckinResult, CheckinStatus, Config, main


class CheckinTests(unittest.TestCase):
    def checker(self, count, outcomes):
        checker = Checker(SimpleNamespace(cookies_list=['fake'] * count))
        checker.results = [CheckinResult(i, domain, code=code) for i, domain, code in outcomes]
        return checker

    def test_all_domains_reject_cookie(self):
        checker = self.checker(1, [(1, 'glados.cloud', CheckinStatus.FAILURE),
                                   (1, 'railgun.info', CheckinStatus.FAILURE)])
        self.assertEqual(checker.exit_code(), 1)

    def test_one_domain_success_or_repeat_is_enough(self):
        for code in [CheckinStatus.SUCCESS, CheckinStatus.REPEAT]:
            with self.subTest(code=code):
                checker = self.checker(1, [(1, 'glados.cloud', CheckinStatus.FAILURE),
                                           (1, 'railgun.info', code)])
                self.assertEqual(checker.exit_code(), 0)

    def test_each_cookie_must_succeed(self):
        checker = self.checker(2, [(1, 'glados.cloud', CheckinStatus.SUCCESS),
                                   (2, 'glados.cloud', CheckinStatus.FAILURE)])
        self.assertEqual(checker.exit_code(), 1)
        checker.results.append(CheckinResult(2, 'railgun.info', code=CheckinStatus.REPEAT))
        self.assertEqual(checker.exit_code(), 0)

    def test_no_results_is_failure(self):
        self.assertEqual(self.checker(1, []).exit_code(), 1)
        self.assertEqual(self.checker(0, []).exit_code(), 1)

    def test_auth_error_has_actionable_diagnostic(self):
        with API('glados.cloud') as api, self.assertLogs(level='ERROR') as logs:
            result = api._parse_checkin({'code': -2, 'message': '没有权限'})
        self.assertEqual(result['code'], CheckinStatus.FAILURE)
        self.assertIn('GLADOS_COOKIES', logs.output[0])
        self.assertIn('gld:sess', logs.output[0])

    @patch.dict(os.environ, {}, clear=True)
    def test_missing_cookie_fails(self):
        self.assertEqual(main(), 1)

    @patch('checkin.Config', side_effect=ValueError('invalid config'))
    def test_config_failure_returns_failure(self, config):
        self.assertEqual(main(), 1)

    @patch.dict(os.environ, {'GLADOS_COOKIES': 'dummy', 'GLADOS_VERBOSE': ''}, clear=True)
    def test_empty_verbose_uses_default(self):
        self.assertFalse(Config().verbose)

    @patch.dict(os.environ, {'GLADOS_COOKIES': 'dummy'}, clear=True)
    @patch.object(Checker, 'format_results', side_effect=RuntimeError('format failed'))
    @patch.object(Checker, 'exit_code', return_value=0)
    @patch.object(Checker, 'checkin_all')
    def test_exception_after_success_is_failure(self, check_all, exit_code, format_results):
        self.assertEqual(main(), 1)

    @patch.dict(os.environ, {'GLADOS_COOKIES': 'dummy'}, clear=True)
    def test_main_propagates_business_result_without_network(self):
        for code, expected in [(CheckinStatus.FAILURE, 1), (CheckinStatus.SUCCESS, 0),
                               (CheckinStatus.REPEAT, 0)]:
            with self.subTest(code=code), patch.object(Checker, '_checkin_on_domain',
                    side_effect=lambda cookie, idx, domain: CheckinResult(idx, domain, code=code)):
                self.assertEqual(main(), expected)


if __name__ == '__main__':
    unittest.main()
