#!/usr/bin/env python3
"""Read-only helpers shared by the Codex governance hooks.

This module intentionally depends only on Python 3.9's standard library.  It
does not repair project-control state: malformed or inconsistent state remains
visible and causes write-capable tool calls to fail closed.
"""

from __future__ import annotations

import fnmatch
import importlib.util
import json
import os
import re
import shlex
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple


MAX_JSON_BYTES = 1024 * 1024
TASK_ID_RE = re.compile(r"^[A-Z][A-Z0-9]*(?:-[A-Z0-9][A-Z0-9]*)+$")
REVIEW_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$")
LEGAL_TASK_STATES = {
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
    "BLOCKED",
    "FAILED",
    "REJECTED",
    "CANCELLED",
}
ORDINARY_WRITE_STATE = "IN_PROGRESS"
READY_OR_LATER_STATES = {
    "READY",
    "IN_PROGRESS",
    "LOCAL_VERIFIED",
    "COMMITTED",
    "CI_VERIFIED",
    "CODE_REVIEWED",
    "MERGED",
    "POST_MERGE_VERIFIED",
    "DONE",
}
INTERACTION_KINDS = {"ui", "non_ui", "mixed"}
VALIDATION_GATES = {
    "LOCAL_VERIFIED",
    "CI_VERIFIED",
    "POST_MERGE_VERIFIED",
}
REVIEW_NAMESPACE = "material-governance-review"
CI_TRUST_ANCHOR = {
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
}
REQUIRED_TASK_LIST_FIELDS = (
    "allowed_paths",
    "allowed_commands",
    "allowed_tools",
    "dependencies",
    "required_docs",
    "assumptions",
    "open_questions",
    "blockers",
)


class GovernanceError(Exception):
    """A state error that must make write-capable operations fail closed."""


@dataclass(frozen=True)
class GovernanceSnapshot:
    repo_root: Path
    task: Optional[Dict[str, Any]]
    review: Optional[Dict[str, Any]]
    actual_branch: Optional[str]
    valid: bool
    reasons: Tuple[str, ...]
    review_reason: Optional[str]


def load_stdin_object() -> Dict[str, Any]:
    raw = os.sys.stdin.buffer.read(MAX_JSON_BYTES + 1)
    if len(raw) > MAX_JSON_BYTES:
        raise GovernanceError("hook input exceeds the 1 MiB safety limit")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise GovernanceError("hook input is not valid UTF-8 JSON") from exc
    if not isinstance(value, dict):
        raise GovernanceError("hook input must be a JSON object")
    return value


def emit_json(value: Dict[str, Any]) -> None:
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":")))


def find_repo_root(start: Path) -> Path:
    """Walk upward from *start* until a Git worktree marker is found."""

    try:
        current = start.expanduser().resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise GovernanceError("session cwd does not resolve to a readable path") from exc
    if current.is_file():
        current = current.parent
    for candidate in (current, *current.parents):
        marker = candidate / ".git"
        if marker.is_dir() or marker.is_file():
            return candidate.resolve()
    raise GovernanceError("session cwd is not inside a Git repository")


def repo_root_from_payload(payload: Dict[str, Any]) -> Path:
    cwd = payload.get("cwd")
    if not isinstance(cwd, str) or not cwd.strip():
        raise GovernanceError("hook input is missing cwd")
    return find_repo_root(Path(cwd))


def _read_json_object(path: Path) -> Dict[str, Any]:
    try:
        size = path.stat().st_size
        if size > MAX_JSON_BYTES:
            raise GovernanceError(f"{path.name} exceeds the 1 MiB safety limit")
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise GovernanceError(f"required governance file is missing: {path.name}") from exc
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise GovernanceError(f"governance file is unreadable or invalid: {path.name}") from exc
    if not isinstance(value, dict):
        raise GovernanceError(f"governance file must contain a JSON object: {path.name}")
    return value


def _git_dir(repo_root: Path) -> Path:
    marker = repo_root / ".git"
    if marker.is_dir():
        return marker.resolve()
    try:
        text = marker.read_text(encoding="utf-8").strip()
    except (OSError, UnicodeDecodeError) as exc:
        raise GovernanceError("Git worktree marker is unreadable") from exc
    if not text.startswith("gitdir:"):
        raise GovernanceError("Git worktree marker is invalid")
    target = text.split(":", 1)[1].strip()
    git_dir = Path(target)
    if not git_dir.is_absolute():
        git_dir = marker.parent / git_dir
    try:
        return git_dir.resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise GovernanceError("Git worktree metadata directory is missing") from exc


def current_branch(repo_root: Path) -> Optional[str]:
    try:
        head = (_git_dir(repo_root) / "HEAD").read_text(encoding="utf-8").strip()
    except (OSError, UnicodeDecodeError) as exc:
        raise GovernanceError("Git HEAD is unreadable") from exc
    prefix = "ref: refs/heads/"
    if head.startswith(prefix):
        branch = head[len(prefix) :]
        return branch if branch else None
    return None


_CORE_CACHE: Dict[str, Any] = {}


def _load_core(repo_root: Path) -> Any:
    """Load the repository's sole canonical task/review implementation."""

    core_path = (repo_root / "tools" / "governance" / "core.py").resolve()
    try:
        core_path.relative_to(repo_root.resolve())
        if core_path.stat().st_size > MAX_JSON_BYTES:
            raise GovernanceError("tools/governance/core.py exceeds the safety limit")
    except (OSError, RuntimeError, ValueError) as exc:
        raise GovernanceError("canonical governance core is missing or outside the repository") from exc
    cache_key = str(core_path)
    if cache_key in _CORE_CACHE:
        return _CORE_CACHE[cache_key]
    governance_module_dir = str(core_path.parent)
    if governance_module_dir not in sys.path:
        # core.py lazily imports its sibling authority module only when a v2
        # signed receipt is inspected.  Keep that import bound to the already
        # resolved in-repository governance directory.
        sys.path.insert(0, governance_module_dir)
    spec = importlib.util.spec_from_file_location(
        f"_project_governance_core_{abs(hash(cache_key))}",
        str(core_path),
    )
    if spec is None or spec.loader is None:
        raise GovernanceError("canonical governance core cannot be loaded")
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception as exc:
        raise GovernanceError("canonical governance core failed to load") from exc
    for name in ("load_current_task", "find_effective_review", "canonical_scope_hash"):
        if not callable(getattr(module, name, None)):
            raise GovernanceError(f"canonical governance core is missing {name}")
    _CORE_CACHE[cache_key] = module
    return module


