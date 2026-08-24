from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


GOVERNANCE_DIR = Path(__file__).resolve().parents[1]
if str(GOVERNANCE_DIR) not in sys.path:
    sys.path.insert(0, str(GOVERNANCE_DIR))

import taskctl  # noqa: E402
from core import read_json, task_path  # noqa: E402
from helpers import AuthenticatedReceiptTestCase, base_task, initialize_root, write_json  # noqa: E402
from validation_runner import RUNNER_VERSION  # noqa: E402


class ControlledTaskCtlTests(AuthenticatedReceiptTestCase):
    def _task(self, root: Path, exit_code: int = 0, status: str = "IN_PROGRESS") -> dict:
        task = base_task(status=status)
        task["validation"]["required"] = [{
            "id": "unit",
            "argv": ["python3", "-c", "raise SystemExit(%s)" % exit_code],
            "timeout_seconds": 5,
            "gates": ["LOCAL_VERIFIED", "CI_VERIFIED", "POST_MERGE_VERIFIED"],
            "release_units": ["mac", "win", "backend"],
        }]
        if status == "COMMITTED":
            task["git"] = {"committed_sha": "a" * 40}
        initialize_root(root, task)
        return task

    def test_run_validation_persists_only_derived_local_pass(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = self._task(root)
            code = taskctl.main([
                "run-validation", task["task_id"], "--check", "unit",
                "--root", str(root), "--json",
            ])
            self.assertEqual(0, code)
            stored = read_json(task_path(root, task["task_id"]))
            result = stored["validation"]["results"][-1]
            self.assertEqual("passed", result["status"])
            self.assertEqual(RUNNER_VERSION, result["source"])
            self.assertEqual(0, result["exit_code"])
            self.assertTrue(result["integrity"]["unchanged"])

    def test_nonzero_process_is_recorded_as_failed_and_returns_one(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = self._task(root, exit_code=7)
            code = taskctl.main([
                "run-required", task["task_id"], "--phase", "local",
                "--root", str(root), "--json",
            ])
            self.assertEqual(1, code)
            result = read_json(task_path(root, task["task_id"]))["validation"]["results"][-1]
            self.assertEqual("failed", result["status"])
            self.assertEqual(7, result["exit_code"])

    def test_ci_process_report_never_persists_pass(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = self._task(root, status="COMMITTED")
            code = taskctl.main([
                "run-required", task["task_id"], "--phase", "ci",
                "--release-unit", "mac", "--root", str(root), "--json",
            ])
            self.assertEqual(0, code)
            stored = read_json(task_path(root, task["task_id"]))
            self.assertEqual([], stored["validation"]["results"])

    def test_ci_unaffected_release_unit_returns_not_applicable_without_results(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = self._task(root, status="COMMITTED")
            task["release_units"] = ["mac"]
            task["validation"]["required"][0]["release_units"] = ["mac"]
            task["coordination"]["deployment_order"] = ["mac"]
            task["coordination"]["rollback_order"] = ["mac"]
            task["coordination"]["unit_tasks"] = {"mac": task["task_id"]}
            task["coordination"]["unit_validation_checks"] = {"mac": ["unit"]}
            task["coordination"]["unit_rollback_checks"] = {"mac": ["unit"]}
            write_json(task_path(root, task["task_id"]), task)
            with mock.patch.dict(os.environ, {"GITHUB_ACTIONS": "true"}, clear=False), mock.patch.object(
                taskctl, "_require_validation_branch"
            ):
                code = taskctl.main([
                    "run-required", task["task_id"], "--phase", "ci",
                    "--release-unit", "backend", "--root", str(root), "--json",
                ])
            self.assertEqual(0, code)
            stored = read_json(task_path(root, task["task_id"]))
            self.assertEqual([], stored["validation"]["results"])


if __name__ == "__main__":
    unittest.main()
