import { createHash, randomUUID } from "node:crypto";
import express from "express";
import { eq, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { assets, companies, createDb, issueComments, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import type { StorageService } from "../storage/types.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres inline data image tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const inline = (text: string) => `${text}\n\n![shot](data:image/png;base64,${PNG.toString("base64")})\n`;

describeEmbeddedPostgres("inline data images in task text", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const stored: Buffer[] = [];

  const storage: StorageService = {
    provider: "local_disk",
    putFile: vi.fn(async (input) => {
      stored.push(input.body);
      return {
        provider: "local_disk",
        objectKey: `${input.namespace}/${randomUUID()}`,
        contentType: input.contentType,
        byteSize: input.body.length,
        sha256: createHash("sha256").update(input.body).digest("hex"),
        originalFilename: input.originalFilename,
      };
    }),
    getObject: vi.fn(),
    headObject: vi.fn(),
    deleteObject: vi.fn(),
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-inline-data-images-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    stored.length = 0;
    await db.execute(sql`truncate table ${companies} cascade`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("stores pasted images as company assets and links them from the description and comments", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "Inline Co", status: "active", issuePrefix: "INL", requireBoardApprovalForNewAgents: false },
      { id: otherCompanyId, name: "Other Co", status: "active", issuePrefix: "OTH", requireBoardApprovalForNewAgents: false },
    ]);
    const app = express();
    app.use(express.json({ limit: "10mb" }));
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", source: "local_implicit", companyIds: [companyId] };
      next();
    });
    app.use("/api", issueRoutes(db, storage));
    app.use(errorHandler);

    const created = await request(app).post(`/api/companies/${companyId}/issues`)
      .send({ title: "Screenshot task", description: inline("Created") });
    expect(created.status).toBe(201);
    const issueId = created.body.id as string;
    const patched = await request(app).patch(`/api/issues/${issueId}`).send({ description: inline("Edited") });
    expect(patched.status).toBe(200);
    const clientRequestId = randomUUID();
    const commented = await request(app).post(`/api/issues/${issueId}/comments`)
      .send({ body: inline("Comment"), clientRequestId });
    expect(commented.status).toBe(201);
    // A retry yields the same text, so it returns the first comment instead of a 409.
    const retried = await request(app).post(`/api/issues/${issueId}/comments`)
      .send({ body: inline("Comment"), clientRequestId });
    expect(retried.body.id).toBe(commented.body.id);

    // Another company's task answers 404, as it does without an image.
    const [foreign] = await db.insert(issues).values({ companyId: otherCompanyId, title: "Foreign" })
      .returning({ id: issues.id });
    const sessionApp = express();
    sessionApp.use(express.json({ limit: "10mb" }));
    sessionApp.use((req, _res, next) => {
      req.actor = { type: "board", userId: "member", source: "session", companyIds: [companyId] };
      next();
    });
    sessionApp.use("/api", issueRoutes(db, storage));
    sessionApp.use(errorHandler);
    const foreignPatch = await request(sessionApp).patch(`/api/issues/${foreign!.id}`).send({ description: inline("Probe") });
    expect(foreignPatch.status).toBe(404);

    const [issue] = await db.select({ description: issues.description }).from(issues).where(eq(issues.id, issueId));
    const [comment] = await db.select({ body: issueComments.body }).from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    const assetIds = (await db.select({ id: assets.id }).from(assets).where(eq(assets.companyId, companyId)))
      .map((row) => row.id);

    // The same image every time: stored once, one asset.
    expect(assetIds).toHaveLength(1);
    expect(stored).toEqual([PNG]);
    for (const text of [issue!.description!, comment!.body]) {
      expect(text).not.toContain("data:image");
      const [, id] = text.match(/!\[shot\]\(\/api\/assets\/([0-9a-f-]+)\/content\)/) ?? [];
      expect(assetIds).toContain(id);
    }
  });
});