def canonical_scope_hash(task: Dict[str, Any], repo_root: Path) -> str:
    """Delegate review-bound hashing to tools/governance/core.py."""

    core = _load_core(repo_root)
    try:
        value = core.canonical_scope_hash(task)
    except Exception as exc:
        raise GovernanceError("canonical scope hash could not be calculated") from exc
    if not isinstance(value, str) or not value.startswith("sha256:"):
        raise GovernanceError("canonical governance core returned an invalid scope hash")
    return value


def _validate_task(task: Dict[str, Any]) -> List[str]:
    reasons: List[str] = []
    if task.get("status") not in LEGAL_TASK_STATES:
        reasons.append("task status is not a recognized lifecycle state")
    requirement = task.get("requirement")
    if not isinstance(requirement, dict):
        reasons.append("task requirement must be an object")
    else:
        for field in ("id", "version", "name"):
            if not isinstance(requirement.get(field), str) or not requirement[field].strip():
                reasons.append(f"task requirement.{field} is missing")
        interaction_kind = requirement.get("interaction_kind")
        if interaction_kind is not None and interaction_kind not in INTERACTION_KINDS:
            reasons.append(
                "task requirement.interaction_kind must be ui, non_ui, or mixed"
            )
        elif (
            task.get("status") in READY_OR_LATER_STATES
            and interaction_kind is None
            and not _is_legacy_bootstrap_scope_v1(task)
        ):
            reasons.append(
                "task requirement.interaction_kind is required from READY onward"
            )
    branch = task.get("branch")
    if not isinstance(branch, str) or not branch.strip():
        reasons.append("task branch is missing")
    if "base_branch" in task and (
        not isinstance(task.get("base_branch"), str)
        or not str(task.get("base_branch")).strip()
    ):
        reasons.append("task base_branch must be a non-empty string when present")
    scope_version = task.get("scope_version")
    if not isinstance(scope_version, int) or isinstance(scope_version, bool) or scope_version < 1:
        reasons.append("task scope_version must be a positive integer")
    for field in REQUIRED_TASK_LIST_FIELDS:
        if not isinstance(task.get(field), list):
            reasons.append(f"task {field} must be a list")
    validation = task.get("validation")
    if not isinstance(validation, dict):
        reasons.append("task validation must be an object")
    else:
        required = validation.get("required", [])
        if not isinstance(required, list):
            reasons.append("task validation.required must be a list")
        else:
            reasons.extend(_validation_contract_reasons(task, required))
        if not isinstance(validation.get("results", []), list):
            reasons.append("task validation.results must be a list")
    if _requires_v2_trust_contract(task):
        reasons.extend(_review_authority_reasons(task))
        reasons.extend(_ci_trust_reasons(task))
        reasons.extend(_coordination_reasons(task))
    return reasons


def _is_legacy_bootstrap_scope_v1(task: Dict[str, Any]) -> bool:
    """Identify only the original G0 v1 bootstrap scope migration."""

    git_evidence = task.get("git", {})
    if not isinstance(git_evidence, dict):
        return False
    status = task.get("status")
    if status == "BLOCKED":
        exception_state = task.get("exception")
        status = (
            exception_state.get("previous_status")
            if isinstance(exception_state, dict)
            else None
        )
    exception = task.get("branch_exception")
    return (
        task.get("task_id") == "GOV-0001"
        and task.get("scope_version") == 1
        and status in {"DRAFT", "REVIEW_PENDING", "APPROVED", "READY", "IN_PROGRESS"}
        and task.get("branch") == "main"
        and isinstance(exception, dict)
        and exception.get("kind") == "bootstrap-main"
        and exception.get("applies_only_to_task") == "GOV-0001"
        and not git_evidence.get("committed_sha")
    )


def _effective_status(task: Dict[str, Any]) -> Optional[str]:
    status = task.get("status")
    if status in {"BLOCKED", "FAILED", "REJECTED", "CANCELLED"}:
        exception = task.get("exception")
        if isinstance(exception, dict):
            previous = exception.get("previous_status")
            return previous if isinstance(previous, str) else None
    return status if isinstance(status, str) else None


def _requires_v2_trust_contract(task: Dict[str, Any]) -> bool:
    status = _effective_status(task)
    reviewed_states = {
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
    }
    return status in reviewed_states and not _is_legacy_bootstrap_scope_v1(task)


def _validation_contract_reasons(
    task: Dict[str, Any],
    required: Sequence[Any],
) -> List[str]:
    reasons: List[str] = []
    legacy = _is_legacy_bootstrap_scope_v1(task)
    task_units = task.get("release_units")
    units = task_units if isinstance(task_units, list) else []
    check_ids: List[str] = []
    covered_gates = set()
    for check in required:
        if not isinstance(check, dict):
            reasons.append("validation.required entries must be objects")
            continue
        check_id = check.get("id")
        if not isinstance(check_id, str) or not check_id.strip():
            reasons.append("validation check id must be a non-empty string")
        else:
            check_ids.append(check_id)
        gates = check.get("gates")
        if (
            not isinstance(gates, list)
            or not gates
            or any(gate not in VALIDATION_GATES for gate in gates)
        ):
            reasons.append("validation check gates must be known validation gates")
        else:
            covered_gates.update(gates)
        if legacy:
            command = check.get("command")
            if not isinstance(command, str) or not command.strip():
                reasons.append("legacy validation check command must be a non-empty string")
            continue
        argv = check.get("argv")
        if (
            not isinstance(argv, list)
            or not argv
            or any(not isinstance(argument, str) or not argument for argument in argv)
        ):
            reasons.append("validation check argv must be a non-empty array of exact tokens")
        timeout_seconds = check.get("timeout_seconds")
        if (
            not isinstance(timeout_seconds, (int, float))
            or isinstance(timeout_seconds, bool)
            or timeout_seconds <= 0
            or timeout_seconds > 3600
        ):
            reasons.append("validation check timeout_seconds must be in (0, 3600]")
        check_units = check.get("release_units")
        if (
            not isinstance(check_units, list)
            or not check_units
            or any(unit not in units for unit in check_units)
            or len(set(check_units)) != len(check_units)
        ):
            reasons.append(
                "validation check release_units must be unique affected release units"
            )
        unsupported = sorted(
            set(check) - {"id", "argv", "timeout_seconds", "gates", "release_units"}
        )
        if unsupported:
            reasons.append(
                "validation check contains unsupported fields: " + ", ".join(unsupported)
            )
    if len(set(check_ids)) != len(check_ids):
        reasons.append("validation check ids must be unique")
    if (
        task.get("status") in READY_OR_LATER_STATES
        and not legacy
        and not required
    ):
        reasons.append("validation.required must contain at least one check")
    missing_gates = sorted(VALIDATION_GATES - covered_gates)
    if task.get("status") in READY_OR_LATER_STATES and not legacy and missing_gates:
        reasons.append("validation plan does not cover gates: " + ", ".join(missing_gates))
    return reasons


