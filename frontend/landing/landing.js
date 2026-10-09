/* CHM Breaker — общий скрипт лендинга (/) и тарифов (/pricing). Без сборки и без зависимостей.
 DATA_SOURCE: 'api' (GET /api/public/*) или 'mock' по эндпоинтам, ?data= — README.md. */
(() => {
'use strict';
const DATA_SOURCE = { trend: 'api', stats: 'api', feed: 'api', showcase: 'mock', sandbox: 'mock', genome: 'mock' };
const D = document, QS = new URLSearchParams(location.search);
const MODE = { empty: 'empty', api: 'api', mock: 'mock' }[QS.get('data')], SRC = (p) => MODE || DATA_SOURCE[p], ALL_API = Object.keys(DATA_SOURCE).every((p) => SRC(p) === 'api');
const $ = (s, r) => (r || D).querySelector(s), $$ = (s, r) => [...(r || D).querySelectorAll(s)];
const on = (el, ev, f) => el && el.addEventListener(ev, f);
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches, FINE = matchMedia('(hover: hover) and (pointer: fine)').matches;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const txt = (s, v) => { const e = $(s); if (e) e.textContent = v; };
const html = (s, v) => { const e = $(s); if (e) e.innerHTML = v; };

const EMPTY = 'Статистика появится после 30 закрытых сигналов';
const NO = { sandbox: 'Предрасчёт бэктеста появится после первого ночного прогона', genome: 'История эволюции появится после первого прогона Genome', trend: 'Тренд BTC появится после запуска монитора' };
let mockP;
function api(path, q) {
 const none = { empty: true, reason: NO[path] || EMPTY }, m = SRC(path);
 if (m === 'empty') return Promise.resolve(none);
 if (m === 'mock') {
  mockP = mockP || new Promise((ok, no) => { const s = D.createElement('script'); s.src = '/landing/data/mock-api.js?v=6'; s.onload = ok; s.onerror = no; D.head.appendChild(s); });
  return mockP.then(() => window.CHM_MOCK.get(path, q && Object.fromEntries(new URLSearchParams(q)))).catch(() => none);
 }
 return fetch('/api/public/' + path + (q ? '?' + new URLSearchParams(q) : ''), { headers: { Accept: 'application/json' } })
  .then((r) => { if (!r.ok) throw r.status; return r.json(); }).catch(() => ({ empty: true, reason: 'Данные временно недоступны' }));
}
const memo = {};
const api1 = (p) => memo[p] || (memo[p] = api(p));
const ok = (d) => d && !d.empty;

const MI = '−', NB = ' ';
const num = (x, d) => { const p = Math.abs(x).toFixed(d || 0).split('.'); p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, NB); return p.join(','); };
const sgn = (x, d, s) => (+Math.abs(x).toFixed(d || 0) ? (x > 0 ? '+' : MI) : '') + num(x, d) + (s || '');
const fR = (x, d) => sgn(x, d == null ? 1 : d, 'R'), fP = (x, d) => sgn(x, d == null ? 1 : d, '%');
const usd = (x, d) => (x < 0 && +Math.abs(x).toFixed(d || 0) ? MI : '') + '$' + num(x, d);
const rTxt = (r) => { const k = Math.round(r * 100); return num(r, k % 100 ? (k % 10 ? 2 : 1) : 0) + '%'; };
const p2 = (n) => String(n).padStart(2, '0');
const hm = (t) => { const d = new Date(t); return p2(d.getHours()) + ':' + p2(d.getMinutes()); };
const dm = (t) => { const d = new Date(t); return p2(d.getDate()) + '.' + p2(d.getMonth() + 1); };
const dmy = (t) => dm(t) + '.' + new Date(t).getFullYear();
const utc = (t) => { const d = new Date(t); return p2(d.getUTCDate()) + '.' + p2(d.getUTCMonth() + 1) + ' ' + p2(d.getUTCHours()) + ':00'; };
const plural = (n, a, b, c) => { n = Math.abs(n) % 100; const k = n % 10; return n > 10 && n < 20 ? c : k === 1 ? a : k > 1 && k < 5 ? b : c; };

const wilson = (k, n) => { if (!n) return [0, 0]; const z2 = 3.8416, p = k / n, den = 1 + z2 / n, c = p + z2 / (2 * n), m = 1.96 * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)); return [Math.max(0, (c - m) / den * 100), Math.min(100, (c + m) / den * 100)]; };
const riskLvl = (p95m, r, lev) => { const d = p95m * r; return lev >= 10 ? 5 : d <= 5 ? 1 : d <= 8 ? 2 : d <= 12 ? 3 : d <= 18 ? 4 : 5; };
const RW = ['', 'низкий', 'умеренный', 'заметный', 'высокий', 'очень высокий'];
const median = (a) => { const s = a.slice().sort((x, y) => x - y), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; };
const STR = { LEVELS: ['Уровни', '1H', 'УР'], SMC: ['SMC', '15m', 'SMC'], VOLUME: ['Объём + MA', '4H', 'ОБ'] }, DIRN = { both: 'Long + Short', long: 'Long', short: 'Short' };
function baseTags(s) {
 const t = [s.n < 30 ? ['warn', `мало сделок (${s.n} < 30): выводы ненадёжны`] : ['ok', 'сделок ' + s.n]], q = s.n ? (s.n - s.wins) / s.n : 0;
 if (s.r_total < 0) t.push(['bad', 'итог после комиссий меньше нуля']);
 if (s.p95_dd_r > 15) t.push(['warn', 'p95 просадки больше 15R']);
 if (s.gross_r <= s.fee_r_total) t.push(['warn', 'комиссии больше прибыли до комиссий']);
 else if (s.fee_r_total / s.gross_r > 0.3) t.push(['warn', `комиссии съедают ${Math.round(s.fee_r_total / s.gross_r * 100)}% прибыли`]);
 if (q > 0 && q < 1 && s.max_loss_streak > Math.log(s.n) / Math.log(1 / q) + 1.5) t.push(['warn', `серия убытков длиннее ожидаемой: ${s.max_loss_streak} подряд`]);
 return t;
}
const tagsH = (t) => t.map((x) => `<span class="tag ${x[0]}">${esc(x[1])}</span>`).join('');

let DIG = ''; for (let i = 0; i < 10; i++) DIG += '<i>' + i + '</i>';
function odo(el, t) {
 if (!el) return;
 t = String(t); const pv = el._o;
 if (pv === t) return;
 el._o = t;
 if (pv == null || RM) { el.textContent = t; return; }
 let h = `<span class="sr">${esc(t)}</span><span class="odo-v" aria-hidden="true">`; const off = pv.length - t.length;
 for (let i = 0; i < t.length; i++) {
  const c = t[i], q = pv[i + off];
  h += c >= '0' && c <= '9' ? `<span class="od"><span data-d="${c}" style="transform:translateY(${-(q >= '0' && q <= '9' ? +q : 0) * 10}%)">${DIG}</span></span>` : `<span>${c === ' ' ? '&nbsp;' : esc(c)}</span>`;
 }
 el.innerHTML = h + '</span>';
 requestAnimationFrame(() => requestAnimationFrame(() => $$('.od>span', el).forEach((s) => { s.style.transform = `translateY(${-s.dataset.d * 10}%)`; })));
}

function ticks(lo, hi, n) {
 if (lo === hi) { lo -= 1; hi += 1; }
 const raw = (hi - lo) / (n || 4), mag = Math.pow(10, Math.floor(Math.log10(raw))), st = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw), out = [];
 for (let v = Math.floor(lo / st) * st; v <= Math.ceil(hi / st) * st + st / 2; v += st) out.push(Math.round(v * 1e6) / 1e6);
 return out;
}
const f1 = (x) => Math.round(x * 10) / 10;
const pathD = (pts, X, Y) => pts.map((p, i) => (i ? 'L' : 'M') + f1(X(p[0])) + ' ' + f1(Y(p[1]))).join('');
function mark(m, X, Y) {
 const x = f1(X(m.x)), y = f1(Y(m.y)), r = m.r || 4;
 return m.cls === 'x' ? `<path class="mk-x" d="M${x - r} ${y - r}L${x + r} ${y + r}M${x + r} ${y - r}L${x - r} ${y + r}"/>` : `<circle class="mk ${m.cls}" cx="${x}" cy="${y}" r="${r}"${m.o ? ` opacity="${m.o}"` : ''}/>`;
}
function chart(box, c) {
 const W = Math.max(120, box.clientWidth), H = Math.max(40, box.clientHeight);
 const P = Object.assign({ l: c.yFmt ? 42 : 4, r: c.y2Fmt ? 48 : 8, t: 10, b: c.xl ? 20 : 4 }, c.pad);
 let lo = c.yMin, hi = c.yMax;
 if (lo == null) {
  lo = hi = 0;
  const tk = (v) => { if (v < lo) lo = v; if (v > hi) hi = v; };
  (c.series || []).forEach((s) => s.pts.forEach((p) => tk(p[1])));
  (c.band || []).forEach((p) => { tk(p[1]); tk(p[2]); });
  (c.hl || []).forEach((h) => tk(h.y)); (c.marks || []).forEach((m) => tk(m.y));
  if (c.zeroless) { lo = Math.min(...c.series[0].pts.map((p) => p[1])); hi = Math.max(...c.series[0].pts.map((p) => p[1])); }
  const sp = hi - lo || 1; lo -= sp * 0.06; hi += sp * 0.06;
 }
 const tk = c.ticks || ticks(lo, hi, c.yt || 4);
 if (!c.ticks) { lo = tk[0]; hi = tk[tk.length - 1]; }
 const x0 = c.x0, x1 = c.x1 === x0 ? x0 + 1 : c.x1;
 const X = (t) => P.l + (t - x0) / (x1 - x0) * (W - P.l - P.r), Y = (v) => P.t + (hi - v) / (hi - lo) * (H - P.t - P.b);
 let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">`;
 (c.shades || []).forEach((z) => {
  const a = X(Math.max(x0, z.from)), b = X(Math.min(x1, z.to));
  s += `<rect class="${z.cls || 'shade'}" x="${f1(a)}" y="${P.t}" width="${f1(Math.max(0, b - a))}" height="${H - P.t - P.b}"/>`;
  if (z.label && b - a > 90) s += `<text class="g-lblb" x="${f1(a + 6)}" y="${P.t + 14}">${esc(z.label)}</text>`;
 });
 tk.forEach((v) => {
  const y = f1(Y(v));
  s += `<line class="${Math.abs(v) < 1e-9 && !c.zeroless ? 'g-zero' : 'g-grid'}" x1="${P.l}" x2="${W - P.r}" y1="${y}" y2="${y}"/>`;
  if (c.yFmt) s += `<text class="g-lbl" text-anchor="end" x="${P.l - 6}" y="${y + 4}">${esc(c.yFmt(v))}</text>`;
  if (c.y2Fmt) s += `<text class="g-lbl2" x="${W - P.r + 6}" y="${y + 4}">${esc(c.y2Fmt(v))}</text>`;
 });
 (c.xl || []).forEach((l, i, a) => { s += `<text class="g-lbl" text-anchor="${i ? (i === a.length - 1 ? 'end' : 'middle') : 'start'}" x="${f1(X(l[0]))}" y="${H - 5}">${esc(l[1])}</text>`; });
 (c.vl || []).forEach((v) => {
  const x = f1(X(v.x)), end = X(v.x) > W * 0.62;
  s += `<line class="${v.cls || 'g-zero'}" x1="${x}" x2="${x}" y1="${P.t}" y2="${H - P.b}"/>`;
  if (v.label) s += `<text class="g-lblb" text-anchor="${end ? 'end' : 'start'}" x="${end ? x - 5 : x + 5}" y="${P.t + 14 + (v.dy || 0)}">${esc(v.label)}</text>`;
 });
 if (c.band && c.band.length > 1) {
  let d = ''; c.band.forEach((p, i) => { d += (i ? 'L' : 'M') + f1(X(p[0])) + ' ' + f1(Y(p[2])); });
  for (let i = c.band.length - 1; i >= 0; i--) d += 'L' + f1(X(c.band[i][0])) + ' ' + f1(Y(c.band[i][1]));
  s += `<path class="band" d="${d}Z"/>`;
 }
 (c.hl || []).forEach((h) => { const y = f1(Y(h.y)); s += `<line class="${h.cls}" x1="${f1(h.x0 != null ? X(h.x0) : P.l)}" x2="${f1(h.x1 != null ? X(h.x1) : W - P.r)}" y1="${y}" y2="${y}"/>`; });
 (c.dots || []).forEach((m) => { s += mark(m, X, Y); });
 (c.series || []).forEach((sr) => {
  if (sr.pts.length < 2) return;
  const d = pathD(sr.pts, X, Y), z = f1(Y(Math.max(lo, 0))), cl = `L${f1(X(sr.pts[sr.pts.length - 1][0]))} ${z}L${f1(X(sr.pts[0][0]))} ${z}Z`;
  if (sr.fill) { s += `<path class="${sr.fill}" d="${d}${cl}"/>`; return; }
  if (sr.area) s += `<path fill="url(#ga-${sr.area})" d="${d}${cl}"/>`;
  s += `<path class="eq ${sr.cls || ''}${c.draw && !RM ? ' draw' : ''}" pathLength="1" d="${d}"/>`;
 });
 (c.marks || []).forEach((m) => { s += mark(m, X, Y); });
 s += `<g class="xh-g" style="display:none"><line class="xh" y1="${P.t}" y2="${H - P.b}"/><circle class="xh-dot" r="4"/></g></svg>`;
 box.innerHTML = s + (c.tip ? '<div class="tip" hidden></div>' : '');
 if (c.tip) tip(box, c.tipPts || c.series[0].pts, c.tip, X, Y);
}
function tip(box, pts, fn, X, Y) {
 const svg = $('svg', box), g = $('.xh-g', box), ln = $('line', g), dot = $('circle', g), tp = $('.tip', box), xs = pts.map((p) => X(p[0]));
 const at = (cx) => {
  const r = svg.getBoundingClientRect(), off = r.left - box.getBoundingClientRect().left, x = cx - r.left;
  let lo = 0, hi = xs.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] < x) lo = m; else hi = m; }
  const i = Math.abs(xs[lo] - x) < Math.abs(xs[hi] - x) ? lo : hi, px = xs[i], py = Y(pts[i][1]);
  g.style.display = ''; ln.setAttribute('x1', px); ln.setAttribute('x2', px); dot.setAttribute('cx', px); dot.setAttribute('cy', py);
  tp.hidden = false; tp.innerHTML = fn(i, pts[i]);
  const w = tp.offsetWidth; tp.style.left = Math.min(box.clientWidth - w / 2 - 4, Math.max(w / 2 + 4, px + off)) + 'px'; tp.style.top = Math.max(26, py) + 'px';
 };
 box.onpointermove = box.onpointerdown = (e) => at(e.clientX);
 box.onpointerleave = () => { g.style.display = 'none'; tp.hidden = true; };
}
const ph = (box, t) => { box.innerHTML = `<div class="ph">${esc(t)}</div>`; };
function autoSize(box, fn) {
 if (!window.ResizeObserver) return;
 let w = box.clientWidth, t;
 new ResizeObserver(() => { if (Math.abs(box.clientWidth - w) < 2) return; w = box.clientWidth; clearTimeout(t); t = setTimeout(fn, 80); }).observe(box);
}

