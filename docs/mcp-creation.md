# Creating content through Noelle MCP

The local skill and MCP server instructions tell clients to call Noelle's
creation tools. Workers generate the text and run the existing reviewers.
Clients should show those results, including failures or missing reviews.
Assistant-written text and a chat critique are not Noelle generation or review.

## Posts

Use `noelle_add_post_idea` for a supplied premise, or `noelle_trigger_ideation`
when ideas are requested. Ideation reads saved posts and the operator's sent
replies; it does not call Apify. Discovery and profiling can keep feeding the
saved context independently. Poll `noelle_get_ideation_request` with its
`requestId` to retrieve that worker run's ideas and source references. An error
does not authorize inventing ideas in chat and inserting them as a workaround.

Submit `noelle_generate_post` with an actual returned `ideaId`, the
requested `platforms`, optional `guidance` and optional `waitSeconds` (up to 45).
Keep `request_id`, then call `noelle_get_post` with that `requestId`.

The request records its platforms and requires the post verifier even when
recurring verification is disabled. Drafts carry the generation request ID.
Polling returns only that generation's drafts and recorded verifier results.
A revision is a new guided generation after the current request finishes.

## Replies

Find an existing saved X or LinkedIn lead. Call `noelle_request_reply` with
`leadId`, a stable `requestKey` and optional `instructions`. Retrieve progress
with `noelle_get_reply_request_status` using the same lead and request key.
Retrying the same key reads the same request; a revision uses a new key.

Requests can run while recurring reply generation is paused. They use Noelle's
reply drafter and verifier. Resulting drafts carry the request key and require
human review, including when the agent normally sends replies automatically.
Creating a request does not change the agent's lanes or sender settings.

## Friendly DMs

Call `noelle_request_friendly_dms` with `platform` (`linkedin` or `x`), optional
`personId` or `handle`, and `count`. Keep `requestId` and poll
`noelle_list_friendly_dms`. Results include full bodies and the DM judge verdict.

The lane uses saved person, profile, post and interaction evidence. It does not
start discovery or call Apify. Most messages ask nothing; occasional questions
concern real past experience. No pitches, invented familiarity or forced coffee
invitations. One-off and recurring requests share the daily caps: 40 LinkedIn,
15 X. `noelle_set_friendly_dms` changes only the recurring Friendly DM switch.

Approval list/detail output labels classifier scores as **lead score**. DM **writing check** results describe that body's wording check only; missing checks show as unavailable. The Friendly DM tool supplies its separate evidence judge verdict. A public reply's review is never presented as a DM review.

## Result handling

A bounded wait may finish before the worker. Keep polling the same request;
do not submit the creation write again. Report a failed or absent review as
such. If progress stops, inspect worker runs and report the actual error.
Creating or reviewing content does not authorize sending or publishing.

On a phone, use the connected Noelle app in ChatGPT. Native-app availability
depends on the account and client; verify that connection before declaring it
unsupported or requiring a browser. A working Cortex connection on the same
account is a useful reference for comparing the setup. The connection calls
these same tools through the existing private tunnel.
After changing the MCP tools, rebuild the local server,
reconnect the managed tunnel, refresh the Noelle plugin's metadata, and verify
an actual remote call. Localhost health alone does not prove that connection.
