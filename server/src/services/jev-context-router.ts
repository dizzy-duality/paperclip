import { createHash } from "node:crypto";

export interface JevContextRouterOptions {
  enabled?: boolean;
  endpoint?: string;
  threshold?: number;
  topK?: number;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

const cache = new Map<string, Record<string, unknown>>();
const MANDATORY = /^(system|developer|policy|governance|request|current|wake|origin|newest|permission|unresolved|decision|skill|symbol|paperclip)/i;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function configured(options: JevContextRouterOptions): Required<Omit<JevContextRouterOptions, "fetch">> & { fetch: typeof globalThis.fetch } | null {
  const enabled = options.enabled ?? process.env.PAPERCLIP_JEV_CONTEXT_ROUTER_ENABLED === "true";
  const endpoint = options.endpoint ?? process.env.PAPERCLIP_JEV_CONTEXT_ROUTER_URL ?? "";
  if (!enabled || !endpoint) return null;
  return {
    enabled,
    endpoint,
    threshold: options.threshold ?? Number(process.env.PAPERCLIP_JEV_CONTEXT_ROUTER_THRESHOLD ?? 0.55),
    topK: options.topK ?? Number(process.env.PAPERCLIP_JEV_CONTEXT_ROUTER_TOP_K ?? 8),
    timeoutMs: options.timeoutMs ?? Number(process.env.PAPERCLIP_JEV_CONTEXT_ROUTER_TIMEOUT_MS ?? 1500),
    fetch: options.fetch ?? globalThis.fetch,
  };
}

/** Shortens only the ephemeral legacy-adapter projection. The caller's snapshot is never mutated. */
export async function routeLegacyAdapterContext(
  context: Record<string, unknown>,
  options: JevContextRouterOptions = {},
): Promise<Record<string, unknown>> {
  const config = configured(options);
  if (!config) return { ...context };
  const optional = Object.entries(context).filter(([key]) => !MANDATORY.test(key));
  if (optional.length === 0) return { ...context };
  const key = createHash("sha256").update(stable({ context, endpoint: config.endpoint, threshold: config.threshold, topK: config.topK })).digest("hex");
  const hit = cache.get(key);
  if (hit) return { ...hit };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await config.fetch(config.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "relevance_selection",
        threshold: config.threshold,
        topK: config.topK,
        candidates: optional.map(([id, value]) => ({ id, content: stable(value) })),
      }),
      signal: controller.signal,
    });
    if (!response.ok) return { ...context };
    const answer = await response.json() as { selections?: Array<{ id?: unknown; score?: unknown }> };
    if (!Array.isArray(answer.selections)) return { ...context };
    const allowed = new Set(optional.map(([id]) => id));
    const selected = answer.selections
      .filter((item): item is { id: string; score: number } => typeof item?.id === "string" && typeof item?.score === "number" && item.score >= config.threshold && allowed.has(item.id))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, config.topK));
    // Empty/low-confidence answers widen safely to the full projection.
    if (selected.length === 0) return { ...context };
    const selectedIds = new Set(selected.map(({ id }) => id));
    const result = Object.fromEntries(Object.entries(context).filter(([id]) => MANDATORY.test(id) || selectedIds.has(id)));
    cache.set(key, result);
    return { ...result };
  } catch {
    return { ...context };
  } finally {
    clearTimeout(timer);
  }
}

export function clearJevContextRouterCacheForTest(): void {
  cache.clear();
}
