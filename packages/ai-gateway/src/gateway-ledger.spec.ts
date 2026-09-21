import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { systemClock } from "@investigator/core";
import { SqliteMetadataStore } from "@investigator/storage";
import { LlmGateway, type CallContext } from "./gateway.js";
import { BudgetTracker } from "./budget.js";
import type { LlmProvider, LlmRequest, LlmResponse } from "./index.js";

/**
 * A re-run of the same logical call, in a later process, must not collide with the ledger row
 * the earlier run wrote. Observed: `analyze --ai` failed with "UNIQUE constraint failed:
 * ai_calls.request_id" whenever the same analysis was run again -- after a transport failure, or
 * a second click of Analyse.
 */

let dir: string;
let store: SqliteMetadataStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "reproagent-ledger-"));
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
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

const provider: LlmProvider = {
  async complete(): Promise<LlmResponse> {
    return {
      rawText: "{}",
      parsed: {},
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      provider: "deepseek",
      modelId: "test-model",
      latencyMs: 1,
      finishReason: "stop",
      warnings: [],
    };
  },
  async capabilities() {
    return {} as never;
  },
};

function call(gateway: LlmGateway) {
  const ctx: CallContext = {
    budget: new BudgetTracker(
      {
        maxTotalTokens: 100_000,
        maxUsd: null,
        maxTurns: 8,
        maxWallClockMs: 60_000,
        maxToolCalls: 10,
        maxRepairs: 1,
      },
      systemClock.nowMs()
    ),
    flowId: "analyze_failures",
    flowVersion: "1.1.0",
    flowHash: `sha256:${"a".repeat(64)}`,
    promptVersion: "1.1.0",
    turnIndex: 0,
  };
  const req: LlmRequest = {
    alias: "FAST_MODEL",
    system: "same system",
    messages: [{ role: "user", content: "same input" }],
    maxTokens: 100,
    temperature: 0,
    timeoutMs: 1_000,
    requestId: "",
  };
  return gateway.call(req, ctx);
}

describe("re-running the same call", () => {
  it("records it as a later attempt of the same logical call instead of failing", async () => {
    const first = await call(
      new LlmGateway({ provider, metadata: store, investigationId: "INV-001" })
    );
    // A second process: a new gateway, the same investigation, flow, turn and input.
    const second = await call(
      new LlmGateway({ provider, metadata: store, investigationId: "INV-001" })
    );
    expect(second.requestId).not.toBe(first.requestId);
    expect(second.response.rawText).toBe("{}");
  });
});
