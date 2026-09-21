import { join } from "node:path";
import { canonicalJson, fail, sha256Hex, sha256Prefixed, systemClock } from "@investigator/core";
import {
  DEFAULT_STATISTICAL_SETTINGS,
  countRun,
  decideConfirmation,
  deriveTargetSignature,
  type ArmCounts,
  type ConfirmationVerdict,
  type StatisticalSettings,
  type TargetSignature,
} from "@investigator/evidence";
import { buildConfirmationSchedule, type ConfirmationFactor } from "@investigator/execution";
import { LineageWriter } from "@investigator/lineage";
import { investigationDirs } from "@investigator/storage";
import type { GlobalOptions, Runtime } from "../runtime.js";
import { suiteChecksum } from "../rerun-capture.js";
import { listRerunBatches, readBatchEvidence } from "../tool-registry.js";
import { rerunCommand } from "./rerun.js";

/**
 * `investigate confirm` -- Confirm -> View result (ADR-0031).
 *
 * Without `--checksum` it only builds the experiment config the condition card shows and prints
 * it with its SHA-256. With `--checksum` -- the operator's single Confirm click, carrying the hash
 * of the bytes they were shown -- it rebuilds the same config, refuses if a byte differs, freezes
 * it as an artifact, and runs it: 2N repeats of the authored script, variant and control
 * interleaved by the seed in the config, counting only failures that match the target signature
 * derived from the earlier batch. The statistics are internal and frozen with it.
 *
 * Not one of the three approval gates: like `rerun`, this runs the operator's own script outside
 * the measured path, and the frozen, checksum-bound config is the record of the decision.
 */

export interface ConfirmOptions {
  /** 1-based index into the analysis's proposed confirmations. */
  condition?: number;
  checksum?: string;
  perArm?: number;
  batch?: string;
}

export interface ConfirmationConfig {
  schemaVersion: "1.0.0";
  investigationId: string;
  sourceBatchId: string;
  analysisArtifactId: string;
  conditionIndex: number;
  condition: string;
  falsifier: string;
  rationale: string;
  factor: ConfirmationFactor;
  control: { kind: "none" };
  perArm: number;
  suiteChecksum: string;
  targetSignature: TargetSignature;
  seed: number;
  statistics: StatisticalSettings;
}

export interface ProposedConfirmation {
  condition: string;
  factor: ConfirmationFactor;
  rationale: string;
  falsifier: string;
}

/**
 * Runs per arm. Above the statistical minimum on purpose: a run whose browser fails to start is
 * excluded, correctly, and with no headroom a single such hiccup would make any confirmation
 * impossible.
 */
export const DEFAULT_PER_ARM = 12;

/** The bytes the operator confirms: canonical JSON (sorted keys, fixed layout, one newline). */
export function configBytes(config: ConfirmationConfig): string {
  return canonicalJson(config);
}

export function configChecksum(config: ConfirmationConfig): string {
  return sha256Prefixed(configBytes(config));
}

/** The seed of the interleaving, derived from what is being confirmed so a rebuild agrees. */
export function confirmationSeed(analysisArtifactId: string, conditionIndex: number): number {
  return Number.parseInt(sha256Hex(`${analysisArtifactId}:${conditionIndex}`).slice(0, 8), 16);
}

export function buildConfirmationConfig(args: {
  investigationId: string;
  sourceBatchId: string;
  analysisArtifactId: string;
  conditionIndex: number;
  proposal: ProposedConfirmation;
  perArm: number;
  suiteChecksum: string;
  targetSignature: TargetSignature;
  statistics?: StatisticalSettings;
}): ConfirmationConfig {
  return {
    schemaVersion: "1.0.0",
    investigationId: args.investigationId,
    sourceBatchId: args.sourceBatchId,
    analysisArtifactId: args.analysisArtifactId,
    conditionIndex: args.conditionIndex,
    condition: args.proposal.condition,
    falsifier: args.proposal.falsifier,
    rationale: args.proposal.rationale,
    factor: args.proposal.factor,
    control: { kind: "none" },
    perArm: args.perArm,
    suiteChecksum: args.suiteChecksum,
    targetSignature: args.targetSignature,
    seed: confirmationSeed(args.analysisArtifactId, args.conditionIndex),
    statistics: args.statistics ?? DEFAULT_STATISTICAL_SETTINGS,
  };
}

interface StoredAnalysis {
  source?: { kind?: string; batchId?: string };
  proposedConfirmations?: ProposedConfirmation[];
}

/** The latest analysis of a rerun batch -- the named one, or the latest batch analysed. */
async function latestBatchAnalysis(
  rt: Runtime,
  investigationId: string,
  batchId?: string
): Promise<{ artifactId: string; analysis: StoredAnalysis; batchId: string } | null> {
  const refs = await rt.artifacts.list(investigationId, { kind: "report" });
  const sorted = [...refs].sort((a, b) => (a.storedAt < b.storedAt ? 1 : -1));
  for (const ref of sorted) {
    if (!ref.filename.endsWith("-analysis.json")) continue;
    let analysis: StoredAnalysis;
    try {
      analysis = JSON.parse(await rt.artifacts.getText(ref)) as StoredAnalysis;
    } catch {
      continue;
    }
    if (analysis.source?.kind !== "rerun-batch" || !analysis.source.batchId) continue;
    if (batchId && analysis.source.batchId !== batchId) continue;
    return { artifactId: ref.artifactId, analysis, batchId: analysis.source.batchId };
  }
  return null;
}

