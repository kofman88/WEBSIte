/* CHM BREAKER — client-side signal chart (decision D3: the server returns
 * candles + overlays as JSON, the picture is drawn here on a canvas).
 *
 * window.CHMChart.render(data, sig, title) → <canvas class="chm-chart">
 *   data.candles  [{t|ts, o, h, l, c}] or [[t, o, h, l, c]] — ascending, last = last closed bar
 *   data.overlays {entry, sl, tps:[…] | tp1..tp3, be,
 *                  ob:[{from,to,top,bottom,side}], fvg:[{…}], pivots:[{price,kind}],
 *                  hvn:[price…], lvn:[price…], emas:{"50":[…],"200":[…]} | [{name, label?, values}]}
 *   data.event / data.hit_levels — progress chart (TP1 … / SL hit) marks
 * Missing overlay fields fall back to the signal itself (entry / sl / tp1-3).
 * TradingView-dark palette, no network, no API strings through innerHTML.
 * This is the M11 placeholder renderer: the full overlay list of
 * signal-pipeline.md §16 extends it without changing the call.
 */
(function () {
  "use strict";
  var W = 720, H = 440, PAD_R = 118, PAD_T = 34, PAD_B = 22;
  var C = { bg: "#131722", grid: "rgba(255,255,255,.06)", up: "#26a69a", dn: "#ef5350", text: "#d1d4dc",
    muted: "rgba(209,212,220,.55)", entry: "#f6eef0", sl: "#ff2a4d", tp: "#3df2a0", be: "#ffc24b",
    ob: "rgba(168,85,247,.18)", obLine: "#a855f7", fvg: "rgba(61,242,160,.12)", fvgLine: "rgba(61,242,160,.55)",
    pivot: "rgba(255,255,255,.28)", hvn: "rgba(255,194,75,.35)", lvn: "rgba(255,42,77,.3)", ema: ["#ffc24b", "#60a5fa", "#f472b6"] };

  function num(x) { if (x === null || x === undefined || x === "") return null; var n = Number(x); return isFinite(n) ? n : null; }
  function candle(c) {
    if (Array.isArray(c)) return { t: num(c[0]), o: num(c[1]), h: num(c[2]), l: num(c[3]), c: num(c[4]) };
    return { t: num(c.t != null ? c.t : (c.ts != null ? c.ts : c.time)), o: num(c.o != null ? c.o : c.open), h: num(c.h != null ? c.h : c.high), l: num(c.l != null ? c.l : c.low), c: num(c.c != null ? c.c : c.close) };
  }
  function priceDecimals(p) {
    var a = Math.abs(p);
    if (a >= 1000) return 2;
    if (a >= 100) return 3;
    if (a >= 1) return 4;
    if (a === 0) return 2;
    return Math.min(12, Math.ceil(-Math.log10(a)) + 3);
  }
  function fmt(p) { return p === null ? "—" : p.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: priceDecimals(p) }); }
  function emaList(e) {
    if (!e) return [];
    if (Array.isArray(e)) return e.filter(function (x) { return x && Array.isArray(x.values); });
    return Object.keys(e).map(function (k) { return { name: k, values: e[k] }; }).filter(function (x) { return Array.isArray(x.values); });
  }

  function render(data, sig, title) {
    sig = sig || {};
    var cs = (data.candles || []).map(candle).filter(function (k) { return k.o !== null && k.h !== null && k.l !== null && k.c !== null; });
    var ov = data.overlays || {};
    var entry = num(ov.entry != null ? ov.entry : sig.entry), sl = num(ov.sl != null ? ov.sl : sig.sl);
    var tps = Array.isArray(ov.tps) ? ov.tps.map(num) : [ov.tp1 != null ? ov.tp1 : sig.tp1, ov.tp2 != null ? ov.tp2 : sig.tp2, ov.tp3 != null ? ov.tp3 : sig.tp3].map(num);
    tps = tps.filter(function (x) { return x !== null && x > 0; });
    var be = num(ov.be);
    var emas = emaList(ov.emas);
    var hit = {};
    (data.hit_levels || []).forEach(function (k) { hit[String(k).toUpperCase()] = true; });
    var event = data.event ? String(data.event).toUpperCase() : "";

    var dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    var cv = document.createElement("canvas");
    cv.className = "chm-chart";
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.setAttribute("role", "img");
    cv.setAttribute("aria-label", title || "График");
    var g = cv.getContext("2d");
    g.scale(dpr, dpr);
    g.fillStyle = C.bg; g.fillRect(0, 0, W, H);
    if (!cs.length) { g.fillStyle = C.muted; g.font = "500 13px 'JetBrains Mono', monospace"; g.fillText("нет свечей", 14, 26); return cv; }

    var lo = Infinity, hi = -Infinity;
    cs.forEach(function (k) { lo = Math.min(lo, k.l); hi = Math.max(hi, k.h); });
    [entry, sl, be].concat(tps).forEach(function (v) { if (v !== null) { lo = Math.min(lo, v); hi = Math.max(hi, v); } });
    emas.forEach(function (e) { e.values.forEach(function (v) { v = num(v); if (v !== null) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }); });
    if (!(hi > lo)) { hi = lo + 1; lo = lo - 1; }
    var pad = (hi - lo) * 0.05; lo -= pad; hi += pad;
    var plotW = W - PAD_R, plotH = H - PAD_T - PAD_B;
    var n = cs.length;
    var cw = plotW / n;
    var X = function (i) { return i * cw + cw / 2; };
    var Y = function (v) { return PAD_T + (hi - v) / (hi - lo) * plotH; };

    // grid
    g.strokeStyle = C.grid; g.lineWidth = 1;
    for (var i = 0; i <= 6; i++) { var gy = PAD_T + i * plotH / 6; g.beginPath(); g.moveTo(0, gy); g.lineTo(plotW, gy); g.stroke(); }
    for (var j = 0; j <= 8; j++) { var gx = j * plotW / 8; g.beginPath(); g.moveTo(gx, PAD_T); g.lineTo(gx, H - PAD_B); g.stroke(); }

    // zones: order blocks / FVG (index-based from..to, price top..bottom)
    function zone(list, fill, line) {
      (list || []).forEach(function (z) {
        var top = num(z.top != null ? z.top : z.high), bot = num(z.bottom != null ? z.bottom : z.low);
        if (top === null || bot === null) return;
        var from = num(z.from); var to = num(z.to);
        var x0 = from === null ? 0 : Math.max(0, from) * cw, x1 = to === null ? plotW : Math.min(n, to + 1) * cw;
        g.fillStyle = fill; g.fillRect(x0, Y(Math.max(top, bot)), Math.max(2, x1 - x0), Math.max(1, Math.abs(Y(top) - Y(bot))));
        g.strokeStyle = line; g.lineWidth = 1; g.strokeRect(x0, Y(Math.max(top, bot)), Math.max(2, x1 - x0), Math.max(1, Math.abs(Y(top) - Y(bot))));
      });
    }
    zone(ov.ob, C.ob, C.obLine);
    zone(ov.fvg, C.fvg, C.fvgLine);
    // pivots / volume nodes: thin horizontal guides
    function guide(list, color, dash) {
      (list || []).forEach(function (p) {
        var v = num(p && typeof p === "object" ? p.price : p);
        if (v === null) return;
        g.strokeStyle = color; g.lineWidth = 1; g.setLineDash(dash);
        g.beginPath(); g.moveTo(0, Y(v)); g.lineTo(plotW, Y(v)); g.stroke(); g.setLineDash([]);
      });
    }
    guide(ov.pivots, C.pivot, [2, 4]);
    guide(ov.hvn, C.hvn, [1, 3]);
    guide(ov.lvn, C.lvn, [1, 3]);

    // candles
    cs.forEach(function (k, idx) {
      var x = X(idx), up = k.c >= k.o;
      g.strokeStyle = up ? C.up : C.dn; g.fillStyle = up ? C.up : C.dn; g.lineWidth = 1;
      g.beginPath(); g.moveTo(x, Y(k.h)); g.lineTo(x, Y(k.l)); g.stroke();
      var top = Math.min(Y(k.o), Y(k.c)), bh = Math.max(1.2, Math.abs(Y(k.o) - Y(k.c)));
      g.fillRect(x - cw * 0.32, top, Math.max(1.5, cw * 0.64), bh);
    });

    // EMAs
    emas.forEach(function (e, ei) {
      g.strokeStyle = C.ema[ei % C.ema.length]; g.lineWidth = 1.4; g.beginPath();
      var started = false, off = n - e.values.length;
      e.values.forEach(function (v, i) {
        v = num(v); var idx = i + off;
        if (v === null || idx < 0) { return; }
        if (!started) { g.moveTo(X(idx), Y(v)); started = true; } else g.lineTo(X(idx), Y(v));
      });
      g.stroke();
      g.fillStyle = C.ema[ei % C.ema.length]; g.font = "500 10px 'JetBrains Mono', monospace";
      // the payload labels each line ("EMA 20", VOLUME's "SMA 10"); a bare {name: values} map is an EMA period
      g.fillText(e.label ? String(e.label) : "EMA " + e.name, 8 + ei * 64, H - 8);
    });

    // levels with right-side labels
    g.font = "600 11px 'JetBrains Mono', monospace";
    var levels = [];
    tps.forEach(function (v, i) { levels.push(["TP" + (i + 1), v, C.tp, !!hit["TP" + (i + 1)]]); });
    if (entry !== null) levels.push(["ВХОД", entry, C.entry, false]);
    if (be !== null) levels.push(["БУ", be, C.be, event === "BE"]);
    if (sl !== null) levels.push(["SL", sl, C.sl, !!hit.SL || event === "SL"]);
    levels.forEach(function (l) {
      var ly = Y(l[1]);
      g.strokeStyle = l[2]; g.globalAlpha = l[0] === "ВХОД" ? 0.95 : 0.75; g.lineWidth = l[3] ? 1.8 : 1;
      g.setLineDash(l[0] === "ВХОД" ? [] : [6, 5]);
      g.beginPath(); g.moveTo(0, ly); g.lineTo(plotW, ly); g.stroke();
      g.setLineDash([]); g.globalAlpha = 1;
      g.fillStyle = l[2]; g.fillRect(plotW + 2, ly - 10, PAD_R - 4, 20);
      g.fillStyle = l[0] === "SL" || l[0] === "ВХОД" ? "#14070b" : "#06140d";
      g.fillText((l[3] ? "✓ " : "") + l[0] + " " + fmt(l[1]), plotW + 6, ly + 4);
    });

    // title / event
    g.fillStyle = C.text; g.font = "700 15px 'Oswald', 'Arial Narrow', sans-serif";
    var head = String(sig.pair || sig.symbol || title || "").toUpperCase() + (sig.timeframe ? "  ·  " + String(sig.timeframe).toUpperCase() : "");
    g.fillText(head, 10, 22);
    if (event) {
      g.fillStyle = event === "SL" ? C.sl : event === "BE" ? C.be : C.tp; g.font = "700 12px 'JetBrains Mono', monospace";
      g.fillText(event === "SL" ? "СТОП" : event === "BE" ? "БЕЗУБЫТОК" : event === "EXPIRED" ? "ПО ВРЕМЕНИ" : event === "MISSED" ? "БЕЗ ВХОДА" : event, plotW - 150, 22);
    }
    g.fillStyle = C.muted; g.font = "500 10px 'JetBrains Mono', monospace";
    g.fillText("CHM BREAKER", plotW - 86, H - 8);
    return cv;
  }

  window.CHMChart = { render: render };
})();
