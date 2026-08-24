#!/usr/bin/env python3
"""Inject a concise current-task summary when a Codex session starts."""

from __future__ import annotations

import json
from typing import Any, Dict

from _governance import (
    GovernanceError,
    ORDINARY_WRITE_STATE,
    concise_reasons,
    emit_json,
    load_snapshot,
    load_stdin_object,
    repo_root_from_payload,
)


PREPARATION_WRITE_STATES = {
    "DRAFT",
    "REVIEW_PENDING",
    "APPROVED",
    "READY",
}


NEXT_STATE = {
    "DRAFT": "IN_PROGRESS",
    "REVIEW_PENDING": "APPROVED",
    "APPROVED": "READY",
    "READY": "IN_PROGRESS",
    "IN_PROGRESS": "LOCAL_VERIFIED",
    "LOCAL_VERIFIED": "COMMITTED",
    "COMMITTED": "CI_VERIFIED",
    "CI_VERIFIED": "CODE_REVIEWED",
    "CODE_REVIEWED": "MERGED",
    "MERGED": "POST_MERGE_VERIFIED",
    "POST_MERGE_VERIFIED": "DONE",
}


NEXT_STEP = {
    "DRAFT": "Use taskctl begin to create the task branch and enter IN_PROGRESS.",
    "REVIEW_PENDING": (
        "This is a compatibility state. Reconcile the recorded task with taskctl and resume "
        "toward IN_PROGRESS; routine work needs no scope receipt."
    ),
    "APPROVED": "Resume this compatibility state toward IN_PROGRESS on its task branch.",
    "READY": "Enter IN_PROGRESS before ordinary implementation work.",
    "IN_PROGRESS": (
        "Work only in scope, then use taskctl run-validation or taskctl run-required "
        "--phase local so the controlled runner derives every result before transition "
        "to LOCAL_VERIFIED."
    ),
    "LOCAL_VERIFIED": (
        "Ordinary writes are frozen. Use taskctl commit-task after the "
        "complete local gate; exact unborn GOV-0001 keeps its bounded bootstrap transport. "
        "Same-scope local rework may use taskctl reopen before any content drift."
    ),
    "COMMITTED": (
        "Use taskctl push-task for a non-force feature-branch fast-forward and prepare the PR. "
        "Inspect GitHub Actions directly; do not import Run metadata into the task. Stop for "
        "the user's final merge decision after every required job is green."
    ),
    "CI_VERIFIED": (
        "This compatibility state still requires the user's final merge decision; it does not "
        "require a routine code-review receipt."
    ),
    "CODE_REVIEWED": "Merge through the controlled repository workflow, then transition to MERGED.",
    "MERGED": (
        "Confirm the merge result before closing the task. Deployment or release remains a "
        "separate explicit user decision."
    ),
    "POST_MERGE_VERIFIED": "Confirm all release evidence and transition to DONE.",
    "DONE": "Create and select a new DRAFT task before starting another requirement.",
    "CANCELLED": "Create and select a new DRAFT task before starting another requirement.",
    "FAILED": "Record the failure decision, then use taskctl to resume IN_PROGRESS or cancel.",
    "REJECTED": "Revise the recorded scope with taskctl or cancel the task.",
}

PROHIBITED_PATHS = [
    {
        "pattern": ".git/**",
        "reason": "Git metadata is never a direct file-edit target.",
    },
    {
        "pattern": "project-control/reviews/**",
        "reason": (
            "Review files are machine records; use reviewctl record-conversation for an "
            "explicit user dialogue decision and never edit receipt files directly."
        ),
    },
    {
        "pattern": "project-control/tasks/**",
        "reason": "Task state changes must go through taskctl.",
    },
    {
        "pattern": "project-control/current-task.json",
        "reason": "Current task selection must go through taskctl set-current.",
    },
    {
        "pattern": "<outside task.allowed_paths>",
        "reason": "All other writes must stay inside the current task allowed_paths.",
    },
]


def _next_state_and_step(task: Dict[str, Any]) -> tuple:
    status = task.get("status")
    if status == "BLOCKED":
        exception = task.get("exception")
        previous = exception.get("previous_status") if isinstance(exception, dict) else None
        if previous == "COMMITTED" and task.get("task_id") != "GOV-0001":
            return previous, (
                "For same-scope append-only repair, use taskctl recover-blocked, rerun the full "
                "local gate, then create and non-force push new descendant commits."
            )
        return previous, "Resolve the recorded blockers, then use taskctl to resume the previous state."
    return NEXT_STATE.get(status), NEXT_STEP.get(
        status,
        "Create or reconcile a valid task before performing write-capable work.",
    )


def _open_subtasks(task: Dict[str, Any]) -> list:
    """Return only the small, non-sensitive part of active subtask records."""

    records = task.get("subtasks", [])
    if not isinstance(records, list):
        return []
    open_records = []
    for record in records:
        if not isinstance(record, dict) or record.get("status") != "in_progress":
            continue
        values = {key: record.get(key) for key in ("id", "name", "purpose")}
        if all(isinstance(value, str) and value.strip() for value in values.values()):
            open_records.append(values)
    return open_records


