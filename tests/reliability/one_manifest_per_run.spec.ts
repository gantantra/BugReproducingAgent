import { describe, it, expect, afterEach } from "vitest";
import { searchExperiment } from "@investigator/test-fixtures";
import { verifyManifest, ManifestWriter } from "@investigator/execution";
import { systemClock } from "@investigator/core";
import {
  createHarness,
  readManifests,
  runExperiment,
  runExperimentAllAttempts,
  type Harness,
} from "./harness.js";

/**
 * Reliability gate test 2 — one manifest per run, sealed and immutable.
 */

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

describe("one manifest per run", () => {
  it("produces exactly one sealed manifest per run, bijective with jobs and runs", async () => {
    h = await createHarness({ fixtures: ["passing", "product-failing-deterministic"] });
    // This test is about the per-attempt bijection, so it needs every attempt, not the
    // collapsed one-per-repetition view.
    const a = await runExperimentAllAttempts(h, searchExperiment("passing"), 4);
    const b = await runExperimentAllAttempts(
      h,
      searchExperiment("product-failing-deterministic", { experimentId: "EXP-002" }),
      4
    );
    // One manifest per ATTEMPT, not per requested repetition. An infrastructure retry is a new
    // attempt by design (ADR-0005), so the count is >= 8; what must hold is the bijection.
    const total = a.length + b.length;
    expect(total).toBeGreaterThanOrEqual(8);

    const manifests = await readManifests(h);
    expect(manifests).toHaveLength(total);

    const jobs = await h.queue.listJobs(h.investigationId);
    const runs = await h.metadata.read((t) => t.listRuns(h!.investigationId));
    expect(jobs).toHaveLength(total);
    expect(runs).toHaveLength(total);

    // Bijection on runId across manifests, runs, and the results the worker returned.
    const manifestRunIds = new Set(manifests.map((m) => m["runId"] as string));
    const runRunIds = new Set(runs.map((r) => r.runId));
    const resultRunIds = new Set([...a, ...b].map((r) => r.runId));
    expect(manifestRunIds).toEqual(runRunIds);
    expect(manifestRunIds).toEqual(resultRunIds);
    expect(manifestRunIds.size).toBe(total);
    // Every repetition still ends with exactly one surviving observation.
    const { noValidObservation } = await h.queue.repetitionOutcomes(h.investigationId);
    expect(noValidObservation).toEqual([]);

    // No orphans in either direction.
    for (const job of jobs) expect(job.runId).toBeTruthy();
    for (const run of runs) expect(jobs.some((j) => j.jobId === run.jobId)).toBe(true);
  });

  it("every manifest is sealed, seal-verifiable, and carries the required header fields", async () => {
    h = await createHarness({ fixtures: ["passing"] });
    await runExperiment(h, searchExperiment("passing"), 3);
    const manifests = await readManifests(h);

    for (const m of manifests) {
      expect(m["sealed"]).toBe(true);
      expect(m["sealHash"]).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(verifyManifest(m as never).ok).toBe(true);

      // Required header content (docs/acceptance-tests/M1-reliability-gate.md, test 2).
      for (const key of [
        "investigationId",
        "experimentId",
        "jobId",
        "runId",
        "repetitionIndex",
        "attemptIndex",
        "seed",
        "emulation",
        "versions",
        "configSources",
        "outcomeRuleId",
        "captureStatus",
        "artifacts",
      ]) {
        expect(m[key], `manifest missing ${key}`).toBeDefined();
      }

      const emulation = m["emulation"] as Record<string, unknown>;
      const browser = emulation["browser"] as Record<string, unknown>;
      // browserVersion is OBSERVED at launch, never templated (ADR-0014).
      expect(String(browser["browserVersion"])).not.toContain("<version>");
      expect(String(browser["browserVersion"]).length).toBeGreaterThan(0);

      const resolved = emulation["resolved"] as Record<string, unknown>;
      expect(resolved["userAgent"]).toBeTruthy();
      expect(String(resolved["userAgent"])).not.toContain("<version>");
      expect(resolved["deviceScaleFactor"]).toBeTypeOf("number");

      const versions = m["versions"] as Record<string, unknown>;
      expect(versions["collectorVersion"]).toBeTruthy();
      expect(versions["normalizerVersion"]).toBeTruthy();
      expect(versions["extractorVersion"]).toBeTruthy();

      expect(Array.isArray(m["artifacts"])).toBe(true);
    }
  });

  it("a second seal raises MANIFEST_IMMUTABLE", () => {
    const writer = new ManifestWriter({
      runId: "RUN-001",
      jobId: "JOB-abcdef123456",
      investigationId: "INV-001",
      experimentId: "EXP-001",
      approvalId: null,
      effectiveProposalChecksum: null,
      repetitionIndex: 0,
      attemptIndex: 0,
      previousAttemptJobId: null,
      seed: 1,
      emulation: {
        profileName: "p",
        profileSource: "test",
        resolved: {
          viewport: { width: 1, height: 1 },
          screen: { width: 1, height: 1 },
          deviceScaleFactor: 1,
          isMobile: false,
          hasTouch: false,
          userAgent: "ua",
          locale: "en",
          timezoneId: "UTC",
          colorScheme: "light",
        },
        browser: {
          engine: "chromium",
          playwrightVersion: "x",
          browserVersion: "y",
          headless: true,
        },
      },
      versions: { collectorVersion: "1", normalizerVersion: "1", extractorVersion: "1" },
      target: { name: "t", baseUrl: "http://127.0.0.1:1", classification: "fixture" },
      configSources: {},
      clock: systemClock,
    });

    const sealArgs = {
      terminalReason: "COMPLETED" as const,
      outcome: "VALID_COMPLETED" as const,
      outcomeRuleId: 5 as const,
      outcomeDetail: "ok",
      assertionOutcomes: [],
      captureStatus: {} as never,
      artifacts: [],
      declaredFactors: [],
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      durationMs: 1000,
      clock: systemClock,
    };

    expect(writer.seal(sealArgs).sealed).toBe(true);
    expect(() => writer.seal(sealArgs)).toThrowError(/MANIFEST_IMMUTABLE|already sealed/);
  });

  it("tampering with a sealed manifest is detected by seal verification", async () => {
    h = await createHarness({ fixtures: ["passing"] });
    await runExperiment(h, searchExperiment("passing"), 1);
    const [manifest] = await readManifests(h);
    expect(verifyManifest(manifest as never).ok).toBe(true);

    const tampered = { ...manifest, runOutcome: "VALID_COMPLETED", seed: 999999 };
    const check = verifyManifest(tampered as never);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("seal hash mismatch");
  });

  it("the runs table rejects a second seal via the append-only trigger", async () => {
    h = await createHarness({ fixtures: ["passing"] });
    const [r] = await runExperiment(h, searchExperiment("passing"), 1);

    await expect(
      h.metadata.tx((t) =>
        t.updateRunOnSeal(r!.runId, {
          outcome: "PRODUCT_FAILED",
          outcomeRuleId: 4,
          manifestArtifactId: "MANIFEST-x",
          manifestSealHash: "sha256:" + "0".repeat(64),
          finishedAt: "2026-01-01T00:00:00.000Z",
          durationMs: 1,
        })
      )
    ).rejects.toThrowError(/MANIFEST_IMMUTABLE|sealed/);
  });
});
