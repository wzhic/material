#!/usr/bin/env python3
"""Manage task state without third-party dependencies."""

from __future__ import annotations

import argparse
import copy
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional

from core import (
    GATE_PHASES,
    GovernanceError,
    NORMAL_STATES,
    SCOPE_EDITABLE_FIELDS,
    TASK_STATES,
    VALIDATION_STATUSES,
    VALIDATION_PHASES,
    allowed_transition,
    active_bootstrap_recovery_contract,
    branch_validity,
    BOOTSTRAP_TASK_ID,
    bootstrap_recovery_contract_for_parent,
    bootstrap_repair_commit_issues,
    canonical_scope,
    canonical_scope_hash,
    control_dir,
    current_branch,
    current_task_id,
    default_root,
    find_effective_review,
    find_effective_code_review,
    find_effective_rework_review,
    find_effective_validation_waiver,
    json_result,
    legacy_g0_v1_migration,
    list_reviews,
    load_current_task,
    load_task,
    managed_content_subject,
    normalize_commit,
    path_is_allowed,
    read_json,
    recovery_proposal_path,
    review_validity,
    run_git,
    task_path,
    utc_now,
    validation_gate_status,
    validate_task,
    validate_bootstrap_recovery_contract,
    validation_plan_issues,
    write_output,
    write_json_atomic,
)
from github_evidence import GitHubEvidenceError, verify_workflow_run
from validation_runner import (
    RUNNER_VERSION,
    run_one as run_controlled_validation,
    run_required as run_controlled_required,
)


_CURRENT_TASK_TARGETS = frozenset(NORMAL_STATES[3:])
_WORK_BRANCH_TARGETS = frozenset((
    "READY",
    "IN_PROGRESS",
    "LOCAL_VERIFIED",
    "COMMITTED",
    "CI_VERIFIED",
    "CODE_REVIEWED",
))
_SELECTABLE_TERMINAL_STATES = frozenset(("DONE", "CANCELLED"))
_PHASE_RECORD_STATES = {
    "local": "IN_PROGRESS",
    "ci": "COMMITTED",
    "post_merge": "MERGED",
}
_GITHUB_RUN_ID = re.compile(r"^[1-9][0-9]*$")
_GITHUB_SHA = re.compile(r"^[0-9a-f]{40}$")
_BOOTSTRAP_SOURCE_REPOSITORY = "git@github.com:wzhic/material.git"
_BOOTSTRAP_PUSH_URL = "ssh://git@ssh.github.com:443/wzhic/material.git"
_BOOTSTRAP_CONTENT_MESSAGE = "chore(governance): establish G0 baseline"
_BOOTSTRAP_CONTROL_MESSAGE = "chore(governance): record G0 content commit"


def _protected_control_path(path: str) -> bool:
    normalized = path.replace("\\", "/").lstrip("./")
    return (
        normalized == "project-control/current-task.json"
        or normalized.startswith("project-control/tasks/")
        or normalized.startswith("project-control/reviews/")
    )


def _git(root: Path, arguments: tuple[str, ...], purpose: str) -> str:
    output, error = run_git(root, arguments)
    if error:
        raise GovernanceError("%s: %s" % (purpose, error))
    return output or ""


def _nul_paths(output: str) -> List[str]:
    return [item for item in output.split("\0") if item]


def _require_exact_bootstrap_task(
    root: Path,
    task: Dict[str, Any],
    expected_status: str,
) -> None:
    _require_current_task(root, task)
    _require_complete_validation_plan(task)
    _require_scope_review(root, task)
    _require_work_branch(root, task)
    if task.get("task_id") != BOOTSTRAP_TASK_ID:
        raise GovernanceError("bootstrap Git transport is limited to GOV-0001")
    if task.get("status") != expected_status:
        raise GovernanceError(
            "bootstrap Git transport requires task status %s, found %s"
            % (expected_status, task.get("status"))
        )
    if task.get("branch") != "main" or task.get("base_branch") != "main":
        raise GovernanceError("bootstrap Git transport is limited to main/main")
    exception = task.get("branch_exception")
    if not isinstance(exception, dict) or exception.get("kind") != "bootstrap-main" or (
        exception.get("applies_only_to_task") != BOOTSTRAP_TASK_ID
    ):
        raise GovernanceError("bootstrap Git transport requires the exact GOV-0001 branch exception")
    project = read_json(control_dir(root) / "project.json")
    if project.get("source_repository") != _BOOTSTRAP_SOURCE_REPOSITORY:
        raise GovernanceError("bootstrap source repository does not match the fixed GitHub repository")
    if project.get("branch_policy", {}).get("bootstrap_main_tasks") != [BOOTSTRAP_TASK_ID]:
        raise GovernanceError("bootstrap main trust root must be exactly GOV-0001")


def _require_root_commit(root: Path, commit: str) -> None:
    line = _git(root, ("rev-list", "--parents", "-n", "1", commit), "cannot inspect commit parents")
    words = line.split()
    if words != [commit]:
        raise GovernanceError("bootstrap content commit must be the repository root commit")


def _require_repair_authorization(
    task: Dict[str, Any], contract: Mapping[str, Any]
) -> None:
    if contract.get("authorization_kind") == "irreversible_operation":
        marker = task.get("bootstrap_recovery", {})
        if (
            not isinstance(marker, Mapping)
            or marker.get("review_id") != contract.get("review_id")
            or marker.get("target_digest") != contract.get("target_digest")
        ):
            raise GovernanceError("receipt-bound recovery activation is missing or drifted")
        return
    review_id = str(contract["review_id"])
    history = task.get("rework_history", [])
    if not isinstance(history, list) or not any(
        isinstance(item, dict) and item.get("review_id") == review_id
        for item in history
    ):
        raise GovernanceError(
            "failed bootstrap repair requires recorded %s rework authorization" % review_id
        )


def _bootstrap_content_subject_mode(
    root: Path,
    commit: str,
    task: Optional[Mapping[str, Any]] = None,
) -> str:
    line = _git(root, ("rev-list", "--parents", "-n", "1", commit), "cannot inspect content parents")
    if line.split() == [commit]:
        return "root"
    issues = bootstrap_repair_commit_issues(root, commit, task)
    if issues:
        raise GovernanceError("invalid failed-bootstrap repair content: %s" % "; ".join(issues))
    return "repair"


def _require_allowed_snapshot(root: Path, task: Dict[str, Any], commit: str) -> List[str]:
    paths = _nul_paths(
        _git(root, ("ls-tree", "-r", "--name-only", "-z", commit), "cannot inspect commit snapshot")
    )
    if not paths:
        raise GovernanceError("bootstrap content snapshot may not be empty")
    outside = [path for path in paths if not path_is_allowed(root, path, task["allowed_paths"])]
    if outside:
        raise GovernanceError(
            "bootstrap content snapshot contains paths outside reviewed scope: %s"
            % ", ".join(sorted(outside))
        )
    return paths


def _configure_fixed_origin(root: Path) -> None:
    existing, error = run_git(root, ("remote", "get-url", "origin"))
    if error:
        remotes = _git(root, ("remote",), "cannot inspect Git remotes").splitlines()
        if "origin" in remotes:
            raise GovernanceError("origin exists but its URL cannot be verified")
        _git(
            root,
            ("remote", "add", "origin", _BOOTSTRAP_SOURCE_REPOSITORY),
            "cannot configure the fixed origin",
        )
        return
    if existing != _BOOTSTRAP_SOURCE_REPOSITORY:
        raise GovernanceError("origin does not match the fixed repository; refusing to overwrite it")


