/* CHM BREAKER — splash screen, synthesized sound and haptics (web app port).
 * Loaded before app.js. No network, no audio files: the entry chime is two
 * soft sine notes rendered with Web Audio. Haptics use the Vibration API
 * (navigator.vibrate) instead of the Telegram haptics API; everything is
 * wrapped in try/catch so a browser without AudioContext / vibration degrades
 * silently (desktop browsers simply have no vibration).
 *
 * window.CHMFX = { enabled(), setEnabled(bool), hap(kind), chime(), dismiss() }
 *   pref persisted in localStorage["chm_fx"] ("1" default / "0" off).
 */
(function () {
  "use strict";
  // Google Fonts load as media="print" (never render-blocking) and switch to "all" once loaded —
  // here, not in an inline onload="…": the site's CSP (script-src-attr 'none') blocks inline handlers.
  var fonts = document.getElementById("app-fonts");
  if (fonts) {
    if (fonts.sheet) fonts.media = "all";
    else fonts.addEventListener("load", function () { fonts.media = "all"; });
  }
  var KEY = "chm_fx";
  var QS;
  try { QS = new URLSearchParams(location.search); } catch (e) { QS = { get: function () { return null; } }; }

  function lsGet() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function lsSet(v) { try { localStorage.setItem(KEY, v); } catch (e) { /* private mode */ } }
  var enabled = lsGet() !== "0";
  var reduced = false;
  try { reduced = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch (e) {}

  // ---------------------------------------------------------------- audio
  var ctx = null, pendingChime = false, gestureBound = false;
  function getCtx() {
    if (ctx) return ctx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC(); } catch (e) { ctx = null; }
    return ctx;
  }
  function note(c, t0, freq, dur, peak) {
    var o = c.createOscillator(), g = c.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.025);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(c.destination);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }
  // Two-note chime: E5 → B5 with a faint octave shimmer. ~0.9 s, quiet.
  function playChime() {
    var c = getCtx();
    if (!c) return false;
    if (c.state === "suspended") { try { c.resume(); } catch (e) {} }
    if (c.state !== "running") return false;
    var t = c.currentTime + 0.02;
    note(c, t, 659.25, 0.55, 0.11);
    note(c, t + 0.17, 987.77, 0.75, 0.09);
    note(c, t + 0.17, 1975.53, 0.35, 0.015);
    return true;
  }
  function bindGesture() {
    if (gestureBound) return;
    gestureBound = true;
    var evs = ["pointerdown", "touchstart", "keydown"];
    var handler = function () {
      evs.forEach(function (ev) { document.removeEventListener(ev, handler, true); });
      try {
        var c = getCtx();
        if (!c) return;
        var fire = function () { if (pendingChime && enabled) { pendingChime = false; playChime(); } };
        if (c.state === "suspended") c.resume().then(fire, function () {});
        else fire();
      } catch (e) { /* ignore */ }
    };
    evs.forEach(function (ev) { document.addEventListener(ev, handler, { capture: true, passive: true }); });
  }
  // Chromium refuses (and warns about) an AudioContext created before any user
  // gesture, so when the page knows it has had none we wait for the first tap.
  function gestureKnownMissing() {
    try { return !!(navigator.userActivation && !navigator.userActivation.hasBeenActive); } catch (e) { return false; }
  }
  function chime() {
    if (!enabled) return;
    try {
      if (gestureKnownMissing() || !playChime()) { pendingChime = true; bindGesture(); }   // autoplay blocked → retry on first gesture
    } catch (e) { /* audio unsupported */ }
  }

  // -------------------------------------------------------------- haptics
  // Telegram's selection / impact / notification kinds mapped onto vibration
  // patterns (ms). Gated on navigator.vibrate: a no-op where unsupported.
  var PATTERNS = {
    select: [6], light: [10], medium: [18], heavy: [30], rigid: [14], soft: [22],
    success: [12, 40, 12], warning: [20, 50, 20], error: [30, 40, 30, 40, 30]
  };
  function hap(kind) {
    if (!enabled) return;
    try {
      if (!navigator.vibrate || typeof navigator.vibrate !== "function") return;
      navigator.vibrate(PATTERNS[kind] || PATTERNS.light);
    } catch (e) { /* vibration blocked (no user gesture yet) */ }
  }

  // --------------------------------------------------------------- splash
  var splash = null, outTimer = null, done = false;
  function buildCandles(box) {
    // deterministic little candle strip (14 candles)
    var seed = 7;
    var rnd = function () { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    var y = 18;
    for (var i = 0; i < 14; i++) {
      var hgt = 10 + Math.round(rnd() * 26);
      var up = rnd() > 0.42;
      y = Math.max(2, Math.min(34, y + (up ? 1 : -1) * Math.round(rnd() * 8)));
      var el = document.createElement("i");
      el.className = up ? "up" : "dn";
      el.style.cssText = "--i:" + i + ";--h:" + hgt + "px;--y:" + y + "px";
      box.appendChild(el);
    }
  }
  function dismiss() {
    if (done || !splash) return;
    done = true;
    clearTimeout(outTimer);
    splash.classList.add("is-out");
    document.documentElement.classList.remove("has-splash");
    var ms = reduced ? 0 : 480;
    setTimeout(function () {
      try { splash.hidden = true; if (splash.parentNode) splash.parentNode.removeChild(splash); } catch (e) {}
      splash = null;
    }, ms);
  }
  function start() {
    splash = document.getElementById("splash");
    var mode = QS.get("splash") || "";
    if (!splash || mode === "off") { if (splash) { splash.hidden = true; } done = true; return; }
    document.documentElement.classList.add("has-splash");
    var box = splash.querySelector(".splash-candles");
    if (box) buildCandles(box);
    hap("medium");
    chime();
    splash.addEventListener("click", dismiss);
    splash.addEventListener("touchend", function (e) { e.preventDefault(); dismiss(); }, { passive: false });
    if (mode !== "hold") outTimer = setTimeout(dismiss, reduced ? 700 : 1250);
  }

  window.CHMFX = {
    enabled: function () { return enabled; },
    setEnabled: function (v) { enabled = !!v; lsSet(enabled ? "1" : "0"); if (enabled) hap("success"); },
    hap: hap,
    chime: chime,
    dismiss: dismiss
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
