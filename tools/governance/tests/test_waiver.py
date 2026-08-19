from __future__ import annotations

import contextlib
import io
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, Dict, Optional


GOVERNANCE_DIR = Path(__file__).resolve().parents[1]
if str(GOVERNANCE_DIR) not in sys.path:
    sys.path.insert(0, str(GOVERNANCE_DIR))

import taskctl  # noqa: E402
import reviewctl  # noqa: E402
from core import (  # noqa: E402
    canonical_scope_hash,
    find_effective_validation_waiver,
    managed_content_subject,
    read_json,
    validation_gate_status,
)
from helpers import AuthenticatedReceiptTestCase, base_task, initialize_root, write_json  # noqa: E402
from reconcile import run_reconcile  # noqa: E402


def write_waiver(
    root: Path,
    task: Dict[str, Any],
    review_id: str = "WAIVER-1",
    approver: str = "user",
    expires_at: Optional[str] = "2099-01-01T00:00:00+00:00",
    scope_hash: Optional[str] = None,
    phase: str = "local",
    subject: Optional[str] = None,
    environment: Optional[str] = None,
    max_gate: Optional[str] = None,
) -> None:
    write_json(root / "project-control" / "reviews" / (review_id + ".json"), {
        "schema_version": 1,
        "review_id": review_id,
        "task_id": task["task_id"],
        "kind": "validation_waiver",
        "decision": "approved",
        "approver": approver,
        "reason": "test-only user waiver",
        "confirmation_source": "unittest",
        "scope_version": task["scope_version"],
        "scope_hash": scope_hash or canonical_scope_hash(task),
        "check_id": "unit",
        "phase": phase,
        "subject": subject or (
            managed_content_subject(root, task) if phase == "local" else "commit:" + "c" * 40
        ),
        "environment": environment or ("local" if phase == "local" else "github-actions"),
        "max_gate": max_gate or {
            "local": "LOCAL_VERIFIED",
            "ci": "CI_VERIFIED",
            "post_merge": "POST_MERGE_VERIFIED",
        }[phase],
        "decided_at": "2026-08-18T00:01:00+00:00",
        "expires_at": expires_at,
        "supersedes": None,
    })


def record_skipped_task(root: Path, task: Dict[str, Any], waiver_id: str = "WAIVER-1") -> None:
    task["validation"]["results"] = [{
        "check_id": "unit",
        "status": "skipped",
        "phase": "local",
        "subject": managed_content_subject(root, task),
        "environment": "local",
        "evidence": "not run",
        "actor": "test",
        "recorded_at": "2026-08-18T00:02:00+00:00",
        "waiver_id": waiver_id,
    }]
    write_json(root / "project-control" / "tasks" / (task["task_id"] + ".json"), task)