def _review_authority_reasons(task: Dict[str, Any]) -> List[str]:
    authority = task.get("review_authority")
    if not isinstance(authority, dict):
        return ["review_authority must be a reviewed object"]
    reasons: List[str] = []
    if authority.get("scheme") != "ssh-keygen-y-v1":
        reasons.append("review_authority.scheme must be ssh-keygen-y-v1")
    identity = authority.get("identity")
    if (
        not isinstance(identity, str)
        or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}", identity) is None
    ):
        reasons.append("review_authority.identity is invalid")
    if authority.get("namespace") != REVIEW_NAMESPACE:
        reasons.append(f"review_authority.namespace must be {REVIEW_NAMESPACE}")
    public_key = authority.get("public_key")
    if (
        not isinstance(public_key, str)
        or "\n" in public_key
        or re.fullmatch(
            r"(?:ssh-ed25519|sk-ssh-ed25519@openssh\.com|rsa-sha2-512|ssh-rsa) "
            r"[A-Za-z0-9+/]+={0,3}(?: [^\r\n]+)?",
            public_key,
        )
        is None
    ):
        reasons.append("review_authority.public_key must be one OpenSSH public key line")
    fingerprint = authority.get("key_fingerprint")
    if (
        not isinstance(fingerprint, str)
        or re.fullmatch(r"SHA256:[A-Za-z0-9+/]{20,}={0,3}", fingerprint) is None
    ):
        reasons.append("review_authority.key_fingerprint must be an OpenSSH SHA256 fingerprint")
    return reasons


def _ci_trust_reasons(task: Dict[str, Any]) -> List[str]:
    trust = task.get("ci_trust")
    if not isinstance(trust, dict):
        return ["ci_trust must be a reviewed object"]
    reasons = [
        f"ci_trust.{field} must equal the project trust anchor"
        for field, expected in CI_TRUST_ANCHOR.items()
        if trust.get(field) != expected
    ]
    unsupported = sorted(set(trust) - set(CI_TRUST_ANCHOR))
    if unsupported:
        reasons.append("ci_trust contains unsupported fields: " + ", ".join(unsupported))
    return reasons


def _coordination_reasons(task: Dict[str, Any]) -> List[str]:
    units_value = task.get("release_units")
    if not isinstance(units_value, list) or len(units_value) <= 1:
        return []
    coordination = task.get("coordination")
    if not isinstance(coordination, dict):
        return ["multi-unit task requires a reviewed coordination object"]
    task_id = str(task.get("task_id", ""))
    if coordination.get("coordinator_task") != task_id:
        return ["coordination.coordinator_task must equal the current task"]
    mode = coordination.get("mode")
    if mode == "governance-bootstrap":
        if task_id != "GOV-0001" or coordination.get("no_release_artifacts") is not True:
            return [
                "governance-bootstrap coordination is limited to GOV-0001 with no release artifacts"
            ]
        rationale = coordination.get("rationale")
        return [] if isinstance(rationale, str) and rationale.strip() else [
            "governance-bootstrap coordination requires a rationale"
        ]
    if mode != "coordinated-multi":
        return ["coordination.mode must be coordinated-multi"]

    reasons: List[str] = []
    unit_set = set(str(unit) for unit in units_value)
    unit_tasks = coordination.get("unit_tasks")
    if not isinstance(unit_tasks, dict) or set(unit_tasks) != unit_set:
        reasons.append("coordination.unit_tasks must cover every affected release unit")
    elif any(
        not isinstance(value, str) or TASK_ID_RE.fullmatch(value) is None
        for value in unit_tasks.values()
    ):
        reasons.append("coordination.unit_tasks values must be task ids")
    matrix_doc = coordination.get("compatibility_matrix_doc")
    if (
        not isinstance(matrix_doc, str)
        or not matrix_doc.strip()
        or Path(matrix_doc).is_absolute()
        or ".." in Path(matrix_doc).parts
    ):
        reasons.append("coordination.compatibility_matrix_doc must be repository-relative")
    for field in ("deployment_order", "rollback_order"):
        order = coordination.get(field)
        if (
            not isinstance(order, list)
            or len(order) != len(unit_set)
            or set(order) != unit_set
        ):
            reasons.append(f"coordination.{field} must contain each affected release unit once")
    validation = task.get("validation")
    required = validation.get("required", []) if isinstance(validation, dict) else []
    declared_checks = {
        str(check.get("id")) for check in required if isinstance(check, dict)
    }
    for field in ("unit_validation_checks", "unit_rollback_checks"):
        bindings = coordination.get(field)
        if not isinstance(bindings, dict) or set(bindings) != unit_set:
            reasons.append(f"coordination.{field} must cover every affected release unit")
            continue
        for unit, check_ids in bindings.items():
            if (
                not isinstance(check_ids, list)
                or not check_ids
                or any(
                    not isinstance(check_id, str) or check_id not in declared_checks
                    for check_id in check_ids
                )
            ):
                reasons.append(
                    f"coordination.{field}.{unit} must reference declared validation checks"
                )
    return reasons


