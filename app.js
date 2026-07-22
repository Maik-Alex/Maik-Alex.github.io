/* ============================================================================
 *  Sprint-Kraftanalyse · Web-App Hauptsteuerung
 *  Lädt MediaPipe (Web), extrahiert Posen aus dem Galerie-Video, führt die
 *  Pipeline aus und spielt das Video mit Overlay ab.
 * ========================================================================= */
import {
  FilesetResolver,
  PoseLandmarker,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18";

const A = window.SPRINT.analysis;
const OV = window.SPRINT.overlay;
const CH = window.SPRINT.charts;

// ── DOM ──────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const fileInput = $("fileInput");
const massInput = $("mass");
const heightInput = $("height");
const cutoffInput = $("cutoff");
const startBtn = $("startBtn");
const progressWrap = $("progressWrap");
const progressBar = $("progressBar");
const progressTxt = $("progressTxt");
const setupCard = $("setupCard");
const resultsSection = $("results");
const video = $("video");
const overlayCanvas = $("overlay");
const octx = overlayCanvas.getContext("2d");
const metricsBody = $("metricsBody");
const errorBox = $("errorBox");

let landmarker = null;
let state = null; // { frames, res, fps, mass }

// ── MediaPipe-Landmarker (lazy, einmalig) ──────────────────────────────────
async function getLandmarker() {
  if (landmarker) return landmarker;
  setProgress(2, "Lade Pose-Modell …");
  const fileset = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm"
  );
  try {
    landmarker = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: "pose_landmarker_full.task", delegate: "GPU" },
      runningMode: "VIDEO",
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  } catch (e) {
    // Fallback auf CPU, falls GPU-Delegate nicht verfügbar
    landmarker = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: "pose_landmarker_full.task", delegate: "CPU" },
      runningMode: "VIDEO",
      numPoses: 1,
    });
  }
  return landmarker;
}

// ── Datei laden ─────────────────────────────────────────────────────────────
fileInput.addEventListener("change", () => {
  if (fileInput.files.length) {
    const url = URL.createObjectURL(fileInput.files[0]);
    video.src = url;
    startBtn.disabled = false;
    $("fileName").textContent = fileInput.files[0].name;
  }
});

startBtn.addEventListener("click", () => {
  hideError();
  runAnalysis().catch((e) => {
    console.error(e);
    showError(e.message || String(e));
    setProgressVisible(false);
    startBtn.disabled = false;
  });
});

// ── fps messen (über requestVideoFrameCallback) ─────────────────────────────
function measureFps(v) {
  return new Promise((resolve) => {
    if (!("requestVideoFrameCallback" in HTMLVideoElement.prototype)) {
      resolve(30); return;
    }
    const times = [];
    let count = 0;
    const onFrame = (now, meta) => {
      times.push(meta.mediaTime);
      count++;
      if (count >= 12) {
        v.pause();
        const diffs = [];
        for (let i = 1; i < times.length; i++) diffs.push(times[i] - times[i - 1]);
        diffs.sort((a, b) => a - b);
        const med = diffs[Math.floor(diffs.length / 2)] || 1 / 30;
        resolve(Math.min(1000, Math.max(15, Math.round(1 / med))));
      } else {
        v.requestVideoFrameCallback(onFrame);
      }
    };
    v.currentTime = 0;
    v.muted = true;
    v.play().then(() => v.requestVideoFrameCallback(onFrame)).catch(() => resolve(30));
  });
}

// ── Seek-basierte Frame-Extraktion (deterministisch, ohne Frame-Drops) ──────
function seekTo(v, t) {
  return new Promise((resolve) => {
    const onSeeked = () => { v.removeEventListener("seeked", onSeeked); resolve(); };
    v.addEventListener("seeked", onSeeked);
    v.currentTime = t;
  });
}

