import type { ListmonkServerInfo } from "@/lib/listmonk";
import type { SesStatus } from "@/lib/ses";

/**
 * Two-card row at the top of the admin Email page. Mirrors what an SRE
 * would otherwise read from the AWS SES dashboard + the Listmonk admin —
 * sending quota, send rate, sandbox vs production, list/subscriber/campaign
 * counts — without leaving Noelle.
 *
 * Read-only. Config changes happen in AWS (production access request,
 * sender identities) and on the Listmonk VM (lists, subscribers); this
 * panel only reflects current state.
 */

interface SesStatusBlock {
  configured: boolean;
  status: SesStatus | null;
  error: string | null;
}

interface ListmonkStatusBlock {
  configured: boolean;
  info: ListmonkServerInfo | null;
  error: string | null;
}

interface MailInfraStatusProps {
  ses: SesStatusBlock;
  listmonk: ListmonkStatusBlock;
}

export function MailInfraStatus({ ses, listmonk }: MailInfraStatusProps) {
  return (
    <div
      className="stack-phone"
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 16,
      }}
    >
      <SesCard ses={ses} />
      <ListmonkCard lm={listmonk} />
    </div>
  );
}

// ─── SES ───────────────────────────────────────────────────────────────────
function SesCard({ ses }: { ses: SesStatusBlock }) {
  const region = ses.status?.region ?? process.env.AWS_SES_REGION ?? "us-east-1";
  const consoleUrl = `https://${region}.console.aws.amazon.com/ses/home?region=${region}#/account`;

  const sandbox = ses.status && !ses.status.productionAccessEnabled;
  const sendingPaused = ses.status && !ses.status.sendingEnabled;
  const health =
    sendingPaused || ses.status?.enforcementStatus === "SHUTDOWN"
      ? "down"
      : sandbox || ses.status?.enforcementStatus === "PROBATION"
      ? "warn"
      : ses.status
      ? "ok"
      : "muted";

  return (
    <Card>
      <CardHeader
        eyebrow={`AWS SES · ${region}`}
        title="Amazon SES"
        right={<ExternalLink href={consoleUrl}>open AWS console ↗</ExternalLink>}
        tone={health}
        toneLabel={
          health === "ok" ? "production" : sandbox ? "sandbox" : sendingPaused ? "paused" : "—"
        }
      />
      {!ses.configured ? (
        <Hint>
          Add <code>AWS_SES_ACCESS_KEY_ID</code> + <code>AWS_SES_SECRET_ACCESS_KEY</code> to the
          environment (read-only IAM user) to render live quota + sandbox status here.
        </Hint>
      ) : ses.error ? (
        <ErrorRow>{ses.error}</ErrorRow>
      ) : ses.status ? (
        <Stats
          rows={[
            { label: "Daily quota", value: fmtInt(ses.status.dailyQuota), unit: "emails / 24h" },
            { label: "Max send rate", value: fmtInt(ses.status.maxSendRate), unit: "emails / sec" },
            {
              label: "Sent (24h)",
              value: fmtInt(ses.status.sentLast24h),
              unit: `of ${fmtInt(ses.status.dailyQuota)}`,
            },
            {
              label: "Account health",
              value: ses.status.enforcementStatus.toLowerCase(),
              unit: ses.status.sendingEnabled ? "sending enabled" : "sending paused",
              tone: health,
            },
          ]}
        />
      ) : null}
    </Card>
  );
}

// ─── Listmonk ──────────────────────────────────────────────────────────────
function ListmonkCard({ lm }: { lm: ListmonkStatusBlock }) {
  const host = (process.env.LISTMONK_URL ?? "https://listmonk.trynoelle.com").replace(/\/$/, "");

  const health = lm.error ? "down" : lm.info ? "ok" : "muted";

  return (
    <Card>
      <CardHeader
        eyebrow="Listmonk · GCP VM"
        title="Listmonk"
        right={<ExternalLink href={host}>open admin ↗</ExternalLink>}
        tone={health}
        toneLabel={
          lm.info ? `v${lm.info.version}` : lm.error ? "unreachable" : "not configured"
        }
      />
      {!lm.configured ? (
        <Hint>
          Set <code>LISTMONK_URL</code>, <code>LISTMONK_USER</code>, and{" "}
          <code>LISTMONK_PASSWORD</code> in this environment to pull live list + campaign counts.
        </Hint>
      ) : lm.error ? (
        <ErrorRow>{lm.error}</ErrorRow>
      ) : lm.info ? (
        <Stats
          rows={[
            {
              label: "Subscribers",
              value: fmtInt(lm.info.database?.subscribers ?? 0),
              unit: "all lists",
            },
            { label: "Lists", value: fmtInt(lm.info.database?.lists ?? 0), unit: "active" },
            {
              label: "Campaigns",
              value: fmtInt(lm.info.database?.campaigns ?? 0),
              unit: "all-time",
            },
            {
              label: "Messages sent",
              value: fmtInt(lm.info.database?.messages ?? 0),
              unit: "lifetime",
              tone: "ok",
            },
          ]}
        />
      ) : null}
    </Card>
  );
}

// ─── primitives ────────────────────────────────────────────────────────────
function Card({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="card"
      style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}
    >
      {children}
    </div>
  );
}

function CardHeader({
  eyebrow,
  title,
  right,
  tone,
  toneLabel,
}: {
  eyebrow: string;
  title: string;
  right?: React.ReactNode;
  tone: Tone;
  toneLabel: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 10,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: "var(--ink-muted)",
          }}
        >
          {eyebrow}
        </div>
        <div
          className="serif"
          style={{ fontSize: 22, marginTop: 4, lineHeight: 1.05, letterSpacing: "-0.01em" }}
        >
          {title}
        </div>
