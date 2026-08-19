from __future__ import annotations

import tempfile
import sys
import os
from pathlib import Path
from unittest import mock


GOVERNANCE_DIR = Path(__file__).resolve().parents[1]
if str(GOVERNANCE_DIR) not in sys.path:
    sys.path.insert(0, str(GOVERNANCE_DIR))
TESTS_DIR = Path(__file__).resolve().parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))

from helpers import (
    AuthenticatedReceiptTestCase,
    base_task,
    initialize_root,
    valid_local_pass,
    write_json,
)

import taskctl
import core
from reconcile import run_reconcile
from core import (
    BOOTSTRAP_REPAIR_MESSAGE,
    BOOTSTRAP_REPAIR_REVIEW_ID,
    SECOND_BOOTSTRAP_REPAIR_MESSAGE,
    SECOND_BOOTSTRAP_REPAIR_REVIEW_ID,
    canonical_scope_hash,
    recovery_contract_digest,
    read_json,
    run_git,
)


def git(root: Path, *arguments: str) -> str:
    output, error = run_git(root, arguments)
    if error:
        raise AssertionError("git %s failed: %s" % (" ".join(arguments), error))
    return output or ""


class BootstrapGitTransportTests(AuthenticatedReceiptTestCase):
    def prepare(self, root: Path) -> dict:
        task = base_task(status="IN_PROGRESS")
        task["task_id"] = "GOV-0001"
        task["branch"] = "main"
        task["base_branch"] = "main"
        task["branch_exception"] = {
            "kind": "bootstrap-main",
            "applies_only_to_task": "GOV-0001",
            "reason": "isolated transport test",
        }
        task["allowed_paths"] = [
            ".codex/**",
            ".github/**",
            ".gitignore",
            "AGENTS.md",
            "README.md",
            "docs/**",
            "project-control/**",
            "tools/governance/**",
        ]
        task["coordination"]["coordinator_task"] = "GOV-0001"
        task["coordination"]["unit_tasks"] = {
            "mac": "GOV-0001",
            "win": "GOV-0001",
            "backend": "GOV-0001",
        }
        initialize_root(root, task)
        project_path = root / "project-control" / "project.json"
        project = read_json(project_path)
        project["source_repository"] = "git@github.com:wzhic/material.git"
        write_json(project_path, project)
        (root / "README.md").write_text("# governed bootstrap\n", encoding="utf-8")
        git(root, "init")
        git(root, "symbolic-ref", "HEAD", "refs/heads/main")
        task["validation"]["results"] = [valid_local_pass(root, task)]
        task["status"] = "LOCAL_VERIFIED"
        write_json(root / "project-control" / "tasks" / "GOV-0001.json", task)
        return task

    def commit_content(self, root: Path) -> str:
        with mock.patch("reconcile.run_reconcile", return_value={"ok": True, "checks": []}):
            code = taskctl.main([
                "bootstrap-commit", "GOV-0001",
                "--stage", "content",
                "--actor", "Codex",
                "--root", str(root),
                "--json",
            ])
        self.assertEqual(0, code)
        content_sha = git(root, "rev-parse", "HEAD")
        self.assertEqual(1, len(git(root, "rev-list", "--parents", "-n", "1", content_sha).split()))
        return content_sha

    def prepare_repair(self, root: Path) -> None:
        governed = root / "tools" / "governance" / "core.py"
        governed.parent.mkdir(parents=True, exist_ok=True)
        governed.write_text("# explicit UTF-8 Git decoding\n", encoding="utf-8")
        task_path = root / "project-control" / "tasks" / "GOV-0001.json"
        task = read_json(task_path)
        task["rework_history"] = [{"review_id": BOOTSTRAP_REPAIR_REVIEW_ID}]
        task["validation"]["results"] = [valid_local_pass(root, task)]
        write_json(task_path, task)

    def commit_repair(self, root: Path, failed_root: str) -> str:
        self.prepare_repair(root)
        with mock.patch.object(core, "FAILED_BOOTSTRAP_ROOT_SHA", failed_root), mock.patch(
            "reconcile.run_reconcile", return_value={"ok": True, "checks": []}
        ):
            code = taskctl.main([
                "bootstrap-commit", "GOV-0001",
                "--stage", "content",
                "--actor", "Codex",
                "--root", str(root),
                "--json",
            ])
        self.assertEqual(0, code)
        repair_sha = git(root, "rev-parse", "HEAD")
        self.assertEqual(
            [repair_sha, failed_root],
            git(root, "rev-list", "--parents", "-n", "1", repair_sha).split(),
        )
        self.assertEqual(BOOTSTRAP_REPAIR_MESSAGE, git(root, "show", "-s", "--format=%s", repair_sha))
        return repair_sha

    def commit_second_repair(self, root: Path, failed_root: str, first_repair: str) -> str:
        governed = root / "tools" / "governance" / "reviewctl.py"
        governed.write_text("# locale-independent governance output\n", encoding="utf-8")
        governance_doc = root / "docs" / "governance" / "治理总则-GOV-0001-v1.0.md"
        governance_doc.parent.mkdir(parents=True, exist_ok=True)
        governance_doc.write_text("# finite second repair contract\n", encoding="utf-8")
        task_path = root / "project-control" / "tasks" / "GOV-0001.json"
        task = read_json(task_path)
        task.setdefault("rework_history", []).append({
            "review_id": SECOND_BOOTSTRAP_REPAIR_REVIEW_ID,
        })
        task["validation"]["results"] = [valid_local_pass(root, task)]
        write_json(task_path, task)
        with mock.patch.object(core, "FAILED_BOOTSTRAP_ROOT_SHA", failed_root), mock.patch.object(
            core, "FAILED_BOOTSTRAP_REPAIR_SHA", first_repair
        ), mock.patch("reconcile.run_reconcile", return_value={"ok": True, "checks": []}):
            code = taskctl.main([
                "bootstrap-commit", "GOV-0001",
                "--stage", "content",
                "--actor", "Codex",
                "--root", str(root),
                "--json",
            ])
        self.assertEqual(0, code)
        second_repair = git(root, "rev-parse", "HEAD")
        self.assertEqual(
            [second_repair, first_repair],
            git(root, "rev-list", "--parents", "-n", "1", second_repair).split(),
        )
        self.assertEqual(
            SECOND_BOOTSTRAP_REPAIR_MESSAGE,
            git(root, "show", "-s", "--format=%s", second_repair),
        )
        self.assertIn(
            "docs/governance/治理总则-GOV-0001-v1.0.md",
            git(root, "diff", "--name-only", first_repair + ".." + second_repair).splitlines(),
        )
        return second_repair

    def transition_and_commit_control(self, root: Path, content_sha: str) -> str:
        code = taskctl.main([
            "transition", "GOV-0001", "COMMITTED",
            "--actor", "Codex",
            "--reason", "record exact root content commit",
            "--commit", content_sha,
            "--root", str(root),
            "--json",
        ])
        self.assertEqual(0, code)
        code = taskctl.main([
            "bootstrap-commit", "GOV-0001",
            "--stage", "control",
            "--actor", "Codex",
            "--root", str(root),
            "--json",
        ])
        self.assertEqual(0, code)
        control_sha = git(root, "rev-parse", "HEAD")
        changed = git(root, "diff", "--name-only", content_sha + ".." + control_sha).splitlines()
        self.assertEqual(["project-control/tasks/GOV-0001.json"], changed)
        return control_sha

    def test_content_and_control_commits_are_exact_and_nonempty(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.prepare(root)
            content_sha = self.commit_content(root)
            control_sha = self.transition_and_commit_control(root, content_sha)
            self.assertNotEqual(content_sha, control_sha)
            self.assertEqual("", git(root, "status", "--porcelain", "--untracked-files=all"))

    def test_receipt_bound_committed_recovery_reruns_validation_before_direct_child(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.prepare(root)
            failed_content = self.commit_content(root)
            failed_control = self.transition_and_commit_control(root, failed_content)
            task_path = root / "project-control" / "tasks" / "GOV-0001.json"
            task = read_json(task_path)
            task["status"] = "BLOCKED"
            task["exception"] = {
                "previous_status": "COMMITTED",
                "reason": "GitHub Actions Run 987654 failed on every required runner",
                "recorded_at": "2026-08-19T00:00:00+00:00",
            }
            write_json(task_path, task)
            proposal_relative = "project-control/proposals/GOV-0001-R010-break-glass.json"
            contract = {
                "allowed_paths": [
                    "project-control/proposals/GOV-0001-R010-break-glass.json",
                    "project-control/reviews/GOV-0001-R010.json",
                    "project-control/tasks/GOV-0001.json",
                    "tools/governance/core.py",
                ],
                "commit_message": "fix(governance): recover receipt-bound bootstrap CI",
                "failed_content_sha": failed_content,
                "failed_control_head": failed_control,
                "failed_run_id": "987654",
                "from_previous_status": "COMMITTED",
                "from_status": "BLOCKED",
                "invariants": [
                    "no_validation_waiver",
                    "no_force_push",
                    "preserve_existing_history",
                    "controlled_local_validation_required",
                    "three_platform_ci_required",
                    "no_business_code_or_dependency_files",
                ],
                "operation_id": "GOV-0001-CI-RUN-987654-BREAK-GLASS",
                "review_id": "GOV-0001-R010",
                "schema_version": 1,
                "scope_version": task["scope_version"],
                "task_id": "GOV-0001",
            }
            digest = recovery_contract_digest(contract)
            write_json(root / proposal_relative, contract)
            write_json(root / "project-control" / "reviews" / "GOV-0001-R010.json", {
                "review_id": "GOV-0001-R010",
                "task_id": "GOV-0001",
                "kind": "irreversible_operation",
                "decision": "approved",
                "approver": "user",
                "scope_version": task["scope_version"],
                "scope_hash": canonical_scope_hash(task),
                "decided_at": "2026-08-19T00:00:00+00:00",
                "expires_at": "2099-08-20T00:00:00+00:00",
                "operation_id": contract["operation_id"],
                "target_digest": digest,
            })

            code = taskctl.main([
                "recover-committed", "GOV-0001",
                "--proposal", proposal_relative,
                "--actor", "Codex",
                "--reason", "exercise exact receipt-bound recovery",
                "--root", str(root),
                "--json",
            ])
            self.assertEqual(0, code)
            recovered = read_json(task_path)
            self.assertEqual("IN_PROGRESS", recovered["status"])
            self.assertEqual({}, recovered["git"])
            self.assertEqual([], recovered["validation"]["results"])
            self.assertEqual(digest, recovered["bootstrap_recovery"]["target_digest"])
            self.assertEqual(2, recovered["bootstrap_recovery"]["history_count"])
            self.assertTrue(run_reconcile(root, "session")["ok"])
            drifted = dict(contract)
            drifted["commit_message"] = "fix(governance): unreviewed drift"
            write_json(root / proposal_relative, drifted)
            drift_report = run_reconcile(root, "session")
            self.assertFalse(drift_report["ok"])
            self.assertIn(
                "bootstrap_recovery",
                [item["id"] for item in drift_report["checks"] if item["status"] == "failed"],
            )
            write_json(root / proposal_relative, contract)

            governed = root / "tools" / "governance" / "core.py"
            governed.parent.mkdir(parents=True, exist_ok=True)
            governed.write_text("# receipt-bound CI recovery\n", encoding="utf-8")
            recovered["validation"]["results"] = [valid_local_pass(root, recovered)]
            recovered["status"] = "LOCAL_VERIFIED"
            write_json(task_path, recovered)
            with mock.patch("reconcile.run_reconcile", return_value={"ok": True, "checks": []}):
                code = taskctl.main([
                    "bootstrap-commit", "GOV-0001",
                    "--stage", "content",
                    "--actor", "Codex",
                    "--root", str(root),
                    "--json",
                ])
            self.assertEqual(0, code)
            recovered_content = git(root, "rev-parse", "HEAD")
            self.assertEqual(
                [recovered_content, failed_control],
                git(root, "rev-list", "--parents", "-n", "1", recovered_content).split(),
            )
            self.assertEqual(contract["commit_message"], git(root, "show", "-s", "--format=%s"))
            self.assertEqual([], core.bootstrap_repair_commit_issues(root, recovered_content, recovered))
            recovered_control = self.transition_and_commit_control(root, recovered_content)
            required_jobs = [
                "Governance (ubuntu-latest)",
                "Governance (macos-latest)",
                "Governance (windows-latest)",
            ]
            github = {
                "provider": "github_actions_rest_v1",
                "repository": "wzhic/material",
                "workflow_path": ".github/workflows/governance.yml",
                "workflow_id": 77,
                "run_id": "12345",
                "run_attempt": 1,
                "event": "push",
                "head_sha": recovered_control,
                "head_branch": "main",
                "status": "completed",
                "conclusion": "success",
                "run_url": "https://github.com/wzhic/material/actions/runs/12345",
                "job_names": required_jobs,
                "required_job_names": required_jobs,
                "api_version": "2026-03-10",
                "verified_at": "2026-08-19T01:00:00+00:00",
            }
            with (
                mock.patch.dict(os.environ, {"MATERIAL_GITHUB_ACTIONS_READ_TOKEN": "secret"}),
                mock.patch("taskctl.verify_workflow_run", return_value=github),
            ):
                code = taskctl.main([
                    "sync-github-run", "GOV-0001",
                    "--phase", "ci",
                    "--run-id", "12345",
                    "--run-attempt", "1",
                    "--event", "push",
                    "--head-sha", recovered_control,
                    "--actor", "Codex",
                    "--root", str(root),
                    "--json",
                ])
            self.assertEqual(0, code)
            consumed = read_json(task_path)["bootstrap_recovery"]
            self.assertEqual("consumed", consumed["state"])
            self.assertEqual(recovered_content, consumed["consumed_content_sha"])
            self.assertEqual(recovered_control, consumed["consumed_control_head"])
            self.assertEqual("12345", consumed["consumed_run_id"])
            self.assertIsNotNone(core.active_bootstrap_recovery_contract(root, read_json(task_path)))
            consumed_task = read_json(task_path)
            consumed_task["bootstrap_recovery"]["activated_at"] = "2018-08-19T00:00:00+00:00"
            consumed_task["bootstrap_recovery"]["consumed_at"] = "2019-08-19T00:00:00+00:00"
            write_json(task_path, consumed_task)
            receipt_path = root / "project-control" / "reviews" / "GOV-0001-R010.json"
            historical_receipt = read_json(receipt_path)
            historical_receipt["decided_at"] = "2018-08-18T00:00:00+00:00"
            historical_receipt["expires_at"] = "2020-08-20T00:00:00+00:00"
            write_json(receipt_path, historical_receipt)
            self.assertIsNotNone(
                core.active_bootstrap_recovery_contract(root, read_json(task_path))
            )

    def test_receipt_bound_recovery_rejects_proposal_drift(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = self.prepare(root)
            proposal = {
                "allowed_paths": ["tools/governance/core.py"],
                "commit_message": "fix(governance): rejected drift",
                "failed_content_sha": "a" * 40,
                "failed_control_head": "b" * 40,
                "failed_run_id": "1",
                "from_previous_status": "COMMITTED",
                "from_status": "BLOCKED",
                "invariants": [
                    "no_validation_waiver",
                    "no_force_push",
                    "preserve_existing_history",
                    "controlled_local_validation_required",
                    "three_platform_ci_required",
                    "no_business_code_or_dependency_files",
                ],
                "operation_id": "GOV-0001-DRIFT",
                "review_id": "GOV-0001-R010",
                "schema_version": 1,
                "scope_version": task["scope_version"],
                "task_id": "GOV-0001",
            }
            with mock.patch(
                "core.find_effective_irreversible_operation_review",
                return_value=({"review_id": "GOV-0001-R010"}, "approved"),
            ):
                digest = recovery_contract_digest(proposal)
                core.validate_bootstrap_recovery_contract(
                    root, task, proposal, expected_digest=digest
                )
                proposal["commit_message"] = "fix(governance): tampered"
                with self.assertRaisesRegex(core.GovernanceError, "digest"):
                    core.validate_bootstrap_recovery_contract(
                        root, task, proposal, expected_digest=digest
                    )

    def test_pending_content_contract_binds_same_head_and_history_count(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = self.prepare(root)
            head = "c" * 40
            proposal = {
                "allowed_paths": ["tools/governance/core.py"],
                "commit_message": "fix(governance): seal migration root",
                "expected_history_count": 5,
                "failed_content_sha": head,
                "failed_control_head": head,
                "failed_run_id": "32230013274",
                "failure_stage": "content_ci_pending",
                "from_previous_status": "LOCAL_VERIFIED",
                "from_status": "BLOCKED",
                "invariants": [
                    "no_validation_waiver",
                    "no_force_push",
                    "preserve_existing_history",
                    "controlled_local_validation_required",
                    "three_platform_ci_required",
                    "no_business_code_or_dependency_files",
                ],
                "operation_id": "GOV-0001-PENDING-CONTENT",
                "review_id": "GOV-0001-R012",
                "rework_review_id": "GOV-0001-R011",
                "schema_version": 2,
                "scope_version": task["scope_version"],
                "task_id": task["task_id"],
            }
            with mock.patch(
                "core.find_effective_irreversible_operation_review",
                return_value=({"review_id": "GOV-0001-R012"}, "approved"),
            ):
                normalized = core.validate_bootstrap_recovery_contract(root, task, proposal)
                self.assertEqual(5, normalized["expected_history_count"])
                changed = dict(proposal)
                changed["failed_control_head"] = "d" * 40
                with self.assertRaisesRegex(core.GovernanceError, "same failed content"):
                    core.validate_bootstrap_recovery_contract(root, task, changed)

    def test_pending_content_recovery_replaces_only_reviewed_active_contract(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.prepare(root)
            head = self.commit_content(root)
            task_path = root / "project-control" / "tasks" / "GOV-0001.json"
            task = read_json(task_path)
            task["status"] = "IN_PROGRESS"
            task["validation"]["results"] = []
            task["git"] = {}
            task["bootstrap_recovery"] = {
                "activated_at": "2026-08-19T00:00:00+00:00",
                "activated_by": "Codex",
                "failed_content_sha": "a" * 40,
                "failed_control_head": "b" * 40,
                "failed_run_id": "1",
                "history_count": 1,
                "operation_id": "PRIOR-RECOVERY",
                "proposal_path": "project-control/proposals/prior.json",
                "review_id": "GOV-0001-R010",
                "state": "active",
                "target_digest": "sha256:" + "1" * 64,
            }
            subject = core.managed_content_subject(root, task)
            task["rework_history"] = [{
                "review_id": "GOV-0001-R011",
                "subject": subject,
                "to_status": "IN_PROGRESS",
            }]
            write_json(task_path, task)
            write_json(root / "project-control" / "reviews" / "GOV-0001-R011.json", {
                "review_id": "GOV-0001-R011",
                "task_id": "GOV-0001",
                "kind": "rework",
                "decision": "approved",
                "approver": "user",
                "scope_version": task["scope_version"],
                "scope_hash": canonical_scope_hash(task),
                "subject": subject,
                "from_status": "LOCAL_VERIFIED",
                "decided_at": "2026-08-19T00:00:00+00:00",
                "expires_at": "2099-08-20T00:00:00+00:00",
            })
            proposal_relative = "project-control/proposals/pending.json"
            write_json(root / proposal_relative, {})
            contract = {
                "schema_version": 2,
                "failure_stage": "content_ci_pending",
                "failed_content_sha": head,
                "failed_control_head": head,
                "failed_run_id": "32230013274",
                "expected_history_count": 1,
                "rework_review_id": "GOV-0001-R011",
                "review_id": "GOV-0001-R012",
                "operation_id": "PENDING-CONTENT-RECOVERY",
                "target_digest": "sha256:" + "2" * 64,
            }
            prior = {"recovery_state": "active"}
            with (
                mock.patch("taskctl.validate_bootstrap_recovery_contract", return_value=contract),
                mock.patch("taskctl.active_bootstrap_recovery_contract", return_value=prior),
                mock.patch("taskctl.bootstrap_repair_commit_issues", return_value=[]),
            ):
                code = taskctl.main([
                    "recover-pending-content", "GOV-0001",
                    "--proposal", proposal_relative,
                    "--actor", "Codex",
                    "--reason", "replace failed pending content recovery",
                    "--root", str(root),
                    "--json",
                ])
            self.assertEqual(0, code)
            stored = read_json(task_path)
            self.assertEqual("GOV-0001-R012", stored["bootstrap_recovery"]["review_id"])
            self.assertEqual(head, stored["bootstrap_recovery"]["failed_control_head"])
            self.assertEqual(
                "receipt_bound_pending_content_recovery",
                stored["history"][-1]["event"],
            )

    def test_control_commit_rejects_ordinary_content(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.prepare(root)
            content_sha = self.commit_content(root)
            code = taskctl.main([
                "transition", "GOV-0001", "COMMITTED",
                "--actor", "Codex",
                "--reason", "record exact root content commit",
                "--commit", content_sha,
                "--root", str(root),
                "--json",
            ])
            self.assertEqual(0, code)
            (root / "docs" / "ordinary.md").write_text("ordinary\n", encoding="utf-8")
            code = taskctl.main([
                "bootstrap-commit", "GOV-0001",
                "--stage", "control",
                "--actor", "Codex",
                "--root", str(root),
                "--json",
            ])
            self.assertEqual(2, code)
            self.assertEqual(content_sha, git(root, "rev-parse", "HEAD"))

    def test_empty_remote_content_then_fast_forward_control_push(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "work"
            remote = Path(temporary) / "remote.git"
            root.mkdir()
            remote.mkdir()
            git(remote, "init", "--bare")
            self.prepare(root)
            content_sha = self.commit_content(root)
            with mock.patch.object(taskctl, "_BOOTSTRAP_PUSH_URL", str(remote)):
                code = taskctl.main([
                    "bootstrap-push", "GOV-0001",
                    "--stage", "content",
                    "--actor", "Codex",
                    "--root", str(root),
                    "--json",
                ])
                self.assertEqual(0, code)
                self.assertEqual(
                    content_sha,
                    git(remote, "rev-parse", "refs/heads/main"),
                )
                control_sha = self.transition_and_commit_control(root, content_sha)
                code = taskctl.main([
                    "bootstrap-push", "GOV-0001",
                    "--stage", "control",
                    "--actor", "Codex",
                    "--root", str(root),
                    "--json",
                ])
                self.assertEqual(0, code)
                self.assertEqual(control_sha, git(remote, "rev-parse", "refs/heads/main"))
            self.assertEqual(
                "git@github.com:wzhic/material.git",
                git(root, "remote", "get-url", "origin"),
            )

    def test_failed_root_repair_and_control_are_both_non_force_fast_forwards(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "work"
            remote = Path(temporary) / "remote.git"
            root.mkdir()
            remote.mkdir()
            git(remote, "init", "--bare")
            self.prepare(root)
            failed_root = self.commit_content(root)
            with mock.patch.object(taskctl, "_BOOTSTRAP_PUSH_URL", str(remote)):
                self.assertEqual(0, taskctl.main([
                    "bootstrap-push", "GOV-0001", "--stage", "content",
                    "--actor", "Codex", "--root", str(root), "--json",
                ]))
            repair_sha = self.commit_repair(root, failed_root)
            with mock.patch.object(core, "FAILED_BOOTSTRAP_ROOT_SHA", failed_root), mock.patch.object(
                taskctl, "_BOOTSTRAP_PUSH_URL", str(remote)
            ):
                self.assertEqual(0, taskctl.main([
                    "bootstrap-push", "GOV-0001", "--stage", "content",
                    "--actor", "Codex", "--root", str(root), "--json",
                ]))
                self.assertEqual(repair_sha, git(remote, "rev-parse", "refs/heads/main"))
                control_sha = self.transition_and_commit_control(root, repair_sha)
                self.assertEqual(0, taskctl.main([
                    "bootstrap-push", "GOV-0001", "--stage", "control",
                    "--actor", "Codex", "--root", str(root), "--json",
                ]))
                self.assertEqual(control_sha, git(remote, "rev-parse", "refs/heads/main"))

    def test_second_windows_repair_is_exact_non_force_and_exhausts_chain(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "work"
            remote = Path(temporary) / "remote.git"
            root.mkdir()
            remote.mkdir()
            git(remote, "init", "--bare")
            self.prepare(root)
            failed_root = self.commit_content(root)
            with mock.patch.object(taskctl, "_BOOTSTRAP_PUSH_URL", str(remote)):
                self.assertEqual(0, taskctl.main([
                    "bootstrap-push", "GOV-0001", "--stage", "content",
                    "--actor", "Codex", "--root", str(root), "--json",
                ]))
            first_repair = self.commit_repair(root, failed_root)
            with mock.patch.object(core, "FAILED_BOOTSTRAP_ROOT_SHA", failed_root), mock.patch.object(
                taskctl, "_BOOTSTRAP_PUSH_URL", str(remote)
            ):
                self.assertEqual(0, taskctl.main([
                    "bootstrap-push", "GOV-0001", "--stage", "content",
                    "--actor", "Codex", "--root", str(root), "--json",
                ]))
            second_repair = self.commit_second_repair(root, failed_root, first_repair)
            with mock.patch.object(core, "FAILED_BOOTSTRAP_ROOT_SHA", failed_root), mock.patch.object(
                core, "FAILED_BOOTSTRAP_REPAIR_SHA", first_repair
            ), mock.patch.object(taskctl, "_BOOTSTRAP_PUSH_URL", str(remote)):
                self.assertEqual(0, taskctl.main([
                    "bootstrap-push", "GOV-0001", "--stage", "content",
                    "--actor", "Codex", "--root", str(root), "--json",
                ]))
                self.assertEqual(second_repair, git(remote, "rev-parse", "refs/heads/main"))
                control_sha = self.transition_and_commit_control(root, second_repair)
                self.assertEqual(0, taskctl.main([
                    "bootstrap-push", "GOV-0001", "--stage", "control",
                    "--actor", "Codex", "--root", str(root), "--json",
                ]))
                self.assertEqual(control_sha, git(remote, "rev-parse", "refs/heads/main"))
