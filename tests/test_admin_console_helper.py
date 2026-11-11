import importlib.util
import pathlib
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch


HELPER_PATH = pathlib.Path(__file__).resolve().parents[1] / "infrastructure" / "admin-console" / "helper.py"
SPEC = importlib.util.spec_from_file_location("agentoc_admin_helper", HELPER_PATH)
HELPER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HELPER)


class AdminHelperValidationTests(unittest.TestCase):
    def test_env_parser_keeps_equals_in_secret_and_ignores_comments(self):
        parsed = HELPER.parse_env_text("# private\nOPENAI_API_KEY=sk-test=part\nPORT=7700\n")
        self.assertEqual(parsed["OPENAI_API_KEY"], "sk-test=part")
        self.assertEqual(parsed["PORT"], "7700")
        self.assertNotIn("# private", parsed)

    def test_env_replace_updates_only_target_and_preserves_other_entries(self):
        source = "PORT=7700\n# keep this\nOPENAI_API_KEY=old-value\n"
        updated = HELPER.replace_env_value_text(source, "OPENAI_API_KEY", "new-value")
        self.assertEqual(updated, "PORT=7700\n# keep this\nOPENAI_API_KEY=new-value\n")
        added = HELPER.replace_env_value_text(source, "AGENTOC_ACCOUNTS_ASR_ENABLED", "0")
        self.assertTrue(added.endswith("AGENTOC_ACCOUNTS_ASR_ENABLED=0\n"))

    def test_env_replace_rejects_line_injection_and_duplicate_target(self):
        with self.assertRaises(HELPER.AdminError):
            HELPER.replace_env_value_text("PORT=7700\n", "OPENAI_API_KEY", "safe\nPORT=1")
        with self.assertRaises(HELPER.AdminError):
            HELPER.replace_env_value_text("OPENAI_API_KEY=one\nOPENAI_API_KEY=two\n", "OPENAI_API_KEY", "new")

    def test_fcm_service_account_validation(self):
        self.assertTrue(HELPER.validate_fcm_document({
            "type": "service_account",
            "project_id": "ragent-test",
            "client_email": "push@example.com",
            "token_uri": "https://oauth2.googleapis.com/token",
            "private_key": "-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----",
        }))
        self.assertFalse(HELPER.validate_fcm_document({"type": "authorized_user"}))

    def test_systemd_status_reports_missing_unit_file_for_orphan_detection(self):
        result = SimpleNamespace(
            returncode=0,
            stdout=(
                b"ActiveState=active\nSubState=running\nMainPID=1234\n"
                b"ActiveEnterTimestamp=Tue 2026-11-10 12:00:00 UTC\nFragmentPath=\n"
            ),
        )
        with patch.object(HELPER, "_run", return_value=result):
            status = HELPER._systemd_status("agentoc-connectivity-gateway.service")
        self.assertTrue(status["active"])
        self.assertEqual(status["pid"], 1234)
        self.assertIsNone(status["fragmentPath"])

    def test_systemd_status_exposes_numeric_resource_counters(self):
        result = SimpleNamespace(
            returncode=0,
            stdout=(
                b"ActiveState=active\nSubState=running\nMainPID=1234\n"
                b"ActiveEnterTimestamp=Tue 2026-11-10 12:00:00 UTC\nFragmentPath=/etc/systemd/system/test.service\n"
                b"MemoryCurrent=1048576\nCPUUsageNSec=2500000000\nTasksCurrent=7\nNRestarts=2\n"
            ),
        )
        with patch.object(HELPER, "_run", return_value=result):
            status = HELPER._systemd_status("test.service")
        self.assertEqual(status["memoryBytes"], 1048576)
        self.assertEqual(status["cpuUsageNs"], 2500000000)
        self.assertEqual(status["tasks"], 7)
        self.assertEqual(status["restartCount"], 2)

    def test_docker_memory_values_are_normalized_to_bytes(self):
        self.assertEqual(HELPER._parse_docker_bytes("1.5MiB"), 1572864)
        self.assertEqual(HELPER._parse_docker_bytes("2 GB"), 2000000000)
        self.assertIsNone(HELPER._parse_docker_bytes("unlimited"))

    def test_diagnostics_are_read_only_and_mark_real_delivery_checks_skipped(self):
        env = {
            "AGENTOC_ACCOUNTS_HOST": "127.0.0.1", "PORT": "7700",
            "AGENTOC_TURN_BROKER_HOST": "127.0.0.1", "AGENTOC_TURN_BROKER_PORT": "7710",
        }

        def fake_http(_host, _port, route):
            if route == "/readyz": return 200, {"status": "ready"}
            if route.endswith("jwks.json"): return 200, {"keys": [{"kid": "public-test-key"}]}
            return 200, {"ok": True}

        def fake_run(args, **_kwargs):
            return SimpleNamespace(returncode=0, stdout=b"1|active")

        with (
            patch.object(HELPER, "read_env", return_value=env),
            patch.object(HELPER, "_systemd_status", return_value={"active": True}),
            patch.object(HELPER, "_loopback_http_json", side_effect=fake_http),
            patch.object(HELPER, "_query", return_value="1"),
            patch.object(HELPER, "_run", side_effect=fake_run),
            patch.object(HELPER, "_fcm_metadata", return_value={"available": False, "configured": False}),
            patch.object(HELPER, "_secret_metadata", return_value={"items": [{"id": "openai-api-key", "configured": True}], "asrEnabled": True}),
            patch.object(HELPER, "_audit") as audit,
        ):
            result = HELPER._run_diagnostics("owner@example.com")
        statuses = {item["id"]: item["status"] for item in result["checks"]}
        self.assertEqual(statuses["accounts"], "pass")
        self.assertEqual(statuses["database"], "pass")
        self.assertEqual(statuses["fcm-delivery"], "skipped")
        self.assertEqual(statuses["asr-transcription"], "skipped")
        self.assertEqual(statuses["device-session"], "skipped")
        audit.assert_called_once()

    def test_loopback_probe_rejects_non_local_hosts(self):
        with self.assertRaises(HELPER.AdminError) as error:
            HELPER._loopback_http_json("example.com", 7700, "/readyz")
        self.assertEqual(error.exception.code, "LOCAL_ENDPOINT_NOT_ALLOWED")

    def test_metrics_history_is_bounded_and_calculates_process_cpu_delta(self):
        metrics_directory = pathlib.Path("G:/AgentoC/.tmp/admin-console")
        metrics_directory.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=metrics_directory) as directory:
            metrics_file = pathlib.Path(directory) / "metrics.json"

            def write_metrics(path, content, **_kwargs):
                pathlib.Path(path).write_text(content, encoding="utf-8")

            first_services = {"agentoc-accounts": {"memoryBytes": 1024, "cpuUsageNs": 1_000_000_000, "tasks": 3, "restartCount": 0}}
            second_services = {"agentoc-accounts": {"memoryBytes": 2048, "cpuUsageNs": 3_000_000_000, "tasks": 4, "restartCount": 0}}
            with (
                patch.object(HELPER, "METRICS_FILE", metrics_file),
                patch.object(HELPER, "atomic_write", side_effect=write_metrics),
                patch.object(HELPER, "_host_metrics", return_value={"memoryTotalBytes": 4096}),
            ):
                first = HELPER._record_metrics(first_services, {}, now_epoch=1_000)
                second = HELPER._record_metrics(second_services, {}, now_epoch=1_060)
            self.assertEqual(len(first["history"]), 1)
            self.assertEqual(len(second["history"]), 2)
            self.assertAlmostEqual(second["history"][-1]["services"]["agentoc-accounts"]["cpuPercent"], 3.33, places=2)

    def test_backup_ids_are_confined_to_expected_names(self):
        self.assertTrue(HELPER.validate_backup_id("accounts-20261111T120000Z-a1b2c3d4.dump"))
        self.assertFalse(HELPER.validate_backup_id("../../etc/passwd"))
        self.assertFalse(HELPER.validate_backup_id("accounts-latest.dump"))


if __name__ == "__main__":
    unittest.main()
