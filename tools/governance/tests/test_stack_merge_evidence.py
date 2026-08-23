from __future__ import annotations

import tempfile
import unittest
import sys
from pathlib import Path

GOVERNANCE_DIR = Path(__file__).resolve().parents[1]
if str(GOVERNANCE_DIR) not in sys.path:
    sys.path.insert(0, str(GOVERNANCE_DIR))

from core import validation_gate_status
from helpers import base_task, initialize_root, valid_local_pass, write_json


class StackMergeEvidenceTests(unittest.TestCase):
    def test_committed_local_evidence_survives_descendant_stack_content(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = base_task(status="IN_PROGRESS")
            initialize_root(root, task)
            governed = root / "tools" / "governance" / "stacked.py"
            governed.parent.mkdir(parents=True, exist_ok=True)
            governed.write_text("before = True\n", encoding="utf-8")
            task["validation"]["results"] = [valid_local_pass(root, task)]
            task["status"] = "COMMITTED"
            task["git"] = {"committed_sha": "a" * 40}
            write_json(root / "project-control" / "tasks" / "GOV-TEST.json", task)

            governed.write_text("before = True\ndescendant = True\n", encoding="utf-8")

            gate = validation_gate_status(root, task, "LOCAL_VERIFIED")
            self.assertEqual([], gate["missing"])
            self.assertEqual(["unit"], gate["passed"])

    def test_uncommitted_local_evidence_still_tracks_live_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = base_task(status="IN_PROGRESS")
            initialize_root(root, task)
            governed = root / "tools" / "governance" / "stacked.py"
            governed.parent.mkdir(parents=True, exist_ok=True)
            governed.write_text("before = True\n", encoding="utf-8")
            task["validation"]["results"] = [valid_local_pass(root, task)]
            task["status"] = "LOCAL_VERIFIED"
            write_json(root / "project-control" / "tasks" / "GOV-TEST.json", task)

            governed.write_text("before = False\n", encoding="utf-8")

            gate = validation_gate_status(root, task, "LOCAL_VERIFIED")
            self.assertEqual([], gate["passed"])
            self.assertIn("no longer matches", gate["missing"][0]["reason"])


if __name__ == "__main__":
    unittest.main()