function radio(g, cb) {
 if (!g) return { set() {} };
 const bs = () => $$('button[data-v]', g);
 const set = (b, fire) => { bs().forEach((x) => { const o = x === b; x.classList.toggle('on', o); x.setAttribute('aria-checked', o); x.tabIndex = o ? 0 : -1; }); if (fire) cb(b.dataset.v, b); };
 bs().forEach((x) => { const o = x.classList.contains('on'); x.setAttribute('role', 'radio'); x.setAttribute('aria-checked', o); x.tabIndex = o ? 0 : -1; });
 on(g, 'click', (e) => { const b = e.target.closest('button[data-v]'); if (b && g.contains(b) && !b.disabled) set(b, 1); });
 on(g, 'keydown', (e) => {
  const f = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]; if (!f) return;
  const l = bs().filter((b) => !b.disabled), i = l.indexOf(D.activeElement); if (i < 0) return;
  e.preventDefault(); const n = l[(i + f + l.length) % l.length]; n.focus(); set(n, 1);
 });
 return { set: (v) => { const b = bs().find((x) => x.dataset.v === String(v)); if (b) set(b); } };
}
const fill = (r) => r.style.setProperty('--p', (r.value - r.min) / (r.max - r.min) * 100 + '%');
const vis = (el, cb, m) => { if (!el) return; if (!window.IntersectionObserver) return cb(); const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); cb(); } }, { rootMargin: m || '200px' }); io.observe(el); };
const SEC = {};

SEC.header = () => {
 if (ALL_API) { $$('#proto, #ftr-src').forEach((e) => { e.hidden = true; }); }
 const b = $('#burger'), l = $('#nav-links'), sc = $('#scrim');
 if (b) {
  const set = (o) => { l.classList.toggle('open', o); b.setAttribute('aria-expanded', o); sc.hidden = !o; D.documentElement.style.overflow = o ? 'hidden' : ''; };
  on(b, 'click', () => set(!l.classList.contains('open')));
  on(sc, 'click', () => set(false));
  on(l, 'click', (e) => { if (e.target.closest('a')) set(false); });
  on(D, 'keydown', (e) => { if (e.key === 'Escape' && l.classList.contains('open')) { set(false); b.focus(); } });
 }
 const m = $('#mcta'), hero = $('.hero, .pr-hero'), f = $('.ftr');
 if (!window.IntersectionObserver) return;
 if (m && hero) { let a = 0, z = 0; const u = () => m.classList.toggle('show', a && !z); new IntersectionObserver((e) => { a = !e[0].isIntersecting; u(); }, { rootMargin: '-40% 0px 0px 0px' }).observe(hero); new IntersectionObserver((e) => { z = e[0].isIntersecting; u(); }).observe(f); }
 const map = {}; $$('#nav-links a[href^="#"]').forEach((a) => { map[a.hash.slice(1)] = a; });
 const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) $$('#nav-links a').forEach((a) => a.classList.toggle('cur', a === map[e.target.id])); }), { rootMargin: '-45% 0px -50% 0px' });
 Object.keys(map).forEach((id) => { const s = D.getElementById(id); if (s) io.observe(s); });
};

const TFN = { '15m': '15M', '1H': '1H', '4H': '4H', '1D': 'ДЕНЬ', '1W': 'НЕДЕЛЯ', '1M': 'МЕСЯЦ' }, TW = { LONG: 'ЛОНГ', SHORT: 'ШОРТ', RANGE: 'БОКОВИК' };
let TREND = null;
SEC.ticker = () => {
 const row = $('#tick-row'); if (!row) return;
 const tr = row.parentNode, pp = $('#tick-pp');
 // WCAG 2.2.2: кнопка паузы бегущей строки
 on(pp, 'click', () => { const o = pp.getAttribute('aria-pressed') !== 'true'; pp.setAttribute('aria-pressed', o); row.classList.toggle('paused', o); });
 const cells = (t) => Object.keys(TFN).map((k) => {
  const s = t.tfs[k] || {}, c = s.trend === 'LONG' ? 'long' : s.trend === 'SHORT' ? 'short' : 'flat';
  return `<span class="tc"><span>${TFN[k]}</span><span class="dir ${c}">${c === 'long' ? '▲' : c === 'short' ? '▼' : '↔'} ${TW[s.trend] || '—'}</span><span class="str ${c}"><b style="width:${s.strength || 0}%"></b></span><span class="val">${s.strength == null ? '—' : s.strength + '%'}</span></span>`;
 }).join('') + ['BTC', 'ETH'].map((k) => { const x = t.change_24h[k]; return `<span class="tc"><span>${k} 24Ч</span><span class="val ${x == null ? '' : x >= 0 ? 'up' : 'loss'}">${x == null ? '—' : fP(x, 2)}</span></span>`; }).join('');
 const fit = () => {
  if (!TREND) return;
  const one = cells(TREND); row.classList.remove('marq'); row.innerHTML = one;
  // копия для бесшовной прокрутки скрыта от дикторов
  if (!RM && row.scrollWidth > tr.clientWidth + 4) { row.innerHTML = one + one.replace(/<span class="tc">/g, '<span class="tc" aria-hidden="true">'); row.classList.add('marq'); }
  pp.hidden = !row.classList.contains('marq');
 };
 const render = (t) => {
  if (!ok(t)) { row.innerHTML = `<span class="tc">${esc(t.reason)}</span>`; txt('#tick-upd', 'нет данных'); return; }
  const first = !TREND; TREND = t;
  if (first) fit();
  else { const tmp = D.createElement('div'); tmp.innerHTML = cells(t); const fr = $$('.tc', tmp); $$('.tc', row).forEach((el, i) => { const f = fr[i % fr.length]; if (el.innerHTML !== f.innerHTML) el.innerHTML = f.innerHTML; }); }
  txt('#tick-upd', 'обн. ' + hm(t.updated_at));
 };
 api('trend').then(render);
 setInterval(() => { if (!D.hidden && TREND) api('trend', { tick: 1 }).then(render); }, SRC('trend') === 'mock' ? 5000 : 30000);
 let w = innerWidth; on(window, 'resize', () => { if (Math.abs(innerWidth - w) > 30) { w = innerWidth; fit(); } });
};

