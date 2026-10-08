import type { ReactNode } from "react";
import type { AgentRole } from "@noelle/contracts";
import { AppLink } from "@/components/nav/AppLink";
import { Card } from "@/components/ui/card";
import { channelForRole } from "@/lib/social-channels";

export function ChannelSetupNotice({ orgSlug, role, children }: {
  orgSlug: string; role: AgentRole; children: ReactNode;
}) {
  const channel = channelForRole(role);
  if (!channel) return null;
  return <Card className="card ideas-empty">
    <h3>Set up {channel.label}</h3>
    <p>{children}</p>
    <AppLink className="btn btn-primary" href={`/app/${orgSlug}/settings?tab=channels`}>
      Set up {channel.label}
    </AppLink>
  </Card>;
}
