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
const kraftChk = $("kraftChk");
const kraftHint = $("kraftHint");
const metricsCard = $("metricsCard");
const chartsCard = $("chartsCard");
const seekBar = $("seekBar");
const timeLbl = $("timeLbl");
const muteBtn = $("muteBtn");
const toggleReakt = $("toggleReakt");
const reaktBox = $("reaktBox");
const waveCanvas = $("waveCanvas");

let landmarker = null;
let state = null; // { frames, res, fps, mass }
let wave = null;  // { env_t, env_v, dur }  — Lautstärke-Hüllkurve (WebAudio)
let reakt = { start: null, ende: null, dragT0: null, dragT1: null, dragging: false };

// ── Kraftberechnung-Checkbox (Startseite) ──────────────────────────────────
function updateKraftUi() {
  const on = kraftChk.checked;
  [massInput, heightInput, cutoffInput].forEach((el) => (el.disabled = !on));
  kraftHint.textContent = on
    ? ""
    : "Nur Reaktionszeit-Modus: überspringt Pose-Erkennung und Kraftberechnung (deutlich schneller).";
  startBtn.textContent = on ? "Analyse starten" : "Reaktionszeit-Modus starten";
}
kraftChk.addEventListener("change", updateKraftUi);
updateKraftUi();

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

// ── Lautstärke-Hüllkurve aus der Tonspur (WebAudio) ─────────────────────────
//   Pendant zu extrahiere_lautstaerke() im Python-Skript. decodeAudioData
//   dekodiert die Audiospur des Videos; daraus RMS je kurzem Zeitfenster.
//   Der Startschuss/-piepser ist der lauteste Ausschlag → deutlicher Peak.
async function ladeLautstaerke(file, binsProSek = 200) {
  try {
    const buf = await file.arrayBuffer();
    const AC = window.AudioContext || window.webkitAudioContext;
    const ac = new AC();
    const audioBuf = await ac.decodeAudioData(buf);
    ac.close();
    const ch = audioBuf.getChannelData(0); // erster Kanal (mono genügt)
    const sr = audioBuf.sampleRate;
    const binLen = Math.max(1, Math.floor(sr / binsProSek));
    const nBins = Math.floor(ch.length / binLen);
    if (nBins < 2) return null;
    const env_t = new Float32Array(nBins);
    const env_v = new Float32Array(nBins);
    let maxv = 0;
    for (let b = 0; b < nBins; b++) {
      let s = 0;
      const off = b * binLen;
      for (let i = 0; i < binLen; i++) { const x = ch[off + i]; s += x * x; }
      const rms = Math.sqrt(s / binLen);
      env_v[b] = rms;
      env_t[b] = ((b + 0.5) * binLen) / sr;
      if (rms > maxv) maxv = rms;
    }
    if (maxv > 0) for (let b = 0; b < nBins; b++) env_v[b] /= maxv;
    return { env_t, env_v, dur: audioBuf.duration };
  } catch (e) {
    console.warn("Tonspur konnte nicht dekodiert werden:", e);
    return null; // kein/ nicht dekodierbares Audio → Reaktionsmodus ohne Kurve
  }
}

