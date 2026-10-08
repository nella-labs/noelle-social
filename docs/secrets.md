# Credential ownership

Each installation supplies its own provider, social account, database and signing credentials. Keep those values outside source control.

## Local installations

The CLI reads provider credentials from its process environment during initialization and writes private runtime configuration beneath `NOELLE_HOME`, which defaults to `~/.noelle`. The environment file and signing secrets belong to that installation.

`packages/secrets` owns secret names, environment mapping, retrieval and bounded caching. Consumers request a secret through that owner. The CLI configures the local environment source; configured cloud deployments may use their secret manager.

Provider credentials do not establish social account permission. Each platform reader or sender has its own account access contract. Do not reuse one organization's account credentials in another organization.

## Application boundaries

- Database reads and writes keep verified user and organization membership checks.
- Worker writes use their existing authenticated boundary.
- Actuator commands use their scoped credentials and sender gates.
- Local operator mode is intended for a private installation.
- Hosted session mode needs its own stable cookie signing secrets and authenticated users.

The local environment example documents configuration names. Blank values and fictional examples are intentional. Public session settings such as an anonymous client key do not grant access to private database rows by themselves.

## Rotation

Revoke or rotate a credential when it may be exposed. Update the configured secret source, then use the managed runtime path to reload affected services. Confirm access using a bounded read or explicit status response. Do not send a social message merely to test replacement credentials.

Cookie signing secret rotation invalidates proofs created with the old secret. Plan for affected sessions to authenticate again. Provider token rotation follows that provider's current procedure.

## Source and logs

Never commit environment files, private keys, session cookies, database dumps, runtime state, personal working notes or unredacted captures. Review tracked files and repository history before changing repository visibility.

Secret scanners can miss unusual formats and can flag harmless identifiers or fixtures. Triage findings without printing values. A clean scan does not prove that private data or operational context is safe to publish.

Read [SECURITY.md](../SECURITY.md) for reporting and incident handling.
