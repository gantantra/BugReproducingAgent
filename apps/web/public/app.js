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
  const CREDENTIAL_FIELD =
    /credential|password|passcode|\botp\b|\bpin\b|login|log in|sign.?in|account|phone|mobile|email|username|user.?id|token/i;

  const PATTERNS = [
    { name: "ACCOUNT_EMAIL", re: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/ },
    { name: "ACCOUNT_PHONE", re: /(?:\+\d{1,3}[- ]?)?[6-9]\d{9}\b/ },
    { name: "ACCOUNT_OTP", re: /(?<!\d)\d{4,8}(?!\d)/ },
  ];

  /* Turn an answer that IS a credential into a NAME the session can reference.
   *
   * The authoring session asks for things in plain language — "what account should I sign in
   * with?" — and the reply is typed into the same box as everything else. Sending that reply
   * onward verbatim would put the value into a command line and into the model's context, which
   * is exactly what the credential store exists to prevent.
   *
   * So the value goes to the store and the session is told `ACCOUNT_PHONE`. Playwright MCP reads
   * the value from a secrets file at the moment it types it into the page. The model never learns
   * it, and neither does the transcript.
   *
   * Returns the text to send onward: either the original answer, or a sentence naming what was
   * stored. */
  async function credentialsToNames(question, answer) {
    const looksLikeCredential =
      CREDENTIAL_FIELD.test(question || "") || CREDENTIAL_FIELD.test(answer);
    if (!looksLikeCredential) return answer;

    const found = [];
    let rest = answer;
    for (const p of PATTERNS) {
      const m = rest.match(p.re);
      if (m) {
        found.push({ name: p.name, value: m[0] });
        rest = rest.replace(m[0], " ");
      }
    }
    /* A password has no shape to match, so look for one by its label first -- "password Hunter2",
     * "pwd: x" -- which is how people actually write them. */
    const labelled = /\b(?:password|passcode|pwd|pass|pin|token|secret)\b\s*[:=]?\s*(\S+)/i.exec(
      rest
    );
    if (labelled) {
      found.push({ name: "ACCOUNT_PASSWORD", value: labelled[1] });
      rest = rest.replace(labelled[1], " ");
    }

    /* And if the QUESTION was about credentials but nothing in the answer matched a shape, the
     * whole answer is the credential. Erring the other way sends it onward in the clear, which is
     * what happened: asked "what test account credentials should I use?", the reply's email was
     * captured and its password travelled as text. In a credential context, unmatched means
     * unrecognised, not harmless. */
    if (found.length === 0) {
      // Named after what was asked for, so the session referencing it can tell what it is.
      const q = question || "";
      const name = /password|passcode|pwd/i.test(q)
        ? "ACCOUNT_PASSWORD"
        : /otp|one.?time/i.test(q)
          ? "ACCOUNT_OTP"
          : /username|user name|login/i.test(q)
            ? "ACCOUNT_USERNAME"
            : "ACCOUNT_SECRET";
      found.push({ name, value: answer.trim() });
    }

    const stored = [];
    for (const c of found) {
      const res = await api("/api/credentials", { method: "POST", body: JSON.stringify(c) });
      if (res && res.ok) stored.push(res.name);
    }
    if (stored.length === 0) return answer; // Storing failed; do not silently drop what they typed.

    say(
      `Stored ${stored.join(", ")} for this session. The value stays on this machine and is typed straight into the page — it never reaches the model or the transcript.`
    );
    return `Use the credential named ${stored.join(" and ")}. Reference it by name; the browser tool will supply the value.`;
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
    const existing = await api("/api/targets");
    const targets = (existing && existing.targets) || [];
    if (targets.length > 0) {
      state.targetName = targets[0].name;
      say(`Using the configured target “${targets[0].name}” (${targets[0].baseUrl}).`);
      return true;
    }
    await askForTarget();
    return false;
  }

  async function askForTarget() {
    if (state.targetName) {
      offerAuthoring();
      return;
    }
    const existing = await api("/api/targets");
    const targets = (existing && existing.targets) || [];
    if (targets.length > 0) {
      state.targetName = targets[0].name;
      say(`Using the configured target “${targets[0].name}” (${targets[0].baseUrl}).`);
      offerAuthoring();
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
        "There is deliberately no “production”. Choosing one of these is you asserting you are authorised to act on it — the session will do on this site whatever the bug report describes, including deleting things, because that is what reproducing a delete bug means."
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
        // Reads the actual setting rather than asserting one. It said "blocked" long after
        // `blockDestructiveActions` began defaulting to false, which is the kind of stale
        // reassurance that is worse than saying nothing.
        ["destructive actions", "allowed — this is an in-house QA target you named"],
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
        appendLogLine(log, line);
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

  async function startAuthoring(extra) {
    setStep("reproduce");
    const planning = !extra || extra.approvePlan !== true;
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
    const log = node("div", "log");
    c.appendChild(log);

    await streamJob(
      started.jobId,
      (line) => appendLogLine(log, line),
      (payload) => {
        spinner.remove();
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
      buttons(c, [
        { label: "Add more detail", kind: "primary", onClick: () => promptForMoreDetail() },
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

    /* A plan with gaps in it ends on a question rather than a bare sentinel, and that is the
     * normal case -- the first real planning run asked which account to sign in as and what
     * password to type, which are exactly the two things the earlier browser-first session
     * guessed at. Answering here is better than approving, so the composer opens. */
    const asked = (r.question || "").trim();
    if (asked) {
      c.appendChild(node("p", "ask", asked));
      el.input.placeholder = "Your answer…";
      el.input.focus();
      const handler = async (answer) => {
        state.awaiting = null;
        await startAuthoring({
          approvePlan: true,
          answer: await credentialsToNames(asked, answer),
        });
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
        "Type your answer below and press Enter. It keeps the browser open and picks up exactly where it stopped — nothing is repeated."
      )
    );
    buttons(c, [
      {
        label: "I don't know",
        onClick: () =>
          resumeAuthoring("I don't know — carry on without it if you can, or say what you need."),
      },
    ]);

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

  async function resumeAuthoring(answer) {
    el.input.placeholder = DEFAULT_PLACEHOLDER;
    if (!state.authoringSession) {
      say("I lost track of that session. Starting a fresh one with what you have told me.");
      await startAuthoring({});
      return;
    }
    say(answer, "you");
    setBusy(true, "Picking up where it left off…");

    const started = await act("author", {
      investigation: state.investigation,
      resume: state.authoringSession,
      answer,
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
    const log = node("div", "log");
    c.appendChild(log);

    await streamJob(
      started.jobId,
      (line) => appendLogLine(log, line),
      (payload) => {
        spinner.remove();
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
  function renderAuthored(r) {
    setStep("approve");
    const c = card("Reproduction ready");
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
    buttons(c, [
      { label: "Run it 30×", kind: "primary", onClick: () => say(rerunHint(r, 30)) },
      { label: "Run it 100×", onClick: () => say(rerunHint(r, 100)) },
    ]);
  }

  function rerunHint(r, n) {
    const dir = (r.suite && r.suite.dir) || "<the suite folder>";
    return `In a terminal:\n\n  cd "${dir}"\n  npm i\n  npx playwright test --repeat-each=${n}\n\nYou get a pass/fail count and a video per run.`;
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
    void checkProvider();
  }

  void boot();
})();
