from __future__ import annotations

import copy
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


GOVERNANCE_DIR = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = GOVERNANCE_DIR.parents[1]
if str(GOVERNANCE_DIR) not in sys.path:
    sys.path.insert(0, str(GOVERNANCE_DIR))
if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

import core  # noqa: E402
import reconcile  # noqa: E402
from core import (  # noqa: E402
    BOOTSTRAP_REPAIR_MESSAGE,
    SECOND_BOOTSTRAP_REPAIR_MESSAGE,
    canonical_scope_hash,
    read_json,
    run_git,
)
from helpers import AuthenticatedReceiptTestCase, base_task, initialize_root, write_json  # noqa: E402
from reconcile import run_reconcile  # noqa: E402
import taskctl  # noqa: E402
from validation_runner import RUNNER_VERSION, run_one  # noqa: E402


# The governance suite constructs its own trusted GitHub event fixtures.  When
# the suite is discovered inside Actions, inherited outer-run metadata would
# otherwise be mistaken for fixture evidence by tests that intentionally omit
# or replace individual fields.  Discovery imports every test module before
# executing cases, so clearing the non-secret outer context here keeps the
# complete suite deterministic without weakening production CI validation.
AMBIENT_CI_CONTEXT_KEYS = (
    "GITHUB_ACTIONS",
    "GITHUB_BASE_REF",
    "GITHUB_EVENT_NAME",
    "GITHUB_EVENT_PATH",
    "GITHUB_HEAD_REF",
    "GITHUB_REF",
    "GITHUB_REF_NAME",
    "GITHUB_REPOSITORY",
    "GITHUB_RUN_ATTEMPT",
    "GITHUB_RUN_ID",
    "GITHUB_SERVER_URL",
    "GITHUB_SHA",
    "GITHUB_WORKFLOW_REF",
    "MATERIAL_RELEASE_UNIT",
    "RUNNER_OS",
)
for _context_key in AMBIENT_CI_CONTEXT_KEYS:
    os.environ.pop(_context_key, None)


SECTION_TITLES = (
    "文档信息",
    "一句话摘要",
    "背景与现状证据",
    "使用者与使用场景",
    "目标与成功指标",
    "非目标",
    "范围",
    "前置与后置依赖",
    "假设和未决事项",
    "功能明细与业务规则",
    "用户流程与交互（UI 必填）",
    "非 UI 流程图（非 UI 需求必填）",
    "数据与生命周期",
    "登录、权限、安全与隐私",
    "接口与兼容性",
    "性能、可靠性与成本",
    "运维、可观察性和问题排查",
    "发布、迁移与回退",
    "验收标准",
    "验证计划与证据",
    "文档更新清单",
    "风险与影响分析",
    "审核与回执",
    "变更历史",
)
DOC_DIMENSIONS = (
    "project",
    "requirements",
    "development",
    "operations",
    "troubleshooting",
    "decisions",
    "governance",
)


class AmbientCiIsolationTests(unittest.TestCase):
    def test_discovered_governance_suite_does_not_inherit_outer_ci_context(self) -> None:
        self.assertEqual(
            [],
            [key for key in AMBIENT_CI_CONTEXT_KEYS if key in os.environ],
        )


def git(root: Path, *arguments: str) -> str:
    output, error = run_git(root, arguments)
    if error:
        raise AssertionError("git %s failed: %s" % (" ".join(arguments), error))
    return output or ""


def active_requirement_path(root: Path) -> Path:
    return root / "docs" / "requirements" / "测试需求-REQ-0009" / "测试需求-REQ-0009-v1.0.md"


def write_active_requirement(root: Path, placeholder: bool = False, section_count: int = 24) -> None:
    lines = ["# 测试需求-REQ-0009-v1.0", ""]
    for number, title in enumerate(SECTION_TITLES[:section_count], start=1):
        lines.extend(["## %s. %s" % (number, title), ""])
        if number == 9:
            lines.extend([
                "假设清单与未决事项清单均在本节维护。",
                "- ASM-TEST：测试假设已由用户确认。",
                "- OPEN-TEST：无阻断当前静态核对的未决事项。",
            ])
        elif number == 11:
            lines.append("**不适用。** 本治理测试没有 UI，理由和用户确认依据已记录。")
        elif number == 12:
            lines.extend([
                "失败、边界和恢复路径由以下状态图与流程图共同说明。",
                "",
                "```mermaid",
                "stateDiagram-v2",
                "    [*] --> READY",
                "    READY --> BLOCKED: 失败",
                "    BLOCKED --> READY: 恢复",
                "```",
                "",
                "```mermaid",
                "flowchart TD",
                "    A[入口] --> B{检查}",
                "    B -- 失败 --> C[恢复]",
                "```",
            ])
        elif placeholder and number == 20:
            lines.append("TODO: 待填验证证据")
        else:
            lines.append("本节提供已确认且可核对的完整说明。")
        lines.append("")
    path = active_requirement_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines), encoding="utf-8")


def prepare_static_root(root: Path, task_status: str = "IN_PROGRESS", task_id: str = "GOV-TEST") -> dict:
    task = base_task(status=task_status)
    task["task_id"] = task_id
    task["requirement"] = {
        "id": "测试需求-REQ-0009",
        "version": "v1.0",
        "name": "测试需求",
        "interaction_kind": "non_ui",
    }
    task["base_branch"] = "main"
    task["scope_version"] = 3
    task["branch"] = (
        "main" if task_id == "GOV-0001"
        else "codex/req-0009-%s-static-checks" % task_id.lower()
    )
    task["allowed_paths"] = [".github/**", "docs/**", "tools/governance/**"]
    task["required_docs"] = [
        "docs/requirements/测试需求-REQ-0009/测试需求-REQ-0009-v1.0.md",
        ".github/workflows/governance.yml",
    ]
    task["validation"] = {
        "required": [{
            "id": "unit",
            "argv": ["python3", "-c", "pass"],
            "timeout_seconds": 60,
            "gates": ["LOCAL_VERIFIED", "CI_VERIFIED", "POST_MERGE_VERIFIED"],
            "release_units": ["mac", "win", "backend"],
        }],
        "results": [],
    }
    task["coordination"] = {
        "mode": "coordinated-multi",
        "coordinator_task": task_id,
        "unit_tasks": {"mac": task_id, "win": task_id, "backend": task_id},
        "compatibility_matrix_doc": (
            "docs/requirements/测试需求-REQ-0009/测试需求-REQ-0009-v1.0.md"
        ),
        "deployment_order": ["backend", "mac", "win"],
        "rollback_order": ["mac", "win", "backend"],
        "unit_validation_checks": {
            "mac": ["unit"], "win": ["unit"], "backend": ["unit"],
        },
        "unit_rollback_checks": {
            "mac": ["unit"], "win": ["unit"], "backend": ["unit"],
        },
    }
    task["assumptions"] = [{"id": "ASM-TEST", "statement": "test", "status": "confirmed"}]
    task["open_questions"] = [{
        "id": "OPEN-TEST",
        "question": "test question",
        "status": "resolved",
        "blocking_for": "none",
    }]
    initialize_root(root, task)
    project_path = root / "project-control" / "project.json"
    project = read_json(project_path)
    project.update({
        "project_id": "material",
        "source_repository": "git@github.com:wzhic/material.git",
        "maintainers": 1,
        "coding_agents": ["Codex"],
    })
    project["branch_policy"]["default_pattern"] = "codex/<requirement-id>-<task-id>-<readable-slug>"
    write_json(project_path, project)
    for dimension in DOC_DIMENSIONS:
        index = root / "docs" / dimension / "README.md"
        index.parent.mkdir(parents=True, exist_ok=True)
        index.write_text("# %s documents\n" % dimension, encoding="utf-8")
    write_active_requirement(root)
    (root / "README.md").write_text(
        "GOV-0001-R003 authorizes conversation-v1; use reviewctl record-conversation. "
        "该回执不是密码学身份凭证。\n",
        encoding="utf-8",
    )
    (root / "AGENTS.md").write_text("# Test governance instructions\n", encoding="utf-8")
    template = root / "docs" / "requirements" / "需求文档模板-REQ-TEMPLATE-0001-v1.0.md"
    template.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(
        str(REPOSITORY_ROOT / "docs" / "requirements" / "需求文档模板-REQ-TEMPLATE-0001-v1.0.md"),
        str(template),
    )
    workflow = root / ".github" / "workflows" / "governance.yml"
    workflow.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(str(REPOSITORY_ROOT / ".github" / "workflows" / "governance.yml"), str(workflow))
    return task


