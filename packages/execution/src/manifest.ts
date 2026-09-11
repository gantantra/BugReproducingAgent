import type {
  ArtifactRef,
  CaptureStatus,
  ConfigSourceEntry,
  JobTerminalReason,
  OutcomeRuleId,
  ResolvedEmulation,
  RunOutcome,
  TargetClassification,
  VersionStamps,
  Clock,
} from "@investigator/core";
import {
  computeSealHash,
  fail,
  isLegalTerminalOutcome,
  verifySealHash,
} from "@investigator/core";
import type { AssertionOutcome } from "@investigator/evidence";
import type { DeclaredFactor } from "./types.js";

/**
 * Immutable run manifest (ADR-0004, ADR-0005).
 *
 * Opened BEFORE the first browser action with everything already known — ids, resolved config,
 * emulation, seed, versions — then sealed after the run with the outcome, the rule that decided
 * it, completeness, and the artifact digest list. The seal hash covers every recorded field
 * including that digest list, so tampering with either is detectable.
 *
 * A second seal raises MANIFEST_IMMUTABLE. This is the crash-consistency anchor from the queue
 * model: an unsealed manifest plus an expired lease is unambiguously INTERRUPTED.
 */

export interface RunManifest {
  schemaVersion: "1.0.0";
  runId: string;
  jobId: string;
  investigationId: string;
  experimentId: string;
  approvedExperimentId?: string;
  approvalId: string | null;
  effectiveProposalChecksum: string | null;
  repetitionIndex: number;
  attemptIndex: number;
  previousAttemptJobId: string | null;
  seed: number;
  emulation: ResolvedEmulation;
  versions: VersionStamps;
  target: {
    name: string;
    baseUrl: string;
    classification: TargetClassification;
    resetStrategy?: string;
    allowedOrigins?: string[];
  };
  configSources: Record<string, ConfigSourceEntry>;
  declaredFactors?: DeclaredFactor[];
  openedAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  sealed: boolean;
  sealedAt?: string;
  sealHash?: string;
  jobState?: "TERMINAL";
  jobTerminalReason?: JobTerminalReason;
  runOutcome?: RunOutcome;
  outcomeRuleId?: OutcomeRuleId;
  outcomeDetail?: string;
  assertionOutcomes?: AssertionOutcome[];
  captureStatus?: CaptureStatus;
  artifacts?: ArtifactRef[];
  warnings?: string[];
  unsafeDebug?: boolean;
  unsafeTrace?: boolean;
}

export interface OpenManifestArgs {
  runId: string;
  jobId: string;
  investigationId: string;
  experimentId: string;
  approvalId: string | null;
  effectiveProposalChecksum: string | null;
  repetitionIndex: number;
  attemptIndex: number;
  previousAttemptJobId: string | null;
  seed: number;
  emulation: ResolvedEmulation;
  versions: VersionStamps;
  target: RunManifest["target"];
  configSources: Record<string, ConfigSourceEntry>;
  clock: Clock;
}

export interface SealManifestArgs {
  terminalReason: JobTerminalReason;
  outcome: RunOutcome;
  outcomeRuleId: OutcomeRuleId;
  outcomeDetail: string;
  assertionOutcomes: AssertionOutcome[];
  captureStatus: CaptureStatus;
  artifacts: ArtifactRef[];
  declaredFactors: DeclaredFactor[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  warnings?: string[];
  unsafeDebug?: boolean;
  unsafeTrace?: boolean;
  clock: Clock;
}

export class ManifestWriter {
  private manifest: RunManifest;
  private isSealed = false;

  constructor(args: OpenManifestArgs) {
    this.manifest = {
      schemaVersion: "1.0.0",
      runId: args.runId,
      jobId: args.jobId,
      investigationId: args.investigationId,
      experimentId: args.experimentId,
      approvalId: args.approvalId,
      effectiveProposalChecksum: args.effectiveProposalChecksum,
      repetitionIndex: args.repetitionIndex,
      attemptIndex: args.attemptIndex,
      previousAttemptJobId: args.previousAttemptJobId,
      seed: args.seed,
      emulation: args.emulation,
      versions: args.versions,
      target: args.target,
      configSources: args.configSources,
      openedAt: args.clock.nowIso(),
      sealed: false,
    };
  }

