import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { COLLECTOR_VERSION, sha256Prefixed, type EvidenceCategory } from "@investigator/core";
import {
  buildEvidenceQuality,
  runPlane,
  type AssertionOutcome,
  type PlaneResult,
  type Redactor,
} from "@investigator/evidence";
import {
  SUITE_CAPTURE_CONFIG_ENV,
  VIDEO_UNREDACTABLE_RULE,
  suiteCaptureArmName,
  suiteCaptureLogName,
  type ArmRecord,
  type SuiteCaptureConfig,
} from "@investigator/execution";
import type { LocalArtifactStore, SqliteMetadataStore } from "@investigator/storage";
import type { ResolvedConfig } from "@investigator/core";

/**
 * Evidence from an authored suite's runs (ADR-0029).
 *
 * The suite is left exactly as written: plain `@playwright/test`, runnable by anyone with
 * `npx playwright test`. At run time `rerun` puts a copy of its tests in `.reproagent/`, with
 * only the import line changed to a fixture that runs the measured path's own Collector around
 * every repeat. Line numbers are unchanged, so "failed at the final check" means the same line.
 *
 * If anything about that cannot be prepared, the suite runs exactly as it did before capture
 * existed, and the result says capture was unsupported -- never silently absent.
 */

/** Where a suite's capture is prepared, relative to the suite. */
export const CAPTURE_DIR = ".reproagent";

