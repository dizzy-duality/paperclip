import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const HOURS_TEST_ADAPTER = "active_hours_test";
const HOUR_MS = 60 * 60 * 1000;

function utcHhmm(at: Date) {
  return at.toISOString().slice(11, 16);
}

/** A UTC window that does or does not contain the real current time. */
function windowAroundNow(containsNow: boolean) {
  const now = Date.now();
  return containsNow
    ? { start: utcHhmm(new Date(now - HOUR_MS)), end: utcHhmm(new Date(now + HOUR_MS)), timezone: "UTC" }
    : { start: utcHhmm(new Date(now + 2 * HOUR_MS)), end: utcHhmm(new Date(now + 3 * HOUR_MS)), timezone: "UTC" };
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres active-hours tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent active hours", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const executedRunIds: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-active-hours-");
    db = createDb(tempDb.connectionString);
    registerServerAdapter({
      type: HOURS_TEST_ADAPTER,
      execute: async (input) => {
        executedRunIds.push(input.runId);
        return { exitCode: 0, signal: null, timedOut: false, resultJson: {} };
      },
      testEnvironment: async () => ({
        adapterType: HOURS_TEST_ADAPTER,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
  }, 20_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    executedRunIds.length = 0;
    await db.execute(sql`truncate table ${companies} cascade`);
  });

  afterAll(async () => {
    unregisterServerAdapter(HOURS_TEST_ADAPTER);
    await tempDb?.cleanup();
  });

  async function insertAgent(activeHours: Record<string, string>, lastHeartbeatAt: Date | null = null) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Hours Co",
      status: "active",
      issuePrefix: `Q${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Night Agent",
      role: "engineer",
      status: "idle",
      adapterType: HOURS_TEST_ADAPTER,
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 3600, wakeOnDemand: true, activeHours } },
      lastHeartbeatAt,
      createdAt: lastHeartbeatAt ?? new Date(),
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function insertQueuedRun(
    ids: { companyId: string; agentId: string },
    invocationSource: "timer" | "on_demand" = "timer",
  ) {
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const triggerDetail = invocationSource === "on_demand" ? "manual" : "system";
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId, ...ids, source: invocationSource, triggerDetail, status: "queued", runId,
      requestedByActorType: "user", requestedByActorId: "board-user",
    });
    await db.insert(heartbeatRuns).values({
      id: runId, ...ids, invocationSource, triggerDetail, status: "queued", wakeupRequestId,
      responsibleUserId: "board-user",
    });
    return runId;
  }

  async function startedAfterResume(runId: string) {
    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    return executedRunIds.includes(runId);
  }

  it("keeps automatic runs queued outside the agent's active hours", async () => {
    const ids = await insertAgent(windowAroundNow(false));
    const runId = await insertQueuedRun(ids);

    expect(await startedAfterResume(runId)).toBe(false);
    const [row] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    expect(row?.status).toBe("queued");
  });

  it("starts them inside the active hours", async () => {
    const ids = await insertAgent(windowAroundNow(true));
    const runId = await insertQueuedRun(ids);

    expect(await startedAfterResume(runId)).toBe(true);
  });

  it("still starts a manual run outside the active hours", async () => {
    const ids = await insertAgent(windowAroundNow(false));
    const runId = await insertQueuedRun(ids, "on_demand");

    expect(await startedAfterResume(runId)).toBe(true);
  });

  it("fires no timer heartbeat outside the active hours, and fires once they open", async () => {
    const night = { start: "22:00", end: "06:00", timezone: "Europe/Amsterdam" };
    await insertAgent(night, new Date("2026-07-15T00:00:00Z"));
    const heartbeat = heartbeatService(db);

    // 14:00 CEST: overdue, but outside the window.
    expect((await heartbeat.tickTimers(new Date("2026-07-15T12:00:00Z"))).enqueued).toBe(0);
    // 23:00 CEST: inside.
    expect((await heartbeat.tickTimers(new Date("2026-07-15T21:00:00Z"))).enqueued).toBe(1);
  });
});
