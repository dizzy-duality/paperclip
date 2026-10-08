import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
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
const QUOTA_HOLD_TEST_ADAPTER = "quota_hold_test";
const HOUR_MS = 60 * 60 * 1000;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres provider-quota hold tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("provider quota hold on queued runs", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const executedRunIds: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-provider-quota-hold-");
    db = createDb(tempDb.connectionString);
    registerServerAdapter({
      type: QUOTA_HOLD_TEST_ADAPTER,
      execute: async (input) => {
        executedRunIds.push(input.runId);
        return { exitCode: 0, signal: null, timedOut: false, resultJson: {} };
      },
      testEnvironment: async () => ({
        adapterType: QUOTA_HOLD_TEST_ADAPTER,
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
    unregisterServerAdapter(QUOTA_HOLD_TEST_ADAPTER);
    await tempDb?.cleanup();
  });

  async function insertAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Quota Co",
      status: "active",
      issuePrefix: `Q${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Quota Agent",
      role: "engineer",
      status: "idle",
      adapterType: QUOTA_HOLD_TEST_ADAPTER,
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 3600, wakeOnDemand: true } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function insertFinishedRun(
    ids: { companyId: string; agentId: string },
    finishedAt: Date,
    outcome:
      | { status: "succeeded" }
      | { status: "failed"; errorCode: string; resultJson: Record<string, unknown> },
  ) {
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      ...ids,
      invocationSource: "timer",
      status: outcome.status,
      startedAt: new Date(finishedAt.getTime() - 60_000),
      finishedAt,
      ...(outcome.status === "failed"
        ? { errorCode: outcome.errorCode, error: "You've hit your usage limit.", resultJson: outcome.resultJson }
        : {}),
    });
  }

  function quotaStop(resetAt?: Date) {
    return {
      status: "failed" as const,
      errorCode: "provider_quota",
      resultJson: {
        errorFamily: "provider_quota",
        ...(resetAt ? { retryNotBefore: resetAt.toISOString() } : {}),
      },
    };
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

  it("keeps automatic runs queued until the provider's reset time", async () => {
    const ids = await insertAgent();
    // Stopped 2 h ago, so the 1 h default backoff alone would have released it.
    await insertFinishedRun(ids, new Date(Date.now() - 2 * HOUR_MS), quotaStop(new Date(Date.now() + HOUR_MS)));
    const runId = await insertQueuedRun(ids);

    expect(await startedAfterResume(runId)).toBe(false);
    const [row] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    expect(row?.status).toBe("queued");
  });

  it("starts them once the reset time has passed", async () => {
    const ids = await insertAgent();
    await insertFinishedRun(ids, new Date(Date.now() - 2 * HOUR_MS), quotaStop(new Date(Date.now() - 60_000)));
    const runId = await insertQueuedRun(ids);

    expect(await startedAfterResume(runId)).toBe(true);
  });

  it("still starts a manual run during the hold", async () => {
    const ids = await insertAgent();
    await insertFinishedRun(ids, new Date(Date.now() - 60_000), quotaStop(new Date(Date.now() + HOUR_MS)));
    const runId = await insertQueuedRun(ids, "on_demand");

    expect(await startedAfterResume(runId)).toBe(true);
  });

  it("still starts a scheduled retry the board promoted with Retry now", async () => {
    const ids = await insertAgent();
    await insertFinishedRun(ids, new Date(Date.now() - 60_000), quotaStop(new Date(Date.now() + HOUR_MS)));
    const [quotaRun] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, ids.agentId));
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId, companyId: ids.companyId, title: "Quota retry", status: "in_progress", assigneeAgentId: ids.agentId,
    });
    const runId = await insertQueuedRun(ids);
    await db.update(heartbeatRuns).set({
      status: "scheduled_retry", invocationSource: "automation", retryOfRunId: quotaRun!.id,
      scheduledRetryAt: new Date(Date.now() + HOUR_MS), scheduledRetryReason: "transient_failure",
      contextSnapshot: { issueId },
    }).where(eq(heartbeatRuns.id, runId));
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));

    const result = await heartbeatService(db).retryScheduledRetryNow({
      issueId, actor: { actorType: "user", actorId: "board-user" },
    });
    expect(result.outcome).toBe("promoted");
    expect(await startedAfterResume(runId)).toBe(true);
  });

  it("lifts the hold when a later run finished without hitting the limit", async () => {
    const ids = await insertAgent();
    await insertFinishedRun(ids, new Date(Date.now() - 10 * 60_000), quotaStop(new Date(Date.now() + HOUR_MS)));
    await insertFinishedRun(ids, new Date(Date.now() - 60_000), { status: "succeeded" });
    const runId = await insertQueuedRun(ids);

    expect(await startedAfterResume(runId)).toBe(true);
  });

  it("without a parsed reset time, holds for the default quota backoff after the stop", async () => {
    const recent = await insertAgent();
    await insertFinishedRun(recent, new Date(Date.now() - 10 * 60_000), quotaStop());
    const recentRunId = await insertQueuedRun(recent);

    const old = await insertAgent();
    await insertFinishedRun(old, new Date(Date.now() - 2 * HOUR_MS), quotaStop());
    const oldRunId = await insertQueuedRun(old);

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(executedRunIds).not.toContain(recentRunId);
    expect(executedRunIds).toContain(oldRunId);
  });
});