async function extractPoses(v, fps) {
  const lm = await getLandmarker();
  const w = v.videoWidth, h = v.videoHeight;
  const cvs = document.createElement("canvas");
  cvs.width = w; cvs.height = h;
  const c = cvs.getContext("2d", { willReadFrequently: true });

  const dt = 1 / fps;
  const duration = v.duration;
  const total = Math.max(1, Math.floor(duration / dt));
  const frames = [];
  let ts = 0;

  v.pause();
  for (let i = 0; i < total; i++) {
    const t = i * dt;
    await seekTo(v, t);
    c.drawImage(v, 0, 0, w, h);
    ts = Math.round(t * 1000);
    if (ts <= (frames.length ? frames[frames.length - 1]._ts : -1)) ts += 1;
    const result = lm.detectForVideo(cvs, ts);
    if (result.landmarks && result.landmarks.length) {
      const dict = A.toLandmarkDict(result.landmarks[0], w, h);
      frames.push({ lm: dict, time: t, _ts: ts });
    }
    if (i % 4 === 0 || i === total - 1) {
      setProgress(10 + (i / total) * 70, `Pose-Erkennung … Frame ${i + 1}/${total}`);
      await new Promise((r) => setTimeout(r, 0)); // UI atmen lassen
    }
  }
  return frames;
}

// ── Komplette Analyse ───────────────────────────────────────────────────────
async function runAnalysis() {
  if (!fileInput.files.length) { showError("Bitte zuerst ein Video auswählen."); return; }
  const mass = parseFloat(massInput.value.replace(",", "."));
  const height = parseFloat(heightInput.value.replace(",", "."));
  const cutoff = parseFloat(cutoffInput.value.replace(",", "."));
  if (!(mass > 0) || !(height > 0) || !(cutoff > 0)) {
    showError("Masse, Größe und Filter müssen positive Zahlen sein.");
    return;
  }

  startBtn.disabled = true;
  setProgressVisible(true);
  setProgress(1, "Video wird geladen …");

  // Metadaten laden
  await new Promise((resolve) => {
    if (video.readyState >= 1) resolve();
    else video.addEventListener("loadedmetadata", resolve, { once: true });
  });

  setProgress(5, "Bildrate wird gemessen …");
  const fps = await measureFps(video);

  const frames = await extractPoses(video, fps);
  if (frames.length < 20) {
    throw new Error(
      "Zu wenige Frames mit Pose erkannt (" + frames.length + ").\n" +
      "Tipp: seitlich filmen, ganzer Körper vollständig im Bild."
    );
  }

  setProgress(82, "Kalibrierung & inverse Dynamik …");
  const ppm = A.calibrate(frames[0].lm, height);
  const res = A.computeGrf(frames, fps, mass, ppm, cutoff);

  // Winkel pro Frame im Frame-Objekt ablegen (für Overlay)
  frames.forEach((f, i) => { f.winkel = res.angles[i]; });

  setProgress(90, "Metriken & Diagramme …");
  const metrics = A.sprintMetrics(res);

  state = { frames, res, fps, mass, ppm, cutoff, height, metrics };

  renderMetrics(metrics);
  CH.renderAll(res);
  setupOverlayPlayback();

  setProgress(100, "Fertig.");
  setTimeout(() => setProgressVisible(false), 400);
  setupCard.classList.add("collapsed");
  resultsSection.classList.remove("hidden");
  resultsSection.scrollIntoView({ behavior: "smooth" });
}

