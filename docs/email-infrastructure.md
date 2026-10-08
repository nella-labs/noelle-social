# Email infrastructure — SES + Listmonk on GCP

How Noelle sends every email — auth (Supabase), transactional, and marketing —
through Amazon SES with Listmonk on a GCP VM as the marketing campaign manager.

Written after the first SES production-access request was rejected. The goal
of this doc is to do **all** the technical setup before reapplying, so the
reviewer has nothing to flag.

---

## 1. Architecture at a glance

```
                        ┌──────────────────────────────┐
  Supabase Auth ───────►│                              │
  (magic links, etc)    │                              │
                        │      Amazon SES (us-east-1)  │──► recipient
  Listmonk (GCP VM) ───►│      verified sender domains │
  (marketing campaigns) │                              │
                        └──────────────┬───────────────┘
                                       │
                                       ▼
                            SNS topic (bounces, complaints, deliveries)
                                       │
                                       ▼
                   HTTPS webhook → Listmonk + Supabase suppression table
```

**Three streams, three sender identities, three reputation buckets:**

| Stream | From | DKIM domain | Volume | Unsub? |
|---|---|---|---|---|
| Auth (Supabase) | `auth@trynoelle.com` | `trynoelle.com` | Low, per-user | No |
| Transactional product mail | `noelle@trynoelle.com` | `trynoelle.com` | Low, per-user | No |
| Marketing (Listmonk) | `news@mail.trynoelle.com` | `mail.trynoelle.com` | High, batch | **Yes** |

Splitting the marketing domain from the apex protects auth deliverability. A
bad campaign on `mail.trynoelle.com` can't tank password-reset delivery on
`trynoelle.com`.

---

## 2. Up-front decisions

| Decision | Value | Why |
|---|---|---|
| SES region | `us-east-1` | Cheapest, highest deliverability, largest IP pool |
| Apex sender domain | `trynoelle.com` | For auth + transactional |
| Marketing sender domain | `mail.trynoelle.com` | Isolated reputation |
| Custom MAIL FROM (apex) | `bounces.trynoelle.com` | Aligns envelope sender with header `From:` for DMARC |
| Custom MAIL FROM (mail) | `bounces.mail.trynoelle.com` | Same, for marketing stream |
| DMARC reporting mailbox | `dmarc@trynoelle.com` | Receive aggregate reports; forward to dmarcian or postmark for parsing |
| Listmonk host | Dedicated GCP VM, `e2-small`, Debian 12, us-central1 | Isolated from `noelle-vm-0` so a blocklist DB issue can't take down agent workers |
| Listmonk public URL | `listmonk.trynoelle.com` | Behind Caddy with auto-TLS |
| Bounce webhook URL | `https://listmonk.trynoelle.com/webhooks/ses` | Custom handler we'll add |

---

## 3. Cloudflare DNS records (do this first)

The records below cover **everything**: domain verification, DKIM, SPF,
DMARC, MAIL FROM, and (later) the Listmonk vhost. Apply them now even before
clicking through SES — most propagate within 60s on Cloudflare.

> ⚠️ For `mail.trynoelle.com` we'll get the actual DKIM CNAME targets from
> the SES console after creating the identity in §5. Records marked
> `<placeholder>` get filled in then.

### 3.1 Apex: `trynoelle.com`

