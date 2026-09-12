import { describe, it, expect } from "vitest";
import { ACTIONS, ParamError, artifactRequest, findAction, type BuildContext } from "./actions.js";

/**
 * The allowlist is the web UI's security boundary: it is the only thing that turns a browser
 * payload into process arguments. These tests are about what must NOT get through.
 *
 * The companion check lives in tests/e2e/web-actions.test.ts, which asserts the argv these
 * builders produce is argv the real CLI parser accepts. Two bugs already escaped a reading of the
 * source alone — an `inspect` command that does not exist, and `--gate` for an argument the CLI
 * takes positionally — so shape is verified against the binary, not against memory.
 */

const ctx: BuildContext = { inWorkspace: (rel) => `/ws/${rel}` };

function build(id: string, params: Record<string, unknown>): string[] {
  const action = findAction(id);
  if (!action) throw new Error(`no action ${id}`);
  return action.build(params, ctx);
}

describe("the allowlist itself", () => {
  it("has unique ids", () => {
    const ids = ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("refuses an unknown action", () => {
    expect(findAction("rm -rf /")).toBeUndefined();
    expect(findAction("")).toBeUndefined();
    expect(findAction(undefined)).toBeUndefined();
    expect(findAction(42)).toBeUndefined();
  });

  it("every action declares a summary and a streaming decision", () => {
    for (const a of ACTIONS) {
      expect(a.summary.length, `${a.id} has no summary`).toBeGreaterThan(0);
      expect(typeof a.streams, `${a.id} does not declare streams`).toBe("boolean");
    }
  });
});

describe("parameters that must never reach argv", () => {
  it("refuses an investigation id carrying extra flags", () => {
    expect(() => build("status", { investigation: "INV-001 --workspace /etc" })).toThrow(
      ParamError
    );
    expect(() => build("status", { investigation: "--help" })).toThrow(ParamError);
    expect(() => build("status", { investigation: "" })).toThrow(ParamError);
  });

  it("refuses path traversal and absolute paths", () => {
    for (const bad of ["../../etc/passwd", "/etc/passwd", "C:/Windows/system32", "a/../../b"]) {
      expect(() => build("intake", { from: bad }), bad).toThrow(ParamError);
    }
  });

  it("refuses a gate that is not one of the three", () => {
    expect(() => build("approve-scaffold", { investigation: "INV-001", gate: "anything" })).toThrow(
      ParamError
    );
  });

  it("refuses a repetition count outside the allowed range", () => {
    for (const bad of [0, -1, 1000, 2.5, "lots"]) {
      expect(() => build("run", { investigation: "INV-001", repeat: bad }), String(bad)).toThrow(
        ParamError
      );
    }
  });

  it("refuses a malformed checksum", () => {
    const base = { investigation: "INV-001", gate: "target_failure", from: "a.yaml" };
    for (const bad of ["", "sha256:" + "a".repeat(64), "a".repeat(63), "z".repeat(64)]) {
      expect(() => build("approve", { ...base, checksum: bad }), bad).toThrow(ParamError);
    }
  });
});

describe("argv the builders produce", () => {
  it("puts the gate positionally, where the CLI expects it", () => {
    const argv = build("approve", {
      investigation: "INV-001",
      gate: "experiment_selection",
      checksum: "a".repeat(64),
      from: "approvals/gate-1.yaml",
    });
    expect(argv[0]).toBe("approve");
    expect(argv[1]).toBe("experiment_selection");
    expect(argv).not.toContain("--gate");
  });

  it("cannot approve without a checksum", () => {
    const approve = findAction("approve");
    expect(approve).toBeDefined();
    expect(() =>
      build("approve", {
        investigation: "INV-001",
        gate: "experiment_selection",
        from: "approvals/gate-1.yaml",
      })
    ).toThrow(ParamError);
    // Nothing in the allowlist may approve a gate without binding to proposal bytes.
    for (const a of ACTIONS) {
      if (a.id !== "approve" && a.id !== "approve-scaffold") {
        expect(a.summary.toLowerCase(), `${a.id} claims to approve`).not.toContain(
          "approve a gate"
        );
      }
    }
  });

  it("makes workspace-relative paths absolute through the context", () => {
    const argv = build("intake", { from: "reports/report.md", ai: true });
    expect(argv).toContain("/ws/reports/report.md");
    expect(argv).toContain("--ai");
    expect(argv).not.toContain("reports/report.md");
  });

  it("omits optional flags that were not supplied", () => {
    const argv = build("intake", { from: "r.md" });
    expect(argv).not.toContain("--ai");
    expect(argv).not.toContain("--title");
    expect(argv).not.toContain("--env");
  });
});

describe("artifact requests", () => {
  it("accepts a well-formed request", () => {
    const q = new URLSearchParams({ investigation: "INV-001", kind: "video", sha: "a".repeat(64) });
    expect(artifactRequest(q)).toEqual({
      investigation: "INV-001",
      kind: "video",
      sha: "a".repeat(64),
    });
  });

  it("refuses a kind or sha that could walk the filesystem", () => {
    const bad = [
      { investigation: "INV-001", kind: "../../..", sha: "a".repeat(64) },
      { investigation: "INV-001", kind: "video", sha: "../etc/passwd" },
      { investigation: "../..", kind: "video", sha: "a".repeat(64) },
    ];
    for (const params of bad) {
      expect(() => artifactRequest(new URLSearchParams(params)), JSON.stringify(params)).toThrow(
        ParamError
      );
    }
  });
});