def _bootstrap_commit(root: Path, task: Dict[str, Any], stage: str) -> Dict[str, Any]:
    expected_status = "LOCAL_VERIFIED" if stage == "content" else "COMMITTED"
    _require_exact_bootstrap_task(root, task, expected_status)
    content_mode = "control"
    repair_contract: Optional[Mapping[str, Any]] = None
    if stage == "content":
        if task.get("git", {}).get("committed_sha"):
            raise GovernanceError("content commit is already recorded")
        count = _git(root, ("rev-list", "--all", "--count"), "cannot inspect repository history")
        recovery = count != "0"
        if recovery:
            head = normalize_commit(
                _git(root, ("rev-parse", "HEAD"), "cannot resolve failed bootstrap root"),
                "HEAD",
            )
            repair_contract = bootstrap_recovery_contract_for_parent(root, head, task)
            if repair_contract is None:
                raise GovernanceError(
                    "bootstrap repair must start at an exact reviewed failed content head"
                )
            if int(count) != int(repair_contract["history_count"]):
                raise GovernanceError("bootstrap repair history contains an unexpected side branch")
            if repair_contract.get("authorization_kind") == "irreversible_operation":
                if head != repair_contract.get("failed_control_head"):
                    raise GovernanceError(
                        "receipt-bound recovery must start at its exact failed control head"
                    )
            elif int(count) == 1:
                _require_root_commit(root, head)
            else:
                prior_issues = bootstrap_repair_commit_issues(root, head, task)
                if prior_issues:
                    raise GovernanceError(
                        "R009 repair parent is not the exact R007 content commit: %s"
                        % "; ".join(prior_issues)
                    )
            _require_repair_authorization(task, repair_contract)
        gate = validation_gate_status(root, task, "LOCAL_VERIFIED")
        if gate["missing"]:
            raise GovernanceError("bootstrap content commit requires complete local validation")
        from reconcile import run_reconcile

        report = run_reconcile(root, "precommit")
        if not report.get("ok"):
            failed = [
                str(item.get("message")) for item in report.get("checks", [])
                if item.get("status") == "failed"
            ]
            raise GovernanceError(
                "bootstrap content commit requires a clean precommit reconcile: %s"
                % ("; ".join(failed) or "unknown reconcile failure")
            )
        if recovery:
            candidates = list(dict.fromkeys(
                _nul_paths(_git(root, ("diff", "--name-only", "-z"), "cannot inspect repair changes"))
                + _nul_paths(_git(root, ("diff", "--cached", "--name-only", "-z"), "cannot inspect staged repair changes"))
                + _nul_paths(_git(root, ("ls-files", "--others", "--exclude-standard", "-z"), "cannot inspect repair files"))
            ))
        else:
            candidates = _nul_paths(
                _git(
                    root,
                    ("ls-files", "--cached", "--others", "--exclude-standard", "-z"),
                    "cannot enumerate bootstrap content",
                )
            )
        if not candidates:
            raise GovernanceError("bootstrap content commit has no reviewed files")
        if recovery:
            assert repair_contract is not None
            outside = sorted(set(candidates) - set(repair_contract["allowed_paths"]))
        else:
            outside = [path for path in candidates if not path_is_allowed(root, path, task["allowed_paths"])]
        if outside:
            raise GovernanceError(
                "bootstrap content contains paths outside reviewed scope: %s"
                % ", ".join(sorted(outside))
            )
        message = str(repair_contract["message"]) if recovery else _BOOTSTRAP_CONTENT_MESSAGE
        content_mode = "repair" if recovery else "root"
    else:
        content_sha = normalize_commit(task.get("git", {}).get("committed_sha"), "task.git.committed_sha")
        head = normalize_commit(
            _git(root, ("rev-parse", "HEAD"), "cannot resolve current HEAD"),
            "HEAD",
        )
        if head != content_sha:
            raise GovernanceError("control commit must start directly from the recorded content commit")
        _bootstrap_content_subject_mode(root, content_sha, task)
        candidates = list(dict.fromkeys(
            _nul_paths(_git(root, ("diff", "--name-only", "-z"), "cannot inspect unstaged changes"))
            + _nul_paths(_git(root, ("diff", "--cached", "--name-only", "-z"), "cannot inspect staged changes"))
            + _nul_paths(_git(root, ("ls-files", "--others", "--exclude-standard", "-z"), "cannot inspect untracked files"))
        ))
        if not candidates:
            raise GovernanceError("control commit has no protected state change")
        outside = [path for path in candidates if not _protected_control_path(path)]
        if outside:
            raise GovernanceError(
                "control commit contains ordinary project changes: %s"
                % ", ".join(sorted(outside))
            )
        message = _BOOTSTRAP_CONTROL_MESSAGE

    _git(root, ("add", "--all"), "cannot stage bootstrap commit")
    staged = _nul_paths(
        _git(root, ("diff", "--cached", "--name-only", "--diff-filter=ACDMRTUXB", "-z"), "cannot inspect staged commit")
    )
    if not staged:
        raise GovernanceError("bootstrap commit staging produced an empty commit")
    if stage == "content" and content_mode == "repair":
        assert repair_contract is not None
        invalid = sorted(set(staged) - set(repair_contract["allowed_paths"]))
    elif stage == "content":
        invalid = [path for path in staged if not path_is_allowed(root, path, task["allowed_paths"])]
    else:
        invalid = [path for path in staged if not _protected_control_path(path)]
    if invalid:
        raise GovernanceError("staged bootstrap commit contains prohibited paths: %s" % ", ".join(sorted(invalid)))
    _git(root, ("diff", "--cached", "--check"), "staged bootstrap commit failed whitespace checks")
    _git(
        root,
        (
            "-c", "user.name=Codex Governance",
            "-c", "user.email=codex-governance@users.noreply.github.com",
            "-c", "commit.gpgSign=false",
            "commit", "-m", message,
        ),
        "cannot create bootstrap commit",
    )
    commit = normalize_commit(_git(root, ("rev-parse", "HEAD"), "cannot resolve created commit"), "HEAD")
    if stage == "content":
        actual_mode = _bootstrap_content_subject_mode(root, commit, task)
        if actual_mode != content_mode:
            raise GovernanceError("created bootstrap content does not match the selected transport mode")
        _require_allowed_snapshot(root, task, commit)
    else:
        content_sha = normalize_commit(task.get("git", {}).get("committed_sha"), "task.git.committed_sha")
        line = _git(root, ("rev-list", "--parents", "-n", "1", commit), "cannot inspect control parent")
        if line.split() != [commit, content_sha]:
            raise GovernanceError("control commit must have the content commit as its only parent")
        _verify_content_control_commits(root, content_sha, commit)
    dirty = _git(root, ("status", "--porcelain", "--untracked-files=all"), "cannot verify clean worktree")
    if dirty:
        raise GovernanceError("bootstrap commit left unexpected worktree changes")
    return {
        "stage": stage,
        "mode": content_mode,
        "commit": commit,
        "paths": sorted(staged),
        "message": message,
    }


def _remote_branch_sha(output: str) -> Optional[str]:
    lines = [line for line in output.splitlines() if line.strip()]
    if len(lines) != 1:
        return None
    fields = lines[0].split()
    if len(fields) != 2 or fields[1] != "refs/heads/main" or not _GITHUB_SHA.fullmatch(fields[0]):
        return None
    return fields[0]


