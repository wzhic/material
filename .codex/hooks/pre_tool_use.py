#!/usr/bin/env python3
"""Codex PreToolUse gate for reviewed task scope."""

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
    is_strict_readonly_bash,
    load_snapshot,
    load_stdin_object,
    normalize_repo_path,
    nonpatch_tool_paths,
    ORDINARY_WRITE_STATE,
    path_is_allowed,
    prohibited_bash_reason,
    direct_governance_mutation_reason,
    repo_root_from_payload,
    safe_local_read_tool,
    tool_is_reviewed,
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


def evaluate(payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if payload.get("hook_event_name") != "PreToolUse":
        return deny("governance hook received the wrong event type")
    tool_name = payload.get("tool_name")
    if not isinstance(tool_name, str) or not tool_name:
        return deny("tool call is missing a canonical tool_name")
    tool_name = _policy_tool_name(tool_name)
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
    if status != ORDINARY_WRITE_STATE:
        return deny(
            "ordinary writes require task status IN_PROGRESS; "
            f"current status is {status!r}"
        )
    if task.get("blockers"):
        return deny("task has unresolved blockers; ordinary writes are prohibited")
    if snapshot.review is None:
        return deny(
            "work has no effective user review: "
            + str(snapshot.review_reason or "no effective review receipt")
        )

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
                    return deny(f"file target is outside reviewed scope: {relative}")
        except GovernanceError as exc:
            return deny(str(exc))
        return None

    if tool_name == "Bash":
        command = tool_input.get("command") if isinstance(tool_input, dict) else ""
        if command_is_reviewed(command, task["allowed_commands"]):
            return None
        return deny("Bash command is not read-only and is not in task.allowed_commands")

    for relative in nonpatch_paths:
        if not path_is_allowed(relative, task["allowed_paths"]):
            return deny(f"tool path is outside reviewed scope: {relative}")
    if tool_is_reviewed(tool_name, task["allowed_tools"]):
        return None
    return deny(f"tool {tool_name!r} is not a safe local read and is not in task.allowed_tools")


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
