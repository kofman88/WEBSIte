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

        <div class="ops-card mb-4">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <div class="kpi-label">Revenue · Новые юзеры · Платежи</div>
            <div style="display:flex;gap:4px">
              <button class="ops-btn revSeg" data-days="7">7d</button>
              <button class="ops-btn revSeg" data-days="30">30d</button>
              <button class="ops-btn revSeg" data-days="90">90d</button>
            </div>
          </div>
          <div style="position:relative;height:260px;overflow:hidden">
            <canvas id="revChart" style="display:block;max-width:100%;max-height:100%"></canvas>
          </div>
        </div>

        <div class="text-xs text-slate-500 text-center mt-4">Обновлено ${fmtDate(new Date())}</div>
      `;
      document.querySelectorAll('.revSeg').forEach((btn) => btn.addEventListener('click', () => loadRevenueChart(+btn.dataset.days)));
      loadRevenueChart(30);
    } catch (e) {
      pane.innerHTML = `<div class="text-center py-12 text-red-400 text-sm">${esc(e.message || 'Ошибка')}</div>`;
    }
  }
  loaders.dash = loadDashboard;

  let _revChart = null;
  async function loadRevenueChart(days) {
    try {
      const r = await API.adminRevenueSeries(days);
      const ctx = document.getElementById('revChart');
      if (!ctx) return;
      if (_revChart) _revChart.destroy();
      const labels = r.points.map((p) => p.day.slice(5));
      _revChart = new Chart(ctx, {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              label: 'Revenue, $', data: r.points.map((p) => p.revenue),
              borderColor: '#4ade80', backgroundColor: 'rgba(34,197,94,.15)',
              fill: true, tension: .35, borderWidth: 2, pointRadius: 0, yAxisID: 'y',
            },
            {
              label: 'Новые юзеры', data: r.points.map((p) => p.newUsers),
              borderColor: '#93c5fd', backgroundColor: 'transparent',
              borderWidth: 1.5, tension: .35, pointRadius: 0, yAxisID: 'y1',
            },
            {
              label: 'Платежей', data: r.points.map((p) => p.payments),
              borderColor: '#fde047', backgroundColor: 'transparent',
              borderDash: [4, 4], borderWidth: 1.5, tension: .35, pointRadius: 0, yAxisID: 'y1',
            },
          ],
        },
        options: {
          responsive: true, maintainAspectRatio: false, resizeDelay: 150, animation: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { labels: { color: 'rgba(255,255,255,.6)', font: { size: 11 }, usePointStyle: true } },
            tooltip: {
              backgroundColor: 'rgba(0,0,0,.85)', borderColor: 'rgba(255,255,255,.1)', borderWidth: 1,
              callbacks: { label: (ctx) => ctx.dataset.label + ': ' + (ctx.dataset.yAxisID === 'y' ? money(ctx.parsed.y) : ctx.parsed.y) },
            },
          },
          scales: {
            x: { ticks: { color: 'rgba(255,255,255,.35)', font: { size: 10 }, maxTicksLimit: 8 }, grid: { display: false } },
            y: { position: 'left',  ticks: { color: 'rgba(255,255,255,.35)', font: { size: 10 }, callback: (v) => '$' + v }, grid: { color: 'rgba(255,255,255,.04)' } },
            y1: { position: 'right', ticks: { color: 'rgba(255,255,255,.35)', font: { size: 10 } }, grid: { display: false } },
          },
        },
      });
    } catch (_e) { /* silent — KPI card still shows */ }
  }

  // ── Users ─────────────────────────────────────────────────────────────
  let _usersSearch = '';
  async function loadUsers() {
    const pane = document.getElementById('pane-users');
    pane.innerHTML = `
      <div class="ops-card mb-4" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <input id="usersQ" class="ops-input" placeholder="Поиск по email / ref-коду…" value="${esc(_usersSearch)}" style="flex:1;min-width:240px"/>
        <button class="ops-btn ops-btn-primary" id="usersBtn">Искать</button>
      </div>
      <div class="ops-card" style="padding:0;overflow:auto">
        <table class="ops-table">
          <thead><tr>
            <th>Email</th><th>Plan</th><th>2FA</th><th>Bots</th><th>Trades</th><th>$</th><th>Registered</th><th>Last login</th><th></th>
          </tr></thead>
          <tbody id="usersTb"><tr><td colspan="9" class="text-center py-8 text-slate-500">Загрузка…</td></tr></tbody>
        </table>
      </div>
    `;
    document.getElementById('usersBtn').addEventListener('click', () => {
      _usersSearch = document.getElementById('usersQ').value.trim(); loadUsers();
    });
    document.getElementById('usersQ').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { _usersSearch = e.target.value.trim(); loadUsers(); }
    });
    try {
      const data = await API.adminListUsers({ search: _usersSearch, limit: 200 });
      const rows = (data.users || []).map((u) => {
        const planBadge = u.plan === 'free' ? 'badge-gray' : u.plan === 'elite' ? 'badge-blue' : 'badge-yellow';
        const adminTag = u.isAdmin ? ' <span class="badge badge-red">ADMIN</span>' : '';
        const blockedTag = !u.isActive ? ' <span class="badge badge-red">BLOCKED</span>' : '';
        return `<tr style="cursor:pointer" data-uid="${u.id}">
          <td class="mono">${esc(u.email)}${adminTag}${blockedTag}</td>
          <td><span class="badge ${planBadge}">${u.plan}</span></td>
          <td>${u.twoFactor && u.twoFactor.enabled ? '<span class="badge badge-green">ON</span>' : '<span class="text-slate-600">—</span>'}</td>
          <td class="mono">${u.botCount || 0}</td>
          <td class="mono">${u.tradeCount || 0}</td>
          <td class="mono">${u.paidCount || 0}</td>
          <td class="mono text-xs text-slate-500">${fmtDateShort(u.createdAt)}</td>
          <td class="mono text-xs text-slate-500">${u.lastLoginAt ? fmtDateShort(u.lastLoginAt) : '—'}</td>
          <td><button class="ops-btn">Открыть →</button></td>
        </tr>`;
      }).join('');
      document.getElementById('usersTb').innerHTML = rows || '<tr><td colspan="9" class="text-center py-8 text-slate-500">Нет результатов</td></tr>';
      document.querySelectorAll('#usersTb tr[data-uid]').forEach((tr) => tr.addEventListener('click', () => openUser(+tr.dataset.uid)));
    } catch (e) {
      document.getElementById('usersTb').innerHTML = `<tr><td colspan="9" class="text-center py-8 text-red-400">${esc(e.message)}</td></tr>`;
    }
  }
  loaders.users = loadUsers;

  // ── User detail drawer ────────────────────────────────────────────────
  async function openUser(userId) {
    document.getElementById('drawerBg').classList.add('open');
    document.getElementById('drawer').classList.add('open');
    const body = document.getElementById('drawerBody');
    body.innerHTML = '<div class="p-8 text-center text-slate-500 text-sm">Загрузка…</div>';
    try {
      const d = await API.adminUserDetail(userId);
      const u = d.user;
      const pnl = d.pnl;
      const pnlCls = pnl.totalPnl > 0 ? 'text-green-400' : pnl.totalPnl < 0 ? 'text-red-400' : '';
      body.innerHTML = `
        <div class="drawer-section">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
            <div>
              <div class="text-lg font-semibold">${esc(u.email)}${u.isAdmin ? ' <span class="badge badge-red">ADMIN</span>' : ''}${!u.isActive ? ' <span class="badge badge-red">BLOCKED</span>' : ''}</div>
              <div class="text-xs text-slate-500 mt-1">id: ${u.id} · ref ${esc(u.referralCode)} · <span class="mono">${fmtDate(u.createdAt)}</span></div>
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              <button class="ops-btn" onclick="Ops.notifyUser(${u.id})">📨 Notify</button>
              <button class="ops-btn" onclick="Ops.changePlan(${u.id})">Plan…</button>
              <button class="ops-btn ${u.isActive ? 'ops-btn-danger' : ''}" onclick="Ops.toggleActive(${u.id}, ${!u.isActive})">${u.isActive ? '🔒 Block' : '🔓 Unblock'}</button>
              <button class="ops-btn ${u.isAdmin ? 'ops-btn-danger' : 'ops-btn-primary'}" onclick="Ops.toggleAdminFlag(${u.id}, ${!u.isAdmin})">${u.isAdmin ? 'Revoke admin' : 'Grant admin'}</button>
            </div>
          </div>
        </div>

        <div class="drawer-section">
          <div class="kpi-label mb-2">Subscription</div>
          <div class="dl-pair"><span class="k">Plan</span><span class="v">${u.subscription.plan.toUpperCase()}</span></div>
          <div class="dl-pair"><span class="k">Status</span><span class="v">${u.subscription.status}</span></div>
          <div class="dl-pair"><span class="k">Expires</span><span class="v">${u.subscription.expiresAt ? fmtDate(u.subscription.expiresAt) : '—'}</span></div>
          <div class="dl-pair"><span class="k">Auto-renew</span><span class="v">${u.subscription.autoRenew ? 'yes' : 'no'}</span></div>
        </div>

        <div class="drawer-section">
          <div class="kpi-label mb-2">Security</div>
          <div class="dl-pair"><span class="k">Email verified</span><span class="v">${u.emailVerified ? '✓' : '—'}</span></div>
          <div class="dl-pair"><span class="k">2FA</span><span class="v">${u.twoFactor.enabled ? 'Enabled · ' + fmtDateShort(u.twoFactor.enabledAt) : 'Off'}</span></div>
          <div class="dl-pair"><span class="k">Last login</span><span class="v">${u.lastLoginAt ? fmtDate(u.lastLoginAt) : '—'}</span></div>
          <div class="dl-pair"><span class="k">Telegram</span><span class="v">${u.telegramUsername ? '@' + esc(u.telegramUsername) : '—'}</span></div>
          <div class="dl-pair"><span class="k">Public profile</span><span class="v">${u.publicProfile ? 'yes' : 'no'}</span></div>
        </div>

        <div class="drawer-section">
          <div class="kpi-label mb-2">Trading (${pnl.closedTrades} closed)</div>
          <div class="dl-pair"><span class="k">Total PnL</span><span class="v ${pnlCls} mono">${money(pnl.totalPnl)}</span></div>
          <div class="dl-pair"><span class="k">Wins / Losses</span><span class="v mono">${pnl.wins} / ${pnl.losses}</span></div>
          <div class="dl-pair"><span class="k">Win rate</span><span class="v mono">${pnl.winRate !== null ? pct(pnl.winRate * 100) : '—'}</span></div>
          <div class="dl-pair"><span class="k">Bots</span><span class="v mono">${d.bots.length}</span></div>
          <div class="dl-pair"><span class="k">Exchange keys</span><span class="v mono">${d.exchangeKeys.length}</span></div>
        </div>

        <div class="drawer-section">
          <div class="kpi-label mb-2">Bots · ${d.bots.length}</div>
          ${d.bots.length ? `<table class="ops-table"><thead><tr><th>Name</th><th>Strategy</th><th>Mode</th><th>Status</th></tr></thead><tbody>
            ${d.bots.slice(0, 10).map((b) => `<tr><td>${esc(b.name)}</td><td>${esc(b.strategy)}</td><td>${esc(b.trading_mode)}</td><td>${b.is_active ? '<span class="badge badge-green">active</span>' : '<span class="badge badge-gray">off</span>'}</td></tr>`).join('')}
          </tbody></table>` : '<div class="text-xs text-slate-600">Ботов нет</div>'}
        </div>

        <div class="drawer-section">
          <div class="kpi-label mb-2">Payments · ${d.payments.length}</div>
          ${d.payments.length ? `<table class="ops-table"><thead><tr><th>Date</th><th>Amount</th><th>Method</th><th>Plan</th><th>Status</th></tr></thead><tbody>
            ${d.payments.slice(0, 10).map((p) => `<tr><td class="text-xs">${fmtDateShort(p.created_at)}</td><td class="mono">${money(p.amount_usd)}</td><td>${esc(p.method)}</td><td>${esc(p.plan || '—')}</td><td><span class="badge ${p.status === 'confirmed' ? 'badge-green' : p.status === 'pending' ? 'badge-yellow' : 'badge-gray'}">${p.status}</span></td></tr>`).join('')}
          </tbody></table>` : '<div class="text-xs text-slate-600">Платежей нет</div>'}
        </div>

        <div class="drawer-section">
          <div class="kpi-label mb-2">Last logins</div>
          ${d.logins.length ? `<table class="ops-table"><thead><tr><th>When</th><th>IP</th><th>Success</th></tr></thead><tbody>
            ${d.logins.slice(0, 10).map((l) => `<tr><td class="text-xs">${fmtDate(l.created_at)}</td><td class="mono text-xs">${esc(l.ip_address || '—')}</td><td>${l.success ? '<span class="badge badge-green">ok</span>' : '<span class="badge badge-red">' + esc(l.code || 'fail') + '</span>'}</td></tr>`).join('')}
          </tbody></table>` : '<div class="text-xs text-slate-600">—</div>'}
        </div>

        <div class="drawer-section">
          <div class="kpi-label mb-2">Active sessions · ${d.sessions.filter((s) => s.active).length}</div>
          ${d.sessions.length ? `<table class="ops-table"><thead><tr><th>Issued</th><th>IP</th><th>Active</th></tr></thead><tbody>
            ${d.sessions.slice(0, 10).map((s) => `<tr><td class="text-xs">${fmtDate(s.created_at)}</td><td class="mono text-xs">${esc(s.ip_address || '—')}</td><td>${s.active ? '<span class="badge badge-green">yes</span>' : '<span class="badge badge-gray">revoked</span>'}</td></tr>`).join('')}
          </tbody></table>` : '<div class="text-xs text-slate-600">—</div>'}
        </div>

        <div class="drawer-section">
          <div class="kpi-label mb-2">Audit trail (last 20)</div>
          ${d.audit.length ? `<div style="max-height:240px;overflow:auto">${d.audit.slice(0, 20).map((a) => `<div style="padding:4px 0;font-size:11px;border-bottom:1px solid rgba(255,255,255,.03)"><span class="mono text-slate-500">${fmtDate(a.created_at)}</span> · <span class="mono">${esc(a.action)}</span>${a.entity_type ? ' · ' + esc(a.entity_type) + (a.entity_id ? '#' + a.entity_id : '') : ''}</div>`).join('')}</div>` : '<div class="text-xs text-slate-600">—</div>'}
        </div>
      `;
    } catch (e) {
      body.innerHTML = `<div class="p-8 text-center text-red-400 text-sm">${esc(e.message || 'Ошибка')}</div>`;
    }
  }
  window.Ops.openUser = openUser;
  window.closeDrawer = () => {
    document.getElementById('drawerBg').classList.remove('open');
    document.getElementById('drawer').classList.remove('open');
  };

  // Destructive actions — all confirmed, all audited server-side.
  window.Ops.toggleActive = async (id, newState) => {
    if (!confirm(newState ? 'Разблокировать пользователя?' : 'Заблокировать пользователя? Все сессии сразу завершатся.')) return;
    try { await API.adminSetUserActive(id, newState); Toast.success('OK'); openUser(id); loadUsers(); }
    catch (e) { Toast.error(e.message); }
  };
  window.Ops.toggleAdminFlag = async (id, newState) => {
    if (!confirm(newState ? 'Сделать пользователя админом? Даст полный доступ в ops.' : 'Снять admin-флаг?')) return;
    try { await API.adminSetUserAdmin(id, newState); Toast.success('OK'); openUser(id); loadUsers(); }
    catch (e) { Toast.error(e.message); }
  };
  window.Ops.changePlan = async (id) => {
    const plan = prompt('Новый план (free / starter / pro / elite)?', 'pro');
    if (!plan) return;
    const days = parseInt(prompt('На сколько дней?', '30'), 10);
    if (!days || days < 1) return;
    try { await API.adminSetUserPlan(id, plan.trim().toLowerCase(), days); Toast.success('План обновлён'); openUser(id); loadUsers(); }
    catch (e) { Toast.error(e.message); }
  };
  window.Ops.notifyUser = async (id) => {
    const title = prompt('Заголовок сообщения?');
    if (!title) return;
    const body = prompt('Текст сообщения?');
    if (!body) return;
    try { await API.adminNotifyUser(id, { type: 'system', title, body }); Toast.success('Отправлено: in-app + email + Telegram'); }
    catch (e) { Toast.error(e.message); }
  };

  // ── Bots (global) ─────────────────────────────────────────────────────
  let _botsFilter = '';
  async function loadBots() {
    const pane = document.getElementById('pane-bots');
    pane.innerHTML = `
      <div class="ops-card mb-4" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <select id="botsF" class="ops-input">
          <option value="">Все</option>
          <option value="active" ${_botsFilter === 'active' ? 'selected' : ''}>Active</option>
          <option value="inactive" ${_botsFilter === 'inactive' ? 'selected' : ''}>Inactive</option>
        </select>
        <button class="ops-btn" id="botsR">Обновить</button>
      </div>
      <div class="ops-card" style="padding:0;overflow:auto">
        <table class="ops-table">
          <thead><tr>
            <th>User</th><th>Name</th><th>Exchange</th><th>Symbols</th><th>Strategy</th><th>TF</th><th>Mode</th><th>Status</th><th>Trades</th><th>PnL</th><th>Last run</th>
          </tr></thead>
          <tbody id="botsTb"><tr><td colspan="11" class="text-center py-8 text-slate-500">Загрузка…</td></tr></tbody>
        </table>
      </div>
    `;
    document.getElementById('botsF').addEventListener('change', (e) => { _botsFilter = e.target.value; loadBots(); });
    document.getElementById('botsR').addEventListener('click', loadBots);
    try {
      const data = await API.adminListBots({ status: _botsFilter || undefined, limit: 300 });
      document.getElementById('botsTb').innerHTML = (data.bots || []).map((b) => {
        const pnl = Number(b.total_pnl) || 0;
        const pnlCls = pnl > 0 ? 'text-green-400' : pnl < 0 ? 'text-red-400' : 'text-slate-400';
        return `<tr style="cursor:pointer" onclick="Ops.openUser(${b.user_id})">
          <td class="mono text-xs">${esc(b.user_email)}</td>
          <td>${esc(b.name)}</td>
          <td>${esc(b.exchange)}</td>
          <td class="text-xs">${esc(b.symbols)}</td>
          <td>${esc(b.strategy)}</td>
          <td>${esc(b.timeframe)}</td>
          <td>${b.trading_mode === 'live' ? '<span class="badge badge-red">live</span>' : '<span class="badge badge-gray">paper</span>'}</td>
          <td>${b.is_active ? '<span class="badge badge-green">on</span>' : '<span class="badge badge-gray">off</span>'}${b.auto_trade ? ' <span class="badge badge-blue">auto</span>' : ''}</td>
          <td class="mono">${b.trade_count || 0}</td>
          <td class="mono ${pnlCls}">${money(pnl)}</td>
          <td class="mono text-xs text-slate-500">${b.last_run_at ? fmtDateShort(b.last_run_at) : '—'}</td>
        </tr>`;
      }).join('') || '<tr><td colspan="11" class="text-center py-8 text-slate-500">Нет ботов</td></tr>';
    } catch (e) {
      document.getElementById('botsTb').innerHTML = `<tr><td colspan="11" class="text-center py-8 text-red-400">${esc(e.message)}</td></tr>`;
    }
  }
  loaders.bots = loadBots;

  // ── Trades (global) ───────────────────────────────────────────────────
  let _tradesFilters = { status: '', mode: '' };
  async function loadTrades() {
    const pane = document.getElementById('pane-trades');
    pane.innerHTML = `
      <div class="ops-card mb-4" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <select id="trStatus" class="ops-input">
          <option value="">Все статусы</option>
          <option value="open" ${_tradesFilters.status === 'open' ? 'selected' : ''}>Open</option>
          <option value="closed" ${_tradesFilters.status === 'closed' ? 'selected' : ''}>Closed</option>
          <option value="cancelled" ${_tradesFilters.status === 'cancelled' ? 'selected' : ''}>Cancelled</option>
        </select>
        <select id="trMode" class="ops-input">
          <option value="">Все режимы</option>
          <option value="paper" ${_tradesFilters.mode === 'paper' ? 'selected' : ''}>Paper</option>
          <option value="live" ${_tradesFilters.mode === 'live' ? 'selected' : ''}>Live</option>
        </select>
        <button class="ops-btn" id="trR">Обновить</button>
      </div>
      <div class="ops-card" style="padding:0;overflow:auto">
        <table class="ops-table">
          <thead><tr>
            <th>Opened</th><th>User</th><th>Symbol</th><th>Side</th><th>Entry</th><th>Exit</th><th>PnL</th><th>%</th><th>Status</th><th>Mode</th>
          </tr></thead>
          <tbody id="trTb"><tr><td colspan="10" class="text-center py-8 text-slate-500">Загрузка…</td></tr></tbody>
        </table>
      </div>
    `;
    document.getElementById('trStatus').addEventListener('change', (e) => { _tradesFilters.status = e.target.value; loadTrades(); });
    document.getElementById('trMode').addEventListener('change', (e) => { _tradesFilters.mode = e.target.value; loadTrades(); });
    document.getElementById('trR').addEventListener('click', loadTrades);
    try {
      const data = await API.adminListTrades({
        status: _tradesFilters.status || undefined,
        mode: _tradesFilters.mode || undefined,
        limit: 300,
      });
      document.getElementById('trTb').innerHTML = (data.trades || []).map((t) => {
        const pnl = Number(t.realized_pnl) || 0;
        const pct = Number(t.realized_pnl_pct) || 0;
        const cls = pnl > 0 ? 'text-green-400' : pnl < 0 ? 'text-red-400' : 'text-slate-400';
        return `<tr style="cursor:pointer" onclick="Ops.openUser(${t.user_id})">
          <td class="mono text-xs text-slate-500">${fmtDateShort(t.opened_at)}</td>
          <td class="mono text-xs">${esc(t.user_email)}</td>
          <td>${esc(t.symbol)}</td>
          <td><span class="badge ${t.side === 'long' ? 'badge-green' : 'badge-red'}">${t.side}</span></td>
          <td class="mono text-xs">${esc(t.entry_price || '—')}</td>
          <td class="mono text-xs">${esc(t.exit_price || '—')}</td>
          <td class="mono ${cls}">${t.realized_pnl !== null ? money(pnl) : '—'}</td>
          <td class="mono ${cls}">${t.realized_pnl_pct !== null ? pct.toFixed(2) + '%' : '—'}</td>
          <td><span class="badge ${t.status === 'open' ? 'badge-yellow' : t.status === 'closed' ? 'badge-gray' : 'badge-red'}">${t.status}</span></td>
          <td>${t.trading_mode === 'live' ? '<span class="badge badge-red">live</span>' : '<span class="badge badge-gray">paper</span>'}</td>
        </tr>`;
      }).join('') || '<tr><td colspan="10" class="text-center py-8 text-slate-500">Нет сделок</td></tr>';
    } catch (e) {
      document.getElementById('trTb').innerHTML = `<tr><td colspan="10" class="text-center py-8 text-red-400">${esc(e.message)}</td></tr>`;
    }
  }
  loaders.trades = loadTrades;

  // ── Signals (global) ──────────────────────────────────────────────────
  let _signalsFilter = '';
  async function loadSignals() {
    const pane = document.getElementById('pane-signals');
    pane.innerHTML = `
      <div class="ops-card mb-4" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <input id="sigF" class="ops-input" placeholder="Стратегия (smc, dca, grid, tradingview…)" value="${esc(_signalsFilter)}"/>
        <button class="ops-btn" id="sigR">Обновить</button>
      </div>
      <div class="ops-card" style="padding:0;overflow:auto">
        <table class="ops-table">
          <thead><tr>
            <th>Created</th><th>User</th><th>Symbol</th><th>Side</th><th>Strategy</th><th>Entry</th><th>TP</th><th>SL</th><th>Result</th>
          </tr></thead>
          <tbody id="sigTb"><tr><td colspan="9" class="text-center py-8 text-slate-500">Загрузка…</td></tr></tbody>
        </table>
      </div>
    `;
    document.getElementById('sigF').addEventListener('change', (e) => { _signalsFilter = e.target.value.trim(); loadSignals(); });
    document.getElementById('sigR').addEventListener('click', loadSignals);
    try {
      const data = await API.adminListSignals({ strategy: _signalsFilter || undefined, limit: 300 });
      document.getElementById('sigTb').innerHTML = (data.signals || []).map((s) => {
        const resultBadge = s.result === 'tp' ? 'badge-green' : s.result === 'sl' ? 'badge-red' : s.result === 'expired' ? 'badge-gray' : 'badge-yellow';
        return `<tr ${s.user_id ? 'style="cursor:pointer" onclick="Ops.openUser(' + s.user_id + ')"' : ''}>
          <td class="mono text-xs text-slate-500">${fmtDate(s.created_at)}</td>
          <td class="mono text-xs">${s.user_email ? esc(s.user_email) : '<span class="text-slate-600">public</span>'}</td>
          <td>${esc(s.symbol)}</td>
          <td><span class="badge ${s.side === 'long' ? 'badge-green' : 'badge-red'}">${s.side}</span></td>
          <td>${esc(s.strategy)}</td>
          <td class="mono text-xs">${esc(s.entry || '—')}</td>
          <td class="mono text-xs">${esc(s.tp || '—')}</td>
          <td class="mono text-xs">${esc(s.sl || '—')}</td>
          <td><span class="badge ${resultBadge}">${s.result || 'pending'}</span></td>
        </tr>`;
      }).join('') || '<tr><td colspan="9" class="text-center py-8 text-slate-500">Нет сигналов</td></tr>';
    } catch (e) {
      document.getElementById('sigTb').innerHTML = `<tr><td colspan="9" class="text-center py-8 text-red-400">${esc(e.message)}</td></tr>`;
    }
  }
  loaders.signals = loadSignals;

  // ── Payments ──────────────────────────────────────────────────────────
  let _payFilters = { status: '', method: '' };
  async function loadPayments() {
    const pane = document.getElementById('pane-payments');
    pane.innerHTML = `
      <div class="ops-card mb-4" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <select id="pSt" class="ops-input">
          <option value="">Все</option>
          <option value="pending" ${_payFilters.status === 'pending' ? 'selected' : ''}>Pending</option>
          <option value="confirmed" ${_payFilters.status === 'confirmed' ? 'selected' : ''}>Confirmed</option>
          <option value="failed" ${_payFilters.status === 'failed' ? 'selected' : ''}>Failed</option>
          <option value="refunded" ${_payFilters.status === 'refunded' ? 'selected' : ''}>Refunded</option>
        </select>
        <select id="pMt" class="ops-input">
          <option value="">Все</option>
          <option value="stripe" ${_payFilters.method === 'stripe' ? 'selected' : ''}>Stripe</option>
          <option value="usdt_bep20" ${_payFilters.method === 'usdt_bep20' ? 'selected' : ''}>USDT BEP20</option>
          <option value="usdt_trc20" ${_payFilters.method === 'usdt_trc20' ? 'selected' : ''}>USDT TRC20</option>
          <option value="promo" ${_payFilters.method === 'promo' ? 'selected' : ''}>Promo</option>
        </select>
        <button class="ops-btn" id="pR">Обновить</button>
      </div>
      <div class="ops-card" style="padding:0;overflow:auto">
        <table class="ops-table">
          <thead><tr><th>ID</th><th>Date</th><th>User</th><th>Method</th><th>Amount</th><th>Plan</th><th>Status</th><th></th></tr></thead>
          <tbody id="pTb"><tr><td colspan="8" class="text-center py-8 text-slate-500">Загрузка…</td></tr></tbody>
        </table>
      </div>
    `;
    document.getElementById('pSt').addEventListener('change', (e) => { _payFilters.status = e.target.value; loadPayments(); });
    document.getElementById('pMt').addEventListener('change', (e) => { _payFilters.method = e.target.value; loadPayments(); });
    document.getElementById('pR').addEventListener('click', loadPayments);
    try {
      const data = await API.adminListPayments({ status: _payFilters.status || undefined, method: _payFilters.method || undefined, limit: 300 });
      document.getElementById('pTb').innerHTML = (data.payments || []).map((p) => {
        const badge = p.status === 'confirmed' ? 'badge-green' : p.status === 'pending' ? 'badge-yellow' : p.status === 'refunded' ? 'badge-gray' : 'badge-red';
        return `<tr>
          <td class="mono">${p.id}</td>
          <td class="mono text-xs text-slate-500">${fmtDate(p.createdAt)}</td>
          <td class="mono text-xs">${esc(p.userEmail || '—')}</td>
          <td>${esc(p.method)}</td>
          <td class="mono">${money(p.amountUsd)}</td>
          <td>${esc(p.plan || '—')}</td>
          <td><span class="badge ${badge}">${p.status}</span></td>
          <td style="display:flex;gap:6px">
            ${p.status === 'pending' ? `<button class="ops-btn" onclick="Ops.confirmPay(${p.id})">Confirm</button>` : ''}
            ${p.status === 'confirmed' ? `<button class="ops-btn ops-btn-danger" onclick="Ops.refundPay(${p.id})">Refund</button>` : ''}
          </td>
        </tr>`;
      }).join('') || '<tr><td colspan="8" class="text-center py-8 text-slate-500">Нет платежей</td></tr>';
    } catch (e) {
      document.getElementById('pTb').innerHTML = `<tr><td colspan="8" class="text-center py-8 text-red-400">${esc(e.message)}</td></tr>`;
    }
  }
  loaders.payments = loadPayments;
  window.Ops.confirmPay = async (id) => {
    if (!confirm('Подтвердить платёж вручную? Будет активирована подписка + начислена реф-комиссия.')) return;
    try { await API.adminConfirmPayment(id, 'manual'); Toast.success('Подтверждено'); loadPayments(); }
    catch (e) { Toast.error(e.message); }
  };
  window.Ops.refundPay = async (id) => {
    const reason = prompt('Причина возврата?');
    if (reason === null) return;
    try { await API.adminRefundPayment(id, reason); Toast.success('Refund · юзер переведён на free если нет другого платежа'); loadPayments(); }
    catch (e) { Toast.error(e.message); }
  };

  // ── Promo codes ───────────────────────────────────────────────────────
  async function loadPromo() {
    const pane = document.getElementById('pane-promo');
    pane.innerHTML = `
      <div class="ops-card mb-4">
        <form id="promoForm" style="display:grid;grid-template-columns:repeat(5,1fr) auto;gap:10px;align-items:end">
          <div><label class="kpi-label block mb-1">Code</label><input name="code" required class="ops-input" style="width:100%" placeholder="FRIEND2026"/></div>
          <div><label class="kpi-label block mb-1">Plan</label><select name="plan" class="ops-input" style="width:100%"><option>starter</option><option selected>pro</option><option>elite</option></select></div>
          <div><label class="kpi-label block mb-1">Days</label><input name="durationDays" type="number" min="1" max="3650" value="30" class="ops-input" style="width:100%"/></div>
          <div><label class="kpi-label block mb-1">Max uses</label><input name="maxUses" type="number" min="0" value="1" class="ops-input" style="width:100%"/></div>
          <div><label class="kpi-label block mb-1">Discount %</label><input name="discountPct" type="number" min="0" max="100" value="100" class="ops-input" style="width:100%"/></div>
          <button type="submit" class="ops-btn ops-btn-primary">Создать</button>
        </form>
      </div>
      <div class="ops-card" style="padding:0;overflow:auto">
        <table class="ops-table">
          <thead><tr><th>Code</th><th>Plan</th><th>Days</th><th>Uses</th><th>Status</th><th>Created</th><th></th></tr></thead>
          <tbody id="prTb"><tr><td colspan="7" class="text-center py-8 text-slate-500">Загрузка…</td></tr></tbody>
        </table>
      </div>
    `;
    document.getElementById('promoForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(e.target).entries());
      try {
        await API.adminCreatePromoCode({
          code: fd.code.toUpperCase(),
          plan: fd.plan,
          durationDays: +fd.durationDays,
          maxUses: +fd.maxUses,
          discountPct: +fd.discountPct,
        });
        Toast.success('Промо создан'); e.target.reset(); loadPromo();
      } catch (err) { Toast.error(err.message); }
    });
    try {
      const data = await API.adminListPromoCodes();
      document.getElementById('prTb').innerHTML = (data.codes || []).map((c) => `<tr>
        <td class="mono font-semibold">${esc(c.code)}</td>
        <td>${esc(c.plan)}</td>
        <td class="mono">${c.durationDays}</td>
        <td class="mono">${c.usesCount}${c.maxUses ? ' / ' + c.maxUses : ''}</td>
        <td>${c.isActive ? '<span class="badge badge-green">active</span>' : '<span class="badge badge-gray">off</span>'}</td>
        <td class="text-xs text-slate-500">${fmtDateShort(c.createdAt)}</td>
        <td style="display:flex;gap:6px">
          <button class="ops-btn" onclick="Ops.togglePromo(${c.id}, ${!c.isActive})">${c.isActive ? 'Disable' : 'Enable'}</button>
          <button class="ops-btn ops-btn-danger" onclick="Ops.deletePromo(${c.id})">Delete</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="7" class="text-center py-8 text-slate-500">Нет промо-кодов</td></tr>';
    } catch (e) {
      document.getElementById('prTb').innerHTML = `<tr><td colspan="7" class="text-center py-8 text-red-400">${esc(e.message)}</td></tr>`;
    }
  }
  loaders.promo = loadPromo;
  window.Ops.togglePromo = async (id, isActive) => {
    try { await API.adminTogglePromoCode(id, isActive); Toast.success('OK'); loadPromo(); }
    catch (e) { Toast.error(e.message); }
  };
  window.Ops.deletePromo = async (id) => {
    if (!confirm('Удалить промо-код? Отменит будущие активации. История редемпций останется.')) return;
    try { await API.adminDeletePromoCode(id); Toast.success('Удалён'); loadPromo(); }
    catch (e) { Toast.error(e.message); }
  };

  // ── Referral rewards ──────────────────────────────────────────────────
  let _rewStatus = 'pending';
  async function loadRewards() {
    const pane = document.getElementById('pane-rewards');
    pane.innerHTML = `
      <div class="ops-card mb-4" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <select id="rwS" class="ops-input">
          <option value="">Все</option>
          <option value="pending" ${_rewStatus === 'pending' ? 'selected' : ''}>Pending</option>
          <option value="paid" ${_rewStatus === 'paid' ? 'selected' : ''}>Paid</option>
          <option value="cancelled" ${_rewStatus === 'cancelled' ? 'selected' : ''}>Cancelled</option>
        </select>
        <button class="ops-btn" id="rwR">Обновить</button>
      </div>
      <div class="ops-card" style="padding:0;overflow:auto">
        <table class="ops-table">
          <thead><tr><th>Date</th><th>Referrer</th><th>Referred</th><th>Payment</th><th>Amount</th><th>Status</th><th></th></tr></thead>
          <tbody id="rwTb"><tr><td colspan="7" class="text-center py-8 text-slate-500">Загрузка…</td></tr></tbody>
        </table>
      </div>
    `;
    document.getElementById('rwS').addEventListener('change', (e) => { _rewStatus = e.target.value; loadRewards(); });
    document.getElementById('rwR').addEventListener('click', loadRewards);
    try {
      const data = await API.adminListRewards({ status: _rewStatus || undefined, limit: 300 });
      document.getElementById('rwTb').innerHTML = (data.rewards || []).map((r) => {
        const badge = r.status === 'paid' ? 'badge-green' : r.status === 'pending' ? 'badge-yellow' : 'badge-gray';
        return `<tr>
          <td class="mono text-xs text-slate-500">${fmtDateShort(r.createdAt)}</td>
          <td class="mono text-xs">${esc(r.referrerEmail || '—')}</td>
          <td class="mono text-xs">${esc(r.referredEmail || '—')}</td>
          <td class="mono">#${r.paymentId}</td>
          <td class="mono text-green-400">${money(r.amountUsd)}</td>
          <td><span class="badge ${badge}">${r.status}</span></td>
          <td style="display:flex;gap:6px">
            ${r.status === 'pending' ? `<button class="ops-btn ops-btn-primary" onclick="Ops.payReward(${r.id})">Pay</button><button class="ops-btn" onclick="Ops.cancelReward(${r.id})">Cancel</button>` : ''}
          </td>
        </tr>`;
      }).join('') || '<tr><td colspan="7" class="text-center py-8 text-slate-500">Нет выплат</td></tr>';
    } catch (e) {
      document.getElementById('rwTb').innerHTML = `<tr><td colspan="7" class="text-center py-8 text-red-400">${esc(e.message)}</td></tr>`;
    }
  }
  loaders.rewards = loadRewards;
  window.Ops.payReward = async (id) => {
    if (!confirm('Пометить как выплаченное?')) return;
    try { await API.adminPayReward(id); Toast.success('Выплачено'); loadRewards(); }
    catch (e) { Toast.error(e.message); }
  };
  window.Ops.cancelReward = async (id) => {
    const reason = prompt('Причина отмены?');
    if (reason === null) return;
    try { await API.adminCancelReward(id, reason); Toast.success('Отменено'); loadRewards(); }
    catch (e) { Toast.error(e.message); }
  };

  // ── Support ───────────────────────────────────────────────────────────
  async function loadSupport() {
    const pane = document.getElementById('pane-support');
    pane.innerHTML = `
      <div class="ops-card" style="padding:0;overflow:auto">
        <table class="ops-table">
          <thead><tr><th>#</th><th>User</th><th>Subject</th><th>Status</th><th>Msgs</th><th>Updated</th></tr></thead>
          <tbody id="suTb"><tr><td colspan="6" class="text-center py-8 text-slate-500">Загрузка…</td></tr></tbody>
        </table>
      </div>
    `;
    try {
      const data = await API.listAllTickets({ limit: 200 });
      document.getElementById('suTb').innerHTML = (data.tickets || []).map((t) => {
        const badge = t.status === 'open' ? 'badge-green' : t.status === 'pending' ? 'badge-yellow' : 'badge-gray';
        return `<tr>
          <td class="mono">#${t.id}</td>
          <td class="mono text-xs">${esc(t.userEmail || '—')}</td>
          <td>${esc(t.subject)}</td>
          <td><span class="badge ${badge}">${t.status}</span></td>
          <td class="mono">${t.messageCount || 0}</td>
          <td class="mono text-xs text-slate-500">${fmtDate(t.updatedAt || t.createdAt)}</td>
        </tr>`;
      }).join('') || '<tr><td colspan="6" class="text-center py-8 text-slate-500">Нет тикетов</td></tr>';
    } catch (e) {
      document.getElementById('suTb').innerHTML = `<tr><td colspan="6" class="text-center py-8 text-red-400">${esc(e.message)}</td></tr>`;
    }
  }
  loaders.support = loadSupport;

  // ── System ────────────────────────────────────────────────────────────
  async function loadSystem() {
    const pane = document.getElementById('pane-system');
    pane.innerHTML = '<div class="text-center py-12 text-slate-500 text-sm">Загрузка…</div>';
    try {
      const s = await API.adminSystem();
      const counts = s.db.rowCounts || {};
      pane.innerHTML = `
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
          <div class="ops-card">
            <div class="kpi-label mb-3">Process</div>
            <div class="dl-pair"><span class="k">Node</span><span class="v">${esc(s.process.node || '—')}</span></div>
            <div class="dl-pair"><span class="k">PID</span><span class="v">${s.process.pid}</span></div>
            <div class="dl-pair"><span class="k">Env</span><span class="v">${esc(s.process.nodeEnv)}</span></div>
            <div class="dl-pair"><span class="k">Uptime</span><span class="v">${duration(s.process.uptimeSeconds)}</span></div>
            <div class="dl-pair"><span class="k">RSS</span><span class="v">${s.process.memoryMb} MB</span></div>
            <div class="dl-pair"><span class="k">Heap</span><span class="v">${s.process.heapMb} MB</span></div>
          </div>
          <div class="ops-card">
            <div class="kpi-label mb-3">Database</div>
            <div class="dl-pair"><span class="k">Size</span><span class="v">${s.db.sizeMb || '—'} MB</span></div>
            <div class="dl-pair"><span class="k">WAL mode</span><span class="v">${s.db.walMode ? 'yes' : 'no'}</span></div>
            <div class="dl-pair"><span class="k">Tables</span><span class="v">${(s.db.tables || []).length}</span></div>
          </div>
          <div class="ops-card">
            <div class="kpi-label mb-3">Backups</div>
            <div class="dl-pair"><span class="k">Count</span><span class="v">${s.backups.count}</span></div>
            <div class="dl-pair"><span class="k">Latest</span><span class="v">${s.backups.latest ? esc(s.backups.latest.name) : 'нет'}</span></div>
            <div class="dl-pair"><span class="k">Size</span><span class="v">${s.backups.latest ? s.backups.latest.sizeMb + ' MB' : '—'}</span></div>
            <div class="dl-pair"><span class="k">Created</span><span class="v">${s.backups.latest ? fmtDate(s.backups.latest.mtime) : '—'}</span></div>
          </div>
        </div>

        <div class="ops-card">
          <div class="kpi-label mb-3">Row counts</div>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px">
            ${Object.keys(counts).map((t) => `<div style="padding:8px 12px;background:rgba(255,255,255,.02);border-radius:8px"><div class="text-xs text-slate-500">${esc(t)}</div><div class="mono font-semibold">${counts[t].toLocaleString()}</div></div>`).join('')}
          </div>
        </div>

        <div class="ops-card mt-4">
          <div class="kpi-label mb-3">Latest backups</div>
          ${s.backups.files && s.backups.files.length ? `<table class="ops-table"><thead><tr><th>File</th><th>Size</th><th>Created</th></tr></thead><tbody>
            ${s.backups.files.map((f) => `<tr><td class="mono">${esc(f.name)}</td><td class="mono">${f.sizeMb} MB</td><td class="text-xs text-slate-500">${fmtDate(f.mtime)}</td></tr>`).join('')}
          </tbody></table>` : '<div class="text-xs text-slate-600">Нет бэкапов</div>'}
        </div>
      `;
    } catch (e) {
      pane.innerHTML = `<div class="text-center py-12 text-red-400 text-sm">${esc(e.message)}</div>`;
    }
  }
  loaders.system = loadSystem;

  // ── Audit log ─────────────────────────────────────────────────────────
  let _auditFilter = '';
  async function loadAudit() {
    const pane = document.getElementById('pane-audit');
    pane.innerHTML = `
      <div class="ops-card mb-4" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <input id="auF" class="ops-input" placeholder="Фильтр по действию (admin.user.plan, payment.refund, …)" value="${esc(_auditFilter)}" style="flex:1;min-width:240px"/>
        <button class="ops-btn" id="auR">Обновить</button>
      </div>
      <div class="ops-card" style="padding:0;overflow:auto">
        <table class="ops-table">
          <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Entity</th><th>IP</th><th>Meta</th></tr></thead>
          <tbody id="auTb"><tr><td colspan="6" class="text-center py-8 text-slate-500">Загрузка…</td></tr></tbody>
        </table>
      </div>
    `;
    document.getElementById('auF').addEventListener('change', (e) => { _auditFilter = e.target.value.trim(); loadAudit(); });
    document.getElementById('auR').addEventListener('click', loadAudit);
    try {
      const data = await API.adminAuditLog({ action: _auditFilter || undefined, limit: 300 });
      document.getElementById('auTb').innerHTML = (data.events || []).map((a) => `<tr>
        <td class="mono text-xs text-slate-500">${fmtDate(a.createdAt)}</td>
        <td class="mono text-xs">${esc(a.userEmail || '—')}</td>
        <td class="mono text-xs">${esc(a.action)}</td>
        <td class="text-xs">${esc(a.entityType || '—')}${a.entityId ? ' #' + a.entityId : ''}</td>
        <td class="mono text-xs text-slate-500">${esc(a.ipAddress || '—')}</td>
        <td class="mono text-xs text-slate-500" style="max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(JSON.stringify(a.metadata || {}))}</td>
      </tr>`).join('') || '<tr><td colspan="6" class="text-center py-8 text-slate-500">Нет событий</td></tr>';
    } catch (e) {
      document.getElementById('auTb').innerHTML = `<tr><td colspan="6" class="text-center py-8 text-red-400">${esc(e.message)}</td></tr>`;
    }
  }
  loaders.audit = loadAudit;

  // ── Feature flags ─────────────────────────────────────────────────────
  async function loadFlags() {
    const pane = document.getElementById('pane-flags');
    pane.innerHTML = '<div class="text-center py-12 text-slate-500 text-sm">Загрузка…</div>';
    try {
      const r = await API.adminListFlags();
      pane.innerHTML = `
        <div class="ops-card mb-4 text-xs" style="color:rgba(255,255,255,.55);line-height:1.6">
          Флаги применяются в течение 30с без рестарта. Каждое изменение логируется в audit (<span class="mono">admin.flag.set</span>). Выключение <span class="mono">email_notifications</span> или <span class="mono">telegram_notifications</span> моментально глушит соответствующий канал для всей платформы.
        </div>
        <div class="ops-card" style="padding:0;overflow:auto">
          <table class="ops-table">
            <thead><tr><th>Key</th><th>State</th><th>Default</th><th>Description</th><th></th></tr></thead>
            <tbody id="flTb">
              ${(r.flags || []).map((f) => `<tr>
                <td class="mono font-semibold">${esc(f.key)}</td>
                <td>${f.value ? '<span class="badge badge-green">ON</span>' : '<span class="badge badge-gray">OFF</span>'}${f.overridden ? ' <span class="badge badge-yellow">override</span>' : ''}</td>
                <td class="text-xs text-slate-500">${f.defaultValue ? 'on' : 'off'}</td>
                <td class="text-xs">${esc(f.description)}</td>
                <td><button class="ops-btn ${f.value ? 'ops-btn-danger' : 'ops-btn-primary'}" onclick="Ops.toggleFlag('${esc(f.key)}', ${!f.value})">${f.value ? 'Turn off' : 'Turn on'}</button></td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      `;
    } catch (e) {
      pane.innerHTML = `<div class="text-center py-12 text-red-400 text-sm">${esc(e.message)}</div>`;
    }
  }
  loaders.flags = loadFlags;
  window.Ops.toggleFlag = async (key, value) => {
    if (key === 'maintenance' && value) {
      if (!confirm('ВКЛЮЧИТЬ maintenance-mode? API будет возвращать 503 всем кроме админов.')) return;
    } else if (!confirm((value ? 'Включить ' : 'Выключить ') + key + '?')) return;
    try { await API.adminSetFlag(key, value); Toast.success('Флаг применён'); loadFlags(); }
    catch (e) { Toast.error(e.message); }
  };

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
