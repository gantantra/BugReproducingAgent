import { detectUnsafeDiagnostics, llmConfigStatus } from "@investigator/core";
import { verifyManifest } from "@investigator/execution";
import type { Runtime } from "../runtime.js";

/**
 * `investigate doctor` — read-only state report.
 *
 * Prints no secret material: the API key is reported only as configured or not, by variable
 * NAME, and the provider base URL is reduced to its host (ADR-0008).
 */

export interface DoctorResult {
  json: unknown;
  human: () => string;
}

interface DoctorOptions {
  verifyLineage?: boolean;
}

export async function doctorCommand(rt: Runtime, opts: DoctorOptions): Promise<DoctorResult> {
  const schemaVersion = await rt.metadata.schemaVersion();
  const investigations = await rt.metadata.read((t) => t.listInvestigations());
  const diagnostics = detectUnsafeDiagnostics();

  // AI configuration is REPORTED, never required (decision 6). `doctor` must work on a fresh
  // workspace with no DeepSeek variables set, because nothing it does calls a provider. Only
  // variable NAMES appear in the output.
  const llm = llmConfigStatus(rt.config);
  const baseUrlHost = llm.baseUrlHost ?? "unset";
  const keyConfigured = llm.apiKeyConfigured;

  const perInvestigation: Array<{
    investigationId: string;
    queue: Awaited<ReturnType<typeof rt.queue.stats>>;
    artifacts: number;
    integrity: { checked: number; failed: number; failures: string[] };
    lineage?: { records: number; chainOk: boolean; firstBreak: string | null };
  }> = [];

  for (const inv of investigations) {
    const queue = await rt.queue.stats(inv.investigationId);
    const refs = await rt.artifacts.list(inv.investigationId);

    // Integrity: recompute every artifact hash and re-verify every sealed manifest.
    const failures: string[] = [];
    for (const ref of refs) {
      const v = await rt.artifacts.verify(ref);
      if (!v.ok) failures.push(`${ref.artifactId}: hash mismatch`);
    }
    for (const ref of refs.filter((r) => r.kind === "run-manifest")) {
      try {
        const text = await rt.artifacts.getText(ref);
        const check = verifyManifest(JSON.parse(text));
        if (!check.ok) failures.push(`${ref.artifactId}: ${check.detail}`);
      } catch (e) {
        failures.push(`${ref.artifactId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const entry: (typeof perInvestigation)[number] = {
      investigationId: inv.investigationId,
      queue,
      artifacts: refs.length,
      integrity: { checked: refs.length, failed: failures.length, failures: failures.slice(0, 10) },
    };

    if (opts.verifyLineage) {
      const records = await rt.metadata.read((t) => t.listLineage(inv.investigationId));
      // Detection, not prevention: a local user can rewrite consistently. The honest guarantee
      // for a local tool is that a rewrite is visible (ADR-0012).
      let chainOk = true;
      let firstBreak: string | null = null;
      let prev: string | null = null;
      for (const r of records) {
        if (r.prevRecordHash !== prev) {
          chainOk = false;
          firstBreak = r.lineageId;
          break;
        }
        prev = r.recordHash;
      }
      entry.lineage = { records: records.length, chainOk, firstBreak };
    }

    perInvestigation.push(entry);
  }

  const json = {
    ok: perInvestigation.every((p) => p.integrity.failed === 0),
    workspace: rt.workspace.root,
    schemaVersion,
    config: {
      provider: rt.config.llm.provider,
      baseUrlHost,
      apiKeyEnv: rt.config.llm.apiKeyEnv,
      apiKeyConfigured: keyConfigured,
      // "configured" | "missing" | "unavailable", plus the NAMES of anything absent.
      aiConfig: llm.state,
      aiConfigMissing: llm.missingVars,
      metadata: rt.config.storage.metadata,
      artifacts: rt.config.storage.artifacts,
      queue: rt.config.storage.queue,
      journalMode: rt.config.storage.sqlite.journalMode,
      workers: rt.config.execution.workers,
      tracePolicy: rt.config.execution.capture.tracePolicy,
      video: rt.config.execution.video,
      gatesRequired: rt.config.approvals.required,
      allowedOrigins: rt.config.safety.allowedOrigins.length,
    },
    redaction: {
      policyId: rt.redactor.policy.policyId,
      policyVersion: rt.redactor.policy.policyVersion,
      mode: rt.redactor.policy.mode,
      rules: rt.redactor.policy.rules.length,
    },
    safety: {
      unsafeDiagnostics: diagnostics.unsafe,
      findings: diagnostics.findings,
    },
    investigations: perInvestigation,
  };

  return {
    json,
    human: () => {
      const l: string[] = [];
      l.push(`Workspace      ${rt.workspace.root}`);
      l.push(`Schema         version ${schemaVersion}`);
      l.push(
        `Storage        metadata=${rt.config.storage.metadata} artifacts=${rt.config.storage.artifacts} queue=${rt.config.storage.queue} journal=${rt.config.storage.sqlite.journalMode}`
      );
      l.push(
        `Provider       ${rt.config.llm.provider} host=${baseUrlHost} key(${rt.config.llm.apiKeyEnv})=${keyConfigured ? "configured" : "not set"} ai=${llm.state}${llm.missingVars.length ? ` missing=${llm.missingVars.join(",")}` : ""}`
      );
      l.push(
        `Redaction      ${rt.redactor.policy.policyId} v${rt.redactor.policy.policyVersion} mode=${rt.redactor.policy.mode} rules=${rt.redactor.policy.rules.length}`
      );
      l.push(
        `Capture        trace=${rt.config.execution.capture.tracePolicy} video=${rt.config.execution.video} wsFrames=${rt.config.execution.capture.webSocketFrames}`
      );
      l.push(`Gates          ${rt.config.approvals.required.join(", ")}`);
      l.push(
        `Safety         allowedOrigins=${rt.config.safety.allowedOrigins.length} productionGuard=${rt.config.safety.productionGuard} blockDestructive=${rt.config.safety.blockDestructiveActions}`
      );
      if (diagnostics.unsafe) {
        l.push("", "UNSAFE DIAGNOSTICS:");
        for (const f of diagnostics.findings) l.push(`  ! ${f}`);
      }
      if (!perInvestigation.length) {
        l.push("", "No investigations yet.");
      }
      for (const p of perInvestigation) {
        l.push("", `${p.investigationId}`);
        l.push(
          `  queue        pending=${p.queue.pending} claimed=${p.queue.claimed} running=${p.queue.running} terminal=${p.queue.terminal}`
        );
        const outcomes = Object.entries(p.queue.byOutcome)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ");
        if (outcomes) l.push(`  outcomes     ${outcomes}`);
        l.push(
          `  integrity    ${p.integrity.checked} artifacts checked, ${p.integrity.failed} failed`
        );
        for (const f of p.integrity.failures) l.push(`    ! ${f}`);
        if (p.lineage) {
          l.push(
            `  lineage      ${p.lineage.records} records, chain ${p.lineage.chainOk ? "verified" : `BROKEN at ${p.lineage.firstBreak}`}`
          );
        }
      }
      return l.join("\n");
    },
  };
}
