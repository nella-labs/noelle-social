from pathlib import Path
import base64, fnmatch, json, os, re, subprocess, tempfile, unittest

REPO = Path(os.environ.get("NOELLE_DEPLOY_TEST_REPO", Path(__file__).resolve().parents[2]))
WORK = os.environ.get("NOELLE_DEPLOY_TEST_WORK")
ROOTS = ["@noelle/api-vm", "@noelle/x-intern", "@noelle/reddit-intern"]


def selection(filters):
    args = ["pnpm", "list", "-r", "--depth=-1", "--json"]
    for value in filters:
        args.extend(["--filter", value])
    return json.loads(subprocess.check_output(args, cwd=REPO, text=True))


def exercise(fail_build=False, *, origin="https://github.com/nella-labs/noelle.git",
             repository_url=None, checkout="existing", skip_fetch=True, ref="fixture-ref"):
    with tempfile.TemporaryDirectory(prefix="deploy-fixture-", dir=WORK) as name:
        fixture = Path(name)
        root = fixture / "checkout"
        if checkout != "fresh":
            root.mkdir()
        if checkout == "existing":
            (root / ".git").mkdir()
        elif checkout == "worktree":
            (root / ".git").write_text("gitdir: inert-fixture\n")
        script = fixture / "infra/agents-vm/deploy.sh"
        script.parent.mkdir(parents=True)
        script.write_text((REPO / "infra/agents-vm/deploy.sh").read_text())
        token = fixture / "scripts/github-app-token.sh"
        token.parent.mkdir()
        token.write_text("#!/bin/bash\nprintf 'inert-installation-token'\n")
        token.chmod(0o755)
        capture = fixture / "commands.jsonl"
        capture.write_text("")
        envfile = fixture / "inert-env.sh"
        envfile.write_text(r"""
log_command() { python3 -c 'import json,os,sys;open(os.environ["DEPLOY_COMMANDS"],"a").write(json.dumps(sys.argv[1:])+"\n")' "$@"; }
sudo() {
  log_command sudo "$@"
  if [[ "$1" == "-iu" ]]; then shift 2; "$@"
  elif [[ "$1" == "-u" ]]; then shift 2; "$@"
  elif [[ "$1" == "mv" ]]; then mv "$2" "$3"
  elif [[ "$1" == "cmp" ]]; then return 0
  elif [[ "$1" == "systemctl" && "$2" == "is-active" ]]; then printf 'active\n'
  else return 0; fi
}
git() {
  log_command git "$@"
  if [[ "$1" == clone || "$1" == fetch ]]; then
    [[ "${GIT_CONFIG_COUNT:-}" == 1 && "${GIT_CONFIG_KEY_0:-}" == http.https://github.com/.extraheader &&
       "${GIT_CONFIG_VALUE_0:-}" == "AUTHORIZATION: basic $(printf 'x-access-token:inert-installation-token' | base64 | tr -d '\n')" ]] || return 19
  fi
  if [[ "$*" == *"remote get-url origin" ]]; then printf '%s\n' "$FIXTURE_ORIGIN"
  elif [[ "$1" == clone ]]; then mkdir -p "${*: -1}/.git"
  elif [[ "$*" == *"rev-parse"* ]]; then printf 'fixture-head\n'; fi
}
pnpm() { log_command pnpm "$@"; if [[ "${SIMULATE_BUILD_FAILURE:-0}" == 1 && "${*: -1}" == build ]]; then return 17; fi; }
curl() { log_command curl "$@"; return 0; }
hostname() { printf 'inert-fixture\n'; }
""")
        env = {**os.environ, "BASH_ENV": str(envfile), "DEPLOY_COMMANDS": str(capture),
               "REPO_DIR": str(root), "SKIP_FETCH": str(int(skip_fetch)),
               "FIXTURE_ORIGIN": origin, "SIMULATE_BUILD_FAILURE": str(int(fail_build))}
        env.pop("NOELLE_REPOSITORY_URL", None)
        if repository_url is not None:
            env["NOELLE_REPOSITORY_URL"] = repository_url
        args = ["bash", str(script)] + ([] if ref is None else [ref])
        run = subprocess.run(args, env=env,
                             text=True, capture_output=True, timeout=10)
        commands = [json.loads(line) for line in capture.read_text().splitlines()]
        return run, commands


