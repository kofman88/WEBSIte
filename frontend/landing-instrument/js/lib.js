/* Общие помощники лендинга: форматирование чисел по-русски, одометр, SVG-графики с осями,
   интервал Уилсона, шкала риска, наблюдатели видимости, блик стекла. */
(function () {
  'use strict';
  const L = {};
  const mq = (q) => window.matchMedia && window.matchMedia(q).matches;
  L.reduced = mq('(prefers-reduced-motion: reduce)');
  L.finePointer = mq('(hover: hover) and (pointer: fine)');
  L.$ = (s, r) => (r || document).querySelector(s);
  L.$$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
  L.esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  L.store = {
    get(k) { try { return window.localStorage.getItem(k); } catch (_e) { return null; } },
    set(k, v) { try { window.localStorage.setItem(k, v); } catch (_e) { /* приватный режим */ } },
  };

  // ---------- числа ----------
  const MINUS = '−', NBSP = ' ';
  L.num = function (x, d) {
    const s = Math.abs(x).toFixed(d || 0);
    const p = s.split('.');
    p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
    return p.join(',');
  };
  L.sgn = function (x, d, suf) {
    const r = Number(Math.abs(x).toFixed(d || 0));
    return (r === 0 ? '' : x > 0 ? '+' : MINUS) + L.num(x, d) + (suf || '');
  };
  L.R = (x, d) => L.sgn(x, d === undefined ? 1 : d, 'R');
  L.pct = (x, d) => L.sgn(x, d === undefined ? 1 : d, '%');
  L.usd = (x, d) => (Number(Math.abs(x).toFixed(d || 0)) !== 0 && x < 0 ? MINUS : '') + '$' + L.num(x, d || 0);
  L.usdS = (x, d) => (x > 0 ? '+' : '') + L.usd(x, d);
  L.riskTxt = (r) => L.num(r, r % 1 ? 2 : 0).replace(/,?0+$/, '').replace(/,$/, '') + '%';
  const pad2 = (n) => String(n).padStart(2, '0');
  L.time = (ts) => { const d = new Date(ts); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); };
  L.timeS = (ts) => { const d = new Date(ts); return L.time(ts) + ':' + pad2(d.getSeconds()); };
  L.dm = (ts) => { const d = new Date(ts); return pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1); };
  L.date = (ts) => L.dm(ts) + '.' + new Date(ts).getFullYear();

  // интервал Уилсона 95% для доли k/n, в процентах
  L.wilson = function (k, n, z) {
    if (!n) return [0, 0];
    z = z || 1.96;
    const p = k / n, z2 = z * z, den = 1 + z2 / n;
    const c = p + z2 / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n));
    return [Math.max(0, (c - m) / den * 100), Math.min(100, (c + m) / den * 100)];
  };
  // шкала риска §3.4, пересчитанная под риск посетителя: p95 просадки в % депозита
  L.riskLevel = function (p95R, riskPct) {
    const dd = p95R * riskPct;
    return dd <= 5 ? 1 : dd <= 8 ? 2 : dd <= 12 ? 3 : dd <= 18 ? 4 : 5;
  };
  L.riskWord = ['', 'низкий', 'умеренный', 'заметный', 'высокий', 'очень высокий'];
  L.median = function (a) {
    const s = a.slice().sort((x, y) => x - y), n = s.length;
    return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0;
  };
  // ожидаемая длина худшей серии убытков для n сделок с долей убыточных q
  L.expStreak = (n, q) => (q > 0 && q < 1 ? Math.log(n) / Math.log(1 / q) : n);

  // автотеги прогона (общие для песочницы и площадки бэктеста)
  L.baseTags = function (st) {
    const t = [st.n < 30 ? ['warn', 'мало сделок (' + st.n + ' < 30): выводы ненадёжны'] : ['ok', 'сделок ' + st.n]];
    if (st.r_total < 0) t.push(['bad', 'Net < 0']);
    if (st.p95_dd_r > 15) t.push(['warn', 'p95 просадки > 15R']);
    if (st.gross_r <= st.fee_r_total) t.push(['warn', 'комиссии больше прибыли до комиссий']);
    else if (st.fee_r_total / st.gross_r > 0.3) t.push(['warn', 'комиссии съедают ' + Math.round(st.fee_r_total / st.gross_r * 100) + '% прибыли']);
    if (st.max_loss_streak > L.expStreak(st.n, st.n ? (st.n - st.wins) / st.n : 0) + 1.5) t.push(['warn', 'серия убытков длиннее ожидаемой: ' + st.max_loss_streak + ' подряд']);
    return t;
  };
  L.tagsHtml = (t) => t.map((x) => '<span class="tag ' + x[0] + '">' + L.esc(x[1]) + '</span>').join('');

  // ---------- одометр: цифры прокручиваются колонками ----------
  let odoIO = null;
  function odoBuild(el, text, from) {
    const prev = from || '';
    let html = '<span class="sr">' + L.esc(text) + '</span><span aria-hidden="true" class="odo-v">';
    const off = prev.length - text.length;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c >= '0' && c <= '9') {
        const pc = prev[i + off];
        const start = pc >= '0' && pc <= '9' ? +pc : 0;
        html += '<span class="od"><span data-d="' + c + '" style="transform:translateY(' + (-start * 10) + '%)">';
        for (let k = 0; k < 10; k++) html += '<i>' + k + '</i>';
        html += '</span></span>';
      } else html += '<span class="oc">' + (c === ' ' ? '&nbsp;' : L.esc(c)) + '</span>';
    }
    el.innerHTML = html + '</span>';
  }
  function odoRoll(el) {
    L.$$('.od > span', el).forEach((s) => { s.style.transform = 'translateY(' + (-s.getAttribute('data-d') * 10) + '%)'; });
  }
  L.odo = function (el, text) {
    if (!el) return;
    text = String(text);
    if (el._odo === text) return;
    const prev = el._odo;
    el._odo = text;
    el.classList.add('odo');
    if (L.reduced) { odoBuild(el, text, text); return; }
    if (!el._seen && 'IntersectionObserver' in window) {
      // первая прокрутка — когда показание попадёт на экран
      odoBuild(el, text, '');
      if (!odoIO) {
        odoIO = new IntersectionObserver((ents) => ents.forEach((e) => {
          if (e.isIntersecting) { e.target._seen = true; odoIO.unobserve(e.target); requestAnimationFrame(() => odoRoll(e.target)); }
        }), { threshold: 0.4 });
      }
      odoIO.observe(el);
      return;
    }
    odoBuild(el, text, prev || '');
    requestAnimationFrame(() => requestAnimationFrame(() => odoRoll(el)));
  };

  // ---------- SVG ----------
  L.niceTicks = function (min, max, count) {
    if (min === max) { min -= 1; max += 1; }
    const span = max - min, raw = span / Math.max(1, count || 4);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
    const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
    const out = [];
    for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.round(v * 1e6) / 1e6);
    return out;
  };
  const f1 = (x) => Math.round(x * 10) / 10;
  function pathD(pts, X, Y) { let d = ''; for (let i = 0; i < pts.length; i++) d += (i ? 'L' : 'M') + f1(X(pts[i][0])) + ' ' + f1(Y(pts[i][1])); return d; }
  L.pathD = pathD;

  /* Универсальный график: оси, нулевая линия, затенённые зоны, полоса, линии, маркеры, перекрестие.
     cfg: { x0, x1, series:[{pts, cls, area}], band:{pts:[[t,lo,hi]]}, shades:[{from,to,label}], hl:[{y,cls,label}],
            vl:[{x,label}], marks:[{x,y,cls,r}], yFmt, xLabels:[[t,txt]], tip:fn(i,pt)->html, tipSeries, pad, yTicks, yPad, draw } */
  L.chart = function (box, cfg) {
    const W = Math.max(120, box.clientWidth), H = Math.max(40, box.clientHeight);
    const pad = Object.assign({ l: 4, r: 46, t: 12, b: 20 }, cfg.pad || {});
    let lo = cfg.yMin !== undefined ? cfg.yMin : 0, hi = cfg.yMax !== undefined ? cfg.yMax : 0;
    if (cfg.yMin === undefined) {
      (cfg.series || []).forEach((s) => s.pts.forEach((p) => { if (p[1] < lo) lo = p[1]; if (p[1] > hi) hi = p[1]; }));
      if (cfg.band) cfg.band.pts.forEach((p) => { if (p[1] < lo) lo = p[1]; if (p[2] > hi) hi = p[2]; });
      (cfg.hl || []).forEach((h) => { if (h.y < lo) lo = h.y; if (h.y > hi) hi = h.y; });
      const yp = cfg.yPad === undefined ? 0.06 : cfg.yPad, sp = (hi - lo) || 1;
      lo -= sp * yp; hi += sp * yp;
    }
    const ticks = cfg.ticks || L.niceTicks(lo, hi, cfg.yTicks || 4);
    if (!cfg.ticks) { lo = ticks[0]; hi = ticks[ticks.length - 1]; }
    const x0 = cfg.x0, x1 = cfg.x1 === x0 ? x0 + 1 : cfg.x1;
    const X = (t) => pad.l + (t - x0) / (x1 - x0) * (W - pad.l - pad.r);
    const Y = (v) => pad.t + (hi - v) / (hi - lo) * (H - pad.t - pad.b);
    const yFmt = cfg.yFmt || ((v) => String(v));
    let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" aria-hidden="true">';
    (cfg.shades || []).forEach((z) => {
      const a = X(Math.max(x0, z.from)), b = X(Math.min(x1, z.to));
      s += '<rect class="shade" x="' + f1(a) + '" y="' + pad.t + '" width="' + f1(Math.max(0, b - a)) + '" height="' + (H - pad.t - pad.b) + '"/>';
      if (z.label && b - a > 70) s += '<text class="g-lbl-b" x="' + f1(a + 6) + '" y="' + (pad.t + 12) + '">' + L.esc(z.label) + '</text>';
    });
    ticks.forEach((v) => {
      const y = f1(Y(v));
      s += '<line class="' + (Math.abs(v) < 1e-9 ? 'g-zero' : 'g-grid') + '" x1="' + pad.l + '" x2="' + (W - pad.r) + '" y1="' + y + '" y2="' + y + '"/>';
      s += '<text class="g-lbl" x="' + (W - pad.r + 6) + '" y="' + (y + 3) + '">' + L.esc(yFmt(v)) + '</text>';
    });
    (cfg.xLabels || []).forEach((xl, i, arr) => {
      const x = X(xl[0]);
      const anchor = i === 0 ? 'start' : i === arr.length - 1 ? 'end' : 'middle';
      s += '<text class="g-lbl" text-anchor="' + anchor + '" x="' + f1(x) + '" y="' + (H - 5) + '">' + L.esc(xl[1]) + '</text>';
    });
    (cfg.vl || []).forEach((v) => {
      const x = f1(X(v.x));
      s += '<line class="g-zero" x1="' + x + '" x2="' + x + '" y1="' + pad.t + '" y2="' + (H - pad.b) + '"/>';
      if (v.label) s += '<text class="g-lbl-b" text-anchor="' + (v.anchor || 'start') + '" x="' + (v.anchor === 'end' ? x - 5 : x + 5) + '" y="' + (H - pad.b - 6) + '">' + L.esc(v.label) + '</text>';
    });
    if (cfg.band && cfg.band.pts.length > 1) {
      const bp = cfg.band.pts;
      let d = '';
      bp.forEach((p, i) => { d += (i ? 'L' : 'M') + f1(X(p[0])) + ' ' + f1(Y(p[2])); });
      for (let i = bp.length - 1; i >= 0; i--) d += 'L' + f1(X(bp[i][0])) + ' ' + f1(Y(bp[i][1]));
      s += '<path class="band" d="' + d + 'Z"/>';
    }
    (cfg.hl || []).forEach((h) => {
      const y = f1(Y(h.y));
      s += '<line class="' + h.cls + '" x1="' + f1(h.x0 !== undefined ? X(h.x0) : pad.l) + '" x2="' + f1(h.x1 !== undefined ? X(h.x1) : W - pad.r) + '" y1="' + y + '" y2="' + y + '"/>';
      if (h.label) s += '<text class="lvl-lbl" fill="' + (h.color || 'currentColor') + '" x="' + f1((h.lx !== undefined ? X(h.lx) : pad.l) + 4) + '" y="' + (y - 4) + '">' + L.esc(h.label) + '</text>';
    });
    (cfg.series || []).forEach((sr) => {
      if (sr.pts.length < 2) return;
      const d = pathD(sr.pts, X, Y);
      if (sr.area) {
        const z = f1(Y(0));
        s += '<path class="area" fill="url(#' + (sr.area === 'neg' ? 'g-area-neg' : 'g-area-pos') + ')" d="' + d + 'L' + f1(X(sr.pts[sr.pts.length - 1][0])) + ' ' + z + 'L' + f1(X(sr.pts[0][0])) + ' ' + z + 'Z"/>';
      }
      if (sr.fill) {
        const z = f1(Y(0));
        s += '<path class="' + sr.fill + '" d="' + d + 'L' + f1(X(sr.pts[sr.pts.length - 1][0])) + ' ' + z + 'L' + f1(X(sr.pts[0][0])) + ' ' + z + 'Z"/>';
      } else {
        s += '<path class="eq ' + (sr.cls || '') + (cfg.draw && !L.reduced ? ' draw' : '') + '" pathLength="1" d="' + d + '"/>';
      }
    });
    (cfg.marks || []).forEach((m) => {
      s += '<circle class="mk ' + m.cls + '" cx="' + f1(X(m.x)) + '" cy="' + f1(Y(m.y)) + '" r="' + (m.r || 4) + '"/>';
    });
    s += '<g class="xh-g" style="display:none"><line class="xh" y1="' + pad.t + '" y2="' + (H - pad.b) + '"/><circle class="xh-dot" r="4"/></g>';
    s += '</svg>';
    box.innerHTML = s + (cfg.tip ? '<div class="tip" hidden></div>' : '');
    if (cfg.tip) attachTip(box, cfg, X, Y);
    return { X, Y, W, H, lo, hi };
  };
  function attachTip(box, cfg, X, Y) {
    const svg = box.querySelector('svg'), g = svg.querySelector('.xh-g'), ln = g.querySelector('line'), dot = g.querySelector('circle');
    const tip = box.querySelector('.tip');
    const pts = cfg.tipSeries || (cfg.series && cfg.series[0] && cfg.series[0].pts) || [];
    if (!pts.length) return;
    const xs = pts.map((p) => X(p[0]));
    function at(clientX) {
      const r = svg.getBoundingClientRect();
      const x = clientX - r.left;
      let lo = 0, hi = xs.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] < x) lo = m; else hi = m; }
      const i = Math.abs(xs[lo] - x) < Math.abs(xs[hi] - x) ? lo : hi;
      const p = pts[i], px = xs[i], py = Y(p[1]);
      g.style.display = '';
      ln.setAttribute('x1', px); ln.setAttribute('x2', px);
      dot.setAttribute('cx', px); dot.setAttribute('cy', py);
      tip.hidden = false;
      tip.innerHTML = cfg.tip(i, p);
      const tw = tip.offsetWidth;
      tip.style.left = Math.min(r.width - tw / 2 - 4, Math.max(tw / 2 + 4, px)) + 'px';
      tip.style.top = Math.max(26, py) + 'px';
    }
    function hide() { g.style.display = 'none'; tip.hidden = true; }
    box.onpointermove = (e) => at(e.clientX);
    box.onpointerdown = (e) => at(e.clientX);
    box.onpointerleave = hide;
  }
  // перерисовка при смене ширины контейнера
  L.autoSize = function (box, render) {
    let w = box.clientWidth;
    if (!('ResizeObserver' in window)) return;
    let t = 0;
    new ResizeObserver(() => {
      if (Math.abs(box.clientWidth - w) < 2) return;
      w = box.clientWidth;
      clearTimeout(t); t = setTimeout(render, 80);
    }).observe(box);
  };
  // общие defs: градиенты под кривой и штриховка убытка
  L.defs = function () {
    const d = document.createElement('div');
    d.innerHTML = '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>' +
      '<linearGradient id="g-area-pos" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3df2a0" stop-opacity=".2"/><stop offset="1" stop-color="#3df2a0" stop-opacity="0"/></linearGradient>' +
      '<linearGradient id="g-area-neg" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#ff7a8f" stop-opacity=".18"/><stop offset="1" stop-color="#ff7a8f" stop-opacity="0"/></linearGradient>' +
      '<pattern id="hatch-loss" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="rgba(255,122,143,.08)"/><line x1="0" y1="0" x2="0" y2="5" stroke="rgba(255,122,143,.55)" stroke-width="1.4"/></pattern>' +
      '</defs></svg>';
    document.body.appendChild(d.firstChild);
  };

  // ---------- взаимодействие ----------
  // группа role=radio: клик, стрелки, единое событие изменения
  L.radio = function (group, onChange) {
    if (!group) return;
    const btns = () => L.$$('button[data-v]', group);
    btns().forEach((x) => { x.setAttribute('role', 'radio'); x.setAttribute('aria-checked', x.classList.contains('on') ? 'true' : 'false'); });
    function set(b, fire) {
      btns().forEach((x) => { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-checked', on ? 'true' : 'false'); x.tabIndex = on ? 0 : -1; });
      if (fire) onChange(b.getAttribute('data-v'), b);
    }
    btns().forEach((b) => { b.tabIndex = b.classList.contains('on') ? 0 : -1; });
    group.addEventListener('click', (e) => { const b = e.target.closest('button[data-v]'); if (b && group.contains(b) && !b.disabled) set(b, true); });
    group.addEventListener('keydown', (e) => {
      const k = e.key; if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].indexOf(k) < 0) return;
      const list = btns().filter((b) => !b.disabled && b.offsetParent !== null), i = list.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      const n = list[(i + (k === 'ArrowRight' || k === 'ArrowDown' ? 1 : list.length - 1)) % list.length];
      n.focus(); set(n, true);
    });
    return { set: (v) => { const b = btns().find((x) => x.getAttribute('data-v') === String(v)); if (b) set(b, false); } };
  };
  L.rangeFill = function (inp) {
    const f = () => inp.style.setProperty('--p', ((inp.value - inp.min) / (inp.max - inp.min) * 100) + '%');
    inp.addEventListener('input', f); f();
  };
  L.onVisible = function (el, cb, margin) {
    if (!el) return;
    if (!('IntersectionObserver' in window)) { cb(); return; }
    const io = new IntersectionObserver((ents) => { if (ents.some((e) => e.isIntersecting)) { io.disconnect(); cb(); } }, { rootMargin: margin || '0px 0px -10% 0px' });
    io.observe(el);
  };
  // мягкий блик под курсором на стеклянных панелях (только мышь, без reduced-motion)
  L.glare = function () {
    if (L.reduced || !L.finePointer) return;
    let cur = null;
    document.addEventListener('pointermove', (e) => {
      const p = e.target.closest && e.target.closest('.inst');
      if (cur && cur !== p) cur.classList.remove('is-lit');
      cur = p;
      if (!p) return;
      const r = p.getBoundingClientRect();
      p.style.setProperty('--mx', (e.clientX - r.left) + 'px');
      p.style.setProperty('--my', (e.clientY - r.top) + 'px');
      p.classList.add('is-lit');
    }, { passive: true });
  };

  window.CHML = window.CHML || {};
  window.CHML.lib = L;
})();
