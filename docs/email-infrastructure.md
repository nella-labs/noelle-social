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