const PLAYWRIGHT_IMPORT = /from\s+(["'])@playwright\/test\1/;

/** The evidence a run of an authored suite must have for a passing run to count as valid. */
export const AUTHORED_REQUIRED_EVIDENCE: readonly EvidenceCategory[] = [
  "navigation",
  "console",
  "exceptions",
  "networkMetadata",
];

export type CapturePreparation =
  | {
      supported: true;
      configArgs: string[];
      env: Record<string, string>;
      stagingDir: string;
    }
  | { supported: false; reason: string };

/** The module the fixture loads: the built capture entry of @investigator/execution. */
export function suiteCaptureModulePath(): string {
  const req = createRequire(__filename);
  return join(dirname(req.resolve("@investigator/execution")), "suite-capture.js");
}

export function renderCaptureFixture(): string {
  return [
    `// Written by \`investigate rerun\` for this run only. The suite itself is unchanged.`,
    `import { test as base } from "@playwright/test";`,
    `export * from "@playwright/test";`,
    ``,
    `type Handle = { finish(): Promise<void> };`,
    ``,
    `export const test = base.extend<{ _reproagentCapture: void }>({`,
    `  _reproagentCapture: [`,
    `    async ({ context, page }, use, testInfo) => {`,
    `      let handle: Handle | null = null;`,
    `      try {`,
    `        // eslint-disable-next-line @typescript-eslint/no-require-imports`,
    `        const capture = require(process.env["REPROAGENT_CAPTURE_MODULE"] as string);`,
    `        const config = capture.readSuiteCaptureConfig(process.env["${SUITE_CAPTURE_CONFIG_ENV}"]);`,
    `        handle = await capture.startSuiteCapture(config, context, page, testInfo.repeatEachIndex);`,
    `      } catch (e) {`,
    `        console.warn(\`[reproagent] evidence capture could not start: \${(e as Error).message}\`);`,
    `      }`,
    `      await use();`,
    `      try {`,
    `        await handle?.finish();`,
    `      } catch (e) {`,
    `        console.warn(\`[reproagent] evidence capture could not finish: \${(e as Error).message}\`);`,
    `      }`,
    `    },`,
    `    { auto: true },`,
    `  ],`,
    `});`,
    ``,
  ].join("\n");
}

export function renderCaptureConfig(): string {
  return [
    `// Written by \`investigate rerun\` for this run only: the suite's own config, with its tests`,
    `// read from the capture copy beside this file. Artifacts land where they always did.`,
    `import { join } from "node:path";`,
    `import base from "../playwright.config";`,
    ``,
    `export default {`,
    `  ...base,`,
    `  testDir: join(__dirname, "tests"),`,
    `  outputDir: join(__dirname, "..", "artifacts"),`,
    `};`,
    ``,
  ].join("\n");
}

/**
 * Prepare the capture copy of a suite. Pure file work inside the suite folder; nothing outside it
 * is touched, and the suite's own files are only read.
 */
export function prepareSuiteCapture(opts: {
  suiteDir: string;
  policyPath: string;
  credentialNames: string[];
  capture: SuiteCaptureConfig["capture"];
  captureModule?: string;
  confirmation?: SuiteCaptureConfig["confirmation"];
}): CapturePreparation {
  const testsDir = join(opts.suiteDir, "tests");
  if (!existsSync(join(opts.suiteDir, "playwright.config.ts"))) {
    return { supported: false, reason: "the suite has no playwright.config.ts" };
  }
  if (!existsSync(testsDir)) return { supported: false, reason: "the suite has no tests folder" };
  const captureModule = opts.captureModule ?? suiteCaptureModulePath();
  if (!existsSync(captureModule)) {
    return { supported: false, reason: "the capture module is not built" };
  }

  const files = readdirSync(testsDir).filter((f) => statSync(join(testsDir, f)).isFile());
  let swapped = 0;
  const copies: Array<{ name: string; text: string }> = [];
  for (const name of files) {
    const text = readFileSync(join(testsDir, name), "utf8");
    if (/\.(spec|test)\.[cm]?[jt]s$/.test(name)) {
      if (!PLAYWRIGHT_IMPORT.test(text)) {
        return {
          supported: false,
          reason: `${name} does not import test from @playwright/test in the expected form`,
        };
      }
      copies.push({ name, text: text.replace(PLAYWRIGHT_IMPORT, `from "../capture"`) });
      swapped++;
    } else {
      copies.push({ name, text });
    }
  }
  if (swapped === 0) return { supported: false, reason: "the suite has no spec files" };

  const root = join(opts.suiteDir, CAPTURE_DIR);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "tests"), { recursive: true });
  for (const c of copies) writeFileSync(join(root, "tests", c.name), c.text, "utf8");
  writeFileSync(join(root, "capture.ts"), renderCaptureFixture(), "utf8");
  writeFileSync(join(root, "playwright.config.ts"), renderCaptureConfig(), "utf8");

  const stagingDir = join(root, "evidence");
  mkdirSync(stagingDir, { recursive: true });
  const config: SuiteCaptureConfig = {
    policyPath: opts.policyPath,
    credentialNames: opts.credentialNames,
    capture: opts.capture,
    outDir: stagingDir,
    ...(opts.confirmation ? { confirmation: opts.confirmation } : {}),
  };
  const configPath = join(root, "capture-config.json");
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  return {
    supported: true,
    configArgs: ["--config", join(root, "playwright.config.ts")],
    env: { [SUITE_CAPTURE_CONFIG_ENV]: configPath, REPROAGENT_CAPTURE_MODULE: captureModule },
    stagingDir,
  };
}

export function captureSettings(config: ResolvedConfig): SuiteCaptureConfig["capture"] {
  const c = config.execution.capture;
  return {
    responseBodyMaxBytes: c.responseBodyMaxBytes,
    responseBodyContentTypes: c.responseBodyContentTypes,
    webSocketFrames: c.webSocketFrames,
    captureBodies: c.responseBodyMaxBytes > 0,
  };
}

// ------------------------------------------------------------------------------ classification

export type AuthoredRunKind = "passed" | "failed-at-check" | "stopped-early" | "did-not-start";

export interface AuthoredRunResult {
  repeatIndex: number;
  kind: AuthoredRunKind;
  /** Script line the run failed on, when it failed on one. */
  line: number | null;
  /** The recording Playwright made of this repeat, when it made one. */
  videoPath: string | null;
}

/** The script's final check: its last `await page.` statement, as `classifyRuns` defines it. */
export function checkLineOf(specText: string): number | null {
  let checkLine: number | null = null;
  specText.split(/\r?\n/).forEach((l, i) => {
    if (/^\s*await page\./.test(l)) checkLine = i + 1;
  });
  return checkLine;
}

/**
 * Every run in a Playwright JSON report, with the repeat it was. The repeat comes from the
 * output folder Playwright names each repeat after (`…-repeat7`), so it does not depend on the
 * report's ordering; a run with no artifacts falls back to its position.
 */
