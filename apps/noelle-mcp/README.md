# @noelle/mcp

Operate Noelle from an MCP client: create and review posts, replies and Friendly
DMs; inspect saved people and leads; manage agent settings and approvals.
Noelle's local workers generate the text and run the reviewers. The MCP returns
request progress, full drafts and recorded verdicts.

## Setup

Build from the repository root:

```bash
pnpm --filter @noelle/mcp build
```

Register `node /ABSOLUTE/PATH/TO/noelle/apps/noelle-mcp/dist/server.js` as a stdio
MCP server with `NOELLE_DATABASE_URL` pointing to the same local Postgres as the
app and workers, and `NOELLE_MCP_ORG` set to your org slug.

| Environment variable | Purpose |
| --- | --- |
| `NOELLE_DATABASE_URL` | Required local Postgres connection string. |
| `NOELLE_MCP_ORG` | Default org slug or UUID. Tools may accept an explicit org. |
| `NOELLE_MCP_READONLY` | `1` or `true` refuses writes. |
| `NOELLE_MCP_OPERATOR_SUB` | Operator ID recorded on mutations. |
| `NOELLE_MCP_STATEMENT_TIMEOUT_MS` | Query timeout; defaults to 8000 ms. |
| `NOELLE_MCP_CONNECT_TIMEOUT_S` | Connection timeout; defaults to 10 seconds. |
| `NOELLE_API_BASE_URL` | Optional local API delegation, usually `http://127.0.0.1:18791`. |
| `NOELLE_MCP_API_TOKEN` | Operator token for optional API delegation. |

API delegation can alternatively mint a token using
`NOELLE_SUPABASE_JWT_SECRET` and `NOELLE_MCP_OPERATOR_SUB`. Creation works through
the database-backed queues without API delegation.

## Creation and review

- Posts: `noelle_add_post_idea` → `noelle_generate_post` → `noelle_get_post`.
- Replies: `noelle_request_reply` → `noelle_get_reply_request_status`.
- Friendly DMs: `noelle_request_friendly_dms` → `noelle_list_friendly_dms`.

Keep the returned request ID and poll it. A queued request is still pending.
One-off requests do not enable recurring lanes. Reply requests require human
review; Friendly DMs use saved evidence and remain subject to the daily caps of
40 LinkedIn and 15 X. See [the workflow guide](../../docs/mcp-creation.md).

## Budget visibility

`noelle_budget_holds` reads unresolved calls for an org, with an optional agent
selector and pages of up to 100 rows. It separates recorded accounting from held
estimates and identifies the separate Codex pot. Copy the returned cursor exactly
to continue a page. The tool is read-only; status summaries use cached monthly accounting.

## Phone access

Connect this stdio server through the existing private Secure MCP Tunnel and
select the Noelle plugin in ChatGPT. The phone uses the same local workers and
data. The host and tunnel must stay running. After changing tools, rebuild,
reconnect the tunnel, refresh Noelle in ChatGPT's plugin settings, and verify a
remote call. Server instructions supply the workflow even without a local skill.

## Access and sending

This is an operator server with database access. Queries are scoped to the
selected org; the configured org is a default, not an authorization boundary.
Keep the connection private. Destructive tools require explicit confirmation.

Creating a draft does not send it. `noelle_send_draft` supports X: optional API
delegation submits the send request; the default path releases a pending reply
to the local browser actuator under existing sender gates. Read delivery status
before claiming it was posted. Other supported review actions remain available
in the local app.
