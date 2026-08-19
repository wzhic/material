from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path


GOVERNANCE_DIR = Path(__file__).resolve().parents[1]
if str(GOVERNANCE_DIR) not in sys.path:
    sys.path.insert(0, str(GOVERNANCE_DIR))

import reviewctl  # noqa: E402
import taskctl  # noqa: E402
from core import canonical_scope_hash, find_effective_review, read_json  # noqa: E402
from helpers import (  # noqa: E402
    AuthenticatedReceiptTestCase,
    base_task,
    initialize_root,
    valid_local_pass,
    write_json,
)
from reconcile import run_reconcile  # noqa: E402


class TaskCtlTests(AuthenticatedReceiptTestCase):
    def test_create_rejects_task_id_path_traversal(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = base_task(status="DRAFT")
            task["task_id"] = "../../escaped"
            specification = root / "malicious-task.json"
            write_json(specification, task)
            with contextlib.redirect_stderr(io.StringIO()):
                result = taskctl.main([
                    "create", "--file", str(specification), "--root", str(root),
                ])
            self.assertEqual(2, result)
            self.assertFalse((root / "escaped.json").exists())

    def test_transition_and_nonpassing_validation_only_write_temp_state(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = base_task(status="REVIEW_PENDING")
            initialize_root(root, task)
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                result = taskctl.main([
                    "transition", task["task_id"], "APPROVED", "--actor", "user",
                    "--reason", "approved in test", "--root", str(root), "--json",
                ])
            self.assertEqual(0, result)
            stored = read_json(root / "project-control" / "tasks" / "GOV-TEST.json")
            self.assertEqual("APPROVED", stored["status"])

            stored["status"] = "IN_PROGRESS"
            write_json(root / "project-control" / "tasks" / "GOV-TEST.json", stored)

            with contextlib.redirect_stdout(io.StringIO()):
                result = taskctl.main([
                    "record-validation", task["task_id"], "--check", "unit", "--status", "failed",
                    "--phase", "local", "--evidence", "isolated unittest", "--actor", "test",
                    "--root", str(root), "--json",
                ])
            self.assertEqual(0, result)
            stored = read_json(root / "project-control" / "tasks" / "GOV-TEST.json")
            self.assertEqual("failed", stored["validation"]["results"][-1]["status"])

    def test_public_cli_rejects_self_reported_pass(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = initialize_root(root)
            error = io.StringIO()
            with (
                mock.patch.dict(
                    os.environ,
                    {
                        "CI": "true",
                        "GITHUB_ACTIONS": "true",
                        "TASKCTL_CONTROLLED_RUNNER": "true",
                    },
                ),
                contextlib.redirect_stderr(error),
            ):
                result = taskctl.main([
                    "record-validation", task["task_id"], "--check", "unit", "--status", "passed",
                    "--phase", "local", "--evidence", "self reported", "--actor", "controlled-runner",
                    "--root", str(root),
                ])
            self.assertEqual(2, result)
            self.assertIn("controlled runner", error.getvalue())
            stored = read_json(root / "project-control" / "tasks" / "GOV-TEST.json")
            self.assertEqual([], stored["validation"]["results"])

    def test_record_validation_requires_current_branch_and_effective_scope_review(self) -> None:
        cases = ("not_current", "wrong_branch", "expired_review")
        for case in cases:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                task = base_task(status="IN_PROGRESS")
                initialize_root(root, task)
                if case == "not_current":
                    write_json(root / "project-control" / "current-task.json", {"task_id": "GOV-OTHER"})
                elif case == "wrong_branch":
                    (root / ".git" / "HEAD").write_text(
                        "ref: refs/heads/codex/wrong-branch\n", encoding="utf-8"
                    )
                else:
                    receipt_path = root / "project-control" / "reviews" / "REV-TEST.json"
                    receipt = read_json(receipt_path)
                    receipt["expires_at"] = "2020-01-01T00:00:00+00:00"
                    write_json(receipt_path, receipt)
                with contextlib.redirect_stderr(io.StringIO()):
                    result = taskctl.main([
                        "record-validation", task["task_id"], "--check", "unit",
                        "--status", "failed", "--phase", "local",
                        "--evidence", "must not be written", "--actor", "test",
                        "--root", str(root),
                    ])
                self.assertEqual(2, result)
                stored = read_json(root / "project-control" / "tasks" / "GOV-TEST.json")
                self.assertEqual([], stored["validation"]["results"])

    def test_skipping_a_state_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = base_task(status="DRAFT")
            initialize_root(root, task, approved=False)
            with contextlib.redirect_stderr(io.StringIO()):
                result = taskctl.main([
                    "transition", task["task_id"], "APPROVED", "--actor", "test",
                    "--reason", "skip", "--root", str(root),
                ])
            self.assertEqual(2, result)

    def test_scope_revision_is_explicit_and_invalidates_old_review(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = base_task(status="IN_PROGRESS")
            initialize_root(root, task)
            task["validation"]["results"].append(valid_local_pass(root, task))
            write_json(root / "project-control" / "tasks" / "GOV-TEST.json", task)
            old_hash = canonical_scope_hash(task)
            proposal = root / "proposal.json"
            write_json(proposal, {"allowed_paths": ["tools/governance/**", "docs/**", "project-control/**"]})
            with contextlib.redirect_stdout(io.StringIO()):
                result = taskctl.main([
                    "revise-scope", task["task_id"], "--file", str(proposal),
                    "--target", "REVIEW_PENDING", "--actor", "Codex",
                    "--reason", "approved scope needs expansion", "--root", str(root), "--json",
                ])
            self.assertEqual(0, result)
            revised = read_json(root / "project-control" / "tasks" / "GOV-TEST.json")
            self.assertEqual(2, revised["scope_version"])
            self.assertEqual("REVIEW_PENDING", revised["status"])
            self.assertEqual([], revised["validation"]["results"])
            self.assertEqual("passed", revised["scope_revisions"][-1]["archived_validation_results"][0]["status"])
            self.assertNotEqual(old_hash, canonical_scope_hash(revised))
            self.assertIsNone(find_effective_review(root, revised)[0])

    def test_normal_transition_cannot_move_back_to_review(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = base_task(status="IN_PROGRESS")
            initialize_root(root, task)
            with contextlib.redirect_stderr(io.StringIO()):
                result = taskctl.main([
                    "transition", task["task_id"], "REVIEW_PENDING", "--actor", "Codex",
                    "--reason", "attempted backwards transition", "--root", str(root),
                ])
            self.assertEqual(2, result)

    def test_set_current_cannot_abandon_unfinished_task(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            active = initialize_root(root)
            target = base_task(status="DRAFT")
            target["task_id"] = "GOV-NEXT"
            write_json(root / "project-control" / "tasks" / "GOV-NEXT.json", target)
            with contextlib.redirect_stderr(io.StringIO()):
                denied = taskctl.main([
                    "set-current", "GOV-NEXT", "--actor", "Codex", "--reason", "switch",
                    "--root", str(root),
                ])
            self.assertEqual(2, denied)
            self.assertEqual(active["task_id"], read_json(
                root / "project-control" / "current-task.json"
            )["task_id"])

            active["status"] = "DONE"
            completed_sha = "a" * 40
            active["git"] = {
                "committed_sha": completed_sha,
                "ci_verified_sha": completed_sha,
                "merged_sha": completed_sha,
                "post_merge_verified_sha": completed_sha,
            }
            write_json(root / "project-control" / "tasks" / "GOV-TEST.json", active)
            with contextlib.redirect_stdout(io.StringIO()):
                accepted = taskctl.main([
                    "set-current", "GOV-NEXT", "--actor", "Codex", "--reason", "completed",
                    "--root", str(root),
                ])
            self.assertEqual(0, accepted)
            self.assertEqual("GOV-NEXT", read_json(
                root / "project-control" / "current-task.json"
            )["task_id"])

    def test_ready_requires_done_dependencies(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = base_task(status="APPROVED")
            task["dependencies"] = ["GOV-DEP"]
            initialize_root(root, task)
            dependency = base_task(status="IN_PROGRESS")
            dependency["task_id"] = "GOV-DEP"
            write_json(root / "project-control" / "tasks" / "GOV-DEP.json", dependency)
            with contextlib.redirect_stderr(io.StringIO()):
                result = taskctl.main([
                    "transition", task["task_id"], "READY", "--actor", "Codex",
                    "--reason", "dependency not done", "--root", str(root),
                ])
            self.assertEqual(2, result)

    def test_ready_requires_current_task_and_expected_branch(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = base_task(status="APPROVED")
            initialize_root(root, task)
            write_json(root / "project-control" / "current-task.json", {"task_id": "GOV-OTHER"})
            with contextlib.redirect_stderr(io.StringIO()):
                result = taskctl.main([
                    "transition", task["task_id"], "READY", "--actor", "Codex",
                    "--reason", "not current", "--root", str(root),
                ])
            self.assertEqual(2, result)

            write_json(root / "project-control" / "current-task.json", {"task_id": task["task_id"]})
            (root / ".git" / "HEAD").write_text("ref: refs/heads/codex/wrong-branch\n", encoding="utf-8")
            with contextlib.redirect_stderr(io.StringIO()):
                result = taskctl.main([
                    "transition", task["task_id"], "READY", "--actor", "Codex",
                    "--reason", "wrong branch", "--root", str(root),
                ])
            self.assertEqual(2, result)


class ReviewCtlTests(unittest.TestCase):
    def test_unsigned_record_is_disabled_even_with_user_like_process_context(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = initialize_root(root, approved=False)
            output = io.StringIO()
            with (
                mock.patch.dict(
                    os.environ,
                    {"USER": "user", "REVIEW_APPROVER": "user", "CODEX_REVIEW_APPROVER": "user"},
                ),
                mock.patch("reviewctl.sys.stdin.isatty", return_value=True),
                contextlib.redirect_stderr(output),
            ):
                result = reviewctl.main([
                    "record", task["task_id"], "--decision", "approved", "--approver", "user",
                    "--reason", "test approval", "--confirmation-source", "actor:user;tty:true",
                    "--review-id", "REV-NEW", "--root", str(root), "--json",
                ])
            self.assertEqual(2, result)
            payload = json.loads(output.getvalue())
            self.assertIn("LEGACY_RECORD_DISABLED", payload["error"])
            self.assertFalse((root / "project-control" / "reviews" / "REV-NEW.json").exists())

    def test_reserved_waive_entry_is_disabled_with_actionable_error(self) -> None:
        output = io.StringIO()
        with contextlib.redirect_stderr(output):
            result = reviewctl.main(["waive", "GOV-TEST", "--json"])
        self.assertEqual(2, result)
        self.assertIn("LEGACY_RECORD_DISABLED", json.loads(output.getvalue())["error"])


class ReconcileTests(AuthenticatedReceiptTestCase):
    def test_session_reconciles_isolated_state(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = initialize_root(root)
            report = run_reconcile(
                root, "session", git_branch=task["branch"], git_changes=["tools/governance/core.py"]
            )
            self.assertTrue(report["ok"], report)
            self.assertTrue(report["read_only"])

    def test_scope_drift_and_pretool_escape_fail(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = initialize_root(root)
            drift = run_reconcile(
                root, "session", git_branch=task["branch"], git_changes=["application/main.py"]
            )
            self.assertFalse(drift["ok"])
            denied = run_reconcile(
                root, "pretool", tool="apply_patch", paths=["application/main.py"],
                git_branch=task["branch"],
            )
            self.assertFalse(denied["ok"])

    def test_reviewed_pretool_and_shell_control(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = initialize_root(root)
            allowed = run_reconcile(
                root, "pretool", tool="apply_patch", paths=["tools/governance/core.py"],
                git_branch=task["branch"],
            )
            self.assertTrue(allowed["ok"], allowed)
            chained = run_reconcile(
                root, "pretool", tool="Bash",
                command="python3 -m unittest discover; touch outside",
                git_branch=task["branch"],
            )
            self.assertFalse(chained["ok"])


if __name__ == "__main__":
    unittest.main()
