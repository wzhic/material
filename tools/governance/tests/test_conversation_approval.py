from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


GOVERNANCE_DIR = Path(__file__).resolve().parents[1]
if str(GOVERNANCE_DIR) not in sys.path:
    sys.path.insert(0, str(GOVERNANCE_DIR))

import reviewctl  # noqa: E402
import taskctl  # noqa: E402
import core  # noqa: E402
from core import (  # noqa: E402
    canonical_scope_hash,
    find_effective_code_review,
    find_effective_final_action_review,
    find_effective_review,
    managed_content_subject,
    read_json,
)
from helpers import (  # noqa: E402
    AuthenticatedReceiptTestCase,
    base_task,
    initialize_root,
    valid_local_pass,
    write_json,
)


VERIFIED_COMMIT = "c" * 40
REPOSITORY_ROOT = Path(__file__).resolve().parents[3]


class SealedMigrationRootTests(unittest.TestCase):
    def test_exact_r003_is_sealed_without_runtime_openssh(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            initialize_root(root, base_task(), approved=False)
            source = REPOSITORY_ROOT / "project-control" / "reviews" / "GOV-0001-R003.json"
            receipt = read_json(source)
            write_json(
                root / "project-control" / "reviews" / "GOV-0001-R003.json",
                receipt,
            )
            with mock.patch(
                "authority.verify_signed_receipt",
                side_effect=AssertionError("sealed migration must not invoke OpenSSH"),
            ):
                valid, reason = core._conversation_migration_authorized(root)
            self.assertTrue(valid, reason)
            self.assertIn("sealed signed R003", reason)

    def test_any_r003_signature_change_breaks_the_seal(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            initialize_root(root, base_task(), approved=False)
            source = REPOSITORY_ROOT / "project-control" / "reviews" / "GOV-0001-R003.json"
            receipt = read_json(source)
            receipt["signature"] = dict(receipt["signature"])
            receipt["signature"]["armored"] = receipt["signature"]["armored"].replace(
                "U1NIU0lH", "V1NIU0lH", 1
            )
            write_json(
                root / "project-control" / "reviews" / "GOV-0001-R003.json",
                receipt,
            )
            valid, reason = core._conversation_migration_authorized(root)
            self.assertFalse(valid)
            self.assertIn("sealed signed R003", reason)


class ConversationReceiptTests(unittest.TestCase):
    def setUp(self) -> None:
        super().setUp()
        patcher = mock.patch(
            "core._conversation_migration_authorized",
            return_value=(True, "test R003 migration root"),
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def _record(self, root: Path, task_id: str, *extra: str) -> int:
        argv = [
            "record-conversation",
            task_id,
            "--review-id",
            "REV-CONVERSATION",
            "--decision",
            "approved",
            "--reason",
            "explicit user decision",
            "--confirmation-ref",
            "conversation:test-turn",
            "--confirmation-text",
            "确认按当前范围执行",
            "--actor",
            "Codex",
            *extra,
            "--root",
            str(root),
            "--json",
        ]
        with contextlib.redirect_stdout(io.StringIO()):
            return reviewctl.main(argv)

    def test_scope_receipt_is_derived_and_invalidates_on_scope_change(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = base_task(status="REVIEW_PENDING")
            initialize_root(root, task, approved=False)
            self.assertEqual(0, self._record(root, task["task_id"]))

            receipt = read_json(root / "project-control" / "reviews" / "REV-CONVERSATION.json")
            self.assertEqual("conversation-v1", receipt["approval_mode"])
            self.assertEqual("Codex", receipt["recorded_by"])
            self.assertEqual("user", receipt["approver"])
            self.assertNotIn("signature", receipt)
            self.assertEqual(canonical_scope_hash(task), receipt["scope_hash"])
            effective, reason = find_effective_review(root, task)
            self.assertIsNotNone(effective, reason)

            changed = dict(task)
            changed["summary"] = "changed scope"
            self.assertIsNone(find_effective_review(root, changed)[0])

    def test_code_receipt_binds_exact_ci_verified_commit(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = base_task(status="CI_VERIFIED")
            task["git"] = {
                "committed_sha": VERIFIED_COMMIT,
                "ci_verified_sha": VERIFIED_COMMIT,
            }
            initialize_root(root, task, approved=False)
            self.assertEqual(
                0,
                self._record(root, task["task_id"], "--kind", "code", "--commit", VERIFIED_COMMIT),
            )
            receipt, reason = find_effective_code_review(root, task, VERIFIED_COMMIT)
            self.assertIsNotNone(receipt, reason)
            self.assertEqual(VERIFIED_COMMIT, receipt["commit"])
            self.assertIsNone(find_effective_code_review(root, task, "d" * 40)[0])

    def test_final_merge_conversation_receipt_allows_only_the_bound_task(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = base_task(status="COMMITTED")
            task["git"] = {"committed_sha": VERIFIED_COMMIT}
            initialize_root(root, task, approved=False)
            task["validation"]["results"] = [valid_local_pass(root, task)]
            write_json(root / "project-control" / "tasks" / "GOV-TEST.json", task)
            self.assertEqual(
                0,
                self._record(
                    root,
                    task["task_id"],
                    "--kind", "final_action",
                    "--action", "merge",
                    "--expires-at", "2099-01-01T00:00:00+00:00",
                ),
            )
            receipt, reason = find_effective_final_action_review(root, task, "merge")
            self.assertIsNotNone(receipt, reason)
            with (
                mock.patch("taskctl._require_merged_commit_relation"),
                contextlib.redirect_stdout(io.StringIO()),
            ):
                result = taskctl.main([
                    "transition", task["task_id"], "MERGED", "--actor", "Codex",
                    "--reason", "user approved final merge", "--commit", "d" * 40,
                    "--root", str(root),
                ])
            self.assertEqual(0, result)

    def test_actor_and_state_cannot_be_self_selected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = base_task(status="IN_PROGRESS")
            initialize_root(root, task, approved=False)
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                result = reviewctl.main([
                    "record-conversation",
                    task["task_id"],
                    "--review-id",
                    "REV-BAD",
                    "--decision",
                    "approved",
                    "--reason",
                    "bad",
                    "--confirmation-ref",
                    "conversation:test",
                    "--confirmation-text",
                    "确认",
                    "--actor",
                    "user",
                    "--root",
                    str(root),
                ])
            self.assertEqual(2, result)
            self.assertIn("REVIEW_PENDING", stderr.getvalue())


class ControlledReworkTests(AuthenticatedReceiptTestCase):
    def _write_rework_receipt(self, root: Path, task: dict) -> None:
        write_json(root / "project-control" / "reviews" / "REV-REWORK.json", {
            "schema_version": 3,
            "approval_mode": "conversation-v1",
            "review_id": "REV-REWORK",
            "project_id": "material",
            "source_repository": "git@github.com:wzhic/material.git",
            "task_id": task["task_id"],
            "kind": "rework",
            "decision": "approved",
            "approver": "user",
            "recorded_by": "Codex",
            "reason": "explicit same-scope rework",
            "confirmation_source": "codex-conversation",
            "confirmation_ref": "conversation:test-rework",
            "confirmation_text": "确认返工",
            "scope_version": task["scope_version"],
            "scope_hash": canonical_scope_hash(task),
            "subject": managed_content_subject(root, task),
            "from_status": "LOCAL_VERIFIED",
            "decided_at": "2026-08-19T00:00:00+00:00",
            "expires_at": "2099-01-01T00:00:00+00:00",
            "supersedes": None,
        })

    def _verified_task(self, root: Path) -> dict:
        task = base_task(status="LOCAL_VERIFIED")
        initialize_root(root, task)
        task["validation"]["results"] = [valid_local_pass(root, task)]
        write_json(root / "project-control" / "tasks" / "GOV-TEST.json", task)
        return task

    def test_reopen_archives_local_results_and_returns_to_in_progress(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = self._verified_task(root)
            with (
                mock.patch("taskctl._require_merged_commit_relation"),
                contextlib.redirect_stdout(io.StringIO()),
            ):
                result = taskctl.main([
                    "reopen",
                    task["task_id"],
                    "--actor",
                    "Codex",
                    "--reason",
                    "fix stale documentation",
                    "--root",
                    str(root),
                ])
            self.assertEqual(0, result)
            stored = read_json(root / "project-control" / "tasks" / "GOV-TEST.json")
            self.assertEqual("IN_PROGRESS", stored["status"])
            self.assertEqual([], stored["validation"]["results"])
            self.assertNotIn("review_id", stored["rework_history"][-1])
            self.assertEqual(1, len(stored["rework_history"][-1]["archived_validation_results"]))

    def test_reopen_after_frozen_subject_drift_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = self._verified_task(root)
            changed = root / "tools" / "governance" / "changed.txt"
            changed.parent.mkdir(parents=True, exist_ok=True)
            changed.write_text("changed after verification\n", encoding="utf-8")
            with contextlib.redirect_stderr(io.StringIO()):
                result = taskctl.main([
                    "reopen",
                    task["task_id"],
                    "--actor",
                    "Codex",
                    "--reason",
                    "attempt rework after content drift",
                    "--root",
                    str(root),
                ])
            self.assertEqual(2, result)
            stored = read_json(root / "project-control" / "tasks" / "GOV-TEST.json")
            self.assertEqual("LOCAL_VERIFIED", stored["status"])


if __name__ == "__main__":
    unittest.main()
