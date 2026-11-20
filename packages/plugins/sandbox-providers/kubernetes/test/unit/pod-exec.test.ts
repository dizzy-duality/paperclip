import { describe, it, expect, vi } from "vitest";
import { Readable, Writable } from "node:stream";
import type { PassThrough } from "node:stream";

// Mock the k8s client so `execInPod` runs against a scripted WebSocket exec: the
// fake `Exec.exec` streams stdout chunks into the provided PassThrough and, for
// the success path, reports an exit status. This exercises the host-side stdout
// accumulation cap without a real cluster.
type StatusCb = (status: {
  reason?: string;
  message?: string;
  status: string;
  details?: { causes?: { reason?: string; message?: string }[] };
}) => void;

let setupError: unknown = null;
let scriptedExec: (
  stdout: PassThrough,
  stderr: PassThrough,
  statusCb: StatusCb,
  stdin: PassThrough | null,
) => void = () => undefined;

vi.mock("@kubernetes/client-node", () => {
  class Exec {
    constructor(_kc: unknown) {}
    async exec(
      _namespace: string,
      _podName: string,
      _containerName: string,
      _command: string[],
      stdout: PassThrough,
      stderr: PassThrough,
      stdin: PassThrough | null,
      _tty: boolean,
      statusCb: StatusCb,
    ) {
      if (setupError) throw setupError;
      // Defer so the caller has wired its stream listeners first.
      setImmediate(() => scriptedExec(stdout, stderr, statusCb, stdin));
      return { close() {} };
    }
  }
  return { Exec };
});

const { ExecSetupError, execInPod, execInPodStreaming, retryExecSetup } = await import("../../src/pod-exec.js");

const KC = {} as never;

describe("execInPod stdout cap", () => {
  it("fails closed when pod stdout exceeds the cap", async () => {
    scriptedExec = (stdout) => {
      // Emit more than the cap in a single chunk; the host must reject.
      stdout.write(Buffer.alloc(64, 0x41));
    };
    await expect(
      execInPod(KC, "ns", "pod", "agent", ["/bin/sh", "-c", ":"], undefined, 5_000, 16),
    ).rejects.toThrow(/cap|exceeded/i);
  });

  it("accepts stdout within the cap and returns the accumulated output", async () => {
    scriptedExec = (stdout, stderr, statusCb) => {
      stdout.write(Buffer.from("hello", "utf-8"));
      stdout.end();
      stderr.end();
      statusCb({ status: "Success" });
    };
    const result = await execInPod(
      KC,
      "ns",
      "pod",
      "agent",
      ["/bin/sh", "-c", ":"],
      undefined,
      5_000,
      1024,
    );
    expect(result).toEqual({ exitCode: 0, stdout: "hello", stderr: "" });
  });

  it("leaves stdout unbounded when no cap is provided", async () => {
    scriptedExec = (stdout, stderr, statusCb) => {
      stdout.write(Buffer.alloc(4096, 0x42));
      stdout.end();
      stderr.end();
      statusCb({ status: "Success" });
    };
    const result = await execInPod(
      KC,
      "ns",
      "pod",
      "agent",
      ["/bin/sh", "-c", ":"],
      undefined,
      5_000,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toHaveLength(4096);
  });
});

describe("execInPod stderr cap", () => {
  it("fails closed when pod stderr exceeds the cap", async () => {
    // stderr is equally pod-controlled: a malicious pod that floods stderr must
    // not grow the host accumulator without bound. Same DoS class as stdout.
    scriptedExec = (_stdout, stderr) => {
      stderr.write(Buffer.alloc(64, 0x45));
    };
    await expect(
      // maxStdoutBytes generous, maxStderrBytes = 16 -> stderr must trip.
      execInPod(KC, "ns", "pod", "agent", ["/bin/sh", "-c", ":"], undefined, 5_000, 1024, 16),
    ).rejects.toThrow(/stderr.*cap|cap.*stderr|exceeded/i);
  });

  it("accepts stderr within the cap and returns the accumulated output", async () => {
    scriptedExec = (stdout, stderr, statusCb) => {
      stderr.write(Buffer.from("warn", "utf-8"));
      stdout.end();
      stderr.end();
      statusCb({ status: "Success" });
    };
    const result = await execInPod(
      KC,
      "ns",
      "pod",
      "agent",
      ["/bin/sh", "-c", ":"],
      undefined,
      5_000,
      1024,
      1024,
    );
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "warn" });
  });

  it("leaves stderr unbounded when no cap is provided", async () => {
    scriptedExec = (stdout, stderr, statusCb) => {
      stderr.write(Buffer.alloc(4096, 0x46));
      stdout.end();
      stderr.end();
      statusCb({ status: "Success" });
    };
    const result = await execInPod(
      KC,
      "ns",
      "pod",
      "agent",
      ["/bin/sh", "-c", ":"],
      undefined,
      5_000,
      1024,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toHaveLength(4096);
  });
});

