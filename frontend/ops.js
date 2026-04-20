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
