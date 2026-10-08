import type { ApprovalStream } from "@/lib/approval-streams";
import { EmptyApprovalStream } from "./EmptyApprovalStream";

interface Props {
  stream: ApprovalStream;
  basePath: string;
  ctaHref: string;
}

export function ChannelSetupStream({ stream, basePath, ctaHref }: Props) {
  return (
    <EmptyApprovalStream
      role={stream.agentRole}
      title={`${stream.network} · ${stream.surface}`}
      description={stream.desc}
      note="Connect this channel to start discovering conversations."
      backHref={basePath}
      primary={{ href: ctaHref, label: `Set up ${stream.network}` }}
    />
  );
}