def renew_test_scope_review(root: Path, task: dict) -> None:
    """Persist a changed fixture scope without rebuilding its complete repository."""

    write_json(root / "project-control" / "tasks" / (task["task_id"] + ".json"), task)
    receipt = read_json(root / "project-control" / "reviews" / "REV-TEST.json")
    receipt["scope_version"] = task["scope_version"]
    receipt["scope_hash"] = canonical_scope_hash(task)
    write_json(root / "project-control" / "reviews" / "REV-TEST.json", receipt)


def initialize_git(root: Path) -> None:
    git(root, "init")
    git(root, "config", "user.name", "Governance Test")
    git(root, "config", "user.email", "governance@example.invalid")


def commit_all(root: Path, message: str) -> str:
    git(root, "add", "--all")
    git(root, "commit", "-m", message)
    return git(root, "rev-parse", "HEAD")


def store_controlled_local_pass(root: Path, task: dict) -> dict:
    """Create fixture evidence through the same process-derived runner as production."""

    check = task["validation"]["required"][0]
    result = run_one(root, task, check, "local", environment="controlled-test")
    if result["status"] != "passed":
        raise AssertionError("controlled local fixture did not pass: %r" % result)
    result["source"] = RUNNER_VERSION
    task["validation"]["results"] = [result]
    write_json(root / "project-control" / "tasks" / (task["task_id"] + ".json"), task)
    return result


def github_push_environment(root: Path, before: str, after: str, branch: str, created: bool = False) -> dict:
    event_path = root / "github-event.json"
    event_path.write_text(json.dumps({
        "ref": "refs/heads/" + branch,
        "before": before,
        "after": after,
        "created": created,
        "deleted": False,
        "repository": {"full_name": "wzhic/material"},
    }), encoding="utf-8")
    return {
        "GITHUB_ACTIONS": "true",
        "GITHUB_EVENT_NAME": "push",
        "GITHUB_EVENT_PATH": str(event_path),
        "GITHUB_SHA": after,
        "GITHUB_REF": "refs/heads/" + branch,
        "GITHUB_REF_NAME": branch,
        "GITHUB_RUN_ID": "123456",
        "GITHUB_SERVER_URL": "https://github.com",
        "GITHUB_REPOSITORY": "wzhic/material",
        "GITHUB_WORKFLOW_REF": "wzhic/material/.github/workflows/governance.yml@refs/heads/" + branch,
        "MATERIAL_RELEASE_UNIT": "backend",
        "RUNNER_OS": "Linux",
    }


def github_pull_request_environment(root: Path, base: str, head: str, base_ref: str, head_ref: str) -> dict:
    event_path = root / "github-event.json"
    event_path.write_text(json.dumps({
        "repository": {"full_name": "wzhic/material"},
        "pull_request": {
            "base": {"sha": base, "ref": base_ref},
            "head": {"sha": head, "ref": head_ref},
        }
    }), encoding="utf-8")
    return {
        "GITHUB_ACTIONS": "true",
        "GITHUB_EVENT_NAME": "pull_request",
        "GITHUB_EVENT_PATH": str(event_path),
        "GITHUB_SHA": head,
        "GITHUB_HEAD_REF": head_ref,
        "GITHUB_BASE_REF": base_ref,
        "GITHUB_REF": "refs/pull/7/merge",
        "GITHUB_RUN_ID": "123457",
        "GITHUB_SERVER_URL": "https://github.com",
        "GITHUB_REPOSITORY": "wzhic/material",
        "GITHUB_WORKFLOW_REF": "wzhic/material/.github/workflows/governance.yml@refs/heads/" + head_ref,
        "MATERIAL_RELEASE_UNIT": "backend",
        "RUNNER_OS": "Linux",
    }


