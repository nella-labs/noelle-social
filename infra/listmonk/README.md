# Listmonk — Noelle marketing campaign manager

Self-hosted [Listmonk](https://listmonk.app) running on a dedicated GCP VM.
Handles all marketing / product-update email for Noelle. SMTP relay is AWS SES
(`us-east-1`). See `docs/email-infrastructure.md` for the architecture.

## Where it lives

| Field | Value |
|---|---|
| GCP project | `noelle-agents` |
| VM name | `noelle-listmonk` |
| Zone | `us-central1-a` |
| Machine | `e2-small`, Debian 12, 20GB disk |
| Public URL | https://listmonk.trynoelle.com |
| Reverse proxy | Caddy (auto-TLS via Let's Encrypt) |
| Listmonk version | `v6.1.0` (pinned in `docker-compose.yml`) |
| Postgres | `postgres:16`, data in `/opt/listmonk/pgdata` on the VM |

The VM is **separate** from `noelle-vm-0` (the agents VM) on purpose — a
Listmonk crash or blocklist DB issue must not be able to take down agent
workers.

## Secrets

All secrets live in GCP Secret Manager. **Never** put them in a `.env` file
committed to the repo.

| Secret | Purpose |
|---|---|
| `listmonk-postgres-password` | Postgres user password inside the compose stack |
| `listmonk-ses-smtp-user` | SES SMTP IAM access key ID (entered in Listmonk UI) |
| `listmonk-ses-smtp-pass` | SES SMTP password (entered in Listmonk UI) |
| `listmonk-admin-password` | UI admin login at `https://listmonk.trynoelle.com` (username `admin`) |
| `listmonk-dashboard-api-token` | API token for the `noelle-dashboard` API user — read by `apps/app` as `LISTMONK_PASSWORD` |
| `noelle-ses-readonly-access-key-id` | AWS access key for the SES-status read-only IAM user; mirrored to Vercel as `AWS_SES_ACCESS_KEY_ID` |
| `noelle-ses-readonly-secret-access-key` | AWS secret for the same; mirrored to Vercel as `AWS_SES_SECRET_ACCESS_KEY` |

Fetch a secret:

```bash
gcloud secrets versions access latest --secret=listmonk-postgres-password
```

## SSH in

```bash
gcloud compute ssh noelle-listmonk --zone=us-central1-a --project=noelle-agents
```

OS Login is enabled, so use your normal Google account; no SSH key management.

## First-time deploy (already done)

If you ever rebuild from scratch, the sequence is:

```bash
# On the VM
sudo apt update && sudo apt install -y curl ca-certificates

# Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker

# Caddy
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy

# App dir
sudo mkdir -p /opt/listmonk && sudo chown $USER /opt/listmonk
cd /opt/listmonk

# Pull this repo's infra/listmonk/{docker-compose.yml,Caddyfile} onto the VM
# (gcloud compute scp from your laptop, or paste via SSH heredoc)

# Caddy
sudo cp Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy

# Postgres password from Secret Manager
export POSTGRES_PASSWORD=$(gcloud secrets versions access latest \
  --secret=listmonk-postgres-password --project=noelle-agents)

# Init the DB then start
docker compose run --rm listmonk ./listmonk --install --yes
docker compose up -d
```

## Start / stop / status

All commands run from `/opt/listmonk` on the VM. **Always export
`POSTGRES_PASSWORD` first** — compose will refuse to start without it:

```bash
export POSTGRES_PASSWORD=$(gcloud secrets versions access latest \
  --secret=listmonk-postgres-password --project=noelle-agents)

docker compose ps                # status
docker compose up -d             # start
docker compose stop              # stop (keeps data)
docker compose down              # stop + remove containers (keeps volumes)
docker compose logs -f listmonk  # tail Listmonk logs
docker compose logs -f postgres  # tail Postgres logs
```

Caddy runs as a systemd service, independent of compose:

```bash
sudo systemctl status caddy
sudo systemctl reload caddy      # after editing /etc/caddy/Caddyfile
journalctl -u caddy -f           # tail Caddy logs (TLS issuance, etc)
```

## Upgrade Listmonk

1. Bump the `listmonk/listmonk:vX.Y.Z` tag in `infra/listmonk/docker-compose.yml`
   in the repo. Pick the highest non-prerelease tag from
   https://github.com/knadh/listmonk/releases.
2. Commit the bump on a branch + PR.
3. SCP the updated compose file to the VM:
   ```bash
   gcloud compute scp infra/listmonk/docker-compose.yml \
     noelle-listmonk:/opt/listmonk/docker-compose.yml \
     --zone=us-central1-a --project=noelle-agents
   ```
4. On the VM:
   ```bash
   cd /opt/listmonk
   export POSTGRES_PASSWORD=$(gcloud secrets versions access latest \
     --secret=listmonk-postgres-password --project=noelle-agents)
   docker compose pull listmonk
   docker compose up -d listmonk
   docker compose logs -f listmonk  # confirm clean start
   ```

Listmonk runs DB migrations automatically on boot.

## Rotate the Postgres password

This is more involved because Postgres needs the password reset inside the
running container *and* both Listmonk and Postgres need to be restarted with
the new env var.

```bash
# 1. Generate a new password and add a new secret version
openssl rand -hex 24 | gcloud secrets versions add listmonk-postgres-password \
  --data-file=- --project=noelle-agents

# 2. On the VM, change the password inside Postgres
gcloud compute ssh noelle-listmonk --zone=us-central1-a --project=noelle-agents
cd /opt/listmonk
NEW=$(gcloud secrets versions access latest \
  --secret=listmonk-postgres-password --project=noelle-agents)
docker compose exec postgres psql -U listmonk -c \
  "ALTER USER listmonk WITH PASSWORD '$NEW';"

# 3. Restart the stack with the new password
export POSTGRES_PASSWORD=$NEW
docker compose down
docker compose up -d
```

Disable old secret versions in GCP once the new one is confirmed working.

## Rotate the SES SMTP credentials

1. AWS IAM console → delete the old SMTP user's access key.
2. SES console → SMTP Settings → Create SMTP credentials → save the new
   username/password.
3. Add them as new secret versions:
   ```bash
   gcloud secrets versions add listmonk-ses-smtp-user --data-file=- \
     --project=noelle-agents <<< "NEW_ACCESS_KEY_ID"
   gcloud secrets versions add listmonk-ses-smtp-pass --data-file=- \
     --project=noelle-agents <<< "NEW_SMTP_PASSWORD"
   ```
4. Listmonk UI → Settings → SMTP → paste the new values → Save → send the
   built-in test email.

No restart needed; Listmonk picks up SMTP config from the database.

## Rotate the dashboard API token

The Noelle dashboard authenticates as the `noelle-dashboard` API user
via HTTP Basic. To rotate:

```bash
NEW=$(openssl rand -hex 24)
echo -n "$NEW" | gcloud secrets versions add listmonk-dashboard-api-token \
  --data-file=- --project=noelle-agents

# Update the row in Listmonk's Postgres (plaintext for type='api' users)
gcloud compute ssh noelle-listmonk --zone=us-central1-a --project=noelle-agents \
  --command="cd /opt/listmonk && export POSTGRES_PASSWORD=\$(gcloud secrets versions access latest --secret=listmonk-postgres-password --project=noelle-agents) && sudo POSTGRES_PASSWORD=\"\$POSTGRES_PASSWORD\" docker compose exec -T postgres psql -U listmonk -d listmonk -c \"UPDATE users SET password='$NEW' WHERE username='noelle-dashboard';\" && sudo docker compose restart listmonk"

# Mirror to Vercel — required because the dashboard reads LISTMONK_PASSWORD