def _bootstrap_push(root: Path, task: Dict[str, Any], stage: str) -> Dict[str, Any]:
    expected_status = "LOCAL_VERIFIED" if stage == "content" else "COMMITTED"
    _require_exact_bootstrap_task(root, task, expected_status)
    head = normalize_commit(_git(root, ("rev-parse", "HEAD"), "cannot resolve push head"), "HEAD")
    _configure_fixed_origin(root)
    content_mode = "control"
    if stage == "content":
        if task.get("git", {}).get("committed_sha"):
            raise GovernanceError("content push must occur before the content SHA is recorded")
        content_mode = _bootstrap_content_subject_mode(root, head, task)
        _require_allowed_snapshot(root, task, head)
        if content_mode == "repair":
            parents = _git(
                root,
                ("rev-list", "--parents", "-n", "1", head),
                "cannot inspect failed-bootstrap repair parent",
            ).split()
            if len(parents) != 2 or parents[0] != head:
                raise GovernanceError("failed-bootstrap repair must have exactly one parent")
            repair_contract = bootstrap_recovery_contract_for_parent(root, parents[1], task)
            if repair_contract is None:
                raise GovernanceError(
                    "repair push is outside the finite or receipt-bound recovery chain"
                )
            _require_repair_authorization(task, repair_contract)
            remote_state = _git(
                root,
                ("ls-remote", _BOOTSTRAP_PUSH_URL, "refs/heads/main"),
                "cannot verify failed bootstrap remote",
            )
            expected_before = _remote_branch_sha(remote_state)
            if expected_before != repair_contract["parent_sha"]:
                raise GovernanceError(
                    "%s repair push requires remote main at its exact failed parent"
                    % repair_contract["review_id"]
                )
        else:
            remote_state = _git(root, ("ls-remote", _BOOTSTRAP_PUSH_URL), "cannot verify empty remote")
            if remote_state:
                raise GovernanceError("bootstrap content push requires a completely empty remote")
            expected_before = None
    else:
        content_sha = normalize_commit(task.get("git", {}).get("committed_sha"), "task.git.committed_sha")
        if head == content_sha:
            raise GovernanceError("control push requires a distinct protected control commit")
        _bootstrap_content_subject_mode(root, content_sha, task)
        _verify_content_control_commits(root, content_sha, head)
        remote_state = _git(
            root,
            ("ls-remote", _BOOTSTRAP_PUSH_URL, "refs/heads/main"),
            "cannot verify remote content commit",
        )
        expected_before = _remote_branch_sha(remote_state)
        if expected_before != content_sha:
            raise GovernanceError("remote main must equal the recorded content commit before control push")
    _git(
        root,
        ("push", _BOOTSTRAP_PUSH_URL, "HEAD:refs/heads/main"),
        "bootstrap push failed without force",
    )
    verified = _remote_branch_sha(
        _git(
            root,
            ("ls-remote", _BOOTSTRAP_PUSH_URL, "refs/heads/main"),
            "cannot verify pushed main",
        )
    )
    if verified != head:
        raise GovernanceError("remote main does not match the pushed bootstrap commit")
    return {
        "stage": stage,
        "mode": content_mode,
        "commit": head,
        "remote": _BOOTSTRAP_SOURCE_REPOSITORY,
        "transport": _BOOTSTRAP_PUSH_URL,
        "previous_remote_sha": expected_before,
        "remote_main_sha": verified,
        "forced": False,
    }


def _verify_content_control_commits(root: Path, content_sha: str, control_sha: str) -> None:
    if content_sha == control_sha:
        return
    _output, ancestor_error = run_git(root, ("merge-base", "--is-ancestor", content_sha, control_sha))
    if ancestor_error:
        raise GovernanceError(
            "GitHub run head must contain the task content commit: %s" % ancestor_error
        )
    changed, diff_error = run_git(root, ("diff", "--name-only", content_sha + ".." + control_sha))
    if diff_error:
        raise GovernanceError("cannot verify content/control commit diff: %s" % diff_error)
    outside = [path for path in (changed or "").splitlines() if not _protected_control_path(path)]
    if outside:
        raise GovernanceError(
            "content/control commit range contains ordinary project changes: %s"
            % ", ".join(sorted(outside))
        )


def _root(value: str) -> Path:
    return Path(value).resolve()


def _emit(payload: Dict[str, Any], as_json: bool) -> None:
    if as_json:
        write_output(json_result(payload))
        return
    if "task" in payload:
        task = payload["task"]
        if "status" not in task:
            write_output(json_result(task))
            return
        write_output("%s %s (%s@%s)" % (
            task["task_id"], task["status"], task["requirement"]["id"], task["requirement"]["version"]
        ))
        return
    if "tasks" in payload:
        for task in payload["tasks"]:
            write_output("%s\t%s\t%s" % (task["task_id"], task["status"], task.get("summary", "")))
        return
    write_output(payload.get("message", json_result(payload)))


def _load_requested(root: Path, task_id: Optional[str]) -> Dict[str, Any]:
    return load_task(root, task_id) if task_id else load_current_task(root)


def _require_current_task(root: Path, task: Dict[str, Any]) -> None:
    selected = current_task_id(root)
    if selected != task["task_id"]:
        raise GovernanceError(
            "critical progress is limited to the current task: selected %s, requested %s"
            % (selected, task["task_id"])
        )


def _require_work_branch(root: Path, task: Dict[str, Any]) -> None:
    valid, branch_reason, _actual, _bootstrap = branch_validity(root, task)
    if not valid:
        raise GovernanceError(branch_reason)


def _require_done_dependencies(root: Path, task: Dict[str, Any]) -> None:
    incomplete: List[str] = []
    for dependency_id in task["dependencies"]:
        try:
            dependency = load_task(root, dependency_id)
        except GovernanceError as exc:
            incomplete.append("%s (%s)" % (dependency_id, exc))
            continue
        if dependency["status"] != "DONE":
            incomplete.append("%s (%s)" % (dependency_id, dependency["status"]))
    if incomplete:
        raise GovernanceError("dependencies must exist and be DONE before READY: %s" % ", ".join(incomplete))


def _require_complete_validation_plan(task: Dict[str, Any]) -> None:
    issues = validation_plan_issues(task)
    if issues:
        raise GovernanceError("validation plan is incomplete: %s" % "; ".join(issues))


def _require_scope_review(root: Path, task: Dict[str, Any]) -> None:
    receipt, reason = find_effective_review(root, task)
    if receipt is None:
        raise GovernanceError("current scope is not approved: %s" % reason)


def _require_validation_branch(root: Path, task: Dict[str, Any], phase: str) -> None:
    if phase in ("local", "ci"):
        _require_work_branch(root, task)
        return
    actual, error = current_branch(root)
    expected = task.get("base_branch")
    if error:
        raise GovernanceError(error)
    if not isinstance(expected, str) or not expected.strip() or actual != expected:
        raise GovernanceError(
            "post_merge validation branch mismatch: expected %s, found %s" % (expected, actual)
        )


