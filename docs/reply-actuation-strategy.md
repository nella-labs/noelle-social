# Reply actuation strategy

Noelle separates selection and writing from external publication. The platform workers discover conversations, classify fit and prepare drafts. Review and sender owners enforce the final account, consent and action checks.

## Transport owners

Browser actuation for X, LinkedIn and Reddit lives in the corresponding `apps/*-actuator` packages. Shared debugger input, composer handling and connection primitives live in `packages/actuator-cdp`. Platform locators stay with the platform that owns their DOM contract.

Original posts and browser replies may use different send paths. Confirm the current sender and configured account before changing a transport. A provider accepting a queued request is not evidence that the platform published it.

## Required gates

- Resolve the organization, platform profile and connected account before claiming work.
- Require the enabled publication lane and the configured account's consent.
- Preserve approval, cap, quiet-window, kill-switch and challenge checks at their existing owners.
- Recheck ownership and mutable gates immediately before the external action.
- Halt on account restrictions or challenges. Reconcile an uncertain action before retrying it.
- Record the result with an external receipt when available. Keep pending, failed and confirmed states distinct.

Fresh installations keep publication disabled. Profile activation, running worker processes and sender permission are separate decisions. See [the profile model](agent-model.md) and [setup](self-host.md).

## Browser execution

The actuator uses the configured browser session. Keep the target tab available, the debugger connection intact and account access private. Use one active sender host per account; [the second-host guide](linkedin-actuator-second-host.md) describes the monitoring boundary.

Shared composer cleanup matters after a failed action. Leaving unsent text can block later navigation with a browser dialog. `packages/actuator-cdp` owns the input sequence and verification used to clear that state.

Pacing and action limits belong to the account's configured policy. Browser transport does not guarantee account safety or compliance with a platform's current rules. Operators must verify the platform's current access and automation requirements before enabling publication.

## Validation and evidence

Use existing DOM fixtures, fake provider clients and connection-boundary tests to validate locators, gates and receipts. Do not post live content to prove a build or connection works.

For an intentionally published action, verify both the platform result and Noelle's activity record. Inspect challenge, skip and cap signals through the protected health routes and operator UI. Missing measurement data must remain unknown.

See [LinkedIn actuation](linkedin-actuator.md), [Chrome Bridge](chrome-bridge.md), [writing structure](writing-structure.md) and [testing](testing.md).