SEC.sandbox = () => {
 const box = $('#sbx-chart'); if (!box) return;
 const S = { st: 'LEVELS', coin: 'BTC', dir: 'both', risk: 1, g: null }, ri = $('#sbx-risk'), cw = $('#sbx-coins'), strip = $('#sbx-strip');
 let coinR, first = 1;
 fill(ri);
 radio($('#sbx-strat'), (v) => { S.st = v; render(); });
 radio($('#sbx-dir'), (v) => { S.dir = v; render(); });
 on(ri, 'input', () => { S.risk = +ri.value; fill(ri); render(1); });
 on($('#sbx-more'), 'click', (e) => { const o = cw.classList.toggle('open'); e.target.setAttribute('aria-expanded', o); e.target.textContent = o ? 'свернуть' : 'все 20'; });
 const pick = (v) => { const f = strip.contains(D.activeElement); S.coin = v; coinR.set(v); render(); if (f) { const n = $(`[data-v="${v}"]`, strip); if (n) n.focus(); } };
 const cell = (sym) => S.g.cells[`${S.st}:${sym}:${S.dir}`];
 function render(soft) {
  if (!S.g) return;
  const g = S.g, P = g.period, c = cell(S.coin), st = STR[S.st], r = S.risk, neg = c.r_total < 0;
  txt('#sbx-title', `${S.coin} · ${st[0]} · ${st[1]} · ${DIRN[S.dir]}`);
  txt('#sbx-period', `отложенный период ${dm(P.from)}–${dmy(P.to)} · ${P.days} дн.`);
  txt('#sbx-risk-out', rTxt(r)); txt('#sbx-leg', S.coin); txt('#sbx-axis', 'справа % при риске ' + rTxt(r));
  const all = g.coins.map((x) => cell(x.sym)), med = [], idx = all.map(() => 0);
  for (let k = 0; k <= 60; k++) {
   const t = P.from + (P.to - P.from) * k / 60;
   med.push([t, median(all.map((x, j) => { while (idx[j] + 1 < x.curve.length && x.curve[idx[j] + 1][0] <= t) idx[j]++; return x.curve[idx[j]][1]; }))]);
  }
  const dec = (v) => (Math.abs(v) < 10 && v % 1 ? 1 : 0);
  chart(box, { x0: P.from, x1: P.to, draw: !soft || first, series: [{ pts: med, cls: 'med' }, { pts: c.curve, cls: neg ? 'neg' : '', area: neg ? 'neg' : 'pos' }], tipPts: c.curve,
   yFmt: (v) => fR(v, dec(v)), y2Fmt: (v) => fP(v * r, dec(v * r)), xl: [[P.from, dm(P.from)], [(P.from + P.to) / 2, dm((P.from + P.to) / 2)], [P.to, dm(P.to)]],
   tip: (i, p) => (i ? `${dm(p[0])} · сделка ${i}<br><b>${fR(p[1])}</b> = ${fP(p[1] * r)} при ${rTxt(r)}` : 'старт · 0R') });
  box.setAttribute('aria-label', `Бэктест ${S.coin}, ${st[0]}: ${fR(c.r_total)} за ${P.days} дней, ${c.n} сделок, макс. просадка ${fR(-c.max_dd_r)}; медиана 20 монет пунктиром. Слева R, справа % при риске ${rTxt(r)}.`);
  let pk = 0;
  chart($('#sbx-uw'), { x0: P.from, x1: P.to, series: [{ pts: c.curve.map((p) => { pk = Math.max(pk, p[1]); return [p[0], p[1] - pk]; }), fill: 'uw' }], yMax: 0, yMin: Math.min(-1, -c.max_dd_r * 1.15), ticks: [0], pad: { l: 42, r: 48, t: 2, b: 2 } });
  odo($('#m-r'), fR(c.r_total)); $('#m-r').classList.toggle('loss', neg);
  txt('#m-rp', `= ${fP(c.r_total * r)} при риске ${rTxt(r)}`);
  odo($('#m-dd'), fR(-c.max_dd_r)); txt('#m-ddp', `= ${fP(-c.max_dd_r * r)} депозита`);
  const ci = wilson(c.wins, c.n); odo($('#m-wr'), Math.round(c.wins / c.n * 100) + '%'); txt('#m-wrci', `Уилсон ${Math.round(ci[0])}–${Math.round(ci[1])}%`);
  odo($('#m-pf'), c.pf == null ? '—' : num(c.pf, 2)); txt('#m-n', `сделок ${c.n}${c.n < 30 ? ' · мало' : ''}`);
  const lv = riskLvl(c.p95_month_r, r); $('#m-risk .rbar').dataset.l = lv; txt('#m-risk span', lv + ' из 5'); txt('#m-riskl', `${RW[lv]} при риске ${rTxt(r)}${c.n < 30 ? ', мало данных' : ''}`);
  html('#sbx-honest', `При риске <b>${rTxt(r)}</b> на сделку, без реинвеста: результат <b>${fP(c.r_total * r)}</b>, худшая просадка <b>${fP(-c.max_dd_r * r)}</b> депозита. В худших 5% месяцев (Монте-Карло) просадка до <b>${fP(-c.p95_month_r * r)}</b>. Риск выше — шире оба края.`);
  const vals = g.coins.map((x) => ({ s: x.sym, v: cell(x.sym).r_total })), m = median(vals.map((x) => x.v)), nn = vals.filter((x) => x.v < 0).length;
  html('#sbx-median', `медиана <b>${fR(m)}</b> · в минусе ${nn} из 20 · ${S.coin} <b>${fR(c.r_total)}</b>`);
  const lo = Math.min(0, ...vals.map((x) => x.v)), hi = Math.max(0, ...vals.map((x) => x.v)), X = (v) => 3 + (v - lo) / (hi - lo || 1) * 94, lanes = [], sw = strip.clientWidth / 100 || 3;
  const C = parseFloat(getComputedStyle(strip).getPropertyValue('--sc')) || 48, LN = [0, -14, 14, -28, 28];
  let h = `<i class="st-zero" style="left:${X(0)}%"></i><span class="st-zl" style="left:${X(0)}%">0R</span><i class="st-med" style="left:${X(m)}%"></i><span class="st-ml" style="left:${X(m)}%">медиана</span>`;
  vals.slice().sort((a, b) => a.v - b.v).forEach((x) => {
   const p = X(x.v), o = x.s === S.coin; let ln = LN.findIndex((_, k) => lanes[k] == null || (p - lanes[k]) * sw >= 14);
   if (ln < 0) ln = lanes.indexOf(Math.min(...lanes));
   lanes[ln] = p;
   h += `<button class="st-dot${o ? ' on' : ''}" data-v="${x.s}" role="radio" aria-checked="${o}" tabindex="${o ? 0 : -1}" aria-label="${x.s}: ${fR(x.v)}" title="${x.s} ${fR(x.v)}" style="left:${p}%;top:${C + LN[ln]}px;--c:var(--${x.v < 0 ? 'loss' : 'green'})"></button>`;
  });
  strip.innerHTML = h;
  const tg = baseTags(c);
  if (c.r_total * r < c.hold_pct) tg.push(['info', `хуже, чем держать ${S.coin} (${fP(c.hold_pct)} без плеча)`]);
  if (S.st !== 'VOLUME') tg.push(['info', 'MTF-фильтры в бэктесте упрощены']);
  if (c.r_total > m && c.r_total > 0) tg.push(['info', `${S.coin} выше медианы — не выбирайте монету по лучшему результату`]);
  html('#sbx-tags', tagsH(tg));
  const q = new URLSearchParams({ from: 'sandbox', mode: 'demo', strategy: S.st, coin: S.coin, dir: S.dir, risk: r });
  $('#hero-launch').href = $('#sbx-launch').href = '/app/?' + q;
  try { localStorage.setItem('chm_sandbox_cfg', JSON.stringify({ strategy: S.st, coin: S.coin, dir: S.dir, risk: r, at: Date.now() })); } catch (e) { /* приватный режим */ }
  first = 0;
 }
 api1('sandbox').then((g) => {
  if (!ok(g)) {
   ph(box, g.reason); txt('#sbx-honest', 'Цифры появятся после ночного прогона бэктестера. Выдуманных результатов не показываем.');
   html('#sbx-tags', '<span class="tag info">нет данных</span>'); txt('#sbx-median', 'нет данных'); return;
  }
  S.g = g; txt('#sbx-sel', dmy(g.selection_end)); txt('#sbx-upd', dmy(g.updated_at) + ' ' + hm(g.updated_at));
  cw.innerHTML = g.coins.map((c) => `<button class="chip${c.sym === S.coin ? ' on' : ''}" data-v="${c.sym}" title="Объём за 24 ч ≈ $${c.vol24h_musd >= 1000 ? num(c.vol24h_musd / 1000, 1) + ' млрд' : c.vol24h_musd + ' млн'}">${c.sym}<em>${c.vol24h_musd >= 1000 ? num(c.vol24h_musd / 1000, 1) + ' млрд' : c.vol24h_musd + ' млн'}</em></button>`).join('');
  coinR = radio(cw, pick); radio(strip, pick);
  render(); autoSize(box, () => render(1));
 });
};

const PTH = { open: ['ВХОД', ''], tp1: ['TP1', 'tp'], tp2: ['TP2', 'tp'], tp3: ['TP3', 'tp'], be: ['БУ', 'be'], sl: ['СТОП', 'sl'], exp: ['ИСТЁК', 'be'], missed: ['БЕЗ ВХОДА', 'be'] };
SEC.feed = () => {
 const list = $('#feed-list'); if (!list) return;
 const F = { f: 'all', paused: false, items: [], cur: null, vis: false, t: 0 }, MAX = 8, pb = $('#feed-pause');
 const live = (it) => it.status === 'open' || it.status === 'tp1';
 const chain = (it) => it.path.map((p, i) => (i ? '<i></i>' : '') + `<span class="pth ${live(it) && i === it.path.length - 1 ? 'live' : PTH[p][1]}">${PTH[p][0]}</span>`).join('');
 const res = (it) => (it.r != null ? [it.r > 0 ? 'up' : it.r < 0 ? 'loss' : '', fR(it.r, 2)] : live(it) ? ['amber', it.status === 'tp1' ? 'стоп в БУ' : 'в сделке'] : ['', '—']);
 const sr = (it) => `${hm(it.t)}, ${it.pair} ${it.side}, ${it.strategy_name}: ${it.path.map((p) => PTH[p][0]).join(' → ')}${it.r != null ? ', ' + fR(it.r, 2) : ''}`;
 const row = (it) => { const r = res(it); return `<li class="fi" data-id="${it.id}"><span class="sr">${esc(sr(it))}</span><span class="ft" aria-hidden="true">${hm(it.t)}</span><span class="fp" aria-hidden="true"><b>${it.pair} <em class="${it.side === 'LONG' ? 'up' : 'loss'}">${it.side}</em></b><span>${esc(it.strategy_name)} · ${it.tf}</span></span><span class="chain" aria-hidden="true">${chain(it)}</span><span class="fr ${r[0]}" aria-hidden="true">${r[1]}</span></li>`; };
 const render = () => { const l = F.items.filter((x) => F.f === 'all' || x.strategy === F.f).slice(0, MAX); list.innerHTML = l.length ? l.map(row).join('') : '<li class="fi-empty">Нет сигналов этой стратегии за последний час</li>'; };
 radio($('#feed-f'), (v) => { F.f = v; render(); });
 const sched = () => { clearTimeout(F.t); if (!F.paused && F.vis && !D.hidden && F.cur) F.t = setTimeout(poll, SRC('feed') === 'mock' ? 7000 : 30000); };
 on(pb, 'click', () => { F.paused = !F.paused; pb.setAttribute('aria-pressed', F.paused); pb.innerHTML = F.paused ? '<span aria-hidden="true">▶</span> Дальше' : '<span aria-hidden="true">❚❚</span> Пауза'; sched(); });
 const poll = () => api('feed', { after: F.cur }).then((d) => {
  if (ok(d)) {
   F.cur = d.cursor || F.cur;
   (d.events || []).forEach((ev) => {
    if (ev.type === 'new') {
     F.items.unshift(ev.item);
     if (F.f !== 'all' && ev.item.strategy !== F.f) return;
     const t = D.createElement('template'); t.innerHTML = row(ev.item); const li = t.content.firstChild;
     if (!RM) li.classList.add('enter');
     $$('.fi-empty', list).forEach((x) => x.remove()); list.prepend(li); $$('.fi', list).slice(MAX).forEach((x) => x.remove());
    } else {
     const it = F.items.find((x) => x.id === ev.id); if (!it) return;
     Object.assign(it, { status: ev.status, path: ev.path, r: ev.r });
     const li = $(`[data-id="${ev.id}"]`, list); if (!li) return;
     const r = res(it); $('.sr', li).textContent = sr(it); $('.chain', li).innerHTML = chain(it); const fr = $('.fr', li); fr.className = 'fr ' + r[0]; fr.textContent = r[1];
     if (!RM) { li.classList.remove('flash'); void li.offsetWidth; li.classList.add('flash'); }
    }
   });
   F.items.length = Math.min(F.items.length, 60);
  }
  sched();
 });
 api('feed').then((d) => {
  if (!ok(d)) { list.innerHTML = `<li class="fi-empty">${esc(d.reason)}</li>`; pb.disabled = true; return; }
  F.items = d.items; F.cur = d.cursor; render(); sched();
 });
 const clock = () => txt('#feed-clock', `сейчас ${hm(Date.now())} · лента до ${hm(Date.now() - 36e5)}`);
 clock(); setInterval(clock, 15000);
 if (window.IntersectionObserver) new IntersectionObserver((e) => { F.vis = e[0].isIntersecting; sched(); }).observe($('#now')); else F.vis = true;
 on(D, 'visibilitychange', sched);
};
SEC.counters = () => {
 if (!$('[data-c="signals"]')) return;
 api1('stats').then((s) => {
  const set = (k, v) => txt(`[data-c="${k}"]`, v), up = (k, t) => txt(`[data-u="${k}"]`, hm(t) + (Date.now() - t > 864e5 ? ' ' + dm(t) : ''));
  if (!ok(s)) { set('signals-s', s.reason); set('median-s', 'нет данных'); set('cand-s', 'реестр появится с первым кандидатом'); txt('#mix-leg', s.reason); return; }
  set('signals', num(s.tracked_signals.value)); set('signals-s', `закрыто ${num(s.closed_signals.value)} · открыто ${s.open_signals.value}`); up('signals', s.tracked_signals.updated_at);
  set('days', s.showcase_days.value); set('days-s', 'дней, с ' + dmy(s.showcase_days.since)); up('days', s.showcase_days.updated_at);
  const b = s.bots_30d; set('median', fR(b.median_r)); set('median-s', `в плюсе ${b.positive} из ${b.total} ботов · ${b.n} сделок · медиана просадки ${fR(-b.median_dd_r)}`); up('median', b.updated_at);
  set('worst', fR(b.worst_r)); set('best', fR(b.best_r)); up('median2', b.updated_at);
  const g = s.registry; set('cand', g.candidates); set('cand-s', `на витрине ${g.published} · ждут ${g.waiting} · архив ${g.archived}`); up('cand', s.tracked_signals.updated_at);
  const o = s.outcomes_recent, tot = o.tp2plus + o.tp1be + o.sl + o.exp, P = [['m-tp2', o.tp2plus, 'TP2 и выше'], ['m-tp1', o.tp1be, 'TP1 → БУ'], ['m-sl', o.sl, 'Стоп'], ['m-exp', o.exp, 'Истекли']], pc = (v) => Math.round(v / tot * 100) + '%';
  const mb = $('#mix-bar'); mb.innerHTML = P.map((p) => `<i class="${p[0]}" style="flex-grow:${p[1]}"></i>`).join(''); mb.setAttribute('aria-label', P.map((p) => p[2] + ' ' + pc(p[1])).join(', '));
  html('#mix-leg', P.map((p) => `<span><i class="sw ${p[0]}"></i>${p[2]} <b>${pc(p[1])}</b></span>`).join('')); txt('#mix-upd', 'обн. ' + hm(o.updated_at));
 });
};

