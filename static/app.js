// ---------- data ----------
const SUBJECTS = {
  maths: {
    label: "Maths", code: "1MA1", accent: "#6EE7C0",
    paperDefault: { name: "Paper 1", sections: ["Q1–10", "Q11–20", "Q21–25", "Review"] },
    drillTopics: ["Algebra", "Geometry", "Number", "Statistics", "Ratio & Proportion", "Circle Theorems"],
  },
  english: {
    label: "English Lang B", code: "4EB1", accent: "#F2A65A",
    paperDefault: { name: "Paper 1", sections: ["Section A: Reading", "Section B: Writing", "Review"] },
    drillTopics: ["Article Writing", "Comprehension", "Summary", "Vocabulary", "Narrative Writing"],
  },
};
const MODES = { PAPER: "paper", DRILL: "drill" };

// ---------- backend persistence ----------
async function loadRuns() {
  try {
    const res = await fetch("/api/runs");
    if (!res.ok) throw new Error("bad status " + res.status);
    const data = await res.json();
    return { runs: data.runs || [] };
  } catch (e) {
    console.error("failed to load run history", e);
    return { runs: [] };
  }
}
async function saveRun(run) {
  try {
    const res = await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(run),
    });
    return res.ok;
  } catch (e) {
    console.error("save failed", e);
    return false;
  }
}
async function clearHistoryRemote() {
  try { await fetch("/api/runs", { method: "DELETE" }); } catch (e) { /* best effort */ }
}

