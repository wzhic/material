#!/usr/bin/env python3
"""Shared, dependency-free primitives for the repository governance tools.

The module deliberately keeps policy data in JSON.  It does not import any
application code and it never repairs state implicitly.
"""

from __future__ import annotations

import datetime as _datetime
import fnmatch
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple


SCHEMA_VERSION = 1
BOOTSTRAP_TASK_ID = "GOV-0001"
FAILED_BOOTSTRAP_ROOT_SHA = "59a285c853099b817d5fafa3a1d50ddda5ae7ce8"
FAILED_BOOTSTRAP_RUN_ID = "32221854668"
BOOTSTRAP_REPAIR_REVIEW_ID = "GOV-0001-R007"
BOOTSTRAP_REPAIR_MESSAGE = "fix(governance): restore Windows bootstrap CI"
BOOTSTRAP_REPAIR_ALLOWED_PATHS = frozenset((
    "AGENTS.md",
    "docs/governance/治理总则-GOV-0001-v1.0.md",
    "docs/governance/验证与豁免-GOV-0003-v1.0.md",
    "docs/requirements/治理基线-REQ-0001/治理基线-REQ-0001-v1.0.md",
    "docs/troubleshooting/治理门禁问题排查-TRB-0001-v1.0.md",
    "project-control/reviews/GOV-0001-R007.json",
    "project-control/tasks/GOV-0001.json",
    "tools/governance/core.py",
    "tools/governance/reconcile.py",
    "tools/governance/taskctl.py",
    "tools/governance/tests/test_bootstrap_git.py",
    "tools/governance/tests/test_core.py",
    "tools/governance/tests/test_reconcile_ci_static.py",
))
FAILED_BOOTSTRAP_REPAIR_SHA = "7b18bb4c0b3cc42e078acf5351a19f6760beea0f"
FAILED_BOOTSTRAP_REPAIR_RUN_ID = "32223213198"
SECOND_BOOTSTRAP_REPAIR_REVIEW_ID = "GOV-0001-R009"
SECOND_BOOTSTRAP_REPAIR_MESSAGE = "fix(governance): harden Windows bootstrap runtime"
SECOND_BOOTSTRAP_REPAIR_ALLOWED_PATHS = frozenset((
    "AGENTS.md",
    "docs/governance/治理总则-GOV-0001-v1.0.md",
    "docs/governance/验证与豁免-GOV-0003-v1.0.md",
    "docs/requirements/治理基线-REQ-0001/治理基线-REQ-0001-v1.0.md",
    "docs/troubleshooting/治理门禁问题排查-TRB-0001-v1.0.md",
    "project-control/reviews/GOV-0001-R008.json",
    "project-control/reviews/GOV-0001-R009.json",
    "project-control/tasks/GOV-0001.json",
    "tools/governance/core.py",
    "tools/governance/reconcile.py",
    "tools/governance/reviewctl.py",
    "tools/governance/taskctl.py",
    "tools/governance/tests/test_bootstrap_git.py",
    "tools/governance/tests/test_core.py",
    "tools/governance/tests/test_reconcile_ci_static.py",
))

NORMAL_STATES: Tuple[str, ...] = (
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
EXCEPTION_STATES: Tuple[str, ...] = ("BLOCKED", "FAILED", "REJECTED", "CANCELLED")
TASK_STATES = frozenset(NORMAL_STATES + EXCEPTION_STATES)
REVIEW_DECISIONS = frozenset(("approved", "rejected", "revoked", "expired"))
VALIDATION_STATUSES = frozenset(("passed", "failed", "blocked", "skipped"))
VALIDATION_PHASES = frozenset(("local", "ci", "post_merge"))
GATE_PHASES = {
    "LOCAL_VERIFIED": "local",
    "CI_VERIFIED": "ci",
    "POST_MERGE_VERIFIED": "post_merge",
}
PHASE_GATES = {phase: gate for gate, phase in GATE_PHASES.items()}
TASK_ID_PATTERN = re.compile(r"^[A-Z][A-Z0-9]*(?:-[A-Z0-9][A-Z0-9]*)+$")
REVIEW_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$")
COMMIT_PATTERN = re.compile(r"^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$")
TARGET_DIGEST_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]*:[A-Fa-f0-9]{32,128}$")
_SUBTASK_SENSITIVE_TEXT_PATTERNS: Tuple[Tuple[str, re.Pattern[str]], ...] = (
    (
        "private key material",
        re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----", re.IGNORECASE),
    ),
    (
        "provider credential",
        re.compile(
            r"(?:\bAKIA[0-9A-Z]{16}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|"
            r"\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bsk-[A-Za-z0-9_-]{20,}\b)"
        ),
    ),
    (
        "assigned secret",
        re.compile(
            r"\b(?:api[ _-]?key|access[ _-]?token|client[ _-]?secret|password|passwd)"
            r"\s*[:=：]\s*[\"']?[^\s\"']{8,}",
            re.IGNORECASE,
        ),
    ),
    (
        "authorization credential",
        re.compile(r"\bauthorization\s*[:=]\s*bearer\s+\S+", re.IGNORECASE),
    ),
    (
        "prompt or internal reasoning",
        re.compile(
            r"(?:\b(?:system|developer)\s+prompt\s*[:=]|"
            r"(?:系统|开发者|完整|原始)?提示词\s*[:：=]|"
            r"(?:内部推理|思维链|chain[ -]of[ -]thought)\s*[:：=])",
            re.IGNORECASE,
        ),
    ),
)

LEGACY_RECORD_DISABLED = (
    "LEGACY_RECORD_DISABLED: use reviewctl record-conversation with an explicit user "
    "conversation reference; legacy record/waive cannot create governance receipts"
)
_LEGACY_G0_R001_CANONICAL_SHA256 = (
    "7a633901df8677250c399ff3702807bc3f82f5de8e7e587c3280d27b8c6d84e8"
)

CONVERSATION_APPROVAL_MODE = "conversation-v1"
CONVERSATION_CONFIRMATION_SOURCE = "codex-conversation"
CONVERSATION_RECEIPT_SCHEMA_VERSION = 3
CONVERSATION_MIGRATION_RECEIPT_ID = "GOV-0001-R003"
CONVERSATION_MIGRATION_PAYLOAD_SHA256 = (
    "sha256:80b72baede7e7e81c06e095d9e88ea87209d764a2e8977b7b85b85fc850e8b15"
)
CONVERSATION_MIGRATION_RECEIPT_SHA256 = (
    "sha256:e69a6208c58999a7c69389fbd27318c1bd9ae88dc89c6a5034f363f276dfa6d8"
)
CONVERSATION_REVIEW_POLICY = {
    "approvers": ["user"],
    "agent_may_approve": False,
    "skip_requires_user_receipt": True,
    "scope_change_invalidates_approval": True,
    "approval_mode": CONVERSATION_APPROVAL_MODE,
    "cryptographic_identity_proof": False,
    "requires_explicit_user_message": True,
    "migration_receipt_id": CONVERSATION_MIGRATION_RECEIPT_ID,
    "migration_payload_sha256": CONVERSATION_MIGRATION_PAYLOAD_SHA256,
}

_CONVERSATION_COMMON_FIELDS = frozenset((
    "schema_version",
    "approval_mode",
    "review_id",
    "project_id",
    "source_repository",
    "task_id",
    "kind",
    "decision",
    "approver",
    "recorded_by",
    "reason",
    "confirmation_source",
    "confirmation_ref",
    "confirmation_text",
    "scope_version",
    "scope_hash",
    "decided_at",
    "expires_at",
    "supersedes",
))
_CONVERSATION_KIND_FIELDS = {
    "scope": frozenset(),
    "code": frozenset(("commit",)),
    "validation_waiver": frozenset((
        "check_id", "phase", "subject", "environment", "max_gate",
    )),
    "irreversible_operation": frozenset(("operation_id", "target_digest")),
    "rework": frozenset(("subject", "from_status")),
    "final_action": frozenset(("action", "subject")),
}

_SUBJECT_EXCLUDED_EXACT = frozenset((
    "project-control/current-task.json",
    ".coverage",
))
_SUBJECT_EXCLUDED_PARTS = frozenset((
    ".git",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".tox",
    ".nox",
    ".venv",
    "venv",
    "node_modules",
    "htmlcov",
))
SCOPE_EDITABLE_FIELDS: Tuple[str, ...] = (
    "requirement",
    "summary",
    "release_units",
    "branch",
    "base_branch",
    "allowed_paths",
    "allowed_commands",
    "allowed_tools",
    "dependencies",
    "required_docs",
    "validation",
    "assumptions",
    "open_questions",
    "review_authority",
    "ci_trust",
    "coordination",
)

REVIEW_NAMESPACE = "material-governance-review"
GITHUB_REPOSITORY = "wzhic/material"
PROJECT_ID = "material"
SOURCE_REPOSITORY = "git@github.com:wzhic/material.git"
GITHUB_WORKFLOW_PATH = ".github/workflows/governance.yml"
GITHUB_API_BASE = "https://api.github.com"
GITHUB_API_VERSION = "2026-03-10"
GITHUB_TOKEN_ENV = "MATERIAL_GITHUB_ACTIONS_READ_TOKEN"
GITHUB_REQUIRED_JOBS = {
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
}

_NORMAL_NEXT = {
    state: NORMAL_STATES[index + 1]
    for index, state in enumerate(NORMAL_STATES[:-1])
}


class GovernanceError(Exception):
    """A user-correctable governance or state error."""


def validate_task_id(task_id: Any) -> str:
    """Return a safe task id or fail before it can be used in a path."""

    if not isinstance(task_id, str) or not TASK_ID_PATTERN.fullmatch(task_id):
        raise GovernanceError(
            "task_id must use uppercase alphanumeric segments separated by hyphens"
        )
    return task_id


def validate_review_id(review_id: Any) -> str:
    if not isinstance(review_id, str) or not REVIEW_ID_PATTERN.fullmatch(review_id):
        raise GovernanceError("review_id contains unsupported characters")
    return review_id


def normalize_commit(value: Any, field: str = "commit") -> str:
    if not isinstance(value, str) or not COMMIT_PATTERN.fullmatch(value):
        raise GovernanceError("%s must be a 40 or 64 character hexadecimal commit id" % field)
    return value.lower()


def validate_target_digest(value: Any) -> str:
    if not isinstance(value, str) or not TARGET_DIGEST_PATTERN.fullmatch(value):
        raise GovernanceError("target_digest must be an algorithm-prefixed hexadecimal digest")
    return value


def utc_now() -> str:
    return _datetime.datetime.now(_datetime.timezone.utc).replace(microsecond=0).isoformat()


def parse_timestamp(value: Optional[str]) -> Optional[_datetime.datetime]:
    if not value:
        return None
    if not isinstance(value, str):
        raise GovernanceError("timestamp must be a string")
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = _datetime.datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise GovernanceError("invalid timestamp: %s" % value) from exc
    if parsed.tzinfo is None:
        raise GovernanceError("timestamp must include a timezone: %s" % value)
    return parsed.astimezone(_datetime.timezone.utc)


def default_root() -> Path:
    return Path(__file__).resolve().parents[2]


def control_dir(root: Path) -> Path:
    return root.resolve() / "project-control"


def _contained_path(directory: Path, filename: str) -> Path:
    base = directory.resolve()
    destination = (base / filename).resolve()
    try:
        destination.relative_to(base)
    except ValueError as exc:
        raise GovernanceError("state path escapes its expected directory") from exc
    return destination


def read_json(path: Path) -> Dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8") as handle:
            value = json.load(handle)
    except FileNotFoundError as exc:
        raise GovernanceError("required state file is missing: %s" % path) from exc
    except json.JSONDecodeError as exc:
        raise GovernanceError("invalid JSON in %s: %s" % (path, exc)) from exc
    except (OSError, UnicodeError) as exc:
        raise GovernanceError("cannot read state file %s: %s" % (path, exc)) from exc
    if not isinstance(value, dict):
        raise GovernanceError("top-level JSON value must be an object: %s" % path)
    return value


def write_json_atomic(path: Path, value: Mapping[str, Any]) -> None:
    """Write one state file atomically; callers must have already authorized it."""

    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=".%s." % path.name, suffix=".tmp", dir=str(path.parent)
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, str(path))
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)


def write_json_exclusive_atomic(path: Path, value: Mapping[str, Any]) -> None:
    """Atomically create one JSON file and never replace an existing receipt."""

    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=".%s." % path.name, suffix=".tmp", dir=str(path.parent)
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.link(str(temporary), str(path))
        except FileExistsError as exc:
            raise GovernanceError("review receipt already exists: %s" % path.name) from exc
        except OSError as exc:
            raise GovernanceError("cannot atomically create review receipt: %s" % exc) from exc
    finally:
        try:
            temporary.unlink()
        except OSError:
            pass


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def subtask_sensitive_text_reason(value: str) -> Optional[str]:
    """Return a bounded reason when a subtask summary resembles forbidden data."""

    if not isinstance(value, str):
        return None
    for label, pattern in _SUBTASK_SENSITIVE_TEXT_PATTERNS:
        if pattern.search(value):
            return label
    return None


def conversation_approval_policy_issues(project: Mapping[str, Any]) -> List[str]:
    """Return drift in the user-confirmed dialogue-only approval contract."""

    policy = project.get("review_policy")
    if not isinstance(policy, Mapping):
        return ["project.review_policy must be an object"]
    issues = [
        "project.review_policy.%s must equal %r" % (field, expected)
        for field, expected in CONVERSATION_REVIEW_POLICY.items()
        if policy.get(field) != expected
    ]
    unsupported = sorted(set(policy) - set(CONVERSATION_REVIEW_POLICY))
    if unsupported:
        issues.append(
            "project.review_policy contains unsupported fields: %s" % ", ".join(unsupported)
        )
    return issues