  markStarted(clock: Clock): void {
    if (this.isSealed) fail("MANIFEST_IMMUTABLE", "Manifest is sealed", { context: { runId: this.manifest.runId } });
    this.manifest.startedAt = clock.nowIso();
  }

  /** The open, unsealed manifest. Written to disk before the first action. */
  open(): RunManifest {
    return { ...this.manifest };
  }

  seal(args: SealManifestArgs): RunManifest {
    if (this.isSealed) {
      fail("MANIFEST_IMMUTABLE", "Run manifest is already sealed", {
        context: { runId: this.manifest.runId },
      });
    }
    if (!isLegalTerminalOutcome(args.terminalReason, args.outcome)) {
      fail("INTERNAL", "Illegal (terminalReason, runOutcome) combination at seal time", {
        context: {
          runId: this.manifest.runId,
          reason: args.terminalReason,
          outcome: args.outcome,
        },
      });
    }

    const sealed: RunManifest = {
      ...this.manifest,
      startedAt: args.startedAt,
      finishedAt: args.finishedAt,
      durationMs: args.durationMs,
      declaredFactors: args.declaredFactors,
      sealed: true,
      sealedAt: args.clock.nowIso(),
      jobState: "TERMINAL",
      jobTerminalReason: args.terminalReason,
      runOutcome: args.outcome,
      outcomeRuleId: args.outcomeRuleId,
      outcomeDetail: args.outcomeDetail,
      assertionOutcomes: args.assertionOutcomes,
      captureStatus: args.captureStatus,
      // Sorted so the digest list, and therefore the seal hash, is deterministic.
      artifacts: [...args.artifacts].sort((a, b) => (a.artifactId < b.artifactId ? -1 : 1)),
      ...(args.warnings?.length ? { warnings: args.warnings } : {}),
      ...(args.unsafeDebug ? { unsafeDebug: true } : {}),
      ...(args.unsafeTrace ? { unsafeTrace: true } : {}),
    };

    sealed.sealHash = computeSealHash(sealed as unknown as Record<string, unknown>, "sealHash");
    this.manifest = sealed;
    this.isSealed = true;
    return { ...sealed };
  }

  get sealedManifest(): RunManifest | null {
    return this.isSealed ? { ...this.manifest } : null;
  }
}

/** Verify a manifest seal. Any mismatch is MANIFEST_SEAL_INVALID, exit 9. */
export function verifyManifest(manifest: RunManifest): { ok: boolean; detail: string | null } {
  if (!manifest.sealed) return { ok: false, detail: "manifest is not sealed" };
  if (!manifest.sealHash) return { ok: false, detail: "manifest has no seal hash" };
  const check = verifySealHash(manifest as unknown as Record<string, unknown>, "sealHash");
  if (check.ok) return { ok: true, detail: null };
  return { ok: false, detail: `seal hash mismatch: expected ${check.expected}` };
}

export function assertManifestValid(manifest: RunManifest): void {
  const result = verifyManifest(manifest);
  if (!result.ok) {
    fail("MANIFEST_SEAL_INVALID", "Run manifest failed seal verification", {
      context: { runId: manifest.runId, detail: result.detail },
    });
  }
}

/**
 * Build a sealed PARTIAL manifest for a reaped run. An interrupted run still has usable evidence
 * up to the truncation, and it must not look like a run that never happened (ADR-0003).
 */
export function sealInterrupted(
  writer: ManifestWriter,
  args: {
    captureStatus: CaptureStatus;
    artifacts: ArtifactRef[];
    startedAt: string;
    clock: Clock;
  }
): RunManifest {
  const finishedAt = args.clock.nowIso();
  return writer.seal({
    terminalReason: "INTERRUPTED",
    outcome: "INTERRUPTED",
    outcomeRuleId: 1,
    outcomeDetail: "Killed, lease expired, or terminated mid-run",
    assertionOutcomes: [],
    captureStatus: args.captureStatus,
    artifacts: args.artifacts,
    declaredFactors: [],
    startedAt: args.startedAt,
    finishedAt,
    durationMs: Math.max(0, new Date(finishedAt).getTime() - new Date(args.startedAt).getTime()),
    warnings: ["Run was interrupted; evidence is partial up to the point of interruption."],
    clock: args.clock,
  });
}