def _validate_branch_policy(repo_root: Path, task: Dict[str, Any]) -> List[str]:
    """Keep the empty-repository main-branch exception explicit and bounded."""

    reasons: List[str] = []
    branch = task.get("branch")
    base_branch = task.get("base_branch")
    if (
        task.get("status") in READY_OR_LATER_STATES
        and not isinstance(base_branch, str)
        and not _is_legacy_bootstrap_scope_v1(task)
    ):
        reasons.append("task base_branch is required from READY onward")
    if (
        isinstance(branch, str)
        and isinstance(base_branch, str)
        and branch == base_branch
        and branch != "main"
    ):
        reasons.append("non-bootstrap task branch must differ from base_branch")
    if branch != "main":
        return reasons
    try:
        project = _read_json_object(repo_root / "project-control" / "project.json")
    except GovernanceError as exc:
        return reasons + [str(exc)]
    policy = project.get("branch_policy")
    if not isinstance(policy, dict):
        return reasons + ["project branch_policy is missing"]
    bootstrap_tasks = policy.get("bootstrap_main_tasks")
    if not isinstance(bootstrap_tasks, list):
        return reasons + ["project bootstrap_main_tasks must be a list"]
    task_id = task.get("task_id")
    if bootstrap_tasks != ["GOV-0001"]:
        reasons.append("bootstrap main-branch trust root must be exactly GOV-0001")
    if task_id != "GOV-0001" or task_id not in bootstrap_tasks:
        reasons.append("only GOV-0001 is authorized for the bootstrap main-branch exception")
        return reasons
    branch_exception = task.get("branch_exception")
    if not isinstance(branch_exception, dict):
        reasons.append("main-branch task is missing its explicit branch_exception")
        return reasons
    if branch_exception.get("kind") != "bootstrap-main":
        reasons.append("main-branch task does not declare a bootstrap-main exception")
        return reasons
    if branch_exception.get("applies_only_to_task") != task_id:
        reasons.append("main-branch exception is not bound to the current task")
    return reasons


def load_snapshot(repo_root: Path) -> GovernanceSnapshot:
    reasons: List[str] = []
    task: Optional[Dict[str, Any]] = None
    review: Optional[Dict[str, Any]] = None
    review_reason: Optional[str] = None
    actual: Optional[str] = None
    try:
        actual = current_branch(repo_root)
    except GovernanceError as exc:
        reasons.append(str(exc))
    try:
        core = _load_core(repo_root)
        task = core.load_current_task(repo_root)
        if not isinstance(task, dict):
            raise GovernanceError("canonical governance core returned an invalid task")
        if task.get("bootstrap_recovery") is not None:
            active_recovery = core.active_bootstrap_recovery_contract(repo_root, task)
            if not isinstance(active_recovery, dict):
                raise GovernanceError("active bootstrap recovery contract is unavailable")
        reasons.extend(_validate_task(task))
        reasons.extend(_validate_branch_policy(repo_root, task))
    except Exception as exc:
        reasons.append(str(exc) or "current task could not be loaded")
    if task is not None:
        expected = task.get("branch")
        if actual is None:
            reasons.append("Git HEAD is detached or has no branch")
        elif isinstance(expected, str) and actual != expected:
            reasons.append(f"current branch {actual!r} does not match task branch {expected!r}")
        try:
            review, found_review_reason = core.find_effective_review(repo_root, task)
            if review is None:
                review_reason = str(found_review_reason or "no effective review receipt")
            elif not isinstance(review, dict):
                review = None
                review_reason = "canonical governance core returned an invalid review"
        except Exception as exc:
            review_reason = str(exc) or "effective review could not be loaded"
    return GovernanceSnapshot(
        repo_root=repo_root,
        task=task,
        review=review,
        actual_branch=actual,
        valid=not reasons,
        reasons=tuple(dict.fromkeys(reasons)),
        review_reason=review_reason,
    )


def normalize_repo_path(repo_root: Path, raw_path: str) -> Tuple[str, Path]:
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise GovernanceError("tool input contains an empty path")
    text = raw_path.strip().replace("\\", "/")
    candidate = Path(text)
    if candidate.is_absolute() or text.startswith("/"):
        raise GovernanceError("absolute paths are not allowed in reviewed file scope")
    if any(part in ("", ".", "..") for part in text.split("/")):
        raise GovernanceError("tool input path is not normalized")
    if text == ".git" or text.startswith(".git/"):
        raise GovernanceError("Git metadata is never an allowed file target")
    try:
        resolved = (repo_root / Path(*text.split("/"))).resolve(strict=False)
        resolved.relative_to(repo_root.resolve())
    except (OSError, RuntimeError, ValueError) as exc:
        raise GovernanceError("tool input path escapes the repository") from exc
    return text, resolved


def direct_governance_mutation_reason(relative_path: str) -> Optional[str]:
    """Return why a path may only be changed through governance commands."""

    normalized = relative_path.strip("/").replace("\\", "/").casefold()
    if normalized == ".git" or normalized.startswith(".git/"):
        return "Git metadata may never be modified directly"
    if normalized == "project-control/reviews" or normalized.startswith(
        "project-control/reviews/"
    ):
        return (
            "review receipts may not be modified directly; use the narrow reviewctl "
            "record-conversation path for explicit user dialogue decisions"
        )
    if normalized == "project-control/tasks" or normalized.startswith(
        "project-control/tasks/"
    ):
        return "task state may not be modified directly; use taskctl"
    if normalized == "project-control/current-task.json":
        return "current task selection may not be modified directly; use taskctl set-current"
    return None


def nonpatch_tool_paths(
    tool_input: Any,
    repo_root: Path,
    cwd: Path,
) -> Tuple[List[str], Optional[str]]:
    """Resolve every path-like argument for a non-read tool, or fail closed."""

    if not isinstance(tool_input, dict):
        return [], None
    raw_values: List[str] = []
    path_argument_present = False
    for key in ("path", "paths", "directory", "file_path"):
        if key not in tool_input:
            continue
        path_argument_present = True
        value = tool_input.get(key)
        if isinstance(value, str) and value.strip():
            raw_values.append(value)
        elif (
            isinstance(value, list)
            and value
            and all(isinstance(item, str) and item.strip() for item in value)
        ):
            raw_values.extend(value)
        else:
            return [], f"non-read tool argument {key!r} is not a reliably parseable path"
    if path_argument_present and not raw_values:
        return [], "non-read tool path arguments are empty"
    relative_paths: List[str] = []
    for raw_value in raw_values:
        if raw_value.startswith("~") or any(char in raw_value for char in "*?["):
            return [], f"non-read tool path is ambiguous and cannot be scoped: {raw_value!r}"
        candidate = Path(raw_value)
        possible = candidate if candidate.is_absolute() else cwd / candidate
        try:
            relative = possible.resolve(strict=False).relative_to(
                repo_root.resolve()
            ).as_posix()
        except (OSError, RuntimeError, ValueError):
            return [], f"non-read tool path is outside the repository: {raw_value!r}"
        relative_paths.append(relative)
    return list(dict.fromkeys(relative_paths)), None


