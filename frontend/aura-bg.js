/* ============================================================
 * CHM × Aura background
 * Dot-matrix field + rotating particle sphere.
 * Чистый Canvas 2D, без зависимостей, ~6kb.
 *
 * УСТАНОВКА:
 *   1) Сразу после открывающего <body> добавь:
 *        <div id="aura-bg">
 *          <canvas id="aura-grid"></canvas>
 *          <canvas id="aura-orb"></canvas>
 *        </div>
 *
 *   2) В CSS (в самом начале твоего основного стиля):
 *        #aura-bg {
 *          position: fixed; inset: 0;
 *          width: 100vw; height: 100vh;
 *          z-index: -1; pointer-events: none;
 *          background: #000;
 *        }
 *        #aura-bg canvas {
 *          position: absolute; inset: 0;
 *          width: 100%; height: 100%;
 *        }
 *        body { background: transparent; }
 *
 *   3) Перед </body>:
 *        <script src="/static/js/aura-bg.js" defer></script>
 *
 * НАСТРОЙКИ — см. CFG ниже.
 * ============================================================ */

(function () {
  'use strict';

  var CFG = {
    // ---- общее ----
    color:      [255, 90, 31],     // RGB: бренд CHM (оранжевый) — dark theme
    colorLight: [204, 64, 16],     // darker orange for light mode (better contrast on white)
    bgDark:     '#0A0A0A',
    bgLight:    '#F5F6F8',
    lightAlphaMult: 0.55,          // reduce overall alpha in light mode (dots on white read too strong)
    // color: [16, 185, 129],      // альтернатива: зелёный
    // color: [255, 255, 255],     // альтернатива: белый

    // ---- точечная сетка ----
    gridSpacing:     28,           // расстояние между точками, px
    gridDotSize:     1.2,          // базовый радиус точек
    gridBaseAlpha:   0.12,         // базовая непрозрачность
    gridBreathAmp:   0.35,         // амплитуда "дыхания" у каждой точки
    gridPulseAmp:    0.12,         // общий фоновой пульс
    gridMouseR:      180,          // радиус влияния курсора
    gridMouseBoost:  0.70,         // на сколько ярче точки возле курсора
    gridDepthFade:   0.35,         // затемнение к краям (0 = нет)

    // ---- сфера из частиц ----
    orb: false,                    // по умолчанию ВЫКЛ — центр страницы не перегружается
                                   // включить: <script>window.AURA_CFG = { orb: true };</script> перед aura-bg.js
    orbParticles:    900,          // сколько точек на сфере
    orbRadiusRatio:  0.32,         // доля от min(width, height) — размер сферы
    orbRotSpeed:     0.15,         // скорость вращения по Y
    orbWobbleSpeed:  0.10,         // скорость покачивания по X
    orbWobbleAmp:    0.25,         // амплитуда покачивания (рад)
    orbMouseParallax:0.40,         // влияние курсора на вращение (0..1)
    orbBreathAmp:    0.04,         // амплитуда "дыхания" размера
    orbGlow:         0.08,         // интенсивность сияющего ореола (0 = без ореола)

    // ---- производительность ----
    maxDPR:          2,            // clamp pixel ratio (экономит GPU)
    pauseHidden:     true          // пауза при скрытой вкладке
  };

  // Allow per-page overrides via window.AURA_CFG before this script runs
  if (window.AURA_CFG && typeof window.AURA_CFG === 'object') {
    for (var k in window.AURA_CFG) {
      if (Object.prototype.hasOwnProperty.call(window.AURA_CFG, k)) CFG[k] = window.AURA_CFG[k];
    }
  }

  var root = document.getElementById('aura-bg');
  var grid = document.getElementById('aura-grid');
  var orb  = document.getElementById('aura-orb');

  // Defensive: force the container out of flow + body transparent even if a
  // stylesheet (tailwind, legacy styles.css, inline body bg) managed to
  // override. This runs BEFORE animation init so content never renders
  // on top of (or pushed by) a mis-positioned aura-bg div.
  if (root) {
    root.style.setProperty('position', 'fixed', 'important');
    root.style.setProperty('top', '0', 'important');
    root.style.setProperty('left', '0', 'important');
    root.style.setProperty('right', '0', 'important');
    root.style.setProperty('bottom', '0', 'important');
    root.style.setProperty('width', '100vw', 'important');
    root.style.setProperty('height', '100vh', 'important');
    root.style.setProperty('z-index', '-1', 'important');
    root.style.setProperty('pointer-events', 'none', 'important');
    root.style.setProperty('margin', '0', 'important');
    root.style.setProperty('padding', '0', 'important');
    root.style.setProperty('overflow', 'hidden', 'important');
    // Relocate to be a direct body child if something wrapped it
    if (root.parentElement && root.parentElement !== document.body) {
      document.body.insertBefore(root, document.body.firstChild);
    }
    // Body stays transparent so canvas shows through — the aura-bg
    // container itself paints the theme-aware base color behind the dots.
    document.body.style.setProperty('background', 'transparent', 'important');
  }

  // Reactive theme: reads html.light, paints the container bg, and
  // swaps the dot color. Re-runs whenever the class mutates.
  function isLight() { return document.documentElement.classList.contains('light'); }
  function applyTheme() {
    if (!root) return;
    var light = isLight();
    root.style.setProperty('background', light ? CFG.bgLight : CFG.bgDark, 'important');
  }
  applyTheme();
  if (window.MutationObserver) {
    new MutationObserver(applyTheme).observe(document.documentElement, {
      attributes: true, attributeFilter: ['class']
    });
  }
  if (!root || !grid) {
    console.warn('[aura-bg] не найдены #aura-bg / #aura-grid. Фон не инициализирован.');
    return;
  }
  var showOrb = CFG.orb && !!orb;

  var gCtx = grid.getContext('2d', { alpha: true });
  var oCtx = showOrb ? orb.getContext('2d', { alpha: true }) : null;

  var dpr = Math.min(window.devicePixelRatio || 1, CFG.maxDPR);
  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var w = 0, h = 0;
  var dots = [];
  var particles = [];
  var mouse = { x: -9999, y: -9999, nx: 0, ny: 0, active: false };
  var t0 = performance.now();
  var rafId = null;

  function resize() {
    w = window.innerWidth;
    h = window.innerHeight;

    function sizeCanvas(c) {
      c.width  = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.style.width  = w + 'px';
      c.style.height = h + 'px';
    }
    sizeCanvas(grid);
    gCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (showOrb) {
      sizeCanvas(orb);
      oCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    buildGrid();
    if (showOrb) buildSphere();
  }

  function buildGrid() {
    dots = [];
    var s = CFG.gridSpacing;
    var cols = Math.ceil(w / s) + 1;
    var rows = Math.ceil(h / s) + 1;
    var offX = (w - (cols - 1) * s) / 2;
    var offY = (h - (rows - 1) * s) / 2;
    for (var iy = 0; iy < rows; iy++) {
      for (var ix = 0; ix < cols; ix++) {
        dots.push({
          x: offX + ix * s,
          y: offY + iy * s,
          phase: Math.random() * Math.PI * 2
        });
      }
    }
  }

  function buildSphere() {
    particles = [];
    var N = CFG.orbParticles;
    for (var i = 0; i < N; i++) {
      var u = Math.random();
      var v = Math.random();
      var theta = 2 * Math.PI * u;
      var phi = Math.acos(2 * v - 1);
      particles.push({
        theta: theta,
        phi: phi,
        r: 1 + (Math.random() - 0.5) * 0.04
      });
    }
  }

  function onMove(e) {
    var cx = e.clientX, cy = e.clientY;
    if (e.touches && e.touches[0]) { cx = e.touches[0].clientX; cy = e.touches[0].clientY; }
    mouse.x = cx;
    mouse.y = cy;
    mouse.nx = (cx / w - 0.5) * 2;
    mouse.ny = (cy / h - 0.5) * 2;
    mouse.active = true;
  }
  function onLeave() {
    mouse.active = false;
    mouse.x = -9999; mouse.y = -9999;
  }

  function drawGrid(t) {
    gCtx.clearRect(0, 0, w, h);
    var cx = w / 2, cy = h / 2;
    var maxR = Math.sqrt(cx * cx + cy * cy);
    var globalPulse = 0.5 + 0.5 * Math.sin(t * 0.4);
    var light = isLight();
    var col = light ? CFG.colorLight : CFG.color;
    var cR = col[0], cG = col[1], cB = col[2];
    var alphaMult = light ? CFG.lightAlphaMult : 1;

    for (var i = 0; i < dots.length; i++) {
      var d = dots[i];
      var local = 0.5 + 0.5 * Math.sin(t * 0.6 + d.phase);
      var alpha = (CFG.gridBaseAlpha + CFG.gridBreathAmp * local + CFG.gridPulseAmp * globalPulse) * alphaMult;

      if (mouse.active) {
        var dx = d.x - mouse.x, dy = d.y - mouse.y;
        var dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < CFG.gridMouseR) {
          alpha += (1 - dist / CFG.gridMouseR) * CFG.gridMouseBoost;
        }
      }

      if (CFG.gridDepthFade > 0) {
        var dc = Math.sqrt((d.x - cx) * (d.x - cx) + (d.y - cy) * (d.y - cy));
        alpha *= 1 - (dc / maxR) * CFG.gridDepthFade;
      }

      if (alpha < 0.02) continue;
      if (alpha > 1) alpha = 1;

      gCtx.fillStyle = 'rgba(' + cR + ',' + cG + ',' + cB + ',' + alpha.toFixed(3) + ')';
      gCtx.beginPath();
      gCtx.arc(d.x, d.y, CFG.gridDotSize, 0, Math.PI * 2);
      gCtx.fill();
    }
  }

  function drawSphere(t) {
    oCtx.clearRect(0, 0, w, h);
    var cx = w / 2, cy = h / 2;
    var radius = Math.min(w, h) * CFG.orbRadiusRatio;
    var rotY = t * CFG.orbRotSpeed + mouse.nx * CFG.orbMouseParallax;
    var rotX = Math.sin(t * CFG.orbWobbleSpeed) * CFG.orbWobbleAmp + mouse.ny * CFG.orbMouseParallax * 0.75;
    var cY = Math.cos(rotY), sY = Math.sin(rotY);
    var cX = Math.cos(rotX), sX = Math.sin(rotX);
    var pulse = 1 + CFG.orbBreathAmp * Math.sin(t * 0.5);

    var rendered = new Array(particles.length);
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      var x = Math.sin(p.phi) * Math.cos(p.theta) * p.r;
      var y = Math.cos(p.phi) * p.r;
      var z = Math.sin(p.phi) * Math.sin(p.theta) * p.r;
      var x1 = x * cY - z * sY;
      var z1 = x * sY + z * cY;
      var y1 = y * cX - z1 * sX;
      var z2 = y * sX + z1 * cX;
      rendered[i] = { x: x1, y: y1, z: z2 };
    }
    rendered.sort(function (a, b) { return a.z - b.z; });

    var lightS = isLight();
    var colS = lightS ? CFG.colorLight : CFG.color;
    var cR = colS[0], cG = colS[1], cB = colS[2];
    var alphaMultS = lightS ? CFG.lightAlphaMult : 1;
    for (var j = 0; j < rendered.length; j++) {
      var r = rendered[j];
      var depth = (r.z + 1) / 2;
      var px = cx + r.x * radius * pulse;
      var py = cy + r.y * radius * pulse;
      var size = 0.8 + depth * 1.8;
      var alpha = (0.15 + depth * 0.75) * alphaMultS;
      oCtx.fillStyle = 'rgba(' + cR + ',' + cG + ',' + cB + ',' + alpha.toFixed(3) + ')';
      oCtx.beginPath();
      oCtx.arc(px, py, size, 0, Math.PI * 2);
      oCtx.fill();
    }

    if (CFG.orbGlow > 0) {
      var grad = oCtx.createRadialGradient(cx, cy, radius * 0.3, cx, cy, radius * 1.5);
      grad.addColorStop(0, 'rgba(' + cR + ',' + cG + ',' + cB + ',' + CFG.orbGlow + ')');
      grad.addColorStop(1, 'rgba(' + cR + ',' + cG + ',' + cB + ',0)');
      oCtx.fillStyle = grad;
      oCtx.fillRect(0, 0, w, h);
    }
  }

  function loop() {
    var t = (performance.now() - t0) / 1000;
    drawGrid(t);
    if (showOrb) drawSphere(t);
    rafId = requestAnimationFrame(loop);
  }

  function pause() { if (rafId) { cancelAnimationFrame(rafId); rafId = null; } }
  function resume() { if (!rafId) { t0 = performance.now() - 0; rafId = requestAnimationFrame(loop); } }

  function init() {
    resize();
    window.addEventListener('resize', resize, { passive: true });
    window.addEventListener('mousemove', onMove, { passive: true });
    window.addEventListener('mouseleave', onLeave, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onLeave, { passive: true });
    if (CFG.pauseHidden) {
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) pause(); else resume();
      });
    }

    if (reducedMotion) {
      var t = 0;
      drawGrid(t);
      if (showOrb) drawSphere(t);
    } else {
      resume();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
