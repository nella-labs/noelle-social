/**
 * Thin Listmonk client. Used by the admin Broadcasts page to send
 * announcement emails to opted-in subscribers.
 *
 * Listmonk runs on a GCP VM behind https://listmonk.trynoelle.com.
 * Auth is HTTP Basic against the admin user created in the Listmonk wizard.
 *
 * Required env vars:
 *   LISTMONK_URL       — base URL, e.g. https://listmonk.trynoelle.com
 *   LISTMONK_USER      — admin username
 *   LISTMONK_PASSWORD  — admin password
 *
 * Missing env vars cause `listmonkConfigured()` to return false. The
 * Broadcasts page checks that and shows a "not configured" notice instead
 * of throwing — the rest of the admin should keep working in environments
 * where Listmonk isn't reachable (preview deployments, local dev).
 */

const LISTMONK_URL = process.env.LISTMONK_URL?.replace(/\/$/, "");
const LISTMONK_USER = process.env.LISTMONK_USER;
const LISTMONK_PASSWORD = process.env.LISTMONK_PASSWORD;

export function listmonkConfigured(): boolean {
  return Boolean(LISTMONK_URL && LISTMONK_USER && LISTMONK_PASSWORD);
}

function authHeader(): string {
  if (!LISTMONK_USER || !LISTMONK_PASSWORD) throw new Error("Listmonk credentials missing");
  return "Basic " + Buffer.from(`${LISTMONK_USER}:${LISTMONK_PASSWORD}`).toString("base64");
}

async function listmonkFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!LISTMONK_URL) throw new Error("LISTMONK_URL not set");
  const res = await fetch(`${LISTMONK_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader(),
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Listmonk ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

// ─── Lists ─────────────────────────────────────────────────────────────────
export interface ListmonkList {
  id: number;
  name: string;
  type: "public" | "private";
  optin: "single" | "double";
  subscriber_count: number;
}

export async function getLists(): Promise<ListmonkList[]> {
  const res = await listmonkFetch<{ data: { results: ListmonkList[] } }>(
    "/api/lists?per_page=100",
  );
  return res.data.results;
}

// ─── Campaigns ─────────────────────────────────────────────────────────────
export interface CreateCampaignArgs {
  name: string;
  subject: string;
  /** HTML body. Wrap with the Noelle announcement template before passing. */
  body: string;
  fromEmail?: string;
  listIds: number[];
  /** "richtext" = HTML editor, "html" = raw HTML. Default html for our case. */
  contentType?: "richtext" | "html" | "markdown" | "plain";
}

export interface ListmonkCampaign {
  id: number;
  name: string;
  subject: string;
  status: "draft" | "scheduled" | "running" | "paused" | "finished" | "cancelled";
}

export async function createCampaign(args: CreateCampaignArgs): Promise<ListmonkCampaign> {
  const res = await listmonkFetch<{ data: ListmonkCampaign }>("/api/campaigns", {
    method: "POST",
    body: JSON.stringify({
      name: args.name,
      subject: args.subject,
      body: args.body,
      content_type: args.contentType ?? "html",
      lists: args.listIds,
      from_email:
        args.fromEmail ?? process.env.LISTMONK_FROM_EMAIL ?? "Noelle <news@mail.trynoelle.com>",
      type: "regular",
      messenger: "email",
    }),
  });
  return res.data;
}

/**
 * Move a campaign to `running` (or `scheduled` if it has `send_at`).
 * Listmonk requires this PATCH after `createCampaign`; campaigns are created
 * in draft state.
 */
export async function startCampaign(id: number): Promise<void> {
  await listmonkFetch(`/api/campaigns/${id}/status`, {
    method: "PUT",
    body: JSON.stringify({ status: "running" }),
  });
}

// ─── Server info ───────────────────────────────────────────────────────────
export interface ListmonkServerInfo {
  version: string;
  /** Listmonk reports "build" — git-sha or `unknown`. Optional. */
  build?: string;
  /** Listmonk's own DB connectivity check. */
  database?: { messages: number; subscribers: number; lists: number; campaigns: number };
}

interface ListmonkCounts {
  messages?: number;
  subscribers?: number;
  lists?: number;
  campaigns?: number;
}

export async function getServerInfo(): Promise<ListmonkServerInfo> {
  const res = await listmonkFetch<{ data: { version: string; build?: string } }>("/api/config");
  const stats = await listmonkFetch<{ data: ListmonkCounts }>(
    "/api/dashboard/counts",
  ).catch((): { data: ListmonkCounts } => ({ data: {} }));
  return {
    version: res.data.version,
    build: res.data.build,
    database: {
      messages: stats.data.messages ?? 0,
      subscribers: stats.data.subscribers ?? 0,
      lists: stats.data.lists ?? 0,
      campaigns: stats.data.campaigns ?? 0,
    },
  };
}

// ─── Recent campaigns ──────────────────────────────────────────────────────
export interface ListmonkCampaignRow {
  id: number;
  name: string;
  subject: string;
  status: ListmonkCampaign["status"];
  /** ISO timestamp when the campaign was created. */
  created_at: string;
  /** ISO timestamp when the campaign started sending. May be null for drafts. */
  started_at: string | null;
  /** Total recipients the campaign was sent to. */
  to_send: number;
  /** Messages actually sent so far. */
  sent: number;
}

export async function getRecentCampaigns(limit = 10): Promise<ListmonkCampaignRow[]> {
  const res = await listmonkFetch<{
    data: {
      results: Array<{
        id: number;
        name: string;
        subject: string;
        status: ListmonkCampaign["status"];
        created_at: string;
        started_at: string | null;
        to_send: number;
        sent: number;
      }>;
    };
  }>(`/api/campaigns?page=1&per_page=${limit}&order_by=created_at&order=desc`);
  return res.data.results;
}

// ─── Transactional (single-recipient) ─────────────────────────────────────
export interface SendTransactionalArgs {
  toEmail: string;
  subject: string;
  body: string;
  fromEmail?: string;
  contentType?: "html" | "plain";
  /** Optional Listmonk transactional template ID. If omitted, body is rendered as-is. */
  templateId?: number;
}

export async function sendTransactional(args: SendTransactionalArgs): Promise<void> {
  await listmonkFetch("/api/tx", {
    method: "POST",
    body: JSON.stringify({
      subscriber_email: args.toEmail,
      template_id: args.templateId ?? 0,
      data: { body: args.body, subject: args.subject },
      headers: [],
      from_email:
        args.fromEmail ?? process.env.LISTMONK_FROM_EMAIL ?? "Noelle <news@mail.trynoelle.com>",
      content_type: args.contentType ?? "html",
    }),
  });
}
