import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
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

// Must match MAX_FUTURE_LAST_REFRESH_SKEW_MS in codex-auth-merge-decision.cjs
// so pre-dispatch readiness and execute-time materialization enforce the exact
// same clock-skew ceiling.
export const MAX_FUTURE_LAST_REFRESH_SKEW_MS = 5 * 60 * 1000;

// Base64 expands bytes by 4/3 (plus optional whitespace/newlines). Reject
// oversized raw env payloads before decoding to keep memory bounded.
const MAX_ENCODED_AUTH_JSON_CHARS = Math.ceil((MAX_AUTH_JSON_BYTES * 4) / 3) + 4096;

export const REDACTED_CODEX_ACCOUNT_HANDLE = "<redacted-account>";

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

export interface ParseCodexAuthJsonOptions {
  /** Clock reference for future `last_refresh` skew validation. Defaults to `Date.now()`. */
  nowMs?: number;
}

function readAuthLastRefreshMs(bytes: Buffer): number | null {
  try {
    const parsed = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    if (typeof parsed.last_refresh !== "string") return null;
    const ms = Date.parse(parsed.last_refresh);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

/**
 * Decodes and validates a `CODEX_AUTH_JSON` environment value (either raw JSON
 * or base64-encoded JSON) representing a ChatGPT subscription `auth.json`.
 *
 * Fails closed on empty, oversized, malformed, API-key, missing-identity, or
 * implausibly future-dated `last_refresh` payloads. Error messages never
 * include raw token bytes or `account_id`.
 */
export function parseCodexAuthJsonEnv(
  raw: string,
  options: ParseCodexAuthJsonOptions = {},
): ParsedCodexAuthJson {
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

  const nowMs = options.nowMs ?? Date.now();
  const lastRefreshMs = readAuthLastRefreshMs(bytes);
  if (lastRefreshMs !== null && lastRefreshMs - nowMs > MAX_FUTURE_LAST_REFRESH_SKEW_MS) {
    throw new InvalidCodexAuthJsonError(
      "CODEX_AUTH_JSON last_refresh is implausibly far in the future (exceeds the 5-minute clock skew allowance).",
    );
  }

  return { bytes, accountId, accountHandle };
}

export interface MaterializeCodexAuthJsonInput {
  raw: string;
  companyId: string;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void | Promise<void>;
  nowMs?: number;
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
 *
 * Fails closed: after the write/keep decision, verifies that the slot actually
 * contains a usable subscription credential for the parsed `account_id`, and
 * never leaks `accountHandle` or token bytes in thrown errors.
 */
export async function materializeCodexAuthJsonSecret(
  input: MaterializeCodexAuthJsonInput,
): Promise<MaterializeCodexAuthJsonResult> {
  const env = input.env ?? process.env;
  const parsed = parseCodexAuthJsonEnv(input.raw, { nowMs: input.nowMs });
  let authPath: string;
  let outcome: WriteCredentialSeedOrNewerOutcome;
  try {
    authPath = await ensureCodexAuthCacheEntryDir(env, parsed.accountHandle, input.companyId);
    outcome = await writeCredentialSeedOrNewer({
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
  } catch (error) {
    if (error instanceof InvalidCodexAuthJsonError) {
      throw error;
    }
    const code = (error as NodeJS.ErrnoException | null)?.code ?? "unknown";
    throw new Error(`Failed to materialize CODEX_AUTH_JSON into company-scoped Codex account home (${code}).`);
  }

  // Defense in depth: never proceed if the slot is still absent, unreadable,
  // or holds a different/unusable credential (e.g. if the merge predicate
  // refused the seed).
  const slotBytes = await readFile(authPath).catch(() => null);
  const slotAccountId = slotBytes ? readSubscriptionAccountId(slotBytes) : null;
  if (slotAccountId !== parsed.accountId) {
    throw new InvalidCodexAuthJsonError(
      "CODEX_AUTH_JSON could not be materialized into a usable company-scoped credential slot.",
    );
  }

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

/** Redacts an account handle (embedded in the cache slot directory path) from text. */
export function redactCodexAccountHandleInText(
  text: string,
  accountHandle: string | null | undefined,
): string {
  if (!accountHandle || !text.includes(accountHandle)) {
    return text;
  }
  return text.split(accountHandle).join(REDACTED_CODEX_ACCOUNT_HANDLE);
}

/** Wraps `onLog` so the `CODEX_AUTH_JSON` account handle never reaches run logs. */
export function wrapOnLogRedactingCodexAccountHandle(
  onLog: AdapterExecutionContext["onLog"],
  accountHandle: string | null | undefined,
): AdapterExecutionContext["onLog"] {
  if (!accountHandle) return onLog;
  return (stream, chunk) => onLog(stream, redactCodexAccountHandleInText(chunk, accountHandle));
}

/** Wraps `onMeta` so the `CODEX_AUTH_JSON` account handle never reaches invocation metadata. */
export function wrapOnMetaRedactingCodexAccountHandle(
  onMeta: AdapterExecutionContext["onMeta"],
  accountHandle: string | null | undefined,
): AdapterExecutionContext["onMeta"] {
  if (!onMeta || !accountHandle) return onMeta;
  return (meta) =>
    onMeta({
      ...meta,
      ...(meta.env
        ? {
            env: Object.fromEntries(
              Object.entries(meta.env).map(([k, v]) => [
                k,
                typeof v === "string" ? redactCodexAccountHandleInText(v, accountHandle) : v,
              ]),
            ),
          }
        : {}),
      ...(meta.commandNotes
        ? {
            commandNotes: meta.commandNotes.map((note) =>
              redactCodexAccountHandleInText(note, accountHandle),
            ),
          }
        : {}),
      ...(meta.commandArgs
        ? {
            commandArgs: meta.commandArgs.map((arg) =>
              redactCodexAccountHandleInText(arg, accountHandle),
            ),
          }
        : {}),
    });
}

/** Deeply redacts `accountHandle` from every string in a plain value (objects/arrays/strings). */
export function redactCodexAccountHandleInValue<T>(
  value: T,
  accountHandle: string | null | undefined,
): T {
  if (!accountHandle) return value;
  const seen = new WeakMap<object, unknown>();
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      return redactCodexAccountHandleInText(node, accountHandle);
    }
    if (node === null || typeof node !== "object") {
      return node;
    }
    if (seen.has(node)) {
      return seen.get(node);
    }
    if (Array.isArray(node)) {
      const out: unknown[] = [];
      seen.set(node, out);
      for (const item of node) out.push(walk(item));
      return out;
    }
    if (node instanceof Date || Buffer.isBuffer(node) || node instanceof RegExp) {
      return node;
    }
    const out: Record<string, unknown> = {};
    seen.set(node, out);
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[redactCodexAccountHandleInText(k, accountHandle)] = walk(v);
    }
    return out;
  };
  return walk(value) as T;
}

/** Redacts `accountHandle` from an Error's message, stack, and path/dest fields before rethrowing. */
export function redactCodexAccountHandleInError(
  error: unknown,
  accountHandle: string | null | undefined,
): unknown {
  if (!accountHandle || !(error instanceof Error)) return error;
  if (error.message.includes(accountHandle)) {
    error.message = redactCodexAccountHandleInText(error.message, accountHandle);
  }
  if (typeof error.stack === "string" && error.stack.includes(accountHandle)) {
    error.stack = redactCodexAccountHandleInText(error.stack, accountHandle);
  }
  const errnoErr = error as Error & { path?: unknown; dest?: unknown };
  if (typeof errnoErr.path === "string" && errnoErr.path.includes(accountHandle)) {
    errnoErr.path = redactCodexAccountHandleInText(errnoErr.path, accountHandle);
  }
  if (typeof errnoErr.dest === "string" && errnoErr.dest.includes(accountHandle)) {
    errnoErr.dest = redactCodexAccountHandleInText(errnoErr.dest, accountHandle);
  }
  return error;
}
