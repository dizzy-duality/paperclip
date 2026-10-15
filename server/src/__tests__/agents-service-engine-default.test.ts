import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// Our agent images ship no ACP agent: a Claude or Codex agent that names no
// engine must be stored with the CLI engine, or every run fails with
// adapter_engine_unavailable.
describeEmbeddedPostgres("agent engine default", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("agent-engine-default");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);
  afterAll(async () => { await stopDb?.(); });

  it("stores the CLI engine for Claude and Codex agents that name none, on create and on update, and keeps an explicit ACP", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const svc = agentService(db);
    const create = (name: string, adapterType: string, adapterConfig: Record<string, unknown>) =>
      svc.create(companyId, { name, role: "engineer", adapterType, adapterConfig, runtimeConfig: {}, spentMonthlyCents: 0, lastHeartbeatAt: null });

    const claude = await create("Claude", "claude_local", {});
    const codex = await create("Codex", "codex_local", { model: "gpt-5" });
    const acp = await create("Explicit ACP", "claude_local", { engine: "acp" });
    expect(claude.adapterConfig).toMatchObject({ engine: "cli" });
    expect(codex.adapterConfig).toMatchObject({ engine: "cli", model: "gpt-5" });
    expect(acp.adapterConfig).toMatchObject({ engine: "acp" });

    // The config form's "Default" choice saves the config without an engine.
    const updated = await svc.update(acp.id, { adapterConfig: {} });
    expect(updated?.adapterConfig).toMatchObject({ engine: "cli" });
  });
});
