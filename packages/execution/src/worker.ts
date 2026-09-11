import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ArtifactRef,
  Clock,
  ConfigSourceEntry,
  JobTerminalReason,
  ResolvedConfig,
  ResolvedEmulation,
  RunOutcome,
} from "@investigator/core";
import {
  COLLECTOR_VERSION,
  EVIDENCE_CATEGORIES,
  InvestigatorError,
  SeededRng,
  deriveSeed,
  isInvestigatorError,
  runId as makeRunId,
  systemClock,
} from "@investigator/core";
import type { ArtifactStore, MetadataStore, WorkQueue } from "@investigator/storage";
import {
  CaptureStatusBuilder,
  type Redactor,
  runPlane,
  serializeRawLog,
} from "@investigator/evidence";
import { Collector } from "./collector.js";
import { ActionInterpreter } from "./action-interpreter.js";
import { ManifestWriter, type RunManifest } from "./manifest.js";
import { classifyExperiment } from "./destructive-classifier.js";
import type { ExperimentSpec } from "./types.js";
import { resolveEmulation } from "./emulation.js";
import { deriveJobId } from "./enqueue.js";

/**
 * One local Playwright worker with bounded concurrency (ADR-0001, ADR-0006).
 *
 * Durable write order per run, which is what makes a crash classifiable without guessing:
 *   1. jobs row -> RUNNING
 *   2. manifest OPENED (immutable header)
 *   3. artifact bytes written and hashed, refs inserted incrementally
 *   4. redacted normalized evidence written
 *   5. manifest SEALED (outcome, rule id, captureStatus, artifact digest list, seal hash)
 *   6. jobs row -> TERMINAL
 *
 * This file imports no AI code and never will (ADR-0006).
 */

export interface WorkerDeps {
  config: ResolvedConfig;
  metadata: MetadataStore;
  artifacts: ArtifactStore;
  queue: WorkQueue;
  redactor: Redactor;
  clock?: Clock;
  workerId: string;
  /** Resolves the approved experiment a job refers to. */
  loadExperiment: (payloadJson: string) => ExperimentSpec;
  resolveSecret?: (envVar: string) => string | undefined;
  resolveUnknown?: (unknownId: string) => string | undefined;
  onRunComplete?: (manifest: RunManifest) => void | Promise<void>;
}

export interface RunResult {
  runId: string;
  jobId: string;
  terminalReason: JobTerminalReason;
  outcome: RunOutcome;
  outcomeRuleId: number;
  manifest: RunManifest;
  durationMs: number;
}

/**
 * First meaningful line of a browser launch error, capped.
 *
 * Playwright launch errors are multi-line and can embed a local profile path; the first line
 * carries the classification (timeout, spawn EPERM, target closed) which is what a diagnosis
 * needs. Local filesystem paths are not secrets, but the value is capped and single-lined so it
 * cannot smuggle an arbitrary payload into a persisted manifest field.
 */
function launchErrorSummary(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const firstMeaningful =
    raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith("at ")) ?? "unknown";
  return firstMeaningful.slice(0, 200);
}

export class Worker {
  private readonly clock: Clock;
  private stopped = false;
  /** Shared across every run in the batch. See ADR-0025. */
  private browser: Browser | null = null;