def canonical_scope(task: Mapping[str, Any]) -> Dict[str, Any]:
    """Return only review-bound fields.

    Runtime state, history, validation results and Git evidence are excluded so
    normal progress cannot invalidate approval.  Changing the plan or any
    permission does invalidate it.
    """

    validation = task.get("validation", {})
    required_validation = validation.get("required", []) if isinstance(validation, dict) else []
    scope = {
        "task_id": task.get("task_id"),
        "scope_version": task.get("scope_version"),
        "requirement": task.get("requirement"),
        "summary": task.get("summary"),
        "release_units": task.get("release_units", []),
        "branch": task.get("branch"),
        "allowed_paths": task.get("allowed_paths", []),
        "allowed_commands": task.get("allowed_commands", []),
        "allowed_tools": task.get("allowed_tools", []),
        "dependencies": task.get("dependencies", []),
        "required_docs": task.get("required_docs", []),
        "validation_required": required_validation,
        "assumptions": task.get("assumptions", []),
        "open_questions": task.get("open_questions", []),
    }
    # Legacy bootstrap tasks predate base_branch.  Omit the key only until the
    # next explicit scope revision so loading the old scope does not silently
    # invalidate its receipt; READY still requires the reviewed field.
    if "base_branch" in task:
        scope["base_branch"] = task.get("base_branch")
    for field in ("review_authority", "ci_trust", "coordination"):
        if field in task:
            scope[field] = task.get(field)
    return scope


def canonical_scope_hash(task: Mapping[str, Any]) -> str:
    return "sha256:" + hashlib.sha256(canonical_json(canonical_scope(task)).encode("utf-8")).hexdigest()


def task_path(root: Path, task_id: str) -> Path:
    safe_id = validate_task_id(task_id)
    repository = root.resolve()
    controls = control_dir(root).resolve()
    tasks = (controls / "tasks").resolve()
    try:
        controls.relative_to(repository)
        tasks.relative_to(controls)
    except ValueError as exc:
        raise GovernanceError("task state directory escapes the repository control directory") from exc
    return _contained_path(tasks, safe_id + ".json")


def review_path(root: Path, review_id: str) -> Path:
    safe_id = validate_review_id(review_id)
    repository = root.resolve()
    controls = control_dir(root).resolve()
    reviews = (controls / "reviews").resolve()
    try:
        controls.relative_to(repository)
        reviews.relative_to(controls)
    except ValueError as exc:
        raise GovernanceError("review state directory escapes the repository control directory") from exc
    return _contained_path(reviews, safe_id + ".json")


def load_task(root: Path, task_id: str) -> Dict[str, Any]:
    task = read_json(task_path(root, task_id))
    validate_task(task)
    if task.get("task_id") != task_id:
        raise GovernanceError("task_id does not match filename: %s" % task_id)
    return task


def current_task_id(root: Path) -> str:
    current = read_json(control_dir(root) / "current-task.json")
    task_id = current.get("task_id")
    try:
        return validate_task_id(task_id)
    except GovernanceError as exc:
        raise GovernanceError("current-task.json contains an invalid task_id: %s" % exc) from exc


def load_current_task(root: Path) -> Dict[str, Any]:
    return load_task(root, current_task_id(root))


def recovery_proposal_path(root: Path, relative_path: Any) -> Path:
    """Resolve one machine-readable recovery proposal inside the proposal registry."""

    if not isinstance(relative_path, str) or not relative_path.strip():
        raise GovernanceError("bootstrap recovery proposal_path must be a non-empty string")
    normalized = relative_path.strip().replace("\\", "/")
    prefix = "project-control/proposals/"
    if not normalized.startswith(prefix) or not normalized.endswith(".json"):
        raise GovernanceError("bootstrap recovery proposal must be a JSON file in project-control/proposals")
    candidate = (root.resolve() / normalized).resolve()
    proposals = (control_dir(root) / "proposals").resolve()
    try:
        candidate.relative_to(proposals)
    except ValueError as exc:
        raise GovernanceError("bootstrap recovery proposal escapes project-control/proposals") from exc
    return candidate


def recovery_contract_digest(contract: Mapping[str, Any]) -> str:
    return "sha256:" + hashlib.sha256(canonical_json(contract).encode("utf-8")).hexdigest()


def validate_bootstrap_recovery_contract(
    root: Path,
    task: Mapping[str, Any],
    contract: Mapping[str, Any],
    *,
    expected_digest: Optional[str] = None,
    approval_at: Optional[_datetime.datetime] = None,
) -> Dict[str, Any]:
    """Validate a user-digested, one-operation bootstrap recovery contract."""

    base_fields = frozenset((
        "allowed_paths",
        "commit_message",
        "failed_content_sha",
        "failed_control_head",
        "failed_run_id",
        "from_previous_status",
        "from_status",
        "invariants",
        "operation_id",
        "review_id",
        "schema_version",
        "scope_version",
        "task_id",
    ))
    schema_version = contract.get("schema_version")
    if schema_version == 1:
        required_fields = base_fields
    elif schema_version == 2:
        required_fields = base_fields | frozenset((
            "expected_history_count",
            "failure_stage",
            "rework_review_id",
        ))
    else:
        raise GovernanceError("bootstrap recovery contract schema_version must be 1 or 2")
    if set(contract) != required_fields:
        missing = sorted(required_fields - set(contract))
        extra = sorted(set(contract) - required_fields)
        details = []
        if missing:
            details.append("missing %s" % ", ".join(missing))
        if extra:
            details.append("unsupported %s" % ", ".join(extra))
        raise GovernanceError("bootstrap recovery contract fields are invalid: %s" % "; ".join(details))
    if contract.get("task_id") != task.get("task_id"):
        raise GovernanceError("bootstrap recovery contract belongs to another task")
    if contract.get("scope_version") != task.get("scope_version"):
        raise GovernanceError("bootstrap recovery contract scope_version is stale")
    if schema_version == 1:
        if (
            contract.get("from_status") != "BLOCKED"
            or contract.get("from_previous_status") != "COMMITTED"
        ):
            raise GovernanceError("schema v1 recovery must bind BLOCKED from COMMITTED")
    else:
        if contract.get("failure_stage") != "content_ci_pending":
            raise GovernanceError("schema v2 recovery failure_stage must be content_ci_pending")
        if (
            contract.get("from_status") != "BLOCKED"
            or contract.get("from_previous_status") != "LOCAL_VERIFIED"
        ):
            raise GovernanceError(
                "pending-content recovery must bind BLOCKED from LOCAL_VERIFIED"
            )
        validate_review_id(contract.get("rework_review_id"))
        expected_count = contract.get("expected_history_count")
        if (
            not isinstance(expected_count, int)
            or isinstance(expected_count, bool)
            or expected_count < 1
        ):
            raise GovernanceError("pending-content recovery expected_history_count must be positive")
    validate_review_id(contract.get("review_id"))
    operation_id = contract.get("operation_id")
    if not isinstance(operation_id, str) or not operation_id.strip():
        raise GovernanceError("bootstrap recovery operation_id must be non-empty")
    failed_content = normalize_commit(contract.get("failed_content_sha"), "failed_content_sha")
    failed_head = normalize_commit(contract.get("failed_control_head"), "failed_control_head")
    if schema_version == 1 and failed_content == failed_head:
        raise GovernanceError("bootstrap recovery content and control commits must be distinct")
    if schema_version == 2 and failed_content != failed_head:
        raise GovernanceError(
            "pending-content recovery must bind the same failed content and current head"
        )
    failed_run_id = contract.get("failed_run_id")
    if not isinstance(failed_run_id, str) or not re.fullmatch(r"[1-9][0-9]*", failed_run_id):
        raise GovernanceError("bootstrap recovery failed_run_id must be a positive decimal id")
    message = contract.get("commit_message")
    if not isinstance(message, str) or not message.strip() or "\n" in message or "\r" in message:
        raise GovernanceError("bootstrap recovery commit_message must be one non-empty line")
    allowed_paths = contract.get("allowed_paths")
    if (
        not isinstance(allowed_paths, list)
        or not allowed_paths
        or len(set(allowed_paths)) != len(allowed_paths)
        or any(
            not isinstance(path, str)
            or not path.strip()
            or path.startswith("/")
            or ".." in path.replace("\\", "/").split("/")
            or any(char in path for char in "*?[")
            for path in allowed_paths
        )
    ):
        raise GovernanceError("bootstrap recovery allowed_paths must be unique exact repository paths")
    outside_scope = sorted(
        path for path in allowed_paths
        if not path_is_allowed(root, path, task.get("allowed_paths", []))
    )
    if outside_scope:
        raise GovernanceError(
            "bootstrap recovery paths are outside the reviewed task scope: %s"
            % ", ".join(outside_scope)
        )
    invariants = contract.get("invariants")
    required_invariants = frozenset((
        "no_validation_waiver",
        "no_force_push",
        "preserve_existing_history",
        "controlled_local_validation_required",
        "three_platform_ci_required",
        "no_business_code_or_dependency_files",
    ))
    if not isinstance(invariants, list) or frozenset(invariants) != required_invariants:
        raise GovernanceError("bootstrap recovery contract is missing a required safety invariant")
    digest = recovery_contract_digest(contract)
    if expected_digest is not None and digest != validate_target_digest(expected_digest):
        raise GovernanceError("bootstrap recovery proposal digest does not match its activation record")
    if approval_at is None:
        receipt, reason = find_effective_irreversible_operation_review(
            root,
            task,
            str(operation_id),
            digest,
        )
    else:
        matching = [
            item for item in list_reviews(root, str(task.get("task_id")))
            if item.get("review_id") == contract.get("review_id")
            and item.get("kind") == "irreversible_operation"
            and item.get("operation_id") == operation_id
            and item.get("target_digest") == digest
            and item.get("scope_hash") == canonical_scope_hash(task)
        ]
        receipt = matching[0] if len(matching) == 1 else None
        if receipt is None:
            reason = "consumed recovery receipt is missing or ambiguous"
        else:
            valid, reason = review_validity(receipt, task, now=approval_at, root=root)
            if not valid:
                receipt = None
    if receipt is None or receipt.get("review_id") != contract.get("review_id"):
        raise GovernanceError("bootstrap recovery has no matching user receipt: %s" % reason)
    normalized = dict(contract)
    normalized["failed_content_sha"] = failed_content
    normalized["failed_control_head"] = failed_head
    normalized["target_digest"] = digest
    return normalized


def active_bootstrap_recovery_contract(
    root: Path,
    task: Optional[Mapping[str, Any]] = None,
) -> Optional[Dict[str, Any]]:
    """Return the active receipt-bound recovery contract, or fail on drift."""

    selected = task if task is not None else load_current_task(root)
    marker = selected.get("bootstrap_recovery")
    if marker is None:
        return None
    if not isinstance(marker, Mapping) or marker.get("state") not in ("active", "consumed"):
        raise GovernanceError("bootstrap_recovery must be active or consumed while present")
    approval_at = None
    if marker.get("state") == "consumed":
        approval_at = parse_timestamp(marker.get("consumed_at"))
        if approval_at is None:
            raise GovernanceError("consumed bootstrap recovery is missing consumed_at")
    proposal = recovery_proposal_path(root, marker.get("proposal_path"))
    contract = read_json(proposal)
    normalized = validate_bootstrap_recovery_contract(
        root,
        selected,
        contract,
        expected_digest=marker.get("target_digest"),
        approval_at=approval_at,
    )
    binding_fields = (
        "review_id",
        "operation_id",
        "failed_content_sha",
        "failed_control_head",
        "failed_run_id",
    )
    drift = [field for field in binding_fields if marker.get(field) != normalized.get(field)]
    if drift:
        raise GovernanceError(
            "bootstrap recovery activation drifted from its proposal: %s" % ", ".join(drift)
        )
    history_count = marker.get("history_count")
    if not isinstance(history_count, int) or isinstance(history_count, bool) or history_count < 1:
        raise GovernanceError("bootstrap recovery history_count must be a positive integer")
    if normalized.get("schema_version") == 2 and (
        history_count != normalized.get("expected_history_count")
    ):
        raise GovernanceError(
            "pending-content recovery history_count differs from the reviewed proposal"
        )
    if marker.get("state") == "consumed":
        consumed_content = normalize_commit(
            marker.get("consumed_content_sha"),
            "bootstrap_recovery.consumed_content_sha",
        )
        consumed_head = normalize_commit(
            marker.get("consumed_control_head"),
            "bootstrap_recovery.consumed_control_head",
        )
        consumed_run = str(marker.get("consumed_run_id"))
        if selected.get("git", {}).get("committed_sha") != consumed_content:
            raise GovernanceError("consumed recovery content SHA differs from task.git.committed_sha")
        matching_results = [
            result for result in selected.get("validation", {}).get("results", [])
            if isinstance(result, Mapping)
            and result.get("status") == "passed"
            and result.get("phase") == "ci"
            and result.get("source") == "github_actions_rest_v1"
            and result.get("run_id") == consumed_run
            and result.get("subject") == "commit:" + consumed_content
            and isinstance(result.get("github"), Mapping)
            and result["github"].get("control_head_sha") == consumed_head
        ]
        if not matching_results:
            raise GovernanceError(
                "consumed bootstrap recovery has no matching REST-verified CI evidence"
            )
    normalized["history_count"] = history_count
    normalized["proposal_path"] = marker.get("proposal_path")
    normalized["authorization_kind"] = "irreversible_operation"
    normalized["recovery_state"] = marker.get("state")
    normalized["parent_sha"] = normalized["failed_control_head"]
    normalized["message"] = normalized["commit_message"]
    return normalized


def _git_candidates() -> List[str]:
    """Return Git candidates in preference order, including Codex fallbacks."""

    candidates: List[str] = []
    configured = os.environ.get("GOVERNANCE_GIT")
    discovered = shutil.which("git")
    runtime_roots: List[Path] = []
    try:
        home = Path.home()
    except (OSError, RuntimeError):
        # Windows services and deliberately minimal CI subprocesses may have
        # neither HOME nor USERPROFILE. Git discovery must keep using PATH and
        # the active Python runtime instead of crashing before a candidate runs.
        home = None
    if home is not None:
        runtime_roots.append(
            home / ".cache" / "codex-runtimes" / "codex-primary-runtime" / "dependencies"
        )
    for parent in Path(sys.executable).resolve().parents:
        if parent.name == "dependencies" and parent not in runtime_roots:
            runtime_roots.append(parent)
    fallback_paths: List[Path] = []
    for runtime_root in runtime_roots:
        fallback_paths.extend((
            runtime_root / "bin" / "fallback" / "git",
            runtime_root / "bin" / "fallback" / "git.exe",
            runtime_root / "git" / "bin" / "git",
            runtime_root / "git" / "bin" / "git.exe",
            runtime_root / "bin" / "git",
            runtime_root / "bin" / "git.exe",
        ))
    for candidate in (configured, discovered) + tuple(
        str(path) for path in fallback_paths if path.is_file()
    ):
        if candidate and candidate not in candidates:
            candidates.append(candidate)
    return candidates