// ── Komplette Analyse ───────────────────────────────────────────────────────
async function runAnalysis() {
  if (!fileInput.files.length) { showError("Bitte zuerst ein Video auswählen."); return; }
  const kraft = kraftChk.checked;

  const mass = parseFloat(massInput.value.replace(",", "."));
  const height = parseFloat(heightInput.value.replace(",", "."));
  const cutoff = parseFloat(cutoffInput.value.replace(",", "."));
  if (kraft && (!(mass > 0) || !(height > 0) || !(cutoff > 0))) {
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

  // Tonspur für die Lautstärke-Kurve (beide Modi) laden
  setProgress(kraft ? 6 : 40, "Tonspur wird analysiert …");
  wave = await ladeLautstaerke(fileInput.files[0]);

  if (kraft) {
    // ── Voller Ablauf: Pose-Erkennung + inverse Dynamik ────────────────────
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
    frames.forEach((f, i) => { f.winkel = res.angles[i]; }); // Winkel fürs Overlay

    setProgress(90, "Metriken & Diagramme …");
    const metrics = A.sprintMetrics(res);
    state = { frames, res, fps, mass, ppm, cutoff, height, metrics };

    renderMetrics(metrics);
    CH.renderAll(res);
    showForceUi(true);
    setupOverlayPlayback();
    setReaktion(false);
  } else {
    // ── Nur Reaktionszeit-Modus: keine Pose, keine Kraftberechnung ─────────
    state = { frames: [], res: null, fps, mass: NaN, height: NaN };
    showForceUi(false);
    setupOverlayPlayback();
    setReaktion(true); // Reaktionsmodus dauerhaft aktiv
  }

  setProgress(100, "Fertig.");
  setTimeout(() => setProgressVisible(false), 400);
  setupCard.classList.add("collapsed");
  resultsSection.classList.remove("hidden");
  resultsSection.scrollIntoView({ behavior: "smooth" });
  // Wave-Canvas erst dimensionieren, wenn der Bereich sichtbar ist (clientWidth > 0)
  if (playState.reaktion) { sizeWaveCanvas(); drawWave(video.currentTime); }
}

// Blendet Kraft-spezifische UI (Metriken, Diagramme, Ansicht/Winkel/Reaktion-
// Umschalter) je nach Modus ein oder aus.
function showForceUi(on) {
  metricsCard.classList.toggle("hidden", !on);
  chartsCard.classList.toggle("hidden", !on);
  $("toggleModus").classList.toggle("hidden", !on);
  $("toggleWinkel").classList.toggle("hidden", !on);
  toggleReakt.classList.toggle("hidden", !on); // im Reaktions-Only-Modus fest an
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
let playState = { modus: "voll", winkel: true, reaktion: false, FvSerie: [], FhSerie: [] };

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
  // Reaktions-Only-Modus (ohne Kraftberechnung): keine Pose → Overlay leer
  if (!state.res || !state.frames.length) {
    octx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    return;
  }
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
            FvSerie, FhSerie, playState.modus,
            { winkel: playState.winkel, reaktion: playState.reaktion });
}

let playbackWired = false;
function setupOverlayPlayback() {
  overlayCanvas.width = video.videoWidth;
  overlayCanvas.height = video.videoHeight;
  video.currentTime = 0;
  video.muted = false;          // Ton standardmäßig an (Video spielt nativ synchron)
  updateMuteBtn();

  const loop = () => {
    tick(video.currentTime);
    if (!video.paused && !video.ended) {
      video.requestVideoFrameCallback ? video.requestVideoFrameCallback(loop)
                                      : requestAnimationFrame(loop);
    }
  };

  if (!playbackWired) {          // Listener nur einmal binden (mehrere Analysen)
    playbackWired = true;
    video.addEventListener("play", () => {
      video.requestVideoFrameCallback ? video.requestVideoFrameCallback(loop)
                                      : requestAnimationFrame(loop);
    });
    video.addEventListener("seeked", () => tick(video.currentTime));
    video.addEventListener("timeupdate", () => { if (video.paused) tick(video.currentTime); });
    window.addEventListener("resize", () => {
      if (playState.reaktion) { sizeWaveCanvas(); drawWave(video.currentTime); }
    });
  }

  tick(0);
}

// Ein Aktualisierungsschritt: Overlay, Seek-Leiste und (falls aktiv) Reaktions-Panel.
function tick(t) {
  drawOverlayAt(t);
  updateSeek(t);
  if (playState.reaktion) updateReaktion(t);
}

// ── Seek-Leiste (Videoplayer-Balken mit Punkt) ──────────────────────────────
let scrubbing = false;
function updateSeek(t) {
  const d = video.duration || 0;
  if (!scrubbing && d > 0) seekBar.value = Math.round((t / d) * 1000);
  timeLbl.textContent = `${t.toFixed(2)} / ${(d || 0).toFixed(2)} s`;
}
seekBar.addEventListener("pointerdown", () => { scrubbing = true; });
seekBar.addEventListener("pointerup", () => { scrubbing = false; });
seekBar.addEventListener("pointercancel", () => { scrubbing = false; });
seekBar.addEventListener("input", () => {
  const d = video.duration || 0;
  if (d > 0) video.currentTime = (seekBar.value / 1000) * d;
});

