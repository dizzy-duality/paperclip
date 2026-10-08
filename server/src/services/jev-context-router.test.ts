import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearJevContextRouterCacheForTest, routeLegacyAdapterContext } from "./jev-context-router.js";

const response = (selections: Array<{ id: string; score: number }>) =>
  new Response(JSON.stringify({ selections }), { status: 200, headers: { "content-type": "application/json" } });

describe("legacy Jev context router", () => {
  beforeEach(clearJevContextRouterCacheForTest);

  it("is opt-in and does not call Jev by default", async () => {
    const fetch = vi.fn();
    expect(await routeLegacyAdapterContext({ old: "history" }, { fetch })).toEqual({ old: "history" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns a projection without mutating the durable source", async () => {
    const source = { request: { text: "now" }, useful: "keep", stale: "drop" };
    const result = await routeLegacyAdapterContext(source, { enabled: true, endpoint: "http://jev", fetch: vi.fn(async () => response([{ id: "useful", score: 0.9 }])) });
    expect(result).toEqual({ request: { text: "now" }, useful: "keep" });
    expect(source).toEqual({ request: { text: "now" }, useful: "keep", stale: "drop" });
  });

  it("always preserves mandatory context", async () => {
    const input = { systemPolicy: "rules", governance: "core", currentRequest: "work", wakeOriginComments: [1], newestFourMessages: [2], skillTriggers: [3], symbolMatches: [4], permissions: [5], unresolvedDecisions: [6], old: "drop" };
    expect(await routeLegacyAdapterContext(input, { enabled: true, endpoint: "http://jev", fetch: vi.fn(async () => response([{ id: "old", score: 0.1 }])) })).toEqual(input);
  });

  it("applies threshold and top-k relevance selection", async () => {
    const fetch = vi.fn(async () => response([{ id: "a", score: 0.9 }, { id: "b", score: 0.8 }, { id: "c", score: 0.4 }]));
    expect(await routeLegacyAdapterContext({ request: "x", a: 1, b: 2, c: 3 }, { enabled: true, endpoint: "http://jev", threshold: 0.5, topK: 1, fetch })).toEqual({ request: "x", a: 1 });
  });

  it("fails open on errors, malformed and empty answers", async () => {
    const input = { request: "x", history: "all" };
    for (const fetch of [vi.fn(async () => { throw new Error("down"); }), vi.fn(async () => new Response("{}")), vi.fn(async () => response([]))]) {
      expect(await routeLegacyAdapterContext(input, { enabled: true, endpoint: "http://jev", fetch })).toEqual(input);
    }
  });

  it("caches identical decisions", async () => {
    const fetch = vi.fn(async () => response([{ id: "history", score: 0.9 }]));
    const options = { enabled: true, endpoint: "http://jev", fetch };
    await routeLegacyAdapterContext({ request: "x", history: "h" }, options);
    await routeLegacyAdapterContext({ request: "x", history: "h" }, options);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