_WORKING_GIT_BY_CANDIDATES: Dict[Tuple[str, ...], str] = {}


def run_git(
    root: Path,
    arguments: Sequence[str],
    *,
    input_text: Optional[str] = None,
) -> Tuple[Optional[str], Optional[str]]:
    """Run Git with portable fallbacks; every candidate may fail independently."""

    candidates = _git_candidates()
    if not candidates:
        return None, "git executable was not found"
    candidate_key = tuple(candidates)
    preferred = _WORKING_GIT_BY_CANDIDATES.get(candidate_key)
    if preferred in candidates:
        candidates = [preferred] + [candidate for candidate in candidates if candidate != preferred]
    errors: List[str] = []
    for executable in candidates:
        try:
            completed = subprocess.run(
                [executable, "-c", "core.quotepath=false"] + list(arguments),
                cwd=str(root),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="strict",
                input=input_text,
                check=False,
            )
        except OSError as exc:
            errors.append("%s: %s" % (executable, exc))
            if executable == preferred:
                _WORKING_GIT_BY_CANDIDATES.pop(candidate_key, None)
            continue
        if completed.returncode == 0:
            _WORKING_GIT_BY_CANDIDATES[candidate_key] = executable
            return completed.stdout.strip(), None
        if executable == preferred:
            _WORKING_GIT_BY_CANDIDATES.pop(candidate_key, None)
        errors.append(completed.stderr.strip() or "%s exited %s" % (executable, completed.returncode))
    return None, "; ".join(errors)


def bootstrap_repair_contracts() -> Tuple[Mapping[str, Any], ...]:
    """Return the finite, immutable-in-practice bootstrap recovery chain."""

    return (
        {
            "parent_sha": FAILED_BOOTSTRAP_ROOT_SHA,
            "history_count": 1,
            "failed_run_id": FAILED_BOOTSTRAP_RUN_ID,
            "review_id": BOOTSTRAP_REPAIR_REVIEW_ID,
            "message": BOOTSTRAP_REPAIR_MESSAGE,
            "allowed_paths": BOOTSTRAP_REPAIR_ALLOWED_PATHS,
        },
        {
            "parent_sha": FAILED_BOOTSTRAP_REPAIR_SHA,
            "history_count": 2,
            "failed_run_id": FAILED_BOOTSTRAP_REPAIR_RUN_ID,
            "review_id": SECOND_BOOTSTRAP_REPAIR_REVIEW_ID,
            "message": SECOND_BOOTSTRAP_REPAIR_MESSAGE,
            "allowed_paths": SECOND_BOOTSTRAP_REPAIR_ALLOWED_PATHS,
        },
    )


def bootstrap_repair_contract_for_parent(parent: str) -> Optional[Mapping[str, Any]]:
    normalized = str(parent).strip().lower()
    for contract in bootstrap_repair_contracts():
        if contract["parent_sha"] == normalized:
            return contract
    return None


def bootstrap_recovery_contract_for_parent(
    root: Path,
    parent: str,
    task: Optional[Mapping[str, Any]] = None,
) -> Optional[Mapping[str, Any]]:
    """Resolve a historical finite repair or the active receipt-bound recovery."""

    static = bootstrap_repair_contract_for_parent(parent)
    if static is not None:
        return static
    active = active_bootstrap_recovery_contract(root, task)
    if active is not None and active.get("failed_control_head") == str(parent).strip().lower():
        return active
    return None


def bootstrap_repair_commit_issues(
    root: Path,
    commit: str,
    task: Optional[Mapping[str, Any]] = None,
) -> List[str]:
    """Validate one exact, non-force child in a reviewed G0 recovery chain."""

    normalized = str(commit).strip().lower()
    issues: List[str] = []
    if not re.fullmatch(r"[0-9a-f]{40}", normalized):
        return ["bootstrap repair subject must be a distinct 40-character commit"]
    parents, parents_error = run_git(root, ("rev-list", "--parents", "-n", "1", normalized))
    words = (parents or "").split()
    if parents_error or len(words) != 2 or words[0] != normalized:
        return ["bootstrap repair must have exactly one reviewed failed parent"]
    parent = words[1]
    try:
        contract = bootstrap_recovery_contract_for_parent(root, parent, task)
    except GovernanceError as exc:
        return ["bootstrap recovery contract is invalid: %s" % exc]
    if contract is None:
        return ["bootstrap repair parent has no finite or receipt-bound recovery contract"]
    dynamic = contract.get("authorization_kind") == "irreversible_operation"
    if dynamic:
        failed_content = str(contract.get("failed_content_sha", ""))
        _coverage, coverage_error = run_git(
            root,
            ("merge-base", "--is-ancestor", failed_content, parent),
        )
        if coverage_error:
            issues.append(
                "receipt-bound recovery control head does not contain its failed content commit: %s"
                % coverage_error
            )
    elif parent == FAILED_BOOTSTRAP_ROOT_SHA:
        root_line, root_error = run_git(
            root, ("rev-list", "--parents", "-n", "1", FAILED_BOOTSTRAP_ROOT_SHA)
        )
        if root_error or (root_line or "").split() != [FAILED_BOOTSTRAP_ROOT_SHA]:
            issues.append("recorded failed bootstrap commit is unavailable or is not the repository root")
    else:
        prior_issues = bootstrap_repair_commit_issues(root, parent, task)
        if prior_issues:
            issues.append(
                "bootstrap repair parent does not satisfy the preceding reviewed recovery: %s"
                % "; ".join(prior_issues)
            )
    message, message_error = run_git(root, ("show", "-s", "--format=%s", normalized))
    if message_error or message != contract["message"]:
        issues.append("bootstrap repair commit message is not the fixed reviewed message")
    changed, changed_error = run_git(
        root,
        ("diff", "--name-only", "-z", parent + ".." + normalized),
    )
    if changed_error:
        issues.append("bootstrap repair paths cannot be inspected: %s" % changed_error)
    else:
        paths = [path for path in (changed or "").split("\0") if path]
        if not paths:
            issues.append("bootstrap repair commit may not be empty")
        outside = sorted(set(paths) - set(contract["allowed_paths"]))
        if outside:
            issues.append(
                "bootstrap repair changes paths outside the %s allowlist: %s"
                % (contract["review_id"], ", ".join(outside))
            )
    return issues


def current_branch(root: Path) -> Tuple[Optional[str], Optional[str]]:
    branch, error = run_git(root, ("symbolic-ref", "--quiet", "--short", "HEAD"))
    if branch:
        return branch, None
    # A pure-filesystem fallback keeps branch checks available on machines
    # where the system Git launcher is unusable (for example, an unaccepted
    # Xcode license) and for an unborn repository.  It also supports worktrees
    # whose .git entry is a gitdir pointer file.
    git_entry = root.resolve() / ".git"
    git_directory = git_entry
    try:
        if git_entry.is_file():
            pointer = git_entry.read_text(encoding="utf-8").strip()
            if not pointer.startswith("gitdir:"):
                return None, "invalid .git pointer file"
            raw_directory = pointer.split(":", 1)[1].strip()
            candidate = Path(raw_directory)
            git_directory = candidate if candidate.is_absolute() else (root / candidate).resolve()
        head = (git_directory / "HEAD").read_text(encoding="utf-8").strip()
    except OSError as exc:
        return None, error or "cannot read Git HEAD: %s" % exc
    prefix = "ref: refs/heads/"
    if head.startswith(prefix) and len(head) > len(prefix):
        return head[len(prefix):], None
    if head:
        return None, "detached HEAD is not allowed for governed work"
    return None, error or "Git HEAD is empty"


def branch_validity(
    root: Path,
    task: Mapping[str, Any],
    actual_branch: Optional[str] = None,
) -> Tuple[bool, str, Optional[str], bool]:
    """Apply the shared task branch and bootstrap-main policy."""

    branch, error = (actual_branch, None) if actual_branch is not None else current_branch(root)
    expected = str(task.get("branch", ""))
    project = read_json(control_dir(root) / "project.json")
    bootstrap_tasks = project.get("branch_policy", {}).get("bootstrap_main_tasks", [])
    if bootstrap_tasks != [BOOTSTRAP_TASK_ID]:
        return (
            False,
            "project bootstrap_main_tasks must be exactly [%s]" % BOOTSTRAP_TASK_ID,
            branch,
            False,
        )
    bootstrap_ok = expected == "main" and task.get("task_id") == BOOTSTRAP_TASK_ID
    if error:
        return False, error, branch, bootstrap_ok
    if branch != expected:
        return False, "branch mismatch: expected %s, found %s" % (expected, branch), branch, bootstrap_ok
    if expected == "main" and not bootstrap_ok:
        return False, "governed feature work may not use main", branch, bootstrap_ok
    return True, "branch matches task scope", branch, bootstrap_ok


def _subject_path_is_excluded(relative: str) -> bool:
    if relative in _SUBJECT_EXCLUDED_EXACT:
        return True
    if relative.startswith("project-control/tasks/") or relative.startswith("project-control/reviews/"):
        return True
    parts = tuple(part for part in relative.split("/") if part)
    if any(part in _SUBJECT_EXCLUDED_PARTS for part in parts):
        return True
    filename = parts[-1] if parts else ""
    return filename.endswith((".pyc", ".pyo")) or filename in (".DS_Store", "coverage.xml")


def _git_index_path(root: Path) -> Optional[Path]:
    """Return the real Git index path, including linked-worktree layouts."""

    git_marker = root / ".git"
    if not git_marker.exists():
        return None
    if git_marker.is_dir():
        index_path = git_marker / "index"
    elif git_marker.is_file():
        try:
            marker_text = git_marker.read_text(encoding="utf-8").strip()
        except OSError as exc:
            raise GovernanceError("cannot inspect Git worktree pointer: %s" % exc) from exc
        prefix = "gitdir: "
        if not marker_text.startswith(prefix):
            raise GovernanceError("cannot parse Git worktree pointer")
        git_directory = Path(marker_text[len(prefix):])
        if not git_directory.is_absolute():
            git_directory = (root / git_directory).resolve()
        index_path = git_directory / "index"
    else:
        raise GovernanceError("unsupported .git repository marker")
    if not index_path.is_file():
        # Hook tests use a synthetic .git marker, while a newly initialized
        # repository has no index until its first add.  Both contain no tracked
        # executable classes and correctly use the untracked fallback.
        return None
    return index_path


def _tracked_git_entries(root: Path) -> Dict[str, Tuple[str, str]]:
    """Return stage-zero Git index mode and blob id for each tracked path."""

    if _git_index_path(root) is None:
        return {}
    output, error = run_git(root, ("ls-files", "--stage", "-z"))
    if error:
        raise GovernanceError("cannot inspect Git index entries: %s" % error)
    entries: Dict[str, Tuple[str, str]] = {}
    for record in (output or "").split("\0"):
        if not record:
            continue
        try:
            metadata, relative = record.split("\t", 1)
        except ValueError as exc:
            raise GovernanceError("cannot parse Git index mode record") from exc
        fields = metadata.split()
        if (
            len(fields) != 3
            or not re.fullmatch(r"[0-7]{6}", fields[0])
            or not re.fullmatch(r"(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})", fields[1])
        ):
            raise GovernanceError("cannot parse Git index mode metadata")
        mode, object_id, stage = fields
        if stage != "0":
            raise GovernanceError("cannot calculate subject with unmerged Git index entries")
        if not relative or relative.startswith("/") or ".." in relative.split("/"):
            raise GovernanceError("cannot parse Git index path")
        entry = (mode, object_id.lower())
        previous = entries.get(relative)
        if previous is not None and previous != entry:
            raise GovernanceError("conflicting Git index entries for %s" % relative)
        entries[relative] = entry
    return entries


def _git_worktree_available(root: Path) -> bool:
    """Distinguish a real Git worktree from synthetic fixture markers."""

    if not (root / ".git").exists():
        return False
    output, error = run_git(root, ("rev-parse", "--is-inside-work-tree"))
    return error is None and (output or "").strip().lower() == "true"


def _tracked_git_modes(root: Path) -> Dict[str, str]:
    """Return portable executable classes keyed by repository-relative path."""

    return {relative: entry[0] for relative, entry in _tracked_git_entries(root).items()}


def _git_modified_paths(root: Path) -> frozenset[str]:
    """Return tracked paths whose worktree form differs from the Git index."""

    output, error = run_git(root, ("diff-files", "--name-only", "-z", "--"))
    if error:
        raise GovernanceError("cannot inspect Git worktree differences: %s" % error)
    paths = []
    for relative in (output or "").split("\0"):
        if not relative:
            continue
        if relative.startswith("/") or ".." in relative.split("/"):
            raise GovernanceError("cannot parse Git worktree path")
        paths.append(relative)
    return frozenset(paths)


def _git_blob_oid(root: Path, relative: str) -> str:
    """Hash current file bytes through Git's reviewed path clean filters."""

    output, error = run_git(root, ("hash-object", "--path=" + relative, "--", relative))
    if error:
        raise GovernanceError("cannot calculate Git blob identity for %s: %s" % (relative, error))
    object_id = (output or "").strip().lower()
    if not re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", object_id):
        raise GovernanceError("cannot parse Git blob identity for %s" % relative)
    return object_id


