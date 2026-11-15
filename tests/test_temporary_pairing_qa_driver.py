import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import unittest
from unittest import mock


spec = importlib.util.spec_from_file_location(
    "pairing_qa_driver", Path(__file__).resolve().parents[1] / "scripts/qa-temporary-pairing-replacement.py")
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


class TemporaryPairingQaDriverTest(unittest.TestCase):
    paths = dict(node_path=r"C:\Program Files\Ragent\payload\node.exe",
                 cli_path=r"C:\Program Files\Ragent\payload\cli.js",
                 config_dir=r"C:\ProgramData\Ragent\instances\owner\config")

    def test_windows_owner_uses_installed_cli_service_context_and_stdin_body(self):
        result = subprocess.CompletedProcess([], 0, b'{"status":"ready"}', b'')
        with mock.patch.object(driver.subprocess, "run", return_value=result) as run:
            self.assertEqual({"status": "ready"}, driver.windows_owner_json(
                "POST", driver.API, {"claimTtlMs": 120000}, **self.paths))
        args, kwargs = run.call_args
        self.assertEqual([self.paths["node_path"], self.paths["cli_path"], "api", "POST", driver.API,
                          "--body", "-"], args[0])
        self.assertEqual({"claimTtlMs": 120000}, json.loads(kwargs["input"]))
        self.assertEqual("1", kwargs["env"]["RAGENT_WINDOWS_SERVICE_MODE"])
        self.assertEqual(r"C:\ProgramData\Ragent\instances\owner", kwargs["env"]["RAGENT_INSTANCE_ROOT"])
        self.assertEqual("http://127.0.0.1:7690", kwargs["env"]["RAGENT_CHAT_BASE_URL"])
        self.assertEqual("", kwargs["env"]["RAGENT_RUN_SPOOL_DIR"])
        self.assertNotIn("shell", kwargs)

    def test_windows_permission_denial_reports_required_access_without_raw_credentials(self):
        result = subprocess.CompletedProcess([], 1, b'', b'connect EPERM pipe; private-credential-fixture')
        with mock.patch.object(driver.subprocess, "run", return_value=result):
            with self.assertRaises(RuntimeError) as raised:
                driver.windows_owner_json("GET", driver.API, **self.paths)
        self.assertIn("authorized administrator terminal", str(raised.exception))
        self.assertNotIn("private-credential-fixture", str(raised.exception))

    def test_invalid_cli_json_does_not_echo_stdout(self):
        result = subprocess.CompletedProcess([], 0, b'private-ticket-fixture', b'')
        with mock.patch.object(driver.subprocess, "run", return_value=result):
            with self.assertRaisesRegex(RuntimeError, "returned invalid JSON") as raised:
                driver.windows_owner_json("GET", driver.API, **self.paths)
        self.assertNotIn("private-ticket-fixture", str(raised.exception))

    def test_failed_owner_preflight_never_touches_android_or_prompts_for_ssh_password(self):
        with mock.patch.object(driver, "windows_owner_json", side_effect=[
                {"status": "ready"}, RuntimeError("access denied")]), \
                mock.patch.object(driver, "adb") as adb, \
                mock.patch.object(driver.getpass, "getpass") as password:
            with self.assertRaisesRegex(RuntimeError, "access denied"):
                driver.main(["--windows-local", "--serial", "explicit-device", "--mode", "files"])
        adb.assert_not_called()
        password.assert_not_called()

    def test_readonly_check_does_not_create_invites_or_touch_android(self):
        with mock.patch.object(driver, "windows_owner_json", side_effect=[
                {"status": "ready"}, {"invitations": []}]) as owner, \
                mock.patch.object(driver, "adb") as adb, contextlib.redirect_stdout(io.StringIO()):
            driver.main(["--windows-local", "--check-active"])
        self.assertEqual([("GET", "/healthz"), ("GET", driver.API)],
                         [call.args[:2] for call in owner.call_args_list])
        adb.assert_not_called()

    def file_flow(self, android_success, file_bytes=None):
        output, errors = io.StringIO(), io.StringIO()
        staged = []

        def owner(method, path, body=None, **kwargs):
            if path == "/healthz":
                return {"status": "ready"}
            if method == "POST" and path == driver.API:
                return {"invitation": {"envelope": {"invitation": {"invitationId": "inv-fixture"}},
                                       "token": "private-ticket-fixture"}}
            if method == "POST" and path == driver.API + "/inv-fixture/revoke":
                return {"invitation": {"status": "REVOKED"}}
            if method == "GET" and path == driver.API:
                return {"invitations": [{"invitationId": "inv-fixture", "status": "REVOKED",
                                         "delivery": {"revocationConfirmed": True}}]}
            self.fail("Unexpected Owner API call")

        def adb(serial, *args, **kwargs):
            self.assertEqual("explicit-device", serial)
            if kwargs.get("input_bytes"):
                staged.append(json.loads(kwargs["input_bytes"]))
            if "instrument" in args:
                return b'OK (1 test)' if android_success else b'FAILURES!!!'
            return b''

        with mock.patch.object(driver, "windows_owner_json", side_effect=owner) as owner_mock, \
                mock.patch.object(driver, "adb", side_effect=adb) as adb_mock, \
                mock.patch.object(driver, "observe_android_test", return_value=([], [], [])), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            argv = ["--windows-local", "--serial", "explicit-device", "--mode", "files"]
            if file_bytes is not None:
                argv += ["--file-bytes", str(file_bytes)]
            if android_success:
                driver.main(argv)
            else:
                with self.assertRaisesRegex(RuntimeError, "Android files test did not pass"):
                    driver.main(argv)
        self.assertEqual(1, len(staged))
        self.assertEqual("private-ticket-fixture", staged[0]["token"])
        self.assertNotIn("private-ticket-fixture", output.getvalue() + errors.getvalue())
        self.assertIn("Windows broker revocation confirmed", output.getvalue())
        self.assertTrue(any(call.args[:2] == ("POST", driver.API + "/inv-fixture/revoke")
                            for call in owner_mock.call_args_list))
        instrument = next(call.args for call in adb_mock.call_args_list if "instrument" in call.args)
        self.assertIn("liveTemporaryPairingFiles", instrument)
        self.assertIn("liveTemporaryPairingSystemChooser", instrument)
        if file_bytes is not None:
            self.assertIn("liveTemporaryPairingFileBytes", instrument)
            self.assertIn(str(file_bytes), instrument)
        else:
            self.assertNotIn("liveTemporaryPairingFileBytes", instrument)
        self.assertEqual(("explicit-device", "shell", "rm", "-f", *driver.STAGED),
                         adb_mock.call_args_list[-1].args)

    def test_successful_windows_files_flow_checks_broker_revocation(self):
        self.file_flow(True)

    def test_android_failure_still_revokes_original_windows_invitation(self):
        self.file_flow(False)

    def test_large_file_flow_passes_exact_requested_size_to_instrumentation(self):
        self.file_flow(True, file_bytes=400000)


if __name__ == "__main__":
    unittest.main()