def _context_document(payload: Dict[str, Any]) -> Dict[str, Any]:
    source = payload.get("source")
    if source not in {"startup", "resume", "clear", "compact"}:
        return {
            "governance": "FAIL_CLOSED",
            "write_mode": "FAIL_CLOSED",
            "reason": "SessionStart source is missing or unsupported",
            "next_state": None,
            "next_step": "Provide a supported SessionStart source and reconcile governance state.",
            "prohibited_paths": PROHIBITED_PATHS,
            "instruction": "Do not start work. Only read-only inspection is permitted.",
        }
    try:
        repo_root = repo_root_from_payload(payload)
        snapshot = load_snapshot(repo_root)
    except GovernanceError as exc:
        return {
            "governance": "FAIL_CLOSED",
            "write_mode": "FAIL_CLOSED",
            "reason": str(exc),
            "next_state": None,
            "next_step": "Reconcile repository task state before write-capable work.",
            "prohibited_paths": PROHIBITED_PATHS,
            "instruction": "Do not start work. Only read-only inspection is permitted.",
        }

    task = snapshot.task or {}
    next_state, next_step = _next_state_and_step(task)
    status = task.get("status")
    blockers = task.get("blockers") if isinstance(task.get("blockers"), list) else []
    ordinary_writes_allowed = (
        snapshot.valid
        and status == ORDINARY_WRITE_STATE
        and not blockers
    )
    preparation_writes_allowed = snapshot.valid and status in PREPARATION_WRITE_STATES
    recovery_proposal_allowed = snapshot.valid and status == "BLOCKED"
    if not snapshot.valid:
        write_mode = "FAIL_CLOSED"
        instruction = (
            "Do not start work. Only strict read-only inspection and exact governance "
            "lifecycle commands are permitted until task state reconciles."
        )
    elif ordinary_writes_allowed:
        write_mode = "IN_SCOPE_WRITES_ALLOWED"
        instruction = (
            "Ordinary writes are allowed only inside current-task allowed_paths while the "
            "task remains IN_PROGRESS; do not bypass validation."
        )
    elif preparation_writes_allowed:
        write_mode = "PREPARATION_WRITES_ALLOWED"
        instruction = (
            "Local preparation files may be created or edited only in docs/requirements, "
            "docs/decisions, and project-control/proposals. Protected task/review/current "
            "records and implementation files remain blocked until the task is IN_PROGRESS."
        )
    elif recovery_proposal_allowed:
        write_mode = "RECOVERY_PROPOSAL_ONLY"
        instruction = (
            "Only a recovery proposal whose filename starts with the current task id may be "
            "prepared. All implementation, terminal-task, and cross-task writes remain blocked."
        )
    else:
        write_mode = "GOVERNANCE_ONLY"
        instruction = (
            "Ordinary writes are prohibited. Only strict read-only inspection and exact "
            "taskctl/reviewctl lifecycle commands are permitted."
        )
        if status == ORDINARY_WRITE_STATE and blockers:
            next_step = "Resolve the recorded blockers through taskctl before ordinary work resumes."
    context: Dict[str, Any] = {
        "governance": "READY" if snapshot.valid else "FAIL_CLOSED",
        "write_mode": write_mode,
        "repository": str(repo_root),
        "task": {
            "id": task.get("task_id"),
            "status": task.get("status"),
        },
        "branch": {
            "base": task.get("base_branch"),
            "expected": task.get("branch"),
            "actual": snapshot.actual_branch,
        },
        "allowed_paths": task.get("allowed_paths", []),
        "blockers": blockers,
        "open_subtasks": _open_subtasks(task),
        "next_state": next_state,
        "next_step": next_step,
        "prohibited_paths": PROHIBITED_PATHS,
        "reconciliation_issues": list(snapshot.reasons),
        "instruction": instruction,
    }
    if not snapshot.valid:
        context["reason"] = concise_reasons(snapshot.reasons)
    return context


def _output_for_context(context: Dict[str, Any]) -> Dict[str, Any]:
    text = "PROJECT GOVERNANCE CONTEXT\n" + json.dumps(
        context,
        ensure_ascii=False,
        sort_keys=True,
        indent=2,
    )
    return {
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": text,
        }
    }


def build_output(payload: Dict[str, Any]) -> Dict[str, Any]:
    return _output_for_context(_context_document(payload))


def main() -> int:
    try:
        payload = load_stdin_object()
        output = build_output(payload)
    except GovernanceError as exc:
        output = _output_for_context(
            {
                "governance": "FAIL_CLOSED",
                "write_mode": "FAIL_CLOSED",
                "reason": str(exc),
                "next_state": None,
                "next_step": "Provide valid hook input and reconcile governance state.",
                "prohibited_paths": PROHIBITED_PATHS,
                "instruction": "Do not start work. Only read-only inspection is permitted.",
            }
        )
    except Exception:
        output = _output_for_context(
            {
                "governance": "FAIL_CLOSED",
                "write_mode": "FAIL_CLOSED",
                "reason": "governance hook failed unexpectedly",
                "next_state": None,
                "next_step": "Reconcile Hook and governance state before write-capable work.",
                "prohibited_paths": PROHIBITED_PATHS,
                "instruction": "Do not start work. Only read-only inspection is permitted.",
            }
        )
    emit_json(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
