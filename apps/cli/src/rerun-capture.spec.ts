import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { systemClock } from "@investigator/core";
import { Redactor, runPlane, serializeRawLog, type RawEvent } from "@investigator/evidence";
import { suiteCaptureLogName } from "@investigator/execution";
import { LocalArtifactStore, SqliteMetadataStore } from "@investigator/storage";
import {
  AUTHORED_REQUIRED_EVIDENCE,
  CAPTURE_DIR,
  classifyEachRun,
  ingestRerunBatch,
  maskLiterals,
  outcomeInputsFor,
  prepareSuiteCapture,
  suiteCaptureModulePath,
  type AuthoredRunResult,
} from "./rerun-capture.js";

const POLICY = join(process.cwd(), "policies", "default.yaml");
const CAPTURE = {
  responseBodyMaxBytes: 0,
  responseBodyContentTypes: [],
  webSocketFrames: false,
  captureBodies: false,
};

const SPEC = [
  `import { test } from "@playwright/test";`,
  ``,
  `test("t", async ({ page }) => {`,
  `  await page.goto("http://127.0.0.1/");`,
  `  await page.getByRole("button").click();`,
  `  await page.getByText("done").waitFor();`,
  `});`,
  ``,
].join("\n");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reproagent-rerun-capture-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function suite(spec = SPEC): string {
  const s = join(dir, "suite");
  mkdirSync(join(s, "tests"), { recursive: true });
  writeFileSync(join(s, "playwright.config.ts"), "export default {};\n");
  writeFileSync(join(s, "tests", "repro.spec.ts"), spec);
  return s;
}

function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else out[p] = readFileSync(p, "utf8");
    }
  };
  walk(root);
  return out;
}

describe("preparing a suite for capture", () => {
  it("copies the tests with only the import changed, and leaves the suite untouched", () => {
    const s = suite();
    const before = snapshot(s);
    const prep = prepareSuiteCapture({
      suiteDir: s,
      policyPath: POLICY,
      credentialNames: ["ACCOUNT_OTP"],
      capture: CAPTURE,
      captureModule: suiteCaptureModulePath(),
    });
    expect(prep.supported).toBe(true);
    if (!prep.supported) return;

    // The suite's own files, byte for byte.
    for (const [p, text] of Object.entries(before)) expect(readFileSync(p, "utf8")).toBe(text);

    const copy = readFileSync(join(s, CAPTURE_DIR, "tests", "repro.spec.ts"), "utf8");
    expect(copy).toContain(`import { test } from "../capture";`);
    expect(copy).not.toContain("@playwright/test");
    // Same line count, so "failed at the final check" is the same line in both.
    expect(copy.split("\n").length).toBe(SPEC.split("\n").length);
    expect(prep.configArgs).toEqual(["--config", join(s, CAPTURE_DIR, "playwright.config.ts")]);
  });

  it("puts credential names in the config, never their values", () => {
    const s = suite();
    const prep = prepareSuiteCapture({
      suiteDir: s,
      policyPath: POLICY,
      credentialNames: ["ACCOUNT_OTP"],
      capture: CAPTURE,
      captureModule: suiteCaptureModulePath(),
    });
    if (!prep.supported) throw new Error(prep.reason);
    const config = readFileSync(prep.env["REPROAGENT_CAPTURE_CONFIG"]!, "utf8");
    expect(config).toContain("ACCOUNT_OTP");
    expect(Object.values(prep.env).join(" ")).not.toContain("7982");
  });

  it("reports a suite it cannot prepare as unsupported, and writes nothing", () => {
    const s = suite(`const { test } = require("@playwright/test");\ntest("t", async () => {});\n`);
    const prep = prepareSuiteCapture({
      suiteDir: s,
      policyPath: POLICY,
      credentialNames: [],
      capture: CAPTURE,
      captureModule: suiteCaptureModulePath(),
    });
    expect(prep).toMatchObject({ supported: false });
    expect(existsSync(join(s, CAPTURE_DIR))).toBe(false);
  });

  it("reports a missing capture module as unsupported", () => {
    const prep = prepareSuiteCapture({
      suiteDir: suite(),
      policyPath: POLICY,
      credentialNames: [],
      capture: CAPTURE,
      captureModule: join(dir, "nowhere.js"),
    });
    expect(prep).toEqual({ supported: false, reason: "the capture module is not built" });
  });
});

describe("classifying each run of a report", () => {
  const result = (status: string, line: number | null, repeatDir: string) => ({
    status,
    errors: line === null ? [] : [{ location: { line } }],
    attachments: [{ name: "video", path: `/a/artifacts/${repeatDir}/video.webm` }],
  });
  const report = {
    suites: [
      {
        specs: [
          {
            tests: [
              { results: [result("failed", 6, "tests-repro-t-repeat2")] },
              { results: [result("passed", null, "tests-repro-t")] },
              { results: [result("failed", 5, "tests-repro-t-repeat1")] },
              { results: [{ status: "failed", errors: [], attachments: [] }] },
            ],
          },
        ],
      },
    ],
  };

  it("takes each run's repeat from the folder Playwright named after it", () => {
    const runs = classifyEachRun(report, SPEC);
    expect(runs.map((r) => [r.repeatIndex, r.kind, r.line])).toEqual([
      [0, "passed", null],
      [1, "stopped-early", 5],
      [2, "failed-at-check", 6],
      [3, "did-not-start", null],
    ]);
    expect(runs[0]!.videoPath).toBe("/a/artifacts/tests-repro-t/video.webm");
  });
});

