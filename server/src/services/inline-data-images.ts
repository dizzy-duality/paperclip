import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { assets as assetRows, type Db } from "@paperclipai/db";
import type { StorageService } from "../storage/types.js";
import { formatAttachmentSize, MAX_ATTACHMENT_BYTES } from "../attachment-types.js";
import { unprocessable } from "../errors.js";
import { assetService } from "./assets.js";
import { logActivity } from "./activity-log.js";

// Raster images only: an inline SVG would need the sanitizing the upload route does.
// A fresh regex per use: a shared global one carries lastIndex between calls.
const inlineDataImageRe = () => /data:(image\/(?:png|jpe?g|gif|webp));base64,([A-Za-z0-9+/]+={0,2})/gi;

export function hasInlineDataImage(text: string) {
  return inlineDataImageRe().test(text);
}

/**
 * Replaces each base64 `data:` image in `text` with the URL `store` returns for
 * it. A pasted screenshot inlined this way is ~1 MB of text, which agents read
 * whole and which overflowed a run's context window (LMT-1760).
 */
export async function externalizeInlineDataImages(
  text: string,
  store: (image: { contentType: string; body: Buffer }) => Promise<string>,
) {
  const matches = [...text.matchAll(inlineDataImageRe())];
  let result = text;
  for (const [uri, contentType, base64] of matches) {
    const body = Buffer.from(base64!, "base64");
    if (body.length > MAX_ATTACHMENT_BYTES) {
      throw unprocessable(
        `An inline image is larger than the ${formatAttachmentSize(MAX_ATTACHMENT_BYTES)} limit; attach it instead`,
      );
    }
    result = result.replace(uri, await store({ contentType: contentType!.toLowerCase(), body }));
  }
  return { text: result, count: matches.length };
}

/**
 * Stores an inline image as a company image asset and returns its content URL.
 * An image the company already holds reuses that asset, so a retried write
 * yields the same text (comment retries dedupe on it).
 */
export function inlineImageAssetStore(
  db: Db,
  storage: StorageService,
  companyId: string,
  actor: { actorType: "agent" | "user"; actorId: string; agentId: string | null; runId: string | null; agentApiKeyId: string | null },
) {
  const assets = assetService(db);
  let n = 0;
  return async (image: { contentType: string; body: Buffer }) => {
    n += 1;
    const sha256 = createHash("sha256").update(image.body).digest("hex");
    const [existing] = await db.select({ id: assetRows.id }).from(assetRows).where(and(
      eq(assetRows.companyId, companyId), eq(assetRows.sha256, sha256), eq(assetRows.contentType, image.contentType),
    )).limit(1);
    if (existing) return `/api/assets/${existing.id}/content`;
    const extension = image.contentType.split("/")[1]!.replace("jpeg", "jpg");
    const stored = await storage.putFile({
      companyId,
      namespace: "assets/inline-images",
      originalFilename: `inline-image-${n}.${extension}`,
      contentType: image.contentType,
      body: image.body,
    });
    const asset = await assets.create(companyId, {
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "asset.created",
      entityType: "asset",
      entityId: asset.id,
      details: { originalFilename: asset.originalFilename, contentType: asset.contentType, byteSize: asset.byteSize, source: "inline_data_image" },
    });
    return `/api/assets/${asset.id}/content`;
  };
}
