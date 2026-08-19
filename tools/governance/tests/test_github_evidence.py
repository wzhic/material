from __future__ import annotations

import sys
import unittest
from pathlib import Path
from typing import Any, Dict, Mapping


GOVERNANCE_DIR = Path(__file__).resolve().parents[1]
if str(GOVERNANCE_DIR) not in sys.path:
    sys.path.insert(0, str(GOVERNANCE_DIR))

from github_evidence import GitHubEvidenceError, verify_workflow_run  # noqa: E402


SHA = "a" * 40
RUN_ID = "12345"
ATTEMPT = 2
TRUST = {
    "provider": "github_actions_rest_v1",
    "repository": "wzhic/material",
    "workflow_path": ".github/workflows/governance.yml",
    "api_base": "https://api.github.com",
    "api_version": "2026-03-10",
    "private": True,
    "token_env": "MATERIAL_GITHUB_ACTIONS_READ_TOKEN",
}


class FixtureClient:
    def __init__(self) -> None:
        self.calls = []
        self.run: Dict[str, Any] = {
            "id": 12345,
            "run_attempt": ATTEMPT,
            "path": ".github/workflows/governance.yml@main",
            "status": "completed",
            "conclusion": "success",
            "event": "pull_request",
            "head_sha": SHA,
            "head_branch": "codex/req-1-task-1-feature",
            "html_url": "https://github.com/wzhic/material/actions/runs/12345/attempts/2",
            "workflow_id": 77,
            "repository": {"full_name": "wzhic/material"},
        }
        self.jobs: Dict[str, Any] = {
            "total_count": 3,
            "jobs": [
                self._job("Governance (ubuntu-latest)"),
                self._job("Governance (macos-latest)"),
                self._job("Governance (windows-latest)"),
            ],
        }

    @staticmethod
    def _job(name: str) -> Dict[str, Any]:
        return {
            "name": name,
            "run_id": 12345,
            "head_sha": SHA,
            "status": "completed",
            "conclusion": "success",
        }

    def __call__(self, url: str, headers: Mapping[str, str], timeout: float) -> Mapping[str, Any]:
        self.calls.append((url, dict(headers), timeout))
        if url.endswith("/jobs?per_page=100"):
            return self.jobs
        return self.run


def verify(client: FixtureClient, **overrides: Any) -> Dict[str, Any]:
    arguments = {
        "run_id": RUN_ID,
        "run_attempt": ATTEMPT,
        "expected_event": "pull_request",
        "expected_head_sha": SHA,
        "expected_head_branch": "codex/req-1-task-1-feature",
        "expected_job_names": [
            "Governance (ubuntu-latest)",
            "Governance (macos-latest)",
            "Governance (windows-latest)",
        ],
        "token": "read-only-secret",
        "fetch_json": client,
        "verified_at": "2026-08-19T00:00:00+00:00",
    }
    arguments.update(overrides)
    return verify_workflow_run(TRUST, **arguments)


class GitHubEvidenceTests(unittest.TestCase):
    def test_verified_evidence_is_derived_and_never_contains_token(self) -> None:
        client = FixtureClient()
        result = verify(client)
        self.assertEqual("github_actions_rest_v1", result["provider"])
        self.assertEqual(RUN_ID, result["run_id"])
        self.assertEqual(ATTEMPT, result["run_attempt"])
        self.assertEqual("success", result["conclusion"])
        self.assertNotIn("token", result)
        self.assertNotIn("read-only-secret", repr(result))
        self.assertEqual(2, len(client.calls))
        for _url, headers, _timeout in client.calls:
            self.assertEqual("Bearer read-only-secret", headers["Authorization"])
            self.assertEqual("2026-03-10", headers["X-GitHub-Api-Version"])

    def test_private_repository_requires_external_credential(self) -> None:
        with self.assertRaisesRegex(GitHubEvidenceError, "credential"):
            verify(FixtureClient(), token="")

    def test_wrong_trust_anchor_fails_before_network(self) -> None:
        client = FixtureClient()
        for change in (
            {"repository": "attacker/material"},
            {"workflow_path": "../evil.yml"},
            {"api_base": "https://example.invalid"},
            {"api_version": "2022-11-28"},
            {"private": False},
        ):
            trust = dict(TRUST)
            trust.update(change)
            with self.subTest(change=change), self.assertRaises(GitHubEvidenceError):
                verify_workflow_run(
                    trust,
                    run_id=RUN_ID,
                    run_attempt=ATTEMPT,
                    expected_event="pull_request",
                    expected_head_sha=SHA,
                    expected_head_branch="codex/req-1-task-1-feature",
                    expected_job_names=["Governance (ubuntu-latest)"],
                    token="secret",
                    fetch_json=client,
                )
        self.assertEqual([], client.calls)

    def test_run_identity_and_success_fields_are_all_required(self) -> None:
        mutations = (
            ("repository", {"full_name": "other/repo"}),
            ("id", 999),
            ("run_attempt", 1),
            ("path", ".github/workflows/evil.yml@main"),
            ("status", "in_progress"),
            ("conclusion", "failure"),
            ("event", "push"),
            ("head_sha", "b" * 40),
            ("head_branch", "main"),
            ("html_url", "https://github.com/other/repo/actions/runs/12345"),
        )
        for field, value in mutations:
            client = FixtureClient()
            client.run[field] = value
            with self.subTest(field=field), self.assertRaises(GitHubEvidenceError):
                verify(client)

    def test_jobs_must_be_complete_successful_and_cover_each_platform(self) -> None:
        client = FixtureClient()
        client.jobs["jobs"][2]["conclusion"] = "failure"
        with self.assertRaisesRegex(GitHubEvidenceError, "not completed successfully"):
            verify(client)

        client = FixtureClient()
        client.jobs["jobs"] = client.jobs["jobs"][:2]
        client.jobs["total_count"] = 2
        with self.assertRaisesRegex(GitHubEvidenceError, "missing required jobs"):
            verify(client)

        client = FixtureClient()
        client.jobs["total_count"] = 99
        with self.assertRaisesRegex(GitHubEvidenceError, "incomplete"):
            verify(client)

        client = FixtureClient()
        client.jobs["jobs"][0]["head_sha"] = "b" * 40
        with self.assertRaisesRegex(GitHubEvidenceError, "different commit"):
            verify(client)

    def test_transport_or_client_failure_is_fail_closed_without_secret(self) -> None:
        def broken(_url: str, _headers: Mapping[str, str], _timeout: float) -> Mapping[str, Any]:
            raise ValueError("read-only-secret")

        with self.assertRaises(GitHubEvidenceError) as caught:
            verify(FixtureClient(), fetch_json=broken)
        self.assertNotIn("read-only-secret", str(caught.exception))

    def test_caller_cannot_supply_url_or_conclusion_as_evidence(self) -> None:
        client = FixtureClient()
        with self.assertRaises(TypeError):
            verify(client, run_url="https://github.com/wzhic/material/actions/runs/12345")
        with self.assertRaises(TypeError):
            verify(client, conclusion="success")


if __name__ == "__main__":
    unittest.main()
