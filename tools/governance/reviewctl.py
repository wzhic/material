#!/usr/bin/env python3
"""Prepare, import, inspect and verify signed governance receipts."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

from authority import (
    authority_from_task,
    build_receipt,
    canonical_receipt_payload,
    import_signed_receipt,
    load_signed_receipt,
    receipt_payload_digest,
    write_payload_exclusive,
)
from core import (
    PHASE_GATES,
    GovernanceError,
    LEGACY_RECORD_DISABLED,
    REVIEW_DECISIONS,
    VALIDATION_PHASES,
    build_conversation_receipt,
    canonical_scope_hash,
    default_root,
    expected_validation_subject,
    find_effective_code_review,
    find_effective_final_action_review,
    find_effective_irreversible_operation_review,
    find_effective_rework_review,
    find_effective_review,
    find_effective_validation_waiver,
    json_result,
    list_reviews,
    load_current_task,
    load_task,
    normalize_commit,
    read_json,
    review_path,
    write_output,
    write_json_exclusive_atomic,
)


def _root(value: str) -> Path:
    return Path(value).resolve()


def _external_path(root: Path, value: Path, field: str) -> Path:
    resolved = value.expanduser().resolve()
    try:
        resolved.relative_to(root.resolve())
    except ValueError:
        return resolved
    raise GovernanceError("%s must be outside the repository" % field)


def _task(root: Path, task_id: Optional[str]) -> Dict[str, Any]:
    return load_task(root, task_id) if task_id else load_current_task(root)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="reviewctl", description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    def common(subparser: argparse.ArgumentParser) -> None:
        subparser.add_argument("--root", type=_root, default=default_root())
        subparser.add_argument("--json", action="store_true")

    listing = subparsers.add_parser("list", help="list review receipts")
    listing.add_argument("--task", dest="task_id")
    common(listing)

    show = subparsers.add_parser("show", help="show one review receipt")
    show.add_argument("review_id")
    common(show)

    verify = subparsers.add_parser("verify", help="verify approval for the current scope")
    verify.add_argument("--task", dest="task_id")
    verify.add_argument(
        "--kind",
        default="scope",
        choices=(
            "scope", "code", "validation_waiver", "irreversible_operation", "rework",
            "final_action",
        ),
    )
    verify.add_argument("--check-id")
    verify.add_argument("--phase", choices=sorted(VALIDATION_PHASES))
    verify.add_argument("--commit")
    verify.add_argument("--environment")
    verify.add_argument("--operation-id")
    verify.add_argument("--target-digest")
    verify.add_argument("--action", choices=("merge", "deploy", "release"))
    common(verify)

    prepare = subparsers.add_parser(
        "prepare",
        help="render a canonical unsigned payload for the user-controlled signer",
    )
    prepare.add_argument("task_id")
    prepare.add_argument("--review-id", required=True)
    prepare.add_argument("--decision", required=True, choices=sorted(REVIEW_DECISIONS))
    prepare.add_argument(
        "--kind",
        default="scope",
        choices=("scope", "code", "validation_waiver", "irreversible_operation"),
    )
    prepare.add_argument("--reason", required=True)
    prepare.add_argument(
        "--confirmation-source",
        default="external:user-signed-receipt",
    )
    prepare.add_argument("--decided-at")
    prepare.add_argument("--expires-at")
    prepare.add_argument("--supersedes")
    prepare.add_argument("--nonce")
    prepare.add_argument("--commit")
    prepare.add_argument("--check-id")
    prepare.add_argument("--phase", choices=sorted(VALIDATION_PHASES))
    prepare.add_argument("--environment")
    prepare.add_argument("--operation-id")
    prepare.add_argument("--target-digest")
    prepare.add_argument(
        "--output",
        type=Path,
        help="user-only external-terminal option; create this payload file without overwrite",
    )
    common(prepare)

    signed_import = subparsers.add_parser(
        "import-signed",
        help="user-only: verify and atomically import a detached OpenSSH signature",
    )
    signed_import.add_argument("--payload", type=Path, required=True)
    signed_import.add_argument("--signature", type=Path, required=True)
    common(signed_import)

    conversation = subparsers.add_parser(
        "record-conversation",
        help="record an explicit user decision from the current Codex conversation",
    )
    conversation.add_argument("task_id")
    conversation.add_argument("--review-id", required=True)
    conversation.add_argument("--decision", required=True, choices=sorted(REVIEW_DECISIONS))
    conversation.add_argument(
        "--kind",
        default="scope",
        choices=(
            "scope", "code", "validation_waiver", "irreversible_operation", "rework",
            "final_action",
        ),
    )
    conversation.add_argument("--reason", required=True)
    conversation.add_argument("--confirmation-ref", required=True)
    conversation.add_argument("--confirmation-text", required=True)
    conversation.add_argument("--actor", required=True)
    conversation.add_argument("--decided-at")
    conversation.add_argument("--expires-at")
    conversation.add_argument("--supersedes")
    conversation.add_argument("--commit")
    conversation.add_argument("--check-id")
    conversation.add_argument("--phase", choices=sorted(VALIDATION_PHASES))
    conversation.add_argument("--environment")
    conversation.add_argument("--operation-id")
    conversation.add_argument("--target-digest")
    conversation.add_argument("--action", choices=("merge", "deploy", "release"))
    common(conversation)

    record = subparsers.add_parser(
        "record",
        help="disabled legacy entry point; use record-conversation",
    )
    record.add_argument("task_id")
    record.add_argument("--decision", required=True, choices=sorted(REVIEW_DECISIONS))
    record.add_argument("--approver", required=True, choices=("user",))
    record.add_argument(
        "--kind",
        default="scope",
        choices=("scope", "code", "validation_waiver", "irreversible_operation"),
    )
    record.add_argument("--check-id")
    record.add_argument("--phase", choices=sorted(VALIDATION_PHASES))
    record.add_argument("--commit")
    record.add_argument("--environment")
    record.add_argument("--operation-id")
    record.add_argument("--target-digest")
    record.add_argument("--reason", required=True)
    record.add_argument("--confirmation-source", required=True)
    record.add_argument("--expires-at")
    record.add_argument("--supersedes")
    record.add_argument("--review-id")
    common(record)
    return parser


def _find_by_id(root: Path, review_id: str) -> Dict[str, Any]:
    path = review_path(root, review_id)
    receipt = read_json(path)
    if receipt.get("review_id") != review_id:
        raise GovernanceError("review_id does not match filename")
    return receipt


def main(argv: Optional[List[str]] = None) -> int:
    effective_argv = list(sys.argv[1:] if argv is None else argv)
    # `waive` is reserved as a write entry point even though it is not exposed
    # by the current parser.  Keep it fail-closed with the same actionable
    # message instead of allowing an alternate unsigned receipt path to emerge.
    if effective_argv and effective_argv[0] == "waive":
        wants_json = "--json" in effective_argv
        payload = {"ok": False, "error": LEGACY_RECORD_DISABLED}
        write_output(
            json_result(payload) if wants_json else "ERROR: %s" % LEGACY_RECORD_DISABLED,
            stream=sys.stderr,
        )
        return 2

    args = build_parser().parse_args(effective_argv)
    root: Path = args.root
    try:
        if args.command == "list":
            receipts = list_reviews(root, args.task_id)
            payload = {"ok": True, "reviews": receipts}
            write_output(json_result(payload) if args.json else "\n".join(
                "%s\t%s\t%s" % (item.get("review_id"), item.get("decision"), item.get("task_id"))
                for item in receipts
            ))
            return 0

        if args.command == "show":
            receipt = _find_by_id(root, args.review_id)
            write_output(json_result({"ok": True, "review": receipt}) if args.json else json_result(receipt))
            return 0

        if args.command == "verify":
            task = _task(root, args.task_id)
            if args.kind == "validation_waiver":
                if not args.check_id or not args.phase:
                    raise GovernanceError("validation_waiver verification requires --check-id and --phase")
                if any((args.operation_id, args.target_digest, args.action)):
                    raise GovernanceError("validation_waiver verification does not accept unrelated bindings")
                gate = PHASE_GATES[args.phase]
                expected_subject, subject_error = expected_validation_subject(root, task, gate)
                if subject_error:
                    raise GovernanceError(subject_error)
                environment = args.environment.strip() if args.environment else None
                if args.phase == "local":
                    if args.commit:
                        raise GovernanceError("local validation waiver verification does not accept --commit")
                    environment = environment or "local"
                else:
                    if not args.commit or not environment:
                        raise GovernanceError(
                            "%s validation waiver verification requires --commit and --environment" % args.phase
                        )
                    if "commit:" + normalize_commit(args.commit) != expected_subject:
                        raise GovernanceError("validation waiver commit does not match the task gate subject")
                receipt, reason = find_effective_validation_waiver(
                    root, task, args.check_id, args.phase, environment
                )
            elif args.kind == "code":
                if any((
                    args.check_id, args.phase, args.environment, args.operation_id,
                    args.target_digest, args.action,
                )):
                    raise GovernanceError("code verification only accepts a commit binding")
                receipt, reason = find_effective_code_review(root, task, args.commit)
            elif args.kind == "irreversible_operation":
                if not args.operation_id or not args.target_digest:
                    raise GovernanceError(
                        "irreversible_operation verification requires --operation-id and --target-digest"
                    )
                if any((args.check_id, args.phase, args.commit, args.environment, args.action)):
                    raise GovernanceError(
                        "irreversible_operation verification only accepts operation bindings"
                    )
                receipt, reason = find_effective_irreversible_operation_review(
                    root, task, args.operation_id, args.target_digest
                )
            elif args.kind == "rework":
                if any((
                    args.check_id, args.phase, args.commit, args.environment,
                    args.operation_id, args.target_digest, args.action,
                )):
                    raise GovernanceError("rework verification derives its frozen subject from the task")
                receipt, reason = find_effective_rework_review(root, task)
            elif args.kind == "final_action":
                if not args.action:
                    raise GovernanceError("final_action verification requires --action")
                if any((
                    args.check_id, args.phase, args.commit, args.environment,
                    args.operation_id, args.target_digest,
                )):
                    raise GovernanceError("final_action verification only accepts --action")
                receipt, reason = find_effective_final_action_review(root, task, args.action)
            else:
                if any((
                    args.check_id, args.phase, args.commit, args.environment,
                    args.operation_id, args.target_digest, args.action,
                )):
                    raise GovernanceError("scope verification does not accept specialized binding arguments")
                receipt, reason = find_effective_review(root, task)
            ok = receipt is not None
            payload = {
                "ok": ok,
                "task_id": task["task_id"],
                "scope_hash": canonical_scope_hash(task),
                "reason": reason,
                "review": receipt,
            }
            write_output(json_result(payload) if args.json else ("VALID: " if ok else "INVALID: ") + reason)
            return 0 if ok else 1

        if args.command == "prepare":
            task = load_task(root, args.task_id)
            current = load_current_task(root)
            if task.get("task_id") != current.get("task_id"):
                raise GovernanceError("signed receipt payload may only be prepared for the current task")
            receipt = build_receipt(
                root,
                task,
                review_id=args.review_id,
                kind=args.kind,
                decision=args.decision,
                reason=args.reason,
                confirmation_source=args.confirmation_source,
                decided_at=args.decided_at,
                expires_at=args.expires_at,
                supersedes=args.supersedes,
                nonce=args.nonce,
                commit=args.commit,
                check_id=args.check_id,
                phase=args.phase,
                environment=args.environment,
                operation_id=args.operation_id,
                target_digest=args.target_digest,
            )
            canonical_payload = canonical_receipt_payload(receipt)
            digest = receipt_payload_digest(receipt)
            authority = authority_from_task(task)
            if args.output is not None:
                output = _external_path(root, args.output, "prepared payload output")
                write_payload_exclusive(output, canonical_payload)
                result = {
                    "ok": True,
                    "output": str(output),
                    "payload_sha256": digest,
                    "namespace": authority["namespace"],
                    "identity": authority["identity"],
                    "key_fingerprint": authority["key_fingerprint"],
                }
                write_output(json_result(result) if args.json else "PREPARED: %s" % output)
            elif args.json:
                write_output(json_result({
                    "ok": True,
                    "payload": canonical_payload.decode("utf-8"),
                    "payload_sha256": digest,
                    "namespace": authority["namespace"],
                    "identity": authority["identity"],
                    "key_fingerprint": authority["key_fingerprint"],
                }))
            else:
                # Text mode is intentionally only the exact bytes to sign so
                # the user can redirect stdout from an external terminal.
                write_output(canonical_payload.decode("utf-8"), end="")
            return 0

        if args.command == "import-signed":
            task = load_current_task(root)
            authority = authority_from_task(task)
            payload_path = _external_path(root, args.payload, "signed payload")
            signature_path = _external_path(root, args.signature, "detached signature")
            receipt = load_signed_receipt(
                payload_path,
                signature_path,
                authority,
            )
            path = import_signed_receipt(root, receipt)
            result = {
                "ok": True,
                "review_id": receipt["review_id"],
                "task_id": receipt["task_id"],
                "path": str(path),
                "payload_sha256": receipt["signature"]["payload_sha256"],
                "key_fingerprint": receipt["signature"]["key_fingerprint"],
            }
            write_output(json_result(result) if args.json else "IMPORTED: %s" % receipt["review_id"])
            return 0

        if args.command == "record-conversation":
            task = load_task(root, args.task_id)
            current = load_current_task(root)
            if task.get("task_id") != current.get("task_id"):
                raise GovernanceError("conversation receipts may only be recorded for the current task")
            expected_states = {
                "scope": "REVIEW_PENDING",
                "code": "CI_VERIFIED",
                "validation_waiver": {
                    "local": "IN_PROGRESS",
                    "ci": "COMMITTED",
                    "post_merge": "MERGED",
                }.get(args.phase),
            }
            expected_state = expected_states.get(args.kind)
            if expected_state is not None and task.get("status") != expected_state:
                raise GovernanceError(
                    "%s conversation decision may only be recorded while task is %s"
                    % (args.kind, expected_state)
                )
            if args.kind == "final_action":
                if args.action == "merge":
                    allowed_states = ("COMMITTED", "CI_VERIFIED", "CODE_REVIEWED")
                else:
                    allowed_states = ("MERGED", "POST_MERGE_VERIFIED", "DONE")
                if task.get("status") not in allowed_states:
                    raise GovernanceError(
                        "%s final decision may only be recorded while task is %s"
                        % (args.action, " or ".join(allowed_states))
                    )
            receipt = build_conversation_receipt(
                root,
                task,
                review_id=args.review_id,
                kind=args.kind,
                decision=args.decision,
                reason=args.reason,
                confirmation_ref=args.confirmation_ref,
                confirmation_text=args.confirmation_text,
                actor=args.actor,
                decided_at=args.decided_at,
                expires_at=args.expires_at,
                supersedes=args.supersedes,
                commit=args.commit,
                check_id=args.check_id,
                phase=args.phase,
                environment=args.environment,
                operation_id=args.operation_id,
                target_digest=args.target_digest,
                action=args.action,
            )
            if args.supersedes is not None:
                prior = _find_by_id(root, args.supersedes)
                if (
                    prior.get("task_id") != receipt.get("task_id")
                    or prior.get("kind") != receipt.get("kind")
                ):
                    raise GovernanceError("supersedes must reference the same task and receipt kind")
            destination = review_path(root, args.review_id)
            write_json_exclusive_atomic(destination, receipt)
            result = {
                "ok": True,
                "review_id": receipt["review_id"],
                "task_id": receipt["task_id"],
                "kind": receipt["kind"],
                "approval_mode": receipt["approval_mode"],
                "path": str(destination),
                "warning": "audit-only conversation receipt; no cryptographic identity proof",
            }
            write_output(json_result(result) if args.json else "RECORDED: %s" % receipt["review_id"])
            return 0

        if args.command == "record":
            raise GovernanceError(LEGACY_RECORD_DISABLED)
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