class StaticProfileTests(AuthenticatedReceiptTestCase):
    def test_static_profile_checks_active_requirement_and_workflow(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = prepare_static_root(root)
            report = run_reconcile(
                root, "static", git_branch=task["branch"], git_changes=[]
            )
            self.assertTrue(report["ok"], report)
            check_ids = {item["id"] for item in report["checks"]}
            self.assertIn("requirement_sections", check_ids)
            self.assertIn("requirement_flow", check_ids)
            self.assertIn("requirement_placeholders", check_ids)
            self.assertIn("requirement_template", check_ids)
            self.assertIn("governed_requirements", check_ids)
            self.assertIn("local_markdown_links", check_ids)
            self.assertIn("workflow_contract", check_ids)
            self.assertIn("fixed_project_contract", check_ids)
            self.assertIn("ci_trust", check_ids)
            self.assertIn("coordination", check_ids)
            self.assertIn("validation_provenance", check_ids)

    def test_static_profile_rejects_missing_section_and_placeholder(self) -> None:
        cases = ((False, 23, "requirement_sections"), (True, 24, "requirement_placeholders"))
        for placeholder, count, expected_check in cases:
            with self.subTest(expected_check=expected_check), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                task = prepare_static_root(root)
                write_active_requirement(root, placeholder=placeholder, section_count=count)
                report = run_reconcile(
                    root, "static", git_branch=task["branch"], git_changes=[]
                )
                self.assertFalse(report["ok"])
                failed = {item["id"] for item in report["checks"] if item["status"] == "failed"}
                self.assertIn(expected_check, failed)

    def test_precommit_checks_local_gate_without_requiring_local_verified_status(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = prepare_static_root(root, task_status="IN_PROGRESS")
            report = run_reconcile(
                root, "precommit", git_branch=task["branch"], git_changes=[]
            )
            self.assertFalse(report["ok"], report)
            check_ids = {item["id"] for item in report["checks"]}
            self.assertNotIn("phase", check_ids)
            self.assertIn("doc_dimensions", check_ids)
            self.assertIn("workflow_contract", check_ids)
            validation = next(item for item in report["checks"] if item["id"] == "validation")
            self.assertEqual("failed", validation["status"])

            store_controlled_local_pass(root, task)
            passed = run_reconcile(
                root, "precommit", git_branch=task["branch"], git_changes=[]
            )
            self.assertTrue(passed["ok"], passed)

    def test_workflow_contract_rejects_shallow_checkout(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = prepare_static_root(root)
            workflow = root / ".github" / "workflows" / "governance.yml"
            workflow.write_text(
                workflow.read_text(encoding="utf-8").replace("fetch-depth: 0", "fetch-depth: 1"),
                encoding="utf-8",
            )
            report = run_reconcile(
                root, "workflow", git_branch=task["branch"], git_changes=[]
            )
            self.assertFalse(report["ok"])
            contract = next(item for item in report["checks"] if item["id"] == "workflow_contract")
            self.assertIn("fetch-depth", contract["message"])

    def test_workflow_contract_requires_nonempty_test_suite_guards(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = prepare_static_root(root)
            workflow = root / ".github" / "workflows" / "governance.yml"
            workflow.write_text(
                workflow.read_text(encoding="utf-8").replace(
                    "discover('tools/governance/tests', pattern='test_*.py').countTestCases()",
                    "discover('tools/governance/tests', pattern='test_*.py').disabledCount()",
                ),
                encoding="utf-8",
            )
            report = run_reconcile(
                root, "workflow", git_branch=task["branch"], git_changes=[]
            )
            self.assertFalse(report["ok"])
            contract = next(
                item for item in report["checks"] if item["id"] == "workflow_contract"
            )
            self.assertIn("governance tests reject an empty suite", contract["message"])

    def test_workflow_uses_independent_test_loaders_for_each_suite(self) -> None:
        workflow = (
            REPOSITORY_ROOT / ".github" / "workflows" / "governance.yml"
        ).read_text(encoding="utf-8")
        self.assertNotIn("unittest.defaultTestLoader", workflow)
        self.assertEqual(2, workflow.count("unittest.TestLoader().discover("))

    def test_workflow_contract_requires_controlled_three_unit_matrix(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = prepare_static_root(root)
            workflow = root / ".github" / "workflows" / "governance.yml"
            workflow.write_text(
                workflow.read_text(encoding="utf-8").replace("run-required", "run-validation"),
                encoding="utf-8",
            )
            report = run_reconcile(root, "workflow", git_branch=task["branch"], git_changes=[])
            self.assertFalse(report["ok"])
            contract = next(item for item in report["checks"] if item["id"] == "workflow_contract")
            self.assertIn("controlled required validation", contract["message"])

    def test_workflow_contract_requires_official_pinned_uv_setup(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = prepare_static_root(root)
            workflow = root / ".github" / "workflows" / "governance.yml"
            workflow.write_text(
                workflow.read_text(encoding="utf-8").replace(
                    "astral-sh/setup-uv@c771a70e6277c0a99b617c7a806ffedaca235ff9",
                    "astral-sh/setup-uv@v9",
                ),
                encoding="utf-8",
            )
            report = run_reconcile(root, "workflow", git_branch=task["branch"], git_changes=[])
            self.assertFalse(report["ok"])
            contract = next(item for item in report["checks"] if item["id"] == "workflow_contract")
            self.assertIn("official pinned uv setup", contract["message"])

    def test_workflow_contract_requires_locked_desktop_dependencies(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = prepare_static_root(root)
            workflow = root / ".github" / "workflows" / "governance.yml"
            workflow.write_text(
                workflow.read_text(encoding="utf-8").replace(
                    "npm ci --prefix apps/desktop",
                    "echo desktop dependencies omitted",
                ),
                encoding="utf-8",
            )
            report = run_reconcile(root, "workflow", git_branch=task["branch"], git_changes=[])
            self.assertFalse(report["ok"])
            contract = next(item for item in report["checks"] if item["id"] == "workflow_contract")
            self.assertIn("desktop lockfile dependencies installed", contract["message"])

    def test_workflow_contract_requires_json_runner_diagnostics(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = prepare_static_root(root)
            workflow = root / ".github" / "workflows" / "governance.yml"
            workflow.write_text(
                workflow.read_text(encoding="utf-8").replace(
                    "'--json'",
                    "'--diagnostics-disabled'",
                ),
                encoding="utf-8",
            )
            report = run_reconcile(root, "workflow", git_branch=task["branch"], git_changes=[])
            self.assertFalse(report["ok"])
            contract = next(item for item in report["checks"] if item["id"] == "workflow_contract")
            self.assertIn("controlled required validation", contract["message"])

    def test_workflow_failure_diagnostics_preserve_controlled_result(self) -> None:
        workflow = (
            REPOSITORY_ROOT / ".github" / "workflows" / "governance.yml"
        ).read_text(encoding="utf-8")
        self.assertIn("controlled_code = subprocess.call(", workflow)
        self.assertIn("controlled_code == 0 or", workflow)
        self.assertIn("raise SystemExit(controlled_code)", workflow)
        self.assertIn("[sys.executable, '-m', 'unittest', 'discover'", workflow)
        self.assertIn(
            "[sys.executable, 'tools/governance/reconcile.py', 'static', '--json']",
            workflow,
        )
        self.assertNotIn("continue-on-error: true", workflow)
        self.assertEqual(
            1,
            workflow.count(
                "PSModuleAnalysisCachePath: ${{ github.workspace }}/../PowerShell-ModuleAnalysisCache"
            ),
        )
        self.assertNotIn("PSModuleAnalysisCachePath: ${{ runner.temp }}", workflow)

    def test_workflow_contract_rejects_duplicate_direct_validation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = prepare_static_root(root)
            workflow = root / ".github" / "workflows" / "governance.yml"
            workflow.write_text(
                workflow.read_text(encoding="utf-8")
                + "\n# duplicate\n# python -m unittest discover -s tools/governance/tests\n",
                encoding="utf-8",
            )
            report = run_reconcile(root, "workflow", git_branch=task["branch"], git_changes=[])
            self.assertFalse(report["ok"])
            contract = next(item for item in report["checks"] if item["id"] == "workflow_contract")
            self.assertIn("no duplicate governance test execution", contract["message"])

    def test_workflow_contract_rejects_github_run_metadata_writeback(self) -> None:
        forbidden_markers = (
            "sync-github-run",
            "MATERIAL_GITHUB_ACTIONS_READ_TOKEN",
            "secrets.GITHUB_TOKEN",
            "github.token",
            "GITHUB_RUN_ID",
            "github.run_id",
            "--run-id",
            "--run-url",
            "/actions/runs/",
        )
        for marker in forbidden_markers:
            with self.subTest(marker=marker), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                task = prepare_static_root(root)
                workflow = root / ".github" / "workflows" / "governance.yml"
                workflow.write_text(
                    workflow.read_text(encoding="utf-8") + "\n# " + marker + "\n",
                    encoding="utf-8",
                )
                report = run_reconcile(
                    root, "workflow", git_branch=task["branch"], git_changes=[]
                )
                self.assertFalse(report["ok"])
                contract = next(
                    item for item in report["checks"] if item["id"] == "workflow_contract"
                )
                self.assertIn("no GitHub run metadata writeback", contract["message"])

    def test_static_rejects_fixed_project_repository_drift(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = prepare_static_root(root)
            project_path = root / "project-control" / "project.json"
            project = read_json(project_path)
            project["source_repository"] = "git@github.com:attacker/material.git"
            write_json(project_path, project)
            report = run_reconcile(root, "static", git_branch=task["branch"], git_changes=[])
            fixed = next(item for item in report["checks"] if item["id"] == "fixed_project_contract")
            self.assertEqual("failed", fixed["status"])
            self.assertIn("source_repository", fixed["message"])

    def test_static_rejects_broken_relative_link_and_incomplete_template(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = prepare_static_root(root)
            requirement = active_requirement_path(root)
            requirement.write_text(
                requirement.read_text(encoding="utf-8") + "\n[broken](../../../../outside.md)\n",
                encoding="utf-8",
            )
            template = root / "docs" / "requirements" / "需求文档模板-REQ-TEMPLATE-0001-v1.0.md"
            template.write_text(
                template.read_text(encoding="utf-8").replace("## 24. 变更历史", "### 变更历史"),
                encoding="utf-8",
            )
            report = run_reconcile(root, "static", git_branch=task["branch"], git_changes=[])
            failed = {item["id"] for item in report["checks"] if item["status"] == "failed"}
            self.assertIn("local_markdown_links", failed)
            self.assertIn("requirement_template", failed)

    def test_static_rejects_stale_pre_r003_approval_state(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = prepare_static_root(root)
            (root / "README.md").write_text(
                "GOV-0001-R003 authorizes conversation-v1; use reviewctl record-conversation. "
                "该回执不是密码学身份凭证。当前 scope v1 不能记录新 PASS。\n",
                encoding="utf-8",
            )
            report = run_reconcile(root, "static", git_branch=task["branch"], git_changes=[])
            migration = next(
                item for item in report["checks"] if item["id"] == "approval_migration_docs"
            )
            self.assertEqual("failed", migration["status"])
            self.assertIn("README.md:1", migration["message"])

    def test_new_task_scope_v1_does_not_reenter_gov0001_migration(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = prepare_static_root(root)
            task["scope_version"] = 1
            renew_test_scope_review(root, task)
            report = run_reconcile(root, "static", git_branch=task["branch"], git_changes=[])
            migration = next(
                item for item in report["checks"] if item["id"] == "approval_migration_docs"
            )
            self.assertEqual("passed", migration["status"])
            self.assertFalse(migration["details"]["migration_scope_applies"])

    def test_static_scans_noncurrent_review_pending_requirement(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = prepare_static_root(root)
            second = base_task(status="REVIEW_PENDING")
            second["task_id"] = "GOV-SECOND"
            second["requirement"] = {
                "id": "第二需求-REQ-0010",
                "version": "v1.0",
                "name": "第二需求",
                "interaction_kind": "non_ui",
            }
            second["branch"] = "codex/req-0010-gov-second-second-requirement"
            write_json(root / "project-control" / "tasks" / "GOV-SECOND.json", second)
            report = run_reconcile(root, "static", git_branch=task["branch"], git_changes=[])
            governed = next(item for item in report["checks"] if item["id"] == "governed_requirements")
            self.assertEqual("failed", governed["status"])
            self.assertIn("GOV-SECOND", governed["message"])


class TrustedCiContextTests(AuthenticatedReceiptTestCase):
    def prepare_two_layer_commits(self, root: Path, ordinary_change_in_control_head: bool = False):
        task = prepare_static_root(root)
        initialize_git(root)
        base_sha = commit_all(root, "reviewed base")
        content = root / "tools" / "governance" / "content.py"
        content.parent.mkdir(parents=True, exist_ok=True)
        content.write_text("VALUE = 'content subject'\n", encoding="utf-8")
        store_controlled_local_pass(root, task)
        task_file = root / "project-control" / "tasks" / (task["task_id"] + ".json")
        content_sha = commit_all(root, "content subject")

        task["status"] = "COMMITTED"
        task["git"] = {"committed_sha": content_sha}
        write_json(task_file, task)
        if ordinary_change_in_control_head:
            ordinary = root / "tools" / "governance" / "ordinary.py"
            ordinary.parent.mkdir(parents=True, exist_ok=True)
            ordinary.write_text("VALUE = 1\n", encoding="utf-8")
        control_sha = commit_all(root, "control metadata")
        return task, base_sha, content_sha, control_sha

    def test_ci_accepts_content_commit_plus_control_only_head(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task, base_sha, content_sha, control_sha = self.prepare_two_layer_commits(root)
            environment = github_push_environment(
                root, base_sha, control_sha, task["branch"]
            )
            with mock.patch.dict(os.environ, environment, clear=False):
                report = run_reconcile(root, "ci")
            self.assertTrue(report["ok"], report)
            self.assertEqual(content_sha, report["context"]["ci"]["content_subject_sha"])
            self.assertEqual(control_sha, report["context"]["ci"]["control_head_sha"])
            self.assertEqual("control_head", report["context"]["ci"]["mode"])

    def test_ci_attributes_only_exact_done_successor_merges_in_stack(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task, base_sha, _content_sha, _control_sha = self.prepare_two_layer_commits(root)
            git(root, "branch", "-M", task["branch"])

            successor = copy.deepcopy(task)
            successor_id = "GOV-SUCCESSOR"
            successor["task_id"] = successor_id
            successor["status"] = "DRAFT"
            successor["branch"] = "codex/req-0009-gov-successor-owned-change"
            successor["base_branch"] = task["branch"]
            successor["allowed_paths"] = ["successor/**", "project-control/**"]
            successor["validation"]["results"] = []
            successor.pop("git", None)
            successor["coordination"]["coordinator_task"] = successor_id
            successor["coordination"]["unit_tasks"] = {
                "mac": successor_id, "win": successor_id, "backend": successor_id,
            }
            successor_file = (
                root / "project-control" / "tasks" / (successor_id + ".json")
            )
            write_json(successor_file, successor)
            commit_all(root, "register successor task")

            git(root, "switch", "-c", successor["branch"])
            owned = root / "successor" / "owned.py"
            owned.parent.mkdir(parents=True, exist_ok=True)
            owned.write_text("VALUE = 'reviewed successor'\n", encoding="utf-8")
            successor_subject = commit_all(root, "successor content subject")
            successor["status"] = "COMMITTED"
            successor["git"] = {"committed_sha": successor_subject}
            write_json(successor_file, successor)
            commit_all(root, "successor control metadata")

            git(root, "switch", task["branch"])
            git(root, "merge", "--no-ff", successor["branch"], "-m", "merge successor")
            successor_merge = git(root, "rev-parse", "HEAD")
            successor["status"] = "DONE"
            successor["git"]["merged_sha"] = successor_merge
            write_json(successor_file, successor)
            head = commit_all(root, "close successor task")
            git(root, "checkout", "--detach", head)

            environment = github_pull_request_environment(
                root, base_sha, head, "main", task["branch"]
            )
            with mock.patch.dict(os.environ, environment, clear=False):
                report = run_reconcile(root, "ci")
            self.assertTrue(report["ok"], report)
            changed = next(item for item in report["checks"] if item["id"] == "changed_paths")
            protocol = next(
                item for item in report["checks"] if item["id"] == "ci_commit_protocol"
            )
            self.assertEqual(
                [successor_id],
                [item["task_id"] for item in changed["details"]["successor_merges"]],
            )
            self.assertEqual(
                [successor_id],
                [item["task_id"] for item in protocol["details"]["successor_merges"]],
            )

            git(root, "switch", task["branch"])
            successor["status"] = "COMMITTED"
            write_json(successor_file, successor)
            untrusted_head = commit_all(root, "make successor incomplete")
            git(root, "checkout", "--detach", untrusted_head)
            untrusted_environment = github_pull_request_environment(
                root, base_sha, untrusted_head, "main", task["branch"]
            )
            with mock.patch.dict(os.environ, untrusted_environment, clear=False):
                rejected = run_reconcile(root, "ci")
            self.assertFalse(rejected["ok"])
            rejected_protocol = next(
                item for item in rejected["checks"] if item["id"] == "ci_commit_protocol"
            )
            self.assertIn("DONE direct successor", rejected_protocol["message"])

    def test_ci_accepts_exact_g0_root_subject_plus_protected_control_head(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = prepare_static_root(root, task_id="GOV-0001")
            task["allowed_paths"].extend([
                "project-control/**",
                "AGENTS.md",
                "README.md",
            ])
            task["branch_exception"] = {
                "kind": "bootstrap-main",
                "applies_only_to_task": "GOV-0001",
                "reason": "isolated bootstrap test",
            }
            renew_test_scope_review(root, task)
            initialize_git(root)
            store_controlled_local_pass(root, task)
            task["status"] = "LOCAL_VERIFIED"
            task_file = root / "project-control" / "tasks" / "GOV-0001.json"
            write_json(task_file, task)
            content_sha = commit_all(root, "root content subject")

            task["status"] = "COMMITTED"
            task["git"] = {"committed_sha": content_sha}
            write_json(task_file, task)
            control_sha = commit_all(root, "protected control state")
            environment = github_push_environment(root, content_sha, control_sha, "main")
            with mock.patch.dict(os.environ, environment, clear=False):
                report = run_reconcile(root, "ci")
            self.assertTrue(report["ok"], report)
            context = report["context"]["ci"]
            self.assertEqual("bootstrap_control_head", context["mode"])
            self.assertEqual(content_sha, context["content_subject_sha"])
            self.assertEqual(control_sha, context["control_head_sha"])
            self.assertGreater(context["bootstrap_content_path_count"], 0)

    def test_taskctl_first_root_push_returns_pending_without_recording_ci_pass(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = prepare_static_root(root, task_id="GOV-0001")
            task["allowed_paths"].extend([
                "project-control/**",
                "AGENTS.md",
                "README.md",
            ])
            renew_test_scope_review(root, task)
            initialize_git(root)
            store_controlled_local_pass(root, task)
            task["status"] = "LOCAL_VERIFIED"
            task_file = root / "project-control" / "tasks" / "GOV-0001.json"
            write_json(task_file, task)
            before_results = copy.deepcopy(task["validation"]["results"])
            head = commit_all(root, "bootstrap root snapshot")
            environment = github_push_environment(
                root, "0" * len(head), head, "main", created=True
            )
            with mock.patch.dict(os.environ, environment, clear=False):
                code = taskctl.main([
                    "run-required", "GOV-0001",
                    "--phase", "ci",
                    "--release-unit", "backend",
                    "--environment", "github-actions:push:backend",
                    "--bootstrap-first-push",
                    "--root", str(root),
                    "--json",
                ])
            self.assertEqual(0, code)
            stored = read_json(task_file)
            self.assertEqual(before_results, stored["validation"]["results"])
            self.assertFalse(any(
                item.get("phase") == "ci" for item in stored["validation"]["results"]
            ))

    def test_ci_rejects_ordinary_content_in_control_only_range(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task, base_sha, content_sha, control_sha = self.prepare_two_layer_commits(
                root, ordinary_change_in_control_head=True
            )
            environment = github_push_environment(
                root, base_sha, control_sha, task["branch"]
            )
            with mock.patch.dict(os.environ, environment, clear=False):
                report = run_reconcile(root, "ci")
            self.assertFalse(report["ok"])
            protocol = next(item for item in report["checks"] if item["id"] == "ci_commit_protocol")
            self.assertIn("ordinary.py", protocol["message"])

    def test_ci_rejects_event_range_that_omits_content_commit_changes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task, _base_sha, content_sha, control_sha = self.prepare_two_layer_commits(root)
            environment = github_push_environment(
                root, content_sha, control_sha, task["branch"]
            )
            with mock.patch.dict(os.environ, environment, clear=False):
                report = run_reconcile(root, "ci")
            self.assertFalse(report["ok"])
            protocol = next(item for item in report["checks"] if item["id"] == "ci_commit_protocol")
            self.assertIn("does not revalidate", protocol["message"])

    def test_pr_detached_head_uses_trusted_event_branch(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task, base_sha, content_sha, control_sha = self.prepare_two_layer_commits(root)
            git(root, "checkout", "--detach", control_sha)
            environment = github_pull_request_environment(
                root, base_sha, control_sha, "main", task["branch"]
            )
            with mock.patch.dict(os.environ, environment, clear=False):
                report = run_reconcile(root, "ci")
                static_report = run_reconcile(root, "static", git_changes=[])
            self.assertTrue(report["ok"], report)
            self.assertTrue(static_report["ok"], static_report)
            branch = next(item for item in report["checks"] if item["id"] == "branch")
            self.assertEqual(task["branch"], branch["details"]["actual"])
            static_branch = next(item for item in static_report["checks"] if item["id"] == "branch")
            self.assertEqual("trusted_github_event", static_branch["details"]["source"])

    def test_terminal_task_pr_still_uses_trusted_event_head_branch(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task, base_sha, content_sha, _control_sha = self.prepare_two_layer_commits(root)
            original_branch = git(root, "rev-parse", "--abbrev-ref", "HEAD")
            git(root, "switch", "-c", "post-merge-main", base_sha)
            side_marker = root / "post-merge-main.txt"
            side_marker.write_text("terminal merge lives on the base branch\n", encoding="utf-8")
            merged_sha = commit_all(root, "terminal merge on base branch")
            git(root, "switch", original_branch)
            task["status"] = "DONE"
            task["git"] = {
                "committed_sha": content_sha,
                "merged_sha": merged_sha,
            }
            task_file = root / "project-control" / "tasks" / (task["task_id"] + ".json")
            write_json(task_file, task)
            control_sha = commit_all(root, "terminal task control metadata")
            git(root, "checkout", "--detach", control_sha)
            environment = github_pull_request_environment(
                root, base_sha, control_sha, "main", task["branch"]
            )
            with mock.patch.dict(os.environ, environment, clear=False):
                ci_report = run_reconcile(root, "ci")
                report = run_reconcile(root, "static", git_changes=[])
            self.assertTrue(ci_report["ok"], ci_report)
            self.assertTrue(report["ok"], report)
            self.assertEqual("ci", ci_report["context"]["ci"]["phase"])
            changed = next(item for item in ci_report["checks"] if item["id"] == "changed_paths")
            self.assertEqual("passed", changed["status"])
            branch = next(item for item in report["checks"] if item["id"] == "branch")
            self.assertEqual(task["branch"], branch["details"]["expected"])
            self.assertEqual(task["branch"], branch["details"]["actual"])
            self.assertEqual("trusted_github_event", branch["details"]["source"])

    def test_taskctl_ci_branch_gate_accepts_only_a_reconciled_detached_pr_head(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task, base_sha, _content_sha, control_sha = self.prepare_two_layer_commits(root)
            task["status"] = "DONE"
            task["git"]["merged_sha"] = control_sha
            task_file = root / "project-control" / "tasks" / (task["task_id"] + ".json")
            write_json(task_file, task)
            terminal_head = commit_all(root, "terminal task PR control metadata")
            git(root, "checkout", "--detach", terminal_head)
            environment = github_pull_request_environment(
                root, base_sha, terminal_head, "main", task["branch"]
            )
            before_results = copy.deepcopy(task["validation"]["results"])
            with mock.patch.dict(os.environ, environment, clear=False):
                taskctl._require_validation_branch(root, task, "ci")
                with mock.patch("sys.stdout"):
                    code = taskctl.main([
                        "run-required", task["task_id"],
                        "--phase", "ci",
                        "--release-unit", "backend",
                        "--environment", "github-actions:pull_request:backend",
                        "--root", str(root),
                        "--json",
                    ])
            self.assertEqual(0, code)
            self.assertEqual(before_results, read_json(task_file)["validation"]["results"])

            untrusted = dict(environment)
            untrusted["GITHUB_REPOSITORY"] = "attacker/material"
            with mock.patch.dict(os.environ, untrusted, clear=False):
                with self.assertRaisesRegex(Exception, "trusted GitHub CI context is invalid"):
                    taskctl._require_validation_branch(root, task, "ci")

    def test_main_push_detached_head_runs_the_single_controlled_ci_entry(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task, base_sha, _content_sha, control_sha = self.prepare_two_layer_commits(root)
            git(root, "branch", "main", base_sha)
            git(root, "switch", "main")
            git(root, "merge", "--no-ff", control_sha, "-m", "merge governed task")
            merge_sha = git(root, "rev-parse", "HEAD")
            task["status"] = "DONE"
            task["git"]["merged_sha"] = merge_sha
            task_file = root / "project-control" / "tasks" / (task["task_id"] + ".json")
            write_json(task_file, task)
            terminal_head = commit_all(root, "terminal task main control metadata")
            git(root, "checkout", "--detach", terminal_head)
            environment = github_push_environment(root, base_sha, terminal_head, "main")
            with mock.patch.dict(os.environ, environment, clear=False):
                report = run_reconcile(root, "ci")
                with mock.patch("sys.stdout"):
                    code = taskctl.main([
                        "run-required", task["task_id"],
                        "--phase", "ci",
                        "--release-unit", "backend",
                        "--environment", "github-actions:push:backend",
                        "--root", str(root),
                        "--json",
                    ])
            self.assertTrue(report["ok"], report)
            self.assertEqual(0, code)
            branch = next(item for item in report["checks"] if item["id"] == "branch")
            self.assertEqual("main", branch["details"]["actual"])
            self.assertEqual("trusted_github_event", branch["details"]["source"])

    def test_main_push_attributes_clean_closeout_stack_to_done_successors(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task, base_sha, content_sha, _control_sha = self.prepare_two_layer_commits(root)
            task_file = root / "project-control" / "tasks" / (task["task_id"] + ".json")
            git(root, "branch", "-M", task["branch"])

            git(root, "switch", "-c", "main", base_sha)
            git(root, "merge", "--no-ff", task["branch"], "-m", "merge governed task")
            merged_base = git(root, "rev-parse", "HEAD")

            git(root, "switch", task["branch"])
            task["status"] = "DONE"
            task["git"] = {"committed_sha": content_sha, "merged_sha": merged_base}
            write_json(task_file, task)
            commit_all(root, "close governed task")

            successor = copy.deepcopy(task)
            successor_id = "GOV-SUCCESSOR"
            successor["task_id"] = successor_id
            successor["status"] = "DRAFT"
            successor["branch"] = "codex/req-0009-gov-successor-owned-change"
            successor["base_branch"] = task["branch"]
            successor["allowed_paths"] = ["successor/**", "project-control/**"]
            successor["validation"]["results"] = []
            successor.pop("git", None)
            successor["coordination"]["coordinator_task"] = successor_id
            successor["coordination"]["unit_tasks"] = {
                "mac": successor_id, "win": successor_id, "backend": successor_id,
            }
            successor_file = (
                root / "project-control" / "tasks" / (successor_id + ".json")
            )
            write_json(successor_file, successor)
            commit_all(root, "register successor")

            git(root, "switch", "-c", successor["branch"])
            owned = root / "successor" / "owned.py"
            owned.parent.mkdir(parents=True, exist_ok=True)
            owned.write_text("VALUE = 'reviewed successor'\n", encoding="utf-8")
            successor_subject = commit_all(root, "successor content")
            successor["status"] = "COMMITTED"
            successor["git"] = {"committed_sha": successor_subject}
            write_json(successor_file, successor)
            commit_all(root, "successor control")

            git(root, "switch", task["branch"])
            git(root, "merge", "--no-ff", successor["branch"], "-m", "merge successor")
            successor_merge = git(root, "rev-parse", "HEAD")
            successor["status"] = "DONE"
            successor["git"]["merged_sha"] = successor_merge
            write_json(successor_file, successor)
            side_head = commit_all(root, "close successor")

            git(root, "switch", "main")
            git(root, "merge", "--no-ff", task["branch"], "-m", "merge closeout stack")
            main_head = git(root, "rev-parse", "HEAD")
            git(root, "checkout", "--detach", main_head)
            environment = github_push_environment(root, merged_base, main_head, "main")
            with mock.patch.dict(os.environ, environment, clear=False):
                report = run_reconcile(root, "ci")

            self.assertTrue(report["ok"], report)
            changed = next(item for item in report["checks"] if item["id"] == "changed_paths")
            self.assertEqual([], changed["details"]["outside_scope"])
            self.assertEqual(
                ["successor/owned.py"],
                changed["details"]["successor_merges"][0]["successor_merges"][0]["paths"],
            )
            protocol = next(
                item for item in report["checks"] if item["id"] == "ci_commit_protocol"
            )
            self.assertEqual("passed", protocol["status"])
            self.assertEqual(side_head, git(root, "rev-parse", "%s^2" % main_head))

    def test_ci_rejects_event_head_that_is_not_checked_out(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task, base_sha, content_sha, control_sha = self.prepare_two_layer_commits(root)
            environment = github_push_environment(
                root, base_sha, content_sha, task["branch"]
            )
            with mock.patch.dict(os.environ, environment, clear=False):
                report = run_reconcile(root, "ci")
            self.assertFalse(report["ok"])
            event_check = next(item for item in report["checks"] if item["id"] == "ci_event")
            self.assertIn("checked-out", event_check["message"])

    def test_ci_rejects_repository_environment_drift(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task, base_sha, _content_sha, control_sha = self.prepare_two_layer_commits(root)
            environment = github_push_environment(root, base_sha, control_sha, task["branch"])
            environment["GITHUB_REPOSITORY"] = "attacker/material"
            with mock.patch.dict(os.environ, environment, clear=False):
                report = run_reconcile(root, "ci")
            event_check = next(item for item in report["checks"] if item["id"] == "ci_event")
            self.assertEqual("failed", event_check["status"])
            self.assertIn("GITHUB_REPOSITORY", event_check["message"])

    def test_ci_rejects_release_unit_on_wrong_runner(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task, base_sha, _content_sha, control_sha = self.prepare_two_layer_commits(root)
            environment = github_push_environment(root, base_sha, control_sha, task["branch"])
            environment["MATERIAL_RELEASE_UNIT"] = "win"
            with mock.patch.dict(os.environ, environment, clear=False):
                report = run_reconcile(root, "ci")
            runner = next(item for item in report["checks"] if item["id"] == "ci_release_runner")
            self.assertEqual("failed", runner["status"])
            self.assertIn("Windows", runner["message"])

    def test_ci_accepts_trusted_runner_for_unaffected_release_unit(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task, base_sha, _content_sha, control_sha = self.prepare_two_layer_commits(root)
            task["release_units"] = ["mac", "win"]
            for check in task["validation"]["required"]:
                check["release_units"] = ["mac", "win"]
            task["coordination"]["deployment_order"] = ["mac", "win"]
            task["coordination"]["rollback_order"] = ["win", "mac"]
            for field in ("unit_tasks", "unit_validation_checks", "unit_rollback_checks"):
                task["coordination"][field].pop("backend")
            task["validation"]["results"] = []
            renew_test_scope_review(root, task)
            store_controlled_local_pass(root, task)
            write_json(root / "project-control" / "tasks" / (task["task_id"] + ".json"), task)
            environment = github_push_environment(root, base_sha, control_sha, task["branch"])
            with mock.patch.dict(os.environ, environment, clear=False):
                report = run_reconcile(root, "ci")
            runner = next(item for item in report["checks"] if item["id"] == "ci_release_runner")
            self.assertEqual("passed", runner["status"])
            self.assertFalse(runner["details"]["applicable"])
            self.assertIn("not applicable", runner["message"])

    def test_ci_rejects_pr_target_not_bound_as_base_branch(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task, base_sha, content_sha, control_sha = self.prepare_two_layer_commits(root)
            environment = github_pull_request_environment(
                root, base_sha, control_sha, "develop", task["branch"]
            )
            with mock.patch.dict(os.environ, environment, clear=False):
                report = run_reconcile(root, "ci")
            self.assertFalse(report["ok"])
            event_check = next(item for item in report["checks"] if item["id"] == "ci_event")
            self.assertIn("base_branch", event_check["message"])

    def test_first_bootstrap_push_is_root_snapshot_and_stays_pending(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = prepare_static_root(root, task_status="IN_PROGRESS", task_id="GOV-0001")
            task["allowed_paths"].extend([
                "project-control/**",
                "AGENTS.md",
                "README.md",
            ])
            task_file = root / "project-control" / "tasks" / "GOV-0001.json"
            write_json(task_file, task)
            # allowed_paths is review-bound, so renew the isolated test receipt.
            initialize_root(root, task)
            project_path = root / "project-control" / "project.json"
            project = read_json(project_path)
            project.update({
                "project_id": "material",
                "source_repository": "git@github.com:wzhic/material.git",
                "maintainers": 1,
                "coding_agents": ["Codex"],
            })
            write_json(project_path, project)
            for dimension in DOC_DIMENSIONS:
                index = root / "docs" / dimension / "README.md"
                index.parent.mkdir(parents=True, exist_ok=True)
                index.write_text("# %s documents\n" % dimension, encoding="utf-8")
            write_active_requirement(root)
            workflow = root / ".github" / "workflows" / "governance.yml"
            workflow.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(str(REPOSITORY_ROOT / ".github" / "workflows" / "governance.yml"), str(workflow))
            initialize_git(root)
            head = commit_all(root, "bootstrap snapshot")
            environment = github_push_environment(
                root, "0" * len(head), head, "main", created=True
            )
            with mock.patch.dict(os.environ, environment, clear=False):
                report = run_reconcile(root, "ci")
            self.assertTrue(report["ok"], report)
            self.assertEqual("bootstrap_pending", report["context"]["ci"]["mode"])
            self.assertEqual("pending", report["context"]["ci"]["evidence_status"])
            self.assertIsNone(report["context"]["ci"]["content_subject_sha"])

    def test_exact_two_repair_chain_stays_pending_then_allows_protected_control_head(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = prepare_static_root(root, task_id="GOV-0001")
            task["allowed_paths"].extend(["project-control/**", "AGENTS.md", "README.md"])
            task["branch_exception"] = {
                "kind": "bootstrap-main",
                "applies_only_to_task": "GOV-0001",
                "reason": "isolated failed-root repair test",
            }
            renew_test_scope_review(root, task)
            store_controlled_local_pass(root, task)
            task["status"] = "LOCAL_VERIFIED"
            task_file = root / "project-control" / "tasks" / "GOV-0001.json"
            write_json(task_file, task)
            initialize_git(root)
            failed_root = commit_all(root, "failed bootstrap root")

            governed = root / "tools" / "governance" / "core.py"
            governed.parent.mkdir(parents=True, exist_ok=True)
            governed.write_text("# explicit UTF-8 Git decoding\n", encoding="utf-8")
            task = read_json(task_file)
            store_controlled_local_pass(root, task)
            repair_sha = commit_all(root, BOOTSTRAP_REPAIR_MESSAGE)
            repair_environment = github_push_environment(root, failed_root, repair_sha, "main")
            with mock.patch.object(core, "FAILED_BOOTSTRAP_ROOT_SHA", failed_root), mock.patch.dict(
                os.environ, repair_environment, clear=False
            ):
                repair_report = run_reconcile(root, "ci")
            self.assertTrue(repair_report["ok"], repair_report)
            self.assertEqual("bootstrap_repair_pending", repair_report["context"]["ci"]["mode"])
            Path(repair_environment["GITHUB_EVENT_PATH"]).unlink()

            second_governed = root / "tools" / "governance" / "reviewctl.py"
            second_governed.write_text("# portable UTF-8 output\n", encoding="utf-8")
            task = read_json(task_file)
            store_controlled_local_pass(root, task)
            second_repair_sha = commit_all(root, SECOND_BOOTSTRAP_REPAIR_MESSAGE)
            second_environment = github_push_environment(
                root, repair_sha, second_repair_sha, "main"
            )
            with mock.patch.object(core, "FAILED_BOOTSTRAP_ROOT_SHA", failed_root), mock.patch.object(
                core, "FAILED_BOOTSTRAP_REPAIR_SHA", repair_sha
            ), mock.patch.dict(os.environ, second_environment, clear=False):
                second_report = run_reconcile(root, "ci")
            self.assertTrue(second_report["ok"], second_report)
            self.assertEqual(
                "bootstrap_repair_pending", second_report["context"]["ci"]["mode"]
            )
            self.assertEqual(
                "GOV-0001-R009", second_report["context"]["ci"]["rework_review_id"]
            )
            Path(second_environment["GITHUB_EVENT_PATH"]).unlink()

            task = read_json(task_file)
            task["status"] = "COMMITTED"
            task["git"] = {"committed_sha": second_repair_sha}
            write_json(task_file, task)
            control_sha = commit_all(root, "protected control state")
            control_environment = github_push_environment(
                root, second_repair_sha, control_sha, "main"
            )
            with mock.patch.object(core, "FAILED_BOOTSTRAP_ROOT_SHA", failed_root), mock.patch.object(
                core, "FAILED_BOOTSTRAP_REPAIR_SHA", repair_sha
            ), mock.patch.dict(os.environ, control_environment, clear=False):
                control_report = run_reconcile(root, "ci")
            self.assertTrue(control_report["ok"], control_report)
            context = control_report["context"]["ci"]
            self.assertEqual("bootstrap_control_head", context["mode"])
            self.assertEqual("failed_root_repair", context["bootstrap_content_mode"])


class GovernanceConsistencyTests(unittest.TestCase):
    def test_done_shortcut_claims_only_local_validation_gate(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = prepare_static_root(root, task_status="IN_PROGRESS")
            store_controlled_local_pass(root, task)
            task["status"] = "DONE"
            task["git"] = {
                "committed_sha": "a" * 40,
                "merged_sha": "b" * 40,
            }
            write_json(
                root / "project-control" / "tasks" / (task["task_id"] + ".json"),
                task,
            )

            report = run_reconcile(root, "session", git_branch="main", git_changes=[])

            self.assertTrue(report["ok"], report)
            attained = next(
                item for item in report["checks"]
                if item["id"] == "attained_validation_gates"
            )
            self.assertEqual(
                ["LOCAL_VERIFIED"],
                list(attained["details"]["gates"]),
            )

    def test_done_task_still_enforces_persisted_ci_gate_claim(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = prepare_static_root(root, task_status="IN_PROGRESS")
            store_controlled_local_pass(root, task)
            task["status"] = "DONE"
            task["git"] = {
                "committed_sha": "a" * 40,
                "ci_verified_sha": "a" * 40,
                "merged_sha": "b" * 40,
            }
            write_json(
                root / "project-control" / "tasks" / (task["task_id"] + ".json"),
                task,
            )

            report = run_reconcile(root, "session", git_branch="main", git_changes=[])

            self.assertFalse(report["ok"])
            attained = next(
                item for item in report["checks"]
                if item["id"] == "attained_validation_gates"
            )
            self.assertEqual(
                ["LOCAL_VERIFIED", "CI_VERIFIED"],
                list(attained["details"]["gates"]),
            )
            self.assertTrue(
                attained["details"]["gates"]["CI_VERIFIED"]["missing"]
            )

    def test_project_cannot_extend_bootstrap_main_authority(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = prepare_static_root(root)
            project_path = root / "project-control" / "project.json"
            project = read_json(project_path)
            project["branch_policy"]["bootstrap_main_tasks"] = ["GOV-0001", "GOV-EVIL"]
            write_json(project_path, project)
            report = run_reconcile(root, "session", git_branch=task["branch"], git_changes=[])
            failed = {item["id"] for item in report["checks"] if item["status"] == "failed"}
            self.assertIn("project", failed)
            self.assertIn("branch", failed)
            self.assertIn("branch_schema", failed)

    def test_branch_pattern_requires_requirement_task_and_readable_slug(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = prepare_static_root(root)
            task["branch"] = "codex/unrelated"
            write_json(root / "project-control" / "tasks" / (task["task_id"] + ".json"), task)
            report = run_reconcile(root, "session", git_branch=task["branch"], git_changes=[])
            branch_schema = next(item for item in report["checks"] if item["id"] == "branch_schema")
            self.assertEqual("failed", branch_schema["status"])

    def test_ready_task_requires_existing_done_dependencies(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = prepare_static_root(root, task_status="READY")
            task["dependencies"] = ["GOV-MISSING"]
            write_json(root / "project-control" / "tasks" / (task["task_id"] + ".json"), task)
            report = run_reconcile(root, "session", git_branch=task["branch"], git_changes=[])
            dependency = next(item for item in report["checks"] if item["id"] == "dependencies")
            self.assertEqual("failed", dependency["status"])
            self.assertIn("GOV-MISSING", dependency["message"])

    def test_unknown_release_unit_and_multiple_active_tasks_fail(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = prepare_static_root(root)
            task["release_units"] = ["mac", "unknown"]
            task["validation"]["required"][0]["release_units"] = ["mac", "unknown"]
            task["coordination"]["unit_tasks"] = {
                "mac": task["task_id"], "unknown": task["task_id"],
            }
            task["coordination"]["deployment_order"] = ["unknown", "mac"]
            task["coordination"]["rollback_order"] = ["mac", "unknown"]
            task["coordination"]["unit_validation_checks"] = {
                "mac": ["unit"], "unknown": ["unit"],
            }
            task["coordination"]["unit_rollback_checks"] = {
                "mac": ["unit"], "unknown": ["unit"],
            }
            write_json(root / "project-control" / "tasks" / (task["task_id"] + ".json"), task)
            second = base_task(status="READY")
            second["task_id"] = "GOV-SECOND"
            second["branch"] = "codex/req-test-gov-second-second-task"
            second["coordination"]["coordinator_task"] = "GOV-SECOND"
            second["coordination"]["unit_tasks"] = {
                "mac": "GOV-SECOND", "win": "GOV-SECOND", "backend": "GOV-SECOND",
            }
            write_json(root / "project-control" / "tasks" / "GOV-SECOND.json", second)
            report = run_reconcile(root, "session", git_branch=task["branch"], git_changes=[])
            failed = {item["id"] for item in report["checks"] if item["status"] == "failed"}
            self.assertIn("release_units", failed)
            self.assertIn("active_task", failed)

    def test_noncurrent_committed_task_waiting_for_ci_is_not_active_work(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = prepare_static_root(root)
            waiting = base_task(status="COMMITTED")
            waiting["task_id"] = "GOV-WAITING"
            waiting["branch"] = "codex/req-waiting-gov-waiting-ci"
            waiting["coordination"]["coordinator_task"] = "GOV-WAITING"
            waiting["coordination"]["unit_tasks"] = {
                "mac": "GOV-WAITING", "win": "GOV-WAITING", "backend": "GOV-WAITING",
            }
            waiting["git"] = {"committed_sha": "a" * 40}
            write_json(root / "project-control" / "tasks" / "GOV-WAITING.json", waiting)

            report = run_reconcile(root, "session", git_branch=task["branch"], git_changes=[])
            active = next(item for item in report["checks"] if item["id"] == "active_task")
            self.assertEqual("passed", active["status"], active)
            self.assertEqual(
                [{"task_id": task["task_id"], "status": task["status"]}],
                active["details"]["active"],
            )

    def test_noncurrent_blocked_task_is_frozen_not_active_work(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = prepare_static_root(root)
            blocked = base_task(status="BLOCKED")
            blocked["task_id"] = "GOV-BLOCKED"
            blocked["branch"] = "codex/req-blocked-gov-blocked-waiting"
            blocked["coordination"]["coordinator_task"] = "GOV-BLOCKED"
            blocked["coordination"]["unit_tasks"] = {
                "mac": "GOV-BLOCKED", "win": "GOV-BLOCKED", "backend": "GOV-BLOCKED",
            }
            blocked["exception"] = {
                "previous_status": "IN_PROGRESS",
                "reason": "frozen while another task resolves the blocker",
                "recorded_at": "2026-08-21T00:00:00+00:00",
            }
            write_json(root / "project-control" / "tasks" / "GOV-BLOCKED.json", blocked)

            report = run_reconcile(root, "session", git_branch=task["branch"], git_changes=[])
            active = next(item for item in report["checks"] if item["id"] == "active_task")
            self.assertEqual("passed", active["status"], active)
            self.assertEqual(
                [{"task_id": task["task_id"], "status": task["status"]}],
                active["details"]["active"],
            )


if __name__ == "__main__":
    unittest.main()
