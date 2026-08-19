from __future__ import annotations

import tempfile
from pathlib import Path
from unittest import mock

from helpers import (
    AuthenticatedReceiptTestCase,
    base_task,
    initialize_root,
    valid_local_pass,
    write_json,
)

import taskctl
import core
from core import (
    BOOTSTRAP_REPAIR_MESSAGE,
    BOOTSTRAP_REPAIR_REVIEW_ID,
    SECOND_BOOTSTRAP_REPAIR_MESSAGE,
    SECOND_BOOTSTRAP_REPAIR_REVIEW_ID,
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
