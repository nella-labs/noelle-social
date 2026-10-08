export type {
  AgentRole,
  EngineHandle,
  EscalationPredicate,
  ModelRouting,
  AgentTool,
  AgentInstanceRow,
  AgentCallContext,
  RenderedPanel,
  AgentType,
  ManifestEscalationPredicate,
  AgentManifest,
  CapabilityTag,
  CapabilitySurface,
  AgentCapability,
} from "@noelle/runtime/types";

// Value re-exports (the capability vocabulary is a runtime const, not just a
// type) so `@noelle/agents` consumers and the router can validate against it.
export { CAPABILITY_TAGS, CAPABILITY_SURFACES, SOCIAL_AGENT_ROLES, isSocialAgentRole } from "@noelle/runtime/types";
