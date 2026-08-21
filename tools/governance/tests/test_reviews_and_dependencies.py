from __future__ import annotations

import contextlib
import io
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
from core import (  # noqa: E402
    canonical_scope_hash,
    find_effective_code_review,
    find_effective_final_action_review,
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
    def test_code_review_remains_verifiable_but_is_not_required(self) -> None:
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
            with contextlib.redirect_stdout(io.StringIO()):
                accepted = taskctl.main([
                    "transition", task["task_id"], "CODE_REVIEWED", "--actor", "Codex",
                    "--reason", "no code receipt", "--root", str(root),
                ])
            self.assertEqual(0, accepted)

            write_existing_review(root, task, "REV-CODE", "code", commit=VERIFIED_COMMIT)
            stored = read_json(root / "project-control" / "tasks" / "GOV-TEST.json")
            receipt, reason = find_effective_code_review(root, stored, VERIFIED_COMMIT)
            self.assertIsNotNone(receipt, reason)
            self.assertIsNone(find_effective_code_review(root, stored, OTHER_COMMIT)[0])

    def test_merge_requires_a_final_action_receipt_bound_to_committed_content(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = base_task(status="COMMITTED")
            task["git"] = {"committed_sha": VERIFIED_COMMIT}
            initialize_root(root, task)
            task["validation"]["results"] = [valid_local_pass(root, task)]
            write_json(root / "project-control" / "tasks" / "GOV-TEST.json", task)

            with contextlib.redirect_stderr(io.StringIO()):
                denied = taskctl.main([
                    "transition", task["task_id"], "MERGED", "--actor", "Codex",
                    "--reason", "missing final decision", "--commit", OTHER_COMMIT,
                    "--root", str(root),
                ])
            self.assertEqual(2, denied)

            write_existing_review(
                root,
                task,
                "REV-FINAL-MERGE",
                "final_action",
                action="merge",
                subject="commit:" + VERIFIED_COMMIT,
                expires_at="2099-01-01T00:00:00+00:00",
            )
            receipt, reason = find_effective_final_action_review(root, task, "merge")
            self.assertIsNotNone(receipt, reason)
            with contextlib.redirect_stdout(io.StringIO()):
                verified = reviewctl.main([
                    "verify", "--task", task["task_id"],
                    "--kind", "final_action", "--action", "merge",
                    "--root", str(root), "--json",
                ])
            self.assertEqual(0, verified)
            with (
                mock.patch("taskctl._require_merged_commit_relation"),
                contextlib.redirect_stdout(io.StringIO()),
            ):
                accepted = taskctl.main([
                    "transition", task["task_id"], "MERGED", "--actor", "Codex",
                    "--reason", "user approved final merge", "--commit", OTHER_COMMIT,
                    "--root", str(root),
                ])
            self.assertEqual(0, accepted)
            stored = read_json(root / "project-control" / "tasks" / "GOV-TEST.json")
            self.assertEqual("MERGED", stored["status"])
            self.assertEqual(OTHER_COMMIT, stored["git"]["merged_sha"])

    def test_merge_relation_accepts_a_landed_commit_when_target_advances(self) -> None:
        task = base_task(status="COMMITTED")
        task["git"] = {"committed_sha": VERIFIED_COMMIT}
        target_tip = "e" * 40

        def related_git(_root: Path, arguments: tuple[str, ...]):
            if arguments[0] == "cat-file":
                return "", None
            if arguments[:2] == ("merge-base", "--is-ancestor"):
                self.assertIn(
                    arguments[2:],
                    ((VERIFIED_COMMIT, OTHER_COMMIT), (OTHER_COMMIT, target_tip)),
                )
                return "", None
            if arguments == ("rev-parse", "--verify", "refs/heads/main^{commit}"):
                return target_tip, None
            if arguments == (
                "rev-parse", "--verify", "refs/remotes/origin/main^{commit}"
            ):
                return None, "missing remote ref"
            raise AssertionError("unexpected git call: %r" % (arguments,))

        with mock.patch("taskctl.run_git", side_effect=related_git):
            taskctl._require_merged_commit_relation(Path("."), task, OTHER_COMMIT)

    def test_merge_relation_rejects_unrelated_or_unlanded_commits(self) -> None:
        task = base_task(status="COMMITTED")
        task["git"] = {"committed_sha": VERIFIED_COMMIT}
        target_tip = "e" * 40

        def git_result(
            _root: Path,
            arguments: tuple[str, ...],
            *,
            committed_is_ancestor: bool,
            target_contains_merge: bool,
        ):
            if arguments[0] == "cat-file":
                return "", None
            if arguments == (
                "merge-base", "--is-ancestor", VERIFIED_COMMIT, OTHER_COMMIT
            ):
                return ("", None) if committed_is_ancestor else (None, "not ancestor")
            if arguments == ("merge-base", "--is-ancestor", OTHER_COMMIT, target_tip):
                return ("", None) if target_contains_merge else (None, "not contained")
            if arguments == ("rev-parse", "--verify", "refs/heads/main^{commit}"):
                return target_tip, None
            if arguments == (
                "rev-parse", "--verify", "refs/remotes/origin/main^{commit}"
            ):
                return None, "missing remote ref"
            raise AssertionError("unexpected git call: %r" % (arguments,))

        with mock.patch(
            "taskctl.run_git",
            side_effect=lambda root, arguments: git_result(
                root,
                arguments,
                committed_is_ancestor=False,
                target_contains_merge=True,
            ),
        ):
            with self.assertRaisesRegex(Exception, "not an ancestor"):
                taskctl._require_merged_commit_relation(Path("."), task, OTHER_COMMIT)

        with mock.patch(
            "taskctl.run_git",
            side_effect=lambda root, arguments: git_result(
                root,
                arguments,
                committed_is_ancestor=True,
                target_contains_merge=False,
            ),
        ):
            with self.assertRaisesRegex(Exception, "not contained"):
                taskctl._require_merged_commit_relation(Path("."), task, OTHER_COMMIT)

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
