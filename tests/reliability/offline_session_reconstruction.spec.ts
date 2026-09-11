import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { searchExperiment } from "@investigator/test-fixtures";
import { Redactor, runPlane } from "@investigator/evidence";
import { COLLECTOR_VERSION } from "@investigator/core";
import {
  createHarness,
  readNormalized,
  readRawLog,
  runExperiment,
  type Harness,
} from "./harness.js";

/**
 * Reliability gate test 10 — offline session reconstruction.
 *
 * The plane must rebuild byte-identically from persisted artifacts alone, with the network
 * stubbed to throw and no browser reachable. This is the property that makes evidence
 * re-derivable years later, and it is what proves the plane is genuinely a pure function of its
 * inputs rather than incidentally depending on ambient state (ADR-0007).
 */

let h: Harness | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await h?.cleanup();
  h = undefined;
});

function policyText(): string {
  return readFileSync(join(process.cwd(), "policies", "default.yaml"), "utf8");
}

describe("offline session reconstruction", () => {
  it("rebuilds byte-identical normalized output with no network and no browser", async () => {
    h = await createHarness({ fixtures: ["passing", "product-failing-deterministic"] });
    const pass = await runExperiment(h, searchExperiment("passing"), 3);
    const fail = await runExperiment(
      h,
      searchExperiment("product-failing-deterministic", { experimentId: "EXP-002" }),
      3
    );
    const all = [...pass, ...fail];
    expect(all).toHaveLength(6);

    // Snapshot the original derived output before tearing anything down.
    const originals = new Map<string, string>();
    const rawLogs = new Map<string, string>();
    const requiredByRun = new Map<string, string[]>();
    for (const r of all) {
      originals.set(r.runId, (await readNormalized(h, r.runId))!);
      rawLogs.set(r.runId, (await readRawLog(h, r.runId))!);
      requiredByRun.set(r.runId, [
        "actions",
        "navigation",
        "console",
        "exceptions",
        "networkMetadata",
      ]);
    }

    // Now make the world hostile: any network call throws, and there is no browser.
    // `vi.spyOn` cannot patch an ESM module namespace, so stub what IS reachable: the global
    // fetch, and the browser entry point. Every fixture server is already torn down by this
    // point, so any attempt to reach one would fail regardless.
    const netError = (): never => {
      throw new Error("network access during reconstruction is forbidden by this test");
    };
    vi.stubGlobal("fetch", netError);
    vi.stubGlobal("XMLHttpRequest", netError);
    for (const f of h.fixtures) await f.close();

    // Rebuild from the persisted raw log alone.
    for (const r of all) {
      const redactor = Redactor.fromString(policyText());
      const rebuilt = runPlane({
        runId: r.runId,
        rawLogText: rawLogs.get(r.runId)!,
        redactor,
        collectorVersion: COLLECTOR_VERSION,
        requiredCategories: requiredByRun.get(r.runId) as never,
        assertionOutcomes: (
          JSON.parse(originals.get(r.runId)!) as { features: { assertionOutcomes: unknown[] } }
        ).features.assertionOutcomes as never,
        interrupted: false,
        infrastructureFailure: null,
        automationFailure: null,
      });

      // 2. Byte-identical. On failure, name the divergence point: two elided blobs tell the
      //    reader nothing about what actually differs.
      const want = originals.get(r.runId)!;
      const got = rebuilt.normalizedJson;
      if (got !== want) {
        let i = 0;
        while (i < Math.min(got.length, want.length) && got[i] === want[i]) i++;
        const window = 220;
        const from = Math.max(0, i - 60);
        throw new Error(
          `run ${r.runId} diverged at offset ${i} (lengths want=${want.length} got=${got.length})
` +
            `WANT: ${JSON.stringify(want.slice(from, from + window))}
` +
            `GOT : ${JSON.stringify(got.slice(from, from + window))}`
        );
      }

      // 6. Outcome and rule id identical.
      expect(rebuilt.outcome.outcome).toBe(r.outcome);
      expect(rebuilt.outcome.ruleId).toBe(r.outcomeRuleId);
    }
  });

  it("running the plane twice on the same input is byte-identical", async () => {
    h = await createHarness({ fixtures: ["passing"] });
    const [r] = await runExperiment(h, searchExperiment("passing"), 1);
    const raw = (await readRawLog(h, r!.runId))!;

    const once = runPlane({
      runId: r!.runId,
      rawLogText: raw,
      redactor: Redactor.fromString(policyText()),
      collectorVersion: COLLECTOR_VERSION,
      interrupted: false,
      infrastructureFailure: null,
      automationFailure: null,
    });
    const twice = runPlane({
      runId: r!.runId,
      rawLogText: raw,
      redactor: Redactor.fromString(policyText()),
      collectorVersion: COLLECTOR_VERSION,
      interrupted: false,
      infrastructureFailure: null,
      automationFailure: null,
    });

    expect(twice.normalizedJson).toBe(once.normalizedJson);
    expect(twice.captureStatus).toEqual(once.captureStatus);
    expect(twice.features).toEqual(once.features);
  });

  it("the rebuilt timeline and index match the original", async () => {
    h = await createHarness({ fixtures: ["passing"] });
    const [r] = await runExperiment(h, searchExperiment("passing"), 1);
    const raw = (await readRawLog(h, r!.runId))!;
    const original = JSON.parse((await readNormalized(h, r!.runId))!) as {
      events: unknown[];
      actions: unknown[];
      captureStatus: unknown;
    };

    const rebuilt = runPlane({
      runId: r!.runId,
      rawLogText: raw,
      redactor: Redactor.fromString(policyText()),
      collectorVersion: COLLECTOR_VERSION,
      interrupted: false,
      infrastructureFailure: null,
      automationFailure: null,
    });

    // 3, 4, 5. Timeline, index, and completeness all reconstruct.
    expect(rebuilt.events.length).toBe(original.events.length);
    expect(rebuilt.actions.length).toBe(original.actions.length);
    expect(rebuilt.index.byEventId.size).toBe(rebuilt.events.length);
    expect(rebuilt.captureStatus.categories).toEqual(
      (original.captureStatus as { categories: unknown }).categories
    );
  });

  it("a changed normalizer version stamps the new version rather than reusing cached output", async () => {
    h = await createHarness({ fixtures: ["passing"] });
    const [r] = await runExperiment(h, searchExperiment("passing"), 1);
    const raw = (await readRawLog(h, r!.runId))!;

    const base = runPlane({
      runId: r!.runId,
      rawLogText: raw,
      redactor: Redactor.fromString(policyText()),
      collectorVersion: COLLECTOR_VERSION,
      interrupted: false,
      infrastructureFailure: null,
      automationFailure: null,
    });
    const bumped = runPlane({
      runId: r!.runId,
      rawLogText: raw,
      redactor: Redactor.fromString(policyText()),
      collectorVersion: "9.9.9-test",
      interrupted: false,
      infrastructureFailure: null,
      automationFailure: null,
    });

    expect(base.versions.collectorVersion).toBe(COLLECTOR_VERSION);
    expect(bumped.versions.collectorVersion).toBe("9.9.9-test");
    // The version stamp is part of the serialised output, so derived data cannot be silently
    // mixed across generations.
    expect(bumped.normalizedJson).not.toBe(base.normalizedJson);
  });
});
