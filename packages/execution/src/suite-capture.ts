import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import { SeededRng, systemClock } from "@investigator/core";
import { Redactor, serializeRawLog } from "@investigator/evidence";
import { Collector, type CollectorOptions } from "./collector.js";
import { STORAGE_READER } from "./action-interpreter.js";

/**
 * Evidence capture inside an authored suite's own test run (ADR-0029).
 *
 * `investigate rerun` runs the suite through a fixture that calls `startSuiteCapture` for every
 * repeat. It is the measured path's own `Collector`, so the same events are recorded and the
 * same collection-time redaction runs before anything is buffered (ADR-0008): the policy the
 * workspace uses, plus every operator credential value, masked by identity. Only redacted events
 * are ever written, one raw log per repeat, into a staging folder `rerun` ingests and removes.
 *
 * The credential VALUES are not in the config file. They reach this process the way they
 * already did before capture existed -- as the suite's environment, which the script types from
 * -- and only their names are passed here.
 */

/** Environment variable holding the path of the capture config `rerun` writes. */
export const SUITE_CAPTURE_CONFIG_ENV = "REPROAGENT_CAPTURE_CONFIG";

export interface SuiteCaptureConfig {
  /** Absolute path of the redaction policy the workspace uses. */
  policyPath: string;
  /** Names of environment variables whose values must be masked everywhere. */
  credentialNames: string[];
  capture: CollectorOptions["capture"];
  /** Staging folder for the per-repeat raw logs. */
  outDir: string;
  /** A confirmation run: which arm each repeat is, and the factor the variant arm applies. */
  confirmation?: { factor: ConfirmationFactor; schedule: ConfirmationArm[] };
}

export interface SuiteCaptureHandle {
  finish(): Promise<void>;
}

/**
 * One factor varied between otherwise identical runs (ADR-0031). The model names it; this module
 * applies it, through the browser's own DevTools protocol, and records whether it took.
 */
export type ConfirmationFactor =
  { kind: "network"; profile: "slow-3g" | "fast-3g" } | { kind: "cpu"; rate: 2 | 4 | 6 };

export type ConfirmationArm = "variant" | "control";

/**
 * Throughput in bytes per second, latency in milliseconds. The DevTools presets of the same name,
 * so what the operator reads is what they would pick by hand.
 */
export const NETWORK_PROFILES = {
  "slow-3g": { latency: 400, downloadThroughput: 51_200, uploadThroughput: 51_200 },
  "fast-3g": { latency: 150, downloadThroughput: 204_800, uploadThroughput: 96_000 },
} as const;

/**
 * A randomized interleaving of the two arms: n blocks, each one variant and one control in an
 * order the seed decides. Every block holds both arms, so a drift over the batch -- a warming
 * cache, a server slowing down -- falls on both equally. Same seed, same order.
 */
export function buildConfirmationSchedule(perArm: number, seed: number): ConfirmationArm[] {
  if (!Number.isInteger(perArm) || perArm < 1) throw new RangeError(`invalid perArm ${perArm}`);
  const rng = new SeededRng(seed);
  const out: ConfirmationArm[] = [];
  for (let i = 0; i < perArm; i++) {
    out.push(
      ...(rng.next() < 0.5 ? (["variant", "control"] as const) : (["control", "variant"] as const))
    );
  }
  return out;
}

/** The sidecar a confirmation repeat writes beside its raw log: its arm, and whether it took. */
export function suiteCaptureArmName(repeatIndex: number): string {
  return `run-${String(repeatIndex).padStart(4, "0")}.arm.json`;
}

export interface ArmRecord {
  arm: ConfirmationArm;
  factorApplied: boolean;
  error?: string;
}

async function applyFactor(
  context: BrowserContext,
  page: Page,
  factor: ConfirmationFactor
): Promise<void> {
  const cdp = await context.newCDPSession(page);
  if (factor.kind === "network") {
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      ...NETWORK_PROFILES[factor.profile],
    });
  } else {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: factor.rate });
  }
}

