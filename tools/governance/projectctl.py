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

from core import GovernanceError, current_branch, default_root, load_current_task, path_is_allowed


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

    return (".git", ".venv", "__pycache__", "node_modules", "out")


def _require_programs() -> Dict[str, str]:
    resolved: Dict[str, str] = {}
    for name in ("node", "npm", "uv"):
        executable = shutil.which(name)
        if executable is None:
            raise GovernanceError("required generator runtime is unavailable: %s" % name)
        resolved[name] = executable
    return resolved


def _preflight(root: Path) -> Mapping[str, object]:
    task = load_current_task(root)
    if task.get("status") != "IN_PROGRESS":
        raise GovernanceError("project init requires the current task to be IN_PROGRESS")
    branch, branch_error = current_branch(root)
    if branch_error or branch != task.get("branch"):
        raise GovernanceError(
            "project init branch mismatch: expected %s, found %s"
            % (task.get("branch"), branch or branch_error)
        )
    for target in (CLIENT_TARGET, BACKEND_TARGET):
        if not path_is_allowed(root, target, task.get("allowed_paths", [])):
            raise GovernanceError("project init target is outside current task scope: %s" % target)
        if (root / target).exists():
            raise GovernanceError("project init refuses to overwrite existing target: %s" % target)
    _require_programs()
    return task


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
    task = _preflight(root)
    environment = os.environ.copy()
    environment.update({
        "CI": "1",
        "npm_config_yes": "true",
        "PYTHONDONTWRITEBYTECODE": "1",
    })
    with tempfile.TemporaryDirectory(prefix="material-official-scaffold-") as temporary:
        staging = Path(temporary)
        commands = generator_commands()
        _run(commands[0], staging, environment)
        _run(commands[1], staging, environment)
        _run(commands[2], staging, environment)

        # Validate generated output before it enters the repository.
        _run(("npm", "run", "lint"), staging / "desktop", environment)
        _run(("npm", "run", "package"), staging / "desktop", environment)
        _run(
            ("uv", "run", "--project", "backend", "python", "-c", "import fastapi"),
            staging,
            environment,
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

    return {
        "ok": True,
        "task_id": task.get("task_id"),
        "generated": [CLIENT_TARGET, BACKEND_TARGET],
        "client_generator": "Electron Forge webpack-typescript",
        "backend_generator": "uv app + FastAPI",
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