const REG = { LONG: 'up', SHORT: 'down', RANGE: 'range' };
SEC.showcase = () => {
 const track = $('#sc-track'); if (!track) return;
 const S = { strategy: 'all', risk: 5, dir: 'all', tf: 'all', regime: false, my: 1, sort: 'top', coin: null, d: null };
 if (STR[QS.get('strategy')]) S.strategy = QS.get('strategy');
 if (QS.get('coin')) S.coin = QS.get('coin').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
 const grp = {};
 $$('#sc-filters [data-f]').forEach((g) => { const k = g.dataset.f; grp[k] = radio(g, (v) => { S[k] = k === 'risk' ? +v : v; render(); }); });
 grp.strategy.set(S.strategy);
 radio($('#sc-risk'), (v) => { S.my = +v; render(); });
 radio($('#sc-sort'), (v) => { S.sort = v; render(); });
 on($('#sc-regime'), 'change', (e) => { S.regime = e.target.checked; render(); });
 on($('#sc-reset'), 'click', () => { Object.assign(S, { strategy: 'all', risk: 5, dir: 'all', tf: 'all', regime: false, coin: null }); ['strategy', 'dir', 'tf'].forEach((k) => grp[k].set('all')); grp.risk.set(5); $('#sc-regime').checked = false; const c = $('#sc-coin'); if (c) c.remove(); render(); });
 const regNow = () => (TREND ? TREND.tfs['4H'].trend : 'RANGE');
 const ro = (k, v, s, c) => `<div class="ro"><span class="ro-k">${k}</span><b class="ro-v ${c || ''}">${v}</b><span class="ro-s">${s}</span></div>`;
 function card(b) {
  const r = S.my, s = b.stats, coins = b.coins.join(' ') + (b.coins_extra ? ' +' + b.coins_extra : '');
  const btns = `<div class="row"><a class="btn btn-g" href="#backtest" data-bt="${b.strategy}:${b.coins[0]}">Тест на моих монетах</a><a class="btn btn-red" href="/app/?copy=${b.id}&amp;mode=demo">Копировать</a></div>`;
  const lv = riskLvl(s.p95_month_r, r, b.leverage_max), ci = wilson(s.wins, s.n), ex = b.exchange_copies, bh = b.backtest_holdout;
  let f = `<div class="inst-hd"><span class="src src-paper" title="Сигналы по ценам уровней, без реальных исполнений">Трек сигналов (бумажный)</span><span title="${esc(b.copies_rule)}">копий ${b.copies}</span></div>
<div class="sc-head"><b class="glyph">${STR[b.strategy][2]}</b><div class="sc-name"><b>${esc(b.strategy_name)} · ${esc(coins)}</b><span>${DIRN[b.dir]} · ${b.tf} · плечо до ${b.leverage_max}× · v${b.version}, параметры заморожены</span></div></div>`;
  f += `<div class="sc-res"><div><div class="sc-big ${s.r_total < 0 ? 'loss' : ''}">${fR(s.r_total)}<small>за ${b.track_days} дн.</small></div><div class="sc-pct">= ${fP(s.r_total * r)} при риске ${rTxt(r)} на сделку, без реинвеста</div></div><div class="chart spark" data-spark="${b.id}"></div></div>
<div class="sc-m">${ro('Просадка', fR(-s.max_dd_r), 'макс. ' + fP(-s.max_dd_r * r), 'loss')}${ro('Винрейт', Math.round(s.wins / s.n * 100) + '%', `Уилсон ${Math.round(ci[0])}–${Math.round(ci[1])}%`)}${ro('PF', num(s.pf, 2), 'после комиссий')}${ro('Сигналов', s.n, 'все исходы')}${ro('В сделке', '~' + Math.round(s.avg_hold_h) + ' ч', 'в среднем')}${ro('За 30 дн.', fR(s.r_30d), fP(s.r_30d * r), s.r_30d < 0 ? 'loss' : '')}</div>
<div class="sc-risk"><div class="rr"><i class="rbar" data-l="${lv}" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></i>Риск ${lv} из 5 · ${RW[lv]}</div><div class="rs">при риске ${rTxt(r)} худший месяц ≈ ${fP(-s.p95_month_r * r)} депозита (p95 Монте-Карло)${b.leverage_max >= 10 ? ', плечо от 10× — сразу 5' : ''}</div></div>
<div class="sc-src"><div><span class="src src-bt src-xs">Бэктест</span><span>отложенный, ${bh.period_days} дн.: <b>${fR(bh.r_total)}</b> · PF ${num(bh.pf, 2)} · ${bh.n} сд. · просадка ${fR(-bh.max_dd_r)}</span></div><div><span class="src src-ex src-xs">Биржа</span><span>${ex.n >= 20 ? `медиана копий <b class="${ex.median_r < 0 ? 'loss' : ''}">${fR(ex.median_r)}</b>, просадка ${fR(-ex.median_dd_r)} (n=${ex.n})${ex.liquidations ? ` · ликвидаций ${ex.liquidations}` : ''}` : `копий от 7 дней мало (n=${ex.n}), медиану не считаем`}</span></div></div>`;
  f += `<div class="sc-foot"><div class="sc-meta"><span>обн. ${hm(b.updated_at)} · оценка</span><button class="btn-g flip-btn" data-flip="1" aria-pressed="false" aria-label="Как торгует бот, подробнее">↻ Как торгует</button></div>${btns}</div>`;
  const rg = b.regime_r, rb = (k, v) => `<div>${k}<b class="${v > 0 ? 'up' : v < 0 ? 'loss' : ''}">${fR(v)}</b></div>`;
  const back = `<div class="inst-hd"><span class="inst-id">Как торгует</span><span>v${b.version} · параметры заморожены</span></div><p class="how">${esc(b.how)}</p>
<div class="tbl-wrap"><table class="tbl"><tbody>${b.params.concat([['Частичный TP', '40 / 30 / 30'], ['Мин. депозит', '≈ $' + b.min_deposit_usd]]).map((p) => `<tr><td>${esc(p[0])}</td><td>${esc(p[1])}</td></tr>`).join('')}</tbody></table></div>
<div class="regime" aria-label="Результат по режиму рынка BTC">${rb('Рост BTC', rg.up)}${rb('Падение', rg.down)}${rb('Боковик', rg.range)}</div><p class="weak"><b>Где не работает:</b> ${esc(b.weak)}</p>
<div class="sc-foot"><div class="sc-meta"><span>опубликован ${dmy(b.published_at)}</span><button class="btn-g flip-btn" data-flip="0">↺ Статистика</button></div>${btns}</div>`;
  return `<li class="sc-card" data-id="${b.id}"><div class="sc-in"><div class="sc-face sc-front inst">${f}</div><div class="sc-face sc-back inst" inert>${back}</div></div></li>`;
 }
 function render() {
  if (!S.d) return;
  const reg = regNow(), my = S.my;
  txt('#sc-regime-now', `(сейчас ${TW[reg].toLowerCase()} на 4H)`);
  const bots = S.d.bots.filter((b) => {
   if (S.strategy !== 'all' && b.strategy !== S.strategy) return false;
   if (S.dir !== 'all' && b.dir !== S.dir) return false;
   if (S.tf !== 'all' && b.tf !== S.tf) return false;
   if (S.coin && b.coins.indexOf(S.coin) < 0 && !(b.coins_extra >= 10)) return false;
   if (S.regime && !(b.regime_r[REG[reg]] > 0)) return false;
   return riskLvl(b.stats.p95_month_r, my, b.leverage_max) <= S.risk;
  });
  // «Топ» — только на окне от 90 дней, остальные после них
  const sc = (b) => (b.track_days >= 90 ? 1e6 : 0) + b.stats.r_total / Math.max(1, b.stats.max_dd_r);
  bots.sort(S.sort === 'top' ? (a, b) => sc(b) - sc(a) : S.sort === 'new' ? (a, b) => b.published_at - a.published_at : (a, b) => b.copies - a.copies);
  track.innerHTML = bots.map(card).join('');
  $('#sc-empty').hidden = bots.length > 0;
  track.scrollLeft = 0;
  bots.forEach((b) => {
   const el = $(`[data-spark="${b.id}"]`, track); if (!el) return;
   const pts = b.curve, t = ticks(Math.min(0, ...pts.map((p) => p[1])), Math.max(1, ...pts.map((p) => p[1])), 2);
   chart(el, { x0: pts[0][0], x1: pts[pts.length - 1][0], ticks: [t[0], t[t.length - 1]].concat(t[0] < 0 ? [0] : []), yMin: t[0], yMax: t[t.length - 1], series: [{ pts, cls: b.stats.r_total < 0 ? 'neg' : '' }],
    yFmt: (v) => fR(v, 0), y2Fmt: (v) => fP(v * my, 0), pad: { l: 30, r: 34, t: 6, b: 4 } });
  });
  pos();
  if (S.coin && !$('#sc-coin')) { $('#sc-filters').insertAdjacentHTML('beforeend', `<button class="chip on" id="sc-coin" aria-label="Убрать фильтр по монете">Монета: ${esc(S.coin)} ✕</button>`); on($('#sc-coin'), 'click', (e) => { S.coin = null; e.currentTarget.remove(); render(); }); }
 }
 const cw = () => { const c = $('.sc-card', track); return c ? c.offsetWidth + 16 : 360; };
 function pos() {
  const n = track.children.length;
  if (!n) { txt('#sc-pos', '0 ботов'); $('#sc-prev').disabled = $('#sc-next').disabled = true; return; }
  const w = cw(), a = Math.round(track.scrollLeft / w) + 1, z = Math.min(n, a + Math.max(1, Math.floor((track.clientWidth + 16) / w)) - 1);
  txt('#sc-pos', (z > a ? a + '–' + z : a) + ' из ' + n);
  $('#sc-prev').disabled = track.scrollLeft < 4; $('#sc-next').disabled = track.scrollLeft + track.clientWidth >= track.scrollWidth - 4;
 }
 on($('#sc-prev'), 'click', () => track.scrollBy({ left: -cw(), behavior: RM ? 'auto' : 'smooth' }));
 on($('#sc-next'), 'click', () => track.scrollBy({ left: cw(), behavior: RM ? 'auto' : 'smooth' }));
 on(track, 'scroll', () => requestAnimationFrame(pos)); on(window, 'resize', pos);
 // переворот: наведение на ↻ показывает обратную сторону, клик закрепляет; кнопки обеих сторон на одном месте, скрытая сторона inert
 const flip = (c, f, pin) => {
  c._pin = pin; c.classList.toggle('flip', f); $('.sc-front', c).inert = f; $('.sc-back', c).inert = !f;
  $('.sc-front [data-flip]', c).setAttribute('aria-pressed', f); $('.sc-back [data-flip]', c).textContent = pin || !f ? '↺ Статистика' : 'Закрепить';
 };
 on(track, 'click', (e) => {
  const fb = e.target.closest('[data-flip]');
  if (fb) {
   // после возврата кликом наведение не переворачивает карточку, пока курсор не покинет её
   const c = fb.closest('.sc-card'), f = fb.dataset.flip === '1' || !c._pin; flip(c, f, f); c._nh = !f;
   const t = $(f ? '.sc-back [data-flip]' : '.sc-front [data-flip]', c); if (t && e.detail === 0) t.focus({ preventScroll: true }); return;
  }
  const bt = e.target.closest('[data-bt]'); if (bt && SEC.btPreset) { const p = bt.dataset.bt.split(':'); SEC.btPreset(p[0], p[1]); }
 });
 if (FINE) {
  on(track, 'pointerover', (e) => { const fb = e.target.closest('.sc-front [data-flip]'), c = fb && fb.closest('.sc-card'); if (c && !c._nh && !c.classList.contains('flip')) flip(c, true, false); });
  on(track, 'pointerout', (e) => {
   const c = e.target.closest('.sc-card'); if (!c || c.contains(e.relatedTarget)) return;
   c._nh = 0; if (!c._pin && c.classList.contains('flip')) flip(c, false, false);
  });
 }
 api1('showcase').then((d) => {
  if (!ok(d)) { txt('#sc-empty b', d.reason); $('#sc-reset').hidden = true; $('#sc-empty').hidden = false; txt('#sc-pos', '0 ботов'); txt('#sc-arch-sum', 'пока пусто'); html('#arch-tbl tbody', `<tr><td colspan="6">${esc(d.reason)}</td></tr>`); return; }
  S.d = d; render();
  // реестр всех кандидатов с даты запуска (К3 #5)
  const g = d.registry, RS = (a) => (a.status === 'published' ? 'на витрине' : a.status === 'waiting' ? 'набирает: ' + (a.n < 30 ? `${a.n} из 30 сигналов, ` + (a.days < 30 ? `${a.days} из 30 дн.` : 'срок 30 дн. пройден') : `${a.days} из 30 дн., сигналов уже ${a.n}`) : 'снят ' + dmy(a.to) + ': ' + esc(a.reason));
  txt('#sc-arch-sum', `реестр ${g.candidates} · на витрине ${g.published} · ждут ${g.waiting} · архив ${g.archived}`);
  html('#arch-tbl tbody', g.items.map((a) => `<tr><td>${STR[a.strategy][0]} · ${esc(a.coins)} · ${a.tf} · v${a.v}</td><td data-l="запущен">${dmy(a.launched_at)}</td><td>${RS(a)}</td><td data-l="сигналов">${a.n}</td><td data-l="итог" class="${a.r_total < 0 ? 'loss' : 'up'}">${fR(a.r_total)}</td><td data-l="просадка" class="loss">${fR(-a.max_dd_r)}</td></tr>`).join(''));
 });
 api1('stats').then((s) => { if (ok(s)) { const b = s.bots_30d; txt('#sc-med', `Медиана витрины за 30 дн.: ${fR(b.median_r)}, в плюсе ${b.positive} из ${b.total}`); } });
 setTimeout(() => { if (S.d) txt('#sc-regime-now', `(сейчас ${TW[regNow()].toLowerCase()} на 4H)`); }, 1500);
};