def _transition(
    root: Path,
    task: Dict[str, Any],
    target: str,
    actor: str,
    reason: str,
    commit: Optional[str] = None,
) -> Dict[str, Any]:
    current = str(task["status"])
    if not actor.strip() or not reason.strip():
        raise GovernanceError("actor and reason must be non-empty")
    blocked_from = task.get("exception", {}).get("previous_status")
    if not allowed_transition(current, target, blocked_from):
        raise GovernanceError("transition is not allowed: %s -> %s" % (current, target))

    if target in _CURRENT_TASK_TARGETS:
        _require_current_task(root, task)
    legacy_g0_resume = (
        current == "BLOCKED"
        and target == blocked_from == "IN_PROGRESS"
        and legacy_g0_v1_migration(task)
    )
    if target in NORMAL_STATES[3:] and not legacy_g0_resume:
        _require_complete_validation_plan(task)
    if target in _WORK_BRANCH_TARGETS:
        _require_work_branch(root, task)
    if target == "READY":
        _require_done_dependencies(root, task)
        if not isinstance(task.get("base_branch"), str) or not task.get("base_branch", "").strip():
            raise GovernanceError("base_branch must be recorded in reviewed scope before READY")
        if task.get("requirement", {}).get("interaction_kind") not in ("ui", "non_ui", "mixed"):
            raise GovernanceError(
                "requirement.interaction_kind must be recorded as ui, non_ui or mixed before READY"
            )

    normalized_commit: Optional[str] = None
    if target in ("COMMITTED", "MERGED"):
        if not commit:
            raise GovernanceError("transition to %s requires --commit" % target)
        normalized_commit = normalize_commit(commit)
    elif commit:
        raise GovernanceError("--commit is only valid when entering COMMITTED or MERGED")

    approval_required = target in NORMAL_STATES[2:] or (
        current in NORMAL_STATES[2:] and target not in ("CANCELLED", "FAILED", "BLOCKED")
    )
    if approval_required:
        effective_review, reason_invalid = find_effective_review(root, task)
        if effective_review is None:
            raise GovernanceError("current scope is not approved: %s" % reason_invalid)

    target_index = NORMAL_STATES.index(target) if target in NORMAL_STATES else -1
    required_gates = [
        gate_name for gate_name in GATE_PHASES
        if target_index >= NORMAL_STATES.index(gate_name)
    ]
    for gate_name in required_gates:
        gate = validation_gate_status(root, task, gate_name)
        if gate["missing"]:
            raise GovernanceError("required %s validations are not satisfied: %s" % (
                gate_name,
                ", ".join("%s (%s)" % (item["check_id"], item["reason"]) for item in gate["missing"]),
            ))

    if target_index >= NORMAL_STATES.index("CODE_REVIEWED"):
        code_receipt, code_reason = find_effective_code_review(root, task)
        if code_receipt is None:
            raise GovernanceError("verified commit has no effective user code review: %s" % code_reason)

    timestamp = utc_now()
    task.setdefault("history", []).append({
        "from": current,
        "to": target,
        "at": timestamp,
        "actor": actor,
        "reason": reason,
    })
    if target == "BLOCKED":
        task["exception"] = {"previous_status": current, "reason": reason, "recorded_at": timestamp}
    elif current == "BLOCKED" or target in NORMAL_STATES:
        task.pop("exception", None)
    task["status"] = target
    if target == "COMMITTED":
        task.setdefault("git", {})["committed_sha"] = normalized_commit
        task["git"].pop("ci_verified_sha", None)
    elif target == "CI_VERIFIED":
        committed_sha = task.get("git", {}).get("committed_sha")
        if not committed_sha:
            raise GovernanceError("CI_VERIFIED requires task.git.committed_sha")
        task.setdefault("git", {})["ci_verified_sha"] = committed_sha
    elif target == "MERGED":
        task.setdefault("git", {})["merged_sha"] = normalized_commit
        task["git"].pop("post_merge_verified_sha", None)
    elif target == "POST_MERGE_VERIFIED":
        merged_sha = task.get("git", {}).get("merged_sha")
        if not merged_sha:
            raise GovernanceError("POST_MERGE_VERIFIED requires task.git.merged_sha")
        task.setdefault("git", {})["post_merge_verified_sha"] = merged_sha
    task["updated_at"] = timestamp
    validate_task(task)
    write_json_atomic(task_path(root, str(task["task_id"])), task)
    return task


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="taskctl", description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    def common(subparser: argparse.ArgumentParser) -> None:
        subparser.add_argument("--root", type=_root, default=default_root())
        subparser.add_argument("--json", action="store_true")

    current = subparsers.add_parser("current", help="show the current task")
    common(current)

    show = subparsers.add_parser("show", help="show one task")
    show.add_argument("task_id", nargs="?")
    show.add_argument("--scope", action="store_true", help="show only review-bound scope")
    common(show)

    listing = subparsers.add_parser("list", help="list all tasks")
    common(listing)

    scope_hash = subparsers.add_parser("scope-hash", help="print canonical scope hash")
    scope_hash.add_argument("task_id", nargs="?")
    common(scope_hash)

    transition = subparsers.add_parser("transition", help="perform one allowed state transition")
    transition.add_argument("task_id")
    transition.add_argument("target", choices=sorted(TASK_STATES))
    transition.add_argument("--actor", required=True)
    transition.add_argument("--reason", required=True)
    transition.add_argument("--commit", help="exact commit when entering COMMITTED or MERGED")
    common(transition)

    validation = subparsers.add_parser(
        "record-validation",
        help="append non-passing validation evidence; PASS is reserved for controlled runners",
    )
    validation.add_argument("task_id")
    validation.add_argument("--check", required=True, dest="check_id")
    validation.add_argument(
        "--status",
        required=True,
        choices=sorted(VALIDATION_STATUSES),
        help="failed, blocked or waived skipped evidence only; passed is rejected on this public CLI",
    )
    validation.add_argument("--phase", required=True, choices=sorted(VALIDATION_PHASES))
    validation.add_argument("--commit", help="required exact commit for ci and post_merge evidence")
    validation.add_argument(
        "--environment",
        help="execution environment; defaults to local for local evidence and is required otherwise",
    )
    validation.add_argument("--run-id", help="required GitHub Actions run id for ci and post_merge")
    validation.add_argument("--run-url", help="required GitHub Actions run URL for ci and post_merge")
    validation.add_argument("--evidence", required=True)
    validation.add_argument("--actor", required=True)
    common(validation)

    github_sync = subparsers.add_parser(
        "sync-github-run",
        help="verify one private GitHub Actions run via REST and import derived CI evidence",
    )
    github_sync.add_argument("task_id")
    github_sync.add_argument("--phase", required=True, choices=("ci", "post_merge"))
    github_sync.add_argument("--run-id", required=True)
    github_sync.add_argument("--run-attempt", required=True, type=int)
    github_sync.add_argument("--event", required=True, choices=("pull_request", "push"))
    github_sync.add_argument(
        "--head-sha",
        required=True,
        help="GitHub event/control head; its relation to the task content commit is verified locally",
    )
    github_sync.add_argument("--actor", required=True)
    common(github_sync)

    controlled_one = subparsers.add_parser(
        "run-validation",
        help="execute one reviewed local argv and derive its status from the process",
    )
    controlled_one.add_argument("task_id")
    controlled_one.add_argument("--check", required=True, dest="check_id")
    controlled_one.add_argument("--environment")
    controlled_one.add_argument("--release-unit")
    common(controlled_one)

    controlled_all = subparsers.add_parser(
        "run-required",
        help="execute every reviewed argv for one validation phase",
    )
    controlled_all.add_argument("task_id")
    controlled_all.add_argument("--phase", required=True, choices=sorted(VALIDATION_PHASES))
    controlled_all.add_argument("--environment")
    controlled_all.add_argument("--release-unit")
    controlled_all.add_argument(
        "--bootstrap-first-push",
        action="store_true",
        help=(
            "allow only the exact GOV-0001 root push to finish as explicit PENDING; "
            "all later runs still execute the reviewed phase checks"
        ),
    )
    common(controlled_all)

    bootstrap_commit = subparsers.add_parser(
        "bootstrap-commit",
        help="create the exact GOV-0001 root content or protected control commit",
    )
    bootstrap_commit.add_argument("task_id")
    bootstrap_commit.add_argument("--stage", required=True, choices=("content", "control"))
    bootstrap_commit.add_argument("--actor", required=True)
    common(bootstrap_commit)

    bootstrap_push = subparsers.add_parser(
        "bootstrap-push",
        help="push the exact GOV-0001 content or control commit without force",
    )
    bootstrap_push.add_argument("task_id")
    bootstrap_push.add_argument("--stage", required=True, choices=("content", "control"))
    bootstrap_push.add_argument("--actor", required=True)
    common(bootstrap_push)

    revise = subparsers.add_parser(
        "revise-scope",
        help="replace reviewed scope fields, increment scope_version and return to drafting or review",
    )
    revise.add_argument("task_id")
    revise.add_argument("--file", required=True, type=Path, help="JSON object containing changed scope fields")
    revise.add_argument("--target", choices=("DRAFT", "REVIEW_PENDING"), default="REVIEW_PENDING")
    revise.add_argument("--actor", required=True)
    revise.add_argument("--reason", required=True)
    common(revise)

    reopen = subparsers.add_parser(
        "reopen",
        help="invalidate frozen local evidence and reopen approved same-scope rework",
    )
    reopen.add_argument("task_id")
    reopen.add_argument("--actor", required=True)
    reopen.add_argument("--reason", required=True)
    common(reopen)

    committed_recovery = subparsers.add_parser(
        "recover-committed",
        help="activate one receipt-bound recovery after a committed bootstrap CI failure",
    )
    committed_recovery.add_argument("task_id")
    committed_recovery.add_argument("--proposal", required=True)
    committed_recovery.add_argument("--actor", required=True)
    committed_recovery.add_argument("--reason", required=True)
    common(committed_recovery)

    pending_content_recovery = subparsers.add_parser(
        "recover-pending-content",
        help="replace an active bootstrap recovery after its pushed content CI fails",
    )
    pending_content_recovery.add_argument("task_id")
    pending_content_recovery.add_argument("--proposal", required=True)
    pending_content_recovery.add_argument("--actor", required=True)
    pending_content_recovery.add_argument("--reason", required=True)
    common(pending_content_recovery)

    create = subparsers.add_parser("create", help="create a DRAFT task from a reviewed JSON specification")
    create.add_argument("--file", required=True, type=Path)
    common(create)

    select = subparsers.add_parser("set-current", help="select an existing task")
    select.add_argument("task_id")
    select.add_argument("--actor", required=True)
    select.add_argument("--reason", required=True)
    common(select)
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    root: Path = args.root
    try:
        if args.command == "current":
            task = load_current_task(root)
            _emit({"ok": True, "task": task, "scope_hash": canonical_scope_hash(task)}, args.json)
            return 0

        if args.command == "show":
            task = _load_requested(root, args.task_id)
            payload = canonical_scope(task) if args.scope else task
            _emit({"ok": True, "task": payload, "scope_hash": canonical_scope_hash(task)}, args.json)
            return 0

        if args.command == "list":
            tasks = []
            directory = control_dir(root) / "tasks"
            for path in sorted(directory.glob("*.json")) if directory.exists() else []:
                tasks.append(load_task(root, path.stem))
            _emit({"ok": True, "tasks": tasks}, args.json)
            return 0

        if args.command == "scope-hash":
            task = _load_requested(root, args.task_id)
            payload = {"ok": True, "task_id": task["task_id"], "scope_hash": canonical_scope_hash(task)}
            write_output(json_result(payload) if args.json else payload["scope_hash"])
            return 0

        if args.command == "transition":
            task = load_task(root, args.task_id)
            changed = _transition(root, task, args.target, args.actor, args.reason, args.commit)
            _emit({"ok": True, "task": changed, "message": "transition recorded"}, args.json)
            return 0

        if args.command == "record-validation":
            if args.status == "passed":
                raise GovernanceError(
                    "passed validation evidence cannot be self-reported with public taskctl; "
                    "wait for a controlled runner to execute the check and derive PASS from its exit status"
                )
            task = load_task(root, args.task_id)
            _require_current_task(root, task)
            _require_complete_validation_plan(task)
            _require_scope_review(root, task)
            _require_validation_branch(root, task, args.phase)
            if not args.evidence.strip() or not args.actor.strip():
                raise GovernanceError("validation evidence and actor must be non-empty")
            expected_state = _PHASE_RECORD_STATES[args.phase]
            if task["status"] != expected_state:
                raise GovernanceError(
                    "%s validation evidence may only be recorded while task is %s"
                    % (args.phase, expected_state)
                )
            required_ids = {str(item.get("id")) for item in task["validation"].get("required", [])}
            if args.check_id not in required_ids:
                raise GovernanceError("validation check is not declared in scope: %s" % args.check_id)
            result_environment: Optional[str] = None
            result_run_id: Optional[str] = None
            result_run_url: Optional[str] = None
            if args.phase == "local":
                if args.commit or args.run_id or args.run_url:
                    raise GovernanceError(
                        "local validation computes its subject automatically and takes no commit or CI run binding"
                    )
                subject = managed_content_subject(root, task)
                result_environment = args.environment.strip() if args.environment else "local"
                if not result_environment:
                    raise GovernanceError("local validation environment must be non-empty")
            else:
                if (
                    not args.commit
                    or not args.environment
                    or not args.environment.strip()
                    or not args.run_id
                    or not args.run_url
                ):
                    raise GovernanceError(
                        "%s validation requires --commit, --environment, --run-id and --run-url" % args.phase
                    )
                if not _GITHUB_RUN_ID.fullmatch(args.run_id):
                    raise GovernanceError("GitHub Actions run id must be a positive decimal integer")
                expected_suffix = "/actions/runs/" + args.run_id
                if not args.run_url.startswith("https://github.com/") or expected_suffix not in args.run_url:
                    raise GovernanceError("run URL must be a GitHub Actions URL matching --run-id")
                commit = normalize_commit(args.commit)
                git_field = "committed_sha" if args.phase == "ci" else "merged_sha"
                expected_commit = task.get("git", {}).get(git_field)
                if not expected_commit:
                    raise GovernanceError("%s validation requires task.git.%s" % (args.phase, git_field))
                if commit != normalize_commit(expected_commit, "task.git.%s" % git_field):
                    raise GovernanceError(
                        "%s validation commit does not match task.git.%s" % (args.phase, git_field)
                    )
                subject = "commit:" + commit
                result_environment = args.environment.strip()
                result_run_id = args.run_id
                result_run_url = args.run_url
            waiver_id = None
            if args.status == "skipped":
                waiver, waiver_reason = find_effective_validation_waiver(
                    root, task, args.check_id, args.phase, result_environment
                )
                if waiver is None:
                    raise GovernanceError("skipped validation requires an effective user waiver: %s" % waiver_reason)
                waiver_id = waiver["review_id"]
            result = {
                "check_id": args.check_id,
                "status": args.status,
                "phase": args.phase,
                "subject": subject,
                "evidence": args.evidence,
                "actor": args.actor,
                "recorded_at": utc_now(),
            }
            if waiver_id is not None:
                result["waiver_id"] = waiver_id
            if result_environment is not None:
                result["environment"] = result_environment
            if result_run_id is not None:
                result["run_id"] = result_run_id
                result["run_url"] = result_run_url
            task["validation"].setdefault("results", []).append(result)
            task["updated_at"] = result["recorded_at"]
            validate_task(task)
            write_json_atomic(task_path(root, args.task_id), task)
            _emit({"ok": True, "task": task, "result": result, "message": "validation recorded"}, args.json)
            return 0

        if args.command == "sync-github-run":
            task = load_task(root, args.task_id)
            _require_current_task(root, task)
            _require_complete_validation_plan(task)
            _require_scope_review(root, task)
            _require_validation_branch(root, task, args.phase)
            expected_state = _PHASE_RECORD_STATES[args.phase]
            if task["status"] != expected_state:
                raise GovernanceError(
                    "%s GitHub evidence may only be synchronized while task is %s"
                    % (args.phase, expected_state)
                )
            if not args.actor.strip():
                raise GovernanceError("actor must be non-empty")
            if not _GITHUB_RUN_ID.fullmatch(args.run_id):
                raise GovernanceError("GitHub Actions run id must be a positive decimal integer")
            if not _GITHUB_SHA.fullmatch(args.head_sha):
                raise GovernanceError("GitHub event head must be a lowercase 40-character SHA")
            trust = task.get("ci_trust")
            if not isinstance(trust, dict):
                raise GovernanceError("reviewed ci_trust is missing")
            allowed_events_field = "ci_events" if args.phase == "ci" else "post_merge_events"
            if args.event not in trust.get(allowed_events_field, []):
                raise GovernanceError(
                    "GitHub event %s is not approved for %s evidence" % (args.event, args.phase)
                )
            expected_branch = task["branch"] if args.phase == "ci" else task.get("base_branch")
            if not isinstance(expected_branch, str) or not expected_branch:
                raise GovernanceError("reviewed branch binding is missing for GitHub evidence")
            git_field = "committed_sha" if args.phase == "ci" else "merged_sha"
            content_sha = task.get("git", {}).get(git_field)
            if not isinstance(content_sha, str):
                raise GovernanceError("%s evidence requires task.git.%s" % (args.phase, git_field))
            content_sha = normalize_commit(content_sha, "task.git.%s" % git_field)
            if len(content_sha) != 40:
                raise GovernanceError("GitHub evidence requires a 40-character Git commit")
            _verify_content_control_commits(root, content_sha, args.head_sha)
            token_env = trust.get("token_env")
            if not isinstance(token_env, str) or not token_env:
                raise GovernanceError("reviewed ci_trust token_env is missing")
            token = os.environ.get(token_env, "")
            expected_jobs = trust.get("required_jobs", {}).get(args.event, [])
            try:
                github = verify_workflow_run(
                    trust,
                    run_id=args.run_id,
                    run_attempt=args.run_attempt,
                    expected_event=args.event,
                    expected_head_sha=args.head_sha,
                    expected_head_branch=expected_branch,
                    expected_job_names=expected_jobs,
                    token=token,
                )
            except GitHubEvidenceError as exc:
                raise GovernanceError(str(exc)) from exc
            github["content_subject_sha"] = content_sha
            github["control_head_sha"] = args.head_sha
            gate = "CI_VERIFIED" if args.phase == "ci" else "POST_MERGE_VERIFIED"
            timestamp = utc_now()
            environment = "github-actions:%s:attempt-%s" % (args.event, args.run_attempt)
            results = []
            for check in task["validation"].get("required", []):
                if gate not in check.get("gates", []):
                    continue
                result = {
                    "check_id": str(check.get("id")),
                    "status": "passed",
                    "phase": args.phase,
                    "subject": "commit:" + content_sha,
                    "environment": environment,
                    "source": "github_actions_rest_v1",
                    "evidence": "GitHub REST verified workflow run %s attempt %s"
                    % (args.run_id, args.run_attempt),
                    "actor": args.actor,
                    "recorded_at": timestamp,
                    "run_id": args.run_id,
                    "run_url": github["run_url"],
                    "github": copy.deepcopy(github),
                }
                task["validation"].setdefault("results", []).append(result)
                results.append(result)
            if not results:
                raise GovernanceError("reviewed validation plan has no checks for %s" % gate)
            recovery_marker = task.get("bootstrap_recovery")
            if (
                args.phase == "ci"
                and isinstance(recovery_marker, dict)
                and recovery_marker.get("state") == "active"
            ):
                active_bootstrap_recovery_contract(root, task)
                recovery_marker.update({
                    "state": "consumed",
                    "consumed_at": timestamp,
                    "consumed_content_sha": content_sha,
                    "consumed_control_head": args.head_sha,
                    "consumed_run_id": args.run_id,
                })
            task["updated_at"] = timestamp
            validate_task(task)
            write_json_atomic(task_path(root, args.task_id), task)
            _emit({
                "ok": True,
                "task": task,
                "results": results,
                "github": github,
                "message": "verified GitHub Actions evidence synchronized",
            }, args.json)
            return 0

        if args.command in ("bootstrap-commit", "bootstrap-push"):
            if args.actor != "Codex":
                raise GovernanceError("bootstrap Git transport must record --actor Codex exactly")
            task = load_task(root, args.task_id)
            if args.command == "bootstrap-commit":
                evidence = _bootstrap_commit(root, task, args.stage)
                message = "exact bootstrap commit created"
            else:
                evidence = _bootstrap_push(root, task, args.stage)
                message = "exact bootstrap commit pushed without force"
            _emit({
                "ok": True,
                "task_id": task["task_id"],
                "evidence": evidence,
                "message": message,
            }, args.json)
            return 0

        if args.command in ("run-validation", "run-required"):
            task = load_task(root, args.task_id)
            _require_current_task(root, task)
            _require_complete_validation_plan(task)
            _require_scope_review(root, task)
            phase = "local" if args.command == "run-validation" else args.phase
            bootstrap_first_push = bool(
                args.command == "run-required" and args.bootstrap_first_push
            )
            if bootstrap_first_push and phase != "ci":
                raise GovernanceError(
                    "--bootstrap-first-push is only valid for --phase ci"
                )
            _require_validation_branch(root, task, phase)
            expected_state = _PHASE_RECORD_STATES[phase]
            if task["status"] != expected_state:
                if (
                    bootstrap_first_push
                    and phase == "ci"
                    and task["status"] == "LOCAL_VERIFIED"
                ):
                    # The unborn repository cannot record its root commit SHA in
                    # that same commit.  Reuse the full read-only CI reconciler
                    # to recognize only the exact GOV-0001 root snapshot.  This
                    # path records no PASS and exists solely so the first run is
                    # visibly PENDING before a protected control commit records A.
                    from reconcile import run_reconcile

                    report = run_reconcile(root, "ci")
                    ci_context = report.get("context", {}).get("ci", {})
                    if not report.get("ok") or ci_context.get("mode") not in (
                        "bootstrap_pending", "bootstrap_repair_pending",
                    ):
                        failed = [
                            str(item.get("message"))
                            for item in report.get("checks", [])
                            if item.get("status") == "failed"
                        ]
                        raise GovernanceError(
                            "bootstrap first push did not satisfy the exact PENDING contract: %s"
                            % (
                                "; ".join(failed)
                                or "CI context is not bootstrap_pending/bootstrap_repair_pending"
                            )
                        )
                    _emit({
                        "ok": True,
                        "task_id": task["task_id"],
                        "phase": "ci",
                        "status": "pending",
                        "results": [],
                        "ci": ci_context,
                        "message": (
                            "exact GOV-0001 bootstrap content push validated as PENDING; "
                            "no CI PASS was recorded"
                        ),
                    }, args.json)
                    return 0
                raise GovernanceError(
                    "%s controlled validation may only run while task is %s"
                    % (phase, expected_state)
                )
            if args.command == "run-validation":
                matching = [
                    check for check in task["validation"].get("required", [])
                    if check.get("id") == args.check_id
                ]
                if len(matching) != 1:
                    raise GovernanceError(
                        "validation check must be declared exactly once: %s" % args.check_id
                    )
                result = run_controlled_validation(
                    root,
                    task,
                    matching[0],
                    "local",
                    environment=args.environment,
                    release_unit=args.release_unit,
                )
                batch = {
                    "runner_version": RUNNER_VERSION,
                    "task_id": task["task_id"],
                    "phase": "local",
                    "release_unit": args.release_unit,
                    "status": result["status"],
                    "results": [result],
                    "planned_check_count": 1,
                    "executed_check_count": 1,
                    "not_run": [],
                }
            else:
                batch = run_controlled_required(
                    root,
                    task,
                    phase,
                    environment=args.environment,
                    release_unit=args.release_unit,
                )
            integrity_failures = [
                result for result in batch["results"]
                if not result.get("integrity", {}).get("unchanged")
            ]
            if integrity_failures:
                raise GovernanceError(
                    "controlled validation changed managed content or protected governance state; "
                    "no result was recorded"
                )
            # CI and post-merge process reports are intentionally ephemeral.
            # Only sync-github-run may persist PASS for those phases after the
            # private GitHub REST API confirms the exact run and commit.
            if phase == "local":
                stored_results = []
                for derived in batch["results"]:
                    result = copy.deepcopy(derived)
                    result["source"] = RUNNER_VERSION
                    task["validation"].setdefault("results", []).append(result)
                    stored_results.append(result)
                task["updated_at"] = utc_now()
                validate_task(task)
                write_json_atomic(task_path(root, args.task_id), task)
                payload = {
                    "ok": batch["status"] == "passed",
                    "task": task,
                    "batch": batch,
                    "results": stored_results,
                    "message": "controlled local validation completed",
                }
            else:
                payload = {
                    "ok": batch["status"] == "passed",
                    "batch": batch,
                    "message": (
                        "controlled CI process checks completed; PASS remains pending GitHub REST sync"
                    ),
                }
            _emit(payload, args.json)
            return 0 if batch["status"] == "passed" else 1

        if args.command == "recover-pending-content":
            task = load_task(root, args.task_id)
            _require_current_task(root, task)
            _require_complete_validation_plan(task)
            _require_scope_review(root, task)
            _require_work_branch(root, task)
            if args.actor != "Codex":
                raise GovernanceError(
                    "recover-pending-content must record --actor Codex exactly"
                )
            if not args.reason.strip():
                raise GovernanceError("recover-pending-content reason must be non-empty")
            if task.get("status") != "IN_PROGRESS":
                raise GovernanceError(
                    "recover-pending-content requires task status IN_PROGRESS after reviewed reopen"
                )
            if task.get("validation", {}).get("results"):
                raise GovernanceError(
                    "recover-pending-content requires all prior validation results to be archived"
                )
            if task.get("git"):
                raise GovernanceError(
                    "recover-pending-content requires no active Git phase evidence"
                )
            prior_contract = active_bootstrap_recovery_contract(root, task)
            if prior_contract is None or prior_contract.get("recovery_state") != "active":
                raise GovernanceError(
                    "recover-pending-content requires one active prior recovery contract"
                )
            proposal_argument = Path(args.proposal)
            proposal_candidate = (
                proposal_argument if proposal_argument.is_absolute() else root / proposal_argument
            ).resolve()
            try:
                proposal_relative = proposal_candidate.relative_to(root.resolve()).as_posix()
            except ValueError as exc:
                raise GovernanceError("recovery proposal must be inside the repository") from exc
            proposal = recovery_proposal_path(root, proposal_relative)
            contract = validate_bootstrap_recovery_contract(root, task, read_json(proposal))
            if (
                contract.get("schema_version") != 2
                or contract.get("failure_stage") != "content_ci_pending"
            ):
                raise GovernanceError(
                    "recover-pending-content requires a schema v2 content_ci_pending proposal"
                )
            head = normalize_commit(
                _git(root, ("rev-parse", "HEAD"), "cannot resolve failed content HEAD"),
                "HEAD",
            )
            if head != contract["failed_content_sha"]:
                raise GovernanceError(
                    "pending-content proposal does not match the current failed content HEAD"
                )
            history_count_text = _git(
                root,
                ("rev-list", "--all", "--count"),
                "cannot inspect pending-content recovery history",
            )
            if (
                not history_count_text.isdigit()
                or int(history_count_text) != contract["expected_history_count"]
            ):
                raise GovernanceError(
                    "pending-content recovery history count differs from the reviewed proposal"
                )
            prior_issues = bootstrap_repair_commit_issues(root, head, task)
            if prior_issues:
                raise GovernanceError(
                    "failed pending content is not the exact prior recovery child: %s"
                    % "; ".join(prior_issues)
                )
            rework_history = task.get("rework_history", [])
            latest_rework = rework_history[-1] if isinstance(rework_history, list) and rework_history else None
            if (
                not isinstance(latest_rework, Mapping)
                or latest_rework.get("review_id") != contract["rework_review_id"]
                or latest_rework.get("to_status") != "IN_PROGRESS"
            ):
                raise GovernanceError(
                    "pending-content recovery is not bound to the latest consumed rework receipt"
                )
            matching_rework = [
                receipt for receipt in list_reviews(root, task["task_id"])
                if receipt.get("review_id") == contract["rework_review_id"]
                and receipt.get("kind") == "rework"
                and receipt.get("subject") == latest_rework.get("subject")
            ]
            if len(matching_rework) != 1:
                raise GovernanceError("pending-content rework receipt is missing or ambiguous")
            rework_valid, rework_reason = review_validity(
                matching_rework[0], task, root=root
            )
            if not rework_valid:
                raise GovernanceError(
                    "pending-content rework receipt is invalid: %s" % rework_reason
                )
            timestamp = utc_now()
            prior_marker = copy.deepcopy(task.get("bootstrap_recovery"))
            marker = {
                "activated_at": timestamp,
                "activated_by": args.actor,
                "failed_content_sha": contract["failed_content_sha"],
                "failed_control_head": contract["failed_control_head"],
                "failed_run_id": contract["failed_run_id"],
                "history_count": contract["expected_history_count"],
                "operation_id": contract["operation_id"],
                "proposal_path": proposal_relative,
                "review_id": contract["review_id"],
                "state": "active",
                "target_digest": contract["target_digest"],
            }
            task.setdefault("bootstrap_recovery_history", []).append({
                "activated_at": timestamp,
                "actor": args.actor,
                "reason": args.reason,
                "review_id": contract["review_id"],
                "rework_review_id": contract["rework_review_id"],
                "target_digest": contract["target_digest"],
                "failed_run_id": contract["failed_run_id"],
                "failure_stage": contract["failure_stage"],
                "from_status": "BLOCKED",
                "from_previous_status": "LOCAL_VERIFIED",
                "to_status": "IN_PROGRESS",
                "superseded_recovery": prior_marker,
            })
            task.setdefault("history", []).append({
                "event": "receipt_bound_pending_content_recovery",
                "from": "IN_PROGRESS",
                "to": "IN_PROGRESS",
                "at": timestamp,
                "actor": args.actor,
                "reason": args.reason,
                "review_id": contract["review_id"],
                "rework_review_id": contract["rework_review_id"],
                "target_digest": contract["target_digest"],
                "failed_run_id": contract["failed_run_id"],
            })
            task["bootstrap_recovery"] = marker
            task["updated_at"] = timestamp
            validate_task(task)
            active_bootstrap_recovery_contract(root, task)
            write_json_atomic(task_path(root, args.task_id), task)
            _emit({
                "ok": True,
                "task": task,
                "recovery_review_id": contract["review_id"],
                "rework_review_id": contract["rework_review_id"],
                "target_digest": contract["target_digest"],
                "message": (
                    "receipt-bound pending-content recovery replaced the prior active contract; "
                    "all validation must rerun"
                ),
            }, args.json)
            return 0

        if args.command == "recover-committed":
            task = load_task(root, args.task_id)
            _require_current_task(root, task)
            _require_complete_validation_plan(task)
            _require_scope_review(root, task)
            _require_work_branch(root, task)
            if args.actor != "Codex":
                raise GovernanceError("recover-committed must record --actor Codex exactly")
            if not args.reason.strip():
                raise GovernanceError("recover-committed reason must be non-empty")
            if task.get("status") != "BLOCKED" or task.get("exception", {}).get(
                "previous_status"
            ) != "COMMITTED":
                raise GovernanceError(
                    "recover-committed requires a BLOCKED task whose previous status is COMMITTED"
                )
            if task.get("bootstrap_recovery") is not None:
                raise GovernanceError("a bootstrap recovery is already active")
            proposal_argument = Path(args.proposal)
            proposal_candidate = (
                proposal_argument if proposal_argument.is_absolute() else root / proposal_argument
            ).resolve()
            try:
                proposal_relative = proposal_candidate.relative_to(root.resolve()).as_posix()
            except ValueError as exc:
                raise GovernanceError("recovery proposal must be inside the repository") from exc
            proposal = recovery_proposal_path(root, proposal_relative)
            contract = validate_bootstrap_recovery_contract(root, task, read_json(proposal))
            current_content = normalize_commit(
                task.get("git", {}).get("committed_sha"),
                "task.git.committed_sha",
            )
            if current_content != contract["failed_content_sha"]:
                raise GovernanceError("recovery proposal does not match task.git.committed_sha")
            head = normalize_commit(
                _git(root, ("rev-parse", "HEAD"), "cannot resolve failed control HEAD"),
                "HEAD",
            )
            if head != contract["failed_control_head"]:
                raise GovernanceError("recovery proposal does not match the current control HEAD")
            if contract["failed_run_id"] not in str(task.get("exception", {}).get("reason", "")):
                raise GovernanceError("recovery proposal run id is absent from the BLOCKED reason")
            history_count_text = _git(
                root,
                ("rev-list", "--all", "--count"),
                "cannot inspect recovery history",
            )
            if not history_count_text.isdigit() or int(history_count_text) < 1:
                raise GovernanceError("recovery Git history count is invalid")
            timestamp = utc_now()
            archived_results = copy.deepcopy(task.get("validation", {}).get("results", []))
            archived_git = copy.deepcopy(task.get("git", {}))
            archived_exception = copy.deepcopy(task.get("exception", {}))
            marker = {
                "activated_at": timestamp,
                "activated_by": args.actor,
                "failed_content_sha": contract["failed_content_sha"],
                "failed_control_head": contract["failed_control_head"],
                "failed_run_id": contract["failed_run_id"],
                "history_count": int(history_count_text),
                "operation_id": contract["operation_id"],
                "proposal_path": proposal_relative,
                "review_id": contract["review_id"],
                "state": "active",
                "target_digest": contract["target_digest"],
            }
            task.setdefault("bootstrap_recovery_history", []).append({
                "activated_at": timestamp,
                "actor": args.actor,
                "reason": args.reason,
                "review_id": contract["review_id"],
                "target_digest": contract["target_digest"],
                "failed_run_id": contract["failed_run_id"],
                "from_status": task.get("status"),
                "from_previous_status": task.get("exception", {}).get("previous_status"),
                "to_status": "IN_PROGRESS",
                "archived_git": archived_git,
                "archived_exception": archived_exception,
                "archived_validation_results": archived_results,
            })
            task.setdefault("history", []).append({
                "event": "receipt_bound_committed_recovery",
                "from": task.get("status"),
                "to": "IN_PROGRESS",
                "at": timestamp,
                "actor": args.actor,
                "reason": args.reason,
                "review_id": contract["review_id"],
                "target_digest": contract["target_digest"],
                "failed_run_id": contract["failed_run_id"],
            })
            task["bootstrap_recovery"] = marker
            task["validation"]["results"] = []
            task["git"] = {}
            task["status"] = "IN_PROGRESS"
            task.pop("exception", None)
            task["updated_at"] = timestamp
            validate_task(task)
            active_bootstrap_recovery_contract(root, task)
            write_json_atomic(task_path(root, args.task_id), task)
            _emit({
                "ok": True,
                "task": task,
                "recovery_review_id": contract["review_id"],
                "target_digest": contract["target_digest"],
                "archived_result_count": len(archived_results),
                "message": "receipt-bound committed recovery activated; all validation must rerun",
            }, args.json)
            return 0

        if args.command == "reopen":
            task = load_task(root, args.task_id)
            _require_current_task(root, task)
            _require_complete_validation_plan(task)
            _require_scope_review(root, task)
            _require_work_branch(root, task)
            if args.actor != "Codex":
                raise GovernanceError("reopen must record --actor Codex exactly")
            if not args.reason.strip():
                raise GovernanceError("reopen reason must be non-empty")
            effective_status = task.get("status")
            if effective_status == "BLOCKED":
                effective_status = task.get("exception", {}).get("previous_status")
            if effective_status != "LOCAL_VERIFIED":
                raise GovernanceError(
                    "same-scope rework may only reopen LOCAL_VERIFIED or its BLOCKED exception"
                )
            if task.get("git", {}).get("committed_sha"):
                raise GovernanceError("rework after a content commit requires a new task")
            local_gate = validation_gate_status(root, task, "LOCAL_VERIFIED")
            if local_gate["missing"]:
                raise GovernanceError(
                    "cannot reopen because frozen local validation is already inconsistent: %s"
                    % ", ".join(
                        "%s (%s)" % (item["check_id"], item["reason"])
                        for item in local_gate["missing"]
                    )
                )
            receipt, receipt_reason = find_effective_rework_review(root, task)
            if receipt is None:
                raise GovernanceError("same-scope rework has no effective user decision: %s" % receipt_reason)
            timestamp = utc_now()
            archived_results = copy.deepcopy(task.get("validation", {}).get("results", []))
            task.setdefault("rework_history", []).append({
                "at": timestamp,
                "actor": args.actor,
                "reason": args.reason,
                "review_id": receipt.get("review_id"),
                "scope_hash": canonical_scope_hash(task),
                "subject": managed_content_subject(root, task),
                "from_status": task.get("status"),
                "to_status": "IN_PROGRESS",
                "archived_validation_results": archived_results,
            })
            task.setdefault("history", []).append({
                "event": "same_scope_rework",
                "from": task.get("status"),
                "to": "IN_PROGRESS",
                "at": timestamp,
                "actor": args.actor,
                "reason": args.reason,
                "review_id": receipt.get("review_id"),
            })
            task["validation"]["results"] = []
            task["status"] = "IN_PROGRESS"
            task.pop("exception", None)
            task["updated_at"] = timestamp
            validate_task(task)
            write_json_atomic(task_path(root, args.task_id), task)
            _emit({
                "ok": True,
                "task": task,
                "rework_review_id": receipt.get("review_id"),
                "archived_result_count": len(archived_results),
                "message": "same-scope rework reopened; prior local evidence is archived and inactive",
            }, args.json)
            return 0

        if args.command == "revise-scope":
            task = load_task(root, args.task_id)
            if task.get("git", {}).get("committed_sha") or task["status"] in (
                "COMMITTED", "CI_VERIFIED", "CODE_REVIEWED", "MERGED",
                "POST_MERGE_VERIFIED", "DONE", "CANCELLED",
            ):
                raise GovernanceError("scope revision after commit or closure requires a new task")
            proposal = read_json(args.file)
            proposed_task_id = proposal.get("task_id")
            if proposed_task_id is not None and proposed_task_id != task["task_id"]:
                raise GovernanceError("scope proposal belongs to another task")
            unknown_fields = sorted(set(proposal) - set(SCOPE_EDITABLE_FIELDS) - {"task_id"})
            if unknown_fields:
                raise GovernanceError("scope proposal contains non-scope fields: %s" % ", ".join(unknown_fields))
            supplied_fields = [field for field in SCOPE_EDITABLE_FIELDS if field in proposal]
            if not supplied_fields:
                raise GovernanceError("scope proposal contains no review-bound fields")
            changed_fields = []
            for field in supplied_fields:
                if field == "validation":
                    proposed_validation = proposal[field]
                    proposed_required = proposed_validation.get("required") if isinstance(proposed_validation, dict) else None
                    current_required = task.get("validation", {}).get("required")
                    if proposed_required != current_required:
                        changed_fields.append(field)
                elif proposal[field] != task.get(field):
                    changed_fields.append(field)
            if not changed_fields:
                raise GovernanceError("scope proposal does not change canonical scope")
            previous_scope = canonical_scope(task)
            previous_hash = canonical_scope_hash(task)
            previous_results = copy.deepcopy(task["validation"].get("results", []))
            revised = copy.deepcopy(task)
            for field in supplied_fields:
                revised[field] = copy.deepcopy(proposal[field])
            if not isinstance(revised.get("validation"), dict):
                raise GovernanceError("revised validation must be an object")
            if not isinstance(revised["validation"].get("required"), list):
                raise GovernanceError("revised validation.required must be a list")
            proposed_validation = proposal.get("validation")
            if isinstance(proposed_validation, dict) and proposed_validation.get("results"):
                raise GovernanceError("scope proposal may not supply validation results")
            revised["validation"]["results"] = []
            revised["scope_version"] = int(task["scope_version"]) + 1
            revised["status"] = args.target
            timestamp = utc_now()
            new_hash = canonical_scope_hash(revised)
            if new_hash == previous_hash:
                raise GovernanceError("scope proposal does not change canonical scope")
            revision = {
                "from_scope_version": task["scope_version"],
                "to_scope_version": revised["scope_version"],
                "from_scope_hash": previous_hash,
                "to_scope_hash": new_hash,
                "changed_fields": changed_fields,
                "previous_scope": previous_scope,
                "archived_validation_results": previous_results,
                "at": timestamp,
                "actor": args.actor,
                "reason": args.reason,
            }
            revised.setdefault("scope_revisions", []).append(revision)
            revised.setdefault("history", []).append({
                "event": "scope_revision",
                "from": task["status"],
                "to": args.target,
                "from_scope_version": task["scope_version"],
                "to_scope_version": revised["scope_version"],
                "at": timestamp,
                "actor": args.actor,
                "reason": args.reason,
            })
            revised["updated_at"] = timestamp
            validate_task(revised)
            write_json_atomic(task_path(root, args.task_id), revised)
            _emit({
                "ok": True,
                "task": revised,
                "scope_revision": revision,
                "message": "scope revised; prior review and validation evidence are no longer effective",
            }, args.json)
            return 0

        if args.command == "create":
            task = read_json(args.file)
            validate_task(task)
            if task["status"] != "DRAFT":
                raise GovernanceError("new tasks must start in DRAFT")
            destination = task_path(root, str(task["task_id"]))
            if destination.exists():
                raise GovernanceError("task already exists: %s" % task["task_id"])
            task.setdefault("created_at", utc_now())
            task.setdefault("updated_at", task["created_at"])
            task.setdefault("history", [])
            write_json_atomic(destination, task)
            _emit({"ok": True, "task": task, "message": "task created"}, args.json)
            return 0

        if args.command == "set-current":
            task = load_task(root, args.task_id)
            previous = None
            try:
                previous = current_task_id(root)
            except GovernanceError:
                pass
            if previous and previous != task["task_id"]:
                active = load_task(root, previous)
                if active["status"] not in _SELECTABLE_TERMINAL_STATES:
                    raise GovernanceError(
                        "cannot switch away from unfinished current task %s (%s)"
                        % (active["task_id"], active["status"])
                    )
            current = {
                "schema_version": 1,
                "task_id": task["task_id"],
                "selected_at": utc_now(),
                "selected_by": args.actor,
                "reason": args.reason,
                "previous_task_id": previous,
            }
            write_json_atomic(control_dir(root) / "current-task.json", current)
            _emit({"ok": True, "task": task, "message": "current task selected"}, args.json)
            return 0
    except GovernanceError as exc:
        payload = {"ok": False, "error": str(exc)}
        write_output(
            json_result(payload) if getattr(args, "json", False) else "ERROR: %s" % exc,
            stream=sys.stderr,
        )
        return 2
    return 2


if __name__ == "__main__":
    sys.exit(main())
