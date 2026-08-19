#!/usr/bin/env python3
"""Repository-external OpenSSH authority for signed governance receipts.

The signing private key is deliberately outside this module's interface.  The
only cryptographic operation performed here is verification with the public
key that is pinned in the task's reviewed canonical scope.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import secrets
import stat
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from core import (
    PHASE_GATES,
    REVIEW_DECISIONS,
    REVIEW_NAMESPACE,
    VALIDATION_PHASES,
    GovernanceError,
    canonical_scope_hash,
    control_dir,
    expected_validation_subject,
    load_current_task,
    load_task,
    normalize_commit,
    parse_timestamp,
    read_json,
    review_path,
    utc_now,
    validate_review_id,
    validate_target_digest,
)


AUTHORITY_SCHEME = "ssh-keygen-y-v1"
PAYLOAD_SCHEMA = "material-governance-review/v1"
RECEIPT_SCHEMA_VERSION = 2
SSH_SIGNATURE_BEGIN = "-----BEGIN SSH SIGNATURE-----"
SSH_SIGNATURE_END = "-----END SSH SIGNATURE-----"

_SAFE_IDENTITY = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+@-]{0,127}$")
_SAFE_NAMESPACE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+@-]{2,127}$")
_SAFE_KEY_TYPE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+@-]{1,127}$")
_ALLOWED_KEY_TYPES = frozenset((
    "ssh-ed25519",
    "sk-ssh-ed25519@openssh.com",
    "rsa-sha2-512",
    "ssh-rsa",
))
_NONCE = re.compile(r"^[A-Za-z0-9_-]{32,128}$")
_SCOPE_HASH = re.compile(r"^sha256:[0-9a-f]{64}$")
_MAX_PAYLOAD_BYTES = 1024 * 1024
_MAX_SIGNATURE_BYTES = 64 * 1024

_AUTHORITY_FIELDS = frozenset((
    "scheme",
    "identity",
    "namespace",
    "public_key",
    "key_fingerprint",
))
_AUTHORITY_DESCRIPTOR_FIELDS = frozenset((
    "scheme",
    "identity",
    "namespace",
    "key_fingerprint",
))
_SIGNATURE_FIELDS = frozenset((
    "scheme",
    "identity",
    "namespace",
    "key_fingerprint",
    "payload_sha256",
    "armored",
))
_COMMON_RECEIPT_FIELDS = frozenset((
    "schema_version",
    "payload_schema",
    "review_id",
    "project_id",
    "source_repository",
    "task_id",
    "kind",
    "decision",
    "approver",
    "reason",
    "confirmation_source",
    "scope_version",
    "scope_hash",
    "decided_at",
    "expires_at",
    "supersedes",
    "nonce",
    "authority",
))
_KIND_FIELDS = {
    "scope": frozenset(),
    "code": frozenset(("commit",)),
    "validation_waiver": frozenset((
        "check_id",
        "phase",
        "subject",
        "environment",
        "max_gate",
    )),
    "irreversible_operation": frozenset(("operation_id", "target_digest")),
}


def _nonempty_string(value: Any, field: str, maximum: int = 4096) -> str:
    if not isinstance(value, str) or not value.strip():
        raise GovernanceError("%s must be a non-empty string" % field)
    if len(value) > maximum or "\x00" in value:
        raise GovernanceError("%s is too large or contains a NUL byte" % field)
    return value


def _canonical_json_bytes(value: Any) -> bytes:
    try:
        rendered = json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
    except (TypeError, ValueError) as exc:
        raise GovernanceError("receipt payload is not canonical JSON: %s" % exc) from exc
    encoded = (rendered + "\n").encode("utf-8")
    if len(encoded) > _MAX_PAYLOAD_BYTES:
        raise GovernanceError("receipt payload exceeds the one MiB limit")
    return encoded


def _ssh_public_key_parts(public_key: Any) -> Tuple[str, str]:
    value = _nonempty_string(public_key, "review_authority.public_key", 32 * 1024)
    if "\n" in value or "\r" in value:
        raise GovernanceError("review_authority.public_key must contain exactly one public-key line")
    parts = value.strip().split()
    if len(parts) < 2:
        raise GovernanceError("review_authority.public_key must contain a key type and base64 blob")
    key_type, encoded = parts[0], parts[1]
    if not _SAFE_KEY_TYPE.fullmatch(key_type) or key_type not in _ALLOWED_KEY_TYPES:
        raise GovernanceError("review_authority.public_key has an unsafe key type")
    try:
        blob = base64.b64decode(encoded.encode("ascii"), validate=True)
    except (UnicodeEncodeError, ValueError) as exc:
        raise GovernanceError("review_authority.public_key has invalid base64") from exc
    if len(blob) < 8:
        raise GovernanceError("review_authority.public_key blob is truncated")
    declared_length = int.from_bytes(blob[:4], byteorder="big")
    if declared_length <= 0 or 4 + declared_length > len(blob):
        raise GovernanceError("review_authority.public_key blob has an invalid key-type field")
    try:
        embedded_type = blob[4:4 + declared_length].decode("ascii")
    except UnicodeDecodeError as exc:
        raise GovernanceError("review_authority.public_key key type is not ASCII") from exc
    if embedded_type != key_type:
        raise GovernanceError("review_authority.public_key key type does not match its blob")
    return key_type, encoded


def public_key_fingerprint(public_key: Any) -> str:
    """Return the OpenSSH SHA256 fingerprint for one public-key line."""

    _key_type, encoded = _ssh_public_key_parts(public_key)
    blob = base64.b64decode(encoded.encode("ascii"), validate=True)
    digest = base64.b64encode(hashlib.sha256(blob).digest()).decode("ascii").rstrip("=")
    return "SHA256:" + digest


def validate_authority(authority: Any) -> Dict[str, str]:
    """Validate and normalize the reviewed public trust anchor."""

    if not isinstance(authority, Mapping):
        raise GovernanceError("task.review_authority must be an object")
    if set(authority) != _AUTHORITY_FIELDS:
        missing = sorted(_AUTHORITY_FIELDS - set(authority))
        extra = sorted(set(authority) - _AUTHORITY_FIELDS)
        details: List[str] = []
        if missing:
            details.append("missing %s" % ", ".join(missing))
        if extra:
            details.append("unknown %s" % ", ".join(extra))
        raise GovernanceError("task.review_authority fields are invalid: %s" % "; ".join(details))
    if authority.get("scheme") != AUTHORITY_SCHEME:
        raise GovernanceError("task.review_authority.scheme must be %s" % AUTHORITY_SCHEME)
    identity = _nonempty_string(authority.get("identity"), "review_authority.identity", 128)
    namespace = _nonempty_string(authority.get("namespace"), "review_authority.namespace", 128)
    if not _SAFE_IDENTITY.fullmatch(identity):
        raise GovernanceError("review_authority.identity contains unsupported characters")
    if not _SAFE_NAMESPACE.fullmatch(namespace) or namespace != REVIEW_NAMESPACE:
        raise GovernanceError("review_authority.namespace must be %s" % REVIEW_NAMESPACE)
    key_type, encoded_key = _ssh_public_key_parts(authority.get("public_key"))
    expected_fingerprint = public_key_fingerprint(authority.get("public_key"))
    fingerprint = _nonempty_string(
        authority.get("key_fingerprint"), "review_authority.key_fingerprint", 128
    )
    if fingerprint != expected_fingerprint:
        raise GovernanceError("review_authority.key_fingerprint does not match public_key")
    return {
        "scheme": AUTHORITY_SCHEME,
        "identity": identity,
        "namespace": namespace,
        "public_key": "%s %s" % (key_type, encoded_key),
        "key_fingerprint": fingerprint,
    }


def authority_from_task(task: Mapping[str, Any]) -> Dict[str, str]:
    """Load the sole trust anchor from canonical task scope."""

    if "review_authority" not in task:
        raise GovernanceError(
            "task.review_authority is absent; a reviewed public key is required before signed receipts"
        )
    return validate_authority(task.get("review_authority"))


def authority_descriptor(authority: Mapping[str, Any]) -> Dict[str, str]:
    normalized = validate_authority(authority)
    return {
        key: normalized[key]
        for key in ("scheme", "identity", "namespace", "key_fingerprint")
    }


def _validate_receipt_shape(receipt: Any, require_signature: bool) -> Dict[str, Any]:
    if not isinstance(receipt, Mapping):
        raise GovernanceError("signed receipt must be a JSON object")
    stored = {key: value for key, value in receipt.items() if key != "_path"}
    kind = stored.get("kind")
    if kind not in _KIND_FIELDS:
        raise GovernanceError("receipt.kind is unknown")
    expected_fields = set(_COMMON_RECEIPT_FIELDS | _KIND_FIELDS[str(kind)])
    if require_signature:
        expected_fields.add("signature")
    actual_fields = set(stored)
    if actual_fields != expected_fields:
        missing = sorted(expected_fields - actual_fields)
        extra = sorted(actual_fields - expected_fields)
        details: List[str] = []
        if missing:
            details.append("missing %s" % ", ".join(missing))
        if extra:
            details.append("unknown %s" % ", ".join(extra))
        raise GovernanceError("receipt fields are invalid: %s" % "; ".join(details))

    if stored.get("schema_version") != RECEIPT_SCHEMA_VERSION:
        raise GovernanceError("signed receipt schema_version must be %d" % RECEIPT_SCHEMA_VERSION)
    if stored.get("payload_schema") != PAYLOAD_SCHEMA:
        raise GovernanceError("signed receipt payload_schema is unsupported")
    validate_review_id(stored.get("review_id"))
    _nonempty_string(stored.get("project_id"), "receipt.project_id", 128)
    _nonempty_string(stored.get("source_repository"), "receipt.source_repository", 1024)
    _nonempty_string(stored.get("task_id"), "receipt.task_id", 192)
    if stored.get("decision") not in REVIEW_DECISIONS:
        raise GovernanceError("receipt.decision is unknown")
    if stored.get("approver") != "user":
        raise GovernanceError("signed receipts must name user as approver")
    _nonempty_string(stored.get("reason"), "receipt.reason")
    _nonempty_string(stored.get("confirmation_source"), "receipt.confirmation_source", 1024)
    if not isinstance(stored.get("scope_version"), int) or stored["scope_version"] < 1:
        raise GovernanceError("receipt.scope_version must be a positive integer")
    if not isinstance(stored.get("scope_hash"), str) or not _SCOPE_HASH.fullmatch(stored["scope_hash"]):
        raise GovernanceError("receipt.scope_hash must be a lowercase sha256 digest")
    decided = parse_timestamp(stored.get("decided_at"))
    if decided is None:
        raise GovernanceError("receipt.decided_at is required")
    expires = parse_timestamp(stored.get("expires_at"))
    if expires is not None and expires <= decided:
        raise GovernanceError("receipt.expires_at must be later than decided_at")
    supersedes = stored.get("supersedes")
    if supersedes is not None:
        validate_review_id(supersedes)
        if supersedes == stored.get("review_id"):
            raise GovernanceError("receipt cannot supersede itself")
    nonce = stored.get("nonce")
    if not isinstance(nonce, str) or not _NONCE.fullmatch(nonce):
        raise GovernanceError("receipt.nonce must be 32-128 base64url characters")
    descriptor = stored.get("authority")
    if not isinstance(descriptor, Mapping) or set(descriptor) != _AUTHORITY_DESCRIPTOR_FIELDS:
        raise GovernanceError("receipt.authority descriptor fields are invalid")

    if kind == "code":
        normalized = normalize_commit(stored.get("commit"), "receipt.commit")
        if normalized != stored.get("commit"):
            raise GovernanceError("receipt.commit must use lowercase hexadecimal")
    elif kind == "validation_waiver":
        _nonempty_string(stored.get("check_id"), "receipt.check_id", 192)
        phase = stored.get("phase")
        if phase not in VALIDATION_PHASES:
            raise GovernanceError("receipt.phase is unknown")
        _nonempty_string(stored.get("subject"), "receipt.subject", 1024)
        _nonempty_string(stored.get("environment"), "receipt.environment", 192)
        if stored.get("max_gate") != PHASE_GATES[phase]:
            raise GovernanceError("receipt.max_gate does not match receipt.phase")
        if expires is None:
            raise GovernanceError("validation waiver receipts require expires_at")
    elif kind == "irreversible_operation":
        _nonempty_string(stored.get("operation_id"), "receipt.operation_id", 192)
        validate_target_digest(stored.get("target_digest"))
        if expires is None:
            raise GovernanceError("irreversible-operation receipts require expires_at")

    if require_signature:
        signature = stored.get("signature")
        if not isinstance(signature, Mapping) or set(signature) != _SIGNATURE_FIELDS:
            raise GovernanceError("receipt.signature envelope fields are invalid")
    return stored


def canonical_receipt_payload(receipt: Mapping[str, Any]) -> bytes:
    """Return the one canonical byte sequence covered by the detached signature."""

    stored = {key: value for key, value in receipt.items() if key not in ("_path", "signature")}
    validated = _validate_receipt_shape(stored, require_signature=False)
    return _canonical_json_bytes(validated)


def receipt_payload_digest(receipt: Mapping[str, Any]) -> str:
    return "sha256:" + hashlib.sha256(canonical_receipt_payload(receipt)).hexdigest()


def _validate_project_binding(root: Path, receipt: Mapping[str, Any]) -> Dict[str, Any]:
    project = read_json(control_dir(root) / "project.json")
    project_id = _nonempty_string(project.get("project_id"), "project.project_id", 128)
    repository = _nonempty_string(
        project.get("source_repository"), "project.source_repository", 1024
    )
    if receipt.get("project_id") != project_id:
        raise GovernanceError("signed receipt belongs to another project")
    if receipt.get("source_repository") != repository:
        raise GovernanceError("signed receipt belongs to another source repository")
    return project


def _validate_task_binding(root: Path, receipt: Mapping[str, Any]) -> Dict[str, Any]:
    task = load_task(root, str(receipt.get("task_id")))
    if receipt.get("scope_version") != task.get("scope_version"):
        raise GovernanceError("signed receipt scope_version does not match the current task")
    if receipt.get("scope_hash") != canonical_scope_hash(task):
        raise GovernanceError("signed receipt scope_hash does not match the current task")
    expected_authority = authority_descriptor(authority_from_task(task))
    if receipt.get("authority") != expected_authority:
        raise GovernanceError("signed receipt authority descriptor does not match reviewed task scope")

    kind = receipt.get("kind")
    if kind == "code":
        verified_commit = task.get("git", {}).get("ci_verified_sha")
        if not verified_commit:
            raise GovernanceError("code receipt requires task.git.ci_verified_sha")
        if receipt.get("commit") != normalize_commit(verified_commit, "task.git.ci_verified_sha"):
            raise GovernanceError("code receipt commit does not match task.git.ci_verified_sha")
    elif kind == "validation_waiver":
        required_ids = {
            str(item.get("id"))
            for item in task.get("validation", {}).get("required", [])
            if isinstance(item, Mapping)
        }
        if receipt.get("check_id") not in required_ids:
            raise GovernanceError("validation waiver references an undeclared check")
        gate = PHASE_GATES[str(receipt.get("phase"))]
        subject, subject_error = expected_validation_subject(root, task, gate)
        if subject_error:
            raise GovernanceError(subject_error)
        if receipt.get("subject") != subject:
            raise GovernanceError("validation waiver subject does not match the current gate subject")
    return task


def build_receipt(
    root: Path,
    task: Mapping[str, Any],
    *,
    review_id: str,
    kind: str,
    decision: str,
    reason: str,
    confirmation_source: str = "external:user-signed-receipt",
    decided_at: Optional[str] = None,
    expires_at: Optional[str] = None,
    supersedes: Optional[str] = None,
    nonce: Optional[str] = None,
    commit: Optional[str] = None,
    check_id: Optional[str] = None,
    phase: Optional[str] = None,
    environment: Optional[str] = None,
    operation_id: Optional[str] = None,
    target_digest: Optional[str] = None,
) -> Dict[str, Any]:
    """Build, but never sign or import, one canonical receipt payload."""

    specialized = {
        "commit": commit,
        "check_id": check_id,
        "phase": phase,
        "environment": environment,
        "operation_id": operation_id,
        "target_digest": target_digest,
    }
    applicable = {
        "scope": frozenset(),
        "code": frozenset(("commit",)),
        "validation_waiver": frozenset(("check_id", "phase", "environment")),
        "irreversible_operation": frozenset(("operation_id", "target_digest")),
    }
    if kind not in applicable:
        raise GovernanceError("unknown receipt kind: %s" % kind)
    irrelevant = sorted(
        field for field, value in specialized.items()
        if value is not None and field not in applicable[kind]
    )
    if irrelevant:
        raise GovernanceError(
            "%s receipt does not accept bindings: %s" % (kind, ", ".join(irrelevant))
        )

    project = read_json(control_dir(root) / "project.json")
    authority = authority_from_task(task)
    receipt: Dict[str, Any] = {
        "schema_version": RECEIPT_SCHEMA_VERSION,
        "payload_schema": PAYLOAD_SCHEMA,
        "review_id": validate_review_id(review_id),
        "project_id": _nonempty_string(project.get("project_id"), "project.project_id", 128),
        "source_repository": _nonempty_string(
            project.get("source_repository"), "project.source_repository", 1024
        ),
        "task_id": task.get("task_id"),
        "kind": kind,
        "decision": decision,
        "approver": "user",
        "reason": reason,
        "confirmation_source": confirmation_source,
        "scope_version": task.get("scope_version"),
        "scope_hash": canonical_scope_hash(task),
        "decided_at": decided_at or utc_now(),
        "expires_at": expires_at,
        "supersedes": supersedes,
        "nonce": nonce or secrets.token_urlsafe(24),
        "authority": authority_descriptor(authority),
    }
    if kind == "code":
        selected_commit = commit or task.get("git", {}).get("ci_verified_sha")
        receipt["commit"] = normalize_commit(selected_commit, "code receipt commit")
    elif kind == "validation_waiver":
        if not check_id or phase not in VALIDATION_PHASES:
            raise GovernanceError("validation waiver requires --check-id and --phase")
        gate = PHASE_GATES[phase]
        subject, subject_error = expected_validation_subject(root, task, gate)
        if subject_error:
            raise GovernanceError(subject_error)
        receipt.update({
            "check_id": check_id,
            "phase": phase,
            "subject": subject,
            "environment": environment or ("local" if phase == "local" else "github-actions"),
            "max_gate": gate,
        })
    elif kind == "irreversible_operation":
        receipt.update({
            "operation_id": _nonempty_string(
                operation_id, "irreversible operation id", 192
            ),
            "target_digest": validate_target_digest(target_digest),
        })
    validated = _validate_receipt_shape(receipt, require_signature=False)
    _validate_project_binding(root, validated)
    _validate_task_binding(root, validated)
    return validated


def attach_signature(
    receipt: Mapping[str, Any],
    signature_text: str,
    authority: Mapping[str, Any],
) -> Dict[str, Any]:
    """Attach an OpenSSH armor block without claiming that it is valid."""

    unsigned = _validate_receipt_shape(receipt, require_signature=False)
    normalized_authority = validate_authority(authority)
    descriptor = authority_descriptor(normalized_authority)
    if unsigned.get("authority") != descriptor:
        raise GovernanceError("receipt authority descriptor does not match the trust anchor")
    signature_text = _nonempty_string(signature_text, "OpenSSH signature", _MAX_SIGNATURE_BYTES)
    try:
        encoded_signature = signature_text.encode("ascii")
    except UnicodeEncodeError as exc:
        raise GovernanceError("OpenSSH signature armor must be ASCII") from exc
    if len(encoded_signature) > _MAX_SIGNATURE_BYTES:
        raise GovernanceError("OpenSSH signature exceeds the 64 KiB limit")
    if not signature_text.startswith(SSH_SIGNATURE_BEGIN + "\n"):
        raise GovernanceError("OpenSSH signature armor has an invalid header")
    if not signature_text.rstrip().endswith(SSH_SIGNATURE_END):
        raise GovernanceError("OpenSSH signature armor has an invalid footer")
    signed = dict(unsigned)
    signed["signature"] = {
        "scheme": normalized_authority["scheme"],
        "identity": normalized_authority["identity"],
        "namespace": normalized_authority["namespace"],
        "key_fingerprint": normalized_authority["key_fingerprint"],
        "payload_sha256": receipt_payload_digest(unsigned),
        "armored": signature_text,
    }
    _validate_receipt_shape(signed, require_signature=True)
    return signed


def _resolve_ssh_keygen() -> Path:
    """Resolve only fixed operating-system OpenSSH locations."""

    if os.name == "nt":
        candidates: Sequence[Path] = (
            Path(r"C:\Windows\System32\OpenSSH\ssh-keygen.exe"),
        )
    else:
        candidates = (
            Path("/usr/bin/ssh-keygen"),
            Path("/bin/ssh-keygen"),
        )
    for candidate in candidates:
        try:
            mode = candidate.stat().st_mode
        except OSError:
            continue
        if stat.S_ISREG(mode) and (os.name == "nt" or mode & 0o111):
            return candidate
    raise GovernanceError(
        "OpenSSH ssh-keygen with -Y sign/verify support is unavailable at a trusted system path"
    )


def _write_restricted_temp(path: Path, data: bytes) -> None:
    descriptor = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
    except BaseException:
        try:
            path.unlink()
        except OSError:
            pass
        raise


def _require_valid_signature(receipt: Mapping[str, Any], authority: Mapping[str, Any]) -> None:
    stored = _validate_receipt_shape(receipt, require_signature=True)
    normalized_authority = validate_authority(authority)
    descriptor = authority_descriptor(normalized_authority)
    if stored.get("authority") != descriptor:
        raise GovernanceError("receipt authority descriptor does not match reviewed task scope")
    signature = stored["signature"]
    for field in ("scheme", "identity", "namespace", "key_fingerprint"):
        if signature.get(field) != descriptor.get(field):
            raise GovernanceError("receipt.signature.%s does not match reviewed task scope" % field)
    expected_digest = receipt_payload_digest(stored)
    if signature.get("payload_sha256") != expected_digest:
        raise GovernanceError("receipt signature payload digest does not match canonical payload")
    armored = _nonempty_string(signature.get("armored"), "OpenSSH signature", _MAX_SIGNATURE_BYTES)
    try:
        armored_bytes = armored.encode("ascii")
    except UnicodeEncodeError as exc:
        raise GovernanceError("OpenSSH signature armor must be ASCII") from exc
    if len(armored_bytes) > _MAX_SIGNATURE_BYTES:
        raise GovernanceError("OpenSSH signature exceeds the 64 KiB limit")
    if not armored.startswith(SSH_SIGNATURE_BEGIN + "\n") or not armored.rstrip().endswith(
        SSH_SIGNATURE_END
    ):
        raise GovernanceError("OpenSSH signature armor is malformed")

    binary = _resolve_ssh_keygen()
    with tempfile.TemporaryDirectory(prefix="material-receipt-verify-") as temporary:
        directory = Path(temporary)
        allowed_signers = directory / "allowed_signers"
        signature_file = directory / "receipt.sig"
        allowed_line = '%s namespaces="%s" %s\n' % (
            normalized_authority["identity"],
            normalized_authority["namespace"],
            normalized_authority["public_key"],
        )
        _write_restricted_temp(allowed_signers, allowed_line.encode("ascii"))
        _write_restricted_temp(signature_file, armored_bytes)
        environment = {
            "HOME": str(directory),
            "LANG": "C",
            "LC_ALL": "C",
            "PATH": str(binary.parent),
        }
        if os.name == "nt":
            environment["SystemRoot"] = r"C:\Windows"
        try:
            completed = subprocess.run(
                [
                    str(binary),
                    "-Y",
                    "verify",
                    "-f",
                    str(allowed_signers),
                    "-I",
                    normalized_authority["identity"],
                    "-n",
                    normalized_authority["namespace"],
                    "-s",
                    str(signature_file),
                ],
                input=canonical_receipt_payload(stored),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=str(directory),
                env=environment,
                timeout=10,
                check=False,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise GovernanceError("OpenSSH signature verification could not run: %s" % exc) from exc
        if completed.returncode != 0:
            raise GovernanceError(
                "OpenSSH signature verification failed; the key, namespace, identity or payload is invalid"
            )


def verify_signed_receipt(
    receipt: Mapping[str, Any],
    authority: Mapping[str, Any],
) -> Tuple[bool, str]:
    """Verify a receipt against the supplied reviewed trust anchor."""

    try:
        _require_valid_signature(receipt, authority)
    except GovernanceError as exc:
        return False, str(exc)
    return True, "valid OpenSSH signed receipt"


def load_signed_receipt(
    payload_path: Path,
    signature_path: Path,
    authority: Mapping[str, Any],
) -> Dict[str, Any]:
    """Load canonical public payload and detached signature; never access a key."""

    try:
        payload_bytes = payload_path.read_bytes()
        signature_bytes = signature_path.read_bytes()
    except OSError as exc:
        raise GovernanceError("cannot read signed receipt import files: %s" % exc) from exc
    if len(payload_bytes) > _MAX_PAYLOAD_BYTES or len(signature_bytes) > _MAX_SIGNATURE_BYTES:
        raise GovernanceError("signed receipt import file exceeds its size limit")
    try:
        payload = json.loads(payload_bytes.decode("utf-8"))
        signature_text = signature_bytes.decode("ascii")
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise GovernanceError("signed receipt import files are malformed: %s" % exc) from exc
    if not isinstance(payload, dict):
        raise GovernanceError("signed receipt payload must be a JSON object")
    canonical = canonical_receipt_payload(payload)
    if payload_bytes != canonical:
        raise GovernanceError("receipt payload file is not the exact canonical byte sequence")
    return attach_signature(payload, signature_text, authority)


def _atomic_create_json(path: Path, value: Mapping[str, Any]) -> None:
    """Atomically create a new JSON file without any overwrite path."""

    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=".%s." % path.name,
        suffix=".tmp",
        dir=str(path.parent),
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.link(str(temporary), str(path))
        except FileExistsError as exc:
            raise GovernanceError("review receipt already exists: %s" % path.name) from exc
        except OSError as exc:
            raise GovernanceError("cannot atomically create review receipt: %s" % exc) from exc
    finally:
        try:
            temporary.unlink()
        except OSError:
            pass


def import_signed_receipt(root: Path, receipt: Mapping[str, Any]) -> Path:
    """Verify, replay-check and atomically import one signed receipt."""

    stored = _validate_receipt_shape(receipt, require_signature=True)
    _validate_project_binding(root, stored)
    current = load_current_task(root)
    if stored.get("task_id") != current.get("task_id"):
        raise GovernanceError("signed receipt does not belong to the current task")
    task = _validate_task_binding(root, stored)
    authority = authority_from_task(task)
    valid, reason = verify_signed_receipt(stored, authority)
    if not valid:
        raise GovernanceError(reason)

    reviews = control_dir(root) / "reviews"
    lock_path = reviews / ".signed-receipt-import.lock"
    reviews.mkdir(parents=True, exist_ok=True)
    try:
        lock_descriptor = os.open(
            str(lock_path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600
        )
    except FileExistsError as exc:
        raise GovernanceError(
            "another signed-receipt import is active or its fail-closed lock needs inspection"
        ) from exc
    try:
        with os.fdopen(lock_descriptor, "w", encoding="ascii") as lock:
            lock.write("pid=%d at=%s\n" % (os.getpid(), utc_now()))
            lock.flush()
            os.fsync(lock.fileno())
        destination = review_path(root, str(stored["review_id"]))
        if destination.exists():
            raise GovernanceError("review receipt already exists: %s" % destination.name)
        for path in sorted(reviews.glob("*.json")):
            existing = read_json(path)
            if existing.get("nonce") == stored.get("nonce"):
                raise GovernanceError(
                    "signed receipt nonce was already imported by %s" % existing.get("review_id")
                )
        supersedes = stored.get("supersedes")
        if supersedes is not None:
            prior_path = review_path(root, str(supersedes))
            if not prior_path.is_file():
                raise GovernanceError("superseded receipt does not exist: %s" % supersedes)
            prior = read_json(prior_path)
            if prior.get("task_id") != stored.get("task_id") or prior.get("kind") != stored.get("kind"):
                raise GovernanceError("supersedes must reference the same task and receipt kind")
        _atomic_create_json(destination, stored)
        return destination
    finally:
        try:
            lock_path.unlink()
        except OSError:
            pass


def write_payload_exclusive(path: Path, payload: bytes) -> None:
    """Write a signing payload without ever replacing an existing file."""

    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        _write_restricted_temp(path, payload)
    except FileExistsError as exc:
        raise GovernanceError("signing payload already exists: %s" % path) from exc
