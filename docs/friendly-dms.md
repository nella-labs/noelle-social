# Friendly DMs

Lyra and Vega can draft friendly messages for people already known to Noelle. On either agent's page, open **Pipeline → Friendly DMs** and turn its switch **On**. This switch runs DMs separately: it works while replies are paused, with other workers off, and during a reply goal. You do not need to start the reply pipeline. Use **Review Friendly DMs** to open the approval inbox.

| Platform | Maximum new drafts per day |
| --- | --- |
| LinkedIn | 40 |
| X | 15 |

Each organization shares its platform allowance across agent instances. Days reset at midnight in America/Bogota. A failed or skipped attempt also consumes a slot that day, so the lane can produce fewer messages than the ceiling. Restarts and concurrent ticks do not reset the count.

The writer reads saved posts, person profiles, CRM notes and recorded exchanges. Each source type has room in the context, so a long post history cannot crowd out notes or conversation history. Discovery and Apify feed that information separately. Starting this lane does not request more profile information, posts, or searches.

Most drafts ask for nothing. They respond to one specific detail in a person's writing or experience. A small share can ask one question about an actual experience. The question policy draws on [The Mom Test](https://www.momtestbook.com/); a friendly message does not have to become an interview.

A saved post from the last seven days is required. Older posts and profile summaries cannot supply the detail used to start a new DM.

Drafts avoid pitches, product links, meeting requests, invented familiarity and generic praise. A separate model check compares each message with the saved evidence. Unsupported drafts get one retry, then are skipped. A generated profile alone cannot substantiate a particular post or experience.

The writer and evidence judge use Noelle's shared writing rules. Stock frames such as “the part I keep thinking about” and “curious how” trigger a rewrite. Short reactions and direct questions remain allowed. Companion, requested, VIP and follow-up DMs also check their own wording; a failed rewrite never restores the rejected message. A `dm_voice_check` records the wording check separately from reply `verifier_meta` and does not imply an evidence verdict.

Every accepted draft goes to the existing approval inbox with the source excerpts. Review it before sending. LinkedIn's DM send permission remains an explicit approval; X uses its existing manual DM flow. The lane never attaches an auto-send instruction.

A pending or sent DM blocks another first message to that person, including messages from other instances in the organization. Queued reservations remain blocked even if the operator later skips the draft. Failed or skipped generation attempts can retry on a later day. Unfinished reservations are retained after a crash to avoid a duplicate when the outcome is uncertain.

The opt-in setting is `lane_config.dms.relationship_dms_enabled`. Existing companion, intro and on-demand DM controls keep their current behavior. Apply migration `0098_relationship_dm_reservations.sql` with the normal deployment before enabling the lane.