export interface ConfirmationResult {
  schemaVersion: "1.0.0";
  investigationId: string;
  configArtifactId: string;
  configChecksum: string;
  batchId: string;
  condition: string;
  factor: ConfirmationFactor;
  variant: ArmCounts;
  control: ArmCounts;
  /** Variant repeats whose factor did not take: counted in neither arm. */
  factorNotApplied: number;
  decision: ConfirmationVerdict;
  rootCauseHypothesis?: { statement: string; mechanism: string };
}

/** Count a finished confirmation batch by arm. Pure over its inputs. */
export function countConfirmation(
  signature: TargetSignature,
  runs: ReadonlyArray<{
    outcome: string;
    features: Record<string, unknown>;
    arm?: { arm: string; factorApplied: boolean };
  }>
): { variant: ArmCounts; control: ArmCounts; factorNotApplied: number } {
  const empty = (): ArmCounts => ({ matched: 0, reached: 0, otherFailures: 0, excluded: 0 });
  const variant = empty();
  const control = empty();
  let factorNotApplied = 0;
  for (const run of runs) {
    if (!run.arm) continue;
    const arm = run.arm.arm === "variant" ? variant : control;
    const c = countRun(signature, run);
    // A run that never reached the check says nothing, whichever arm it was.
    if (c === "excluded") {
      arm.excluded++;
      continue;
    }
    // A variant run that reached the check without its factor is not a variant run.
    if (run.arm.arm === "variant" && !run.arm.factorApplied) {
      factorNotApplied++;
      continue;
    }
    arm.reached++;
    if (c === "matched") arm.matched++;
    if (c === "other-failure") arm.otherFailures++;
  }
  return { variant, control, factorNotApplied };
}

