from __future__ import annotations

import datetime as dt
import io
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


GOVERNANCE_DIR = Path(__file__).resolve().parents[1]
if str(GOVERNANCE_DIR) not in sys.path:
    sys.path.insert(0, str(GOVERNANCE_DIR))

from core import (  # noqa: E402
    GovernanceError,
    allowed_transition,
    branch_validity,
    canonical_scope_hash,
    find_effective_review,
    legacy_g0_v1_migration,
    load_task,
    path_is_allowed,
    read_json,
    review_authenticity,
    review_validity,
    task_path,
    validate_task,
    write_output,
)
from helpers import AuthenticatedReceiptTestCase, base_task, initialize_root, write_json  # noqa: E402
import core  # noqa: E402
import taskctl  # noqa: E402


class GitEncodingTests(unittest.TestCase):
    def setUp(self) -> None:
        core._WORKING_GIT_BY_CANDIDATES.clear()

    def tearDown(self) -> None:
        core._WORKING_GIT_BY_CANDIDATES.clear()

    def test_run_git_requests_utf8_instead_of_the_windows_locale(self) -> None:
        completed = mock.Mock(returncode=0, stdout="治理输出\n", stderr="")
        with mock.patch.object(core, "_git_candidates", return_value=["git"]), mock.patch.object(
            core.subprocess, "run", return_value=completed
        ) as run:
            output, error = core.run_git(Path("."), ("status",))
        self.assertEqual("治理输出", output)
        self.assertIsNone(error)
        self.assertEqual("utf-8", run.call_args.kwargs["encoding"])
        self.assertEqual("strict", run.call_args.kwargs["errors"])

    def test_git_candidates_keep_path_discovery_when_home_is_unavailable(self) -> None:
        with mock.patch.dict(core.os.environ, {}, clear=True), mock.patch.object(
            core.Path, "home", side_effect=RuntimeError("no home directory")
        ), mock.patch.object(core.shutil, "which", return_value="git"):
            candidates = core._git_candidates()
        self.assertEqual("git", candidates[0])

    def test_run_git_reuses_the_first_working_portable_candidate(self) -> None:
        failed = mock.Mock(returncode=69, stdout="", stderr="license blocked")
        passed = mock.Mock(returncode=0, stdout="ok\n", stderr="")
        with mock.patch.object(
            core, "_git_candidates", return_value=["/system/git", "/portable/git"]
        ), mock.patch.object(
            core.subprocess, "run", side_effect=[failed, passed, passed]
        ) as run:
            first, first_error = core.run_git(Path("."), ("status",))
            second, second_error = core.run_git(Path("."), ("status",))

        self.assertEqual(("ok", None), (first, first_error))
        self.assertEqual(("ok", None), (second, second_error))
        self.assertEqual(
            ["/system/git", "/portable/git", "/portable/git"],
            [call.args[0][0] for call in run.call_args_list],
        )

    def test_git_blob_paths_are_hashed_in_one_filtered_batch(self) -> None:
        object_ids = "a" * 40 + "\n" + "b" * 40 + "\n"
        with mock.patch.object(core, "run_git", return_value=(object_ids, None)) as run:
            result = core._git_blob_oids(Path("."), ["a.txt", "dir/b.txt"])

        self.assertEqual({"a.txt": "a" * 40, "dir/b.txt": "b" * 40}, result)
        self.assertEqual(("hash-object", "--stdin-paths"), run.call_args.args[1])
        self.assertEqual("a.txt\ndir/b.txt\n", run.call_args.kwargs["input_text"])

    def test_output_uses_utf8_bytes_when_console_text_encoding_is_cp1252(self) -> None:
        raw = io.BytesIO()
        stream = io.TextIOWrapper(raw, encoding="cp1252")
        write_output("治理输出", stream=stream)
        stream.detach()
        self.assertEqual("治理输出\n".encode("utf-8"), raw.getvalue())

    def test_taskctl_routes_json_through_locale_independent_output(self) -> None:
        raw = io.BytesIO()
        stream = io.TextIOWrapper(raw, encoding="cp1252")
        with mock.patch.object(core.sys, "stdout", stream):
            taskctl._emit({"message": "治理输出"}, as_json=True)
        stream.detach()
        self.assertEqual(
            (core.json_result({"message": "治理输出"}) + "\n").encode("utf-8"),
            raw.getvalue(),
        )


