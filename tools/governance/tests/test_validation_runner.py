from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


GOVERNANCE_DIR = Path(__file__).resolve().parents[1]
if str(GOVERNANCE_DIR) not in sys.path:
    sys.path.insert(0, str(GOVERNANCE_DIR))

from core import GovernanceError  # noqa: E402
from helpers import base_task, initialize_root  # noqa: E402
from validation_runner import RUNNER_VERSION, required_checks, run_one, run_required  # noqa: E402
import validation_runner  # noqa: E402


class ControlledValidationRunnerTests(unittest.TestCase):
    def tearDown(self) -> None:
        validation_runner._WORKING_GIT_DIRECTORY = None

    def _root_and_task(
        self,
        root: Path,
        argv: list,
        timeout_seconds: float = 5,
        checks: list = None,
    ):
        task = base_task()
        task["validation"]["required"] = checks or [{
            "id": "unit",
            "argv": argv,
            "timeout_seconds": timeout_seconds,
            "gates": ["LOCAL_VERIFIED", "CI_VERIFIED", "POST_MERGE_VERIFIED"],
            "release_units": ["mac", "win", "backend"],
        }]
        initialize_root(root, task)
        return task

    def test_success_is_derived_and_python3_maps_to_current_interpreter(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = self._root_and_task(root, ["python3", "-c", "raise SystemExit(0)"])

            result = run_one(root, task, task["validation"]["required"][0], "local")

            self.assertEqual("passed", result["status"])
            self.assertEqual(0, result["exit_code"])
            self.assertFalse(result["timed_out"])
            self.assertEqual(RUNNER_VERSION, result["runner_version"])
            self.assertEqual("python3", result["declared_argv"][0])
            self.assertEqual(str(Path(sys.executable).resolve()), result["executed_argv"][0])
            self.assertTrue(result["argv_sha256"].startswith("sha256:"))
            self.assertTrue(result["integrity"]["unchanged"])
            self.assertEqual([], result["integrity"]["issues"])
            self.assertEqual("controlled-local", result["environment"])
            self.assertIn("version", result["python"])
            self.assertIn("system", result["platform"])
            self.assertIn("started_at", result)
            self.assertIn("finished_at", result)

    def test_nonzero_exit_is_failed_without_caller_status(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = self._root_and_task(root, ["python3", "-c", "raise SystemExit(7)"])

            result = run_one(root, task, task["validation"]["required"][0], "local")

            self.assertEqual("failed", result["status"])
            self.assertEqual(7, result["exit_code"])
            self.assertFalse(result["timed_out"])
            self.assertTrue(result["integrity"]["unchanged"])

    def test_timeout_is_failed_and_process_is_reaped(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = self._root_and_task(
                root,
                ["python3", "-c", "import time; time.sleep(2)"],
                timeout_seconds=0.05,
            )

            result = run_one(root, task, task["validation"]["required"][0], "local")

            self.assertEqual("failed", result["status"])
            self.assertTrue(result["timed_out"])
            self.assertIsNone(result["exit_code"])
            self.assertLess(result["duration_ms"], 1500)

    def test_shell_metacharacters_are_literal_argv_tokens(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            argv = [
                "python3",
                "-c",
                "import sys; raise SystemExit(0 if sys.argv[1:] == ['*', '$HOME', ';', 'a b'] else 9)",
                "*",
                "$HOME",
                ";",
                "a b",
            ]
            task = self._root_and_task(root, argv)

            result = run_one(root, task, task["validation"]["required"][0], "local")

            self.assertEqual("passed", result["status"])
            self.assertEqual(argv, result["declared_argv"])

    def test_managed_content_mutation_cannot_pass_even_with_zero_exit(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = (
                "from pathlib import Path; "
                "p=Path('tools/governance/runner-mutated.txt'); "
                "p.parent.mkdir(parents=True, exist_ok=True); p.write_text('changed')"
            )
            task = self._root_and_task(root, ["python3", "-c", source])

            result = run_one(root, task, task["validation"]["required"][0], "local")

            self.assertEqual(0, result["exit_code"])
            self.assertEqual("failed", result["status"])
            self.assertIn("managed_content_changed", result["integrity"]["issues"])
            self.assertFalse(result["integrity"]["unchanged"])

    def test_protected_state_mutation_cannot_pass_even_when_scope_is_same(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = (
                "from pathlib import Path; "
                "p=Path('project-control/current-task.json'); "
                "p.write_bytes(p.read_bytes() + bytes([10]))"
            )
            task = self._root_and_task(root, ["python3", "-c", source])

            result = run_one(root, task, task["validation"]["required"][0], "local")

            self.assertEqual(0, result["exit_code"])
            self.assertEqual("failed", result["status"])
            self.assertIn("protected_state_changed", result["integrity"]["issues"])
            self.assertNotIn("scope_changed", result["integrity"]["issues"])

    def test_child_environment_is_allowlisted_and_home_is_temporary(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = (
                "import os; "
                "blocked=['GITHUB_TOKEN','ACTIONS_ID_TOKEN_REQUEST_TOKEN','MATERIAL_CREDENTIAL',"
                "'SSH_AUTH_SOCK','GPG_AGENT_INFO','GITHUB_ACTIONS','GITHUB_EVENT_NAME','RUNNER_OS']; "
                "home=os.environ.get('HOME',''); "
                "ok=(not any(k in os.environ for k in blocked) and home != '/sensitive-home' "
                "and os.path.isdir(home) and os.environ.get('USERPROFILE') == home); "
                "raise SystemExit(0 if ok else 8)"
            )
            task = self._root_and_task(root, ["python3", "-c", source])
            inherited = {
                "HOME": "/sensitive-home",
                "GITHUB_TOKEN": "secret",
                "ACTIONS_ID_TOKEN_REQUEST_TOKEN": "secret",
                "MATERIAL_CREDENTIAL": "secret",
                "SSH_AUTH_SOCK": "/sensitive-agent.sock",
                "GPG_AGENT_INFO": "sensitive-agent",
                "GITHUB_ACTIONS": "true",
                "GITHUB_EVENT_NAME": "pull_request",
                "RUNNER_OS": "Linux",
            }

            with mock.patch.dict(os.environ, inherited, clear=False):
                result = run_one(root, task, task["validation"]["required"][0], "local")

            self.assertEqual("passed", result["status"])

    def test_child_path_prefers_the_first_git_candidate_that_can_initialize(self) -> None:
        failed = mock.Mock(returncode=69, stderr="license blocked")
        passed = mock.Mock(returncode=0, stderr="")
        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(
            validation_runner,
            "_git_candidates",
            return_value=["/system/git", "/portable/bin/git"],
        ), mock.patch.object(
            validation_runner.subprocess,
            "run",
            side_effect=[failed, passed],
        ) as run_mock:
            environment = validation_runner._minimal_environment(Path(temporary), "local")

        self.assertEqual(
            str(Path("/portable/bin/git").resolve().parent),
            environment["PATH"].split(os.pathsep)[0],
        )
        self.assertEqual(
            ["/system/git", "init", "--quiet"],
            run_mock.call_args_list[0].args[0][:3],
        )
        self.assertEqual(
            ["/portable/bin/git", "init", "--quiet"],
            run_mock.call_args_list[1].args[0][:3],
        )

    def test_windows_child_profile_and_cache_paths_stay_in_temporary_home(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve()
            git_directory = str(home / "git-bin")
            with mock.patch.object(
                validation_runner.os,
                "name",
                "nt",
            ), mock.patch.object(
                validation_runner,
                "_working_git_directory",
                return_value=git_directory,
            ), mock.patch.dict(
                os.environ,
                {
                    "APPDATA": "C:\\sensitive\\roaming",
                    "LOCALAPPDATA": "C:\\sensitive\\local",
                    "TEMP": "C:\\sensitive\\temp",
                    "TMP": "C:\\sensitive\\temp",
                    "PSModuleAnalysisCachePath": "C:\\sensitive\\cache",
                },
                clear=False,
            ):
                environment = validation_runner._minimal_environment(home, "ci")

            expected = {
                "APPDATA": home / "AppData" / "Roaming",
                "LOCALAPPDATA": home / "AppData" / "Local",
                "TEMP": home / "Temp",
                "TMP": home / "Temp",
                "PSModuleAnalysisCachePath": home / "PowerShell" / "ModuleAnalysisCache",
            }
            for name, path in expected.items():
                self.assertEqual(str(path), environment[name])
                self.assertTrue(path.parent.is_dir())
                self.assertTrue(path == home or home in path.parents)

    def test_ci_gets_only_nonsecret_github_context_allowlist(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            allowed = {
                "GITHUB_ACTIONS": "true",
                "GITHUB_EVENT_NAME": "pull_request",
                "GITHUB_EVENT_PATH": "/tmp/event.json",
                "GITHUB_SHA": "a" * 40,
                "GITHUB_REF": "refs/pull/1/merge",
                "GITHUB_REF_NAME": "1/merge",
                "GITHUB_HEAD_REF": "codex/req-test-gov-test",
                "GITHUB_BASE_REF": "main",
                "GITHUB_RUN_ID": "12345",
                "GITHUB_RUN_ATTEMPT": "2",
                "GITHUB_SERVER_URL": "https://github.com",
                "GITHUB_REPOSITORY": "wzhic/material",
                "GITHUB_WORKFLOW_REF": "wzhic/material/.github/workflows/governance.yml@refs/heads/main",
                "MATERIAL_RELEASE_UNIT": "backend",
                "RUNNER_OS": "Linux",
            }
            blocked = {
                "GITHUB_TOKEN": "secret",
                "GITHUB_ENV": "/tmp/command-file",
                "ACTIONS_ID_TOKEN_REQUEST_TOKEN": "secret",
                "MATERIAL_CREDENTIAL": "secret",
                "SSH_AUTH_SOCK": "/tmp/ssh-agent",
                "GPG_AGENT_INFO": "secret",
            }
            source = (
                "import json, os, sys; "
                "expected=json.loads(sys.argv[1]); blocked=json.loads(sys.argv[2]); "
                "ok=(all(os.environ.get(k) == v for k,v in expected.items()) "
                "and not any(k in os.environ for k in blocked)); "
                "raise SystemExit(0 if ok else 11)"
            )
            argv = [
                "python3",
                "-c",
                source,
                json.dumps(allowed, sort_keys=True),
                json.dumps(sorted(blocked), sort_keys=True),
            ]
            task = self._root_and_task(root, argv)

            with mock.patch.dict(os.environ, dict(allowed, **blocked), clear=False):
                result = run_one(root, task, task["validation"]["required"][0], "ci")

            self.assertEqual("passed", result["status"])

    def test_output_is_persisted_only_as_digest_and_byte_count(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            stdout_bytes = b"stdout-secret\n"
            stderr_bytes = b"stderr-secret\n"
            source = (
                "import sys; "
                "sys.stdout.buffer.write(bytes([115,116,100,111,117,116,45,115,101,99,114,101,116,10])); "
                "sys.stderr.buffer.write(bytes([115,116,100,101,114,114,45,115,101,99,114,101,116,10]))"
            )
            task = self._root_and_task(root, ["python3", "-c", source])

            result = run_one(root, task, task["validation"]["required"][0], "local")

            self.assertEqual({
                "sha256": hashlib.sha256(stdout_bytes).hexdigest(),
                "byte_count": len(stdout_bytes),
            }, result["stdout"])
            self.assertEqual({
                "sha256": hashlib.sha256(stderr_bytes).hexdigest(),
                "byte_count": len(stderr_bytes),
            }, result["stderr"])
            encoded = json.dumps(result, sort_keys=True)
            self.assertNotIn("stdout-secret", encoded)
            self.assertNotIn("stderr-secret", encoded)

    def test_run_required_executes_every_phase_check(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            checks = [
                {
                    "id": "first",
                    "argv": ["python3", "-c", "raise SystemExit(0)"],
                    "timeout_seconds": 5,
                    "gates": ["LOCAL_VERIFIED"],
                    "release_units": ["mac", "win", "backend"],
                },
                {
                    "id": "second",
                    "argv": ["python3", "-c", "raise SystemExit(3)"],
                    "timeout_seconds": 5,
                    "gates": ["LOCAL_VERIFIED"],
                    "release_units": ["mac", "win", "backend"],
                },
            ]
            task = self._root_and_task(root, ["python3", "-c", "raise SystemExit(0)"], checks=checks)

            batch = run_required(root, task, "local")

            self.assertEqual("failed", batch["status"])
            self.assertEqual(2, batch["planned_check_count"])
            self.assertEqual(2, batch["executed_check_count"])
            self.assertEqual([], batch["not_run"])
            self.assertEqual(["passed", "failed"], [item["status"] for item in batch["results"]])

    def test_run_required_can_select_one_release_unit_and_empty_unit_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            checks = [
                {
                    "id": "mac-only",
                    "argv": ["python3", "-c", "raise SystemExit(0)"],
                    "timeout_seconds": 5,
                    "gates": ["LOCAL_VERIFIED"],
                    "release_units": ["mac"],
                },
                {
                    "id": "win-only",
                    "argv": ["python3", "-c", "raise SystemExit(9)"],
                    "timeout_seconds": 5,
                    "gates": ["LOCAL_VERIFIED"],
                    "release_units": ["win"],
                },
            ]
            task = self._root_and_task(root, ["python3", "-c", "raise SystemExit(0)"], checks=checks)

            batch = run_required(root, task, "local", release_unit="mac")

            self.assertEqual("passed", batch["status"])
            self.assertEqual("mac", batch["release_unit"])
            self.assertEqual(["mac-only"], [item["check_id"] for item in batch["results"]])
            self.assertEqual("mac", batch["results"][0]["release_unit"])
            with self.assertRaises(GovernanceError):
                run_required(root, task, "local", release_unit="backend")
            with self.assertRaises(GovernanceError):
                run_one(
                    root,
                    task,
                    checks[0],
                    "local",
                    release_unit="win",
                )

    def test_empty_plan_and_string_command_fail_closed(self) -> None:
        empty_task = base_task()
        empty_task["validation"]["required"] = []
        with self.assertRaises(GovernanceError):
            required_checks(empty_task, "local")

        string_task = base_task()
        string_task["validation"]["required"] = [{
            "id": "legacy",
            "command": "python3 -m unittest",
            "timeout_seconds": 5,
            "gates": ["LOCAL_VERIFIED"],
            "release_units": ["mac", "win", "backend"],
        }]
        with self.assertRaises(GovernanceError):
            required_checks(string_task, "local")

        invalid_timeout = base_task()
        invalid_timeout["validation"]["required"][0]["timeout_seconds"] = float("nan")
        with self.assertRaises(GovernanceError):
            required_checks(invalid_timeout, "local")

    def test_ci_repeats_a_minimal_local_only_plan(self) -> None:
        task = base_task(status="COMMITTED")
        task["validation"]["required"][0]["gates"] = ["LOCAL_VERIFIED"]
        selected = required_checks(task, "ci")
        self.assertEqual(["unit"], [check["id"] for check in selected])


if __name__ == "__main__":
    unittest.main()
