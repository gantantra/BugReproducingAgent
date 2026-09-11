import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fail, systemClock } from "@investigator/core";
import { LineageWriter } from "@investigator/lineage";
import type { GlobalOptions, Runtime } from "../runtime.js";
import { requireGateApproval } from "../gates.js";

/**
 * `investigate suite generate` — emit a standalone Playwright suite from what a human approved.
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * Emission is DETERMINISTIC and template-driven. No model writes test source: the closed action
 * vocabulary maps one-to-one onto Playwright calls, and an action type with no mapping is a hard
 * error rather than a guess. This is the property that lets the output be handed to a developer
 * who has never run this tool — it is ordinary Playwright, readable and reviewable.
 *
 * The source is the EFFECTIVE proposal, so the emitted suite reproduces what was approved and
 * edited, not what was originally proposed.
 */

export interface SuiteOptions {
  out?: string;
  experiment?: string[];
}

export interface SuiteResult {
  json: unknown;
  human: () => string;
}

function q(value: string): string {
  return JSON.stringify(value);
}

/** One Playwright locator expression for the closed selector vocabulary. */
function locator(sel: Record<string, unknown>): string {
  const strategy = String(sel["strategy"]);
  const value = String(sel["value"] ?? "");
  switch (strategy) {
    case "testid":
      return `page.getByTestId(${q(value)})`;
    case "role":
      return sel["name"]
        ? `page.getByRole(${q(String(sel["role"] ?? value))}, { name: ${q(String(sel["name"]))} })`
        : `page.getByRole(${q(String(sel["role"] ?? value))})`;
    case "label":
      return `page.getByLabel(${q(value)})`;
    case "placeholder":
      return `page.getByPlaceholder(${q(value)})`;
    case "text":
      return `page.getByText(${q(value)})`;
    case "css":
      return `page.locator(${q(value)})`;
    case "xpath":
      return `page.locator(${q(`xpath=${value}`)})`;
    default:
      return fail("INPUT_INVALID", `No Playwright mapping for selector strategy ${strategy}`, {
        context: { strategy },
      });
  }
}

function assertionLines(a: Record<string, unknown>, indent: string): string[] {
  const kind = String(a["kind"]);
  const sel = a["selector"] as Record<string, unknown> | undefined;
  const timeout = a["timeoutMs"] ? `, { timeout: ${String(a["timeoutMs"])} }` : "";
  switch (kind) {
    case "elementCountAtLeast":
      return [
        `${indent}// ${a["assertionId"]}: at least ${String(a["min"])} match(es)`,
        `${indent}await expect(${locator(sel!)}.first()).toBeVisible(${timeout.replace(/^, /, "")});`,
        `${indent}expect(await ${locator(sel!)}.count()).toBeGreaterThanOrEqual(${String(a["min"] ?? 1)});`,
      ];
    case "elementCountEquals":
      return [
        `${indent}// ${a["assertionId"]}`,
        `${indent}expect(await ${locator(sel!)}.count()).toBe(${String(a["count"] ?? 0)});`,
      ];
    case "elementVisible":
      return [
        `${indent}await expect(${locator(sel!)}).toBeVisible(${timeout.replace(/^, /, "")});`,
      ];
    case "elementHidden":
      return [`${indent}await expect(${locator(sel!)}).toBeHidden(${timeout.replace(/^, /, "")});`];
    case "textContains":
      return [
        `${indent}await expect(${locator(sel!)}).toContainText(${q(String(a["text"] ?? ""))});`,
      ];
    case "textEquals":
      return [`${indent}await expect(${locator(sel!)}).toHaveText(${q(String(a["text"] ?? ""))});`];
    case "urlMatches":
      return [
        `${indent}await expect(page).toHaveURL(new RegExp(${q(String(a["urlPattern"] ?? ".*"))}));`,
      ];
    case "noConsoleErrors":
      return [
        `${indent}expect(consoleErrors, "console errors: " + consoleErrors.join(" | ")).toEqual([]);`,
      ];
    case "noUncaughtExceptions":
      return [`${indent}expect(pageErrors, "page errors: " + pageErrors.join(" | ")).toEqual([]);`];
    default:
      return fail("INPUT_INVALID", `No Playwright mapping for assertion kind ${kind}`, {
        context: { kind },
      });
  }
}