// ── Ton an/aus (Stummschaltung) ─────────────────────────────────────────────
function updateMuteBtn() {
  muteBtn.textContent = video.muted ? "🔇 stumm" : "🔊 Ton";
  muteBtn.classList.toggle("active", !video.muted);
}
muteBtn.addEventListener("click", () => { video.muted = !video.muted; updateMuteBtn(); });

// ── Reaktionszeit-Modus ─────────────────────────────────────────────────────
function setReaktion(on) {
  playState.reaktion = on;
  toggleReakt.textContent = "Reaktion: " + (on ? "an" : "aus");
  toggleReakt.classList.toggle("active", on);
  reaktBox.classList.toggle("hidden", !on);
  if (on) { sizeWaveCanvas(); updateReaktion(video.currentTime); }
  drawOverlayAt(video.currentTime); // Kraft-Overlays werden im Reaktionsmodus ausgeblendet
}

function sizeWaveCanvas() {
  const cssW = waveCanvas.clientWidth || (waveCanvas.parentElement || {}).clientWidth || 600;
  waveCanvas.width = Math.max(120, Math.round(cssW));
  waveCanvas.height = 96;
}

function reaktDauer() { return video.duration || (wave ? wave.dur : 1) || 1; }

function updateReaktion(t) {
  drawWave(t);
  const f3 = (x) => x.toFixed(3) + " s";
  $("rStart").textContent = reakt.start == null ? "–" : f3(reakt.start);
  $("rEnde").textContent = reakt.ende == null ? "–" : f3(reakt.ende);
  $("rSeit").textContent = reakt.start == null ? "–"
    : ((t - reakt.start >= 0 ? "+" : "") + (t - reakt.start).toFixed(3) + " s");
  $("rReakt").textContent = (reakt.start != null && reakt.ende != null)
    ? (reakt.ende - reakt.start).toFixed(3) + " s" : "–";
}

// Startpunkt = lautester Punkt im gewählten Bereich (ohne Audio: Bereichsanfang)
function snapStart(t0, t1) {
  if (!wave) {
    reakt.start = Math.min(t0, t1);
  } else {
    const lo = Math.min(t0, t1), hi = Math.max(t0, t1);
    let best = -1, bt = lo;
    for (let i = 0; i < wave.env_t.length; i++) {
      const tt = wave.env_t[i];
      if (tt < lo) continue;
      if (tt > hi) break;
      if (wave.env_v[i] > best) { best = wave.env_v[i]; bt = tt; }
    }
    reakt.start = bt;
  }
  video.pause();
  video.currentTime = Math.max(0, Math.min(reaktDauer(), reakt.start));
  updateReaktion(reakt.start);
}