describe("execInPodStreaming", () => {
  it("streams the command's stdout into the caller sink and resolves with exit code + stderr", async () => {
    scriptedExec = (stdout, stderr, statusCb) => {
      stdout.write(Buffer.from("chunk-one;"));
      stdout.write(Buffer.from("chunk-two"));
      stdout.end();
      stderr.write(Buffer.from("warn"));
      stderr.end();
      statusCb({ status: "Success" });
    };
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
    });
    const result = await execInPodStreaming(KC, "ns", "pod", "agent", ["/bin/sh", "-c", ":"], {
      stdout: sink,
      timeoutMs: 5_000,
    });
    expect(result).toEqual({ exitCode: 0, stderr: "warn" });
    expect(Buffer.concat(chunks).toString("utf-8")).toBe("chunk-one;chunk-two");
  });

  it("streams the caller stdin Readable into the pod command", async () => {
    let received = Buffer.alloc(0);
    scriptedExec = (stdout, stderr, statusCb, stdin) => {
      if (stdin) {
        stdin.on("data", (chunk: Buffer) => {
          received = Buffer.concat([received, chunk]);
        });
      }
      // Resolve once the source has been fully piped through.
      setImmediate(() => {
        stdout.end();
        stderr.end();
        statusCb({ status: "Success" });
      });
    };
    const source = Readable.from([Buffer.from("payload-bytes")]);
    const result = await execInPodStreaming(KC, "ns", "pod", "agent", ["/bin/sh", "-c", ":"], {
      stdin: source,
      timeoutMs: 5_000,
    });
    expect(result.exitCode).toBe(0);
    expect(received.toString("utf-8")).toBe("payload-bytes");
  });

  it("fails closed when the pod floods stderr past the cap", async () => {
    scriptedExec = (_stdout, stderr) => {
      stderr.write(Buffer.alloc(64, 0x45));
    };
    const sink = new Writable({ write(_c, _e, cb) { cb(); } });
    await expect(
      execInPodStreaming(KC, "ns", "pod", "agent", ["/bin/sh", "-c", ":"], {
        stdout: sink,
        timeoutMs: 5_000,
        maxStderrBytes: 16,
      }),
    ).rejects.toThrow(/stderr.*cap|exceeded/i);
  });

  it("fails closed when the caller sink errors (e.g. a streamed-bytes disk guard trips)", async () => {
    scriptedExec = (stdout, stderr, statusCb) => {
      stdout.write(Buffer.alloc(4096, 0x42));
      stdout.end();
      stderr.end();
      statusCb({ status: "Success" });
    };
    // A sink that rejects any write, standing in for the file-sync disk guard.
    const sink = new Writable({
      write(_chunk, _enc, cb) {
        cb(new Error("streamed-output disk guard tripped"));
      },
    });
    await expect(
      execInPodStreaming(KC, "ns", "pod", "agent", ["/bin/sh", "-c", ":"], {
        stdout: sink,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/disk guard/i);
  });
});