/** How long the end-of-run storage read may take before storage is recorded as not captured. */
export const STORAGE_READ_TIMEOUT_MS = 5_000;

/** `promise`, or a rejection after `ms`. The timer never keeps the worker alive. */
export function withinMs<T>(ms: number, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** The raw log a repeat writes. Zero-padded so a directory listing sorts by repeat. */
export function suiteCaptureLogName(repeatIndex: number): string {
  return `run-${String(repeatIndex).padStart(4, "0")}.jsonl`;
}

export function readSuiteCaptureConfig(path: string): SuiteCaptureConfig {
  return JSON.parse(readFileSync(path, "utf8")) as SuiteCaptureConfig;
}

export async function startSuiteCapture(
  config: SuiteCaptureConfig,
  context: BrowserContext,
  page: Page,
  repeatIndex: number,
  env: NodeJS.ProcessEnv = process.env
): Promise<SuiteCaptureHandle> {
  const redactor = Redactor.fromFile(config.policyPath);
  const values = config.credentialNames
    .map((name) => env[name])
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  if (values.length) redactor.maskValues(values);

  const collector = new Collector({
    clock: systemClock,
    redactor,
    runStartWallMs: systemClock.nowMs(),
    runStartMonoMs: systemClock.monotonicMs(),
    capture: config.capture,
  });
  const detach = collector.attach(context, page);

  // The arm is decided by the frozen schedule, and the factor applied BEFORE the script's first
  // step. A variant whose factor did not take is recorded as such and never counted as a variant.
  if (config.confirmation) {
    const arm = config.confirmation.schedule[repeatIndex];
    let record: ArmRecord;
    if (arm === undefined) {
      record = { arm: "control", factorApplied: false, error: "repeat outside the schedule" };
    } else if (arm === "control") {
      record = { arm, factorApplied: false };
    } else {
      try {
        await applyFactor(context, page, config.confirmation.factor);
        record = { arm, factorApplied: true };
      } catch (e) {
        record = { arm, factorApplied: false, error: (e as Error).message };
      }
    }
    writeFileSync(
      join(config.outDir, suiteCaptureArmName(repeatIndex)),
      JSON.stringify(record),
      "utf8"
    );
  }

  return {
    async finish(): Promise<void> {
      // Storage as the run left it. A page that has already closed has none to read, which the
      // collector records as TARGET_DETACHED rather than as an empty store.
      //
      // Bounded: a page still stuck in a navigation when the test timed out would otherwise hold
      // this read for a whole second test timeout, doubling what every such run costs.
      try {
        if (!page.isClosed()) {
          const web = await withinMs(STORAGE_READ_TIMEOUT_MS, page.evaluate(STORAGE_READER));
          collector.storageSnapshot(
            "localStorage",
            web.local.map((e) => ({ key: e.k, rawValue: e.v }))
          );
          collector.storageSnapshot(
            "sessionStorage",
            web.session.map((e) => ({ key: e.k, rawValue: e.v }))
          );
          const cookies = await withinMs(STORAGE_READ_TIMEOUT_MS, context.cookies());
          collector.storageSnapshot(
            "cookies",
            cookies.map((c) => ({
              key: c.name,
              rawValue: c.value,
              metadata: { domain: c.domain, path: c.path, httpOnly: c.httpOnly, secure: c.secure },
            }))
          );
        }
      } catch {
        collector.note({ category: "storage", code: "TARGET_DETACHED" });
      }
      detach();
      // The script's own statements are not seen here: an authored suite calls Playwright
      // directly, with no interpreter emitting action events. Said, not left to look complete.
      collector.note({ category: "actions", code: "COLLECTOR_UNSUPPORTED" });
      collector.flushNotesToLog();
      writeFileSync(
        join(config.outDir, suiteCaptureLogName(repeatIndex)),
        serializeRawLog(collector.getEvents()),
        "utf8"
      );
    },
  };
}