// ── Metrik-Tabelle ───────────────────────────────────────────────────────────
function renderMetrics(metrics) {
  metricsBody.innerHTML = "";
  if (!metrics.length) {
    metricsBody.innerHTML = `<tr><td colspan="7">Keine klaren Bodenkontakte erkannt.</td></tr>`;
    return;
  }
  metrics.forEach((m, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${i + 1}</td><td>${m.tc_ms} ms</td>
      <td>${m.Fv_BW} BW</td><td>${m.Fh_BW} BW</td>
      <td>${m.Rf_pct} %</td><td>${m.Jh_Ns} N·s</td>
      <td>${m.Pmax_W ?? "–"}</td>`;
    metricsBody.appendChild(tr);
  });
}

// ── Video-Wiedergabe mit Overlay ─────────────────────────────────────────────
let playState = { modus: "voll", winkel: true, FvSerie: [], FhSerie: [] };

function nearestFrameIndex(t) {
  const times = state.res.times;
  // binäre Annäherung (times ist sortiert)
  let lo = 0, hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1; else hi = mid;
  }
  if (lo > 0 && Math.abs(times[lo - 1] - t) < Math.abs(times[lo] - t)) return lo - 1;
  return lo;
}

function drawOverlayAt(t) {
  if (!state) return;
  const idx = nearestFrameIndex(t);
  const { frames, res, mass } = state;
  const f = frames[idx];
  if (!f) { octx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height); return; }
  const Fv = res.Fv[idx], Fh = res.Fh[idx], inC = res.in_contact[idx];
  // Kraftverlauf bis zum aktuellen Frame (für Mini-Graph)
  const s = Math.max(0, idx - 499);
  const FvSerie = res.Fv.slice(s, idx + 1);
  const FhSerie = res.Fh.slice(s, idx + 1);
  OV.render(octx, overlayCanvas.width, overlayCanvas.height, f, Fv, Fh, mass, inC,
            FvSerie, FhSerie, playState.modus, { winkel: playState.winkel });
}

function setupOverlayPlayback() {
  overlayCanvas.width = video.videoWidth;
  overlayCanvas.height = video.videoHeight;
  video.currentTime = 0;

  const loop = () => {
    drawOverlayAt(video.currentTime);
    if (!video.paused && !video.ended) {
      video.requestVideoFrameCallback ? video.requestVideoFrameCallback(loop)
                                      : requestAnimationFrame(loop);
    }
  };
  video.addEventListener("play", () => {
    video.requestVideoFrameCallback ? video.requestVideoFrameCallback(loop)
                                    : requestAnimationFrame(loop);
  });
  video.addEventListener("seeked", () => drawOverlayAt(video.currentTime));
  video.addEventListener("timeupdate", () => { if (video.paused) drawOverlayAt(video.currentTime); });

  drawOverlayAt(0);
}

// ── Wiedergabe-Steuerung (Buttons) ──────────────────────────────────────────
$("playBtn").addEventListener("click", () => { video.paused ? video.play() : video.pause(); });
$("speedSel").addEventListener("change", (e) => { video.playbackRate = parseFloat(e.target.value); });
$("stepBack").addEventListener("click", () => { video.pause(); video.currentTime = Math.max(0, video.currentTime - 1 / state.fps); });
$("stepFwd").addEventListener("click", () => { video.pause(); video.currentTime = Math.min(video.duration, video.currentTime + 1 / state.fps); });
$("toggleModus").addEventListener("click", () => {
  const next = { voll: "aus", aus: "modell", modell: "voll" };
  playState.modus = next[playState.modus];
  $("toggleModus").textContent = "Ansicht: " + ({ voll: "Alles", aus: "Nur Video", modell: "Nur Modell" })[playState.modus];
  drawOverlayAt(video.currentTime);
});
$("toggleWinkel").addEventListener("click", () => {
  playState.winkel = !playState.winkel;
  $("toggleWinkel").textContent = "Winkel: " + (playState.winkel ? "an" : "aus");
  drawOverlayAt(video.currentTime);
});

// ── JSON-Export ───────────────────────────────────────────────────────────────
$("exportBtn").addEventListener("click", () => {
  if (!state) return;
  const { res, mass, height, fps, ppm, cutoff, metrics } = state;
  const nan2null = (arr) => arr.map((v) => (isNaN(v) ? null : +v.toFixed(4)));
  const exp = {
    config: { mass_kg: mass, height_m: height, fps, ppm: +ppm.toFixed(2), cutoff_hz: cutoff },
    metrics,
    timeseries: {
      time_s: nan2null(res.times),
      com_y_m: nan2null(res.com_y),
      acc_y_ms2: nan2null(res.acc_y),
      Fv_N: nan2null(res.Fv),
      Fh_N: nan2null(res.Fh),
      in_contact: res.in_contact,
    },
    angles_deg: Object.fromEntries(A.WINKEL_KEYS.map((k) =>
      [k, A.winkelArray(res.angles, k).map((v) => (isNaN(v) ? null : +v.toFixed(1)))])),
  };
  const blob = new Blob([JSON.stringify(exp, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "sprint_analyse.json";
  a.click();
});

$("newBtn").addEventListener("click", () => {
  setupCard.classList.remove("collapsed");
  setupCard.scrollIntoView({ behavior: "smooth" });
});

// ── UI-Helfer ─────────────────────────────────────────────────────────────────
function setProgress(pct, txt) {
  progressBar.style.width = Math.min(100, pct) + "%";
  if (txt) progressTxt.textContent = txt;
}
function setProgressVisible(v) { progressWrap.classList.toggle("hidden", !v); }
function showError(msg) { errorBox.textContent = msg; errorBox.classList.remove("hidden"); }
function hideError() { errorBox.classList.add("hidden"); }

// ── Service Worker registrieren (für PWA-Installation/Offline) ─────────────
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
