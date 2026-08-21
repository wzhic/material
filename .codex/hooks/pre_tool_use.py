#!/usr/bin/env python3
"""Codex PreToolUse gate for current-task scope."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, Optional

from _governance import (
    GovernanceError,
    command_is_reviewed,
    concise_reasons,
    emit_json,
    extract_apply_patch_paths,
    governance_cli_policy,
    is_ordinary_development_bash,
    is_strict_readonly_bash,
    load_snapshot,
    load_stdin_object,
    normalize_repo_path,
    nonpatch_tool_paths,
    ordinary_bash_scope_reason,
    ORDINARY_WRITE_STATE,
    path_is_allowed,
    prohibited_bash_reason,
    direct_governance_mutation_reason,
    repo_root_from_payload,
    safe_local_read_tool,
    tool_is_reviewed,
)


PREPARATION_WRITE_STATES = {
    "DRAFT",
    "REVIEW_PENDING",
    "APPROVED",
    "READY",
}
PREPARATION_PATHS = (
    "project-control/proposals/**",
    "docs/requirements/**",
    "docs/decisions/**",
)


def deny(reason: str) -> Dict[str, Any]:
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }


def _policy_tool_name(tool_name: str) -> str:
    """Collapse supported aliases before any high-risk tool dispatch.

    Codex has emitted both ``apply_patch``/``ApplyPatch`` and case variants of
    ``Bash`` across hosts.  Dispatching before normalization would let an alias
    fall through to the generic allow-list path and bypass the parser that
    enforces command or patch invariants.
    """

    normalized = tool_name.strip().lower().replace("_", "").replace("-", "")
    if normalized == "applypatch":
        return "apply_patch"
    if normalized == "bash":
        return "Bash"
    return tool_name


def _normalized_tool_name(tool_name: str) -> str:
    return "".join(character for character in tool_name.casefold() if character.isalnum())


PASSIVE_COLLABORATION_TOOLS = {
    "listagents",
    "collaborationlistagents",
    "waitagent",
    "collaborationwaitagent",
}
ACTIVE_COLLABORATION_TOOLS = {
    "sendmessage",
    "collaborationsendmessage",
    "followuptask",
    "collaborationfollowuptask",
    "interruptagent",
    "collaborationinterruptagent",
}
SPAWN_COLLABORATION_TOOLS = {
    "spawnagent",
    "collaborationspawnagent",
}


def _spawn_record_reason(task: Dict[str, Any], tool_input: Any) -> Optional[str]:
    if not isinstance(tool_input, dict):
        return "spawn_agent input is not a JSON object"
    task_name = tool_input.get("task_name")
    if not isinstance(task_name, str) or not task_name.strip():
        return "spawn_agent requires a non-empty task_name"
    requested_name = task_name.strip().rstrip("/").rsplit("/", 1)[-1]
    subtasks = task.get("subtasks", [])
    if not isinstance(subtasks, list):
        return "task subtasks record is invalid"
    for record in subtasks:
        if not isinstance(record, dict) or record.get("status") != "in_progress":
            continue
        recorded_names = {
            str(value).strip().rstrip("/").rsplit("/", 1)[-1]
            for value in (record.get("id"), record.get("name"))
            if isinstance(value, str) and value.strip()
        }
        if requested_name in recorded_names:
            if record.get("finished_at") is None and record.get("result") is None:
                return None
    return (
        "spawn_agent requires a matching in-progress subtask record; run "
        "taskctl subtask-start before spawning"
    )


def evaluate(payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if payload.get("hook_event_name") != "PreToolUse":
        return deny("governance hook received the wrong event type")
    tool_name = payload.get("tool_name")
    if not isinstance(tool_name, str) or not tool_name:
        return deny("tool call is missing a canonical tool_name")
    tool_name = _policy_tool_name(tool_name)
    normalized_tool = _normalized_tool_name(tool_name)
    tool_input = payload.get("tool_input")
    try:
        repo_root = repo_root_from_payload(payload)
    except GovernanceError as exc:
        return deny(f"cannot establish repository governance root: {exc}")

    cwd = Path(str(payload.get("cwd"))).resolve(strict=False)
    nonpatch_paths = []
    if tool_name == "Bash":
        command = tool_input.get("command") if isinstance(tool_input, dict) else None
        if not isinstance(command, str):
            return deny("Bash tool input is missing command")
        reason = prohibited_bash_reason(command)
        if reason is not None:
            return deny(reason)
        governance_call = governance_cli_policy(command, repo_root, cwd)
        if governance_call is not None:
            allowed, governance_reason = governance_call
            return None if allowed else deny(governance_reason)
        if is_strict_readonly_bash(command, repo_root, cwd):
            return None
    elif safe_local_read_tool(tool_name, tool_input, repo_root, cwd):
        return None
    else:
        nonpatch_paths, path_error = nonpatch_tool_paths(tool_input, repo_root, cwd)
        if path_error is not None:
            return deny(path_error)
        for relative in nonpatch_paths:
            protected_reason = direct_governance_mutation_reason(relative)
            if protected_reason is not None:
                return deny(f"protected governance path {relative!r}: {protected_reason}")

    snapshot = load_snapshot(repo_root)
    if not snapshot.valid or snapshot.task is None:
        return deny("governance snapshot is invalid: " + concise_reasons(snapshot.reasons))
    task = snapshot.task
    status = task.get("status")
    if normalized_tool in PASSIVE_COLLABORATION_TOOLS:
        return None
    if normalized_tool in ACTIVE_COLLABORATION_TOOLS | SPAWN_COLLABORATION_TOOLS:
        if status != ORDINARY_WRITE_STATE:
            return deny(
                "active collaboration requires task status IN_PROGRESS; "
                f"current status is {status!r}"
            )
        if task.get("blockers"):
            return deny("task has unresolved blockers; active collaboration is prohibited")
        if normalized_tool in SPAWN_COLLABORATION_TOOLS:
            record_reason = _spawn_record_reason(task, tool_input)
            if record_reason is not None:
                return deny(record_reason)
        return None
    preparation_only = status in PREPARATION_WRITE_STATES
    recovery_proposal_only = status == "BLOCKED"
    if (preparation_only or recovery_proposal_only) and tool_name == "apply_patch":
        command = tool_input.get("command") if isinstance(tool_input, dict) else None
        try:
            targets = extract_apply_patch_paths(command)
            for raw_target in targets:
                relative, resolved = normalize_repo_path(repo_root, raw_target)
                resolved_relative = resolved.relative_to(repo_root.resolve()).as_posix()
                protected_reason = direct_governance_mutation_reason(resolved_relative)
                if protected_reason is None:
                    protected_reason = direct_governance_mutation_reason(relative)
                if protected_reason is not None:
                    return deny(f"protected governance path {relative!r}: {protected_reason}")
                allowed_preparation_paths = (
                    PREPARATION_PATHS if preparation_only else
                    ("project-control/proposals/%s-*.json" % task.get("task_id"),)
                )
                if not path_is_allowed(relative, allowed_preparation_paths):
                    return deny(
                        "preparation writes are limited to the current state and task-owned proposal files: "
                        + relative
                    )
        except GovernanceError as exc:
            return deny(str(exc))
        return None
    if status != ORDINARY_WRITE_STATE:
        return deny(
            "ordinary implementation writes require task status IN_PROGRESS; "
            f"current status is {status!r}"
        )
    if task.get("blockers"):
        return deny("task has unresolved blockers; ordinary writes are prohibited")
    if tool_name == "apply_patch":
        command = tool_input.get("command") if isinstance(tool_input, dict) else None
        try:
            targets = extract_apply_patch_paths(command)
            for raw_target in targets:
                relative, resolved = normalize_repo_path(repo_root, raw_target)
                resolved_relative = resolved.relative_to(repo_root.resolve()).as_posix()
                protected_reason = direct_governance_mutation_reason(resolved_relative)
                if protected_reason is None:
                    protected_reason = direct_governance_mutation_reason(relative)
                if protected_reason is not None:
                    return deny(f"protected governance path {relative!r}: {protected_reason}")
                if not path_is_allowed(relative, task["allowed_paths"]):
                    return deny(f"file target is outside task allowed scope: {relative}")
        except GovernanceError as exc:
            return deny(str(exc))
        return None

    if tool_name == "Bash":
        command = tool_input.get("command") if isinstance(tool_input, dict) else ""
        allowed_paths = task.get("allowed_paths", [])
        scope_reason = ordinary_bash_scope_reason(
            command,
            repo_root,
            cwd,
            allowed_paths,
        )
        if scope_reason is not None:
            return deny(scope_reason)
        if command_is_reviewed(command, task.get("allowed_commands", [])):
            return None
        if is_ordinary_development_bash(command, repo_root, cwd, allowed_paths):
            return None
        return deny(
            "Bash command is not a recognized reversible development command; "
            "use a controlled governance command for lifecycle or Git actions"
        )

    for relative in nonpatch_paths:
        if not path_is_allowed(relative, task["allowed_paths"]):
            return deny(f"tool path is outside task allowed scope: {relative}")
    if tool_is_reviewed(tool_name, task.get("allowed_tools", [])):
        return None
    return deny(
        f"tool {tool_name!r} is not a safe local read and is not listed in the "
        "optional task.allowed_tools risk boundary"
    )


def main() -> int:
    try:
        payload = load_stdin_object()
        result = evaluate(payload)
    except GovernanceError as exc:
        result = deny(str(exc))
    except Exception:
        result = deny("governance hook failed unexpectedly; refusing the tool call")
    if result is not None:
        emit_json(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
