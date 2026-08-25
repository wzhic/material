#!/usr/bin/env python3
"""Execute reviewed validation argv without trusting caller-reported outcomes.

This module deliberately does not persist task state.  It returns evidence for
``taskctl`` to validate and record atomically.  Commands are always executed as
an argv vector with ``shell=False`` and with a deliberately small environment.
"""

from __future__ import annotations

import hashlib
import math
import os
import platform
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from core import (
    PHASE_GATES,
    VALIDATION_PHASES,
    GovernanceError,
    canonical_json,
    canonical_scope_hash,
    current_task_id,
    managed_content_subject,
    read_json,
    task_path,
    utc_now,
    _git_candidates,
)


RUNNER_VERSION = "controlled-validation-runner-v1"
MAX_TIMEOUT_SECONDS = 3600.0
_PROTECTED_PATHS = (
    "project-control/current-task.json",
    "project-control/tasks",
    "project-control/reviews",
)
_ENV_ALLOWLIST = frozenset((
    "COMSPEC",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "SystemRoot",
    "TZ",
    "WINDIR",
))
_CI_CONTEXT_ENV_ALLOWLIST = frozenset((
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
))
_WORKING_GIT_DIRECTORY: Optional[str] = None


def _sha256_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def _sha256_json(value: Any) -> str:
    return _sha256_bytes(canonical_json(value).encode("utf-8"))


def _digest_part(digest: "hashlib._Hash", value: bytes) -> None:
    digest.update(len(value).to_bytes(8, "big"))
    digest.update(value)


def _protected_entries(root: Path) -> List[Tuple[str, str, int, bytes]]:
    """Read protected records as raw bytes without following symlinks."""

    root = root.resolve()
    entries: List[Tuple[str, str, int, bytes]] = []
    try:
        for relative_name in _PROTECTED_PATHS:
            target = root / relative_name
            if not target.exists() and not target.is_symlink():
                entries.append((relative_name, "missing", 0, b""))
                continue
            mode = os.lstat(str(target)).st_mode
            if stat.S_ISLNK(mode):
                entries.append((relative_name, "symlink", 0, os.readlink(str(target)).encode("utf-8")))
                continue
            if stat.S_ISREG(mode):
                entries.append((relative_name, "file", mode & 0o111, target.read_bytes()))
                continue
            if not stat.S_ISDIR(mode):
                entries.append((relative_name, "other", mode & 0o7777, b""))
                continue

            entries.append((relative_name, "directory", mode & 0o111, b""))
            for directory, directory_names, file_names in os.walk(
                str(target), topdown=True, followlinks=False
            ):
                directory_path = Path(directory)
                kept_directories: List[str] = []
                for name in sorted(directory_names):
                    candidate = directory_path / name
                    relative = candidate.relative_to(root).as_posix()
                    child_mode = os.lstat(str(candidate)).st_mode
                    if stat.S_ISLNK(child_mode):
                        entries.append((
                            relative,
                            "symlink",
                            0,
                            os.readlink(str(candidate)).encode("utf-8"),
                        ))
                    else:
                        entries.append((relative, "directory", child_mode & 0o111, b""))
                        kept_directories.append(name)
                directory_names[:] = kept_directories
                for name in sorted(file_names):
                    candidate = directory_path / name
                    relative = candidate.relative_to(root).as_posix()
                    child_mode = os.lstat(str(candidate)).st_mode
                    if stat.S_ISLNK(child_mode):
                        entries.append((
                            relative,
                            "symlink",
                            0,
                            os.readlink(str(candidate)).encode("utf-8"),
                        ))
                    elif stat.S_ISREG(child_mode):
                        entries.append((relative, "file", child_mode & 0o111, candidate.read_bytes()))
                    else:
                        entries.append((relative, "other", child_mode & 0o7777, b""))
    except OSError as exc:
        raise GovernanceError("cannot calculate protected state digest: %s" % exc) from exc
    return entries


def protected_state_digest(root: Path) -> str:
    """Bind task, review and current-task records including path and file kind."""

    digest = hashlib.sha256()
    for relative, kind, mode, content in sorted(_protected_entries(root), key=lambda item: item[0]):
        _digest_part(digest, relative.encode("utf-8"))
        _digest_part(digest, kind.encode("ascii"))
        digest.update(mode.to_bytes(4, "big"))
        _digest_part(digest, content)
    return "protected-state:sha256:" + digest.hexdigest()