describe("the existing outcome rules decide each authored run", () => {
  const outcome = (kind: AuthoredRunResult["kind"]): string =>
    runPlane({
      runId: "ARUN-001-001",
      rawLogText: "",
      redactor: Redactor.fromFile(POLICY),
      collectorVersion: "0",
      requiredCategories: AUTHORED_REQUIRED_EVIDENCE,
      ...outcomeInputsFor({
        repeatIndex: 0,
        kind,
        line: kind === "passed" ? null : 6,
        videoPath: null,
      }),
    }).outcome.outcome;

  it.each([
    ["failed-at-check", "PRODUCT_FAILED"],
    ["stopped-early", "AUTOMATION_FAILED"],
    ["passed", "VALID_COMPLETED"],
    ["did-not-start", "INFRASTRUCTURE_FAILED"],
  ] as const)("%s -> %s", (kind, expected) => {
    expect(outcome(kind)).toBe(expected);
  });
});

describe("masking credential values that reached a raw log", () => {
  it("masks the value as written and as escaped inside JSON", () => {
    const value = 'p"ss\\word';
    const text = `{"a":"${JSON.stringify(value).slice(1, -1)}"} and ${value}`;
    const masked = maskLiterals(text, [value], "[REDACTED]");
    expect(masked).not.toContain(value);
    expect(masked).not.toContain(JSON.stringify(value).slice(1, -1));
  });
});

describe("storing a batch", () => {
  const SECRET = "7982-otp-SECRET";
  let store: SqliteMetadataStore;
  let artifacts: LocalArtifactStore;

  beforeEach(async () => {
    store = new SqliteMetadataStore({ path: join(dir, "t.db") });
    await store.migrate();
    await store.tx((t) =>
      t.insertInvestigation({
        investigationId: "INV-001",
        title: "t",
        targetName: null,
        createdAt: systemClock.nowIso(),
        status: "open",
      })
    );
    artifacts = new LocalArtifactStore({
      root: join(dir, "inv"),
      metadata: store,
      clock: systemClock,
    });
  });
  afterEach(async () => {
    await store.close();
  });

  it("never stores a registered credential value, even one the collector missed", async () => {
    const staging = join(dir, "staging");
    mkdirSync(staging, { recursive: true });
    // A console line carrying the value unmasked: what a collector that failed to mask would write.
    const events = [
      {
        seq: 1,
        tMonoMs: 1,
        tWallMs: 1,
        tDeltaMs: 0,
        category: "console",
        level: "error",
        text: `otp is ${SECRET}`,
        file: "http://127.0.0.1/app.js",
        line: 1,
        column: 1,
      },
    ] as unknown as RawEvent[];
    writeFileSync(join(staging, suiteCaptureLogName(0)), serializeRawLog(events));
    const video = join(dir, "video.webm");
    writeFileSync(video, Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));

    const batch = await ingestRerunBatch({
      investigationId: "INV-001",
      runs: [
        { repeatIndex: 0, kind: "failed-at-check", line: 6, videoPath: video },
        { repeatIndex: 1, kind: "passed", line: null, videoPath: null },
      ],
      stagingDir: staging,
      suiteChecksum: "sha256:" + "b".repeat(64),
      captureSupported: true,
      credentialValues: [SECRET],
      redactor: Redactor.fromFile(POLICY),
      artifacts,
      metadata: store,
      now: () => "2026-09-21T00:00:00.000Z",
    });

    expect(batch.batchId).toBe("BATCH-001");
    expect(batch.runs.map((r) => [r.runId, r.outcome, r.captured])).toEqual([
      ["ARUN-001-001", "PRODUCT_FAILED", true],
      ["ARUN-001-002", "VALID_COMPLETED", false],
    ]);
    expect(batch.runs[0]!.videoArtifactId).toMatch(/^VIDEO-/);

    const stored = snapshot(join(dir, "inv"));
    expect(Object.keys(stored).length).toBeGreaterThan(4);
    for (const [p, text] of Object.entries(stored)) {
      expect(text.includes(SECRET), `${p} holds the credential`).toBe(false);
    }
  });

  it("numbers batches per investigation", async () => {
    const base = {
      investigationId: "INV-001",
      runs: [],
      stagingDir: null,
      suiteChecksum: "sha256:" + "b".repeat(64),
      captureSupported: false,
      captureReason: "test",
      credentialValues: [],
      redactor: Redactor.fromFile(POLICY),
      artifacts,
      metadata: store,
      now: () => "2026-09-21T00:00:00.000Z",
    };
    expect((await ingestRerunBatch(base)).batchId).toBe("BATCH-001");
    expect((await ingestRerunBatch(base)).batchId).toBe("BATCH-002");
  });
});