def _git_blob_oids(root: Path, relatives: Sequence[str]) -> Dict[str, str]:
    """Hash reviewed paths through Git filters in one bounded subprocess."""

    paths = list(relatives)
    if not paths:
        return {}
    if any("\n" in path or "\r" in path for path in paths):
        raise GovernanceError("cannot calculate Git blob identity for a path containing a newline")
    output, error = run_git(
        root,
        ("hash-object", "--stdin-paths"),
        input_text="".join(path + "\n" for path in paths),
    )
    if error:
        raise GovernanceError("cannot calculate Git blob identities: %s" % error)
    object_ids = (output or "").splitlines()
    if len(object_ids) != len(paths):
        raise GovernanceError("Git returned an unexpected blob identity count")
    result: Dict[str, str] = {}
    for relative, object_id in zip(paths, object_ids):
        normalized = object_id.strip().lower()
        if not re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", normalized):
            raise GovernanceError("cannot parse Git blob identity for %s" % relative)
        result[relative] = normalized
    return result


def _unfiltered_git_blob_oid(content: bytes) -> str:
    """Return the standard SHA-1 Git blob id used before a worktree exists."""

    header = b"blob " + str(len(content)).encode("ascii") + b"\0"
    return hashlib.sha1(header + content).hexdigest()


