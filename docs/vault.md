# Vaults and writing context

A vault supplies tenant writing evidence: voice examples, notes and supporting facts. Retrieval belongs to the configured tenant. An absent or unavailable vault returns no anchors rather than borrowing another workspace's material.

## Local context

Native installations can read Markdown from `NOELLE_VAULT_DIR`. `init --vault-dir` saves that folder in the runtime configuration. `--voice-dirs` selects comma separated relative paths used for voice examples.

The shared `KnowledgeBase` in `packages/runtime/src/knowledgeBase.ts` owns local file ingestion and ranking. Its local backend watches configured Markdown and ranks chunks lexically. Dense retrieval and reranking are optional provider-backed lanes; their switches and failure behavior are documented in [grounded drafting](grounded-drafting.md).

Choose context deliberately. A connected folder is readable by the worker process, so it should contain only material intended for that workspace. Keep private credentials, unrelated documents and runtime logs outside it.

## Remote context

`NOELLE_KB_BACKEND` selects the worker backend and takes precedence over the legacy `NOELLE_NELLA_BACKEND` setting.

| Backend | Configuration |
| --- | --- |
| `local` | `NOELLE_VAULT_DIR` |
| `gcs` | `NOELLE_VAULT_BUCKET` plus the explicit workspace/storage mapping |
| `http` | `NELLA_BASE_URL`, explicit `NELLA_WORKSPACE` and the tenant's Nella API key |

The profile registry resolves remote context through the organization's active vault mapping. Missing, inactive or unavailable mappings produce an empty anchor set. A deployment must configure its own workspace; there is no shared personal fallback.

See [the Nella contract](nella-contract.md) for HTTP retrieval. GCS-backed retrieval runs in-process and does not require the external Nella service.

## Storage and uploads

Tenant vault records and storage prefixes belong to the database schema. Preserve the tenant prefix when uploading or listing objects. Never let a client choose another organization's storage location without an ownership check.

The dashboard's context onboarding and upload paths operate on the current organization. Files used as voice anchors should represent the connected account; factual claims still need relevant evidence. A voice example does not establish that a factual claim is true.

## Optional mirror daemon

`apps/vault-daemon` is a standalone opt-in Markdown mirror for configured local and remote storage. It is not needed for local filesystem retrieval. Configure the folder, bucket and tenant prefix explicitly before running it.

The mirror defaults to additive behavior: local removal does not imply remote deletion. Pruning requires an explicit option. Validate a new configuration against a disposable bucket or prefix before pointing it at existing context.

## Failure handling

Retrieval can return no anchors when context is missing or a remote service is unavailable. Generators must retain that uncertainty and avoid unsupported personal claims. Retrieval availability is separate from account access, approval and publication gates.

See [setup](self-host.md), [writing structure](writing-structure.md), [the database contract](database-contract.md) and [testing](testing.md).