def _validate_argv(value: Any) -> List[str]:
    if not isinstance(value, list) or not value:
        raise GovernanceError("validation check argv must be a non-empty array")
    if any(not isinstance(token, str) or not token or "\x00" in token for token in value):
        raise GovernanceError("validation check argv entries must be non-empty strings without NUL bytes")
    return list(value)


def _validate_timeout(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise GovernanceError("validation check timeout_seconds must be a number")
    timeout = float(value)
    if not math.isfinite(timeout) or timeout <= 0 or timeout > MAX_TIMEOUT_SECONDS:
        raise GovernanceError(
            "validation check timeout_seconds must be greater than zero and no more than %s"
            % int(MAX_TIMEOUT_SECONDS)
        )
    return timeout


def _validate_check(
    check: Mapping[str, Any],
    phase: str,
    task: Optional[Mapping[str, Any]] = None,
) -> Tuple[str, List[str], float, List[str]]:
    if phase not in VALIDATION_PHASES:
        raise GovernanceError("unknown validation phase: %s" % phase)
    if not isinstance(check, Mapping):
        raise GovernanceError("validation check must be an object")
    check_id = check.get("id")
    if not isinstance(check_id, str) or not check_id.strip():
        raise GovernanceError("validation check id must be a non-empty string")
    if "command" in check:
        raise GovernanceError("validation command strings are not executable; use an exact argv array")
    argv = _validate_argv(check.get("argv"))
    timeout = _validate_timeout(check.get("timeout_seconds"))
    gates = check.get("gates")
    phase_gate = PHASE_GATES[phase]
    repeats_local_plan = phase in ("ci", "post_merge") and (
        isinstance(gates, list) and "LOCAL_VERIFIED" in gates
    )
    if not isinstance(gates, list) or (phase_gate not in gates and not repeats_local_plan):
        raise GovernanceError("validation check %s is not required for phase %s" % (check_id, phase))
    release_units = check.get("release_units")
    task_units_value = task.get("release_units", []) if isinstance(task, Mapping) else []
    task_units = task_units_value if isinstance(task_units_value, list) else []
    if (
        not isinstance(release_units, list)
        or not release_units
        or any(not isinstance(unit, str) or not unit for unit in release_units)
        or len(set(release_units)) != len(release_units)
        or (task is not None and any(unit not in task_units for unit in release_units))
    ):
        raise GovernanceError(
            "validation check %s release_units must be unique affected task units" % check_id
        )
    return check_id, argv, timeout, list(release_units)


def _declared_checks(task: Mapping[str, Any]) -> List[Mapping[str, Any]]:
    validation = task.get("validation")
    required = validation.get("required") if isinstance(validation, Mapping) else None
    if not isinstance(required, list) or not required:
        raise GovernanceError("validation.required must contain at least one controlled check")
    if any(not isinstance(check, Mapping) for check in required):
        raise GovernanceError("validation.required entries must be objects")
    return list(required)


def required_checks(
    task: Mapping[str, Any],
    phase: str,
    release_unit: Optional[str] = None,
) -> List[Mapping[str, Any]]:
    """Return controlled checks for a phase, rejecting an empty plan.

    CI and post-merge runs repeat the local plan even when a new minimal task
    does not declare separate evidence gates for those environments.
    """

    if phase not in VALIDATION_PHASES:
        raise GovernanceError("unknown validation phase: %s" % phase)
    task_units = task.get("release_units", [])
    if not isinstance(task_units, list):
        raise GovernanceError("task release_units must be an array")
    if release_unit is not None and release_unit not in task_units:
        raise GovernanceError("unknown task release unit: %s" % release_unit)
    gate = PHASE_GATES[phase]
    selected = [
        check for check in _declared_checks(task)
        if isinstance(check.get("gates"), list)
        and (
            gate in check.get("gates", [])
            or (phase in ("ci", "post_merge") and "LOCAL_VERIFIED" in check.get("gates", []))
        )
        and (release_unit is None or release_unit in check.get("release_units", []))
    ]
    if not selected:
        suffix = " and release unit %s" % release_unit if release_unit is not None else ""
        raise GovernanceError("validation plan contains no checks for phase %s%s" % (phase, suffix))
    for check in selected:
        _validate_check(check, phase, task)
    return selected


def _disk_task(root: Path, task: Mapping[str, Any]) -> Dict[str, Any]:
    task_id = task.get("task_id")
    if not isinstance(task_id, str):
        raise GovernanceError("task_id must be present before validation")
    if current_task_id(root) != task_id:
        raise GovernanceError("controlled validation is limited to the current task")
    stored = read_json(task_path(root, task_id))
    if canonical_scope_hash(stored) != canonical_scope_hash(task):
        raise GovernanceError("in-memory task scope does not match protected task state")
    return stored


def _stored_check(task: Mapping[str, Any], check: Mapping[str, Any]) -> Mapping[str, Any]:
    check_id = check.get("id")
    matches = [item for item in _declared_checks(task) if item.get("id") == check_id]
    if len(matches) != 1 or canonical_json(matches[0]) != canonical_json(check):
        raise GovernanceError("validation check does not exactly match the protected reviewed plan")
    return matches[0]


def _minimal_environment(temporary_home: Path, phase: str) -> Dict[str, str]:
    """Build an allowlisted child environment with no inherited credentials."""

    if phase not in VALIDATION_PHASES:
        raise GovernanceError("unknown validation phase: %s" % phase)
    allowlist = set(_ENV_ALLOWLIST)
    if phase in ("ci", "post_merge"):
        # These values describe the GitHub event and runner; none is an
        # authentication capability.  All other GITHUB_*/ACTIONS_* values,
        # including tokens and command files, remain absent.
        allowlist.update(_CI_CONTEXT_ENV_ALLOWLIST)
    environment = {
        key: value
        for key, value in os.environ.items()
        if key in allowlist and isinstance(value, str)
    }
    home_value = str(temporary_home.resolve())
    environment.update({
        "HOME": home_value,
        "USERPROFILE": home_value,
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONNOUSERSITE": "1",
    })
    if os.name == "nt":
        # PowerShell derives its module-analysis cache from LOCALAPPDATA.  If
        # that variable is absent it can resolve the fallback relative to the
        # validation cwd and dirty the repository.  Keep all Windows profile
        # and temporary artifacts inside the runner-owned, short-lived home.
        roaming = temporary_home / "AppData" / "Roaming"
        local = temporary_home / "AppData" / "Local"
        temporary = temporary_home / "Temp"
        powershell_cache = temporary_home / "PowerShell" / "ModuleAnalysisCache"
        for directory in (roaming, local, temporary, powershell_cache.parent):
            directory.mkdir(parents=True, exist_ok=True)
        environment.update({
            "APPDATA": str(roaming.resolve()),
            "LOCALAPPDATA": str(local.resolve()),
            "TEMP": str(temporary.resolve()),
            "TMP": str(temporary.resolve()),
            "PSModuleAnalysisCachePath": str(powershell_cache.resolve()),
        })
    environment["PATH"] = _working_git_directory() + os.pathsep + environment.get("PATH", "")
    return environment


def _working_git_directory() -> str:
    """Return the first Git installation that can initialize a repository."""

    global _WORKING_GIT_DIRECTORY
    if _WORKING_GIT_DIRECTORY is not None:
        return _WORKING_GIT_DIRECTORY
    errors: List[str] = []
    for candidate in _git_candidates():
        try:
            with tempfile.TemporaryDirectory(prefix="material-validation-git-probe-") as temporary:
                completed = subprocess.run(
                    [candidate, "init", "--quiet", temporary],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                    text=True,
                    timeout=10,
                    check=False,
                )
        except (OSError, subprocess.TimeoutExpired) as exc:
            errors.append("%s: %s" % (candidate, type(exc).__name__))
            continue
        if completed.returncode == 0:
            _WORKING_GIT_DIRECTORY = str(Path(candidate).resolve().parent)
            return _WORKING_GIT_DIRECTORY
        errors.append(completed.stderr.strip() or "%s exited %s" % (candidate, completed.returncode))
    raise GovernanceError("controlled validation requires a working Git executable: %s" % "; ".join(errors))


def _resolve_argv(argv: Sequence[str]) -> List[str]:
    resolved = list(argv)
    if resolved[0] == "python3":
        resolved[0] = str(Path(sys.executable).resolve())
    elif os.name == "nt":
        executable = shutil.which(resolved[0])
        if executable:
            resolved[0] = executable
    return resolved


def _stream_summary(handle: Any) -> Dict[str, Any]:
    handle.seek(0)
    digest = hashlib.sha256()
    byte_count = 0
    while True:
        chunk = handle.read(1024 * 1024)
        if not chunk:
            break
        byte_count += len(chunk)
        digest.update(chunk)
    return {"sha256": digest.hexdigest(), "byte_count": byte_count}


def _post_run_integrity(
    root: Path,
    start_task: Mapping[str, Any],
    scope_before: str,
    subject_before: str,
    protected_before: str,
) -> Dict[str, Any]:
    issues: List[str] = []
    scope_after: Optional[str]
    subject_after: Optional[str]
    protected_after: Optional[str]
    try:
        stored_after = read_json(task_path(root, str(start_task["task_id"])))
        scope_after = canonical_scope_hash(stored_after)
    except (GovernanceError, OSError, KeyError, TypeError, ValueError):
        scope_after = None
        issues.append("scope_snapshot_unavailable")
    try:
        # Use the original allowed-path universe so a task-file mutation cannot
        # hide changed managed content by narrowing the scope after execution.
        subject_after = managed_content_subject(root, start_task)
    except (GovernanceError, OSError):
        subject_after = None
        issues.append("content_snapshot_unavailable")
    try:
        protected_after = protected_state_digest(root)
    except (GovernanceError, OSError):
        protected_after = None
        issues.append("protected_state_snapshot_unavailable")

    if scope_after is not None and scope_after != scope_before:
        issues.append("scope_changed")
    if subject_after is not None and subject_after != subject_before:
        issues.append("managed_content_changed")
    if protected_after is not None and protected_after != protected_before:
        issues.append("protected_state_changed")
    return {
        "scope_hash_before": scope_before,
        "scope_hash_after": scope_after,
        "managed_content_subject_before": subject_before,
        "managed_content_subject_after": subject_after,
        "protected_state_digest_before": protected_before,
        "protected_state_digest_after": protected_after,
        "unchanged": not issues,
        "issues": issues,
    }


def run_one(
    root: Path,
    task: Mapping[str, Any],
    check: Mapping[str, Any],
    phase: str,
    environment: Optional[str] = None,
    release_unit: Optional[str] = None,
) -> Dict[str, Any]:
    """Run one exact reviewed argv and return derived, output-redacted evidence."""

    root = root.resolve()
    stored_task = _disk_task(root, task)
    stored_check = _stored_check(stored_task, check)
    check_id, declared_argv, timeout_seconds, release_units = _validate_check(
        stored_check, phase, stored_task
    )
    if release_unit is not None and release_unit not in release_units:
        raise GovernanceError(
            "validation check %s is not approved for release unit %s" % (check_id, release_unit)
        )
    executed_argv = _resolve_argv(declared_argv)

    scope_before = canonical_scope_hash(stored_task)
    subject_before = managed_content_subject(root, stored_task)
    protected_before = protected_state_digest(root)
    started_at = utc_now()
    monotonic_start = time.monotonic()
    timed_out = False
    exit_code: Optional[int] = None
    launch_error: Optional[str] = None

    with tempfile.TemporaryDirectory(prefix="material-validation-home-") as home_name:
        with tempfile.TemporaryFile() as stdout_handle, tempfile.TemporaryFile() as stderr_handle:
            try:
                process = subprocess.Popen(
                    executed_argv,
                    cwd=str(root),
                    env=_minimal_environment(Path(home_name), phase),
                    stdin=subprocess.DEVNULL,
                    stdout=stdout_handle,
                    stderr=stderr_handle,
                    shell=False,
                )
                try:
                    exit_code = process.wait(timeout=timeout_seconds)
                except subprocess.TimeoutExpired:
                    timed_out = True
                    process.kill()
                    process.wait()
            except OSError as exc:
                # Do not persist platform-specific paths or command output from
                # the exception; the exception class is enough to diagnose the
                # fail-closed launch result outside persisted evidence.
                launch_error = type(exc).__name__
            stdout_summary = _stream_summary(stdout_handle)
            stderr_summary = _stream_summary(stderr_handle)

    finished_at = utc_now()
    integrity = _post_run_integrity(
        root,
        stored_task,
        scope_before,
        subject_before,
        protected_before,
    )
    if integrity["issues"]:
        status = "failed"
    elif launch_error is not None:
        status = "blocked"
    elif timed_out or exit_code != 0:
        status = "failed"
    else:
        status = "passed"

    duration_ms = max(0, int(round((time.monotonic() - monotonic_start) * 1000)))
    environment_label = environment or "controlled-%s" % phase.replace("_", "-")
    return {
        "runner_version": RUNNER_VERSION,
        "check_id": check_id,
        "release_units": release_units,
        "release_unit": release_unit,
        "phase": phase,
        "status": status,
        "subject": subject_before,
        "scope_hash": scope_before,
        "environment": environment_label,
        "declared_argv": declared_argv,
        "executed_argv": executed_argv,
        "argv_sha256": _sha256_json(declared_argv),
        "plan_sha256": _sha256_json({
            "argv": declared_argv,
            "timeout_seconds": timeout_seconds,
        }),
        "timeout_seconds": timeout_seconds,
        "timed_out": timed_out,
        "exit_code": exit_code,
        "launch_error": launch_error,
        "stdout": stdout_summary,
        "stderr": stderr_summary,
        "integrity": integrity,
        "platform": {
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
        },
        "python": {
            "implementation": platform.python_implementation(),
            "version": platform.python_version(),
            "executable": str(Path(sys.executable).resolve()),
        },
        "started_at": started_at,
        "finished_at": finished_at,
        "duration_ms": duration_ms,
        "actor": "controlled-validation-runner",
        "evidence": "%s derived status from process execution" % RUNNER_VERSION,
        "recorded_at": finished_at,
    }


def run_required(
    root: Path,
    task: Mapping[str, Any],
    phase: str,
    environment: Optional[str] = None,
    release_unit: Optional[str] = None,
) -> Dict[str, Any]:
    """Run every required check for a phase and return a fail-closed batch."""

    root = root.resolve()
    checks = required_checks(task, phase, release_unit=release_unit)
    stored_task = _disk_task(root, task)
    anchor = {
        "scope_hash": canonical_scope_hash(stored_task),
        "managed_content_subject": managed_content_subject(root, stored_task),
        "protected_state_digest": protected_state_digest(root),
    }
    started_at = utc_now()
    results: List[Dict[str, Any]] = []
    not_run: List[str] = []
    for index, check in enumerate(checks):
        result = run_one(
            root,
            stored_task,
            check,
            phase,
            environment=environment,
            release_unit=release_unit,
        )
        before = result["integrity"]
        anchor_changed = (
            before["scope_hash_before"] != anchor["scope_hash"]
            or before["managed_content_subject_before"] != anchor["managed_content_subject"]
            or before["protected_state_digest_before"] != anchor["protected_state_digest"]
        )
        if anchor_changed:
            result["integrity"]["issues"].append("batch_anchor_changed_before_check")
            result["integrity"]["unchanged"] = False
            result["status"] = "failed"
        results.append(result)
        if not result["integrity"]["unchanged"]:
            # Continuing after a command changes reviewed content or protected
            # state would execute a plan whose trust anchor no longer matches.
            not_run = [str(item.get("id", "")) for item in checks[index + 1:]]
            break

    finished_at = utc_now()
    passed = len(results) == len(checks) and all(item["status"] == "passed" for item in results)
    return {
        "runner_version": RUNNER_VERSION,
        "task_id": stored_task.get("task_id"),
        "phase": phase,
        "release_unit": release_unit,
        "status": "passed" if passed else "failed",
        "environment": environment or "controlled-%s" % phase.replace("_", "-"),
        "anchor": anchor,
        "planned_check_count": len(checks),
        "executed_check_count": len(results),
        "results": results,
        "not_run": not_run,
        "started_at": started_at,
        "finished_at": finished_at,
    }