def path_is_allowed(relative_path: str, allowed_paths: Sequence[Any]) -> bool:
    for raw_pattern in allowed_paths:
        if not isinstance(raw_pattern, str):
            continue
        pattern = raw_pattern.strip().replace("\\", "/")
        while pattern.startswith("./"):
            pattern = pattern[2:]
        if not pattern or pattern.startswith("/") or ".." in pattern.split("/"):
            continue
        if pattern.endswith("/**"):
            base = pattern[:-3].rstrip("/")
            if relative_path == base or relative_path.startswith(base + "/"):
                return True
        elif pattern.endswith("/"):
            base = pattern.rstrip("/")
            if relative_path == base or relative_path.startswith(base + "/"):
                return True
        elif any(char in pattern for char in "*?["):
            if fnmatch.fnmatchcase(relative_path, pattern):
                return True
        elif relative_path == pattern:
            return True
    return False


def extract_apply_patch_paths(command: str) -> List[str]:
    if not isinstance(command, str):
        raise GovernanceError("apply_patch input is missing command text")
    if "*** Begin Patch" not in command or "*** End Patch" not in command:
        raise GovernanceError("apply_patch input is not a complete patch")
    paths: List[str] = []
    header = re.compile(r"^\*\*\* (?:Add|Update|Delete) File: (.+)$")
    move = re.compile(r"^\*\*\* Move to: (.+)$")
    for line in command.splitlines():
        match = header.match(line) or move.match(line)
        if match:
            paths.append(match.group(1).strip())
    if not paths:
        raise GovernanceError("apply_patch input contains no file targets")
    return paths


def _has_shell_control(command: str) -> bool:
    quote: Optional[str] = None
    escaped = False
    for char in command:
        if escaped:
            escaped = False
            continue
        if char == "\\" and quote != "'":
            escaped = True
            continue
        if quote:
            if char == quote:
                quote = None
            elif char in ("`", "$"):
                return True
            continue
        if char in ("'", '"'):
            quote = char
        elif char in ("\n", "\r", ";", "&", "|", ">", "<", "`", "$"):
            return True
    return quote is not None or escaped


def shell_words(command: str) -> Optional[List[str]]:
    if not isinstance(command, str) or not command.strip() or _has_shell_control(command):
        return None
    try:
        words = shlex.split(command, posix=os.name != "nt")
    except ValueError:
        return None
    if os.name == "nt":
        words = [
            word[1:-1]
            if len(word) >= 2 and word[0] == word[-1] and word[0] in ("'", '"')
            else word
            for word in words
        ]
    if not words or any("\x00" in word for word in words):
        return None
    return words


def prohibited_bash_reason(command: str) -> Optional[str]:
    words = shell_words(command)
    lowered = command.lower()
    if words is None:
        return "shell control operators, substitutions, redirections, or malformed quoting are blocked"
    executable = Path(words[0]).name.lower()
    if executable in {"rm", "rmdir", "shred", "sudo", "doas"}:
        return f"destructive command {executable!r} is blocked during G0"
    if executable == "git" and len(words) > 1:
        git_words = [word.lower() for word in words[1:] if not word.startswith("-")]
        if git_words and git_words[0] in {"commit", "push"}:
            return f"git {git_words[0]} is not authorized during G0"
    blocked_fragments = (
        "--no-verify",
        "[skip ci]",
        "[ci skip]",
        "skip-ci",
        "skip_ci",
        "husky_skip_hooks",
    )
    for fragment in blocked_fragments:
        if fragment in lowered:
            return f"verification bypass marker {fragment!r} is blocked"
    return None


def _path_arg_inside_repo(repo_root: Path, cwd: Path, raw: str) -> bool:
    if raw in ("", "-") or raw.startswith("~"):
        return False
    if any(char in raw for char in "*?["):
        return False
    path = Path(raw)
    candidate = path if path.is_absolute() else cwd / path
    try:
        candidate.resolve(strict=False).relative_to(repo_root.resolve())
    except (OSError, RuntimeError, ValueError):
        return False
    return True


def _safe_git_read(words: Sequence[str]) -> bool:
    args = list(words[1:])
    while args and args[0] in {"--no-pager", "--no-optional-locks"}:
        args.pop(0)
    if not args:
        return False
    subcommand = args.pop(0)
    if subcommand in {"status", "rev-parse", "symbolic-ref", "ls-files"}:
        return not any(arg.startswith(("--exec", "--output", "--config-env")) for arg in args)
    if subcommand in {"diff", "log", "show"}:
        blocked = ("--ext-diff", "--textconv", "--output", "--exec", "--config-env")
        return not any(arg.startswith(blocked) for arg in args)
    if subcommand == "branch":
        return bool(args) and all(
            arg in {"--show-current", "--list", "-l", "--contains", "--no-contains"}
            or arg.startswith("--format=")
            for arg in args
        )
    if subcommand == "remote":
        return args in (["-v"], ["--verbose"])
    if subcommand == "config":
        return bool(args) and args[0] in {"--get", "--get-all", "--list", "-l", "--show-origin"}
    return False


def is_strict_readonly_bash(command: str, repo_root: Path, cwd: Path) -> bool:
    if prohibited_bash_reason(command) is not None:
        return False
    words = shell_words(command)
    if words is None:
        return False
    executable = Path(words[0]).name
    if executable == "pwd":
        return len(words) == 1
    if executable == "git":
        return _safe_git_read(words)
    if executable == "rg":
        return not any(
            word == "--pre"
            or word.startswith("--pre=")
            or word.startswith("--pre-glob")
            or word.startswith("--generate")
            for word in words[1:]
        )
    if executable in {"ls", "cat", "head", "tail", "wc", "stat", "file", "readlink", "realpath"}:
        if executable == "tail" and any(word in {"-f", "--follow"} or word.startswith("--follow=") for word in words[1:]):
            return False
        path_args = [word for word in words[1:] if not word.startswith("-")]
        return all(_path_arg_inside_repo(repo_root, cwd, word) for word in path_args)
    return False


def command_is_reviewed(command: str, allowed_commands: Sequence[Any]) -> bool:
    words = shell_words(command)
    if words is None:
        return False
    for allowed in allowed_commands:
        if not isinstance(allowed, str):
            continue
        allowed_words = shell_words(allowed)
        if allowed_words is not None and words == allowed_words:
            return True
        if (
            allowed_words is not None
            and len(words) == len(allowed_words)
            and words[1:] == allowed_words[1:]
            and _is_python_executable(words[0])
            and _is_python_executable(allowed_words[0])
        ):
            return True
    return False


