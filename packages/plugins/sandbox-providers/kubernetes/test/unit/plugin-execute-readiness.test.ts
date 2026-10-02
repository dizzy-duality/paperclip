import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A fresh pod's readiness wait (scheduling, image pull) must not eat the
// command's own timeout: the first command on a node that still had to pull a
// 333 MB image used to fail its 15 s budget before it started.
const h = vi.hoisted(() => ({
  readyWaitMs: 0,
  readyTimeoutMs: 0,
  execTimeoutMs: 0,
}));

vi.mock("../../src/kube-client.js", () => ({
  createKubeConfig: vi.fn(() => ({})),
  makeKubeClients: vi.fn(() => ({})),
}));

vi.mock("../../src/sandbox-cr-orchestrator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/sandbox-cr-orchestrator.js")>();
  return {
    ...actual,
    sandboxCrOrchestrator: {
      ...actual.sandboxCrOrchestrator,
      // Simulate a slow image pull: the clock moves while we "wait".
      waitForCompletion: vi.fn(async (_c: unknown, _n: string, _l: string, opts: { timeoutMs: number }) => {
        h.readyTimeoutMs = opts.timeoutMs;
        vi.setSystemTime(Date.now() + h.readyWaitMs);
      }),
      findPod: vi.fn(async () => "pc-pod"),
    },
  };
});

vi.mock("../../src/pod-exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/pod-exec.js")>();
  return {
    ...actual,
    execInPod: vi.fn(async (_kc: unknown, _ns: string, _p: string, _c: string, _cmd: string[], _in?: unknown, timeoutMs?: number) => {
      h.execTimeoutMs = timeoutMs ?? 0;
      return { exitCode: 0, stdout: "", stderr: "" };
    }),
  };
});

import plugin from "../../src/plugin.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-02T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

async function executeOnFreshLease(leaseId: string, config: Record<string, unknown> = {}) {
  return plugin.definition.onEnvironmentExecute!({
    driverKey: "kubernetes",
    companyId: "acme",
    environmentId: "env-1",
    config: { inCluster: true, backend: "sandbox-cr", ...config },
    lease: { providerLeaseId: leaseId, metadata: { namespace: "paperclip-acme", backend: "sandbox-cr" } },
    command: "sh",
    args: ["-c", "git rev-parse --show-toplevel"],
    timeoutMs: 15_000,
  } as never);
}

describe("onEnvironmentExecute readiness budget", () => {
  it("gives the command its full timeout after a slow pod start", async () => {
    h.readyWaitMs = 16_000;
    const result = await executeOnFreshLease("pc-slow-pull");
    expect(result.exitCode).toBe(0);
    expect(h.execTimeoutMs).toBe(15_000);
  });

  it("waits for readiness up to podReadyTimeoutSec, not the command timeout", async () => {
    h.readyWaitMs = 0;
    await executeOnFreshLease("pc-default-budget");
    expect(h.readyTimeoutMs).toBe(180_000);
    await executeOnFreshLease("pc-custom-budget", { podReadyTimeoutSec: 60 });
    expect(h.readyTimeoutMs).toBe(60_000);
  });
});
