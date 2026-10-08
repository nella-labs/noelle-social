import type { AgentTool, AgentType, ModelRouting, AgentRole, AgentInstanceRow, AgentCallContext, RenderedPanel } from "./types.js";

export function defineAgent(spec: {
  id: AgentRole;
  defaultModel: ModelRouting;
  defaultBucket: string;
  tools?: ReadonlyArray<AgentTool>;
  run?: (ctx: AgentCallContext) => Promise<void>;
  render: (instance: AgentInstanceRow) => Promise<RenderedPanel>;
}): AgentType {
  const base = {
    id: spec.id,
    defaultModel: spec.defaultModel,
    defaultBucket: spec.defaultBucket,
    tools: spec.tools ?? [],
    render: spec.render,
  };
  if (spec.run) {
    return { ...base, run: spec.run } satisfies AgentType;
  }
  return base satisfies AgentType;
}
