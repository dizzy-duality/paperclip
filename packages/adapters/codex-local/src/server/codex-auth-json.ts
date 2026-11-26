import path from "node:path";
import { toAccountHandle } from "@paperclipai/shared";
import {
  ensureCodexAuthCacheEntryDir,
  readSubscriptionAccountId,
} from "./codex-auth-cache.js";
import {
  writeCredentialSeedOrNewer,
  type WriteCredentialSeedOrNewerOutcome,
} from "./codex-auth-seed-write.js";
import {
  assertUsableSubscriptionShape,
  MAX_AUTH_JSON_BYTES,
} from "./device-login-export.js";

export const CODEX_AUTH_JSON_ENV_KEY = "CODEX_AUTH_JSON";

// Base64 expands bytes by 4/3 (plus optional whitespace/newlines). Reject
// oversized raw env payloads before decoding to keep memory bounded.
const MAX_ENCODED_AUTH_JSON_CHARS = Math.ceil((MAX_AUTH_JSON_BYTES * 4) / 3) + 4096;

export class InvalidCodexAuthJsonError extends Error {
  constructor(
    message = "CODEX_AUTH_JSON is invalid: expected a ChatGPT subscription auth.json payload (raw JSON or base64) with tokens and account_id.",
  ) {
    super(message);
    this.name = "InvalidCodexAuthJsonError";
  }
}

export interface ParsedCodexAuthJson {
  bytes: Buffer;
  accountId: string;
  accountHandle: string;
}

/**
 * Decodes and validates a `CODEX_AUTH_JSON` environment value (either raw JSON
 * or base64-encoded JSON) representing a ChatGPT subscription `auth.json`.
 *
 * Fails closed on empty, oversized, malformed, API-key, or missing-identity
 * payloads. Error messages never include raw token bytes or `account_id`.
 */
export function parseCodexAuthJsonEnv(raw: string): ParsedCodexAuthJson {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (trimmed.length === 0) {
    throw new InvalidCodexAuthJsonError("CODEX_AUTH_JSON is empty.");
  }
  if (trimmed.length > MAX_ENCODED_AUTH_JSON_CHARS) {
    throw new InvalidCodexAuthJsonError(
      "CODEX_AUTH_JSON exceeds the maximum allowed auth.json size.",
    );
  }

  let bytes: Buffer;
  if (trimmed.startsWith("{")) {
    bytes = Buffer.from(trimmed, "utf8");
  } else {
    const compact = trimmed.replace(/\s+/g, "");
    // Accept standard or URL-safe base64.
    const normalized = compact.replace(/-/g, "+").replace(/_/g, "/");
    if (!/^[A-Za-z0-9+/]+=*$/.test(normalized) || normalized.length % 4 === 1) {
      throw new InvalidCodexAuthJsonError();
    }
    const decoded = Buffer.from(normalized, "base64");
    const decodedTrimmed = decoded.toString("utf8").trimStart();
    if (!decodedTrimmed.startsWith("{")) {
      throw new InvalidCodexAuthJsonError();
    }
    bytes = decoded;
  }

  try {
    assertUsableSubscriptionShape(bytes);
  } catch {
    throw new InvalidCodexAuthJsonError();
  }

  const accountId = readSubscriptionAccountId(bytes);
  if (!accountId) {
    throw new InvalidCodexAuthJsonError();
  }

  const accountHandle = toAccountHandle(accountId);
  if (!accountHandle) {
    throw new InvalidCodexAuthJsonError(
      "CODEX_AUTH_JSON account_id cannot form a valid account handle.",
    );
  }

  return { bytes, accountId, accountHandle };
}

export interface MaterializeCodexAuthJsonInput {
  raw: string;
  companyId: string;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void | Promise<void>;
}

export interface MaterializeCodexAuthJsonResult {
  accountHomeDir: string;
  authPath: string;
  accountHandle: string;
  outcome: WriteCredentialSeedOrNewerOutcome;
}

const noopLog = () => undefined;

/**
 * Materializes a `CODEX_AUTH_JSON` secret into the company-scoped, per-identity
 * account home (`companies/<companyId>/codex-auth-cache/<accountHandle>/auth.json`).
 *
 * Because ChatGPT subscription `auth.json` uses single-use rotating refresh
 * tokens, this never blindly overwrites an existing slot: it seeds an absent
 * slot, adopts a strictly-newer rotated secret, and preserves any equal or
 * newer rotated token already persisted in the slot from prior runs.
 */
export async function materializeCodexAuthJsonSecret(
  input: MaterializeCodexAuthJsonInput,
): Promise<MaterializeCodexAuthJsonResult> {
  const env = input.env ?? process.env;
  const parsed = parseCodexAuthJsonEnv(input.raw);
  const authPath = await ensureCodexAuthCacheEntryDir(env, parsed.accountHandle, input.companyId);
  const outcome = await writeCredentialSeedOrNewer({
    sourceBytes: parsed.bytes,
    destinationPath: authPath,
    seedIfDestAbsent: true,
    log: input.log ?? noopLog,
    writtenLine:
      "[paperclip] Materialized CODEX_AUTH_JSON into company-scoped Codex account home (seed or strictly-newer update).",
    keptLine:
      "[paperclip] Kept existing company-scoped Codex account home (already holds an equal or newer rotated credential for this account).",
    tempPrefix: "auth.json.secret-seed",
    errorLabel: "codex auth json secret",
    env,
  });
  return {
    accountHomeDir: path.dirname(authPath),
    authPath,
    accountHandle: parsed.accountHandle,
    outcome,
  };
}

/**
 * Returns a shallow copy of `env` with `CODEX_AUTH_JSON` removed so raw
 * subscription token JSON is never leaked into child process environments,
 * shell allowlists, or invocation logs.
 */
export function stripCodexAuthJsonFromEnv<T extends Record<string, unknown>>(
  env: T,
): Omit<T, typeof CODEX_AUTH_JSON_ENV_KEY> {
  if (!Object.hasOwn(env, CODEX_AUTH_JSON_ENV_KEY)) {
    return env;
  }
  const copy = { ...env };
  delete copy[CODEX_AUTH_JSON_ENV_KEY];
  return copy;
}
