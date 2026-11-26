import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_AUTH_JSON_ENV_KEY,
  InvalidCodexAuthJsonError,
  REDACTED_CODEX_ACCOUNT_HANDLE,
  materializeCodexAuthJsonSecret,
  parseCodexAuthJsonEnv,
  redactCodexAccountHandleInError,
  stripCodexAuthJsonFromEnv,
} from "./codex-auth-json.js";
import { createCodexAcpExecutor, testCodexAcpEnvironment } from "./acp.js";
import { copyBackCodexAuth } from "./codex-auth-copyback.js";
import {
  evaluateCodexCredentialReadiness,
  resolveCodexAuthCopyBackTarget,
  resolveCodexVendTargetAuthPath,
  resolveManagedCodexHomeDir,
} from "./codex-home.js";
import { execute } from "./execute.js";

function subscriptionAuthJson(opts: {
  accountId: string;
  lastRefresh: string;
  marker: string;
}): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: `id-${opts.marker}`,
      access_token: `access-${opts.marker}`,
      refresh_token: `refresh-${opts.marker}`,
      account_id: opts.accountId,
    },
    last_refresh: opts.lastRefresh,
  });
}

describe("CODEX_AUTH_JSON parsing and materialization", () => {
  const scratchDirs: string[] = [];

  async function makeScratchDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
    scratchDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    vi.unstubAllEnvs();
    while (scratchDirs.length > 0) {
      const dir = scratchDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("parses raw JSON and base64-encoded subscription auth.json payloads", () => {
    const raw = subscriptionAuthJson({
      accountId: "acct-colleague-y",
      lastRefresh: "2026-10-01T10:00:00Z",
      marker: "colleague-y",
    });
    const parsedRaw = parseCodexAuthJsonEnv(raw);
    expect(parsedRaw.accountId).toBe("acct-colleague-y");
    expect(parsedRaw.accountHandle).toBe("acct-colleague-y");
    expect(parsedRaw.bytes.toString("utf8")).toBe(raw);

    const b64 = Buffer.from(raw, "utf8").toString("base64");
    const wrappedB64 = `${b64.slice(0, 24)}\n  ${b64.slice(24)}`;
    const parsedB64 = parseCodexAuthJsonEnv(wrappedB64);
    expect(parsedB64.accountId).toBe("acct-colleague-y");
    expect(parsedB64.bytes.toString("utf8")).toBe(raw);
  });

  it("fails closed on invalid, API-key, or missing-identity payloads without leaking secrets", () => {
    const secretToken = "refresh-SUPER-SECRET-TOKEN-12345";
    const apiKeyPayload = JSON.stringify({ OPENAI_API_KEY: "sk-secret-key-999" });
    const missingIdentityPayload = JSON.stringify({
      tokens: { refresh_token: secretToken, access_token: "access-secret" },
    });

    for (const bad of ["", "   ", "not-json-or-base64!!!", apiKeyPayload, missingIdentityPayload]) {
      let caught: unknown = null;
      try {
        parseCodexAuthJsonEnv(bad);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(InvalidCodexAuthJsonError);
      const message = (caught as Error).message;
      expect(message).not.toContain(secretToken);
      expect(message).not.toContain("sk-secret-key-999");
    }
  });

  it("isolates multiple organisations' accounts and preserves strictly-newer rotated tokens", async () => {
    const root = await makeScratchDir("paperclip-codex-multi-org-");
    const env: NodeJS.ProcessEnv = {
      PAPERCLIP_HOME: root,
      PAPERCLIP_INSTANCE_ID: "default",
      CODEX_HOME: path.join(root, "shared-host"),
    };

    const userX = subscriptionAuthJson({
      accountId: "acct-user-x",
      lastRefresh: "2026-10-01T10:00:00Z",
      marker: "user-x-v1",
    });
    const colleagueY = subscriptionAuthJson({
      accountId: "acct-colleague-y",
      lastRefresh: "2026-10-01T10:00:00Z",
      marker: "colleague-y-v1",
    });

    const orgA = await materializeCodexAuthJsonSecret({ raw: userX, companyId: "org-a", env });
    const orgB = await materializeCodexAuthJsonSecret({
      raw: Buffer.from(colleagueY, "utf8").toString("base64"),
      companyId: "org-b",
      env,
    });

    expect(orgA.outcome).toBe("written");
    expect(orgB.outcome).toBe("written");
    expect(orgA.accountHomeDir).not.toBe(orgB.accountHomeDir);
    expect(orgA.accountHomeDir).toContain(path.join("companies", "org-a", "codex-auth-cache"));
    expect(orgB.accountHomeDir).toContain(path.join("companies", "org-b", "codex-auth-cache"));
    expect((await lstat(orgB.authPath)).mode & 0o777).toBe(0o600);

    // Simulate Codex rotating colleague Y's refresh token during a run and
    // copy-back updating the slot to v2.
    const colleagueYV2 = subscriptionAuthJson({
      accountId: "acct-colleague-y",
      lastRefresh: "2026-10-01T12:00:00Z",
      marker: "colleague-y-v2-rotated",
    });
    const copyBackOutcome = await copyBackCodexAuth({
      readSandboxAuth: async () => Buffer.from(colleagueYV2, "utf8"),
      hostAuthPath: orgB.authPath,
      resolveCacheEntryPath: async () => orgB.authPath,
      log: () => undefined,
      env,
    });
    expect(copyBackOutcome).toBe("copied");

    // Re-running with the older static secret v1 MUST keep the rotated v2 token.
    const rerunOldSecret = await materializeCodexAuthJsonSecret({
      raw: colleagueY,
      companyId: "org-b",
      env,
    });
    expect(rerunOldSecret.outcome).toBe("kept");
    expect(await readFile(orgB.authPath, "utf8")).toContain("colleague-y-v2-rotated");

    // Updating the secret to an even newer v3 token MUST adopt v3.
    const colleagueYV3 = subscriptionAuthJson({
      accountId: "acct-colleague-y",
      lastRefresh: "2026-10-01T14:00:00Z",
      marker: "colleague-y-v3-secret-rotated",
    });
    const rerunNewSecret = await materializeCodexAuthJsonSecret({
      raw: colleagueYV3,
      companyId: "org-b",
      env,
    });
    expect(rerunNewSecret.outcome).toBe("written");
    expect(await readFile(orgB.authPath, "utf8")).toContain("colleague-y-v3-secret-rotated");

    // Org A remains completely untouched on user X.
    expect(await readFile(orgA.authPath, "utf8")).toContain("user-x-v1");
  });

  it("strips CODEX_AUTH_JSON from env objects cleanly", () => {
    const stripped = stripCodexAuthJsonFromEnv({
      CODEX_AUTH_JSON: "{\"secret\":true}",
      KEEP_ME: "yes",
    });
    expect(stripped).toEqual({ KEEP_ME: "yes" });
    expect(Object.hasOwn(stripped, CODEX_AUTH_JSON_ENV_KEY)).toBe(false);
  });
});

describe("resolveCodexAuthCopyBackTarget and resolveCodexVendTargetAuthPath", () => {
  const scratchDirs: string[] = [];

  async function makeScratchDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
    scratchDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    while (scratchDirs.length > 0) {
      const dir = scratchDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("targets provider/auth.json for managedAiConnection even when runtimeSkillDigest redirects effectiveCodexHome", async () => {
    const root = await makeScratchDir("paperclip-codex-cb-managed-");
    const env: NodeJS.ProcessEnv = {
      PAPERCLIP_HOME: root,
      PAPERCLIP_INSTANCE_ID: "default",
      CODEX_HOME: path.join(root, "shared"),
    };
    const providerHome = path.join(root, "tmp-managed-ai", "provider");
    const skillRuntimeHome = path.join(
      resolveManagedCodexHomeDir(env, "org-b"),
      "skill-runtimes",
      "agent-1",
      "digest123",
    );
    await mkdir(providerHome, { recursive: true });
    await mkdir(skillRuntimeHome, { recursive: true });
    await writeFile(path.join(providerHome, "auth.json"), "{}", "utf8");
    await symlink(path.join(providerHome, "auth.json"), path.join(skillRuntimeHome, "auth.json"));

    const target = await resolveCodexAuthCopyBackTarget({
      env,
      companyId: "org-b",
      managedAiConnection: true,
      runtimeCredentialHome: providerHome,
      effectiveCodexHome: skillRuntimeHome,
    });
    expect(target).toBe(path.join(providerHome, "auth.json"));
  });

  it("targets a promoted per-company auth.json for both copy-back and vend instead of the shared host", async () => {
    const root = await makeScratchDir("paperclip-codex-cb-promoted-");
    const sharedHome = path.join(root, "shared");
    const env: NodeJS.ProcessEnv = {
      PAPERCLIP_HOME: root,
      PAPERCLIP_INSTANCE_ID: "default",
      CODEX_HOME: sharedHome,
    };
    const companyHome = resolveManagedCodexHomeDir(env, "org-b");
    await mkdir(sharedHome, { recursive: true });
    await mkdir(companyHome, { recursive: true });
    await writeFile(
      path.join(sharedHome, "auth.json"),
      subscriptionAuthJson({ accountId: "acct-user-x", lastRefresh: "2026-10-01T10:00:00Z", marker: "host-x" }),
    );
    await writeFile(
      path.join(companyHome, "auth.json"),
      subscriptionAuthJson({ accountId: "acct-colleague-y", lastRefresh: "2026-10-01T10:00:00Z", marker: "orgb-y" }),
    );

    const copyBackTarget = await resolveCodexAuthCopyBackTarget({
      env,
      companyId: "org-b",
      managedAiConnection: false,
      runtimeCredentialHome: null,
      effectiveCodexHome: companyHome,
    });
    expect(copyBackTarget).toBe(path.join(companyHome, "auth.json"));

    const vendTarget = await resolveCodexVendTargetAuthPath({
      env,
      companyId: "org-b",
      configuredCodexHome: null,
    });
    expect(vendTarget).toBe(path.join(companyHome, "auth.json"));
  });

  it("follows skill-runtime symlinks back to codex-auth-cache slots and skips vend on cache homes", async () => {
    const root = await makeScratchDir("paperclip-codex-cb-cache-");
    const env: NodeJS.ProcessEnv = {
      PAPERCLIP_HOME: root,
      PAPERCLIP_INSTANCE_ID: "default",
      CODEX_HOME: path.join(root, "shared"),
    };
    const raw = subscriptionAuthJson({
      accountId: "acct-colleague-y",
      lastRefresh: "2026-10-01T10:00:00Z",
      marker: "colleague-y",
    });
    const materialized = await materializeCodexAuthJsonSecret({ raw, companyId: "org-b", env });
    const skillRuntimeHome = path.join(
      resolveManagedCodexHomeDir(env, "org-b"),
      "skill-runtimes",
      "agent-1",
      "digest456",
    );
    await mkdir(skillRuntimeHome, { recursive: true });
    await symlink(materialized.authPath, path.join(skillRuntimeHome, "auth.json"));

    const copyBackTarget = await resolveCodexAuthCopyBackTarget({
      env,
      companyId: "org-b",
      managedAiConnection: false,
      runtimeCredentialHome: materialized.accountHomeDir,
      effectiveCodexHome: skillRuntimeHome,
    });
    expect(copyBackTarget).toBe(materialized.authPath);

    const vendTarget = await resolveCodexVendTargetAuthPath({
      env,
      companyId: "org-b",
      configuredCodexHome: materialized.accountHomeDir,
    });
    expect(vendTarget).toBeNull();
  });

  it("falls back to the shared host path when no auth.json exists yet on the host", async () => {
    const root = await makeScratchDir("paperclip-codex-cb-empty-");
    const sharedHome = path.join(root, "shared");
    const env: NodeJS.ProcessEnv = {
      PAPERCLIP_HOME: root,
      PAPERCLIP_INSTANCE_ID: "default",
      CODEX_HOME: sharedHome,
    };
    const companyHome = resolveManagedCodexHomeDir(env, "org-empty");
    await mkdir(companyHome, { recursive: true });

    const copyBackTarget = await resolveCodexAuthCopyBackTarget({
      env,
      companyId: "org-empty",
      managedAiConnection: false,
      runtimeCredentialHome: null,
      effectiveCodexHome: companyHome,
    });
    expect(copyBackTarget).toBe(path.join(sharedHome, "auth.json"));
  });
});

describe("evaluateCodexCredentialReadiness and execute with CODEX_AUTH_JSON", () => {
  const scratchDirs: string[] = [];

  async function makeScratchDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
    scratchDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    vi.unstubAllEnvs();
    while (scratchDirs.length > 0) {
      const dir = scratchDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("reports ready for valid CODEX_AUTH_JSON and fails closed for invalid CODEX_AUTH_JSON even when shared host has auth", async () => {
    const root = await makeScratchDir("paperclip-codex-readiness-");
    const sharedHome = path.join(root, "shared");
    await mkdir(sharedHome, { recursive: true });
    await writeFile(
      path.join(sharedHome, "auth.json"),
      subscriptionAuthJson({ accountId: "acct-host-x", lastRefresh: "2026-10-01T10:00:00Z", marker: "host-x" }),
    );
    const env: NodeJS.ProcessEnv = {
      PAPERCLIP_HOME: root,
      PAPERCLIP_INSTANCE_ID: "default",
      CODEX_HOME: sharedHome,
    };

    const validResult = await evaluateCodexCredentialReadiness({
      env,
      companyId: "org-b",
      configuredCodexHome: null,
      configuredApiKey: null,
      configuredAuthJson: subscriptionAuthJson({
        accountId: "acct-colleague-y",
        lastRefresh: "2026-10-01T10:00:00Z",
        marker: "colleague-y",
      }),
    });
    expect(validResult.ready).toBe(true);
    expect(validResult.authMode).toBe("subscription");

    const invalidResult = await evaluateCodexCredentialReadiness({
      env,
      companyId: "org-b",
      configuredCodexHome: null,
      configuredApiKey: null,
      configuredAuthJson: "corrupted-not-json",
    });
    expect(invalidResult.ready).toBe(false);
    expect(invalidResult.invalidReason).toBe("invalid_codex_auth_json");
  });

  it("executes with colleague Y's CODEX_AUTH_JSON instead of shared host user X and strips CODEX_AUTH_JSON from child env and logs", async () => {
    const root = await makeScratchDir("paperclip-codex-exec-secret-");
    const sharedHome = path.join(root, "shared-host");
    const workspaceDir = path.join(root, "workspace");
    const capturedPath = path.join(root, "captured.json");
    const fakeCodexPath = path.join(root, "fake-codex");
    await mkdir(sharedHome, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    // Shared host holds User X's login.
    await writeFile(
      path.join(sharedHome, "auth.json"),
      subscriptionAuthJson({ accountId: "acct-user-x", lastRefresh: "2026-10-01T10:00:00Z", marker: "host-user-x" }),
    );

    // Fake codex binary captures $CODEX_HOME/auth.json and checks env for CODEX_AUTH_JSON.
    await writeFile(
      fakeCodexPath,
      `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
process.stdin.resume();
process.stdin.on("end", () => {
  const authRaw = fs.readFileSync(path.join(process.env.CODEX_HOME, "auth.json"), "utf8");
  fs.writeFileSync(${JSON.stringify(capturedPath)}, JSON.stringify({
    codexHome: process.env.CODEX_HOME,
    hasCodexAuthJsonEnv: Object.prototype.hasOwnProperty.call(process.env, "CODEX_AUTH_JSON"),
    auth: JSON.parse(authRaw),
  }));
  console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-org-b" }));
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));
});
`,
      "utf8",
    );
    await chmod(fakeCodexPath, 0o755);

    vi.stubEnv("PAPERCLIP_HOME", root);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
    vi.stubEnv("CODEX_HOME", sharedHome);

    const colleagueYSecret = subscriptionAuthJson({
      accountId: "acct-colleague-y",
      lastRefresh: "2026-10-01T11:00:00Z",
      marker: "colleague-y-secret",
    });

    let loggedMetaEnv: Record<string, string> | undefined;
    const logs: string[] = [];
    const result = await execute({
      runId: "run-org-b-1",
      agent: {
        id: "agent-org-b",
        companyId: "org-b",
        name: "OrgB-Codex",
        adapterType: "codex_local",
        adapterConfig: { engine: "cli" },
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        engine: "cli",
        command: fakeCodexPath,
        cwd: workspaceDir,
        env: {
          OPENAI_API_KEY: "",
          CODEX_AUTH_JSON: Buffer.from(colleagueYSecret, "utf8").toString("base64"),
        },
      },
      context: {},
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
      onMeta: async (meta) => {
        loggedMetaEnv = meta.env;
      },
    });

    expect(result.exitCode).toBe(0);
    const captured = JSON.parse(await readFile(capturedPath, "utf8")) as {
      codexHome: string;
      hasCodexAuthJsonEnv: boolean;
      auth: { tokens: { account_id: string; refresh_token: string } };
    };
    expect(captured.hasCodexAuthJsonEnv).toBe(false);
    expect(captured.auth.tokens.account_id).toBe("acct-colleague-y");
    expect(captured.auth.tokens.refresh_token).toBe("refresh-colleague-y-secret");
    expect(captured.codexHome).toContain(path.join("companies", "org-b", "codex-auth-cache", "acct-colleague-y"));
    expect(loggedMetaEnv).toBeDefined();
    expect(loggedMetaEnv?.CODEX_AUTH_JSON).toBeUndefined();
    expect(loggedMetaEnv?.CODEX_HOME).toContain(REDACTED_CODEX_ACCOUNT_HANDLE);
    expect(JSON.stringify(loggedMetaEnv)).not.toContain("acct-colleague-y");
    expect(logs.join("")).not.toContain("refresh-colleague-y-secret");
    expect(logs.join("")).not.toContain("acct-colleague-y");
    // Host login for User X remained completely untouched.
    expect(await readFile(path.join(sharedHome, "auth.json"), "utf8")).toContain("host-user-x");
  });

  it("fails closed when CODEX_AUTH_JSON has an implausibly future last_refresh (empty slot never launches)", async () => {
    const root = await makeScratchDir("paperclip-codex-exec-future-refresh-");
    const sharedHome = path.join(root, "shared-host");
    const workspaceDir = path.join(root, "workspace");
    await mkdir(sharedHome, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(
      path.join(sharedHome, "auth.json"),
      subscriptionAuthJson({ accountId: "acct-user-x", lastRefresh: "2026-10-01T10:00:00Z", marker: "host-user-x" }),
    );

    vi.stubEnv("PAPERCLIP_HOME", root);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
    vi.stubEnv("CODEX_HOME", sharedHome);

    const futureLastRefresh = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const futureSecret = subscriptionAuthJson({
      accountId: "acct-future-skew",
      lastRefresh: futureLastRefresh,
      marker: "future-token",
    });

    const readiness = await evaluateCodexCredentialReadiness({
      env: process.env,
      companyId: "org-b",
      configuredCodexHome: null,
      configuredApiKey: null,
      configuredAuthJson: futureSecret,
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.invalidReason).toBe("invalid_codex_auth_json");

    await expect(
      execute({
        runId: "run-future-skew",
        agent: {
          id: "agent-org-b",
          companyId: "org-b",
          name: "OrgB-Codex",
          adapterType: "codex_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          engine: "cli",
          command: "codex",
          cwd: workspaceDir,
          env: {
            OPENAI_API_KEY: "",
            CODEX_AUTH_JSON: futureSecret,
          },
        },
        context: {},
        onLog: async () => {},
      }),
    ).rejects.toBeInstanceOf(InvalidCodexAuthJsonError);
  });

  it("does not leak accountHandle when materialization hits a filesystem error", async () => {
    const root = await makeScratchDir("paperclip-codex-fs-err-");
    // Point PAPERCLIP_HOME at a regular file so mkdir fails with ENOTDIR/EEXIST.
    const blockingFile = path.join(root, "not-a-dir");
    await writeFile(blockingFile, "block", "utf8");
    const env: NodeJS.ProcessEnv = {
      PAPERCLIP_HOME: blockingFile,
      PAPERCLIP_INSTANCE_ID: "default",
    };
    const secret = subscriptionAuthJson({
      accountId: "acct-sensitive-handle",
      lastRefresh: "2026-10-01T10:00:00Z",
      marker: "tok",
    });

    let caught: Error | null = null;
    try {
      await materializeCodexAuthJsonSecret({ raw: secret, companyId: "org-b", env });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught?.message).not.toContain("acct-sensitive-handle");
    expect(caught?.message).not.toContain("refresh-tok");

    // Also verify redactCodexAccountHandleInError scrubs message, stack, path, and dest.
    const fsErr = Object.assign(
      new Error("EEXIST: file already exists, open '/tmp/codex-auth-cache/acct-sensitive-handle/auth.json'"),
      {
        path: "/tmp/codex-auth-cache/acct-sensitive-handle/auth.json",
        dest: "/tmp/codex-auth-cache/acct-sensitive-handle/auth.json.tmp",
      },
    );
    fsErr.stack = "Error: /tmp/codex-auth-cache/acct-sensitive-handle/auth.json\n  at test";
    redactCodexAccountHandleInError(fsErr, "acct-sensitive-handle");
    expect(fsErr.message).not.toContain("acct-sensitive-handle");
    expect(fsErr.stack).not.toContain("acct-sensitive-handle");
    expect(fsErr.path).not.toContain("acct-sensitive-handle");
    expect(fsErr.dest).not.toContain("acct-sensitive-handle");
  });

  it("redacts accountHandle from returned AdapterExecutionResult when Codex fails naming CODEX_HOME", async () => {
    const root = await makeScratchDir("paperclip-codex-exec-fail-redact-");
    const sharedHome = path.join(root, "shared-host");
    const workspaceDir = path.join(root, "workspace");
    const fakeCodexPath = path.join(root, "fake-codex-fail");
    await mkdir(sharedHome, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(
      fakeCodexPath,
      `#!${process.execPath}
process.stdin.resume();
process.stdin.on("end", () => {
  console.error("error: failed to load config at " + process.env.CODEX_HOME + "/config.toml");
  process.exit(1);
});
`,
      "utf8",
    );
    await chmod(fakeCodexPath, 0o755);

    vi.stubEnv("PAPERCLIP_HOME", root);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
    vi.stubEnv("CODEX_HOME", sharedHome);

    const secret = subscriptionAuthJson({
      accountId: "acct-cli-fail-handle",
      lastRefresh: "2026-10-01T11:00:00Z",
      marker: "cli-fail",
    });

    const logs: string[] = [];
    const result = await execute({
      runId: "run-cli-fail-redact",
      agent: {
        id: "agent-org-b",
        companyId: "org-b",
        name: "OrgB-Codex",
        adapterType: "codex_local",
        adapterConfig: { engine: "cli" },
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        engine: "cli",
        command: fakeCodexPath,
        cwd: workspaceDir,
        env: { OPENAI_API_KEY: "", CODEX_AUTH_JSON: secret },
      },
      context: {},
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain(REDACTED_CODEX_ACCOUNT_HANDLE);
    expect(result.errorMessage).not.toContain("acct-cli-fail-handle");
    expect(JSON.stringify(result)).not.toContain("acct-cli-fail-handle");
    expect(logs.join("")).not.toContain("acct-cli-fail-handle");
  });

  it("fails closed when CODEX_AUTH_JSON is malformed instead of falling back to shared host user X", async () => {
    const root = await makeScratchDir("paperclip-codex-exec-bad-secret-");
    const sharedHome = path.join(root, "shared-host");
    const workspaceDir = path.join(root, "workspace");
    await mkdir(sharedHome, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(
      path.join(sharedHome, "auth.json"),
      subscriptionAuthJson({ accountId: "acct-user-x", lastRefresh: "2026-10-01T10:00:00Z", marker: "host-user-x" }),
    );

    vi.stubEnv("PAPERCLIP_HOME", root);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
    vi.stubEnv("CODEX_HOME", sharedHome);

    await expect(
      execute({
        runId: "run-bad-secret",
        agent: {
          id: "agent-org-b",
          companyId: "org-b",
          name: "OrgB-Codex",
          adapterType: "codex_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          engine: "cli",
          command: "codex",
          cwd: workspaceDir,
          env: {
            OPENAI_API_KEY: "",
            CODEX_AUTH_JSON: "not-valid-secret-payload",
          },
        },
        context: {},
        onLog: async () => {},
      }),
    ).rejects.toBeInstanceOf(InvalidCodexAuthJsonError);
  });
});

describe("ACP lane CODEX_AUTH_JSON wiring", () => {
  const scratchDirs: string[] = [];

  async function makeScratchDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
    scratchDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    vi.unstubAllEnvs();
    while (scratchDirs.length > 0) {
      const dir = scratchDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  function makeStubAcpRuntime() {
    const ensureSession = vi.fn(async (input: { sessionKey: string; cwd?: string }) => ({
      sessionKey: input.sessionKey,
      backend: "acpx",
      runtimeSessionName: "runtime-1",
      cwd: input.cwd,
      acpxRecordId: "record-1",
      backendSessionId: "acp-1",
      agentSessionId: "agent-1",
    }));
    const createRuntime = () => ({
      ensureSession,
      startTurn: (input: { requestId: string }) => ({
        requestId: input.requestId,
        events: {
          [Symbol.asyncIterator]: async function* () {
            yield { type: "text_delta", text: "ok", stream: "output", tag: "agent_message_chunk" };
          },
        },
        result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
        cancel: async () => {},
        closeStream: async () => {},
      }),
      getCapabilities: () => ({ controls: [] }),
      getStatus: async () => ({}),
      setConfigOption: async () => {},
      setMode: async () => {},
      close: async () => {},
    }) as never;
    return { createRuntime, ensureSession };
  }

  it("materializes CODEX_AUTH_JSON, overrides CODEX_HOME, strips CODEX_AUTH_JSON, and redacts accountHandle from logs/meta", async () => {
    const root = await makeScratchDir("paperclip-codex-acp-secret-");
    const sharedHome = path.join(root, "shared-host");
    const workspaceDir = path.join(root, "workspace");
    await mkdir(sharedHome, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(
      path.join(sharedHome, "auth.json"),
      subscriptionAuthJson({ accountId: "acct-host-x", lastRefresh: "2026-10-01T10:00:00Z", marker: "host-x" }),
    );
    vi.stubEnv("PAPERCLIP_HOME", root);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
    vi.stubEnv("CODEX_HOME", sharedHome);

    const colleagueY = subscriptionAuthJson({
      accountId: "acct-acp-colleague-y",
      lastRefresh: "2026-10-01T11:00:00Z",
      marker: "acp-colleague-y",
    });

    const { createRuntime, ensureSession } = makeStubAcpRuntime();
    const acpExec = createCodexAcpExecutor({ createRuntime });
    const logs: string[] = [];
    let metaEnv: Record<string, string> | undefined;
    const result = await acpExec({
      runId: "run-acp-secret",
      agent: {
        id: "agent-acp-b",
        companyId: "org-b",
        name: "OrgB-ACP",
        adapterType: "codex_local",
        adapterConfig: { engine: "acp" },
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        engine: "acp",
        cwd: workspaceDir,
        agentCommand: "node ./fake-acp.js",
        stateDir: path.join(root, "state"),
        env: {
          OPENAI_API_KEY: "",
          CODEX_AUTH_JSON: Buffer.from(colleagueY, "utf8").toString("base64"),
        },
      },
      context: {},
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
      onMeta: async (meta) => {
        metaEnv = meta.env;
      },
    });

    expect(result.exitCode).toBe(0);
    expect(ensureSession).toHaveBeenCalledTimes(1);
    const materializedAuthPath = path.join(
      root,
      "instances",
      "default",
      "companies",
      "org-b",
      "codex-auth-cache",
      "acct-acp-colleague-y",
      "auth.json",
    );
    expect(await readFile(materializedAuthPath, "utf8")).toContain("acp-colleague-y");
    expect(metaEnv?.CODEX_AUTH_JSON).toBeUndefined();
    expect(metaEnv?.CODEX_HOME).toContain(path.join("companies", "org-b", "codex-auth-cache", REDACTED_CODEX_ACCOUNT_HANDLE));
    expect(logs.join("")).not.toContain("acct-acp-colleague-y");
    expect(JSON.stringify(metaEnv ?? {})).not.toContain("acct-acp-colleague-y");
  });

  it("ignores CODEX_AUTH_JSON on ACP when managedAiConnection or OPENAI_API_KEY is configured, and strips it", async () => {
    const root = await makeScratchDir("paperclip-codex-acp-precedence-");
    const workspaceDir = path.join(root, "workspace");
    const managedHome = path.join(root, "managed-provider");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(managedHome, { recursive: true });
    vi.stubEnv("PAPERCLIP_HOME", root);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
    vi.stubEnv("CODEX_HOME", managedHome);

    // 1. managedAiConnection ignores even an invalid CODEX_AUTH_JSON and strips it.
    const first = makeStubAcpRuntime();
    const acpExec1 = createCodexAcpExecutor({ createRuntime: first.createRuntime });
    let meta1: Record<string, string> | undefined;
    const res1 = await acpExec1({
      runId: "run-acp-managed",
      agent: {
        id: "agent-acp-1",
        companyId: "org-b",
        name: "OrgB-ACP",
        adapterType: "codex_local",
        adapterConfig: { engine: "acp" },
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        engine: "acp",
        cwd: workspaceDir,
        agentCommand: "node ./fake-acp.js",
        stateDir: path.join(root, "state-1"),
        managedAiConnection: { provider: "openai", method: "subscription" },
        env: {
          CODEX_HOME: managedHome,
          CODEX_AUTH_JSON: "invalid-but-ignored-under-managed",
        },
      },
      context: {},
      onLog: async () => {},
      onMeta: async (meta) => {
        meta1 = meta.env;
      },
    });
    expect(res1.exitCode).toBe(0);
    expect(meta1?.CODEX_AUTH_JSON).toBeUndefined();
    expect(meta1?.CODEX_HOME).toBe(managedHome);

    // 2. Explicit OPENAI_API_KEY takes precedence over CODEX_AUTH_JSON and strips it.
    const second = makeStubAcpRuntime();
    const acpExec2 = createCodexAcpExecutor({ createRuntime: second.createRuntime });
    let meta2: Record<string, string> | undefined;
    const res2 = await acpExec2({
      runId: "run-acp-apikey",
      agent: {
        id: "agent-acp-2",
        companyId: "org-b",
        name: "OrgB-ACP",
        adapterType: "codex_local",
        adapterConfig: { engine: "acp" },
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        engine: "acp",
        cwd: workspaceDir,
        agentCommand: "node ./fake-acp.js",
        stateDir: path.join(root, "state-2"),
        env: {
          OPENAI_API_KEY: "sk-explicit-key",
          CODEX_AUTH_JSON: "invalid-but-ignored-under-api-key",
        },
      },
      context: {},
      onLog: async () => {},
      onMeta: async (meta) => {
        meta2 = meta.env;
      },
    });
    expect(res2.exitCode).toBe(0);
    expect(meta2?.CODEX_AUTH_JSON).toBeUndefined();
    expect(meta2?.OPENAI_API_KEY).toBe("***REDACTED***");
  });

  it("fails closed on ACP when CODEX_AUTH_JSON has a future last_refresh, and testCodexAcpEnvironment does not let ambient host OPENAI_API_KEY mask invalid CODEX_AUTH_JSON", async () => {
    const root = await makeScratchDir("paperclip-codex-acp-future-");
    const workspaceDir = path.join(root, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    vi.stubEnv("PAPERCLIP_HOME", root);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
    vi.stubEnv("CODEX_HOME", path.join(root, "shared"));
    vi.stubEnv("OPENAI_API_KEY", "sk-ambient-host-key");

    const futureSecret = subscriptionAuthJson({
      accountId: "acct-acp-future",
      lastRefresh: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      marker: "future",
    });

    const { createRuntime, ensureSession } = makeStubAcpRuntime();
    const acpExec = createCodexAcpExecutor({ createRuntime });
    await expect(
      acpExec({
        runId: "run-acp-future",
        agent: {
          id: "agent-acp-f",
          companyId: "org-b",
          name: "OrgB-ACP",
          adapterType: "codex_local",
          adapterConfig: { engine: "acp" },
        },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          engine: "acp",
          cwd: workspaceDir,
          agentCommand: "node ./fake-acp.js",
          env: { CODEX_AUTH_JSON: futureSecret },
        },
        context: {},
        onLog: async () => {},
      }),
    ).rejects.toBeInstanceOf(InvalidCodexAuthJsonError);
    expect(ensureSession).not.toHaveBeenCalled();

    const envTest = await testCodexAcpEnvironment({
      companyId: "org-b",
      adapterType: "codex_local",
      config: {
        engine: "acp",
        cwd: workspaceDir,
        agentCommand: "node",
        env: { CODEX_AUTH_JSON: futureSecret },
      },
    });
    expect(envTest.status).toBe("fail");
    expect(envTest.checks.some((c) => c.code === "codex_auth_json_invalid")).toBe(true);
  });

  it("redacts accountHandle from returned AdapterExecutionResult when ACP runtime fails naming CODEX_HOME", async () => {
    const root = await makeScratchDir("paperclip-codex-acp-fail-redact-");
    const workspaceDir = path.join(root, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    vi.stubEnv("PAPERCLIP_HOME", root);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
    vi.stubEnv("CODEX_HOME", path.join(root, "shared"));

    const handle = "acct-acp-fail-handle";
    const secret = subscriptionAuthJson({
      accountId: handle,
      lastRefresh: "2026-10-01T11:00:00Z",
      marker: "acp-fail",
    });

    const failingRuntime = () => ({
      ensureSession: async () => {
        throw new Error(`failed to read /paperclip/companies/org-b/codex-auth-cache/${handle}/config.toml`);
      },
      startTurn: () => {
        throw new Error("not reached");
      },
      getCapabilities: () => ({ controls: [] }),
      getStatus: async () => ({}),
      setConfigOption: async () => {},
      setMode: async () => {},
      close: async () => {},
    }) as never;

    const acpExec = createCodexAcpExecutor({ createRuntime: failingRuntime });
    const logs: string[] = [];
    const result = await acpExec({
      runId: "run-acp-fail-redact",
      agent: {
        id: "agent-acp-fail",
        companyId: "org-b",
        name: "OrgB-ACP",
        adapterType: "codex_local",
        adapterConfig: { engine: "acp" },
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        engine: "acp",
        cwd: workspaceDir,
        agentCommand: "node ./fake-acp.js",
        stateDir: path.join(root, "state"),
        env: { OPENAI_API_KEY: "", CODEX_AUTH_JSON: secret },
      },
      context: {},
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain(REDACTED_CODEX_ACCOUNT_HANDLE);
    expect(result.errorMessage).not.toContain(handle);
    expect(JSON.stringify(result)).not.toContain(handle);
    expect(logs.join("")).not.toContain(handle);
  });
});
