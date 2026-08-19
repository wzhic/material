from __future__ import annotations

import datetime as dt
import json
import shutil
import os
import shlex
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


HOOKS_DIR = Path(__file__).resolve().parents[1] / "hooks"
if str(HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(HOOKS_DIR))

import _governance  # noqa: E402
import pre_tool_use  # noqa: E402
import session_start  # noqa: E402


class RepositoryFixture:
    def __init__(self, root: Path) -> None:
        self.root = root
        (root / ".git").mkdir(parents=True)
        (root / ".git" / "HEAD").write_text(
            "ref: refs/heads/codex/gov-0001-hooks\n",
            encoding="utf-8",
        )
        (root / "nested").mkdir()
        (root / "project-control" / "tasks").mkdir(parents=True)
        (root / "project-control" / "reviews").mkdir(parents=True)
        self.write_json(
            "project-control/project.json",
            {
                "project_id": "material",
                "source_repository": "git@github.com:wzhic/material.git",
                "branch_policy": {"bootstrap_main_tasks": ["GOV-0001"]},
            },
        )
        source_core = Path(__file__).resolve().parents[2] / "tools" / "governance" / "core.py"
        target_core = root / "tools" / "governance" / "core.py"
        target_core.parent.mkdir(parents=True)
        shutil.copyfile(str(source_core), str(target_core))
        source_governance = source_core.parent
        for cli_name in ("authority.py", "taskctl.py", "reviewctl.py"):
            shutil.copyfile(
                str(source_governance / cli_name),
                str(target_core.parent / cli_name),
            )
        source_hooks = Path(__file__).resolve().parents[1] / "hooks"
        shutil.copytree(str(source_hooks), str(root / ".codex" / "hooks"))
        self.task = {
            "task_id": "GOV-0001",
            "status": "IN_PROGRESS",
            "requirement": {
                "id": "G0",
                "interaction_kind": "non_ui",
                "version": "1.0",
                "name": "Governance bootstrap",
            },
            "summary": "Create and verify the G0 Codex Hook layer.",
            "release_units": ["mac", "win", "backend"],
            "branch": "codex/gov-0001-hooks",
            "base_branch": "main",
            "allowed_paths": [".codex/**"],
            "allowed_commands": [
                "python3 -m unittest discover -s .codex/tests -p test_*.py"
            ],
            "allowed_tools": ["update_plan"],
            "dependencies": [],
            "validation": {
                "required": [
                    {
                        "id": "hook-tests",
                        "argv": [
                            "python3",
                            "-m",
                            "unittest",
                            "discover",
                            "-s",
                            ".codex/tests",
                            "-p",
                            "test_*.py",
                        ],
                        "timeout_seconds": 60,
                        "gates": [
                            "LOCAL_VERIFIED",
                            "CI_VERIFIED",
                            "POST_MERGE_VERIFIED",
                        ],
                        "release_units": ["mac", "win", "backend"],
                    }
                ],
                "results": [],
            },
            "required_docs": ["docs/governance/G0.md"],
            "assumptions": ["Only Codex uses the repository"],
            "open_questions": ["Application framework is not selected"],
            "blockers": [],
            "review_authority": {
                "scheme": "ssh-keygen-y-v1",
                "identity": "material-project-owner",
                "namespace": "material-governance-review",
                "public_key": (
                    "ssh-ed25519 "
                    "AAAAC3NzaC1lZDI1NTE5AAAAITestFixtureOnly00000000000000000000 test"
                ),
                "key_fingerprint": (
                    "SHA256:Xu3ri2ZzXo4cOsPpru2X3BNviwcn0C7hW4yVzg50SCw"
                ),
            },
            "ci_trust": {
                "provider": "github_actions_rest_v1",
                "repository": "wzhic/material",
                "workflow_path": ".github/workflows/governance.yml",
                "api_base": "https://api.github.com",
                "api_version": "2026-03-10",
                "private": True,
                "token_env": "MATERIAL_GITHUB_ACTIONS_READ_TOKEN",
                "ci_events": ["pull_request", "push"],
                "post_merge_events": ["push"],
                "required_jobs": {
                    "pull_request": [
                        "Governance (ubuntu-latest)",
                        "Governance (macos-latest)",
                        "Governance (windows-latest)",
                    ],
                    "push": [
                        "Governance (ubuntu-latest)",
                        "Governance (macos-latest)",
                        "Governance (windows-latest)",
                    ],
                },
            },
            "coordination": {
                "mode": "coordinated-multi",
                "coordinator_task": "GOV-0001",
                "unit_tasks": {
                    "mac": "GOV-0001",
                    "win": "GOV-0001",
                    "backend": "GOV-0001",
                },
                "compatibility_matrix_doc": "docs/governance/G0.md",
                "deployment_order": ["backend", "mac", "win"],
                "rollback_order": ["mac", "win", "backend"],
                "unit_validation_checks": {
                    "mac": ["hook-tests"],
                    "win": ["hook-tests"],
                    "backend": ["hook-tests"],
                },
                "unit_rollback_checks": {
                    "mac": ["hook-tests"],
                    "win": ["hook-tests"],
                    "backend": ["hook-tests"],
                },
            },
            "scope_version": 1,
        }
        self._v2_validation_required = json.loads(
            json.dumps(self.task["validation"]["required"])
        )
        self.write_current_task()

    def write_json(self, relative: str, value: object) -> None:
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(value, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def write_current_task(self) -> None:
        self.write_json("project-control/current-task.json", {"task_id": "GOV-0001"})
        self.write_json("project-control/tasks/GOV-0001.json", self.task)

    def approve(self) -> None:
        now = dt.datetime.now(dt.timezone.utc)
        # Production accepts no unsigned receipt beyond the byte-pinned G0 R001
        # migration.  Hook policy tests need an already-verified receipt but do
        # not exercise cryptography, so patch only the tempfile-loaded core
        # module in this test process.  No production flag or file-path bypass
        # exists.
        fixture_core = _governance._load_core(self.root)
        fixture_core.review_authenticity = lambda *_args: (
            True,
            "test fixture represents an externally verified signature",
        )
        review = {
            "schema_version": 2,
            "payload_schema": "material-governance-review/v1",
            "review_id": "REV-0001",
            "project_id": "material",
            "source_repository": "git@github.com:wzhic/material.git",
            "task_id": "GOV-0001",
            "kind": "scope",
            "decision": "approved",
            "reason": "reviewed Hook test scope",
            "confirmation_source": "external:test-signed-receipt",
            "scope_hash": _governance.canonical_scope_hash(self.task, self.root),
            "scope_version": self.task["scope_version"],
            "approver": "user",
            "decided_at": now.isoformat(),
            "expires_at": (now + dt.timedelta(days=1)).isoformat(),
            "supersedes": None,
            "nonce": "hook-tests-externally-signed-receipt",
            "authority": {
                "scheme": self.task["review_authority"]["scheme"],
                "identity": self.task["review_authority"]["identity"],
                "namespace": self.task["review_authority"]["namespace"],
                "key_fingerprint": self.task["review_authority"]["key_fingerprint"],
            },
        }
        self.write_json("project-control/reviews/REV-0001.json", review)

    def use_legacy_bootstrap_validation(self) -> None:
        self.task["validation"]["required"] = [
            {
                "id": "hook-tests",
                "gates": [
                    "LOCAL_VERIFIED",
                    "CI_VERIFIED",
                    "POST_MERGE_VERIFIED",
                ],
                "command": "python3 -m unittest discover -s .codex/tests",
            }
        ]

    def use_v2_validation(self) -> None:
        self.task["validation"]["required"] = json.loads(
            json.dumps(self._v2_validation_required)
        )

    def set_status(self, status: str) -> None:
        """Write a core-valid lifecycle snapshot for status policy tests."""

        normal_states = (
            "DRAFT",
            "REVIEW_PENDING",
            "APPROVED",
            "READY",
            "IN_PROGRESS",
            "LOCAL_VERIFIED",
            "COMMITTED",
            "CI_VERIFIED",
            "CODE_REVIEWED",
            "MERGED",
            "POST_MERGE_VERIFIED",
            "DONE",
        )
        self.task["status"] = status
        self.task.pop("git", None)
        if status in normal_states:
            index = normal_states.index(status)
            git_evidence = {}
            committed_sha = "1" * 40
            merged_sha = "2" * 40
            if index >= normal_states.index("COMMITTED"):
                git_evidence["committed_sha"] = committed_sha
            if index >= normal_states.index("CI_VERIFIED"):
                git_evidence["ci_verified_sha"] = committed_sha
            if index >= normal_states.index("MERGED"):
                git_evidence["merged_sha"] = merged_sha
            if index >= normal_states.index("POST_MERGE_VERIFIED"):
                git_evidence["post_merge_verified_sha"] = merged_sha
            if git_evidence:
                self.task["git"] = git_evidence
        self.write_current_task()

    def payload(self, tool: str, tool_input: object) -> dict:
        return {
            "session_id": "test-session",
            "turn_id": "test-turn",
            "cwd": str(self.root),
            "hook_event_name": "PreToolUse",
            "tool_name": tool,
            "tool_input": tool_input,
        }


class HookPolicyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="hook root with spaces ")
        self.fixture = RepositoryFixture(Path(self.temp.name).resolve())

    def tearDown(self) -> None:
        self.temp.cleanup()

    def assert_denied(self, result: object, text: str) -> None:
        self.assertIsInstance(result, dict)
        output = result["hookSpecificOutput"]  # type: ignore[index]
        self.assertEqual(output["hookEventName"], "PreToolUse")
        self.assertEqual(output["permissionDecision"], "deny")
        self.assertIn(text, output["permissionDecisionReason"])

    def test_without_review_denies_write(self) -> None:
        payload = self.fixture.payload(
            "apply_patch",
            {
                "command": (
                    "*** Begin Patch\n"
                    "*** Add File: .codex/new.py\n"
                    "+pass\n"
                    "*** End Patch"
                )
            },
        )
        result = pre_tool_use.evaluate(payload)
        self.assert_denied(result, "no effective user review")

    def test_without_review_allows_strict_readonly_bash(self) -> None:
        payload = self.fixture.payload("Bash", {"command": "git status --short"})
        self.assertIsNone(pre_tool_use.evaluate(payload))

    def test_pre_review_states_are_recognized_but_governance_only(self) -> None:
        for status in ("DRAFT", "REVIEW_PENDING"):
            with self.subTest(status=status):
                self.fixture.set_status(status)
                payload = {
                    "session_id": "test-session",
                    "cwd": str(self.fixture.root),
                    "hook_event_name": "SessionStart",
                    "source": "startup",
                }
                output = session_start.build_output(payload)
                _, encoded = output["hookSpecificOutput"]["additionalContext"].split("\n", 1)
                context = json.loads(encoded)
                self.assertEqual(context["governance"], "READY")
                self.assertEqual(context["write_mode"], "GOVERNANCE_ONLY")
                self.assertEqual(context["task"]["status"], status)
                self.assertFalse(context["review"]["effective"])
                self.assertTrue(context["review"]["reason"])

    def test_in_progress_scope_allows_in_scope_patch(self) -> None:
        self.fixture.approve()
        payload = self.fixture.payload(
            "apply_patch",
            {
                "command": (
                    "*** Begin Patch\n"
                    "*** Add File: .codex/hooks/new.py\n"
                    "+pass\n"
                    "*** End Patch"
                )
            },
        )
        self.assertIsNone(pre_tool_use.evaluate(payload))

    def test_in_progress_scope_denies_out_of_scope_patch(self) -> None:
        self.fixture.approve()
        payload = self.fixture.payload(
            "apply_patch",
            {
                "command": (
                    "*** Begin Patch\n"
                    "*** Add File: src/business.py\n"
                    "+pass\n"
                    "*** End Patch"
                )
            },
        )
        result = pre_tool_use.evaluate(payload)
        self.assert_denied(result, "outside reviewed scope")

    def test_in_progress_with_blockers_denies_ordinary_write(self) -> None:
        self.fixture.task["blockers"] = ["Waiting for a recorded user decision"]
        self.fixture.write_current_task()
        self.fixture.approve()
        payload = self.fixture.payload(
            "apply_patch",
            {
                "command": (
                    "*** Begin Patch\n"
                    "*** Add File: .codex/blocked.py\n"
                    "+pass\n"
                    "*** End Patch"
                )
            },
        )
        result = pre_tool_use.evaluate(payload)
        self.assert_denied(result, "task has unresolved blockers")

    def test_approved_and_ready_reject_all_ordinary_writes(self) -> None:
        self.fixture.task["allowed_tools"].append("WriteTool")
        for status in ("APPROVED", "READY"):
            with self.subTest(status=status):
                self.fixture.set_status(status)
                self.fixture.approve()
                payloads = (
                    self.fixture.payload(
                        "apply_patch",
                        {
                            "command": (
                                "*** Begin Patch\n"
                                "*** Add File: .codex/not-started.py\n"
                                "+pass\n"
                                "*** End Patch"
                            )
                        },
                    ),
                    self.fixture.payload(
                        "WriteTool",
                        {"path": ".codex/not-started.json"},
                    ),
                )
                for payload in payloads:
                    result = pre_tool_use.evaluate(payload)
                    self.assert_denied(
                        result,
                        "ordinary writes require task status IN_PROGRESS",
                    )

    def test_reviewed_lifecycle_states_have_explicit_session_write_mode(self) -> None:
        statuses = (
            "APPROVED",
            "READY",
            "IN_PROGRESS",
            "LOCAL_VERIFIED",
            "COMMITTED",
            "CI_VERIFIED",
            "CODE_REVIEWED",
            "MERGED",
            "POST_MERGE_VERIFIED",
            "DONE",
        )
        self.fixture.task["allowed_tools"].append("WriteTool")
        for status in statuses:
            with self.subTest(status=status):
                self.fixture.set_status(status)
                self.fixture.approve()
                payload = {
                    "session_id": "test-session",
                    "cwd": str(self.fixture.root / "nested"),
                    "hook_event_name": "SessionStart",
                    "source": "resume",
                }
                output = session_start.build_output(payload)
                _, encoded = output["hookSpecificOutput"]["additionalContext"].split("\n", 1)
                context = json.loads(encoded)
                self.assertEqual(context["governance"], "READY")
                self.assertEqual(context["task"]["status"], status)
                self.assertTrue(context["review"]["effective"])
                self.assertTrue(context["next_step"])
                expected_mode = (
                    "IN_SCOPE_WRITES_ALLOWED"
                    if status == "IN_PROGRESS"
                    else "GOVERNANCE_ONLY"
                )
                self.assertEqual(context["write_mode"], expected_mode)

                read_payload = self.fixture.payload(
                    "Read",
                    {"path": "project-control/tasks/GOV-0001.json"},
                )
                self.assertIsNone(pre_tool_use.evaluate(read_payload))
                if status != "IN_PROGRESS":
                    frozen_payloads = (
                        self.fixture.payload(
                            "apply_patch",
                            {
                                "command": (
                                    "*** Begin Patch\n"
                                    "*** Add File: .codex/frozen.py\n"
                                    "+pass\n"
                                    "*** End Patch"
                                )
                            },
                        ),
                        self.fixture.payload(
                            "WriteTool",
                            {"path": ".codex/frozen.json"},
                        ),
                    )
                    for frozen_payload in frozen_payloads:
                        result = pre_tool_use.evaluate(frozen_payload)
                        self.assert_denied(
                            result,
                            "ordinary writes require task status IN_PROGRESS",
                        )

    def test_reviewed_project_control_scope_cannot_directly_mutate_state(self) -> None:
        self.fixture.task["allowed_paths"].append("project-control/**")
        self.fixture.write_current_task()
        self.fixture.approve()
        patches = {
            "add-review": (
                "*** Begin Patch\n"
                "*** Add File: project-control/reviews/FORGED-R001.json\n"
                "+{}\n"
                "*** End Patch"
            ),
            "update-task": (
                "*** Begin Patch\n"
                "*** Update File: project-control/tasks/GOV-0001.json\n"
                "@@\n"
                "-old\n"
                "+new\n"
                "*** End Patch"
            ),
            "delete-current": (
                "*** Begin Patch\n"
                "*** Delete File: project-control/current-task.json\n"
                "*** End Patch"
            ),
            "move-to-reviews": (
                "*** Begin Patch\n"
                "*** Update File: project-control/proposals/candidate.json\n"
                "*** Move to: project-control/reviews/FORGED-R002.json\n"
                "@@\n"
                "-old\n"
                "+new\n"
                "*** End Patch"
            ),
        }
        for operation, command in patches.items():
            with self.subTest(operation=operation):
                payload = self.fixture.payload("apply_patch", {"command": command})
                result = pre_tool_use.evaluate(payload)
                self.assert_denied(result, "protected governance path")

    def test_apply_patch_aliases_cannot_bypass_protected_path_policy(self) -> None:
        self.fixture.task["allowed_paths"].append("project-control/**")
        self.fixture.task["allowed_tools"].extend(["ApplyPatch", "apply-patch"])
        self.fixture.write_current_task()
        self.fixture.approve()
        command = (
            "*** Begin Patch\n"
            "*** Delete File: project-control/reviews/REV-0001.json\n"
            "*** End Patch"
        )
        for alias in ("ApplyPatch", "apply-patch", "APPLY_PATCH"):
            with self.subTest(alias=alias):
                result = pre_tool_use.evaluate(
                    self.fixture.payload(alias, {"command": command})
                )
                self.assert_denied(result, "protected governance path")

    def test_reviewed_project_control_scope_allows_non_state_proposal(self) -> None:
        self.fixture.task["allowed_paths"].append("project-control/**")
        self.fixture.write_current_task()
        self.fixture.approve()
        payload = self.fixture.payload(
            "apply_patch",
            {
                "command": (
                    "*** Begin Patch\n"
                    "*** Add File: project-control/proposals/scope.json\n"
                    "+{}\n"
                    "*** End Patch"
                )
            },
        )
        self.assertIsNone(pre_tool_use.evaluate(payload))

    def test_other_write_tools_cannot_mutate_governance_state_paths(self) -> None:
        self.fixture.task["allowed_tools"].append("WriteTool")
        self.fixture.write_current_task()
        self.fixture.approve()
        inputs = (
            {"path": "project-control/reviews/FORGED-R003.json"},
            {"paths": ["notes.txt", "project-control/tasks/GOV-0001.json"]},
            {"path": "project-control/current-task.json"},
        )
        for tool_input in inputs:
            with self.subTest(tool_input=tool_input):
                payload = self.fixture.payload("WriteTool", tool_input)
                result = pre_tool_use.evaluate(payload)
                self.assert_denied(result, "protected governance path")

    def test_other_write_tool_paths_must_all_stay_in_reviewed_scope(self) -> None:
        self.fixture.task["allowed_tools"].extend(
            ["WriteTool", "mcp__writer__write"]
        )
        self.fixture.write_current_task()
        self.fixture.approve()
        allowed_inputs = (
            ("WriteTool", {"path": ".codex/output.json"}),
            ("WriteTool", {"directory": ".codex/generated"}),
            ("mcp__writer__write", {"file_path": ".codex/mcp-output.json"}),
            ("WriteTool", {"paths": [".codex/a.json", ".codex/b.json"]}),
        )
        for tool_name, tool_input in allowed_inputs:
            with self.subTest(allowed=tool_input):
                payload = self.fixture.payload(tool_name, tool_input)
                self.assertIsNone(pre_tool_use.evaluate(payload))

        rejected_inputs = (
            {"path": "docs/outside.json"},
            {"paths": [".codex/in-scope.json", "docs/outside.json"]},
            {"directory": "../outside-repository"},
            {"file_path": "*.json"},
            {"path": {"nested": ".codex/not-reliably-parsed.json"}},
            {"paths": []},
        )
        for tool_input in rejected_inputs:
            with self.subTest(rejected=tool_input):
                payload = self.fixture.payload("WriteTool", tool_input)
                result = pre_tool_use.evaluate(payload)
                self.assertIsNotNone(result)

    def test_local_verified_freezes_all_non_governance_writes(self) -> None:
        self.fixture.task["status"] = "LOCAL_VERIFIED"
        self.fixture.task["allowed_tools"].append("WriteTool")
        self.fixture.write_current_task()
        self.fixture.approve()
        patch_payload = self.fixture.payload(
            "apply_patch",
            {
                "command": (
                    "*** Begin Patch\n"
                    "*** Add File: .codex/after-validation.py\n"
                    "+pass\n"
                    "*** End Patch"
                )
            },
        )
        write_payload = self.fixture.payload(
            "WriteTool",
            {"path": ".codex/after-validation.json"},
        )
        bash_payload = self.fixture.payload(
            "Bash",
            {
                "command": (
                    "python3 -m unittest discover -s .codex/tests -p test_*.py"
                )
            },
        )
        for payload in (patch_payload, write_payload, bash_payload):
            with self.subTest(tool=payload["tool_name"]):
                result = pre_tool_use.evaluate(payload)
                self.assert_denied(result, "ordinary writes require task status IN_PROGRESS")

        transition = (
            "python3 tools/governance/taskctl.py transition GOV-0001 COMMITTED "
            "--actor Codex --reason 'advance frozen task' "
            "--commit 1111111111111111111111111111111111111111 --json"
        )
        self.assertIsNone(
            pre_tool_use.evaluate(self.fixture.payload("Bash", {"command": transition}))
        )

    def test_read_tool_can_inspect_protected_governance_state(self) -> None:
        payload = self.fixture.payload(
            "Read",
            {"path": "project-control/tasks/GOV-0001.json"},
        )
        self.assertIsNone(pre_tool_use.evaluate(payload))

    def test_wrong_branch_denies_write(self) -> None:
        self.fixture.approve()
        (self.fixture.root / ".git" / "HEAD").write_text(
            "ref: refs/heads/main\n",
            encoding="utf-8",
        )
        payload = self.fixture.payload(
            "apply_patch",
            {
                "command": (
                    "*** Begin Patch\n"
                    "*** Update File: .codex/hooks/session_start.py\n"
                    "@@\n"
                    "-old\n"
                    "+new\n"
                    "*** End Patch"
                )
            },
        )
        result = pre_tool_use.evaluate(payload)
        self.assert_denied(result, "does not match task branch")

    def test_missing_base_branch_is_only_tolerated_before_ready(self) -> None:
        self.fixture.task.pop("base_branch")
        for status in ("DRAFT", "REVIEW_PENDING", "APPROVED"):
            with self.subTest(status=status):
                self.fixture.set_status(status)
                if status == "APPROVED":
                    self.fixture.approve()
                payload = {
                    "session_id": "test-session",
                    "cwd": str(self.fixture.root),
                    "hook_event_name": "SessionStart",
                    "source": "resume",
                }
                output = session_start.build_output(payload)
                _, encoded = output["hookSpecificOutput"]["additionalContext"].split("\n", 1)
                context = json.loads(encoded)
                self.assertEqual(context["governance"], "READY")
                self.assertIsNone(context["branch"]["base"])

        for status in ("READY", "IN_PROGRESS", "LOCAL_VERIFIED", "DONE"):
            with self.subTest(status=status):
                self.fixture.set_status(status)
                self.fixture.approve()
                payload = self.fixture.payload(
                    "apply_patch",
                    {
                        "command": (
                            "*** Begin Patch\n"
                            "*** Add File: .codex/missing-base.py\n"
                            "+pass\n"
                            "*** End Patch"
                        )
                    },
                )
                result = pre_tool_use.evaluate(payload)
                self.assert_denied(result, "base_branch is required from READY onward")

    def test_non_bootstrap_branch_must_differ_from_base_branch(self) -> None:
        self.fixture.task["base_branch"] = self.fixture.task["branch"]
        self.fixture.write_current_task()
        self.fixture.approve()
        payload = self.fixture.payload(
            "apply_patch",
            {
                "command": (
                    "*** Begin Patch\n"
                    "*** Add File: .codex/equal-branches.py\n"
                    "+pass\n"
                    "*** End Patch"
                )
            },
        )
        result = pre_tool_use.evaluate(payload)
        self.assert_denied(result, "task branch must differ from base_branch")

    def test_missing_interaction_kind_is_only_tolerated_before_ready(self) -> None:
        self.fixture.task["requirement"].pop("interaction_kind")
        for status in ("DRAFT", "REVIEW_PENDING", "APPROVED"):
            with self.subTest(status=status):
                self.fixture.set_status(status)
                if status == "APPROVED":
                    self.fixture.approve()
                payload = {
                    "session_id": "test-session",
                    "cwd": str(self.fixture.root),
                    "hook_event_name": "SessionStart",
                    "source": "resume",
                }
                output = session_start.build_output(payload)
                _, encoded = output["hookSpecificOutput"]["additionalContext"].split("\n", 1)
                context = json.loads(encoded)
                self.assertEqual(context["governance"], "READY")
                self.assertIsNone(context["requirement"]["interaction_kind"])

        for status in ("READY", "IN_PROGRESS", "LOCAL_VERIFIED", "DONE"):
            with self.subTest(status=status):
                self.fixture.set_status(status)
                self.fixture.approve()
                payload = self.fixture.payload(
                    "apply_patch",
                    {
                        "command": (
                            "*** Begin Patch\n"
                            "*** Add File: .codex/missing-interaction-kind.py\n"
                            "+pass\n"
                            "*** End Patch"
                        )
                    },
                )
                result = pre_tool_use.evaluate(payload)
                self.assert_denied(
                    result,
                    "requirement.interaction_kind is required from READY onward",
                )

    def test_interaction_kind_accepts_only_supported_modes(self) -> None:
        payload = self.fixture.payload(
            "apply_patch",
            {
                "command": (
                    "*** Begin Patch\n"
                    "*** Add File: .codex/interaction-kind.py\n"
                    "+pass\n"
                    "*** End Patch"
                )
            },
        )
        for interaction_kind in ("ui", "non_ui", "mixed"):
            with self.subTest(interaction_kind=interaction_kind):
                self.fixture.task["requirement"]["interaction_kind"] = interaction_kind
                self.fixture.write_current_task()
                self.fixture.approve()
                self.assertIsNone(pre_tool_use.evaluate(payload))

        self.fixture.task["requirement"]["interaction_kind"] = "backend"
        self.fixture.write_current_task()
        self.fixture.approve()
        result = pre_tool_use.evaluate(payload)
        self.assert_denied(result, "interaction_kind must be ui, non_ui or mixed")

    def test_bootstrap_base_migration_is_bounded_to_gov_v1(self) -> None:
        self.fixture.use_legacy_bootstrap_validation()
        self.fixture.task.pop("base_branch")
        self.fixture.task["requirement"].pop("interaction_kind")
        self.fixture.task["branch"] = "main"
        self.fixture.task["branch_exception"] = {
            "kind": "bootstrap-main",
            "applies_only_to_task": "GOV-0001",
        }
        (self.fixture.root / ".git" / "HEAD").write_text(
            "ref: refs/heads/main\n",
            encoding="utf-8",
        )
        self.fixture.write_json(
            "project-control/project.json",
            {"branch_policy": {"bootstrap_main_tasks": ["GOV-0001"]}},
        )
        self.fixture.write_current_task()
        self.fixture.approve()
        payload = self.fixture.payload(
            "apply_patch",
            {
                "command": (
                    "*** Begin Patch\n"
                    "*** Add File: .codex/bootstrap-migration.py\n"
                    "+pass\n"
                    "*** End Patch"
                )
            },
        )
        self.assertIsNone(pre_tool_use.evaluate(payload))

        self.fixture.task["scope_version"] = 2
        self.fixture.use_v2_validation()
        self.fixture.write_current_task()
        self.fixture.approve()
        result = pre_tool_use.evaluate(payload)
        self.assert_denied(result, "base_branch is required from READY onward")

        self.fixture.task["base_branch"] = "main"
        self.fixture.write_current_task()
        self.fixture.approve()
        result = pre_tool_use.evaluate(payload)
        self.assert_denied(
            result,
            "requirement.interaction_kind is required from READY onward",
        )

        self.fixture.task["requirement"]["interaction_kind"] = "non_ui"
        self.fixture.write_current_task()
        self.fixture.approve()
        self.assertIsNone(pre_tool_use.evaluate(payload))

    def test_legacy_bootstrap_detection_is_exact_and_expires(self) -> None:
        self.fixture.use_legacy_bootstrap_validation()
        self.fixture.task.pop("base_branch")
        self.fixture.task["requirement"].pop("interaction_kind")
        self.fixture.task["branch"] = "main"
        self.fixture.task["branch_exception"] = {
            "kind": "bootstrap-main",
            "applies_only_to_task": "GOV-0001",
        }
        legacy = json.loads(json.dumps(self.fixture.task))
        self.assertTrue(_governance._is_legacy_bootstrap_scope_v1(legacy))

        mutations = (
            ("scope-v2", lambda task: task.update(scope_version=2)),
            ("wrong-branch", lambda task: task.update(branch="codex/gov-0001-hooks")),
            ("late-state", lambda task: task.update(status="LOCAL_VERIFIED")),
            (
                "content-commit",
                lambda task: task.update(git={"committed_sha": "1" * 40}),
            ),
            ("malformed-git", lambda task: task.update(git="not-an-object")),
            ("wrong-task", lambda task: task.update(task_id="GOV-0002")),
            (
                "wrong-exception",
                lambda task: task.update(
                    branch_exception={
                        "kind": "bootstrap-main",
                        "applies_only_to_task": "GOV-0002",
                    }
                ),
            ),
        )
        for name, mutate in mutations:
            with self.subTest(name=name):
                candidate = json.loads(json.dumps(legacy))
                mutate(candidate)
                self.assertFalse(_governance._is_legacy_bootstrap_scope_v1(candidate))

    def test_v2_validation_and_trust_schema_fail_closed(self) -> None:
        cases = (
            (
                "argv",
                lambda task: task["validation"]["required"][0].update(argv=[]),
                "argv",
            ),
            (
                "timeout",
                lambda task: task["validation"]["required"][0].update(
                    timeout_seconds=0
                ),
                "timeout_seconds",
            ),
            (
                "release-unit",
                lambda task: task["validation"]["required"][0].update(
                    release_units=["unknown"]
                ),
                "release_units",
            ),
            (
                "review-authority",
                lambda task: task.pop("review_authority"),
                "review_authority",
            ),
            (
                "ci-trust",
                lambda task: task["ci_trust"]["required_jobs"].update(
                    push=["Governance (ubuntu-latest)"]
                ),
                "ci_trust",
            ),
            (
                "coordination",
                lambda task: task["coordination"]["unit_tasks"].pop("win"),
                "coordination",
            ),
        )
        original = json.loads(json.dumps(self.fixture.task))
        for name, mutate, expected in cases:
            with self.subTest(name=name):
                self.fixture.task = json.loads(json.dumps(original))
                mutate(self.fixture.task)
                self.fixture.write_current_task()
                snapshot = _governance.load_snapshot(self.fixture.root)
                self.assertFalse(snapshot.valid)
                self.assertIn(expected, " ".join(snapshot.reasons))

    def test_unlisted_main_branch_exception_denies_write(self) -> None:
        self.fixture.use_legacy_bootstrap_validation()
        self.fixture.task["branch"] = "main"
        self.fixture.task["branch_exception"] = {
            "kind": "bootstrap-main",
            "applies_only_to_task": "GOV-0001",
        }
        self.fixture.write_current_task()
        (self.fixture.root / ".git" / "HEAD").write_text(
            "ref: refs/heads/main\n",
            encoding="utf-8",
        )
        self.fixture.write_json(
            "project-control/project.json",
            {"branch_policy": {"bootstrap_main_tasks": []}},
        )
        self.fixture.approve()
        payload = self.fixture.payload(
            "apply_patch",
            {
                "command": (
                    "*** Begin Patch\n"
                    "*** Add File: .codex/new.py\n"
                    "+pass\n"
                    "*** End Patch"
                )
            },
        )
        result = pre_tool_use.evaluate(payload)
        self.assert_denied(result, "bootstrap main-branch exception")

    def test_bootstrap_main_trust_root_cannot_be_extended_in_project_json(self) -> None:
        self.fixture.use_legacy_bootstrap_validation()
        self.fixture.task["branch"] = "main"
        self.fixture.task["branch_exception"] = {
            "kind": "bootstrap-main",
            "applies_only_to_task": "GOV-0001",
        }
        self.fixture.write_current_task()
        (self.fixture.root / ".git" / "HEAD").write_text(
            "ref: refs/heads/main\n",
            encoding="utf-8",
        )
        self.fixture.write_json(
            "project-control/project.json",
            {"branch_policy": {"bootstrap_main_tasks": ["GOV-0001", "REQ-0002-T01"]}},
        )
        self.fixture.approve()
        payload = self.fixture.payload(
            "apply_patch",
            {
                "command": (
                    "*** Begin Patch\n"
                    "*** Add File: .codex/unreviewed-main-extension.py\n"
                    "+pass\n"
                    "*** End Patch"
                )
            },
        )
        result = pre_tool_use.evaluate(payload)
        self.assert_denied(result, "trust root must be exactly GOV-0001")

    def test_scope_change_invalidates_existing_receipt(self) -> None:
        self.fixture.approve()
        self.fixture.task["allowed_paths"].append("src/**")
        self.fixture.write_current_task()
        payload = self.fixture.payload(
            "apply_patch",
            {
                "command": (
                    "*** Begin Patch\n"
                    "*** Add File: src/new.py\n"
                    "+pass\n"
                    "*** End Patch"
                )
            },
        )
        result = pre_tool_use.evaluate(payload)
        self.assert_denied(result, "canonical scope")

    def test_g0_blocks_commit_even_if_command_is_listed(self) -> None:
        self.fixture.task["allowed_commands"].append("git commit -m test")
        self.fixture.write_current_task()
        self.fixture.approve()
        payload = self.fixture.payload("Bash", {"command": "git commit -m test"})
        result = pre_tool_use.evaluate(payload)
        self.assert_denied(result, "not authorized during G0")

    def test_draft_can_transition_to_review_pending_without_scope_review(self) -> None:
        self.fixture.task["status"] = "DRAFT"
        self.fixture.write_current_task()
        command = (
            "python3 tools/governance/taskctl.py transition GOV-0001 REVIEW_PENDING "
            "--actor Codex --reason 'request user review' --json"
        )
        payload = self.fixture.payload("Bash", {"command": command})
        self.assertIsNone(pre_tool_use.evaluate(payload))

    def test_ready_can_transition_to_in_progress(self) -> None:
        self.fixture.task["status"] = "READY"
        self.fixture.write_current_task()
        self.fixture.approve()
        command = (
            "python3 tools/governance/taskctl.py transition GOV-0001 IN_PROGRESS "
            "--actor Codex --reason 'start reviewed task' --json"
        )
        payload = self.fixture.payload("Bash", {"command": command})
        self.assertIsNone(pre_tool_use.evaluate(payload))

    def test_local_verified_can_transition_to_committed(self) -> None:
        self.fixture.task["status"] = "LOCAL_VERIFIED"
        self.fixture.write_current_task()
        self.fixture.approve()
        command = (
            "python3 tools/governance/taskctl.py transition GOV-0001 COMMITTED "
            "--actor Codex --reason 'record completed commit gate' "
            "--commit 1111111111111111111111111111111111111111 --json"
        )
        payload = self.fixture.payload("Bash", {"command": command})
        self.assertIsNone(pre_tool_use.evaluate(payload))

    def test_scope_revision_cli_is_reachable_with_in_repo_proposal(self) -> None:
        proposal = self.fixture.root / "project-control" / "scope-proposal.json"
        proposal.write_text(
            json.dumps({"summary": "Revised reviewed scope"}),
            encoding="utf-8",
        )
        command = (
            "python3 tools/governance/taskctl.py revise-scope GOV-0001 "
            "--file project-control/scope-proposal.json --target REVIEW_PENDING "
            "--actor Codex --reason 'scope changed' --json"
        )
        payload = self.fixture.payload("Bash", {"command": command})
        self.assertIsNone(pre_tool_use.evaluate(payload))

    def test_task_create_set_current_and_nonpass_validation_are_reachable(self) -> None:
        spec = dict(self.fixture.task)
        spec["task_id"] = "REQ-0002-T01"
        spec["status"] = "DRAFT"
        spec["branch"] = "codex/req-0002-t01-next-task"
        spec_path = self.fixture.root / "project-control" / "next-task.json"
        spec_path.write_text(json.dumps(spec), encoding="utf-8")
        commands = (
            "python3 tools/governance/taskctl.py create --file project-control/next-task.json --json",
            (
                "python3 tools/governance/taskctl.py set-current GOV-0001 "
                "--actor Codex --reason 'select planned task' --json"
            ),
            (
                "python3 tools/governance/taskctl.py record-validation GOV-0001 "
                "--check hook-tests --status blocked --phase local "
                "--evidence 'runner not available' --actor Codex --json"
            ),
        )
        for command in commands:
            with self.subTest(command=command):
                payload = self.fixture.payload("Bash", {"command": command})
                self.assertIsNone(pre_tool_use.evaluate(payload))

    def test_review_queries_remain_reachable_without_approval(self) -> None:
        commands = (
            "python3 tools/governance/reviewctl.py list --task GOV-0001 --json",
            "python3 tools/governance/reviewctl.py show REV-0001 --json",
            "python3 tools/governance/reviewctl.py verify --task GOV-0001 --kind scope --json",
            (
                "python3 tools/governance/reviewctl.py verify --task GOV-0001 "
                "--kind validation_waiver --check-id hook-tests --phase local --json"
            ),
            (
                "python3 tools/governance/reviewctl.py verify --task GOV-0001 "
                "--kind code --commit 1111111111111111111111111111111111111111 --json"
            ),
        )
        for command in commands:
            with self.subTest(command=command):
                payload = self.fixture.payload("Bash", {"command": command})
                self.assertIsNone(pre_tool_use.evaluate(payload))

    def test_controlled_validation_and_github_sync_clis_are_reachable(self) -> None:
        repository = shlex.quote(str(self.fixture.root))
        commands = (
            (
                "python3 tools/governance/taskctl.py run-validation GOV-0001 "
                "--check hook-tests --environment controlled-local "
                "--release-unit mac --json"
            ),
            (
                "python3 tools/governance/taskctl.py run-required GOV-0001 "
                "--phase local --release-unit win --root " + repository + " --json"
            ),
            (
                "python3 tools/governance/taskctl.py run-required GOV-0001 "
                "--phase ci --environment github-actions --release-unit backend "
                "--bootstrap-first-push --json"
            ),
            (
                "python3 tools/governance/taskctl.py sync-github-run GOV-0001 "
                "--phase ci --run-id 12345 --run-attempt 2 "
                "--event pull_request --head-sha " + "a" * 40 + " "
                "--actor Codex --json"
            ),
        )
        for command in commands:
            with self.subTest(command=command):
                payload = self.fixture.payload("Bash", {"command": command})
                self.assertIsNone(pre_tool_use.evaluate(payload))

    def test_controlled_cli_aliases_reach_the_same_policy(self) -> None:
        command_tail = (
            "tools/governance/taskctl.py run-validation GOV-0001 "
            "--check hook-tests --release-unit mac --json"
        )
        for executable in ("python", "python3", sys.executable):
            for tool_alias in ("Bash", "bash", "B_A-S_H"):
                with self.subTest(executable=executable, tool_alias=tool_alias):
                    command = shlex.quote(executable) + " " + command_tail
                    payload = self.fixture.payload(tool_alias, {"command": command})
                    self.assertIsNone(pre_tool_use.evaluate(payload))

    def test_controlled_cli_rejects_missing_repeated_and_unknown_arguments(self) -> None:
        commands = (
            "python3 tools/governance/taskctl.py run-validation GOV-0001 --json",
            (
                "python3 tools/governance/taskctl.py run-validation GOV-0001 "
                "--check hook-tests --check duplicate"
            ),
            (
                "python3 tools/governance/taskctl.py run-validation GOV-0001 extra "
                "--check hook-tests"
            ),
            (
                "python3 tools/governance/taskctl.py run-validation ../../outside "
                "--check hook-tests"
            ),
            (
                "python3 tools/governance/taskctl.py run-validation GOV-0001 "
                "--check hook-tests --actor Codex"
            ),
            "python3 tools/governance/taskctl.py run-required GOV-0001 --json",
            (
                "python3 tools/governance/taskctl.py run-required GOV-0001 "
                "--phase deploy"
            ),
            (
                "python3 tools/governance/taskctl.py run-required GOV-0001 "
                "--phase local --release-unit mac --release-unit win"
            ),
            (
                "python3 tools/governance/taskctl.py run-required GOV-0001 "
                "--phase ci --bootstrap-first-push --bootstrap-first-push"
            ),
            (
                "python3 tools/governance/taskctl.py sync-github-run GOV-0001 "
                "--phase ci --run-id 0 --run-attempt 1 --event pull_request "
                "--head-sha " + "a" * 40 + " --actor Codex"
            ),
            (
                "python3 tools/governance/taskctl.py sync-github-run GOV-0001 "
                "--phase ci --run-id 123 --run-attempt 0 --event pull_request "
                "--head-sha " + "a" * 40 + " --actor Codex"
            ),
            (
                "python3 tools/governance/taskctl.py sync-github-run GOV-0001 "
                "--phase ci --run-id 123 --run-attempt 1 --event workflow_dispatch "
                "--head-sha " + "a" * 40 + " --actor Codex"
            ),
            (
                "python3 tools/governance/taskctl.py sync-github-run GOV-0001 "
                "--phase ci --run-id 123 --run-attempt 1 --event pull_request "
                "--head-sha ABC --actor Codex"
            ),
            (
                "python3 tools/governance/taskctl.py sync-github-run GOV-0001 "
                "--phase ci --run-id 123 --run-attempt 1 --event pull_request "
                "--head-sha " + "a" * 40 + " --actor user"
            ),
        )
        for command in commands:
            with self.subTest(command=command):
                result = pre_tool_use.evaluate(
                    self.fixture.payload("Bash", {"command": command})
                )
                self.assert_denied(result, "arguments are invalid")

    def test_review_prepare_is_stdout_only_and_user_import_is_denied(self) -> None:
        base = (
            "python3 tools/governance/reviewctl.py prepare GOV-0001 "
            "--review-id GOV-0001-R002 --decision approved "
            "--reason 'approve scope v2'"
        )
        for command in (base, base + " --json"):
            with self.subTest(allowed=command):
                self.assertIsNone(
                    pre_tool_use.evaluate(
                        self.fixture.payload("Bash", {"command": command})
                    )
                )

        denied = (
            (base + " --output payload.json", "--output is user-only"),
            (base + " --output=payload.json", "--output is user-only"),
            (
                "python3 tools/governance/reviewctl.py prepare GOV-0001 "
                "--review-id GOV-0001-R002 --decision approved",
                "missing required option",
            ),
            (
                base + " --review-id GOV-0001-R003",
                "--review-id may not be repeated",
            ),
            (base + " --unknown value", "unknown option"),
            (
                "python3 tools/governance/reviewctl.py prepare GOV-0001 "
                "--review-id ../outside --decision approved --reason ok",
                "--review-id is invalid",
            ),
            (base + " > payload.json", "shell control operators"),
            (
                "python3 tools/governance/reviewctl.py import-signed "
                "--payload receipt.json --signature receipt.sig",
                "may not import signed review receipts",
            ),
        )
        for command, reason in denied:
            with self.subTest(denied=command):
                result = pre_tool_use.evaluate(
                    self.fixture.payload("Bash", {"command": command})
                )
                self.assert_denied(result, reason)

    def test_bootstrap_git_transport_is_exact_and_direct_git_stays_denied(self) -> None:
        for subcommand in ("bootstrap-commit", "bootstrap-push"):
            for stage in ("content", "control"):
                command = (
                    "python3 tools/governance/taskctl.py %s GOV-0001 "
                    "--stage %s --actor Codex --json" % (subcommand, stage)
                )
                with self.subTest(command=command):
                    self.assertIsNone(
                        pre_tool_use.evaluate(
                            self.fixture.payload("Bash", {"command": command})
                        )
                    )

        invalid = (
            "python3 tools/governance/taskctl.py bootstrap-commit GOV-OTHER "
            "--stage content --actor Codex --json",
            "python3 tools/governance/taskctl.py bootstrap-commit GOV-0001 "
            "--stage other --actor Codex --json",
            "python3 tools/governance/taskctl.py bootstrap-push GOV-0001 "
            "--stage content --actor user --json",
            "python3 tools/governance/taskctl.py bootstrap-push GOV-0001 "
            "--stage content --stage control --actor Codex --json",
            "python3 tools/governance/taskctl.py bootstrap-push GOV-0001 "
            "--stage content --actor Codex --force --json",
        )
        for command in invalid:
            with self.subTest(invalid=command):
                self.assert_denied(
                    pre_tool_use.evaluate(
                        self.fixture.payload("Bash", {"command": command})
                    ),
                    "arguments are invalid",
                )

        for command in ("git commit -m test", "git push origin main"):
            with self.subTest(direct=command):
                self.assert_denied(
                    pre_tool_use.evaluate(
                        self.fixture.payload("Bash", {"command": command})
                    ),
                    "not authorized during G0",
                )

    def test_codex_cannot_impersonate_user_in_task_history(self) -> None:
        command = (
            "python3 tools/governance/taskctl.py transition GOV-0001 REVIEW_PENDING "
            "--actor user --reason impersonation --json"
        )
        payload = self.fixture.payload("Bash", {"command": command})
        result = pre_tool_use.evaluate(payload)
        self.assert_denied(result, "must record --actor Codex exactly")

    def test_legacy_review_entry_points_remain_denied(self) -> None:
        commands = (
            (
                "python3 tools/governance/reviewctl.py record GOV-0001 "
                "--decision approved --approver user --kind scope --reason ok "
                "--confirmation-source codex --json"
            ),
            "python3 tools/governance/reviewctl.py waive GOV-0001 --check-id hook-tests",
        )
        for command in commands:
            with self.subTest(command=command):
                payload = self.fixture.payload("Bash", {"command": command})
                result = pre_tool_use.evaluate(payload)
                self.assert_denied(result, "legacy unsigned review entry points are disabled")

    def test_conversation_receipt_and_rework_lifecycle_are_reachable(self) -> None:
        commands = (
            (
                "python3 tools/governance/reviewctl.py record-conversation GOV-0001 "
                "--review-id GOV-0001-R004 --decision approved --kind scope "
                "--reason 'user approved current scope' "
                "--confirmation-ref conversation:test-turn "
                "--confirmation-text '确认当前范围' --actor Codex --json"
            ),
            (
                "python3 tools/governance/taskctl.py reopen GOV-0001 --actor Codex "
                "--reason 'user approved same-scope rework' --json"
            ),
        )
        for command in commands:
            with self.subTest(command=command):
                self.assertIsNone(
                    pre_tool_use.evaluate(
                        self.fixture.payload("Bash", {"command": command})
                    )
                )

        malformed = (
            "python3 tools/governance/reviewctl.py record-conversation GOV-0001 "
            "--review-id GOV-0001-R004 --decision approved --reason ok "
            "--confirmation-ref conversation:test --confirmation-text ok --actor user"
        )
        result = pre_tool_use.evaluate(
            self.fixture.payload("Bash", {"command": malformed})
        )
        self.assert_denied(result, "--actor must be Codex exactly")

    def test_bash_aliases_cannot_bypass_governance_cli_policy(self) -> None:
        command = (
            "python3 tools/governance/reviewctl.py record GOV-0001 "
            "--decision approved --approver user --kind scope --reason ok "
            "--confirmation-source codex --json"
        )
        for alias in ("bash", "BASH", "b_a-s-h"):
            with self.subTest(alias=alias):
                result = pre_tool_use.evaluate(
                    self.fixture.payload(alias, {"command": command})
                )
            self.assert_denied(result, "legacy unsigned review entry points are disabled")

    def test_governance_script_spoof_is_denied(self) -> None:
        outside = self.fixture.root / "other" / "taskctl.py"
        outside.parent.mkdir()
        outside.write_text("raise SystemExit(0)\n", encoding="utf-8")
        command = (
            f"python3 {shlex.quote(str(outside))} transition GOV-0001 REVIEW_PENDING "
            "--actor Codex --reason spoofed"
        )
        payload = self.fixture.payload("Bash", {"command": command})
        result = pre_tool_use.evaluate(payload)
        self.assert_denied(result, "must use the in-repository taskctl.py")

    def test_governance_cli_cannot_target_another_root(self) -> None:
        command = (
            "python3 tools/governance/taskctl.py transition GOV-0001 REVIEW_PENDING "
            "--actor Codex --reason wrong-root --root /tmp"
        )
        payload = self.fixture.payload("Bash", {"command": command})
        result = pre_tool_use.evaluate(payload)
        self.assert_denied(result, "--root must be the current repository")

    def test_controlled_cli_rejects_malformed_or_repeated_root(self) -> None:
        repository = shlex.quote(str(self.fixture.root))
        commands = (
            (
                "python3 tools/governance/taskctl.py run-validation GOV-0001 "
                "--check hook-tests --root /tmp"
            ),
            (
                "python3 tools/governance/taskctl.py run-validation GOV-0001 "
                "--check hook-tests --root"
            ),
            (
                "python3 tools/governance/taskctl.py run-required GOV-0001 "
                "--phase local --root " + repository + " --root " + repository
            ),
            (
                "python3 tools/governance/reviewctl.py prepare GOV-0001 "
                "--review-id GOV-0001-R002 --decision approved --reason ok "
                "--root /tmp"
            ),
        )
        for command in commands:
            with self.subTest(command=command):
                result = pre_tool_use.evaluate(
                    self.fixture.payload("Bash", {"command": command})
                )
                self.assert_denied(result, "governance CLI --root")

    def test_reviewed_tool_allowlist_is_honored(self) -> None:
        self.fixture.approve()
        payload = self.fixture.payload("update_plan", {"plan": []})
        self.assertIsNone(pre_tool_use.evaluate(payload))

    def test_reviewed_python_command_accepts_equivalent_runtime_path(self) -> None:
        self.fixture.approve()
        command = (
            f"{sys.executable} -m unittest discover -s .codex/tests -p test_*.py"
        )
        payload = self.fixture.payload("Bash", {"command": command})
        self.assertIsNone(pre_tool_use.evaluate(payload))

    def test_windows_runtime_path_keeps_backslashes_for_reviewed_command(self) -> None:
        command = (
            r"C:\hostedtoolcache\windows\Python\3.13.11\x64\python.exe "
            r"-m unittest discover -s .codex/tests -p test_*.py"
        )
        with mock.patch.object(_governance.os, "name", "nt"):
            words = _governance.shell_words(command)
            self.assertIsNotNone(words)
            assert words is not None
            self.assertEqual(
                r"C:\hostedtoolcache\windows\Python\3.13.11\x64\python.exe",
                words[0],
            )
            self.assertTrue(
                _governance.command_is_reviewed(
                    command,
                    ["python3 -m unittest discover -s .codex/tests -p test_*.py"],
                )
            )

    def test_receipt_bound_recovery_cli_is_narrowly_reachable(self) -> None:
        proposals = self.fixture.root / "project-control" / "proposals"
        proposals.mkdir(parents=True)
        for subcommand, name in (
            ("recover-committed", "GOV-0001-R010.json"),
            ("recover-pending-content", "GOV-0001-R012.json"),
        ):
            (proposals / name).write_text("{}\n", encoding="utf-8")
            command = (
                "python3 tools/governance/taskctl.py %s GOV-0001 "
                "--proposal project-control/proposals/%s "
                "--actor Codex --reason confirmed --root %s"
                % (subcommand, name, shlex.quote(str(self.fixture.root)))
            )
            with self.subTest(subcommand=subcommand):
                self.assertIsNone(
                    pre_tool_use.evaluate(self.fixture.payload("Bash", {"command": command}))
                )
        outside = self.fixture.root / "outside-recovery.json"
        outside.write_text("{}\n", encoding="utf-8")
        denied = (
            "python3 tools/governance/taskctl.py recover-pending-content GOV-0001 "
            "--proposal outside-recovery.json --actor Codex --reason confirmed --root "
            + shlex.quote(str(self.fixture.root))
        )
        self.assert_denied(
            pre_tool_use.evaluate(self.fixture.payload("Bash", {"command": denied})),
            "project-control/proposals",
        )

    def test_session_start_injects_task_and_review_context(self) -> None:
        self.fixture.approve()
        payload = {
            "session_id": "test-session",
            "cwd": str(self.fixture.root / "nested"),
            "hook_event_name": "SessionStart",
            "source": "resume",
        }
        output = session_start.build_output(payload)
        hook_output = output["hookSpecificOutput"]
        self.assertEqual(hook_output["hookEventName"], "SessionStart")
        prefix, encoded = hook_output["additionalContext"].split("\n", 1)
        self.assertEqual(prefix, "PROJECT GOVERNANCE CONTEXT")
        context = json.loads(encoded)
        self.assertEqual(context["governance"], "READY")
        self.assertEqual(context["task"]["id"], "GOV-0001")
        self.assertEqual(context["requirement"]["interaction_kind"], "non_ui")
        self.assertEqual(context["requirement"]["version"], "1.0")
        self.assertEqual(context["branch"]["base"], "main")
        self.assertEqual(context["branch"]["actual"], "codex/gov-0001-hooks")
        self.assertFalse(context["task"]["legacy_g0_v1_migration"])
        self.assertEqual(
            context["scope"]["release_units"], ["mac", "win", "backend"]
        )
        self.assertEqual(context["review_authority"], self.fixture.task["review_authority"])
        self.assertEqual(context["ci_trust"], self.fixture.task["ci_trust"])
        self.assertEqual(context["coordination"], self.fixture.task["coordination"])
        self.assertTrue(context["review"]["effective"])
        self.assertEqual("historical-signed", context["review"]["approval_mode"])
        self.assertFalse(context["review"]["cryptographic_identity_proof"])
        self.assertEqual(context["assumptions"], ["Only Codex uses the repository"])
        self.assertEqual(context["open_questions"], ["Application framework is not selected"])
        self.assertEqual(context["write_mode"], "IN_SCOPE_WRITES_ALLOWED")
        self.assertEqual(context["next_state"], "LOCAL_VERIFIED")
        self.assertIn("run-required", context["next_step"])
        self.assertIn("LOCAL_VERIFIED", context["next_step"])
        prohibited = {item["pattern"] for item in context["prohibited_paths"]}
        self.assertIn(".git/**", prohibited)
        self.assertIn("project-control/reviews/**", prohibited)
        self.assertIn("project-control/tasks/**", prohibited)
        self.assertIn("project-control/current-task.json", prohibited)
        self.assertIn("<outside task.allowed_paths>", prohibited)

    def test_session_start_fails_closed_without_state(self) -> None:
        empty_root = Path(self.temp.name) / "empty"
        (empty_root / ".git").mkdir(parents=True)
        (empty_root / ".git" / "HEAD").write_text(
            "ref: refs/heads/main\n",
            encoding="utf-8",
        )
        payload = {
            "session_id": "test-session",
            "cwd": str(empty_root),
            "hook_event_name": "SessionStart",
            "source": "startup",
        }
        output = session_start.build_output(payload)
        _, encoded = output["hookSpecificOutput"]["additionalContext"].split("\n", 1)
        context = json.loads(encoded)
        self.assertEqual(context["governance"], "FAIL_CLOSED")
        self.assertIn("Do not start work", context["instruction"])


