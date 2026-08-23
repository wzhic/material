#!/usr/bin/env python3
"""Manage task state without third-party dependencies."""

from __future__ import annotations

import argparse
import contextlib
import copy
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, Iterator, List, Mapping, Optional, Tuple

from core import (
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
    find_effective_final_action_review,
    find_effective_review,
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
    subtask_sensitive_text_reason,
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


def _task_content_message(task: Mapping[str, Any]) -> str:
    return "chore(task): implement reviewed scope for %s" % task["task_id"]


def _task_control_message(task: Mapping[str, Any]) -> str:
    return "chore(governance): record %s content commit" % task["task_id"]


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


def _changed_worktree_paths(root: Path) -> List[str]:
    return sorted(set(
        _nul_paths(_git(root, ("diff", "--name-only", "-z"), "cannot inspect unstaged changes"))
        + _nul_paths(
            _git(root, ("diff", "--cached", "--name-only", "-z"), "cannot inspect staged changes")
        )
        + _nul_paths(
            _git(
                root,
                ("ls-files", "--others", "--exclude-standard", "-z"),
                "cannot inspect untracked files",
            )
        )
    ))


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


def _require_regular_task_transport(
    root: Path,
    task: Dict[str, Any],
    statuses: tuple[str, ...],
) -> None:
    _require_current_task(root, task)
    _require_complete_validation_plan(task)
    _require_work_branch(root, task)
    if task.get("task_id") == BOOTSTRAP_TASK_ID:
        raise GovernanceError("regular task Git transport cannot replace the bounded GOV-0001 bootstrap flow")
    if task.get("status") not in statuses:
        raise GovernanceError(
            "regular task Git transport requires status %s, found %s"
            % (" or ".join(statuses), task.get("status"))
        )
    branch = task.get("branch")
    base = task.get("base_branch")
    if not isinstance(branch, str) or not branch.strip() or branch == base:
        raise GovernanceError("regular task Git transport requires a reviewed feature branch")
    project = read_json(control_dir(root) / "project.json")
    if project.get("source_repository") != _BOOTSTRAP_SOURCE_REPOSITORY:
        raise GovernanceError("task source repository does not match the fixed GitHub repository")


def _task_owned_control_path(root: Path, task: Mapping[str, Any], relative: str) -> bool:
    task_id = str(task.get("task_id", ""))
    if relative == "project-control/tasks/%s.json" % task_id:
        return True
    if relative == "project-control/current-task.json":
        try:
            return read_json(root / relative).get("task_id") == task_id
        except GovernanceError:
            return False
    if relative.startswith("project-control/reviews/") and relative.endswith(".json"):
        try:
            return read_json(root / relative).get("task_id") == task_id
        except GovernanceError:
            return False
    return False


def _task_change_manifest(
    root: Path,
    task: Mapping[str, Any],
    manifest_value: str,
) -> tuple[str, List[str]]:
    if not isinstance(manifest_value, str) or not manifest_value.strip():
        raise GovernanceError("commit-task requires a non-empty --manifest path")
    manifest_path = Path(manifest_value)
    if manifest_path.is_absolute():
        raise GovernanceError("commit-task manifest must be a repository-relative path")
    try:
        resolved = (root / manifest_path).resolve(strict=True)
        relative = resolved.relative_to(root.resolve()).as_posix()
    except (OSError, ValueError) as exc:
        raise GovernanceError("commit-task manifest is missing or outside the repository") from exc
    task_id = str(task.get("task_id", ""))
    prefix = "project-control/proposals/%s-" % task_id
    if not relative.startswith(prefix) or not relative.endswith(".json"):
        raise GovernanceError("commit-task manifest must be a current-task proposal JSON file")
    manifest = read_json(resolved)
    if manifest.get("schema_version") != 1 or manifest.get("task_id") != task_id:
        raise GovernanceError("commit-task manifest schema or task_id is invalid")
    head = normalize_commit(_git(root, ("rev-parse", "HEAD"), "cannot resolve manifest base"), "HEAD")
    if manifest.get("base_head") != head:
        raise GovernanceError("commit-task manifest base_head does not match the current control head")
    raw_paths = manifest.get("paths")
    if not isinstance(raw_paths, list) or not raw_paths:
        raise GovernanceError("commit-task manifest paths must be a non-empty list")
    selected: List[str] = []
    for raw in raw_paths:
        if not isinstance(raw, str) or not raw or raw.startswith("/") or "\\" in raw:
            raise GovernanceError("commit-task manifest contains an invalid path")
        path = Path(raw)
        if any(part in ("", ".", "..") for part in path.parts) or any(char in raw for char in "*?["):
            raise GovernanceError("commit-task manifest paths must be exact repository-relative paths")
        try:
            normalized = (root / path).resolve(strict=False).relative_to(root.resolve()).as_posix()
        except ValueError as exc:
            raise GovernanceError("commit-task manifest path escapes the repository") from exc
        if normalized != raw:
            raise GovernanceError("commit-task manifest path is not canonical: %s" % raw)
        if _protected_control_path(raw):
            raise GovernanceError("commit-task manifest may not claim protected task state: %s" % raw)
        if not path_is_allowed(root, raw, task.get("allowed_paths", [])):
            raise GovernanceError("commit-task manifest path is outside reviewed scope: %s" % raw)
        if raw in selected:
            raise GovernanceError("commit-task manifest contains a duplicate path: %s" % raw)
        selected.append(raw)
    if relative in selected:
        raise GovernanceError("commit-task manifest must not list itself")
    return relative, selected + [relative]


def _task_commit(
    root: Path,
    task: Dict[str, Any],
    actor: str,
    reason: str,
    manifest: str,
) -> Dict[str, Any]:
    _require_regular_task_transport(root, task, ("LOCAL_VERIFIED",))
    if actor != "Codex":
        raise GovernanceError("commit-task must record --actor Codex exactly")
    if not reason.strip():
        raise GovernanceError("commit-task reason must be non-empty")
    if task.get("git", {}).get("committed_sha"):
        raise GovernanceError("task content commit is already recorded")
    local_gate = validation_gate_status(root, task, "LOCAL_VERIFIED")
    if local_gate["missing"]:
        raise GovernanceError("commit-task requires complete local validation")

    from reconcile import run_reconcile

    report = run_reconcile(root, "precommit")
    if not report.get("ok"):
        failed = [
            str(item.get("message")) for item in report.get("checks", [])
            if item.get("status") == "failed"
        ]
        raise GovernanceError(
            "commit-task requires a clean precommit reconcile: %s"
            % ("; ".join(failed) or "unknown reconcile failure")
        )

    manifest_path, selected = _task_change_manifest(root, task, manifest)
    candidates = _changed_worktree_paths(root)
    if not candidates:
        raise GovernanceError("commit-task has no reviewed changes")
    missing_selected = sorted(set(selected) - set(candidates))
    if missing_selected:
        raise GovernanceError(
            "commit-task manifest lists paths without current changes: %s"
            % ", ".join(missing_selected)
        )
    staged_before = _nul_paths(
        _git(
            root,
            ("diff", "--cached", "--name-only", "--diff-filter=ACDMRTUXB", "-z"),
            "cannot inspect existing staged changes",
        )
    )
    unrelated_staged = sorted(set(staged_before) - set(selected))
    if unrelated_staged:
        raise GovernanceError(
            "commit-task found pre-staged paths outside its manifest: %s"
            % ", ".join(unrelated_staged)
        )
    preserved = sorted(set(candidates) - set(selected))

    _git(root, tuple(["add", "--all", "--"] + selected), "cannot stage manifest-owned task content")
    staged = _nul_paths(
        _git(
            root,
            ("diff", "--cached", "--name-only", "--diff-filter=ACDMRTUXB", "-z"),
            "cannot inspect staged task content",
        )
    )
    invalid = sorted(set(staged) - set(selected))
    if not staged or invalid or set(staged) != set(selected):
        raise GovernanceError(
            "staged task content is empty or outside reviewed scope: %s"
            % ", ".join(sorted(invalid))
        )
    _git(root, ("diff", "--cached", "--check"), "staged task content failed whitespace checks")
    content_message = _task_content_message(task)
    _git(
        root,
        (
            "-c", "user.name=Codex Governance",
            "-c", "user.email=codex-governance@users.noreply.github.com",
            "-c", "commit.gpgSign=false",
            "commit", "-m", content_message,
        ),
        "cannot create reviewed task content commit",
    )
    content_sha = normalize_commit(
        _git(root, ("rev-parse", "HEAD"), "cannot resolve task content commit"),
        "HEAD",
    )

    transitioned = _transition(root, task, "COMMITTED", actor, reason, content_sha)
    control_candidates = _changed_worktree_paths(root)
    # Protected state is writable only through taskctl/reviewctl.  Commit all
    # pending protected records together so a single maintainer can hand off a
    # newly queued or terminal task without leaving an uncommittable control
    # record behind.  Ordinary files outside the manifest remain untouched.
    control_owned = [
        path for path in control_candidates if _protected_control_path(path)
    ]
    if not control_owned:
        raise GovernanceError("content commit transition produced empty protected state")
    _git(
        root,
        tuple(["add", "--all", "--"] + sorted(control_owned)),
        "cannot stage current-task protected state",
    )
    control_staged = _nul_paths(
        _git(
            root,
            ("diff", "--cached", "--name-only", "--diff-filter=ACDMRTUXB", "-z"),
            "cannot inspect protected task state",
        )
    )
    if not control_staged or set(control_staged) != set(control_owned) or any(
        not _protected_control_path(path) for path in control_staged
    ):
        raise GovernanceError("control commit may contain only protected task state")
    _git(root, ("diff", "--cached", "--check"), "protected task state failed whitespace checks")
    control_message = _task_control_message(task)
    _git(
        root,
        (
            "-c", "user.name=Codex Governance",
            "-c", "user.email=codex-governance@users.noreply.github.com",
            "-c", "commit.gpgSign=false",
            "commit", "-m", control_message,
        ),
        "cannot create protected task control commit",
    )
    control_sha = normalize_commit(
        _git(root, ("rev-parse", "HEAD"), "cannot resolve task control commit"),
        "HEAD",
    )
    _verify_content_control_commits(root, content_sha, control_sha)
    remaining = _changed_worktree_paths(root)
    if set(remaining) != set(preserved) - set(control_owned):
        raise GovernanceError("commit-task changed or introduced paths outside its manifest")
    return {
        "task": transitioned,
        "content_sha": content_sha,
        "control_sha": control_sha,
        "content_paths": sorted(staged),
        "control_paths": sorted(control_staged),
        "manifest": manifest_path,
        "preserved_unrelated_paths": sorted(remaining),
        "content_message": content_message,
        "control_message": control_message,
    }


def _remote_ref_sha(output: str, reference: str) -> Optional[str]:
    lines = [line for line in output.splitlines() if line.strip()]
    if not lines:
        return None
    if len(lines) != 1:
        raise GovernanceError("remote reference lookup returned an ambiguous result")
    fields = lines[0].split()
    if len(fields) != 2 or fields[1] != reference or not _GITHUB_SHA.fullmatch(fields[0]):
        raise GovernanceError("remote reference lookup returned an invalid result")
    return fields[0]


def _task_push(root: Path, task: Dict[str, Any], actor: str, reason: str) -> Dict[str, Any]:
    _require_regular_task_transport(root, task, ("COMMITTED",))
    if actor != "Codex":
        raise GovernanceError("push-task must record --actor Codex exactly")
    if not reason.strip():
        raise GovernanceError("push-task reason must be non-empty")
    task_record = "project-control/tasks/%s.json" % task["task_id"]
    dirty_task = _git(
        root,
        ("status", "--porcelain", "--untracked-files=all", "--", task_record),
        "cannot verify committed task control state",
    )
    if dirty_task:
        raise GovernanceError("push-task requires the current task control record to match HEAD")
    content_sha = normalize_commit(
        task.get("git", {}).get("committed_sha"),
        "task.git.committed_sha",
    )
    head = normalize_commit(_git(root, ("rev-parse", "HEAD"), "cannot resolve push head"), "HEAD")
    if head == content_sha:
        raise GovernanceError("push-task requires the protected control commit after task content")
    _verify_content_control_commits(root, content_sha, head)
    _configure_fixed_origin(root)
    reference = "refs/heads/" + str(task["branch"])
    remote_before = _remote_ref_sha(
        _git(root, ("ls-remote", _BOOTSTRAP_PUSH_URL, reference), "cannot inspect remote task branch"),
        reference,
    )
    pushed = remote_before != head
    if remote_before is not None and pushed:
        _output, ancestor_error = run_git(
            root, ("merge-base", "--is-ancestor", remote_before, head)
        )
        if ancestor_error:
            raise GovernanceError(
                "remote task branch is not a local ancestor; refusing a non-fast-forward push"
            )
    if pushed:
        _git(
            root,
            ("push", _BOOTSTRAP_PUSH_URL, "HEAD:" + reference),
            "task branch push failed without force",
        )
    remote_after = _remote_ref_sha(
        _git(root, ("ls-remote", _BOOTSTRAP_PUSH_URL, reference), "cannot verify pushed task branch"),
        reference,
    )
    if remote_after != head:
        raise GovernanceError("remote task branch does not match the reviewed control head")
    return {
        "task_id": task["task_id"],
        "branch": task["branch"],
        "content_sha": content_sha,
        "control_sha": head,
        "remote": _BOOTSTRAP_SOURCE_REPOSITORY,
        "transport": _BOOTSTRAP_PUSH_URL,
        "previous_remote_sha": remote_before,
        "remote_branch_sha": remote_after,
        "pushed": pushed,
        "forced": False,
    }


def _recover_blocked_task(
    root: Path,
    task: Dict[str, Any],
    actor: str,
    reason: str,
) -> Dict[str, Any]:
    _require_regular_task_transport(root, task, ("BLOCKED",))
    if actor != "Codex":
        raise GovernanceError("recover-blocked must record --actor Codex exactly")
    if not reason.strip():
        raise GovernanceError("recover-blocked reason must be non-empty")
    if task.get("exception", {}).get("previous_status") != "COMMITTED":
        raise GovernanceError("recover-blocked only handles a task blocked after COMMITTED")
    candidates = _changed_worktree_paths(root)
    ordinary = [path for path in candidates if not _protected_control_path(path)]
    if ordinary:
        raise GovernanceError(
            "recover-blocked found ordinary changes before evidence invalidation: %s"
            % ", ".join(sorted(ordinary))
        )
    content_sha = normalize_commit(
        task.get("git", {}).get("committed_sha"),
        "task.git.committed_sha",
    )
    control_sha = normalize_commit(
        _git(root, ("rev-parse", "HEAD"), "cannot resolve blocked task head"),
        "HEAD",
    )
    _verify_content_control_commits(root, content_sha, control_sha)
    timestamp = utc_now()
    archived_results = copy.deepcopy(task.get("validation", {}).get("results", []))
    archived_git = copy.deepcopy(task.get("git", {}))
    archived_exception = copy.deepcopy(task.get("exception", {}))
    task.setdefault("recovery_history", []).append({
        "at": timestamp,
        "actor": actor,
        "reason": reason,
        "scope_hash": canonical_scope_hash(task),
        "from_status": "BLOCKED",
        "from_previous_status": "COMMITTED",
        "to_status": "IN_PROGRESS",
        "failed_content_sha": content_sha,
        "failed_control_sha": control_sha,
        "archived_git": archived_git,
        "archived_exception": archived_exception,
        "archived_validation_results": archived_results,
        "append_only_required": True,
        "force_push_allowed": False,
    })
    task.setdefault("history", []).append({
        "event": "same_scope_blocked_recovery",
        "from": "BLOCKED",
        "to": "IN_PROGRESS",
        "at": timestamp,
        "actor": actor,
        "reason": reason,
        "failed_content_sha": content_sha,
        "failed_control_sha": control_sha,
    })
    task["validation"]["results"] = []
    task["git"] = {}
    task["status"] = "IN_PROGRESS"
    task.pop("exception", None)
    task["updated_at"] = timestamp
    validate_task(task)
    write_json_atomic(task_path(root, task["task_id"]), task)
    return {
        "task": task,
        "failed_content_sha": content_sha,
        "failed_control_sha": control_sha,
        "archived_result_count": len(archived_results),
        "message": "same-scope blocked task reopened; all local validation must rerun",
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
    if phase == "ci" and os.environ.get("GITHUB_ACTIONS") == "true":
        # Actions checks out the exact event SHA in detached-HEAD mode.  Trust
        # that checkout only after the read-only CI reconciler binds the event,
        # repository, commit, branch, changed paths and release runner.
        from reconcile import run_reconcile

        report = run_reconcile(root, "ci")
        if not report.get("ok"):
            failed = [
                str(item.get("message"))
                for item in report.get("checks", [])
                if item.get("status") == "failed"
            ]
            raise GovernanceError(
                "trusted GitHub CI context is invalid: %s"
                % ("; ".join(failed) or "CI reconciliation failed")
            )
        return
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


_TASK_RECORD_LOCK_TIMEOUT_SECONDS = 10.0


@contextlib.contextmanager
def _task_record_lock(root: Path, task_id: str) -> Iterator[None]:
    """Serialize short task-record mutations across agents and processes."""

    record_path = task_path(root, task_id)
    record_path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = record_path.with_name(".%s.lock" % record_path.name)
    deadline = time.monotonic() + _TASK_RECORD_LOCK_TIMEOUT_SECONDS
    while True:
        try:
            os.mkdir(lock_path)
            break
        except FileExistsError:
            if time.monotonic() >= deadline:
                raise GovernanceError(
                    "timed out waiting for task record lock: %s" % lock_path.name
                )
            time.sleep(0.01)
        except OSError as exc:
            raise GovernanceError("cannot acquire task record lock: %s" % exc) from exc
    try:
        yield
    finally:
        try:
            os.rmdir(lock_path)
        except FileNotFoundError:
            pass
        except OSError as exc:
            raise GovernanceError("cannot release task record lock: %s" % exc) from exc


def _bounded_subtask_text(
    value: str,
    field: str,
    maximum: int,
    *,
    reject_sensitive: bool = False,
) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum or "\x00" in value:
        raise GovernanceError("%s must be a non-empty bounded string" % field)
    normalized = value.strip()
    if reject_sensitive:
        sensitive_reason = subtask_sensitive_text_reason(normalized)
        if sensitive_reason is not None:
            raise GovernanceError(
                "%s resembles %s; record only a redacted summary"
                % (field, sensitive_reason)
            )
    return normalized


def _start_subtask_record(
    root: Path,
    task_id: str,
    identifier: str,
    name: str,
    purpose: str,
    actor: str,
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    with _task_record_lock(root, task_id):
        task = load_task(root, task_id)
        _require_current_task(root, task)
        if task.get("status") != "IN_PROGRESS":
            raise GovernanceError("subtask-start requires the current task to be IN_PROGRESS")
        if actor != "Codex":
            raise GovernanceError("subtask-start must record --actor Codex exactly")
        normalized_id = _bounded_subtask_text(identifier, "subtask.id", 128)
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", normalized_id):
            raise GovernanceError("subtask.id contains unsupported characters")
        subtasks = task.setdefault("subtasks", [])
        if any(item.get("id") == normalized_id for item in subtasks):
            raise GovernanceError("subtask id already exists: %s" % normalized_id)
        timestamp = utc_now()
        record = {
            "id": normalized_id,
            "name": _bounded_subtask_text(name, "subtask.name", 512),
            "purpose": _bounded_subtask_text(
                purpose, "subtask.purpose", 512, reject_sensitive=True
            ),
            "status": "in_progress",
            "started_at": timestamp,
            "finished_at": None,
            "result": None,
        }
        subtasks.append(record)
        task["updated_at"] = timestamp
        validate_task(task)
        write_json_atomic(task_path(root, task_id), task)
        return task, record


def _finish_subtask_record(
    root: Path,
    task_id: str,
    identifier: str,
    status: str,
    result: str,
    actor: str,
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    with _task_record_lock(root, task_id):
        task = load_task(root, task_id)
        _require_current_task(root, task)
        if task.get("status") != "IN_PROGRESS":
            raise GovernanceError("subtask-finish requires the current task to be IN_PROGRESS")
        if actor != "Codex":
            raise GovernanceError("subtask-finish must record --actor Codex exactly")
        normalized_id = _bounded_subtask_text(identifier, "subtask.id", 128)
        matching = [item for item in task.get("subtasks", []) if item.get("id") == normalized_id]
        if len(matching) != 1:
            raise GovernanceError("subtask id is not recorded exactly once: %s" % normalized_id)
        record = matching[0]
        if record.get("status") != "in_progress":
            raise GovernanceError("subtask is already finished: %s" % normalized_id)
        timestamp = utc_now()
        record["status"] = status
        record["finished_at"] = timestamp
        record["result"] = _bounded_subtask_text(
            result, "subtask.result", 4096, reject_sensitive=True
        )
        task["updated_at"] = timestamp
        validate_task(task)
        write_json_atomic(task_path(root, task_id), task)
        return task, record


def _create_task_branch(
    root: Path,
    task: Dict[str, Any],
    actor: str,
    reason: str,
) -> str:
    if actor != "Codex":
        raise GovernanceError("task branch creation must record --actor Codex exactly")
    if not reason.strip():
        raise GovernanceError("task branch reason must be non-empty")
    expected = task.get("branch")
    base = task.get("base_branch")
    if not isinstance(expected, str) or not expected.strip():
        raise GovernanceError("task branch is missing")
    if not isinstance(base, str) or not base.strip() or expected == base:
        raise GovernanceError("task branch must differ from its base branch")
    actual, branch_error = current_branch(root)
    if branch_error:
        raise GovernanceError(branch_error)
    if actual != base:
        raise GovernanceError(
            "task branch must start from base branch %s, found %s" % (base, actual)
        )
    _existing, existing_error = run_git(root, ("show-ref", "--verify", "refs/heads/" + expected))
    if existing_error is None:
        raise GovernanceError("task branch already exists: %s" % expected)
    _git(root, ("switch", "-c", expected), "cannot create task branch")
    actual, branch_error = current_branch(root)
    if branch_error or actual != expected:
        raise GovernanceError("created branch does not match task branch")
    timestamp = utc_now()
    task.setdefault("history", []).append({
        "event": "local_branch_started",
        "at": timestamp,
        "actor": actor,
        "reason": reason,
        "base_branch": base,
        "branch": expected,
    })
    return timestamp


def _require_merged_commit_relation(
    root: Path,
    task: Mapping[str, Any],
    merged_commit: str,
) -> None:
    """Bind a merge record to reviewed content already contained by the target branch."""

    committed = normalize_commit(
        task.get("git", {}).get("committed_sha"),
        "task.git.committed_sha",
    )
    merged = normalize_commit(merged_commit, "merged commit")
    _output, commit_error = run_git(root, ("cat-file", "-e", merged + "^{commit}"))
    if commit_error is not None:
        raise GovernanceError("merged commit is unavailable: %s" % commit_error)
    _output, ancestor_error = run_git(
        root, ("merge-base", "--is-ancestor", committed, merged)
    )
    if ancestor_error is not None:
        raise GovernanceError(
            "task.git.committed_sha is not an ancestor of the merged commit"
        )

    base_branch = task.get("base_branch")
    if not isinstance(base_branch, str) or not base_branch.strip():
        raise GovernanceError("merge target base_branch is missing")
    branch = base_branch.strip()
    candidate_refs = (
        branch if branch.startswith("refs/") else "refs/heads/" + branch,
        "refs/remotes/origin/" + branch.removeprefix("refs/heads/"),
    )
    resolved: Dict[str, str] = {}
    for reference in dict.fromkeys(candidate_refs):
        value, error = run_git(root, ("rev-parse", "--verify", reference + "^{commit}"))
        if error is None and value:
            resolved[reference] = normalize_commit(value, reference)
    if not resolved:
        raise GovernanceError(
            "merge target branch is unavailable locally: %s" % base_branch
        )
    containing_refs: List[str] = []
    for reference, tip in resolved.items():
        _output, relation_error = run_git(
            root, ("merge-base", "--is-ancestor", merged, tip)
        )
        if relation_error is None:
            containing_refs.append(reference)
    if not containing_refs:
        raise GovernanceError(
            "merged commit is not contained in the target branch %s"
            % base_branch
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

    selected_task = load_current_task(root)
    non_current_committed_restore = (
        current == "BLOCKED"
        and target == blocked_from == "COMMITTED"
        and selected_task.get("task_id") != task.get("task_id")
    )
    if non_current_committed_restore:
        repair_base_matches = selected_task.get("base_branch") == task.get("branch")
        if not repair_base_matches:
            repair_base, repair_base_error = run_git(
                root,
                ("rev-parse", "--verify", "refs/heads/" + str(selected_task.get("base_branch", ""))),
            )
            blocked_branch, blocked_branch_error = run_git(
                root,
                ("rev-parse", "--verify", "refs/heads/" + str(task.get("branch", ""))),
            )
            repair_base_matches = (
                repair_base_error is None
                and blocked_branch_error is None
                and normalize_commit(repair_base, "repair base branch")
                == normalize_commit(blocked_branch, "blocked task branch")
            )
        if (
            selected_task.get("status") != "IN_PROGRESS"
            or not repair_base_matches
        ):
            raise GovernanceError(
                "a non-current committed restore is limited to the in-progress repair task "
                "based on the blocked task branch"
            )
    elif target in _CURRENT_TASK_TARGETS:
        _require_current_task(root, task)
    legacy_g0_resume = (
        current == "BLOCKED"
        and target == blocked_from == "IN_PROGRESS"
        and legacy_g0_v1_migration(task)
    )
    if target in NORMAL_STATES[3:] and not legacy_g0_resume:
        _require_complete_validation_plan(task)
    if target in _WORK_BRANCH_TARGETS and not non_current_committed_restore:
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
        if non_current_committed_restore:
            existing_commit = normalize_commit(
                task.get("git", {}).get("committed_sha"),
                "task.git.committed_sha",
            )
            if normalized_commit != existing_commit:
                raise GovernanceError(
                    "a non-current committed restore must preserve task.git.committed_sha"
                )
    elif commit:
        raise GovernanceError("--commit is only valid when entering COMMITTED or MERGED")

    target_index = NORMAL_STATES.index(target) if target in NORMAL_STATES else -1
    if target_index >= NORMAL_STATES.index("LOCAL_VERIFIED"):
        open_subtasks = [
            str(item.get("id"))
            for item in task.get("subtasks", [])
            if isinstance(item, Mapping) and item.get("status") == "in_progress"
        ]
        if open_subtasks:
            raise GovernanceError(
                "cannot enter %s while subtasks are in progress: %s"
                % (target, ", ".join(open_subtasks))
            )
    required_gates: List[str] = []
    if target_index >= NORMAL_STATES.index("LOCAL_VERIFIED"):
        required_gates.append("LOCAL_VERIFIED")
    if target == "CI_VERIFIED":
        required_gates.append("CI_VERIFIED")
    if target == "POST_MERGE_VERIFIED":
        required_gates.append("POST_MERGE_VERIFIED")
    if not non_current_committed_restore:
        for gate_name in required_gates:
            gate = validation_gate_status(root, task, gate_name)
            if gate["missing"]:
                raise GovernanceError("required %s validations are not satisfied: %s" % (
                    gate_name,
                    ", ".join("%s (%s)" % (item["check_id"], item["reason"]) for item in gate["missing"]),
                ))

    if target == "MERGED":
        final_receipt, final_reason = find_effective_final_action_review(root, task, "merge")
        if final_receipt is None:
            raise GovernanceError("final merge has no effective user decision: %s" % final_reason)
        assert normalized_commit is not None
        _require_merged_commit_relation(root, task, normalized_commit)

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

    recovery_info = subparsers.add_parser(
        "prepare-recovery",
        help="show the exact current-task context needed for a recovery proposal",
    )
    recovery_info.add_argument("task_id")
    common(recovery_info)

    pr_link = subparsers.add_parser(
        "open-pr",
        help="show the fixed GitHub compare URL for the reviewed task branch",
    )
    pr_link.add_argument("task_id")
    common(pr_link)

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

    start_branch = subparsers.add_parser(
        "start-branch",
        help="create and switch to the local task branch from its base branch",
    )
    start_branch.add_argument("task_id")
    start_branch.add_argument("--actor", required=True)
    start_branch.add_argument("--reason", required=True)
    common(start_branch)

    begin = subparsers.add_parser(
        "begin",
        help="create the task branch and enter IN_PROGRESS without a scope receipt",
    )
    begin.add_argument("task_id")
    begin.add_argument("--actor", required=True)
    begin.add_argument("--reason", required=True)
    common(begin)

    subtask_start = subparsers.add_parser(
        "subtask-start",
        help="record a lightweight child task or subagent before it starts",
    )
    subtask_start.add_argument("task_id")
    subtask_start.add_argument("--id", required=True, dest="subtask_id")
    subtask_start.add_argument("--name", required=True)
    subtask_start.add_argument("--purpose", required=True)
    subtask_start.add_argument("--actor", required=True)
    common(subtask_start)

    subtask_finish = subparsers.add_parser(
        "subtask-finish",
        help="finish a recorded child task or subagent with a concise result",
    )
    subtask_finish.add_argument("task_id")
    subtask_finish.add_argument("--id", required=True, dest="subtask_id")
    subtask_finish.add_argument(
        "--status", required=True, choices=("completed", "failed", "cancelled")
    )
    subtask_finish.add_argument("--result", required=True)
    subtask_finish.add_argument("--actor", required=True)
    common(subtask_finish)

    subtask_list = subparsers.add_parser(
        "subtask-list",
        help="show the lightweight subtask records for one task",
    )
    subtask_list.add_argument("task_id")
    common(subtask_list)

    commit_task = subparsers.add_parser(
        "commit-task",
        help="create manifest-owned content and protected control commits after validation",
    )
    commit_task.add_argument("task_id")
    commit_task.add_argument("--manifest", required=True)
    commit_task.add_argument("--actor", required=True)
    commit_task.add_argument("--reason", required=True)
    common(commit_task)

    for command, help_text in (
        (
            "push-task",
            "push the reviewed task branch as a non-force fast-forward",
        ),
        (
            "recover-blocked",
            "reopen same-scope work append-only after a committed task is blocked",
        ),
    ):
        controlled_git = subparsers.add_parser(command, help=help_text)
        controlled_git.add_argument("task_id")
        controlled_git.add_argument("--actor", required=True)
        controlled_git.add_argument("--reason", required=True)
        common(controlled_git)

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

        if args.command == "prepare-recovery":
            task = load_task(root, args.task_id)
            _require_current_task(root, task)
            if task.get("status") != "BLOCKED":
                raise GovernanceError("prepare-recovery requires the current task to be BLOCKED")
            head = normalize_commit(
                _git(root, ("rev-parse", "HEAD"), "cannot resolve recovery head"),
                "HEAD",
            )
            _emit({
                "ok": True,
                "task_id": task["task_id"],
                "status": task["status"],
                "previous_status": task.get("exception", {}).get("previous_status"),
                "head": head,
                "branch": task.get("branch"),
                "proposal_prefix": "project-control/proposals/%s-" % task["task_id"],
            }, args.json)
            return 0

        if args.command == "open-pr":
            task = load_task(root, args.task_id)
            _require_current_task(root, task)
            if task.get("status") not in ("COMMITTED", "CI_VERIFIED", "CODE_REVIEWED"):
                raise GovernanceError("open-pr requires committed task content")
            branch = str(task.get("branch", ""))
            base = str(task.get("base_branch", ""))
            if not branch or not base or branch == base:
                raise GovernanceError("open-pr requires distinct reviewed base and task branches")
            _emit({
                "ok": True,
                "task_id": task["task_id"],
                "url": "https://github.com/wzhic/material/compare/%s...%s?expand=1" % (base, branch),
                "creates_pull_request": False,
                "message": "open this URL to create the pull request; merge remains a user decision",
            }, args.json)
            return 0

        if args.command == "transition":
            with _task_record_lock(root, args.task_id):
                task = load_task(root, args.task_id)
                changed = _transition(root, task, args.target, args.actor, args.reason, args.commit)
            _emit({"ok": True, "task": changed, "message": "transition recorded"}, args.json)
            return 0

        if args.command == "subtask-list":
            task = load_task(root, args.task_id)
            subtasks = list(task.get("subtasks", []))
            _emit({
                "ok": True,
                "task_id": task["task_id"],
                "subtasks": subtasks,
                "open": [item for item in subtasks if item.get("status") == "in_progress"],
            }, args.json)
            return 0

        if args.command == "subtask-start":
            task, record = _start_subtask_record(
                root,
                args.task_id,
                args.subtask_id,
                args.name,
                args.purpose,
                args.actor,
            )
            _emit({
                "ok": True,
                "task_id": task["task_id"],
                "subtask": record,
                "message": "subtask start recorded",
            }, args.json)
            return 0

        if args.command == "subtask-finish":
            task, record = _finish_subtask_record(
                root,
                args.task_id,
                args.subtask_id,
                args.status,
                args.result,
                args.actor,
            )
            _emit({
                "ok": True,
                "task_id": task["task_id"],
                "subtask": record,
                "message": "subtask finish recorded",
            }, args.json)
            return 0

        if args.command == "begin":
            task = load_task(root, args.task_id)
            _require_current_task(root, task)
            _require_complete_validation_plan(task)
            _require_done_dependencies(root, task)
            if task.get("blockers"):
                raise GovernanceError("begin requires blockers to be resolved")
            if task.get("status") not in ("DRAFT", "REVIEW_PENDING", "APPROVED", "READY"):
                raise GovernanceError(
                    "begin requires task status DRAFT, REVIEW_PENDING, APPROVED or READY"
                )
            if task.get("requirement", {}).get("interaction_kind") not in (
                "ui", "non_ui", "mixed",
            ):
                raise GovernanceError("begin requires requirement.interaction_kind")
            previous = str(task["status"])
            timestamp = _create_task_branch(root, task, args.actor, args.reason)
            task.setdefault("history", []).append({
                "event": "task_started",
                "from": previous,
                "to": "IN_PROGRESS",
                "at": timestamp,
                "actor": args.actor,
                "reason": args.reason,
            })
            task["status"] = "IN_PROGRESS"
            task.pop("exception", None)
            task["updated_at"] = timestamp
            validate_task(task)
            write_json_atomic(task_path(root, args.task_id), task)
            _emit({
                "ok": True,
                "task": task,
                "branch": task["branch"],
                "base_branch": task["base_branch"],
                "message": "task branch created and task entered IN_PROGRESS",
            }, args.json)
            return 0

        if args.command == "start-branch":
            task = load_task(root, args.task_id)
            _require_current_task(root, task)
            _require_complete_validation_plan(task)
            if task.get("status") not in ("APPROVED", "READY"):
                raise GovernanceError("start-branch requires task status APPROVED or READY")
            timestamp = _create_task_branch(root, task, args.actor, args.reason)
            task["updated_at"] = timestamp
            validate_task(task)
            write_json_atomic(task_path(root, args.task_id), task)
            _emit({
                "ok": True,
                "task": task,
                "branch": task["branch"],
                "base_branch": task["base_branch"],
                "message": "local task branch created",
            }, args.json)
            return 0

        if args.command == "commit-task":
            task = load_task(root, args.task_id)
            evidence = _task_commit(root, task, args.actor, args.reason, args.manifest)
            _emit({
                "ok": True,
                "task": evidence["task"],
                "evidence": {key: value for key, value in evidence.items() if key != "task"},
                "message": "reviewed task content and protected control commits created",
            }, args.json)
            return 0

        if args.command == "push-task":
            task = load_task(root, args.task_id)
            evidence = _task_push(root, task, args.actor, args.reason)
            _emit({
                "ok": True,
                "task_id": task["task_id"],
                "evidence": evidence,
                "message": "reviewed task branch is present remotely without force",
            }, args.json)
            return 0

        if args.command == "recover-blocked":
            task = load_task(root, args.task_id)
            evidence = _recover_blocked_task(root, task, args.actor, args.reason)
            _emit({"ok": True, **evidence}, args.json)
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
                integrity_details = []
                for failed_result in integrity_failures:
                    issues = failed_result.get("integrity", {}).get("issues", [])
                    integrity_details.append(
                        "%s (%s)" % (
                            failed_result.get("check_id", "unknown-check"),
                            ", ".join(str(item) for item in issues) or "integrity mismatch",
                        )
                    )
                raise GovernanceError(
                    "controlled validation changed managed content or protected governance state; "
                    "no result was recorded: %s" % "; ".join(integrity_details)
                )
            # CI process reports remain ephemeral: the Actions job result is
            # authoritative and ordinary work does not copy Run metadata into
            # the local task record.  The legacy sync command is read-compatible
            # only and is not part of the current workflow.
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
                        "controlled CI checks completed; the Actions job result is authoritative "
                        "and is not persisted in the local task record"
                    ),
                }
            _emit(payload, args.json)
            return 0 if batch["status"] == "passed" else 1

        if args.command == "recover-pending-content":
            task = load_task(root, args.task_id)
            _require_current_task(root, task)
            _require_complete_validation_plan(task)
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
            timestamp = utc_now()
            archived_results = copy.deepcopy(task.get("validation", {}).get("results", []))
            task.setdefault("rework_history", []).append({
                "at": timestamp,
                "actor": args.actor,
                "reason": args.reason,
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
                "archived_result_count": len(archived_results),
                "message": "same-scope local rework reopened; prior evidence is archived and inactive",
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
                # A pushed/committed task may wait for GitHub independently.
                # This lets one maintainer continue with the next feature
                # without importing CI run metadata or abandoning the task.
                switchable_states = _SELECTABLE_TERMINAL_STATES | {"COMMITTED"}
                if active["status"] not in switchable_states:
                    raise GovernanceError(
                        "cannot switch away from unfinished current task %s (%s)"
                        % (active["task_id"], active["status"])
                    )

            expected_branch = str(task.get("branch", ""))
            actual_branch, branch_error = current_branch(root)
            if branch_error:
                raise GovernanceError("cannot inspect current branch: %s" % branch_error)
            branch_switched = False
            if actual_branch != expected_branch:
                _existing, target_error = run_git(
                    root,
                    ("show-ref", "--verify", "--quiet", "refs/heads/" + expected_branch),
                )
                if target_error is None:
                    changed_paths = _changed_worktree_paths(root)
                    if changed_paths:
                        raise GovernanceError(
                            "cannot switch task branches with uncommitted paths: %s"
                            % ", ".join(changed_paths)
                        )
                    _git(
                        root,
                        ("switch", expected_branch),
                        "cannot switch to target task branch",
                    )
                    branch_switched = True
                    try:
                        task = load_task(root, args.task_id)
                        if task.get("branch") != expected_branch:
                            raise GovernanceError(
                                "target branch task record does not match expected branch"
                            )
                    except (GovernanceError, OSError) as exc:
                        _restored, restore_error = run_git(root, ("switch", str(actual_branch)))
                        if restore_error:
                            raise GovernanceError(
                                "%s; failed to restore previous branch: %s"
                                % (exc, restore_error)
                            ) from exc
                        raise
                elif task.get("status") != "DRAFT":
                    raise GovernanceError(
                        "target task branch does not exist for status %s: %s"
                        % (task.get("status"), expected_branch)
                    )
            current = {
                "schema_version": 1,
                "task_id": task["task_id"],
                "selected_at": utc_now(),
                "selected_by": args.actor,
                "reason": args.reason,
                "previous_task_id": previous,
            }
            try:
                write_json_atomic(control_dir(root) / "current-task.json", current)
            except OSError as exc:
                if branch_switched:
                    _restored, restore_error = run_git(root, ("switch", str(actual_branch)))
                    if restore_error:
                        raise GovernanceError(
                            "cannot update current task record: %s; failed to restore previous branch: %s"
                            % (exc, restore_error)
                        ) from exc
                raise GovernanceError("cannot update current task record: %s" % exc) from exc
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