class ManagedContentSubjectTests(unittest.TestCase):
    def test_ignored_untracked_output_is_excluded_but_tracked_content_is_bound(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "generated").mkdir()
            (root / ".gitignore").write_text("generated/\n", encoding="utf-8")
            (root / "source.txt").write_text("source-v1\n", encoding="utf-8")
            (root / "generated" / "tracked.txt").write_text("tracked-v1\n", encoding="utf-8")
            for arguments in (
                ("init",),
                ("add", "--", ".gitignore", "source.txt"),
                ("add", "-f", "--", "generated/tracked.txt"),
            ):
                _output, error = core.run_git(root, arguments)
                self.assertIsNone(error)

            task = base_task()
            task["allowed_paths"] = [".gitignore", "source.txt", "generated/**"]
            original = core.managed_content_subject(root, task)

            (root / "generated" / "package.zip").write_bytes(b"generated-output")
            self.assertEqual(original, core.managed_content_subject(root, task))

            (root / "generated" / "tracked.txt").write_text("tracked-v2\n", encoding="utf-8")
            self.assertNotEqual(original, core.managed_content_subject(root, task))


class CanonicalScopeTests(unittest.TestCase):
    def test_runtime_progress_does_not_change_scope_hash(self) -> None:
        task = base_task()
        original = canonical_scope_hash(task)
        task["status"] = "LOCAL_VERIFIED"
        task["history"].append({"from": "IN_PROGRESS", "to": "LOCAL_VERIFIED"})
        task["validation"]["results"].append({"check_id": "unit", "status": "passed"})
        self.assertEqual(original, canonical_scope_hash(task))

    def test_permission_change_invalidates_scope_hash(self) -> None:
        task = base_task()
        original = canonical_scope_hash(task)
        task["allowed_paths"].append("application/**")
        self.assertNotEqual(original, canonical_scope_hash(task))


class TransitionTests(unittest.TestCase):
    def test_normal_and_exception_transitions(self) -> None:
        self.assertTrue(allowed_transition("DRAFT", "REVIEW_PENDING"))
        self.assertFalse(allowed_transition("DRAFT", "APPROVED"))
        self.assertTrue(allowed_transition("IN_PROGRESS", "BLOCKED"))
        self.assertTrue(allowed_transition("BLOCKED", "IN_PROGRESS", "IN_PROGRESS"))
        self.assertFalse(allowed_transition("BLOCKED", "READY", "IN_PROGRESS"))
        self.assertTrue(allowed_transition("LOCAL_VERIFIED", "FAILED"))
        self.assertTrue(allowed_transition("FAILED", "IN_PROGRESS"))

    def test_legacy_g0_migration_window_is_exact_and_disappears_at_v2(self) -> None:
        task = base_task()
        task.update({
            "task_id": "GOV-0001",
            "scope_version": 1,
            "branch": "main",
            "branch_exception": {
                "kind": "bootstrap-main",
                "applies_only_to_task": "GOV-0001",
            },
        })
        task["validation"]["required"] = task["validation"]["required"][:1]
        self.assertTrue(legacy_g0_v1_migration(task))

        for field, value in (
            ("scope_version", 2),
            ("task_id", "GOV-0002"),
            ("branch", "codex/GOV-0001"),
        ):
            candidate = dict(task)
            candidate[field] = value
            self.assertFalse(legacy_g0_v1_migration(candidate), field)

        committed = dict(task)
        committed["git"] = {"committed_sha": "a" * 40}
        self.assertFalse(legacy_g0_v1_migration(committed))


