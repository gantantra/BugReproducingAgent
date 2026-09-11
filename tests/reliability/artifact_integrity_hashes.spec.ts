import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { searchExperiment } from "@investigator/test-fixtures";
import { sha256Prefixed } from "@investigator/core";
import { createHarness, readManifests, runExperiment, type Harness } from "./harness.js";

/**
 * Reliability gate test 6 — artifact integrity.
 *
 * The store computes hashes itself, verifies on read, and a single corrupted byte is detected.
 * This is detection, not prevention: a local user who can write the workspace can rewrite bytes
 * and hashes consistently, which is the honest guarantee for a local tool (ADR-0004).
 */

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walkFiles(p));
    else out.push(p);
  }
  return out;
}

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

describe("artifact integrity hashes", () => {
  it("every recorded hash and byte length matches a fresh recomputation", async () => {
    h = await createHarness({ fixtures: ["passing"] });
    await runExperiment(h, searchExperiment("passing"), 5);

    const refs = await h.artifacts.list(h.investigationId);
    expect(refs.length).toBeGreaterThan(0);

    for (const ref of refs) {
      const bytes = await h.artifacts.get(ref);
      expect(sha256Prefixed(bytes), `${ref.artifactId} hash`).toBe(ref.sha256);
      expect(bytes.byteLength, `${ref.artifactId} length`).toBe(ref.byteLength);

      const v = await h.artifacts.verify(ref);
      expect(v.ok, `${ref.artifactId} verify`).toBe(true);
      expect(v.observedSha256).toBe(ref.sha256);
    }
  });

  it("every artifact a manifest references exists and verifies", async () => {
    h = await createHarness({ fixtures: ["passing"] });
    await runExperiment(h, searchExperiment("passing"), 3);

    // The invariant is one manifest per ATTEMPT, bijective with the job rows -- not a fixed
    // total. Asserting `=== 3` encoded an assumption that no retry ever happens, which ADR-0005
    // explicitly permits; this spec's subject is artifact integrity, so it must not fail for a
    // reason that has nothing to do with artifacts (decision 4).
    //
    // The deterministic 100-run fixture separately requires ZERO retries
    // (same_test_100_runs.spec.ts). That criterion is not weakened by this assertion: this spec
    // asserts the lineage invariant, that spec asserts the zero-retry criterion, and both hold.
    const manifests = await readManifests(h);
    const jobs = await h.queue.listJobs(h.investigationId);
    expect(manifests.length, "one manifest per attempt").toBe(jobs.length);
    expect(manifests.length).toBeGreaterThanOrEqual(3);

    const manifestRunIds = new Set(manifests.map((m) => m["runId"] as string));
    expect(manifestRunIds.size, "manifest runIds are unique").toBe(manifests.length);
    for (const job of jobs) {
      expect(job.runId, `job ${job.jobId} has no runId`).toBeTruthy();
      expect(manifestRunIds.has(job.runId!), `job ${job.jobId} has no manifest`).toBe(true);
    }
    // Every retry is a new linked attempt, never a mutation of its predecessor.
    for (const retry of jobs.filter((j) => j.attemptIndex > 0)) {
      expect(retry.previousAttemptJobId, "a retry must link to its predecessor").toBeTruthy();
    }

    for (const m of manifests) {
      const listed = m["artifacts"] as Array<{ artifactId: string; sha256: string }>;
      expect(Array.isArray(listed)).toBe(true);
      for (const a of listed) {
        const head = await h.artifacts.head(a.artifactId);
        expect(head.sha256).toBe(a.sha256);
        const v = await h.artifacts.verify(a.artifactId);
        expect(v.ok, `manifest-referenced ${a.artifactId} failed verification`).toBe(true);
      }
    }
  });

  it("a single corrupted byte is detected as ARTIFACT_HASH_MISMATCH on read", async () => {
    h = await createHarness({ fixtures: ["passing"] });
    const [r] = await runExperiment(h, searchExperiment("passing"), 1);

    const refs = await h.artifacts.list(h.investigationId, {
      kind: "normalized-evidence",
      runId: r!.runId,
    });
    const ref = refs[0]!;
    expect((await h.artifacts.verify(ref)).ok).toBe(true);

    // Find the blob on disk and flip one byte.
    const files = walkFiles(h.workspace.investigationsDir).filter((f) =>
      f.includes("normalized-evidence")
    );
    expect(files.length).toBeGreaterThan(0);
    const victim = files[0]!;
    const original = readFileSync(victim);
    const mutated = Buffer.from(original);
    // Flip a byte in the middle, keeping length identical so only the hash can catch it.
    const idx = Math.floor(mutated.length / 2);
    mutated[idx] = mutated[idx]! ^ 0x01;
    writeFileSync(victim, mutated);

    const v = await h.artifacts.verify(ref);
    expect(v.ok).toBe(false);
    expect(v.observedSha256).not.toBe(ref.sha256);

    // Reading it must refuse rather than silently serving corrupted evidence.
    await expect(h.artifacts.get(ref)).rejects.toThrowError(
      /ARTIFACT_HASH_MISMATCH|does not match its recorded hash/
    );
  });

  it("the store computes the hash itself and rejects a conflicting caller-supplied id", async () => {
    h = await createHarness({ fixtures: ["passing"] });

    const stamp = h.redactor.stamp();
    const first = await h.artifacts.put({
      investigationId: h.investigationId,
      kind: "console-log",
      filename: "a.jsonl",
      bytes: "content A",
      contentType: "application/x-ndjson",
      redactionApplied: stamp,
      artifactId: "CONSOLE-fixed",
    });
    expect(first.sha256).toBe(sha256Prefixed("content A"));

    // Re-putting identical bytes under the same id is idempotent.
    const again = await h.artifacts.put({
      investigationId: h.investigationId,
      kind: "console-log",
      filename: "a.jsonl",
      bytes: "content A",
      contentType: "application/x-ndjson",
      redactionApplied: stamp,
      artifactId: "CONSOLE-fixed",
    });
    expect(again.sha256).toBe(first.sha256);

    // Different bytes under the same id is a hash mismatch, not a silent overwrite.
    await expect(
      h.artifacts.put({
        investigationId: h.investigationId,
        kind: "console-log",
        filename: "a.jsonl",
        bytes: "content B",
        contentType: "application/x-ndjson",
        redactionApplied: stamp,
        artifactId: "CONSOLE-fixed",
      })
    ).rejects.toThrowError(/ARTIFACT_HASH_MISMATCH|different content/);
  });

  it("identical bytes are stored once but keep separate refs and provenance", async () => {
    h = await createHarness({ fixtures: ["passing"] });
    const stamp = h.redactor.stamp();

    const a = await h.artifacts.put({
      investigationId: h.investigationId,
      runId: "RUN-001",
      kind: "screenshot",
      filename: "same.png",
      bytes: "IDENTICAL",
      contentType: "image/png",
      redactionApplied: stamp,
      artifactId: "SHOT-1",
    });
    const b = await h.artifacts.put({
      investigationId: h.investigationId,
      runId: "RUN-002",
      kind: "screenshot",
      filename: "same.png",
      bytes: "IDENTICAL",
      contentType: "image/png",
      redactionApplied: stamp,
      artifactId: "SHOT-2",
    });

    expect(a.sha256).toBe(b.sha256);
    expect(a.artifactId).not.toBe(b.artifactId);
    expect(a.runId).toBe("RUN-001");
    expect(b.runId).toBe("RUN-002");
  });
});