export async function confirmCommand(
  rt: Runtime,
  opts: ConfirmOptions,
  globals: GlobalOptions
): Promise<{ json: unknown; human: () => string }> {
  const investigationId = globals.investigation;
  if (!investigationId) {
    fail("INPUT_INVALID", "`investigate confirm` requires --investigation <id>", {
      context: { flag: "--investigation" },
    });
  }
  const conditionIndex = Number(opts.condition);
  if (!Number.isInteger(conditionIndex) || conditionIndex < 1) {
    fail("INPUT_INVALID", "`--condition` must be the number of a proposed condition, from 1", {
      context: { condition: String(opts.condition ?? "") },
    });
  }
  const perArm = opts.perArm === undefined ? DEFAULT_PER_ARM : Number(opts.perArm);
  if (
    !Number.isInteger(perArm) ||
    perArm < DEFAULT_STATISTICAL_SETTINGS.minReachedPerArm ||
    perArm > 100
  ) {
    fail(
      "INPUT_INVALID",
      `\`--per-arm\` must be a whole number from ${DEFAULT_STATISTICAL_SETTINGS.minReachedPerArm} to 100`,
      { context: { perArm: String(opts.perArm ?? "") } }
    );
  }

  const found = await latestBatchAnalysis(rt, investigationId, opts.batch);
  if (!found) {
    fail(
      "INPUT_INVALID",
      "There is no analysis of the authored script's runs to confirm from. Run it, then analyse it with --ai.",
      { context: { investigationId } }
    );
  }
  const proposal = found.analysis.proposedConfirmations?.[conditionIndex - 1];
  if (!proposal) {
    fail("INPUT_INVALID", `The analysis proposed no condition ${conditionIndex}`, {
      context: {
        investigationId,
        proposed: String(found.analysis.proposedConfirmations?.length ?? 0),
      },
    });
  }

  const source = await readBatchEvidence(rt, investigationId, found.batchId);
  if (!source) {
    fail("GATE_REFERENCE_UNKNOWN", `Unknown rerun batch ${found.batchId}`, {
      context: { investigationId, batch: found.batchId },
    });
  }
  const suiteDir = join(
    investigationDirs(rt.workspace, investigationId).root,
    "authoring",
    "suite"
  );
  const config = buildConfirmationConfig({
    investigationId,
    sourceBatchId: found.batchId,
    analysisArtifactId: found.artifactId,
    conditionIndex,
    proposal,
    perArm,
    suiteChecksum: suiteChecksum(suiteDir),
    targetSignature: deriveTargetSignature(source.runs),
  });
  const bytes = configBytes(config);
  const checksum = sha256Prefixed(bytes);

  // The card: what will run, and the hash the Confirm click must carry.
  if (opts.checksum === undefined) {
    return {
      json: { ok: true, preview: true, investigationId, config, checksum, runs: 2 * perArm },
      human: () =>
        [
          `Condition ${conditionIndex}: ${config.condition}`,
          `  change   ${describeFactor(config.factor)}`,
          `  runs     ${perArm} with the change and ${perArm} without, interleaved`,
          `  counts   only failures at the final check that match the earlier failures`,
          `  disproved if: ${config.falsifier}`,
          "",
          `Confirm with --checksum ${checksum}`,
        ].join("\n"),
    };
  }

  if (opts.checksum !== checksum) {
    fail(
      "GATE_CHECKSUM_MISMATCH",
      "The experiment to confirm is no longer the one that was shown: its config changed. Nothing ran.",
      { context: { expected: checksum, supplied: opts.checksum } }
    );
  }

  const configRef = await rt.artifacts.put({
    investigationId,
    kind: "confirmation-config",
    filename: `${investigationId}-confirmation-config.json`,
    bytes,
    contentType: "application/json",
    redactionApplied: rt.redactor.stamp(),
  });

  const rerun = await rerunCommand(rt, { repeat: 2 * perArm }, globals, {
    run: { factor: config.factor, schedule: buildConfirmationSchedule(perArm, config.seed) },
    configArtifactId: configRef.artifactId,
    configChecksum: checksum,
  });
  const ran = rerun.json as {
    evidenceIngested?: boolean;
    batchId?: string;
    evidenceError?: string;
  };
  if (!ran.evidenceIngested || !ran.batchId) {
    fail(
      "EXEC_ACTION_FAILED",
      `The confirmation runs finished but their evidence could not be stored${ran.evidenceError ? `: ${ran.evidenceError}` : ""}`,
      { context: { investigationId } }
    );
  }

  const batch = await readBatchEvidence(rt, investigationId, ran.batchId);
  const record = (await listRerunBatches(rt, investigationId)).find(
    (b) => b.batchId === ran.batchId
  );
  if (!batch || !record) {
    fail("INTERNAL", `The confirmation batch ${ran.batchId} could not be read back`, {
      context: { investigationId },
    });
  }
  const armById = new Map(
    record.runs.map((r) => [r.runId, (r as { arm?: { arm: string; factorApplied: boolean } }).arm])
  );
  const counted = countConfirmation(
    config.targetSignature,
    batch.runs.map((r) => {
      const arm = armById.get(r.runId);
      return { outcome: r.outcome, features: r.features, ...(arm ? { arm } : {}) };
    })
  );
  const decision = decideConfirmation(counted.variant, counted.control, config.statistics);

  const result: ConfirmationResult = {
    schemaVersion: "1.0.0",
    investigationId,
    configArtifactId: configRef.artifactId,
    configChecksum: checksum,
    batchId: ran.batchId,
    condition: config.condition,
    factor: config.factor,
    ...counted,
    decision,
    ...(decision.verdict === "high_confidence_trigger"
      ? { rootCauseHypothesis: { statement: config.condition, mechanism: config.rationale } }
      : {}),
  };
  const resultRef = await rt.artifacts.put({
    investigationId,
    kind: "confirmation-result",
    filename: `${investigationId}-confirmation-result.json`,
    bytes: canonicalJson(result),
    contentType: "application/json",
    redactionApplied: rt.redactor.stamp(),
  });

  // The result hangs off the runs it was counted from, as every finding does.
  if (batch.runs[0]) {
    await new LineageWriter(rt.metadata, systemClock).append({
      investigationId,
      edge: "derived_finding",
      fromKind: "run",
      fromId: batch.runs[0].runId,
      toKind: "finding",
      toId: resultRef.artifactId,
      actor: { kind: "deterministic", component: "confirm", version: "1.0.0" },
      inputs: {
        configChecksum: checksum,
        batchId: ran.batchId,
        verdict: decision.verdict,
      },
    });
  }

  return {
    json: { ok: true, preview: false, ...result, resultArtifactId: resultRef.artifactId },
    human: () => renderResult(result),
  };
}

export function describeFactor(f: ConfirmationFactor): string {
  return f.kind === "network"
    ? `the network slowed to ${f.profile === "slow-3g" ? "slow 3G" : "fast 3G"}`
    : `the CPU slowed ${f.rate}×`;
}

function renderResult(r: ConfirmationResult): string {
  const pct = (x: number): string => `${Math.round(x * 100)}%`;
  const lines = [
    r.decision.verdict === "high_confidence_trigger"
      ? `Confirmed: ${r.condition}`
      : `Not confirmed: ${r.condition}`,
    `  with ${describeFactor(r.factor)}: ${r.variant.matched} of ${r.variant.reached} (${pct(r.decision.variantRate)})`,
    `  without it:          ${r.control.matched} of ${r.control.reached} (${pct(r.decision.controlRate)})`,
  ];
  const other = r.variant.otherFailures + r.control.otherFailures;
  if (other) lines.push(`  ${other} other failure(s) at the check were not counted`);
  if (r.factorNotApplied)
    lines.push(`  ${r.factorNotApplied} run(s) where the change did not take were not counted`);
  if (r.decision.reason) lines.push(`  ${r.decision.reason}`);
  if (r.rootCauseHypothesis) lines.push(`  Likely mechanism: ${r.rootCauseHypothesis.mechanism}`);
  return lines.join("\n");
}
