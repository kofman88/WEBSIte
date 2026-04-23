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
              <button class="ops-btn" onclick="Ops.impersonate(${u.id}, '${esc(u.email)}')">🎭 Impersonate</button>
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
  window.Ops.impersonate = async (id, email) => {
    const reason = prompt(
      'Причина входа под ' + email + '?\n\nЗапишется в audit_log с тобой как actor. Откроется новая вкладка с 30-минутной сессией target-юзера — твоя admin-сессия в этой вкладке не трогается.',
    );
    if (!reason || reason.length < 3) return;
    try {
      const r = await API.adminImpersonate(id, reason);
      // Open dashboard in a new tab with the impersonation token in the
      // URL hash. app.js picks it up into sessionStorage (scoped to that
      // tab only) so our own admin session in localStorage is never
      // touched. The hash is stripped from the URL on first render.
      const url = '/dashboard.html#imp=' + encodeURIComponent(r.accessToken) + '&email=' + encodeURIComponent(email);
      window.open(url, '_blank', 'noopener');
      Toast.success('Impersonating ' + email + ' · opened in new tab');
    } catch (e) { Toast.error(e.message || 'Ошибка'); }
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

  // ── Billing analytics ─────────────────────────────────────────────────
  async function loadBilling() {
    const pane = document.getElementById('pane-billing');
    pane.innerHTML = '<div class="text-center py-12 text-slate-500 text-sm">Загрузка…</div>';
    try {
      const d = await API.adminBillingAnalytics();
      const churnPct = (d.churn.monthlyRate * 100).toFixed(2) + '%';
      pane.innerHTML = `
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <div class="ops-card kpi"><div class="kpi-label">LTV</div><div class="kpi-value mono">${money(d.ltv)}</div><div class="kpi-sub">Mature cohorts (≥6mo)</div></div>
          <div class="ops-card kpi"><div class="kpi-label">ARPPU</div><div class="kpi-value mono">${money(d.arppu)}</div><div class="kpi-sub">Avg revenue per paying</div></div>
          <div class="ops-card kpi"><div class="kpi-label">Paying users</div><div class="kpi-value mono">${d.payingUsers}</div></div>
          <div class="ops-card kpi"><div class="kpi-label">Churn · 30d</div><div class="kpi-value mono">${churnPct}</div><div class="kpi-sub">${d.churn.churnedLast30d} lost</div></div>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <div class="ops-card">
            <div class="kpi-label mb-3">Plan distribution</div>
            ${d.planDistribution.map((p) => `<div class="dl-pair"><span class="k">${esc(p.plan)}</span><span class="v">${p.n}</span></div>`).join('')}
          </div>
          <div class="ops-card">
            <div class="kpi-label mb-3">Churn detail</div>
            <div class="dl-pair"><span class="k">Active now</span><span class="v">${d.churn.activeNow}</span></div>
            <div class="dl-pair"><span class="k">Active 30d ago</span><span class="v">${d.churn.activeThirtyDaysAgo}</span></div>
            <div class="dl-pair"><span class="k">Lost · 30d</span><span class="v">${d.churn.churnedLast30d}</span></div>
            <div class="dl-pair"><span class="k">Monthly churn</span><span class="v">${churnPct}</span></div>
          </div>
        </div>
        <div class="ops-card" style="padding:0;overflow:auto">
          <table class="ops-table">
            <thead><tr><th>Cohort</th><th>Members</th><th>Active MRR</th><th>Lifetime revenue</th><th>Avg / user</th></tr></thead>
            <tbody>
              ${d.cohorts.map((c) => `<tr>
                <td class="mono">${esc(c.cohort)}</td>
                <td class="mono">${c.members}</td>
                <td class="mono text-green-400">${money(c.activeMrr)}</td>
                <td class="mono">${money(c.lifetimeRev)}</td>
                <td class="mono text-xs text-slate-500">${money(c.members ? c.lifetimeRev / c.members : 0)}</td>
              </tr>`).join('') || '<tr><td colspan="5" class="text-center py-8 text-slate-500">Нет платящих пользователей</td></tr>'}
            </tbody>
          </table>
        </div>
      `;
    } catch (e) {
      pane.innerHTML = `<div class="text-center py-12 text-red-400 text-sm">${esc(e.message)}</div>`;
    }
  }
  loaders.billing = loadBilling;
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

  // ── Support Inbox (Intercom-style) ────────────────────────────────────
  // List of tickets with unread badge + status badge + last message
  // preview. Click row → opens drawer with full thread + textarea reply.
  // WebSocket subscription below (wireSupportWs) keeps list + open drawer
  // live without page reloads.
  let _supOpenTicketId = null;
  async function loadSupport() {
    const pane = document.getElementById('pane-support');
    pane.innerHTML =
      '<div class="ops-card" style="padding:0;overflow:hidden">' +
      '<div style="padding:14px 18px;border-bottom:1px solid rgba(255,255,255,.06)">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">' +
          '<div style="font-weight:600;font-size:14px">Support Inbox <span id="suUnread" class="badge badge-red" style="display:none;margin-left:8px">0</span></div>' +
          '<div style="display:flex;gap:8px;align-items:center">' +
            '<button id="suTemplatesBtn" class="ops-btn" type="button" title="Управление шаблонами">Шаблоны</button>' +
            '<select id="suFilter" class="ops-input" style="padding:6px 10px;font-size:12px">' +
              '<option value="">Все статусы</option>' +
              '<option value="open" selected>Open</option>' +
              '<option value="pending">Pending</option>' +
              '<option value="closed">Closed</option>' +
            '</select>' +
            '<button id="suReload" class="ops-btn" type="button">↻</button>' +
          '</div>' +
        '</div>' +
        '<div id="suOnlineBar" style="margin-top:10px;display:flex;gap:4px;flex-wrap:wrap;min-height:22px"></div>' +
      '</div>' +
      '<div id="suList" style="max-height:68vh;overflow-y:auto">' +
        '<div class="text-center py-8 text-slate-500 text-sm">Загрузка…</div>' +
      '</div>' +
      '</div>' +
      // Templates manager modal (hidden by default)
      '<div id="suTmplModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(6px);z-index:200;align-items:center;justify-content:center;padding:20px">' +
        '<div class="ops-card" style="max-width:640px;width:100%;max-height:80vh;overflow-y:auto">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">' +
            '<div style="font-weight:600;font-size:15px">Шаблоны ответов</div>' +
            '<button id="suTmplClose" class="ops-btn" type="button">✕</button>' +
          '</div>' +
          '<div id="suTmplList" class="text-sm"><div class="text-center py-6 text-slate-500">Загрузка…</div></div>' +
          '<details style="margin-top:14px"><summary style="cursor:pointer;color:#FF8C5A;font-size:12px">+ Добавить новый шаблон</summary>' +
            '<div style="display:flex;flex-direction:column;gap:8px;margin-top:10px">' +
              '<input id="suTmplSlug" class="ops-input" placeholder="slug (latin, lowercase)" maxlength="32" style="font-size:12px"/>' +
              '<input id="suTmplTitle" class="ops-input" placeholder="Название (для админа)" maxlength="100" style="font-size:12px"/>' +
              '<textarea id="suTmplBody" class="ops-input" placeholder="Текст ответа…" rows="4" style="font-size:13px;resize:vertical"></textarea>' +
              '<button id="suTmplAdd" class="ops-btn ops-btn-primary" type="button" style="align-self:flex-start">Создать</button>' +
            '</div>' +
          '</details>' +
        '</div>' +
      '</div>';
    document.getElementById('suFilter').addEventListener('change', renderSupportList);
    document.getElementById('suReload').addEventListener('click', renderSupportList);
    document.getElementById('suTemplatesBtn').addEventListener('click', openTemplatesModal);
    document.getElementById('suTmplClose').addEventListener('click', closeTemplatesModal);
    document.getElementById('suTmplAdd').addEventListener('click', async function () {
      const slug = document.getElementById('suTmplSlug').value.trim();
      const title = document.getElementById('suTmplTitle').value.trim();
      const body = document.getElementById('suTmplBody').value.trim();
      if (!slug || !title || !body) return alert('Заполни все поля');
      try {
        await API.adminTemplateCreate({ slug, title, body });
        _templatesCache = null;
        document.getElementById('suTmplSlug').value = '';
        document.getElementById('suTmplTitle').value = '';
        document.getElementById('suTmplBody').value = '';
        renderTemplatesList();
      } catch (e) { alert(e.message || 'Ошибка'); }
    });
    renderSupportList();
  }
  function openTemplatesModal() {
    document.getElementById('suTmplModal').style.display = 'flex';
    renderTemplatesList();
  }
  function closeTemplatesModal() {
    document.getElementById('suTmplModal').style.display = 'none';
  }
  async function renderTemplatesList() {
    const box = document.getElementById('suTmplList');
    if (!box) return;
    box.innerHTML = '<div class="text-center py-4 text-slate-500">Загрузка…</div>';
    try {
      const r = await API.adminTemplatesList();
      _templatesCache = r.templates || [];
      if (!_templatesCache.length) {
        box.innerHTML = '<div class="text-center py-4 text-slate-500">Пусто</div>';
        return;
      }
      box.innerHTML = _templatesCache.map((t) =>
        '<div style="padding:10px 12px;border:1px solid rgba(255,255,255,.06);border-radius:10px;margin-bottom:6px">' +
          '<div style="display:flex;justify-content:space-between;gap:8px;align-items:center">' +
            '<div><strong>' + esc(t.title) + '</strong> <span class="mono text-xs" style="color:rgba(255,255,255,.4)">/' + esc(t.slug) + '</span> <span class="mono text-xs" style="color:rgba(255,255,255,.35);margin-left:6px">×' + t.use_count + '</span></div>' +
            '<button class="ops-btn ops-btn-danger" data-tmpl-del="' + t.id + '" type="button">Удалить</button>' +
          '</div>' +
          '<div style="margin-top:6px;font-size:12px;color:rgba(255,255,255,.68);white-space:pre-wrap">' + esc(t.body) + '</div>' +
        '</div>'
      ).join('');
      box.querySelectorAll('[data-tmpl-del]').forEach((b) => b.addEventListener('click', async function () {
        if (!confirm('Удалить шаблон?')) return;
        try { await API.adminTemplateRemove(Number(b.getAttribute('data-tmpl-del'))); _templatesCache = null; renderTemplatesList(); }
        catch (e) { alert(e.message || 'Ошибка'); }
      }));
    } catch (e) { box.innerHTML = '<div class="text-center py-4 text-red-400">' + esc(e.message) + '</div>'; }
  }
  async function renderSupportList() {
    const list = document.getElementById('suList');
    if (!list) return;
    const status = document.getElementById('suFilter').value || undefined;
    try {
      const data = await API.listAllTickets({ status, limit: 200 });
      const tickets = data.tickets || [];
      // Aggregate unread for the top-of-pane counter
      const totalUnread = tickets.reduce(function (a, t) { return a + (t.unreadCount || 0); }, 0);
      const badge = document.getElementById('suUnread');
      if (badge) {
        badge.style.display = totalUnread > 0 ? 'inline-block' : 'none';
        badge.textContent = totalUnread;
      }
      if (!tickets.length) {
        list.innerHTML = '<div class="text-center py-10 text-sm" style="color:rgba(255,255,255,.5)">Пусто — все тикеты закрыты ✓</div>';
        return;
      }
      list.innerHTML = tickets.map(function (t) {
        const statusCls = t.status === 'open' ? 'badge-green' : t.status === 'pending' ? 'badge-yellow' : 'badge-gray';
        const preview = t.lastBody ? (t.lastFromAdmin ? '↳ ' : '') + esc(t.lastBody.slice(0, 100)) : '';
        const unread = t.unreadCount > 0
          ? '<span class="badge badge-red" style="margin-left:6px">' + t.unreadCount + '</span>'
          : '';
        // SLA color-code left border: green=fresh, yellow=>3min, orange=>15min, red=>60min
        const slaColors = ['transparent', '#fde047', '#FF8C5A', '#ef4444'];
        const slaBar = 'border-left:3px solid ' + slaColors[t.slaLevel || 0] + ';';
        const slaLabel = ['', '≥3 мин', '≥15 мин', '≥1 час'][t.slaLevel || 0];
        const rowBg = t.unreadCount > 0 ? 'background:rgba(239,68,68,.04);' : '';
        const assigneeBadge = t.assignedToEmail
          ? '<span class="badge badge-blue" style="margin-left:4px">→ ' + esc(t.assignedToEmail.split('@')[0]) + '</span>'
          : '';
        return '<div class="su-row" data-tid="' + t.id + '" style="padding:12px 18px;border-bottom:1px solid rgba(255,255,255,.04);cursor:pointer;display:flex;gap:12px;align-items:flex-start;' + rowBg + slaBar + '">' +
          '<div style="flex:0 0 auto;width:32px;height:32px;border-radius:50%;background:rgba(255,90,31,.15);color:#FF8C5A;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:12px">' +
            esc((t.userEmail || '?')[0].toUpperCase()) +
          '</div>' +
          '<div style="flex:1;min-width:0">' +
            '<div style="display:flex;justify-content:space-between;gap:8px">' +
              '<div class="mono text-xs" style="color:rgba(255,255,255,.65)">' + esc(t.userEmail || '—') + unread + assigneeBadge + '</div>' +
              '<div style="display:flex;gap:6px;align-items:center">' +
                (slaLabel ? '<span class="mono text-xs" style="color:' + slaColors[t.slaLevel] + '">⏱ ' + slaLabel + '</span>' : '') +
                '<span class="badge ' + statusCls + '">' + esc(t.status) + '</span>' +
                '<span class="mono text-xs" style="color:rgba(255,255,255,.4)">#' + t.id + '</span>' +
              '</div>' +
            '</div>' +
            '<div style="font-weight:500;margin-top:2px;font-size:13px">' + esc(t.subject || 'Без темы') + '</div>' +
            '<div style="margin-top:3px;font-size:12px;color:rgba(255,255,255,.5);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + preview + '</div>' +
          '</div>' +
        '</div>';
      }).join('');
      // Fetch + render online-agents pill row above the list
      try {
        const op = await API.adminPresenceOnline();
        const agents = op.agents || [];
        const onlineBar = document.getElementById('suOnlineBar');
        if (onlineBar) {
          onlineBar.innerHTML = agents.length
            ? '<span style="font-size:11px;color:rgba(255,255,255,.5);margin-right:6px">Онлайн:</span>' +
              agents.map((a) => '<span style="display:inline-flex;align-items:center;gap:4px;padding:3px 8px;background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.25);border-radius:9999px;font-size:10px;color:#86efac"><span style="width:6px;height:6px;border-radius:50%;background:#4ade80"></span>' + esc(a.email.split('@')[0]) + '</span>').join(' ')
            : '<span style="font-size:11px;color:rgba(255,255,255,.35)">Нет агентов онлайн</span>';
        }
      } catch (_) {}
      list.querySelectorAll('.su-row').forEach(function (row) {
        row.addEventListener('click', function () { openSupportDrawer(Number(row.getAttribute('data-tid'))); });
      });
    } catch (e) {
      list.innerHTML = '<div class="text-center py-10 text-sm text-red-400">' + esc(e.message) + '</div>';
    }
  }

  let _templatesCache = null;
  async function _loadTemplates() {
    if (_templatesCache) return _templatesCache;
    try { const r = await API.adminTemplatesList(); _templatesCache = r.templates || []; }
    catch { _templatesCache = []; }
    return _templatesCache;
  }
  async function openSupportDrawer(ticketId) {
    _supOpenTicketId = ticketId;
    openDrawer();
    const bodyEl = document.getElementById('drawerBody');
    bodyEl.innerHTML = '<div class="p-8 text-center text-slate-500 text-sm">Загрузка тикета…</div>';
    try {
      const [t, templates] = await Promise.all([API.adminTicketGet(ticketId), _loadTemplates()]);
      const msgs = t.messages || [];
      const assignedBadge = t.assignedToEmail
        ? '<span class="badge badge-blue" style="margin-left:6px">→ ' + esc(t.assignedToEmail) + '</span>'
        : '<span class="badge badge-gray" style="margin-left:6px">не назначен</span>';
      bodyEl.innerHTML =
        '<div class="drawer-section" style="border-bottom:1px solid rgba(255,255,255,.05)">' +
          '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap">' +
            '<div style="flex:1;min-width:0">' +
              '<div style="font-weight:600;font-size:15px">' + esc(t.subject || 'Без темы') + '</div>' +
              '<div class="mono text-xs" style="color:rgba(255,255,255,.5);margin-top:4px">#' + t.id + ' · статус <strong>' + esc(t.status) + '</strong> · ' + msgs.length + ' сообщ.' + assignedBadge + '</div>' +
            '</div>' +
            '<div style="display:flex;gap:6px;flex-wrap:wrap">' +
              (t.assignedTo
                ? '<button id="suUnassign" class="ops-btn" type="button">Снять</button>'
                : '<button id="suAssignSelf" class="ops-btn ops-btn-primary" type="button">Взять</button>') +
              (t.status !== 'closed'
                ? '<button id="suClose" class="ops-btn ops-btn-danger" type="button">Закрыть</button>'
                : '') +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div id="suThread" style="padding:18px 22px;display:flex;flex-direction:column;gap:10px;max-height:50vh;overflow-y:auto">' +
          msgs.map(renderOpsBubble).join('') +
          '<div id="suTyping" style="display:none;align-self:flex-start;padding:8px 14px;background:rgba(255,255,255,.04);border-radius:14px;font-size:12px;color:rgba(255,255,255,.6)">' +
            '<span style="display:inline-flex;gap:2px;align-items:center;margin-right:6px">' +
              '<span class="typing-dot"></span><span class="typing-dot" style="animation-delay:.15s"></span><span class="typing-dot" style="animation-delay:.3s"></span>' +
            '</span>' +
            'Пользователь печатает…' +
          '</div>' +
        '</div>' +
        '<div class="drawer-section" style="border-top:1px solid rgba(255,255,255,.06);position:sticky;bottom:0;background:#0a0a0f;padding:14px 18px">' +
          '<div style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap;align-items:center">' +
            '<label style="display:inline-flex;align-items:center;gap:6px;font-size:11px;color:rgba(255,255,255,.7);cursor:pointer">' +
              '<input type="checkbox" id="suInternal" style="accent-color:#FF5A1F"/> <span>Внутренняя заметка</span>' +
            '</label>' +
            (templates.length
              ? '<select id="suTemplateSel" class="ops-input" style="padding:4px 8px;font-size:11px;margin-left:auto">' +
                  '<option value="">↓ Шаблоны</option>' +
                  templates.map((tpl) => '<option value="' + tpl.id + '">/' + esc(tpl.slug) + ' — ' + esc(tpl.title) + '</option>').join('') +
                '</select>'
              : '') +
          '</div>' +
          '<textarea id="suReplyInput" placeholder="Ответ пользователю…" rows="3" style="width:100%;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:10px 12px;color:#fff;font-family:inherit;font-size:13px;resize:vertical;outline:none"></textarea>' +
          '<div id="suAttachPreview" style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap"></div>' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;font-size:11px;color:rgba(255,255,255,.4);gap:6px;flex-wrap:wrap">' +
            '<label style="cursor:pointer;display:inline-flex;align-items:center;gap:4px;color:rgba(255,140,90,.8)">📎 <input id="suAttachInput" type="file" accept="image/*" multiple style="display:none"/><span>Скрин</span></label>' +
            '<span style="flex:1;text-align:center">Ctrl/Cmd + Enter — отправить</span>' +
            '<button id="suReplyBtn" class="ops-btn ops-btn-primary" type="button">Ответить →</button>' +
          '</div>' +
        '</div>';

      try { await API.adminTicketMarkRead(ticketId); } catch (_) {}

      const thread = document.getElementById('suThread');
      thread.scrollTop = thread.scrollHeight;

      const replyBtn = document.getElementById('suReplyBtn');
      const replyInput = document.getElementById('suReplyInput');
      const internalCheck = document.getElementById('suInternal');
      const tplSel = document.getElementById('suTemplateSel');
      const attachInput = document.getElementById('suAttachInput');
      const attachPreview = document.getElementById('suAttachPreview');
      let pendingAttachments = [];

      // Template selector — inserts body into textarea (admin can edit)
      if (tplSel) tplSel.addEventListener('change', async function () {
        const id = Number(tplSel.value);
        if (!id) return;
        const tpl = (_templatesCache || []).find((x) => x.id === id);
        if (tpl) {
          replyInput.value = tpl.body;
          replyInput.focus();
          try { API.adminTemplateUse(id); } catch (_) {}
        }
        tplSel.value = '';
      });

      // Attachments: small (<500KB each) images as base64 data URLs
      if (attachInput) attachInput.addEventListener('change', function (ev) {
        const files = Array.from(ev.target.files || []);
        files.slice(0, 3 - pendingAttachments.length).forEach((f) => {
          if (f.size > 500_000) { alert('Файл слишком большой (max 500 KB): ' + f.name); return; }
          const r = new FileReader();
          r.onload = () => {
            pendingAttachments.push({ name: f.name, type: f.type, dataUrl: r.result });
            renderAttachPreview();
          };
          r.readAsDataURL(f);
        });
        attachInput.value = '';
      });
      function renderAttachPreview() {
        attachPreview.innerHTML = pendingAttachments.map((a, i) =>
          '<div style="position:relative;width:64px;height:64px;border-radius:8px;overflow:hidden;border:1px solid rgba(255,255,255,.1)">' +
            '<img src="' + a.dataUrl + '" style="width:100%;height:100%;object-fit:cover"/>' +
            '<button data-rm-att="' + i + '" style="position:absolute;top:2px;right:2px;width:18px;height:18px;border-radius:50%;border:0;background:rgba(0,0,0,.7);color:#fff;font-size:11px;cursor:pointer;line-height:1">×</button>' +
          '</div>'
        ).join('');
        attachPreview.querySelectorAll('[data-rm-att]').forEach((b) => b.addEventListener('click', () => {
          pendingAttachments.splice(Number(b.getAttribute('data-rm-att')), 1);
          renderAttachPreview();
        }));
      }

      // Typing indicator — emit start on keystroke, stop on idle
      let typingTimer = null;
      replyInput.addEventListener('input', function () {
        try { window.WS && WS._send && WS._send({ type: 'support.typing', ticketId, state: 'start' }); } catch (_) {}
        clearTimeout(typingTimer);
        typingTimer = setTimeout(() => {
          try { window.WS && WS._send && WS._send({ type: 'support.typing', ticketId, state: 'stop' }); } catch (_) {}
        }, 3000);
      });

      async function send() {
        const txt = (replyInput.value || '').trim();
        if (txt.length < 1 && pendingAttachments.length === 0) return;
        replyBtn.disabled = true; replyBtn.textContent = '…';
        try {
          await API.adminTicketReply(ticketId, {
            body: txt || '(вложение)',
            isInternal: !!internalCheck.checked,
            attachments: pendingAttachments.length ? pendingAttachments : undefined,
          });
          replyInput.value = '';
          pendingAttachments = [];
          renderAttachPreview();
          internalCheck.checked = false;
          try { WS._send && WS._send({ type: 'support.typing', ticketId, state: 'stop' }); } catch (_) {}
        } catch (e) {
          alert(e.message || 'Не отправилось');
        } finally {
          replyBtn.disabled = false; replyBtn.textContent = 'Ответить →';
          replyInput.focus();
        }
      }
      replyBtn.addEventListener('click', send);
      replyInput.addEventListener('keydown', function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); send(); }
      });
      replyInput.focus();

      const closeBtn = document.getElementById('suClose');
      if (closeBtn) closeBtn.addEventListener('click', async function () {
        if (!confirm('Закрыть тикет?')) return;
        try { await API.adminTicketClose(ticketId); closeDrawer(); renderSupportList(); }
        catch (e) { alert(e.message || 'Ошибка'); }
      });
      const assignBtn = document.getElementById('suAssignSelf');
      if (assignBtn) assignBtn.addEventListener('click', async function () {
        try { await API.adminTicketAssign(ticketId); openSupportDrawer(ticketId); }
        catch (e) { alert(e.message || 'Ошибка'); }
      });
      const unassignBtn = document.getElementById('suUnassign');
      if (unassignBtn) unassignBtn.addEventListener('click', async function () {
        try { await API.adminTicketUnassign(ticketId); openSupportDrawer(ticketId); }
        catch (e) { alert(e.message || 'Ошибка'); }
      });
    } catch (e) {
      bodyEl.innerHTML = '<div class="p-8 text-center text-red-400">' + esc(e.message) + '</div>';
    }
  }

  // When drawer closes, clear open-ticket ID and reload the list to
  // refresh unread counts that may have changed while it was open.
  const _origCloseDrawer = window.closeDrawer;
  window.closeDrawer = function () {
    _supOpenTicketId = null;
    if (typeof _origCloseDrawer === 'function') _origCloseDrawer();
    else document.getElementById('drawerBg').classList.remove('open'), document.getElementById('drawer').classList.remove('open');
    // If the Support pane is visible, refresh to pick up any admin_read_at changes
    if (document.getElementById('pane-support').classList.contains('active')) {
      renderSupportList();
    }
  };

  function renderOpsBubble(m) {
    const mine = m.isAdmin;
    const internal = m.isInternal;
    // Internal notes — yellow dashed border so agents can't miss them
    const bg = internal
      ? 'rgba(234,179,8,.08)'
      : (mine ? 'linear-gradient(180deg,#FF7840,#FF5A1F)' : 'rgba(255,255,255,.04)');
    const color = internal ? '#fde047' : (mine ? '#fff' : 'rgba(255,255,255,.92)');
    const border = internal
      ? '1px dashed rgba(234,179,8,.45)'
      : '1px solid ' + (mine ? 'transparent' : 'rgba(255,255,255,.08)');
    const radius = mine ? 'border-bottom-right-radius:4px' : 'border-bottom-left-radius:4px';
    const align = mine ? 'margin-left:auto;text-align:left' : 'margin-right:auto';
    const attachHtml = (m.attachments && m.attachments.length)
      ? '<div style="display:flex;gap:4px;margin-top:6px;flex-wrap:wrap">' +
          m.attachments.map((a) => '<a href="' + a.dataUrl + '" target="_blank" style="display:inline-block"><img src="' + a.dataUrl + '" title="' + esc(a.name) + '" style="max-width:120px;max-height:90px;border-radius:6px;border:1px solid rgba(255,255,255,.15)"/></a>').join('') +
        '</div>'
      : '';
    const internalTag = internal ? '<span class="badge badge-yellow" style="margin-right:4px">internal</span>' : '';
    return '<div style="max-width:82%;' + align + '">' +
      '<div style="padding:10px 14px;background:' + bg + ';border:' + border + ';border-radius:14px;' + radius + ';color:' + color + ';font-size:13px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word">' +
        internalTag +
        esc(m.body) +
        attachHtml +
      '</div>' +
      '<div class="mono text-xs" style="color:rgba(255,255,255,.35);margin-top:3px;' + (mine ? 'text-align:right' : '') + '">' +
        (internal ? '🔒 Заметка · ' : '') +
        (mine ? 'Вы (agent)' : 'Пользователь') + ' · ' + fmtDate(m.createdAt) +
      '</div>' +
    '</div>';
  }

  // ── WS subscription for live updates ──────────────────────────────────
  function wireSupportWs() {
    if (window._opsSupportWsWired || !window.WS) return;
    window._opsSupportWsWired = true;
    WS.on('support.message_added', function (ev) {
      const d = ev && ev.data;
      if (!d) return;
      if (_supOpenTicketId === d.ticketId) {
        const thread = document.getElementById('suThread');
        if (thread) {
          // Insert before the typing indicator (last child)
          const typingEl = document.getElementById('suTyping');
          const html = renderOpsBubble({
            isAdmin: d.message.isAdmin,
            isInternal: d.message.isInternal,
            body: d.message.body,
            attachments: d.message.attachments,
            createdAt: new Date().toISOString(),
          });
          if (typingEl) typingEl.insertAdjacentHTML('beforebegin', html);
          else thread.insertAdjacentHTML('beforeend', html);
          thread.scrollTop = thread.scrollHeight;
        }
      }
      if (document.getElementById('pane-support').classList.contains('active')) renderSupportList();
    });
    WS.on('support.ticket_created', function () {
      if (document.getElementById('pane-support').classList.contains('active')) renderSupportList();
    });
    WS.on('support.assignment_changed', function () {
      if (document.getElementById('pane-support').classList.contains('active')) renderSupportList();
    });
    // Typing indicator — show ellipsis in open drawer
    WS.on('support.typing', function (ev) {
      const d = ev && ev.data;
      if (!d || _supOpenTicketId !== d.ticketId) return;
      // We only care about USER typing (admin typing is ourselves)
      if (d.isAdmin) return;
      const el = document.getElementById('suTyping');
      if (!el) return;
      el.style.display = d.state === 'stop' ? 'none' : 'block';
      // Auto-hide after 5s if we miss a stop event
      clearTimeout(window._suTypingTimer);
      if (d.state !== 'stop') {
        window._suTypingTimer = setTimeout(() => { el.style.display = 'none'; }, 5000);
      }
    });
  }

  // Presence ping — runs every 30s while Support tab is active so agents
  // appear "online" to others. Uses visibilitychange to pause when tab
  // hidden (browser throttles setInterval anyway, but explicit is nice).
  let _presenceTimer = null;
  function startPresencePing() {
    const send = () => { try { API.adminPresencePing(); } catch (_) {} };
    send();
    clearInterval(_presenceTimer);
    _presenceTimer = setInterval(() => { if (!document.hidden) send(); }, 30_000);
  }

  loaders.support = function () { loadSupport(); wireSupportWs(); startPresencePing(); };

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
      <div class="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
        <div class="ops-card"><div class="kpi-label mb-2">Activity · last 14d</div><div style="position:relative;height:160px"><canvas id="auChartDay"></canvas></div></div>
        <div class="ops-card"><div class="kpi-label mb-2">By category</div><div id="auByCat" style="font-size:12px"></div></div>
        <div class="ops-card"><div class="kpi-label mb-2">Top admins</div><div id="auByActor" style="font-size:12px"></div></div>
      </div>
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
    // Background-render the three analytics tiles; don't block the table.
    API.adminAuditAnalytics(14).then((ana) => {
      const catBox = document.getElementById('auByCat');
      if (catBox) catBox.innerHTML = (ana.byCategory || []).map((c) => `<div class="dl-pair"><span class="k">${esc(c.category || '—')}</span><span class="v">${c.n}</span></div>`).join('') || '<div class="text-xs text-slate-600">—</div>';
      const actBox = document.getElementById('auByActor');
      if (actBox) actBox.innerHTML = (ana.byActor || []).map((a) => `<div class="dl-pair"><span class="k mono text-xs" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block">${esc(a.email)}</span><span class="v">${a.n}</span></div>`).join('') || '<div class="text-xs text-slate-600">—</div>';
      const cv = document.getElementById('auChartDay');
      if (cv && window.Chart) {
        new Chart(cv, {
          type: 'bar',
          data: {
            labels: (ana.byDay || []).map((d) => d.day.slice(5)),
            datasets: [{ data: (ana.byDay || []).map((d) => d.n), backgroundColor: 'rgba(147,197,253,.55)', borderColor: '#60a5fa', borderWidth: 1, borderRadius: 4 }],
          },
          options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: 'rgba(255,255,255,.4)', font: { size: 10 } }, grid: { display: false } }, y: { ticks: { color: 'rgba(255,255,255,.4)', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,.04)' } } } },
        });
      }
    }).catch(() => {});
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

  // ── Marketplace moderation ────────────────────────────────────────────
  async function loadMarketplace() {
    const pane = document.getElementById('pane-marketplace');
    pane.innerHTML = '<div class="text-center py-12 text-slate-500 text-sm">Загрузка…</div>';
    try {
      const r = await API.adminMarketplace();
      const list = r.strategies || [];
      pane.innerHTML =
        '<div class="ops-card mb-4">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">' +
          '<div style="font-weight:600">Опубликованные стратегии</div>' +
          '<div class="text-xs" style="color:rgba(255,255,255,.45)">' + list.length + ' items · hidden inclusive</div>' +
        '</div>' +
        '<table class="ops-table"><thead><tr>' +
          '<th>Title / Slug</th><th>Author</th><th>Strategy</th><th>Price</th>' +
          '<th>Installs</th><th>Earnings</th><th>Status</th><th></th>' +
        '</tr></thead><tbody>' +
        (list.length ? list.map(function (s) {
          var priceTxt = (s.price_usd > 0) ? '$' + s.price_usd.toFixed(0) : 'free';
          var earnTxt = (s.earnings_count > 0)
            ? '<span class="mono">$' + (s.pending_usd + s.paid_usd).toFixed(2) + '</span>' +
              '<span class="text-xs" style="color:rgba(255,255,255,.5);margin-left:6px">' + s.earnings_count + '</span>'
            : '<span class="text-slate-600">—</span>';
          var badge = s.is_public
            ? '<span class="badge badge-green">public</span>'
            : '<span class="badge badge-gray">hidden</span>';
          var btnLabel = s.is_public ? 'Unpublish' : 'Republish';
          var btnCls = s.is_public ? 'ops-btn ops-btn-danger' : 'ops-btn';
          return '<tr>' +
            '<td><div style="font-weight:500">' + esc(s.title) + '</div>' +
              '<div class="text-xs mono" style="color:rgba(255,255,255,.4)">' + esc(s.slug) + '</div></td>' +
            '<td class="text-xs">' + esc(s.author_email) + '</td>' +
            '<td><span class="badge badge-blue">' + esc(s.strategy) + '</span> <span class="text-xs text-slate-500">' + esc(s.timeframe) + '</span></td>' +
            '<td>' + priceTxt + '</td>' +
            '<td>' + s.installs + '</td>' +
            '<td>' + earnTxt + '</td>' +
            '<td>' + badge + '</td>' +
            '<td><button class="' + btnCls + '" data-mkt-toggle="' + s.id + '" data-next="' + (!s.is_public) + '">' + btnLabel + '</button></td>' +
          '</tr>';
        }).join('') : '<tr><td colspan="8" class="text-center py-8" style="color:rgba(255,255,255,.45)">Пока ничего не опубликовано</td></tr>') +
        '</tbody></table></div>';

      pane.querySelectorAll('[data-mkt-toggle]').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          var id = btn.getAttribute('data-mkt-toggle');
          var next = btn.getAttribute('data-next') === 'true';
          btn.disabled = true; btn.textContent = '…';
          try {
            await API.adminSetStrategyPublic(id, next);
            loadMarketplace();
          } catch (e) { btn.disabled = false; alert(e.message || 'Ошибка'); btn.textContent = next ? 'Republish' : 'Unpublish'; }
        });
      });
    } catch (e) {
      pane.innerHTML = '<div class="text-center py-12 text-red-400 text-sm">' + esc(e.message) + '</div>';
    }
  }
  loaders.marketplace = loadMarketplace;

  // ── Copy Trading moderation ───────────────────────────────────────────
  async function loadCopy() {
    const pane = document.getElementById('pane-copy');
    pane.innerHTML = '<div class="text-center py-12 text-slate-500 text-sm">Загрузка…</div>';
    try {
      const r = await API.adminCopyList({ activeOnly: false });
      const subs = r.subscriptions || [];
      pane.innerHTML =
        '<div class="ops-card">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">' +
          '<div style="font-weight:600">Copy subscriptions</div>' +
          '<div class="text-xs" style="color:rgba(255,255,255,.45)">' + subs.length + ' total · ' + subs.filter(function(x){return x.is_active}).length + ' active</div>' +
        '</div>' +
        '<table class="ops-table"><thead><tr>' +
          '<th>Leader</th><th>Follower</th><th>Mode</th><th>Risk×</th>' +
          '<th>Leader PnL</th><th>Leader trades</th><th>Status</th><th></th>' +
        '</tr></thead><tbody>' +
        (subs.length ? subs.map(function (s) {
          var status = s.is_active
            ? '<span class="badge badge-green">active</span>'
            : '<span class="badge badge-gray">off</span>';
          var pnlCls = s.leader_total_pnl >= 0 ? 'text-green-400' : 'text-red-400';
          return '<tr>' +
            '<td><div class="text-xs">' + esc(s.leader_email) + '</div>' +
              '<div class="mono text-xs" style="color:rgba(255,255,255,.4)">#' + esc(s.leader_code) + '</div></td>' +
            '<td class="text-xs">' + esc(s.follower_email) + '</td>' +
            '<td><span class="badge ' + (s.mode === 'live' ? 'badge-green' : 'badge-yellow') + '">' + esc(s.mode) + '</span></td>' +
            '<td class="mono">' + Number(s.risk_mult).toFixed(1) + '</td>' +
            '<td class="mono ' + pnlCls + '">' + (Number(s.leader_total_pnl) >= 0 ? '+' : '') + Number(s.leader_total_pnl).toFixed(2) + '</td>' +
            '<td class="text-xs">' + s.leader_closed_trades + '</td>' +
            '<td>' + status + '</td>' +
            '<td>' +
              (s.is_active ? '<button class="ops-btn ops-btn-danger" data-cp-disable="' + s.leader_id + '-' + s.follower_id + '">Disable</button>' : '') +
              '<button class="ops-btn ops-btn-danger" style="margin-left:4px" data-cp-ban="' + s.leader_id + '" title="Disable all subs + revoke public profile">Ban leader</button>' +
            '</td>' +
          '</tr>';
        }).join('') : '<tr><td colspan="8" class="text-center py-8" style="color:rgba(255,255,255,.45)">Ни одной подписки</td></tr>') +
        '</tbody></table></div>';

      pane.querySelectorAll('[data-cp-disable]').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          var parts = btn.getAttribute('data-cp-disable').split('-');
          btn.disabled = true; btn.textContent = '…';
          try {
            await API.adminCopyDisable(Number(parts[0]), Number(parts[1]));
            loadCopy();
          } catch (e) { btn.disabled = false; btn.textContent = 'Disable'; alert(e.message || 'Ошибка'); }
        });
      });
      pane.querySelectorAll('[data-cp-ban]').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          if (!confirm('Заблокировать лидера? Все активные подписки отключатся + публичный профиль закроется.')) return;
          var lid = btn.getAttribute('data-cp-ban');
          btn.disabled = true; btn.textContent = '…';
          try { await API.adminCopyBanLeader(lid); loadCopy(); }
          catch (e) { btn.disabled = false; btn.textContent = 'Ban leader'; alert(e.message || 'Ошибка'); }
        });
      });
    } catch (e) {
      pane.innerHTML = '<div class="text-center py-12 text-red-400 text-sm">' + esc(e.message) + '</div>';
    }
  }
  loaders.copy = loadCopy;

  // ── AI usage (Gemini) ─────────────────────────────────────────────────
  async function loadAI() {
    const pane = document.getElementById('pane-ai');
    pane.innerHTML = '<div class="text-center py-12 text-slate-500 text-sm">Загрузка…</div>';
    try {
      const r = await API.adminAIUsage();
      var enabled = r.enabled ? '<span class="badge badge-green">enabled</span>' : '<span class="badge badge-red">disabled</span>';
      var rows = r.users || [];
      pane.innerHTML =
        '<div class="ops-card">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">' +
          '<div style="font-weight:600">Gemini AI usage · сегодня · in-memory</div>' +
          enabled +
        '</div>' +
        '<div class="text-xs" style="color:rgba(255,255,255,.5);margin-bottom:12px">' +
          'Счётчик хранится в памяти процесса — сбрасывается после рестарта Passenger. ' +
          'Ниже только юзеры с запросами > 0 в текущем процессе.' +
        '</div>' +
        '<table class="ops-table"><thead><tr>' +
          '<th>User</th><th>Plan</th><th>Today</th><th>Limit</th><th>% of limit</th>' +
        '</tr></thead><tbody>' +
        (rows.length ? rows.map(function (u) {
          var pct = u.limit ? Math.round(u.requestsToday / u.limit * 100) : 0;
          var pctCls = pct >= 90 ? 'badge-red' : pct >= 60 ? 'badge-yellow' : 'badge-gray';
          return '<tr>' +
            '<td class="text-xs">' + esc(u.email) + '</td>' +
            '<td><span class="badge badge-blue">' + esc(u.plan) + '</span></td>' +
            '<td class="mono">' + u.requestsToday + '</td>' +
            '<td class="mono" style="color:rgba(255,255,255,.5)">' + u.limit + '</td>' +
            '<td><span class="badge ' + pctCls + '">' + pct + '%</span></td>' +
          '</tr>';
        }).join('') : '<tr><td colspan="5" class="text-center py-8" style="color:rgba(255,255,255,.45)">Никто ещё не пользовался AI в этом процессе</td></tr>') +
        '</tbody></table></div>';
    } catch (e) {
      pane.innerHTML = '<div class="text-center py-12 text-red-400 text-sm">' + esc(e.message) + '</div>';
    }
  }
  loaders.ai = loadAI;

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
