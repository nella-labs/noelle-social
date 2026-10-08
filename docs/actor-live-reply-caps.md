# Browser actor reply caps

The LinkedIn and X actor panels show confirmed browser replies from today's
`linkedin_activity` comments and `x_activity` replies. LinkedIn DMs and X's
separate official API sends are not counted as browser replies. The panels read
the API every 15 seconds and update immediately after a cap edit. Discovery's
five active lead slots are a separate counter.

The cap is saved on `agent_instances.actuator_daily_reply_cap` (migration 0110).
`GET` and `POST /api/actuator/reply-cap?platform=linkedin|x&instanceId=<uuid>`
require the actuator token and verify the instance's org and role. `POST` accepts
`{"cap": 0..500}`; `null` restores the server default. The queue and pre-submit
claim both use this saved cap, so changing it also affects replies already
waiting in the actor pool. A failed API read or write never changes the cap.

With no saved override, LinkedIn has no reply-only cap. Its existing optional
`NOELLE_LINKEDIN_DAILY_WRITE_CAP` still limits combined comments and DMs. X
uses `NOELLE_X_ACTUATOR_DAILY_WRITE_CAP` (default 40, or the configured local
value) until an override is saved. The X official API sender keeps its own
`x_api_daily_write_cap`. Actor pacing, switches, quiet hours, challenge gates,
review, and duplicate protection still apply.

The Options page retains every stored setting. Its old `caps.comments` field
limits scheduled run planning; continuous discovery and drains use the server
reply cap in the panel.