def managed_content_subject(root: Path, task: Mapping[str, Any]) -> str:
    """Hash current governed file contents while excluding mutable control state.

    The path, file kind, executable-bit class and canonical content identity are
    hashed.  Clean tracked files use the Git index blob id; modified tracked and
    untracked files in an indexed repository are hashed through Git's path clean
    filters.  This also applies before the first index exists, provided the root
    is a real Git worktree.  It preserves real content changes while making
    checkout-only representations such as LF versus CRLF portable.  Before a
    real worktree exists, unfiltered bytes use the standard SHA-1 Git blob
    identity so first-commit validation remains stable.  Task/review/current-task
    records are excluded so appending the validation result does not invalidate
    itself.  Git metadata and generated caches are excluded as non-project
    content.
    """

    root = root.resolve()
    patterns = task.get("allowed_paths", [])
    git_worktree = _git_worktree_available(root)
    tracked_entries = _tracked_git_entries(root)
    modified_paths = _git_modified_paths(root) if tracked_entries else frozenset()
    entries: List[Tuple[str, str, int, Optional[bytes]]] = []
    filtered_paths: List[str] = []
    try:
        for directory, directory_names, file_names in os.walk(str(root), topdown=True, followlinks=False):
            directory_path = Path(directory)
            kept_directories: List[str] = []
            for name in directory_names:
                candidate = directory_path / name
                relative = candidate.relative_to(root).as_posix()
                if _subject_path_is_excluded(relative):
                    continue
                if candidate.is_symlink():
                    if path_is_allowed(root, relative, patterns):
                        entries.append((
                            relative,
                            "symlink",
                            0,
                            os.readlink(str(candidate)).encode("utf-8"),
                        ))
                    continue
                kept_directories.append(name)
            directory_names[:] = kept_directories
            for name in file_names:
                candidate = directory_path / name
                relative = candidate.relative_to(root).as_posix()
                if _subject_path_is_excluded(relative) or not path_is_allowed(root, relative, patterns):
                    continue
                mode = os.lstat(str(candidate)).st_mode
                if stat.S_ISLNK(mode):
                    kind = "symlink"
                    executable_bits = 0
                    content = os.readlink(str(candidate)).encode("utf-8")
                elif stat.S_ISREG(mode):
                    kind = "file"
                    tracked_entry = tracked_entries.get(relative)
                    tracked_mode = tracked_entry[0] if tracked_entry is not None else None
                    if tracked_mode == "100755":
                        executable_bits = stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH
                    elif tracked_mode in ("100644", "120000"):
                        executable_bits = 0
                    else:
                        executable_bits = mode & (stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
                    if tracked_entry is not None and relative not in modified_paths:
                        content = ("git-blob:" + tracked_entry[1]).encode("ascii")
                    elif git_worktree:
                        content = None
                        filtered_paths.append(relative)
                    else:
                        content = (
                            "git-blob:" + _unfiltered_git_blob_oid(candidate.read_bytes())
                        ).encode("ascii")
                else:
                    continue
                entries.append((relative, kind, executable_bits, content))
    except OSError as exc:
        raise GovernanceError("cannot calculate local validation subject: %s" % exc) from exc

    filtered_blob_ids = _git_blob_oids(root, filtered_paths)
    digest = hashlib.sha256()
    for relative, kind, executable_bits, content in sorted(entries, key=lambda item: item[0]):
        if content is None:
            content = ("git-blob:" + filtered_blob_ids[relative]).encode("ascii")
        path_bytes = relative.encode("utf-8")
        kind_bytes = kind.encode("ascii")
        digest.update(len(path_bytes).to_bytes(8, "big"))
        digest.update(path_bytes)
        digest.update(len(kind_bytes).to_bytes(8, "big"))
        digest.update(kind_bytes)
        digest.update(executable_bits.to_bytes(2, "big"))
        digest.update(len(content).to_bytes(8, "big"))
        digest.update(content)
    return "workspace:sha256:" + digest.hexdigest()


def validation_plan_issues(task: Mapping[str, Any]) -> List[str]:
    """Return problems for the one validation gate required before commit.

    CI may repeat the declared checks without importing GitHub run metadata back
    into the task record. Historical tasks can still declare CI and post-merge
    gates, but new tasks only need a non-empty, controlled local plan.
    """

    validation = task.get("validation", {})
    required = validation.get("required", []) if isinstance(validation, dict) else []
    if not isinstance(required, list) or not required:
        return ["validation.required must contain at least one check"]
    local_checks = [
        check for check in required
        if isinstance(check, Mapping)
        and "LOCAL_VERIFIED" in check.get("gates", [])
    ]
    if not local_checks:
        return ["validation plan must include at least one LOCAL_VERIFIED check"]
    return []


def review_authority_issues(task: Mapping[str, Any]) -> List[str]:
    authority = task.get("review_authority")
    if not isinstance(authority, Mapping):
        return ["review_authority must be a reviewed object"]
    try:
        # Lazy import avoids a module cycle while keeping task-schema checks and
        # receipt verification on the same exact key parser/fingerprint logic.
        from authority import validate_authority
        validate_authority(authority)
    except (GovernanceError, ImportError) as exc:
        return [str(exc)]
    return []


def ci_trust_issues(task: Mapping[str, Any]) -> List[str]:
    trust = task.get("ci_trust")
    if not isinstance(trust, Mapping):
        return ["ci_trust must be a reviewed object"]
    expected = {
        "provider": "github_actions_rest_v1",
        "repository": GITHUB_REPOSITORY,
        "workflow_path": GITHUB_WORKFLOW_PATH,
        "api_base": GITHUB_API_BASE,
        "api_version": GITHUB_API_VERSION,
        "private": True,
        "token_env": GITHUB_TOKEN_ENV,
        "ci_events": ["pull_request", "push"],
        "post_merge_events": ["push"],
        "required_jobs": GITHUB_REQUIRED_JOBS,
    }
    issues: List[str] = []
    for field, expected_value in expected.items():
        if trust.get(field) != expected_value:
            issues.append("ci_trust.%s must equal the project trust anchor" % field)
    unknown = sorted(set(trust) - set(expected))
    if unknown:
        issues.append("ci_trust contains unsupported fields: %s" % ", ".join(unknown))
    return issues


def coordination_issues(task: Mapping[str, Any]) -> List[str]:
    """Validate machine-readable multi-release coordination scope."""

    units = task.get("release_units", [])
    if not isinstance(units, list) or len(units) <= 1:
        return []
    coordination = task.get("coordination")
    if not isinstance(coordination, Mapping):
        return ["multi-unit task requires a reviewed coordination object"]
    task_id = str(task.get("task_id", ""))
    if coordination.get("coordinator_task") != task_id:
        return ["coordination.coordinator_task must equal the current task"]
    mode = coordination.get("mode")
    if mode == "governance-bootstrap":
        if task_id != BOOTSTRAP_TASK_ID or coordination.get("no_release_artifacts") is not True:
            return ["governance-bootstrap coordination is limited to GOV-0001 with no release artifacts"]
        rationale = coordination.get("rationale")
        if not isinstance(rationale, str) or not rationale.strip():
            return ["governance-bootstrap coordination requires a rationale"]
        return []
    if mode != "coordinated-multi":
        return ["coordination.mode must be coordinated-multi"]

    issues: List[str] = []
    unit_set = set(str(unit) for unit in units)
    unit_tasks = coordination.get("unit_tasks")
    if not isinstance(unit_tasks, Mapping) or set(unit_tasks) != unit_set:
        issues.append("coordination.unit_tasks must cover every affected release unit")
    else:
        for unit, implementation_task in unit_tasks.items():
            try:
                validate_task_id(implementation_task)
            except GovernanceError:
                issues.append("coordination.unit_tasks.%s must be a task id" % unit)
    matrix_doc = coordination.get("compatibility_matrix_doc")
    if (
        not isinstance(matrix_doc, str)
        or not matrix_doc.strip()
        or Path(matrix_doc).is_absolute()
        or ".." in Path(matrix_doc).parts
    ):
        issues.append("coordination.compatibility_matrix_doc must be a repository-relative path")
    for field in ("deployment_order", "rollback_order"):
        order = coordination.get(field)
        if (
            not isinstance(order, list)
            or len(order) != len(unit_set)
            or set(order) != unit_set
        ):
            issues.append("coordination.%s must contain each affected release unit once" % field)
    declared_checks = {
        str(check.get("id")): set(str(unit) for unit in check.get("release_units", []))
        for check in task.get("validation", {}).get("required", [])
        if isinstance(check, Mapping)
    }
    for field in ("unit_validation_checks", "unit_rollback_checks"):
        bindings = coordination.get(field)
        if not isinstance(bindings, Mapping) or set(bindings) != unit_set:
            issues.append("coordination.%s must cover every affected release unit" % field)
            continue
        for unit, check_ids in bindings.items():
            if (
                not isinstance(check_ids, list)
                or not check_ids
                or any(
                    not isinstance(check_id, str)
                    or check_id not in declared_checks
                    or unit not in declared_checks[check_id]
                    for check_id in check_ids
                )
            ):
                issues.append(
                    "coordination.%s.%s must reference checks reviewed for that release unit"
                    % (field, unit)
                )
    return issues


def legacy_g0_v1_migration(task: Mapping[str, Any]) -> bool:
    """Keep the exact reviewed v1 root task usable only long enough to migrate.

    Strict execution entry points call validation_plan_issues directly, so this
    compatibility window cannot record evidence or advance the lifecycle.  It
    is deliberately bound to the one unborn-repository bootstrap task and
    disappears as soon as scope v2 or a commit exists.
    """

    status = task.get("status")
    if status == "BLOCKED":
        status = task.get("exception", {}).get("previous_status")
    branch_exception = task.get("branch_exception", {})
    return (
        task.get("task_id") == BOOTSTRAP_TASK_ID
        and task.get("scope_version") == 1
        and status in NORMAL_STATES[:5]
        and task.get("branch") == "main"
        and isinstance(branch_exception, Mapping)
        and branch_exception.get("kind") == "bootstrap-main"
        and branch_exception.get("applies_only_to_task") == BOOTSTRAP_TASK_ID
        and task.get("bootstrap_recovery") is None
        and not task.get("git", {}).get("committed_sha")
    )


def validate_task(task: Mapping[str, Any]) -> None:
    required = (
        "task_id",
        "status",
        "scope_version",
        "requirement",
        "summary",
        "release_units",
        "branch",
        "allowed_paths",
        "dependencies",
        "required_docs",
        "validation",
        "assumptions",
        "open_questions",
        "blockers",
    )
    missing = [key for key in required if key not in task]
    if missing:
        raise GovernanceError("task is missing required fields: %s" % ", ".join(missing))
    validate_task_id(task["task_id"])
    if task["status"] not in TASK_STATES:
        raise GovernanceError("unknown task status: %s" % task["status"])
    if not isinstance(task["scope_version"], int) or task["scope_version"] < 1:
        raise GovernanceError("scope_version must be a positive integer")
    requirement = task["requirement"]
    if (
        not isinstance(requirement, dict)
        or not isinstance(requirement.get("id"), str)
        or not requirement.get("id", "").strip()
        or not isinstance(requirement.get("version"), str)
        or not requirement.get("version", "").strip()
    ):
        raise GovernanceError("requirement must contain id and version")
    if "interaction_kind" in requirement and requirement.get("interaction_kind") not in (
        "ui", "non_ui", "mixed",
    ):
        raise GovernanceError("requirement.interaction_kind must be ui, non_ui or mixed")
    if not isinstance(task["summary"], str) or not task["summary"].strip():
        raise GovernanceError("summary must be a non-empty string")
    if not isinstance(task["branch"], str) or not task["branch"].strip():
        raise GovernanceError("branch must be a non-empty string")
    if "base_branch" in task and (
        not isinstance(task["base_branch"], str) or not task["base_branch"].strip()
    ):
        raise GovernanceError("base_branch must be a non-empty string when present")

    for field in ("release_units", "allowed_paths", "required_docs"):
        values = task[field]
        if not isinstance(values, list) or any(
            not isinstance(value, str) or not value.strip() for value in values
        ):
            raise GovernanceError("%s must be a list of non-empty strings" % field)
    for field in ("allowed_commands", "allowed_tools"):
        values = task.get(field, [])
        if not isinstance(values, list) or any(
            not isinstance(value, str) or not value.strip() for value in values
        ):
            raise GovernanceError("%s must be a list of non-empty strings when present" % field)
    if not task["release_units"]:
        raise GovernanceError("release_units must contain at least one release unit")
    if len(set(task["release_units"])) != len(task["release_units"]):
        raise GovernanceError("release_units must not contain duplicates")

    dependencies = task["dependencies"]
    if not isinstance(dependencies, list):
        raise GovernanceError("dependencies must be a list of task_id strings")
    for dependency_id in dependencies:
        validate_task_id(dependency_id)
    if len(set(dependencies)) != len(dependencies):
        raise GovernanceError("dependencies must not contain duplicates")
    if task["task_id"] in dependencies:
        raise GovernanceError("a task may not depend on itself")

    structured_lists = {
        "assumptions": ("statement",),
        "open_questions": ("question",),
        "blockers": ("description", "reason", "statement"),
    }
    for field, content_fields in structured_lists.items():
        values = task[field]
        if not isinstance(values, list):
            raise GovernanceError("%s must be a list" % field)
        for value in values:
            if isinstance(value, str):
                if not value.strip():
                    raise GovernanceError("%s entries must not be empty" % field)
                continue
            if not isinstance(value, dict) or not value:
                raise GovernanceError("%s entries must be non-empty strings or objects" % field)
            if not isinstance(value.get("id"), str) or not value.get("id", "").strip():
                raise GovernanceError("structured %s entries require a non-empty id" % field)
            if not any(isinstance(value.get(key), str) and value.get(key, "").strip() for key in content_fields):
                raise GovernanceError(
                    "structured %s entries require %s" % (field, " or ".join(content_fields))
                )

    validation = task["validation"]
    if not isinstance(validation, dict) or not isinstance(validation.get("required", []), list):
        raise GovernanceError("validation.required must be a list")
    if not isinstance(validation.get("results", []), list):
        raise GovernanceError("validation.results must be a list")
    check_ids: List[str] = []
    legacy_validation_schema = legacy_g0_v1_migration(task)
    for check in validation.get("required", []):
        if not isinstance(check, dict):
            raise GovernanceError("validation.required entries must be objects")
        check_id = check.get("id")
        gates = check.get("gates")
        if not isinstance(check_id, str) or not check_id.strip():
            raise GovernanceError("validation check id must be a non-empty string")
        argv = check.get("argv")
        timeout_seconds = check.get("timeout_seconds")
        if legacy_validation_schema:
            command = check.get("command")
            if not isinstance(command, str) or not command.strip():
                raise GovernanceError("legacy validation check command must be a non-empty string")
        else:
            if (
                not isinstance(argv, list)
                or not argv
                or any(not isinstance(argument, str) or not argument for argument in argv)
            ):
                raise GovernanceError("validation check argv must be a non-empty array of exact tokens")
            if (
                not isinstance(timeout_seconds, (int, float))
                or isinstance(timeout_seconds, bool)
                or timeout_seconds <= 0
                or timeout_seconds > 3600
            ):
                raise GovernanceError("validation check timeout_seconds must be in (0, 3600]")
            check_units = check.get("release_units")
            if (
                not isinstance(check_units, list)
                or not check_units
                or any(unit not in task["release_units"] for unit in check_units)
                or len(set(check_units)) != len(check_units)
            ):
                raise GovernanceError(
                    "validation check release_units must be unique affected release units"
                )
            unsupported = sorted(
                set(check) - {"id", "argv", "timeout_seconds", "gates", "release_units"}
            )
            if unsupported:
                raise GovernanceError(
                    "validation check contains unsupported fields: %s" % ", ".join(unsupported)
                )
        if not isinstance(gates, list) or not gates or any(gate not in GATE_PHASES for gate in gates):
            raise GovernanceError("validation check gates must be known validation gates")
        check_ids.append(check_id)
    if len(set(check_ids)) != len(check_ids):
        raise GovernanceError("validation check ids must be unique")
    plan_issues = validation_plan_issues(task)
    if plan_issues:
        if not validation.get("required", []):
            raise GovernanceError(plan_issues[0])
        task_status_index = status_index(str(task.get("status", "")))
        if task_status_index < 0:
            task_status_index = status_index(str(task.get("exception", {}).get("previous_status", "")))
        if task_status_index >= status_index("READY") and not legacy_g0_v1_migration(task):
            raise GovernanceError("; ".join(plan_issues))
    effective_schema_status = str(task.get("status", ""))
    if effective_schema_status in EXCEPTION_STATES:
        effective_schema_status = str(task.get("exception", {}).get("previous_status", ""))
    validates_optional_contracts = (
        status_index(effective_schema_status) >= status_index("REVIEW_PENDING")
        and not legacy_g0_v1_migration(task)
    )
    if validates_optional_contracts:
        contract_issues: List[str] = []
        if "review_authority" in task:
            contract_issues.extend(review_authority_issues(task))
        if "ci_trust" in task:
            contract_issues.extend(ci_trust_issues(task))
        if "coordination" in task:
            contract_issues.extend(coordination_issues(task))
        if contract_issues:
            raise GovernanceError("; ".join(contract_issues))

    subtasks = task.get("subtasks", [])
    if not isinstance(subtasks, list):
        raise GovernanceError("subtasks must be a list when present")
    subtask_fields = {
        "id", "name", "purpose", "status", "started_at", "finished_at", "result",
    }
    subtask_ids: List[str] = []
    for subtask in subtasks:
        if not isinstance(subtask, Mapping) or set(subtask) != subtask_fields:
            raise GovernanceError(
                "subtask entries must contain only id, name, purpose, status, "
                "started_at, finished_at and result"
            )
        for field in ("id", "name", "purpose"):
            value = subtask.get(field)
            if (
                not isinstance(value, str)
                or not value.strip()
                or len(value) > 512
                or "\x00" in value
            ):
                raise GovernanceError("subtask.%s must be a non-empty bounded string" % field)
            if field == "purpose":
                sensitive_reason = subtask_sensitive_text_reason(value)
                if sensitive_reason is not None:
                    raise GovernanceError(
                        "subtask.purpose resembles %s; record only a redacted summary"
                        % sensitive_reason
                    )
        identifier = str(subtask["id"])
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", identifier):
            raise GovernanceError("subtask.id contains unsupported characters")
        subtask_ids.append(identifier)
        status = subtask.get("status")
        if status not in ("in_progress", "completed", "failed", "cancelled"):
            raise GovernanceError("subtask.status is unknown")
        started_at = parse_timestamp(subtask.get("started_at"))
        if started_at is None:
            raise GovernanceError("subtask.started_at is required")
        if status == "in_progress":
            if subtask.get("finished_at") is not None or subtask.get("result") is not None:
                raise GovernanceError("in-progress subtask must not have finished_at or result")
        else:
            finished_at = parse_timestamp(subtask.get("finished_at"))
            result = subtask.get("result")
            if finished_at is None or finished_at < started_at:
                raise GovernanceError("finished subtask requires finished_at after started_at")
            if (
                not isinstance(result, str)
                or not result.strip()
                or len(result) > 4096
                or "\x00" in result
            ):
                raise GovernanceError("finished subtask requires a non-empty bounded result")
            sensitive_reason = subtask_sensitive_text_reason(result)
            if sensitive_reason is not None:
                raise GovernanceError(
                    "subtask.result resembles %s; record only a redacted summary"
                    % sensitive_reason
                )
    if len(subtask_ids) != len(set(subtask_ids)):
        raise GovernanceError("subtask ids must be unique")
    recovery = task.get("bootstrap_recovery")
    if recovery is not None:
        base_recovery_fields = frozenset((
            "activated_at",
            "activated_by",
            "failed_content_sha",
            "failed_control_head",
            "failed_run_id",
            "history_count",
            "operation_id",
            "proposal_path",
            "review_id",
            "state",
            "target_digest",
        ))
        consumed_recovery_fields = frozenset((
            "consumed_at",
            "consumed_content_sha",
            "consumed_control_head",
            "consumed_run_id",
        ))
        state = recovery.get("state") if isinstance(recovery, Mapping) else None
        required_recovery_fields = (
            base_recovery_fields | consumed_recovery_fields
            if state == "consumed" else base_recovery_fields
        )
        if not isinstance(recovery, Mapping) or set(recovery) != required_recovery_fields:
            raise GovernanceError("bootstrap_recovery has an invalid activation shape")
        if state not in ("active", "consumed") or recovery.get("activated_by") != "Codex":
            raise GovernanceError("bootstrap_recovery must be active/consumed and recorded by Codex")
        parse_timestamp(recovery.get("activated_at"))
        normalize_commit(recovery.get("failed_content_sha"), "bootstrap_recovery.failed_content_sha")
        normalize_commit(recovery.get("failed_control_head"), "bootstrap_recovery.failed_control_head")
        validate_review_id(recovery.get("review_id"))
        validate_target_digest(recovery.get("target_digest"))
        if not isinstance(recovery.get("operation_id"), str) or not recovery.get("operation_id", "").strip():
            raise GovernanceError("bootstrap_recovery.operation_id must be non-empty")
        if not isinstance(recovery.get("failed_run_id"), str) or not re.fullmatch(
            r"[1-9][0-9]*", recovery.get("failed_run_id", "")
        ):
            raise GovernanceError("bootstrap_recovery.failed_run_id must be a positive decimal id")
        if (
            not isinstance(recovery.get("history_count"), int)
            or isinstance(recovery.get("history_count"), bool)
            or recovery.get("history_count") < 1
        ):
            raise GovernanceError("bootstrap_recovery.history_count must be positive")
        proposal = recovery.get("proposal_path")
        if (
            not isinstance(proposal, str)
            or not proposal.startswith("project-control/proposals/")
            or not proposal.endswith(".json")
            or ".." in proposal.split("/")
        ):
            raise GovernanceError("bootstrap_recovery.proposal_path is invalid")
        if state == "consumed":
            consumed_at = parse_timestamp(recovery.get("consumed_at"))
            activated_at = parse_timestamp(recovery.get("activated_at"))
            if consumed_at is None or activated_at is None or consumed_at < activated_at:
                raise GovernanceError("bootstrap_recovery consumed_at precedes activation")
            normalize_commit(
                recovery.get("consumed_content_sha"),
                "bootstrap_recovery.consumed_content_sha",
            )
            normalize_commit(
                recovery.get("consumed_control_head"),
                "bootstrap_recovery.consumed_control_head",
            )
            if not isinstance(recovery.get("consumed_run_id"), str) or not re.fullmatch(
                r"[1-9][0-9]*", recovery.get("consumed_run_id", "")
            ):
                raise GovernanceError("bootstrap_recovery.consumed_run_id must be positive")
    for result in validation.get("results", []):
        if not isinstance(result, dict):
            raise GovernanceError("validation.results entries must be objects")
        if result.get("check_id") not in check_ids:
            raise GovernanceError("validation result references an undeclared check")
        if result.get("status") not in VALIDATION_STATUSES:
            raise GovernanceError("validation result has an unknown status")
        if result.get("phase") not in VALIDATION_PHASES:
            raise GovernanceError("validation result has an unknown phase")
        if not isinstance(result.get("subject"), str) or not result.get("subject", "").strip():
            raise GovernanceError("validation result must bind a subject")
        if not isinstance(result.get("environment"), str) or not result.get("environment", "").strip():
            raise GovernanceError("validation result must bind a non-empty environment")
        result_unit = result.get("release_unit")
        declared_check = next(
            check for check in validation.get("required", [])
            if check.get("id") == result.get("check_id")
        )
        if result_unit is not None and (
            not isinstance(result_unit, str)
            or result_unit not in declared_check.get("release_units", [])
        ):
            raise GovernanceError("validation result release_unit is outside the reviewed check")
        provenance_issues = validation_result_provenance_issues(task, result)
        if provenance_issues:
            raise GovernanceError("validation PASS provenance is invalid: %s" % "; ".join(provenance_issues))
        if result.get("phase") in ("ci", "post_merge"):
            run_id = result.get("run_id")
            run_url = result.get("run_url")
            if not isinstance(run_id, str) or not re.fullmatch(r"[1-9][0-9]*", run_id):
                raise GovernanceError("CI validation result must bind a GitHub Actions run_id")
            if (
                not isinstance(run_url, str)
                or not run_url.startswith("https://github.com/")
                or "/actions/runs/" + run_id not in run_url
            ):
                raise GovernanceError("CI validation result must bind the matching GitHub Actions run_url")

    git_evidence = task.get("git", {})
    if not isinstance(git_evidence, dict):
        raise GovernanceError("git must be an object when present")
    for field in ("committed_sha", "ci_verified_sha", "merged_sha", "post_merge_verified_sha"):
        if field in git_evidence:
            normalized = normalize_commit(git_evidence[field], "git.%s" % field)
            if normalized != git_evidence[field]:
                raise GovernanceError("git.%s must use lowercase hexadecimal" % field)
    normal_index = status_index(str(task["status"]))
    if normal_index >= status_index("COMMITTED") and not git_evidence.get("committed_sha"):
        raise GovernanceError("COMMITTED or later task state requires git.committed_sha")
    if task.get("status") in ("CI_VERIFIED", "CODE_REVIEWED"):
        if not git_evidence.get("ci_verified_sha"):
            raise GovernanceError("CI_VERIFIED and CODE_REVIEWED require git.ci_verified_sha")
        if git_evidence.get("ci_verified_sha") != git_evidence.get("committed_sha"):
            raise GovernanceError("git.ci_verified_sha must equal git.committed_sha")
    if normal_index >= status_index("MERGED") and not git_evidence.get("merged_sha"):
        raise GovernanceError("MERGED or later task state requires git.merged_sha")
    if task.get("status") == "POST_MERGE_VERIFIED":
        if not git_evidence.get("post_merge_verified_sha"):
            raise GovernanceError("POST_MERGE_VERIFIED requires git.post_merge_verified_sha")
        if git_evidence.get("post_merge_verified_sha") != git_evidence.get("merged_sha"):
            raise GovernanceError("git.post_merge_verified_sha must equal git.merged_sha")


def allowed_transition(current: str, target: str, blocked_from: Optional[str] = None) -> bool:
    if current not in TASK_STATES or target not in TASK_STATES or current == target:
        return False
    if target == _NORMAL_NEXT.get(current):
        return True
    if current == "COMMITTED" and target == "MERGED":
        return True
    if current == "MERGED" and target == "DONE":
        return True
    if target == "BLOCKED" and current not in ("DONE", "CANCELLED", "BLOCKED"):
        return True
    if current == "BLOCKED" and target == blocked_from:
        return bool(blocked_from and blocked_from not in ("DONE", "CANCELLED", "BLOCKED"))
    if target == "FAILED" and current in NORMAL_STATES[4:-1]:
        return True
    if current == "FAILED" and target in ("IN_PROGRESS", "CANCELLED"):
        return True
    if target == "REJECTED" and current == "REVIEW_PENDING":
        return True
    if current == "REJECTED" and target in ("DRAFT", "CANCELLED"):
        return True
    if target == "CANCELLED" and current not in ("DONE", "CANCELLED"):
        return True
    return False


def list_reviews(root: Path, task_id: Optional[str] = None) -> List[Dict[str, Any]]:
    directory = control_dir(root) / "reviews"
    if not directory.exists():
        return []
    reviews: List[Dict[str, Any]] = []
    for path in sorted(directory.glob("*.json")):
        receipt = read_json(path)
        file_review_id = validate_review_id(path.stem)
        if receipt.get("review_id") != file_review_id:
            raise GovernanceError("review_id does not match filename: %s" % path.name)
        if task_id is None or receipt.get("task_id") == task_id:
            receipt["_path"] = str(path)
            reviews.append(receipt)
    return reviews


def _conversation_migration_authorized(root: Path) -> Tuple[bool, str]:
    """Verify the final signed receipt that authorized dialogue approvals."""

    try:
        project = read_json(control_dir(root) / "project.json")
        policy_issues = conversation_approval_policy_issues(project)
        if policy_issues:
            return False, "; ".join(policy_issues)
        receipt = read_json(review_path(root, CONVERSATION_MIGRATION_RECEIPT_ID))
        if receipt.get("review_id") != CONVERSATION_MIGRATION_RECEIPT_ID:
            return False, "conversation migration receipt id does not match its filename"
        signature = receipt.get("signature")
        if not isinstance(signature, Mapping):
            return False, "conversation migration receipt has no OpenSSH signature"
        if signature.get("payload_sha256") != CONVERSATION_MIGRATION_PAYLOAD_SHA256:
            return False, "conversation migration receipt payload digest is not pinned R003"
        if (
            receipt.get("task_id") != BOOTSTRAP_TASK_ID
            or receipt.get("kind") != "scope"
            or receipt.get("decision") != "approved"
            or receipt.get("approver") != "user"
            or receipt.get("scope_version") != 3
        ):
            return False, "conversation migration receipt bindings are not the approved R003 contract"
        from authority import receipt_payload_digest
        if receipt_payload_digest(receipt) != CONVERSATION_MIGRATION_PAYLOAD_SHA256:
            return False, "conversation migration receipt canonical payload digest changed"
        sealed_digest = "sha256:" + hashlib.sha256(
            canonical_json(receipt).encode("utf-8")
        ).hexdigest()
        if sealed_digest != CONVERSATION_MIGRATION_RECEIPT_SHA256:
            return False, "conversation migration receipt differs from the sealed signed R003"
        return True, "sealed signed R003 authorizes conversation-v1 approvals"
    except (GovernanceError, ImportError) as exc:
        return False, str(exc)


def _nonempty_receipt_text(value: Any, field: str, maximum: int = 4096) -> str:
    if (
        not isinstance(value, str)
        or not value.strip()
        or len(value) > maximum
        or "\x00" in value
    ):
        raise GovernanceError("%s must be a non-empty bounded string" % field)
    return value


def _conversation_receipt_shape_issues(receipt: Mapping[str, Any]) -> List[str]:
    """Validate the complete audit-only receipt shape without task binding."""

    issues: List[str] = []
    kind = receipt.get("kind")
    if kind not in _CONVERSATION_KIND_FIELDS:
        return ["conversation receipt kind is unknown"]
    expected_fields = _CONVERSATION_COMMON_FIELDS | _CONVERSATION_KIND_FIELDS[str(kind)]
    actual_fields = set(receipt) - {"_path"}
    missing = sorted(expected_fields - actual_fields)
    extra = sorted(actual_fields - expected_fields)
    if missing:
        issues.append("conversation receipt is missing fields: %s" % ", ".join(missing))
    if extra:
        issues.append("conversation receipt has unsupported fields: %s" % ", ".join(extra))
    if missing or extra:
        return issues

    if receipt.get("schema_version") != CONVERSATION_RECEIPT_SCHEMA_VERSION:
        issues.append("conversation receipt schema_version must be 3")
    if receipt.get("approval_mode") != CONVERSATION_APPROVAL_MODE:
        issues.append("conversation receipt approval_mode must be conversation-v1")
    try:
        validate_review_id(receipt.get("review_id"))
        validate_task_id(receipt.get("task_id"))
        _nonempty_receipt_text(receipt.get("reason"), "receipt.reason")
        _nonempty_receipt_text(receipt.get("confirmation_ref"), "receipt.confirmation_ref", 512)
        _nonempty_receipt_text(receipt.get("confirmation_text"), "receipt.confirmation_text")
    except GovernanceError as exc:
        issues.append(str(exc))
    if receipt.get("project_id") != PROJECT_ID:
        issues.append("conversation receipt belongs to another project")
    if receipt.get("source_repository") != SOURCE_REPOSITORY:
        issues.append("conversation receipt belongs to another source repository")
    if receipt.get("decision") not in REVIEW_DECISIONS:
        issues.append("conversation receipt decision is unknown")
    if receipt.get("approver") != "user":
        issues.append("conversation receipt must record user as decision actor")
    if receipt.get("recorded_by") != "Codex":
        issues.append("conversation receipt must record Codex as the audit recorder")
    if receipt.get("confirmation_source") != CONVERSATION_CONFIRMATION_SOURCE:
        issues.append("conversation receipt confirmation_source must be codex-conversation")
    scope_version = receipt.get("scope_version")
    if not isinstance(scope_version, int) or isinstance(scope_version, bool) or scope_version < 1:
        issues.append("conversation receipt scope_version must be a positive integer")
    scope_hash = receipt.get("scope_hash")
    if not isinstance(scope_hash, str) or re.fullmatch(r"sha256:[0-9a-f]{64}", scope_hash) is None:
        issues.append("conversation receipt scope_hash must be a lowercase sha256 digest")

    decided = None
    expires = None
    try:
        decided = parse_timestamp(receipt.get("decided_at"))
        if decided is None:
            issues.append("conversation receipt decided_at is required")
        expires = parse_timestamp(receipt.get("expires_at"))
        if decided is not None and expires is not None and expires <= decided:
            issues.append("conversation receipt expires_at must be later than decided_at")
    except GovernanceError as exc:
        issues.append(str(exc))
    supersedes = receipt.get("supersedes")
    if supersedes is not None:
        try:
            validate_review_id(supersedes)
            if supersedes == receipt.get("review_id"):
                issues.append("conversation receipt cannot supersede itself")
        except GovernanceError as exc:
            issues.append(str(exc))

    try:
        if kind == "code":
            if normalize_commit(receipt.get("commit"), "receipt.commit") != receipt.get("commit"):
                issues.append("conversation receipt commit must use lowercase hexadecimal")
        elif kind == "validation_waiver":
            _nonempty_receipt_text(receipt.get("check_id"), "receipt.check_id", 192)
            phase = receipt.get("phase")
            if phase not in VALIDATION_PHASES:
                issues.append("conversation waiver phase is unknown")
            else:
                if receipt.get("max_gate") != PHASE_GATES[phase]:
                    issues.append("conversation waiver max_gate does not match phase")
            _nonempty_receipt_text(receipt.get("subject"), "receipt.subject", 1024)
            _nonempty_receipt_text(receipt.get("environment"), "receipt.environment", 192)
            if expires is None:
                issues.append("conversation validation waiver requires expires_at")
        elif kind == "irreversible_operation":
            _nonempty_receipt_text(receipt.get("operation_id"), "receipt.operation_id", 192)
            validate_target_digest(receipt.get("target_digest"))
            if expires is None:
                issues.append("conversation irreversible-operation approval requires expires_at")
        elif kind == "rework":
            _nonempty_receipt_text(receipt.get("subject"), "receipt.subject", 1024)
            if receipt.get("from_status") != "LOCAL_VERIFIED":
                issues.append("conversation rework receipt must bind from_status LOCAL_VERIFIED")
            if expires is None:
                issues.append("conversation rework approval requires expires_at")
        elif kind == "final_action":
            if receipt.get("action") not in ("merge", "deploy", "release"):
                issues.append("conversation final action is unknown")
            subject = receipt.get("subject")
            if not isinstance(subject, str) or re.fullmatch(r"commit:[0-9a-f]{40,64}", subject) is None:
                issues.append("conversation final action must bind a commit subject")
            if expires is None:
                issues.append("conversation final-action approval requires expires_at")
    except GovernanceError as exc:
        issues.append(str(exc))
    return issues


def verify_conversation_receipt(
    root: Path,
    receipt: Mapping[str, Any],
) -> Tuple[bool, str]:
    migration_valid, migration_reason = _conversation_migration_authorized(root)
    if not migration_valid:
        return False, migration_reason
    issues = _conversation_receipt_shape_issues(receipt)
    if issues:
        return False, "; ".join(issues)
    return True, (
        "valid conversation approval receipt; audit binding only, without cryptographic identity proof"
    )


def build_conversation_receipt(
    root: Path,
    task: Mapping[str, Any],
    *,
    review_id: str,
    kind: str,
    decision: str,
    reason: str,
    confirmation_ref: str,
    confirmation_text: str,
    actor: str,
    decided_at: Optional[str] = None,
    expires_at: Optional[str] = None,
    supersedes: Optional[str] = None,
    commit: Optional[str] = None,
    check_id: Optional[str] = None,
    phase: Optional[str] = None,
    environment: Optional[str] = None,
    operation_id: Optional[str] = None,
    target_digest: Optional[str] = None,
    action: Optional[str] = None,
) -> Dict[str, Any]:
    """Derive one exact conversation receipt from current governed state."""

    migration_valid, migration_reason = _conversation_migration_authorized(root)
    if not migration_valid:
        raise GovernanceError("conversation approval policy is unavailable: %s" % migration_reason)
    if actor != "Codex":
        raise GovernanceError("conversation receipts must record --actor Codex exactly")
    if decision not in REVIEW_DECISIONS:
        raise GovernanceError("conversation receipt decision is unknown")
    if kind not in _CONVERSATION_KIND_FIELDS:
        raise GovernanceError("conversation receipt kind is unknown")
    validate_review_id(review_id)
    validate_task_id(task.get("task_id"))
    _nonempty_receipt_text(reason, "receipt.reason")
    _nonempty_receipt_text(confirmation_ref, "receipt.confirmation_ref", 512)
    _nonempty_receipt_text(confirmation_text, "receipt.confirmation_text")
    if supersedes is not None:
        validate_review_id(supersedes)

    specialized = {
        "commit": commit,
        "check_id": check_id,
        "phase": phase,
        "environment": environment,
        "operation_id": operation_id,
        "target_digest": target_digest,
        "action": action,
    }
    applicable = {
        "scope": frozenset(),
        "code": frozenset(("commit",)),
        "validation_waiver": frozenset(("check_id", "phase", "environment")),
        "irreversible_operation": frozenset(("operation_id", "target_digest")),
        "rework": frozenset(),
        "final_action": frozenset(("action",)),
    }
    irrelevant = sorted(
        field for field, value in specialized.items()
        if value is not None and field not in applicable[kind]
    )
    if irrelevant:
        raise GovernanceError(
            "%s conversation receipt does not accept bindings: %s"
            % (kind, ", ".join(irrelevant))
        )

    decided_value = decided_at or utc_now()
    decided = parse_timestamp(decided_value)
    expires = parse_timestamp(expires_at)
    if decided is None:
        raise GovernanceError("conversation receipt decided_at is required")
    if expires is not None and expires <= decided:
        raise GovernanceError("conversation receipt expires_at must be later than decided_at")
    if expires is not None and expires <= _datetime.datetime.now(_datetime.timezone.utc):
        raise GovernanceError("conversation receipt expires_at must be in the future")

    receipt: Dict[str, Any] = {
        "schema_version": CONVERSATION_RECEIPT_SCHEMA_VERSION,
        "approval_mode": CONVERSATION_APPROVAL_MODE,
        "review_id": review_id,
        "project_id": PROJECT_ID,
        "source_repository": SOURCE_REPOSITORY,
        "task_id": task.get("task_id"),
        "kind": kind,
        "decision": decision,
        "approver": "user",
        "recorded_by": actor,
        "reason": reason,
        "confirmation_source": CONVERSATION_CONFIRMATION_SOURCE,
        "confirmation_ref": confirmation_ref,
        "confirmation_text": confirmation_text,
        "scope_version": task.get("scope_version"),
        "scope_hash": canonical_scope_hash(task),
        "decided_at": decided_value,
        "expires_at": expires_at,
        "supersedes": supersedes,
    }
    if kind == "code":
        selected_commit = commit or task.get("git", {}).get("ci_verified_sha")
        normalized = normalize_commit(selected_commit, "code review commit")
        expected = task.get("git", {}).get("ci_verified_sha")
        if not expected or normalized != normalize_commit(expected, "task.git.ci_verified_sha"):
            raise GovernanceError("code review commit does not match task.git.ci_verified_sha")
        receipt["commit"] = normalized
    elif kind == "validation_waiver":
        if not check_id or phase not in VALIDATION_PHASES:
            raise GovernanceError("validation waiver requires --check-id and --phase")
        required_ids = {
            str(item.get("id"))
            for item in task.get("validation", {}).get("required", [])
            if isinstance(item, Mapping)
        }
        if check_id not in required_ids:
            raise GovernanceError("validation waiver references an undeclared check")
        gate = PHASE_GATES[phase]
        subject, subject_error = expected_validation_subject(root, task, gate)
        if subject_error:
            raise GovernanceError(subject_error)
        receipt.update({
            "check_id": check_id,
            "phase": phase,
            "subject": subject,
            "environment": environment or ("local" if phase == "local" else "github-actions"),
            "max_gate": gate,
        })
    elif kind == "irreversible_operation":
        receipt.update({
            "operation_id": _nonempty_receipt_text(
                operation_id, "irreversible operation id", 192
            ),
            "target_digest": validate_target_digest(target_digest),
        })
    elif kind == "rework":
        effective_status = task.get("status")
        if effective_status == "BLOCKED":
            effective_status = task.get("exception", {}).get("previous_status")
        if effective_status != "LOCAL_VERIFIED":
            raise GovernanceError("rework approval is only valid for a LOCAL_VERIFIED task")
        receipt.update({
            "subject": managed_content_subject(root, task),
            "from_status": "LOCAL_VERIFIED",
        })
    elif kind == "final_action":
        if action not in ("merge", "deploy", "release"):
            raise GovernanceError("final action must be merge, deploy or release")
        git_evidence = task.get("git", {})
        selected = (
            git_evidence.get("committed_sha")
            if action == "merge"
            else git_evidence.get("merged_sha") or git_evidence.get("committed_sha")
        )
        receipt.update({
            "action": action,
            "subject": "commit:" + normalize_commit(selected, "final action subject"),
        })
    issues = _conversation_receipt_shape_issues(receipt)
    if issues:
        raise GovernanceError("; ".join(issues))
    return receipt


def review_authenticity(
    receipt: Mapping[str, Any],
    task: Optional[Mapping[str, Any]] = None,
    root: Optional[Path] = None,
) -> Tuple[bool, str]:
    """Verify a pinned bootstrap, historical OpenSSH or dialogue receipt.

    The sole compatibility exception is the exact G0 scope-v1 migration
    receipt already accepted before this gate existed. Its complete canonical
    payload is pinned, so changing any authority, binding, timestamp or
    explanatory field invalidates the exception. ``_path`` is loader metadata,
    not part of the stored receipt.
    """

    stored_payload = {
        key: value for key, value in receipt.items()
        if key != "_path"
    }
    digest = hashlib.sha256(canonical_json(stored_payload).encode("utf-8")).hexdigest()
    if digest == _LEGACY_G0_R001_CANONICAL_SHA256:
        return True, "exact legacy GOV-0001-R001 migration receipt"
    if receipt.get("approval_mode") == CONVERSATION_APPROVAL_MODE:
        if root is None:
            return False, "conversation receipt verification requires the repository root"
        return verify_conversation_receipt(root, receipt)
    if task is None or root is None:
        return False, LEGACY_RECORD_DISABLED
    try:
        project = read_json(control_dir(root) / "project.json")
        if project.get("project_id") != PROJECT_ID or project.get("source_repository") != SOURCE_REPOSITORY:
            return False, "project identity or source repository does not match the fixed trust root"
        if receipt.get("project_id") != PROJECT_ID or receipt.get("source_repository") != SOURCE_REPOSITORY:
            return False, "signed receipt belongs to another project or source repository"
        from authority import authority_from_task, verify_signed_receipt
        return verify_signed_receipt(receipt, authority_from_task(task))
    except (GovernanceError, ImportError) as exc:
        return False, str(exc)


def review_validity(
    receipt: Mapping[str, Any],
    task: Mapping[str, Any],
    now: Optional[_datetime.datetime] = None,
    root: Optional[Path] = None,
) -> Tuple[bool, str]:
    authentic, authenticity_reason = review_authenticity(receipt, task, root)
    if not authentic:
        return False, authenticity_reason
    if receipt.get("task_id") != task.get("task_id"):
        return False, "receipt belongs to another task"
    if receipt.get("decision") != "approved":
        return False, "latest decision is %s" % receipt.get("decision")
    if receipt.get("approver") != "user":
        return False, "only user may approve work"
    if receipt.get("scope_version") != task.get("scope_version"):
        return False, "scope version changed"
    if receipt.get("scope_hash") != canonical_scope_hash(task):
        return False, "scope hash changed"
    expires_at = parse_timestamp(receipt.get("expires_at"))
    clock = now or _datetime.datetime.now(_datetime.timezone.utc)
    if expires_at is not None and clock >= expires_at:
        return False, "approval expired"
    return True, "approved"


def _review_sort_key(receipt: Mapping[str, Any]) -> Tuple[_datetime.datetime, str]:
    decided_at = parse_timestamp(receipt.get("decided_at"))
    if decided_at is None:
        decided_at = _datetime.datetime.min.replace(tzinfo=_datetime.timezone.utc)
    return decided_at, str(receipt.get("review_id", ""))


def _latest_receipt(candidates: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """Select an unsuperseded receipt, then use timestamp/id as a tie-breaker."""

    superseded = {
        str(receipt.get("supersedes"))
        for receipt in candidates
        if receipt.get("supersedes")
    }
    leaves = [
        receipt for receipt in candidates
        if str(receipt.get("review_id")) not in superseded
    ]
    return max(leaves or list(candidates), key=_review_sort_key)


def find_effective_review(
    root: Path,
    task: Mapping[str, Any],
    kind: str = "scope",
    commit: Optional[str] = None,
) -> Tuple[Optional[Dict[str, Any]], str]:
    """Find an effective scope or code receipt.

    Code receipts are additionally bound to the exact commit which has already
    passed the CI gate.  The optional commit argument is mainly useful to
    perform an explicit verification; normal callers use task.git evidence.
    """

    scope_hash = canonical_scope_hash(task)
    expected_commit: Optional[str] = None
    if kind == "code":
        candidate_commit = commit or task.get("git", {}).get("ci_verified_sha")
        if not candidate_commit:
            return None, "code review requires an exact CI-verified commit"
        expected_commit = normalize_commit(candidate_commit, "code review commit")
    elif commit is not None:
        return None, "commit binding is only valid for code review"
    candidates = [
        receipt
        for receipt in list_reviews(root, str(task.get("task_id")))
        if receipt.get("kind", "scope") == kind and receipt.get("scope_hash") == scope_hash
        and (expected_commit is None or receipt.get("commit") == expected_commit)
    ]
    if not candidates:
        if expected_commit is not None:
            return None, "no code review receipt matches the current scope and CI-verified commit"
        return None, "no receipt matches the current canonical scope"
    receipt = _latest_receipt(candidates)
    valid, reason = review_validity(receipt, task, root=root)
    return (receipt if valid else None), reason


def find_effective_validation_waiver(
    root: Path,
    task: Mapping[str, Any],
    check_id: str,
    phase: str,
    environment: Optional[str] = None,
) -> Tuple[Optional[Dict[str, Any]], str]:
    """Return the latest effective waiver for one validation check.

    Waivers are narrower than scope approval: they must be user-approved, bind
    the current canonical scope and check id, and always have a future expiry.
    """

    if phase not in VALIDATION_PHASES:
        raise GovernanceError("unknown validation waiver phase: %s" % phase)
    scope_hash = canonical_scope_hash(task)
    gate = PHASE_GATES[phase]
    expected_subject, subject_error = expected_validation_subject(root, task, gate)
    if subject_error:
        return None, subject_error
    normalized_environment = environment.strip() if isinstance(environment, str) else None
    if environment is not None and not normalized_environment:
        return None, "validation waiver environment must be non-empty"
    candidates = [
        receipt
        for receipt in list_reviews(root, str(task.get("task_id")))
        if receipt.get("kind") == "validation_waiver"
        and receipt.get("check_id") == check_id
        and receipt.get("phase") == phase
        and receipt.get("scope_hash") == scope_hash
        and receipt.get("subject") == expected_subject
        and receipt.get("max_gate") == gate
        and isinstance(receipt.get("environment"), str)
        and bool(receipt.get("environment", "").strip())
        and (normalized_environment is None or receipt.get("environment") == normalized_environment)
    ]
    if not candidates:
        return None, (
            "no validation waiver matches the current scope, check, phase, subject, gate and environment"
        )
    receipt = _latest_receipt(candidates)
    valid, reason = review_validity(receipt, task, root=root)
    if not valid:
        return None, reason
    if not receipt.get("expires_at"):
        return None, "validation waiver must have an expiry"
    return receipt, "waived by user"


def find_effective_code_review(
    root: Path,
    task: Mapping[str, Any],
    commit: Optional[str] = None,
) -> Tuple[Optional[Dict[str, Any]], str]:
    return find_effective_review(root, task, "code", commit)


def find_effective_final_action_review(
    root: Path,
    task: Mapping[str, Any],
    action: str,
) -> Tuple[Optional[Dict[str, Any]], str]:
    if action not in ("merge", "deploy", "release"):
        raise GovernanceError("final action must be merge, deploy or release")
    git_evidence = task.get("git", {})
    selected = (
        git_evidence.get("committed_sha")
        if action == "merge"
        else git_evidence.get("merged_sha") or git_evidence.get("committed_sha")
    )
    try:
        subject = "commit:" + normalize_commit(selected, "final action subject")
    except GovernanceError as exc:
        return None, str(exc)
    candidates = [
        receipt
        for receipt in list_reviews(root, str(task.get("task_id")))
        if receipt.get("kind") == "final_action"
        and receipt.get("action") == action
        and receipt.get("subject") == subject
        and receipt.get("scope_hash") == canonical_scope_hash(task)
    ]
    if not candidates:
        return None, "no final-action receipt matches the current scope, action and commit"
    receipt = _latest_receipt(candidates)
    valid, reason = review_validity(receipt, task, root=root)
    if not valid:
        return None, reason
    if not receipt.get("expires_at"):
        return None, "final-action approval must have an expiry"
    return receipt, "final action approved by user"


def find_effective_irreversible_operation_review(
    root: Path,
    task: Mapping[str, Any],
    operation_id: str,
    target_digest: str,
) -> Tuple[Optional[Dict[str, Any]], str]:
    if not isinstance(operation_id, str) or not operation_id.strip():
        raise GovernanceError("operation_id must be a non-empty string")
    operation_id = operation_id.strip()
    target_digest = validate_target_digest(target_digest)
    scope_hash = canonical_scope_hash(task)
    candidates = [
        receipt
        for receipt in list_reviews(root, str(task.get("task_id")))
        if receipt.get("kind") == "irreversible_operation"
        and receipt.get("operation_id") == operation_id
        and receipt.get("target_digest") == target_digest
        and receipt.get("scope_hash") == scope_hash
    ]
    if not candidates:
        return None, "no irreversible-operation receipt matches the current scope, operation and target"
    receipt = _latest_receipt(candidates)
    valid, reason = review_validity(receipt, task, root=root)
    if not valid:
        return None, reason
    if not receipt.get("expires_at"):
        return None, "irreversible-operation approval must have an expiry"
    return receipt, "irreversible operation approved by user"


def find_effective_rework_review(
    root: Path,
    task: Mapping[str, Any],
) -> Tuple[Optional[Dict[str, Any]], str]:
    """Return a current, subject-bound user decision allowing verified rework."""

    effective_status = task.get("status")
    if effective_status == "BLOCKED":
        effective_status = task.get("exception", {}).get("previous_status")
    if effective_status != "LOCAL_VERIFIED":
        return None, "rework approval requires a LOCAL_VERIFIED task"
    subject = managed_content_subject(root, task)
    scope_hash = canonical_scope_hash(task)
    candidates = [
        receipt
        for receipt in list_reviews(root, str(task.get("task_id")))
        if receipt.get("kind") == "rework"
        and receipt.get("scope_hash") == scope_hash
        and receipt.get("subject") == subject
        and receipt.get("from_status") == "LOCAL_VERIFIED"
    ]
    if not candidates:
        return None, "no rework receipt matches the current scope and frozen workspace subject"
    receipt = _latest_receipt(candidates)
    valid, reason = review_validity(receipt, task, root=root)
    if not valid:
        return None, reason
    if not receipt.get("expires_at"):
        return None, "rework approval must have an expiry"
    return receipt, "rework approved by user conversation"


def validation_result_provenance_issues(
    task: Mapping[str, Any],
    result: Mapping[str, Any],
) -> List[str]:
    """Return reasons a claimed PASS is not derived from a trusted producer."""

    if result.get("status") != "passed":
        return []
    phase = result.get("phase")
    check_id = result.get("check_id")
    checks = [
        check for check in task.get("validation", {}).get("required", [])
        if isinstance(check, Mapping) and check.get("id") == check_id
    ]
    if len(checks) != 1:
        return ["passed result does not bind exactly one reviewed check"]
    check = checks[0]
    issues: List[str] = []
    if phase == "local":
        runner = "controlled-validation-runner-v1"
        if result.get("source") != runner or result.get("runner_version") != runner:
            issues.append("local PASS source is not the controlled runner")
        if result.get("actor") != "controlled-validation-runner":
            issues.append("local PASS actor is not the controlled runner")
        if result.get("scope_hash") != canonical_scope_hash(task):
            issues.append("local PASS scope hash does not match current reviewed scope")
        declared_argv = check.get("argv")
        if result.get("declared_argv") != declared_argv:
            issues.append("local PASS argv does not match the reviewed plan")
        expected_argv_digest = (
            "sha256:" + hashlib.sha256(canonical_json(declared_argv).encode("utf-8")).hexdigest()
        )
        if result.get("argv_sha256") != expected_argv_digest:
            issues.append("local PASS argv digest is invalid")
        try:
            reviewed_timeout = float(check.get("timeout_seconds"))
            recorded_timeout = float(result.get("timeout_seconds"))
            plan = {"argv": declared_argv, "timeout_seconds": reviewed_timeout}
            expected_plan_digest = (
                "sha256:" + hashlib.sha256(canonical_json(plan).encode("utf-8")).hexdigest()
            )
            if result.get("plan_sha256") != expected_plan_digest:
                issues.append("local PASS plan digest is invalid")
            if recorded_timeout != reviewed_timeout:
                issues.append("local PASS timeout does not match the reviewed plan")
        except (TypeError, ValueError):
            issues.append("local PASS timeout evidence is invalid")
        if result.get("exit_code") != 0 or result.get("timed_out") is not False:
            issues.append("local PASS was not derived from a zero non-timeout exit")
        if result.get("launch_error") is not None:
            issues.append("local PASS contains a launch error")
        if result.get("release_units") != check.get("release_units"):
            issues.append("local PASS release-unit binding differs from the reviewed check")
        release_unit = result.get("release_unit")
        if release_unit is not None and release_unit not in check.get("release_units", []):
            issues.append("local PASS names an unreviewed release unit")
        integrity = result.get("integrity")
        if not isinstance(integrity, Mapping):
            issues.append("local PASS lacks integrity evidence")
        else:
            if integrity.get("unchanged") is not True or integrity.get("issues") != []:
                issues.append("local PASS reports changed content or protected state")
            if integrity.get("scope_hash_before") != result.get("scope_hash"):
                issues.append("local PASS pre-run scope hash is inconsistent")
            if integrity.get("scope_hash_after") != result.get("scope_hash"):
                issues.append("local PASS post-run scope hash is inconsistent")
            if integrity.get("managed_content_subject_before") != result.get("subject"):
                issues.append("local PASS pre-run content subject is inconsistent")
            if integrity.get("managed_content_subject_after") != result.get("subject"):
                issues.append("local PASS post-run content subject is inconsistent")
            protected_before = integrity.get("protected_state_digest_before")
            if (
                not isinstance(protected_before, str)
                or not protected_before.startswith("protected-state:sha256:")
                or integrity.get("protected_state_digest_after") != protected_before
            ):
                issues.append("local PASS protected-state digest is invalid")
        for stream_name in ("stdout", "stderr"):
            stream = result.get(stream_name)
            if (
                not isinstance(stream, Mapping)
                or not isinstance(stream.get("byte_count"), int)
                or isinstance(stream.get("byte_count"), bool)
                or stream.get("byte_count", -1) < 0
                or not isinstance(stream.get("sha256"), str)
                or not re.fullmatch(r"[0-9a-f]{64}", stream.get("sha256", ""))
            ):
                issues.append("local PASS %s summary is invalid" % stream_name)
        try:
            started = parse_timestamp(result.get("started_at"))
            finished = parse_timestamp(result.get("finished_at"))
            recorded = parse_timestamp(result.get("recorded_at"))
            if started is None or finished is None or recorded != finished or finished < started:
                issues.append("local PASS timestamps are inconsistent")
        except GovernanceError:
            issues.append("local PASS timestamps are invalid")
        return issues

    if phase not in ("ci", "post_merge"):
        return ["passed result has an unknown phase"]
    if result.get("source") != "github_actions_rest_v1":
        issues.append("CI PASS source is not GitHub REST verification")
    github = result.get("github")
    if not isinstance(github, Mapping):
        return issues + ["CI PASS lacks GitHub REST evidence"]
    trust = task.get("ci_trust", {})
    content_field = "committed_sha" if phase == "ci" else "merged_sha"
    content_sha = task.get("git", {}).get(content_field)
    expected_branch = task.get("branch") if phase == "ci" else task.get("base_branch")
    allowed_events = trust.get("ci_events", []) if phase == "ci" else trust.get("post_merge_events", [])
    event = github.get("event")
    expected_jobs = trust.get("required_jobs", {}).get(event, [])
    if github.get("provider") != "github_actions_rest_v1":
        issues.append("CI PASS provider is invalid")
    if github.get("repository") != GITHUB_REPOSITORY:
        issues.append("CI PASS repository is invalid")
    if github.get("workflow_path") != GITHUB_WORKFLOW_PATH:
        issues.append("CI PASS workflow path is invalid")
    if github.get("api_version") != GITHUB_API_VERSION:
        issues.append("CI PASS API version is invalid")
    if event not in allowed_events:
        issues.append("CI PASS event is not approved for this phase")
    if github.get("head_branch") != expected_branch:
        issues.append("CI PASS branch does not match the reviewed phase branch")
    if github.get("status") != "completed" or github.get("conclusion") != "success":
        issues.append("CI PASS run is not completed successfully")
    run_id = github.get("run_id")
    run_attempt = github.get("run_attempt")
    run_url = github.get("run_url")
    if (
        not isinstance(run_id, str)
        or not re.fullmatch(r"[1-9][0-9]*", run_id)
        or result.get("run_id") != run_id
        or result.get("run_url") != run_url
        or not isinstance(run_attempt, int)
        or isinstance(run_attempt, bool)
        or run_attempt < 1
        or not isinstance(run_url, str)
        or not run_url.startswith("https://github.com/%s/actions/runs/%s" % (GITHUB_REPOSITORY, run_id))
    ):
        issues.append("CI PASS run identity is invalid")
    control_sha = github.get("control_head_sha")
    if (
        not isinstance(content_sha, str)
        or github.get("content_subject_sha") != content_sha
        or result.get("subject") != "commit:" + str(content_sha)
        or not isinstance(control_sha, str)
        or not re.fullmatch(r"[0-9a-f]{40}", control_sha)
        or github.get("head_sha") != control_sha
    ):
        issues.append("CI PASS content/control commit binding is invalid")
    job_names = github.get("job_names")
    required_names = github.get("required_job_names")
    if (
        not isinstance(job_names, list)
        or any(not isinstance(name, str) for name in job_names)
        or len(set(job_names)) != len(job_names)
        or set(expected_jobs) - set(job_names)
        or not isinstance(required_names, list)
        or set(required_names) != set(expected_jobs)
    ):
        issues.append("CI PASS required job coverage is invalid")
    return issues


def latest_validation_result(task: Mapping[str, Any], check_id: str, phase: Optional[str] = None) -> Optional[Dict[str, Any]]:
    results = task.get("validation", {}).get("results", [])
    matching = [
        result
        for result in results
        if result.get("check_id") == check_id and (phase is None or result.get("phase") == phase)
    ]
    return matching[-1] if matching else None


def _latest_validation_result_for_unit(
    task: Mapping[str, Any],
    check_id: str,
    phase: str,
    release_unit: Optional[str],
) -> Optional[Dict[str, Any]]:
    """Return the latest result that covers one reviewed release unit.

    A result without ``release_unit`` is an explicitly reviewed common run and
    covers every unit declared by the check. A later unit-specific result
    overrides that common run only for its own unit.
    """

    matching = []
    for result in task.get("validation", {}).get("results", []):
        if result.get("check_id") != check_id or result.get("phase") != phase:
            continue
        recorded_unit = result.get("release_unit")
        if release_unit is None:
            if recorded_unit is None:
                matching.append(result)
        elif recorded_unit is None or recorded_unit == release_unit:
            matching.append(result)
    return matching[-1] if matching else None


def missing_validations(task: Mapping[str, Any], gate: str) -> List[str]:
    phase = GATE_PHASES.get(gate)
    if phase is None:
        raise GovernanceError("unknown validation gate: %s" % gate)
    missing: List[str] = []
    for check in task.get("validation", {}).get("required", []):
        if gate not in check.get("gates", []):
            continue
        check_id = str(check.get("id"))
        units = check.get("release_units", []) or [None]
        for unit in units:
            result = _latest_validation_result_for_unit(task, check_id, phase, unit)
            if result is None or result.get("status") != "passed":
                missing.append("%s[%s]" % (check_id, unit) if unit else check_id)
    return missing


def expected_validation_subject(
    root: Path,
    task: Mapping[str, Any],
    gate: str,
) -> Tuple[Optional[str], Optional[str]]:
    phase = GATE_PHASES.get(gate)
    if phase is None:
        raise GovernanceError("unknown validation gate: %s" % gate)
    if phase == "local":
        # After commit-task freezes a task, its local evidence remains bound to
        # the immutable reviewed content. Descendant stack work may otherwise
        # match broad allowed paths and retroactively invalidate that evidence.
        frozen_states = NORMAL_STATES[NORMAL_STATES.index("COMMITTED"):]
        if task.get("status") in frozen_states and task.get("git", {}).get("committed_sha"):
            subjects = set()
            for check in task.get("validation", {}).get("required", []):
                if gate not in check.get("gates", []):
                    continue
                check_id = str(check.get("id"))
                for unit in check.get("release_units", []) or [None]:
                    result = _latest_validation_result_for_unit(task, check_id, phase, unit)
                    if result is None or result.get("status") not in ("passed", "skipped"):
                        continue
                    subject = result.get("subject")
                    if not isinstance(subject, str) or not re.fullmatch(
                        r"workspace:sha256:[0-9a-f]{64}", subject
                    ):
                        return None, "frozen local validation subject is invalid"
                    subjects.add(subject)
            if len(subjects) == 1:
                return next(iter(subjects)), None
            if len(subjects) > 1:
                return None, "frozen local validation results disagree on content subject"
        return managed_content_subject(root, task), None
    git_evidence = task.get("git", {})
    field = "committed_sha" if phase == "ci" else "merged_sha"
    commit = git_evidence.get(field) if isinstance(git_evidence, dict) else None
    if not commit:
        return None, "task.git.%s is not recorded" % field
    try:
        normalized = normalize_commit(commit, "task.git.%s" % field)
    except GovernanceError as exc:
        return None, str(exc)
    return "commit:" + normalized, None


def validation_gate_status(root: Path, task: Mapping[str, Any], gate: str) -> Dict[str, Any]:
    """Evaluate a gate without ever converting a skipped check into passed."""

    phase = GATE_PHASES.get(gate)
    if phase is None:
        raise GovernanceError("unknown validation gate: %s" % gate)
    expected_subject, subject_error = expected_validation_subject(root, task, gate)
    passed: List[str] = []
    missing: List[Dict[str, Any]] = []
    waived: List[Dict[str, Any]] = []
    for check in task.get("validation", {}).get("required", []):
        if gate not in check.get("gates", []):
            continue
        check_id = str(check.get("id"))
        units = check.get("release_units", []) or [None]
        every_unit_passed = True
        for unit in units:
            result = _latest_validation_result_for_unit(task, check_id, phase, unit)
            item: Dict[str, Any] = {"check_id": check_id}
            if unit is not None:
                item["release_unit"] = unit
            unit_prefix = "%s: " % unit if unit is not None else ""
            if subject_error:
                item["reason"] = unit_prefix + subject_error
                missing.append(item)
                every_unit_passed = False
                continue
            if result is not None and result.get("subject") != expected_subject:
                item["reason"] = (
                    unit_prefix
                    + "%s validation subject no longer matches the gate subject" % phase
                )
                missing.append(item)
                every_unit_passed = False
                continue
            if result is not None:
                environment = result.get("environment")
                if not isinstance(environment, str) or not environment.strip():
                    item["reason"] = unit_prefix + "%s evidence lacks environment" % phase
                    missing.append(item)
                    every_unit_passed = False
                    continue
            if phase in ("ci", "post_merge") and result is not None:
                run_id = result.get("run_id")
                run_url = result.get("run_url")
                if (
                    not isinstance(run_id, str)
                    or not re.fullmatch(r"[1-9][0-9]*", run_id)
                    or not isinstance(run_url, str)
                    or not run_url.startswith("https://github.com/")
                    or "/actions/runs/" + run_id not in run_url
                ):
                    item["reason"] = (
                        unit_prefix
                        + "%s evidence lacks a matching GitHub Actions run id/url" % phase
                    )
                    missing.append(item)
                    every_unit_passed = False
                    continue
            if result is not None and result.get("status") == "passed":
                provenance_issues = validation_result_provenance_issues(task, result)
                if provenance_issues:
                    item["reason"] = (
                        unit_prefix
                        + "validation PASS provenance is invalid: %s"
                        % "; ".join(provenance_issues)
                    )
                    missing.append(item)
                    every_unit_passed = False
                continue
            if result is not None and result.get("status") == "skipped":
                receipt, reason = find_effective_validation_waiver(
                    root,
                    task,
                    check_id,
                    phase,
                    result.get("environment"),
                )
                if receipt is not None and result.get("waiver_id") == receipt.get("review_id"):
                    waiver_item = {
                        "check_id": check_id,
                        "status": "waived",
                        "validation_result_status": "skipped",
                        "waiver_id": receipt.get("review_id"),
                        "phase": phase,
                        "subject": expected_subject,
                        "reason": receipt.get("reason"),
                        "expires_at": receipt.get("expires_at"),
                    }
                    if unit is not None:
                        waiver_item["release_unit"] = unit
                    waived.append(waiver_item)
                    every_unit_passed = False
                    continue
                if receipt is not None:
                    reason = "skipped result does not reference the effective waiver"
                item["reason"] = unit_prefix + reason
                missing.append(item)
                every_unit_passed = False
                continue
            reason = (
                "no validation result"
                if result is None
                else "latest result is %s" % result.get("status")
            )
            item["reason"] = unit_prefix + reason
            missing.append(item)
            every_unit_passed = False
        if every_unit_passed:
            passed.append(check_id)
    return {"passed": passed, "waived": waived, "missing": missing}


def normalize_repo_path(root: Path, value: str) -> Optional[str]:
    candidate = Path(value)
    absolute = candidate.resolve() if candidate.is_absolute() else (root / candidate).resolve()
    try:
        relative = absolute.relative_to(root.resolve())
    except ValueError:
        return None
    return relative.as_posix()


def path_is_allowed(root: Path, path: str, patterns: Sequence[str]) -> bool:
    relative = normalize_repo_path(root, path)
    if relative is None:
        return False
    for pattern in patterns:
        cleaned = str(pattern).rstrip("/")
        base = cleaned[:-3].rstrip("/") if cleaned.endswith("/**") else None
        if relative == cleaned or (base is not None and (relative == base or relative.startswith(base + "/"))):
            return True
        if fnmatch.fnmatchcase(relative, cleaned):
            return True
    return False


def command_is_allowed(command: str, prefixes: Sequence[str]) -> bool:
    normalized = " ".join(command.strip().split())
    return any(normalized == prefix or normalized.startswith(prefix + " ") for prefix in prefixes)


def tool_is_allowed(tool: str, allowed_tools: Iterable[str]) -> bool:
    wanted = tool.strip().lower().replace("_", "").replace("-", "")
    return any(wanted == str(item).strip().lower().replace("_", "").replace("-", "") for item in allowed_tools)


def status_index(status: str) -> int:
    try:
        return NORMAL_STATES.index(status)
    except ValueError:
        return -1


def json_result(payload: Mapping[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True)


def write_output(value: Any, stream: Optional[Any] = None, end: str = "\n") -> None:
    """Write deterministic UTF-8 output across consoles and redirected streams.

    Windows may expose a legacy text encoding such as CP1252 even though
    governance JSON contains Chinese.  Writing UTF-8 through the underlying
    binary buffer avoids locale-dependent UnicodeEncodeError.  StringIO and
    other text-only test streams remain supported.
    """

    target = stream if stream is not None else sys.stdout
    rendered = str(value) + end
    binary = getattr(target, "buffer", None)
    if binary is not None:
        binary.write(rendered.encode("utf-8"))
        binary.flush()
        return
    target.write(rendered)
    flush = getattr(target, "flush", None)
    if callable(flush):
        flush()
