# Noelle systemd units

Canonical copies of the systemd unit files that run on noelle-vm-0
(per the single-source-of-truth rule, D37). Deploy-time the rollout
script `rsync`s these to `/etc/systemd/system/` on the VM and reloads.

## Units

| Unit | Role |
|---|---|
| `noelle-api-vm.service` | `apps/api-vm` Hono process, port 18791, fronted by cloudflared. |
| `noelle-discovery@.service` | X discovery worker. Template (one instance per N). |
| `noelle-classifier@.service` | Gemini Flash classifier worker. Template. |
| `noelle-drafter@.service` | Codex drafter (replaces `noelle-vm-0-drafter@`). Template. |
| `noelle-send@.service` | X send worker. Template. |

The previous `noelle-vm-0-drafter@.service` is removed; the bootstrap section
below disables and removes it before enabling `noelle-drafter@`.

## EnvironmentFiles

Workers read non-secret config from files under `/etc/noelle/`:

- `/etc/noelle/api-vm.env` — `NODE_ENV=production`, `PORT=18791`, `GCP_PROJECT=noelle-agents`, etc.
- `/etc/noelle/db.env` — `NOELLE_DATABASE_URL` (composed from `noelle-postgres-app-password`).
- `/etc/noelle/worker.env` — `NOELLE_HMAC_SECRET`, `NELLA_API_KEY`, `X_COOKIE_CT0`, `X_COOKIE_AUTH_TOKEN`, `GEMINI_API_KEY`, plus `GCP_PROJECT`.

These files are regenerated at deploy time by `scripts/pull-secrets.sh`,
which resolves GCP Secret Manager → on-disk env. Per `docs/secrets.md` the
files are owned `root:noelle` mode `0640` so the service user can read
but not modify, and no shell history records the values.

## Bootstrap

```bash
# Once per host
sudo install -d -o noelle-api -g noelle-api /opt/noelle/api-vm /opt/noelle/x-intern /var/log/noelle
sudo install -d -m 0750 -o root -g noelle /etc/noelle

# Push code (CI deploy step):
rsync -a dist/ vm:/opt/noelle/api-vm/dist/

# Push secrets (CI deploy step, GCP SA-key-authenticated):
ssh vm 'sudo -u root /opt/noelle/api-vm/scripts/pull-secrets.sh'

# Install + start units:
rsync -a infra/systemd/ vm:/etc/systemd/system/
ssh vm sudo systemctl daemon-reload
ssh vm sudo systemctl enable --now noelle-api-vm.service
ssh vm sudo systemctl enable --now noelle-discovery@0 noelle-classifier@0 noelle-send@0
ssh vm sudo systemctl enable --now noelle-drafter@{0..3}
```

## Verify

```bash
ssh vm systemctl status noelle-api-vm
curl -sS https://api.trynoelle.com/health | jq
ssh vm journalctl -u 'noelle-discovery@*' -u 'noelle-classifier@*' -u 'noelle-drafter@*' -u 'noelle-send@*' --since '10 min ago' -n 50
```

The `/health` endpoint always returns 200 while the process is alive
(Cloudflare tunnel uses this as a liveness check). A separate
`/health/strict` may be added later that 503s on degraded components.
