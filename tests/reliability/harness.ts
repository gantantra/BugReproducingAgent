import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SystemClock,
  loadConfigFromString,
  type ResolvedConfig,
  investigationId as makeInvestigationId,
  systemClock,
} from "@investigator/core";
import {
  LocalArtifactStore,
  SqliteMetadataStore,
  SqliteWorkQueue,
  ensureInvestigationDirs,
  initWorkspace,
  type Workspace,
} from "@investigator/storage";
import { Redactor } from "@investigator/evidence";
import { Worker, enqueueExperiment, type ExperimentSpec, type RunResult } from "@investigator/execution";
import { startFixture, type FixtureHandle, type FixtureKind } from "@investigator/test-fixtures";

/**
 * Shared harness for the M1 reliability gate.
 *
 * Anti-flake requirements (docs/architecture/reliability-strategy.md):
 *  - every test gets its own temp workspace and never touches the repository .investigator
 *  - fixtures bind 127.0.0.1:0 and the harness passes the resolved port, so no port collisions
 *  - no wall-clock sleeps in assertions
 *  - DEEPSEEK_API_KEY is set to a dummy value so the gate proves the execution path never uses
 *    it and never leaks it
 */

export const DUMMY_API_KEY = "sk-dummy-DO-NOT-LEAK-4f3a91c7e2b85d06";

export interface Harness {
  workspace: Workspace;
  config: ResolvedConfig;
  metadata: SqliteMetadataStore;
  artifacts: LocalArtifactStore;
  queue: SqliteWorkQueue;
  redactor: Redactor;
  investigationId: string;
  fixtures: FixtureHandle[];
  dir: string;
  cleanup: () => Promise<void>;
}

function policyPath(): string {
  return join(process.cwd(), "policies", "default.yaml");
}

let investigationOrdinal = 0;
function nextInvestigationOrdinal(): number {
  return ++investigationOrdinal;
}

export interface HarnessOptions {
  fixtures: FixtureKind[];
  /** Extra config YAML fragments merged textually under execution/safety. */
  video?: "off" | "on" | "on-failure";
  tracePolicy?: "withhold" | "raw-opt-in";
  responseBodyMaxBytes?: number;
  leaseMs?: number;
  heartbeatMs?: number;
  seed?: number;
  screenshotOn?: Array<"action" | "navigation" | "failure">;
  domSnapshotOn?: Array<"action" | "navigation" | "failure">;
}

export async function createHarness(opts: HarnessOptions): Promise<Harness> {
  process.env["DEEPSEEK_API_KEY"] = DUMMY_API_KEY;
  process.env["DEEPSEEK_BASE_URL"] = "https://api.example.invalid/v1";
  process.env["DEEPSEEK_FAST_MODEL"] = "fixture-fast";
  process.env["DEEPSEEK_REASONING_MODEL"] = "fixture-reasoning";
  process.env["DEEPSEEK_FALLBACK_MODEL"] = "fixture-fallback";

  const dir = mkdtempSync(join(tmpdir(), "investigator-gate-"));
  const { workspace } = initWorkspace(join(dir, ".investigator"));

  const fixtures: FixtureHandle[] = [];
  for (const kind of opts.fixtures) fixtures.push(await startFixture(kind));

  const targets = fixtures
    .map(
      (f) => `    ${f.kind}:
      baseUrl: ${f.origin}
      classification: fixture
      resetStrategy: fresh-context`
    )
    .join("\n");
  const origins = fixtures.map((f) => `    - ${f.origin}`).join("\n");

  const yaml = `
llm:
  provider: deepseek
  baseUrl: env:DEEPSEEK_BASE_URL
  apiKeyEnv: DEEPSEEK_API_KEY
  aliases:
    FAST_MODEL: { modelId: env:DEEPSEEK_FAST_MODEL, inferenceMode: non-thinking }
    REASONING_MODEL: { modelId: env:DEEPSEEK_REASONING_MODEL, inferenceMode: thinking }
    FALLBACK_MODEL: { modelId: env:DEEPSEEK_FALLBACK_MODEL, inferenceMode: non-thinking }
  budgets:
    perInvestigationUsd: 5
    perCallTokens: 32000
storage:
  metadata: sqlite
  artifacts: local
  queue: local
  redactionPolicy: policies/default.yaml
execution:
  browser: chromium
  workers: 1
  maxParallelRuns: 1
  defaultTimeoutMs: 15000
  runWallClockBudgetMs: 60000
  leaseMs: ${opts.leaseMs ?? 60000}
  heartbeatMs: ${opts.heartbeatMs ?? 5000}
  seed: ${opts.seed ?? 1}
  video: ${opts.video ?? "off"}
  trace: off
  capture:
    responseBodyMaxBytes: ${opts.responseBodyMaxBytes ?? 262144}
    tracePolicy: ${opts.tracePolicy ?? "withhold"}
    screenshotOn: [${(opts.screenshotOn ?? ["failure"]).join(", ")}]
    domSnapshotOn: [${(opts.domSnapshotOn ?? ["action", "failure"]).join(", ")}]
  targets:
${targets || "    {}"}
approvals:
  required: [experiment_selection, target_failure, final_reproduction]
safety:
  allowedOrigins:
${origins || "    []"}
  productionGuard: true
  blockDestructiveActions: true
logging:
  level: error
`;

  writeFileSync(workspace.configPath, yaml, "utf8");
  mkdirSync(workspace.policiesDir, { recursive: true });
  writeFileSync(join(workspace.policiesDir, "default.yaml"), readFileSync(policyPath(), "utf8"));

  const config = loadConfigFromString(yaml, {});
  const metadata = new SqliteMetadataStore({ path: workspace.dbPath });
  await metadata.migrate();

  const artifacts = new LocalArtifactStore({
    root: workspace.investigationsDir,
    metadata,
    clock: new SystemClock(),
  });
  const queue = new SqliteWorkQueue({ store: metadata, clock: systemClock });
  const redactor = Redactor.fromFile(policyPath());

  // Unique per harness. The reliability project runs every spec file in ONE process, and
  // several files reuse experiment ids, so a constant investigation id couples them.
  const investigationId = makeInvestigationId(nextInvestigationOrdinal());
  ensureInvestigationDirs(workspace, investigationId);
  await metadata.tx((t) =>
    t.insertInvestigation({
      investigationId,
      title: "reliability gate",
      targetName: fixtures[0]?.kind ?? null,
      createdAt: systemClock.nowIso(),
      status: "open",
    })
  );

  return {
    workspace,
    config,
    metadata,
    artifacts,
    queue,
    redactor,
    investigationId,
    fixtures,
    dir,
    cleanup: async () => {
      await metadata.close();
      for (const f of fixtures) await f.close();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows sometimes holds the db file briefly; the temp dir is disposable. */
      }
    },
  };
}