def _is_python_executable(value: str) -> bool:
    name = value.strip().strip("'\"").replace("\\", "/").rsplit("/", 1)[-1].lower()
    return re.fullmatch(r"python(?:3(?:\.\d+)?)?(?:\.exe)?", name) is not None


def _option_values(arguments: Sequence[str], option: str) -> Optional[List[str]]:
    """Return option values, or None when an option is missing its value."""

    values: List[str] = []
    index = 0
    while index < len(arguments):
        item = arguments[index]
        if item == option:
            if index + 1 >= len(arguments) or arguments[index + 1].startswith("--"):
                return None
            values.append(arguments[index + 1])
            index += 2
            continue
        prefix = option + "="
        if item.startswith(prefix):
            value = item[len(prefix) :]
            if not value:
                return None
            values.append(value)
        index += 1
    return values


def _exact_cli_shape(
    arguments: Sequence[str],
    *,
    positional_count: int,
    required_value_options: Sequence[str],
    optional_value_options: Sequence[str] = (),
    flag_options: Sequence[str] = ("--json",),
) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """Parse a deliberately small CLI surface without executing argparse.

    Governance commands are privileged write paths.  The hook therefore
    recognizes only the final public spelling of each reachable command and
    rejects missing, repeated, or unknown arguments before delegating semantic
    checks to the CLI itself.
    """

    value_options = set(required_value_options) | set(optional_value_options)
    flags = set(flag_options)
    values: Dict[str, str] = {}
    seen_flags = set()
    positionals: List[str] = []
    index = 1
    while index < len(arguments):
        item = arguments[index]
        if item.startswith("--"):
            option, separator, inline_value = item.partition("=")
            if option in flags:
                if separator:
                    return None, f"{option} does not accept a value"
                if option in seen_flags:
                    return None, f"{option} may not be repeated"
                seen_flags.add(option)
                index += 1
                continue
            if option not in value_options:
                return None, f"unknown option {option}"
            if option in values:
                return None, f"{option} may not be repeated"
            if separator:
                value = inline_value
            else:
                if index + 1 >= len(arguments) or arguments[index + 1].startswith("--"):
                    return None, f"{option} requires a value"
                value = arguments[index + 1]
                index += 1
            if not value:
                return None, f"{option} requires a non-empty value"
            values[option] = value
            index += 1
            continue
        if item.startswith("-") or not item:
            return None, f"unexpected argument {item!r}"
        positionals.append(item)
        index += 1

    if len(positionals) != positional_count:
        return None, f"requires exactly {positional_count} positional argument(s)"
    missing = [option for option in required_value_options if option not in values]
    if missing:
        return None, "missing required option(s): " + ", ".join(missing)
    return {
        "positionals": positionals,
        "values": values,
        "flags": sorted(seen_flags),
    }, None


def _taskctl_controlled_shape(
    subcommand: str,
    arguments: Sequence[str],
) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    common_optional = ("--environment", "--release-unit", "--root")
    if subcommand == "run-validation":
        parsed, error = _exact_cli_shape(
            arguments,
            positional_count=1,
            required_value_options=("--check",),
            optional_value_options=common_optional,
        )
        if error is None and parsed is not None:
            if TASK_ID_RE.fullmatch(parsed["positionals"][0]) is None:
                return None, "task_id is invalid"
        return parsed, error
    if subcommand == "run-required":
        parsed, error = _exact_cli_shape(
            arguments,
            positional_count=1,
            required_value_options=("--phase",),
            optional_value_options=common_optional,
            flag_options=("--json", "--bootstrap-first-push"),
        )
        if error is None and parsed is not None:
            if TASK_ID_RE.fullmatch(parsed["positionals"][0]) is None:
                return None, "task_id is invalid"
            phase = parsed["values"]["--phase"]
            if phase not in {"local", "ci", "post_merge"}:
                return None, "--phase must be local, ci, or post_merge"
        return parsed, error
    if subcommand == "sync-github-run":
        parsed, error = _exact_cli_shape(
            arguments,
            positional_count=1,
            required_value_options=(
                "--phase",
                "--run-id",
                "--run-attempt",
                "--event",
                "--head-sha",
                "--actor",
            ),
            optional_value_options=("--root",),
        )
        if error is not None or parsed is None:
            return parsed, error
        values = parsed["values"]
        if TASK_ID_RE.fullmatch(parsed["positionals"][0]) is None:
            return None, "task_id is invalid"
        if values["--phase"] not in {"ci", "post_merge"}:
            return None, "--phase must be ci or post_merge"
        if values["--event"] not in {"pull_request", "push"}:
            return None, "--event must be pull_request or push"
        if re.fullmatch(r"[1-9][0-9]*", values["--run-id"]) is None:
            return None, "--run-id must be a positive decimal integer"
        if re.fullmatch(r"[1-9][0-9]*", values["--run-attempt"]) is None:
            return None, "--run-attempt must be a positive decimal integer"
        if re.fullmatch(r"[0-9a-f]{40}", values["--head-sha"]) is None:
            return None, "--head-sha must be a lowercase 40-character SHA"
        if values["--actor"] != "Codex":
            return None, "--actor must be Codex exactly"
        return parsed, None
    if subcommand in {"bootstrap-commit", "bootstrap-push"}:
        parsed, error = _exact_cli_shape(
            arguments,
            positional_count=1,
            required_value_options=("--stage", "--actor"),
            optional_value_options=("--root",),
        )
        if error is not None or parsed is None:
            return parsed, error
        values = parsed["values"]
        if parsed["positionals"] != ["GOV-0001"]:
            return None, "bootstrap Git transport is limited to GOV-0001"
        if values["--stage"] not in {"content", "control"}:
            return None, "--stage must be content or control"
        if values["--actor"] != "Codex":
            return None, "--actor must be Codex exactly"
        return parsed, None
    if subcommand in {"recover-committed", "recover-pending-content"}:
        parsed, error = _exact_cli_shape(
            arguments,
            positional_count=1,
            required_value_options=("--proposal", "--actor", "--reason"),
            optional_value_options=("--root",),
        )
        if error is not None or parsed is None:
            return parsed, error
        if parsed["positionals"] != ["GOV-0001"]:
            return None, "bootstrap recovery is limited to GOV-0001"
        if parsed["values"]["--actor"] != "Codex":
            return None, "--actor must be Codex exactly"
        return parsed, None
    if subcommand == "commit-task":
        parsed, error = _exact_cli_shape(
            arguments,
            positional_count=1,
            required_value_options=("--manifest", "--actor", "--reason"),
            optional_value_options=("--root",),
        )
        if error is not None or parsed is None:
            return parsed, error
        task_id = parsed["positionals"][0]
        if TASK_ID_RE.fullmatch(task_id) is None:
            return None, "task_id is invalid"
        if parsed["values"]["--actor"] != "Codex":
            return None, "--actor must be Codex exactly"
        manifest = parsed["values"]["--manifest"]
        if not manifest.startswith("project-control/proposals/%s-" % task_id) or not manifest.endswith(".json"):
            return None, "--manifest must name a current-task proposal JSON file"
        return parsed, None
    if subcommand in {"start-branch", "push-task", "recover-blocked"}:
        parsed, error = _exact_cli_shape(
            arguments,
            positional_count=1,
            required_value_options=("--actor", "--reason"),
            optional_value_options=("--root",),
        )
        if error is not None or parsed is None:
            return parsed, error
        if TASK_ID_RE.fullmatch(parsed["positionals"][0]) is None:
            return None, "task_id is invalid"
        if parsed["values"]["--actor"] != "Codex":
            return None, "--actor must be Codex exactly"
        return parsed, None
    return None, "controlled taskctl subcommand is not recognized"


