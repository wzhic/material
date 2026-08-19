from __future__ import annotations

import base64
import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


GOVERNANCE_DIR = Path(__file__).resolve().parents[1]
if str(GOVERNANCE_DIR) not in sys.path:
    sys.path.insert(0, str(GOVERNANCE_DIR))

import authority  # noqa: E402
import reviewctl  # noqa: E402
from core import GovernanceError, find_effective_review, read_json  # noqa: E402
from helpers import base_task, initialize_root, write_json  # noqa: E402


SIGNATURE = (
    "-----BEGIN SSH SIGNATURE-----\n"
    "ZmFrZS1kZXRhLWZvci1jb250cmFjdC10ZXN0cw==\n"
    "-----END SSH SIGNATURE-----\n"
)
NONCE = "A" * 32
DECIDED_AT = "2026-08-18T00:00:00+00:00"


def fake_public_key(fill: bytes = b"A") -> str:
    key_type = b"ssh-ed25519"
    material = (fill * 32)[:32]
    blob = (
        len(key_type).to_bytes(4, byteorder="big")
        + key_type
        + len(material).to_bytes(4, byteorder="big")
        + material
    )
    return "ssh-ed25519 " + base64.b64encode(blob).decode("ascii")


def make_authority(fill: bytes = b"A", namespace: str = authority.REVIEW_NAMESPACE) -> dict:
    public_key = fake_public_key(fill)
    return {
        "scheme": authority.AUTHORITY_SCHEME,
        "identity": "material-project-owner",
        "namespace": namespace,
        "public_key": public_key,
        "key_fingerprint": authority.public_key_fingerprint(public_key),
    }


def initialized_root(root: Path, status: str = "REVIEW_PENDING") -> tuple[dict, dict]:
    task = base_task(status=status)
    task["review_authority"] = make_authority()
    initialize_root(root, task, approved=False)
    project_path = root / "project-control" / "project.json"
    project = read_json(project_path)
    project.update({
        "project_id": "material",
        "source_repository": "git@github.com:wzhic/material.git",
    })
    write_json(project_path, project)
    return task, task["review_authority"]


def scope_receipt(root: Path, task: dict, review_id: str = "REV-SIGNED", nonce: str = NONCE) -> dict:
    return authority.build_receipt(
        root,
        task,
        review_id=review_id,
        kind="scope",
        decision="approved",
        reason="user approved exact reviewed scope",
        decided_at=DECIDED_AT,
        nonce=nonce,
    )


