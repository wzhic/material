#!/usr/bin/env python3
"""Read-only reconciliation of files, task phase, approval and Git state."""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import sys
import urllib.parse
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, Set, Tuple

from core import (
    BOOTSTRAP_TASK_ID,
    FAILED_BOOTSTRAP_ROOT_SHA,
    GITHUB_REPOSITORY,
    GITHUB_WORKFLOW_PATH,
    GovernanceError,
    NORMAL_STATES,
    PROJECT_ID,
    SOURCE_REPOSITORY,
    branch_validity,
    bootstrap_repair_commit_issues,
    canonical_scope_hash,
    ci_trust_issues,
    command_is_allowed,
    conversation_approval_policy_issues,
    coordination_issues,
    control_dir,
    default_root,
    find_effective_review,
    find_effective_code_review,
    json_result,
    legacy_g0_v1_migration,
    load_current_task,
    load_task,
    path_is_allowed,
    read_json,
    review_authority_issues,
    run_git,
    status_index,
    tool_is_allowed,
    validation_gate_status,
    validation_plan_issues,
    validation_result_provenance_issues,
)


PROFILES = ("session", "pretool", "docs", "workflow", "static", "precommit", "ci")
READ_ONLY_TOOLS = frozenset(("read", "grep", "glob", "ls", "web", "websearch", "webfetch"))
MUTATING_FILE_TOOLS = frozenset(("write", "edit", "multiedit", "applypatch", "notebookedit"))
SHELL_CONTROL_TOKENS = (";", "&&", "||", "\n", "`", "$(", ">", "<", "|")
ZERO_SHA_LENGTHS = frozenset((40, 64))
PROTECTED_CONTROL_PATTERNS = (
    "project-control/tasks/**",
    "project-control/reviews/**",
    "project-control/current-task.json",
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
SECTION_PREFIXES = (
    "文档信息",
    "一句话摘要",
    "背景与现状证据",
    "使用者与使用场景",
    "目标与成功指标",
    "非目标",
    "范围",
    "前置与后置依赖",
    "假设和未决事项",
    "功能明细",
    "用户流程与交互",
    "非 UI 流程图",
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
PLACEHOLDER_PATTERNS = (
    re.compile(r"(?i)(?<![A-Za-z0-9_])(?:TODO|TBD|FIXME|XXX|PLACEHOLDER)(?![A-Za-z0-9_])"),
    re.compile(r"待填|请填写|待补(?:充)?|\?\?\?|\{\{[^}\n]+\}\}"),
)
COMMIT_RE = re.compile(r"^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$")
RELEASE_RUNNERS = {"backend": "Linux", "mac": "macOS", "win": "Windows"}
STALE_APPROVAL_MIGRATION_PATTERNS = (
    re.compile(r"scope v2[^\n]{0,100}(?:仍待|待迁移|待用户)"),
    re.compile(r"(?:用户|当前)[^\n]{0,40}(?:尚未|未提供)[^\n]{0,40}(?:公钥|签名密钥)"),
    re.compile(r"当前[^\n]{0,80}scope v1"),
    re.compile(r"(?:所有|任何)新[^\n]{0,40}回执[^\n]{0,40}(?:必须|都由)[^\n]{0,40}(?:OpenSSH|私钥|签名)"),
    re.compile(r"当前任务仍使用[^\n]*R001"),
    re.compile(r"scope v1[^\n]{0,100}不能记录新 PASS"),
)


def _normalized_tool(value: str) -> str:
    return value.strip().lower().replace("_", "").replace("-", "")


def _check(check_id: str, ok: bool, message: str, details: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
    result: Dict[str, Any] = {
        "id": check_id,
        "status": "passed" if ok else "failed",
        "message": message,
    }
    if details:
        result["details"] = dict(details)
    return result


def changed_paths(root: Path) -> Tuple[Set[str], Optional[str]]:
    paths: Set[str] = set()
    commands = (
        ("diff", "--name-only"),
        ("diff", "--cached", "--name-only"),
        ("ls-files", "--others", "--exclude-standard"),
    )
    errors: List[str] = []
    for command in commands:
        output, error = run_git(root, command)
        if error:
            errors.append("git %s: %s" % (" ".join(command), error))
            continue
        paths.update(line for line in (output or "").splitlines() if line)
    return paths, "; ".join(errors) if errors else None


def _validate_project(project: Mapping[str, Any]) -> List[str]:
    issues: List[str] = []
    if project.get("scale") != "M":
        issues.append("project scale must be M")
    if project.get("topology") != "multi":
        issues.append("project topology must be multi")
    units = project.get("release_units", [])
    unit_ids = {item.get("id") for item in units if isinstance(item, dict)}
    if unit_ids != {"mac", "win", "backend"}:
        issues.append("release units must be exactly mac, win and backend")
    issues.extend(conversation_approval_policy_issues(project))
    if project.get("branch_policy", {}).get("bootstrap_main_tasks") != [BOOTSTRAP_TASK_ID]:
        issues.append("bootstrap_main_tasks must be exactly [%s]" % BOOTSTRAP_TASK_ID)
    return issues


def _fixed_project_contract_check(project: Mapping[str, Any]) -> Dict[str, Any]:
    expected = {
        "project_id": PROJECT_ID,
        "source_repository": SOURCE_REPOSITORY,
        "maintainers": 1,
        "coding_agents": ["Codex"],
    }
    mismatches = [
        "%s must equal %r" % (field, value)
        for field, value in expected.items()
        if project.get(field) != value
    ]
    return _check(
        "fixed_project_contract",
        not mismatches,
        "project and source repository match the fixed governance identity"
        if not mismatches else "; ".join(mismatches),
        {"expected": expected},
    )


def _reviewed_task_contract_checks(
    task: Mapping[str, Any],
    migration_pending: bool,
) -> List[Dict[str, Any]]:
    if migration_pending:
        message = "legacy GOV-0001 scope v1 contract migration is pending"
        return [
            _check("review_authority", True, message, {"migration_pending": True}),
            _check("ci_trust", True, message, {"migration_pending": True}),
            _check("coordination", True, message, {"migration_pending": True}),
            _check("validation_provenance", True, message, {"migration_pending": True}),
        ]

    authority_errors = review_authority_issues(task)
    trust_errors = ci_trust_issues(task)
    coordination_errors = coordination_issues(task)
    provenance_errors: List[str] = []
    for index, result in enumerate(task.get("validation", {}).get("results", [])):
        if not isinstance(result, Mapping):
            provenance_errors.append("result %s is not an object" % index)
            continue
        issues = validation_result_provenance_issues(task, result)
        provenance_errors.extend(
            "%s[%s]: %s" % (result.get("check_id", index), result.get("phase", "unknown"), issue)
            for issue in issues
        )
    return [
        _check(
            "review_authority", not authority_errors,
            "historical OpenSSH migration authority remains verifiable"
            if not authority_errors else "; ".join(authority_errors),
        ),
        _check(
            "ci_trust", not trust_errors,
            "reviewed CI trust matches the fixed private GitHub Actions anchor"
            if not trust_errors else "; ".join(trust_errors),
        ),
        _check(
            "coordination", not coordination_errors,
            "multi-release coordination is complete and internally consistent"
            if not coordination_errors else "; ".join(coordination_errors),
        ),
        _check(
            "validation_provenance", not provenance_errors,
            "all persisted PASS results have trusted producer provenance"
            if not provenance_errors else "; ".join(provenance_errors),
        ),
    ]


def _required_docs(root: Path, task: Mapping[str, Any]) -> Tuple[List[str], List[str]]:
    missing: List[str] = []
    matched: List[str] = []
    for required in task.get("required_docs", []):
        pattern = str(required)
        pattern_path = Path(pattern)
        if pattern_path.is_absolute() or ".." in pattern_path.parts:
            missing.append("%s (path escapes repository)" % pattern)
            continue
        if any(character in pattern for character in "*?["):
            hits: List[Path] = []
            for path in root.glob(pattern):
                try:
                    path.resolve().relative_to(root.resolve())
                except ValueError:
                    continue
                if path.is_file() and path.stat().st_size > 0:
                    hits.append(path)
            if hits:
                matched.extend(path.relative_to(root).as_posix() for path in hits)
            else:
                missing.append(pattern)
        else:
            path = (root / pattern).resolve()
            try:
                path.relative_to(root.resolve())
            except ValueError:
                missing.append("%s (path escapes repository)" % pattern)
                continue
            if path.is_file() and path.stat().st_size > 0:
                matched.append(pattern)
            else:
                missing.append(pattern)
    return missing, matched


def _effective_status_index(task: Mapping[str, Any]) -> int:
    index = status_index(str(task.get("status", "")))
    if index >= 0:
        return index
    exception = task.get("exception", {}) if isinstance(task.get("exception"), dict) else {}
    previous = exception.get("previous_status", task.get("blocked_from", ""))
    return status_index(str(previous))


def _release_registry_check(root: Path, project: Mapping[str, Any], task: Mapping[str, Any]) -> Dict[str, Any]:
    registry_path = control_dir(root) / "releases" / "release-units.json"
    try:
        registry = read_json(registry_path)
    except GovernanceError as exc:
        return _check("release_units", False, str(exc))
    project_units = {
        str(item.get("id")) for item in project.get("release_units", [])
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }
    registry_units = {
        str(item.get("id")) for item in registry.get("units", [])
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }
    task_units = set(str(item) for item in task.get("release_units", []))
    unknown_project = sorted(task_units - project_units)
    unknown_registry = sorted(task_units - registry_units)
    ok = not unknown_project and not unknown_registry and project_units == registry_units
    if ok:
        message = "task release units are present in the project and release registry"
    else:
        parts: List[str] = []
        if unknown_project:
            parts.append("not in project: %s" % ", ".join(unknown_project))
        if unknown_registry:
            parts.append("not in release registry: %s" % ", ".join(unknown_registry))
        if project_units != registry_units:
            parts.append("project and release registry differ")
        message = "; ".join(parts)
    return _check(
        "release_units", ok, message,
        {
            "task": sorted(task_units),
            "project": sorted(project_units),
            "registry": sorted(registry_units),
        },
    )


def _dependency_check(root: Path, task: Mapping[str, Any]) -> Dict[str, Any]:
    dependencies: List[Dict[str, str]] = []
    errors: List[str] = []
    require_done = _effective_status_index(task) >= status_index("READY")
    for dependency_id in task.get("dependencies", []):
        try:
            dependency = load_task(root, str(dependency_id))
        except GovernanceError as exc:
            errors.append("%s: %s" % (dependency_id, exc))
            continue
        dependencies.append({"task_id": str(dependency_id), "status": str(dependency.get("status"))})
        if require_done and dependency.get("status") != "DONE":
            errors.append("%s is %s, not DONE" % (dependency_id, dependency.get("status")))
    return _check(
        "dependencies",
        not errors,
        "all dependencies exist%s" % (" and are DONE" if require_done else "")
        if not errors else "; ".join(errors),
        {"require_done": require_done, "dependencies": dependencies},
    )


def _active_task_check(root: Path, current_task: Mapping[str, Any]) -> Dict[str, Any]:
    tasks_directory = control_dir(root) / "tasks"
    active: List[Dict[str, str]] = []
    errors: List[str] = []
    for path in sorted(tasks_directory.glob("*.json")):
        try:
            task = load_task(root, path.stem)
        except GovernanceError as exc:
            errors.append("%s: %s" % (path.name, exc))
            continue
        status = str(task.get("status"))
        effective_index = _effective_status_index(task)
        if (
            status not in ("DONE", "CANCELLED", "REJECTED")
            and effective_index >= status_index("READY")
        ):
            active.append({"task_id": str(task.get("task_id")), "status": status})
    current_id = str(current_task.get("task_id"))
    if len(active) > 1:
        errors.append("multiple active tasks: %s" % ", ".join(item["task_id"] for item in active))
    elif active and active[0]["task_id"] != current_id:
        errors.append("active task %s is not current task %s" % (active[0]["task_id"], current_id))
    return _check(
        "active_task",
        not errors,
        "current and active task selection is unambiguous" if not errors else "; ".join(errors),
        {"current": current_id, "active": active},
    )


def _branch_schema_check(project: Mapping[str, Any], task: Mapping[str, Any]) -> Dict[str, Any]:
    policy = project.get("branch_policy", {}) if isinstance(project.get("branch_policy"), dict) else {}
    bootstrap_tasks = policy.get("bootstrap_main_tasks", [])
    task_id = str(task.get("task_id", ""))
    branch = str(task.get("branch", ""))
    base_branch = task.get("base_branch")
    bootstrap = task_id == BOOTSTRAP_TASK_ID and bootstrap_tasks == [BOOTSTRAP_TASK_ID]
    errors: List[str] = []
    if bootstrap_tasks != [BOOTSTRAP_TASK_ID]:
        errors.append("bootstrap_main_tasks must be exactly [%s]" % BOOTSTRAP_TASK_ID)
    if bootstrap:
        if branch != "main":
            errors.append("bootstrap task must use main")
    elif policy.get("default_pattern"):
        if not isinstance(base_branch, str) or not base_branch.strip():
            errors.append("non-bootstrap task requires a reviewed base_branch")
        elif branch == base_branch:
            errors.append("feature branch must differ from base_branch")
        requirement_id = str(task.get("requirement", {}).get("id", ""))
        requirement_match = re.search(r"REQ-[A-Z0-9]+(?:-[A-Z0-9]+)*", requirement_id, re.IGNORECASE)
        requirement_token = requirement_match.group(0).lower() if requirement_match else ""
        task_token = task_id.lower()
        expected_prefix = "codex/%s-%s-" % (requirement_token, task_token)
        slug = branch[len(expected_prefix):] if branch.startswith(expected_prefix) else ""
        if not requirement_token or not branch.startswith(expected_prefix):
            errors.append("branch must start with %s and contain requirement/task ids" % expected_prefix)
        elif not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", slug) or not re.search(r"[a-z]", slug):
            errors.append("branch requires a non-empty readable lowercase slug")
    elif branch == "main":
        errors.append("only a listed bootstrap task may use main")
    return _check(
        "branch_schema",
        not errors,
        "branch naming follows project policy" if not errors else "; ".join(errors),
        {"branch": branch, "base_branch": base_branch, "bootstrap": bootstrap},
    )


def _markdown_sections(text: str) -> Tuple[List[Tuple[int, str, str]], List[str]]:
    matches = list(re.finditer(r"(?m)^##\s+(\d+)\.\s+(.+?)\s*$", text))
    sections: List[Tuple[int, str, str]] = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        sections.append((int(match.group(1)), match.group(2).strip(), text[match.end():end]))
    problems: List[str] = []
    numbers = [item[0] for item in sections]
    if numbers != list(range(1, 25)):
        problems.append("numbered H2 sections must be exactly 1..24 in order")
    for number, title, body in sections:
        if 1 <= number <= len(SECTION_PREFIXES) and not title.startswith(SECTION_PREFIXES[number - 1]):
            problems.append("section %s title must start with %s" % (number, SECTION_PREFIXES[number - 1]))
        without_comments = re.sub(r"<!--.*?-->", "", body, flags=re.DOTALL)
        without_headings = re.sub(r"(?m)^#{3,6}\s+.*$", "", without_comments).strip()
        if not without_headings:
            problems.append("section %s has no substantive content" % number)
    return sections, problems


def _without_fenced_code(text: str) -> str:
    without_fences = re.sub(r"(?ms)^\s*(```|~~~).*?^\s*\1\s*$", "", text)
    return re.sub(r"`[^`\n]*`", "", without_fences)


def _mermaid_blocks(text: str) -> List[str]:
    return [
        match.group(2).strip()
        for match in re.finditer(r"(?ms)^\s*(```|~~~)mermaid\s*\n(.*?)^\s*\1\s*$", text)
        if match.group(2).strip()
    ]


def _document_checks(
    root: Path,
    task: Mapping[str, Any],
    include_dimensions: bool = True,
) -> List[Dict[str, Any]]:
    checks: List[Dict[str, Any]] = []
    if include_dimensions:
        missing_dimensions: List[str] = []
        for dimension in DOC_DIMENSIONS:
            index = root / "docs" / dimension / "README.md"
            try:
                present = index.is_file() and bool(index.read_text(encoding="utf-8").strip())
            except (OSError, UnicodeError):
                present = False
            if not present:
                missing_dimensions.append(index.relative_to(root).as_posix())
        checks.append(_check(
            "doc_dimensions", not missing_dimensions,
            "all seven document dimensions have non-empty indexes" if not missing_dimensions
            else "missing or empty document indexes: %s" % ", ".join(missing_dimensions),
            {"missing": missing_dimensions},
        ))

    requirement = task.get("requirement", {})
    requirement_id = str(requirement.get("id", ""))
    version = str(requirement.get("version", ""))
    naming_ok = bool(
        re.fullmatch(r"[^/\\]+-REQ-\d{4}", requirement_id)
        and re.fullmatch(r"v\d+\.\d+(?:\.\d+)?", version)
    )
    relative = Path("docs") / "requirements" / requirement_id / (requirement_id + "-" + version + ".md")
    document = (root / relative).resolve()
    try:
        document.relative_to(root.resolve())
    except ValueError:
        naming_ok = False
    text = ""
    if naming_ok and document.is_file():
        try:
            text = document.read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            text = ""
    first_h1 = re.search(r"(?m)^#\s+(.+?)\s*$", text)
    binding_ok = naming_ok and bool(text.strip()) and bool(first_h1) and first_h1.group(1).strip() == document.stem
    checks.append(_check(
        "requirement_binding", binding_ok,
        "active requirement path, versioned name and H1 are bound to the task" if binding_ok
        else "active requirement must be a non-empty docs/requirements/<id>/<id>-<version>.md with a matching H1",
        {"path": relative.as_posix(), "requirement_id": requirement_id, "version": version},
    ))
    if not text:
        for check_id in ("requirement_sections", "requirement_placeholders", "assumptions_register", "requirement_flow"):
            checks.append(_check(check_id, False, "active requirement cannot be checked until requirement_binding passes"))
        return checks

    sections, section_problems = _markdown_sections(text)
    checks.append(_check(
        "requirement_sections", not section_problems,
        "active requirement has 24 ordered, named, non-empty sections" if not section_problems
        else "; ".join(section_problems),
        {"count": len(sections), "problems": section_problems},
    ))
    placeholder_hits: List[str] = []
    placeholder_text = _without_fenced_code(text)
    for pattern in PLACEHOLDER_PATTERNS:
        placeholder_hits.extend(match.group(0) for match in pattern.finditer(placeholder_text))
    checks.append(_check(
        "requirement_placeholders", not placeholder_hits,
        "active requirement has no unresolved authoring placeholders" if not placeholder_hits
        else "active requirement contains authoring placeholders: %s" % ", ".join(sorted(set(placeholder_hits))),
        {"matches": sorted(set(placeholder_hits))},
    ))

    section_map = {number: body for number, _title, body in sections}
    assumptions_text = _without_fenced_code(section_map.get(9, ""))
    assumptions_ok = "\u5047\u8bbe" in assumptions_text and "\u672a\u51b3" in assumptions_text and bool(
        re.search(r"(?m)^\s*(?:[-*+]\s+|\|.+\|)", assumptions_text)
    )
    checks.append(_check(
        "assumptions_register", assumptions_ok,
        "section 9 contains or links structured assumptions and open questions" if assumptions_ok
        else "section 9 must contain or link a structured assumptions and open-questions register",
    ))

    interaction_kind = requirement.get("interaction_kind")
    flow_errors: List[str] = []
    if interaction_kind not in ("ui", "non_ui", "mixed"):
        flow_errors.append("requirement.interaction_kind must be ui, non_ui or mixed")
    if interaction_kind in ("ui", "mixed"):
        ui_body = section_map.get(11, "")
        ui_blocks = _mermaid_blocks(ui_body)
        if not any(re.match(r"^(?:flowchart|graph)\b", block) for block in ui_blocks):
            flow_errors.append("section 11 requires a Mermaid user flowchart")
        ui_prose = _without_fenced_code(ui_body)
        keyword_groups = (
            ("\u5165\u53e3",), ("\u4e3b\u6d41\u7a0b", "\u4e3b\u8981\u6d41\u7a0b"), ("\u8fd4\u56de",), ("\u53d6\u6d88",),
            ("\u7a7a\u72b6\u6001",), ("\u52a0\u8f7d",), ("\u6210\u529f",), ("\u5931\u8d25",), ("\u6743\u9650",),
            ("\u79bb\u7ebf", "\u8d85\u65f6"), ("\u6062\u590d", "\u91cd\u8bd5"), ("\u65e0\u969c\u788d",),
        )
        missing_keywords = ["/".join(group) for group in keyword_groups if not any(word in ui_prose for word in group)]
        if missing_keywords:
            flow_errors.append("section 11 interaction prose misses: %s" % ", ".join(missing_keywords))
    if interaction_kind in ("non_ui", "mixed"):
        non_ui_body = section_map.get(12, "")
        non_ui_blocks = _mermaid_blocks(non_ui_body)
        allowed_diagram = re.compile(r"^(?:stateDiagram(?:-v2)?|sequenceDiagram|flowchart|graph)\b")
        if not any(allowed_diagram.match(block) for block in non_ui_blocks):
            flow_errors.append("section 12 requires a Mermaid state, sequence or data-flow diagram")
        prose = _without_fenced_code(non_ui_body)
        for label, alternatives in (
            ("failure", ("\u5931\u8d25", "\u5f02\u5e38", "\u963b\u65ad")),
            ("boundary", ("\u8fb9\u754c", "\u8303\u56f4", "\u72b6\u6001")),
            ("recovery", ("\u6062\u590d", "\u91cd\u8bd5", "\u8fd4\u5de5")),
        ):
            if not any(word in prose for word in alternatives):
                flow_errors.append("section 12 prose must describe %s handling" % label)
    checks.append(_check(
        "requirement_flow", not flow_errors,
        "interaction-kind diagrams and narrative details are complete" if not flow_errors
        else "; ".join(flow_errors),
        {"interaction_kind": interaction_kind, "problems": flow_errors},
    ))
    return checks


def _requirement_template_check(root: Path) -> Dict[str, Any]:
    relative = Path("docs/requirements/需求文档模板-REQ-TEMPLATE-0001-v1.0.md")
    path = root / relative
    problems: List[str] = []
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        return _check("requirement_template", False, "cannot read requirement template: %s" % exc)
    h1 = re.search(r"(?m)^#\s+(.+?)\s*$", text)
    if h1 is None or h1.group(1).strip() != path.stem:
        problems.append("template H1 must match its filename")
    sections, section_problems = _markdown_sections(text)
    problems.extend(section_problems)
    return _check(
        "requirement_template", not problems,
        "requirement template has 24 ordered sections with non-empty guidance"
        if not problems else "; ".join(problems),
        {
            "path": relative.as_posix(),
            "count": len(sections),
            "placeholders_allowed": True,
            "problems": problems,
        },
    )


def _approval_migration_docs_check(
    root: Path,
    project: Mapping[str, Any],
    task: Mapping[str, Any],
) -> Dict[str, Any]:
    """Reject documents that still describe a pre-R003 active approval state."""

    policy = project.get("review_policy", {})
    if not isinstance(policy, Mapping) or policy.get("approval_mode") != "conversation-v1":
        return _check(
            "approval_migration_docs",
            False,
            "documentation approval migration check requires conversation-v1 project policy",
        )
    files = [root / "README.md", root / "AGENTS.md"]
    docs_root = root / "docs"
    if docs_root.is_dir():
        files.extend(sorted(docs_root.rglob("*.md")))
    stale: List[str] = []
    combined: List[str] = []
    for path in files:
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            continue
        combined.append(text)
        relative = path.relative_to(root).as_posix()
        for line_number, line in enumerate(text.splitlines(), start=1):
            if any(pattern.search(line) for pattern in STALE_APPROVAL_MIGRATION_PATTERNS):
                stale.append("%s:%s" % (relative, line_number))
    corpus = "\n".join(combined)
    missing_anchors = [
        anchor
        for anchor in ("conversation-v1", "GOV-0001-R003", "record-conversation", "不是密码学")
        if anchor not in corpus
    ]
    scope_ok = isinstance(task.get("scope_version"), int) and task.get("scope_version", 0) >= 3
    ok = scope_ok and not stale and not missing_anchors
    details = {
        "scope_version": task.get("scope_version"),
        "stale_locations": stale,
        "missing_anchors": missing_anchors,
    }
    if ok:
        message = "documents consistently describe R003 and conversation-v1 as the active approval model"
    else:
        problems: List[str] = []
        if not scope_ok:
            problems.append("active task scope_version is below 3")
        if stale:
            problems.append("stale pre-R003 statements: %s" % ", ".join(stale))
        if missing_anchors:
            problems.append("missing active-model anchors: %s" % ", ".join(missing_anchors))
        message = "; ".join(problems)
    return _check("approval_migration_docs", ok, message, details)


def _governed_requirement_documents_check(root: Path) -> Dict[str, Any]:
    problems: List[str] = []
    inspected: List[Dict[str, str]] = []
    tasks_directory = control_dir(root) / "tasks"
    for task_file in sorted(tasks_directory.glob("*.json")):
        try:
            task = load_task(root, task_file.stem)
        except GovernanceError as exc:
            problems.append("%s: %s" % (task_file.name, exc))
            continue
        status = str(task.get("status", ""))
        if status in ("DONE", "CANCELLED", "REJECTED"):
            continue
        if _effective_status_index(task) < status_index("REVIEW_PENDING"):
            continue
        inspected.append({"task_id": str(task["task_id"]), "status": status})
        for item in _document_checks(root, task, include_dimensions=False):
            if item["status"] == "failed":
                problems.append("%s:%s: %s" % (task["task_id"], item["id"], item["message"]))
    return _check(
        "governed_requirements", not problems,
        "all review-pending and active tasks have versioned, complete requirement documents"
        if not problems else "; ".join(problems),
        {"tasks": inspected, "problems": problems},
    )


def _markdown_link_destination(raw: str) -> str:
    candidate = raw.strip()
    if candidate.startswith("<") and ">" in candidate:
        return candidate[1:candidate.index(">")]
    return candidate.split(None, 1)[0] if candidate else ""


def _local_markdown_links_check(root: Path) -> Dict[str, Any]:
    problems: List[str] = []
    inspected = 0
    root = root.resolve()
    for source in sorted(root.rglob("*.md")):
        try:
            relative_source = source.resolve().relative_to(root).as_posix()
        except ValueError:
            continue
        if any(part in (".git", "node_modules", ".venv", "venv") for part in source.parts):
            continue
        try:
            text = _without_fenced_code(source.read_text(encoding="utf-8"))
        except (OSError, UnicodeError) as exc:
            problems.append("%s: cannot read (%s)" % (relative_source, exc))
            continue
        inspected += 1
        for match in re.finditer(r"!?\[[^\]\n]*\]\(([^)\n]+)\)", text):
            destination = _markdown_link_destination(match.group(1))
            if not destination or destination.startswith("#") or destination.startswith("//"):
                continue
            parsed = urllib.parse.urlsplit(destination)
            if parsed.scheme or parsed.netloc:
                continue
            decoded_path = urllib.parse.unquote(parsed.path)
            if not decoded_path:
                continue
            candidate = (root / decoded_path.lstrip("/")) if decoded_path.startswith("/") else (source.parent / decoded_path)
            resolved = candidate.resolve()
            try:
                resolved.relative_to(root)
            except ValueError:
                problems.append("%s -> %s escapes repository" % (relative_source, destination))
                continue
            if not resolved.exists():
                problems.append("%s -> %s does not exist" % (relative_source, destination))
    return _check(
        "local_markdown_links", not problems,
        "all repository-relative Markdown links resolve inside the repository"
        if not problems else "; ".join(problems),
        {"documents": inspected, "problems": problems},
    )


def _workflow_check(root: Path) -> Dict[str, Any]:
    path = root / ".github" / "workflows" / "governance.yml"
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        return _check("workflow_contract", False, "cannot read governance workflow: %s" % exc)
    requirements = {
        "push trigger": bool(re.search(r"(?m)^\s{2}push:\s*$", text)),
        "push limited to main": bool(
            re.search(r"(?ms)^\s{2}push:\s*\n\s{4}branches:\s*\n\s{6}-\s+main\s*$", text)
        ),
        "pull_request trigger": bool(re.search(r"(?m)^\s{2}pull_request:\s*$", text)),
        "superseded runs cancel": (
            "group: governance-${{ github.workflow }}-${{ github.ref }}" in text
            and "cancel-in-progress: true" in text
        ),
        "minimum permissions contents: read": bool(re.search(r"(?ms)^permissions:\s*\n\s+contents:\s*read\s*$", text)),
        "fetch-depth: 0": "fetch-depth: 0" in text,
        "persist-credentials: false": "persist-credentials: false" in text,
        "trusted PR head checkout": "github.event.pull_request.head.sha" in text and "github.sha" in text,
        "fixed repository guard": "github.repository == 'wzhic/material'" in text,
        "Python 3.9": bool(re.search(r"python-version:\s*[\"']?3\.9[\"']?", text)),
        "backend Linux release runner": "os: ubuntu-latest" in text and "release_unit: backend" in text,
        "mac macOS release runner": "os: macos-latest" in text and "release_unit: mac" in text,
        "win Windows release runner": "os: windows-latest" in text and "release_unit: win" in text,
        "release unit runtime binding": "MATERIAL_RELEASE_UNIT: ${{ matrix.release_unit }}" in text,
        "exact reviewed branch attachment": (
            "git', 'checkout', '-B'" in text and "GITHUB_SHA" in text
            and "task['base_branch'] if phase == 'post_merge' else task['branch']" in text
        ),
        "lifecycle-derived validation phase": (
            "task['status'] == 'MERGED'" in text
            and "phase = 'post_merge'" in text
            and "else 'ci'" in text
        ),
        "controlled required validation": (
            "taskctl.py" in text and "run-required" in text and "--phase', phase" in text
            and "--release-unit', '${{ matrix.release_unit }}'" in text
        ),
        "explicit bootstrap first-push PENDING path": (
            "--bootstrap-first-push" in text
        ),
        "governance tests reject zero cases": (
            "discover('tools/governance/tests'" in text and "countTestCases()" in text
            and "No governance tests discovered" in text
        ),
        "hook tests reject zero cases": (
            "discover('.codex/tests'" in text and "countTestCases()" in text
            and "No hook contract tests discovered" in text
        ),
        "governance tests run": "unittest discover -s tools/governance/tests" in text,
        "hook tests run": "unittest discover -s .codex/tests" in text,
        "static reconcile": "reconcile.py static --json" in text,
        "CI reconcile": "reconcile.py ci --json" in text,
        "no continue-on-error": not bool(re.search(r"(?i)continue-on-error:\s*true", text)),
    }
    missing = [name for name, present in requirements.items() if not present]
    return _check(
        "workflow_contract", not missing,
        "workflow binds all release units to trusted OS runners and controlled validation"
        if not missing else "workflow contract is missing: %s" % ", ".join(missing),
        {"requirements": requirements, "note": "static text checks do not prove GitHub accepted or ran the workflow"},
    )


def _ci_release_runner_check(task: Mapping[str, Any]) -> Dict[str, Any]:
    unit = os.environ.get("MATERIAL_RELEASE_UNIT", "")
    runner = os.environ.get("RUNNER_OS", "")
    expected_runner = RELEASE_RUNNERS.get(unit)
    errors: List[str] = []
    if expected_runner is None:
        errors.append("MATERIAL_RELEASE_UNIT must be backend, mac or win")
    elif runner != expected_runner:
        errors.append("release unit %s requires RUNNER_OS=%s, found %s" % (unit, expected_runner, runner))
    if unit not in task.get("release_units", []):
        errors.append("release unit %s is outside the reviewed task" % (unit or "<missing>"))
    return _check(
        "ci_release_runner", not errors,
        "CI release unit is bound to its trusted operating-system runner"
        if not errors else "; ".join(errors),
        {"release_unit": unit or None, "runner_os": runner or None, "expected_runner": expected_runner},
    )


def _is_zero_oid(value: str) -> bool:
    return len(value) in ZERO_SHA_LENGTHS and not value.strip("0")


def _valid_oid(value: Any, allow_zero: bool = False) -> bool:
    if not isinstance(value, str) or not COMMIT_RE.fullmatch(value):
        return False
    return allow_zero or not _is_zero_oid(value)


def _git_commit_exists(root: Path, commit: str) -> Tuple[bool, str]:
    _output, error = run_git(root, ("cat-file", "-e", commit + "^{commit}"))
    return error is None, error or "commit exists"


def _parse_name_status_z(output: str) -> Tuple[Set[str], Optional[str]]:
    tokens = output.split("\0")
    if tokens and tokens[-1] == "":
        tokens.pop()
    paths: Set[str] = set()
    index = 0
    while index < len(tokens):
        token = tokens[index]
        index += 1
        status = token
        embedded_path: Optional[str] = None
        if "\t" in token:
            status, embedded_path = token.split("\t", 1)
        if not status or status[0] not in "ACDMRTUXB":
            return set(), "cannot parse Git name-status record %r" % token
        path_count = 2 if status[0] in "RC" else 1
        record_paths: List[str] = []
        if embedded_path is not None:
            record_paths.append(embedded_path)
        while len(record_paths) < path_count:
            if index >= len(tokens):
                return set(), "truncated Git name-status output"
            record_paths.append(tokens[index])
            index += 1
        for path in record_paths:
            if not path:
                return set(), "Git name-status output contains an empty path"
            paths.add(path)
    return paths, None


def _git_diff_paths(root: Path, left: str, right: str, merge_base: bool = False) -> Tuple[Set[str], Optional[str]]:
    revision = "%s...%s" % (left, right) if merge_base else None
    arguments: Tuple[str, ...]
    if revision:
        arguments = ("diff", "--name-status", "-z", "--find-renames", revision)
    else:
        arguments = ("diff", "--name-status", "-z", "--find-renames", left, right)
    output, error = run_git(root, arguments)
    if error:
        return set(), error
    return _parse_name_status_z(output or "")


def _git_snapshot_paths(root: Path, commit: str) -> Tuple[Set[str], Optional[str]]:
    output, error = run_git(root, ("ls-tree", "-r", "--name-only", "-z", commit))
    if error:
        return set(), error
    paths = set((output or "").split("\0"))
    paths.discard("")
    return paths, None


def _resolve_base_commit(root: Path, branch: str) -> Tuple[Optional[str], Optional[str]]:
    errors: List[str] = []
    for reference in ("refs/remotes/origin/" + branch, "refs/heads/" + branch, branch):
        output, error = run_git(root, ("rev-parse", "--verify", reference + "^{commit}"))
        if not error and output and _valid_oid(output):
            return output.lower(), None
        if error:
            errors.append(error)
    return None, "cannot resolve trusted base branch %s: %s" % (branch, "; ".join(errors))


def _read_github_event() -> Tuple[Optional[Dict[str, Any]], List[str]]:
    errors: List[str] = []
    if os.environ.get("GITHUB_ACTIONS") != "true":
        errors.append("GITHUB_ACTIONS must be true")
    event_path = os.environ.get("GITHUB_EVENT_PATH")
    if not event_path:
        return None, errors + ["GITHUB_EVENT_PATH is missing"]
    try:
        with Path(event_path).open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        return None, errors + ["cannot read trusted GitHub event payload: %s" % exc]
    if not isinstance(payload, dict):
        return None, errors + ["GitHub event payload must be a JSON object"]
    return payload, errors


def _trusted_github_branch(task: Mapping[str, Any]) -> Tuple[Optional[str], List[str]]:
    """Resolve a runner branch without trusting detached Git HEAD."""

    payload, errors = _read_github_event()
    event_name = os.environ.get("GITHUB_EVENT_NAME", "")
    branch: Optional[str] = None
    if payload is None:
        return None, errors
    if event_name == "push":
        ref = payload.get("ref")
        if not isinstance(ref, str) or not ref.startswith("refs/heads/"):
            errors.append("push event must target a branch ref")
        else:
            branch = ref[len("refs/heads/"):]
        if os.environ.get("GITHUB_REF") != ref:
            errors.append("GITHUB_REF does not match push payload ref")
        if branch is not None and os.environ.get("GITHUB_REF_NAME") != branch:
            errors.append("GITHUB_REF_NAME does not match push branch")
    elif event_name == "pull_request":
        pull_request = payload.get("pull_request")
        if not isinstance(pull_request, dict):
            errors.append("pull_request payload object is missing")
        else:
            head = pull_request.get("head", {})
            base = pull_request.get("base", {})
            if not isinstance(head, dict) or not isinstance(base, dict):
                errors.append("pull_request base/head objects are missing")
            else:
                branch = str(head.get("ref", "")) or None
                base_branch = str(base.get("ref", ""))
                if os.environ.get("GITHUB_HEAD_REF") != branch:
                    errors.append("GITHUB_HEAD_REF does not match pull_request head ref")
                if os.environ.get("GITHUB_BASE_REF") != base_branch:
                    errors.append("GITHUB_BASE_REF does not match pull_request base ref")
                if base_branch != str(task.get("base_branch", "")):
                    errors.append("pull_request target branch does not match task.base_branch")
    else:
        errors.append("GITHUB_EVENT_NAME must be push or pull_request")
    return branch, errors


def _trusted_ci_context(
    root: Path,
    task: Mapping[str, Any],
    project: Mapping[str, Any],
) -> Tuple[Dict[str, Any], Dict[str, Any], Set[str], Dict[str, Any]]:
    payload, errors = _read_github_event()
    event_name = os.environ.get("GITHUB_EVENT_NAME", "")
    head = ""
    base = ""
    head_branch = ""
    base_branch = ""
    created = False
    diff_mode = ""
    diff_base_sha = ""
    changed: Set[str] = set()
    diff_errors: List[str] = []
    if event_name not in ("push", "pull_request"):
        errors.append("GITHUB_EVENT_NAME must be push or pull_request")
    elif payload is not None and event_name == "push":
        head = str(payload.get("after", "")).lower()
        base = str(payload.get("before", "")).lower()
        ref = payload.get("ref")
        created = payload.get("created") is True
        if payload.get("deleted") is True:
            errors.append("deleted push has no verifiable head commit")
        if not isinstance(ref, str) or not ref.startswith("refs/heads/"):
            errors.append("push event must target a branch ref")
        else:
            head_branch = ref[len("refs/heads/"):]
        if not _valid_oid(head):
            errors.append("push after must be a non-zero 40/64 character commit id")
        if not _valid_oid(base, allow_zero=True):
            errors.append("push before must be a 40/64 character commit id")
        if _is_zero_oid(base) and not created:
            errors.append("all-zero push before requires created=true")
        if created and not _is_zero_oid(base):
            errors.append("created push requires an all-zero before")
        if payload.get("forced") is True:
            errors.append("forced push cannot produce trusted governance evidence")
        if os.environ.get("GITHUB_REF") != ref:
            errors.append("GITHUB_REF does not match push payload ref")
        if os.environ.get("GITHUB_REF_NAME") != head_branch:
            errors.append("GITHUB_REF_NAME does not match push branch")
        if os.environ.get("GITHUB_SHA", "").lower() != head:
            errors.append("GITHUB_SHA does not match push after")
        base_branch = str(task.get("base_branch", ""))
    elif payload is not None and event_name == "pull_request":
        pull_request = payload.get("pull_request")
        if not isinstance(pull_request, dict):
            errors.append("pull_request payload object is missing")
        else:
            base_object = pull_request.get("base", {})
            head_object = pull_request.get("head", {})
            if not isinstance(base_object, dict) or not isinstance(head_object, dict):
                errors.append("pull_request base/head objects are missing")
            else:
                base = str(base_object.get("sha", "")).lower()
                head = str(head_object.get("sha", "")).lower()
                base_branch = str(base_object.get("ref", ""))
                head_branch = str(head_object.get("ref", ""))
        if not _valid_oid(base) or not _valid_oid(head):
            errors.append("pull_request base/head must be non-zero 40/64 character commit ids")
        if os.environ.get("GITHUB_BASE_REF") != base_branch:
            errors.append("GITHUB_BASE_REF does not match pull_request base ref")
        if os.environ.get("GITHUB_HEAD_REF") != head_branch:
            errors.append("GITHUB_HEAD_REF does not match pull_request head ref")
        if base_branch != str(task.get("base_branch", "")):
            errors.append("pull_request target branch does not match task.base_branch")

    if payload is not None:
        repository_payload = payload.get("repository")
        repository_name = (
            repository_payload.get("full_name")
            if isinstance(repository_payload, Mapping) else None
        )
        if repository_name != GITHUB_REPOSITORY:
            errors.append("GitHub event repository must be %s" % GITHUB_REPOSITORY)

    required_env = (
        "GITHUB_RUN_ID", "GITHUB_SERVER_URL", "GITHUB_REPOSITORY", "GITHUB_WORKFLOW_REF",
        "MATERIAL_RELEASE_UNIT", "RUNNER_OS",
    )
    missing_env = [name for name in required_env if not os.environ.get(name)]
    if missing_env:
        errors.append("trusted CI environment is missing %s" % ", ".join(missing_env))
    repository = os.environ.get("GITHUB_REPOSITORY", "")
    if repository and repository != GITHUB_REPOSITORY:
        errors.append("GITHUB_REPOSITORY must be %s" % GITHUB_REPOSITORY)
    server_url = os.environ.get("GITHUB_SERVER_URL", "")
    if server_url and server_url.rstrip("/") != "https://github.com":
        errors.append("GITHUB_SERVER_URL must be https://github.com")
    workflow_ref = os.environ.get("GITHUB_WORKFLOW_REF", "")
    expected_workflow_prefix = "%s/%s@" % (GITHUB_REPOSITORY, GITHUB_WORKFLOW_PATH)
    if workflow_ref and not workflow_ref.startswith(expected_workflow_prefix):
        errors.append("GITHUB_WORKFLOW_REF must bind %s" % expected_workflow_prefix)
    checkout_head = ""
    checkout_output, checkout_error = run_git(root, ("rev-parse", "HEAD"))
    if checkout_error or not checkout_output:
        errors.append("cannot resolve checked-out HEAD: %s" % (checkout_error or "empty output"))
    else:
        checkout_head = checkout_output.lower()
        if head and checkout_head != head:
            errors.append("checked-out HEAD does not match trusted event head")
    if head and _valid_oid(head):
        head_exists, head_reason = _git_commit_exists(root, head)
        if not head_exists:
            errors.append("event head commit is unavailable: %s" % head_reason)
    if base and not _is_zero_oid(base) and _valid_oid(base):
        base_exists, base_reason = _git_commit_exists(root, base)
        if not base_exists:
            errors.append("event base commit is unavailable: %s" % base_reason)

    if not errors:
        if event_name == "pull_request":
            merge_output, merge_error = run_git(root, ("merge-base", base, head))
            if merge_error or not merge_output:
                diff_errors.append("pull_request base and head have no available merge-base: %s" % (merge_error or "empty output"))
            else:
                diff_base_sha = merge_output.lower()
                changed, error = _git_diff_paths(root, base, head, merge_base=True)
                if error:
                    diff_errors.append(error)
                diff_mode = "pull_request_merge_base"
        elif _is_zero_oid(base):
            bootstrap_tasks = project.get("branch_policy", {}).get("bootstrap_main_tasks", [])
            if (
                bootstrap_tasks == [BOOTSTRAP_TASK_ID]
                and task.get("task_id") == BOOTSTRAP_TASK_ID
                and head_branch == task.get("branch") == "main"
            ):
                parents, parents_error = run_git(root, ("rev-list", "--parents", "-n", "1", head))
                if parents_error or len((parents or "").split()) != 1:
                    diff_errors.append("bootstrap first push head must be a root commit")
                changed, error = _git_snapshot_paths(root, head)
                if error:
                    diff_errors.append(error)
                diff_mode = "root_snapshot"
            else:
                reviewed_base = str(task.get("base_branch", ""))
                base_commit, base_error = _resolve_base_commit(root, reviewed_base)
                if base_error or not base_commit:
                    diff_errors.append(base_error or "reviewed base branch commit is unavailable")
                else:
                    merge_output, merge_error = run_git(root, ("merge-base", base_commit, head))
                    if merge_error or not merge_output:
                        diff_errors.append("new branch head has no common ancestor with task.base_branch")
                    else:
                        diff_base_sha = merge_output.lower()
                        changed, error = _git_diff_paths(root, base_commit, head, merge_base=True)
                        if error:
                            diff_errors.append(error)
                    diff_mode = "created_branch_merge_base"
        else:
            diff_base_sha = base
            changed, error = _git_diff_paths(root, base, head)
            if error:
                diff_errors.append(error)
            diff_mode = "push_before_after"

    run_id = os.environ.get("GITHUB_RUN_ID")
    context = {
        "event": event_name,
        "base_sha": base or None,
        "head_sha": head or None,
        "head_branch": head_branch or None,
        "base_branch": base_branch or None,
        "github_sha": os.environ.get("GITHUB_SHA"),
        "checkout_head_sha": checkout_head or None,
        "runner_os": os.environ.get("RUNNER_OS"),
        "release_unit": os.environ.get("MATERIAL_RELEASE_UNIT"),
        "workflow_ref": workflow_ref or None,
        "run_id": run_id,
        "run_url": "%s/%s/actions/runs/%s" % (server_url.rstrip("/"), repository, run_id)
        if server_url and repository and run_id else None,
        "created": created,
        "diff_mode": diff_mode or None,
        "diff_base_sha": diff_base_sha or None,
    }
    event_check = _check(
        "ci_event", not errors,
        "trusted GitHub event and checked-out head are consistent" if not errors else "; ".join(errors),
        context,
    )
    diff_check = _check(
        "ci_committed_diff", not errors and not diff_errors,
        "committed event diff was derived from trusted base/head" if not errors and not diff_errors
        else "; ".join(diff_errors or ["committed diff unavailable because CI event is invalid"]),
        {"changed": sorted(changed), "mode": diff_mode or None},
    )
    return context, event_check, changed, diff_check


def _protected_control_path(root: Path, path: str) -> bool:
    return path_is_allowed(root, path, PROTECTED_CONTROL_PATTERNS)


def _ci_commit_protocol_check(
    root: Path,
    project: Mapping[str, Any],
    task: Mapping[str, Any],
    ci_context: Mapping[str, Any],
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    head = ci_context.get("head_sha")
    event_name = ci_context.get("event")
    created = ci_context.get("created") is True
    base = str(ci_context.get("base_sha") or "")
    branch = ci_context.get("head_branch")
    task_index = _effective_status_index(task)
    bootstrap_tasks = project.get("branch_policy", {}).get("bootstrap_main_tasks", [])
    bootstrap = (
        event_name == "push"
        and created
        and _is_zero_oid(base)
        and bootstrap_tasks == [BOOTSTRAP_TASK_ID]
        and task.get("task_id") == BOOTSTRAP_TASK_ID
        and branch == task.get("branch") == "main"
        and task_index < status_index("COMMITTED")
        and not task.get("git", {}).get("committed_sha")
    )
    bootstrap_repair = (
        event_name == "push"
        and not created
        and base == FAILED_BOOTSTRAP_ROOT_SHA
        and bootstrap_tasks == [BOOTSTRAP_TASK_ID]
        and task.get("task_id") == BOOTSTRAP_TASK_ID
        and branch == task.get("branch") == task.get("base_branch") == "main"
        and task_index < status_index("COMMITTED")
        and not task.get("git", {}).get("committed_sha")
    )
    result_context: Dict[str, Any] = {
        "content_subject_sha": None,
        "control_head_sha": head,
        "mode": None,
        "evidence_status": "pending",
        "phase": "post_merge" if task_index >= status_index("MERGED") else "ci",
    }
    if not isinstance(head, str) or not _valid_oid(head):
        return _check("ci_commit_protocol", False, "trusted event head is unavailable"), result_context
    if bootstrap:
        result_context["mode"] = "bootstrap_pending"
        return _check(
            "ci_commit_protocol", True,
            "bootstrap root snapshot is definition-only; CI evidence remains pending and cannot advance CI_VERIFIED",
            result_context,
        ), result_context
    if bootstrap_repair:
        repair_issues = bootstrap_repair_commit_issues(root, str(head))
        if repair_issues:
            return _check(
                "ci_commit_protocol",
                False,
                "failed-bootstrap repair does not match the exact R007 contract: %s"
                % "; ".join(repair_issues),
                result_context,
            ), result_context
        result_context["mode"] = "bootstrap_repair_pending"
        result_context["failed_root_sha"] = FAILED_BOOTSTRAP_ROOT_SHA
        return _check(
            "ci_commit_protocol",
            True,
            "exact R007 repair was fast-forwarded from the failed root; CI evidence remains pending",
            result_context,
        ), result_context
    git_evidence = task.get("git", {}) if isinstance(task.get("git"), dict) else {}
    subject_field = "merged_sha" if task_index >= status_index("MERGED") else "committed_sha"
    subject = git_evidence.get(subject_field)
    if not isinstance(subject, str) or not _valid_oid(subject):
        return _check(
            "ci_commit_protocol", False,
            "non-bootstrap CI requires task.git.%s" % subject_field,
            result_context,
        ), result_context
    subject = subject.lower()
    result_context["content_subject_sha"] = subject
    subject_exists, subject_reason = _git_commit_exists(root, subject)
    if not subject_exists:
        return _check(
            "ci_commit_protocol", False,
            "content subject commit is unavailable: %s" % subject_reason,
            result_context,
        ), result_context
    requires_content_coverage = task_index in (
        status_index("COMMITTED"), status_index("MERGED"),
    )
    bootstrap_control_continuation = False
    if requires_content_coverage:
        diff_base = ci_context.get("diff_base_sha")
        if not isinstance(diff_base, str) or not _valid_oid(diff_base):
            return _check(
                "ci_commit_protocol", False,
                "current-stage CI requires a trusted diff base that covers the content subject",
                result_context,
            ), result_context
        if diff_base == subject:
            branch_exception = task.get("branch_exception", {})
            exact_bootstrap_control = (
                event_name == "push"
                and not created
                and task_index == status_index("COMMITTED")
                and bootstrap_tasks == [BOOTSTRAP_TASK_ID]
                and task.get("task_id") == BOOTSTRAP_TASK_ID
                and branch == task.get("branch") == task.get("base_branch") == "main"
                and isinstance(branch_exception, Mapping)
                and branch_exception.get("kind") == "bootstrap-main"
                and branch_exception.get("applies_only_to_task") == BOOTSTRAP_TASK_ID
                and head != subject
            )
            parents, parents_error = run_git(
                root, ("rev-list", "--parents", "-n", "1", subject)
            )
            subject_is_root = not parents_error and len((parents or "").split()) == 1
            repair_issues = bootstrap_repair_commit_issues(root, subject)
            subject_is_repair = not repair_issues
            if not exact_bootstrap_control or not (subject_is_root or subject_is_repair):
                return _check(
                    "ci_commit_protocol", False,
                    "trusted event diff starts at the content subject and therefore does not revalidate its changes",
                    result_context,
                ), result_context
            content_paths, snapshot_error = _git_snapshot_paths(root, subject)
            if snapshot_error:
                return _check(
                    "ci_commit_protocol", False,
                    "cannot inspect bootstrap content subject snapshot: %s" % snapshot_error,
                    result_context,
                ), result_context
            outside_content_scope = sorted(
                path for path in content_paths
                if not path_is_allowed(root, path, task.get("allowed_paths", []))
            )
            if outside_content_scope:
                return _check(
                    "ci_commit_protocol", False,
                    "bootstrap content subject contains paths outside reviewed scope: %s"
                    % ", ".join(outside_content_scope),
                    {
                        **result_context,
                        "bootstrap_content_paths": sorted(content_paths),
                        "outside_scope": outside_content_scope,
                    },
                ), result_context
            bootstrap_control_continuation = True
            result_context["bootstrap_content_mode"] = (
                "root" if subject_is_root else "failed_root_repair"
            )
            result_context["bootstrap_content_path_count"] = len(content_paths)
            result_context["content_diff_base_sha"] = diff_base
        else:
            _coverage_output, coverage_error = run_git(
                root, ("merge-base", "--is-ancestor", diff_base, subject)
            )
            if coverage_error:
                return _check(
                    "ci_commit_protocol", False,
                    "content subject is outside the trusted event diff: %s" % coverage_error,
                    result_context,
                ), result_context
            result_context["content_diff_base_sha"] = diff_base
    if subject == head:
        result_context["mode"] = "content_head"
        result_context["evidence_status"] = "eligible_to_record"
        return _check(
            "ci_commit_protocol", True,
            "event head is the exact content subject commit; CI result is not yet recorded",
            result_context,
        ), result_context
    _output, ancestor_error = run_git(root, ("merge-base", "--is-ancestor", subject, head))
    if ancestor_error:
        return _check(
            "ci_commit_protocol", False,
            "content subject is not an ancestor of control head: %s" % ancestor_error,
            result_context,
        ), result_context
    control_paths, diff_error = _git_diff_paths(root, subject, head)
    if diff_error:
        return _check(
            "ci_commit_protocol", False,
            "cannot inspect content-to-control range: %s" % diff_error,
            result_context,
        ), result_context
    ordinary = sorted(path for path in control_paths if not _protected_control_path(root, path))
    if ordinary:
        return _check(
            "ci_commit_protocol", False,
            "content-to-control range changes ordinary project files: %s" % ", ".join(ordinary),
            {**result_context, "control_paths": sorted(control_paths), "ordinary_paths": ordinary},
        ), result_context
    result_context["mode"] = (
        "bootstrap_control_head" if bootstrap_control_continuation else "control_head"
    )
    result_context["evidence_status"] = "eligible_to_record"
    return _check(
        "ci_commit_protocol", True,
        (
            "bootstrap root content subject and protected control head are fully revalidated; "
            "CI result is not yet recorded"
            if bootstrap_control_continuation else
            "content subject is an ancestor and control head changes only protected machine state; "
            "CI result is not yet recorded"
        ),
        {**result_context, "control_paths": sorted(control_paths)},
    ), result_context


def _check_command(command: str, allowed: Sequence[str]) -> Tuple[bool, str]:
    if any(token in command for token in SHELL_CONTROL_TOKENS):
        return False, "shell chaining, redirection and substitution require a separately reviewed command"
    try:
        shlex.split(command)
    except ValueError as exc:
        return False, "command cannot be parsed safely: %s" % exc
    if not command_is_allowed(command, allowed):
        return False, "command is outside allowed_commands"
    return True, "command is approved"


def run_reconcile(
    root: Path,
    profile: str,
    tool: Optional[str] = None,
    command: Optional[str] = None,
    paths: Optional[Sequence[str]] = None,
    git_branch: Optional[str] = None,
    git_changes: Optional[Sequence[str]] = None,
) -> Dict[str, Any]:
    """Run reconciliation and return a report.  No state is ever changed."""

    root = root.resolve()
    checks: List[Dict[str, Any]] = []
    paths = list(paths or [])

    project = read_json(control_dir(root) / "project.json")
    project_issues = _validate_project(project)
    checks.append(_check(
        "project",
        not project_issues,
        "project classification and release units are consistent" if not project_issues else "; ".join(project_issues),
    ))
    if profile in ("workflow", "static", "precommit", "ci"):
        checks.append(_fixed_project_contract_check(project))

    task = load_current_task(root)
    checks.append(_check(
        "current_task",
        True,
        "current task %s is %s" % (task["task_id"], task["status"]),
        {
            "task_id": task["task_id"],
            "status": task["status"],
            "requirement": task["requirement"],
            "scope_version": task["scope_version"],
        },
    ))
    checks.append(_release_registry_check(root, project, task))
    checks.append(_active_task_check(root, task))
    checks.append(_dependency_check(root, task))
    plan_issues = validation_plan_issues(task)
    legacy_plan_migration = bool(plan_issues) and legacy_g0_v1_migration(task)
    checks.append(_check(
        "validation_plan",
        not plan_issues or legacy_plan_migration,
        (
            "validation plan is non-empty and covers local, CI and post-merge gates"
            if not plan_issues else
            "legacy GOV-0001 scope v1 migration is pending: %s" % "; ".join(plan_issues)
            if legacy_plan_migration else
            "; ".join(plan_issues)
        ),
        {
            "migration_pending": legacy_plan_migration,
            "issues": plan_issues,
        },
    ))
    checks.extend(_reviewed_task_contract_checks(task, legacy_g0_v1_migration(task)))

    receipt, review_reason = find_effective_review(root, task)
    checks.append(_check(
        "scope_review",
        receipt is not None,
        "current canonical scope is approved" if receipt else review_reason,
        {"review_id": receipt.get("review_id") if receipt else None, "scope_hash": canonical_scope_hash(task)},
    ))

    blockers = task.get("blockers", [])
    blocking_questions = [
        item for item in task.get("open_questions", [])
        if isinstance(item, dict) and item.get("blocking_for") in ("current", "all") and item.get("status") != "resolved"
    ]
    checks.append(_check(
        "blockers",
        not blockers and not blocking_questions,
        "no current blockers" if not blockers and not blocking_questions else "task has unresolved blockers",
        {"blockers": blockers, "blocking_questions": blocking_questions},
    ))

    attained_gates: Dict[str, Any] = {}
    attained_missing: List[str] = []
    for gate in ("LOCAL_VERIFIED", "CI_VERIFIED", "POST_MERGE_VERIFIED"):
        if status_index(str(task["status"])) >= status_index(gate):
            gate_status = validation_gate_status(root, task, gate)
            attained_gates[gate] = gate_status
            attained_missing.extend(
                "%s:%s" % (gate, item["check_id"]) for item in gate_status["missing"]
            )
    checks.append(_check(
        "attained_validation_gates",
        not attained_missing,
        (
            "all validation gates claimed by the current phase remain effective"
            if not attained_missing else
            "current phase claims unsatisfied validation gates: %s" % ", ".join(attained_missing)
        ),
        {"gates": attained_gates},
    ))

    code_review_receipt = None
    if status_index(str(task["status"])) >= status_index("CODE_REVIEWED"):
        code_review_receipt, code_review_reason = find_effective_code_review(root, task)
        checks.append(_check(
            "code_review",
            code_review_receipt is not None,
            "CI-verified commit has effective user code review"
            if code_review_receipt else code_review_reason,
            {
                "review_id": code_review_receipt.get("review_id") if code_review_receipt else None,
                "commit": task.get("git", {}).get("ci_verified_sha"),
            },
        ))

    ci_context: Dict[str, Any] = {}
    ci_protocol_context: Dict[str, Any] = {}
    ci_changed: Set[str] = set()
    ci_event_ok = True
    if profile == "ci":
        ci_context, event_check, ci_changed, diff_check = _trusted_ci_context(root, task, project)
        release_runner_check = _ci_release_runner_check(task)
        checks.extend((event_check, diff_check, release_runner_check))
        ci_event_ok = (
            event_check["status"] == "passed"
            and diff_check["status"] == "passed"
            and release_runner_check["status"] == "passed"
        )

    expected_branch = str(task.get("branch", ""))
    branch_source = "git"
    if profile == "ci":
        branch_input = ci_context.get("head_branch")
        branch_source = "trusted_github_event"
    elif git_branch is None and os.environ.get("GITHUB_ACTIONS") == "true":
        branch_input, runner_branch_errors = _trusted_github_branch(task)
        branch_source = "trusted_github_event"
        checks.append(_check(
            "github_branch_context",
            not runner_branch_errors,
            "trusted GitHub event branch is available" if not runner_branch_errors
            else "; ".join(runner_branch_errors),
            {"branch": branch_input},
        ))
    else:
        branch_input = git_branch
    expected_for_phase = expected_branch
    post_merge_phase = _effective_status_index(task) >= status_index("MERGED")
    if post_merge_phase:
        expected_for_phase = str(task.get("base_branch", ""))
    if post_merge_phase:
        _work_ok, _work_message, actual_branch, _work_bootstrap = branch_validity(
            root, task, branch_input
        )
        bootstrap_ok = False
        branch_ok = bool(expected_for_phase) and actual_branch == expected_for_phase
        message = (
            "post-merge event branch matches task.base_branch" if branch_ok
            else "post-merge branch mismatch: expected %s, found %s" % (expected_for_phase, actual_branch)
        )
    else:
        branch_ok, message, actual_branch, bootstrap_ok = branch_validity(root, task, branch_input)
    checks.append(_check(
        "branch",
        branch_ok,
        message,
        {
            "expected": expected_for_phase,
            "task_branch": expected_branch,
            "actual": actual_branch,
            "bootstrap_exception": bootstrap_ok,
            "source": branch_source,
        },
    ))
    checks.append(_branch_schema_check(project, task))

    if profile == "pretool":
        normalized_tool = _normalized_tool(tool or "")
        tool_ok = bool(tool) and tool_is_allowed(str(tool), task.get("allowed_tools", []))
        checks.append(_check("tool", tool_ok, "tool is approved" if tool_ok else "tool is outside allowed_tools", {"tool": tool}))

        if normalized_tool in MUTATING_FILE_TOOLS:
            scoped = bool(paths) and all(path_is_allowed(root, path, task.get("allowed_paths", [])) for path in paths)
            checks.append(_check(
                "requested_paths", scoped,
                "all requested write paths are approved" if scoped else "a mutating file tool requires only approved --path values",
                {"paths": paths},
            ))
        elif paths:
            scoped = all(path_is_allowed(root, path, task.get("allowed_paths", [])) for path in paths)
            checks.append(_check("requested_paths", scoped, "requested paths are approved" if scoped else "requested path is outside scope", {"paths": paths}))

        is_shell = normalized_tool in ("bash", "shell", "exec", "execcommand", "functionsexec")
        if is_shell:
            command_ok, command_reason = _check_command(command or "", task.get("allowed_commands", []))
            checks.append(_check("command", command_ok, command_reason, {"command": command}))
        elif command:
            checks.append(_check("command", False, "--command is only valid for an approved shell tool"))
    else:
        if profile == "ci":
            changed, changes_error = ci_changed, None if ci_event_ok else "trusted committed diff is unavailable"
        else:
            changed, changes_error = (set(git_changes), None) if git_changes is not None else changed_paths(root)
        outside = sorted(
            path for path in changed
            if not path_is_allowed(root, path, task.get("allowed_paths", []))
            and not (profile == "ci" and _protected_control_path(root, path))
        )
        changes_ok = changes_error is None and not outside
        changes_message = "all changed paths are inside task scope"
        if changes_error:
            changes_message = changes_error
        elif outside:
            changes_message = "changed paths outside task scope: %s" % ", ".join(outside)
        checks.append(_check(
            "changed_paths", changes_ok, changes_message,
            {"changed": sorted(changed), "outside_scope": outside},
        ))

        missing_docs, matched_docs = _required_docs(root, task)
        checks.append(_check(
            "required_docs", not missing_docs,
            "all required documents exist" if not missing_docs else "required documents are missing: %s" % ", ".join(missing_docs),
            {"matched": matched_docs, "missing": missing_docs},
        ))

    if profile in ("docs", "static", "precommit", "ci"):
        checks.extend(_document_checks(root, task))
        checks.append(_requirement_template_check(root))
        checks.append(_governed_requirement_documents_check(root))
        checks.append(_local_markdown_links_check(root))
        checks.append(_approval_migration_docs_check(root, project, task))
    if profile in ("workflow", "static", "precommit", "ci"):
        checks.append(_workflow_check(root))

    bootstrap_ci_pending = (
        profile == "ci"
        and ci_context.get("event") == "push"
        and ci_context.get("created") is True
        and _is_zero_oid(str(ci_context.get("base_sha") or ""))
        and project.get("branch_policy", {}).get("bootstrap_main_tasks", []) == [BOOTSTRAP_TASK_ID]
        and task.get("task_id") == BOOTSTRAP_TASK_ID
        and _effective_status_index(task) < status_index("COMMITTED")
    )
    if profile in ("precommit", "ci") and not bootstrap_ci_pending:
        validation_status = validation_gate_status(root, task, "LOCAL_VERIFIED")
        validation_missing = validation_status["missing"]
        checks.append(_check(
            "validation",
            not validation_missing,
            (
                "local validation gates are satisfied; %s waived" % len(validation_status["waived"])
                if not validation_missing else
                "validation gates are not satisfied: %s" % ", ".join(
                    "%s (%s)" % (item["check_id"], item["reason"]) for item in validation_missing
                )
            ),
            validation_status,
        ))

    if profile == "ci":
        protocol_check, ci_protocol_context = _ci_commit_protocol_check(root, project, task, ci_context)
        if not ci_event_ok:
            protocol_check = _check(
                "ci_commit_protocol", False,
                "commit protocol cannot be trusted until CI event and committed diff checks pass",
                ci_protocol_context,
            )
        checks.append(protocol_check)

    ok = all(item["status"] == "passed" for item in checks)
    context = {
        "task_id": task["task_id"],
        "status": task["status"],
        "requirement": task["requirement"],
        "branch": task["branch"],
        "scope_hash": canonical_scope_hash(task),
        "review_id": receipt.get("review_id") if receipt else None,
        "assumptions": task.get("assumptions", []),
        "open_questions": task.get("open_questions", []),
        "blockers": blockers,
        "validation_gates": {
            "LOCAL_VERIFIED": validation_gate_status(root, task, "LOCAL_VERIFIED"),
            "CI_VERIFIED": validation_gate_status(root, task, "CI_VERIFIED"),
            "POST_MERGE_VERIFIED": validation_gate_status(root, task, "POST_MERGE_VERIFIED"),
        },
        "next_state": NORMAL_STATES[status_index(task["status"]) + 1]
        if 0 <= status_index(task["status"]) < len(NORMAL_STATES) - 1 else None,
    }
    if profile == "ci":
        context["ci"] = dict(ci_context)
        context["ci"].update(ci_protocol_context)
    return {"ok": ok, "profile": profile, "read_only": True, "context": context, "checks": checks}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="reconcile", description=__doc__)
    subparsers = parser.add_subparsers(dest="profile", required=True)
    for profile in PROFILES:
        subparser = subparsers.add_parser(profile)
        subparser.add_argument("--root", type=Path, default=default_root())
        subparser.add_argument("--json", action="store_true")
        if profile == "pretool":
            subparser.add_argument("--tool", required=True)
            subparser.add_argument("--command")
            subparser.add_argument("--path", action="append", dest="paths", default=[])
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        report = run_reconcile(
            Path(args.root), args.profile,
            tool=getattr(args, "tool", None),
            command=getattr(args, "command", None),
            paths=getattr(args, "paths", None),
        )
    except GovernanceError as exc:
        payload = {"ok": False, "profile": args.profile, "read_only": True, "error": str(exc), "checks": []}
        print(json_result(payload) if args.json else "ERROR: %s" % exc, file=sys.stderr)
        return 2

    if args.json:
        print(json_result(report))
    else:
        print("reconcile %s: %s" % (args.profile, "PASS" if report["ok"] else "FAIL"))
        for item in report["checks"]:
            print("[%s] %s: %s" % (item["status"].upper(), item["id"], item["message"]))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
