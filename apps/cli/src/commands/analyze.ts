import { canonicalJson, fail, systemClock } from "@investigator/core";
import { LineageWriter } from "@investigator/lineage";
import { runFlow } from "@investigator/ai-flows";
import {
  validateReferences,
  validateClaimSupport,
  rejectUnreachableLevel,
  type EvidenceReference,
  type ReferenceWorld,
} from "@investigator/ai-gateway";
import { contrastRuns, type RunEvidenceFacts } from "@investigator/tools";
import type { GlobalOptions, Runtime } from "../runtime.js";
import { openAiSession } from "../ai.js";
import { buildAnalysisRegistry, readFlowFacts, readRunEvidence } from "../tool-registry.js";

/**
 * `investigate analyze` — read the runs that were measured and say what they show.
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * The deterministic half runs FIRST and unconditionally: `contrastRuns` computes what separates
 * failing runs from passing ones by arithmetic, and that contrast is printed whether or not a
 * model is ever reached. So the most load-bearing answer in the whole product -- what is
 * different about the runs that failed -- never depends on a provider being available, or
 * correct.
 *
 * The model's reading is additive on top, and every claim it makes is reference-checked against
 * the very runs the tools returned. A citation to a run that was not in evidence is a fabrication
 * and the output is refused, not repaired into plausibility.
 */

export interface AnalyzeOptions {
  ai?: boolean;
  replay?: string;
  json?: boolean;
}

interface AnalysisFinding {
  level: string;
  statement: string;
  claimCategory?: string;
  mechanism?: string;
  supportingEvidence: EvidenceReference[];
  contradictingEvidence?: EvidenceReference[];
  confidence: number;
}

interface AnalysisOutput {
  summary: string;
  findings: AnalysisFinding[];
  reproductionSteps: {
    confidence: string;
    basedOnRunIds: string[];
    preconditions?: string[];
    steps: Array<{ ordinal: number; action: string; expected?: string; timingSensitive?: boolean }>;
    whyThisReproduces?: string;
    notReproducedBy?: string[];
  };
  openQuestions?: Array<{ question: string; whyItMatters: string; howToAnswer?: string }>;
  evidenceGaps?: string[];
}

/**
 * A ReferenceWorld over exactly what the tools returned.
 *
 * Deliberately NOT over the whole workspace. A model may only cite what it was shown; letting a
 * citation resolve against a run the tools never surfaced would validate a claim the model had no
 * basis to make and could not have checked.
 */
