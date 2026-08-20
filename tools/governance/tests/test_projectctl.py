from pathlib import Path
import sys
import tempfile
import unittest

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
        self.assertTrue({".git", ".venv", "node_modules", "out"}.issubset(ignored))

    def test_existing_targets_are_never_overwritten(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / projectctl.CLIENT_TARGET).mkdir(parents=True)
            with self.assertRaises(GovernanceError):
                projectctl._preflight(root)


if __name__ == "__main__":
    unittest.main()