class ValidationWaiverTests(AuthenticatedReceiptTestCase):
    def test_skipped_without_waiver_does_not_satisfy_gate(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = initialize_root(root)
            record_skipped_task(root, task)
            status = validation_gate_status(root, task, "LOCAL_VERIFIED")
            self.assertEqual([], status["waived"])
            self.assertEqual("unit", status["missing"][0]["check_id"])

    def test_expired_wrong_scope_and_non_user_waivers_are_rejected(self) -> None:
        cases = (
            {"expires_at": "2020-01-01T00:00:00+00:00"},
            {"scope_hash": "sha256:" + "0" * 64},
            {"approver": "Codex"},
        )
        for parameters in cases:
            with self.subTest(parameters=parameters), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                task = initialize_root(root)
                write_waiver(root, task, **parameters)
                record_skipped_task(root, task)
                status = validation_gate_status(root, task, "LOCAL_VERIFIED")
                self.assertEqual([], status["waived"])
                self.assertEqual(
                    {"mac", "win", "backend"},
                    {item["release_unit"] for item in status["missing"]},
                )

    def test_valid_waiver_satisfies_gate_but_is_never_passed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = initialize_root(root)
            write_waiver(root, task)
            record_skipped_task(root, task)
            status = validation_gate_status(root, task, "LOCAL_VERIFIED")
            self.assertEqual([], status["passed"])
            self.assertEqual([], status["missing"])
            self.assertEqual("waived", status["waived"][0]["status"])
            self.assertEqual("skipped", status["waived"][0]["validation_result_status"])

    def test_waiver_for_another_phase_does_not_satisfy_gate(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = initialize_root(root)
            write_waiver(root, task, phase="ci")
            record_skipped_task(root, task)
            status = validation_gate_status(root, task, "LOCAL_VERIFIED")
            self.assertEqual([], status["waived"])
            self.assertEqual("unit", status["missing"][0]["check_id"])

    def test_waiver_subject_environment_and_gate_are_exact(self) -> None:
        cases = (
            {"subject": "workspace:sha256:" + "0" * 64},
            {"environment": "another-environment"},
            {"max_gate": "CI_VERIFIED"},
        )
        for parameters in cases:
            with self.subTest(parameters=parameters), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                task = initialize_root(root)
                write_waiver(root, task, **parameters)
                record_skipped_task(root, task)
                status = validation_gate_status(root, task, "LOCAL_VERIFIED")
                self.assertEqual([], status["waived"])
                self.assertEqual("unit", status["missing"][0]["check_id"])

    def test_existing_fixture_waiver_binds_current_local_subject_and_invalidates_on_change(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = initialize_root(root)
            write_waiver(root, task, review_id="WAIVER-BOUND")
            receipt = read_json(root / "project-control" / "reviews" / "WAIVER-BOUND.json")
            self.assertEqual(managed_content_subject(root, task), receipt["subject"])
            self.assertEqual("local", receipt["environment"])
            self.assertEqual("LOCAL_VERIFIED", receipt["max_gate"])
            self.assertIsNotNone(find_effective_validation_waiver(root, task, "unit", "local", "local")[0])

            (root / "docs" / "governance" / "test.md").write_text("changed\n", encoding="utf-8")
            self.assertIsNone(find_effective_validation_waiver(root, task, "unit", "local", "local")[0])

    def test_taskctl_refuses_to_record_skip_without_waiver(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = initialize_root(root)
            with contextlib.redirect_stderr(io.StringIO()):
                result = taskctl.main([
                    "record-validation", task["task_id"], "--check", "unit", "--status", "skipped",
                    "--phase", "local", "--evidence", "not run", "--actor", "Codex",
                    "--root", str(root),
                ])
            self.assertEqual(2, result)

    def test_reviewctl_rejects_unsigned_waiver_before_binding_validation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = initialize_root(root)
            error = io.StringIO()
            with contextlib.redirect_stderr(error):
                result = reviewctl.main([
                    "record", task["task_id"], "--kind", "validation_waiver",
                    "--decision", "approved", "--approver", "user", "--check-id", "unit",
                    "--expires-at", "2099-01-01T00:00:00+00:00",
                    "--reason", "test", "--confirmation-source", "unittest",
                    "--root", str(root),
                ])
            self.assertEqual(2, result)
            self.assertIn("LEGACY_RECORD_DISABLED", error.getvalue())

    def test_reconcile_reports_waived_detail(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = base_task(status="LOCAL_VERIFIED")
            initialize_root(root, task)
            write_waiver(root, task)
            record_skipped_task(root, task)
            report = run_reconcile(
                root, "session", git_branch=task["branch"], git_changes=["tools/governance/core.py"]
            )
            self.assertTrue(report["ok"], report)
            attained = next(
                item for item in report["checks"] if item["id"] == "attained_validation_gates"
            )
            validation = attained["details"]["gates"]["LOCAL_VERIFIED"]
            self.assertEqual("waived", validation["waived"][0]["status"])
            self.assertNotIn("unit", validation["passed"])


if __name__ == "__main__":
    unittest.main()
