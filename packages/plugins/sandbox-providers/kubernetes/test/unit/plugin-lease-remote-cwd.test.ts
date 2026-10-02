import { beforeEach, describe, expect, it, vi } from "vitest";

// The server reads lease.metadata.remoteCwd before realizeWorkspace runs and
// never copies realizeWorkspace's metadata onto the lease (paperclip#13587), so
// the lease itself must carry it from acquire and resume onward.
const h = vi.hoisted(() => ({ clients: {} as Record<string, unknown> }));

vi.mock("../../src/kube-client.js", () => ({
  createKubeConfig: vi.fn(() => ({})),
  makeKubeClients: vi.fn(() => h.clients),
}));

import plugin from "../../src/plugin.js";

// A Kubernetes API where every call succeeds and every object exists and is Ready.
function permissiveClient(): unknown {
  const ready = {
    metadata: { uid: "uid-1", name: "x" },
    status: { conditions: [{ type: "Ready", status: "True" }], podName: "pc-pod", phase: "Running" },
    items: [{ metadata: { name: "pc-pod" }, status: { phase: "Running" } }],
  };
  return new Proxy({}, { get: () => vi.fn().mockResolvedValue(ready) });
}

beforeEach(() => {
  h.clients = new Proxy({}, { get: () => permissiveClient() });
});

const base = { driverKey: "kubernetes", companyId: "acme", environmentId: "env-1" };

describe("lease remoteCwd", () => {
  it("is set on a freshly acquired sandbox-cr lease", async () => {
    const lease = await plugin.definition.onEnvironmentAcquireLease!({
      ...base,
      config: { inCluster: true, backend: "sandbox-cr" },
      runId: "run-1",
    } as never);
    expect(lease.metadata?.remoteCwd).toBe("/workspace");
  });

  it("falls back to the workspace mount on resume when none was recorded", async () => {
    const lease = await plugin.definition.onEnvironmentResumeLease!({
      ...base,
      config: { inCluster: true, backend: "sandbox-cr" },
      providerLeaseId: "pc-abc",
      leaseMetadata: { namespace: "paperclip-acme", jobName: "pc-abc", podName: "pc-pod", backend: "sandbox-cr" },
    });
    expect(lease.metadata?.remoteCwd).toBe("/workspace");
  });

  it("keeps a root recorded earlier when the lease is resumed", async () => {
    const lease = await plugin.definition.onEnvironmentResumeLease!({
      ...base,
      config: { inCluster: true, backend: "sandbox-cr" },
      providerLeaseId: "pc-abc",
      leaseMetadata: {
        namespace: "paperclip-acme", jobName: "pc-abc", podName: "pc-pod", backend: "sandbox-cr",
        remoteCwd: "/workspace/custom",
      },
    });
    expect(lease.metadata?.remoteCwd).toBe("/workspace/custom");
  });
});
