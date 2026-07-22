/* ============================================================================
 *  Diagramme · 5-Panel-Pipeline (Portierung von plot_results, via Chart.js)
 * ========================================================================= */
(function (global) {
  "use strict";
  const G = 9.81;
  const charts = [];

  function destroyAll() { while (charts.length) charts.pop().destroy(); }

  function lineChart(canvasId, title, t, datasets, yLabel) {
    const ctx = document.getElementById(canvasId).getContext("2d");
    const c = new Chart(ctx, {
      type: "line",
      data: { labels: t.map((x) => x.toFixed(2)), datasets },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: "nearest", intersect: false },
        elements: { point: { radius: 0 } },
        plugins: {
          title: { display: true, text: title, color: "#e8eef5", font: { size: 13 } },
          legend: { labels: { color: "#b9c4d0", boxWidth: 18, font: { size: 11 } } },
        },
        scales: {
          x: { ticks: { color: "#8a97a6", maxTicksLimit: 8 }, grid: { color: "rgba(255,255,255,0.06)" },
               title: { display: true, text: "Zeit (s)", color: "#8a97a6" } },
          y: { ticks: { color: "#8a97a6" }, grid: { color: "rgba(255,255,255,0.06)" },
               title: { display: true, text: yLabel, color: "#8a97a6" } },
        },
      },
    });
    charts.push(c);
    return c;
  }

  function ds(label, data, color, opts = {}) {
    return Object.assign({
      label, data, borderColor: color, backgroundColor: color,
      borderWidth: opts.width || 1.6, fill: opts.fill || false, tension: 0.15,
      borderDash: opts.dash || [],
    }, opts.extra || {});
  }

  function renderAll(res) {
    destroyAll();
    const A = global.SPRINT.analysis;
    const t = res.times;
    const mG = res.mass * G;

    // ① KSP-Position roh vs. gefiltert
    lineChart("chart1", "① KSP-Position: Roh vs. Butterworth-gefiltert", t, [
      ds("Roh (MediaPipe)", res.com_raw_y, "#888", { width: 1 }),
      ds("Gefiltert", res.com_y, "#3a8fe0", { width: 2 }),
    ], "KSP-Höhe (m)");

    // ② Beschleunigung
    lineChart("chart2", "② KSP-Beschleunigung d²(KSP)/dt²", t, [
      ds("a_y vertikal", res.acc_y, "#cf6242", { width: 1.6 }),
      ds("a_x horizontal", res.acc_x, "#7a6fe0", { width: 1.6 }),
      ds("−g", t.map(() => -G), "#777", { width: 1, dash: [6, 4] }),
    ], "Beschleunigung (m/s²)");

    // ③ Vertikale GRK
    lineChart("chart3", "③ Vertikale Bodenreaktionskraft", t, [
      ds("Fv = m·(a_y + g)", res.Fv.map((f) => f / mG), "#1f9e78",
         { width: 2, fill: true, extra: { backgroundColor: "rgba(31,158,120,0.18)" } }),
      ds("1 BW", t.map(() => 1), "#777", { width: 1, dash: [6, 4] }),
    ], "Kraft (BW)");

    // ④ Horizontale GRK
    lineChart("chart4", "④ Horizontale Bodenreaktionskraft (Vortrieb)", t, [
      ds("Fh", res.Fh.map((f) => f / mG), "#d8702f",
         { width: 2, fill: true, extra: { backgroundColor: "rgba(216,112,47,0.18)" } }),
      ds("0", t.map(() => 0), "#555", { width: 1 }),
    ], "Kraft (BW)");

    // ⑤ Gelenkwinkel (Bein mit wenigsten Lücken)
    const nanL = A.winkelArray(res.angles, "l_knee").filter(isNaN).length;
    const nanR = A.winkelArray(res.angles, "r_knee").filter(isNaN).length;
    const leg = nanR <= nanL ? "r" : "l";
    const beinname = leg === "r" ? "rechts" : "links";
    lineChart("chart5", `⑤ Gelenkwinkel (Bein ${beinname})`, t, [
      ds("Sprunggelenk", A.winkelArray(res.angles, leg + "_ankle"), "#3a8fe0"),
      ds("Knie", A.winkelArray(res.angles, leg + "_knee"), "#1f9e78"),
      ds("Hüfte", A.winkelArray(res.angles, leg + "_hip"), "#cf6242"),
      ds("Rumpf-Boden", A.winkelArray(res.angles, "trunk_ground"), "#d8702f", { dash: [6, 4] }),
    ], "Winkel (°)");
  }

  global.SPRINT = global.SPRINT || {};
  global.SPRINT.charts = { renderAll };
})(window);