function worldFor(
  investigationId: string,
  runs: readonly RunEvidenceFacts[],
  comparisonId: string
): ReferenceWorld {
  const byRun = new Map(runs.map((r) => [r.runId, r]));
  return {
    investigationExists: (id) => id === investigationId,
    runBelongsTo: (runId) => byRun.has(runId),
    // Event-level citation is not resolvable from the feature projection the tools expose, so
    // any event id is refused rather than waved through. Refusing is the safe direction: it
    // pushes the model towards comparison and statistic citations, which ARE checkable here.
    eventBelongsTo: () => false,
    artifactExists: () => false,
    artifactKind: () => null,
    resolveField: (ref) => {
      if (ref.statisticId === comparisonId || ref.runId === undefined)
        return { found: false, value: undefined };
      const run = byRun.get(ref.runId);
      if (!run || !ref.field) return { found: false, value: undefined };
      const parts = ref.field.replace(/^\//, "").split("/");
      let cur: unknown = { features: run.features, outcome: run.outcome, actions: run.actions };
      for (const part of parts) {
        if (cur === null || typeof cur !== "object") return { found: false, value: undefined };
        cur = (cur as Record<string, unknown>)[
          decodeURIComponent(part.replace(/~1/g, "/").replace(/~0/g, "~"))
        ];
        if (cur === undefined) return { found: false, value: undefined };
      }
      return { found: true, value: cur };
    },
    unusableCategories: (runId) => {
      const run = byRun.get(runId);
      if (!run) return [];
      return Object.entries(run.captureStatus)
        .filter(([, s]) => s === "missing" || s === "corrupted")
        .map(([c]) => c);
    },
  };
}

export async function analyzeCommand(
  rt: Runtime,
  opts: AnalyzeOptions,
  globals: GlobalOptions
): Promise<{ json: unknown; human: () => string }> {
  const investigationId = globals.investigation;
  if (!investigationId) {
    fail("INPUT_INVALID", "`investigate analyze` requires --investigation <id>", {
      context: { flag: "--investigation" },
    });
  }
  if (!(await rt.metadata.read((t) => t.getInvestigation(investigationId)))) {
    fail("GATE_REFERENCE_UNKNOWN", `Unknown investigation ${investigationId}`, {
      context: { investigationId },
    });
  }

  const runs = await readRunEvidence(rt, investigationId);
  if (runs.length === 0) {
    fail("INPUT_INVALID", "No runs with normalized evidence. Run experiments before analysing.", {
      context: { investigationId },
    });
  }

  // Deterministic first, and unconditional. This is the answer that does not need a provider.
  const contrast = contrastRuns(runs);

  let analysis: AnalysisOutput | null = null;
  let aiRequestIds: string[] = [];
  const referenceIssues: string[] = [];

  if (opts.ai) {
    const session = await openAiSession({
      rt,
      investigationId,
      flowId: "analyze_failures",
      ...(opts.replay ? { replayDir: opts.replay } : {}),
    });
    const flow = await readFlowFacts(rt, investigationId);
    const registry = buildAnalysisRegistry(rt, investigationId, { flow, runs });

    const result = await runFlow<AnalysisOutput>(
      {
        flow: session.flow,
        input: { investigationId },
        userContent: JSON.stringify({
          investigationId,
          instruction: "Call contrast_runs first, then analyse. Cite only what the tools returned.",
        }),
      },
      {
        investigationId,
        gateway: session.gateway,
        capabilities: session.capabilities,
        registry,
        toolContext: {
          investigationId,
          normalizerVersion: "1.0.0",
          extractorVersion: "1.0.0",
          redaction: rt.redactor.policyStamp(),
          captureStatus: {},
          maxBytes: session.flow.definition.budget.maxEvidenceBytes,
        },
      }
    );

    if (result.status !== "complete") {
      fail(
        "AI_INVALID_OUTPUT",
        `analyze_failures did not complete: ${result.status === "inconclusive" ? result.reason : "partial"}`,
        { context: { flowId: "analyze_failures", status: result.status } }
      );
    }

    const value = result.value;
    const world = worldFor(investigationId, runs, contrast.comparisonId);

    // Reference validation is applied HERE, outside the flow runner, because only this layer
    // knows which runs were actually shown to the model.
    for (const [i, f] of (value.findings ?? []).entries()) {
      const refs = [...(f.supportingEvidence ?? []), ...(f.contradictingEvidence ?? [])];
      for (const r of validateReferences(refs, investigationId, world, `/findings/${i}`).issues) {
        referenceIssues.push(`${r.path}: ${r.message}`);
      }
      for (const r of validateClaimSupport(
        f.level,
        f.supportingEvidence ?? [],
        `/findings/${i}/level`
      ).issues) {
        referenceIssues.push(`${r.path}: ${r.message}`);
      }
      for (const r of rejectUnreachableLevel(f.level, false).issues) {
        referenceIssues.push(`/findings/${i}/level: ${r.message}`);
      }
    }
    for (const runId of value.reproductionSteps?.basedOnRunIds ?? []) {
      if (!world.runBelongsTo(runId, investigationId)) {
        referenceIssues.push(`/reproductionSteps/basedOnRunIds: ${runId} was not in evidence`);
      }
    }

    if (referenceIssues.length > 0) {
      // Nothing partial is persisted. An analysis citing evidence that does not exist is not a
      // weaker analysis, it is a different kind of object, and keeping half of it would leave a
      // reader unable to tell which half.
      fail(
        "AI_INVALID_OUTPUT",
        `analyze_failures produced ${referenceIssues.length} invalid evidence reference(s)`,
        { context: { flowId: "analyze_failures", issues: referenceIssues.slice(0, 5).join("; ") } }
      );
    }

    analysis = value;
    aiRequestIds = result.record.aiRequestIds;

    const ref = await rt.artifacts.put({
      investigationId,
      kind: "report",
      filename: `${investigationId}-analysis.json`,
      bytes: canonicalJson({ ...value, investigationId, comparisonId: contrast.comparisonId }),
      contentType: "application/json",
      redactionApplied: rt.redactor.policyStamp(),
    });

    await new LineageWriter(rt.metadata, systemClock).append({
      investigationId,
      // `derived_finding` is the only edge the vocabulary allows from a run to a finding, and
      // that constraint is doing real work: it forces an analysis to hang off the runs it was
      // derived from, so "what is this claim based on?" is answerable by walking the graph.
      edge: "derived_finding",
      fromKind: "run",
      fromId: runs[0]!.runId,
      toKind: "finding",
      toId: ref.artifactId,
      actor: {
        kind: "ai",
        aiCallId: aiRequestIds[0] ?? "AIC-unknown",
        flowId: session.flow.definition.id,
        flowVersion: session.flow.definition.version,
        flowHash: session.flow.flowHash,
      },
      inputs: { runsAnalysed: runs.length, comparisonId: contrast.comparisonId },
    });
  }

  return {
    json: {
      ok: true,
      investigationId,
      runsAnalysed: runs.length,
      contrast,
      analysis,
      aiRequestIds,
    },
    human: () => renderHuman(investigationId, runs, contrast, analysis),
  };
}

function renderHuman(
  investigationId: string,
  runs: readonly RunEvidenceFacts[],
  contrast: ReturnType<typeof contrastRuns>,
  analysis: AnalysisOutput | null
): string {
  const lines: string[] = [];
  const counts = new Map<string, number>();
  for (const r of runs) counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1);

  lines.push(`Analysis of ${investigationId} — ${runs.length} run(s)`);
  lines.push("");
  lines.push(
    `  outcomes     ${[...counts.entries()]
      .sort()
      .map(([k, v]) => `${k}=${v}`)
      .join("  ")}`
  );
  lines.push(`  failing      ${contrast.failingRunIds.length}`);
  lines.push(`  passing      ${contrast.passingRunIds.length}`);
  lines.push("");

  // With no passing run there is no control group, so "appears in every failure" is a property
  // of the experiment rather than of the failure. Printing these under a heading like
  // "what separates the failing runs" would be read as the answer by anyone skimming -- the
  // caveat further down is not enough, because it arrives after the reader has drawn a
  // conclusion. So the framing changes, not just the footnote.
  const noControl = contrast.passingRunIds.length === 0;

  if (noControl) {
    lines.push("No run passed, so there is no control group and NOTHING below discriminates.");
    lines.push("These are simply present in every run; that is not evidence about the failure.");
    lines.push("");
    lines.push("Present in all failing runs:");
  } else {
    lines.push("What separates the failing runs from the passing ones (measured, not inferred):");
  }

  if (contrast.perfectDiscriminators.length === 0) {
    lines.push("  nothing appears in every failing run and no passing run.");
  } else {
    for (const d of contrast.perfectDiscriminators) lines.push(`  ${d}`);
  }

  const notable = [
    ...contrast.consoleFingerprints,
    ...contrast.exceptionFingerprints,
    ...contrast.requestOrderings,
    ...contrast.failedAssertions,
  ].filter((g) => g.discriminating);
  if (notable.length && !noControl) {
    lines.push("");
    lines.push("Discriminating signals:");
    for (const g of notable.slice(0, 10)) {
      lines.push(`  ${g.failing} failing / ${g.passing} passing   ${g.value}`);
    }
  }

  if (noControl) {
    lines.push("");
    lines.push("To make any of this discriminating, get a passing run to compare against:");
    lines.push("  - run the same experiment against a known-good control, or");
    lines.push("  - raise the repetition count until the intermittent case passes at least once.");
  }

  const timing = contrast.requestTimings.filter(
    (t) => t.deltaMs !== null && Math.abs(t.deltaMs) >= 50
  );
  if (timing.length) {
    lines.push("");
    lines.push("Timing differences (median, failing vs passing):");
    for (const t of timing.slice(0, 8)) {
      lines.push(`  ${t.deltaMs! > 0 ? "+" : ""}${t.deltaMs}ms   ${t.key}`);
    }
  }

  if (contrast.caveats.length) {
    lines.push("");
    lines.push("Limits of this comparison:");
    for (const c of contrast.caveats) lines.push(`  - ${c}`);
  }

  if (!analysis) {
    lines.push("");
    lines.push("Everything above is deterministic and needed no provider.");
    lines.push("Add --ai for an interpretation, root-cause reading, and reproduction steps.");
    return lines.join("\n");
  }

  lines.push("");
  lines.push("─".repeat(72));
  lines.push(analysis.summary);
  lines.push("");
  if (analysis.findings.length === 0) {
    lines.push("No finding was supported by the evidence.");
  }
  for (const [i, f] of analysis.findings.entries()) {
    lines.push(`${i + 1}. [${f.level}] ${f.statement}`);
    if (f.mechanism) lines.push(`   mechanism: ${f.mechanism}`);
    lines.push(`   supported by ${f.supportingEvidence.length} reference(s)`);
    if (f.contradictingEvidence?.length) {
      lines.push(`   CONTRADICTED by ${f.contradictingEvidence.length} reference(s)`);
    }
  }

  const rs = analysis.reproductionSteps;
  lines.push("");
  lines.push(
    `Reproduction steps (confidence: ${rs.confidence}, from ${rs.basedOnRunIds.join(", ")})`
  );
  for (const p of rs.preconditions ?? []) lines.push(`   precondition: ${p}`);
  for (const s of rs.steps) {
    lines.push(`   ${s.ordinal}. ${s.action}${s.timingSensitive ? "   [TIMING SENSITIVE]" : ""}`);
    if (s.expected) lines.push(`      expected: ${s.expected}`);
  }
  for (const n of rs.notReproducedBy ?? []) lines.push(`   does NOT reproduce: ${n}`);

  if (analysis.evidenceGaps?.length) {
    lines.push("");
    lines.push("Evidence gaps:");
    for (const g of analysis.evidenceGaps) lines.push(`  - ${g}`);
  }
  if (analysis.openQuestions?.length) {
    lines.push("");
    lines.push("Open questions:");
    for (const q of analysis.openQuestions) {
      lines.push(`  - ${q.question}`);
      lines.push(`    why: ${q.whyItMatters}`);
      if (q.howToAnswer) lines.push(`    next: ${q.howToAnswer}`);
    }
  }
  return lines.join("\n");
}
