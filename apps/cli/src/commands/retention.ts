import { fail, systemClock } from "@investigator/core";
import type { GlobalOptions, Runtime } from "../runtime.js";

/**
 * `investigate retention apply` — expire artifacts, leaving tombstones (ADR-0018).
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * Deletion is destructive and irreversible, so it is refused without `--confirm`. The default is a
 * dry run that reports exactly what WOULD be deleted.
 *
 * Expired artifacts leave a tombstone rather than vanishing: the row and its hash remain, so a
 * past report's reference resolves to "retained until, then deleted" instead of dangling. A
 * dangling reference is indistinguishable from a fabricated one, and a system whose evidence
 * references can silently rot cannot claim its findings are evidence-backed.
 */

export interface RetentionOptions {
  confirm?: boolean;
  olderThanDays?: number;
}

export interface RetentionResult {
  json: unknown;
  human: () => string;
}

/** Kinds a reproducer needs. Exempt when `storage.retention.keepReproducers` is set. */
const REPRODUCER_KINDS = new Set(["reproducer-package", "run-manifest", "effective-proposal"]);

export async function retentionApplyCommand(
  rt: Runtime,
  opts: RetentionOptions,
  globals: GlobalOptions
): Promise<RetentionResult> {
  const retention = rt.config.storage.retention;
  const days = opts.olderThanDays ?? retention.artifactDays;
  if (!Number.isFinite(days) || days < 0) {
    fail("INPUT_INVALID", "Retention age must be a non-negative number of days", {
      context: { days: String(days) },
    });
  }

  const cutoffMs = Date.parse(systemClock.nowIso()) - days * 86_400_000;
  const investigations = globals.investigation
    ? [{ investigationId: globals.investigation }]
    : await rt.metadata.read((t) => t.listInvestigations());

  const eligible: Array<{
    investigationId: string;
    artifactId: string;
    kind: string;
    createdAt: string;
    bytes: number;
  }> = [];
  let exemptReproducer = 0;
  let alreadyTombstoned = 0;

  for (const inv of investigations) {
    const refs = await rt.artifacts.list(inv.investigationId);
    for (const ref of refs) {
      if (ref.tombstoned) {
        alreadyTombstoned++;
        continue;
      }
      const createdAt = ref.storedAt;
      if (Date.parse(createdAt) > cutoffMs) continue;
      if (retention.keepReproducers && REPRODUCER_KINDS.has(ref.kind)) {
        exemptReproducer++;
        continue;
      }
      eligible.push({
        investigationId: inv.investigationId,
        artifactId: ref.artifactId,
        kind: ref.kind,
        createdAt,
        bytes: ref.byteLength,
      });
    }
  }

  const reclaimable = eligible.reduce((sum, e) => sum + e.bytes, 0);

  if (!opts.confirm) {
    return {
      json: {
        ok: true,
        dryRun: true,
        applied: false,
        olderThanDays: days,
        eligible: eligible.length,
        reclaimableBytes: reclaimable,
        exemptReproducer,
        alreadyTombstoned,
        artifacts: eligible,
      },
      human: () =>
        [
          `Retention dry run: nothing has been deleted.`,
          `  older than        ${days} days`,
          `  eligible          ${eligible.length} artifact(s), ${Math.round(reclaimable / 1024)} KB`,
          `  exempt            ${exemptReproducer} (keepReproducers)`,
          `  already tombstoned ${alreadyTombstoned}`,
          "",
          "Deletion is irreversible. To apply:",
          "  investigate retention apply --confirm",
        ].join("\n"),
    };
  }

  const tombstoned: string[] = [];
  for (const e of eligible) {
    await rt.artifacts.tombstone(
      e.artifactId,
      `retention: older than ${days} days (applied ${systemClock.nowIso()})`
    );
    tombstoned.push(e.artifactId);
  }

  return {
    json: {
      ok: true,
      dryRun: false,
      applied: true,
      olderThanDays: days,
      tombstoned: tombstoned.length,
      reclaimedBytes: reclaimable,
      exemptReproducer,
      artifactIds: tombstoned,
    },
    human: () =>
      [
        `Retention applied.`,
        `  tombstoned  ${tombstoned.length} artifact(s), ${Math.round(reclaimable / 1024)} KB reclaimed`,
        `  exempt      ${exemptReproducer} (keepReproducers)`,
        "",
        "Each deleted artifact keeps its row and hash, so an existing report reference still",
        "resolves — to 'retained until, then deleted' rather than to nothing.",
      ].join("\n"),
  };
}
