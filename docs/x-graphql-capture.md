# X transport diagnostics

X workers no longer use manually maintained GraphQL query IDs. Diagnose the active transport and its configured account or provider connection.

## Transport owners

| Operation | Current owner |
| --- | --- |
| Discovery reads | The configured Apify token pool and `@noelle/x-apify`. Discovery does not require X session cookies. |
| API reply and original-post workers | The official X API clients in `packages/x-client`, with the configured OAuth access and publication gates. |
| Cookie-backed GraphQL operations | The shared Bird adapter in `packages/x-client`. Bird owns query ID lookup and refresh. The manual reply API retains this adapter as a fallback. |

Bird can use cached or bundled query IDs and refresh after a 404. The former constants file is removed. The `update-x-graphql-ids.sh` and `verify-x-graphql.sh` entrypoints are retired; they stop before changing files or making requests.

## Inspect the installation

From a built repository, use the managed runtime commands:

```sh
node apps/cli/dist/index.js status
node apps/cli/dist/index.js health
node apps/cli/dist/index.js logs noelle-discovery
node apps/cli/dist/index.js logs noelle-send
```

These process names come from the shared service manifest. Workers are optional, and `noelle-send` is excluded from autonomous startup. A missing or stopped process alone does not prove an account authentication failure. Use the configured installation's logs and [runtime checks](runbook.md) to identify the sender actually handling the request.

## Follow the failing lane

- For missing discovery results, inspect the discovery lane, selected sources or watchlist, Apify connection pool and recorded worker error.
- For a cookie-backed GraphQL failure, inspect the shared client error and account connection. Updating the removed constants cannot repair this transport.
- For API authentication failures, check the configured X account connection and its OAuth credentials. Credentials belong to the installation; keep them out of source, screenshots and issue reports.
- For missing publication, inspect the actual sender's enabled lane, write access and budget. Browser actuation, API replies and original posts have separate execution paths.
- Preserve account halt and rate-limit states. Reconcile an unknown write outcome before retrying so a transport error does not create a duplicate.

See [worker and publication setup](self-host.md#workers-and-publication), [credential ownership](secrets.md), [reply transport](reply-actuation-strategy.md) and [runtime operation](runbook.md). A passing health check does not verify provider credentials or prove publication.
