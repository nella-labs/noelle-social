from pathlib import Path
import subprocess
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[1]
ENTRYPOINTS = ("update-x-graphql-ids.sh", "verify-x-graphql.sh")


class RetiredGraphqlMaintenance(unittest.TestCase):
    def exercise(self, entrypoint, with_constants):
        with tempfile.TemporaryDirectory(prefix="retired-x-graphql-") as name:
            root = Path(name)
            scripts = root / "scripts"
            scripts.mkdir()
            for filename in ENTRYPOINTS:
                (scripts / filename).write_bytes((REPO / "scripts" / filename).read_bytes())
            target = root / "apps/x-intern/src/lib/x-graphql-ids.ts"
            original = b'UserTweets: {\nqueryId: "old"\n},\nUserByScreenName: {\nqueryId: "old"\n},\nCreateTweet: {\nqueryId: "old"\n},\n'
            if with_constants:
                target.parent.mkdir(parents=True)
                target.write_bytes(original)
            trace = root / "commands.log"
            trace.write_text("")
            fixture = root / "inert.sh"
            fixture.write_text(r"""
record() { printf '%s\n' "$*" >> "$GRAPHQL_TEST_TRACE"; }
gcloud() { record gcloud "$@"; printf 'inert-cookie'; }
curl() { record curl "$@"; printf '200'; }
jq() { record jq "$@"; }
pnpm() { record pnpm "$@"; }
git() { record git "$@"; }
ssh() { record ssh "$@"; }
rsync() { record rsync "$@"; }
""")
            env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(root),
                   "TMPDIR": str(root), "BASH_ENV": str(fixture),
                   "GRAPHQL_TEST_TRACE": str(trace)}
            result = subprocess.run(["bash", str(scripts / entrypoint)], env=env,
                                    input="A" * 22 + "\n" + "B" * 22 + "\n" + "C" * 22 + "\n",
                                    text=True, capture_output=True, timeout=5)
            self.assertNotEqual(result.returncode, 0, "Retired maintenance must not report success")
            self.assertIn("is retired", result.stderr)
            self.assertIn("docs/x-graphql-capture.md", result.stderr)
            self.assertEqual(trace.read_text(), "", "Retirement must precede provider and transport calls")
            self.assertEqual(target.read_bytes() if target.exists() else None,
                             original if with_constants else None,
                             "Retired commands must not create or modify pinned constants")

    def test_retirement_precedes_legacy_transport_and_file_mutation(self):
        for entrypoint in ENTRYPOINTS:
            with self.subTest(entrypoint=entrypoint):
                self.exercise(entrypoint, True)

    def test_retirement_does_not_require_the_removed_constants(self):
        for entrypoint in ENTRYPOINTS:
            with self.subTest(entrypoint=entrypoint):
                self.exercise(entrypoint, False)


if __name__ == "__main__":
    unittest.main()
