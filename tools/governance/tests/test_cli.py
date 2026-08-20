from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
import shutil
from unittest import mock
from pathlib import Path


GOVERNANCE_DIR = Path(__file__).resolve().parents[1]
if str(GOVERNANCE_DIR) not in sys.path:
    sys.path.insert(0, str(GOVERNANCE_DIR))

import reviewctl  # noqa: E402
import taskctl  # noqa: E402
import core  # noqa: E402
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
    def _prepare_committable_task(self, root: Path) -> dict:
        task = base_task(status="IN_PROGRESS")
        task["allowed_paths"].append("project-control/**")
        initialize_root(root, task)
        project_path = root / "project-control" / "project.json"
        project = read_json(project_path)
        project["source_repository"] = "git@github.com:wzhic/material.git"
        write_json(project_path, project)
        shutil.rmtree(root / ".git")
        _output, error = core.run_git(root, ("init", "--quiet", "-b", "main"))
        self.assertIsNone(error, _output)
        _output, error = core.run_git(root, ("add", "--all"))
        self.assertIsNone(error, _output)
        _output, error = core.run_git(root, (
            "-c", "user.name=Governance Test",
            "-c", "user.email=governance-test@example.invalid",
            "-c", "commit.gpgSign=false",
            "commit", "--quiet", "-m", "baseline",
        ))
        self.assertIsNone(error, _output)
        _output, error = core.run_git(root, ("switch", "-c", task["branch"]))
        self.assertIsNone(error, _output)
        governed = root / "docs" / "governance" / "test.md"
        governed.write_text("reviewed task change\n", encoding="utf-8")
        head, error = core.run_git(root, ("rev-parse", "HEAD"))
        self.assertIsNone(error, head)
        write_json(
            root / "project-control" / "proposals" / "GOV-TEST-change-set.json",
            {
                "schema_version": 1,
                "task_id": "GOV-TEST",
                "base_head": head,
                "paths": ["docs/governance/test.md"],
            },
        )
        task["validation"]["results"] = [valid_local_pass(root, task)]
        task["status"] = "LOCAL_VERIFIED"
        write_json(root / "project-control" / "tasks" / "GOV-TEST.json", task)
        return task

    def _commit_prepared_task(self, root: Path) -> dict:
        with mock.patch("reconcile.run_reconcile", return_value={"ok": True, "checks": []}):
            with contextlib.redirect_stdout(io.StringIO()):
                code = taskctl.main([
                    "commit-task",
                    "GOV-TEST",
                    "--actor",
                    "Codex",
                    "--reason",
                    "complete reviewed local work",
                    "--manifest",
                    "project-control/proposals/GOV-TEST-change-set.json",
                    "--root",
                    str(root),
                    "--json",
                ])
        self.assertEqual(0, code)
        return read_json(root / "project-control" / "tasks" / "GOV-TEST.json")

    def test_commit_task_creates_content_and_protected_control_commits(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self._prepare_committable_task(root)
            stored = self._commit_prepared_task(root)
            self.assertEqual("COMMITTED", stored["status"])
            content_sha = stored["git"]["committed_sha"]
            control_sha, error = core.run_git(root, ("rev-parse", "HEAD"))
            self.assertIsNone(error, control_sha)
            self.assertNotEqual(content_sha, control_sha)
            changed, error = core.run_git(
                root, ("diff", "--name-only", content_sha + ".." + str(control_sha))
            )
            self.assertIsNone(error, changed)
            self.assertEqual("project-control/tasks/GOV-TEST.json", changed)
            dirty, error = core.run_git(root, ("status", "--porcelain", "--untracked-files=all"))
            self.assertIsNone(error, dirty)
            self.assertEqual("", dirty)

    def test_commit_task_preserves_unstaged_unrelated_work(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = self._prepare_committable_task(root)
            unrelated = root / "user-notes.txt"
            unrelated.write_text("user-owned work\n", encoding="utf-8")
            task["validation"]["results"] = [valid_local_pass(root, task)]
            write_json(root / "project-control" / "tasks" / "GOV-TEST.json", task)
            stored = self._commit_prepared_task(root)
            self.assertEqual("COMMITTED", stored["status"])
            self.assertEqual("user-owned work\n", unrelated.read_text(encoding="utf-8"))
            status, error = core.run_git(root, ("status", "--porcelain", "--untracked-files=all"))
            self.assertIsNone(error, status)
            self.assertIn("?? user-notes.txt", status)
            committed, error = core.run_git(root, ("ls-tree", "-r", "--name-only", "HEAD"))
            self.assertIsNone(error, committed)
            self.assertNotIn("user-notes.txt", committed.splitlines())

    def test_commit_task_rejects_unrelated_pre_staged_work(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = self._prepare_committable_task(root)
            unrelated = root / "user-notes.txt"
            unrelated.write_text("user-owned work\n", encoding="utf-8")
            _output, error = core.run_git(root, ("add", "--", "user-notes.txt"))
            self.assertIsNone(error, _output)
            task["validation"]["results"] = [valid_local_pass(root, task)]
            write_json(root / "project-control" / "tasks" / "GOV-TEST.json", task)
            with mock.patch("reconcile.run_reconcile", return_value={"ok": True, "checks": []}):
                with contextlib.redirect_stdout(io.StringIO()):
                    code = taskctl.main([
                        "commit-task", "GOV-TEST", "--actor", "Codex",
                        "--reason", "must preserve staged user work",
                        "--manifest", "project-control/proposals/GOV-TEST-change-set.json",
                        "--root", str(root), "--json",
                    ])
            self.assertEqual(2, code)

    def test_push_task_is_non_force_and_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "work"
            remote = Path(temporary) / "remote.git"
            root.mkdir()
            self._prepare_committable_task(root)
            stored = self._commit_prepared_task(root)
            _output, error = core.run_git(root, ("init", "--bare", "--quiet", str(remote)))
            self.assertIsNone(error, _output)
            command = [
                "push-task",
                stored["task_id"],
                "--actor",
                "Codex",
                "--reason",
                "publish reviewed feature branch",
                "--root",
                str(root),
                "--json",
            ]
            with mock.patch.object(taskctl, "_BOOTSTRAP_PUSH_URL", str(remote)):
                with contextlib.redirect_stdout(io.StringIO()):
                    first = taskctl.main(command)
                    second = taskctl.main(command)
            self.assertEqual(0, first)
            self.assertEqual(0, second)
            remote_sha, error = core.run_git(
                root,
                ("ls-remote", str(remote), "refs/heads/" + stored["branch"]),
            )
            self.assertIsNone(error, remote_sha)
            head, error = core.run_git(root, ("rev-parse", "HEAD"))
            self.assertIsNone(error, head)
            self.assertTrue(str(remote_sha).startswith(str(head) + "\t"))

    def test_open_pr_emits_fixed_compare_url_without_creating_external_state(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self._prepare_committable_task(root)
            stored = self._commit_prepared_task(root)
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                code = taskctl.main([
                    "open-pr", stored["task_id"], "--root", str(root), "--json",
                ])
            self.assertEqual(0, code)
            payload = json.loads(output.getvalue())
            self.assertEqual(
                "https://github.com/wzhic/material/compare/main...codex/req-test-gov-test?expand=1",
                payload["url"],
            )
            self.assertFalse(payload["creates_pull_request"])

    def test_prepare_recovery_is_read_only_and_task_owned(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self._prepare_committable_task(root)
            stored = self._commit_prepared_task(root)
            stored["status"] = "BLOCKED"
            stored["exception"] = {
                "previous_status": "COMMITTED",
                "reason": "CI failed",
                "recorded_at": "2026-08-19T00:00:00+00:00",
            }
            task_path = root / "project-control" / "tasks" / "GOV-TEST.json"
            write_json(task_path, stored)
            before = task_path.read_bytes()
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                code = taskctl.main([
                    "prepare-recovery", stored["task_id"], "--root", str(root), "--json",
                ])
            self.assertEqual(0, code)
            payload = json.loads(output.getvalue())
            self.assertEqual("project-control/proposals/GOV-TEST-", payload["proposal_prefix"])
            self.assertEqual("COMMITTED", payload["previous_status"])
            self.assertEqual(before, task_path.read_bytes())

    def test_recover_blocked_archives_committed_evidence_without_rewriting_history(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self._prepare_committable_task(root)
            stored = self._commit_prepared_task(root)
            head_before, error = core.run_git(root, ("rev-parse", "HEAD"))
            self.assertIsNone(error, head_before)
            stored["status"] = "BLOCKED"
            stored["exception"] = {
                "previous_status": "COMMITTED",
                "reason": "CI failed",
                "recorded_at": "2026-08-19T00:00:00+00:00",
            }
            write_json(root / "project-control" / "tasks" / "GOV-TEST.json", stored)
            with contextlib.redirect_stdout(io.StringIO()):
                code = taskctl.main([
                    "recover-blocked",
                    stored["task_id"],
                    "--actor",
                    "Codex",
                    "--reason",
                    "repair failed CI in the same reviewed scope",
                    "--root",
                    str(root),
                ])
            self.assertEqual(0, code)
            recovered = read_json(root / "project-control" / "tasks" / "GOV-TEST.json")
            self.assertEqual("IN_PROGRESS", recovered["status"])
            self.assertEqual({}, recovered["git"])
            self.assertEqual([], recovered["validation"]["results"])
            self.assertTrue(recovered["recovery_history"][-1]["append_only_required"])
            head_after, error = core.run_git(root, ("rev-parse", "HEAD"))
            self.assertIsNone(error, head_after)
            self.assertEqual(head_before, head_after)

    def test_start_branch_creates_only_reviewed_local_branch(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = base_task(status="APPROVED")
            initialize_root(root, task)
            shutil.rmtree(root / ".git")
            _initialized, error = core.run_git(root, ("init", "--quiet", "-b", "main"))
            self.assertIsNone(error, _initialized)
            with contextlib.redirect_stdout(io.StringIO()):
                code = taskctl.main([
                    "start-branch",
                    task["task_id"],
                    "--actor",
                    "Codex",
                    "--reason",
                    "start reviewed local branch",
                    "--root",
                    str(root),
                ])
            self.assertEqual(0, code)
            branch, branch_error = core.current_branch(root)
            self.assertIsNone(branch_error)
            self.assertEqual(task["branch"], branch)
            stored = read_json(root / "project-control" / "tasks" / "GOV-TEST.json")
            self.assertEqual("local_branch_started", stored["history"][-1]["event"])

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

            active["status"] = "COMMITTED"
            completed_sha = "a" * 40
            active["git"] = {
                "committed_sha": completed_sha,
            }
            write_json(root / "project-control" / "tasks" / "GOV-TEST.json", active)
            with contextlib.redirect_stdout(io.StringIO()):
                accepted = taskctl.main([
                    "set-current", "GOV-NEXT", "--actor", "Codex", "--reason", "committed task waits for CI",
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
