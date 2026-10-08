from pathlib import Path
import os
import subprocess
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[1]


class RetiredApiVmDeployment(unittest.TestCase):
    def test_retired_uploader_stops_before_external_effects(self):
        with tempfile.TemporaryDirectory(prefix="retired-api-vm-") as name:
            root = Path(name)
            trace = root / "commands.log"
            trace.write_text("")
            fixture = root / "inert.sh"
            fixture.write_text(r"""
record() { printf '%s\n' "$*" >> "$API_VM_TEST_TRACE"; }
pnpm() { record pnpm "$@"; }
ssh() { record ssh "$@"; }
rsync() { record rsync "$@"; }
sleep() { record sleep "$@"; }
curl() { record curl "$@"; printf '200'; }
cat() { record cat "$@"; printf '{"ok":true}'; }
""")
            env = {**os.environ, "BASH_ENV": str(fixture),
                   "API_VM_TEST_TRACE": str(trace),
                   "NOELLE_VM_HOST": "inert.invalid", "NOELLE_VM_USER": "fixture"}
            result = subprocess.run(["bash", str(REPO / "scripts/deploy-api-vm.sh")],
                                    cwd=REPO, env=env, text=True,
                                    capture_output=True, timeout=5)
            self.assertNotEqual(result.returncode, 0,
                                "An obsolete uploader must not report deployment success")
            self.assertEqual(trace.read_text(), "", "Retirement must precede external effects")
            self.assertIn("noelle sync", result.stderr)
            self.assertIn("docs/architecture.md", result.stderr)


if __name__ == "__main__":
    unittest.main()
