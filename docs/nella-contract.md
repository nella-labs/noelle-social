# Nella retrieval contract

Nella is an optional external context service. Noelle also supports local Markdown and in-process GCS retrieval, so a new installation does not need Nella to start.

## Ownership

`packages/runtime` owns the HTTP client and knowledge-base adapter. Platform workers configure their retrieval backend and workspace. The profile registry resolves context from the organization's vault mapping.

Remote retrieval requires an explicit workspace. The workspace and API key must belong to the intended organization. Missing or inactive vault mappings return an empty anchor set. Do not substitute a deployment-wide personal workspace.

## Configuration

Set `NOELLE_KB_BACKEND=http`, `NELLA_BASE_URL` and `NELLA_WORKSPACE` for the configured worker. `NOELLE_KB_BACKEND` takes precedence over the legacy `NOELLE_NELLA_BACKEND` option. Resolve the tenant's Nella key through the existing secrets owner, outside tracked files.

The backend adapter fixes its workspace at construction and passes it with every search. The MCP context tool requires an explicit workspace argument. Search results carry bounded text and source information for writing evidence; they are not instructions to change runtime policy.

## Search and health

The runtime client owns the request/response shape, timeout and result normalization. Read that client before adding a caller rather than duplicating HTTP requests in a platform worker. Adapter health performs a bounded search for the configured workspace.

Do not document a proposed remote endpoint as an implemented Noelle dependency. Service capabilities and plan access must be verified against the operator's actual Nella installation.

## Failure behavior

Retrieval failures return no usable anchors at the registry boundary. Drafting may continue through its documented fallback, retaining uncertainty about unsupported facts. A retrieval error must never loosen tenant ownership, account consent or publication gates.

Use fake clients to test workspace isolation, timeouts and malformed responses. Live connection checks should read only and avoid printing keys or returned private context.

See [vaults](vault.md), [grounded drafting](grounded-drafting.md), [secrets](secrets.md) and [testing](testing.md).
