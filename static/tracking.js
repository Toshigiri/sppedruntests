// ---------------------------------------------------------------------
// Local-only webcam/screen tracking.
//
// - Screen idle detection and webcam away detection are pure client-side
//   pixel diffing — nothing about those streams ever leaves the browser.
// - AI section detection is the one thing that leaves the machine: every
//   `aiIntervalMs` (while enabled) a downscaled screenshot is POSTed to the
//   local backend, which relays it to a local LM Studio server and discards it.
//   Webcam frames are never sent anywhere, in any mode.
// ---------------------------------------------------------------------
const Tracker = (() => {
  let screenStream = null, webcamStream = null;
  let videoScreen = null, videoWebcam = null;
  let diffCanvasScreen = null, diffCanvasWebcam = null, aiCanvas = null;
  let prevScreenData = null, prevWebcamData = null;
  let screenBelowSince = null, screenOngoing = false;
  let webcamBelowSince = null, webcamOngoing = false;
  let diffTimer = null, aiTimer = null;
  let aiInFlight = false;
  let aiDisabledReason = null;

  let cfg = { idleAfterMs: 90000, awayAfterMs: 20000, aiIntervalMs: 25000, aiEnabled: true };
  let hooks = { getContext: () => ({}), onEvent: () => {}, onStatusChange: () => {}, onAiSuggestion: () => {} };

  const SCREEN_DIFF_W = 64, SCREEN_DIFF_H = 36;
  const WEBCAM_DIFF_W = 48, WEBCAM_DIFF_H = 36;
  const SCREEN_QUIET_THRESHOLD = 0.012;   // normalized 0-1 mean pixel delta
  const WEBCAM_QUIET_THRESHOLD = 0.018;
  const DIFF_SAMPLE_MS = 1200;

  function mkVideo() {
    const v = document.createElement("video");
    v.autoplay = true; v.muted = true; v.playsInline = true;
    v.style.position = "fixed"; v.style.left = "-9999px"; v.style.top = "0";
    v.style.width = "2px"; v.style.height = "2px";
    document.body.appendChild(v);
    return v;
  }

  function meanAbsDiff(a, b) {
    if (!a || !b || a.length !== b.length) return 1;
    let sum = 0, n = 0;
    for (let i = 0; i < a.length; i += 4) {
      const lumA = (a[i] + a[i + 1] + a[i + 2]) / 3;
      const lumB = (b[i] + b[i + 1] + b[i + 2]) / 3;
      sum += Math.abs(lumA - lumB);
      n++;
    }
    return n ? (sum / n) / 255 : 0;
  }

  function status() {
    return {
      screenOn: !!screenStream,
      webcamOn: !!webcamStream,
      idleOngoing: screenOngoing,
      awayOngoing: webcamOngoing,
      aiDisabledReason,
    };
  }
  function emitStatus() { hooks.onStatusChange(status()); }

  function tickScreen() {
    if (!videoScreen || videoScreen.readyState < 2) return;
    const ctx = diffCanvasScreen.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(videoScreen, 0, 0, SCREEN_DIFF_W, SCREEN_DIFF_H);
    let data;
    try { data = ctx.getImageData(0, 0, SCREEN_DIFF_W, SCREEN_DIFF_H).data; } catch (e) { return; }
    const diff = meanAbsDiff(prevScreenData, data);
    prevScreenData = data;
    handleDiff(diff, SCREEN_QUIET_THRESHOLD, cfg.idleAfterMs, "idle",
      () => screenBelowSince, (v) => screenBelowSince = v,
      () => screenOngoing, (v) => screenOngoing = v);
  }

  function tickWebcam() {
    if (!videoWebcam || videoWebcam.readyState < 2) return;
    const ctx = diffCanvasWebcam.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(videoWebcam, 0, 0, WEBCAM_DIFF_W, WEBCAM_DIFF_H);
    let data;
    try { data = ctx.getImageData(0, 0, WEBCAM_DIFF_W, WEBCAM_DIFF_H).data; } catch (e) { return; }
    const diff = meanAbsDiff(prevWebcamData, data);
    prevWebcamData = data;
    handleDiff(diff, WEBCAM_QUIET_THRESHOLD, cfg.awayAfterMs, "away",
      () => webcamBelowSince, (v) => webcamBelowSince = v,
      () => webcamOngoing, (v) => webcamOngoing = v);
  }

  function handleDiff(diff, threshold, afterMs, type, getBelow, setBelow, getOngoing, setOngoing) {
    const ctxInfo = hooks.getContext();
    if (!ctxInfo.running) {
      if (getBelow() != null) setBelow(null);
      if (getOngoing()) { setOngoing(false); emitStatus(); }
      return;
    }
    const nowMs = ctxInfo.elapsedMs;
    if (diff < threshold) {
      if (getBelow() == null) setBelow(nowMs);
      const quietFor = nowMs - getBelow();
      if (!getOngoing() && quietFor >= afterMs) { setOngoing(true); emitStatus(); }
    } else {
      if (getOngoing()) {
        hooks.onEvent({ type, splitIndex: ctxInfo.sectionIdx, startMs: getBelow(), endMs: nowMs, ms: nowMs - getBelow() });
        emitStatus();
      } else if (getBelow() != null) {
        emitStatus();
      }
      setBelow(null);
      setOngoing(false);
    }
  }

  function closeOngoing() {
    const ctxInfo = hooks.getContext();
    const nowMs = ctxInfo.running ? ctxInfo.elapsedMs : null;
    if (screenOngoing && screenBelowSince != null && nowMs != null) {
      hooks.onEvent({ type: "idle", splitIndex: ctxInfo.sectionIdx, startMs: screenBelowSince, endMs: nowMs, ms: nowMs - screenBelowSince });
    }
    if (webcamOngoing && webcamBelowSince != null && nowMs != null) {
      hooks.onEvent({ type: "away", splitIndex: ctxInfo.sectionIdx, startMs: webcamBelowSince, endMs: nowMs, ms: nowMs - webcamBelowSince });
    }
    screenOngoing = webcamOngoing = false;
    screenBelowSince = webcamBelowSince = null;
  }

  async function aiTick() {
    if (aiInFlight || !cfg.aiEnabled || aiDisabledReason) return;
    const ctxInfo = hooks.getContext();
    if (!ctxInfo.running || !videoScreen || videoScreen.readyState < 2) return;
    const labels = ctxInfo.labels || [];
    if (!labels.length) return;

    const vw = videoScreen.videoWidth, vh = videoScreen.videoHeight;
    if (!vw || !vh) return;
    const maxW = 960;
    const scale = Math.min(1, maxW / vw);
    const w = Math.round(vw * scale), h = Math.round(vh * scale);
    aiCanvas.width = w; aiCanvas.height = h;
    aiCanvas.getContext("2d").drawImage(videoScreen, 0, 0, w, h);
    const image = aiCanvas.toDataURL("image/jpeg", 0.6);

    aiInFlight = true;
    try {
      const res = await fetch("/api/vision/section", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image, subject: ctxInfo.subject, labels, currentIndex: ctxInfo.sectionIdx }),
      });
      if (res.status === 503) {
        // LM Studio isn't reachable/running — stop polling until tracking is
        // toggled off and back on (e.g. after starting LM Studio).
        aiDisabledReason = "lm-studio-unreachable";
        if (aiTimer) { clearInterval(aiTimer); aiTimer = null; }
        emitStatus();
        return;
      }
      if (!res.ok) return; // transient — just skip this cycle
      const data = await res.json();
      if (data.index != null && data.index !== -1 && data.index !== ctxInfo.sectionIdx && data.confidence >= 0.4) {
        hooks.onAiSuggestion({ index: data.index, label: data.label, confidence: data.confidence });
      }
    } catch (e) {
      // network hiccup — try again next interval
    } finally {
      aiInFlight = false;
    }
  }

  function startTimers() {
    if (!diffTimer) diffTimer = setInterval(() => { tickScreen(); tickWebcam(); }, DIFF_SAMPLE_MS);
    if (!aiTimer && cfg.aiEnabled && !aiDisabledReason) aiTimer = setInterval(aiTick, cfg.aiIntervalMs);
  }
  function stopTimers() {
    if (diffTimer) { clearInterval(diffTimer); diffTimer = null; }
    if (aiTimer) { clearInterval(aiTimer); aiTimer = null; }
  }

  return {
    init(h) { hooks = { ...hooks, ...h }; },

    setConfig(next) {
      const aiIntervalChanged = next.aiIntervalMs && next.aiIntervalMs !== cfg.aiIntervalMs;
      cfg = { ...cfg, ...next };
      if (screenStream) {
        if (!cfg.aiEnabled && aiTimer) { clearInterval(aiTimer); aiTimer = null; }
        if (cfg.aiEnabled && !aiTimer && !aiDisabledReason) aiTimer = setInterval(aiTick, cfg.aiIntervalMs);
        else if (aiIntervalChanged && aiTimer) { clearInterval(aiTimer); aiTimer = setInterval(aiTick, cfg.aiIntervalMs); }
      }
    },

    isActive() { return !!(screenStream || webcamStream); },
    status,

    async enable() {
      const errors = [];
      if (!diffCanvasScreen) diffCanvasScreen = document.createElement("canvas");
      if (!diffCanvasWebcam) diffCanvasWebcam = document.createElement("canvas");
      if (!aiCanvas) aiCanvas = document.createElement("canvas");

      try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        videoScreen = mkVideo();
        videoScreen.srcObject = screenStream;
        screenStream.getVideoTracks()[0].addEventListener("ended", () => {
          screenStream = null; videoScreen?.remove(); videoScreen = null; emitStatus();
        });
      } catch (e) {
        errors.push("Screen share permission was not granted.");
      }

      try {
        webcamStream = await navigator.mediaDevices.getUserMedia({ video: true });
        videoWebcam = mkVideo();
        videoWebcam.srcObject = webcamStream;
        webcamStream.getVideoTracks()[0].addEventListener("ended", () => {
          webcamStream = null; videoWebcam?.remove(); videoWebcam = null; emitStatus();
        });
      } catch (e) {
        errors.push("Webcam permission was not granted.");
      }

      if (screenStream || webcamStream) startTimers();
      emitStatus();
      return { ok: !!(screenStream || webcamStream), errors };
    },

    // Closes out any in-progress idle/away spell (e.g. right when a run
    // finishes) so its event gets logged instead of silently dropped.
    flush() { closeOngoing(); },

    disable() {
      closeOngoing();
      stopTimers();
      if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
      if (webcamStream) { webcamStream.getTracks().forEach(t => t.stop()); webcamStream = null; }
      videoScreen?.remove(); videoWebcam?.remove();
      videoScreen = videoWebcam = null;
      prevScreenData = prevWebcamData = null;
      screenBelowSince = webcamBelowSince = null;
      screenOngoing = webcamOngoing = false;
      aiDisabledReason = null;
      emitStatus();
    },
  };
})();