function actionLines(a: Record<string, unknown>, indent: string): string[] {
  const type = String(a["type"]);
  const sel = a["selector"] as Record<string, unknown> | undefined;
  const timeout = a["timeoutMs"] ? `{ timeout: ${String(a["timeoutMs"])} }` : "";
  const id = String(a["actionId"]);
  switch (type) {
    case "goto":
      return [
        `${indent}// ${id}`,
        `${indent}await page.goto(BASE_URL + ${q(String(a["url"] ?? "/"))}, { waitUntil: ${q(String(a["waitUntil"] ?? "load"))} });`,
      ];
    case "click":
      return [`${indent}// ${id}`, `${indent}await ${locator(sel!)}.click(${timeout});`];
    case "dblclick":
      return [`${indent}// ${id}`, `${indent}await ${locator(sel!)}.dblclick(${timeout});`];
    case "check":
      return [`${indent}// ${id}`, `${indent}await ${locator(sel!)}.check(${timeout});`];
    case "uncheck":
      return [`${indent}// ${id}`, `${indent}await ${locator(sel!)}.uncheck(${timeout});`];
    case "hover":
      return [`${indent}// ${id}`, `${indent}await ${locator(sel!)}.hover(${timeout});`];
    case "fill":
      return [
        `${indent}// ${id}`,
        `${indent}await ${locator(sel!)}.fill(${q(String(a["value"] ?? ""))});`,
      ];
    case "press":
      return [
        `${indent}// ${id}`,
        `${indent}await page.keyboard.press(${q(String(a["key"] ?? "Enter"))});`,
      ];
    case "waitForTimeout":
      return [
        `${indent}// ${id} — a fixed wait. Prefer a condition; this mirrors the approved sequence.`,
        `${indent}await page.waitForTimeout(${String(a["ms"] ?? 0)});`,
      ];
    case "waitFor": {
      const condition = String(a["condition"] ?? "load");
      return [
        `${indent}// ${id}`,
        `${indent}await page.waitForLoadState(${q(condition)}${timeout ? `, ${timeout}` : ""});`,
      ];
    }
    case "assert":
      return assertionLines(a["assertion"] as Record<string, unknown>, indent);
    default:
      return fail("INPUT_INVALID", `No Playwright mapping for action type ${type}`, {
        context: { actionType: type, actionId: id },
      });
  }
}

