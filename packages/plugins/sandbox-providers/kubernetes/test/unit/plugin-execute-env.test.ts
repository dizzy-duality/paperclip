import { beforeEach, describe, expect, it, vi } from "vitest";

// Drive onEnvironmentExecute against a fake cluster and record every exec.
const h = vi.hoisted(() => ({
  clients: {} as Record<string, unknown>,
  execs: [] as Array<{ command: string[]; stdin: string | undefined }>,
}));

vi.mock("../../src/kube-client.js", () => ({
  createKubeConfig: vi.fn(() => ({})),
  makeKubeClients: vi.fn(() => h.clients),
}));

vi.mock("../../src/pod-exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/pod-exec.js")>();
  return {
    ...actual,
    execInPod: vi.fn(async (_kc: unknown, _ns: string, _pod: string, _c: string, command: string[], stdin?: string | Buffer) => {
      h.execs.push({ command, stdin: stdin === undefined ? undefined : stdin.toString() });
      return { exitCode: 0, stdout: "ok", stderr: "" };
    }),
  };
});

import plugin from "../../src/plugin.js";

const TOKEN = "sk-ant-oat01-must-not-appear-in-argv";

beforeEach(() => {
  h.execs = [];
  h.clients = {
    custom: {
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: { uid: "uid-1" },
        status: { conditions: [{ type: "Ready", status: "True" }], podName: "pc-abc-pod" },
      }),
    },
  };
});

describe("onEnvironmentExecute run env", () => {
  it("sends env values over stdin and never in an exec's argv", async () => {
    const result = await plugin.definition.onEnvironmentExecute!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: { inCluster: true, backend: "sandbox-cr" },
      lease: {
        providerLeaseId: "pc-abc",
        metadata: { namespace: "paperclip-acme", podName: "pc-abc-pod", backend: "sandbox-cr" },
      },
      command: "claude",
      args: ["--print"],
      env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
      timeoutMs: 30_000,
    } as never);

    expect(result.exitCode).toBe(0);
    expect(h.execs).toHaveLength(2);
    for (const exec of h.execs) expect(exec.command.join(" ")).not.toContain(TOKEN);
    expect(h.execs[0]!.stdin).toContain(TOKEN);
    expect(h.execs[1]!.command.slice(-2)).toEqual(["claude", "--print"]);
  });

  it("runs the command directly, in one exec, when there is no env", async () => {
    await plugin.definition.onEnvironmentExecute!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: { inCluster: true, backend: "sandbox-cr" },
      lease: {
        providerLeaseId: "pc-abc",
        metadata: { namespace: "paperclip-acme", podName: "pc-abc-pod", backend: "sandbox-cr" },
      },
      command: "claude",
      args: ["--print"],
      timeoutMs: 30_000,
    } as never);
    expect(h.execs.map((e) => e.command)).toEqual([["claude", "--print"]]);
  });
});
