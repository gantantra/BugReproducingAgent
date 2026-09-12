/* Investigator chat UI.
 *
 * This file renders and sequences. It decides nothing about the investigation: every step calls an
 * allowlisted action, the server spawns the real `investigate` command, and what comes back is
 * displayed as-is. Where the CLI refuses -- an unapproved gate, an unimplemented milestone, an
 * invalid AI output -- the refusal is shown, never worked around.
 */
(() => {
  "use strict";

  const TOKEN = document.body.dataset.token;
  const WORKSPACE = document.body.dataset.workspace;

  const el = {
    transcript: document.getElementById("transcript"),
    input: document.getElementById("input"),
    send: document.getElementById("send"),
    rail: document.getElementById("rail"),
    waiting: document.getElementById("waiting"),
    waitingLabel: document.getElementById("waitingLabel"),
    waitingElapsed: document.getElementById("waitingElapsed"),
    ws: document.getElementById("ws"),
    provider: document.getElementById("provider"),
    inv: document.getElementById("inv"),
  };

  /* What the agent is doing while you wait on each step. The pipeline now appears only against
   * the loader: a permanent rail across the top is scenery once you have read it, whereas the
   * moment you are actually waiting is exactly when "where am I, and what is it doing?" is a real
   * question. */
  const BUSY_LABEL = {
    describe: "Storing your report…",
    interpret: "Reading the report into a structured flow…",
    clarify: "Re-reading the report with your answers…",
    propose: "Proposing experiments…",
    approve: "Recording your decision…",
    record: "Running in Chromium…",
    repeat: "Running the repetitions…",
    rca: "Contrasting the runs…",
  };

  const STEPS = [
    ["describe", "1 · Describe"],
    ["interpret", "2 · Interpret"],
    ["clarify", "3 · Clarify"],
    ["propose", "4 · Propose"],
    ["approve", "5 · Approve"],
    ["record", "6 · Record & review"],
    ["repeat", "7 · Repeat N"],
    ["rca", "8 · Analyse"],
  ];

  const state = {
    step: "describe",
    done: new Set(),
    investigation: null,
    reportPath: null,
    reportText: "",
    flow: null,
    proposalChecksum: null,
    gate: "experiment_selection",
    aiReady: false,
    busy: false,
    awaiting: null, // a pending question handler for the next user message
    // The transcript, as semantics rather than DOM, so a refresh can rebuild it.
    log: [],
    // What the interview has collected, so it can go back into the report in one go.
    answers: [],
    pendingUnknowns: [],
    targetName: null,
  };

  // Set while rebuilding a restored transcript, so replaying does not re-record it.
  let replaying = false;
  // The card currently being filled, so kv() can attach its rows to the right log entry.
  let openEntry = null;
  let persistTimer = null;
  let heartbeat = null;

  // ---------------------------------------------------------------------------------------- api

  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: {
        "content-type": "application/json",
        "x-investigator-token": TOKEN,
        ...(options.headers || {}),
      },
    });
    const body = await res.json().catch(() => ({ ok: false, message: "unreadable response" }));
    if (!res.ok && body.ok !== true) body.ok = false;
    return body;
  }

  let authLossShown = false;

  /** A token from before a restart. Say so plainly, and never more than once. */
  function isAuthLoss(body) {
    return body && body.ok === false && body.code === "FORBIDDEN";
  }

  function renderAuthLoss(pendingText) {
    if (authLossShown) return;
    authLossShown = true;
    setBusy(false);
    const c = card("The agent restarted", true);
    c.appendChild(
      node(
        "p",
        null,
        "This page is still holding the token it was given before the restart, so the server refused the request. Refresh to pick up the current one — the conversation is stored against your session and comes back with it."
      )
    );
    if (pendingText) {
      el.input.value = pendingText;
      c.appendChild(node("p", null, "Your message is back in the box, so nothing is lost."));
    }
    buttons(c, [{ label: "Refresh", kind: "primary", onClick: () => window.location.reload() }]);
  }

  function act(action, params = {}) {
    return api("/api/action", { method: "POST", body: JSON.stringify({ action, params }) });
  }

  // ------------------------------------------------------------------------------------ session

  /* The transcript lives on the server, keyed by a session cookie, so a refresh resumes where the
   * operator left off. Writes are debounced: typing a report should not be a request per keystroke,
   * and nothing here is the source of truth anyway — the investigation itself is already durable in
   * the workspace database. */
  function schedulePersist() {
    if (replaying) return;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void api("/api/session/state", {
        method: "POST",
        body: JSON.stringify({
          state: {
            log: state.log,
            investigation: state.investigation,
            reportText: state.reportText,
            reportPath: state.reportPath,
            proposalChecksum: state.proposalChecksum,
            step: state.step,
            done: [...state.done],
            aiReady: state.aiReady,
          },
        }),
      });
    }, 400);
  }

  function record(entry) {
    if (replaying) return entry;
    state.log.push(entry);
    schedulePersist();
    return entry;
  }

  /** Rebuild one recorded entry. Read-only: live controls come from the resume bar instead. */
  function renderEntry(entry) {
    if (entry.t === "say") {
      say(entry.text, entry.who);
      return;
    }
    if (entry.t === "card") {
      const c = card(entry.title, entry.bad);
      if (entry.pairs && entry.pairs.length) kv(c, entry.pairs);
    }
  }

  function restore(saved) {
    state.investigation = saved.investigation ?? null;
    state.reportText = saved.reportText ?? "";
    state.reportPath = saved.reportPath ?? null;
    state.proposalChecksum = saved.proposalChecksum ?? null;
    state.aiReady = saved.aiReady === true;
    state.done = new Set(saved.done || []);
    state.step = saved.step || "describe";
    state.log = saved.log || [];

    replaying = true;
    try {
      for (const entry of state.log) renderEntry(entry);
    } finally {
      replaying = false;
    }

    renderRail();
    if (state.investigation) {
      el.inv.textContent = state.investigation;
      el.inv.className = "pill ok";
    }
    el.provider.textContent = state.aiReady ? "deepseek · ai ready" : "ai missing";
    el.provider.className = `pill ${state.aiReady ? "ok" : "bad"}`;
    renderResume();
  }

  /* A restored transcript is history: its buttons belonged to a page that no longer exists. Rather
   * than re-attach handlers to every replayed card, offer the one action that is actually next. */
  function renderResume() {
    const c = card("Session resumed");
    kv(c, [
      ["investigation", state.investigation || "not opened yet"],
      ["at step", state.step],
      ["messages restored", state.log.length],
    ]);
    c.appendChild(
      node(
        "p",
        null,
        "The transcript above is restored history, so its buttons are not live. Continue from here."
      )
    );

    const choices = [];
    if (state.investigation) {
      choices.push({
        label: "Propose experiments",
        kind: "primary",
        onClick: () => offerPropose(),
      });
      choices.push({
        label: "Analyse what ran",
        onClick: () => analyse(state.aiReady),
      });
    }
    choices.push({
      label: "Start over",
      kind: "danger",
      onClick: async () => {
        await api("/api/session/release", { method: "POST" });
        window.location.reload();
      },
    });
    buttons(c, choices);
  }

  /** Another tab on this machine holds the session. Say so, and offer nothing that would race it. */
  function renderBusy(info) {
    el.transcript.replaceChildren();
    setBusy(true);
    el.provider.textContent = "session in use";
    el.provider.className = "pill bad";

    const c = card("Another session is already running", true);
    c.appendChild(
      node(
        "p",
        null,
        info.message ||
          "Another session is already running on your machine. Close that tab or window first, then refresh here to use the agent."
      )
    );
    kv(c, [
      ["held since", info.heldSince ? new Date(info.heldSince).toLocaleTimeString() : "—"],
      ["last seen", info.lastSeenAt ? new Date(info.lastSeenAt).toLocaleTimeString() : "—"],
      [
        "frees itself in",
        info.expiresInMs != null
          ? `${Math.ceil(info.expiresInMs / 1000)}s if that tab is gone`
          : "—",
      ],
    ]);
    c.appendChild(
      node(
        "p",
        null,
        "Only one session runs at a time because two would issue commands into the same workspace database and the same investigation, and each transcript would be missing half of what happened."
      )
    );
    buttons(c, [{ label: "Retry", kind: "primary", onClick: () => window.location.reload() }]);
  }

  function startHeartbeat(ttlMs) {
    const every = Math.max(5000, Math.floor((ttlMs || 60000) / 3));
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = setInterval(async () => {
      const r = await api("/api/session/heartbeat", { method: "POST" });
      if (r.ok === false && r.code === "SESSION_EXPIRED") {
        clearInterval(heartbeat);
        heartbeat = null;
        const c = card("Session expired", true);
        c.appendChild(node("p", null, "This session lapsed. Refresh to start a new one."));
        buttons(c, [
          { label: "Refresh", kind: "primary", onClick: () => window.location.reload() },
        ]);
      }
    }, every);
  }

  /* SSE over fetch. EventSource cannot send an Authorization-style header, and putting the token
   * in the URL would leak it into history; streaming the body by hand keeps it in a header. */
  async function streamJob(jobId, onLog, onDone) {
    const res = await fetch(`/api/job/${jobId}/events`, {
      headers: { "x-investigator-token": TOKEN },
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() || "";
      for (const frame of frames) {
        const evMatch = frame.match(/^event: (.+)$/m);
        const dataMatch = frame.match(/^data: (.+)$/m);
        if (!evMatch || !dataMatch) continue;
        let payload;
        try {
          payload = JSON.parse(dataMatch[1]);
        } catch {
          continue;
        }
        if (evMatch[1] === "log") onLog(payload.line);
        else if (evMatch[1] === "done") onDone(payload);
      }
    }
  }

  // ------------------------------------------------------------------------------------ render

  function node(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function scroll() {
    const main = document.querySelector("main");
    main.scrollTop = main.scrollHeight;
  }

  function message(who, label) {
    const wrap = node("div", `msg ${who}`);
    wrap.appendChild(node("div", "who", label || who));
    const body = node("div", "body");
    wrap.appendChild(body);
    el.transcript.appendChild(wrap);
    scroll();
    return body;
  }

  function say(text, who = "agent") {
    const body = message(who, who === "agent" ? "agent" : "you");
    for (const para of String(text).split("\n\n")) {
      const p = node("p", null, para);
      p.style.margin = "0 0 8px";
      body.appendChild(p);
    }
    scroll();
    record({ t: "say", who, text: String(text) });
    return body;
  }

  function card(title, bad) {
    const body = message("agent", "agent");
    const c = node("div", `card${bad ? " bad" : ""}`);
    c.appendChild(node("h3", null, title));
    const inner = node("div", "inner");
    c.appendChild(inner);
    body.appendChild(c);
    scroll();
    openEntry = record({ t: "card", title, bad: !!bad, pairs: [] });
    return inner;
  }

  function kv(parent, pairs) {
    const dl = node("dl", "kv");
    for (const [k, v] of pairs) {
      if (v === undefined || v === null || v === "") continue;
      dl.appendChild(node("dt", null, k));
      dl.appendChild(node("dd", null, String(v)));
    }
    parent.appendChild(dl);
    // Attach the rows to the card that opened them, so a replay shows the substance and not an
    // empty heading. Values are stringified here because that is what a replay will render.
    if (openEntry && !replaying) {
      for (const [k, v] of pairs) {
        if (v === undefined || v === null || v === "") continue;
        openEntry.pairs.push([k, String(v)]);
      }
      schedulePersist();
    }
    return dl;
  }

  function buttons(parent, defs) {
    const row = node("div", "row");
    for (const d of defs) {
      const b = node("button", d.kind || "", d.label);
      b.addEventListener("click", async () => {
        [...row.querySelectorAll("button")].forEach((x) => (x.disabled = true));
        await d.onClick(row);
      });
      row.appendChild(b);
    }
    parent.appendChild(row);
    return row;
  }

  function renderRail() {
    el.rail.replaceChildren();
    for (const [id, label] of STEPS) {
      // Active wins over done. The pipeline is walked backwards routinely — answering an unknown
      // returns to Interpret — and a step you are sitting on must not render as finished just
      // because it was finished once.
      const cls = state.step === id ? "step active" : state.done.has(id) ? "step done" : "step";
      el.rail.appendChild(node("div", cls, label));
    }
  }

  function setStep(id) {
    const order = STEPS.map((s) => s[0]);
    for (const s of order) {
      if (s === id) break;
      state.done.add(s);
    }
    // Re-entering a step un-finishes it, so the state matches what is shown.
    state.done.delete(id);
    state.step = id;
    if (!el.waiting.hidden) {
      renderRail();
      el.waitingLabel.textContent = BUSY_LABEL[state.step] || "Working…";
    }
  }

  let waitingSince = 0;
  let waitingTimer = null;

  /**
   * Busy is the only time the pipeline is shown. `label` overrides the step's default wording for
   * a wait that is not simply "the current step" — recording a target, say.
   */
  function setBusy(on, label) {
    state.busy = on;
    el.send.disabled = on;
    el.input.disabled = on;

    if (!on) {
      el.waiting.hidden = true;
      if (waitingTimer) clearInterval(waitingTimer);
      waitingTimer = null;
      return;
    }

    el.waitingLabel.textContent = label || BUSY_LABEL[state.step] || "Working…";
    renderRail();
    el.waiting.hidden = false;

    // Some of these take minutes. A counter is the difference between "it is thinking" and
    // "it has hung", which is otherwise indistinguishable from a spinner alone.
    waitingSince = Date.now();
    el.waitingElapsed.textContent = "0s";
    if (waitingTimer) clearInterval(waitingTimer);
    waitingTimer = setInterval(() => {
      el.waitingElapsed.textContent = `${Math.round((Date.now() - waitingSince) / 1000)}s`;
    }, 1000);
  }

  /** Render a CLI failure exactly as the CLI reported it. */
  function showFailure(result, contextLabel) {
    const c = card(contextLabel || "Refused", true);
    const pairs = [
      ["code", result.code],
      ["message", result.message],
      ["exit", result.exitCode],
    ];
    if (result.context && result.context.milestone) {
      pairs.push(["arrives in", result.context.milestone]);
    }
    kv(c, pairs);
    if (result.code === "NOT_IMPLEMENTED") {
      c.appendChild(
        node(
          "p",
          null,
          "This step is part of the frozen command contract but is not built yet. It is shown rather than hidden so the pipeline's real extent is visible."
        )
      );
    }
    return c;
  }

  /** Unwrap the server envelope into the CLI's own JSON. */
  function resultOf(response) {
    if (isAuthLoss(response)) renderAuthLoss(null);
    if (!response || response.ok === false)
      return response || { ok: false, message: "no response" };
    return response.result || response;
  }

  // ------------------------------------------------------------------------------------- steps

  async function checkProvider() {
    const r = resultOf(await act("doctor"));
    if (r.ok !== true) {
      el.provider.textContent = "cli error";
      el.provider.className = "pill bad";
      showFailure(r, "doctor failed");
      return;
    }
    const cfg = r.config || {};
    state.aiReady = cfg.aiConfig === "configured" && cfg.apiKeyConfigured === true;
    el.provider.textContent = `${cfg.provider || "?"} · ${state.aiReady ? "ai ready" : "ai missing"}`;
    el.provider.className = `pill ${state.aiReady ? "ok" : "bad"}`;
    setBusy(false);
    if (!state.aiReady) {
      const c = card("DeepSeek is not configured", true);
      kv(c, [
        ["key variable", cfg.apiKeyEnv],
        ["key present", String(cfg.apiKeyConfigured)],
        ["missing", (cfg.aiConfigMissing || []).join(", ") || "—"],
      ]);
      c.appendChild(
        node(
          "p",
          null,
          "Interpretation and analysis need this. Everything deterministic still works without it."
        )
      );
    }
  }

  async function submitReport(text) {
    setBusy(true);
    const wrote = await api("/api/report", {
      method: "POST",
      body: JSON.stringify({ text, name: "report.md" }),
    });
    if (wrote.ok !== true) {
      if (isAuthLoss(wrote)) {
        renderAuthLoss(text);
        return;
      }
      showFailure(wrote, "Could not store the report");
      setBusy(false);
      return;
    }
    state.reportPath = wrote.path;
    state.reportText = text;
    say(`Stored your report (${wrote.bytes} bytes). Interpreting it into a structured Flow…`);

    setStep("interpret");
    const r = resultOf(
      await act("intake", {
        from: wrote.path,
        title: firstLine(text),
        ai: state.aiReady,
        // A target is bound to an investigation AT INTAKE. Recording one in config is not enough:
        // without this the investigation reads `target (none)` and the constraints tool has
        // nothing to answer with, which is the NOT_FOUND that stops planning.
        ...(state.targetName ? { env: state.targetName } : {}),
      })
    );
    setBusy(false);

    if (r.ok !== true) {
      showFailure(r, "Intake failed");
      return;
    }
    state.investigation = r.investigationId || r.investigation || null;
    el.inv.textContent = state.investigation || "no investigation";
    el.inv.className = "pill ok";
    await renderFlow(r);
  }

  function firstLine(text) {
    const line = text.split("\n").find((l) => l.trim());
    return (line || "Reported issue")
      .replace(/[^A-Za-z0-9 ._\-()]/g, " ")
      .slice(0, 110)
      .trim();
  }

  /* `intake --json` returns counts for steps and unknowns, the failure point in full, and the
   * content hash of the stored flow artifact. The detail lives in that artifact, so fetch it
   * rather than inventing a shape the CLI does not emit. */
  async function fetchFlowArtifact(sha) {
    if (!sha) return null;
    const clean = String(sha).replace(/^sha256:/, "");
    try {
      const res = await fetch(
        `/api/artifact?investigation=${encodeURIComponent(state.investigation)}&kind=flow&sha=${encodeURIComponent(clean)}`,
        { headers: { "x-investigator-token": TOKEN } }
      );
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  async function renderFlow(r) {
    const summary = r.flow || null;

    const c = card("Interpreted flow");
    kv(c, [
      ["investigation", state.investigation],
      ["report", r.reportArtifactId],
      ["bytes", r.bytes],
      ["redacted", r.redacted === true ? "yes" : "no"],
      ["flow", summary && summary.flowId],
      ["steps", summary && summary.steps],
      ["unknowns", summary && summary.unknowns],
      ["interpreted by", summary ? "intake_to_flow" : "not interpreted"],
    ]);

    if (!summary) {
      c.appendChild(
        node(
          "p",
          null,
          "The report was stored but not interpreted, so there is no flow to review. Configure DeepSeek to enable this step."
        )
      );
      offerPropose();
      return;
    }

    const fp = summary.suspectedFailurePoint;
    if (fp) {
      const h = node("h4", null, "Where it thinks this breaks");
      h.style.margin = "12px 0 4px";
      c.appendChild(h);
      kv(c, [
        ["what", fp.what],
        ["why", fp.why],
        ["at", `${fp.stepId || "?"} / ${fp.actionId || "?"}`],
        ["confidence", fp.confidence],
      ]);
      if (fp.sourceQuote) c.appendChild(node("div", "quote", `“${fp.sourceQuote}”`));
    }

    const full = await fetchFlowArtifact(summary.sha256);
    state.flow = full || summary;

    if (full && full.steps && full.steps.length) {
      const h = node("h4", null, "Proposed steps");
      h.style.margin = "12px 0 4px";
      c.appendChild(h);
      const ol = node("ol", "steps");
      for (const st of full.steps) {
        const li = node("li");
        li.appendChild(node("span", null, st.description || st.stepId));
        const actions = (st.actions || [])
          .map(
            (a) =>
              a.type + (a.url ? ` ${a.url}` : "") + (a.description ? ` “${a.description}”` : "")
          )
          .join(" → ");
        if (actions) {
          const sub = node("div", "mono", actions);
          sub.style.color = "var(--muted)";
          li.appendChild(sub);
        }
        ol.appendChild(li);
      }
      c.appendChild(ol);
    }

    const unknowns = (full && full.unknowns) || [];
    state.pendingUnknowns = unknowns.slice();
    state.answers = [];

    if (unknowns.length || summary.unknowns > 0) {
      setStep("clarify");
      const q = card(`${unknowns.length || summary.unknowns} things it could not infer`);
      if (unknowns.length) {
        const ul = node("ul", "plain");
        for (const u of unknowns) ul.appendChild(node("li", null, `${u.field} — ${u.why}`));
        q.appendChild(ul);
      }
      q.appendChild(
        node(
          "p",
          null,
          "It will not invent a URL, a selector or a credential. Press “Answer these now” and I will ask about them one at a time — type each reply in the box at the bottom and press Enter. Skip anything you do not know."
        )
      );
      buttons(q, [
        { label: "Answer these now", kind: "primary", onClick: () => askNextUnknown() },
        { label: "Skip to the target", onClick: () => askForTarget() },
      ]);
      return;
    }

    await askForTarget();
  }

  // --------------------------------------------------------------------------------- interview

  /* The point of the agent: find out what the reporter knows before planning anything. Every gap
   * the interpretation could not fill is put back to them as a question, and the answers are
   * folded into the REPORT and re-interpreted rather than patched into the flow. The report is the
   * grounded source; a flow edited behind the reporter's back is an invention with their name on
   * it. */
  function askNextUnknown() {
    const next = state.pendingUnknowns.shift();
    if (!next) {
      void finishInterview();
      return;
    }

    const c = card(`Question — ${next.field}`);
    c.appendChild(node("p", null, next.why));
    c.appendChild(
      node(
        "p",
        null,
        "Type your answer in the box at the bottom and press Enter. If you do not know it, skip it and it stays recorded as an unknown."
      )
    );
    buttons(c, [{ label: "Skip this one", onClick: () => askNextUnknown() }]);

    // Put the cursor where the answer goes. Being asked a question and having to find the box is
    // the kind of small friction that makes an interview feel like a form.
    el.input.placeholder = `Your answer — ${next.field}`;
    el.input.focus();

    state.awaiting = async (answer) => {
      state.awaiting = null;
      state.answers.push({ field: next.field, answer });
      askNextUnknown();
    };
  }

  const DEFAULT_PLACEHOLDER =
    "Describe the bug — the URL, the steps, what you expected, what happens instead, and how often.";

  async function finishInterview() {
    el.input.placeholder = DEFAULT_PLACEHOLDER;
    if (state.answers.length === 0) {
      await askForTarget();
      return;
    }
    const block = state.answers.map((a) => `- **${a.field}**: ${a.answer}`).join("\n");
    const count = state.answers.length;
    state.answers = [];
    say(`Thank you. Folding ${count} answer(s) back into the report and re-reading it…`);
    await submitReport(
      state.reportText + "\n\n## Answers to what could not be inferred\n\n" + block + "\n"
    );
  }

  /* Without a target the agent cannot plan at all: `get_application_constraints` returns NOT_FOUND
   * and the model correctly declines to propose experiments it cannot ground. Asking here is the
   * difference between the agent conducting the investigation and handing the operator a config
   * file to go and edit. */
  async function askForTarget() {
    if (state.targetName) {
      offerPropose();
      return;
    }
    const existing = await api("/api/targets");
    const targets = (existing && existing.targets) || [];
    if (targets.length > 0) {
      state.targetName = targets[0].name;
      say(`Using the configured target “${targets[0].name}” (${targets[0].baseUrl}).`);
      offerPropose();
      return;
    }

    const c = card("Where should I run this?");
    c.appendChild(
      node(
        "p",
        null,
        "I have no target for this workspace and I will not guess one. Give me the base URL, then tell me what kind of environment it is."
      )
    );

    const urlRow = node("div", "row");
    const url = document.createElement("input");
    url.type = "text";
    url.placeholder = "https://staging.example.com";
    url.style.flex = "1";
    url.style.minWidth = "260px";
    urlRow.appendChild(url);
    c.appendChild(urlRow);

    c.appendChild(
      node(
        "p",
        null,
        "There is deliberately no “production”. Choosing one of these is you asserting you are authorised to act on it. Destructive actions stay blocked either way — unblocking a delete needs a written justification at the approval gate."
      )
    );

    const choose = async (classification) => {
      setBusy(true, "Recording the target…");
      const written = await api("/api/targets", {
        method: "POST",
        body: JSON.stringify({
          name: `target-${classification}`,
          baseUrl: url.value.trim(),
          classification,
        }),
      });
      setBusy(false);
      if (written.ok !== true) {
        showFailure(written, "That target was refused");
        await askForTarget();
        return;
      }
      state.targetName = written.target.name;
      const done = card("Target recorded");
      kv(done, [
        ["name", written.target.name],
        ["base url", written.target.baseUrl],
        ["classification", written.target.classification],
        ["allowed origins", written.target.allowedOrigins.join(", ")],
        ["destructive actions", "blocked"],
      ]);
      // Re-open the investigation against the target. The binding happens at intake, so an
      // investigation opened before the target existed would still plan against nothing.
      say("Re-opening the investigation against this target…");
      await submitReport(state.reportText);
    };

    buttons(c, [
      { label: "Test environment", kind: "primary", onClick: () => choose("test") },
      { label: "Staging", onClick: () => choose("staging") },
      { label: "Local fixture", onClick: () => choose("fixture") },
    ]);
  }

  function offerPropose() {
    setStep("propose");
    const c = card("Next: propose experiments");
    c.appendChild(
      node(
        "p",
        null,
        "This renders a gate-1 proposal: what it wants to run, how many repetitions, and what evidence it will capture. Nothing executes until you approve it."
      )
    );
    buttons(c, [
      {
        label: "Propose experiments",
        kind: "primary",
        onClick: async () => {
          setBusy(true);
          const r = resultOf(await act("plan", { investigation: state.investigation, ai: true }));
          setBusy(false);
          if (r.ok !== true) {
            showFailure(r, "Could not render a proposal");
            say(
              "You can still supply a proposal file by hand and load it with the CLI: `investigate plan --investigation " +
                state.investigation +
                " --from <file.json>`."
            );
            return;
          }
          renderProposal(r);
        },
      },
    ]);
  }

  function renderProposal(r) {
    setStep("approve");
    state.proposalChecksum = (r.proposalChecksum || "").replace(/^sha256:/, "");
    const c = card("Gate 1 — experiment selection");
    kv(c, [
      ["gate", "experiment_selection"],
      ["checksum", state.proposalChecksum],
      ["items", (r.items && r.items.length) || r.itemCount],
      ["proposal", r.proposalPath],
    ]);
    c.appendChild(
      node(
        "p",
        null,
        "Approval is bound to this checksum. Re-rendering the proposal changes it and invalidates any approval of the old one, by design."
      )
    );

    const repsWrap = node("div", "row");
    const label = node("span", "mono", "repetitions ");
    label.style.alignSelf = "center";
    const reps = document.createElement("input");
    reps.type = "number";
    reps.min = "1";
    reps.max = "500";
    reps.value = "10";
    reps.style.width = "90px";
    repsWrap.appendChild(label);
    repsWrap.appendChild(reps);
    c.appendChild(repsWrap);

    buttons(c, [
      {
        label: "Approve and run",
        kind: "primary",
        onClick: async () => {
          await approveThenRun(Number.parseInt(reps.value, 10) || 10);
        },
      },
      {
        label: "Reject",
        kind: "danger",
        onClick: () => {
          say(
            "Rejected. Nothing was executed. Describe what should change and I will re-interpret."
          );
          state.awaiting = async (answer) => {
            state.awaiting = null;
            await submitReport(`${state.reportText}\n\n## Requested changes\n\n${answer}\n`);
          };
        },
      },
    ]);
  }

  async function approveThenRun(repetitions) {
    setBusy(true);
    const scaffold = resultOf(
      await act("approve-scaffold", {
        investigation: state.investigation,
        gate: state.gate,
        approver: "web-ui operator",
      })
    );
    if (scaffold.ok !== true) {
      setBusy(false);
      showFailure(scaffold, "Could not write the approval file");
      return;
    }
    const c = card("Approval recorded");
    kv(c, [
      ["file", scaffold.path || scaffold.approvalPath],
      ["checksum", state.proposalChecksum],
    ]);
    c.appendChild(
      node(
        "p",
        null,
        "The scaffold is written pre-filled but approves nothing until a decision is recorded against the checksum. Edit it in the workspace if you want to change which items are approved, then run the printed command."
      )
    );
    c.appendChild(
      node(
        "p",
        null,
        "Because the approval file is a human artefact, this UI does not silently rewrite its decision field. Complete the approval in the workspace file, then press Run."
      )
    );
    buttons(c, [
      {
        label: `Run ${repetitions}×`,
        kind: "primary",
        onClick: () => runBatch(repetitions),
      },
    ]);
    setBusy(false);
  }

  async function runBatch(repetitions) {
    setStep("record");
    setBusy(true);
    const started = await act("run", { investigation: state.investigation, repeat: repetitions });
    if (started.ok !== true || !started.jobId) {
      setBusy(false);
      showFailure(resultOf(started), "Could not start the batch");
      return;
    }
    const c = card(`Running ${repetitions} repetition(s)`);
    const spinner = node("p");
    spinner.innerHTML = '<span class="spin"></span> executing in Chromium…';
    c.appendChild(spinner);
    const log = node("div", "log");
    c.appendChild(log);

    await streamJob(
      started.jobId,
      (line) => {
        log.appendChild(document.createTextNode(line + "\n"));
        log.scrollTop = log.scrollHeight;
      },
      (payload) => {
        spinner.remove();
        setBusy(false);
        const r = payload.result || {};
        if (r.ok !== true) {
          showFailure(r, "The batch failed");
          return;
        }
        renderRunOutcome(r);
      }
    );
  }

  function renderRunOutcome(r) {
    const c = card("Batch complete");
    const counts = r.outcomes || r.byOutcome || {};
    kv(c, [
      ["runs", r.runCount ?? r.total],
      ["completed", r.completed],
      ...Object.entries(counts).map(([k, v]) => [k, v]),
    ]);

    const runs = r.runs || [];
    if (runs.length) {
      const t = node("table", "runs");
      const head = node("tr");
      for (const h of ["run", "outcome", "capture"]) head.appendChild(node("th", null, h));
      t.appendChild(head);
      for (const run of runs.slice(0, 40)) {
        const tr = node("tr");
        tr.appendChild(node("td", null, run.runId || "—"));
        tr.appendChild(node("td", null, run.outcome || "—"));
        tr.appendChild(node("td", null, run.captureStatus || "—"));
        t.appendChild(tr);
      }
      c.appendChild(t);
    }

    // A recorded video is the artefact your step-5 gate reviews, so play it inline when present.
    const video = findVideo(r);
    if (video) {
      c.appendChild(node("h4", null, "Recording")).style.margin = "12px 0 0";
      const v = document.createElement("video");
      v.controls = true;
      v.src = `/api/artifact?investigation=${encodeURIComponent(state.investigation)}&kind=video&sha=${encodeURIComponent(video)}`;
      c.appendChild(v);
      say(
        "Review the recording above. If the steps are wrong, say what to change and I will re-interpret before running more."
      );
    }

    setStep("rca");
    const next = card("Next: analyse");
    next.appendChild(
      node(
        "p",
        null,
        "Contrast runs deterministically first — what separates the failing runs from the passing ones — then optionally add a DeepSeek reading on top."
      )
    );
    buttons(next, [
      {
        label: "Analyse",
        kind: "primary",
        onClick: () => analyse(true),
      },
      { label: "Deterministic only", onClick: () => analyse(false) },
    ]);
  }

  function findVideo(r) {
    const candidates = [];
    for (const run of r.runs || []) {
      for (const a of run.artifacts || []) {
        if (a.kind === "video" && a.sha256) candidates.push(a.sha256.replace(/^sha256:/, ""));
      }
    }
    return candidates[0] || null;
  }

  async function analyse(withAi) {
    setBusy(true);
    const started = await act("analyze", { investigation: state.investigation, ai: withAi });
    if (started.ok !== true || !started.jobId) {
      setBusy(false);
      showFailure(resultOf(started), "Could not start the analysis");
      return;
    }
    const c = card("Analysing");
    const log = node("div", "log");
    c.appendChild(log);
    await streamJob(
      started.jobId,
      (line) => {
        log.appendChild(document.createTextNode(line + "\n"));
        log.scrollTop = log.scrollHeight;
      },
      (payload) => {
        setBusy(false);
        const r = payload.result || {};
        if (r.ok !== true) {
          showFailure(r, "Analysis failed");
          return;
        }
        renderAnalysis(r);
      }
    );
  }

  function renderAnalysis(r) {
    const c = card("What separates failing from passing");
    const disc = (r.comparison && r.comparison.perfectDiscriminators) || r.perfectDiscriminators;
    if (disc && disc.length) {
      const ul = node("ul", "plain");
      for (const d of disc) ul.appendChild(node("li", null, typeof d === "string" ? d : d.name));
      c.appendChild(ul);
    } else {
      c.appendChild(node("p", null, "No signal separated the two groups cleanly."));
    }
    for (const caveat of (r.comparison && r.comparison.caveats) || r.caveats || []) {
      const p = node("p", null, `Caveat: ${typeof caveat === "string" ? caveat : caveat.message}`);
      p.style.color = "var(--warn)";
      c.appendChild(p);
    }
    if (r.findings && r.findings.length) {
      const f = card("Findings");
      for (const finding of r.findings) {
        kv(f, [
          ["claim", finding.claim || finding.title],
          ["level", finding.level],
          ["evidence", (finding.evidence || []).length + " reference(s)"],
        ]);
      }
    }
    state.done.add("rca");
    renderRail();
  }

  // -------------------------------------------------------------------------------- composer

  async function onSend() {
    const text = el.input.value.trim();
    if (!text || state.busy) return;
    el.input.value = "";
    say(text, "user");

    if (state.awaiting) {
      await state.awaiting(text);
      return;
    }
    if (!state.investigation) {
      await submitReport(text);
      return;
    }
    say(
      "This investigation is already open. Use the buttons above to move through the gates, or describe a change and I will re-interpret the report."
    );
    state.awaiting = async (answer) => {
      state.awaiting = null;
      await submitReport(`${state.reportText}\n\n## Clarifications\n\n${answer}\n`);
    };
  }

  el.send.addEventListener("click", onSend);
  el.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void onSend();
    }
  });

  // ------------------------------------------------------------------------------------- boot

  // Tell the server as the page goes away, so the next tab does not wait out the whole TTL.
  // `keepalive` rather than sendBeacon: a beacon cannot carry the auth header.
  window.addEventListener("pagehide", () => {
    void fetch("/api/session/release", {
      method: "POST",
      keepalive: true,
      headers: { "x-investigator-token": TOKEN },
    });
  });

  async function boot() {
    el.ws.textContent = WORKSPACE;
    renderRail();

    let body;
    try {
      const res = await fetch("/api/session", { headers: { "x-investigator-token": TOKEN } });
      body = await res.json();
      if (res.status === 409 || body.code === "SESSION_IN_USE") {
        renderBusy(body);
        return;
      }
    } catch {
      say("Could not reach the agent server. Is it still running?");
      return;
    }

    startHeartbeat(body.ttlMs);

    if (body.state && Array.isArray(body.state.log) && body.state.log.length > 0) {
      restore(body.state);
      return;
    }

    setBusy(true, "Checking the provider…");
    say(
      "I investigate intermittent Chrome issues by reproducing them many times and contrasting the runs that fail against the runs that pass.\n\nDescribe the bug below — the URL, the steps, what you expected, what actually happens, and roughly how often. I will turn it into a structured flow, show you exactly where I think it breaks, and ask before anything runs."
    );
    void checkProvider();
  }

  void boot();
})();
