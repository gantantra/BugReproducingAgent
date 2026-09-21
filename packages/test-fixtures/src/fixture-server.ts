import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Fixture apps for the M1 reliability gate.
 *
 * Constraints (docs/architecture/reliability-strategy.md):
 *  - Plain Node HTTP, standard library only, bound to 127.0.0.1:0. No public network, no fixed
 *    ports, so there is no port-collision flake.
 *  - The intermittent fixture is SEEDED, not random: given the seed, whether a run fails is a
 *    pure function, so the gate asserts an exact failing set rather than a statistical range.
 *  - The intermittent mechanism is a real race between two async in-page fetches whose ordering
 *    is decided by seeded server-side delays, so M4 has a genuine injected difference to detect
 *    rather than a coin flip.
 *
 * This package imports no AI code (ADR-0006).
 */

export type FixtureKind =
  | "passing"
  | "product-failing-deterministic"
  | "product-failing-intermittent"
  | "product-failing-counter"
  | "product-failing-when-slow"
  | "automation-failing"
  | "infrastructure-failing"
  | "straddling-requests"
  | "sensitive";

export interface FixtureHandle {
  kind: FixtureKind;
  baseUrl: string;
  origin: string;
  port: number;
  close: () => Promise<void>;
}

/**
 * Seeded failure decision for the intermittent fixture. Pure: same seed, same verdict, on any
 * machine. The gate calls `intermittentFails(seed)` to compute the exact expected failing set.
 */