class AuthorityValidationTests(unittest.TestCase):
    def test_public_key_fingerprint_and_descriptor_are_deterministic(self) -> None:
        configured = make_authority()
        normalized = authority.validate_authority(configured)
        self.assertEqual(configured, normalized)
        descriptor = authority.authority_descriptor(configured)
        self.assertNotIn("public_key", descriptor)
        self.assertEqual(configured["key_fingerprint"], descriptor["key_fingerprint"])

    def test_missing_key_invalid_fingerprint_and_ambiguous_namespace_fail_closed(self) -> None:
        cases = []
        missing = make_authority()
        missing["public_key"] = ""
        cases.append(missing)
        mismatch = make_authority()
        mismatch["key_fingerprint"] = "SHA256:not-the-key"
        cases.append(mismatch)
        ambiguous = make_authority()
        ambiguous["namespace"] = "generic-file-signature"
        cases.append(ambiguous)
        for configured in cases:
            with self.subTest(configured=configured), self.assertRaises(GovernanceError):
                authority.validate_authority(configured)

    def test_receipt_payload_is_stable_and_binds_all_semantic_fields(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task, _configured = initialized_root(root)
            receipt = scope_receipt(root, task)
            first = authority.canonical_receipt_payload(receipt)
            reordered = dict(reversed(list(receipt.items())))
            self.assertEqual(first, authority.canonical_receipt_payload(reordered))
            self.assertTrue(first.endswith(b"\n"))
            for field in (
                "review_id", "project_id", "source_repository", "task_id", "kind",
                "decision", "scope_version", "scope_hash", "reason", "nonce", "decided_at",
            ):
                self.assertIn(('"%s":' % field).encode("utf-8"), first)

    def test_kind_specific_fields_are_required_and_signed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task, _configured = initialized_root(root)
            waiver = authority.build_receipt(
                root,
                task,
                review_id="REV-WAIVER",
                kind="validation_waiver",
                decision="approved",
                reason="user accepts this bounded skip",
                decided_at=DECIDED_AT,
                expires_at="2099-01-01T00:00:00+00:00",
                nonce="B" * 32,
                check_id="unit",
                phase="local",
                environment="local",
            )
            rendered = authority.canonical_receipt_payload(waiver)
            for field in ("check_id", "phase", "subject", "environment", "max_gate"):
                self.assertIn(('"%s":' % field).encode("ascii"), rendered)
            del waiver["subject"]
            with self.assertRaises(GovernanceError):
                authority.canonical_receipt_payload(waiver)

    def test_kind_cannot_silently_ignore_another_kinds_binding(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task, _configured = initialized_root(root)
            with self.assertRaises(GovernanceError) as caught:
                authority.build_receipt(
                    root,
                    task,
                    review_id="REV-SCOPE-WITH-COMMIT",
                    kind="scope",
                    decision="approved",
                    reason="must not silently discard commit",
                    decided_at=DECIDED_AT,
                    nonce="C" * 32,
                    commit="a" * 40,
                )
            self.assertIn("does not accept bindings", str(caught.exception))


class OpenSshVerificationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.task, self.configured = initialized_root(self.root)
        unsigned = scope_receipt(self.root, self.task)
        self.signed = authority.attach_signature(unsigned, SIGNATURE, self.configured)

    def test_verify_uses_official_y_contract_and_scoped_allowed_signer(self) -> None:
        observed = {}

        def run_contract(command: list[str], **kwargs: object) -> subprocess.CompletedProcess:
            observed["command"] = command
            observed["payload"] = kwargs["input"]
            allowed = Path(command[command.index("-f") + 1]).read_text(encoding="ascii")
            observed["allowed"] = allowed
            return subprocess.CompletedProcess(command, 0, stdout=b"Good signature", stderr=b"")

        with (
            mock.patch("authority._resolve_ssh_keygen", return_value=Path("/usr/bin/ssh-keygen")),
            mock.patch("authority.subprocess.run", side_effect=run_contract),
        ):
            valid, reason = authority.verify_signed_receipt(self.signed, self.configured)
        self.assertTrue(valid, reason)
        self.assertEqual(["-Y", "verify"], observed["command"][1:3])
        self.assertIn("-I", observed["command"])
        self.assertIn("-n", observed["command"])
        self.assertIn('namespaces="material-governance-review"', observed["allowed"])
        self.assertEqual(authority.canonical_receipt_payload(self.signed), observed["payload"])

    def test_tampering_is_rejected_before_or_by_openssh(self) -> None:
        changed = dict(self.signed)
        changed["reason"] = "attacker changed the approved meaning"
        with mock.patch("authority.subprocess.run") as run:
            valid, reason = authority.verify_signed_receipt(changed, self.configured)
        self.assertFalse(valid)
        self.assertIn("payload digest", reason)
        run.assert_not_called()

        changed["signature"] = dict(changed["signature"])
        changed["signature"]["payload_sha256"] = authority.receipt_payload_digest(changed)
        with (
            mock.patch("authority._resolve_ssh_keygen", return_value=Path("/usr/bin/ssh-keygen")),
            mock.patch(
                "authority.subprocess.run",
                return_value=subprocess.CompletedProcess([], 255, stdout=b"", stderr=b"invalid"),
            ),
        ):
            valid, reason = authority.verify_signed_receipt(changed, self.configured)
        self.assertFalse(valid)
        self.assertIn("verification failed", reason)

    def test_wrong_namespace_identity_or_key_cannot_self_authorize(self) -> None:
        wrong_namespace = make_authority(namespace="other-material-governance-review")
        wrong_identity = dict(self.configured)
        wrong_identity["identity"] = "other-material-project-owner"
        wrong_key = make_authority(fill=b"B")
        for configured in (wrong_namespace, wrong_identity, wrong_key):
            with self.subTest(configured=configured):
                valid, reason = authority.verify_signed_receipt(self.signed, configured)
                self.assertFalse(valid)
                self.assertTrue(
                    "does not match" in reason or "namespace must" in reason,
                    reason,
                )

    def test_missing_tool_and_missing_signature_fail_closed(self) -> None:
        with mock.patch(
            "authority._resolve_ssh_keygen",
            side_effect=GovernanceError("OpenSSH unavailable"),
        ):
            valid, reason = authority.verify_signed_receipt(self.signed, self.configured)
        self.assertFalse(valid)
        self.assertIn("unavailable", reason)

        unsigned = dict(self.signed)
        del unsigned["signature"]
        valid, reason = authority.verify_signed_receipt(unsigned, self.configured)
        self.assertFalse(valid)
        self.assertIn("missing signature", reason)

        with self.assertRaises(GovernanceError) as caught:
            authority.attach_signature(
                {key: value for key, value in self.signed.items() if key != "signature"},
                SIGNATURE.replace("ZmFr", "签名"),
                self.configured,
            )
        self.assertIn("ASCII", str(caught.exception))


class SignedImportTests(unittest.TestCase):
    def _successful_verifier(self):
        return (
            mock.patch("authority._resolve_ssh_keygen", return_value=Path("/usr/bin/ssh-keygen")),
            mock.patch(
                "authority.subprocess.run",
                return_value=subprocess.CompletedProcess([], 0, stdout=b"Good signature", stderr=b""),
            ),
        )

    def test_verified_import_is_atomic_and_never_overwrites(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task, configured = initialized_root(root)
            signed = authority.attach_signature(scope_receipt(root, task), SIGNATURE, configured)
            first, second = self._successful_verifier()
            with first, second:
                destination = authority.import_signed_receipt(root, signed)
            self.assertTrue(destination.is_file())
            self.assertEqual("REV-SIGNED", read_json(destination)["review_id"])

            first, second = self._successful_verifier()
            with first, second:
                effective, reason = find_effective_review(root, task)
            self.assertIsNotNone(effective, reason)
            self.assertEqual("REV-SIGNED", effective["review_id"])

            first, second = self._successful_verifier()
            with first, second, self.assertRaises(GovernanceError) as caught:
                authority.import_signed_receipt(root, signed)
            self.assertIn("already exists", str(caught.exception))
            self.assertEqual("REV-SIGNED", read_json(destination)["review_id"])

    def test_nonce_replay_under_another_review_id_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task, configured = initialized_root(root)
            first_receipt = authority.attach_signature(
                scope_receipt(root, task, "REV-FIRST", NONCE), SIGNATURE, configured
            )
            second_receipt = authority.attach_signature(
                scope_receipt(root, task, "REV-SECOND", NONCE), SIGNATURE, configured
            )
            first, second = self._successful_verifier()
            with first, second:
                authority.import_signed_receipt(root, first_receipt)
            first, second = self._successful_verifier()
            with first, second, self.assertRaises(GovernanceError) as caught:
                authority.import_signed_receipt(root, second_receipt)
            self.assertIn("nonce was already imported", str(caught.exception))
            self.assertFalse((root / "project-control" / "reviews" / "REV-SECOND.json").exists())

    def test_cross_repository_binding_is_rejected_even_with_valid_signature(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task, configured = initialized_root(root)
            changed = scope_receipt(root, task)
            changed["source_repository"] = "git@github.com:attacker/material.git"
            signed = authority.attach_signature(changed, SIGNATURE, configured)
            with self.assertRaises(GovernanceError) as caught:
                authority.import_signed_receipt(root, signed)
            self.assertIn("another source repository", str(caught.exception))

    def test_receipt_for_noncurrent_task_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task, configured = initialized_root(root)
            signed = authority.attach_signature(scope_receipt(root, task), SIGNATURE, configured)
            other = base_task(status="DRAFT")
            other["task_id"] = "GOV-OTHER"
            write_json(root / "project-control" / "tasks" / "GOV-OTHER.json", other)
            write_json(root / "project-control" / "current-task.json", {"task_id": "GOV-OTHER"})
            with self.assertRaises(GovernanceError) as caught:
                authority.import_signed_receipt(root, signed)
            self.assertIn("current task", str(caught.exception))

    def test_payload_loader_requires_exact_canonical_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "repo"
            external = Path(temporary) / "external"
            external.mkdir()
            task, configured = initialized_root(root)
            receipt = scope_receipt(root, task)
            payload = external / "receipt.json"
            signature = external / "receipt.json.sig"
            payload.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
            signature.write_text(SIGNATURE, encoding="ascii")
            with self.assertRaises(GovernanceError) as caught:
                authority.load_signed_receipt(payload, signature, configured)
            self.assertIn("exact canonical", str(caught.exception))


class ReviewCtlSignedFlowTests(unittest.TestCase):
    def test_prepare_defaults_to_exact_stdout_and_requires_reviewed_public_key(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task, _configured = initialized_root(root)
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                result = reviewctl.main([
                    "prepare", task["task_id"], "--review-id", "REV-PREPARE",
                    "--decision", "approved", "--reason", "approve exact scope",
                    "--decided-at", DECIDED_AT, "--nonce", NONCE,
                    "--root", str(root),
                ])
            self.assertEqual(0, result)
            parsed = json.loads(output.getvalue())
            self.assertEqual("REV-PREPARE", parsed["review_id"])
            self.assertNotIn("signature", parsed)

            repository_output = root / "receipt-to-sign.json"
            with contextlib.redirect_stderr(io.StringIO()):
                result = reviewctl.main([
                    "prepare", task["task_id"], "--review-id", "REV-LOCAL-FILE",
                    "--decision", "approved", "--reason", "must remain external",
                    "--decided-at", DECIDED_AT, "--nonce", "D" * 32,
                    "--output", str(repository_output), "--root", str(root),
                ])
            self.assertEqual(2, result)
            self.assertFalse(repository_output.exists())

            task_without_key = base_task(status="DRAFT")
            del task_without_key["review_authority"]
            initialize_root(root / "missing", task_without_key, approved=False)
            error = io.StringIO()
            with contextlib.redirect_stderr(error):
                result = reviewctl.main([
                    "prepare", task_without_key["task_id"], "--review-id", "REV-DENIED",
                    "--decision", "approved", "--reason", "no trust anchor",
                    "--root", str(root / "missing"),
                ])
            self.assertEqual(2, result)
            self.assertIn("review_authority is absent", error.getvalue())

    def test_signed_import_files_must_stay_outside_the_repository(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task, _configured = initialized_root(root)
            with contextlib.redirect_stderr(io.StringIO()):
                result = reviewctl.main([
                    "import-signed",
                    "--payload", str(root / "payload.json"),
                    "--signature", str(root / "payload.json.sig"),
                    "--root", str(root),
                ])
            self.assertEqual(2, result)
            self.assertEqual([], list((root / "project-control" / "reviews").glob("REV-*.json")))

    def test_child_process_cannot_forge_unsigned_record(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task, _configured = initialized_root(root)
            command = [
                sys.executable,
                "-B",
                str(GOVERNANCE_DIR / "reviewctl.py"),
                "record",
                task["task_id"],
                "--decision",
                "approved",
                "--approver",
                "user",
                "--reason",
                "forged child process",
                "--confirmation-source",
                "fake-tty",
                "--review-id",
                "REV-FORGED",
                "--root",
                str(root),
                "--json",
            ]
            completed = subprocess.run(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=dict(os.environ, USER="user", REVIEW_APPROVER="user"),
                timeout=10,
                check=False,
            )
            self.assertEqual(2, completed.returncode)
            self.assertIn(b"LEGACY_RECORD_DISABLED", completed.stderr)
            self.assertFalse((root / "project-control" / "reviews" / "REV-FORGED.json").exists())


if __name__ == "__main__":
    unittest.main()