export async function suiteGenerateCommand(
  rt: Runtime,
  opts: SuiteOptions,
  globals: GlobalOptions
): Promise<SuiteResult> {
  const investigationId = globals.investigation;
  if (!investigationId) {
    fail("INPUT_INVALID", "`investigate suite generate` requires --investigation <id>", {
      context: { flag: "--investigation" },
    });
  }

  // Emission is governed by the same gate as execution: a suite that reproduces an unapproved
  // sequence would be an approval bypass wearing a different file extension.
  const authorised = await requireGateApproval(rt, investigationId, "experiment_selection");

  const items = authorised.effective.items.filter(
    (i) =>
      authorised.approvedItemIds.includes(i.itemId) &&
      (!opts.experiment?.length || opts.experiment.includes(i.itemId))
  );
  if (items.length === 0) {
    fail("GATE_REQUIRED", "No approved experiment matches the selection", {
      context: { approved: authorised.approvedItemIds.join(",") },
    });
  }

  const outDir = resolve(opts.out ?? join(process.cwd(), "generated-suite"));
  mkdirSync(outDir, { recursive: true });

  const written: string[] = [];
  for (const item of items) {
    const actions = (item["actions"] as Array<Record<string, unknown>>) ?? [];
    const repetitions = (item["repetitions"] as number | undefined) ?? 1;

    const body: string[] = [
      "// GENERATED by ReproAgent `investigate suite generate`. Do not edit by hand:",
      "// regenerate from the approved experiment instead, so the suite and the approval agree.",
      "//",
      `// Investigation:       ${investigationId}`,
      `// Experiment:          ${item.itemId}`,
      `// Authorised by:       ${authorised.approvalId}`,
      `// Effective proposal:  ${authorised.effectiveProposalChecksum}`,
      `// Generated:           ${systemClock.nowIso()}`,
      "//",
      "// This reproduces the EFFECTIVE approved sequence, including the human's edits.",
      ...(item["hypothesis"] ? [`//`, `// Hypothesis: ${String(item["hypothesis"])}`] : []),
      ...(item["falsifier"] ? [`// Disproved by: ${String(item["falsifier"])}`] : []),
      "",
      'import { test, expect } from "@playwright/test";',
      "",
      "// Point this at the environment you want to reproduce against.",
      'const BASE_URL = process.env.REPROAGENT_BASE_URL ?? "http://127.0.0.1:3000";',
      "",
      `// The approved sequence ran ${repetitions} time(s). Intermittent failures need repetition:`,
      "// a single green run is not evidence that the defect is gone.",
      `for (let repetition = 1; repetition <= ${repetitions}; repetition++) {`,
      `  test(${q(`${item.itemId} repetition `)} + repetition, async ({ page }) => {`,
      "    const consoleErrors: string[] = [];",
      "    const pageErrors: string[] = [];",
      '    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });',
      '    page.on("pageerror", (e) => pageErrors.push(String(e.message)));',
      "",
    ];

    for (const action of actions) body.push(...actionLines(action, "    "));

    const standalone = (item["assertions"] as Array<Record<string, unknown>>) ?? [];
    const inlineIds = new Set(
      actions
        .filter((a) => a["type"] === "assert")
        .map((a) => String((a["assertion"] as Record<string, unknown>)?.["assertionId"]))
    );
    const remaining = standalone.filter((a) => !inlineIds.has(String(a["assertionId"])));
    if (remaining.length) {
      body.push("", "    // Assertions declared on the experiment but not inline in the sequence.");
      for (const a of remaining) body.push(...assertionLines(a, "    "));
    }

    body.push("  });", "}", "");

    const filename = `${item.itemId.toLowerCase()}.spec.ts`;
    writeFileSync(join(outDir, filename), body.join("\n"), "utf8");
    written.push(filename);
  }

  // A README, because the suite is meant to be handed to someone who does not have this tool.
  const readme = [
    "# Generated reproduction suite",
    "",
    `Investigation ${investigationId}, authorised by ${authorised.approvalId}.`,
    `Effective proposal: \`${authorised.effectiveProposalChecksum}\``,
    "",
    "This is ordinary Playwright. It does not need ReproAgent to run.",
    "",
    "```bash",
    "npm i -D @playwright/test && npx playwright install chromium",
    "REPROAGENT_BASE_URL=https://your-env.example npx playwright test",
    "```",
    "",
    "## What this does and does not prove",
    "",
    "Each spec repeats the approved sequence. A failure reproduces the observed defect. A clean",
    "run across every repetition does **not** prove the defect is fixed: these sequences target an",
    "intermittent issue, and the repetition count here is the count that was approved, not a",
    "statistically derived one. Frequency measurement is a separate step.",
    "",
    "## Files",
    "",
    ...written.map((f) => `- \`${f}\``),
    "",
  ].join("\n");
  writeFileSync(join(outDir, "README.md"), readme, "utf8");

  const lineage = new LineageWriter(rt.metadata, systemClock);
  for (const item of items) {
    await lineage.append({
      investigationId,
      edge: "emitted_test",
      fromKind: "approved_experiment",
      fromId: `A${item.itemId}`,
      toKind: "static_test",
      toId: `TEST-${item.itemId}`,
      actor: { kind: "deterministic", component: "cli:suite-generate", version: "0.1.0" },
      inputs: {
        effectiveProposalChecksum: authorised.effectiveProposalChecksum,
        approvalId: authorised.approvalId,
        outDir,
      },
    });
  }

  return {
    json: {
      ok: true,
      investigationId,
      approvalId: authorised.approvalId,
      effectiveProposalChecksum: authorised.effectiveProposalChecksum,
      outDir,
      files: [...written, "README.md"],
    },
    human: () =>
      [
        `Generated a standalone Playwright suite from the approved experiment(s).`,
        `  authorised by ${authorised.approvalId}`,
        `  out           ${outDir}`,
        ...written.map((f) => `                ${f}`),
        "",
        "It is ordinary Playwright and runs without ReproAgent:",
        "  REPROAGENT_BASE_URL=https://your-env npx playwright test",
      ].join("\n"),
  };
}
