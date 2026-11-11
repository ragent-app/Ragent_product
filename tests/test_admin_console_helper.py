import importlib.util
import pathlib
import unittest


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

    def test_backup_ids_are_confined_to_expected_names(self):
        self.assertTrue(HELPER.validate_backup_id("accounts-20261111T120000Z-a1b2c3d4.dump"))
        self.assertFalse(HELPER.validate_backup_id("../../etc/passwd"))
        self.assertFalse(HELPER.validate_backup_id("accounts-latest.dump"))


if __name__ == "__main__":
    unittest.main()