export function classifyEachRun(report: unknown, specText: string): AuthoredRunResult[] {
  const checkLine = checkLineOf(specText);
  const out: AuthoredRunResult[] = [];
  let position = 0;
  const walk = (suite: unknown): void => {
    const s = suite as { suites?: unknown[]; specs?: unknown[] } | null;
    if (!s || typeof s !== "object") return;
    for (const spec of s.specs ?? []) {
      for (const test of (spec as { tests?: unknown[] }).tests ?? []) {
        for (const raw of (test as { results?: unknown[] }).results ?? []) {
          const result = raw as {
            status?: string;
            errors?: Array<{ location?: { line?: number } }>;
            attachments?: Array<{ name?: string; path?: string }>;
          };
          const attachments = result.attachments ?? [];
          const fromPath = attachments
            .map((a) => /-repeat(\d+)(?:[\\/]|$)/.exec(dirname(a.path ?? "") + "/")?.[1])
            .find((m) => m !== undefined);
          const repeatIndex =
            fromPath !== undefined
              ? Number(fromPath)
              : attachments.some((a) => a.path)
                ? 0
                : position;
          position++;
          const video = attachments.find((a) => a.name === "video" && a.path)?.path ?? null;
          const line =
            (result.errors ?? [])
              .map((e) => e.location?.line)
              .find((n): n is number => typeof n === "number") ?? null;
          let kind: AuthoredRunKind;
          if (result.status === "passed") kind = "passed";
          else if (line !== null && line === checkLine) kind = "failed-at-check";
          else if (line === null) kind = "did-not-start";
          else kind = "stopped-early";
          out.push({
            repeatIndex,
            kind,
            line: result.status === "passed" ? null : line,
            videoPath: video,
          });
        }
      }
    }
    for (const child of s.suites ?? []) walk(child);
  };
  for (const suite of (report as { suites?: unknown[] } | null)?.suites ?? []) walk(suite);
  return out.sort((a, b) => a.repeatIndex - b.repeatIndex);
}

/** The plane's inputs for a run's classification, so the existing outcome rules decide. */
export function outcomeInputsFor(run: AuthoredRunResult): {
  assertionOutcomes: AssertionOutcome[];
  automationFailure: { reason: string } | null;
  infrastructureFailure: { reason: string } | null;
} {
  const check = (result: "pass" | "fail"): AssertionOutcome[] => [
    {
      assertionId: "final-check",
      actionId: null,
      result,
      isFailurePredicate: false,
      detail: run.line !== null ? `line ${run.line}` : null,
    },
  ];
  switch (run.kind) {
    case "passed":
      return {
        assertionOutcomes: check("pass"),
        automationFailure: null,
        infrastructureFailure: null,
      };
    case "failed-at-check":
      return {
        assertionOutcomes: check("fail"),
        automationFailure: null,
        infrastructureFailure: null,
      };
    case "stopped-early":
      return {
        assertionOutcomes: [],
        automationFailure: { reason: `stopped at line ${run.line} before the final check` },
        infrastructureFailure: null,
      };
    case "did-not-start":
      return {
        assertionOutcomes: [],
        automationFailure: null,
        infrastructureFailure: { reason: "the run failed before reaching any step of the script" },
      };
  }
}

// --------------------------------------------------------------------------------- ingestion

export interface IngestedRun {
  runId: string;
  repeatIndex: number;
  kind: AuthoredRunKind;
  line: number | null;
  outcome: PlaneResult["outcome"]["outcome"];
  outcomeRuleId: number;
  captured: boolean;
  rawLogArtifactId: string | null;
  normalizedArtifactId: string;
  videoArtifactId: string | null;
  /** In a confirmation batch: the arm this run was, and whether the variant's factor took. */
  arm?: ArmRecord;
}

export interface IngestedBatch {
  batchId: string;
  runs: IngestedRun[];
  batchArtifactId: string;
  evidenceQualityArtifactId: string;
}

export function authoredRunId(batchSeq: number, repeatIndex: number): string {
  return `ARUN-${String(batchSeq).padStart(3, "0")}-${String(repeatIndex + 1).padStart(3, "0")}`;
}