export function fixtureOf(h: Harness, kind: FixtureKind): FixtureHandle {
  const f = h.fixtures.find((x) => x.kind === kind);
  if (!f) throw new Error(`fixture ${kind} not started in this harness`);
  return f;
}

export function makeWorker(h: Harness, overrides: Partial<ResolvedConfig> = {}): Worker {
  return new Worker({
    config: { ...h.config, ...overrides },
    metadata: h.metadata,
    artifacts: h.artifacts,
    queue: h.queue,
    redactor: h.redactor,
    clock: systemClock,
    workerId: `gate:${process.pid}:${Math.floor(Math.random() * 1e6).toString(16)}`,
    loadExperiment: (payloadJson) => JSON.parse(payloadJson) as ExperimentSpec,
  });
}

/**
 * Run an experiment and return ONE result per requested repetition.
 *
 * `Worker.drain` correctly returns one entry per ATTEMPT, because a bounded infrastructure
 * retry is a real new attempt (ADR-0005). Tests almost always mean "the runs" as "the surviving
 * observation per repetition", so collapse here rather than teaching every spec to tolerate
 * retries — which would have quietly weakened assertions that should stay exact.
 *
 * Use `runExperimentAllAttempts` where the attempt history itself is the subject.
 */
export async function runExperiment(
  h: Harness,
  experiment: unknown,
  repetitions: number
): Promise<RunResult[]> {
  const all = await runExperimentAllAttempts(h, experiment, repetitions);

  // Last non-interrupted attempt per repetition, matching the frozen counting rule.
  const byRepetition = new Map<number, RunResult>();
  for (const r of all) {
    if (r.outcome === "INTERRUPTED") continue;
    const rep = r.manifest.repetitionIndex ?? 0;
    const current = byRepetition.get(rep);
    if (!current || (r.manifest.attemptIndex ?? 0) >= (current.manifest.attemptIndex ?? 0)) {
      byRepetition.set(rep, r);
    }
  }
  return [...byRepetition.entries()].sort(([a], [b]) => a - b).map(([, r]) => r);
}

export async function runExperimentAllAttempts(
  h: Harness,
  experiment: unknown,
  repetitions: number
): Promise<RunResult[]> {
  const spec = experiment as ExperimentSpec;
  spec.investigationId = h.investigationId;
  await enqueueExperiment({
    config: h.config,
    metadata: h.metadata,
    queue: h.queue,
    investigationId: h.investigationId,
    experiment: spec,
    repetitions,
    approvalId: null,
    effectiveProposalChecksum: null,
  });
  return makeWorker(h).drain(repetitions);
}

/** Read every sealed manifest for the investigation, straight from the artifact store. */
export async function readManifests(h: Harness): Promise<Array<Record<string, unknown>>> {
  const refs = await h.artifacts.list(h.investigationId, { kind: "run-manifest" });
  const out: Array<Record<string, unknown>> = [];
  for (const ref of refs) {
    out.push(JSON.parse(await h.artifacts.getText(ref)) as Record<string, unknown>);
  }
  return out;
}

export async function readNormalized(h: Harness, runId: string): Promise<string | null> {
  const refs = await h.artifacts.list(h.investigationId, { kind: "normalized-evidence", runId });
  const ref = refs[0];
  return ref ? h.artifacts.getText(ref) : null;
}

export async function readRawLog(h: Harness, runId: string): Promise<string | null> {
  const refs = await h.artifacts.list(h.investigationId, { kind: "raw-event-log", runId });
  const ref = refs[0];
  return ref ? h.artifacts.getText(ref) : null;
}
