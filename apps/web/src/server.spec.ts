import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createInvestigatorServer, mintToken } from "./server.js";

describe("investigator web server endpoints", () => {
  const token = mintToken();
  const testDir = join(tmpdir(), `investigator-test-${Date.now()}`);
  let server: ReturnType<typeof createInvestigatorServer>;
  let baseUrl = "";
  let sessionCookie = "";

  beforeAll(async () => {
    mkdirSync(testDir, { recursive: true });
    const dummyCli = join(testDir, "dummy-cli.js");
    writeFileSync(dummyCli, 'console.log("{}");');

    server = createInvestigatorServer({
      workspace: testDir,
      cliBin: dummyCli,
      port: 0,
      token,
      launchDir: testDir,
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("acquires session and reports 2-hour default TTL", async () => {
    const res = await fetch(`${baseUrl}/api/session`, {
      headers: { "x-investigator-token": token },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; ttlMs: number; sessionFolder: string };
    expect(data.ok).toBe(true);
    expect(data.ttlMs).toBe(7_200_000);

    const setCookie = res.headers.get("set-cookie") || "";
    const m = setCookie.match(/investigator_session=([^;]+)/);
    expect(m).toBeTruthy();
    sessionCookie = m![1];

    const sessionDir = join(testDir, "sessions", data.sessionFolder);
    mkdirSync(join(sessionDir, "authoring", "mcp"), { recursive: true });
    writeFileSync(
      join(sessionDir, "authoring", "mcp", "page-1.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47])
    );
    writeFileSync(join(sessionDir, "authoring", "secret.txt"), "secret");
    const realMcpDir = join(
      sessionDir,
      ".investigator",
      "investigations",
      "INV-002",
      "authoring",
      "mcp"
    );
    mkdirSync(realMcpDir, { recursive: true });
    writeFileSync(join(realMcpDir, "page-1.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it("serves a screenshot where an authoring session really writes it", async () => {
    // The exact query `author` emits: relative to the session folder, through `.investigator`.
    const file = encodeURIComponent(
      ".investigator/investigations/INV-002/authoring/mcp/page-1.png"
    );
    const res = await fetch(`${baseUrl}/api/session-image?file=${file}&token=${token}`, {
      headers: { cookie: `investigator_session=${sessionCookie}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  it("serves session images securely via /api/session-image", async () => {
    const res = await fetch(`${baseUrl}/api/session-image?file=authoring/mcp/page-1.png`, {
      headers: {
        "x-investigator-token": token,
        cookie: `investigator_session=${sessionCookie}`,
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const buf = await res.arrayBuffer();
    expect(new Uint8Array(buf)[0]).toBe(0x89);
  });

  it("rejects non-image files via /api/session-image", async () => {
    const res = await fetch(`${baseUrl}/api/session-image?file=authoring/secret.txt`, {
      headers: {
        "x-investigator-token": token,
        cookie: `investigator_session=${sessionCookie}`,
      },
    });
    expect(res.status).toBe(403);
  });

  it("rejects missing file param via /api/session-image", async () => {
    const res = await fetch(`${baseUrl}/api/session-image`, {
      headers: {
        "x-investigator-token": token,
        cookie: `investigator_session=${sessionCookie}`,
      },
    });
    expect(res.status).toBe(400);
  });

  it("rejects non-existent file via /api/session-image", async () => {
    const res = await fetch(`${baseUrl}/api/session-image?file=authoring/mcp/missing.png`, {
      headers: {
        "x-investigator-token": token,
        cookie: `investigator_session=${sessionCookie}`,
      },
    });
    expect(res.status).toBe(404);
  });

  it("refuses path traversal via /api/session-image", async () => {
    const res = await fetch(`${baseUrl}/api/session-image?file=../../outside.png`, {
      headers: {
        "x-investigator-token": token,
        cookie: `investigator_session=${sessionCookie}`,
      },
    });
    expect(res.status).toBe(404);
  });

  it("lists empty credentials initially", async () => {
    const res = await fetch(`${baseUrl}/api/credentials`, {
      headers: {
        "x-investigator-token": token,
        cookie: `investigator_session=${sessionCookie}`,
      },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; names: string[]; entries: any[] };
    expect(data.ok).toBe(true);
    expect(data.names).toEqual([]);
    expect(data.entries).toEqual([]);
  });

  it("adds credentials via POST /api/credentials with description", async () => {
    const res = await fetch(`${baseUrl}/api/credentials`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-investigator-token": token,
        cookie: `investigator_session=${sessionCookie}`,
      },
      body: JSON.stringify({
        name: "CUSTOM_TOKEN",
        value: "super-secret-token-123",
        description: "API access token",
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      ok: boolean;
      name: string;
      names: string[];
      entries: any[];
    };
    expect(data.ok).toBe(true);
    expect(data.name).toBe("CUSTOM_TOKEN");
    expect(data.names).toContain("CUSTOM_TOKEN");
    expect(data.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "CUSTOM_TOKEN",
          description: "API access token",
        }),
      ])
    );
  });

  it("extracts and stores arbitrary credentials via POST /api/credentials/extract", async () => {
    const res = await fetch(`${baseUrl}/api/credentials/extract`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-investigator-token": token,
        cookie: `investigator_session=${sessionCookie}`,
      },
      body: JSON.stringify({
        text: "use phone number 1111111170 and otp is 7982",
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      ok: boolean;
      referencedText: string;
      extracted: Array<{ name: string; description: string }>;
      names: string[];
      entries: any[];
    };
    expect(data.ok).toBe(true);
    expect(data.extracted.length).toBeGreaterThanOrEqual(2);
    const extractedNames = data.extracted.map((e) => e.name);
    expect(extractedNames).toContain("ACCOUNT_PHONE");
    expect(extractedNames).toContain("ACCOUNT_OTP");
    expect(data.names).toContain("ACCOUNT_PHONE");
    expect(data.names).toContain("ACCOUNT_OTP");
    // The whole reply comes back for the model, with the values replaced and nothing else lost.
    expect(data.referencedText).toBe("use phone number ACCOUNT_PHONE and otp is ACCOUNT_OTP");
    expect(JSON.stringify(data)).not.toContain("1111111170");
    expect(JSON.stringify(data)).not.toContain("7982");
  });

  it("deletes a credential via DELETE /api/credentials", async () => {
    const res = await fetch(`${baseUrl}/api/credentials?name=CUSTOM_TOKEN`, {
      method: "DELETE",
      headers: {
        "x-investigator-token": token,
        cookie: `investigator_session=${sessionCookie}`,
      },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; removed: boolean; names: string[] };
    expect(data.ok).toBe(true);
    expect(data.removed).toBe(true);
    expect(data.names).not.toContain("CUSTOM_TOKEN");
  });
});