  constructor(private readonly deps: WorkerDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  stop(): void {
    this.stopped = true;
  }

  /**
   * The batch's browser, launched on first use and reused afterwards (ADR-0025).
   *
   * The bounded retry here is a PRE-RUN launch retry and is deliberately not a run attempt. No
   * job has started, no evidence has been collected, and no product behaviour has been observed,
   * so there is nothing it can hide: it does not create a job row, does not increment
   * `attemptIndex`, and does not appear in any statistic. Contrast the run-level infrastructure
   * retry in `drain`, which is a new linked attempt precisely because a run did happen.
   *
   * Measured justification: `chromium.launch()` fails on this platform roughly 4 times per 100
   * sequential launches with "Target page, context or browser has been closed", reproducible with
   * no ReproAgent code in the picture. Reusing one browser cuts a 100-run batch from 100 launches
   * to 1; the retry covers the residual chance that the single launch is the one that fails. If
   * every attempt fails, EXEC_BROWSER_LAUNCH_FAILED still surfaces and the run is still
   * INFRASTRUCTURE_FAILED, so a genuinely broken environment fails loudly.
   */
  private async getBrowser(jobId: string): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    // A disconnected browser (crash, external kill) is replaced rather than reused.
    this.browser = null;

    const attempts = 3;
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        this.browser = await chromium.launch({
          headless: true,
          ...(this.deps.config.execution.channel
            ? { channel: this.deps.config.execution.channel }
            : {}),
          args: ["--disable-dev-shm-usage"],
        });
        return this.browser;
      } catch (e) {
        last = e;
      }
    }
    throw new InvestigatorError(
      "EXEC_BROWSER_LAUNCH_FAILED",
      `Chromium failed to launch after ${attempts} attempts: ${launchErrorSummary(last)}`,
      { context: { jobId, launchAttempts: attempts }, cause: last }
    );
  }

  /** Release the batch's browser. Safe to call more than once. */
  private async closeBrowser(): Promise<void> {
    const b = this.browser;
    this.browser = null;
    try {
      await b?.close();
    } catch {
      /* already gone */
    }
  }

  /**
   * Claim and run until the queue is empty or `max` runs have completed.
   *
   * Infrastructure failures are retried as NEW job rows linked to their predecessor (ADR-0005),
   * bounded by `maxInfraRetriesPerRepetition`. Three things this deliberately does NOT do:
   *
   *  - retry PRODUCT_FAILED or VALID_COMPLETED: those are observations, not accidents
   *  - retry AUTOMATION_FAILED: the approved sequence is wrong, which is a human decision
   *  - retry INTERRUPTED: reaping never auto-requeues (ADR-0003); that decision is recorded
   *
   * `max` counts REPETITIONS, not attempts, so a retried repetition does not consume another
   * caller-requested run.
   */
  async drain(max = Number.MAX_SAFE_INTEGER): Promise<RunResult[]> {
    const results: RunResult[] = [];
    const maxRetries = this.deps.config.execution.maxInfraRetriesPerRepetition;
    // Reap before the first claim so a previous crash is classified before new work starts.
    await this.deps.queue.reapStale(this.clock.nowMs());

    try {
      let repetitionsCompleted = 0;
      while (!this.stopped && repetitionsCompleted < max) {
        const job = await this.deps.queue.claim(
          this.deps.workerId,
          this.deps.config.execution.leaseMs
        );
        if (!job) break;

        const result = await this.runClaimedJob(job.jobId, job.payloadJson, job);
        results.push(result);

        if (result.outcome === "INFRASTRUCTURE_FAILED" && job.attemptIndex < maxRetries) {
          // A new row with an incremented attempt index, never a mutation of history. The failed
          // attempt stays visible, so the statistics can report it.
          await this.enqueueRetry(job, result);
          continue; // this repetition has not yet produced a valid observation
        }
        repetitionsCompleted++;
      }
      return results;
    } finally {
      // The batch owns the browser (ADR-0025), so it is released here rather than per run --
      // including when the batch throws or is stopped mid-way.
      await this.closeBrowser();
    }
  }

  private async enqueueRetry(
    job: {
      investigationId: string;
      experimentId: string;
      repetitionIndex: number;
      attemptIndex: number;
      approvalId: string | null;
      effectiveProposalChecksum: string | null;
      payloadJson: string;
      jobId: string;
    },
    failed: RunResult
  ): Promise<void> {
    // Derive the next attempt from what the store actually holds, not from the claimed row.
    // The claimed row only knows its own attempt index; with multiple claimants another worker
    // may already have scheduled this retry, and the UNIQUE constraint would reject a blind
    // increment as an error rather than as the benign race it is.
    const existing = (await this.deps.queue.listJobs(job.investigationId)).filter(
      (j) => j.experimentId === job.experimentId && j.repetitionIndex === job.repetitionIndex
    );
    const highestAttempt = existing.reduce((max, j) => Math.max(max, j.attemptIndex), -1);
    const nextAttempt = highestAttempt + 1;

    // Someone already queued or ran a later attempt for this repetition: nothing to do.
    if (existing.some((j) => j.attemptIndex >= nextAttempt)) return;
    if (nextAttempt > this.deps.config.execution.maxInfraRetriesPerRepetition) return;

    const seq = await this.deps.metadata.tx((t) => t.nextSequence(job.investigationId, "job"));
    try {
      await this.deps.queue.enqueue({
        // `seq ^ job.repetitionIndex` is not injective -- (seq 4, rep 0) and (seq 5, rep 1) both
        // seed 4 -- so two unrelated retries could draw the same id and collide on job_id.
        // Derive from the work instead, exactly as the initial enqueue does.
        jobId: deriveJobId(
          this.deps.config.execution.seed,
          job.investigationId,
          job.experimentId,
          job.repetitionIndex,
          nextAttempt
        ),
        investigationId: job.investigationId,
        experimentId: job.experimentId,
        repetitionIndex: job.repetitionIndex,
        attemptIndex: nextAttempt,
        previousAttemptJobId: failed.jobId,
        seq,
        approvalId: job.approvalId,
        effectiveProposalChecksum: job.effectiveProposalChecksum,
        payloadJson: job.payloadJson,
      });
    } catch (e) {
      // Only a duplicate WORK TUPLE is the benign race the multi-claimant interface (ADR-0001)
      // anticipates: another claimant already scheduled this retry. The jobs table also enforces
      // job_id, and swallowing that as benign would silently drop a retry and hide an id
      // collision -- so it must propagate.
      const constraint = isInvestigatorError(e) ? String(e.context?.["constraint"] ?? "") : "";
      const duplicateWork =
        isInvestigatorError(e) && e.code === "INPUT_INVALID" && !/job_id/.test(constraint);
      if (duplicateWork) return;
      throw e;
    }
  }

  private async runClaimedJob(
    jobId: string,
    payloadJson: string,
    job: {
      investigationId: string;
      experimentId: string;
      repetitionIndex: number;
      attemptIndex: number;
      previousAttemptJobId?: string | null;
      approvalId: string | null;
      effectiveProposalChecksum: string | null;
    }
  ): Promise<RunResult> {
    const cfg = this.deps.config;
    const startedAt = this.clock.nowIso();
    const startMono = this.clock.monotonicMs();

    const runSeq = await this.deps.metadata.tx((t) => t.nextSequence(job.investigationId, "run"));
    const runId = makeRunId(runSeq);
    await this.deps.queue.markRunning(jobId, this.deps.workerId, runId);

    const experiment = this.deps.loadExperiment(payloadJson);
    const target = cfg.execution.targets[experiment.targetName];
    if (!target) {
      return this.finishWithoutBrowser(
        jobId,
        runId,
        job,
        startedAt,
        "WORKER_ERROR",
        "INFRASTRUCTURE_FAILED",
        2,
        `Target ${experiment.targetName} is not configured`
      );
    }

    const seed = deriveSeed(
      cfg.execution.seed,
      job.experimentId,
      job.repetitionIndex,
      job.attemptIndex
    );
    const rng = new SeededRng(seed);

    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let page: Page | undefined;
    let videoDir: string | undefined;
    let detach: (() => void) | undefined;

    const artifacts: ArtifactRef[] = [];
    const warnings: string[] = [];
    let infrastructureFailure: { reason: string } | null = null;
    let automationFailure: { reason: string; actionId?: string } | null = null;

    const collector = new Collector({
      clock: this.clock,
      redactor: this.deps.redactor,
      runStartWallMs: new Date(startedAt).getTime(),
      runStartMonoMs: startMono,
      capture: {
        responseBodyMaxBytes: cfg.execution.capture.responseBodyMaxBytes,
        responseBodyContentTypes: cfg.execution.capture.responseBodyContentTypes,
        webSocketFrames: cfg.execution.capture.webSocketFrames,
        // Bodies are opt-in; the policy still decides per body (ADR-0008).
        captureBodies: cfg.execution.capture.responseBodyMaxBytes > 0,
      },
    });

    let emulation: ResolvedEmulation | undefined;
    let manifestWriter: ManifestWriter | undefined;
    let interpreterResult: Awaited<ReturnType<ActionInterpreter["run"]>> | undefined;

    try {
      // One browser per worker, a fresh CONTEXT per run (ADR-0025). The context is the isolation
      // boundary the configured `resetStrategy: fresh-context` names; launching a whole browser
      // per run bought no extra isolation and cost 4 spurious INFRASTRUCTURE_FAILED per 100 runs.
      browser = await this.getBrowser(jobId);

      const profileName = experiment.emulationProfile ?? cfg.execution.emulation.defaultProfile;
      const profile = cfg.execution.emulation.profiles[profileName];
      if (!profile) {
        throw new InvestigatorError("CONFIG_INVALID", "Emulation profile is not defined", {
          context: { profileName },
        });
      }

      context = await browser.newContext({
        viewport: profile.viewport,
        deviceScaleFactor: profile.deviceScaleFactor,
        isMobile: profile.isMobile,
        hasTouch: profile.hasTouch,
        locale: profile.locale,
        timezoneId: profile.timezoneId,
        colorScheme: profile.colorScheme,
        ...(profile.reducedMotion ? { reducedMotion: profile.reducedMotion } : {}),
        ...(profile.forcedColors ? { forcedColors: profile.forcedColors } : {}),
        ...(profile.userAgent ? { userAgent: profile.userAgent } : {}),
        // The scratch directory is created ONLY when video is on. Creating and deleting a temp
        // directory on every run cost real I/O and, on Windows, raced with the exiting browser
        // for no benefit: nothing else used it once the browser stopped being launched per run.
        ...(cfg.execution.video === "on"
          ? {
              recordVideo: {
                dir: join((videoDir ??= mkdtempSync(join(tmpdir(), "reproagent-video-"))), "video"),
              },
            }
          : {}),
      });

      page = await context.newPage();
      detach = collector.attach(context, page);

      // Resolved emulation is READ BACK from the live context, not copied from the profile
      // definition, and any requested-versus-observed mismatch is recorded (ADR-0014).
      emulation = await resolveEmulation({
        page,
        browser,
        profileName,
        profile,
        headless: true,
        channel: cfg.execution.channel,
        launchArgs: ["--disable-dev-shm-usage"],
      });

      manifestWriter = new ManifestWriter({
        runId,
        jobId,
        investigationId: job.investigationId,
        experimentId: job.experimentId,
        approvalId: job.approvalId,
        effectiveProposalChecksum: job.effectiveProposalChecksum,
        repetitionIndex: job.repetitionIndex,
        attemptIndex: job.attemptIndex,
        previousAttemptJobId: job.previousAttemptJobId ?? null,
        seed,
        emulation,
        versions: {
          collectorVersion: COLLECTOR_VERSION,
          normalizerVersion: "0.1.0",
          extractorVersion: "0.1.0",
        },
        target: {
          name: experiment.targetName,
          baseUrl: target.baseUrl,
          classification: target.classification,
          resetStrategy: target.resetStrategy,
          allowedOrigins: cfg.safety.allowedOrigins,
        },
        configSources: cfg.sources as Record<string, ConfigSourceEntry>,
        clock: this.clock,
      });
      manifestWriter.markStarted(this.clock);

      // Safety: the destructive classifier is authoritative, and it is re-checked here even
      // though enqueue already checked, because the enqueue-time check used the proposal and
      // this one uses what is actually about to run.
      const classification = classifyExperiment(experiment, {
        extraDestructivePatterns: cfg.safety.destructivePatterns,
      });
      if (classification.destructiveActionIds.length && target.classification !== "fixture") {
        throw new InvestigatorError(
          "EXEC_DESTRUCTIVE_BLOCKED",
          "Destructive actions reached the executor without an acknowledged approval",
          { context: { jobId, actions: classification.destructiveActionIds.join(",") } }
        );
      }

      const interpreter = new ActionInterpreter({
        page,
        collector,
        redactor: this.deps.redactor,
        rng,
        defaultTimeoutMs: cfg.execution.defaultTimeoutMs,
        allowedOrigins: cfg.safety.allowedOrigins,
        baseUrl: target.baseUrl,
        domSnapshotOn: cfg.execution.capture.domSnapshotOn,
        screenshotOn: cfg.execution.capture.screenshotOn,
        domSnapshotMaxBytes: cfg.execution.capture.domSnapshotMaxBytes,
        ...(this.deps.resolveSecret ? { resolveSecret: this.deps.resolveSecret } : {}),
        ...(this.deps.resolveUnknown ? { resolveUnknown: this.deps.resolveUnknown } : {}),
        onScreenshot: async (bytes, label) => {
          const ref = await this.deps.artifacts.put({
            investigationId: job.investigationId,
            runId,
            kind: "screenshot",
            filename: `${label}.png`,
            bytes,
            contentType: "image/png",
            redactionApplied: this.deps.redactor.stamp(),
          });
          artifacts.push(ref);
          return ref.artifactId;
        },
        onDomSnapshot: async (json, label) => {
          const ref = await this.deps.artifacts.put({
            investigationId: job.investigationId,
            runId,
            kind: "dom-snapshot",
            filename: `${label}.json`,
            bytes: json,
            contentType: "application/json",
            redactionApplied: this.deps.redactor.stamp(),
          });
          artifacts.push(ref);
          return ref.artifactId;
        },
      });

      interpreterResult = await interpreter.run(experiment.actions, experiment.assertions);
      automationFailure = interpreterResult.automationFailure;
    } catch (e) {
      const err = isInvestigatorError(e)
        ? e
        : new InvestigatorError("INTERNAL", String(e), { cause: e });
      // Boundary rule: harness, host, or environment failures are infrastructure; everything the
      // instructions did to the application is automation (ADR-0005 rules 2 and 3).
      if (
        err.code === "EXEC_BROWSER_LAUNCH_FAILED" ||
        err.code === "EXEC_TARGET_UNREACHABLE" ||
        err.code === "STORE_DISK_FULL" ||
        err.code === "CONFIG_INVALID" ||
        err.code === "INTERNAL"
      ) {
        infrastructureFailure = { reason: `${err.code}: ${err.message}`.slice(0, 300) };
      } else {
        automationFailure = { reason: `${err.code}: ${err.message}`.slice(0, 300) };
      }
    } finally {
      // Cleanup runs even on interruption. Buffers released, temp profile removed.
      try {
        detach?.();
      } catch {
        /* listener already gone */
      }
      try {
        await context?.close();
      } catch {
        /* context already closed */
      }
      // The browser is owned by the worker and closed in `drain`, not here: it is shared across
      // every run in the batch (ADR-0025).
      if (videoDir) {
        try {
          rmSync(videoDir, { recursive: true, force: true });
        } catch {
          /* best effort; the OS temp directory is disposable */
        }
      }
    }

    // --- Evidence: persist the raw log, then run the plane over it -----------------
    // Notes must be in the log BEFORE it is serialised, or a rebuild cannot see them.
    if (cfg.execution.capture.tracePolicy === "withhold") {
      // ADR-0022: collected for in-process use, deliberately not persisted.
      collector.note({ category: "trace", code: "POLICY_REDACTED" });
    }
    if (cfg.execution.video !== "on") {
      collector.note({ category: "video", code: "CONFIG_OFF" });
    }
    collector.flushNotesToLog();

    const rawLogText = serializeRawLog(collector.getEvents());

    const rawLogRef = await this.deps.artifacts.put({
      investigationId: job.investigationId,
      runId,
      kind: "raw-event-log",
      filename: `${runId}-raw.jsonl`,
      bytes: rawLogText,
      contentType: "application/x-ndjson",
      redactionApplied: this.deps.redactor.stamp(),
    });
    artifacts.push(rawLogRef);

    const plane = runPlane({
      runId,
      rawLogText,
      redactor: this.deps.redactor,
      collectorVersion: COLLECTOR_VERSION,
      requiredCategories: experiment.requiredEvidence,
      assertionOutcomes: interpreterResult?.assertionOutcomes ?? [],
      ...(interpreterResult ? { artifactIdsBySeq: interpreterResult.snapshotSeqToArtifact } : {}),
      collectorNotes: collector.finalizeNotes(),
      interrupted: false,
      infrastructureFailure,
      automationFailure,
      unsafeTrace: cfg.execution.capture.tracePolicy === "raw-opt-in",
    });

    const normalizedRef = await this.deps.artifacts.put({
      investigationId: job.investigationId,
      runId,
      kind: "normalized-evidence",
      filename: `${runId}-normalized.json`,
      bytes: plane.normalizedJson,
      contentType: "application/json",
      redactionApplied: this.deps.redactor.stamp(),
    });
    artifacts.push(normalizedRef);

    // --- Seal -----------------------------------------------------------------------
    const finishedAt = this.clock.nowIso();
    const durationMs = Math.max(0, this.clock.monotonicMs() - startMono);

    const terminalReason: JobTerminalReason =
      plane.outcome.outcome === "INFRASTRUCTURE_FAILED" ? "WORKER_ERROR" : "COMPLETED";

    if (!manifestWriter) {
      return this.finishWithoutBrowser(
        jobId,
        runId,
        job,
        startedAt,
        "WORKER_ERROR",
        "INFRASTRUCTURE_FAILED",
        2,
        infrastructureFailure?.reason ?? "worker failed before the manifest was opened"
      );
    }

    const manifest = manifestWriter.seal({
      terminalReason,
      outcome: plane.outcome.outcome,
      outcomeRuleId: plane.outcome.ruleId,
      outcomeDetail: plane.outcome.detail,
      assertionOutcomes: plane.features.assertionOutcomes,
      captureStatus: plane.captureStatus,
      artifacts,
      declaredFactors: interpreterResult?.declaredFactors ?? [],
      startedAt,
      finishedAt,
      durationMs,
      warnings,
      unsafeTrace: cfg.execution.capture.tracePolicy === "raw-opt-in",
      clock: this.clock,
    });

    const manifestRef = await this.deps.artifacts.put({
      investigationId: job.investigationId,
      runId,
      kind: "run-manifest",
      filename: `${runId}-manifest.json`,
      bytes: JSON.stringify(manifest, null, 2) + "\n",
      contentType: "application/json",
      redactionApplied: this.deps.redactor.stamp(),
    });

    await this.deps.metadata.tx(async (t) => {
      await t.insertRun({
        runId,
        jobId,
        investigationId: job.investigationId,
        experimentId: job.experimentId,
        repetitionIndex: job.repetitionIndex,
        attemptIndex: job.attemptIndex,
        seq: runSeq,
        seed,
        outcome: null,
        outcomeRuleId: null,
        manifestArtifactId: null,
        manifestSealHash: null,
        startedAt,
        finishedAt: null,
        durationMs: null,
      });
      await t.updateRunOnSeal(runId, {
        outcome: manifest.runOutcome ?? null,
        outcomeRuleId: manifest.outcomeRuleId ?? null,
        manifestArtifactId: manifestRef.artifactId,
        manifestSealHash: manifest.sealHash ?? null,
        finishedAt,
        durationMs,
      });
    });

    await this.deps.queue.finish(jobId, {
      reason: terminalReason,
      runOutcome: plane.outcome.outcome,
    });

    await this.deps.onRunComplete?.(manifest);

    return {
      runId,
      jobId,
      terminalReason,
      outcome: plane.outcome.outcome,
      outcomeRuleId: plane.outcome.ruleId,
      manifest,
      durationMs,
    };
  }

  /** Failure before the browser or manifest existed. Still produces a terminal, typed record. */
  private async finishWithoutBrowser(
    jobId: string,
    runId: string,
    job: {
      investigationId: string;
      experimentId: string;
      repetitionIndex: number;
      attemptIndex: number;
    },
    startedAt: string,
    reason: JobTerminalReason,
    outcome: RunOutcome,
    ruleId: number,
    detail: string
  ): Promise<RunResult> {
    const finishedAt = this.clock.nowIso();

    // Even a run that never reached the browser gets a sealed, PERSISTED manifest. The gate
    // requires one manifest per attempt, and "the run that could not start" is itself evidence
    // an investigator needs: silently having no record is worse than a record saying so.
    const builder = new CaptureStatusBuilder([]);
    for (const cat of EVIDENCE_CATEGORIES) {
      builder.reason(cat, "RUN_INTERRUPTED", { count: 1, detail });
    }
    const captureStatus = builder.seal({
      runId,
      versions: {
        collectorVersion: COLLECTOR_VERSION,
        normalizerVersion: "0.1.0",
        extractorVersion: "0.1.0",
      },
      redaction: this.deps.redactor.stamp(),
    });

    const writer = new ManifestWriter({
      runId,
      jobId,
      investigationId: job.investigationId,
      experimentId: job.experimentId,
      approvalId: null,
      effectiveProposalChecksum: null,
      repetitionIndex: job.repetitionIndex,
      attemptIndex: job.attemptIndex,
      previousAttemptJobId: null,
      seed: 0,
      // No browser was launched, so nothing can be read back. Recorded as unavailable rather
      // than fabricated (ADR-0014 forbids inventing emulation values).
      emulation: {
        profileName: "unavailable",
        profileSource: "run-did-not-start",
        resolved: {
          viewport: { width: 0, height: 0 },
          screen: { width: 0, height: 0 },
          deviceScaleFactor: 1,
          isMobile: false,
          hasTouch: false,
          userAgent: "",
          userAgentSource: "browser-default",
          locale: "",
          timezoneId: "",
          colorScheme: "no-preference",
        },
        browser: {
          engine: "chromium",
          playwrightVersion: "unavailable",
          browserVersion: "unavailable",
          headless: true,
        },
        discrepancies: [{ field: "browser", requested: "launched", observed: "never started" }],
      },
      versions: {
        collectorVersion: COLLECTOR_VERSION,
        normalizerVersion: "0.1.0",
        extractorVersion: "0.1.0",
      },
      target: { name: "unavailable", baseUrl: "about:blank", classification: "fixture" },
      configSources: {},
      clock: this.clock,
    });
    writer.markStarted(this.clock);

    const manifest = writer.seal({
      terminalReason: reason,
      outcome,
      outcomeRuleId: ruleId as 1 | 2 | 3 | 4 | 5 | 6,
      outcomeDetail: detail,
      assertionOutcomes: [],
      captureStatus,
      artifacts: [],
      declaredFactors: [],
      startedAt,
      finishedAt,
      durationMs: 0,
      warnings: ["Run did not start; no browser was launched and no evidence was collected."],
      clock: this.clock,
    });

    const manifestRef = await this.deps.artifacts.put({
      investigationId: job.investigationId,
      runId,
      kind: "run-manifest",
      filename: `${runId}-manifest.json`,
      bytes: JSON.stringify(manifest, null, 2) + "\n",
      contentType: "application/json",
      redactionApplied: this.deps.redactor.stamp(),
    });

    const runSeq = await this.deps.metadata.tx((t) =>
      t.nextSequence(job.investigationId, "runSeq")
    );
    await this.deps.metadata.tx(async (t) => {
      await t.insertRun({
        runId,
        jobId,
        investigationId: job.investigationId,
        experimentId: job.experimentId,
        repetitionIndex: job.repetitionIndex,
        attemptIndex: job.attemptIndex,
        seq: runSeq,
        seed: 0,
        outcome: null,
        outcomeRuleId: null,
        manifestArtifactId: null,
        manifestSealHash: null,
        startedAt,
        finishedAt: null,
        durationMs: null,
      });
      await t.updateRunOnSeal(runId, {
        outcome,
        outcomeRuleId: ruleId,
        manifestArtifactId: manifestRef.artifactId,
        manifestSealHash: manifest.sealHash ?? null,
        finishedAt,
        durationMs: 0,
      });
    });

    await this.deps.queue.finish(jobId, { reason, runOutcome: outcome });
    return {
      runId,
      jobId,
      terminalReason: reason,
      outcome,
      outcomeRuleId: ruleId,
      manifest,
      durationMs: 0,
    };
  }
}
