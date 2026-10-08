# Public release

A public snapshot should contain the product source, lockfile, migrations, tests and useful technical docs. Private research captures and local tool settings are excluded by an explicit path list.

From a reviewed commit, run:

```sh
node --test scripts/export-public-snapshot.test.mjs
node scripts/export-public-snapshot.mjs /tmp/noelle-public-snapshot HEAD
```

The exporter creates a new directory outside the source checkout. It reads the exact Git commit, so untracked files and uncommitted edits are omitted. It does not initialize a repository, change visibility, rewrite history or publish files.

The exclusion list covers `.private/`, `.claude/`, `.agents/`, `tasks/`, `docs/superpowers/`, `docs/research/`, `.mcp.json` and the private workflow guide `docs/multi-session.md`. Product source is retained. Selected symlinks fail the export for explicit review.

Two installation-specific artifacts are also omitted: the standalone `style-eval.mjs` experiment and the personal lead-flow LaunchAgent template. They have no runtime entry-point references outside their own files. The generic watchdog and its tests remain included.

Inspect the exported inventory and run a secrets scanner before publication. A clean credential scan does not establish that captured content is public. Validate the frozen dependency install and [local setup](self-host.md) against a disposable database.

Publishing a new snapshot and making an existing repository public expose different material. Forward cleanup does not remove old commits, issue bodies, review comments or Actions logs. Keep a private archive when releasing a new public snapshot without that history.
