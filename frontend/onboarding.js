/**
 * Onboarding tour — first-time walk-through on /dashboard.
 * Steps reference DOM with [data-tour="<key>"].
 *
 * Shown once per user (gate: localStorage.chm_onboarding_done).
 * A user can force-replay via URL ?tour=1 or settings → "Показать тур".
 *
 * Dependencies: none. Uses native DOM + a tiny floating tooltip.
 */

(function onboardingBoot() {
  const STORAGE_KEY = 'chm_onboarding_done';
  const STEPS = [
    { selector: '[data-tour="equity"]', title: 'Кривая капитала',
      body: 'Здесь ты видишь свой P&L за последнюю неделю/месяц/квартал. Каждая закрытая сделка добавляет точку. Пока сделок нет — график пустой.', pos: 'bottom' },
    { selector: '[data-tour="bots"]', title: 'Боты — сердце платформы',
      body: 'Боты автоматически торгуют по выбранной стратегии (SMC / DCA / Grid / TradingView webhook). Начни с бумажного режима (paper) — безрисковый симулятор на реальных ценах.', pos: 'right' },
    { selector: '[data-tour="analytics"]', title: 'Аналитика',
      body: 'Equity curve, P&L по стратегиям / символам / месяцам, экспорт в CSV. Сюда ходим, когда хотим понять, какая стратегия работает, а какую отключать.', pos: 'right' },
    { selector: '[data-tour="wallet"]', title: 'Кошелёк',
      body: 'Баланс, депозит / вывод (кастодиальный кошелёк CHM). Для live-торговли ещё нужны API-ключи биржи — это в Настройках.', pos: 'right' },
    { selector: '[data-tour="settings"]', title: 'Настройки',
      body: 'API-ключи бирж, 2FA, Telegram, публичный профиль, подписка. Рекомендуем включить 2FA сразу после регистрации — аккаунт с реальными деньгами без 2FA = плохая идея.', pos: 'right' },
  ];

  function $(s) { return document.querySelector(s); }
  function should() {
    const q = new URLSearchParams(location.search);
    if (q.get('tour') === '1') return true;
    try { return !localStorage.getItem(STORAGE_KEY); } catch { return false; }
  }
  function markDone() { try { localStorage.setItem(STORAGE_KEY, String(Date.now())); } catch (_e) {} }

  function render() {
    if (!should()) return;
    if (!$('[data-tour]')) return;
    const overlay = document.createElement('div');
    overlay.id = 'onboarding-overlay';
    overlay.innerHTML = `
      <style>
        #onboarding-overlay{position:fixed;inset:0;z-index:9998;background:rgba(5,5,10,.65);backdrop-filter:blur(4px);pointer-events:none}
        #onboarding-overlay .ob-spot{position:absolute;border-radius:14px;box-shadow:0 0 0 4000px rgba(5,5,10,.7), 0 0 0 3px rgba(92,128,227,.6), 0 0 60px rgba(92,128,227,.4);pointer-events:none;transition:all .3s ease}
        #onboarding-overlay .ob-card{position:absolute;z-index:9999;background:linear-gradient(180deg,rgba(22,22,30,.98),rgba(15,15,22,.98));border:1px solid rgba(92,128,227,.3);border-radius:14px;padding:20px;width:340px;max-width:calc(100vw - 40px);color:#fff;pointer-events:auto;box-shadow:0 20px 60px rgba(0,0,0,.8);font-family:'Inter',sans-serif}
        #onboarding-overlay .ob-step{font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:#93c5fd;margin-bottom:6px;font-weight:600}
        #onboarding-overlay .ob-title{font-size:16px;font-weight:600;margin-bottom:8px;letter-spacing:-.015em}
        #onboarding-overlay .ob-body{font-size:13px;line-height:1.55;color:rgba(255,255,255,.72);margin-bottom:16px}
        #onboarding-overlay .ob-actions{display:flex;justify-content:space-between;align-items:center;gap:10px}
        #onboarding-overlay .ob-skip{background:none;border:none;color:rgba(255,255,255,.45);font-size:12px;cursor:pointer}
        #onboarding-overlay .ob-skip:hover{color:#fff}
        #onboarding-overlay .ob-nav{display:flex;gap:8px}
        #onboarding-overlay .ob-btn{padding:7px 14px;border-radius:9999px;font-size:12px;font-weight:600;cursor:pointer;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.05);color:#fff}
        #onboarding-overlay .ob-btn-primary{background:linear-gradient(180deg,#2A5BE8,#1D4ED8 60%,#143797);border:none;box-shadow:inset 0 1px 1px rgba(255,255,255,.25),0 4px 10px -2px rgba(29,78,216,.5)}
        #onboarding-overlay .ob-dots{display:flex;gap:5px;justify-content:center;margin-top:14px}
        #onboarding-overlay .ob-dot{width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,.15)}
        #onboarding-overlay .ob-dot.on{background:#5C80E3}
      </style>
      <div class="ob-spot" id="obSpot"></div>
      <div class="ob-card" id="obCard">
        <div class="ob-step" id="obStep"></div>
        <div class="ob-title" id="obTitle"></div>
        <div class="ob-body" id="obBody"></div>
        <div class="ob-actions">
          <button class="ob-skip" id="obSkip">Пропустить</button>
          <div class="ob-nav">
            <button class="ob-btn" id="obPrev">Назад</button>
            <button class="ob-btn ob-btn-primary" id="obNext">Дальше →</button>
          </div>
        </div>
        <div class="ob-dots" id="obDots"></div>
      </div>
    `;
    document.body.appendChild(overlay);

    let idx = 0;
    function layout() {
      const step = STEPS[idx];
      const el = $(step.selector);
      if (!el) { return next(); }
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const r = el.getBoundingClientRect();
      const spot = $('#obSpot');
      const pad = 8;
      spot.style.left = (r.left - pad) + 'px';
      spot.style.top = (r.top - pad) + 'px';
      spot.style.width = (r.width + pad * 2) + 'px';
      spot.style.height = (r.height + pad * 2) + 'px';

      const card = $('#obCard');
      const cw = card.offsetWidth, ch = card.offsetHeight;
      let left, top;
      if (step.pos === 'right' && r.right + 24 + cw < window.innerWidth) {
        left = r.right + 16; top = Math.max(12, r.top);
      } else if (step.pos === 'bottom' && r.bottom + 24 + ch < window.innerHeight) {
        left = Math.max(12, Math.min(window.innerWidth - cw - 12, r.left)); top = r.bottom + 16;
      } else {
        left = Math.max(12, (window.innerWidth - cw) / 2);
        top  = Math.max(12, r.bottom + 16);
        if (top + ch > window.innerHeight - 12) top = window.innerHeight - ch - 12;
      }
      card.style.left = left + 'px';
      card.style.top = top + 'px';

      $('#obStep').textContent = (idx + 1) + ' / ' + STEPS.length;
      $('#obTitle').textContent = step.title;
      $('#obBody').textContent = step.body;
      $('#obPrev').style.visibility = idx === 0 ? 'hidden' : 'visible';
      $('#obNext').textContent = idx === STEPS.length - 1 ? 'Готово ✓' : 'Дальше →';
      $('#obDots').innerHTML = STEPS.map((_, i) => `<div class="ob-dot${i === idx ? ' on' : ''}"></div>`).join('');
    }
    function next() { idx += 1; if (idx >= STEPS.length) { finish(); return; } layout(); }
    function prev() { idx = Math.max(0, idx - 1); layout(); }
    function finish() { markDone(); overlay.remove(); window.removeEventListener('resize', layout); }

    $('#obNext').addEventListener('click', next);
    $('#obPrev').addEventListener('click', prev);
    $('#obSkip').addEventListener('click', finish);
    window.addEventListener('resize', layout);
    setTimeout(layout, 200);
  }

  window.Onboarding = {
    replay() { try { localStorage.removeItem(STORAGE_KEY); } catch (_e) {} location.href = '/dashboard.html?tour=1'; },
    reset() { try { localStorage.removeItem(STORAGE_KEY); } catch (_e) {} },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render);
  } else {
    render();
  }
})();
