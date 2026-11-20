import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A fresh pod's readiness wait (scheduling, image pull) gets a grace period on
// top of the command's timeout: the first command on a node that still had to
// pull a 333 MB image used to fail its 15 s budget before it started. The grace
// stays under the server's 30 s RPC overhead buffer.
const h = vi.hoisted(() => ({
  readyWaitMs: 0,
  readyTimeoutMs: 0,
  execTimeoutMs: 0,
  stageMs: 0,
  execs: [] as Array<{ command: string[]; timeoutMs: number }>,
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
    execInPod: vi.fn(async (_kc: unknown, _ns: string, _p: string, _c: string, cmd: string[], _in?: unknown, timeoutMs?: number) => {
      h.execs.push({ command: cmd, timeoutMs: timeoutMs ?? 0 });
      h.execTimeoutMs = timeoutMs ?? 0;
      // Staging takes h.stageMs of wall-clock time.
      if (cmd.join(" ").includes("head -c")) vi.setSystemTime(Date.now() + h.stageMs);
      return { exitCode: 0, stdout: "", stderr: "" };
    }),
  };
});

import plugin from "../../src/plugin.js";

beforeEach(() => {
  h.execs = [];
  h.stageMs = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-02T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

async function executeOnFreshLease(leaseId: string, env?: Record<string, string>) {
  return plugin.definition.onEnvironmentExecute!({
    driverKey: "kubernetes",
    companyId: "acme",
    environmentId: "env-1",
    config: { inCluster: true, backend: "sandbox-cr" },
    lease: { providerLeaseId: leaseId, metadata: { namespace: "paperclip-acme", backend: "sandbox-cr" } },
    command: "sh",
    args: ["-c", "git rev-parse --show-toplevel"],
    timeoutMs: 15_000,
    env,
  } as never);
}

describe("onEnvironmentExecute readiness grace", () => {
  it("gives the command its full timeout after a slow pod start", async () => {
    h.readyWaitMs = 16_000;
    const result = await executeOnFreshLease("pc-slow-pull");
    expect(result.exitCode).toBe(0);
    expect(h.execTimeoutMs).toBe(15_000);
  });

  it("bounds readiness by the command timeout plus a grace under the server's 30 s buffer", async () => {
    h.readyWaitMs = 0;
    await executeOnFreshLease("pc-bounded");
    expect(h.readyTimeoutMs).toBe(15_000 + 25_000);
  });

  it("shortens the command when readiness overran the grace, so the server deadline still holds", async () => {
    h.readyWaitMs = 30_000;
    await executeOnFreshLease("pc-very-slow");
    expect(h.execTimeoutMs).toBe(10_000);
  });

  it("charges staging and the command against one deadline", async () => {
    h.readyWaitMs = 30_000;
    h.stageMs = 6_000;
    await executeOnFreshLease("pc-staged", { TOKEN: "x" });
    expect(h.execs.map((e) => e.timeoutMs)).toEqual([10_000, 4_000]);
  });

  it("does not start a command once the deadline has passed", async () => {
    h.readyWaitMs = 41_000;
    const result = await executeOnFreshLease("pc-too-slow");
    expect(h.execs).toHaveLength(0);
    expect(result.timedOut).toBe(true);
  });
});