export function intermittentFails(seed: number): boolean {
  // mulberry32 one step, matching packages/core SeededRng so the fixture and the harness agree.
  let s = (seed + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const v = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  s = 0;
  // Target incidence ~20%, high enough that a 60-run batch is informative.
  return v < 0.2;
}

export const INTERMITTENT_TARGET_RATE = 0.2;

const SHELL = (body: string, script: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>fixture</title></head>
<body>${body}<script>${script}</script></body></html>`;

const SEARCH_BODY = `
<h1>Search results</h1>
<button data-testid="filter-verified" type="button">Verified</button>
<div id="results"></div>`;

function send(res: ServerResponse, status: number, contentType: string, body: string): void {
  res.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
  res.end(body);
}

function json(
  res: ServerResponse,
  status: number,
  value: unknown,
  extraHeaders: Record<string, string> = {}
): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(JSON.stringify(value));
}

function seedOf(url: URL): number {
  const raw = url.searchParams.get("seed");
  const n = raw === null ? 0 : Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

/** Client script shared by the search fixtures. Renders three cards on filter click. */
const PASSING_SCRIPT = `
  const results = document.getElementById('results');
  const render = (items) => {
    results.innerHTML = items.map(function (i) {
      return '<div data-testid="result-card">' + i + '</div>';
    }).join('');
  };
  document.getElementById('results').setAttribute('data-ready', '1');
  document.querySelector('[data-testid="filter-verified"]').addEventListener('click', function () {
    fetch('/api/filter').then(function (r) { return r.json(); }).then(function (d) { render(d.items); });
  });
`;

/** Always logs the error and renders zero cards. Deterministic product failure. */
const DETERMINISTIC_FAIL_SCRIPT = `
  const results = document.getElementById('results');
  document.querySelector('[data-testid="filter-verified"]').addEventListener('click', function () {
    fetch('/api/filter').then(function (r) { return r.json(); }).then(function () {
      console.error('applyFilters: results undefined');
      results.innerHTML = '';
    });
  });
`;

/**
 * The real race. Two fetches are in flight; the page renders whichever resolves last. When the
 * initial response lands AFTER the filter response, it overwrites the filtered list with an
 * empty one and logs the error. Server-side delays are seeded, so the ordering — and therefore
 * the failure — is a pure function of the seed.
 */
const INTERMITTENT_SCRIPT = `
  const results = document.getElementById('results');
  const render = (items) => {
    results.innerHTML = items.map(function (i) {
      return '<div data-testid="result-card">' + i + '</div>';
    }).join('');
  };
  const seed = new URLSearchParams(location.search).get('seed') || '0';
  const initial = fetch('/api/initial?seed=' + seed).then(function (r) { return r.json(); });
  document.querySelector('[data-testid="filter-verified"]').addEventListener('click', function () {
    // Deterministic ordering: render the filtered list, THEN apply the initial response.
    // Whether the initial response is "late" is a pure function of the seed, so whether this
    // run fails is decided by the seed rather than by machine timing.
    fetch('/api/filter?seed=' + seed)
      .then(function (r) { return r.json(); })
      .then(function (d) { render(d.items); })
      .then(function () { return initial; })
      .then(function (d) {
        if (d.late) {
          console.error('applyFilters: results undefined');
          results.innerHTML = '';
        }
      });
  });
`;

/**
 * Every third filter comes back empty and the page logs the error. The count is kept by the
 * server, so a suite repeated N times against one fixture fails on exactly runs 3, 6, 9, ... --
 * an intermittent failure whose every instance is known in advance, for the rerun gate.
 */
const COUNTER_SCRIPT = `
  const results = document.getElementById('results');
  document.querySelector('[data-testid="filter-verified"]').addEventListener('click', function () {
    fetch('/api/filter-counted').then(function (r) { return r.json(); }).then(function (d) {
      if (!d.items.length) console.error('applyFilters: results undefined');
      results.innerHTML = d.items.map(function (i) {
        return '<div data-testid="result-card">' + i + '</div>';
      }).join('');
    });
  });
`;

/**
 * Fails only on a slow network: the page gives the filter response `SLOW_FAIL_AFTER_MS` to arrive,
 * then gives up, logs the error and empties the list. On loopback the response takes a few
 * milliseconds, so the page always passes -- until a confirmation slows the network, when it
 * always fails. A condition with a known answer, for the confirmation gate.
 */
export const SLOW_FAIL_AFTER_MS = 300;

const WHEN_SLOW_SCRIPT = `
  const results = document.getElementById('results');
  document.querySelector('[data-testid="filter-verified"]').addEventListener('click', function () {
    let settled = false;
    setTimeout(function () {
      if (settled) return;
      settled = true;
      console.error('applyFilters: gave up waiting for results');
      results.innerHTML = '';
    }, ${SLOW_FAIL_AFTER_MS});
    fetch('/api/filter').then(function (r) { return r.json(); }).then(function (d) {
      if (settled) return;
      settled = true;
      results.innerHTML = d.items.map(function (i) {
        return '<div data-testid="result-card">' + i + '</div>';
      }).join('');
    });
  });
`;

/** Every `COUNTER_FAILS_EVERY`th filter request of a counter fixture returns no results. */
export const COUNTER_FAILS_EVERY = 3;

function handler(kind: FixtureKind, state: { filters: number } = { filters: 0 }) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/api/filter-counted") {
      state.filters += 1;
      const empty = state.filters % COUNTER_FAILS_EVERY === 0;
      json(res, 200, { items: empty ? [] : ["alpha", "beta", "gamma"], n: state.filters });
      return;
    }

    if (url.pathname === "/__meta/expected") {
      const seed = seedOf(url);
      json(res, 200, {
        seed,
        fails: intermittentFails(seed),
        targetRate: INTERMITTENT_TARGET_RATE,
      });
      return;
    }

    if (url.pathname === "/api/filter") {
      const seed = seedOf(url);
      const delay = kind === "product-failing-intermittent" ? (seed % 7) + 1 : 0;
      setTimeout(() => json(res, 200, { items: ["alpha", "beta", "gamma"] }), delay);
      return;
    }

    if (url.pathname === "/api/initial") {
      const seed = seedOf(url);
      const late = intermittentFails(seed);
      // A late initial response is what loses the race and clears the list.
      const delay = late ? 40 : 1;
      setTimeout(() => json(res, 200, { items: [], late }), delay);
      return;
    }

    // Endpoints for the straddling-requests fixture (reliability test 4).
    if (url.pathname === "/api/slow") {
      setTimeout(() => json(res, 200, { ok: true }), 300);
      return;
    }
    if (url.pathname === "/api/quick") {
      json(res, 200, { ok: true });
      return;
    }

    if (url.pathname !== "/" && url.pathname !== "/search") {
      send(res, 404, "text/plain", "not found");
      return;
    }

    switch (kind) {
      case "passing":
        send(res, 200, "text/html", SHELL(SEARCH_BODY, PASSING_SCRIPT));
        return;
      case "product-failing-deterministic":
        send(res, 200, "text/html", SHELL(SEARCH_BODY, DETERMINISTIC_FAIL_SCRIPT));
        return;
      case "product-failing-intermittent":
        send(res, 200, "text/html", SHELL(SEARCH_BODY, INTERMITTENT_SCRIPT));
        return;
      case "product-failing-counter":
        send(res, 200, "text/html", SHELL(SEARCH_BODY, COUNTER_SCRIPT));
        return;
      case "product-failing-when-slow":
        send(res, 200, "text/html", SHELL(SEARCH_BODY, WHEN_SLOW_SCRIPT));
        return;
      case "automation-failing":
        // The approved selector never exists: no button with the accessible name "Verified".
        send(res, 200, "text/html", SHELL(`<h1>Search results</h1><div id="results"></div>`, ""));
        return;
      case "straddling-requests":
        send(
          res,
          200,
          "text/html",
          SHELL(
            SEARCH_BODY,
            `
            fetch('/api/quick');
            document.querySelector('[data-testid="filter-verified"]').addEventListener('click', function () {
              fetch('/api/slow');
              fetch('/api/quick');
            });
            window.addEventListener('load', function () { setTimeout(function () { fetch('/api/quick'); }, 5); });
            `
          )
        );
        return;
      case "sensitive":
        // Emits every shape the redaction gate checks for.
        res.writeHead(200, {
          "content-type": "text/html",
          "set-cookie": "sessionid=s3cr3tSESSIONvalue9876; Path=/; HttpOnly",
          "cache-control": "no-store",
        });
        res.end(
          SHELL(
            `<h1>Account</h1><div id="results"></div>`,
            `
            window.localStorage.setItem('authToken', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk');
            window.localStorage.setItem('cartCount', '3');
            console.log('token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk');
            fetch('/api/profile?access_token=AKIAIOSFODNN7EXAMPLEKEY123&q=laptop', {
              headers: { 'Authorization': 'Bearer AKIAIOSFODNN7EXAMPLEKEY123456789' }
            });
            `
          )
        );
        return;
      case "infrastructure-failing":
        // Unreachable: handled by destroying the socket before any response.
        res.destroy();
        return;
    }
  };
}

/** Profile endpoint for the sensitive fixture, returning PII in a JSON body. */
function sensitiveApi(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/api/profile") return false;
  json(res, 200, {
    email: "real.user@company-domain.example",
    phone: "9876543210",
    card: "4111111111111111",
    pan: "ABCDE1234F",
    plan: "gold",
  });
  return true;
}

export async function startFixture(kind: FixtureKind): Promise<FixtureHandle> {
  // Per server, not per request: the counter fixture counts across the whole batch.
  const state = { filters: 0 };
  const server: Server =
    kind === "infrastructure-failing"
      ? createServer()
      : createServer((req, res) => {
          if (kind === "sensitive" && sensitiveApi(req, res)) return;
          handler(kind, state)(req, res);
        });

  if (kind === "infrastructure-failing") {
    // Accept the TCP connection, then destroy the socket before any HTTP response. This fails
    // at the transport layer BEFORE the first successful navigation, which is exactly what
    // distinguishes rule 2 (infrastructure) from rule 3 (automation).
    server.on("connection", (socket) => socket.destroy());
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  return {
    kind,
    port,
    origin,
    baseUrl: `${origin}/`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