SEC.story = () => {
 const steps = $$('#steps .step'), scrs = $$('#story-phone .scr'); if (!steps.length) return;
 steps.forEach((st, i) => { const b = $('.step-scr', st); if (b && scrs[i]) { const c = scrs[i].cloneNode(true); c.classList.add('on'); b.appendChild(c); } });
 const set = (i) => { steps.forEach((s, k) => s.classList.toggle('on', k === i)); scrs.forEach((s, k) => s.classList.toggle('on', k === i)); txt('#story-n', i + 1 + ' / ' + steps.length); };
 if (window.IntersectionObserver) { const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) set(steps.indexOf(e.target)); }), { rootMargin: '-45% 0px -45% 0px' }); steps.forEach((s) => io.observe(s)); }
};

const ZN = { hold: 'Отложенный период', sel: 'Данные отбора', early: 'Ранняя история', stress: 'Стресс-окно' };
const KIND = { SL: 'SL', TP1: 'TP1 → безубыток', TP2: 'TP2', TP3: 'TP3', EXP: 'истекла' };
SEC.backtest = () => {
 const box = $('#bt-chart'); if (!box) return;
 const S = { st: 'LEVELS', coin: 'BTC', per: 'hold', pess: false, fees: true }, sel = $('#bt-coin'), na = $('#bt-na');
 let last = null, seq = 0;
 const rs = radio($('#bt-strat'), (v) => { S.st = v; run(); });
 on(sel, 'change', () => { S.coin = sel.value; run(); });
 on($('#bt-period'), 'change', (e) => { S.per = e.target.value; run(); });
 on($('#bt-pess'), 'change', (e) => { S.pess = e.target.checked; run(); });
 on($('#bt-fees'), 'change', (e) => { S.fees = e.target.checked; run(); });
 on(na, 'click', (e) => { const b = e.target.closest('[data-coin],[data-per]'); if (!b) return; if (b.dataset.coin) { S.coin = sel.value = b.dataset.coin; } if (b.dataset.per) { S.per = b.dataset.per; $(`#bt-period input[value="${S.per}"]`).checked = true; } run(); });
 SEC.btPreset = (st, coin) => { S.st = st; S.coin = sel.value = coin; S.per = 'hold'; rs.set(st); $('#bt-period input[value="hold"]').checked = true; run(); };
 function run() {
  const my = ++seq, stress = /^\d/.test(S.per);
  $('#bt-opts').hidden = !stress;
  api('sandbox', { strategy: S.st, coin: S.coin, dir: 'both', period: S.per, pessimistic: S.pess ? 1 : 0, fees: S.fees ? 1 : 0 }).then((d) => { if (my === seq) { last = d; render(d); } });
 }
 const view = (stress) => { $('#bt-norm').hidden = stress; $('#bt-stress').hidden = !stress; };
 function noData(d) {
  view(false); $('#bt-leg').hidden = true;
  chart(box, { x0: 0, x1: 1, series: [], yMin: -4, yMax: 4, ticks: [-4, 0, 4] });
  const w = d.window || {}, chip = (a, v, t) => `<button class="chip" data-${a}="${v}">${t}</button>`;
  let t, p, ch = '';
  if (!ok(d)) { t = 'Данных пока нет'; p = d.reason; }
  else if (d.reason === 'no_archive') { t = 'Истории нет — результат не показываем'; p = `Свечи хранятся 365 дней, а отдельного архива для старых стресс-окон пока нет. Поэтому за «${w.label}» истории нет ни для одной монеты. Подставлять похожий период или «примерный» прогон мы не будем.`; ch = chip('per', '2025-10', 'Смотреть 10–11 октября 2025'); }
  else if (d.reason === 'expired') { t = 'Окно выпало из хранилища'; txt('#bt-period input[value="2025-10"] + span i', 'выпало из хранилища ' + dmy(w.expires_at)); p = `Свечи за «${w.label}» удалены из 365-дневного хранилища ${dmy(w.expires_at)}. Результат больше не показываем.`; }
  else { t = 'Истории нет — результат не показываем'; p = `Для ${d.coin} это окно не предрассчитано: стресс-окно считаем только для ${(d.available_for || []).join(', ')}.`; ch = (d.available_for || []).map((c) => chip('coin', c, 'Смотреть ' + c)).join(''); }
  na.innerHTML = `<b>${esc(t)}</b><p>${esc(p)}</p>${ch ? `<div class="chips">${ch}</div>` : ''}`; na.hidden = false;
  txt('#bt-src', 'Бэктест · нет данных');
  $('#bt-zones thead').innerHTML = `<tr><th>Показатель</th><th>${ZN[/^\d/.test(S.per) ? 'stress' : 'hold']}</th></tr>`;
  $('#bt-zones tbody').innerHTML = ['Сделок', 'Результат', 'Винрейт', 'PF', 'Макс. просадка'].map((k) => `<tr><td>${k}</td><td class="z-off">—</td></tr>`).join('');
  html('#bt-q', '<span class="note" style="grid-column:1/-1;align-self:center">Нет данных — не считаем.</span>');
  html('#bt-tags', `<span class="tag warn">${ok(d) ? 'история недоступна' : 'нет данных'}</span>`);
 }
 function render(d, soft) {
  if (!ok(d) || !d.available) return noData(d);
  na.hidden = true; $('#bt-leg').hidden = false;
  if (d.zones[0].id === 'stress') return stress(d);
  view(false);
  const zones = d.zones, main = zones[zones.length - 1], series = [], tp = [], tz = [], selZ = zones.find((z) => z.id === 'sel');
  let base = 0, band = null;
  zones.forEach((z) => {
   const pts = [[z.from, base]], b0 = base;
   z.trades.forEach((t) => { base += t.r; pts.push([t.t, Math.round(base * 100) / 100]); });
   pts.forEach((p) => { tp.push(p); tz.push(z.id); });
   series.push({ pts, cls: z.id === 'hold' ? (z.stats.r_total < 0 ? 'neg' : '') : z.id === 'sel' ? 'dimln' : 'early', area: zones.length === 1 ? (z.stats.r_total < 0 ? 'neg' : 'pos') : null });
   if (z.id === 'hold' && d.mc) band = [[z.from, b0, b0]].concat(z.trades.map((t, i) => [t.t, b0 + d.mc.p5[i], b0 + d.mc.p95[i]]));
  });
  const x0 = zones[0].from, x1 = main.to, xl = [];
  const nx = box.clientWidth < 480 ? 2 : 3, yy = (t) => dmy(t).slice(0, 6) + dmy(t).slice(8);
  for (let k = 0; k <= nx; k++) { const t = x0 + (x1 - x0) * k / nx; xl.push([t, S.per === 'year' ? yy(t) : dm(t)]); }
  chart(box, { x0, x1, series, band, draw: !soft, yFmt: (v) => fR(v, Math.abs(v) < 10 && v % 1 ? 1 : 0), xl, tipPts: tp,
   shades: selZ ? [{ from: selZ.from, to: selZ.to, label: 'данные отбора — завышено' }] : [], vl: selZ ? [{ x: d.selection_end, label: 'дата отбора ' + dm(d.selection_end), dy: 16 }] : [],
   tip: (i, p) => `${dm(p[0])} · ${ZN[tz[i]].toLowerCase()}<br><b>${fR(p[1])}</b> накоплено` });
  box.setAttribute('aria-label', `Бэктест ${d.coin}: ` + zones.map((z) => `${ZN[z.id]} ${fR(z.stats.r_total)}, ${z.stats.n} сделок`).join('; '));
  $$('#bt-leg span').forEach((s, k) => { s.hidden = (k === 0 && !selZ) || (k === 2 && !band) || (k === 3 && S.per !== 'year'); });
  txt('#bt-src', S.per === 'year' ? 'Бэктест · год, отбор затенён' : 'Бэктест · отложенный период');
  const order = zones.slice().sort((a, b) => ['hold', 'sel', 'early'].indexOf(a.id) - ['hold', 'sel', 'early'].indexOf(b.id));
  const row = (k, f, c) => `<tr><td>${k}</td>${order.map((z, i) => `<td class="${i ? 'z-off' : 'z-on'} ${c ? c(z) : ''}">${f(z)}</td>`).join('')}</tr>`;
  const dy = (t) => (selZ ? yy(t) : dm(t));
  txt('#bt-upd', dmy(d.updated_at) + ' ' + hm(d.updated_at));
  $('#bt-zones thead').innerHTML = `<tr><th>Показатель</th>${order.map((z) => `<th>${ZN[z.id]}<br><small>${dy(z.from)}–${dy(z.to)}</small></th>`).join('')}</tr>`;
  $('#bt-zones tbody').innerHTML = row('Сделок', (z) => z.stats.n) + row('Результат', (z) => fR(z.stats.r_total), (z) => (z.stats.r_total < 0 ? 'loss' : '')) +
   row('Винрейт (Уилсон)', (z) => { const c = wilson(z.stats.wins, z.stats.n); return `${Math.round(z.stats.wins / Math.max(1, z.stats.n) * 100)}% (${Math.round(c[0])}–${Math.round(c[1])})`; }) +
   row('PF', (z) => (z.stats.pf == null ? '—' : num(z.stats.pf, 2))) + (selZ ? row('PF × 0,6 (поправка Genome)', (z) => (z.id === 'sel' && z.stats.pf ? num(z.stats.pf * 0.6, 2) : '—')) : '') +
   row('Макс. просадка', (z) => fR(-z.stats.max_dd_r), () => 'loss') + row('p95 просадки', (z) => fR(-z.stats.p95_dd_r));
  const qs = d.quarters, m = Math.max(1, ...qs.map(Math.abs));
  const qb = $('#bt-q'); qb.innerHTML = qs.map((v, i) => { const h = Math.abs(v) / m * 40; return `<div class="qb"><i class="z"></i><i class="b ${v >= 0 ? 'p' : 'n'}" style="height:${h}%;top:${v >= 0 ? 50 - h : 50}%"></i><span class="qv ${v < 0 ? 'loss' : 'up'}" style="top:${v >= 0 ? Math.max(0, 50 - h - 14) : Math.min(78, 52 + h)}%">${fR(v)}</span><span class="ql">${i + 1}/4</span></div>`; }).join('');
  qb.setAttribute('aria-label', 'Результат по четырём периодам: ' + qs.map((v) => fR(v)).join(', '));
  const st = main.stats, tg = baseTags(st), pos = qs.filter((x) => x > 0).length, hold = zones.find((z) => z.id === 'hold').stats;
  tg.push(pos === 1 ? ['warn', 'прибыль сделал один период из четырёх'] : [pos >= 3 ? 'ok' : 'info', `в плюсе ${pos} ${plural(pos, 'период', 'периода', 'периодов')} из 4`]);
  if (selZ && selZ.stats.r_total / 80 > 1.6 * Math.max(0.01, hold.r_total / 88)) tg.push(['info', 'на данных отбора темп заметно выше — так и бывает, судите по отложенному периоду']);
  if (st.r_total < d.hold_pct) tg.push(['info', `хуже, чем держать ${d.coin} при риске 1% (${fP(d.hold_pct)})`]);
  if (d.mtf_simplified) tg.push(['info', 'MTF-фильтры в бэктесте упрощены']);
  html('#bt-tags', tagsH(tg));
 }
 function stress(d) {
  view(true);
  const w = d.window, z = d.zones[0], tr = z.trades, st = z.stats, px = d.price, n = tr.length;
  txt('#bt-src', 'Бэктест · стресс-окно');
  txt('#st-px-l', `Цена ${d.coin}, 1H · время UTC`); txt('#st-hold', `держать ${d.coin} за окно: ${fP(d.hold_pct)}`);
  const big = px[0][1] > 1000, fx = (v) => (big ? num(v / 1000, v % 1000 ? 1 : 0) + 'k' : num(v, v < 10 ? 2 : 0));
  chart($('#st-px'), { x0: px[0][0], x1: px[px.length - 1][0], series: [{ pts: px, cls: 'px' }], zeroless: 1, yt: 3, yFmt: fx, shades: [{ from: w.event - 6 * 36e5, to: w.event + 6 * 36e5, cls: 'shade-x' }],
   vl: [{ x: w.event, cls: 'hl-stop', label: 'обвал ' + utc(w.event) }], marks: tr.map((t) => { let b = px[0]; px.forEach((p) => { if (Math.abs(p[0] - t.t) < Math.abs(b[0] - t.t)) b = p; }); return { x: t.t, y: b[1], cls: t.kind === 'SL' ? (t.gap ? 'loss gapm' : 'loss') : 'green', r: 4 }; }),
   xl: [[px[0][0], utc(px[0][0]).slice(0, 5)], [w.event, utc(w.event).slice(0, 5)], [px[px.length - 1][0], utc(px[px.length - 1][0]).slice(0, 5)]], tip: (i, p) => `${utc(p[0])} · ${fx(p[1])}` });
  let e = 0; const eq = [[0, 0]].concat(tr.map((t, i) => [i + 1, Math.round((e += t.r) * 100) / 100]));
  chart($('#st-eq'), { x0: 0, x1: n, series: [{ pts: eq, cls: st.r_total < 0 ? 'neg' : '' }], band: [[0, 0, 0]].concat(d.mc.p5.map((v, i) => [i + 1, v, d.mc.p95[i]])),
   marks: tr.map((t, i) => (t.gap ? { x: i + 1, y: eq[i + 1][1], cls: 'loss gapm', r: 5 } : null)).filter(Boolean), yFmt: (v) => fR(v, v % 1 ? 1 : 0),
   xl: [[0, '0'], [n / 2, 'сделка №'], [n, String(n)]], tip: (i, p) => (i ? `сделка ${i} · ${KIND[tr[i - 1].kind]}<br><b>${fR(p[1], 2)}</b> накоплено` : 'старт') });
  $('#st-eq').setAttribute('aria-label', `Бот в стресс-окне: ${n} сделок, итог ${fR(st.r_total)}`);
  html('#st-trades', tr.map((t) => `<li><span${t.gap ? ' class="gap"' : ''}>${utc(t.t)} · ${t.side === 'L' ? 'LONG' : 'SHORT'} · ${t.kind === 'SL' && (t.g != null ? t.g : t.r) < -1.2 ? 'SL, исполнен хуже уровня' : KIND[t.kind]}</span><b class="${t.r < 0 ? 'loss' : 'up'}">${fR(t.r, 2)}</b></li>`).join(''));
  const sl = tr.filter((t) => t.kind === 'SL'), avg = sl.length ? sl.reduce((a, t) => a + t.r, 0) / sl.length : null;
  txt('#bt-upd', dmy(d.updated_at) + ' ' + hm(d.updated_at));
  html('#st-sum', `<dt>Итог окна</dt><dd class="big ${st.r_total < 0 ? 'loss' : 'up'}">${fR(st.r_total)}</dd><dt>Сделок</dt><dd>${n}</dd><dt>Макс. просадка</dt><dd class="loss">${fR(-st.max_dd_r)}</dd><dt>Средний стоп в окне</dt><dd class="loss">${avg == null ? '—' : fR(avg, 2)}</dd><dt>Обычный стоп (отложенный)</dt><dd>${d.normal_sl_r == null ? '—' : fR(d.normal_sl_r, 2)}</dd><dt>Комиссии</dt><dd>${S.fees ? 'учтены' : 'выключены'}</dd><dt>Окно выпадет из хранилища</dt><dd class="amber">${dmy(w.expires_at)}</dd>`);
  const tg = [];
  if (avg != null && d.normal_sl_r != null && avg < d.normal_sl_r - 0.1) tg.push(['warn', `стопы в окне в среднем ${fR(avg, 2)} против ${fR(d.normal_sl_r, 2)} обычно`]);
  if (n < 30) tg.push(['warn', `мало сделок: ${n} — это проверка поведения, не статистика`]);
  tg.push(['warn', 'окно выпадет из хранилища ' + dmy(w.expires_at)]);
  if (S.pess) tg.push(['info', 'пессимистичный режим: касание фитилём = стоп']);
  if (!S.fees) tg.push(['info', 'без комиссий — только для сравнения']);
  html('#bt-tags', tagsH(tg));
 }
 api1('sandbox').then((g) => {
  if (ok(g)) { sel.innerHTML = g.coins.map((c) => `<option value="${c.sym}">${c.sym}/USDT</option>`).join(''); sel.value = S.coin; txt('#bt-p-hold', g.period.days + ' дн.'); }
  run();
 });
 autoSize(box, () => { if (last) render(last, 1); });
};

