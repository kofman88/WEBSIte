/* Секции 4–9: история «как это работает», площадка бэктеста, «стоп или усреднение»,
   эволюция Genome, планировщик челленджа, калькулятор оплаты. */
(function () {
  'use strict';
  const C = window.CHML, L = C.lib, api = C.api, $ = L.$, $$ = L.$$;
  const SEC = C.sec = C.sec || {};

  // ---- 4. Scroll-story: макет «прилипает», шаги меняются ----
  SEC.story = function () {
    const steps = $$('#story-steps .step'), scrs = $$('#story-phone .scr'), n = $('#story-step-n');
    // на мобильных экран шага показывается внутри шага (клон макета)
    steps.forEach((st, i) => { const box = $('.step-scr', st); if (box && scrs[i]) { const c = scrs[i].cloneNode(true); c.classList.add('is-on'); box.appendChild(c); } });
    function set(i) {
      steps.forEach((s, k) => s.classList.toggle('is-on', k === i));
      scrs.forEach((s, k) => s.classList.toggle('is-on', k === i));
      n.textContent = (i + 1) + ' / ' + steps.length;
    }
    if (!('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver((ents) => {
      ents.forEach((e) => { if (e.isIntersecting) set(steps.indexOf(e.target)); });
    }, { rootMargin: '-45% 0px -45% 0px' });
    steps.forEach((s) => io.observe(s));
  };

  // ---- 5. Площадка бэктеста ----
  const ZN = { hold: 'Отложенный период', sel: 'Данные отбора', early: 'Ранняя история', stress: 'Стресс-окно' };
  SEC.backtest = function () {
    const S = { strat: 'LEVELS', coin: 'BTC', period: 'hold' };
    const box = $('#bt-chart'), na = $('#bt-na'), sel = $('#bt-coin');
    let last = null, seq = 0;
    const rs = L.radio($('#bt-strat'), (v) => { S.strat = v; run(); });
    sel.addEventListener('change', () => { S.coin = sel.value; run(); });
    $('#bt-period').addEventListener('change', (e) => { if (e.target.name === 'btp') { S.period = e.target.value; run(); } });
    na.addEventListener('click', (e) => { const b = e.target.closest('[data-coin]'); if (b) { S.coin = b.getAttribute('data-coin'); sel.value = S.coin; run(); } });
    SEC.btPreset = (strat, coin) => {
      S.strat = strat; S.coin = coin; S.period = 'hold';
      rs.set(strat); sel.value = coin; $('#bt-period input[value="hold"]').checked = true; run();
    };
    function run() { const my = ++seq; api.backtest(S.strat, S.coin, S.period).then((d) => { if (my === seq) { last = d; render(d); } }); }

    function render(d, soft) {
      const tbl = $('#bt-zones');
      if (!d.available) {
        L.chart(box, { x0: d.window.from, x1: d.window.to, series: [], yMin: -4, yMax: 4, ticks: [-4, 0, 4], yFmt: (v) => L.R(v, 0), xLabels: [[d.window.from, L.date(d.window.from)], [d.window.to, L.date(d.window.to)]] });
        const why = d.reason === 'not_listed'
          ? d.coin + ': перпетуал появился в ' + monthName(d.listed) + ', поэтому истории за «' + d.window.label + '» нет вовсе.'
          : 'Для ' + d.coin + ' свечей за «' + d.window.label + '» у нас нет. Основное хранилище держит 365 дней, а архив стресс-окон пока собран только для ' + d.available_for.join(', ') + '.';
        na.innerHTML = '<b>Истории нет — результат не показываем</b><p>' + L.esc(why) + ' Подставлять похожую монету или «примерный» прогон мы не будем.</p>' +
          '<div class="chips">' + d.available_for.map((c) => '<button type="button" class="chip" data-coin="' + c + '">Смотреть ' + c + '</button>').join('') + '</div>';
        na.hidden = false;
        $('#bt-src').textContent = 'Бэктест · нет данных';
        tbl.querySelector('thead').innerHTML = '<tr><th>Показатель</th><th>' + ZN.stress + '</th></tr>';
        tbl.querySelector('tbody').innerHTML = ['Сделок', 'Результат', 'Винрейт', 'PF', 'Макс. просадка'].map((k) => '<tr><td>' + k + '</td><td class="z-dim">—</td></tr>').join('');
        qbars(null);
        $('#bt-tags').innerHTML = '<span class="tag info">стресс-окно недоступно для ' + L.esc(d.coin) + '</span>';
        box.setAttribute('aria-label', 'Нет истории для ' + d.coin + ' за ' + d.window.label);
        return;
      }
      na.hidden = true;
      const zones = d.zones, main = zones[zones.length - 1];
      let base = 0;
      const series = [], tipPts = [], tipZone = [];
      let band = null;
      zones.forEach((z) => {
        const pts = [[z.from, base]];
        const b0 = base;
        z.trades.forEach((t) => { base += t.r; pts.push([t.t, Math.round(base * 100) / 100]); });
        pts.forEach((p) => { tipPts.push(p); tipZone.push(z.id); });
        const cls = z.id === 'hold' || z.id === 'stress' ? (z.stats.r_total < 0 ? 'neg' : '') : z.id === 'sel' ? 'dimln' : 'early';
        series.push({ pts, cls, area: zones.length === 1 ? (z.stats.r_total < 0 ? 'neg' : 'pos') : null });
        if (z.id === 'hold' && d.mc) {
          band = { pts: [[z.from, b0, b0]].concat(z.trades.map((t, i) => [t.t, b0 + d.mc.p5[i], b0 + d.mc.p95[i]])) };
        }
      });
      // основная серия рисуется последней (поверх), подсказка — по всем зонам
      const x0 = zones[0].from, x1 = main.to;
      const xl = [];
      for (let k = 0; k <= 3; k++) { const t = x0 + (x1 - x0) * k / 3; xl.push([t, S.period === 'year' ? L.dm(t) + '.' + String(new Date(t).getFullYear()).slice(2) : L.dm(t)]); }
      const selZ = zones.find((z) => z.id === 'sel');
      L.chart(box, {
        x0, x1, series, band, draw: !soft, yFmt: (v) => L.R(v, Math.abs(v) < 10 && v % 1 ? 1 : 0), xLabels: xl,
        shades: selZ ? [{ from: selZ.from, to: selZ.to, label: 'данные отбора' }] : [],
        vl: selZ ? [{ x: d.selection_end, label: 'дата отбора ' + L.dm(d.selection_end) }] : [],
        tipSeries: tipPts,
        tip: (i, p) => L.dm(p[0]) + ' · ' + ZN[tipZone[i]].toLowerCase() + '<br/><b>' + L.R(p[1]) + '</b> накоплено',
      });
      box.setAttribute('aria-label', 'Бэктест ' + d.coin + ': ' + zones.map((z) => ZN[z.id] + ' ' + L.R(z.stats.r_total) + ', ' + z.stats.n + ' сделок').join('; '));
      $('#bt-leg').querySelectorAll('span').forEach((s, k) => { s.hidden = (k === 0 && !selZ) || (k === 2 && !band) || (k === 3 && S.period !== 'year'); });
      $('#bt-src').textContent = S.period === 'year' ? 'Бэктест · год' : S.period === 'hold' ? 'Бэктест · отложенный период' : 'Бэктест · стресс-окно (архив)';

      // таблица зон: отложенный период первым
      const order = zones.slice().sort((a, b) => (a.id === 'hold' || a.id === 'stress' ? -1 : b.id === 'hold' || b.id === 'stress' ? 1 : a.id === 'sel' ? -1 : 1));
      const th = '<tr><th>Показатель</th>' + order.map((z, i) => '<th class="' + (i ? 'z-dim' : 'z-on') + '">' + ZN[z.id] + '<br/><span class="dim">' + L.dm(z.from) + '–' + L.dm(z.to) + '</span></th>').join('') + '</tr>';
      const row = (k, f, cls) => '<tr><td>' + k + '</td>' + order.map((z, i) => '<td class="' + (i ? 'z-dim' : 'zh') + ' ' + (cls ? cls(z) : '') + '">' + f(z) + '</td>').join('') + '</tr>';
      let body = row('Сделок', (z) => z.stats.n) +
        row('Результат', (z) => L.R(z.stats.r_total), (z) => (z.stats.r_total < 0 ? 'loss' : '')) +
        row('Винрейт (Уилсон)', (z) => { const ci = L.wilson(z.stats.wins, z.stats.n); return Math.round(z.stats.wins / Math.max(1, z.stats.n) * 100) + '% (' + Math.round(ci[0]) + '–' + Math.round(ci[1]) + ')'; }) +
        row('PF', (z) => (z.stats.pf === null ? '—' : L.num(z.stats.pf, 2))) +
        row('Макс. просадка', (z) => L.R(-z.stats.max_dd_r), () => 'loss') +
        row('p95 просадки', (z) => L.R(-z.stats.p95_dd_r));
      if (selZ) body += row('PF × 0,6 (поправка Genome)', (z) => (z.id === 'sel' && z.stats.pf ? L.num(z.stats.pf * 0.6, 2) : '—'));
      if (S.period !== 'hold' && S.period !== 'year') body += row('Средний стоп', (z) => (z.stats.sl_avg_r === null ? '—' : L.R(z.stats.sl_avg_r, 2)), () => 'loss');
      tbl.querySelector('thead').innerHTML = th;
      tbl.querySelector('tbody').innerHTML = body;
      qbars(d.quarters || null);

      // автотеги
      const st = main.stats, tags = L.baseTags(st);
      if (d.quarters) {
        const pos = d.quarters.filter((x) => x > 0).length;
        if (pos === 1) tags.push(['warn', 'прибыль сделал один период из четырёх']);
        else if (pos >= 3) tags.push(['ok', 'в плюсе ' + pos + ' периода из 4']);
        else tags.push(['info', 'в плюсе ' + pos + ' периода из 4']);
      }
      if (selZ && selZ.stats.r_total > 2 * Math.max(0.5, d.zones.find((z) => z.id === 'hold').stats.r_total)) tags.push(['info', 'на данных отбора результат больше чем вдвое выше — так и должно быть, судите по отложенному периоду']);
      if (st.r_total < d.hold_pct) tags.push(['info', 'хуже, чем держать ' + d.coin + ' при риске 1% (' + L.pct(d.hold_pct) + ')']);
      if (zones[0].id === 'stress' && st.sl_avg_r !== null && st.sl_avg_r < -1.3) tags.push(['warn', 'стопы исполнялись хуже плана: в среднем ' + L.R(st.sl_avg_r, 2)]);
      if (d.mtf_simplified) tags.push(['info', 'MTF-фильтры в бэктесте упрощены']);
      $('#bt-tags').innerHTML = L.tagsHtml(tags);
    }
    function qbars(qs) {
      const el = $('#bt-q');
      if (!qs) { el.innerHTML = '<span class="note" style="grid-column:1/-1;align-self:center">Для этого окна не считаем: слишком короткий период.</span>'; return; }
      const m = Math.max(1, ...qs.map(Math.abs));
      el.innerHTML = qs.map((v, i) => {
        const h = Math.abs(v) / m * 40;
        return '<div class="qb"><i class="zero"></i><i class="bar ' + (v >= 0 ? 'pos' : 'neg') + '" style="height:' + h + '%;top:' + (v >= 0 ? 50 - h : 50) + '%"></i>' +
          '<span class="qv ' + (v < 0 ? 'loss' : 'up') + '" style="top:' + (v >= 0 ? Math.max(0, 50 - h - 13) : Math.min(80, 52 + h)) + '%">' + L.R(v) + '</span><span class="ql">' + (i + 1) + '/4</span></div>';
      }).join('');
      el.setAttribute('aria-label', 'Результат по четырём периодам: ' + qs.map((v) => L.R(v)).join(', '));
    }
    function monthName(ym) {
      const M = ['январе', 'феврале', 'марте', 'апреле', 'мае', 'июне', 'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре'];
      return M[+ym.slice(5) - 1] + ' ' + ym.slice(0, 4);
    }
    api.backtestGrid().then((g) => {
      sel.innerHTML = g.coins.map((c) => '<option value="' + c.sym + '">' + c.sym + '/USDT</option>').join('');
      sel.value = S.coin;
      $('#bt-p-hold').textContent = g.period.days + ' дн.';
      L.onVisible($('#backtest'), run, '300px');
    });
    L.autoSize(box, () => { if (last) render(last, true); });
  };

  // ---- 6. Стоп или усреднение: один ценовой путь, два бота ----
  SEC.compare = function () {
    const S = { drop: 8, after: 'rebound', gap: false };
    const box = $('#cmp-chart'), drop = $('#cmp-drop');
    L.rangeFill(drop);
    drop.addEventListener('input', () => { S.drop = +drop.value; render(); });
    L.radio($('#cmp-after'), (v) => { S.after = v; render(); });
    $('#cmp-gap').addEventListener('change', (e) => { S.gap = e.target.checked; render(); });

    const DEP = 1000, FEE = 0.0006;
    const LV = [0, 2, 4, 6, 8, 10].map((x) => 100 - x), SZ = LV.map((_, k) => 60 * Math.pow(1.3, k));
    const DCA_STOP = LV[5] * 0.95;
    const ease = (u) => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2);
    function pricePath(X, rebound) {
      const N = 180, out = [], trough = 100 - X;
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        const w = (0.32 * Math.sin(t * 41) + 0.22 * Math.sin(t * 97 + 1.3)) * Math.sin(Math.PI * Math.min(1, t * 1.6)) * (0.5 + X / 25);
        let p;
        if (t <= 0.5) p = Math.max(trough, 100 - X * ease(t / 0.5) + w);
        else { const u = (t - 0.5) / 0.5; p = rebound ? trough + (102 - trough) * ease(u) + w * (1 - u) : Math.max(trough - 1.2, trough - 1.2 * u + w * 0.6); }
        out.push([t, i === 0 ? 100 : p]);
      }
      return out;
    }
    function dca(path, slip) {
      let k = 0, qty = SZ[0] / LV[0], cost = SZ[0], fee = SZ[0] * FEE, open = true, res = null, how = '', worst = 0, maxCost = cost;
      const fills = [[0, LV[0]]];
      let exit = null, lastFill = 0;
      for (let i = 1; i < path.length && open; i++) {
        const t = path[i][0], p = path[i][1];
        while (k < 5 && p <= LV[k + 1]) { k++; qty += SZ[k] / LV[k]; cost += SZ[k]; fee += SZ[k] * FEE; fills.push([t, LV[k]]); lastFill = t; maxCost = cost; }
        const avg = cost / qty, tp = avg * 1.015;
        worst = Math.min(worst, qty * p - cost - fee);
        if (p >= tp) { const pr = qty * tp; fee += pr * FEE; res = pr - cost - fee; open = false; how = 'tp'; exit = [t, tp]; }
        else if (k === 5 && p <= DCA_STOP) { const ex = DCA_STOP * (1 - slip); const pr = qty * ex; fee += pr * FEE; res = pr - cost - fee; worst = Math.min(worst, res); open = false; how = 'sl'; exit = [t, ex]; }
      }
      const pe = path[path.length - 1][1];
      if (open) { res = qty * pe - cost - fee; how = 'open'; }
      return { k: k + 1, res, how, worst, maxCost, fills, exit, avg: cost / qty, lastFill, qty, cost };
    }
    // CHM: стоп −1,5% (типичный стоп из планировщика), риск 1% = $10 → позиция $667, тейк 2R = +3%
    const SL = 98.5, TP = 103, QTY = 10 / 1.5;
    function chm(path, slip) {
      const qty = QTY, fee0 = qty * 100 * FEE;
      let worst = 0, res = null, how = 'open', exit = null;
      for (let i = 1; i < path.length; i++) {
        const t = path[i][0], p = path[i][1];
        if (p <= SL) { const ex = SL * (1 - slip); res = qty * (ex - 100) - fee0 - qty * ex * FEE; worst = Math.min(worst, res); how = 'sl'; exit = [t, ex]; break; }
        if (p >= TP) { res = qty * (TP - 100) - fee0 - qty * TP * FEE; how = 'tp'; exit = [t, TP]; break; }
        worst = Math.min(worst, qty * (p - 100) - fee0);
      }
      if (how === 'open') res = qty * (path[path.length - 1][1] - 100) - fee0;
      return { res, how, worst, exit };
    }
    // худший случай DCA заранее: вся сетка + стоп после неё
    function dcaMaxLoss(slip) {
      let q = 0, c = 0, f = 0;
      LV.forEach((l, k) => { q += SZ[k] / l; c += SZ[k]; f += SZ[k] * FEE; });
      const ex = DCA_STOP * (1 - slip);
      return q * ex - c - f - q * ex * FEE;
    }
    const pctD = (usd) => L.pct(usd / DEP * 100, 1);
    function render() {
      $('#cmp-drop-out').textContent = S.drop + '%';
      const path = pricePath(S.drop, S.after === 'rebound');
      const slipC = S.gap ? 0.015 : 0.001, slipD = S.gap ? 0.015 : 0.001;
      const a = dca(path, slipD), b = chm(path, slipC);
      const lo = Math.min(-S.drop - 1.6, -3.2), hi = 3.6;
      const showDcaStop = DCA_STOP - 100 >= lo - 0.5;
      const hl = [];
      LV.slice(1).forEach((l, k) => { const hit = k + 1 < a.k; if (l - 100 >= lo) hl.push({ y: l - 100, cls: 'lvl-dca' + (hit ? ' hit' : ''), label: '#' + (k + 2), lx: 0.94, color: '#ffc24b' }); });
      hl.push({ y: SL - 100, cls: 'stop-chm', label: 'стоп CHM −1,5%', lx: 0.015, color: '#f6eef0' });
      if (S.after === 'rebound') hl.push({ y: TP - 100, cls: 'tp-chm', label: 'тейк CHM +3% (2R)', lx: 0.015, color: '#3df2a0' });
      if (showDcaStop) hl.push({ y: DCA_STOP - 100, cls: 'stop-dca', label: 'стоп DCA ' + L.pct(DCA_STOP - 100), lx: 0.015, color: '#ff7a8f' });
      if (a.k > 1) hl.push({ y: a.avg - 100, cls: 'avg', x0: a.lastFill, x1: a.exit ? a.exit[0] : 1, label: 'средняя DCA', lx: Math.min(0.8, a.lastFill + 0.01), color: '#ffc24b' });
      const marks = a.fills.map((f) => ({ x: f[0], y: f[1] - 100, cls: 'mk-dca', r: 3.5 }));
      marks.push({ x: 0, y: 0, cls: 'mk-chm', r: 4.5 });
      if (a.exit) marks.push({ x: a.exit[0], y: a.exit[1] - 100, cls: a.how === 'tp' ? 'mk-tp' : 'mk-x', r: 5 });
      if (b.exit) marks.push({ x: b.exit[0], y: b.exit[1] - 100, cls: b.how === 'tp' ? 'mk-tp' : 'mk-x', r: 5 });
      L.chart(box, {
        x0: 0, x1: 1, yMin: lo, yMax: hi, ticks: L.niceTicks(lo, hi, 5).filter((v) => v >= lo && v <= hi),
        series: [{ pts: path.map((p) => [p[0], p[1] - 100]), cls: 'px' }], hl, marks, yFmt: (v) => L.pct(v, 0),
        xLabels: [[0, 'вход'], [0.5, 'дно −' + S.drop + '%'], [1, S.after === 'rebound' ? 'отскок' : 'конец']],
        tip: (i, p) => 'цена ' + L.pct(p[1], 2) + ' от входа',
      });
      box.setAttribute('aria-label', 'Цена упала на ' + S.drop + '% ' + (S.after === 'rebound' ? 'и отскочила' : 'без отскока') + '. DCA: ' + L.usdS(a.res) + ', CHM: ' + L.R(b.res / 10));
      // DCA
      const D = (k, v) => L.odo($('[data-d="' + k + '"]'), v), Dt = (k, v) => { $('[data-d="' + k + '"]').textContent = v; };
      D('orders', a.k + ' из 6');
      D('pos', L.usd(a.maxCost)); Dt('pos-s', Math.round(a.maxCost / DEP * 100) + '% депозита в сделке');
      D('worst', L.usd(a.worst)); Dt('worst-s', pctD(a.worst) + ' депозита');
      D('res', L.usdS(a.res, 1));
      $('[data-d="res"]').className = 'ro-v odo ' + (a.res < 0 ? 'loss' : 'up');
      Dt('res-s', (a.how === 'tp' ? 'тейк +1,5% от средней · ' : a.how === 'sl' ? 'стоп после сетки · ' : 'сделка открыта, нереализованно · ') + pctD(a.res));
      // CHM
      const H = (k, v) => L.odo($('[data-c2="' + k + '"]'), v), Ht = (k, v) => { $('[data-c2="' + k + '"]').textContent = v; };
      H('worst', L.R(b.worst / 10)); Ht('worst-s', pctD(b.worst) + ' депозита');
      H('res', L.R(b.res / 10, 2));
      $('[data-c2="res"]').className = 'ro-v odo ' + (b.res < 0 ? 'loss' : 'up');
      Ht('res-s', (b.how === 'sl' ? (S.gap ? 'стоп с проскальзыванием 1,5% · ' : 'стоп −1R + комиссии и проскальзывание · ') : b.how === 'tp' ? 'тейк 2R · ' : 'сделка открыта, нереализованно · ') + pctD(b.res));
      $('#cmp-maxloss').textContent = pctD(dcaMaxLoss(slipD));
      // вывод без подтасовки
      let v;
      const dRes = a.res, cRes = b.res;
      if (dRes > cRes + 0.5) {
        v = '<b>Здесь впереди DCA:</b> ' + (a.how === 'tp' ? 'сетка докупила ' + a.k + ' ' + ord(a.k) + ' и закрылась тейком на ' + L.usdS(dRes, 1) + ', а CHM ' + (b.how === 'sl' ? 'вышел по стопу на ' + L.R(cRes / 10, 2) + '.' : 'пока в сделке.') : 'обе сделки в минусе, но у DCA меньше.') + ' Мелкие просадки с отскоком — сильная сторона усреднения.';
      } else if (cRes > dRes + 0.5) {
        v = '<b>Здесь стоп ограничил убыток:</b> CHM ' + L.R(cRes / 10, 2) + ' (' + pctD(cRes) + '), DCA ' + L.usdS(dRes, 1) + ' (' + pctD(dRes) + ')' + (a.how === 'open' ? ', и сделка DCA ещё открыта: в ней ' + Math.round(a.maxCost / DEP * 100) + '% депозита.' : '.') + (S.gap ? ' С гэпом стоп CHM тоже исполнился хуже плана.' : '');
      } else v = '<b>Почти вничью:</b> разница меньше доллара. Решает то, что будет дальше.';
      $('#cmp-verdict').innerHTML = v;
    }
    function ord(k) { return k === 1 ? 'ордер' : k < 5 ? 'ордера' : 'ордеров'; }
    L.onVisible($('#compare'), render, '300px');
    L.autoSize(box, render);
  };

  // ---- 7. Genome: популяция на карте двух параметров ----
  SEC.genome = function () {
    const cv = $('#gn-canvas'), ctx = cv.getContext('2d');
    const GENS = 24, POP = 10;
    // условная карта фитнеса: глобальный пик + ложный локальный
    const fit = (x, y) => 0.08 + 0.53 * (Math.exp(-((x - 0.7) ** 2 + (y - 0.32) ** 2) / 0.03) + 0.62 * Math.exp(-((x - 0.24) ** 2 + (y - 0.72) ** 2) / 0.02) + 0.12 * Math.sin(x * 9) * Math.cos(y * 7) * 0.5);
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    const gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-9, rnd()))) * Math.cos(2 * Math.PI * rnd());
    let pop = [], prev = [], gen = 0, best = [], anim = 0, t0 = 0, timer = 0, heat = null, W = 0, H = 0, running = false;
    function heatmap() {
      const c = document.createElement('canvas'); c.width = 80; c.height = 50;
      const x = c.getContext('2d'), img = x.createImageData(80, 50);
      for (let j = 0; j < 50; j++) for (let i = 0; i < 80; i++) {
        const f = Math.max(0, Math.min(1, (fit(i / 79, j / 49) - 0.05) / 0.6)), k = (j * 80 + i) * 4;
        img.data[k] = 120 + 60 * f; img.data[k + 1] = 40 + 30 * f; img.data[k + 2] = 200 + 40 * f; img.data[k + 3] = 26 + 150 * f * f;
      }
      x.putImageData(img, 0, 0); return c;
    }
    function size() {
      const r = cv.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
      W = Math.max(200, r.width); H = W * 10 / 16;
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    function reset() {
      seed = 7; gen = 0; best = [];
      pop = []; for (let i = 0; i < POP; i++) pop.push({ x: 0.05 + 0.9 * rnd(), y: 0.05 + 0.9 * rnd() });
      pop.forEach((p) => { p.f = fit(p.x, p.y); });
      prev = pop.map((p) => ({ x: p.x, y: p.y }));
      best.push(Math.max(...pop.map((p) => p.f)));
      readouts();
    }
    function evolve() {
      const s = pop.slice().sort((a, b) => b.f - a.f);
      const sigma = 0.16 * (1 - gen / GENS) + 0.025;
      const next = [{ x: s[0].x, y: s[0].y, elite: true }, { x: s[1].x, y: s[1].y, elite: true }];
      const pick = () => { let b = null; for (let k = 0; k < 3; k++) { const c = s[Math.floor(rnd() * s.length)]; if (!b || c.f > b.f) b = c; } return b; };
      while (next.length < POP) {
        const a = pick(), b = pick(), w = rnd();
        next.push({ x: Math.min(0.98, Math.max(0.02, a.x * w + b.x * (1 - w) + sigma * gauss())), y: Math.min(0.98, Math.max(0.02, a.y * w + b.y * (1 - w) + sigma * gauss())) });
      }
      next.forEach((p) => { p.f = fit(p.x, p.y); });
      prev = pop.map((p) => ({ x: p.x, y: p.y }));
      pop = next; gen++;
      best.push(Math.max(best[best.length - 1], ...pop.map((p) => p.f)));
    }
    function readouts() {
      L.odo($('#gn-gen'), String(gen));
      L.odo($('#gn-best'), L.num(best[best.length - 1], 2));
      $('#gn-med').textContent = 'медиана популяции ' + L.num(L.median(pop.map((p) => p.f)), 2);
      const pts = best.map((v, i) => [i, v]);
      const d = L.pathD(pts, (i) => i / GENS * 120, (v) => 33 - (v - 0.1) / 0.55 * 31);
      $('#gn-spark .ln').setAttribute('d', d);
      $('#gn-state').textContent = gen >= GENS ? 'готово · кандидат → проверка на отложенном периоде' : running ? 'эволюция · поколение ' + gen : 'пауза';
    }
    function draw(k) {
      ctx.clearRect(0, 0, W, H);
      if (!heat) heat = heatmap();
      ctx.imageSmoothingEnabled = true; ctx.globalAlpha = 1;
      ctx.drawImage(heat, 0, 0, W, H);
      ctx.strokeStyle = 'rgba(255,255,255,.05)'; ctx.lineWidth = 1;
      for (let i = 1; i < 8; i++) { ctx.beginPath(); ctx.moveTo(i * W / 8, 0); ctx.lineTo(i * W / 8, H); ctx.stroke(); }
      for (let j = 1; j < 5; j++) { ctx.beginPath(); ctx.moveTo(0, j * H / 5); ctx.lineTo(W, j * H / 5); ctx.stroke(); }
      const e = k < 1 ? 1 - Math.pow(1 - k, 3) : 1;
      pop.forEach((p, i) => {
        const o = prev[i] || p, x = (o.x + (p.x - o.x) * e) * W, y = (o.y + (p.y - o.y) * e) * H;
        ctx.strokeStyle = 'rgba(233,217,255,.18)'; ctx.beginPath(); ctx.moveTo(o.x * W, o.y * H); ctx.lineTo(x, y); ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, p.elite ? 5.5 : 4, 0, Math.PI * 2);
        ctx.fillStyle = p.elite ? '#ffffff' : '#c9a8ff'; ctx.shadowColor = 'rgba(168,85,247,.9)'; ctx.shadowBlur = 10; ctx.fill(); ctx.shadowBlur = 0;
        if (p.elite) { ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke(); }
      });
      const b = pop.reduce((a, p) => (p.f > a.f ? p : a), pop[0]);
      ctx.strokeStyle = 'rgba(255,42,77,.8)'; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(b.x * W, 0); ctx.lineTo(b.x * W, H); ctx.moveTo(0, b.y * H); ctx.lineTo(W, b.y * H); ctx.stroke(); ctx.setLineDash([]);
    }
    function frame(ts) {
      const k = Math.min(1, (ts - t0) / 650);
      draw(k);
      if (k < 1) anim = requestAnimationFrame(frame);
    }
    function step() {
      if (gen >= GENS) return;
      evolve(); readouts();
      if (L.reduced) draw(1); else { cancelAnimationFrame(anim); t0 = performance.now(); anim = requestAnimationFrame(frame); }
    }
    function play() {
      clearInterval(timer); running = true;
      timer = setInterval(() => { if (document.hidden) return; step(); if (gen >= GENS) { clearInterval(timer); running = false; readouts(); } }, 900);
    }
    $('#gn-step').addEventListener('click', () => { clearInterval(timer); running = false; step(); readouts(); });
    $('#gn-replay').addEventListener('click', () => { clearInterval(timer); reset(); draw(1); if (!L.reduced) play(); });
    size(); reset(); draw(1);
    window.addEventListener('resize', () => { size(); draw(1); });
    if (L.reduced) { while (gen < GENS) evolve(); readouts(); draw(1); }
    else L.onVisible($('#gn-canvas'), play, '-15% 0px -15% 0px');

    api.genome().then((g) => {
      const N = { LEVELS: 'Уровни', SMC: 'SMC', VOLUME: 'Объём + MA' }, HC = { passed: 'пройдена', failed: 'не пройдена', pending: 'идёт' };
      $('#gn-upd').textContent = 'обн. ' + L.date(g.updated_at);
      $('#gn-table tbody').innerHTML = g.strategies.map((s) => '<tr><td>' + N[s.id] + ' · ' + s.tf + '</td><td>' + L.dm(s.last_run) + ' ' + L.time(s.last_run) + '</td><td>' + L.num(s.best_fitness, 2) + ' <span class="dim">(было ' + L.num(s.prev_fitness, 2) + ')</span></td><td><span class="hc ' + s.holdout_check + '">' + HC[s.holdout_check] + '</span></td></tr>').join('') +
        '<tr><td colspan="4" class="dim">' + (g.auto_apply_bots ? '' : 'Для ботов автоприменение выключено: новые параметры приходят черновиком.') + '</td></tr>';
    });
  };

  // ---- 8. Планировщик челленджа (та же математика, что challenge.plan, без цели по умолчанию) ----
  SEC.planner = function () {
    const S = { kind: 'pct', term: 30, lev: 3, medDay: null };
    const dep = $('#pl-dep'), goal = $('#pl-goal'), risk = $('#pl-risk'), trades = $('#pl-trades'), limit = $('#pl-limit');
    L.rangeFill(risk);
    L.radio($('#pl-goalkind'), (v) => { S.kind = v; render(); });
    L.radio($('#pl-term'), (v) => { S.term = +v; render(); });
    L.radio($('#pl-lev'), (v) => { S.lev = +v; render(); });
    [dep, goal, risk, trades, limit].forEach((el) => el.addEventListener('input', render));
    const TYPICAL_SL = 1.5, EMPTY = $('#pl-empty').innerHTML;
    function render() {
      const r = +risk.value, d = parseFloat(dep.value), g = parseFloat(goal.value);
      $('#pl-risk-out').textContent = L.num(r, 2) + '%';
      const dd = d > 0 ? d : 1000;
      const r1 = dd * r / 100;
      $('[data-p="dep"]').textContent = L.usd(dd) + (d > 0 ? '' : ' (пример)');
      $('[data-p="risk"]').textContent = L.num(r, 2) + '%';
      $('[data-p="r1"]').textContent = L.usd(r1, r1 < 10 ? 2 : 0);
      const ok = g > 0 && (S.kind === 'pct' || d > 0);
      $('#pl-empty').hidden = ok;
      $('#pl-res').hidden = !ok;
      if (!ok) { $('#pl-empty').innerHTML = g > 0 ? '<b>Нужен депозит.</b> Цель в долларах переводится в R только через депозит и риск.' : EMPTY; return; }
      const profit = S.kind === 'pct' ? dd * g / 100 : g;
      const rNeed = profit / r1;
      const rDay = S.term ? rNeed / S.term : null;
      L.odo($('#pl-o-goal'), L.num(rNeed, rNeed < 10 ? 1 : 0) + 'R');
      $('#pl-o-goal-s').textContent = L.usd(profit) + ' = ' + L.pct(profit / dd * 100) + ' депозита';
      L.odo($('#pl-o-day'), rDay === null ? '—' : L.num(rDay, 2) + 'R');
      $('#pl-o-day-s').textContent = rDay === null ? 'без срока' : '≈ ' + L.usd(rDay * r1, 2) + ' в день · ' + S.term + ' дн.';
      const med = S.medDay;
      L.odo($('#pl-o-med'), med === null ? '…' : L.num(med, 2) + 'R');
      // вердикт по статистике витрины (медиана ботов за 30 дней)
      const v = $('#pl-verdict');
      if (med === null) { v.className = 'verdict'; v.textContent = 'Загружаем статистику витрины…'; }
      else if (med <= 0) { v.className = 'verdict negative'; v.innerHTML = 'Медиана ботов витрины за 30 дней в минусе — прогноза по сроку нет.'; }
      else {
        const days = Math.round(rNeed / med);
        let cls, txt;
        if (!S.term) { cls = 'ok'; txt = 'Без срока: при темпе медианного бота витрины цель займёт около <b>' + days + ' дн.</b>'; }
        else if (days <= S.term) { cls = 'ok'; txt = 'По статистике витрины цель достижима: медианный бот набрал бы её примерно за <b>' + days + ' дн.</b> из ' + S.term + '.'; }
        else if (days <= S.term * 2) { cls = 'tight'; txt = 'На грани: нужен темп вдвое выше медианного бота. Прогноз <b>' + days + ' дн.</b> при сроке ' + S.term + '.'; }
        else { cls = 'unrealistic'; txt = 'В этот срок цель не достижима по статистике витрины: медианному боту понадобилось бы около <b>' + days + ' дн.</b> Уменьшите цель или увеличьте срок, а не риск.'; }
        v.className = 'verdict ' + cls; v.innerHTML = txt + ' <span class="dim">Это трек сигналов (бумажный) и прошлое, а не обещание.</span>';
      }
      // предупреждения — те же правила, что в challenge.plan бота
      const w = [];
      if (r >= 3) w.push('риск ≥ 3%: пять стопов подряд = ' + L.pct(-5 * r, 0) + ' депозита');
      if (100 / Math.max(1, S.lev) < 2 * TYPICAL_SL) w.push('при плече ' + S.lev + '× ликвидация ближе двух стопов');
      const margin = (r / 100) / (TYPICAL_SL / 100) / Math.max(1, S.lev) * 100;
      if (margin > 100) w.push('позиция по плану не влезает в депозит при типичном стопе 1,5% (маржа ' + Math.round(margin) + '%)');
      const lim = parseFloat(limit.value);
      if (lim > 0 && lim < 1) w.push('дневной лимит убытка меньше одного стопа');
      $('#pl-warns').innerHTML = w.map((x) => '<li>' + L.esc(x) + '</li>').join('');
      const tr = parseInt(trades.value, 10) || 0;
      $('#pl-disc').innerHTML = 'Дисциплина: не больше <b>' + tr + '</b> сделок в день; после <b>' + L.R(-(lim || 0), 1) + '</b> за день (' + L.usd(-(lim || 0) * r1) + ') новые входы на паузе до завтра.';
    }
    api.stats().then((s) => { S.medDay = s.bots_30d.median_r / 30; render(); });
    render();
  };

  // ---- 9. Калькулятор оплаты: прибыль 0 по умолчанию, минусовый месяц, перенос убытка ----
  SEC.pricing = function () {
    const inp = $('#pr-profit'), rng = $('#pr-profit-r'), carry = $('#pr-carry');
    L.rangeFill(rng);
    const sync = (v) => { inp.value = v; rng.value = Math.max(+rng.min, Math.min(+rng.max, v)); rng.dispatchEvent(new Event('input')); };
    inp.addEventListener('input', render);
    rng.addEventListener('input', () => { if (+inp.value !== +rng.value && document.activeElement === rng) inp.value = rng.value; render(); });
    carry.addEventListener('input', render);
    $$('.calc [data-step]').forEach((b) => b.addEventListener('click', () => { sync((parseFloat(inp.value) || 0) + +b.getAttribute('data-step')); render(); }));
    function render() {
      const P = parseFloat(inp.value) || 0, Cr = Math.max(0, parseFloat(carry.value) || 0);
      if (document.activeElement !== rng) rng.value = Math.max(+rng.min, Math.min(+rng.max, P));
      rng.style.setProperty('--p', ((rng.value - rng.min) / (rng.max - rng.min) * 100) + '%');
      const base = P - Cr;
      let fee = 0, next = Cr, say;
      if (P < 0) { next = Cr - P; say = 'Месяц в минусе: начислено <b>$0</b>, убыток ' + L.usd(-P) + ' переносится на следующий месяц.'; }
      else if (P === 0) { say = 'Прибыли нет — за месяц <b>$0</b>. Подписка в этом месяце стоила бы $69.'; }
      else if (base <= 0) { next = -base; say = 'Прибыль ушла на покрытие прошлого убытка: начислено <b>$0</b>, осталось перенести ' + L.usd(next) + '.'; }
      else {
        fee = Math.min(0.2 * base, 69); next = 0;
        say = fee >= 69 ? 'Достигнут потолок: <b>$69</b>, как подписка. Больше не берём, сколько бы ни заработали боты.' : 'За результат выходит <b>' + L.usd(fee, 2) + '</b> — на ' + L.usd(69 - fee, 2) + ' дешевле подписки.';
      }
      $('#pr-base').textContent = L.usd(Math.max(0, base), 0);
      L.odo($('#pr-res'), L.usd(fee, fee % 1 ? 2 : 0));
      L.odo($('#pr-carry-next'), L.usd(next));
      $('#pr-say').innerHTML = say;
    }
    render();
  };
})();
