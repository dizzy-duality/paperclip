import { beforeEach, describe, expect, it, vi } from "vitest";

// An environment's nodeSelector must reach the Sandbox the plugin creates,
// e.g. to keep agent pods in the server's datacenter.
const h = vi.hoisted(() => ({ clients: {} as Record<string, unknown>, bodies: [] as unknown[] }));

vi.mock("../../src/kube-client.js", () => ({
  createKubeConfig: vi.fn(() => ({})),
  makeKubeClients: vi.fn(() => h.clients),
}));

import plugin from "../../src/plugin.js";

// A Kubernetes API where every call succeeds, every object is Ready, and every
// request body is recorded.
function recordingClient(): unknown {
  const ready = {
    metadata: { uid: "uid-1", name: "x" },
    status: { conditions: [{ type: "Ready", status: "True" }], podName: "pc-pod", phase: "Running" },
    items: [{ metadata: { name: "pc-pod" }, status: { phase: "Running" } }],
  };
  return new Proxy({}, {
    get: () => vi.fn(async (arg: { body?: unknown } | undefined) => {
      if (arg && typeof arg === "object" && "body" in arg) h.bodies.push(arg.body);
      return ready;
    }),
  });
}

beforeEach(() => {
  h.bodies = [];
  h.clients = new Proxy({}, { get: () => recordingClient() });
});

const sandboxSpec = () => {
  const sandbox = h.bodies.find((b) => (b as { kind?: string })?.kind === "Sandbox") as
    | { spec: { podTemplate: { spec: Record<string, unknown> } } }
    | undefined;
  expect(sandbox, "a Sandbox was created").toBeDefined();
  return sandbox!.spec.podTemplate.spec;
};

describe("environment nodeSelector", () => {
  const base = { driverKey: "kubernetes", companyId: "acme", environmentId: "env-1", runId: "run-1" };

  it("is applied to the agent pod", async () => {
    await plugin.definition.onEnvironmentAcquireLease!({
      ...base,
      config: { inCluster: true, backend: "sandbox-cr", nodeSelector: { "kubernetes.io/hostname": "hive10" } },
    } as never);
    expect(sandboxSpec().nodeSelector).toEqual({ "kubernetes.io/hostname": "hive10" });
  });

  it("is absent when not configured", async () => {
    await plugin.definition.onEnvironmentAcquireLease!({
      ...base,
      config: { inCluster: true, backend: "sandbox-cr" },
    } as never);
    expect(sandboxSpec().nodeSelector).toBeUndefined();
  });

  it("is applied to the agent pod on the job backend too", async () => {
    await plugin.definition.onEnvironmentAcquireLease!({
      ...base,
      config: { inCluster: true, backend: "job", nodeSelector: { "kubernetes.io/hostname": "hive10" } },
    } as never);
    const job = h.bodies.find((b) => (b as { kind?: string })?.kind === "Job") as
      | { spec: { template: { spec: Record<string, unknown> } } }
      | undefined;
    expect(job, "a Job was created").toBeDefined();
    expect(job!.spec.template.spec.nodeSelector).toEqual({ "kubernetes.io/hostname": "hive10" });
  });
});