SEC.compare = () => {
 const bd = $('#cmp-dca'); if (!bd) return;
 const S = { sc: 'drop', x: 12, lev: 1, gstop: true }, xr = $('#cmp-x'), DEP = 1000, FEE = 0.0006, STEPS = [1, 1.2, 1.44, 1.728, 2.0736, 2.48832], SUMW = 9.93;
 fill(xr);
 radio($('#cmp-sc'), (v) => { S.sc = v; render(); });
 radio($('#cmp-lev'), (v) => { S.lev = +v; render(); });
 on(xr, 'input', () => { S.x = +xr.value; fill(xr); render(); });
 on($('#cmp-gstop'), 'change', (e) => { S.gstop = e.target.checked; render(); });
 function path(sc, X) {
  let a = 7 + sc.length * 13; const rnd = () => { a = (a * 16807) % 2147483647; return a / 2147483647 - 0.5; }, p = [];
  for (let i = 0; i < 120; i++) {
   let v; const f = Math.min(1, i / 80);
   if (sc === 'drop') v = 100 - X * (f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2) - (i > 80 ? 0.2 * (i - 80) / 40 : 0);
   else if (sc === 'bounce') v = i < 50 ? 100 - X * Math.sin(i / 50 * Math.PI / 2) : i < 110 ? 100 - X + (X + 1.8) * Math.sin((i - 50) / 60 * Math.PI / 2) : 101.8;
   else if (sc === 'chop') v = 100 + 1.9 * Math.sin(2 * Math.PI * (i - 3) / 28);
   else v = i < 40 ? 100 + Math.sin(i / 7) * 0.4 : i === 40 ? 96.6 : i < 44 ? 91 + (i - 41) * 0.2 : 91.6 + (i - 44) / 76 * 6.6;
   p.push(i ? v + rnd() * (sc === 'gap' && i >= 40 && i < 44 ? 0 : 0.5) : 100);
  }
  return p;
 }
 function dca(p) {
  const base = 600 * S.lev / SUMW; let cy = null, real = 0, tps = 0, maxM = 0, worst = 0, stop = false, liq = null, fills = 0, avgs = [];
  const mk = [], open = (i) => { cy = { e: p[i], n: 0, q: 0, c: 0, ia: i }; add(i); };
  const add = (i) => { const px = cy.e * (1 - 0.03 * cy.n), u = base * STEPS[cy.n]; if (cy.q) avgs.push({ y: cy.c / cy.q, x0: cy.ia, x1: i }); cy.q += u / px; cy.c += u; cy.n++; cy.ia = i; real -= u * FEE; mk.push({ x: i, y: px - 100, cls: 'amber', r: 3.5 }); };
  open(0);
  for (let i = 1; i < p.length; i++) {
   if (stop) continue;
   if (!cy) { open(i); continue; }
   while (cy.n < 6 && p[i] <= cy.e * (1 - 0.03 * cy.n)) add(i);
   const avg = cy.c / cy.q, sl = cy.e * 0.85 * 0.95;
   if (p[i] >= avg * 1.015) { const x = avg * 1.015; real += cy.q * x - cy.c - cy.q * x * FEE; tps++; avgs.push({ y: avg, x0: cy.ia, x1: i }); mk.push({ x: i, y: x - 100, cls: 'green', r: 4.5 }); fills = cy.n; cy = null; continue; }
   if (S.gstop && cy.n === 6 && p[i] <= sl) { const x = Math.min(p[i], sl) * 0.999; real += cy.q * x - cy.c - cy.q * x * FEE; avgs.push({ y: avg, x0: cy.ia, x1: i }); mk.push({ x: i, y: x - 100, cls: 'x', r: 5 }); fills = 6; stop = true; cy = null; continue; }
   maxM = Math.max(maxM, cy.c / S.lev / DEP * 100); worst = Math.min(worst, real + cy.q * p[i] - cy.c);
  }
  let un = 0;
  if (cy) { un = cy.q * p[p.length - 1] - cy.c; fills = cy.n; avgs.push({ y: cy.c / cy.q, x0: cy.ia, x1: p.length - 1 }); if (S.lev > 1) { const lp = (cy.c - DEP - real) / (cy.q * 0.995); liq = lp > 0 ? (1 - lp / cy.e) * 100 : null; } }
  let q = 0; STEPS.forEach((w, k) => { q += base * w / (100 * (1 - 0.03 * k)); });
  const full = (q * 80.75 * 0.999 - base * SUMW) - base * SUMW * FEE * 2;
  return { fin: (real + un) / DEP * 100, open: !!cy, tps, stop, maxM, worst: Math.min(worst, real + un) / DEP * 100, mk, avgs, fills, liq, full: full / DEP * 100, liqFull: S.lev > 1 ? (1 - (base * SUMW - DEP) / (q * 0.995) / 100) * 100 : null };
 }
 function chm(p) {
  const R = 10, n0 = R / 0.02, ent = S.sc === 'chop' ? p.map((v, i) => (i > 1 && i < p.length - 6 && p[i - 1] < 100.9 && v >= 100.9 ? i : -1)).filter((i) => i > 0) : [2];
  let res = 0, pos = null, worst = 0; const mk = [], tr = [], segs = [];
  for (let j = 0; j < p.length; j++) {
   if (!pos) { if (ent.indexOf(j) >= 0) { const e = p[j]; pos = { e, sl: e * 0.98, tp: [e * 1.02, e * 1.04, e * 1.06], left: 1, be: false, r: -n0 * FEE / R, i0: j }; mk.push({ x: j, y: e - 100, cls: 'white', r: 4.5 }); } continue; }
   const x = p[j];
   if (x <= pos.sl) {
    const fx = Math.min(x, pos.sl) * 0.999; pos.r += pos.left * n0 * (fx - pos.e) / pos.e / R - pos.left * n0 * FEE / R;
    res += pos.r; tr.push(pos.r); segs.push({ y: pos.sl - 100, x0: pos.i0, x1: j, cls: pos.be ? 'hl-dca' : 'hl-stop' }); mk.push({ x: j, y: fx - 100, cls: pos.be ? 'be' : 'x', r: 5 }); pos = null; continue;
   }
   for (let k = 0; k < 3 && pos; k++) {
    if (pos.tp[k] && x >= pos.tp[k]) {
     const part = k ? 0.3 : 0.4; pos.r += part * n0 * (pos.tp[k] - pos.e) / pos.e / R - part * n0 * FEE / R; pos.left -= part; mk.push({ x: j, y: pos.tp[k] - 100, cls: 'green', r: 4 }); pos.tp[k] = 0;
     if (!k) { segs.push({ y: pos.sl - 100, x0: pos.i0, x1: j, cls: 'hl-stop' }); pos.sl = pos.e; pos.be = true; pos.i0 = j; }
     if (pos.left < 0.01) { res += pos.r; tr.push(pos.r); pos = null; }
    }
   }
   if (pos) worst = Math.min(worst, res + pos.r + pos.left * n0 * (x - pos.e) / pos.e / R);
  }
  const un = pos ? pos.r + pos.left * n0 * (p[p.length - 1] - pos.e) / pos.e / R : 0;
  if (pos) segs.push({ y: pos.sl - 100, x0: pos.i0, x1: p.length - 1, cls: pos.be ? 'hl-dca' : 'hl-stop' });
  return { fin: res + un, open: !!pos, tr, mk, segs, worst: Math.min(worst, res), slip: tr.length ? Math.min(...tr) : 0 };
 }
 function render() {
  const fixed = S.sc === 'chop' || S.sc === 'gap';
  $('#cmp-x-ctl').classList.toggle('off', fixed); xr.disabled = fixed; txt('#cmp-x-out', fixed ? 'путь фиксирован' : S.x + '%');
  const p = path(S.sc, S.x), a = dca(p), b = chm(p), rel = p.map((v, i) => [i, v - 100]);
  const lo = Math.min(-3.5, ...p.map((v) => v - 101.5)), hi = Math.max(3.5, ...p.map((v) => v - 98.5)), tk = ticks(lo, hi, 4), cf = { x0: 0, x1: p.length - 1, yMin: tk[0], yMax: tk[tk.length - 1], ticks: tk, yFmt: (v) => fP(v, 0), xl: [[0, 'вход'], [119, 'время →']] };
  const dl = [];
  for (let k = 1; k < 6; k++) { const y = -3 * k; if (y >= tk[0]) dl.push({ y, cls: 'hl-dca' }); }
  if (S.gstop && -19.25 >= tk[0]) dl.push({ y: -19.25, cls: 'hl-stop' });
  chart(bd, Object.assign({ series: [{ pts: rel, cls: 'px' }], hl: dl.concat(a.avgs.map((s) => ({ y: s.y - 100, x0: s.x0, x1: s.x1, cls: 'hl-avg' }))), marks: a.mk }, cf));
  chart($('#cmp-chm'), Object.assign({ series: [{ pts: rel, cls: 'px' }], hl: b.segs.map((s) => ({ y: s.y, x0: s.x0, x1: s.x1, cls: s.cls })), marks: b.mk }, cf));
  const kv = (k, v, c) => `<dt>${k}</dt><dd class="${c || ''}">${v}</dd>`, cl = (v) => (v > 0.04 ? 'up' : v < -0.04 ? 'loss' : '');
  html('#cmp-dca-kv', kv('Итог, % депозита', fP(a.fin), 'big ' + cl(a.fin)) + kv('Состояние', a.stop ? 'закрыта по стопу сетки' : a.open ? `в позиции, ордеров ${a.fills} из 6` : 'закрыта тейком') + kv('Циклов с тейком', a.tps) +
   kv('Макс. маржа в сделке', Math.round(a.maxM) + '% депозита') + kv('Худшая точка', fP(a.worst), 'loss') + kv('Вся сетка + стоп', S.gstop ? fP(a.full) + ' депозита' : 'не ограничен', 'loss') +
   kv('Ликвидация', S.lev > 1 ? `при ${MI}${num(a.liqFull, 0)}% от первого входа` : 'нет: без плеча'));
  html('#cmp-chm-kv', kv('Итог, % депозита', fP(b.fin), 'big ' + cl(b.fin)) + kv('В R', fR(b.fin, 2) + (b.tr.length ? ` · сделок ${b.tr.length}` : '')) + kv('Состояние', b.open ? 'в позиции' : b.tr.length ? 'закрыто' : 'нет входа') +
   kv('Позиция', '50% депозита, без плеча') + kv('Худшая точка', fP(b.worst), 'loss') + kv('Стоп исполнен', S.sc === 'gap' ? fR(b.slip, 2) + ' вместо −1R' : '≈ −1R + комиссии', S.sc === 'gap' ? 'loss' : ''));
  bd.setAttribute('aria-label', 'DCA-бот: итог ' + fP(a.fin) + ' депозита'); $('#cmp-chm').setAttribute('aria-label', 'Бот CHM: итог ' + fP(b.fin) + ' депозита');
  const dW = a.fin > b.fin + 0.1, cW = b.fin > a.fin + 0.1, lev = S.lev > 1 ? ' С плечом 3× всё это втрое больше в процентах депозита.' : '';
  let w = dW ? 'Здесь выиграла сетка' : cW ? 'Выиграл стоп' : 'Ничья', t;
  if (S.sc === 'drop') t = S.x < 3 ? 'Цена почти не упала: стоп CHM не задет, сетка открыла один-два ордера.' : a.stop ? `Сетка исполнила все 6 ордеров и закрылась по своему стопу: <b>${fP(a.fin)}</b> депозита за одну сделку. У CHM один стоп: <b>${fP(b.fin)}</b>.${lev}` : `Сетка держит позицию на ${Math.round(a.maxM)}% депозита и ждёт отскока, сейчас у неё <b>${fP(a.fin)}</b>. CHM вышел по стопу: <b>${fP(b.fin)}</b>.${S.gstop ? '' : ' Без стопа убыток сетки ничем не ограничен.'}${lev}`;
  else if (S.sc === 'bounce') t = dW ? `Средняя цена подтянулась, отскок закрыл сетку в плюс: <b>${fP(a.fin)}</b>. CHM поймал стоп <b>${fP(b.fin)}</b> и без нового сигнала на отскоке не входил. Это честная цена стопа: мелкие убытки случаются чаще.` : 'Отскок слишком слабый, чтобы сетка вышла в плюс.';
  else if (S.sc === 'chop') t = `В пиле бот CHM получил серию стопов: ${b.tr.length} ${plural(b.tr.length, 'вход', 'входа', 'входов')}, итог <b>${fP(b.fin)}</b>. Сетка закрыла ${a.tps} ${plural(a.tps, 'цикл', 'цикла', 'циклов')} с тейком: <b>${fP(a.fin)}</b>. Серии стопов — главный риск торговли со стопом, поэтому на витрине есть худшая серия, а в челлендже пауза после серии стопов.`;
  else t = `Гэп пролетел через стоп CHM: он исполнился ниже уровня, <b>${fR(b.slip, 2)}</b> вместо −1R. Ордера сетки собрали падение, отскок вывел её в <b>${fP(a.fin)}</b>. Стоп ограничивает убыток, но цену исполнения не гарантирует.`;
  html('#cmp-verdict', `<b class="vw ${dW ? 'grid' : cW ? 'ok' : 'none'}">${w}</b><span>${t}</span>`);
 }
 render(); autoSize(bd, render);
};

