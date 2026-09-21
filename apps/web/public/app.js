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
  /* The session's own folder, which does not exist until the session is claimed. The page is
   * served before that, so it starts with the root workspace and is corrected by /api/session. */
  let WORKSPACE = document.body.dataset.workspace;

  const el = {
    transcript: document.getElementById("transcript"),
    input: document.getElementById("input"),
    thatsAll: document.getElementById("thatsAll"),
    rail: document.getElementById("rail"),
    waiting: document.getElementById("waiting"),
    waitingLabel: document.getElementById("waitingLabel"),
    waitingElapsed: document.getElementById("waitingElapsed"),
    ws: document.getElementById("ws"),
    provider: document.getElementById("provider"),
    inv: document.getElementById("inv"),
    varsBtn: document.getElementById("varsBtn"),
    varsPanel: document.getElementById("varsPanel"),
    varsPanelBody: document.getElementById("varsPanelBody"),
    varsPanelClose: document.getElementById("varsPanelClose"),
  };

  /* What the agent is doing while you wait on each step. The pipeline now appears only against
   * the loader: a permanent rail across the top is scenery once you have read it, whereas the
   * moment you are actually waiting is exactly when "where am I, and what is it doing?" is a real
   * question. */
  const BUSY_LABEL = {
    describe: "Storing your report…",
    reproduce: "Working through it in a browser…",
    clarify: "Picking up where it left off…",
    approve: "Recording your decision…",
    repeat: "Running the repetitions…",
    rca: "Contrasting the runs…",
  };

  const STEPS = [
    ["describe", "1 · Describe"],
    ["reproduce", "2 · Reproduce"],
    ["clarify", "3 · Clarify"],
    ["approve", "4 · Approve"],
    ["repeat", "5 · Repeat N"],
    ["rca", "6 · Analyse"],
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
    // The paused authoring session, so a typed answer resumes it.
    authoringSession: null,
    // A card is offering options and none has been chosen yet; see updateComposer.
    choicePending: false,
    // How many times this attempt's script has been sent back to be re-recorded after a replay.
    repairAttempts: 0,
    // The plan is still being worked out: no browser yet, and "That's all I know" is offered.
    planning: false,
    // The checksum of the plan card on screen, sent with its approval.
    planChecksum: null,
    // A browser-session question is open: "That's all I know" answers it for the same session.
    browsingQuestion: false,
  };

  /* `state.awaiting` is opened and closed from a dozen places, some of them AFTER the card's
   * buttons are drawn. As an accessor, every one of those assignments keeps the composer right
   * without each having to remember to. */
  {
    let awaiting = state.awaiting;
    Object.defineProperty(state, "awaiting", {
      get: () => awaiting,
      set: (handler) => {
        awaiting = handler;
        updateComposer();
      },
      enumerable: true,
      configurable: true,
    });
  }

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

  /** A token from before a restart, or a session that lapsed. Say so plainly, and once. */
  function isAuthLoss(body) {
    return (
      body && body.ok === false && (body.code === "FORBIDDEN" || body.code === "SESSION_EXPIRED")
    );
  }

  function renderAuthLoss(pendingText) {
    if (authLossShown) return;
    authLossShown = true;
    setBusy(false);
    const c = card("This page needs a fresh session", true);
    c.appendChild(
      node(
        "p",
        null,
        "Either the agent restarted and this page is still holding the old token, or the session lapsed while the tab was idle. Either way the server refused rather than writing into the wrong place — a session owns its own folder, and work done without one has nowhere to go. Refresh: the conversation is stored against your session and comes back with it."
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

  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "visible") {
      const r = await api("/api/session/heartbeat", { method: "POST" });
      if (r.ok === false && r.code === "SESSION_EXPIRED") {
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
        const c = card("Session expired", true);
        c.appendChild(node("p", null, "This session lapsed. Refresh to start a new one."));
        buttons(c, [
          { label: "Refresh", kind: "primary", onClick: () => window.location.reload() },
        ]);
      }
    }
  });

  /* SSE over fetch. EventSource cannot send an Authorization-style header, and putting the token
   * in the URL would leak it into history; streaming the body by hand keeps it in a header. */
  /* A stream that ends without its `done` event — the server restarted, the connection dropped, the
   * job is no longer known — used to end silently. The spinner kept spinning, the page stayed busy,
   * and a pinned live viewport was never released, so every card and log after it scrolled up
   * behind it for the rest of the session. Every caller already renders a failed result, so a lost
   * stream is reported as exactly that. */
  async function streamJob(jobId, onLog, onDone) {
    let finished = false;
    const finish = (payload) => {
      if (finished) return;
      finished = true;
      onDone(payload);
    };

    try {
      const res = await fetch(`/api/job/${jobId}/events`, {
        headers: { "x-investigator-token": TOKEN },
      });
      if (!res.ok || !res.body) throw new Error(`the job stream was refused (${res.status})`);
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
          else if (evMatch[1] === "done") finish(payload);
        }
      }
    } catch (e) {
      console.warn("Job stream ended abnormally:", e);
    }

    if (!finished) {
      finish({
        status: "failed",
        exitCode: null,
        result: {
          ok: false,
          code: "STREAM_LOST",
          message:
            "The connection to this run was lost before it finished, most likely because the server restarted. It may still have completed on the server, so check before starting it again.",
        },
      });
    }
  }

  // ------------------------------------------------------------------------------------ render

  /* node(tag, className, text) — and the className slot is where sentences go to die.
   *
   * Calling this with two arguments puts the text into className. Nothing throws, nothing logs,
   * and the element renders with no content and an absurd CSS class. Seven paragraphs in the
   * authoring flow were written that way and every one of them was invisible — including the
   * question the operator was being asked to answer, which made the card unanswerable.
   *
   * A real class list is short. Prose is not. Refusing the obviously-wrong case turns a silent
   * blank into an error the moment anyone renders it. */
  function node(tag, className, text) {
    if (typeof className === "string" && className.length > 40 && /\s/.test(className)) {
      throw new Error(
        `node("${tag}", …) was given prose where the className goes — pass null as the second ` +
          `argument and the text as the third. Got: ${className.slice(0, 60)}…`
      );
    }
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function scroll() {
    const main = document.querySelector("main");
    main.scrollTop = main.scrollHeight;
  }

  /* The live log is a TAIL, and says so.
   *
   * It used to be a 260px box with its own scrollbar inside the card. Removing that box means the
   * block grows with its content, and a 100-repetition batch emits far more lines than a page
   * should carry — so the number kept in the DOM is capped here instead. Bounding the height by
   * dropping old lines is honest in a way bounding it by clipping was not: the run's full output
   * is in the job record and in the artifacts either way, and what is on screen is what a tail
   * shows. */
  const LOG_TAIL_LINES = 200;

  function appendLogLine(log, line) {
    log.appendChild(document.createTextNode(line + "\n"));
    while (log.childNodes.length > LOG_TAIL_LINES) log.removeChild(log.firstChild);
    // The log inside a live viewport has a fixed height, so it follows the newest line itself.
    if (log.classList.contains("live-log")) log.scrollTop = log.scrollHeight;
    scroll();
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
        // The choice is made. Any typed answer the card was also waiting for is superseded by it:
        // left in place, the next thing typed went to a question that had already been answered.
        // A handler that needs typing next ("Change something") sets its own afterwards.
        state.choicePending = false;
        state.awaiting = null;
        await d.onClick(row);
      });
      row.appendChild(b);
    }
    parent.appendChild(row);
    // Options are on screen: the composer waits for one of them to be chosen.
    state.choicePending = true;
    updateComposer();
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
  /* The composer is open only when something is waiting for typed text.
   *
   * Closed while the agent is busy, and closed while a card is offering options that have not been
   * chosen: typing past a "Looks right — go / Change something" card sent the text somewhere the
   * operator did not intend — a re-submitted report — instead of the decision the card was asking
   * for. A card that ALSO asks for a typed answer (a plan with a question in it, "I don't know")
   * sets `state.awaiting`, and that keeps the composer open alongside its buttons. */
  const CHOOSE_PLACEHOLDER = "Choose one of the options above.";
  let placeholderBeforeChoice = null;

  function updateComposer() {
    const choosing = state.choicePending && !state.awaiting;
    el.input.disabled = state.busy || choosing;
    if (el.thatsAll) {
      el.thatsAll.hidden = !state.planning && !state.browsingQuestion;
      el.thatsAll.disabled = state.busy;
    }
    if (choosing) {
      if (placeholderBeforeChoice === null) placeholderBeforeChoice = el.input.placeholder;
      el.input.placeholder = CHOOSE_PLACEHOLDER;
    } else if (placeholderBeforeChoice !== null) {
      // Put back what was there, unless something has since set a placeholder of its own.
      if (el.input.placeholder === CHOOSE_PLACEHOLDER)
        el.input.placeholder = placeholderBeforeChoice;
      placeholderBeforeChoice = null;
    }
  }

  function setBusy(on, label) {
    state.busy = on;
    updateComposer();

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
    /* Show the error's own context, not just its message.
     *
     * Every typed refusal in this system carries the values that identify it — the checksum
     * provided against the one on disk, the origin that was refused, the variable that was unset.
     * This card printed code, message and exit and dropped all of it, so a GATE_CHECKSUM_MISMATCH
     * read as "something does not match" when the answer was two values sitting in the payload.
     * Rendered generically, because the next refusal will carry different keys. */
    for (const [k, v] of Object.entries(result.context || {})) {
      if (v === null || v === undefined || v === "") continue;
      if (typeof v === "object") continue;
      pairs.push([k === "milestone" ? "arrives in" : k, String(v)]);
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
    // The site comes from the report BEFORE intake, so the investigation is opened once, against it.
    const resolved = await resolveTarget(text);
    if (resolved === "auth") {
      renderAuthLoss(text);
      return;
    }
    if (!resolved) {
      setBusy(false);
      state.reportText = text;
      await askForTarget();
      return;
    }
    // Test-account values in the report itself go to the credential store too, and the stored
    // report carries their names. Extraction ran on answers only, so a report that gave the phone
    // and OTP up front put both into the plan and every prompt in the clear.
    text = await credentialsToNames(undefined, text);
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
    say(`Stored your report (${wrote.bytes} bytes).`);

    setStep("interpret");
    const r = resultOf(
      await act("intake", {
        from: wrote.path,
        title: firstLine(text),
        // No --ai. The report is stored and the investigation opened; the browser session reads
        // the report itself, so interpreting it blind first buys nothing.
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

    /* Straight to the browser. There used to be an interpretation step here that read the report
     * into a structured flow and then asked you about everything it could not infer — before
     * anything had been looked at. The session answers most of those by opening the page, and
     * asks the rest when it actually meets them. */
    const target = await ensureTarget();
    if (!target) return;
    offerAuthoring();
  }

  function firstLine(text) {
    const line = text.split("\n").find((l) => l.trim());
    return (line || "Reported issue")
      .replace(/[^A-Za-z0-9 ._\-()]/g, " ")
      .slice(0, 110)
      .trim();
  }

  // --------------------------------------------------------------------------------- interview

  /* --- credentials -------------------------------------------------------------------------
   *
   * An answer that IS a credential must not go into the report.
   *
   * The report is a durable artifact, so the redaction policy masks phone numbers, emails and
   * id-shaped tokens inside it — correctly, and there is no version of this product where it
   * should not. But the interview folded every answer straight into the report, which meant that
   * asking "what account should I use?" and being told destroyed the answer on the way in. The
   * operator supplied the data and the agent then reported it as missing.
   *
   * So a credential takes the other road: the value goes to this session's credential store and
   * the REPORT records only the name. The model is told the name, emits
   * `{ kind: "secretRef", envVar: "ACCOUNT_PHONE" }`, and the value is resolved inside the
   * executor at run time — after every model call, and masked out of every artifact.
   */
  async function updateVarsCount() {
    if (!el.varsBtn) return;
    try {
      const res = await api("/api/credentials");
      if (res && res.ok && Array.isArray(res.names)) {
        el.varsBtn.textContent = `variables (${res.names.length})`;
      }
    } catch {
      // Ignore
    }
  }

  /* Turn an answer that may contain credentials or parameters into session variables.
   *
   * The user might reply with a phone number (e.g. 1111111170), OTP (e.g. 7982), password,
   * custom token, or key-value format.
   *
   * Instead of hardcoded rigid regexes, we invoke /api/credentials/extract which extracts
   * clean UPPER_SNAKE_CASE keys with descriptions and stores them securely in the session's
   * CredentialStore (.secrets.env). The model only ever references the KEY, never the raw value!
   *
   * What goes on is the operator's WHOLE reply, with only the values swapped for their names.
   * It used to be replaced by a line listing the names, which threw away everything else they
   * said: a reply may carry more than was asked, less, or a correction, and all of it matters. */
  async function credentialsToNames(question, answer) {
    if (!answer || !answer.trim()) return answer;
    try {
      const res = await api("/api/credentials/extract", {
        method: "POST",
        body: JSON.stringify({ text: answer, question }),
      });
      if (res && res.ok && Array.isArray(res.extracted) && res.extracted.length > 0) {
        const storedNames = res.extracted.map((e) => e.name);
        const storedDetails = res.extracted
          .map((e) => `${e.name}${e.description ? ` (${e.description})` : ""}`)
          .join(", ");
        say(
          `Stored session variable(s): ${storedDetails}. The raw value stays securely on this machine in .secrets.env and is resolved by Playwright MCP — it never reaches the model or transcript.`
        );
        void updateVarsCount();
        const keys = `(Session variables: ${storedDetails}. Type them by key name; Playwright MCP will supply the value.)`;
        // No text back means nothing safe to forward: the raw answer holds the values.
        if (typeof res.referencedText !== "string" || !res.referencedText.trim()) {
          return `Use the session variable(s): ${storedNames.join(", ")}. Reference them strictly by key name; Playwright MCP will supply the value.`;
        }
        return `${res.referencedText.trim()}\n\n${keys}`;
      }
    } catch (e) {
      console.warn("Credential extraction failed, continuing with answer:", e);
    }
    return answer;
  }

  /* The variables open in the side panel, not as a card in the conversation.
   *
   * They are a list you work on — add one, delete one, check what is held — and a card pushed into
   * the transcript freezes that list at the moment it was rendered, then scrolls away while the
   * real one changes underneath it. Deleting from a stale card was the part that actually misled:
   * the row vanished from a card halfway up the history, and the card below it still showed the
   * variable as present. The panel is always the current list, and what it says about a change it
   * says in the panel, where the change happened. */
  function openVariablesPanel() {
    if (!el.varsPanel) return;
    el.varsPanel.hidden = false;
    // The transcript and the composer move aside rather than sitting under the panel.
    document.body.classList.add("panel-open");
    void renderVariablesPanel();
  }

  function closeVariablesPanel() {
    if (el.varsPanel) el.varsPanel.hidden = true;
    document.body.classList.remove("panel-open");
  }

  async function renderVariablesPanel(status) {
    const body = el.varsPanelBody;
    if (!body) return;

    const res = await api("/api/credentials");
    const entries = res && res.ok && Array.isArray(res.entries) ? res.entries : [];
    body.replaceChildren();

    body.appendChild(
      node(
        "p",
        "hint",
        "Held on this machine in .secrets.env. The model is given the key name and description only; Playwright supplies the value when the browser types it."
      )
    );

    if (entries.length === 0) {
      body.appendChild(
        node(
          "p",
          "hint",
          "Nothing stored yet. A value you give in an answer is picked up automatically, or add one below."
        )
      );
    }

    for (const entry of entries) {
      const row = node("div", "var-row");
      const left = node("div");
      left.appendChild(node("span", "var-name", entry.name));
      if (entry.description) left.appendChild(node("div", "var-desc", entry.description));

      const right = node("div");
      right.style.display = "flex";
      right.style.alignItems = "center";
      right.appendChild(node("span", "var-value", "••••••••"));

      const del = node("button", "danger", "Delete");
      del.style.padding = "4px 9px";
      del.addEventListener("click", async () => {
        del.disabled = true;
        await api(`/api/credentials?name=${encodeURIComponent(entry.name)}`, { method: "DELETE" });
        void updateVarsCount();
        // Re-read rather than just removing the row: the list on disk is the answer.
        void renderVariablesPanel(`Removed ${entry.name}.`);
      });
      right.appendChild(del);

      row.appendChild(left);
      row.appendChild(right);
      body.appendChild(row);
    }

    const add = node("div", "var-add");
    const nameInput = document.createElement("input");
    nameInput.placeholder = "KEY_NAME (e.g. USER_PIN)";
    const valInput = document.createElement("input");
    valInput.type = "password";
    valInput.placeholder = "Value";
    const descInput = document.createElement("input");
    descInput.placeholder = "What it is (e.g. test account PIN)";

    const addBtn = node("button", "primary", "Add variable");
    addBtn.addEventListener("click", async () => {
      const name = nameInput.value
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9_]/g, "_");
      const value = valInput.value.trim();
      const description = descInput.value.trim();
      if (!name || !value) {
        void renderVariablesPanel("A key name and a value are both needed.");
        return;
      }
      addBtn.disabled = true;
      const saved = await api("/api/credentials", {
        method: "POST",
        body: JSON.stringify({ name, value, description }),
      });
      void updateVarsCount();
      void renderVariablesPanel(
        saved && saved.ok ? `Added ${name}.` : saved?.message || "That variable could not be saved."
      );
    });

    add.appendChild(nameInput);
    add.appendChild(valInput);
    add.appendChild(descInput);
    add.appendChild(addBtn);
    body.appendChild(add);

    body.appendChild(node("div", "side-panel-status", status || ""));
  }

  const DEFAULT_PLACEHOLDER =
    "Describe the bug — the URL, the steps, what you expected, what happens instead, and how often.";

  /* Without a target the agent cannot plan at all: `get_application_constraints` returns NOT_FOUND
   * and the model correctly declines to propose experiments it cannot ground. Asking here is the
   * difference between the agent conducting the investigation and handing the operator a config
   * file to go and edit. */
  /* A target, resolved quietly when there is one and asked for only when there is not.
   *
   * Returns whether the caller may carry on. When it returns false the operator is being asked,
   * and `askForTarget` re-submits the report once they answer — so the flow resumes there rather
   * than here. */
  async function ensureTarget() {
    if (state.targetName) return true;
    const resolved = await resolveTarget(state.reportText || "");
    if (resolved === true) return true;
    await askForTarget();
    return false;
  }

  /* The site to run on, without asking for what the operator already said.
   *
   * The web address in the report being sent wins: it is the most recent thing the operator said
   * about where this happens. A target already configured for the session is the fallback for a
   * report that names no address — checked second, because checked first it would run a new report
   * about a different site against whatever site was recorded earlier in the session. Only a report
   * with no address and no configured target leaves this unresolved, and then the page asks for the
   * one thing missing — the address — and nothing else.
   *
   * It used to ask for the address even when the report contained it, then for an environment
   * label that changed nothing the run does (`test` and `staging` are treated identically), and
   * answering re-submitted the report, opening a second investigation for the same bug.
   *
   * Returns true when a target is set, false when one must be asked for, "auth" when the session
   * token has been lost and the page must re-acquire it. */
  async function resolveTarget(text) {
    if (state.targetName) return true;

    const derived = await api("/api/targets/from-report", {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    if (isAuthLoss(derived)) return "auth";
    if (derived && derived.ok === true && derived.target) {
      state.targetName = derived.target.name;
      say(`Running it on ${derived.target.baseUrl} — the site in your report.`);
      return true;
    }

    const existing = await api("/api/targets");
    if (isAuthLoss(existing)) return "auth";
    const targets = (existing && existing.targets) || [];
    if (targets.length > 0) {
      state.targetName = targets[0].name;
      say(`Running it on ${targets[0].baseUrl}.`);
      return true;
    }
    return false;
  }

  /* Reached only when the report names no web address: ask for that, and only that. */
  async function askForTarget() {
    const c = card("Which site should I run this on?");
    c.appendChild(
      node(
        "p",
        null,
        "Your report doesn't include a web address. Paste the address of the site where this happens."
      )
    );

    const urlRow = node("div", "row");
    const url = document.createElement("input");
    url.type = "text";
    url.placeholder = "https://www.example.com";
    url.style.flex = "1";
    url.style.minWidth = "260px";
    urlRow.appendChild(url);
    c.appendChild(urlRow);

    const use = async () => {
      // Enter in the address box is a choice too; without this the composer stayed closed if
      // recording the site then failed on that path.
      state.choicePending = false;
      setBusy(true, "Recording the site…");
      // The same derivation as an address found in a report, so both are validated one way.
      const written = await api("/api/targets/from-report", {
        method: "POST",
        body: JSON.stringify({ text: url.value.trim() }),
      });
      setBusy(false);
      if (!written || written.ok !== true || !written.target) {
        showFailure(
          written && written.ok === false
            ? written
            : {
                code: "BAD_PARAM",
                message: "That is not a web address. It needs to start with http:// or https://.",
              },
          "That address was not accepted"
        );
        await askForTarget();
        return;
      }
      state.targetName = written.target.name;
      say(`Running it on ${written.target.baseUrl}.`);
      // First intake, not a second one: submitReport stopped before opening anything to ask this.
      await submitReport(state.reportText);
    };

    url.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void use();
      }
    });
    buttons(c, [{ label: "Use this site", kind: "primary", onClick: use }]);
    url.focus();
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
          // An empty proposal is an answer, not a failure: the flow would have had to invent a
          // selector or an origin to fill it, and refusing to is the behaviour that makes the rest
          // of the pipeline worth trusting. Show the reason and what would unblock it.
          if (r.ok === true && r.proposalRendered === false) {
            const c = card("No experiments could be proposed");
            c.appendChild(node("p", null, r.reason || "The flow gave no reason."));
            c.appendChild(
              node(
                "p",
                null,
                "Nothing was invented to fill the gaps. Supply what is missing — a target whose origin matches the report, a real selector, the path — and propose again."
              )
            );
            buttons(c, [
              {
                label: "Reproduce it in a browser",
                kind: "primary",
                onClick: () => offerAuthoring(),
              },
              {
                label: "Change the target",
                onClick: () => {
                  state.targetName = null;
                  void askForTarget();
                },
              },
              { label: "Propose again", onClick: () => offerPropose() },
            ]);
            return;
          }
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
    /* Kept in the CLI's own spelling, `sha256:<hex>`, and never stripped.
     *
     * It used to be stored bare, because the allowlist accepted only 64 hex characters. That made
     * every approval fail: `approve` compares the flag against `checksumOfBytes`, which is
     * prefixed, so the two never matched and the refusal read as a tampered proposal rather than
     * as two spellings of one hash. An artifact sha IS bare — that is a different value, addressed
     * differently on disk — which is exactly why this one is left alone. */
    state.proposalChecksum = r.proposalChecksum || "";
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

  /** The scaffold path comes back absolute; the allowlist takes workspace-relative paths. */
  function toWorkspaceRelative(absolute) {
    if (!absolute) return null;
    const ws = (WORKSPACE || "").replace(/[\\/]+$/, "");
    let rel = absolute;
    if (ws && rel.startsWith(ws)) rel = rel.slice(ws.length);
    return rel.replace(/\\/g, "/").replace(/^\/+/, "");
  }

  /**
   * Record the approval from the page, in one click.
   *
   * This is not an auto-approval. You read the proposal card, you pressed the button, and what is
   * recorded is bound to the checksum of the exact bytes you read — the CLI recomputes it and
   * refuses on any mismatch. What has gone is being sent to a file in the workspace to type the
   * word "approve" into a document the scaffold already filled in for you.
   */
  async function approveThenRun(repetitions) {
    setBusy(true, "Recording your approval…");

    const scaffold = resultOf(
      await act("approve-scaffold", {
        investigation: state.investigation,
        gate: state.gate,
        approver: "web-ui operator",
      })
    );

    // A scaffold already on disk is not an error here: it is the file we are about to approve.
    let path = scaffold.path;
    if (scaffold.ok !== true) {
      path = scaffold.context && scaffold.context.path;
      if (!path) {
        setBusy(false);
        showFailure(scaffold, "Could not prepare the approval");
        return;
      }
    }

    const checksum = String(scaffold.proposalChecksum || state.proposalChecksum || "");
    const from = toWorkspaceRelative(path);

    const approved = resultOf(
      await act("approve", {
        investigation: state.investigation,
        gate: state.gate,
        checksum,
        from,
      })
    );
    setBusy(false);

    if (approved.ok !== true) {
      showFailure(approved, "The approval was refused");
      return;
    }

    const c = card("Approved");
    kv(c, [
      ["gate", state.gate],
      ["checksum", checksum],
      ["recorded in", from],
      ["approver", "web-ui operator"],
    ]);
    c.appendChild(
      node(
        "p",
        null,
        "Bound to the checksum of the proposal you just read. Re-rendering a changed proposal produces a new checksum and invalidates this, by design."
      )
    );
    buttons(c, [
      { label: `Run ${repetitions}×`, kind: "primary", onClick: () => runBatch(repetitions) },
      { label: "Not yet", onClick: () => say("Nothing has run. Press Run when you are ready.") },
    ]);
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
        appendLogLine(log, line);
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
      v.src = `/api/artifact?investigation=${encodeURIComponent(state.investigation)}&kind=video&sha=${encodeURIComponent(video)}&token=${encodeURIComponent(TOKEN)}`;
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

  async function analyse(withAi, batch) {
    setBusy(true);
    const started = await act("analyze", {
      investigation: state.investigation,
      ai: withAi,
      ...(batch ? { batch } : {}),
    });
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
        appendLogLine(log, line);
      },
      (payload) => {
        setBusy(false);
        const r = payload.result || {};
        if (r.ok !== true) {
          // A model reading can fail on one bad citation; the evidence is still there, so the
          // operator can ask again without re-running the script.
          const failed = showFailure(r, "Analysis failed");
          buttons(failed, [
            { label: "Analyse again", kind: "primary", onClick: () => analyse(withAi, batch) },
          ]);
          return;
        }
        renderAnalysis(r);
      }
    );
  }

  function renderAnalysis(r) {
    setStep("rca");
    const contrast = r.contrast || r.comparison || {};
    const c = card("What separates failing from passing");
    if (r.analysis && r.analysis.summary) c.appendChild(node("p", null, r.analysis.summary));
    const disc = contrast.perfectDiscriminators || r.perfectDiscriminators;
    if (disc && disc.length) {
      const ul = node("ul", "plain");
      for (const d of disc) ul.appendChild(node("li", null, typeof d === "string" ? d : d.name));
      c.appendChild(ul);
    } else {
      c.appendChild(node("p", null, "No signal separated the two groups cleanly."));
    }
    for (const caveat of contrast.caveats || r.caveats || []) {
      const p = node("p", null, `Caveat: ${typeof caveat === "string" ? caveat : caveat.message}`);
      p.style.color = "var(--warn)";
      c.appendChild(p);
    }
    const findings = (r.analysis && r.analysis.findings) || r.findings || [];
    const withheld = r.withheldFindings || [];
    if (findings.length || withheld.length) {
      const f = card("Findings");
      for (const finding of findings) {
        const refs = finding.supportingEvidence || finding.evidence || [];
        kv(f, [
          ["claim", finding.statement || finding.claim || finding.title],
          ["level", finding.level],
          ["evidence", refs.length + " reference(s)"],
        ]);
      }
      // Shown only for a finding the evidence could not carry, as one plain line (ADR-0032).
      for (const w of withheld) {
        const cats = [...new Set((w.incomplete || []).map((i) => i.category))].join(", ");
        const runs = new Set((w.incomplete || []).map((i) => i.runId)).size;
        const p = node(
          "p",
          "hint",
          `Held back: “${w.finding.statement}” rests on ${cats} evidence that was incomplete in ${runs} of the runs it cites.`
        );
        f.appendChild(p);
      }
    }
    state.done.add("rca");
    renderRail();
    const proposals = (r.analysis && r.analysis.proposedConfirmations) || [];
    if (r.source && r.source.kind === "rerun-batch" && proposals.length) {
      void seeCondition(r.source.batchId, proposals[0]);
    }
  }

  function describeFactor(f) {
    if (!f) return "the proposed change";
    return f.kind === "network"
      ? `the network slowed to ${f.profile === "slow-3g" ? "slow 3G" : "fast 3G"}`
      : `the CPU slowed ${f.rate}×`;
  }

  /* See condition: the one condition worth testing, what would disprove it, and exactly what a
   * Confirm will run. The experiment is built by the CLI, and the Confirm click carries the
   * checksum of those bytes, so what runs is what was shown. */
  async function seeCondition(batchId, proposal) {
    const preview = await act("confirm", {
      investigation: state.investigation,
      condition: 1,
      batch: batchId,
    });
    const job = preview.jobId ? await waitForJob(preview.jobId) : resultOf(preview);
    const c = card("See condition");
    c.appendChild(node("p", null, proposal.condition));
    c.appendChild(node("p", "hint", `Disproved if: ${proposal.falsifier}`));
    if (!job || job.ok !== true || !job.checksum) {
      c.appendChild(
        node("p", null, `It cannot be confirmed here: ${(job && job.message) || "no experiment"}.`)
      );
      return;
    }
    const perArm = job.config.perArm;
    c.appendChild(
      node(
        "p",
        null,
        `Confirm runs the script ${perArm} times with ${describeFactor(job.config.factor)} and ${perArm} times without, interleaved, and counts only failures that look like the ones already seen.`
      )
    );
    buttons(c, [
      {
        label: "Confirm",
        kind: "primary",
        onClick: () => confirmCondition(batchId, job.checksum),
      },
    ]);
  }

  async function waitForJob(jobId) {
    let result = null;
    await streamJob(
      jobId,
      () => {},
      (payload) => {
        result = payload.result || null;
      }
    );
    return result;
  }

  async function confirmCondition(batchId, checksum) {
    setBusy(true);
    const started = await act("confirm", {
      investigation: state.investigation,
      condition: 1,
      batch: batchId,
      checksum,
    });
    if (started.ok !== true || !started.jobId) {
      setBusy(false);
      showFailure(resultOf(started), "Could not start the confirmation");
      return;
    }
    const c = card("Confirming");
    const log = node("div", "log");
    c.appendChild(log);
    await streamJob(
      started.jobId,
      (line) => appendLogLine(log, line),
      (payload) => {
        setBusy(false);
        const r = payload.result || {};
        if (r.ok !== true) {
          showFailure(r, "The confirmation did not finish");
          return;
        }
        renderConfirmation(r);
      }
    );
  }

  /* View result: the verdict and plain counts. No statistics are shown; they were frozen with the
   * experiment and decided the verdict. */
  function renderConfirmation(r) {
    const d = r.decision || {};
    const confirmed = d.verdict === "high_confidence_trigger";
    const c = card(confirmed ? "Confirmed" : "Not confirmed", !confirmed);
    c.appendChild(node("p", null, r.condition));
    kv(c, [
      [`with ${describeFactor(r.factor)}`, `${r.variant.matched} of ${r.variant.reached} failed`],
      ["without it", `${r.control.matched} of ${r.control.reached} failed`],
    ]);
    const other = (r.variant.otherFailures || 0) + (r.control.otherFailures || 0);
    if (other) {
      c.appendChild(
        node(
          "p",
          "hint",
          `${other} other failure(s) at the final check did not look like this bug and were not counted.`
        )
      );
    }
    if (r.factorNotApplied) {
      c.appendChild(
        node(
          "p",
          "hint",
          `${r.factorNotApplied} run(s) where the change did not take were not counted.`
        )
      );
    }
    if (d.reason) c.appendChild(node("p", null, `Why not: ${d.reason}.`));
    if (r.rootCauseHypothesis) {
      c.appendChild(node("p", null, `Likely cause: ${r.rootCauseHypothesis.mechanism}`));
    }
  }

  // -------------------------------------------------------------------------------- composer

  // ------------------------------------------------------------------------------- authoring

  /* Reproducing the bug in a real browser, and asking you things while it does.
   *
   * This replaced a fixed interview: the page used to take the model's list of `unknowns` and
   * march through them one at a time, up front, before anything had been looked at. That asked
   * the wrong questions at the wrong moment. Half of them the page itself could answer — which
   * control, which field, which URL — and the half worth asking only becomes obvious once you are
   * standing on the page that is missing something.
   *
   * So the session asks in context instead. It navigates, it looks, and when it meets something
   * only you know, it stops and says so. You answer in the same box you described the bug in, and
   * it carries on with the browser and everything it had already done still in place. */

  function offerAuthoring() {
    setStep("reproduce");
    const c = card("Ready to reproduce it");
    c.appendChild(
      node(
        "p",
        null,
        `I will open ${state.targetName ? `the ${state.targetName} target` : "the target"} in a real browser and work through what you described. If I hit something only you know — which control you meant, an account to sign in with, whether what I am looking at is the bug — I will stop and ask right here.`
      )
    );
    buttons(c, [
      { label: "Reproduce it", kind: "primary", onClick: () => startAuthoring({}) },
      {
        label: "Watch the browser",
        onClick: () => startAuthoring({ headed: true }),
      },
    ]);
  }

  /* The viewport stays pinned while its session runs and the steps scroll up behind it, so the
   * browser and the latest steps are on screen together instead of one pushing the other away.
   * `end()` unpins it once the job finishes, so the finished log reads normally. */
  function createLiveViewport(inner) {
    // `.card` clips with overflow:hidden, which would pin the viewport to the card, not the page.
    inner.parentElement.classList.add("live");
    const vp = node("div", "live-viewport");
    const header = node("div", "live-viewport-header");
    const badge = node("span", "live-badge");
    badge.innerHTML = '<span class="live-dot"></span> LIVE BROWSER VIEWPORT';
    const status = node("span", "live-status", "Initializing browser…");
    header.appendChild(badge);
    header.appendChild(status);
    vp.appendChild(header);

    const frame = node("div", "live-viewport-frame");
    const img = node("img");
    img.style.display = "none";
    img.alt = "Browser Viewport";
    const placeholder = node("div", "live-placeholder");
    placeholder.innerHTML = '<span class="spin"></span> Waiting for page render…';
    img.onload = () => {
      img.style.display = "block";
      placeholder.style.display = "none";
      // A phone-shaped page puts the steps beside the frame rather than below it.
      vp.classList.toggle("portrait", img.naturalHeight > img.naturalWidth);
    };
    img.onerror = () => {
      placeholder.style.display = "flex";
      placeholder.textContent = "Error rendering screenshot";
    };
    frame.appendChild(img);
    frame.appendChild(placeholder);

    // The steps live inside the pinned block, beside or below the browser — never behind it.
    const body = node("div", "live-viewport-body");
    body.appendChild(frame);
    const log = node("div", "log live-log");
    body.appendChild(log);
    vp.appendChild(body);
    return {
      vp,
      header,
      badge,
      status,
      frame,
      img,
      placeholder,
      log,
      end: () => vp.classList.add("ended"),
    };
  }

  async function startAuthoring(extra) {
    setStep("reproduce");
    // A new authoring run gets its own repair budget.
    state.repairAttempts = 0;
    const planning = !extra || extra.approvePlan !== true;
    // Planning keeps "That's all I know" beside the composer; opening the browser ends it.
    state.planning = planning;
    state.browsingQuestion = false;
    if (!planning && state.planChecksum && !extra.planChecksum) {
      extra = { ...extra, planChecksum: state.planChecksum };
    }
    setBusy(
      true,
      planning ? "Working out how to reproduce it…" : "Working through it in a browser…"
    );

    const started = await act("author", {
      investigation: state.investigation,
      ...(state.targetName ? { env: state.targetName } : {}),
      ...extra,
    });
    if (started.ok !== true || !started.jobId) {
      setBusy(false);
      showFailure(resultOf(started), "Could not start the browser session");
      return;
    }

    const c = card(planning ? "Working out the steps" : "Reproducing");
    const spinner = node("p");
    spinner.innerHTML =
      '<span class="spin"></span> ' +
      (planning ? "no browser yet — writing the plan first…" : "driving the browser…");
    c.appendChild(spinner);

    const viewport = !planning ? createLiveViewport(c) : null;
    if (viewport) c.appendChild(viewport.vp);

    // With a browser, the steps are inside the pinned viewport; without one (planning), below.
    const log = viewport ? viewport.log : node("div", "log");
    if (!viewport) c.appendChild(log);

    await streamJob(
      started.jobId,
      (line) => {
        const m = line.match(/^\[SCREENSHOT:(.+)\]$/);
        // A frame arrives about once a second. It replaces the picture only: the header keeps the
        // current step, and the scroll position is left where the operator put it.
        if (m && viewport) {
          const imgUrl =
            m[1] +
            (m[1].includes("?") ? "&" : "?") +
            "token=" +
            encodeURIComponent(TOKEN) +
            "&_t=" +
            Date.now();
          viewport.img.src = imgUrl;
          return;
        }
        if (
          viewport &&
          (line.startsWith("🌐 ") ||
            line.startsWith("👆 ") ||
            line.startsWith("⌨️ ") ||
            line.startsWith("⏳ ") ||
            line.startsWith("🔍 ") ||
            line.startsWith("📸 ") ||
            line.startsWith("📝 "))
        ) {
          viewport.status.textContent = line;
        }
        appendLogLine(log, line);
      },
      (payload) => {
        spinner.remove();
        if (viewport) viewport.end();
        setBusy(false);
        handleAuthoringOutcome(payload.result || {});
      }
    );
  }

  /* Four endings, and only one of them produces a script. An ending nobody recognised is treated
   * as "did not finish" rather than as success, because emitting a script from a session that
   * stopped halfway hands you something that looks complete and is not. */
  function handleAuthoringOutcome(r) {
    state.authoringSession = r.sessionId || state.authoringSession || null;

    if (r.outcome === "plan") {
      showPlan(r);
      return;
    }
    if (r.outcome === "question") {
      askAuthoringQuestion(r);
      return;
    }
    if (r.outcome === "done" && r.suite) {
      renderAuthored(r);
      return;
    }
    if (r.outcome === "stuck") {
      const c = card("It could not get there", true);
      c.appendChild(node("p", null, r.reason || r.message || "The session stopped."));
      c.appendChild(
        node(
          "p",
          null,
          "No script was written. A partial reproduction looks complete, and whoever runs it next believes it — so nothing is better than half."
        )
      );
      /* Out of turns is not stuck. The CLI already continued the session once; the flow so far —
       * sign-in, the controls it found, the steps recorded — is kept by resuming it, and thrown away
       * by "Try again", which starts over from a new plan. */
      const canContinue = r.turnLimit === true && Boolean(state.authoringSession);
      if (canContinue) {
        c.appendChild(
          node(
            "p",
            null,
            "It ran out of turns part-way through, after one automatic continuation. Keep going picks the same session up again, with the browser profile and every step it recorded."
          )
        );
      }
      buttons(c, [
        ...(canContinue
          ? [
              {
                label: "Keep going",
                kind: "primary",
                onClick: () => resumeAuthoring("Keep going from where the flow stands."),
              },
            ]
          : []),
        ...(canContinue
          ? []
          : [
              {
                label: "Re-plan with this",
                kind: "primary",
                onClick: () =>
                  replanWith(
                    `The browser session stopped: ${r.reason || r.message || "no reason given"}`
                  ),
              },
            ]),
        { label: "Add more detail", onClick: () => promptForMoreDetail() },
        { label: "Try again", onClick: () => startAuthoring({}) },
      ]);
      return;
    }

    showFailure(
      { code: r.code || "AUTHORING_INCOMPLETE", message: r.message || "", exitCode: r.exitCode },
      "The session ended without finishing"
    );
  }

  /* The plan, before anything opens a browser.
   *
   * This card is the whole reason the planning phase exists. A session used to go from "Reproduce
   * it" straight to a live browser, and the operator's first sight of its intentions was the
   * finished script — by which point it had filled in a change-password form on a production site
   * while signed out, using a password it invented. All of that is legible in five lines of plan.
   *
   * So: read it, approve it, or say what to change. The correction goes to the same session as
   * free text, because "log in first, and use ACCOUNT_PASSWORD for the new one" is a sentence,
   * not a form. */
  function showPlan(r) {
    setStep("reproduce");
    state.planning = true;
    state.planChecksum = r.planChecksum || null;
    updateComposer();
    const c = card("Here is what I plan to do");
    c.appendChild(
      node(
        "p",
        null,
        "Nothing has touched your site yet — I have not opened a browser. Read this first; if a step is wrong or a value is missing, tell me and I will redo it."
      )
    );

    const plan = node("pre", "plan");
    plan.textContent = (r.plan || r.message || "").trim() || "(the session returned no plan)";
    c.appendChild(plan);

    // The browser is launched as this platform. Shown before approval, so a wrong reading of
    // "android chrome" or "mobile web only" is caught before anything opens.
    if (r.platform && r.platform.description) {
      const why =
        r.platform.note ||
        (r.platform.source === "default"
          ? "The default, because nothing you said named a platform."
          : "");
      c.appendChild(
        node(
          "p",
          "hint",
          `Browser: ${r.platform.description}. ${why} To use a different one, say so with "Change something".`
        )
      );
    }

    /* A plan with gaps in it ends on a question rather than a bare sentinel, and that is the
     * normal case -- the first real planning run asked which account to sign in as and what
     * password to type, which are exactly the two things the earlier browser-first session
     * guessed at. Answering here is better than approving, so the composer opens. */
    const asked = (r.question || "").trim();
    if (asked) {
      c.appendChild(node("p", "ask", asked));
      el.input.placeholder = "Your answer…";
      el.input.focus();
      // An answer revises the plan, which comes back for another read before any browser opens.
      const handler = async (answer) => {
        state.awaiting = null;
        await startAuthoring({ answer: await credentialsToNames(asked, answer) });
      };
      handler.echoesItself = true;
      state.awaiting = handler;
    }

    buttons(c, [
      {
        label: asked ? "Go anyway" : "Looks right — go",
        kind: asked ? "" : "primary",
        onClick: () => startAuthoring({ approvePlan: true }),
      },
      { label: "Change something", onClick: () => askPlanChange() },
      {
        label: "Watch the browser",
        onClick: () => startAuthoring({ approvePlan: true, headed: true }),
      },
    ]);
  }

  /* A correction to the plan, in the operator's own words, then straight into the browser run. */
  function askPlanChange() {
    const c = card("What should I do differently?");
    c.appendChild(
      node(
        "p",
        null,
        "Anything the plan got wrong — a step to skip, an account to sign in as, a value to type. I will follow the plan with your changes applied."
      )
    );
    el.input.placeholder = "What should change…";
    el.input.focus();

    const handler = async (answer) => {
      state.awaiting = null;
      await startAuthoring({ approvePlan: true, answer: await credentialsToNames("plan", answer) });
    };
    handler.echoesItself = true;
    state.awaiting = handler;
  }

  /* The question, in the conversation, answered in the same box as everything else. */
  function askAuthoringQuestion(r) {
    setStep("clarify");
    const c = card("It needs to ask you something");
    // Whatever arrived, in preference order. An empty card with a button is the one thing this
    // must never be: the operator cannot answer a question they were not shown.
    const asked = (r.question || "").trim() || (r.message || "").trim();
    c.appendChild(
      node(
        "p",
        null,
        asked ||
          "It stopped to ask something but the question did not come through. Tell it what you think it needs, or say “I don't know” and it will explain."
      )
    );
    c.appendChild(
      node(
        "p",
        null,
        "Type your answer below and press Enter. It picks up where it stopped: the browser restarts on the same profile with sign-ins kept, and the steps so far stay in the script."
      )
    );
    buttons(c, [
      {
        label: "I don't know",
        onClick: () =>
          resumeAuthoring("I don't know — carry on without it if you can, or say what you need."),
      },
    ]);

    // "That's all I know" stays available here too: the plan is settled, but the operator can
    // still say they have nothing more, and the session carries on or says what is missing.
    state.browsingQuestion = true;
    el.input.placeholder = "Your answer…";
    el.input.focus();
    const question = r.question || "";
    const handler = async (answer) => {
      state.awaiting = null;
      await resumeAuthoring(await credentialsToNames(question, answer));
    };
    // resumeAuthoring says the transformed text, so onSend must not say the raw text first.
    handler.echoesItself = true;
    state.awaiting = handler;
  }

  /* `repair`: re-record the script from where its replay stopped, instead of answering a question.
   * The CLI reads that evidence itself, so there is no answer to send or echo. */
  async function resumeAuthoring(answer, repair = false) {
    el.input.placeholder = DEFAULT_PLACEHOLDER;
    state.browsingQuestion = false;
    updateComposer();
    if (!state.authoringSession) {
      say("I lost track of that session. Starting a fresh one with what you have told me.");
      await startAuthoring({});
      return;
    }
    if (!repair) say(answer, "you");
    setBusy(
      true,
      repair
        ? "Recording the flow again from where the replay stopped…"
        : "Picking up where it left off…"
    );

    const started = await act("author", {
      investigation: state.investigation,
      resume: state.authoringSession,
      ...(repair ? { repair: true } : { answer }),
    });
    if (started.ok !== true || !started.jobId) {
      setBusy(false);
      showFailure(resultOf(started), "Could not resume the session");
      return;
    }

    const c = card("Continuing");
    const spinner = node("p");
    spinner.innerHTML = '<span class="spin"></span> back in the browser…';
    c.appendChild(spinner);

    const viewport = createLiveViewport(c);
    c.appendChild(viewport.vp);

    const log = viewport.log;

    await streamJob(
      started.jobId,
      (line) => {
        const m = line.match(/^\[SCREENSHOT:(.+)\]$/);
        if (m) {
          const imgUrl =
            m[1] +
            (m[1].includes("?") ? "&" : "?") +
            "token=" +
            encodeURIComponent(TOKEN) +
            "&_t=" +
            Date.now();
          viewport.img.src = imgUrl;
          return;
        }
        if (
          line.startsWith("🌐 ") ||
          line.startsWith("👆 ") ||
          line.startsWith("⌨️ ") ||
          line.startsWith("⏳ ") ||
          line.startsWith("🔍 ") ||
          line.startsWith("📸 ") ||
          line.startsWith("📝 ")
        ) {
          viewport.status.textContent = line;
        }
        appendLogLine(log, line);
      },
      (payload) => {
        spinner.remove();
        if (viewport) viewport.end();
        setBusy(false);
        handleAuthoringOutcome(payload.result || {});
      }
    );
  }

  function promptForMoreDetail() {
    say(
      "Tell me anything else that might help — the exact wording on the page, an account to use, what you were doing just before it went wrong. I will fold it in and try again."
    );
    el.input.placeholder = "Anything else that might help…";
    el.input.focus();
    state.awaiting = async (extra) => {
      state.awaiting = null;
      el.input.placeholder = DEFAULT_PLACEHOLDER;
      await submitReport(`${state.reportText}\n\n## More detail\n\n${extra}\n`);
    };
  }

  /* What a finished session hands over: a script that runs anywhere Playwright does, and the
   * repetitions that turn one reproduction into a failure rate. */
  /* A finished session's script is replayed by the agent before anyone is offered N runs of it.
   *
   * Thirty runs of a script that could not get past its own sign-up screen reported "30 of 30
   * failed", none of it the bug. Two replays catch that in a minute: a replay that stops BEFORE the
   * final check goes back to the session with where it stopped and what the page showed, and the
   * session records the flow again. A replay that reaches the check — pass or fail — means the
   * script works, whatever the application then did, so it is never sent back: that failure may be
   * the bug. */
  const VERIFY_RUNS = 2;
  const MAX_REPAIRS = 2;
  const NO_MORE_INFO =
    "That's all I know. I have no more information: don't ask again. Carry on with what you have, or stop and say exactly what is missing.";

  function renderAuthored(r) {
    setStep("approve");
    const c = card("Reproduction ready");
    kv(c, [
      ["steps", r.suite && r.suite.steps],
      ["script", r.suite && r.suite.dir],
      [
        "only on some runs",
        r.suite && r.suite.optionalScreens && r.suite.optionalScreens.join(", "),
      ],
    ]);
    if (r.suite && r.suite.optionalRefused) {
      c.appendChild(node("p", "hint", `Kept mandatory: ${r.suite.optionalRefused.join("; ")}`));
    }
    c.appendChild(
      node(
        "p",
        null,
        `Checking that it replays: the agent runs it ${VERIFY_RUNS} times before offering more.`
      )
    );
    void verifyScript(r);
  }

  function verifyScript(r) {
    return runSuite(VERIFY_RUNS, (result) => {
      if (!result || result.ok !== true) {
        showFailure(result || {}, "The script could not be replayed");
        renderRunControls(r, "It could not be replayed automatically, so it has not been checked.");
        return;
      }
      if (!result.stoppedEarly) {
        const atCheck = result.failedAtCheck
          ? ` The final check failed in ${result.failedAtCheck} of them, which may already be the bug.`
          : "";
        renderRunControls(
          r,
          `Replayed ${VERIFY_RUNS} times and reached the final check every time.${atCheck}`
        );
        return;
      }
      if (state.repairAttempts >= MAX_REPAIRS) {
        renderRunControls(
          r,
          `After ${MAX_REPAIRS} repairs it still stops before the final check when replayed: ${result.summary}. Running it many times now would mostly measure that, not the bug.`,
          replayStopReason(result)
        );
        return;
      }
      state.repairAttempts += 1;
      say(
        `The replay stopped before the final check: ${result.summary}. Sending that back to the session to record the flow again (repair ${state.repairAttempts} of ${MAX_REPAIRS})…`
      );
      void resumeAuthoring(null, true);
    });
  }

  /* What the replay's own runner recorded about where it stopped: the line, the statement, and
   * what it was waiting for. A new plan needs that, not just the one-line summary. */
  function replayStopReason(result) {
    const lines = [
      `Replaying the recorded script stopped before the final check: ${result.summary}`,
    ];
    for (const stop of (result.stops || []).slice(0, 3)) {
      const where = stop.line ? `line ${stop.line}` : "an unknown line";
      const waiting = stop.waitingFor ? `, waiting for ${stop.waitingFor}` : "";
      lines.push(
        `- ${where}: ${stop.statement || "(no statement)"}${waiting} (${stop.runs} run(s))`
      );
    }
    return lines.join("\n");
  }

  /* A new plan from what stopped the session, through the same planning turn an answer uses.
   * The reason is the CLI's own text, already written with credential names, not something the
   * operator typed, so it is not sent through credential extraction. */
  async function replanWith(why) {
    say(
      `Re-plan with this.

${why}`,
      "user"
    );
    await startAuthoring({ answer: why });
  }

  /* The replay's own recording, fetched now into memory: the next N× run clears the folder it is
   * in, and the card should keep showing the run the operator is deciding on. */
  async function attachReviewVideo(c, before) {
    try {
      const res = await fetch(
        `/api/suite-video?investigation=${encodeURIComponent(state.investigation)}`,
        { headers: { "x-investigator-token": TOKEN } }
      );
      if (!res.ok) return;
      const blob = await res.blob();
      const v = document.createElement("video");
      v.controls = true;
      v.src = window.URL.createObjectURL(blob);
      const heading = node("h4", null, "Recording of the replay");
      heading.style.margin = "12px 0 0";
      c.insertBefore(heading, before);
      c.insertBefore(v, before);
    } catch {
      // No recording is not an error: the card works without one.
    }
  }

  function renderRunControls(r, note, replanReason) {
    setStep("approve");
    const c = card("Ready to measure");
    if (note) c.appendChild(node("p", null, note));
    kv(c, [
      ["steps", r.suite && r.suite.steps],
      ["script", r.suite && r.suite.dir],
      ["investigation", state.investigation],
    ]);
    c.appendChild(
      node(
        "p",
        null,
        "Every line in it is a call that actually ran, with the selectors Playwright itself generated — so this is the run that worked, not a rewrite of it."
      )
    );
    c.appendChild(
      node(
        "p",
        null,
        "Run it many times to find out how often it fails. One pass proves nothing about a bug that only shows up sometimes."
      )
    );
    /* The count box and the button next to it. Pressing it runs the script here rather than
     * printing a command to paste into a terminal: it is the operator's own script, against the
     * target they named, and the count they chose is the decision. */
    const row = node("div", "row");
    const label = node("span", "mono", "run it");
    label.style.alignSelf = "center";
    const count = document.createElement("input");
    count.type = "number";
    count.min = "1";
    count.max = "500";
    count.value = "30";
    count.style.width = "90px";
    const times = node("span", "mono", "×");
    times.style.alignSelf = "center";
    row.appendChild(label);
    row.appendChild(count);
    row.appendChild(times);
    c.appendChild(row);

    const chosen = () => {
      const n = Number.parseInt(count.value, 10);
      return Number.isInteger(n) && n >= 1 && n <= 500 ? n : 30;
    };

    buttons(c, [
      { label: "Run it", kind: "primary", onClick: () => runSuite(chosen()) },
      { label: "Run it 30×", onClick: () => runSuite(30) },
      { label: "Run it 100×", onClick: () => runSuite(100) },
      ...(replanReason
        ? [{ label: "Re-plan with this", onClick: () => replanWith(replanReason) }]
        : []),
    ]);
    void attachReviewVideo(c, row);
  }

  /** Run the authored suite N times here, streaming what the runner prints. */
  /* `onResult` takes the finished result instead of the usual outcome card — used by the replay
   * check that runs before anyone is offered N runs. */
  async function runSuite(repetitions, onResult) {
    setStep("record");
    setBusy(
      true,
      onResult ? "Checking that the script replays…" : `Running the script ${repetitions}×…`
    );
    const started = await act("rerun", { investigation: state.investigation, repeat: repetitions });
    if (started.ok !== true || !started.jobId) {
      setBusy(false);
      showFailure(resultOf(started), "Could not start the runs");
      return;
    }

    const c = card(
      onResult
        ? `Checking that the script replays (${repetitions} runs)`
        : `Running the script ${repetitions}×`
    );
    const spinner = node("p");
    spinner.innerHTML =
      '<span class="spin"></span> the first run installs the suite&rsquo;s own Playwright, then it runs…';
    c.appendChild(spinner);
    const log = node("div", "log");
    c.appendChild(log);

    await streamJob(
      started.jobId,
      (line) => appendLogLine(log, line),
      (payload) => {
        spinner.remove();
        setBusy(false);
        const r = payload.result || {};
        if (onResult) {
          onResult(r);
          return;
        }
        if (r.ok !== true) {
          showFailure(r, "The runs did not complete");
          return;
        }
        renderSuiteOutcome(r);
      }
    );
  }

  /* A failure count is the RESULT, not an error: an intermittent bug is a rate, and the whole
   * point of running it N times is to find out what that rate is. */
  function renderSuiteOutcome(r) {
    const c = card("Runs complete");
    // Where runs failed matters more than how many: only a failure AT the final check is the bug.
    kv(c, [
      ["ran", r.repetitions],
      ["reached the final check", r.reachedCheck],
      ["failed at the final check", r.failedAtCheck],
      ["stopped before the check", r.stoppedEarly],
      ["videos", r.artifactsDir],
    ]);
    c.appendChild(node("p", null, r.summary || ""));
    c.appendChild(
      node(
        "p",
        null,
        r.stoppedEarly > 0
          ? "Runs that stopped before the final check are not counted against the bug: they never got far enough to see it. It usually means the site took a path the script did not expect."
          : r.failedAtCheck > 0
            ? "That is a failure rate measured from real runs — the number to put in the bug report."
            : "Every run passed. Either the fault did not appear this time, or the closing check does not catch it. Running it more times is the cheapest way to tell."
      )
    );
    buttons(c, [
      ...(r.batchId
        ? [{ label: "Analyse", kind: "primary", onClick: () => analyse(true, r.batchId) }]
        : []),
      {
        label: "Run it 30× more",
        ...(r.batchId ? {} : { kind: "primary" }),
        onClick: () => runSuite(30),
      },
      { label: "Run it 100× more", onClick: () => runSuite(100) },
    ]);
  }

  async function onSend() {
    const text = el.input.value.trim();
    if (!text || state.busy) return;
    el.input.value = "";

    /* A pending handler may be about to turn this into a credential reference, and echoing the
     * raw text first would put the secret in the transcript -- which is persisted, and which the
     * whole credential store exists to keep it out of. So a handler that echoes for itself is
     * trusted to do so. Observed: a typed password reached sessions.json this way. */
    if (state.awaiting) {
      const handler = state.awaiting;
      if (!handler.echoesItself) say(text, "user");
      await handler(text);
      return;
    }
    say(text, "user");
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

  el.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void onSend();
    }
  });

  /* "That's all I know": stop being asked, and have the plan written with what there is. Anything
   * still typed in the box goes with it as the last answer -- credentials first turned into names,
   * as every other answer is, so no value reaches the transcript. */
  el.thatsAll?.addEventListener("click", async () => {
    if (state.busy || !state.investigation) return;
    if (!state.planning && !state.browsingQuestion) return;
    const typed = el.input.value.trim();
    el.input.value = "";
    state.awaiting = null;
    if (!state.planning) {
      // A question from the browser session: answer it in the same session, as every answer is.
      const extra = typed ? await credentialsToNames("question", typed) : "";
      await resumeAuthoring(
        extra
          ? `${extra}

${NO_MORE_INFO}`
          : NO_MORE_INFO
      );
      return;
    }
    const answer = typed ? await credentialsToNames("plan", typed) : "";
    say(answer ? `${answer}\n\nThat's all I know.` : "That's all I know.", "user");
    await startAuthoring({ thatsAll: true, ...(answer ? { answer } : {}) });
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
      if (body.ok === false) {
        say(body.message || "The agent could not start a session. Refresh to try again.");
        return;
      }
    } catch {
      say("Could not reach the agent server. Is it still running?");
      return;
    }

    startHeartbeat(body.ttlMs);

    // Everything this session produces lands in one folder: the report and its versions, the
    // database, the artifacts and videos, the approvals, and the test account. Show it, because
    // the operator's first question after a run is where the evidence went.
    if (body.workspace) {
      WORKSPACE = body.workspace;
      state.sessionFolder = body.sessionFolder || null;
    }
    el.ws.textContent = body.sessionFolder ? `sessions/${body.sessionFolder}` : WORKSPACE;
    el.ws.title = WORKSPACE;

    if (body.state && Array.isArray(body.state.log) && body.state.log.length > 0) {
      restore(body.state);
      return;
    }

    setBusy(true, "Checking the provider…");
    say(
      "I investigate intermittent Chrome issues by reproducing them many times and contrasting the runs that fail against the runs that pass.\n\nDescribe the bug below — the URL, the steps, what you expected, what actually happens, and roughly how often. I will turn it into a structured flow, show you exactly where I think it breaks, and ask before anything runs."
    );
    if (el.varsBtn) {
      el.varsBtn.addEventListener("click", () => {
        if (el.varsPanel && !el.varsPanel.hidden) closeVariablesPanel();
        else openVariablesPanel();
      });
      if (el.varsPanelClose) el.varsPanelClose.addEventListener("click", closeVariablesPanel);
      document.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape") closeVariablesPanel();
      });
    }
    void updateVarsCount();
    void checkProvider();
  }

  void boot();
})();