class DeploymentRepositorySelection(unittest.TestCase):
    def assert_remote(self, expected, *, persisted=None, **options):
        run, commands = exercise(skip_fetch=False, **options)
        self.assertEqual(run.returncode, 0, run.stderr)
        remote = [row for row in commands if row[0] == "git" and row[1] in ("clone", "fetch")]
        self.assertTrue(remote)
        self.assertEqual({row[-2] for row in remote}, {expected})
        updates = [row[-1] for row in commands if row[0] == "git" and "set-url" in row]
        self.assertEqual(set(updates), {persisted or expected})
        output = run.stdout + run.stderr + json.dumps(commands)
        self.assertNotIn("inert-installation-token", output)
        self.assertNotIn(base64.b64encode(b"x-access-token:inert-installation-token").decode(), output)
        return commands

    def test_explicit_repository_overrides_existing_origin(self):
        self.assert_remote("https://github.com/example/growth.git",
                           repository_url="https://github.com/example/growth.git")

    def test_existing_private_origin_is_preserved_and_read_as_owner(self):
        commands = self.assert_remote("https://github.com/nella-labs/noelle.git")
        self.assertTrue(any(row[:4] == ["sudo", "-u", "noelle-api", "git"] and
                            row[-3:] == ["remote", "get-url", "origin"] for row in commands))

    def test_existing_ssh_origin_uses_https_auth_without_changing_origin(self):
        self.assert_remote("https://github.com/example/growth.git",
                           origin="git@github.com:example/growth.git",
                           persisted="git@github.com:example/growth.git")

    def test_existing_worktree_origin_is_preserved(self):
        self.assert_remote("https://github.com/nella-labs/noelle.git", checkout="worktree")

    def test_fresh_and_legacy_checkout_use_public_fallback(self):
        for checkout in ("fresh", "legacy"):
            with self.subTest(checkout=checkout):
                self.assert_remote("https://github.com/nella-labs/noelle-social.git", checkout=checkout)

    def test_fresh_clone_accepts_explicit_ssh_repository(self):
        self.assert_remote("https://github.com/example/growth.git", checkout="fresh",
                           repository_url="git@github.com:example/growth.git",
                           persisted="git@github.com:example/growth.git")

    def test_unspecified_ref_follows_the_selected_remote_default(self):
        commands = self.assert_remote("https://github.com/nella-labs/noelle-social.git",
                                      checkout="fresh", ref=None)
        self.assertEqual(next(row[-1] for row in commands if row[:2] == ["git", "fetch"]), "HEAD")

    def test_unsafe_override_and_saved_origin_stop_before_remote_or_build_calls(self):
        unsafe = ["https://inert-secret@github.com/example/repo.git",
                  "https://github.com.evil.invalid/example/repo.git",
                  "https://example.invalid/example/repo.git",
                  "http://github.com/example/repo.git",
                  "https://github.com/example/../other.git",
                  "https://github.com/example/repo.git?token=inert-secret",
                  "https://github.com/example/repo.git\n",
                  "git@github.com:example/repo.git;touch injected",
                  "ssh://git@github.com/example/repo.git",
                  "https://github.com/example/repo.git/extra"]
        for value in unsafe:
            for source in ("repository_url", "origin"):
                with self.subTest(value=value, source=source):
                    run, commands = exercise(skip_fetch=False, **{source: value})
                    self.assertNotEqual(run.returncode, 0)
                    self.assertNotIn("inert-secret", run.stdout + run.stderr)
                    self.assertFalse(any(row[0] == "pnpm" or
                        (row[0] == "git" and row[1] in ("clone", "fetch", "reset")) or
                        (row[0] == "sudo" and "systemctl" in row) for row in commands))


class DeploymentWorkspaceBoundary(unittest.TestCase):
    def test_actual_deploy_build_selects_current_workspace_dependencies(self):
        run, commands = exercise()
        self.assertEqual(run.returncode, 0, run.stderr)
        build = next(row[1:] for row in commands if row[0] == "pnpm" and row[-1] == "build")
        filters = [build[i + 1] for i, value in enumerate(build) if value == "--filter"]
        selected = {row["name"] for row in selection(filters)}
        required = {row["name"] for row in selection([root + "..." for root in ROOTS])}
        self.assertEqual(required - selected, set(), "Actual build selection omits runtime dependencies")
        self.assertNotIn("@noelle/app", selected)

    def test_each_deployed_workspace_source_change_triggers_the_workflow(self):
        paths = re.findall(r'^\s+- "([^"]+)"$', (REPO / ".github/workflows/agents-vm-deploy.yml").read_text(), re.M)
        missing = []
        for row in selection([root + "..." for root in ROOTS]):
            source = str(Path(row["path"]).relative_to(REPO)) + "/src/index.ts"
            if not any(fnmatch.fnmatchcase(source, pattern) for pattern in paths):
                missing.append(source)
        self.assertEqual(missing, [], "Deployed workspace changes must trigger deployment")

    def test_actual_build_failure_stops_before_secret_refresh_or_service_restart(self):
        run, commands = exercise(True)
        self.assertEqual(run.returncode, 17)
        self.assertFalse(any(row[0] == "sudo" and ("systemctl" in row or any("pull-secrets.sh" in item for item in row)) for row in commands))

    def test_healthy_inert_deploy_keeps_existing_health_and_worker_gates(self):
        run, commands = exercise()
        self.assertEqual(run.returncode, 0)
        self.assertTrue(any(row[0] == "curl" for row in commands))
        self.assertTrue(any(row[0] == "sudo" and "is-active" in row for row in commands))


if __name__ == "__main__":
    unittest.main()
