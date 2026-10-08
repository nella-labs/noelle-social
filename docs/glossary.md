# Glossary

## Product and workspace

**Noelle** is the social growth workspace in this repository. It brings discovery, drafting, review, publication and measurements together for X, LinkedIn, Reddit and video channels.

**Organization / workspace** is a tenant represented by `noelle.organizations`. Account connections, profiles, content and approvals belong to an organization. The UI uses workspace when speaking to the operator.

**Operator** is the person using the installation. Local authentication uses the configured operator identity. Hosted session mode verifies users and organization membership.

**Platform profile** is a configured social capability instance in `noelle.agent_instances`. Vega handles X, Lyra LinkedIn, Orion Reddit and Nova video. Profiles have their own status, configuration, budgets and work lanes. See [the profile model](agent-model.md).

## Social workflow

**Lead** is a discovered conversation or account that may fit a profile's audience and objective.

**Watchlist** is an explicit set of accounts or topics chosen for discovery.

**Draft** is proposed writing. It does not prove approval, scheduling or publication.

**Approval** records the review state for a proposed action. Changing an approval does not bypass the sender's account, consent, budget or safety checks.

**Lane** is a worker responsibility such as discovery, classification, drafting or sending. Lane configuration, profile status and whether the worker process is running are separate states.

**Actuator** is a browser extension that executes supported approved actions through the configured account session. See [the actuation strategy](reply-actuation-strategy.md).

**Receipt** is evidence of an external action or its result. An uncertain response must be reconciled before repeating an action.

## Context and budgets

**Vault** is tenant writing context: Markdown notes, voice examples and supporting evidence. It can be supplied from a configured local folder or supported remote storage. See [vaults](vault.md).

**Nella** is an optional external retrieval service. Its workspace must be explicitly configured for the tenant. See [the retrieval contract](nella-contract.md).

**Bucket** identifies a spend category for a provider call. **Cap** is a configured budget ceiling at the bucket, organization or profile level. Provider usage and social action limits are distinct.

**Engine** is the configured drafting or classification backend. Available providers and fallback behavior depend on the installation and profile configuration; see [setup](self-host.md).