function drawWave(t) {
  const ctx = waveCanvas.getContext("2d");
  const W = waveCanvas.width, H = waveCanvas.height;
  ctx.clearRect(0, 0, W, H);
  const dur = reaktDauer();
  const x0 = 6, x1 = W - 6, ww = x1 - x0;
  const yTop = 14, yBot = H - 6;
  const xOf = (tt) => x0 + Math.max(0, Math.min(1, tt / dur)) * ww;

  if (wave) {
    const n = wave.env_v.length;
    const envDur = wave.env_t[n - 1] || dur;
    const envAt = (tt) => {
      if (tt > envDur) return 0;
      let i = Math.round((tt / envDur) * (n - 1));
      if (i < 0) i = 0; if (i > n - 1) i = n - 1;
      return wave.env_v[i];
    };
    // gefüllte Hüllkurve
    ctx.beginPath();
    ctx.moveTo(x0, yBot);
    for (let px = 0; px <= ww; px++) {
      const v = envAt((px / ww) * dur);
      ctx.lineTo(x0 + px, yBot - v * (yBot - yTop));
    }
    ctx.lineTo(x1, yBot);
    ctx.closePath();
    ctx.fillStyle = "rgba(60,140,90,0.45)";
    ctx.fill();
    ctx.strokeStyle = "rgb(120,210,120)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let px = 0; px <= ww; px++) {
      const v = envAt((px / ww) * dur);
      const y = yBot - v * (yBot - yTop);
      px === 0 ? ctx.moveTo(x0, y) : ctx.lineTo(x0 + px, y);
    }
    ctx.stroke();
  } else {
    ctx.fillStyle = "rgb(150,150,200)";
    ctx.font = "13px sans-serif";
    ctx.fillText("Kein Ton dekodierbar – Start/Ende manuell setzen", x0 + 8, H / 2);
  }

  // Auswahl-Bereich (Ziehen)
  if (reakt.dragging && reakt.dragT0 != null) {
    const xa = Math.min(xOf(reakt.dragT0), xOf(reakt.dragT1));
    const xb = Math.max(xOf(reakt.dragT0), xOf(reakt.dragT1));
    ctx.fillStyle = "rgba(60,180,230,0.22)";
    ctx.fillRect(xa, yTop - 6, xb - xa, yBot - yTop + 6);
    ctx.strokeStyle = "rgb(60,180,230)";
    ctx.lineWidth = 1;
    ctx.strokeRect(xa, yTop - 6, xb - xa, yBot - yTop + 6);
  }
  // Start-/Ende-Marker
  const marker = (tt, color, txt) => {
    const x = xOf(tt);
    ctx.strokeStyle = color; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, yTop - 8); ctx.lineTo(x, yBot); ctx.stroke();
    ctx.fillStyle = color; ctx.font = "11px sans-serif";
    ctx.fillText(txt, Math.min(x + 3, W - 34), yTop - 1);
  };
  if (reakt.start != null) marker(reakt.start, "rgb(80,220,110)", "Start");
  if (reakt.ende != null) marker(reakt.ende, "rgb(90,140,255)", "Ende");
  // Playhead (aktuelle Position)
  const xn = xOf(t);
  ctx.strokeStyle = "rgba(255,255,255,0.95)"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(xn, 2); ctx.lineTo(xn, H - 2); ctx.stroke();
}

// Ziehen über die Kurve (Maus & Touch via Pointer-Events)
function waveTimeAt(clientX) {
  const r = waveCanvas.getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  return frac * reaktDauer();
}
waveCanvas.addEventListener("pointerdown", (e) => {
  if (!playState.reaktion) return;
  reakt.dragging = true;
  reakt.dragT0 = waveTimeAt(e.clientX);
  reakt.dragT1 = reakt.dragT0;
  try { waveCanvas.setPointerCapture(e.pointerId); } catch (_) {}
  drawWave(video.currentTime);
});
waveCanvas.addEventListener("pointermove", (e) => {
  if (!reakt.dragging) return;
  reakt.dragT1 = waveTimeAt(e.clientX);
  drawWave(video.currentTime);
});
function endDrag(e) {
  if (!reakt.dragging) return;
  reakt.dragging = false;
  reakt.dragT1 = waveTimeAt(e.clientX);
  snapStart(reakt.dragT0, reakt.dragT1);
  reakt.dragT0 = reakt.dragT1 = null;
}
waveCanvas.addEventListener("pointerup", endDrag);
waveCanvas.addEventListener("pointercancel", () => { reakt.dragging = false; });

$("rSetStart").addEventListener("click", () => { reakt.start = video.currentTime; updateReaktion(video.currentTime); });
$("rSetEnde").addEventListener("click", () => { reakt.ende = video.currentTime; updateReaktion(video.currentTime); });
$("rClear").addEventListener("click", () => {
  reakt.start = reakt.ende = reakt.dragT0 = reakt.dragT1 = null;
  updateReaktion(video.currentTime);
});
toggleReakt.addEventListener("click", () => setReaktion(!playState.reaktion));

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
  if (!state || !state.res) return; // im Reaktions-Only-Modus keine Kraftdaten
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
