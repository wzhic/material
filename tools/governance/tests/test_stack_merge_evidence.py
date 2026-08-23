from __future__ import annotations

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
from reconcile import _completed_successor_merge_coverage


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