class ReceiptTests(AuthenticatedReceiptTestCase):
    def test_effective_receipt_is_bound_to_current_scope(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = initialize_root(root)
            receipt, reason = find_effective_review(root, task)
            self.assertIsNotNone(receipt)
            self.assertEqual("approved", reason)
            task["summary"] = "expanded scope"
            receipt, reason = find_effective_review(root, task)
            self.assertIsNone(receipt)
            self.assertIn("no receipt", reason)

    def test_expired_receipt_is_invalid(self) -> None:
        task = base_task()
        receipt = {
            "task_id": task["task_id"],
            "decision": "approved",
            "approver": "user",
            "scope_version": 1,
            "scope_hash": canonical_scope_hash(task),
            "expires_at": "2026-01-01T00:00:00+00:00",
        }
        valid, reason = review_validity(
            receipt, task, now=dt.datetime(2026, 8, 18, tzinfo=dt.timezone.utc)
        )
        self.assertFalse(valid)
        self.assertEqual("approval expired", reason)


class ReceiptAuthenticityTests(unittest.TestCase):
    LEGACY_R001 = {
        "schema_version": 1,
        "review_id": "GOV-0001-R001",
        "task_id": "GOV-0001",
        "kind": "scope",
        "decision": "approved",
        "approver": "user",
        "reason": "用户补充产品边界、数据边界、共享客户端和分发方向后，确认按 G0 方向执行。",
        "confirmation_source": "conversation:2026-08-18:user-confirmed-g0",
        "scope_version": 1,
        "scope_hash": "sha256:49f4f4adf502f635e7115c498df27784683a4fadd16e7fd069d39cf1252520ec",
        "decided_at": "2026-08-18T12:20:00+00:00",
        "expires_at": None,
        "supersedes": None,
    }

    def test_only_exact_legacy_g0_r001_is_accepted_without_signature_verifier(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            legacy_path = Path(temporary) / "GOV-0001-R001.json"
            write_json(legacy_path, self.LEGACY_R001)
            valid, reason = review_authenticity(read_json(legacy_path))
            self.assertTrue(valid, reason)

        forged_receipts = []
        for changes in (
            {"review_id": "GOV-0001-R002"},
            {"review_id": "GOV-0001-CODE", "kind": "code", "commit": "c" * 40},
            {"review_id": "GOV-0001-WAIVER", "kind": "validation_waiver", "check_id": "unit"},
            {"signature": {"algorithm": "pending", "value": "not-verified"}},
        ):
            receipt = dict(self.LEGACY_R001)
            receipt.update(changes)
            forged_receipts.append(receipt)

        for receipt in forged_receipts:
            with (
                self.subTest(review_id=receipt["review_id"], kind=receipt["kind"]),
                tempfile.TemporaryDirectory() as temporary,
            ):
                forged_path = Path(temporary) / (receipt["review_id"] + ".json")
                write_json(forged_path, receipt)
                valid, reason = review_authenticity(read_json(forged_path))
                self.assertFalse(valid)
                self.assertIn("LEGACY_RECORD_DISABLED", reason)


class PathTests(unittest.TestCase):
    def test_paths_cannot_escape_scope(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.assertTrue(path_is_allowed(root, "tools/governance/core.py", ["tools/governance/**"]))
            self.assertFalse(path_is_allowed(root, "application/main.py", ["tools/governance/**"]))
            self.assertFalse(path_is_allowed(root, "../outside", ["**"]))

    def test_task_path_and_lookup_reject_traversal(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for task_id in ("../../escaped", "GOV/ESCAPED", "../GOV-0001", "GOV-0001.json"):
                with self.subTest(task_id=task_id), self.assertRaises(GovernanceError):
                    task_path(root, task_id)
                with self.subTest(task_id=task_id), self.assertRaises(GovernanceError):
                    load_task(root, task_id)


class TaskSchemaTests(unittest.TestCase):
    def test_required_collections_have_basic_schema(self) -> None:
        invalid_values = (
            ("summary", ""),
            ("release_units", ["mac", ""]),
            ("dependencies", ["../../escaped"]),
            ("required_docs", ["docs/ok.md", 3]),
            ("assumptions", "not-a-list"),
            ("open_questions", [{}]),
            ("blockers", [""]),
        )
        for field, value in invalid_values:
            with self.subTest(field=field):
                task = base_task()
                task[field] = value
                with self.assertRaises(GovernanceError):
                    validate_task(task)

    def test_required_docs_is_required(self) -> None:
        task = base_task()
        del task["required_docs"]
        with self.assertRaises(GovernanceError):
            validate_task(task)

    def test_ready_validation_plan_is_nonempty_and_covers_local_gate(self) -> None:
        task = base_task(status="READY")
        task["validation"]["required"] = []
        with self.assertRaises(GovernanceError):
            validate_task(task)

        task = base_task(status="READY")
        task["validation"]["required"][0]["gates"] = ["CI_VERIFIED"]
        with self.assertRaises(GovernanceError):
            validate_task(task)

        task = base_task(status="READY")
        task["validation"]["required"][0]["gates"] = ["LOCAL_VERIFIED"]
        validate_task(task)

    def test_historical_authority_ci_and_coordination_contracts_are_optional_but_validated(self) -> None:
        for field in ("review_authority", "ci_trust", "coordination"):
            with self.subTest(field=field):
                task = base_task(status="REVIEW_PENDING")
                del task[field]
                validate_task(task)

        invalid_tasks = []
        wrong_namespace = base_task(status="REVIEW_PENDING")
        wrong_namespace["review_authority"]["namespace"] = "generic-review"
        invalid_tasks.append(wrong_namespace)
        wrong_repository = base_task(status="REVIEW_PENDING")
        wrong_repository["ci_trust"]["repository"] = "example/material"
        invalid_tasks.append(wrong_repository)
        incomplete_units = base_task(status="REVIEW_PENDING")
        del incomplete_units["coordination"]["unit_tasks"]["win"]
        invalid_tasks.append(incomplete_units)
        for task in invalid_tasks:
            with self.assertRaises(GovernanceError):
                validate_task(task)

    def test_allowed_command_and_tool_hints_are_optional(self) -> None:
        task = base_task(status="IN_PROGRESS")
        del task["allowed_commands"]
        del task["allowed_tools"]
        validate_task(task)

    def test_subtask_records_have_a_minimal_secret_free_shape(self) -> None:
        task = base_task(status="IN_PROGRESS")
        task["subtasks"] = [{
            "id": "governance-cli",
            "name": "治理命令",
            "purpose": "精简普通工作门禁",
            "status": "in_progress",
            "started_at": "2026-08-21T00:00:00+00:00",
            "finished_at": None,
            "result": None,
        }]
        validate_task(task)

        task["subtasks"][0]["prompt"] = "must never be persisted"
        with self.assertRaises(GovernanceError):
            validate_task(task)

        for field, value in (
            ("purpose", "password=correct-horse-battery-staple"),
            ("purpose", "内部推理：逐步展示隐藏判断"),
        ):
            with self.subTest(field=field, value=value):
                unsafe = base_task(status="IN_PROGRESS")
                unsafe["subtasks"] = [{
                    "id": "unsafe",
                    "name": "不安全摘要",
                    "purpose": value,
                    "status": "in_progress",
                    "started_at": "2026-08-21T00:00:00+00:00",
                    "finished_at": None,
                    "result": None,
                }]
                with self.assertRaises(GovernanceError):
                    validate_task(unsafe)

        unsafe_result = base_task(status="IN_PROGRESS")
        unsafe_result["subtasks"] = [{
            "id": "unsafe-result",
            "name": "不安全结果",
            "purpose": "核对结果摘要",
            "status": "completed",
            "started_at": "2026-08-21T00:00:00+00:00",
            "finished_at": "2026-08-21T00:01:00+00:00",
            "result": "-----BEGIN OPENSSH PRIVATE KEY-----",
        }]
        with self.assertRaises(GovernanceError):
            validate_task(unsafe_result)

    def test_coordination_checks_must_be_reviewed_for_the_bound_unit(self) -> None:
        task = base_task(status="REVIEW_PENDING")
        task["validation"]["required"][0]["release_units"] = ["mac", "backend"]
        with self.assertRaises(GovernanceError) as raised:
            validate_task(task)
        self.assertIn("reviewed for that release unit", str(raised.exception))

    def test_validation_result_cannot_claim_an_unreviewed_release_unit(self) -> None:
        task = base_task(status="DRAFT")
        task["validation"]["required"][0]["release_units"] = ["mac"]
        task["validation"]["results"] = [{
            "check_id": "unit",
            "status": "failed",
            "phase": "local",
            "release_unit": "win",
            "subject": "workspace:sha256:" + "0" * 64,
            "environment": "test",
        }]
        with self.assertRaises(GovernanceError) as raised:
            validate_task(task)
        self.assertIn("release_unit", str(raised.exception))

    def test_legacy_g0_v1_can_enter_blocked_state_while_awaiting_migration(self) -> None:
        task = base_task(status="BLOCKED")
        task["task_id"] = "GOV-0001"
        task["scope_version"] = 1
        task["branch"] = "main"
        task["branch_exception"] = {
            "kind": "bootstrap-main",
            "applies_only_to_task": "GOV-0001",
        }
        task["exception"] = {
            "previous_status": "IN_PROGRESS",
            "reason": "await user trust decision",
        }
        legacy_check = task["validation"]["required"][0]
        legacy_check.pop("argv", None)
        legacy_check.pop("timeout_seconds", None)
        legacy_check.pop("release_units", None)
        legacy_check["command"] = "python3 -m unittest discover"
        legacy_check["gates"] = [
            "LOCAL_VERIFIED",
            "CI_VERIFIED",
        ]
        validate_task(task)

        task["task_id"] = "GOV-0002"
        with self.assertRaises(GovernanceError):
            validate_task(task)

        task = base_task(status="READY")
        task["validation"]["required"][0]["gates"] = ["LOCAL_VERIFIED", "CI_VERIFIED"]
        validate_task(task)

    def test_bootstrap_main_authority_is_hard_bound_to_gov_0001(self) -> None:
        for task_id in ("GOV-0001", "GOV-EVIL"):
            with self.subTest(task_id=task_id), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                task = base_task(status="IN_PROGRESS")
                task["task_id"] = task_id
                task["branch"] = "main"
                initialize_root(root, task)
                project_path = root / "project-control" / "project.json"
                project = read_json(project_path)
                project["branch_policy"]["bootstrap_main_tasks"] = ["GOV-0001", "GOV-EVIL"]
                write_json(project_path, project)
                valid, reason, _branch, bootstrap = branch_validity(root, task, "main")
                self.assertFalse(valid)
                self.assertFalse(bootstrap)
                self.assertIn("exactly", reason)


if __name__ == "__main__":
    unittest.main()
