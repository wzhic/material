#!/usr/bin/env python3
"""Verify GitHub Actions evidence against the GitHub REST API.

The caller supplies a read-only credential from outside the repository.  The
credential is used only in the HTTP Authorization header and is never returned
in evidence or included in errors.
"""

from __future__ import annotations

import datetime as dt
import json
import re
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence


API_BASE = "https://api.github.com"
API_VERSION = "2026-03-10"
PROVIDER = "github_actions_rest_v1"
TRUSTED_REPOSITORY = "wzhic/material"
TRUSTED_WORKFLOW_PATH = ".github/workflows/governance.yml"
_REPOSITORY = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
_RUN_ID = re.compile(r"^[1-9][0-9]*$")
_HEAD_SHA = re.compile(r"^[0-9a-f]{40}$")


class GitHubEvidenceError(RuntimeError):
    """Fail-closed GitHub evidence verification error."""


FetchJson = Callable[[str, Mapping[str, str], float], Mapping[str, Any]]


def _utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def _default_fetch_json(
    url: str,
    headers: Mapping[str, str],
    timeout_seconds: float,
) -> Mapping[str, Any]:
    request = urllib.request.Request(url, headers=dict(headers), method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            if getattr(response, "status", 200) != 200:
                raise GitHubEvidenceError(
                    "GitHub REST request returned HTTP %s" % getattr(response, "status", "unknown")
                )
            raw = response.read()
    except urllib.error.HTTPError as exc:
        raise GitHubEvidenceError("GitHub REST request returned HTTP %s" % exc.code) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise GitHubEvidenceError("GitHub REST request failed") from exc
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise GitHubEvidenceError("GitHub REST response is not valid UTF-8 JSON") from exc
    if not isinstance(payload, dict):
        raise GitHubEvidenceError("GitHub REST response must be a JSON object")
    return payload


def _require_text(mapping: Mapping[str, Any], field: str) -> str:
    value = mapping.get(field)
    if not isinstance(value, str) or not value.strip():
        raise GitHubEvidenceError("GitHub workflow run is missing %s" % field)
    return value


def _validated_trust(ci_trust: Mapping[str, Any]) -> Dict[str, Any]:
    if not isinstance(ci_trust, Mapping):
        raise GitHubEvidenceError("ci_trust must be an object")
    repository = ci_trust.get("repository")
    workflow_path = ci_trust.get("workflow_path")
    api_base = ci_trust.get("api_base")
    api_version = ci_trust.get("api_version")
    private = ci_trust.get("private")
    if not isinstance(repository, str) or not _REPOSITORY.fullmatch(repository):
        raise GitHubEvidenceError("ci_trust.repository must be owner/repository")
    if repository != TRUSTED_REPOSITORY:
        raise GitHubEvidenceError("ci_trust.repository must be %s" % TRUSTED_REPOSITORY)
    if (
        not isinstance(workflow_path, str)
        or not workflow_path.startswith(".github/workflows/")
        or not workflow_path.endswith((".yml", ".yaml"))
        or ".." in workflow_path.split("/")
    ):
        raise GitHubEvidenceError("ci_trust.workflow_path must be a repository workflow path")
    if workflow_path != TRUSTED_WORKFLOW_PATH:
        raise GitHubEvidenceError("ci_trust.workflow_path must be %s" % TRUSTED_WORKFLOW_PATH)
    if api_base != API_BASE:
        raise GitHubEvidenceError("ci_trust.api_base must be %s" % API_BASE)
    if api_version != API_VERSION:
        raise GitHubEvidenceError("ci_trust.api_version must be %s" % API_VERSION)
    if private is not True:
        raise GitHubEvidenceError("this project requires ci_trust.private=true")
    return {
        "repository": repository,
        "workflow_path": workflow_path,
        "api_base": api_base,
        "api_version": api_version,
        "private": True,
    }


def verify_workflow_run(
    ci_trust: Mapping[str, Any],
    *,
    run_id: str,
    run_attempt: int,
    expected_event: str,
    expected_head_sha: str,
    expected_head_branch: str,
    expected_job_names: Sequence[str],
    token: str,
    fetch_json: Optional[FetchJson] = None,
    timeout_seconds: float = 15.0,
    verified_at: Optional[str] = None,
) -> Dict[str, Any]:
    """Fetch and verify one immutable workflow-run attempt.

    A URL or caller-supplied conclusion is never accepted as evidence.  The run
    and its jobs must be returned by GitHub for the reviewed repository and
    workflow, and every returned job in that attempt must have succeeded.
    """

    trust = _validated_trust(ci_trust)
    if not isinstance(run_id, str) or not _RUN_ID.fullmatch(run_id):
        raise GitHubEvidenceError("run_id must be a positive decimal string")
    if not isinstance(run_attempt, int) or isinstance(run_attempt, bool) or run_attempt < 1:
        raise GitHubEvidenceError("run_attempt must be a positive integer")
    if expected_event not in ("push", "pull_request"):
        raise GitHubEvidenceError("expected_event must be push or pull_request")
    if not isinstance(expected_head_sha, str) or not _HEAD_SHA.fullmatch(expected_head_sha):
        raise GitHubEvidenceError("expected_head_sha must be a lowercase 40-character Git SHA")
    if not isinstance(expected_head_branch, str) or not expected_head_branch.strip():
        raise GitHubEvidenceError("expected_head_branch must be non-empty")
    if (
        not isinstance(expected_job_names, Sequence)
        or isinstance(expected_job_names, (str, bytes))
        or not expected_job_names
        or any(not isinstance(name, str) or not name.strip() for name in expected_job_names)
        or len(set(expected_job_names)) != len(expected_job_names)
    ):
        raise GitHubEvidenceError("expected_job_names must be unique non-empty strings")
    if not isinstance(token, str) or not token.strip():
        raise GitHubEvidenceError("a repository-external Actions read credential is required")
    if not isinstance(timeout_seconds, (int, float)) or isinstance(timeout_seconds, bool) or timeout_seconds <= 0:
        raise GitHubEvidenceError("timeout_seconds must be positive")

    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": "Bearer " + token,
        "X-GitHub-Api-Version": trust["api_version"],
        "User-Agent": "material-governance/1",
    }
    fetch = fetch_json or _default_fetch_json
    repository = trust["repository"]
    base = "%s/repos/%s/actions/runs/%s/attempts/%s" % (
        trust["api_base"], repository, run_id, run_attempt,
    )
    try:
        run = fetch(base, headers, float(timeout_seconds))
        jobs_payload = fetch(base + "/jobs?per_page=100", headers, float(timeout_seconds))
    except GitHubEvidenceError:
        raise
    except Exception as exc:
        raise GitHubEvidenceError("GitHub evidence client failed closed") from exc
    if not isinstance(run, Mapping) or not isinstance(jobs_payload, Mapping):
        raise GitHubEvidenceError("GitHub evidence responses must be JSON objects")

    repository_payload = run.get("repository")
    repository_full_name = (
        repository_payload.get("full_name") if isinstance(repository_payload, Mapping) else None
    )
    if not isinstance(repository_full_name, str) or repository_full_name.lower() != repository.lower():
        raise GitHubEvidenceError("workflow run repository does not match ci_trust")
    if str(run.get("id")) != run_id:
        raise GitHubEvidenceError("workflow run id does not match the requested run")
    if run.get("run_attempt") != run_attempt:
        raise GitHubEvidenceError("workflow run attempt does not match the requested attempt")
    workflow_path_value = _require_text(run, "path").split("@", 1)[0]
    if workflow_path_value != trust["workflow_path"]:
        raise GitHubEvidenceError("workflow run path does not match ci_trust")
    if run.get("status") != "completed" or run.get("conclusion") != "success":
        raise GitHubEvidenceError("workflow run is not completed successfully")
    if run.get("event") != expected_event:
        raise GitHubEvidenceError("workflow run event does not match the expected event")
    if run.get("head_sha") != expected_head_sha:
        raise GitHubEvidenceError("workflow run head SHA does not match the expected commit")
    if run.get("head_branch") != expected_head_branch:
        raise GitHubEvidenceError("workflow run head branch does not match the expected branch")
    html_url = _require_text(run, "html_url")
    expected_url_prefix = "https://github.com/%s/actions/runs/%s" % (repository, run_id)
    if not (html_url == expected_url_prefix or html_url.startswith(expected_url_prefix + "/")):
        raise GitHubEvidenceError("workflow run URL does not match repository and run id")

    jobs = jobs_payload.get("jobs")
    total_count = jobs_payload.get("total_count")
    if not isinstance(jobs, list) or not jobs:
        raise GitHubEvidenceError("workflow run attempt has no jobs")
    if not isinstance(total_count, int) or isinstance(total_count, bool) or total_count != len(jobs):
        raise GitHubEvidenceError("workflow job response is incomplete or malformed")
    names: List[str] = []
    for job in jobs:
        if not isinstance(job, Mapping):
            raise GitHubEvidenceError("workflow job response contains a non-object")
        name = _require_text(job, "name")
        names.append(name)
        if str(job.get("run_id")) != run_id:
            raise GitHubEvidenceError("workflow job is bound to a different run")
        if job.get("head_sha") != expected_head_sha:
            raise GitHubEvidenceError("workflow job is bound to a different commit")
        if job.get("status") != "completed" or job.get("conclusion") != "success":
            raise GitHubEvidenceError("workflow job %s is not completed successfully" % name)
    missing_jobs = sorted(set(expected_job_names) - set(names))
    if missing_jobs:
        raise GitHubEvidenceError("workflow run is missing required jobs: %s" % ", ".join(missing_jobs))

    return {
        "provider": PROVIDER,
        "repository": repository_full_name,
        "workflow_path": workflow_path_value,
        "workflow_id": run.get("workflow_id"),
        "run_id": run_id,
        "run_attempt": run_attempt,
        "event": expected_event,
        "head_sha": expected_head_sha,
        "head_branch": expected_head_branch,
        "status": "completed",
        "conclusion": "success",
        "run_url": html_url,
        "job_names": sorted(names),
        "required_job_names": sorted(expected_job_names),
        "api_version": trust["api_version"],
        "verified_at": verified_at or _utc_now(),
    }