SEC.genome = () => {
 const box = $('#gn-chart'); if (!box) return;
 const S = { st: 'LEVELS', g: 0, t: 0, d: null }, G = () => S.d.strategies.find((x) => x.id === S.st);
 radio($('#gn-strat'), (v) => { S.st = v; side(); play(); });
 on($('#gn-replay'), 'click', () => play());
 on($('#gn-step'), 'click', () => { clearInterval(S.t); if (S.d && S.g < G().generations - 1) { S.g++; draw(); } });
 function draw() {
  const I = G(), N = I.generations, H = I.history, dots = [], bp = [];
  let best = -9, bad = 0;
  for (let k = 0; k <= S.g; k++) { H[k].forEach((v, i) => { dots.push({ x: k + 1 + ((i * 37) % 10 / 10 - 0.45) * 0.62, y: Math.max(-0.58, v), cls: v < 0 ? 'loss' : 'violet', r: k === S.g ? 4 : 2.6, o: k === S.g ? 0 : 0.55 }); if (v < 0) bad++; best = Math.max(best, v); }); bp.push([k + 1, best]); }
  chart(box, { x0: 0.4, x1: N + 0.6, yMin: -0.6, yMax: 0.8, ticks: [-0.4, -0.2, 0, 0.2, 0.4, 0.6, 0.8], yFmt: (v) => (v < 0 ? MI : '') + num(v, 1), xl: [[1, 'поколение 1'], [N / 2, String(N / 2)], [N, String(N)]], dots, series: [{ pts: bp, cls: 'wt' }], marks: [{ x: S.g + 1, y: best, cls: 'white', r: 5 }] });
  box.setAttribute('aria-label', `Эволюция ${STR[S.st][0]}: поколение ${S.g + 1} из ${N}, лучший фитнес ${num(best, 2)}, кандидатов с фитнесом ниже нуля ${bad}`);
  odo($('#gn-gen'), String(S.g + 1)); odo($('#gn-best'), num(best, 2)); txt('#gn-med', 'медиана поколения ' + num(median(H[S.g]), 2)); odo($('#gn-bad'), String(bad));
  const f = S.g / (N - 1); let a = 11; const rnd = () => { a = (a * 48271 + S.st.length) % 2147483647; return a / 2147483647; };
  let gh = '';
  for (let i = 0; i < I.genes; i++) { const fin = 0.2 + rnd() * 0.75, wob = (rnd() - 0.5) * 0.9 * (1 - f) * Math.abs(Math.sin(S.g * 1.7 + i)); gh += `<i class="${S.g >= N - 1 - (i % 6) ? 'lock' : ''}" style="height:${Math.round(Math.min(1, Math.max(0.08, fin + wob)) * 100)}%"></i>`; }
  html('#genes', gh);
  txt('#gn-state', S.g >= N - 1 ? 'готово · кандидат → проверка на отложенном периоде' : 'эволюция · поколение ' + (S.g + 1));
 }
 function side() {
  const I = G(), b = I.best, h = I.holdout, kv = (k, v, c) => `<dt>${k}</dt><dd class="${c || ''}">${v}</dd>`;
  txt('#gn-when', `${dmy(I.last_run)} ${hm(I.last_run)} · ${I.generations} × ${I.population} · ${I.genes} генов`);
  html('#gn-sel', kv('Фитнес', num(b.fitness, 2)) + kv('WR', Math.round(b.wr * 100) + '%') + kv('PF', num(b.pf, 2)) + kv('Сделок', b.n) + kv('Окно отбора', b.selection_days + ' дн.'));
  html('#gn-hold', kv('WR', Math.round(h.wr * 100) + '%') + kv('PF', num(h.pf, 2), h.pf < 1 ? 'loss' : '') + kv('Сделок', h.n + (h.n < 30 ? ' · мало' : ''), h.n < 30 ? 'amber' : '') + kv('Итог', fR(h.sum_r), h.sum_r < 0 ? 'loss' : 'up') + kv('Макс. просадка', fR(-h.max_dd_r), 'loss') + kv('Период', h.days + ' дн.'));
  html('#gn-live', `На данных отбора результат всегда лучше, чем будет. Genome сам делает поправку для реальной торговли: PF × ${num(S.d.live_pf_factor, 1)} = <b>${num(b.pf * S.d.live_pf_factor, 2)}</b>. Применять параметры предлагаем только после проверки на отложенном периоде и только с вашим подтверждением.`);
 }
 function play() {
  clearInterval(S.t); if (!S.d) return;
  const N = G().generations;
  if (RM) { S.g = N - 1; draw(); return; }
  S.g = 0; draw();
  S.t = setInterval(() => { if (D.hidden) return; S.g++; draw(); if (S.g >= N - 1) clearInterval(S.t); }, 260);
 }
 api1('genome').then((d) => {
  if (!ok(d)) { ph(box, d.reason); txt('#gn-state', 'нет данных'); html('#gn-sel', '<dt>нет данных</dt>'); html('#gn-hold', '<dt>нет данных</dt>'); html('#gn-table tbody', `<tr><td colspan="4">${esc(d.reason)}</td></tr>`); return; }
  S.d = d; side();
  S.g = 0; draw();
  vis(box, play, '-15% 0px -15% 0px');
  const HC = { passed: 'пройдена', failed: 'не пройдена', pending: 'идёт' };
  txt('#gn-upd', 'обн. ' + dmy(d.updated_at));
  html('#gn-table tbody', d.strategies.map((s) => `<tr><td>${STR[s.id][0]} · ${s.tf}</td><td>${dm(s.last_run)} ${hm(s.last_run)}</td><td>${num(s.best_fitness, 2)} <small>(было ${num(s.prev_fitness, 2)})</small></td><td><span class="hc ${s.holdout_check}">${HC[s.holdout_check]}</span></td></tr>`).join('') + (d.auto_apply_bots ? '' : '<tr><td colspan="4">Для ботов автоприменение выключено: новые параметры приходят черновиком.</td></tr>'));
 });
 autoSize(box, () => { if (S.d) draw(); });
};

