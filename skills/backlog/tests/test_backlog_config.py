import argparse
import unittest
from unittest import mock

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backlog_tool import cli


class BacklogConfigTest(unittest.TestCase):
    def test_config_projects_marks_default_and_missing_catalog(self):
        config = {"default_project_key": "AQM", "projects": ["OOP", "AQM"]}

        def fake_load_project_catalog(project_key):
            if project_key == "OOP":
                return {"id": 82531, "name": "Osaka"}
            raise ValueError("missing")

        with mock.patch.object(cli, "load_project_catalog", side_effect=fake_load_project_catalog):
            rows = cli.config_projects(config)

        by_key = {row["key"]: row for row in rows}
        self.assertEqual({"key": "OOP", "id": 82531, "name": "Osaka", "default": False}, by_key["OOP"])
        self.assertEqual({"key": "AQM", "id": None, "name": "(missing catalog)", "default": True}, by_key["AQM"])

    def test_set_default_updates_only_known_project(self):
        config = {
            "base_url": "https://example.backlog.com",
            "default_project_key": "AQM",
            "projects": ["AQM", "OOP"],
        }
        args = argparse.Namespace(action="set-default", project_key="OOP")

        with mock.patch.object(cli, "save_config") as save_config, mock.patch.object(cli, "log_event"):
            result = cli.run_config(config, args)

        self.assertEqual("OOP", config["default_project_key"])
        self.assertEqual({"defaultProjectKey": "OOP", "updated": True}, result)
        save_config.assert_called_once_with(config)

    def test_set_default_rejects_unknown_project(self):
        config = {"default_project_key": "AQM", "projects": ["AQM"]}
        args = argparse.Namespace(action="set-default", project_key="OOP")

        with self.assertRaisesRegex(ValueError, "Unknown project"):
            cli.run_config(config, args)


if __name__ == "__main__":
    unittest.main()