| Type | Name | Content | TTL | Proxy |
|---|---|---|---|---|
| TXT | `@` | `v=spf1 include:amazonses.com ~all` | Auto | DNS only |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:dmarc@trynoelle.com; ruf=mailto:dmarc@trynoelle.com; fo=1; adkim=s; aspf=s` | Auto | DNS only |
| MX | `bounces` | `10 feedback-smtp.us-east-1.amazonses.com` | Auto | DNS only |
| TXT | `bounces` | `v=spf1 include:amazonses.com ~all` | Auto | DNS only |
| CNAME | `<ses-dkim-1>._domainkey` | `<placeholder>.dkim.amazonses.com` | Auto | DNS only |
| CNAME | `<ses-dkim-2>._domainkey` | `<placeholder>.dkim.amazonses.com` | Auto | DNS only |
| CNAME | `<ses-dkim-3>._domainkey` | `<placeholder>.dkim.amazonses.com` | Auto | DNS only |

**Don't proxy any of these through Cloudflare** (the orange cloud). SES SMTP
auth and DNS-based mail records must hit the real records, not Cloudflare's
proxy.

### 3.2 Marketing subdomain: `mail.trynoelle.com`

| Type | Name | Content | TTL | Proxy |
|---|---|---|---|---|
| TXT | `mail` | `v=spf1 include:amazonses.com ~all` | Auto | DNS only |
| MX | `bounces.mail` | `10 feedback-smtp.us-east-1.amazonses.com` | Auto | DNS only |
| TXT | `bounces.mail` | `v=spf1 include:amazonses.com ~all` | Auto | DNS only |
| CNAME | `<ses-dkim-1>._domainkey.mail` | `<placeholder>.dkim.amazonses.com` | Auto | DNS only |
| CNAME | `<ses-dkim-2>._domainkey.mail` | `<placeholder>.dkim.amazonses.com` | Auto | DNS only |
| CNAME | `<ses-dkim-3>._domainkey.mail` | `<placeholder>.dkim.amazonses.com` | Auto | DNS only |

DMARC at the apex covers all subdomains because of `adkim=s; aspf=s` strict
alignment — no separate `_dmarc.mail` record needed.

### 3.3 Receiving the `dmarc@trynoelle.com` mailbox

If you don't already host mail for `trynoelle.com`, the cheapest path is
Cloudflare Email Routing → forward `dmarc@` to your personal Gmail. Free,
zero config beyond the Cloudflare UI. (Cloudflare will add its own MX records
under the apex — make sure SES's MX on `bounces.` and `bounces.mail.` stays
intact; they're on different subdomains so they coexist.)

### 3.4 Listmonk vhost

| Type | Name | Content | TTL | Proxy |
|---|---|---|---|---|
| A | `listmonk` | `<GCP VM external IP>` | Auto | **Proxied OK** |

Listmonk's UI behind Cloudflare proxy is fine — the SMTP traffic to SES goes
outbound from the VM, not through Cloudflare.

---

## 4. AWS account prep

1. Use a dedicated IAM user for the Listmonk SMTP credentials. **Never** use
   root keys.
2. Create an SNS topic for bounces/complaints (we'll wire it up in §6).
3. Confirm you're in `us-east-1` for everything — SES region must match the
   SMTP endpoint your Listmonk and Supabase config point at.

---

## 5. SES domain identities + DKIM

Run for both domains: `trynoelle.com` and `mail.trynoelle.com`.

```
SES console → Configuration → Identities → Create identity
  - Identity type: Domain
  - Domain: trynoelle.com
  - Use a custom MAIL FROM domain: bounces.trynoelle.com
  - MAIL FROM behavior on MX failure: UseDefaultValue (safer)
  - DKIM: Easy DKIM, RSA 2048
  - Publish DNS records: NO (we're on Cloudflare, not Route 53)
```

SES will show you **three DKIM CNAME records**. Paste them into Cloudflare
(§3.1 placeholders). Within 5–60 minutes the identity verification status
flips to `Verified` and DKIM goes `Successful`.

Repeat for `mail.trynoelle.com` with MAIL FROM `bounces.mail.trynoelle.com`.

**Don't skip the Custom MAIL FROM.** Without it the envelope sender is
`amazonses.com`, which fails strict DMARC alignment — and that's exactly
the kind of red flag a SES reviewer notices when they preview a test send.

---

## 6. SNS topic for bounces + complaints

1. SNS console → Create topic, type **Standard**, name `noelle-ses-events`.
2. SES console → Configuration → Configuration sets → Create:
   - Name: `noelle-default`
   - Reputation tracking: enabled
   - Event destinations → Add destination → SNS → select `noelle-ses-events`
   - Events to publish: **Bounce, Complaint, Delivery, Reject, Rendering failure**
3. Back in SNS → `noelle-ses-events` → Create subscription:
   - Protocol: HTTPS
   - Endpoint: `https://listmonk.trynoelle.com/webhooks/ses`
   - Raw message delivery: **enabled**
4. The subscription stays `Pending confirmation` until Listmonk's webhook
   handler responds with the confirmation URL. We add that handler in §9.

Make `noelle-default` the **default configuration set** for both identities
in SES (Identity → Configuration set tab → Set as default).

---

## 7. SMTP credentials for Listmonk

```
SES console → SMTP settings → Create SMTP credentials
  - IAM user name: noelle-listmonk-smtp
```

AWS creates an IAM user with the `AmazonSesSendingAccess` policy attached and
hands you SMTP username + password **once**. Save them in GCP Secret Manager:

```bash
gcloud secrets create listmonk-ses-smtp-user --data-file=- <<< "AKIA..."
gcloud secrets create listmonk-ses-smtp-pass --data-file=- <<< "BPx..."
```

(Per CLAUDE.md, all Noelle secrets live in GCP Secret Manager — no `.env`
files with real values.)

**SMTP endpoint** for `us-east-1`: `email-smtp.us-east-1.amazonaws.com:587`
(STARTTLS). Port 465 (TLS Wrapper) also works.

---

## 8. GCP VM for Listmonk

**Architecture summary (this doc) — operational details and exact commands
live in `infra/listmonk/README.md` (next to the compose/Caddy files).**

The Listmonk stack runs on a dedicated GCP VM, separate from `noelle-vm-0`
(the agents VM) so a blocklist DB issue or campaign-time CPU spike can't take
down agent workers.

| Field | Value |
|---|---|
| GCP project | `noelle-agents` |
| VM name | `noelle-listmonk` |
| Zone | `us-central1-a` |
| Machine | `e2-small`, Debian 12, 20GB disk, OS Login |
| Public URL | `https://listmonk.trynoelle.com` |
| Reverse proxy | Caddy (auto-TLS via Let's Encrypt) |
| Postgres | `postgres:16`, data in `/opt/listmonk/pgdata` |
| Listmonk version | Pinned in `infra/listmonk/docker-compose.yml` |
| Firewall | `allow-listmonk-https` (tcp:80,tcp:443 on tag `https-server`) |
| Postgres password | GCP Secret Manager: `listmonk-postgres-password` |

Caddy provisions a Let's Encrypt cert automatically. With the Cloudflare A
record from §3.4 proxied through Cloudflare, set Cloudflare SSL mode to
**Full (strict)** — Caddy serves the real cert on origin, Cloudflare presents
its edge cert to browsers.

**For deploy / upgrade / rotation / logs**, see `infra/listmonk/README.md`.
The `docker-compose.yml` and `Caddyfile` in `infra/listmonk/` are the
single source of truth for what's running on the VM.

---

## 9. Configure Listmonk

Open `https://listmonk.trynoelle.com` and run the first-time setup wizard.

### 9.0 Users (admin + dashboard API)

Listmonk v6 needs two users in the `users` table — one for UI login and
one for the Noelle dashboard's HTTP Basic API calls. Both reference a
`Super Admin` role with wildcard `{*}` permissions.

Provisioned 2026-05-20 (use these; don't recreate):

| User | type | Purpose | Secret name in GCP |
|---|---|---|---|
| `admin` | `user` (UI session login) | https://listmonk.trynoelle.com admin UI | `listmonk-admin-password` |
| `noelle-dashboard` | `api` (HTTP Basic for `/api/*`) | dashboard's `lib/listmonk.ts` reads | `listmonk-dashboard-api-token` |

Vercel envs `LISTMONK_USER` / `LISTMONK_PASSWORD` resolve to the API
user + token (not the UI admin). If you ever wipe the Listmonk Postgres
volume, you'll need to re-create both rows — Listmonk v6's first-run
setup endpoint at `/admin/setup` isn't reachable, so seed via SQL:

```bash
# UI admin user — password is bcrypt-hashed
HASH=$(htpasswd -nbBC10 admin '<plaintext>' | cut -d: -f2 | sed 's/^\$2y\$/\$2a\$/')
docker compose exec -T postgres psql -U listmonk -d listmonk <<SQL
  INSERT INTO roles (type, permissions, name)
    VALUES ('user'::role_type, ARRAY['*']::text[], 'Super Admin');
  INSERT INTO users (username, password_login, password, email, name,
                     type, user_role_id, status)
    VALUES ('admin', TRUE, '$HASH', 'you@example.com', 'You',
            'user'::user_type,
            (SELECT id FROM roles WHERE name='Super Admin' LIMIT 1),
            'enabled'::user_status);
SQL

# API user — token stored as plaintext (Listmonk does plaintext compare)
TOKEN=$(openssl rand -hex 24)
docker compose exec -T postgres psql -U listmonk -d listmonk <<SQL
  INSERT INTO users (username, password_login, password, email, name,
                     type, user_role_id, status)
    VALUES ('noelle-dashboard', FALSE, '$TOKEN',
            'dashboard@trynoelle.com', 'Noelle Dashboard',
            'api'::user_type,
            (SELECT id FROM roles WHERE name='Super Admin' LIMIT 1),
            'enabled'::user_status);
SQL

# After inserting, restart the listmonk container — it caches users in
# memory and won't see the new row until reboot.
docker compose restart listmonk
```

### 9.1 SMTP → SES

Listmonk admin → Settings → SMTP:

| Field | Value |
|---|---|
| Host | `email-smtp.us-east-1.amazonaws.com` |
| Port | `587` |
| Auth protocol | LOGIN |
| Username | from `gcloud secrets versions access` on `listmonk-ses-smtp-user` |
| Password | from `gcloud secrets versions access` on `listmonk-ses-smtp-pass` |
| TLS | STARTTLS |
| HELO hostname | `listmonk.trynoelle.com` |
| Max connections | 10 (sandbox), 50+ after production approval |
| Max retries | 2 |

Send the built-in test mail to yourself to confirm.

### 9.2 Default settings

- **From email**: `Noelle <news@mail.trynoelle.com>`
- **Root URL**: `https://listmonk.trynoelle.com`
- **Notification emails**: send admin alerts to a real human inbox
- **Enable double opt-in**: ON (this is non-negotiable for the SES reapply)

### 9.3 Templates

- Upload `supabase/templates/announcement.html` as the default campaign template.
- The placeholder syntax in that file is already Listmonk-compatible
  (Sprig/Go templates). `{{ UnsubscribeURL }}` and `{{ MessageURL }}` are
  Listmonk built-ins.

### 9.4 SES bounce webhook handler

Listmonk's built-in SES bounce parser was added in v4. Settings → Bounces:

- Enable bounce processing: ON
- SES notifications: ON
- Webhook URL: `/webhooks/ses` (under the same Listmonk host)
- Auto-blocklist after: 2 hard bounces, 1 complaint

The SNS subscription from §6 will auto-confirm the first time SNS POSTs the
confirmation token to this URL.

### 9.5 List structure

Two lists, both **opt-in**:

1. `Noelle product updates` — single-opt-in is OK for users who signed up
   inside the product (we have proof in our DB). Use double-opt-in for any
   list captured from the marketing site.
2. `Noelle launch waitlist` — double-opt-in, public signup form.

---

## 9.6 Dashboard integration (`/admin/email`)

The Noelle dashboard's admin area has an **Email** tab (URL still
`/admin/broadcasts`, label renamed in §AdminTabs) that's the operational
pane for everything in this doc — so an admin never has to bounce between
this Markdown, the AWS console, and Listmonk's admin UI to know if mail
is healthy.

It renders three sections, top-to-bottom:

1. **Mail infrastructure** — two side-by-side status cards:
   - **Amazon SES** — region, daily quota, max send rate, sent in last
     24h, account health (sandbox vs production, sending enabled). Pulled
     live from `ses:GetAccount` via `apps/app/src/lib/ses.ts`. Read-only
     IAM creds (`AWS_SES_ACCESS_KEY_ID` / `AWS_SES_SECRET_ACCESS_KEY`)
     live in Vercel project env — do **not** reuse the Listmonk SMTP IAM
     user (its policy is send-only and lacks `GetAccount`).
   - **Listmonk** — version, subscriber / list / campaign / lifetime-
     messages-sent counts. Pulled live from `/api/config` and
     `/api/dashboard/counts` via `apps/app/src/lib/listmonk.ts`.
2. **Recent campaigns** — the last 8 Listmonk campaigns with status,
   sent/total, age, and a deep-link to the Listmonk admin row.
3. **Send a broadcast** — the existing composer (test send or campaign).

Each section degrades independently — if Listmonk is down, the SES card
still renders and vice versa. Missing credentials show a hint card with
the exact env var names to set, never an exception.

**Provisioned (2026-05-20)** — already live in production. Don't re-run
unless rotating:

| Where | Value |
|---|---|
| AWS IAM user | `noelle-ses-readonly` (account `151963020654`) |
| AWS inline policy | `SesReadOnly` — allows `ses:GetAccount`, `ses:GetSendQuota`, `ses:GetSendStatistics`, `sesv2:GetAccount`, `sesv2:GetSendQuota` |
| AWS access key id | mirrored to GCP Secret Manager `noelle-ses-readonly-access-key-id` |
| AWS secret access key | mirrored to GCP Secret Manager `noelle-ses-readonly-secret-access-key` |
| Vercel project | `noelle-app` (team `nella-labs`), set for production + preview + development |

To re-provision from scratch:

```bash
# Create a read-only IAM user
aws iam create-user --user-name noelle-ses-readonly
aws iam put-user-policy --user-name noelle-ses-readonly \
  --policy-name SesReadOnly --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": [
        "ses:GetAccount", "ses:GetSendQuota", "ses:GetSendStatistics",
        "sesv2:GetAccount", "sesv2:GetSendQuota"
      ],
      "Resource": "*"
    }]
  }'
aws iam create-access-key --user-name noelle-ses-readonly
# → mirror to GCP Secret Manager and Vercel env (AWS_SES_ACCESS_KEY_ID /
#   AWS_SES_SECRET_ACCESS_KEY, all three target environments).
```

If creds are absent the SES card shows a placeholder + a deep-link to the