SEC.planner = () => {
 const dep = $('#pl-dep'); if (!dep) return;
 const S = { term: 30, lev: 3, bots: [] }, goal = $('#pl-goal'), risk = $('#pl-risk'), bot = $('#pl-bot'), trs = $('#pl-trades'), lim = $('#pl-limit');
 fill(risk);
 on($('#pl-form'), 'submit', (e) => e.preventDefault());
 radio($('#pl-term'), (v) => { S.term = +v; render(); }); radio($('#pl-lev'), (v) => { S.lev = +v; render(); });
 [dep, goal, risk, bot, trs, lim].forEach((el) => { on(el, 'input', render); on(el, 'change', render); });
 function render() {
  const r = +risk.value, d = Math.max(0, parseFloat(dep.value) || 0), gv = goal.value.trim(), g = gv === '' ? null : Math.max(0, parseFloat(gv.replace(',', '.')) || 0);
  fill(risk); txt('#pl-risk-out', rTxt(r));
  const R1 = (d || 1000) * r / 100, b = S.bots[+bot.value], pace = b ? b.pace : null, term = S.term;
  let w, wc, sub;
  odo($('#pl-o-bot'), pace == null ? '—' : fR(pace, 2)); txt('#pl-o-bot-s', b ? `в день · ${b.lbl} · просадка ${fR(-b.dd)}` : 'нет бота с треком');
  if (!g) {
   w = 'Цель не задана'; wc = 'none';
   sub = `Мы не подставляем цель за вас. Введите свою — посчитаем, сколько это R в день, и сверим с треком${b ? ` (${fR(pace, 2)} в день)` : ''}.`;
   txt('#pl-o-goal', '—'); txt('#pl-o-goal-s', 'введите цель'); txt('#pl-o-day', '—'); txt('#pl-o-day-s', term + ' дн.');
  } else {
   const profit = (d || 1000) * g / 100, need = profit / R1, day = need / term;
   odo($('#pl-o-goal'), num(need, need < 10 ? 1 : 0) + 'R'); txt('#pl-o-goal-s', `${usd(profit)} = ${fP(g, g % 1 ? 1 : 0)} депозита`);
   odo($('#pl-o-day'), fR(day, 2)); txt('#pl-o-day-s', `≈ ${usd(day * R1, 2)} в день · ${term} дн.`);
   if (!b) { w = 'Нет данных'; wc = 'none'; sub = 'Без трека бота вердикт не выносим: сравнить план не с чем.'; }
   else if (pace <= 0) { w = 'Трек в минусе'; wc = 'bad'; sub = `На треке ${fR(pace, 2)} в день. План на прибыль по нему нереалистичен.`; }
   else {
    const k = day / pace; w = k <= 1 ? 'Реально' : k <= 1.6 ? 'Напряжённо' : 'Нереально'; wc = k <= 1 ? 'ok' : k <= 1.6 ? 'tight' : 'bad';
    sub = `Нужно ${fR(day, 2)} в день, на треке было ${fR(pace, 2)}. В этом темпе цель займёт ≈ ${Math.ceil(need / pace)} дн., если трек повторится, а это не гарантировано.${k > 1 ? ' Уменьшите цель или увеличьте срок, а не риск.' : ''}`;
   }
  }
  html('#pl-verdict', `<b class="vw ${wc}">${w}</b><span>${esc(sub)}</span>`);
  const W = [], five = 5 * r, notional = R1 / 0.02, margin = notional / S.lev, l = parseFloat(lim.value);
  W.push([r >= 3 ? 'b' : '', `Пять стопов подряд = ${fP(-five, five % 1 ? 1 : 0)} депозита${r >= 3 ? ': риск от 3% — это уже ставка, а не дисциплина' : ''}.${b ? ` ${b.ws} — ${b.streak} стопов подряд.` : ''}`]);
  if (d && margin > d) W.push(['b', `Позиция по плану не влезает в депозит: при стопе 2% и плече ${S.lev}× нужна маржа ${usd(margin)}.`]);
  else if (d && margin * 3 > d) W.push(['w', `Три сделки одновременно займут ${Math.round(margin * 3 / d * 100)}% депозита в марже.`]);
  if (100 / S.lev <= 4) W.push(['b', `Ликвидация ближе двух стопов: при плече ${S.lev}× она примерно в ${num(100 / S.lev, 1)}% от входа, а типичный стоп — 2%.`]);
  if (l > 0 && l < 1) W.push(['w', 'Дневной лимит убытка меньше одного стопа.']);
  W.push(['', `Дисциплина: не больше ${parseInt(trs.value, 10) || 0} сделок и ${fR(-(l || 0), 1)} (${usd(-(l || 0) * R1)}) убытка в день, дальше новые входы закрыты до завтра.`]);
  html('#pl-warns', W.map((x) => `<li class="${x[0]}">${esc(x[1])}</li>`).join(''));
  txt('#pl-rexp', `1R — убыток одной сделки по стопу. При депозите ${usd(d || 1000)}${d ? '' : ' (пример)'} и риске ${rTxt(r)} это ${usd(R1, R1 < 10 ? 2 : 0)}. Каждый 1% депозита при этом риске — ${num(1 / r, (1 / r) % 1 ? 2 : 0)}R. Цель в R не зависит от депозита: она показывает, сколько стопов должна перекрыть прибыль.`);
 }
 // по умолчанию сверяем с медианой витрины, а не с лучшим ботом
 api1('showcase').then((d) => {
  const bs = ok(d) ? d.bots.filter((b) => b.status === 'published') : [], M = (f) => median(bs.map(f));
  S.bots = bs.map((b) => ({ n: `${b.strategy_name} · ${b.coins.join(' ')}${b.coins_extra ? ' +' + b.coins_extra : ''} · ${b.tf}`, pace: b.stats.r_total / b.track_days, lbl: b.track_days + ' дн. трека, бумажный', dd: b.stats.max_dd_r, streak: b.stats.max_loss_streak, ws: 'Худшая серия этого бота' }));
  if (bs.length) S.bots.unshift({ n: `Медиана витрины, ${bs.length} ботов`, pace: M((b) => b.stats.r_total / b.track_days), lbl: 'медиана витрины, бумажный трек', dd: M((b) => b.stats.max_dd_r), streak: Math.round(M((b) => b.stats.max_loss_streak)), ws: 'Медиана худших серий витрины' });
  bot.innerHTML = S.bots.length ? S.bots.map((b, i) => `<option value="${i}">${esc(b.n)}</option>`).join('') : '<option value="">нет ботов с треком</option>';
  render();
 });
 render();
};

SEC.pricing = () => {
 const inp = $('#pr-profit'); if (!inp) return;
 // перенос по месяцам с нуля, пример — по кнопке
 const rng = $('#pr-range'), carry = $('#pr-carry'), CAP = 69, M = [0, 0, 0, 0];
 on($('[data-lg-ex]'), 'click', () => { M.splice(0, 4, -120, 80, 400, -60); render(); });
 fill(rng);
 on(inp, 'input', render); on(carry, 'input', render);
 on(rng, 'input', () => { inp.value = rng.value; render(); });
 $$('[data-step]').forEach((b) => on(b, 'click', () => { inp.value = (parseFloat(inp.value) || 0) + +b.dataset.step; render(); }));
 function render() {
  const P = parseFloat(inp.value) || 0, C = Math.max(0, parseFloat(carry.value) || 0), base = P - C;
  if (D.activeElement !== rng) rng.value = Math.max(-500, Math.min(1500, P));
  fill(rng);
  let fee = 0, next = C, say;
  if (P < 0) { next = C - P; say = `Месяц в минусе: начислено <b>$0</b>, убыток ${usd(-P)} переносится на следующий месяц.`; }
  else if (P === 0) say = 'Прибыли нет — за месяц <b>$0</b>. Подписка в этом месяце стоила бы $69.';
  else if (base <= 0) { next = -base; say = `Прибыль ушла на покрытие прошлого убытка: начислено <b>$0</b>, переносится ещё ${usd(next)}.`; }
  else { fee = Math.min(0.2 * base, CAP); next = 0; say = fee >= CAP ? 'Достигнут потолок: <b>$69</b>, как подписка. Больше не берём, сколько бы ни заработали боты.' : `За результат выходит <b>${usd(fee, 2)}</b> — на ${usd(CAP - fee, 2)} дешевле подписки.`; }
  txt('#pr-base', usd(Math.max(0, base))); odo($('#pr-res'), usd(fee, fee % 1 ? 2 : 0)); odo($('#pr-next'), usd(next)); html('#pr-say', say);
  let c = 0, tot = 0;
  html('#lg-body', M.map((v, i) => {
   const before = c; let b = 0, f = 0;
   if (v < 0) c += -v; else { b = Math.max(0, v - c); c = Math.max(0, c - v); f = Math.min(CAP, 0.2 * b); }
   tot += f;
   return `<tr><td>${i + 1}</td><td><span class="st"><button data-m="${i}" data-d="-50" aria-label="Меньше на $50, месяц ${i + 1}">−</button><b class="${v < 0 ? 'loss' : v > 0 ? 'up' : ''}">${v > 0 ? '+' : ''}${usd(v)}</b><button data-m="${i}" data-d="50" aria-label="Больше на $50, месяц ${i + 1}">+</button></span></td><td>${before ? usd(-before) : '—'}</td><td>${usd(b)}</td><td>${usd(f, f % 1 ? 2 : 0)}${f >= CAP ? ' <small>потолок</small>' : ''}</td></tr>`;
  }).join(''));
  html('#lg-foot', `<tr><td>Итого</td><td></td><td>${c ? 'перенос ' + usd(-c) : ''}</td><td></td><td><b>${usd(tot, tot % 1 ? 2 : 0)}</b><small>Pro за ${M.length} мес.: $${CAP * M.length}</small></td></tr>`);
  txt('#lg-sum', `за ${M.length} мес.: ${usd(tot, tot % 1 ? 2 : 0)} против $${CAP * M.length} подписки`);
 }
 on($('#lg-body'), 'click', (e) => { const b = e.target.closest('[data-m]'); if (!b) return; M[+b.dataset.m] += +b.dataset.d; render(); const n = $(`[data-m="${b.dataset.m}"][data-d="${b.dataset.d}"]`); if (n) n.focus(); });
 render();
};

SEC.key = () => {
 const box = $('#key'); if (!box) return;
 const K = {}, v = $('#key-v');
 const upd = () => {
  $$('input[data-k]', box).forEach((i) => { K[i.dataset.k] = i.checked; });
  const r = K.withdraw ? ['b', 'Такой ключ не примем', 'У ключа есть право вывода. Создайте новый ключ только с правами «Чтение» и «Торговля».']
   : !K.trade ? ['w', 'Бот не сможет торговать', 'Без права торговли останутся только сигналы и демо.']
    : !K.read ? ['w', 'Включите чтение', 'Без него бот не увидит баланс и позиции и не сверит сделки.']
     : !K.ip ? ['w', 'Подходит, но привяжите IP', 'С IP-whitelist ключом не сможет воспользоваться никто, кроме нашего сервера.']
      : ['', 'Ключ подходит', 'Торговля без вывода, IP привязан. Деньги остаются на вашей бирже.'];
  v.className = 'key-v ' + r[0]; v.innerHTML = `<b>${r[1]}</b>${r[2]}`;
 };
 on(box, 'change', upd); upd();
};

SEC.app = () => {
 const tabs = $$('#app-tabs [role="tab"]'); if (!tabs.length) return;
 const set = (b) => { tabs.forEach((x) => { const o = x === b; x.classList.toggle('on', o); x.setAttribute('aria-selected', o); x.tabIndex = o ? 0 : -1; }); $$('#app-dev .app-scr').forEach((s) => s.classList.toggle('on', s.dataset.app === b.dataset.app)); };
 tabs.forEach((b, i) => { b.tabIndex = i ? -1 : 0; on(b, 'click', () => set(b)); on(b, 'keydown', (e) => { const f = { ArrowRight: 1, ArrowLeft: -1 }[e.key]; if (!f) return; const n = tabs[(i + f + tabs.length) % tabs.length]; n.focus(); set(n); }); });
 const qr = $('[data-qr]');
 if (qr) { const [n, hex] = qr.dataset.qr.split(':'), bit = (i) => (parseInt(hex[i >> 2], 16) >> (3 - (i & 3))) & 1; let d = ''; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (bit(y * n + x)) d += `M${x} ${y}h1v1h-1z`; $('#qr-path').setAttribute('d', d); }
};
SEC.faq = () => {
 const q = $('#faq-q'); if (!q) return;
 const it = $$('#faq-list details'), norm = (s) => s.toLowerCase().replace(/ё/g, 'е');
 it.forEach((d) => { d._t = norm(d.textContent); });
 on(q, 'input', () => { const v = norm(q.value.trim()); let n = 0; it.forEach((d) => { const m = !v || d._t.indexOf(v) >= 0; d.hidden = !m; if (m) n++; d.open = !!v && m && n <= 2; }); $('#faq-empty').hidden = n > 0; });
};
SEC.misc = () => {
 on(D, 'click', (e) => {
  const o = e.target.closest('[data-dlg]');
  if (o) { const d = D.getElementById(o.dataset.dlg); if (d && d.showModal) d.showModal(); return; }
  const c = e.target.closest('[data-close]'); if (c) { c.closest('dialog').close(); return; }
  if (e.target.tagName === 'DIALOG') e.target.close();
  const s = e.target.closest('[data-support]');
  if (s) {
   if (window.ChmSupport) return window.ChmSupport.open();
   const el = D.createElement('script'); el.src = '/support-widget.js?v=6'; el.onload = () => window.ChmSupport && window.ChmSupport.open(); el.onerror = () => { location.href = 'https://t.me/CHM_signalS_bot'; }; D.body.appendChild(el);
  }
 });
 D.body.insertAdjacentHTML('beforeend', '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><linearGradient id="ga-pos" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3df2a0" stop-opacity=".2"/><stop offset="1" stop-color="#3df2a0" stop-opacity="0"/></linearGradient><linearGradient id="ga-neg" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#ff7a8f" stop-opacity=".18"/><stop offset="1" stop-color="#ff7a8f" stop-opacity="0"/></linearGradient><pattern id="hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="rgba(255,122,143,.08)"/><line x1="0" y1="0" x2="0" y2="5" stroke="rgba(255,122,143,.55)" stroke-width="1.4"/></pattern></defs></svg>');
 if (RM || !FINE) return;
 let cur = null;
 on(D, 'pointermove', (e) => {
  const p = e.target.closest && e.target.closest('.inst');
  if (cur && cur !== p) cur.classList.remove('lit');
  cur = p; if (!p) return;
  const r = p.getBoundingClientRect(); p.style.setProperty('--mx', e.clientX - r.left + 'px'); p.style.setProperty('--my', e.clientY - r.top + 'px'); p.classList.add('lit');
 });
};

Object.keys(SEC).forEach((k) => { try { SEC[k](); } catch (e) { console.error('[landing] ' + k, e); } });
})();
