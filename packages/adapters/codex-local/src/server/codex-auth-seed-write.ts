import { lstat, open, readFile, readlink, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { withDirectoryMergeLock } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { readSubscriptionAccountId } from "./codex-auth-cache.js";
import { USE_SOURCE_EXIT, decideCodexAuthMerge } from "./codex-auth-merge-decision.js";

// The one atomic credential writer. It stages the source bytes into a private
// (0600) temp next to the destination, runs the shared decision predicate, and
// on a use-source decision renames the temp over the destination. The rename is
// an atomic same-directory swap that preserves mode 0600. The whole write runs
// under the directory merge lock, so a concurrent restore, copy-back, or
// promotion can never interleave. The per-identity cache slot and the
// device-login company home both use this writer, so the staged-rename and lock
// logic lives in one place. It never logs token bytes; the caller passes the
// fixed status lines.

export type WriteCredentialSeedOrNewerOutcome = "written" | "kept";

export interface WriteCredentialSeedOrNewerInput {
  /** The source credential bytes to (maybe) install. */
  sourceBytes: Buffer;
  /** The absolute destination path to (maybe) overwrite. */
  destinationPath: string;
  /** Fill an absent destination from a usable subscription source. */
  seedIfDestAbsent: boolean;
  /** A non-leaking progress sink. It receives only the two fixed status lines. */
  log: (line: string) => void | Promise<void>;
  /** The fixed status line for a use-source write. It carries no secret data. */
  writtenLine: string;
  /** The fixed status line for a keep-destination decision. */
  keptLine: string;
  /** A safe, non-secret prefix for the staged temp file name. */
  tempPrefix: string;
  /** The caller name that prefixes a predicate error. */
  errorLabel: string;
  /** Environment for the merge lock root. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * Optional absolute target path of an inherited shared-host symlink that may
   * be atomically replaced when `sourceBytes` holds a *different* subscription
   * identity (or when the symlink target is unreadable/non-subscription). A
   * regular file (e.g. a previously promoted company account) or a symlink to
   * any other target is never bypassed and still goes through the shared merge
   * predicate. Never writes through the symlink.
   */
  replaceInheritedSymlinkTargeting?: string;
}

async function isInheritedDifferentAccountSymlink(
  destinationPath: string,
  expectedTargetPath: string,
  sourceBytes: Buffer,
): Promise<boolean> {
  const existing = await lstat(destinationPath).catch(() => null);
  if (!existing?.isSymbolicLink()) return false;
  const linked = await readlink(destinationPath).catch(() => null);
  if (!linked) return false;
  const resolvedLink = path.resolve(path.dirname(destinationPath), linked);
  if (resolvedLink !== path.resolve(expectedTargetPath)) return false;
  const sourceIdentity = readSubscriptionAccountId(sourceBytes);
  if (!sourceIdentity) return false;
  const targetBytes = await readFile(resolvedLink).catch(() => null);
  const targetIdentity = targetBytes ? readSubscriptionAccountId(targetBytes) : null;
  // Same identity still goes through `decideCodexAuthMerge` so freshness rules
  // apply unchanged; a different (or absent/unusable) inherited host login is
  // replaced atomically at the symlink path itself.
  return targetIdentity !== sourceIdentity;
}

/**
 * Writes `sourceBytes` over `destinationPath` when the shared predicate returns a
 * use-source decision, else keeps the destination. Seeds an absent destination
 * only when `seedIfDestAbsent` is set and the source is a usable subscription
 * credential. The staged temp is always removed, so a failure never leaves a
 * partial file.
 */
export async function writeCredentialSeedOrNewer(
  input: WriteCredentialSeedOrNewerInput,
): Promise<WriteCredentialSeedOrNewerOutcome> {
  const destinationDir = path.dirname(input.destinationPath);
  return withDirectoryMergeLock(
    destinationDir,
    async () => {
      const stagedTempPath = path.join(
        destinationDir,
        `.${input.tempPrefix}-${process.pid}-${randomUUID()}.tmp`,
      );
      // `wx` + explicit mode create the temp private (0600) and fail if it already
      // exists, so the writer never writes through a pre-existing symlink.
      const handle = await open(stagedTempPath, "wx", 0o600);
      try {
        await handle.writeFile(input.sourceBytes);
        await handle.close();
        const shouldReplaceInheritedSymlink =
          input.replaceInheritedSymlinkTargeting != null &&
          (await isInheritedDifferentAccountSymlink(
            input.destinationPath,
            input.replaceInheritedSymlinkTargeting,
            input.sourceBytes,
          ));
        const decision = shouldReplaceInheritedSymlink
          ? USE_SOURCE_EXIT
          : await decideCodexAuthMerge(stagedTempPath, input.destinationPath, {
              seedIfDestAbsent: input.seedIfDestAbsent,
              errorLabel: input.errorLabel,
            });
        if (decision === USE_SOURCE_EXIT) {
          await rename(stagedTempPath, input.destinationPath);
          await input.log(input.writtenLine);
          return "written";
        }
        await input.log(input.keptLine);
        return "kept";
      } finally {
        await handle.close().catch(() => undefined);
        await rm(stagedTempPath, { force: true }).catch(() => undefined);
      }
    },
    input.env,
  );
}