/**
 * Store one batch: per run, the redacted raw log the fixture wrote, the plane's normalized
 * evidence, and the recording; then the batch record and its evidence-quality summary. The raw
 * logs were redacted when collected, and the plane redacts again as it normalizes (ADR-0008).
 */
export async function ingestRerunBatch(opts: {
  investigationId: string;
  runs: AuthoredRunResult[];
  stagingDir: string | null;
  suiteChecksum: string;
  captureSupported: boolean;
  captureReason?: string;
  /** Set for a confirmation batch: the frozen config it ran, and each repeat's arm. */
  confirmation?: {
    configArtifactId: string;
    configChecksum: string;
    schedule: ReadonlyArray<"variant" | "control">;
  };
  /** Operator credential values. Masked in everything stored, whatever the collector did. */
  credentialValues: readonly string[];
  redactor: Redactor;
  artifacts: LocalArtifactStore;
  metadata: SqliteMetadataStore;
  now: () => string;
}): Promise<IngestedBatch> {
  const batchSeq = await opts.metadata.tx((t) =>
    t.nextSequence(opts.investigationId, "rerun-batch")
  );
  const batchId = `BATCH-${String(batchSeq).padStart(3, "0")}`;
  // The normalized evidence is redacted by the plane; registering the values first means the
  // plane masks them by identity, exactly as `investigate run` does.
  if (opts.credentialValues.length) opts.redactor.maskValues(opts.credentialValues);
  const stamp = opts.redactor.stamp();
  const replacement = opts.redactor.policy.defaults.valueReplacement;

  const ingested: IngestedRun[] = [];
  const planes: Array<{ runId: string; plane: PlaneResult }> = [];
  for (const run of opts.runs) {
    const runId = authoredRunId(batchSeq, run.repeatIndex);
    const logPath = opts.stagingDir
      ? join(opts.stagingDir, suiteCaptureLogName(run.repeatIndex))
      : null;
    const captured = logPath !== null && existsSync(logPath);
    // The fixture masked credential values as it collected. This is the backstop that makes
    // "no credential value is ever stored" hold even if it did not: the value as written, and as
    // it appears inside a JSON string.
    const rawLogText = captured
      ? maskLiterals(readFileSync(logPath, "utf8"), opts.credentialValues, replacement)
      : "";

    let rawLogArtifactId: string | null = null;
    if (captured) {
      const ref = await opts.artifacts.put({
        investigationId: opts.investigationId,
        runId,
        kind: "raw-event-log",
        filename: `${runId}-raw.jsonl`,
        bytes: rawLogText,
        contentType: "application/x-ndjson",
        redactionApplied: stamp,
      });
      rawLogArtifactId = ref.artifactId;
    }

    let videoArtifactId: string | null = null;
    const videoNotes: NonNullable<Parameters<typeof runPlane>[0]["collectorNotes"]> = [];
    if (run.videoPath && existsSync(run.videoPath)) {
      const ref = await opts.artifacts.put({
        investigationId: opts.investigationId,
        runId,
        kind: "video",
        filename: `${runId}.webm`,
        bytes: readFileSync(run.videoPath),
        contentType: "video/webm",
        redactionApplied: {
          ...stamp,
          appliedRules: [{ ruleId: VIDEO_UNREDACTABLE_RULE, occurrences: 1 }],
        },
      });
      videoArtifactId = ref.artifactId;
      videoNotes.push({ category: "video", code: "PERSISTED_UNREDACTED", count: 1 });
    } else {
      videoNotes.push({ category: "video", code: "NO_RECORDING_PRODUCED" });
    }

    const unsupported: typeof videoNotes = captured
      ? []
      : (
          [
            "actions",
            "navigation",
            "console",
            "exceptions",
            "networkMetadata",
            "storage",
          ] as EvidenceCategory[]
        ).map((category) => ({ category, code: "COLLECTOR_UNSUPPORTED" as const }));

    const plane = runPlane({
      runId,
      rawLogText,
      redactor: opts.redactor,
      collectorVersion: COLLECTOR_VERSION,
      requiredCategories: AUTHORED_REQUIRED_EVIDENCE,
      ...outcomeInputsFor(run),
      collectorNotes: [...videoNotes, ...unsupported],
      interrupted: false,
    });
    planes.push({ runId, plane });

    const normalized = await opts.artifacts.put({
      investigationId: opts.investigationId,
      runId,
      kind: "normalized-evidence",
      filename: `${runId}-normalized.json`,
      bytes: plane.normalizedJson,
      contentType: "application/json",
      redactionApplied: stamp,
    });

    let arm: ArmRecord | undefined;
    const armPath = opts.stagingDir
      ? join(opts.stagingDir, suiteCaptureArmName(run.repeatIndex))
      : null;
    if (armPath && existsSync(armPath)) {
      try {
        arm = JSON.parse(readFileSync(armPath, "utf8")) as ArmRecord;
      } catch {
        arm = undefined;
      }
    }
    // A repeat whose browser never started wrote no arm record; the schedule still says which arm
    // it was, so the batch lists every run, and the factor is recorded as not applied.
    const scheduled = opts.confirmation?.schedule[run.repeatIndex];
    if (!arm && scheduled) {
      arm = { arm: scheduled, factorApplied: false, error: "no arm record: the run did not start" };
    }

    ingested.push({
      ...(arm ? { arm } : {}),
      runId,
      repeatIndex: run.repeatIndex,
      kind: run.kind,
      line: run.line,
      outcome: plane.outcome.outcome,
      outcomeRuleId: plane.outcome.ruleId,
      captured,
      rawLogArtifactId,
      normalizedArtifactId: normalized.artifactId,
      videoArtifactId,
    });
  }

  const quality = buildEvidenceQuality(
    batchId,
    planes.map((p) => ({ runId: p.runId, captureStatus: p.plane.captureStatus }))
  );
  const qualityRef = await opts.artifacts.put({
    investigationId: opts.investigationId,
    kind: "evidence-quality",
    filename: `${batchId}-evidence-quality.json`,
    bytes: `${JSON.stringify(quality, null, 2)}\n`,
    contentType: "application/json",
    redactionApplied: stamp,
  });

  const batch = {
    schemaVersion: "1.0.0",
    batchId,
    investigationId: opts.investigationId,
    recordedAt: opts.now(),
    suiteChecksum: opts.suiteChecksum,
    capture: opts.captureSupported
      ? { supported: true }
      : { supported: false, reason: opts.captureReason ?? "unknown" },
    evidenceQualityArtifactId: qualityRef.artifactId,
    ...(opts.confirmation
      ? {
          confirmation: {
            configArtifactId: opts.confirmation.configArtifactId,
            configChecksum: opts.confirmation.configChecksum,
          },
        }
      : {}),
    runs: ingested,
  };
  const batchRef = await opts.artifacts.put({
    investigationId: opts.investigationId,
    kind: "rerun-batch",
    filename: `${batchId}.json`,
    bytes: `${JSON.stringify(batch, null, 2)}\n`,
    contentType: "application/json",
    redactionApplied: stamp,
  });

  return {
    batchId,
    runs: ingested,
    batchArtifactId: batchRef.artifactId,
    evidenceQualityArtifactId: qualityRef.artifactId,
  };
}

export function maskLiterals(text: string, values: readonly string[], replacement: string): string {
  let out = text;
  const forms = values
    .filter((v) => v.length > 0)
    .flatMap((v) => [v, JSON.stringify(v).slice(1, -1)])
    .sort((a, b) => b.length - a.length);
  for (const form of forms) if (out.includes(form)) out = out.split(form).join(replacement);
  return out;
}

/** A checksum of the suite as run: its spec files and config, in a fixed order. */
export function suiteChecksum(suiteDir: string): string {
  const parts: string[] = [];
  const add = (path: string): void => {
    if (existsSync(path)) {
      parts.push(`${relative(suiteDir, path).replace(/\\/g, "/")}\n${readFileSync(path, "utf8")}`);
    }
  };
  add(join(suiteDir, "playwright.config.ts"));
  const testsDir = join(suiteDir, "tests");
  if (existsSync(testsDir)) for (const f of readdirSync(testsDir).sort()) add(join(testsDir, f));
  return sha256Prefixed(parts.join("\n\0\n"));
}
