import type { Clock, ResolvedConfig } from "@investigator/core";
import { fail, jobId as makeJobId, sha256Hex, systemClock } from "@investigator/core";
import type { MetadataStore, WorkQueue } from "@investigator/storage";
import {
  assertSafeToEnqueue,
  classifyExperiment,
  isOriginAllowed,
} from "./destructive-classifier.js";
import type { ExperimentSpec } from "./types.js";

/**
 * Enqueue, with the static safety checks that must happen BEFORE any browser launches
 * (docs/architecture/test-data-and-side-effects.md).
 *
 * Seven production-impact guards exist across the system; four of them are enforced here, at the
 * cheapest possible point:
 *   - the target must exist and must not be production-classified (config load rejects that)
 *   - every static URL must be inside safety.allowedOrigins
 *   - destructive actions need a per-sequence acknowledged approval
 *   - remote writes need a declared server-side reset strategy
 */

export interface EnqueueArgs {
  config: ResolvedConfig;
  metadata: MetadataStore;
  queue: WorkQueue;
  investigationId: string;
  experiment: ExperimentSpec;
  repetitions: number;
  approvalId: string | null;
  effectiveProposalChecksum: string | null;
  acknowledgedDestructiveActionIds?: readonly string[];
  clock?: Clock;
  /** Enqueue a retry attempt of one repetition rather than a fresh batch. */
  retryOf?: { repetitionIndex: number; previousAttemptJobId: string; attemptIndex: number };
}

export interface EnqueueResult {
  jobIds: string[];
  firstSeq: number;
  /** Repetitions already present and therefore not re-enqueued. Reported, never hidden. */
  skippedExisting: number;
}

/**
 * Job ids are derived from the work they identify, not drawn from a stream.
 *
 * The previous generator was `new SeededRng(seed ^ existing.length)`, which keys the id sequence
 * on a value that repeats: any two enqueue calls on one investigation that observe the same
 * `existing.length` regenerate the same ids and collide on the `job_id` primary key. A call that
 * skips every repetition as already-present inserts nothing, so it leaves the length unchanged
 * and hands the next call an identical stream.
 *
 * Deriving from (seed, investigation, experiment, repetition, attempt) is still deterministic --
 * ADR-0007 requires the id be reproducible from the seed, not that it be drawn randomly -- and it
 * is collision-free for distinct work by construction. It also makes re-enqueueing genuinely
 * idempotent: the same work derives the same id, so the uniqueness constraint and the
 * already-present skip agree instead of racing.
 */
export function deriveJobId(
  seed: number,
  investigationId: string,
  experimentId: string,
  repetitionIndex: number,
  attemptIndex: number
): string {
  const material = [seed, investigationId, experimentId, repetitionIndex, attemptIndex].join(
    "\u0000"
  );
  return makeJobId(() => sha256Hex(material));
}

export async function enqueueExperiment(args: EnqueueArgs): Promise<EnqueueResult> {
  const { config: cfg, experiment } = args;
  const clock = args.clock ?? systemClock;

  const target = cfg.execution.targets[experiment.targetName];
  if (!target) {
    fail("CONFIG_INVALID", "Experiment names a target that is not configured", {
      context: { targetName: experiment.targetName },
    });
  }

  // Guard: every statically known URL must be inside the allowlist. Runtime navigations are
  // checked again by the interpreter.
  for (const action of experiment.actions) {
    if (action.type !== "goto" || !action.url) continue;
    const resolved = new URL(action.url, target.baseUrl).toString();
    if (!isOriginAllowed(resolved, cfg.safety.allowedOrigins)) {
      fail("EXEC_ORIGIN_NOT_ALLOWED", "Experiment navigates outside safety.allowedOrigins", {
        context: { actionId: action.actionId, origin: new URL(resolved).origin },
      });
    }
  }

  const classification = classifyExperiment(experiment, {
    extraDestructivePatterns: cfg.safety.destructivePatterns,
  });
  assertSafeToEnqueue({
    experiment,
    classification,
    targetClassification: target.classification,
    blockDestructiveActions: cfg.safety.blockDestructiveActions,
    acknowledgedDestructiveActionIds: args.acknowledgedDestructiveActionIds ?? [],
  });

  // Hard stop on investigation size, checked against what already exists plus what is about to
  // be added, so a batch cannot straddle the limit.
  const existing = await args.queue.listJobs(args.investigationId);
  const adding = args.retryOf ? 1 : args.repetitions;

  // A single request is bounded separately from the investigation total. The UI validates this
  // too, but the check lives here because the UI is not the only way in.
  if (adding > cfg.safety.maxRepetitionsPerRun) {
    fail("EXEC_INVESTIGATION_LIMIT", "Request exceeds safety.maxRepetitionsPerRun", {
      context: { requested: adding, limit: cfg.safety.maxRepetitionsPerRun },
    });
  }

  if (existing.length + adding > cfg.safety.maxRunsPerInvestigation) {
    fail("EXEC_INVESTIGATION_LIMIT", "Enqueue would exceed safety.maxRunsPerInvestigation", {
      context: {
        existing: existing.length,
        adding,
        limit: cfg.safety.maxRunsPerInvestigation,
      },
    });
  }

  const payloadJson = JSON.stringify(experiment);
  const jobIds: string[] = [];
  let firstSeq = 0;
  let skippedExisting = 0;

  // (experiment, repetition, attempt) already present means this work is already scheduled or
  // done. Re-enqueueing is a no-op rather than an error, which is what makes the operation safe
  // to repeat on a durable queue.
  const alreadyPresent = new Set(
    existing
      .filter((j) => j.experimentId === experiment.experimentId)
      .map((j) => `${j.repetitionIndex}:${j.attemptIndex}`)
  );

  for (let i = 0; i < adding; i++) {
    const repetitionIndex = args.retryOf ? args.retryOf.repetitionIndex : i;
    const attemptIndex = args.retryOf ? args.retryOf.attemptIndex : 0;
    if (alreadyPresent.has(`${repetitionIndex}:${attemptIndex}`)) {
      skippedExisting++;
      continue;
    }

    const seq = await args.metadata.tx((t) => t.nextSequence(args.investigationId, "job"));
    if (i === 0) firstSeq = seq;
    const id = deriveJobId(
      cfg.execution.seed,
      args.investigationId,
      experiment.experimentId,
      repetitionIndex,
      attemptIndex
    );

    await args.queue.enqueue({
      jobId: id,
      investigationId: args.investigationId,
      experimentId: experiment.experimentId,
      repetitionIndex,
      // A retry is a NEW row with an incremented attempt index and a link to its predecessor,
      // never a mutation of history (ADR-0005).
      attemptIndex,
      previousAttemptJobId: args.retryOf?.previousAttemptJobId ?? null,
      seq,
      approvalId: args.approvalId,
      effectiveProposalChecksum: args.effectiveProposalChecksum,
      payloadJson,
    });
    jobIds.push(id);
  }

  void clock;
  return { jobIds, firstSeq, skippedExisting };
}