def _reviewctl_prepare_shape(
    arguments: Sequence[str],
) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    parsed, error = _exact_cli_shape(
        arguments,
        positional_count=1,
        required_value_options=("--review-id", "--decision", "--reason"),
        optional_value_options=(
            "--kind",
            "--confirmation-source",
            "--decided-at",
            "--expires-at",
            "--supersedes",
            "--nonce",
            "--commit",
            "--check-id",
            "--phase",
            "--environment",
            "--operation-id",
            "--target-digest",
            "--root",
        ),
    )
    if error is not None or parsed is None:
        return parsed, error
    values = parsed["values"]
    if TASK_ID_RE.fullmatch(parsed["positionals"][0]) is None:
        return None, "task_id is invalid"
    if REVIEW_ID_RE.fullmatch(values["--review-id"]) is None:
        return None, "--review-id is invalid"
    if values["--decision"] not in {"approved", "rejected", "revoked", "expired"}:
        return None, "--decision is not recognized"
    if values.get("--kind", "scope") not in {
        "scope",
        "code",
        "validation_waiver",
        "irreversible_operation",
    }:
        return None, "--kind is not recognized"
    if "--phase" in values and values["--phase"] not in {"local", "ci", "post_merge"}:
        return None, "--phase must be local, ci, or post_merge"
    return parsed, None


def _reviewctl_conversation_shape(
    arguments: Sequence[str],
) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    parsed, error = _exact_cli_shape(
        arguments,
        positional_count=1,
        required_value_options=(
            "--review-id",
            "--decision",
            "--reason",
            "--confirmation-ref",
            "--confirmation-text",
            "--actor",
        ),
        optional_value_options=(
            "--kind",
            "--decided-at",
            "--expires-at",
            "--supersedes",
            "--commit",
            "--check-id",
            "--phase",
            "--environment",
            "--operation-id",
            "--target-digest",
            "--root",
        ),
    )
    if error is not None or parsed is None:
        return parsed, error
    values = parsed["values"]
    if TASK_ID_RE.fullmatch(parsed["positionals"][0]) is None:
        return None, "task_id is invalid"
    if REVIEW_ID_RE.fullmatch(values["--review-id"]) is None:
        return None, "--review-id is invalid"
    if values["--decision"] not in {"approved", "rejected", "revoked", "expired"}:
        return None, "--decision is not recognized"
    if values.get("--kind", "scope") not in {
        "scope", "code", "validation_waiver", "irreversible_operation", "rework",
    }:
        return None, "--kind is not recognized"
    if "--phase" in values and values["--phase"] not in {"local", "ci", "post_merge"}:
        return None, "--phase must be local, ci, or post_merge"
    if values["--actor"] != "Codex":
        return None, "--actor must be Codex exactly"
    return parsed, None


def _resolved_argument_path(raw: str, cwd: Path, strict: bool) -> Optional[Path]:
    candidate = Path(raw)
    if not candidate.is_absolute():
        candidate = cwd / candidate
    try:
        return candidate.resolve(strict=strict)
    except (OSError, RuntimeError):
        return None


