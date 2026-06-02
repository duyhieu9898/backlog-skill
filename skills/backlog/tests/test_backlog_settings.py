import os
import tempfile
import unittest
from unittest import mock

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from backlog_tool import settings as backlog_settings
from workflows import ut_bug


class BacklogSettingsTest(unittest.TestCase):
    def test_merge_bug_defaults_applies_project_override_and_keeps_custom_fields(self):
        workflow = {
                "issue_type": "Bug",
                "custom_fields": {
                    "qc_activity": "Unit Test",
                    "env": "DEV",
                },
            "project_overrides": {
                "OOP": {
                        "category": "112_DHP",
                        "custom_fields": {
                            "env": "STG",
                            "impacted": "no",
                        },
                },
            },
        }

        with mock.patch.object(ut_bug, "load_workflow_config", return_value=workflow):
            merged = ut_bug.merge_bug_defaults({}, "OOP")

        self.assertEqual("Bug", merged["issue_type"])
        self.assertEqual("112_DHP", merged["category"])
        self.assertEqual(
            {
                "qc_activity": "Unit Test",
                "env": "STG",
                "impacted": "no",
            },
            merged["custom_fields"],
        )

    def test_resolve_project_key_rejects_unknown_project(self):
        config = {
            "base_url": "https://example.backlog.com",
            "default_project_key": "AQM",
            "projects": ["AQM", "OOP"],
        }

        with self.assertRaisesRegex(ValueError, "Unknown Backlog project"):
            backlog_settings.resolve_project_key(config, "NOPE")

    def test_log_event_writes_timestamped_redacted_shape_without_newline_leak(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            old_log_dir = backlog_settings.LOG_DIR
            old_log_path = backlog_settings.LOG_PATH
            try:
                backlog_settings.LOG_DIR = tmp_dir
                backlog_settings.LOG_PATH = os.path.join(tmp_dir, "backlog.log")

                backlog_settings.log_event(
                    "info",
                    "api",
                    method="GET",
                    path="/issues",
                    body="line one\nline two",
                )

                content = Path(backlog_settings.LOG_PATH).read_text(encoding="utf-8")
            finally:
                backlog_settings.LOG_DIR = old_log_dir
                backlog_settings.LOG_PATH = old_log_path

        self.assertIn("INFO event=api", content)
        self.assertIn('method="GET"', content)
        self.assertIn('path="/issues"', content)
        self.assertIn("line one\\\\nline two", content)
        self.assertEqual(1, len(content.splitlines()))


if __name__ == "__main__":
    unittest.main()
