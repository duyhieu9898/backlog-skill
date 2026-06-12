import unittest
import sys
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from workflows import guidance


WORKFLOW = {
    "issue_type": "Bug",
    "status": "Resolved",
    "estimated_hours": 1,
    "actual_hours": 1,
    "due_in_days": 2,
    "qc_activity": "Integration Test",
    "cause_category": "Not Applicable",
    "bug_origin": "FUN_Incomplete Function",
    "impacted": "no",
    "resolution": "fixed",
}


class GuidanceTest(unittest.TestCase):
    def setUp(self):
        mock.patch.object(guidance, "load_workflow_config", return_value=WORKFLOW).start()
        self.addCleanup(mock.patch.stopall)

    def test_resolve_rules_sourced_from_config(self):
        rules = guidance.resolve_rules()

        self.assertIn("Resolved", rules["actions"][0])
        self.assertEqual("Integration Test", rules["defaults"]["qc_activity"])
        self.assertIn("impacted", rules["alwaysOverwrite"])
        self.assertIn("corrective_action", rules["alwaysOverwrite"])

    def test_field_guidance_lists_fields_when_no_arg(self):
        result = guidance.field_guidance()

        self.assertIn("qc_activity", result["fields"])
        self.assertIn("bug_origin", result["fields"])

    def test_field_guidance_returns_options_for_known_field(self):
        result = guidance.field_guidance("bug_origin")

        self.assertEqual("bug_origin", result["field"])
        self.assertIn("UI_Layout", result["options"])

    def test_field_guidance_rejects_unknown_field(self):
        with self.assertRaises(ValueError):
            guidance.field_guidance("nope")


if __name__ == "__main__":
    unittest.main()
