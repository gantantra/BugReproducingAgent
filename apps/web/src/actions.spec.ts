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
    // 100 is the per-request ceiling. The investigation total is far higher; one command is not.
    for (const bad of [0, -1, 101, 2.5, "lots"]) {
      expect(() => build("run", { investigation: "INV-001", repeat: bad }), String(bad)).toThrow(
        ParamError
      );
    }
  });

  it("refuses a malformed checksum", () => {
    const base = { investigation: "INV-001", gate: "target_failure", from: "a.yaml" };
    for (const bad of [
      "",
      "a".repeat(64), // bare hex: the CLI compares the prefixed form, so this can never match
      "sha256:" + "a".repeat(63),
      "sha256:" + "z".repeat(64),
      "sha512:" + "a".repeat(64),
    ]) {
      expect(() => build("approve", { ...base, checksum: bad }), bad).toThrow(ParamError);
    }
  });

  it("accepts the checksum in the exact form the CLI prints", () => {
    // This assertion previously ran the other way — it required `sha256:<hex>` to be REJECTED,
    // which is the bug it was meant to guard against. `checksumOfBytes` returns the prefixed
    // form and `approve` compares against it, so stripping the prefix to satisfy the allowlist
    // made every one-click approval fail with GATE_CHECKSUM_MISMATCH.
    const argv = build("approve", {
      investigation: "INV-001",
      gate: "target_failure",
      from: "a.yaml",
      checksum: `sha256:${"a".repeat(64)}`,
    });
    expect(argv).toContain(`sha256:${"a".repeat(64)}`);
  });
});

describe("argv the builders produce", () => {
  it("puts the gate positionally, where the CLI expects it", () => {
    const argv = build("approve", {
      investigation: "INV-001",
      gate: "experiment_selection",
      checksum: `sha256:${"a".repeat(64)}`,
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

describe("the authoring action", () => {
  const ctx: BuildContext = { inWorkspace: (rel) => `/ws/${rel}` };
  const build = (p: Record<string, unknown>): string[] => {
    const a = ACTIONS.find((x) => x.id === "author");
    if (!a) throw new Error("no author action");
    return a.build(p, ctx);
  };

  it("streams, because it drives a browser for as long as the flow takes", () => {
    expect(ACTIONS.find((a) => a.id === "author")?.streams).toBe(true);
  });

  it("builds a plain authoring command", () => {
    expect(build({ investigation: "INV-001" })).toEqual(["author", "--investigation", "INV-001"]);
  });

  it("carries the answer back to the session that asked", () => {
    const argv = build({
      investigation: "INV-001",
      resume: "6b46d147-fbf4-4c67-bdc4-21977188e01e",
      answer: "the one in the confirmation dialog, not the row",
    });
    expect(argv[argv.indexOf("--resume") + 1]).toBe("6b46d147-fbf4-4c67-bdc4-21977188e01e");
    expect(argv[argv.indexOf("--answer") + 1]).toBe(
      "the one in the confirmation dialog, not the row"
    );
  });

  it("accepts an answer that spans lines, because the composer invites one", () => {
    // The page says "Shift+Enter for a new line" and then refused the result with "answer must be
    // the answer you typed". The original reason — a newline making an answer look like a second
    // argument — is not true here: the CLI is spawned with an argv array and no shell.
    for (const good of [
      "use this url:\nhttps://shop.example/cart",
      "first\nsecond\nthird",
      "url:\thttps://shop.example",
    ]) {
      expect(
        () => build({ investigation: "INV-001", resume: "abc12345", answer: good }),
        JSON.stringify(good)
      ).not.toThrow();
    }
  });

  it("still refuses the control characters that are never typed on purpose", () => {
    for (const bad of ["bell\u0007", "nul\u0000here", "esc\u001b[31m"]) {
      expect(
        () => build({ investigation: "INV-001", resume: "abc12345", answer: bad }),
        JSON.stringify(bad)
      ).toThrow(ParamError);
    }
  });

  it("accepts ordinary prose, including punctuation and non-English text", () => {
    for (const good of [
      "the one in the dialog",
      "account is 9876543210 — the QA one",
      "इसे हिंदी में भी चलना चाहिए",
      "it's the “Delete” button (top right)",
    ]) {
      expect(
        () => build({ investigation: "INV-001", resume: "abc12345", answer: good }),
        good
      ).not.toThrow();
    }
  });

  it("refuses a resume id that is not a session id", () => {
    expect(() => build({ investigation: "INV-001", resume: "../../etc", answer: "x" })).toThrow(
      ParamError
    );
  });

  it("requires an answer whenever it is resuming", () => {
    // Resuming without one would continue the session with an empty message, which reads to the
    // model as the operator saying nothing.
    expect(() => build({ investigation: "INV-001", resume: "abc12345" })).toThrow(ParamError);
  });
});

describe("approving the plan", () => {
  it("plans by default — a bare author call never opens a browser", () => {
    const argv = build("author", { investigation: "INV-001" });
    expect(argv).not.toContain("--approve-plan");
    expect(argv).not.toContain("--resume");
  });

  it("passes the approval through, and the operator's corrections with it", () => {
    const argv = build("author", {
      investigation: "INV-001",
      approvePlan: true,
      answer: "sign in first, and ask me for the new password",
    });
    expect(argv).toContain("--approve-plan");
    expect(argv[argv.indexOf("--answer") + 1]).toBe(
      "sign in first, and ask me for the new password"
    );
  });

  it("accepts approval with no corrections", () => {
    const argv = build("author", { investigation: "INV-001", approvePlan: true });
    expect(argv).toContain("--approve-plan");
    expect(argv).not.toContain("--answer");
  });
});