// ---------- helpers ----------
function fmt(ms) {
  if (ms < 0) ms = 0;
  const cs = Math.floor((ms % 1000) / 10);
  const s = Math.floor(ms / 1000) % 60;
  const m = Math.floor(ms / 60000) % 60;
  const h = Math.floor(ms / 3600000);
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}.${pad(cs)}` : `${pad(m)}:${pad(s)}.${pad(cs)}`;
}
function fmtDelta(ms) {
  const sign = ms > 0 ? "+" : ms < 0 ? "−" : "";
  return sign + fmt(Math.abs(ms)).replace(/^0:/, "");
}
function fmtShort(ms) {
  // compact duration for event chips, e.g. "2m10s" / "47s"
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60), s = totalSec % 60;
  return m > 0 ? `${m}m${String(s).padStart(2, "0")}s` : `${s}s`;
}
function uid() { return Math.random().toString(36).slice(2, 10); }
function prefixSums(segArr) {
  const out = [];
  let sum = 0;
  for (const seg of segArr) { sum += seg.ms; out.push(sum); }
  return out;
}
function glyphFor(name) {
  const l = (name || "").toLowerCase();
  if (l.includes("review")) return "\u{1F550}";       // clock
  if (l.includes("read")) return "\u{1F4D6}";          // book
  if (l.includes("writ")) return "✏️";       // pencil
  return mode === MODES.DRILL ? "✏️" : "\u{1F4C4}"; // pencil / page
}

// ---------- state ----------
let store = { runs: [] };
let subjectKey = "maths";
let mode = MODES.PAPER;
let running = false;
let elapsed = 0;
let startTime = null;
let rafId = null;
let sectionIdx = 0;
let splits = [];
let sectionNames = SUBJECTS.maths.paperDefault.sections.slice();
let paperName = SUBJECTS.maths.paperDefault.name;
let drillTopic = SUBJECTS.maths.drillTopics[0];
let drillCount = 10;
let justFinished = null;
let runEvents = [];
let aiSuggestion = null;
let aiExpiryTimer = null;
let trackingError = null;
let trackingConfig = { idleAfterSec: 90, awaySec: 20, aiIntervalSec: 25, aiEnabled: true };

function subject() { return SUBJECTS[subjectKey]; }
function activeLabels() {
  return mode === MODES.PAPER ? sectionNames : Array.from({ length: drillCount }, (_, i) => `Q${i + 1}`);
}
function currentKey() {
  return mode === MODES.PAPER ? `paper:${subjectKey}:${paperName}` : `drill:${subjectKey}:${drillTopic}`;
}
function bestForKey(key) {
  const runs = store.runs.filter(r => r.key === key);
  if (runs.length === 0) return null;
  return runs.reduce((best, r) => r.totalMs < best.totalMs ? r : best);
}

// ---------- actions ----------
function start() {
  startTime = Date.now();
  elapsed = 0;
  splits = [];
  sectionIdx = 0;
  justFinished = null;
  runEvents = [];
  clearAiSuggestion();
  running = true;
  tick();
  render();
}
function tick() {
  if (!running) return;
  elapsed = Date.now() - startTime;
  render(true);
  rafId = requestAnimationFrame(tick);
}
function split() {
  const now = Date.now() - startTime;
  const prevCum = splits.reduce((a, s) => a + s.ms, 0);
  const segMs = now - prevCum;
  const name = activeLabels()[sectionIdx] || `Split ${sectionIdx + 1}`;
  splits.push({ name, ms: segMs });
  if (sectionIdx + 1 >= activeLabels().length) {
    finish(now);
  } else {
    sectionIdx++;
    render();
  }
}
function stopEarly() {
  if (splits.length === 0 && elapsed < 200) { running = false; cancelAnimationFrame(rafId); render(); return; }
  const now = Date.now() - startTime;
  const prevCum = splits.reduce((a, s) => a + s.ms, 0);
  const segMs = now - prevCum;
  const name = activeLabels()[sectionIdx] || `Split ${sectionIdx + 1}`;
  splits.push({ name, ms: segMs });
  finish(now);
}
function finish(totalMs) {
  Tracker.flush(); // close out any ongoing idle/away spell while `running` is still true
  running = false;
  cancelAnimationFrame(rafId);
  clearAiSuggestion();
  const label = mode === MODES.PAPER
    ? `${subject().label} — ${paperName}`
    : `${subject().label} — ${drillTopic} ×${drillCount}`;
  const key = currentKey();
  const priorBestRun = bestForKey(key);
  const priorBest = priorBestRun ? priorBestRun.totalMs : Infinity;
  const isPB = totalMs < priorBest;

  const run = {
    id: uid(), key, subject: subjectKey, mode, label,
    sections: splits.slice(), totalMs, date: new Date().toISOString(), isPB,
    events: runEvents.slice(),
  };
  justFinished = { ...run, priorBest: isFinite(priorBest) ? priorBest : null, saveFailed: false, saving: true };
  render();
  saveRun(run).then(ok => {
    if (justFinished && justFinished.id === run.id) {
      justFinished = { ...justFinished, saving: false, saveFailed: !ok };
      if (ok) store.runs = [run, ...store.runs].slice(0, 500);
      render();
    }
  });
}
function clearRunView() {
  elapsed = 0; splits = []; sectionIdx = 0; justFinished = null; runEvents = [];
  clearAiSuggestion();
}
function reset() {
  running = false;
  cancelAnimationFrame(rafId);
  clearRunView();
  render();
}
async function clearHistory() {
  await clearHistoryRemote();
  store = { runs: [] };
  render();
}

// ---------- AI suggestion handling ----------
function clearAiSuggestion() {
  aiSuggestion = null;
  if (aiExpiryTimer) { clearTimeout(aiExpiryTimer); aiExpiryTimer = null; }
}
function logAiFlag(resolution) {
  if (!aiSuggestion) return;
  runEvents.push({
    type: "ai-flag", splitIndex: sectionIdx, ms: elapsed,
    detail: { suggestedIndex: aiSuggestion.index, suggestedLabel: aiSuggestion.label, confidence: aiSuggestion.confidence, resolution },
  });
}
function confirmAiSuggestion() {
  if (!aiSuggestion || !running) return;
  logAiFlag("confirmed");
  clearAiSuggestion();
  split();
}
function dismissAiSuggestion() {
  if (!aiSuggestion) return;
  logAiFlag("dismissed");
  clearAiSuggestion();
  render();
}

// ---------- tracking wiring ----------
Tracker.init({
  getContext: () => ({ running, elapsedMs: elapsed, sectionIdx, subject: subjectKey, labels: activeLabels() }),
  onEvent: (event) => { runEvents.push(event); render(); },
  onStatusChange: () => { render(); },
  onAiSuggestion: (sugg) => {
    if (aiSuggestion || !running) return;
    aiSuggestion = { ...sugg, offeredAtMs: elapsed };
    aiExpiryTimer = setTimeout(() => { logAiFlag("expired"); clearAiSuggestion(); render(); }, 20000);
    render();
  },
});

async function toggleTracking() {
  if (Tracker.isActive()) {
    Tracker.disable();
    trackingError = null;
    render();
    return;
  }
  const btn = document.getElementById("trackingToggleBtn");
  if (btn) btn.disabled = true;
  const result = await Tracker.enable();
  trackingError = result.errors.length ? result.errors.join(" ") : null;
  if (btn) btn.disabled = false;
  render();
}
function applyTrackingConfig() {
  Tracker.setConfig({
    idleAfterMs: trackingConfig.idleAfterSec * 1000,
    awayAfterMs: trackingConfig.awaySec * 1000,
    aiIntervalMs: trackingConfig.aiIntervalSec * 1000,
    aiEnabled: trackingConfig.aiEnabled,
  });
}

// ---------- render ----------
function render(tickOnly) {
  const s = subject();
  document.documentElement.style.setProperty("--accent", s.accent);

  if (!tickOnly) {
    // subject switch
    const subEl = document.getElementById("subjectSwitch");
    subEl.innerHTML = "";
    Object.entries(SUBJECTS).forEach(([k, sd]) => {
      const b = document.createElement("button");
      b.className = "subject-btn" + (k === subjectKey ? " active" : "");
      b.textContent = sd.label;
      b.disabled = running;
      b.onclick = () => { if (!running) { subjectKey = k; onSubjectChange(); clearRunView(); render(); } };
      subEl.appendChild(b);
    });

    // mode buttons
    document.getElementById("modePaperBtn").className = "mode-btn" + (mode === MODES.PAPER ? " active" : "");
    document.getElementById("modeDrillBtn").className = "mode-btn" + (mode === MODES.DRILL ? " active" : "");
    document.getElementById("modePaperBtn").disabled = running;
    document.getElementById("modeDrillBtn").disabled = running;

    // config panel
    document.getElementById("paperConfig").style.display = mode === MODES.PAPER ? "block" : "none";
    document.getElementById("drillConfig").style.display = mode === MODES.DRILL ? "block" : "none";
    document.getElementById("paperNameInput").value = paperName;
    document.getElementById("sectionsInput").value = sectionNames.join("\n");
    document.getElementById("drillCountInput").value = drillCount;
    document.getElementById("aiEnabledInput").checked = trackingConfig.aiEnabled;
    document.getElementById("idleAfterInput").value = trackingConfig.idleAfterSec;
    document.getElementById("awayAfterInput").value = trackingConfig.awaySec;
    document.getElementById("aiIntervalInput").value = trackingConfig.aiIntervalSec;

    const chipsEl = document.getElementById("topicChips");
    chipsEl.innerHTML = "";
    s.drillTopics.forEach(t => {
      const c = document.createElement("button");
      c.className = "chip" + (t === drillTopic ? " active" : "");
      c.textContent = t;
      c.onclick = () => { drillTopic = t; render(); };
      chipsEl.appendChild(c);
    });

    // run label
    document.getElementById("runLabel").textContent = mode === MODES.PAPER
      ? `${s.code} · ${paperName}` : `${s.code} · ${drillTopic} ×${drillCount}`;

    // control row
    const cr = document.getElementById("controlRow");
    cr.innerHTML = "";
    if (!running) {
      const startBtn = document.createElement("button");
      startBtn.className = "main-btn";
      startBtn.innerHTML = "▶ Start Run";
      startBtn.onclick = start;
      cr.appendChild(startBtn);
      if (elapsed > 0 || splits.length > 0) {
        const resetBtn = document.createElement("button");
        resetBtn.className = "ghost-btn";
        resetBtn.innerHTML = "↺ Reset";
        resetBtn.onclick = reset;
        cr.appendChild(resetBtn);
      }
    } else {
      const splitBtn = document.createElement("button");
      splitBtn.className = "main-btn";
      splitBtn.innerHTML = "› Split";
      splitBtn.onclick = split;
      cr.appendChild(splitBtn);
      const stopBtn = document.createElement("button");
      stopBtn.className = "stop-btn";
      stopBtn.innerHTML = "■ Finish";
      stopBtn.onclick = stopEarly;
      cr.appendChild(stopBtn);
    }

    renderTrackingBar();
    renderAiBanner();
    renderSplits();

    // finish card
    const finishCard = document.getElementById("finishCard");
    const saveErrorArea = document.getElementById("saveErrorArea");
    saveErrorArea.innerHTML = "";
    if (justFinished && !running) {
      finishCard.className = "finish-card open";
      finishCard.style.borderColor = justFinished.isPB ? s.accent : "#2a2d33";
      const diff = justFinished.priorBest != null ? justFinished.totalMs - justFinished.priorBest : -1;
      let html = "";
      if (justFinished.isPB) html += `<div class="pb-badge">\u{1F3C6} NEW PB</div>`;
      html += `<div class="finish-time" style="color:${diff > 0 ? 'var(--red)' : 'var(--green)'}">${fmt(justFinished.totalMs)}</div>`;
      if (justFinished.priorBest != null) {
        html += `<div class="finish-sub ${diff < 0 ? 'neg' : 'pos'}">${fmtDelta(diff)} vs previous best</div>`;
      }
      finishCard.innerHTML = html;
      if (justFinished.saving) {
        saveErrorArea.innerHTML = `<div style="font-size:12px;color:var(--text-faint);">Saving run…</div>`;
      } else if (justFinished.saveFailed) {
        saveErrorArea.innerHTML = `<div style="font-size:12px;color:var(--orange);background:#1c1a15;border:1px solid #3a3220;border-radius:8px;padding:8px 12px;">Couldn't save that run to local storage — it won't show up in history after reload.</div>`;
      }
    } else {
      finishCard.className = "finish-card";
      finishCard.innerHTML = "";
    }

    // history
    const clearBtn = document.getElementById("clearBtn");
    clearBtn.style.display = store.runs.length > 0 ? "flex" : "none";
    const historyArea = document.getElementById("historyArea");
    const history = store.runs.filter(r => r.subject === subjectKey).slice(0, 8);
    if (history.length === 0) {
      historyArea.innerHTML = `<div class="empty-state">No runs yet for ${s.label}. Start one above — your first run is automatically the PB.</div>`;
    } else {
      historyArea.innerHTML = `<div class="history-list">` + history.map(r => `
        <div class="history-row">
          <div>
            <div class="history-label">${r.label}</div>
            <div class="history-date">${new Date(r.date).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</div>
          </div>
          <div class="history-right">
            ${r.isPB ? `<span style="color:${s.accent};">\u{1F3C6}</span>` : ""}
            <span class="history-time">${fmt(r.totalMs)}</span>
          </div>
        </div>`).join("") + `</div>`;
    }
  }

  // time display + delta (updates every tick)
  const bigTime = document.getElementById("bigTime");
  bigTime.textContent = fmt(elapsed);
  bigTime.className = "big-time" + (running ? " live" : "");

  const deltaArea = document.getElementById("deltaArea");
  const pb = bestForKey(currentKey());
  if (pb) {
    const liveDelta = elapsed - pb.totalMs;
    if (running) {
      deltaArea.innerHTML = `<div class="delta-line" style="color:${liveDelta > 0 ? 'var(--red)' : 'var(--green)'}">${fmtDelta(liveDelta)}<span class="delta-sub"> vs PB</span></div>`;
    } else {
      deltaArea.innerHTML = `<div class="delta-line" style="color:var(--text-dim)">PB ${fmt(pb.totalMs)}</div>`;
    }
  } else if (!running) {
    deltaArea.innerHTML = `<div class="delta-muted">No PB set yet — this run sets the bar</div>`;
  } else {
    deltaArea.innerHTML = "";
  }

  if (tickOnly) renderSplitCurrentTime();
}

function renderTrackingBar() {
  const st = Tracker.status();
  const statusEl = document.getElementById("trackingStatus");
  const btn = document.getElementById("trackingToggleBtn");
  const errorArea = document.getElementById("trackingErrorArea");

  if (!st.screenOn && !st.webcamOn) {
    statusEl.innerHTML = `<span class="rec-dot off"></span><span class="txt">Tracking off — nothing leaves this machine until you enable it</span>`;
    btn.textContent = "Enable tracking";
    btn.className = "tracking-btn enable";
  } else {
    const parts = [];
    if (st.screenOn) parts.push("screen");
    if (st.webcamOn) parts.push("cam");
    let label = `Tracking (${parts.join(" + ")})`;
    let dotClass = "rec-dot";
    if (st.awayOngoing) { label = "Away from desk…"; dotClass += " idle"; }
    else if (st.idleOngoing) { label = "Idle — no screen activity…"; dotClass += " idle"; }
    if (st.aiDisabledReason === "lm-studio-unreachable") label += " · AI checks off (LM Studio not reachable)";
    statusEl.innerHTML = `<span class="${dotClass}"></span><span class="txt">${label}</span>`;
    btn.textContent = "Stop tracking";
    btn.className = "tracking-btn";
  }
  errorArea.innerHTML = trackingError ? `<div class="tracking-error">${trackingError}</div>` : "";
}

function renderAiBanner() {
  const area = document.getElementById("aiBannerArea");
  if (!aiSuggestion || !running) { area.innerHTML = ""; return; }
  const pct = Math.round(aiSuggestion.confidence * 100);
  area.innerHTML = `
    <div class="ai-banner">
      <span>\u{1F916} Looks like <b>${aiSuggestion.label}</b> is on screen (${pct}% sure) — you're tracking "${activeLabels()[sectionIdx]}".</span>
      <span class="ai-banner-actions">
        <button class="ai-banner-btn confirm" id="aiConfirmBtn">Split</button>
        <button class="ai-banner-btn dismiss" id="aiDismissBtn">Dismiss</button>
      </span>
    </div>`;
  document.getElementById("aiConfirmBtn").onclick = confirmAiSuggestion;
  document.getElementById("aiDismissBtn").onclick = dismissAiSuggestion;
}

function eventChipsFor(events, idx) {
  const forSplit = events.filter(e => e.splitIndex === idx);
  if (!forSplit.length) return "";
  return `<div class="split-events">` + forSplit.map(e => {
    if (e.type === "idle") return `<span class="event-chip">\u{1F634} idle ${fmtShort(e.ms)}</span>`;
    if (e.type === "away") return `<span class="event-chip">\u{1F6AA} away ${fmtShort(e.ms)}</span>`;
    if (e.type === "ai-flag") {
      const d = e.detail || {};
      const tag = d.resolution === "confirmed" ? "confirmed" : d.resolution === "expired" ? "auto-dismissed" : "dismissed";
      return `<span class="event-chip ai">\u{1F916} flagged "${d.suggestedLabel || "?"}" — ${tag}</span>`;
    }
    return "";
  }).join("") + `</div>`;
}

function renderSplits() {
  const splitsCard = document.getElementById("splitsCard");
  if (!(running || splits.length > 0)) {
    splitsCard.className = "splits-card";
    splitsCard.innerHTML = "";
    return;
  }
  splitsCard.className = "splits-card open";
  splitsCard.innerHTML = "";
  const pb = bestForKey(currentKey());
  const pbCum = pb ? prefixSums(pb.sections || []) : null;
  const cum = prefixSums(splits);
  const labels = activeLabels();
  const reviewMode = !running && splits.length > 0;
  const lastDoneIdx = splits.length - 1;

  labels.forEach((name, i) => {
    const done = splits[i];
    const isCurrent = running && i === sectionIdx;
    const row = document.createElement("div");
    row.className = "split-row" + (done ? " done" : "") + (isCurrent ? " current" : "");
    row.dataset.idx = i;

    let timeHtml = "";
    if (done) timeHtml = fmt(cum[i]);
    else if (isCurrent) timeHtml = `<span class="split-live-time">${fmt(elapsed)}</span>`;

    const wantsDelta = done && pbCum && pbCum[i] != null && (reviewMode || i === lastDoneIdx);
    let deltaHtml = "";
    if (wantsDelta) {
      const d = cum[i] - pbCum[i];
      deltaHtml = `<span class="split-delta ${d > 0 ? 'pos' : 'neg'}">${fmtDelta(d)}</span>`;
    }

    row.innerHTML = `
      <div class="split-main">
        <span class="split-glyph">${glyphFor(name)}</span>
        <span class="split-name">${name}</span>
        <span class="split-time">${timeHtml}</span>
        ${deltaHtml}
      </div>
      ${reviewMode ? eventChipsFor(runEvents, i) : ""}`;
    splitsCard.appendChild(row);
  });
}

function renderSplitCurrentTime() {
  if (!running) return;
  const el = document.querySelector(".split-live-time");
  if (el) el.textContent = fmt(elapsed);
}

function onSubjectChange() {
  if (running) return;
  sectionNames = SUBJECTS[subjectKey].paperDefault.sections.slice();
  paperName = SUBJECTS[subjectKey].paperDefault.name;
  drillTopic = SUBJECTS[subjectKey].drillTopics[0];
}

// ---------- event wiring (static elements) ----------
document.getElementById("modePaperBtn").onclick = () => { if (!running) { mode = MODES.PAPER; clearRunView(); render(); } };
document.getElementById("modeDrillBtn").onclick = () => { if (!running) { mode = MODES.DRILL; clearRunView(); render(); } };
document.getElementById("configToggle").onclick = () => {
  document.getElementById("configPanel").classList.toggle("open");
};
document.getElementById("paperNameInput").oninput = (e) => { paperName = e.target.value; render(); };
document.getElementById("sectionsInput").oninput = (e) => {
  sectionNames = e.target.value.split("\n").filter(l => l.trim().length);
};
document.getElementById("drillCountInput").oninput = (e) => {
  drillCount = Math.max(1, Math.min(50, Number(e.target.value) || 1));
  render();
};
document.getElementById("clearBtn").onclick = clearHistory;
document.getElementById("trackingToggleBtn").onclick = toggleTracking;
document.getElementById("aiEnabledInput").onchange = (e) => { trackingConfig.aiEnabled = e.target.checked; applyTrackingConfig(); render(); };
document.getElementById("idleAfterInput").oninput = (e) => { trackingConfig.idleAfterSec = Math.max(10, Number(e.target.value) || 90); applyTrackingConfig(); };
document.getElementById("awayAfterInput").oninput = (e) => { trackingConfig.awaySec = Math.max(5, Number(e.target.value) || 20); applyTrackingConfig(); };
document.getElementById("aiIntervalInput").oninput = (e) => { trackingConfig.aiIntervalSec = Math.max(15, Number(e.target.value) || 25); applyTrackingConfig(); };

// ---------- init ----------
(async function init() {
  store = await loadRuns();
  applyTrackingConfig();
  render();
})();
