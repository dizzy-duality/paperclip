import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
  observeCrossIssueInfluence,
} from "../services/cross-issue-influence-limit.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("cross-issue influence limit PostgreSQL serialization", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cross-issue-cap-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("allows exactly one of concurrent attempts 20 and 21", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const sourceIssueId = randomUUID();
    const targetIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Concurrent Coder",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      responsibleUserId: "board-user",
      contextSnapshot: { issueId: sourceIssueId },
    });
    await db.insert(activityLog).values(
      Array.from({ length: 18 }, () => ({
        companyId,
        actorType: "agent" as const,
        actorId: agentId,
        agentId,
        runId,
        action: "issue.cross_issue_influence_observed",
        entityType: "issue",
        entityId: targetIssueId,
      })),
    );

    const input = {
      companyId,
      runId,
      agentId,
      targetIssueId,
      targetIssueIdentifier: "CAP-2",
      kind: "comment" as const,
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    };
    // A comment, a PATCH, and an issue-thread interaction resolution race for the
    // last slot of the shared budget: the row lock must let exactly one of 19/20
    // through per attempt and fail the twenty-first closed.
    const decisions = await Promise.all([
      observeCrossIssueInfluence(db, input),
      observeCrossIssueInfluence(db, { ...input, kind: "update" }),
      observeCrossIssueInfluence(db, { ...input, kind: "interaction_resolution" }),
    ]);

    expect(decisions.map((decision) => decision?.allowed).sort()).toEqual([false, true, true]);
    expect(decisions.map((decision) => decision?.count).sort((a, b) => Number(a) - Number(b)))
      .toEqual([19, 20, 21]);

    const recorded = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.runId, runId)));
    expect(recorded.filter((row) => row.action === "issue.cross_issue_influence_observed")).toHaveLength(20);
    expect(recorded.filter((row) => row.action === "issue.cross_issue_influence_cap_rejected")).toHaveLength(1);
  });

  it("lets a run without a source issue write, within the cap, only to the issue it checked out", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const timerRunId = randomUUID();
    const otherRunId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Timer Coder", role: "engineer",
      adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    // A timer heartbeat: no issueId or taskId in its context.
    await db.insert(heartbeatRuns).values([
      { id: timerRunId, companyId, agentId, status: "running", contextSnapshot: { source: "heartbeat_timer" } },
      { id: otherRunId, companyId, agentId, status: "running", contextSnapshot: {} },
    ]);
    const [own, othersCheckout, unchecked] = [randomUUID(), randomUUID(), randomUUID()];
    await db.insert(issues).values([
      { id: own, companyId, title: "Checked out by the timer run", checkoutRunId: timerRunId },
      { id: othersCheckout, companyId, title: "Checked out by another run", checkoutRunId: otherRunId },
      { id: unchecked, companyId, title: "Not checked out" },
    ]);
    const attempt = (targetIssueId: string) =>
      observeCrossIssueInfluence(db, { companyId, runId: timerRunId, agentId, targetIssueId, kind: "comment" });

    // Allowed, and counted against the run's cap like any cross-issue write:
    // checking issues out must not become a way around the cap.
    await expect(attempt(own)).resolves.toMatchObject({ allowed: true, count: 1 });
    await db.insert(activityLog).values(Array.from({ length: 19 }, () => ({
      companyId, actorType: "agent" as const, actorId: agentId, agentId, runId: timerRunId,
      action: "issue.cross_issue_influence_observed", entityType: "issue", entityId: own,
    })));
    await expect(observeCrossIssueInfluence(db, {
      companyId, runId: timerRunId, agentId, targetIssueId: own, kind: "comment", now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    })).resolves.toMatchObject({ allowed: false, count: 21 });
    for (const target of [othersCheckout, unchecked]) {
      await expect(attempt(target)).rejects.toMatchObject({
        status: 403,
        details: expect.objectContaining({ code: "cross_issue_influence_run_context_required" }),
      });
    }
  });
});
