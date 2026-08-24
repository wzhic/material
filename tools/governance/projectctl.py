#!/usr/bin/env python3
"""One-command application bootstrap using official project generators."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from typing import Dict, List, Mapping, Sequence, Tuple

from core import (
    GovernanceError,
    _git_candidates,
    current_branch,
    default_root,
    load_current_task,
    path_is_allowed,
)


CLIENT_TARGET = "apps/desktop"
BACKEND_TARGET = "apps/backend"


def generator_commands() -> Tuple[Tuple[str, ...], ...]:
    """Return exact non-shell commands; generators own all dependency files."""

    return (
        (
            "npm", "init", "electron-app@latest", "desktop", "--",
            "--template=webpack-typescript",
        ),
        ("uv", "init", "--app", "--python", "3.12", "backend"),
        ("uv", "add", "--project", "backend", "fastapi", "uvicorn[standard]"),
    )


def scaffold_ignore_names() -> Tuple[str, ...]:
    """Generated caches and nested VCS metadata never enter the repository."""

    return (
        ".git", ".venv", "__pycache__", "node_modules", "out",
        ".electron-cache", ".npm-cache",
    )


def _configure_desktop_scaffold(desktop: Path) -> None:
    """Keep Electron downloads in an ignored project cache for controlled builds."""

    forge_config = desktop / "forge.config.ts"
    ignore_file = desktop / ".gitignore"
    try:
        config = forge_config.read_text(encoding="utf-8")
        ignored = ignore_file.read_text(encoding="utf-8")
    except OSError as exc:
        raise GovernanceError("generated Electron Forge files are incomplete: %s" % exc) from exc

    cache_setting = "    download: { cacheRoot: `${__dirname}/.electron-cache` },\n"
    if cache_setting not in config:
        marker = "  packagerConfig: {\n    asar: true,\n"
        if marker not in config:
            raise GovernanceError("generated Electron Forge packagerConfig format is unsupported")
        config = config.replace(marker, marker + cache_setting, 1)
        forge_config.write_text(config, encoding="utf-8")

    ignored_lines = ignored.splitlines()
    missing_ignores = [name for name in (".electron-cache", ".npm-cache") if name not in ignored_lines]
    if missing_ignores:
        suffix = "" if ignored.endswith("\n") or not ignored else "\n"
        ignore_file.write_text(
            ignored + suffix + "".join(name + "\n" for name in missing_ignores),
            encoding="utf-8",
        )


def _require_programs() -> Dict[str, str]:
    resolved: Dict[str, str] = {}
    for name in ("node", "npm", "uv"):
        executable = shutil.which(name)
        if executable is None:
            raise GovernanceError("required generator runtime is unavailable: %s" % name)
        resolved[name] = executable
    return resolved


def _working_git_directory() -> Path:
    """Find a Git executable that can initialize a repository on this host."""

    errors: List[str] = []
    for candidate in _git_candidates():
        with tempfile.TemporaryDirectory(prefix="material-git-probe-") as temporary:
            completed = subprocess.run(
                [candidate, "init", "--quiet", temporary],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
                check=False,
            )
        if completed.returncode == 0:
            return Path(candidate).resolve().parent
        errors.append(completed.stderr.strip() or "%s exited %s" % (candidate, completed.returncode))
    raise GovernanceError("no Git executable can initialize the official scaffold: %s" % "; ".join(errors))


def _preflight(root: Path) -> Tuple[Mapping[str, object], bool]:
    task = load_current_task(root)
    if task.get("status") != "IN_PROGRESS":
        raise GovernanceError("project init requires the current task to be IN_PROGRESS")
    branch, branch_error = current_branch(root)
    if branch_error or branch != task.get("branch"):
        raise GovernanceError(
            "project init branch mismatch: expected %s, found %s"
            % (task.get("branch"), branch or branch_error)
        )
    existing = []
    for target in (CLIENT_TARGET, BACKEND_TARGET):
        if not path_is_allowed(root, target, task.get("allowed_paths", [])):
            raise GovernanceError("project init target is outside current task scope: %s" % target)
        existing.append((root / target).exists())
    if any(existing) and not all(existing):
        raise GovernanceError("project init found partial targets and refuses to overwrite them")
    if all(existing):
        required_generated_files = (
            root / CLIENT_TARGET / "package-lock.json",
            root / BACKEND_TARGET / "uv.lock",
        )
        if not all(path.is_file() for path in required_generated_files):
            raise GovernanceError("existing targets are not recognized generated projects")
    _require_programs()
    return task, all(existing)


def _run(command: Sequence[str], cwd: Path, environment: Mapping[str, str]) -> None:
    completed = subprocess.run(
        list(command),
        cwd=str(cwd),
        env=dict(environment),
        stdin=subprocess.DEVNULL,
        check=False,
    )
    if completed.returncode != 0:
        raise GovernanceError(
            "official generator or verification failed (%s): %s"
            % (completed.returncode, " ".join(command))
        )


def initialize(root: Path) -> Dict[str, object]:
    task, resume = _preflight(root)
    environment = os.environ.copy()
    environment.update({
        "CI": "1",
        "npm_config_yes": "true",
        "PYTHONDONTWRITEBYTECODE": "1",
    })
    environment["PATH"] = str(_working_git_directory()) + os.pathsep + environment.get("PATH", "")
    if not resume:
        with tempfile.TemporaryDirectory(prefix="material-official-scaffold-") as temporary:
            staging = Path(temporary)
            staging_environment = dict(environment)
            staging_environment["npm_config_cache"] = str(staging / ".npm-cache")
            commands = generator_commands()
            _run(commands[0], staging, staging_environment)
            _run(commands[1], staging, staging_environment)
            _run(commands[2], staging, staging_environment)
            _configure_desktop_scaffold(staging / "desktop")

            # Validate generated output before it enters the repository.
            _run(("npm", "run", "lint"), staging / "desktop", staging_environment)
            _run(("npm", "run", "package"), staging / "desktop", staging_environment)
            _run(
                ("uv", "run", "--project", "backend", "python", "-c", "import fastapi"),
                staging,
                staging_environment,
            )

            apps = root / "apps"
            apps.mkdir(parents=True, exist_ok=True)
            try:
                ignore = shutil.ignore_patterns(*scaffold_ignore_names())
                shutil.copytree(staging / "desktop", root / CLIENT_TARGET, ignore=ignore)
                shutil.copytree(staging / "backend", root / BACKEND_TARGET, ignore=ignore)
            except Exception:
                shutil.rmtree(root / CLIENT_TARGET, ignore_errors=True)
                shutil.rmtree(root / BACKEND_TARGET, ignore_errors=True)
                raise

    _configure_desktop_scaffold(root / CLIENT_TARGET)
    environment["npm_config_cache"] = str((root / CLIENT_TARGET / ".npm-cache").resolve())

    # Install from generated lockfiles in the working tree. These caches remain
    # ignored and are never committed, but the checkout is immediately runnable.
    _run(("npm", "ci"), root / CLIENT_TARGET, environment)
    _run(
        ("npm", "audit", "--omit=dev", "--audit-level=high"),
        root / CLIENT_TARGET,
        environment,
    )
    _run(("uv", "sync", "--project", BACKEND_TARGET), root, environment)
    _run(("npm", "run", "lint"), root / CLIENT_TARGET, environment)
    _run(("npm", "run", "package"), root / CLIENT_TARGET, environment)
    _run(
        ("uv", "run", "--project", BACKEND_TARGET, "python", "-c", "import fastapi"),
        root,
        environment,
    )

    return {
        "ok": True,
        "task_id": task.get("task_id"),
        "generated": [CLIENT_TARGET, BACKEND_TARGET],
        "client_generator": "Electron Forge webpack-typescript",
        "backend_generator": "uv app + FastAPI",
        "resumed": resume,
        "message": "official scaffolds, dependencies and generated-project checks completed",
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="projectctl")
    subparsers = parser.add_subparsers(dest="command", required=True)
    init = subparsers.add_parser("init", help="generate desktop and backend projects")
    init.add_argument("--root", type=Path, default=default_root())
    init.add_argument("--json", action="store_true")
    return parser


def main(argv: List[str] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = initialize(args.root.resolve())
        print(json.dumps(result, ensure_ascii=False, sort_keys=True) if args.json else result["message"])
        return 0
    except (GovernanceError, OSError) as exc:
        payload = {"ok": False, "error": str(exc)}
        print(json.dumps(payload, ensure_ascii=False, sort_keys=True) if args.json else "ERROR: %s" % exc, file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
