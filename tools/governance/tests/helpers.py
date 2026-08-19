from __future__ import annotations

import base64
import hashlib
import json
import unittest
from pathlib import Path
from typing import Any, Dict, Iterable, Optional
from unittest import mock


class AuthenticatedReceiptTestCase(unittest.TestCase):
    """Exercise post-authenticity receipt semantics with an explicit mock."""

    def setUp(self) -> None:
        super().setUp()
        patcher = mock.patch(
            "core.review_authenticity",
            return_value=(True, "authenticated test fixture"),
        )
        patcher.start()
        self.addCleanup(patcher.stop)


def write_json(path: Path, value: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def test_review_authority() -> Dict[str, str]:
    """Return a deterministic public-only trust anchor for isolated tests."""

    key_type = b"ssh-ed25519"
    material = b"T" * 32
    blob = (
        len(key_type).to_bytes(4, byteorder="big")
        + key_type
        + len(material).to_bytes(4, byteorder="big")
        + material
    )
    encoded = base64.b64encode(blob).decode("ascii")
    fingerprint = base64.b64encode(hashlib.sha256(blob).digest()).decode("ascii").rstrip("=")
    return {
        "scheme": "ssh-keygen-y-v1",
        "identity": "material-project-owner",
        "namespace": "material-governance-review",
        "public_key": "ssh-ed25519 " + encoded,
        "key_fingerprint": "SHA256:" + fingerprint,
    }


def base_task(status: str = "IN_PROGRESS") -> Dict[str, Any]:
    return {
        "schema_version": 1,
        "task_id": "GOV-TEST",
        "status": status,
        "scope_version": 1,
        "requirement": {
            "id": "REQ-TEST",
            "version": "v1.0",
            "name": "治理测试",
            "interaction_kind": "non_ui",
        },
        "summary": "isolated governance test",
        "release_units": ["mac", "win", "backend"],
        "branch": "codex/req-test-gov-test",
        "base_branch": "main",
        "allowed_paths": ["tools/governance/**", "docs/**"],
        "allowed_commands": ["python3 -m unittest discover"],
        "allowed_tools": ["Bash", "apply_patch", "Read"],
        "dependencies": [],
        "required_docs": ["docs/governance/test.md"],
        "validation": {
            "required": [
                {
                    "id": "unit",
                    "argv": ["python3", "-c", "raise SystemExit(0)"],
                    "timeout_seconds": 60,
                    "gates": ["LOCAL_VERIFIED", "CI_VERIFIED", "POST_MERGE_VERIFIED"],
                    "release_units": ["mac", "win", "backend"],
                }
            ],
            "results": [],
        },
        "assumptions": [{"id": "A-1", "statement": "test", "status": "confirmed"}],
        "open_questions": [],
        "blockers": [],
        "review_authority": test_review_authority(),
        "ci_trust": {
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
        },
        "coordination": {
            "mode": "coordinated-multi",
            "coordinator_task": "GOV-TEST",
            "unit_tasks": {"mac": "GOV-TEST", "win": "GOV-TEST", "backend": "GOV-TEST"},
            "compatibility_matrix_doc": "docs/governance/test.md",
            "deployment_order": ["backend", "mac", "win"],
            "rollback_order": ["mac", "win", "backend"],
            "unit_validation_checks": {
                "mac": ["unit"], "win": ["unit"], "backend": ["unit"],
            },
            "unit_rollback_checks": {
                "mac": ["unit"], "win": ["unit"], "backend": ["unit"],
            },
        },
        "history": [],
    }


def initialize_root(root: Path, task: Optional[Dict[str, Any]] = None, approved: bool = True) -> Dict[str, Any]:
    from core import canonical_scope_hash

    selected = task or base_task()
    (root / ".git").mkdir(parents=True, exist_ok=True)
    (root / ".git" / "HEAD").write_text("ref: refs/heads/%s\n" % selected["branch"], encoding="utf-8")
    write_json(root / "project-control" / "project.json", {
        "schema_version": 1,
        "scale": "M",
        "topology": "multi",
        "release_units": [{"id": "mac"}, {"id": "win"}, {"id": "backend"}],
        "review_policy": {
            "approvers": ["user"],
            "agent_may_approve": False,
            "skip_requires_user_receipt": True,
            "scope_change_invalidates_approval": True,
            "approval_mode": "conversation-v1",
            "cryptographic_identity_proof": False,
            "requires_explicit_user_message": True,
            "migration_receipt_id": "GOV-0001-R003",
            "migration_payload_sha256": (
                "sha256:80b72baede7e7e81c06e095d9e88ea87209d764a2e8977b7b85b85fc850e8b15"
            ),
        },
        "branch_policy": {"bootstrap_main_tasks": ["GOV-0001"]},
    })
    write_json(root / "project-control" / "current-task.json", {"task_id": selected["task_id"]})
    write_json(root / "project-control" / "tasks" / (selected["task_id"] + ".json"), selected)
    write_json(root / "project-control" / "releases" / "release-units.json", {
        "schema_version": 1,
        "topology": "multi",
        "units": [
            {"id": "mac"},
            {"id": "win"},
            {"id": "backend"},
        ],
    })
    if approved:
        write_json(root / "project-control" / "reviews" / "REV-TEST.json", {
            "schema_version": 1,
            "review_id": "REV-TEST",
            "task_id": selected["task_id"],
            "kind": "scope",
            "decision": "approved",
            "approver": "user",
            "scope_version": selected["scope_version"],
            "scope_hash": canonical_scope_hash(selected),
            "decided_at": "2026-08-18T00:00:00+00:00",
            "expires_at": None,
        })
    for document in selected.get("required_docs", []):
        path = root / document
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("test\n", encoding="utf-8")
    return selected


def valid_local_pass(
    root: Path,
    task: Dict[str, Any],
    check_id: str = "unit",
    release_unit: Optional[str] = None,
) -> Dict[str, Any]:
    """Execute one reviewed check and return its derived local PASS evidence."""

    from validation_runner import RUNNER_VERSION, run_one

    matching = [
        check for check in task["validation"]["required"]
        if check.get("id") == check_id
    ]
    if len(matching) != 1:
        raise AssertionError("test fixture must declare the check exactly once")
    result = run_one(
        root,
        task,
        matching[0],
        "local",
        environment="controlled-local",
        release_unit=release_unit,
    )
    if result.get("status") != "passed":
        raise AssertionError("test fixture command did not pass: %r" % result)
    result["source"] = RUNNER_VERSION
    return result


def valid_github_pass(
    task: Dict[str, Any],
    phase: str,
    content_sha: str,
    control_sha: str,
    *,
    event: Optional[str] = None,
    run_id: str = "12345",
    run_attempt: int = 1,
) -> Dict[str, Any]:
    """Build cached evidence shaped like a previously REST-verified GitHub run.

    Online-verification behavior is exercised separately with a mocked REST
    boundary.  This helper only keeps lifecycle tests focused on consumption of
    a complete, immutable verifier result.
    """

    selected_event = event or ("pull_request" if phase == "ci" else "push")
    trust = task["ci_trust"]
    required_jobs = list(trust["required_jobs"][selected_event])
    branch = task["branch"] if phase == "ci" else task["base_branch"]
    timestamp = "2026-08-19T00:00:00+00:00"
    run_url = "https://github.com/wzhic/material/actions/runs/%s" % run_id
    github = {
        "provider": "github_actions_rest_v1",
        "repository": "wzhic/material",
        "workflow_path": ".github/workflows/governance.yml",
        "workflow_id": 77,
        "run_id": run_id,
        "run_attempt": run_attempt,
        "event": selected_event,
        "head_sha": control_sha,
        "head_branch": branch,
        "status": "completed",
        "conclusion": "success",
        "run_url": run_url,
        "job_names": sorted(required_jobs),
        "required_job_names": sorted(required_jobs),
        "api_version": "2026-03-10",
        "verified_at": timestamp,
        "content_subject_sha": content_sha,
        "control_head_sha": control_sha,
    }
    return {
        "check_id": "unit",
        "status": "passed",
        "phase": phase,
        "subject": "commit:" + content_sha,
        "environment": "github-actions:%s:attempt-%s" % (selected_event, run_attempt),
        "source": "github_actions_rest_v1",
        "evidence": "GitHub REST verified fixture",
        "actor": "github-actions-rest-sync",
        "recorded_at": timestamp,
        "run_id": run_id,
        "run_url": run_url,
        "github": github,
    }
