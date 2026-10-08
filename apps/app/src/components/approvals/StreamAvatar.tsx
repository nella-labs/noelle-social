import { Avatar } from "@/components/constellation/Avatar";
import type { StreamAgentRole } from "@/lib/approval-streams";

export function StreamAvatar({ role, size = 28, accent }: { role: StreamAgentRole; size?: number; accent?: string }) {
  return <Avatar role={role} size={size} accent={accent} />;
}