// A failure status without an ExitCode cause comes from the API server or the
// kubelet, not the command. Reporting it as a bare exit 1 left runs failing
// with "could not stage the run environment in the pod:" and nothing after it.
describe("exec status without an exit code", () => {
  const refused = (stdout: PassThrough, stderr: PassThrough, statusCb: StatusCb) => {
    stdout.end();
    stderr.end();
    statusCb({ status: "Failure", reason: "InternalError", message: "container not running" });
  };

  it("execInPod reports the API reason and message on stderr", async () => {
    scriptedExec = refused;
    const result = await execInPod(KC, "ns", "pod", "agent", ["/bin/sh", "-c", ":"], undefined, 5_000);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("[kubernetes exec Failure] InternalError: container not running");
  });

  it("execInPodStreaming reports it after the command's own stderr", async () => {
    scriptedExec = (stdout, stderr, statusCb) => {
      stderr.write("partial\n");
      refused(stdout, stderr, statusCb);
    };
    const result = await execInPodStreaming(KC, "ns", "pod", "agent", ["/bin/sh", "-c", ":"], { timeoutMs: 5_000 });
    expect(result).toEqual({
      exitCode: 1,
      stderr: "partial\n[kubernetes exec Failure] InternalError: container not running",
    });
  });

  it("keeps a command's own exit code and stderr unchanged", async () => {
    scriptedExec = (stdout, stderr, statusCb) => {
      stderr.write("mkdir: cannot create directory");
      stdout.end();
      stderr.end();
      statusCb({
        status: "Failure",
        reason: "NonZeroExitCode",
        message: "command terminated with non-zero exit code",
        details: { causes: [{ reason: "ExitCode", message: "2" }] },
      });
    };
    const result = await execInPod(KC, "ns", "pod", "agent", ["/bin/sh", "-c", ":"], undefined, 5_000);
    expect(result).toEqual({ exitCode: 2, stdout: "", stderr: "mkdir: cannot create directory" });
  });
});

describe("exec that never opened", () => {
  it("rejects with ExecSetupError carrying the WebSocket event's message", async () => {
    // client-node rejects with a WebSocket ErrorEvent, not an Error.
    setupError = { type: "error", message: "Unexpected server response: 500" };
    try {
      const failure = execInPod(KC, "ns", "pod", "agent", ["/bin/sh", "-c", ":"], undefined, 5_000);
      await expect(failure).rejects.toBeInstanceOf(ExecSetupError);
      await expect(failure).rejects.toThrow("kubernetes exec could not be opened: Unexpected server response: 500");
    } finally {
      setupError = null;
    }
  });
});

describe("retryExecSetup", () => {
  const ok = { exitCode: 0, stdout: "", stderr: "" };
  const apiFailure = { exitCode: 1, stdout: "", stderr: "x", apiFailure: true as const };
  const opts = (retryApiFailure: boolean, remaining = 10_000) => ({
    retryApiFailure,
    remainingMs: () => remaining,
    delaysMs: [0, 0],
  });

  it("re-runs after a setup error, at most twice", async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new ExecSetupError("a"))
      .mockRejectedValueOnce(new ExecSetupError("b"))
      .mockRejectedValueOnce(new ExecSetupError("c"));
    await expect(retryExecSetup(run, opts(false))).rejects.toThrow(/c$/);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("does not re-run after any other error, such as a watchdog timeout", async () => {
    const run = vi.fn().mockRejectedValue(new Error("execInPod timed out"));
    await expect(retryExecSetup(run, opts(true))).rejects.toThrow("timed out");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("re-runs an API failure only when asked to", async () => {
    const twice = vi.fn().mockResolvedValueOnce(apiFailure).mockResolvedValueOnce(ok);
    expect(await retryExecSetup(twice, opts(true))).toEqual(ok);
    const once = vi.fn().mockResolvedValue(apiFailure);
    expect(await retryExecSetup(once, opts(false))).toEqual(apiFailure);
    expect(once).toHaveBeenCalledTimes(1);
  });

  it("does not re-run once the remaining budget cannot cover the delay", async () => {
    const run = vi.fn().mockRejectedValue(new ExecSetupError("a"));
    await expect(
      retryExecSetup(run, { retryApiFailure: false, remainingMs: () => 100, delaysMs: [500] }),
    ).rejects.toBeInstanceOf(ExecSetupError);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