def governance_cli_policy(
    command: str,
    repo_root: Path,
    cwd: Path,
) -> Optional[Tuple[bool, str]]:
    """Recognize narrow governance CLI calls that keep the lifecycle reachable.

    The CLI remains responsible for state-transition, review, waiver, and
    validation invariants.  This hook establishes that the exact in-repo
    script and reviewed public argument surface are used, and that Codex does
    not impersonate the user who alone may import signed receipts.
    """

    words = shell_words(command)
    if words is None or len(words) < 2:
        return None
    if not _is_python_executable(words[0]):
        return None

    script_text = words[1]
    script_name = script_text.replace("\\", "/").rsplit("/", 1)[-1].lower()
    if script_name not in {"taskctl.py", "reviewctl.py", "reconcile.py"}:
        return None
    actual_script = _resolved_argument_path(script_text, cwd, strict=True)
    expected_script = (
        repo_root / "tools" / "governance" / script_name
    ).resolve(strict=False)
    if actual_script is None or actual_script != expected_script:
        return False, f"governance CLI must use the in-repository {script_name}"

    arguments = words[2:]
    if not arguments or arguments[0].startswith("-"):
        return False, "governance CLI call is missing a subcommand"
    root_values = _option_values(arguments, "--root")
    if root_values is None or len(root_values) > 1:
        return False, "governance CLI --root is malformed or repeated"
    if root_values:
        requested_root = _resolved_argument_path(root_values[0], cwd, strict=True)
        if requested_root != repo_root.resolve():
            return False, "governance CLI --root must be the current repository"

    subcommand = arguments[0]
    if script_name == "reconcile.py":
        if subcommand not in {"session", "docs", "workflow", "static", "precommit", "ci"}:
            return False, f"reconcile profile is not permitted through Codex: {subcommand}"
        _parsed, error = _exact_cli_shape(
            arguments,
            positional_count=0,
            required_value_options=(),
            optional_value_options=("--root",),
        )
        if error is not None:
            return False, f"reconcile arguments are invalid: {error}"
        return True, "reconcile profile is read-only and lifecycle-safe"
    if script_name == "reviewctl.py":
        if subcommand in {"record", "waive"}:
            return False, (
                "legacy unsigned review entry points are disabled; use the exact "
                "reviewctl record-conversation audit path"
            )
        if subcommand == "import-signed":
            return False, (
                "Codex may not import signed review receipts; run reviewctl "
                "import-signed in a user-controlled external terminal"
            )
        if subcommand == "prepare":
            if any(
                item == "--output" or item.startswith("--output=")
                for item in arguments[1:]
            ):
                return False, (
                    "reviewctl prepare may only emit the canonical payload to stdout; "
                    "--output is user-only"
                )
            _parsed, error = _reviewctl_prepare_shape(arguments)
            if error is not None:
                return False, f"reviewctl prepare arguments are invalid: {error}"
            return True, "reviewctl prepare is a stdout-only unsigned payload query"
        if subcommand == "record-conversation":
            _parsed, error = _reviewctl_conversation_shape(arguments)
            if error is not None:
                return False, f"reviewctl record-conversation arguments are invalid: {error}"
            return True, (
                "reviewctl record-conversation records an explicit user dialogue decision "
                "without claiming cryptographic identity proof"
            )
        if subcommand in {"list", "show", "verify"}:
            return True, "read-only review query"
        return False, f"reviewctl subcommand is not permitted through Codex: {subcommand}"

    read_subcommands = {
        "current", "show", "list", "scope-hash", "prepare-recovery", "open-pr",
    }
    if subcommand in read_subcommands:
        return True, "read-only task query"
    write_subcommands = {
        "create",
        "set-current",
        "reopen",
        "revise-scope",
        "transition",
        "record-validation",
        "run-validation",
        "run-required",
        "sync-github-run",
        "bootstrap-commit",
        "bootstrap-push",
        "recover-committed",
        "recover-pending-content",
        "start-branch",
        "commit-task",
        "push-task",
        "recover-blocked",
    }
    if subcommand not in write_subcommands:
        return False, f"taskctl subcommand is not lifecycle-approved: {subcommand}"

    if subcommand in {
        "run-validation", "run-required", "sync-github-run",
        "bootstrap-commit", "bootstrap-push", "recover-committed",
        "recover-pending-content",
        "start-branch",
        "commit-task", "push-task", "recover-blocked",
    }:
        parsed, error = _taskctl_controlled_shape(subcommand, arguments)
        if error is not None:
            return False, f"taskctl {subcommand} arguments are invalid: {error}"
        if subcommand in {"recover-committed", "recover-pending-content"}:
            assert parsed is not None
            proposal = _resolved_argument_path(
                parsed["values"]["--proposal"], cwd, strict=True
            )
            expected_directory = (repo_root / "project-control" / "proposals").resolve()
            if proposal is None:
                return False, "receipt-bound recovery proposal does not exist"
            try:
                proposal.relative_to(expected_directory)
            except ValueError:
                return False, "receipt-bound recovery proposal must stay in project-control/proposals"
            return True, (
                "taskctl %s delegates the receipt-bound contract to the governance CLI"
                % subcommand
            )
        if subcommand.startswith("bootstrap-"):
            return True, f"taskctl {subcommand} uses the exact GOV-0001 Git transport path"
        if subcommand == "start-branch":
            return True, "taskctl start-branch creates only the reviewed local task branch"
        if subcommand == "commit-task":
            return True, "taskctl commit-task creates only reviewed content and protected control commits"
        if subcommand == "push-task":
            return True, "taskctl push-task permits only a non-force feature-branch fast-forward"
        if subcommand == "recover-blocked":
            return True, "taskctl recover-blocked invalidates evidence for append-only same-scope rework"
        return True, f"taskctl {subcommand} uses the controlled validation evidence path"

    if subcommand in {"create", "revise-scope"}:
        file_values = _option_values(arguments, "--file")
        if file_values is None or len(file_values) != 1:
            return False, f"taskctl {subcommand} requires exactly one --file"
        proposal = _resolved_argument_path(file_values[0], cwd, strict=True)
        if proposal is None:
            return False, "task or scope proposal file does not exist"
        try:
            proposal.relative_to(repo_root.resolve())
        except ValueError:
            return False, "task or scope proposal file must stay inside the repository"

    if subcommand != "create":
        actor_values = _option_values(arguments, "--actor")
        if actor_values is None or actor_values != ["Codex"]:
            return False, (
                f"taskctl {subcommand} must record --actor Codex exactly; "
                "Codex may not impersonate the user"
            )
    return True, f"taskctl {subcommand} delegates invariants to the governance CLI"


def tool_is_reviewed(tool_name: str, allowed_tools: Sequence[Any]) -> bool:
    wanted = tool_name.strip().lower().replace("_", "").replace("-", "")
    return any(
        wanted == str(item).strip().lower().replace("_", "").replace("-", "")
        for item in allowed_tools
    )


def safe_local_read_tool(
    tool_name: str,
    tool_input: Any,
    repo_root: Path,
    cwd: Optional[Path] = None,
) -> bool:
    exact_without_paths = {
        "codex_app__read_thread_terminal",
        "get_goal",
        "Glob",
        "Grep",
    }
    if tool_name in exact_without_paths:
        return True
    path_tools = {
        "view_image",
        "Read",
        "read_file",
        "read_text_file",
        "list_directory",
        "mcp__filesystem__read_file",
        "mcp__filesystem__read_text_file",
        "mcp__filesystem__list_directory",
        "mcp__filesystem__directory_tree",
        "mcp__filesystem__get_file_info",
        "mcp__filesystem__search_files",
    }
    if tool_name not in path_tools or not isinstance(tool_input, dict):
        return False
    values: List[str] = []
    for key in ("path", "paths", "directory", "file_path"):
        value = tool_input.get(key)
        if isinstance(value, str):
            values.append(value)
        elif isinstance(value, list) and all(isinstance(item, str) for item in value):
            values.extend(value)
    if not values:
        return False
    for value in values:
        candidate = Path(value)
        candidates = [candidate] if candidate.is_absolute() else [repo_root / candidate]
        if not candidate.is_absolute() and cwd is not None:
            candidates.append(cwd / candidate)
        inside_repository = False
        for possible in candidates:
            try:
                possible.resolve(strict=False).relative_to(repo_root.resolve())
                inside_repository = True
                break
            except (OSError, RuntimeError, ValueError):
                continue
        if not inside_repository:
            return False
    return True


def concise_reasons(reasons: Iterable[str]) -> str:
    unique = list(dict.fromkeys(reason for reason in reasons if reason))
    return "; ".join(unique[:5]) or "governance state is not valid"