class HookConfigurationTests(unittest.TestCase):
    def test_hooks_json_uses_official_event_shape(self) -> None:
        config_path = Path(__file__).resolve().parents[1] / "hooks.json"
        config = json.loads(config_path.read_text(encoding="utf-8"))
        session = config["hooks"]["SessionStart"][0]
        pretool = config["hooks"]["PreToolUse"][0]
        self.assertEqual(session["matcher"], "startup|resume|clear|compact")
        self.assertEqual(pretool["matcher"], "*")
        for group in (session, pretool):
            handler = group["hooks"][0]
            self.assertEqual(handler["type"], "command")
            self.assertNotIn("git ", handler["command"])
            self.assertIn("root=$PWD", handler["command"])
            self.assertIn("run_python.sh", handler["command"])
            self.assertIn("commandWindows", handler)
            self.assertNotIn("git rev-parse", handler["commandWindows"])
            self.assertIn("Get-Location", handler["commandWindows"])
            self.assertIn("run_python.ps1", handler["commandWindows"])

    def _real_session_command_finds_root_without_git(self) -> None:
        config_path = Path(__file__).resolve().parents[1] / "hooks.json"
        config = json.loads(config_path.read_text(encoding="utf-8"))
        command = config["hooks"]["SessionStart"][0]["hooks"][0]["command"]
        pretool_command = config["hooks"]["PreToolUse"][0]["hooks"][0]["command"]
        with tempfile.TemporaryDirectory(prefix="hook command root with spaces ") as directory:
            fixture = RepositoryFixture(Path(directory).resolve())
            fixture.approve()
            fake_bin = fixture.root / "fake-bin"
            fake_bin.mkdir()
            fake_git = fake_bin / "git"
            fake_git.write_text("#!/bin/sh\nexit 69\n", encoding="utf-8")
            fake_git.chmod(0o700)
            environment = os.environ.copy()
            environment["PROJECT_GOVERNANCE_PYTHON"] = sys.executable
            environment["PATH"] = str(fake_bin) + os.pathsep + "/usr/bin:/bin"
            for working_directory in (fixture.root, fixture.root / "nested"):
                with self.subTest(cwd=str(working_directory)):
                    payload = {
                        "session_id": "configured-command-test",
                        "cwd": str(working_directory),
                        "hook_event_name": "SessionStart",
                        "source": "startup",
                    }
                    completed = subprocess.run(
                        command,
                        cwd=str(working_directory),
                        env=environment,
                        input=json.dumps(payload),
                        shell=True,
                        executable="/bin/sh",
                        check=False,
                        capture_output=True,
                        text=True,
                    )
                    self.assertEqual(completed.returncode, 0, completed.stderr)
                    output = json.loads(completed.stdout)
                    context_text = output["hookSpecificOutput"]["additionalContext"]
                    _, encoded = context_text.split("\n", 1)
                    context = json.loads(encoded)
                    self.assertEqual(context["governance"], "READY")
                    self.assertEqual(context["repository"], str(fixture.root))
            for working_directory in (fixture.root, fixture.root / "nested"):
                with self.subTest(pretool_cwd=str(working_directory)):
                    payload = {
                        "session_id": "configured-command-test",
                        "turn_id": "configured-command-turn",
                        "cwd": str(working_directory),
                        "hook_event_name": "PreToolUse",
                        "tool_name": "apply_patch",
                        "tool_input": {
                            "command": (
                                "*** Begin Patch\n"
                                "*** Add File: outside-reviewed-scope.py\n"
                                "+pass\n"
                                "*** End Patch"
                            )
                        },
                    }
                    completed = subprocess.run(
                        pretool_command,
                        cwd=str(working_directory),
                        env=environment,
                        input=json.dumps(payload),
                        shell=True,
                        executable="/bin/sh",
                        check=False,
                        capture_output=True,
                        text=True,
                    )
                    self.assertEqual(completed.returncode, 0, completed.stderr)
                    output = json.loads(completed.stdout)
                    decision = output["hookSpecificOutput"]
                    self.assertEqual(decision["permissionDecision"], "deny")
                    # This subprocess intentionally has no externally signed
                    # receipt.  Reaching the authenticity denial proves the
                    # configured command found the repository and executed the
                    # real PreToolUse gate; unit tests above cover path policy
                    # with a test-process-only authenticity mock.
                    self.assertIn("signature", decision["permissionDecisionReason"])

    def _posix_launcher_prefers_explicit_valid_runtime(self) -> None:
        launcher = Path(__file__).resolve().parents[1] / "hooks" / "run_python.sh"
        with tempfile.TemporaryDirectory() as directory:
            fake = Path(directory) / "python3"
            fake.write_text(
                "#!/bin/sh\n"
                "if [ \"${1-}\" = \"-c\" ]; then exit 0; fi\n"
                "printf 'explicit:%s' \"$1\"\n",
                encoding="utf-8",
            )
            fake.chmod(0o700)
            environment = os.environ.copy()
            environment["PROJECT_GOVERNANCE_PYTHON"] = str(fake)
            completed = subprocess.run(
                ["/bin/sh", str(launcher), "session_start.py"],
                env=environment,
                check=False,
                capture_output=True,
                text=True,
            )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertTrue(completed.stdout.startswith("explicit:"), completed.stdout)
        self.assertTrue(completed.stdout.endswith("session_start.py"), completed.stdout)

    def _posix_launcher_rejects_unknown_entrypoint(self) -> None:
        launcher = Path(__file__).resolve().parents[1] / "hooks" / "run_python.sh"
        completed = subprocess.run(
            ["/bin/sh", str(launcher), "not-a-hook.py"],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(completed.returncode, 64)
        self.assertIn("unsupported governance hook entrypoint", completed.stderr)

    def _windows_launcher_prefers_explicit_valid_runtime(self) -> None:
        launcher = Path(__file__).resolve().parents[1] / "hooks" / "run_python.ps1"
        with tempfile.TemporaryDirectory() as directory:
            fake = Path(directory) / "python3.cmd"
            fake.write_text(
                "@echo off\r\n"
                "if \"%~1\"==\"-c\" exit /b 0\r\n"
                "echo explicit:%~1\r\n",
                encoding="utf-8",
            )
            environment = os.environ.copy()
            environment["PROJECT_GOVERNANCE_PYTHON"] = str(fake)
            completed = subprocess.run(
                [
                    "powershell.exe",
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(launcher),
                    "session_start.py",
                ],
                env=environment,
                check=False,
                capture_output=True,
                text=True,
            )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("explicit:", completed.stdout)
        self.assertIn("session_start.py", completed.stdout)

    def _real_windows_commands_find_root_without_git(self) -> None:
        config_path = Path(__file__).resolve().parents[1] / "hooks.json"
        config = json.loads(config_path.read_text(encoding="utf-8"))
        session_command = config["hooks"]["SessionStart"][0]["hooks"][0][
            "commandWindows"
        ]
        pretool_command = config["hooks"]["PreToolUse"][0]["hooks"][0][
            "commandWindows"
        ]
        with tempfile.TemporaryDirectory(
            prefix="hook windows command root with spaces "
        ) as directory:
            fixture = RepositoryFixture(Path(directory).resolve())
            fixture.approve()
            fake_bin = fixture.root / "fake-bin"
            fake_bin.mkdir()
            (fake_bin / "git.cmd").write_text(
                "@echo off\r\nexit /b 69\r\n",
                encoding="utf-8",
            )
            environment = os.environ.copy()
            environment["PROJECT_GOVERNANCE_PYTHON"] = sys.executable
            environment["PATH"] = str(fake_bin) + os.pathsep + environment["PATH"]

            for working_directory in (fixture.root, fixture.root / "nested"):
                with self.subTest(session_cwd=str(working_directory)):
                    payload = {
                        "session_id": "configured-windows-command-test",
                        "cwd": str(working_directory),
                        "hook_event_name": "SessionStart",
                        "source": "startup",
                    }
                    completed = subprocess.run(
                        session_command,
                        cwd=str(working_directory),
                        env=environment,
                        input=json.dumps(payload),
                        shell=True,
                        check=False,
                        capture_output=True,
                        text=True,
                    )
                    self.assertEqual(completed.returncode, 0, completed.stderr)
                    output = json.loads(completed.stdout.lstrip("\ufeff"))
                    context_text = output["hookSpecificOutput"]["additionalContext"]
                    _, encoded = context_text.split("\n", 1)
                    context = json.loads(encoded)
                    self.assertEqual(context["governance"], "READY")
                    self.assertEqual(context["repository"], str(fixture.root))

                with self.subTest(pretool_cwd=str(working_directory)):
                    payload = {
                        "session_id": "configured-windows-command-test",
                        "turn_id": "configured-windows-command-turn",
                        "cwd": str(working_directory),
                        "hook_event_name": "PreToolUse",
                        "tool_name": "apply_patch",
                        "tool_input": {
                            "command": (
                                "*** Begin Patch\n"
                                "*** Add File: outside-reviewed-scope.py\n"
                                "+pass\n"
                                "*** End Patch"
                            )
                        },
                    }
                    completed = subprocess.run(
                        pretool_command,
                        cwd=str(working_directory),
                        env=environment,
                        input=json.dumps(payload),
                        shell=True,
                        check=False,
                        capture_output=True,
                        text=True,
                    )
                    self.assertEqual(completed.returncode, 0, completed.stderr)
                    output = json.loads(completed.stdout.lstrip("\ufeff"))
                    decision = output["hookSpecificOutput"]
                    self.assertEqual(decision["permissionDecision"], "deny")
                    self.assertIn("signature", decision["permissionDecisionReason"])

    if os.name == "posix":
        test_real_session_command_finds_root_without_git = (
            _real_session_command_finds_root_without_git
        )
        test_posix_launcher_prefers_explicit_valid_runtime = (
            _posix_launcher_prefers_explicit_valid_runtime
        )
        test_posix_launcher_rejects_unknown_entrypoint = (
            _posix_launcher_rejects_unknown_entrypoint
        )
    elif os.name == "nt":
        test_windows_launcher_prefers_explicit_valid_runtime = (
            _windows_launcher_prefers_explicit_valid_runtime
        )
        test_real_windows_commands_find_root_without_git = (
            _real_windows_commands_find_root_without_git
        )


if __name__ == "__main__":
    unittest.main()
