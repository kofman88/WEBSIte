/* CHM ops back-office — staff only. All calls go through /api/admin/* which
 * requires admin JWT on the server. Client-side gate is UX only; the hard
 * guarantee is server-side.
 */

(function opsBoot() {
  function esc(s) { return String(s || '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function money(n) { return Fmt.currency(Number(n) || 0); }
  function pct(n, d) { return Fmt.percent(Number(n) || 0, { decimals: d || 1 }); }
  function fmtDate(d) { try { return new Date(d).toLocaleString('ru-RU'); } catch (_e) { return d || '—'; } }
  function fmtDateShort(d) { try { return new Date(d).toLocaleDateString('ru-RU'); } catch (_e) { return d || '—'; } }
  function duration(sec) {
    if (!sec) return '0s';
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    if (d) return d + 'd ' + h + 'h';
    if (h) return h + 'h ' + m + 'm';
    return m + 'm ' + (sec % 60) + 's';
  }
  window.Ops = { esc, money, pct, fmtDate, fmtDateShort, duration };

  // ── Access gate ───────────────────────────────────────────────────────
  async function gate() {
    if (!Auth.isLoggedIn()) { location.replace('/?login=1&next=/ops.html'); return false; }
    try {
      const r = await API.me();
      const u = r.user || r;
      if (!u.isAdmin) { location.replace('/dashboard.html'); return false; }
      const emailEl = document.getElementById('opsAdminEmail');
      if (emailEl) emailEl.textContent = u.email;
      return true;
    } catch (e) {
      location.replace('/?login=1'); return false;
    }
  }

  // ── Tab switching ─────────────────────────────────────────────────────
  const loaders = {};
  function activateTab(tab) {
    document.querySelectorAll('.ops-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.ops-pane').forEach((p) => p.classList.toggle('active', p.id === 'pane-' + tab));
    if (loaders[tab]) loaders[tab]();
    history.replaceState({}, '', '/ops.html#' + tab);
  }
  window.Ops.activateTab = activateTab;
  window.Ops.registerLoader = (tab, fn) => { loaders[tab] = fn; };

  // ── Dashboard ─────────────────────────────────────────────────────────
  async function loadDashboard() {
    const pane = document.getElementById('pane-dash');
    pane.innerHTML = '<div class="text-center py-12 text-slate-500 text-sm">Загрузка…</div>';
    try {
      const d = await API.opsDashboard();
      pane.innerHTML = `
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <div class="ops-card kpi"><div class="kpi-label">MRR</div><div class="kpi-value mono">${money(d.revenue.mrr)}</div><div class="kpi-sub">Активных подписок</div></div>
          <div class="ops-card kpi"><div class="kpi-label">Revenue · 24h</div><div class="kpi-value mono">${money(d.revenue.last24h)}</div><div class="kpi-sub">30d: ${money(d.revenue.last30d)}</div></div>
          <div class="ops-card kpi"><div class="kpi-label">Revenue · total</div><div class="kpi-value mono">${money(d.revenue.lifetime)}</div><div class="kpi-sub">Lifetime</div></div>
          <div class="ops-card kpi"><div class="kpi-label">Users</div><div class="kpi-value mono">${d.users.total}</div><div class="kpi-sub">+${d.users.new24h} за 24h</div></div>
        </div>

        <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <div class="ops-card kpi"><div class="kpi-label">DAU</div><div class="kpi-value mono">${d.users.dau}</div></div>
          <div class="ops-card kpi"><div class="kpi-label">WAU</div><div class="kpi-value mono">${d.users.wau}</div></div>
          <div class="ops-card kpi"><div class="kpi-label">MAU</div><div class="kpi-value mono">${d.users.mau}</div></div>
          <div class="ops-card kpi"><div class="kpi-label">Bots · active</div><div class="kpi-value mono">${d.bots.active}/${d.bots.total}</div><div class="kpi-sub">${d.bots.autotrading} auto</div></div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
          <div class="ops-card">
            <div class="kpi-label mb-2">Trades</div>
            <div class="dl-pair"><span class="k">Open now</span><span class="v">${d.trades.open}</span></div>
            <div class="dl-pair"><span class="k">Opened · 24h</span><span class="v">${d.trades.openedLast24h}</span></div>
            <div class="dl-pair"><span class="k">Closed · 24h</span><span class="v">${d.trades.closedLast24h}</span></div>
          </div>
          <div class="ops-card">
            <div class="kpi-label mb-2">Support queue</div>
            <div class="dl-pair"><span class="k">Open</span><span class="v">${d.support.open} <span class="${d.support.open > 5 ? 'text-red-400' : 'text-slate-500'}">${d.support.open > 5 ? '⚠' : ''}</span></span></div>
            <div class="dl-pair"><span class="k">Pending</span><span class="v">${d.support.pending}</span></div>
            <div class="dl-pair"><span class="k">New · 24h</span><span class="v">${d.support.new24h}</span></div>
          </div>
          <div class="ops-card">
            <div class="kpi-label mb-2">Pipeline</div>
            <div class="dl-pair"><span class="k">Signals · 24h</span><span class="v">${d.pipeline.signalsToday}</span></div>
            <div class="dl-pair"><span class="k">Payments pending</span><span class="v">${d.pipeline.paymentsPending}</span></div>
            <div class="dl-pair"><span class="k">Ref rewards pending</span><span class="v">${d.pipeline.refRewardsPending.count} · ${money(d.pipeline.refRewardsPending.amountUsd)}</span></div>
          </div>
        </div>

        <div class="text-xs text-slate-500 text-center mt-4">Обновлено ${fmtDate(new Date())}</div>
      `;
    } catch (e) {
      pane.innerHTML = `<div class="text-center py-12 text-red-400 text-sm">${esc(e.message || 'Ошибка')}</div>`;
    }
  }
  loaders.dash = loadDashboard;

  // ── Boot ──────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', async () => {
    const ok = await gate();
    if (!ok) return;
    document.getElementById('opsGate').style.display = 'none';
    document.getElementById('opsApp').style.display = 'block';

    document.querySelectorAll('.ops-tab').forEach((b) => b.addEventListener('click', () => activateTab(b.dataset.tab)));

    const initial = (location.hash || '').replace('#', '') || 'dash';
    activateTab(initial);
  });
})();
