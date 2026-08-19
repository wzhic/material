from __future__ import annotations

import contextlib
import io
import sys
import tempfile
import unittest
from pathlib import Path


GOVERNANCE_DIR = Path(__file__).resolve().parents[1]
if str(GOVERNANCE_DIR) not in sys.path:
    sys.path.insert(0, str(GOVERNANCE_DIR))

import reviewctl  # noqa: E402
import taskctl  # noqa: E402
from core import (  # noqa: E402
    canonical_scope_hash,
    find_effective_code_review,
    find_effective_irreversible_operation_review,
    read_json,
)
from helpers import (  # noqa: E402
    AuthenticatedReceiptTestCase,
    base_task,
    initialize_root,
    valid_github_pass,
    valid_local_pass,
    write_json,
)


VERIFIED_COMMIT = "c" * 40
OTHER_COMMIT = "d" * 40
TARGET_DIGEST = "sha256:" + "e" * 64


def write_existing_review(root: Path, task: dict, review_id: str, kind: str, **bindings: str) -> None:
    receipt = {
        "schema_version": 1,
        "review_id": review_id,
        "task_id": task["task_id"],
        "kind": kind,
        "decision": "approved",
        "approver": "user",
        "reason": "pre-existing test fixture",
        "confirmation_source": "fixture",
        "scope_version": task["scope_version"],
        "scope_hash": canonical_scope_hash(task),
        "decided_at": "2026-08-18T00:00:00+00:00",
        "expires_at": None,
        "supersedes": None,
    }
    receipt.update(bindings)
    write_json(root / "project-control" / "reviews" / (review_id + ".json"), receipt)


class SpecializedReviewTests(AuthenticatedReceiptTestCase):
    def test_code_review_is_required_and_binds_verified_commit(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = base_task(status="CI_VERIFIED")
            task["git"] = {
                "committed_sha": VERIFIED_COMMIT,
                "ci_verified_sha": VERIFIED_COMMIT,
            }
            initialize_root(root, task)
            task["validation"]["results"] = [
                valid_local_pass(root, task),
                valid_github_pass(task, "ci", VERIFIED_COMMIT, VERIFIED_COMMIT),
            ]
            write_json(root / "project-control" / "tasks" / "GOV-TEST.json", task)
            with contextlib.redirect_stderr(io.StringIO()):
                denied = taskctl.main([
                    "transition", task["task_id"], "CODE_REVIEWED", "--actor", "Codex",
                    "--reason", "no code receipt", "--root", str(root),
                ])
            self.assertEqual(2, denied)

            write_existing_review(root, task, "REV-CODE", "code", commit=VERIFIED_COMMIT)
            stored = read_json(root / "project-control" / "tasks" / "GOV-TEST.json")
            receipt, reason = find_effective_code_review(root, stored, VERIFIED_COMMIT)
            self.assertIsNotNone(receipt, reason)
            self.assertIsNone(find_effective_code_review(root, stored, OTHER_COMMIT)[0])

            with contextlib.redirect_stdout(io.StringIO()):
                accepted = taskctl.main([
                    "transition", task["task_id"], "CODE_REVIEWED", "--actor", "Codex",
                    "--reason", "user reviewed commit", "--root", str(root),
                ])
            self.assertEqual(0, accepted)

    def test_irreversible_operation_receipt_is_narrow_and_does_not_execute(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = initialize_root(root)
            write_existing_review(
                root,
                task,
                "REV-IRREVERSIBLE",
                "irreversible_operation",
                operation_id="delete-remote-release",
                target_digest=TARGET_DIGEST,
                expires_at="2099-01-01T00:00:00+00:00",
            )
            receipt, reason = find_effective_irreversible_operation_review(
                root, task, "delete-remote-release", TARGET_DIGEST
            )
            self.assertIsNotNone(receipt, reason)
            self.assertIsNone(find_effective_irreversible_operation_review(
                root, task, "delete-remote-release", "sha256:" + "f" * 64
            )[0])

    def test_specialized_unsigned_record_calls_are_disabled(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = base_task(status="CI_VERIFIED")
            task["git"] = {
                "committed_sha": VERIFIED_COMMIT,
                "ci_verified_sha": VERIFIED_COMMIT,
            }
            initialize_root(root, task)
            code_error = io.StringIO()
            with contextlib.redirect_stderr(code_error):
                missing_code_commit = reviewctl.main([
                    "record", task["task_id"], "--kind", "code", "--decision", "approved",
                    "--approver", "user", "--reason", "missing binding",
                    "--confirmation-source", "unittest", "--root", str(root),
                ])
            self.assertEqual(2, missing_code_commit)
            self.assertIn("LEGACY_RECORD_DISABLED", code_error.getvalue())

            operation_error = io.StringIO()
            with contextlib.redirect_stderr(operation_error):
                expired_operation = reviewctl.main([
                    "record", task["task_id"], "--kind", "irreversible_operation",
                    "--decision", "approved", "--approver", "user",
                    "--operation-id", "delete-remote-release", "--target-digest", TARGET_DIGEST,
                    "--expires-at", "2020-01-01T00:00:00+00:00",
                    "--reason", "expired", "--confirmation-source", "unittest",
                    "--root", str(root),
                ])
            self.assertEqual(2, expired_operation)
            self.assertIn("LEGACY_RECORD_DISABLED", operation_error.getvalue())


if __name__ == "__main__":
    unittest.main()
