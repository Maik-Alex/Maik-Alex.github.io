/* ============================================================================
 *  Video-Overlay · Skelett, Kraftvektoren, HUD (Portierung der OpenCV-Zeichnung)
 *  Zeichnet auf eine transparente Canvas über dem <video>-Element.
 * ========================================================================= */
(function (global) {
  "use strict";

  const G = 9.81;
  const KNOCHEN = [
    ["l_shoulder", "r_shoulder"], ["l_shoulder", "l_hip"],
    ["r_shoulder", "r_hip"],      ["l_hip", "r_hip"],
    ["l_shoulder", "nose"],       ["r_shoulder", "nose"],
    ["l_shoulder", "l_elbow"],    ["l_elbow", "l_wrist"],
    ["r_shoulder", "r_elbow"],    ["r_elbow", "r_wrist"],
    ["l_hip", "l_knee"],          ["l_knee", "l_ankle"],  ["l_ankle", "l_toe"],
    ["r_hip", "r_knee"],          ["r_knee", "r_ankle"],  ["r_ankle", "r_toe"],
  ];

  function midpoint(a, b) { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }

  function zeichneSkelett(ctx, lm) {
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgb(210,210,210)";
    for (const [a, b] of KNOCHEN) {
      if (lm[a] && lm[b]) {
        ctx.beginPath();
        ctx.moveTo(lm[a][0], lm[a][1]);
        ctx.lineTo(lm[b][0], lm[b][1]);
        ctx.stroke();
      }
    }
    for (const name in lm) {
      ctx.beginPath();
      ctx.arc(lm[name][0], lm[name][1], 5, 0, 2 * Math.PI);
      ctx.fillStyle = "rgb(255,255,255)";
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgb(160,160,160)";
      ctx.stroke();
    }
    // KSP-Marker (Hüftmitte)
    const ksp = midpoint(lm.l_hip, lm.r_hip);
    ctx.beginPath();
    ctx.arc(ksp[0], ksp[1], 9, 0, 2 * Math.PI);
    ctx.fillStyle = "rgb(240,220,50)";
    ctx.fill();
    ctx.fillStyle = "rgb(240,220,50)";
    ctx.font = "13px sans-serif";
    ctx.fillText("KSP", ksp[0] + 11, ksp[1] - 4);
  }

  function zeichneWinkel(ctx, lm, winkel) {
    ctx.font = "14px sans-serif";
    for (const s of ["l", "r"]) {
      for (const joint of ["ankle", "knee", "hip"]) {
        const w = winkel[s + "_" + joint];
        if (w === undefined || isNaN(w)) continue;
        const p = lm[s + "_" + joint];
        label(ctx, `${Math.round(w)}`, p[0] + 9, p[1] + 5, "rgb(255,220,60)");
      }
    }
    const shMid = midpoint(lm.l_shoulder, lm.r_shoulder);
    const hipMid = midpoint(lm.l_hip, lm.r_hip);
    const mid = midpoint(shMid, hipMid);
    const tg = winkel.trunk_ground;
    if (tg !== undefined && !isNaN(tg)) {
      label(ctx, `${Math.round(tg)}° z.Boden`, mid[0] + 9, mid[1], "rgb(120,240,90)");
    }
  }

  function label(ctx, text, x, y, color) {
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0,0,0,0.9)";
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  function zeichneKraftvektoren(ctx, lm, Fv, Fh, masse) {
    const mG = masse * G;
    if (Fv < 0.05 * mG) return;
    const la = lm.l_ankle, ra = lm.r_ankle;
    const k = la[1] > ra[1] ? la : ra;       // Kontaktpunkt = tieferer Knöchel
    const kx = k[0], ky = k[1];
    const skala = 75 / mG;                    // 1 BW = 75 px

    // Fv senkrecht nach oben (grün)
    const fvPx = Math.min(Fv * skala, 170);
    pfeil(ctx, kx, ky, kx, ky - fvPx, "rgb(100,210,30)", 3);
    label(ctx, `Fv ${(Fv / mG).toFixed(2)} BW`, kx + 7, ky - fvPx - 5, "rgb(100,210,30)");

    // Fh horizontal (Laufrichtung)
    if (Math.abs(Fh) > 0.03 * mG) {
      const fhPx = Math.min(Math.abs(Fh) * skala, 110);
      const richt = Fh >= 0 ? 1 : -1;
      const endHx = kx + richt * fhPx;
      const farbe = Fh >= 0 ? "rgb(255,185,80)" : "rgb(220,60,60)";
      pfeil(ctx, kx, ky, endHx, ky, farbe, 3);
      label(ctx, `Fh ${(Fh / mG).toFixed(2)} BW`, endHx + richt * 5, ky + 17, farbe);
      // Resultierende (gold)
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgb(220,200,40)";
      ctx.beginPath();
      ctx.moveTo(kx, ky);
      ctx.lineTo(endHx, ky - fvPx);
      ctx.stroke();
    }
  }

  function pfeil(ctx, x1, y1, x2, y2, color, lw) {
    ctx.lineWidth = lw;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const h = 12;
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - h * Math.cos(ang - Math.PI / 6), y2 - h * Math.sin(ang - Math.PI / 6));
    ctx.lineTo(x2 - h * Math.cos(ang + Math.PI / 6), y2 - h * Math.sin(ang + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
  }

  function zeichneHud(ctx, W, Fv, Fh, masse, inContact) {
    const mG = masse * G;
    // Info-Panel oben links
    panel(ctx, 8, 8, 320, 92);
    const phaseFarbe = inContact ? "rgb(100,210,30)" : "rgb(255,160,80)";
    const phaseTxt = inContact ? "BODENKONTAKT" : "FLUGPHASE";
    ctx.font = "bold 16px sans-serif";
    ctx.fillStyle = phaseFarbe;
    ctx.fillText(phaseTxt, 16, 32);
    ctx.font = "14px sans-serif";
    ctx.fillStyle = "rgb(100,210,30)";
    ctx.fillText(`Fv  ${(Fv / mG >= 0 ? "+" : "")}${(Fv / mG).toFixed(2)} BW   (${Math.round(Fv)} N)`, 16, 58);
    ctx.fillStyle = "rgb(80,160,255)";
    ctx.fillText(`Fh  ${(Fh / mG >= 0 ? "+" : "")}${(Fh / mG).toFixed(2)} BW   (${Math.round(Fh)} N)`, 16, 82);
  }

  function zeichneWinkelPanel(ctx, winkel, lm) {
    const support = lm.l_ankle[1] > lm.r_ankle[1] ? "l" : "r";
    const seite = support === "l" ? "links" : "rechts";
    panel(ctx, 8, 110, 320, 132);
    ctx.font = "13px sans-serif";
    ctx.fillStyle = "rgb(255,220,60)";
    ctx.fillText(`GELENKWINKEL  (Standbein ${seite})`, 16, 132);
    const zeilen = [
      ["Fuss-Unterschenkel",  winkel[support + "_ankle"]],
      ["Unter-/Oberschenkel", winkel[support + "_knee"]],
      ["Oberschenkel-Rumpf",  winkel[support + "_hip"]],
      ["Rumpf-Boden",         winkel.trunk_ground],
    ];
    let y = 156;
    for (const [name, w] of zeilen) {
      const val = (w !== undefined && !isNaN(w)) ? `${Math.round(w)}°` : "--";
      ctx.fillStyle = "rgb(225,225,225)";
      ctx.fillText(name, 16, y);
      ctx.fillStyle = "rgb(255,220,60)";
      ctx.fillText(val, 268, y);
      y += 22;
    }
  }

  function panel(ctx, x, y, w, h) {
    ctx.fillStyle = "rgba(10,10,10,0.62)";
    ctx.fillRect(x, y, w, h);
  }

  function zeichneMiniGraph(ctx, W, H, masse, FvSerie, FhSerie) {
    const mG = masse * G;
    const gw = 230, gh = 72;
    const gx = W - gw - 10, gy = H - gh - 10;
    ctx.fillStyle = "rgba(10,10,10,0.62)";
    ctx.fillRect(gx - 4, gy - 18, gw + 8, gh + 22);
    ctx.font = "12px sans-serif";
    ctx.fillStyle = "rgb(100,210,30)"; ctx.fillText("Fv", gx, gy - 5);
    ctx.fillStyle = "rgb(80,160,255)"; ctx.fillText("Fh", gx + 24, gy - 5);
    const mitteY = gy + gh / 2;
    ctx.strokeStyle = "rgb(45,45,45)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(gx, mitteY); ctx.lineTo(gx + gw, mitteY); ctx.stroke();
    const n = Math.min(FvSerie.length, gw);
    const maxF = 4 * mG;
    const clamp = (v) => Math.max(gy, Math.min(gy + gh, v));
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgb(100,210,30)";
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = gx + (gw - n + i);
      const yv = clamp(gy + gh - (Math.max(0, FvSerie[FvSerie.length - n + i]) / maxF) * gh);
      i === 0 ? ctx.moveTo(x, yv) : ctx.lineTo(x, yv);
    }
    ctx.stroke();
    ctx.strokeStyle = "rgb(80,160,255)";
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = gx + (gw - n + i);
      const yh = clamp(mitteY - (FhSerie[FhSerie.length - n + i] / maxF) * (gh / 2));
      i === 0 ? ctx.moveTo(x, yh) : ctx.lineTo(x, yh);
    }
    ctx.stroke();
  }

  // ── Öffentliche Render-Funktion ───────────────────────────────────────────
  //   modus: "voll" | "modell" | "aus"
  //   opts:  { winkel: bool }
  function render(ctx, W, H, frame, Fv, Fh, masse, inContact, FvSerie, FhSerie, modus, opts) {
    ctx.clearRect(0, 0, W, H);
    if (modus === "aus") return;
    const lm = frame.lm;
    if (modus === "modell" || modus === "voll") zeichneSkelett(ctx, lm);
    if (opts.winkel) zeichneWinkel(ctx, lm, frame.winkel);
    if (modus === "voll") {
      zeichneKraftvektoren(ctx, lm, Fv, Fh, masse);
      zeichneHud(ctx, W, Fv, Fh, masse, inContact);
      zeichneWinkelPanel(ctx, frame.winkel, lm);
      zeichneMiniGraph(ctx, W, H, masse, FvSerie, FhSerie);
    }
  }

  global.SPRINT = global.SPRINT || {};
  global.SPRINT.overlay = { render };
})(window);
