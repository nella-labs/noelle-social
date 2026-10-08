import { NextResponse } from "next/server";
import { createBedrockBackend } from "@noelle/runtime";
import { checkAdmin } from "@/lib/admin-gate";
import { getSecretManagerClient, SM_PROJECT } from "@/lib/sm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/debug/bedrock — admin-only probe for the Bedrock chat backend.
 *
 * Walks the same four init stages as POST /api/agents/[id]/chat and reports
 * which one (if any) is broken, without exposing secret values. Lets us
 * answer "why is the chat panel returning 503?" in a single curl, instead
 * of having to enable verbose logging and replay user traffic.
 *
 * Each stage returns one of:
 *   - { ok: true, … }                  the stage succeeded
 *   - { ok: false, error: "…", code }  the stage threw; message + code are surfaced
 *   - { ok: false, skipped: true }     an earlier stage failed so this one
 *                                      was not attempted
 *
 * We deliberately do NOT call Bedrock (InvokeModel) here — that costs money
 * and is the one Bedrock-side failure mode the chat route can already
 * surface (502 model_error). This probe only diagnoses the GCP→AWS bridge.
 */

const ACCESS_KEY_SECRET = "noelle-worker-bedrock-aws-access-key-id";
const SECRET_KEY_SECRET = "noelle-worker-bedrock-aws-secret-access-key";

interface StageResult {
  ok: boolean;
  skipped?: boolean;
  error?: string;
  errorCode?: string;
  details?: Record<string, unknown>;
}

function stageError(err: unknown): StageResult {
  if (err instanceof Error) {
    const code = (err as { code?: string | number }).code;
    return {
      ok: false,
      error: err.message,
      errorCode: code !== undefined ? String(code) : undefined,
    };
  }
  return { ok: false, error: String(err) };
}

export async function GET() {
  const admin = await checkAdmin();
  if (!admin.isAdmin) {
    return NextResponse.json(
      { error: "forbidden", message: "Admin-only probe." },
      { status: 403 },
    );
  }

  const result: {
    project: string;
    secrets: { accessKey: string; secretAccessKey: string };
    stages: {
      secret_manager_client: StageResult;
      secret_manager_fetch: StageResult;
      secret_empty: StageResult;
      backend_construct: StageResult;
    };
    overall: "ok" | "failed";
  } = {
    project: SM_PROJECT,
    secrets: { accessKey: ACCESS_KEY_SECRET, secretAccessKey: SECRET_KEY_SECRET },
    stages: {
      secret_manager_client: { ok: false, skipped: true },
      secret_manager_fetch: { ok: false, skipped: true },
      secret_empty: { ok: false, skipped: true },
      backend_construct: { ok: false, skipped: true },
    },
    overall: "failed",
  };

  // Stage 1: build a Secret Manager client.
  let sm: Awaited<ReturnType<typeof getSecretManagerClient>>;
  try {
    sm = await getSecretManagerClient();
    result.stages.secret_manager_client = { ok: true };
  } catch (err) {
    result.stages.secret_manager_client = stageError(err);
    return NextResponse.json(result, { status: 200 });
  }

  // Stage 2: fetch both secrets.
  let accessRes, secretRes;
  try {
    [accessRes, secretRes] = await Promise.all([
      sm.accessSecretVersion({
        name: `projects/${SM_PROJECT}/secrets/${ACCESS_KEY_SECRET}/versions/latest`,
      }),
      sm.accessSecretVersion({
        name: `projects/${SM_PROJECT}/secrets/${SECRET_KEY_SECRET}/versions/latest`,
      }),
    ]);
    result.stages.secret_manager_fetch = { ok: true };
  } catch (err) {
    result.stages.secret_manager_fetch = stageError(err);
    return NextResponse.json(result, { status: 200 });
  }

  // Stage 3: check payloads are non-empty (without leaking values).
  const accessLen = lengthOf(accessRes[0]?.payload?.data);
  const secretLen = lengthOf(secretRes[0]?.payload?.data);
  const missing: string[] = [];
  if (accessLen === 0) missing.push(ACCESS_KEY_SECRET);
  if (secretLen === 0) missing.push(SECRET_KEY_SECRET);
  if (missing.length > 0) {
    result.stages.secret_empty = {
      ok: false,
      error: `Empty payload for: ${missing.join(", ")}`,
      details: { accessKeyLen: accessLen, secretAccessKeyLen: secretLen },
    };
    return NextResponse.json(result, { status: 200 });
  }
  result.stages.secret_empty = {
    ok: true,
    details: { accessKeyLen: accessLen, secretAccessKeyLen: secretLen },
  };

  // Stage 4: construct the backend object (does not call AWS yet).
  try {
    const accessKeyId = readPayload(accessRes[0]?.payload?.data)!;
    const secretAccessKey = readPayload(secretRes[0]?.payload?.data)!;
    createBedrockBackend({
      region: "us-east-1",
      accessKeyId,
      secretAccessKey,
      maxTokens: 16,
    });
    result.stages.backend_construct = { ok: true };
  } catch (err) {
    result.stages.backend_construct = stageError(err);
    return NextResponse.json(result, { status: 200 });
  }

  result.overall = "ok";
  return NextResponse.json(result, { status: 200 });
}

function lengthOf(data: unknown): number {
  if (data instanceof Uint8Array) return Buffer.from(data).toString("utf-8").trim().length;
  if (typeof data === "string") return data.trim().length;
  return 0;
}

function readPayload(data: unknown): string | null {
  if (data instanceof Uint8Array) return Buffer.from(data).toString("utf-8").trim();
  if (typeof data === "string") return data.trim();
  return null;
}
