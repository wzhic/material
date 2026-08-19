from __future__ import annotations

import contextlib
import io
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


GOVERNANCE_DIR = Path(__file__).resolve().parents[1]
if str(GOVERNANCE_DIR) not in sys.path:
    sys.path.insert(0, str(GOVERNANCE_DIR))

import core  # noqa: E402
import taskctl  # noqa: E402
from core import managed_content_subject, read_json, validation_gate_status  # noqa: E402
from helpers import (  # noqa: E402
    AuthenticatedReceiptTestCase,
    base_task,
    initialize_root,
    valid_github_pass,
    valid_local_pass,
    write_json,
)


COMMIT_A = "a" * 40
COMMIT_B = "b" * 40
RUN_ID = "12345"
RUN_URL = "https://github.com/example/material/actions/runs/12345"


class ValidationEvidenceTests(AuthenticatedReceiptTestCase):
    def test_local_result_cannot_satisfy_ci_or_post_merge(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = initialize_root(root)
            task["validation"]["results"] = [valid_local_pass(root, task)]
            write_json(root / "project-control" / "tasks" / "GOV-TEST.json", task)
            stored = read_json(root / "project-control" / "tasks" / "GOV-TEST.json")
            self.assertEqual([], validation_gate_status(root, stored, "LOCAL_VERIFIED")["missing"])
            self.assertEqual("unit", validation_gate_status(root, stored, "CI_VERIFIED")["missing"][0]["check_id"])
            self.assertEqual("unit", validation_gate_status(root, stored, "POST_MERGE_VERIFIED")["missing"][0]["check_id"])

    def test_managed_file_change_invalidates_local_result(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = initialize_root(root)
            governed_file = root / "tools" / "governance" / "subject.txt"
            governed_file.parent.mkdir(parents=True, exist_ok=True)
            governed_file.write_text("before\n", encoding="utf-8")
            task["validation"]["results"] = [valid_local_pass(root, task)]
            write_json(root / "project-control" / "tasks" / "GOV-TEST.json", task)
            stored = read_json(root / "project-control" / "tasks" / "GOV-TEST.json")
            self.assertEqual([], validation_gate_status(root, stored, "LOCAL_VERIFIED")["missing"])
            governed_file.write_text("after\n", encoding="utf-8")
            gate = validation_gate_status(root, stored, "LOCAL_VERIFIED")
            self.assertEqual("unit", gate["missing"][0]["check_id"])
            self.assertIn("subject", gate["missing"][0]["reason"])

    @unittest.skipIf(os.name == "nt", "Windows does not expose the Git executable-bit distinction via chmod")
    def test_executable_bit_change_invalidates_local_result(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = initialize_root(root)
            governed_file = root / "tools" / "governance" / "subject.sh"
            governed_file.parent.mkdir(parents=True, exist_ok=True)
            governed_file.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            os.chmod(str(governed_file), stat.S_IMODE(governed_file.stat().st_mode) & ~0o111)
            task["validation"]["results"] = [valid_local_pass(root, task)]
            write_json(root / "project-control" / "tasks" / "GOV-TEST.json", task)
            stored = read_json(root / "project-control" / "tasks" / "GOV-TEST.json")
            self.assertEqual([], validation_gate_status(root, stored, "LOCAL_VERIFIED")["missing"])
            os.chmod(str(governed_file), stat.S_IMODE(governed_file.stat().st_mode) | stat.S_IXUSR)
            gate = validation_gate_status(root, stored, "LOCAL_VERIFIED")
            self.assertEqual("unit", gate["missing"][0]["check_id"])
            self.assertIn("subject", gate["missing"][0]["reason"])

    def test_tracked_executable_mode_uses_git_index_not_host_mode(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = initialize_root(root)
            governed_file = root / "tools" / "governance" / "subject.sh"
            governed_file.parent.mkdir(parents=True, exist_ok=True)
            governed_file.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            relative = governed_file.relative_to(root).as_posix()
            original_lstat = os.lstat

            def lstat_with_permissions(permissions: int):
                def fake_lstat(path: object) -> os.stat_result:
                    result = original_lstat(path)
                    if Path(path) == governed_file:
                        values = list(result)
                        values[stat.ST_MODE] = (values[stat.ST_MODE] & ~0o777) | permissions
                        return os.stat_result(values)
                    return result

                return fake_lstat

            with mock.patch.object(core, "_tracked_git_modes", return_value={relative: "100755"}):
                with mock.patch.object(core.os, "lstat", side_effect=lstat_with_permissions(0o644)):
                    non_posix_checkout = managed_content_subject(root, task)
                with mock.patch.object(core.os, "lstat", side_effect=lstat_with_permissions(0o755)):
                    posix_checkout = managed_content_subject(root, task)
            self.assertEqual(non_posix_checkout, posix_checkout)

    def test_git_index_executable_class_changes_subject(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = initialize_root(root)
            governed_file = root / "tools" / "governance" / "subject.sh"
            governed_file.parent.mkdir(parents=True, exist_ok=True)
            governed_file.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            relative = governed_file.relative_to(root).as_posix()
            with mock.patch.object(core, "_tracked_git_modes", return_value={relative: "100644"}):
                regular_subject = managed_content_subject(root, task)
            with mock.patch.object(core, "_tracked_git_modes", return_value={relative: "100755"}):
                executable_subject = managed_content_subject(root, task)
            self.assertNotEqual(regular_subject, executable_subject)

    def test_tracked_git_modes_parse_stage_zero_records(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / ".git").mkdir()
            (root / ".git" / "index").write_bytes(b"test-index-marker")
            output = (
                "100755 0123456789012345678901234567890123456789 0\ttools/governance/a.sh\0"
                "100644 1234567890123456789012345678901234567890 0\tdocs/a name.md\0"
            )
            with mock.patch.object(core, "run_git", return_value=(output, None)):
                self.assertEqual(
                    {
                        "docs/a name.md": "100644",
                        "tools/governance/a.sh": "100755",
                    },
                    core._tracked_git_modes(root),
                )

    def test_nonpassing_ci_result_requires_matching_commit_and_environment(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = base_task(status="COMMITTED")
            task["git"] = {"committed_sha": COMMIT_A}
            initialize_root(root, task)
            task_file = root / "project-control" / "tasks" / "GOV-TEST.json"
            write_json(task_file, task)

            with contextlib.redirect_stderr(io.StringIO()):
                wrong = taskctl.main([
                    "record-validation", task["task_id"], "--check", "unit", "--status", "failed",
                    "--phase", "ci", "--commit", COMMIT_B, "--environment", "github-actions",
                    "--run-id", RUN_ID, "--run-url", RUN_URL,
                    "--evidence", "run 1", "--actor", "ci", "--root", str(root),
                ])
            self.assertEqual(2, wrong)

            with contextlib.redirect_stderr(io.StringIO()):
                missing_run = taskctl.main([
                    "record-validation", task["task_id"], "--check", "unit", "--status", "failed",
                    "--phase", "ci", "--commit", COMMIT_A, "--environment", "github-actions",
                    "--evidence", "no durable run", "--actor", "ci", "--root", str(root),
                ])
            self.assertEqual(2, missing_run)

            with contextlib.redirect_stdout(io.StringIO()):
                accepted = taskctl.main([
                    "record-validation", task["task_id"], "--check", "unit", "--status", "failed",
                    "--phase", "ci", "--commit", COMMIT_A, "--environment", "github-actions",
                    "--run-id", RUN_ID, "--run-url", RUN_URL,
                    "--evidence", "run 2", "--actor", "ci", "--root", str(root),
                ])
            self.assertEqual(0, accepted)
            stored = read_json(task_file)
            result = stored["validation"]["results"][-1]
            self.assertEqual("commit:" + COMMIT_A, result["subject"])
            self.assertEqual("github-actions", result["environment"])
            self.assertEqual(RUN_ID, result["run_id"])
            self.assertEqual(RUN_URL, result["run_url"])
            self.assertEqual("failed", result["status"])
            self.assertEqual("unit", validation_gate_status(root, stored, "CI_VERIFIED")["missing"][0]["check_id"])

    def test_public_cli_cannot_turn_a_hardcoded_github_url_into_pass(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = base_task(status="COMMITTED")
            task["git"] = {"committed_sha": COMMIT_A}
            initialize_root(root, task)
            task_file = root / "project-control" / "tasks" / "GOV-TEST.json"
            error = io.StringIO()
            with contextlib.redirect_stderr(error):
                rejected = taskctl.main([
                    "record-validation", task["task_id"], "--check", "unit", "--status", "passed",
                    "--phase", "ci", "--commit", COMMIT_A, "--environment", "github-actions",
                    "--run-id", RUN_ID, "--run-url", RUN_URL,
                    "--evidence", "hardcoded URL is not runner proof", "--actor", "ci",
                    "--root", str(root),
                ])
            self.assertEqual(2, rejected)
            self.assertIn("controlled runner", error.getvalue())
            self.assertEqual([], read_json(task_file)["validation"]["results"])

    def test_validation_phase_can_only_be_recorded_at_its_lifecycle_state(self) -> None:
        cases = (
            ("local", "APPROVED", []),
            ("ci", "IN_PROGRESS", ["--commit", COMMIT_A, "--environment", "ci"]),
            ("post_merge", "COMMITTED", ["--commit", COMMIT_A, "--environment", "prod"]),
        )
        for phase, status, extra in cases:
            with self.subTest(phase=phase), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                task = base_task(status=status)
                task["git"] = {"committed_sha": COMMIT_A, "merged_sha": COMMIT_A}
                initialize_root(root, task)
                with contextlib.redirect_stderr(io.StringIO()):
                    result = taskctl.main([
                        "record-validation", task["task_id"], "--check", "unit",
                        "--status", "failed", "--phase", phase, "--evidence", "invalid phase",
                        "--actor", "test", "--root", str(root),
                    ] + extra)
                self.assertEqual(2, result)

    def test_local_and_ci_evidence_drive_commit_lifecycle_without_self_invalidation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = initialize_root(root)
            task_file = root / "project-control" / "tasks" / "GOV-TEST.json"
            task["validation"]["results"] = [valid_local_pass(root, task)]
            write_json(task_file, task)

            with contextlib.redirect_stdout(io.StringIO()):
                local_verified = taskctl.main([
                    "transition", task["task_id"], "LOCAL_VERIFIED", "--actor", "Codex",
                    "--reason", "local checks passed", "--root", str(root),
                ])
            self.assertEqual(0, local_verified)
            with contextlib.redirect_stderr(io.StringIO()):
                missing_commit = taskctl.main([
                    "transition", task["task_id"], "COMMITTED", "--actor", "Codex",
                    "--reason", "missing commit subject", "--root", str(root),
                ])
            self.assertEqual(2, missing_commit)
            with contextlib.redirect_stdout(io.StringIO()):
                committed = taskctl.main([
                    "transition", task["task_id"], "COMMITTED", "--actor", "Codex",
                    "--reason", "content commit recorded", "--commit", COMMIT_A,
                    "--root", str(root),
                ])
            self.assertEqual(0, committed)

            committed_task = read_json(task_file)
            committed_task["validation"]["results"].append(
                valid_github_pass(committed_task, "ci", COMMIT_A, COMMIT_B)
            )
            write_json(task_file, committed_task)
            with contextlib.redirect_stdout(io.StringIO()):
                ci_verified = taskctl.main([
                    "transition", task["task_id"], "CI_VERIFIED", "--actor", "Codex",
                    "--reason", "CI evidence matched", "--root", str(root),
                ])
            self.assertEqual(0, ci_verified)
            stored = read_json(root / "project-control" / "tasks" / "GOV-TEST.json")
            self.assertEqual(COMMIT_A, stored["git"]["committed_sha"])
            self.assertEqual(COMMIT_A, stored["git"]["ci_verified_sha"])

    def test_changing_gate_commit_invalidates_existing_ci_result(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = base_task(status="COMMITTED")
            task["git"] = {"committed_sha": COMMIT_A}
            initialize_root(root, task)
            task["validation"]["results"] = [
                valid_github_pass(task, "ci", COMMIT_A, COMMIT_B)
            ]
            write_json(root / "project-control" / "tasks" / "GOV-TEST.json", task)
            stored = read_json(root / "project-control" / "tasks" / "GOV-TEST.json")
            stored["git"]["committed_sha"] = COMMIT_B
            gate = validation_gate_status(root, stored, "CI_VERIFIED")
            self.assertEqual("unit", gate["missing"][0]["check_id"])
            self.assertIn("subject", gate["missing"][0]["reason"])

    def test_bare_pass_claim_and_tampered_runner_evidence_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = initialize_root(root)
            task["validation"]["results"] = [{
                "check_id": "unit",
                "status": "passed",
                "phase": "local",
                "subject": managed_content_subject(root, task),
                "environment": "claimed-local",
                "evidence": "self assertion",
                "actor": "Codex",
                "recorded_at": "2026-08-19T00:00:00+00:00",
            }]
            gate = validation_gate_status(root, task, "LOCAL_VERIFIED")
            self.assertIn("provenance", gate["missing"][0]["reason"])

            result = valid_local_pass(root, initialize_root(root))
            result["exit_code"] = 9
            task = read_json(root / "project-control" / "tasks" / "GOV-TEST.json")
            task["validation"]["results"] = [result]
            gate = validation_gate_status(root, task, "LOCAL_VERIFIED")
            self.assertIn("zero non-timeout exit", gate["missing"][0]["reason"])

    def test_structural_github_url_without_rest_provenance_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = base_task(status="COMMITTED")
            task["git"] = {"committed_sha": COMMIT_A}
            initialize_root(root, task)
            task["validation"]["results"] = [{
                "check_id": "unit",
                "status": "passed",
                "phase": "ci",
                "subject": "commit:" + COMMIT_A,
                "environment": "github-actions",
                "run_id": RUN_ID,
                "run_url": "https://github.com/wzhic/material/actions/runs/" + RUN_ID,
                "source": "github_actions_rest_v1",
                "evidence": "URL only",
                "actor": "Codex",
                "recorded_at": "2026-08-19T00:00:00+00:00",
            }]
            gate = validation_gate_status(root, task, "CI_VERIFIED")
            self.assertIn("GitHub REST evidence", gate["missing"][0]["reason"])

    def test_unit_scoped_results_must_cover_every_reviewed_release_unit(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = initialize_root(root)
            task["validation"]["results"] = [
                valid_local_pass(root, task, release_unit="mac"),
                valid_local_pass(root, task, release_unit="win"),
            ]
            partial = validation_gate_status(root, task, "LOCAL_VERIFIED")
            self.assertEqual(["backend"], [item.get("release_unit") for item in partial["missing"]])

            task["validation"]["results"].append(
                valid_local_pass(root, task, release_unit="backend")
            )
            complete = validation_gate_status(root, task, "LOCAL_VERIFIED")
            self.assertEqual([], complete["missing"])
            self.assertEqual(["unit"], complete["passed"])

    def test_later_unit_failure_overrides_an_earlier_common_pass_for_that_unit(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = initialize_root(root)
            task["validation"]["results"] = [valid_local_pass(root, task)]
            task["validation"]["results"].append({
                "check_id": "unit",
                "status": "failed",
                "phase": "local",
                "release_unit": "mac",
                "subject": task["validation"]["results"][0]["subject"],
                "environment": "controlled-local",
                "evidence": "later mac-only failure",
                "actor": "controlled-validation-runner",
                "recorded_at": "2026-08-19T01:00:00+00:00",
            })
            gate = validation_gate_status(root, task, "LOCAL_VERIFIED")
            self.assertEqual(1, len(gate["missing"]))
            self.assertEqual("mac", gate["missing"][0]["release_unit"])
            self.assertIn("failed", gate["missing"][0]["reason"])


if __name__ == "__main__":
    unittest.main()
