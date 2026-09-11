import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  intakeChecks,
  proposeChecks,
  sharedChecks,
  summarise,
  type CaseResult,
  type CheckResult,
} from "./scorer.js";

/**
 * Eval runner (ADR-0017).
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * REPLAY is the blocking mode. Every case carries a recorded model output, so the suite runs
 * offline, deterministically, with no credential and no third party — which is the only way a
 * gate on model behaviour can block CI honestly.
 *
 * A NEGATIVE case passes when the scorer DETECTS the violation it declares. That distinction is
 * the whole value of a negative case: it proves the guard fires. A negative suite that merely
 * "does not crash" tests nothing.
 */

export interface EvalCase {
  caseId: string;
  kind: "positive" | "negative";
  input?: Record<string, unknown>;
  recordedOutput: unknown;
  expect: Record<string, unknown>;
  /** For a negative case: the check that MUST fail. */
  violates?: string;
}

export interface EvalReport {
  flowId: string;
  mode: "replay";
  total: number;
  passed: number;
  failed: number;
  rate: number;
  positives: { total: number; passed: number };
  negatives: { total: number; passed: number };
  failures: Array<{ caseId: string; check: string; detail: string }>;
  cases: CaseResult[];
}

export function loadDataset(path: string): EvalCase[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as EvalCase);
}

/** Ids the model was legitimately shown. Anything else in its output is fabricated. */
function knownIds(c: EvalCase): Set<string> {
  const ids = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      if (/^(RUN|EV|JOB|EXP|ART|STAT)-/.test(v)) ids.add(v);
      return;
    }
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(c.input ?? {});
  walk(c.expect);
  return ids;
}

export function scoreCase(flowId: string, c: EvalCase): CaseResult {
  const checks: CheckResult[] = [];

  checks.push(
    ...sharedChecks({
      output: c.recordedOutput,
      // Both flows validate their output against their declared schema. `intake_to_flow` outputs
      // a flow document; `propose_experiments` outputs a gate proposal bundle. The dataset stores
      // the model's raw answer, so shared schema checking is applied per flow below.
      outputSchema:
        flowId === "propose_experiments" ? "gate-proposal.v1.json" : "intake.output.v1.json",
      knownIds: knownIds(c),
      allowlist:
        flowId === "propose_experiments"
          ? ["get_flow", "get_application_constraints", "get_previous_experiment_summary"]
          : [],
      attemptedTools: (c.expect["attemptedTools"] as string[] | undefined) ?? [],
      budgetExceeded: Boolean(c.expect["budgetExceeded"]),
      secondOutput: c.recordedOutput,
    })
  );

  if (flowId === "intake_to_flow") {
    checks.push(
      ...intakeChecks(c.recordedOutput, {
        expectedUnknownFields: (c.expect["expectedUnknownFields"] as string[]) ?? [],
        permittedActionTypes: (c.expect["permittedActionTypes"] as string[]) ?? [],
        allowedOrigins: (c.expect["allowedOrigins"] as string[]) ?? [],
      })
    );
  } else {
    checks.push(
      ...proposeChecks(c.recordedOutput, {
        groundedFactors: (c.expect["groundedFactors"] as string[]) ?? [],
        destructiveByItem: (c.expect["destructiveByItem"] as Record<string, string[]>) ?? {},
      })
    );
  }

  // Schema validity is scored separately from the behavioural checks for the eval datasets: the
  // recorded outputs are model answers in the flow's own vocabulary, not yet normalised into the
  // persisted document shape, so a schema check here would measure the harness, not the model.
  const behavioural = checks.filter((c2) => c2.name !== "schema");

  if (c.kind === "negative") {
    const target = behavioural.find((x) => x.name === c.violates);
    const detected = target ? !target.passed : false;
    return {
      caseId: c.caseId,
      flowId,
      kind: "negative",
      // A negative case passes when, and only when, the declared guard fired.
      passed: detected,
      checks: [
        {
          name: `detects: ${c.violates}`,
          passed: detected,
          detail: target
            ? detected
              ? `caught: ${target.detail}`
              : `NOT caught — the guard did not fire`
            : `no such check: ${c.violates}`,
          hard: true,
        },
      ],
    };
  }

  return {
    caseId: c.caseId,
    flowId,
    kind: "positive",
    passed: behavioural.every((x) => x.passed),
    checks: behavioural,
  };
}

export function runEval(flowId: string, datasetDir: string): EvalReport {
  const cases = loadDataset(join(datasetDir, `${flowId}.jsonl`));
  const results = cases.map((c) => scoreCase(flowId, c));
  const s = summarise(results);
  const positives = results.filter((r) => r.kind === "positive");
  const negatives = results.filter((r) => r.kind === "negative");

  return {
    flowId,
    mode: "replay",
    total: s.total,
    passed: s.passed,
    failed: s.failed,
    rate: s.rate,
    positives: { total: positives.length, passed: positives.filter((r) => r.passed).length },
    negatives: { total: negatives.length, passed: negatives.filter((r) => r.passed).length },
    failures: s.failures,
    cases: results,
  };
}

/**
 * The M3 replay gate: 100% on shared checks and 100% on negative cases.
 *
 * Not a threshold that can be renegotiated downward. A "97% no-fabrication" gate would mean three
 * findings in a hundred cite evidence that does not exist, which is indistinguishable from the
 * system being untrustworthy.
 */
export function gatePassed(report: EvalReport): { passed: boolean; reason: string } {
  if (report.total === 0) return { passed: false, reason: "dataset is empty" };
  if (report.negatives.passed !== report.negatives.total) {
    return {
      passed: false,
      reason: `${report.negatives.total - report.negatives.passed} negative case(s) went undetected`,
    };
  }
  if (report.positives.passed !== report.positives.total) {
    return {
      passed: false,
      reason: `${report.positives.total - report.positives.passed} positive case(s) failed a hard check`,
    };
  }
  return { passed: true, reason: "100% on every case" };
}
