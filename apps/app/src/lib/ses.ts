/**
 * Thin SES status reader for the admin Email page.
 *
 * SES sends are owned by Listmonk (campaigns + tx) and Supabase Auth (custom
 * SMTP). This module is *read-only* — we only call GetAccount + GetSendQuota
 * to surface the dashboard you'd otherwise have to click into the AWS
 * console for (`Sending limits`, `Account health`, sandbox vs production).
 *
 * Required env vars (all optional — sesConfigured() returns false if any
 * are missing, and the admin page falls back to a "AWS console" link):
 *
 *   AWS_SES_REGION             — e.g. us-east-1
 *   AWS_SES_ACCESS_KEY_ID      — IAM user with ses:GetAccount + ses:GetSendQuota
 *   AWS_SES_SECRET_ACCESS_KEY  — IAM secret access key
 *
 * Don't reuse the Listmonk SMTP IAM user for this — its policy
 * (AmazonSesSendingAccess) is send-only and lacks GetAccount/GetSendQuota.
 * Create a separate IAM user with a tiny read-only inline policy.
 */

import { SESv2Client, GetAccountCommand } from "@aws-sdk/client-sesv2";

const REGION = process.env.AWS_SES_REGION ?? "us-east-1";
const ACCESS_KEY_ID = process.env.AWS_SES_ACCESS_KEY_ID;
const SECRET_ACCESS_KEY = process.env.AWS_SES_SECRET_ACCESS_KEY;

export function sesConfigured(): boolean {
  return Boolean(ACCESS_KEY_ID && SECRET_ACCESS_KEY);
}

export interface SesStatus {
  region: string;
  /** True when SES has graduated the account out of sandbox. */
  productionAccessEnabled: boolean;
  /** True when sending is *not* paused (account-wide). */
  sendingEnabled: boolean;
  /** Cap per 24h, rounded to int. -1 if unlimited (post-graduation only). */
  dailyQuota: number;
  /** Max emails/sec, rounded to int. */
  maxSendRate: number;
  /** Sent in trailing 24h, rounded to int. */
  sentLast24h: number;
  /** Enforcement status — usually `HEALTHY` after production access. */
  enforcementStatus: string;
}

let client: SESv2Client | null = null;
function getClient(): SESv2Client {
  if (client) return client;
  if (!ACCESS_KEY_ID || !SECRET_ACCESS_KEY) {
    throw new Error("SES credentials missing");
  }
  client = new SESv2Client({
    region: REGION,
    credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY },
  });
  return client;
}

export async function getSesStatus(): Promise<SesStatus> {
  const out = await getClient().send(new GetAccountCommand({}));
  const limits = out.SendQuota;
  return {
    region: REGION,
    productionAccessEnabled: Boolean(out.ProductionAccessEnabled),
    sendingEnabled: Boolean(out.SendingEnabled),
    dailyQuota: limits?.Max24HourSend ? Math.round(limits.Max24HourSend) : 0,
    maxSendRate: limits?.MaxSendRate ? Math.round(limits.MaxSendRate) : 0,
    sentLast24h: limits?.SentLast24Hours ? Math.round(limits.SentLast24Hours) : 0,
    enforcementStatus: out.EnforcementStatus ?? "UNKNOWN",
  };
}
