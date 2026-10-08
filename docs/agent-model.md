# Platform growth profiles

Noelle's public catalog contains four platform profiles: X, LinkedIn, Reddit and video. A profile groups a platform objective, supported workers, model routes, budgets and sender settings.

## Registry and instances

`packages/agents/src/registry` owns the manifests. Its public registry and role contract identify supported capabilities. `noelle.agent_instances` stores configured organization instances and their lane settings.

New installations seed the configured operator and flat platform profiles. Existing stored content and instance history remain associated with their original rows. Legacy management roles are archived by the migration path rather than used as public catalog entries.

## Responsibilities

| Owner | Responsibility |
| --- | --- |
| Registry manifest | Identity, description, default routes and capability declaration |
| Platform class | Supported tool and chat behavior |
| Instance settings | Objective, audience, selected routes, budget and lane configuration |
| Worker app | Discovery, classification, drafting, profiling and platform specific work |
| Shared runtime | Accounting, tenant context, approval transitions and bounded external operations |
| Platform sender | Permission, reservations, write result and delivery evidence |

A profile being configured does not imply that its worker processes are running. Instance status and lane enable flags remain separate inputs to admission. Publication consent is separate from drafting configuration.

## Adding a capability

Extend the current owner of the platform contract. Validate the request body in `packages/contracts`, implement behavior in the relevant worker or API module, and expose it through the existing profile's declared capabilities.

Keep queries organization scoped. Check current instance and object ownership before mutating a lead, draft, approval or request. Add boundary tests for the behavior and verify all affected consumers.

Do not add a general management role to route work that already belongs to a platform. Feature pages compose the available controls; they do not duplicate registry rules.

See [architecture](architecture.md), [the database contract](database-contract.md) and [social growth](social-growth.md).
