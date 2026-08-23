from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
import sys
from pathlib import Path

GOVERNANCE_DIR = Path(__file__).resolve().parents[1]
if str(GOVERNANCE_DIR) not in sys.path:
    sys.path.insert(0, str(GOVERNANCE_DIR))

from core import validation_gate_status
from helpers import base_task, initialize_root, valid_local_pass, write_json
from reconcile import _ci_commit_protocol_check, _completed_successor_merge_coverage


def git(root: Path, *arguments: str) -> str:
    result = subprocess.run(
        ["git", *arguments], cwd=str(root), text=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
    )
    if result.returncode != 0:
        raise AssertionError(result.stderr or result.stdout)
    return result.stdout.strip()


class StackMergeEvidenceTests(unittest.TestCase):
    def _base_sync_history(self, root: Path, rewrite: bool = False):
        task = base_task(status="COMMITTED")
        initialize_root(root, task)
        git(root, "init", "--quiet")
        git(root, "config", "user.name", "Stack Test")
        git(root, "config", "user.email", "stack@example.invalid")
        base_file = root / "tools" / "governance" / "base-sync.py"
        base_file.parent.mkdir(parents=True, exist_ok=True)
        base_file.write_text("value = 'initial'\n", encoding="utf-8")
        git(root, "add", "--all")
        git(root, "commit", "-m", "root")
        git(root, "branch", "-M", "base")
        git(root, "switch", "-c", "feature")
        feature_file = root / "docs" / "feature.md"
        feature_file.write_text("feature\n", encoding="utf-8")
        git(root, "add", "--all")
        git(root, "commit", "-m", "feature content")
        subject = git(root, "rev-parse", "HEAD")
        task["git"] = {"committed_sha": subject}
        write_json(root / "project-control" / "tasks" / "GOV-TEST.json", task)
        git(root, "switch", "base")
        base_file.write_text("value = 'base'\n", encoding="utf-8")
        git(root, "add", "--all")
        git(root, "commit", "-m", "base update")
        trusted_base = git(root, "rev-parse", "HEAD")
        git(root, "switch", "feature")
        git(root, "merge", "--no-ff", "--no-commit", "base")
        if rewrite:
            base_file.write_text("value = 'rewritten'\n", encoding="utf-8")
            git(root, "add", str(base_file.relative_to(root)))
        git(root, "commit", "-m", "sync base")
        return task, subject, git(root, "rev-parse", "HEAD"), trusted_base

    def test_trusted_base_sync_merge_is_covered_without_successor_task(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task, subject, head, trusted_base = self._base_sync_history(root)
            covered, errors, details = _completed_successor_merge_coverage(
                root, task, subject, head, trusted_base=trusted_base
            )
            self.assertEqual([], errors)
            self.assertIn("tools/governance/base-sync.py", covered)
            self.assertEqual("trusted_base_sync", details[0]["kind"])

    def test_trusted_base_sync_rejects_conflict_or_extra_rewrite(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task, subject, head, trusted_base = self._base_sync_history(root, rewrite=True)
            _covered, errors, _details = _completed_successor_merge_coverage(
                root, task, subject, head, trusted_base=trusted_base
            )
            self.assertTrue(errors)
            self.assertIn("does not match Git's clean merge result", errors[0])

    def test_pr_commit_protocol_accepts_clean_base_move_past_subject(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task, subject, head, trusted_base = self._base_sync_history(root)
            project = json.loads(
                (root / "project-control" / "project.json").read_text(encoding="utf-8")
            )
            check, context = _ci_commit_protocol_check(
                root,
                project,
                task,
                {
                    "event": "pull_request",
                    "base_sha": trusted_base,
                    "head_sha": head,
                    "head_branch": task["branch"],
                    "diff_base_sha": trusted_base,
                    "created": False,
                },
            )
            self.assertEqual("passed", check["status"])
            self.assertTrue(context["base_moved_past_content_subject"])

    def test_pr_commit_protocol_rejects_rewritten_base_move(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task, _subject, head, trusted_base = self._base_sync_history(root, rewrite=True)
            project = json.loads(
                (root / "project-control" / "project.json").read_text(encoding="utf-8")
            )
            check, _context = _ci_commit_protocol_check(
                root,
                project,
                task,
                {
                    "event": "pull_request",
                    "base_sha": trusted_base,
                    "head_sha": head,
                    "head_branch": task["branch"],
                    "diff_base_sha": trusted_base,
                    "created": False,
                },
            )
            self.assertEqual("failed", check["status"])
            self.assertIn("does not match Git's clean merge result", check["message"])

    def test_completed_successor_recursion_uses_its_merge_first_parent(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            parent = base_task(status="COMMITTED")
            parent["task_id"] = "GOV-PARENT"
            parent["branch"] = "parent"
            parent["base_branch"] = "main"
            parent["coordination"]["coordinator_task"] = "GOV-PARENT"
            parent["coordination"]["unit_tasks"] = {
                unit: "GOV-PARENT" for unit in parent["release_units"]
            }
            initialize_root(root, parent)
            git(root, "init", "--quiet")
            git(root, "config", "user.name", "Stack Test")
            git(root, "config", "user.email", "stack@example.invalid")
            governed = root / "tools" / "governance"
            governed.mkdir(parents=True, exist_ok=True)
            (governed / "root.py").write_text("root = True\n", encoding="utf-8")
            git(root, "add", "--all")
            git(root, "commit", "-m", "root")
            git(root, "branch", "-M", "parent")
            (governed / "parent.py").write_text("parent = True\n", encoding="utf-8")
            git(root, "add", "--all")
            git(root, "commit", "-m", "parent content")
            parent_subject = git(root, "rev-parse", "HEAD")

            git(root, "switch", "-c", "child")
            (governed / "child.py").write_text("child = True\n", encoding="utf-8")
            git(root, "add", "--all")
            git(root, "commit", "-m", "child content")
            child_subject = git(root, "rev-parse", "HEAD")

            git(root, "switch", "-c", "base-fix", "parent")
            (governed / "base-fix.py").write_text("fix = True\n", encoding="utf-8")
            git(root, "add", "--all")
            git(root, "commit", "-m", "base fix content")
            base_fix_subject = git(root, "rev-parse", "HEAD")
            git(root, "switch", "parent")
            git(root, "merge", "--no-ff", "base-fix", "-m", "merge base fix")
            base_fix_merge = git(root, "rev-parse", "HEAD")

            git(root, "switch", "child")
            git(root, "merge", "--no-ff", "parent", "-m", "sync parent")
            child_head = git(root, "rev-parse", "HEAD")
            git(root, "switch", "parent")
            git(root, "merge", "--no-ff", "child", "-m", "merge child")
            outer_head = git(root, "rev-parse", "HEAD")

            base_fix = base_task(status="DONE")
            base_fix.update({
                "task_id": "GOV-BASE-FIX",
                "branch": "base-fix",
                "base_branch": "parent",
                "git": {"committed_sha": base_fix_subject, "merged_sha": base_fix_merge},
            })
            base_fix["coordination"]["coordinator_task"] = "GOV-BASE-FIX"
            base_fix["coordination"]["unit_tasks"] = {
                unit: "GOV-BASE-FIX" for unit in base_fix["release_units"]
            }
            child = base_task(status="DONE")
            child.update({
                "task_id": "GOV-CHILD",
                "branch": "child",
                "base_branch": "parent",
                "git": {"committed_sha": child_subject, "merged_sha": outer_head},
            })
            child["coordination"]["coordinator_task"] = "GOV-CHILD"
            child["coordination"]["unit_tasks"] = {
                unit: "GOV-CHILD" for unit in child["release_units"]
            }
            parent["git"] = {"committed_sha": parent_subject}
            write_json(root / "project-control" / "tasks" / "GOV-PARENT.json", parent)
            write_json(root / "project-control" / "tasks" / "GOV-BASE-FIX.json", base_fix)
            write_json(root / "project-control" / "tasks" / "GOV-CHILD.json", child)

            covered, errors, details = _completed_successor_merge_coverage(
                root, parent, parent_subject, outer_head
            )
            self.assertEqual([], errors)
            self.assertIn("tools/governance/base-fix.py", covered)
            self.assertIn("tools/governance/child.py", covered)
            child_details = next(item for item in details if item.get("task_id") == "GOV-CHILD")
            self.assertEqual("trusted_base_sync", child_details["successor_merges"][0]["kind"])

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
