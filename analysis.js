/* ============================================================================
 *  Sprint-Kraftanalyse · Biomechanik-Kern (Portierung aus sprint_kraft_analyse.py)
 *  ----------------------------------------------------------------------------
 *  Berechnet Bodenreaktionskräfte aus Pose-Landmarks via inverser Dynamik.
 *      F_GRK = m · a_KSP + m · g
 *  Alle wissenschaftlichen Formeln entsprechen 1:1 dem Python-Original.
 * ========================================================================= */
(function (global) {
  "use strict";

  const G = 9.81; // Erdbeschleunigung [m/s²]

  // Segmentmodell nach de Leva (1996), Männer
  const SEGMENTS = {
    head:  { mass: 0.0694, com: 0.50 },
    trunk: { mass: 0.4346, com: 0.5138 },
    uarm:  { mass: 0.0271, com: 0.5772 },
    farm:  { mass: 0.0162, com: 0.4574 },
    hand:  { mass: 0.0061, com: 0.50 },
    thigh: { mass: 0.1478, com: 0.4095 },
    shank: { mass: 0.0481, com: 0.4395 },
    foot:  { mass: 0.0129, com: 0.4014 },
  };

  // MediaPipe Pose Landmark-Indizes (aus 33 Körperpunkten)
  const LM = {
    nose: 0,
    l_shoulder: 11, r_shoulder: 12,
    l_elbow: 13,    r_elbow: 14,
    l_wrist: 15,    r_wrist: 16,
    l_hip: 23,      r_hip: 24,
    l_knee: 25,     r_knee: 26,
    l_ankle: 27,    r_ankle: 28,
    l_toe: 31,      r_toe: 32,
  };

  const WINKEL_KEYS = ["l_ankle", "r_ankle", "l_knee", "r_knee",
                       "l_hip", "r_hip", "trunk_ground"];

  // ── Vektor-Helfer (2D als [x, y]) ─────────────────────────────────────────
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
  const scale = (a, s) => [a[0] * s, a[1] * s];
  const norm = (a) => Math.hypot(a[0], a[1]);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1];

  function segCom(p1, p2, frac) {            // p1 + frac·(p2 − p1)
    return add(p1, scale(sub(p2, p1), frac));
  }
  function midpoint(p1, p2) {
    return [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
  }

  // ── Landmarks aus MediaPipe-Ergebnis in Pixel-Dict umwandeln ──────────────
  function toLandmarkDict(poseLandmarks, w, h) {
    const out = {};
    for (const name in LM) {
      const p = poseLandmarks[LM[name]];
      out[name] = [p.x * w, p.y * h];
    }
    return out;
  }

  // ── Ganzkörper-KSP aus 14-Segment-Modell ──────────────────────────────────
  function bodyCom(lm) {
    const sh  = midpoint(lm.l_shoulder, lm.r_shoulder);
    const hip = midpoint(lm.l_hip, lm.r_hip);
    const S = SEGMENTS;
    const parts = [
      [S.head.mass,  segCom(sh, lm.nose, S.head.com)],
      [S.trunk.mass, segCom(sh, hip, S.trunk.com)],
      [S.uarm.mass,  segCom(lm.l_shoulder, lm.l_elbow, S.uarm.com)],
      [S.uarm.mass,  segCom(lm.r_shoulder, lm.r_elbow, S.uarm.com)],
      [S.farm.mass,  segCom(lm.l_elbow, lm.l_wrist, S.farm.com)],
      [S.farm.mass,  segCom(lm.r_elbow, lm.r_wrist, S.farm.com)],
      [S.hand.mass,  lm.l_wrist],
      [S.hand.mass,  lm.r_wrist],
      [S.thigh.mass, segCom(lm.l_hip, lm.l_knee, S.thigh.com)],
      [S.thigh.mass, segCom(lm.r_hip, lm.r_knee, S.thigh.com)],
      [S.shank.mass, segCom(lm.l_knee, lm.l_ankle, S.shank.com)],
      [S.shank.mass, segCom(lm.r_knee, lm.r_ankle, S.shank.com)],
      [S.foot.mass,  segCom(lm.l_ankle, lm.l_toe, S.foot.com)],
      [S.foot.mass,  segCom(lm.r_ankle, lm.r_toe, S.foot.com)],
    ];
    let totalMass = 0, cx = 0, cy = 0;
    for (const [m, pos] of parts) {
      totalMass += m; cx += m * pos[0]; cy += m * pos[1];
    }
    return [cx / totalMass, cy / totalMass];
  }

  // ── Gelenkwinkel ──────────────────────────────────────────────────────────
  function winkelZwischen(v1, v2) {          // Innenwinkel [Grad] 0–180
    const n1 = norm(v1), n2 = norm(v2);
    if (n1 < 1e-6 || n2 < 1e-6) return NaN;
    const c = Math.min(1, Math.max(-1, dot(v1, v2) / (n1 * n2)));
    return (Math.acos(c) * 180) / Math.PI;
  }
  function winkelZumBoden(pUnten, pOben) {   // gegen Horizontale, 90°=senkrecht
    const v = sub(pOben, pUnten);
    if (norm(v) < 1e-6) return NaN;
    return (Math.atan2(Math.abs(v[1]), Math.abs(v[0])) * 180) / Math.PI;
  }

  function gelenkwinkel(lm) {
    const shMid  = midpoint(lm.l_shoulder, lm.r_shoulder);
    const hipMid = midpoint(lm.l_hip, lm.r_hip);
    const w = {};
    for (const s of ["l", "r"]) {
      const sho = lm[s + "_shoulder"], hip = lm[s + "_hip"];
      const kne = lm[s + "_knee"], ank = lm[s + "_ankle"], toe = lm[s + "_toe"];
      w[s + "_ankle"] = winkelZwischen(sub(toe, ank), sub(kne, ank));
      w[s + "_knee"]  = winkelZwischen(sub(ank, kne), sub(hip, kne));
      w[s + "_hip"]   = winkelZwischen(sub(kne, hip), sub(sho, hip));
    }
    w.trunk_ground = winkelZumBoden(hipMid, shMid);
    return w;
  }

  // ── Butterworth Low-Pass (4. Ordnung, zero-phase via filtfilt) ─────────────
  //   Nutzt fili.js. order:2 Cascade = 4. Ordnung gesamt (= Python order=4).
  //   MUSS vor der Differentiation laufen (Rauschverstärkung!).
  function smooth(data, cutoffHz, fps) {
    const n = data.length;
    if (n < 4) return data.slice();
    const Fs = fps;
    const Fc = Math.min(cutoffHz, (Fs / 2) * 0.99);
    const iir = new Fili.CalcCascades();
    const coeffs = iir.lowpass({ order: 2, characteristic: "butterworth", Fs: Fs, Fc: Fc });

    // fili.filtfilt initialisiert den Filterzustand NICHT (anders als SciPy).
    // Ohne Gegenmaßnahme erzeugt ein Signal mit Offset/Trend gewaltige
    // Einschwing-Transienten an den Rändern, die nach 2× Ableiten explodieren.
    // → 1) lineares Detrending (Endpunkte auf 0)  2) Odd-Reflection-Padding.
    const a0 = data[0];
    const slope = (data[n - 1] - data[0]) / (n - 1);
    const r = new Array(n);
    for (let i = 0; i < n; i++) r[i] = data[i] - (a0 + slope * i);

    const pad = Math.min(n - 1, Math.max(15, 3 * Math.round(Fs / Fc)));
    const padded = new Array(pad + n + pad);
    for (let i = 0; i < pad; i++) padded[i] = 2 * r[0] - r[pad - i];          // links
    for (let i = 0; i < n; i++) padded[pad + i] = r[i];
    for (let i = 0; i < pad; i++) padded[pad + n + i] = 2 * r[n - 1] - r[n - 2 - i]; // rechts

    const filter = new Fili.IirFilter(coeffs);
    const f = filter.filtfilt(padded);

    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = f[pad + i] + (a0 + slope * i);       // Trend zurück
    return out;
  }

  // ── Numerische Differentiation (Zentraldifferenz, wie np.gradient) ─────────
  function differentiate(y, dt) {
    const n = y.length, g = new Array(n);
    if (n === 1) { g[0] = 0; return g; }
    g[0] = (y[1] - y[0]) / dt;
    g[n - 1] = (y[n - 1] - y[n - 2]) / dt;
    for (let i = 1; i < n - 1; i++) g[i] = (y[i + 1] - y[i - 1]) / (2 * dt);
    return g;
  }

  // ── Kalibrierung: Pixel → Meter aus Athletengröße ─────────────────────────
  //   Nase bis Knöchel ≈ 88 % der Körpergröße.
  function calibrate(lm, heightM) {
    const noseY  = lm.nose[1];
    const ankleY = Math.max(lm.l_ankle[1], lm.r_ankle[1]);
    return Math.abs(ankleY - noseY) / (heightM * 0.88);
  }

  // ── Hauptberechnung: inverse Dynamik ──────────────────────────────────────
  function computeGrf(frames, fps, massKg, ppm, cutoffHz) {
    const dt = 1 / fps;
    const times = frames.map((f) => f.time);
    const comPx = frames.map((f) => bodyCom(f.lm));

    // Pixel → Meter, y-Achse umkehren (Bild-y nach unten → Physik-y nach oben)
    const xM = comPx.map((c) => c[0] / ppm);
    const yM = comPx.map((c) => -c[1] / ppm);

    const xF = smooth(xM, cutoffHz, fps);
    const yF = smooth(yM, cutoffHz, fps);

    const vx = differentiate(xF, dt);
    const vy = differentiate(yF, dt);
    const ax = differentiate(vx, dt);
    const ay = differentiate(vy, dt);

    const Fv = ay.map((a) => Math.max(0, massKg * (a + G))); // vertikal
    const Fh = ax.map((a) => massKg * a);                    // horizontal

    const thresh = 0.05 * massKg * G;
    const inContact = Fv.map((f) => f > thresh);

    const angles = frames.map((f) => gelenkwinkel(f.lm));

    return {
      times, dt, fps, mass: massKg,
      com_raw_y: yM, com_y: yF, com_x: xF,
      vel_y: vy, vel_x: vx, acc_y: ay, acc_x: ax,
      Fv, Fh, in_contact: inContact, angles,
    };
  }

  function winkelArray(angles, key) {
    return angles.map((a) => (a[key] === undefined ? NaN : a[key]));
  }

  function trapezoid(y, dx) {
    let s = 0;
    for (let i = 1; i < y.length; i++) s += ((y[i] + y[i - 1]) / 2) * dx;
    return s;
  }

  // ── Sprint-Metriken pro Bodenkontakt ──────────────────────────────────────
  function sprintMetrics(res) {
    const mG = res.mass * G;
    const dt = res.dt;
    const contact = res.in_contact;
    const vx = res.vel_x;

    const phases = [];
    let inC = false, start = 0;
    for (let i = 0; i < contact.length; i++) {
      if (contact[i] && !inC) { start = i; inC = true; }
      else if (!contact[i] && inC) { phases.push([start, i]); inC = false; }
    }
    if (inC) phases.push([start, contact.length]);

    const results = [];
    for (const [s, e] of phases) {
      if (e - s < 5) continue;
      const fv = res.Fv.slice(s, e);
      const fh = res.Fh.slice(s, e);
      const vel = vx.slice(s, e).map(Math.abs);
      const tc = (e - s) * dt;

      const Fvp = Math.max(...fv);
      const Fhp = Math.max(...fh.map(Math.abs));
      const Jh = trapezoid(fh, dt);
      const Rf = Fvp > 0 ? Fhp / Math.hypot(Fvp, Fhp) : 0;
      const vMean = vel.reduce((a, b) => a + b, 0) / vel.length;

      results.push({
        tc_ms: Math.round(tc * 1000),
        Fv_BW: +(Fvp / mG).toFixed(2),
        Fh_BW: +(Fhp / mG).toFixed(2),
        Jh_Ns: +Jh.toFixed(2),
        Rf_pct: +(Rf * 100).toFixed(1),
        Pmax_W: vMean > 0 ? Math.round(Fhp * vMean) : null,
      });
    }
    return results;
  }

  global.SPRINT = global.SPRINT || {};
  global.SPRINT.analysis = {
    G, LM, SEGMENTS, WINKEL_KEYS,
    toLandmarkDict, bodyCom, gelenkwinkel, calibrate,
    computeGrf, sprintMetrics, winkelArray, midpoint,
  };
})(window);
