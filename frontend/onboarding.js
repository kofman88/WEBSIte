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
        #onboarding-overlay .ob-spot.hidden{display:none}
        #onboarding-overlay .ob-card{position:fixed;z-index:9999;background:linear-gradient(180deg,rgba(22,22,30,.98),rgba(15,15,22,.98));border:1px solid rgba(92,128,227,.3);border-radius:14px;padding:20px;width:340px;max-width:calc(100vw - 40px);color:#fff;pointer-events:auto;box-shadow:0 20px 60px rgba(0,0,0,.8);font-family:'Inter',sans-serif;transition:left .25s cubic-bezier(.16,1,.3,1), top .25s cubic-bezier(.16,1,.3,1), opacity .2s}
        #onboarding-overlay .ob-arrow{position:fixed;z-index:9999;width:0;height:0;border-style:solid;pointer-events:none;transition:left .25s cubic-bezier(.16,1,.3,1), top .25s cubic-bezier(.16,1,.3,1)}
        #onboarding-overlay .ob-arrow.right{border-width:8px 12px 8px 0;border-color:transparent rgba(22,22,30,.98) transparent transparent}
        #onboarding-overlay .ob-arrow.left{border-width:8px 0 8px 12px;border-color:transparent transparent transparent rgba(22,22,30,.98)}
        #onboarding-overlay .ob-arrow.bottom{border-width:0 8px 12px 8px;border-color:transparent transparent rgba(22,22,30,.98) transparent}
        #onboarding-overlay .ob-arrow.top{border-width:12px 8px 0 8px;border-color:rgba(22,22,30,.98) transparent transparent transparent}
        #onboarding-overlay .ob-arrow.none{display:none}
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
      <div class="ob-arrow" id="obArrow"></div>
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
    const MARGIN = 16;         // gap between target and card
    const VIEWPORT_PAD = 12;   // min gap from viewport edges

    // 3Commas-style positioning:
    // 1) Scroll target into view, then measure after scroll settles.
    // 2) Try preferred side → fall back to whichever side has most room.
    // 3) Always clamp inside the viewport with VIEWPORT_PAD margins.
    // 4) If target is missing entirely → center the card, hide spot.
    function place(el, preferred) {
      const card = $('#obCard');
      const spot = $('#obSpot');
      const arrow = $('#obArrow');

      if (!el) {
        spot.classList.add('hidden');
        arrow.classList.add('none');
        card.style.left = Math.max(VIEWPORT_PAD, (window.innerWidth - card.offsetWidth) / 2) + 'px';
        card.style.top = Math.max(VIEWPORT_PAD, (window.innerHeight - card.offsetHeight) / 2) + 'px';
        return;
      }

      const r = el.getBoundingClientRect();
      spot.classList.remove('hidden');
      const spotPad = 8;
      spot.style.left = (r.left - spotPad) + 'px';
      spot.style.top = (r.top - spotPad) + 'px';
      spot.style.width = (r.width + spotPad * 2) + 'px';
      spot.style.height = (r.height + spotPad * 2) + 'px';

      const cw = card.offsetWidth, ch = card.offsetHeight;
      const vw = window.innerWidth, vh = window.innerHeight;

      // Available room on each side for a card (including MARGIN + VIEWPORT_PAD).
      const room = {
        right:  vw - r.right - MARGIN - VIEWPORT_PAD,
        left:   r.left - MARGIN - VIEWPORT_PAD,
        bottom: vh - r.bottom - MARGIN - VIEWPORT_PAD,
        top:    r.top - MARGIN - VIEWPORT_PAD,
      };
      // Pick the preferred side if it fits, else the side with the most room
      // that actually fits the card's dimension on that axis.
      const order = [preferred, 'right', 'bottom', 'left', 'top'];
      const fits = {
        right:  room.right  >= cw,
        left:   room.left   >= cw,
        bottom: room.bottom >= ch,
        top:    room.top    >= ch,
      };
      let side = null;
      for (const s of order) { if (fits[s]) { side = s; break; } }
      if (!side) {
        // No side fits the card → place at the side with most room anyway,
        // the clamp below will keep it inside the viewport. The spot is
        // still highlighted; card may overlap slightly, better than off-screen.
        side = Object.keys(room).reduce((a, b) => (room[a] > room[b] ? a : b));
      }

      let left, top, ax, ay, aSide;
      if (side === 'right') {
        left = r.right + MARGIN;
        top  = r.top + (r.height - ch) / 2;
        ax = r.right + 4; ay = r.top + r.height / 2 - 8; aSide = 'right';
      } else if (side === 'left') {
        left = r.left - cw - MARGIN;
        top  = r.top + (r.height - ch) / 2;
        ax = r.left - 16; ay = r.top + r.height / 2 - 8; aSide = 'left';
      } else if (side === 'bottom') {
        left = r.left + (r.width - cw) / 2;
        top  = r.bottom + MARGIN;
        ax = r.left + r.width / 2 - 8; ay = r.bottom + 4; aSide = 'bottom';
      } else { // top
        left = r.left + (r.width - cw) / 2;
        top  = r.top - ch - MARGIN;
        ax = r.left + r.width / 2 - 8; ay = r.top - 16; aSide = 'top';
      }

      // Hard clamp so the card is always visible even if target is near edge
      // or the preferred side didn't fit. Arrow hides when we had to force.
      const clampedLeft = Math.max(VIEWPORT_PAD, Math.min(vw - cw - VIEWPORT_PAD, left));
      const clampedTop  = Math.max(VIEWPORT_PAD, Math.min(vh - ch - VIEWPORT_PAD, top));
      const clamped = clampedLeft !== left || clampedTop !== top;

      card.style.left = clampedLeft + 'px';
      card.style.top  = clampedTop + 'px';

      arrow.className = 'ob-arrow ' + (clamped || !fits[side] ? 'none' : aSide);
      if (!clamped && fits[side]) {
        arrow.style.left = ax + 'px';
        arrow.style.top  = ay + 'px';
      }
    }

    function layout() {
      const step = STEPS[idx];
      const el = $(step.selector);
      if (el) {
        // scrollIntoView is async with 'smooth'; measure after it settles.
        // 'nearest' (not 'center') avoids a useless jump if target is
        // already fully visible — nicer for sidebar items.
        const r0 = el.getBoundingClientRect();
        const fullyVisible = r0.top >= 0 && r0.bottom <= window.innerHeight && r0.left >= 0 && r0.right <= window.innerWidth;
        if (!fullyVisible) el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
        const delay = fullyVisible ? 0 : 320;
        setTimeout(() => place(el, step.pos || 'bottom'), delay);
      } else {
        // Target missing — skip this step gracefully
        return next();
      }

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
