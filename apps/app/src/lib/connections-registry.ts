/**
 * Registry of connection kinds that Noelle can store in GCP Secret Manager.
 *
 * Each kind maps to a secret stored under:
 *   `noelle--org--<org-id>--<secretFragment>`
 *
 * (GCP secret names allow [-A-Za-z0-9_] only; "/" is not permitted, so we
 * use "--" as a path separator.)
 *
 * Validators run server-side before the value is written to Secret Manager.
 * They return `null` on success or an error string on failure.
 */

export type ConnectionKindId =
  | "x_cookies_ct0"
  | "x_cookies_auth_token"
  | "gemini"
  | "anthropic"
  | "openai"
  | "pushover_user"
  | "pushover_token";

export interface ConnectionKindSpec {
  id: ConnectionKindId;
  /** Secret name fragment used in `noelle--org--<org-id>--<this-fragment>`. */
  secretFragment: string;
  /** Display name (serif headline). */
  name: string;
  /** Glyph for the card icon. */
  icon: string;
  /** Short hint shown under the title. */
  hint: string;
  /** Grouping for the connections page. */
  group: "models" | "publishing" | "notify";
  /** Form input type. */
  input: "text" | "textarea" | "json";
  /** Helpful copy shown under the input field. */
  inputHelp: string;
  /** True if the user must perform an off-platform step before pasting. */
  needsExternalStep?: boolean;
  /** Pre-flight instructions displayed before the paste form. */
  setupSteps?: string[];
  /** Live-validate the pasted value. Returns null on success, error string on failure. */
  validate: (value: string) => Promise<string | null>;
}

/**
 * Client-safe view of a ConnectionKindSpec. The `validate` function is server-only —
 * passing the full spec into a "use client" component fails RSC serialization
 * ("Functions cannot be passed directly to Client Components"). Strip it at the
 * RSC boundary and pass this instead.
 */
export type ConnectionKindSpecClient = Omit<ConnectionKindSpec, "validate">;

export function toClientSpec(spec: ConnectionKindSpec): ConnectionKindSpecClient {
  const { validate: _validate, ...rest } = spec;
  return rest;
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

async function validateXCookieCt0(value: string): Promise<string | null> {
  if (!/^[A-Za-z0-9]{40,80}$/.test(value.trim())) {
    return "ct0 must be 40–80 alphanumeric characters.";
  }
  return null;
}

async function validateXCookieAuthToken(value: string): Promise<string | null> {
  if (!/^[A-Za-z0-9]{30,80}$/.test(value.trim())) {
    return "auth_token must be 30–80 alphanumeric characters.";
  }
  return null;
}

async function validateGemini(value: string): Promise<string | null> {
  if (!/^AIza[A-Za-z0-9_-]{30,}$/.test(value.trim())) {
    return "Gemini API keys start with AIza followed by 30+ characters.";
  }
  return null;
}

async function validateAnthropic(value: string): Promise<string | null> {
  if (!value.trim().startsWith("sk-ant-")) {
    return "Anthropic API keys start with sk-ant-.";
  }
  return null;
}

async function validateOpenAI(value: string): Promise<string | null> {
  if (!value.trim().startsWith("sk-")) {
    return "OpenAI API keys start with sk-.";
  }
  return null;
}

async function validatePushover30(value: string): Promise<string | null> {
  if (!/^[A-Za-z0-9]{30}$/.test(value.trim())) {
    return "Pushover keys are exactly 30 alphanumeric characters.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const CONNECTIONS: ConnectionKindSpec[] = [
  // ── Models ─────────────────────────────────────────────────────────────
  // Noelle's metered pool is not a BYO connection — it's the platform default
  // managed via Billing (expense). Users opt in/out from /billing; there is
  // no nk_ key to paste. Only bring-your-own provider keys live here.
  {
    id: "gemini",
    secretFragment: "gemini-api-key",
    name: "Gemini · Google AI",
    icon: "G",
    hint: "Fallback LLM. Get a key at aistudio.google.com.",
    group: "models",
    input: "text",
    inputHelp: "Paste your Google AI Studio API key (starts with AIza…).",
    validate: validateGemini,
  },
  {
    id: "anthropic",
    secretFragment: "anthropic-api-key",
    name: "Anthropic · API key",
    icon: "Aⁿ",
    hint: "Enables Claude models as a fallback LLM path.",
    group: "models",
    input: "text",
    inputHelp: "Paste your Anthropic API key (starts with sk-ant-…).",
    validate: validateAnthropic,
  },
  {
    id: "openai",
    secretFragment: "openai-api-key",
    name: "OpenAI · BYO key",
    icon: "○",
    hint: "Bring-your-own OpenAI key for GPT model access.",
    group: "models",
    input: "text",
    inputHelp: "Paste your OpenAI API key (starts with sk-…).",
    validate: validateOpenAI,
  },
  // ── Publishing ──────────────────────────────────────────────────────────
  {
    id: "x_cookies_ct0",
    secretFragment: "x-cookies-ct0",
    name: "X · ct0 cookie",
    icon: "✕",
    hint: "CSRF token cookie required for authenticated X API calls.",
    group: "publishing",
    input: "text",
    inputHelp:
      "Paste the value of the ct0 cookie from x.com. It is a 40–80 character hexadecimal string.",
    needsExternalStep: true,
    setupSteps: [
      "Sign in at x.com in your browser",
      "Open DevTools → Application → Cookies → x.com",
      "Copy the value of the `ct0` cookie",
    ],
    validate: validateXCookieCt0,
  },
  {
    id: "x_cookies_auth_token",
    secretFragment: "x-cookies-auth-token",
    name: "X · auth_token cookie",
    icon: "✕",
    hint: "Session authentication cookie for the X account the intern posts from.",
    group: "publishing",
    input: "text",
    inputHelp:
      "Paste the value of the auth_token cookie from x.com. It is a 30–80 character alphanumeric string.",
    needsExternalStep: true,
    setupSteps: [
      "Sign in at x.com in your browser",
      "Open DevTools → Application → Cookies → x.com",
      "Copy the value of the `auth_token` cookie",
    ],
    validate: validateXCookieAuthToken,
  },

  // ── Notify ──────────────────────────────────────────────────────────────
  {
    id: "pushover_user",
    secretFragment: "pushover-user-key",
    name: "Pushover · user key",
    icon: "🔔",
    hint: "Your Pushover user key. Required for agent push notifications.",
    group: "notify",
    input: "text",
    inputHelp:
      "Paste your 30-character Pushover user key. Find it on your Pushover dashboard at pushover.net.",
    validate: validatePushover30,
  },
  {
    id: "pushover_token",
