from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


GOVERNANCE_DIR = Path(__file__).resolve().parents[1]
if str(GOVERNANCE_DIR) not in sys.path:
    sys.path.insert(0, str(GOVERNANCE_DIR))

import taskctl  # noqa: E402
from core import read_json, task_path  # noqa: E402
from helpers import AuthenticatedReceiptTestCase, base_task, initialize_root, write_json  # noqa: E402


CONTENT = "a" * 40
CONTROL = "b" * 40


class GitHubSyncTests(AuthenticatedReceiptTestCase):
    def _root(self, temporary: str, phase: str = "ci") -> tuple[Path, dict]:
        root = Path(temporary)
        state = "COMMITTED" if phase == "ci" else "MERGED"
        task = base_task(status=state)
        task["git"] = {"committed_sha": CONTENT}
        if phase == "post_merge":
            task["git"].update({"ci_verified_sha": CONTENT, "merged_sha": CONTENT})
            task["branch"] = "main"
            task["base_branch"] = "main"
            task["task_id"] = "GOV-0001"
            task["coordination"]["coordinator_task"] = "GOV-0001"
            task["coordination"]["unit_tasks"] = {
                "mac": "GOV-0001", "win": "GOV-0001", "backend": "GOV-0001",
            }
        initialize_root(root, task)
        return root, task

    @staticmethod
    def _github(event: str, branch: str) -> dict:
        required_jobs = (
            [
                "Governance (macos-latest)",
                "Governance (ubuntu-latest)",
                "Governance (windows-latest)",
            ]
            if event == "pull_request"
            else ["Governance (ubuntu-latest)"]
        )
        return {
            "provider": "github_actions_rest_v1",
            "repository": "wzhic/material",
            "workflow_path": ".github/workflows/governance.yml",
            "workflow_id": 77,
            "run_id": "12345",
            "run_attempt": 2,
            "event": event,
            "head_sha": CONTROL,
            "head_branch": branch,
            "status": "completed",
            "conclusion": "success",
            "run_url": "https://github.com/wzhic/material/actions/runs/12345",
            "job_names": required_jobs,
            "required_job_names": required_jobs,
            "api_version": "2026-03-10",
            "verified_at": "2026-08-19T00:00:00+00:00",
        }

    def test_sync_imports_pass_only_after_online_verification(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root, task = self._root(temporary)
            with (
                mock.patch.dict(os.environ, {"MATERIAL_GITHUB_ACTIONS_READ_TOKEN": "secret"}),
                mock.patch("taskctl._verify_content_control_commits") as commit_check,
                mock.patch(
                    "taskctl.verify_workflow_run",
                    return_value=self._github("pull_request", task["branch"]),
                ) as verifier,
            ):
                code = taskctl.main([
                    "sync-github-run", task["task_id"],
                    "--phase", "ci", "--run-id", "12345", "--run-attempt", "2",
                    "--event", "pull_request", "--head-sha", CONTROL,
                    "--actor", "Codex", "--root", str(root), "--json",
                ])
            self.assertEqual(0, code)
            commit_check.assert_called_once_with(root.resolve(), CONTENT, CONTROL)
            self.assertEqual("secret", verifier.call_args.kwargs["token"])
            stored = read_json(task_path(root, task["task_id"]))
            result = stored["validation"]["results"][-1]
            self.assertEqual("passed", result["status"])
            self.assertEqual("github_actions_rest_v1", result["source"])
            self.assertEqual("commit:" + CONTENT, result["subject"])
            self.assertEqual(CONTENT, result["github"]["content_subject_sha"])
            self.assertEqual(CONTROL, result["github"]["control_head_sha"])
            self.assertNotIn("secret", repr(stored))

    def test_missing_private_credential_fails_without_writing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root, task = self._root(temporary)
            with (
                mock.patch.dict(os.environ, {}, clear=True),
                mock.patch("taskctl._verify_content_control_commits"),
            ):
                code = taskctl.main([
                    "sync-github-run", task["task_id"],
                    "--phase", "ci", "--run-id", "12345", "--run-attempt", "1",
                    "--event", "pull_request", "--head-sha", CONTROL,
                    "--actor", "Codex", "--root", str(root), "--json",
                ])
            self.assertEqual(2, code)
            self.assertEqual([], read_json(task_path(root, task["task_id"]))["validation"]["results"])

    def test_content_control_mismatch_and_wrong_phase_event_fail(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root, task = self._root(temporary)
            with mock.patch(
                "taskctl._verify_content_control_commits",
                side_effect=taskctl.GovernanceError("ordinary project changes"),
            ):
                code = taskctl.main([
                    "sync-github-run", task["task_id"],
                    "--phase", "ci", "--run-id", "12345", "--run-attempt", "1",
                    "--event", "pull_request", "--head-sha", CONTROL,
                    "--actor", "Codex", "--root", str(root), "--json",
                ])
            self.assertEqual(2, code)

        with tempfile.TemporaryDirectory() as temporary:
            root, task = self._root(temporary, "post_merge")
            code = taskctl.main([
                "sync-github-run", task["task_id"],
                "--phase", "post_merge", "--run-id", "12345", "--run-attempt", "1",
                "--event", "pull_request", "--head-sha", CONTROL,
                "--actor", "Codex", "--root", str(root), "--json",
            ])
            self.assertEqual(2, code)


if __name__ == "__main__":
    unittest.main()
