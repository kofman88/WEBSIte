/* Секции 0–3: лента тренда BTC, песочница hero, живая лента и счётчики, витрина ботов. */
(function () {
  'use strict';
  const C = window.CHML, L = C.lib, api = C.api, $ = L.$, $$ = L.$$;
  const SEC = C.sec = C.sec || {};
  const TF_NAME = { '15m': '15M', '1H': '1H', '4H': '4H', '1D': 'ДЕНЬ', '1W': 'НЕДЕЛЯ', '1M': 'МЕСЯЦ' };
  const TREND_W = { LONG: 'ЛОНГ', SHORT: 'ШОРТ', RANGE: 'БОКОВИК' };
  const DIR_NAME = { both: 'Long + Short', long: 'Long', short: 'Short' };
  const STRAT = { LEVELS: { name: 'Уровни', tf: '1H' }, SMC: { name: 'SMC', tf: '15m' }, VOLUME: { name: 'Объём + MA', tf: '4H' } };
  SEC.STRAT = STRAT;

  // ---- 0. Лента тренда BTC (6 ТФ) — «сердцебиение» шапки ----
  SEC.ticker = function () {
    const row = $('#tick-row'), track = row.parentNode, upd = $('#tick-upd'), dot = $('.hb-dot');
    let marq = false, last = null;
    function cells(t) {
      let h = '';
      ['15m', '1H', '4H', '1D', '1W', '1M'].forEach((tf) => {
        const s = t.tfs[tf] || {};
        const c = s.trend === 'LONG' ? 'long' : s.trend === 'SHORT' ? 'short' : 'flat';
        const ar = s.trend === 'LONG' ? '▲' : s.trend === 'SHORT' ? '▼' : '↔';
        h += '<span class="tc">' +
          '<span class="tf">' + TF_NAME[tf] + '</span><span class="dir ' + c + '">' + ar + ' ' + (TREND_W[s.trend] || '—') + '</span>' +
          '<span class="str dir ' + c + '"><b style="width:' + s.strength + '%"></b></span><span class="val">' + s.strength + '%</span></span>';
      });
      ['BTC', 'ETH'].forEach((k) => {
        const v = t.change_24h[k];
        h += '<span class="tc"><span class="tf">' + k + ' 24Ч</span><span class="val ' + (v >= 0 ? 'up' : 'loss') + '">' + L.pct(v, 2) + '</span></span>';
      });
      return h;
    }
    function fit() {
      // на узком экране — бегущая строка (дубль содержимого), иначе статично
      const one = last ? cells(last) : '';
      row.classList.remove('marq');
      row.innerHTML = one;
      marq = !L.reduced && row.scrollWidth > track.clientWidth + 4;
      if (marq) { row.innerHTML = one + one; row.classList.add('marq'); }
    }
    function render(t) {
      const first = !last;
      last = t;
      if (first) fit();
      else {
        // обновляем значения на месте, чтобы не сбивать анимацию строки
        const tmp = document.createElement('div');
        tmp.innerHTML = cells(t);
        const fresh = $$('.tc', tmp), cur = $$('.tc', row);
        cur.forEach((el, i) => { const f = fresh[i % fresh.length]; if (f && el.innerHTML !== f.innerHTML) el.innerHTML = f.innerHTML; });
      }
      upd.textContent = 'обн. ' + L.timeS(t.updated_at);
      dot.classList.remove('beat'); void dot.offsetWidth; dot.classList.add('beat');
    }
    api.trend().then(render);
    setInterval(() => { if (!document.hidden) api.trend(true).then(render); }, 5000);
    let rw = window.innerWidth;
    window.addEventListener('resize', () => { if (Math.abs(window.innerWidth - rw) > 30) { rw = window.innerWidth; fit(); } });
    SEC.trendNow = () => last;
  };

  // ---- 1. Hero: песочница бота ----
  SEC.sandbox = function () {
    const S = { strat: 'LEVELS', coin: 'BTC', dir: 'both', risk: 1, unit: 'R', grid: null };
    const box = $('#sbx-chart'), uw = $('#sbx-uw'), dist = $('#sbx-dist');
    const riskIn = $('#sbx-risk');
    L.rangeFill(riskIn);
    let first = true;

    L.radio($('#sbx-strat'), (v) => { S.strat = v; render(); });
    L.radio($('#sbx-dir'), (v) => { S.dir = v; render(); });
    L.radio($('#sbx-unit'), (v) => { S.unit = v; render(true); });
    riskIn.addEventListener('input', () => { S.risk = +riskIn.value; render(true); });

    function coins() {
      const wrap = $('#sbx-coins');
      let h = '';
      S.grid.coins.forEach((c, i) => {
        h += '<button type="button" class="chip' + (c.sym === S.coin ? ' on' : '') + '" role="radio" aria-checked="' + (c.sym === S.coin) + '" data-v="' + c.sym + '" title="Объём за 24 ч ≈ $' + L.num(c.vol24h_musd) + ' млн">' + c.sym + (i < 3 ? '<em>' + (c.vol24h_musd >= 1000 ? L.num(c.vol24h_musd / 1000, 1) + ' млрд' : c.vol24h_musd + ' млн') + '</em>' : '') + '</button>';
      });
      h += '<button type="button" class="chip more" id="sbx-more" aria-expanded="false">ещё 12 ↓</button>';
      wrap.innerHTML = h;
      L.radio(wrap, (v) => { S.coin = v; render(); });
      $('#sbx-more').addEventListener('click', () => {
        const open = wrap.classList.toggle('open');
        $('#sbx-more').setAttribute('aria-expanded', open);
        $('#sbx-more').textContent = open ? 'свернуть ↑' : 'ещё 12 ↓';
      });
    }

    function render(soft) {
      const g = S.grid; if (!g) return;
      const cell = g.cells[S.strat + ':' + S.coin + ':' + S.dir];
      const st = STRAT[S.strat], r = S.risk;
      const pctMul = S.unit === 'pct' ? r : 1, suf = S.unit === 'pct' ? '%' : 'R';
      $('#sbx-title').textContent = S.coin + ' · ' + st.name + ' · ' + st.tf + ' · ' + DIR_NAME[S.dir];
      $('#sbx-period').textContent = 'отложенный период ' + L.dm(g.period.from) + '–' + L.date(g.period.to) + ' · ' + g.period.days + ' дн.';
      $('#sbx-risk-out').textContent = L.num(r, 2) + '%';

      // кривая (ось в R или в % при выбранном риске — форма не меняется, честно)
      const pts = cell.curve.map((p) => [p[0], p[1] * pctMul]);
      const neg = cell.r_total < 0;
      const fmtY = (v) => (S.unit === 'pct' ? L.pct(v, Math.abs(v) < 10 && v % 1 ? 1 : 0) : L.R(v, Math.abs(v) < 10 && v % 1 ? 1 : 0));
      const xl = [[g.period.from, L.dm(g.period.from)], [(g.period.from + g.period.to) / 2, L.dm((g.period.from + g.period.to) / 2)], [g.period.to, L.dm(g.period.to)]];
      L.chart(box, {
        x0: g.period.from, x1: g.period.to, series: [{ pts, cls: neg ? 'neg' : '', area: neg ? 'neg' : 'pos' }],
        yFmt: fmtY, xLabels: xl, draw: !soft || first,
        tip: (i, p) => (i === 0 ? '<b>старт</b> · 0' + suf : L.dm(p[0]) + ' · сделка ' + i + '<br/><b>' + L.R(cell.curve[i][1]) + '</b> = ' + L.pct(cell.curve[i][1] * r) + ' при ' + L.num(r, 2) + '%'),
      });
      box.setAttribute('aria-label', 'Кривая бэктеста ' + S.coin + ', ' + st.name + ': ' + L.R(cell.r_total) + ' за ' + g.period.days + ' дней, ' + cell.n + ' сделок, макс. просадка ' + L.R(-cell.max_dd_r));
      // «подводная» кривая просадки
      let peak = 0;
      const dd = cell.curve.map((p) => { if (p[1] > peak) peak = p[1]; return [p[0], (p[1] - peak) * pctMul]; });
      L.chart(uw, { x0: g.period.from, x1: g.period.to, series: [{ pts: dd, fill: 'uw' }], yMax: 0, yMin: Math.min(-1, -cell.max_dd_r * pctMul * 1.15), ticks: [0], yFmt: () => '', pad: { t: 2, b: 2 } });

      // показания
      L.odo($('#m-r'), L.R(cell.r_total));
      $('#m-r').classList.toggle('loss', neg);
      $('#m-rp').textContent = '= ' + L.pct(cell.r_total * r) + ' при риске ' + L.num(r, 2) + '%';
      L.odo($('#m-dd'), L.R(-cell.max_dd_r));
      $('#m-ddp').textContent = '= ' + L.pct(-cell.max_dd_r * r) + ' депозита';
      const wr = cell.n ? cell.wins / cell.n * 100 : 0, ci = L.wilson(cell.wins, cell.n);
      L.odo($('#m-wr'), Math.round(wr) + '%');
      $('#m-wrci').textContent = 'Уилсон ' + Math.round(ci[0]) + '–' + Math.round(ci[1]) + '%';
      L.odo($('#m-pf'), cell.pf === null ? '—' : L.num(cell.pf, 2));
      $('#m-n').textContent = 'сделок ' + cell.n + (cell.n < 30 ? ' · мало' : '');
      const lvl = L.riskLevel(cell.p95_dd_r, r);
      $('#m-risk .rbar').setAttribute('data-l', lvl);
      $('#m-risk span').textContent = lvl + ' из 5';
      $('#m-riskl').textContent = L.riskWord[lvl] + ' при риске ' + L.num(r, 2) + '%';
      $('#sbx-honest').innerHTML = 'При риске <b>' + L.num(r, 2) + '%</b>: результат <b>' + L.pct(cell.r_total * r) + '</b>, худшая просадка <b>' + L.pct(-cell.max_dd_r * r) + '</b> депозита. В худших 5% перестановок сделок (Монте-Карло) просадка доходит до <b>' + L.pct(-cell.p95_dd_r * r) + '</b>. Риск выше — шире оба края.';

      // распределение по 20 монетам и медиана
      const vals = g.coins.map((c) => ({ sym: c.sym, v: g.cells[S.strat + ':' + c.sym + ':' + S.dir].r_total }));
      const med = L.median(vals.map((x) => x.v)), negN = vals.filter((x) => x.v < 0).length;
      $('#sbx-median').innerHTML = 'медиана <b>' + L.R(med) + '</b> · в минусе ' + negN + ' из 20 · ' + S.coin + ' ' + L.R(cell.r_total);
      renderDist(vals, med);

      // автотеги
      const tags = L.baseTags(cell);
      if (cell.r_total * r < cell.hold_pct) tags.push(['info', 'хуже, чем держать ' + S.coin + ' (' + L.pct(cell.hold_pct) + ' без плеча)']);
      if (S.strat !== 'VOLUME') tags.push(['info', 'MTF-фильтры в бэктесте упрощены']);
      if (cell.r_total > med && cell.r_total > 0) tags.push(['info', S.coin + ' выше медианы — не выбирайте монету по лучшему результату']);
      $('#sbx-tags').innerHTML = L.tagsHtml(tags);

      // ссылка запуска сохраняет конфигурацию (после входа бот создаётся в Демо)
      const q2 = 'from=sandbox&strategy=' + S.strat + '&coin=' + S.coin + '&dir=' + S.dir + '&risk=' + r;
      $('#hero-launch').href = $('#sbx-launch').href = '/app/?' + q2;
      L.store.set('chm_sandbox_cfg', JSON.stringify({ strategy: S.strat, coin: S.coin, dir: S.dir, risk: r, at: Date.now() }));
      first = false;
    }
    function renderDist(vals, med) {
      const W = Math.max(200, dist.clientWidth), H = dist.clientHeight || 46;
      let lo = Math.min(0, ...vals.map((x) => x.v)), hi = Math.max(0, ...vals.map((x) => x.v));
      const sp = (hi - lo) || 1; lo -= sp * 0.04; hi += sp * 0.04;
      const X = (v) => 6 + (v - lo) / (hi - lo) * (W - 12);
      let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" aria-hidden="true">';
      s += '<line class="g-grid" x1="6" x2="' + (W - 6) + '" y1="22" y2="22"/>';
      s += '<line class="g-zero" x1="' + X(0) + '" x2="' + X(0) + '" y1="10" y2="34"/><text class="g-lbl" text-anchor="middle" x="' + X(0) + '" y="44">0R</text>';
      vals.forEach((x) => { if (x.sym !== S.coin) s += '<line class="tk' + (x.v < 0 ? ' neg' : '') + '" x1="' + X(x.v) + '" x2="' + X(x.v) + '" y1="15" y2="29"><title>' + x.sym + ' ' + L.R(x.v) + '</title></line>'; });
      s += '<line class="med" x1="' + X(med) + '" x2="' + X(med) + '" y1="6" y2="38"/><text class="med-l" text-anchor="middle" x="' + X(med) + '" y="5">медиана</text>';
      const cur = vals.find((x) => x.sym === S.coin);
      s += '<line class="tk cur" x1="' + X(cur.v) + '" x2="' + X(cur.v) + '" y1="11" y2="33"/><text class="cur-l" text-anchor="' + (X(cur.v) > W - 40 ? 'end' : X(cur.v) < 40 ? 'start' : 'middle') + '" x="' + X(cur.v) + '" y="44">' + cur.sym + '</text>';
      dist.innerHTML = s + '</svg>';
      dist.setAttribute('aria-label', 'Результат стратегии на 20 монетах: медиана ' + L.R(med) + ', выбранная монета ' + cur.sym + ' ' + L.R(cur.v));
    }

    api.backtestGrid().then((g) => {
      S.grid = g;
      $('#sbx-seldate').textContent = L.date(g.selection_end);
      $('#sbx-upd').textContent = L.date(g.updated_at) + ' ' + L.time(g.updated_at);
      coins();
      render();
      [box, dist].forEach((b) => L.autoSize(b, () => render(true)));
    });
  };

  // ---- 2. Лента сигналов (задержка 60 мин) и счётчики трекера ----
  const ST_TXT = { open: 'Открыта', tp1be: 'TP1 → БУ', tp2: 'TP2 → БУ', tp3: 'TP3', sl: 'Стоп', exp: 'Истекла' };
  const ST_CLS = { open: 'open', tp1be: 'tp', tp2: 'tp', tp3: 'tp', sl: 'sl', exp: 'exp' };
  SEC.feed = function () {
    const list = $('#feed-list');
    const MAX = 10;
    function rowHtml(it) {
      return '<span class="ft">' + L.time(it.t) + '</span><span class="fp">' + it.pair + '</span><span class="fb">' + L.esc(it.strategy_name) + ' · ' + it.tf + '</span>' +
        '<span class="fs ' + (it.side === 'LONG' ? 'long' : 'short') + '">' + it.side + '</span>' +
        '<span><span class="st ' + ST_CLS[it.status] + '">' + ST_TXT[it.status] + '</span></span>' +
        '<span class="fr ' + (it.r === null ? 'dim' : it.r > 0 ? 'up' : it.r < 0 ? 'loss' : '') + '">' + (it.r === null ? '—' : L.R(it.r, 2)) + '</span>';
    }
    function li(it, enter) {
      const el = document.createElement('li');
      el.setAttribute('data-id', it.id);
      el.setAttribute('data-st', it.status);
      el.innerHTML = rowHtml(it);
      el.setAttribute('aria-label', L.time(it.t) + ', ' + it.pair + ', ' + it.side + ', ' + ST_TXT[it.status] + (it.r !== null ? ', ' + L.R(it.r, 2) : ''));
      if (enter && !L.reduced) el.classList.add('enter');
      return el;
    }
    const byId = {};
    api.feed().then((d) => {
      d.items.slice(0, MAX).forEach((it) => { byId[it.id] = it; list.appendChild(li(it)); });
    });
    function clock() { $('#feed-clock').textContent = 'сейчас ' + L.time(Date.now()) + ' · лента до ' + L.time(Date.now() - 36e5); }
    clock(); setInterval(clock, 15000);
    function step() {
      if (document.hidden) return;
      const open = $$('li[data-st="open"]', list).map((x) => x.getAttribute('data-id'));
      api.feedNext(open).then((ev) => {
        if (ev.type === 'update') {
          const el = list.querySelector('li[data-id="' + ev.id + '"]'), it = byId[ev.id];
          if (!el || !it) return;
          it.status = ev.status; it.r = ev.r;
          el.innerHTML = rowHtml(it); el.setAttribute('data-st', it.status);
          el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
        } else if (ev.type === 'new') {
          byId[ev.item.id] = ev.item;
          list.insertBefore(li(ev.item, true), list.firstChild);
          const all = $$('li', list);
          if (all.length > MAX) setTimeout(() => { $$('li', list).slice(MAX).forEach((x) => x.remove()); }, 700);
        }
      });
    }
    let timer = 0;
    L.onVisible($('#now'), () => { timer = setInterval(step, 8000); }, '200px');
    SEC.feedStop = () => clearInterval(timer);
  };

  SEC.counters = function () {
    api.stats().then((s) => {
      const set = (k, v) => L.odo($('[data-c="' + k + '"]'), v);
      const txt = (k, v) => { $('[data-c="' + k + '"]').textContent = v; };
      const up = (k, ts) => { $('[data-u="' + k + '"]').textContent = L.time(ts) + (Date.now() - ts > 864e5 ? ' ' + L.dm(ts) : ''); };
      set('signals', L.num(s.tracked_signals.value));
      txt('signals-s', 'закрыто ' + L.num(s.closed_signals.value) + ' · открыто ' + s.open_signals.value);
      up('signals', s.tracked_signals.updated_at);
      set('days', String(s.showcase_days.value));
      txt('days-s', 'дней, с ' + L.date(s.showcase_days.since));
      up('days', s.showcase_days.updated_at);
      const b = s.bots_30d;
      set('median', L.R(b.median_r));
      txt('median-s', 'в плюсе ' + b.positive + ' из ' + b.total + ' ботов');
      up('median', b.updated_at);
      set('worst', L.R(b.worst_r)); set('best', L.R(b.best_r));
      up('median2', b.updated_at);
      set('cand', String(s.registry.candidates));
      txt('cand-s', 'на витрине ' + s.registry.published + ' · ждут ' + s.registry.waiting + ' · архив ' + s.registry.archived);
      up('cand', s.tracked_signals.updated_at);
      // доли исходов: стопы рядом с тейками
      const o = s.outcomes_recent, tot = o.tp2plus + o.tp1be + o.sl + o.exp;
      const parts = [['m-tp2', o.tp2plus, 'TP2 и выше'], ['m-tp1', o.tp1be, 'TP1 → БУ'], ['m-sl', o.sl, 'Стоп'], ['m-exp', o.exp, 'Истекли']];
      $('#mix-bar').innerHTML = parts.map((p) => '<i class="' + p[0] + '" style="flex-grow:' + p[1] + '"></i>').join('');
      $('#mix-bar').setAttribute('aria-label', parts.map((p) => p[2] + ' ' + Math.round(p[1] / tot * 100) + '%').join(', '));
      $('#mix-leg').innerHTML = parts.map((p) => '<span><i class="sw ' + p[0] + '"></i>' + p[2] + ' <b>' + Math.round(p[1] / tot * 100) + '%</b></span>').join('');
      $('#mix-upd').textContent = 'обн. ' + L.time(o.updated_at);
    });
  };

  // ---- 3. Витрина ботов: фильтры, сортировка, риск посетителя, переворот карточки, архив ----
  SEC.showcase = function () {
    const S = { strategy: 'all', risk: 5, dir: 'all', tf: 'all', regime: false, myRisk: 1, sort: 'top', coin: null, data: null };
    const track = $('#sc-track');
    const params = new URLSearchParams(location.search);
    if (params.get('strategy') && STRAT[params.get('strategy')]) S.strategy = params.get('strategy');
    if (params.get('coin')) S.coin = params.get('coin').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);

    const groups = {};
    $$('#sc-filters [data-f]').forEach((g) => {
      const k = g.getAttribute('data-f');
      groups[k] = L.radio(g, (v) => { S[k] = k === 'risk' ? +v : v; render(); });
    });
    if (S.strategy !== 'all') groups.strategy.set(S.strategy);
    L.radio($('#sc-risk'), (v) => { S.myRisk = +v; render(); });
    L.radio($('#sc-sort'), (v) => { S.sort = v; render(); });
    $('#sc-regime').addEventListener('change', (e) => { S.regime = e.target.checked; render(); });
    $('#sc-reset').addEventListener('click', () => {
      S.strategy = 'all'; S.risk = 5; S.dir = 'all'; S.tf = 'all'; S.regime = false; S.coin = null;
      groups.strategy.set('all'); groups.risk.set('5'); groups.dir.set('all'); groups.tf.set('all'); $('#sc-regime').checked = false;
      render();
    });

    function regimeNow() {
      const t = SEC.trendNow && SEC.trendNow();
      return t ? t.tfs['4H'].trend : 'RANGE';
    }
    function spark(b) {
      const pts = b.curve, x0 = pts[0][0], x1 = pts[pts.length - 1][0];
      let lo = 0, hi = 0; pts.forEach((p) => { lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); });
      const W = 120, H = 56, sp = (hi - lo) || 1;
      const X = (t) => (t - x0) / (x1 - x0) * (W - 2) + 1, Y = (v) => 4 + (hi - v) / sp * (H - 16);
      const neg = b.stats.r_total < 0;
      return '<svg class="spark chart" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true">' +
        '<line class="g-zero" x1="0" x2="' + W + '" y1="' + Y(0).toFixed(1) + '" y2="' + Y(0).toFixed(1) + '"/>' +
        '<text class="g-lbl" x="' + (W - 1) + '" y="' + (Y(0) > H - 14 ? Y(0) - 3 : Y(0) + 10).toFixed(1) + '" text-anchor="end">0R</text>' +
        '<text class="g-lbl" x="1" y="' + (H - 1) + '">' + b.track_days + 'д</text>' +
        '<path class="eq ' + (neg ? 'neg' : '') + (L.reduced ? '' : ' draw') + '" pathLength="1" vector-effect="non-scaling-stroke" d="' + L.pathD(pts, X, Y) + '"/></svg>';
    }
    const ro = (k, v, s, c) => '<div class="ro"><span class="ro-k">' + k + '</span><b class="ro-v ' + (c || '') + '">' + v + '</b><span class="ro-s">' + s + '</span></div>';
    function card(b) {
      const r = S.myRisk, st = b.stats, isNew = b.status === 'new';
      const coins = b.coins.join(' ') + (b.coins_extra ? ' +' + b.coins_extra : '');
      const dirTxt = DIR_NAME[b.dir];
      const lvl = isNew ? null : L.riskLevel(st.p95_dd_r, r);
      const ci = L.wilson(st.wins, st.n);
      const srcBadge = isNew ? '<span class="src src-new">Новый · мало данных</span>' : '<span class="src src-paper" title="Трек сигналов по ценам уровней, без реальных исполнений">Трек (бумажный) · ' + b.track_days + ' дн.</span>';
      const head = '<div class="inst-hd">' + srcBadge + '<span title="' + L.esc(b.copies_rule) + '">копий ' + b.copies + '</span></div>' +
        '<div class="sc-head"><b class="glyph">' + L.esc(b.short) + '</b><div class="sc-name"><b>' + L.esc(b.strategy_name) + ' · ' + L.esc(coins) + '</b><span>' + dirTxt + ' · ' + b.tf + ' · v' + b.version + ', параметры заморожены</span></div></div>';
      const btns = '<div class="row"><a class="btn btn-ghost" href="#backtest" data-bt="' + b.strategy + ':' + b.coins[0] + '">Тест на моих монетах</a><a class="btn btn-red" href="/app/?copy=' + b.id + '">Копировать</a></div>';
      let front;
      if (isNew) {
        front = head + '<div class="sc-new"><p style="margin:0">Статистику покажем после 30 закрытых сигналов и 30 дней трека. Так на витрину не попадает бот, которому просто повезло на старте.</p>' +
          '<div><span class="lbl">Сигналов ' + st.n + ' из 30</span><div class="bar"><b style="width:' + Math.min(100, st.n / 30 * 100) + '%"></b></div></div>' +
          '<div><span class="lbl">Дней ' + b.track_days + ' из 30</span><div class="bar"><b style="width:' + Math.min(100, b.track_days / 30 * 100) + '%"></b></div></div>' +
          '<p style="margin:0">Опубликован ' + L.date(b.published_at) + '. До порога бот виден только здесь, с этой пометкой.</p></div>';
      } else {
        front = head +
          '<div class="sc-res"><div><div class="sc-big ' + (st.r_total < 0 ? 'loss' : '') + '">' + L.R(st.r_total) + '<small>за ' + b.track_days + ' дн.</small></div>' +
          '<div class="sc-pct">= ' + L.pct(st.r_total * r) + ' при риске ' + L.riskTxt(r) + ' на сделку, без реинвеста</div></div>' + spark(b) + '</div>' +
          '<div class="sc-m">' +
          ro('Просадка', L.R(-st.max_dd_r), 'макс. = ' + L.pct(-st.max_dd_r * r), 'loss') +
          ro('Винрейт', Math.round(st.wins / st.n * 100) + '%', Math.round(ci[0]) + '–' + Math.round(ci[1]) + '% Уилсон') +
          ro('PF', L.num(st.pf, 2), 'после комиссий') + ro('Сигналов', st.n, 'все исходы') + ro('В сделке', '~' + Math.round(st.avg_hold_h) + ' ч', 'в среднем') +
          ro('За 30 дн.', L.R(st.r_30d), '= ' + L.pct(st.r_30d * r), st.r_30d < 0 ? 'loss' : '') + '</div>' +
          '<div class="sc-risk"><div class="rr"><i class="rbar" data-l="' + lvl + '" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></i>Риск ' + lvl + ' из 5 · ' + L.riskWord[lvl] + '</div>' +
          '<div class="rs">при риске ' + L.riskTxt(r) + ' худшая серия ≈ ' + L.pct(-st.p95_dd_r * r) + ' депозита (p95 Монте-Карло)</div></div>' +
          '<div class="sc-src"><div><span class="src src-bt src-xs">Бэктест</span><span>отложенный: <b>' + L.R(b.backtest_holdout.r_total) + '</b> · PF ' + L.num(b.backtest_holdout.pf, 2) + ' · ' + b.backtest_holdout.n + ' сд.</span></div>' +
          '<div><span class="src src-ex src-xs">Биржа</span><span>' + (b.exchange_copies.n >= 20 ? 'медиана копий <b class="' + (b.exchange_copies.median_r < 0 ? 'loss' : '') + '">' + L.R(b.exchange_copies.median_r) + '</b> (n=' + b.exchange_copies.n + ')' : 'копий от 7 дней мало (n=' + b.exchange_copies.n + '), медиану не считаем') + '</span></div></div>';
      }
      front += '<div class="sc-foot"><div class="sc-meta"><span>обн. ' + L.time(b.updated_at) + ' · после комиссий, оценка</span><button type="button" class="flip-btn" data-flip aria-label="Показать, как торгует бот">↻ как торгует</button></div>' + btns + '</div>';
      const back = '<div class="inst-hd"><span class="inst-id">Как торгует</span><button type="button" class="flip-btn" data-flip aria-label="Вернуться к статистике">↺ статистика</button></div>' +
        '<p class="how">' + L.esc(b.how) + '</p>' +
        '<div class="tbl-wrap" style="padding:0 6px"><table class="tbl"><tbody>' + b.params.concat([['Частичный TP', '40 / 30 / 30']]).map((p) => '<tr><td>' + L.esc(p[0]) + '</td><td>' + L.esc(p[1]) + '</td></tr>').join('') + '</tbody></table></div>' +
        '<p class="weak" style="margin-top:10px"><b>Где не работает:</b> ' + L.esc(b.weak) + '</p>' +
        '<div class="sc-foot"><div class="sc-meta"><span>опубликован ' + L.date(b.published_at) + ' · v' + b.version + '</span><span>режим: ' + b.regime_fit.map((x) => TREND_W[x].toLowerCase()).join(', ') + '</span></div>' + btns + '</div>';
      return '<li class="sc-card" data-id="' + b.id + '"><div class="sc-inner"><div class="sc-face sc-front inst">' + front + '</div><div class="sc-face sc-back inst" aria-hidden="true">' + back + '</div></div></li>';
    }
    function render() {
      if (!S.data) return;
      const reg = regimeNow();
      $('#sc-regime-now').textContent = '(сейчас ' + TREND_W[reg].toLowerCase() + ' на 4H)';
      const bots = S.data.bots.filter((b) => {
        if (S.strategy !== 'all' && b.strategy !== S.strategy) return false;
        if (S.dir !== 'all' && b.dir !== S.dir) return false;
        if (S.tf !== 'all' && b.tf !== S.tf) return false;
        if (S.coin && b.coins.indexOf(S.coin) < 0 && !(b.coins_extra >= 10)) return false;
        if (S.regime && b.regime_fit.indexOf(reg) < 0) return false;
        if (b.status === 'new') return S.risk >= 5;
        return L.riskLevel(b.stats.p95_dd_r, S.myRisk) <= S.risk;
      });
      const score = (b) => (b.status === 'new' ? -1e9 : (b.track_days >= 90 ? 1e6 : 0) + b.stats.r_total / Math.max(1, b.stats.max_dd_r));
      if (S.sort === 'top') bots.sort((a, b) => score(b) - score(a));
      else if (S.sort === 'new') bots.sort((a, b) => b.published_at - a.published_at);
      else bots.sort((a, b) => b.copies - a.copies);
      track.innerHTML = bots.map(card).join('');
      $('#sc-empty').hidden = bots.length > 0;
      track.scrollLeft = 0;
      pos();
      const chip = $('#sc-coin-chip');
      if (S.coin && !chip) {
        const c = document.createElement('button');
        c.type = 'button'; c.className = 'chip on'; c.id = 'sc-coin-chip';
        c.textContent = 'Монета: ' + S.coin + ' ✕';
        c.addEventListener('click', () => { S.coin = null; c.remove(); render(); });
        $('#sc-filters').appendChild(c);
      }
    }
    function cardW() { const c = track.querySelector('.sc-card'); return c ? c.offsetWidth + 16 : 360; }
    function pos() {
      const n = track.children.length;
      if (!n) { $('#sc-pos').textContent = '0 ботов'; $('#sc-prev').disabled = $('#sc-next').disabled = true; return; }
      const w = cardW(), first = Math.round(track.scrollLeft / w) + 1, vis = Math.max(1, Math.floor((track.clientWidth + 16) / w));
      const last = Math.min(n, first + vis - 1);
      $('#sc-pos').textContent = (last > first ? first + '–' + last : first) + ' из ' + n;
      $('#sc-prev').disabled = track.scrollLeft < 4;
      $('#sc-next').disabled = track.scrollLeft + track.clientWidth >= track.scrollWidth - 4;
    }
    $('#sc-prev').addEventListener('click', () => track.scrollBy({ left: -cardW(), behavior: L.reduced ? 'auto' : 'smooth' }));
    $('#sc-next').addEventListener('click', () => track.scrollBy({ left: cardW(), behavior: L.reduced ? 'auto' : 'smooth' }));
    track.addEventListener('scroll', () => { window.requestAnimationFrame(pos); }, { passive: true });
    window.addEventListener('resize', pos);
    // переворот: клик/Enter по кнопке, наведение на кнопку на десктопе
    function flip(cardEl, on) {
      const f = on === undefined ? !cardEl.classList.contains('flip') : on;
      cardEl.classList.toggle('flip', f);
      $('.sc-front', cardEl).setAttribute('aria-hidden', f ? 'true' : 'false');
      $('.sc-back', cardEl).setAttribute('aria-hidden', f ? 'false' : 'true');
      $$('.sc-front a, .sc-front button', cardEl).forEach((x) => { x.tabIndex = f ? -1 : 0; });
      $$('.sc-back a, .sc-back button', cardEl).forEach((x) => { x.tabIndex = f ? 0 : -1; });
    }
    track.addEventListener('click', (e) => {
      const fb = e.target.closest('[data-flip]');
      if (fb) { const c = fb.closest('.sc-card'); flip(c); const t = $(c.classList.contains('flip') ? '.sc-back [data-flip]' : '.sc-front [data-flip]', c); if (t) t.focus({ preventScroll: true }); return; }
      const bt = e.target.closest('[data-bt]');
      if (bt && SEC.btPreset) { const p = bt.getAttribute('data-bt').split(':'); SEC.btPreset(p[0], p[1]); }
    });
    if (L.finePointer) {
      track.addEventListener('pointerover', (e) => { const fb = e.target.closest('.sc-front [data-flip]'); if (fb) flip(fb.closest('.sc-card'), true); });
      track.addEventListener('pointerleave', () => $$('.sc-card.flip', track).forEach((c) => flip(c, false)));
      track.addEventListener('pointerout', (e) => { const c = e.target.closest('.sc-card'); if (c && !c.contains(e.relatedTarget)) flip(c, false); });
    }

    api.showcase().then((d) => {
      S.data = d;
      render();
      $$('.sc-back a, .sc-back button', track).forEach((x) => { x.tabIndex = -1; });
      const reg = d.registry;
      $('#sc-arch-sum').textContent = 'архив ' + d.archive.length + ' · реестр ' + reg.candidates + ' с ' + L.date(reg.launched_since);
      const sn = { LEVELS: 'Уровни', SMC: 'SMC', VOLUME: 'Объём + MA' };
      $('#sc-arch-tbl tbody').innerHTML = d.archive.map((a) => '<tr><td>' + sn[a.strategy] + ' · ' + L.esc(a.coins) + ' · ' + a.tf + ' · v' + a.v + '</td><td>' + L.date(a.from) + '–' + L.date(a.to) + '</td><td>' + a.n + '</td><td class="' + (a.r_total < 0 ? 'loss' : 'up') + '">' + L.R(a.r_total) + '</td><td class="loss">' + L.R(-a.max_dd_r) + '</td><td>' + L.esc(a.reason) + '</td></tr>').join('') +
        '<tr><td colspan="6" class="dim">Ещё ' + reg.waiting + ' кандидата набирают 30 сигналов и 30 дней. Опубликовано ' + reg.published + ' из ' + reg.candidates + ' запущенных.</td></tr>';
    });
    // режим рынка приходит с лентой тренда — обновим подпись, когда она появится
    setTimeout(() => { $('#sc-regime-now').textContent = '(сейчас ' + TREND_W[regimeNow()].toLowerCase() + ' на 4H)'; }, 1500);
  };
})();
