import io
import unittest
from contextlib import redirect_stdout
from unittest import mock

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

import backlog_config


class BacklogConfigTest(unittest.TestCase):
    def test_print_projects_marks_default_and_missing_catalog(self):
        config = {
            "default_project_key": "AQM",
            "projects": ["OOP", "AQM"],
        }

        def fake_load_project_catalog(project_key):
            if project_key == "OOP":
                return {"id": 82531, "name": "Osaka"}
            raise ValueError("missing")

        output = io.StringIO()
        with mock.patch.object(
            backlog_config,
            "load_project_catalog",
            side_effect=fake_load_project_catalog,
        ), redirect_stdout(output):
            backlog_config.print_projects(config)

        text = output.getvalue()
        self.assertIn("  OOP id=82531 name=Osaka", text)
        self.assertIn("* AQM id=- name=(missing catalog)", text)

    def test_set_default_updates_only_known_project(self):
        config = {
            "base_url": "https://example.backlog.com",
            "default_project_key": "AQM",
            "projects": ["AQM", "OOP"],
        }

        with mock.patch.object(backlog_config, "load_config", return_value=config), mock.patch.object(
            backlog_config,
            "save_config",
        ) as save_config, mock.patch.object(backlog_config, "log_event"), redirect_stdout(io.StringIO()):
            backlog_config.set_default("OOP")

        self.assertEqual("OOP", config["default_project_key"])
        save_config.assert_called_once_with(config)

    def test_set_default_rejects_unknown_project(self):
        config = {
            "default_project_key": "AQM",
            "projects": ["AQM"],
        }

        with mock.patch.object(backlog_config, "load_config", return_value=config), self.assertRaisesRegex(
            ValueError,
            "Unknown project",
        ):
            backlog_config.set_default("OOP")


if __name__ == "__main__":
    unittest.main()
