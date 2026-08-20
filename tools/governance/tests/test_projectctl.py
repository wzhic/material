from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

GOVERNANCE_DIR = Path(__file__).resolve().parents[1]
if str(GOVERNANCE_DIR) not in sys.path:
    sys.path.insert(0, str(GOVERNANCE_DIR))

import projectctl
from core import GovernanceError


class ProjectCtlTests(unittest.TestCase):
    def test_generators_are_exact_non_shell_argv(self) -> None:
        commands = projectctl.generator_commands()
        self.assertEqual("npm", commands[0][0])
        self.assertIn("electron-app@latest", commands[0])
        self.assertIn("--template=webpack-typescript", commands[0])
        self.assertEqual(("uv", "init", "--app", "--python", "3.12", "backend"), commands[1])
        self.assertEqual("uvicorn[standard]", commands[2][-1])
        self.assertTrue(all(isinstance(command, tuple) for command in commands))

    def test_generated_caches_and_nested_git_are_excluded(self) -> None:
        ignored = set(projectctl.scaffold_ignore_names())
        self.assertTrue(
            {".git", ".venv", "node_modules", "out", ".electron-cache", ".npm-cache"}.issubset(ignored)
        )

    def test_desktop_scaffold_uses_ignored_project_electron_cache(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            desktop = Path(temporary)
            (desktop / "forge.config.ts").write_text(
                "const config = {\n  packagerConfig: {\n    asar: true,\n  },\n};\n",
                encoding="utf-8",
            )
            (desktop / ".gitignore").write_text(".webpack\nout\n", encoding="utf-8")

            projectctl._configure_desktop_scaffold(desktop)
            projectctl._configure_desktop_scaffold(desktop)

            config = (desktop / "forge.config.ts").read_text(encoding="utf-8")
            ignored = (desktop / ".gitignore").read_text(encoding="utf-8")
            self.assertEqual(1, config.count(".electron-cache"))
            self.assertEqual(1, ignored.splitlines().count(".electron-cache"))
            self.assertEqual(1, ignored.splitlines().count(".npm-cache"))

    def test_runtime_audit_uses_non_mutating_production_scope(self) -> None:
        source = Path(projectctl.__file__).read_text(encoding="utf-8")
        self.assertIn('"audit", "--omit=dev", "--audit-level=high"', source)
        self.assertNotIn("audit fix", source)

    def test_working_git_probe_skips_broken_candidate(self) -> None:
        responses = [
            mock.Mock(returncode=1, stderr="license blocked"),
            mock.Mock(returncode=0, stderr=""),
        ]
        with (
            mock.patch.object(projectctl, "_git_candidates", return_value=["/broken/git", "/portable/git"]),
            mock.patch.object(projectctl.subprocess, "run", side_effect=responses),
        ):
            self.assertEqual(Path("/portable"), projectctl._working_git_directory())

    def test_partial_targets_are_never_overwritten(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / projectctl.CLIENT_TARGET).mkdir(parents=True)
            with self.assertRaises(GovernanceError):
                projectctl._preflight(root)


if __name__ == "__main__":
    unittest.main()
