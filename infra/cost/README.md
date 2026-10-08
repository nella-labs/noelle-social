# infra/cost — pause the managed GCP footprint

Noelle is being run **local-only** (the self-host CLI on a personal VM). The
managed Vercel + GCP deployment has no users, so its always-on compute is pure
cost. These scripts **pause** that footprint to ~$0 and bring it back when
needed. Everything here is **reversible** — nothing is deleted, so all data and
config survive on the stopped instances' disks.

## What gets paused

| Resource | Project | Action | Running cost | Paused cost |
|---|---|---|---|---|
| `noelle-vm-0` (agents VM) | `noelle-agents` | stop | ~$13/mo | boot disk only (cents) |
| `noelle-listmonk` (email VM) | `noelle-agents` | stop | ~$13/mo | boot disk only (cents) |
| `noelle-db` (Cloud SQL PG16) | `noelle-agents` | activation-policy NEVER | ~$50–60/mo | storage only (cents) |

Net: the non-AI GCP bill drops from ~$75–90/mo to a few cents of stopped-disk
storage.

## What is NOT touched

- **AI usage is untouched.** Vertex AI is pay-per-use (you only pay when an
  agent calls it); there's nothing always-on to stop. Bedrock is AWS, not GCP.
- **GCP Secret Manager** — negligible (<$1/mo for a handful of secrets), left as
  is so the self-host box can still pull provider creds by name.
- **Nothing is deleted.** Stopped VMs keep their disks; the stopped Cloud SQL
  keeps its data + automated backups. `resume-managed.sh` restores full service.

## Usage

```bash
infra/cost/status.sh           # show running/stopped state of all three
infra/cost/pause-managed.sh    # stop everything (reversible) → ~$0
infra/cost/resume-managed.sh   # bring everything back up
```

Requires `gcloud` authed against `noelle-agents` (the operator account).

## Note on the dashboard while paused

With Cloud SQL stopped, the managed `app.trynoelle.com` dashboard and
`api.trynoelle.com` will error (they have no DB). That's expected and fine —
all real work happens on the self-host VM, which has its own local Postgres and
is completely independent of this managed footprint.
