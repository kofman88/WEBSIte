/**
 * Plan-gate helper — single source of truth on the frontend for
 * "what's allowed on the current user's plan." Mirrors the backend
 * matrix in /backend/config/plans.js so we stop showing buttons that
 * the API will reject anyway.
 *
 * Usage:
 *   await PlanGate.init();              // once, after Auth resolves
 *   PlanGate.canUseStrategy('smc');     // boolean
 *   PlanGate.requiredFor('strategy', 'gerchik'); // 'elite'
 *   PlanGate.maxLeverage();             // number (5 / 10 / 25 / 100)
 *   PlanGate.lockStrategyRadios(form);  // adds 🔒 + click→toast
 *   PlanGate.lockStrategySelect(select);
 *   PlanGate.lockTradingModeRadios(form);
 */
(function (global) {
  'use strict';

  // Mirror of backend/config/plans.js — strategies + feature flags only.
  // Numeric quotas (signalsPerDay, backtestsPerDay) are read separately
  // via API.me() since they can change with promo / trial.
  var PLAN_TABLE = {
    free:    { strategies: ['levels'], maxLeverage: 5,
               autoTrade: false, paperOnly: true, multiExchange: false,
               marketScanner: false, multiStrategy: false,
               optimizer: false, apiAccess: false, marketplacePublish: false,
               canCreateBot: false, canTrade: false, canAddExchangeKey: false, canRunBacktest: false,
               readOnly: true },
    starter: { strategies: ['levels'], maxLeverage: 10,
               autoTrade: false, paperOnly: true, multiExchange: false,
               marketScanner: false, multiStrategy: false,
               optimizer: false, apiAccess: false, marketplacePublish: true,
               canCreateBot: true, canTrade: true, canAddExchangeKey: true, canRunBacktest: true,
               readOnly: false },
    pro:     { strategies: ['levels', 'smc', 'dca', 'grid'], maxLeverage: 25,
               autoTrade: true, paperOnly: false, multiExchange: true,
               marketScanner: false, multiStrategy: false,
               optimizer: false, apiAccess: false, marketplacePublish: true,
               canCreateBot: true, canTrade: true, canAddExchangeKey: true, canRunBacktest: true,
               readOnly: false },
    elite:   { strategies: ['levels', 'smc', 'gerchik', 'scalping', 'dca', 'grid'], maxLeverage: 100,
               autoTrade: true, paperOnly: false, multiExchange: true,
               marketScanner: true, multiStrategy: true,
               optimizer: true, apiAccess: true, marketplacePublish: true,
               canCreateBot: true, canTrade: true, canAddExchangeKey: true, canRunBacktest: true,
               readOnly: false },
  };
  var PLAN_ORDER = ['free', 'starter', 'pro', 'elite'];
  var PLAN_LABEL = { free: 'Free', starter: 'Starter', pro: 'Pro', elite: 'Elite' };

  // Russian display name + the plan that unlocks it (for upsell toast).
  var STRATEGY_INFO = {
    levels:   { label: 'Levels',   minPlan: 'free' },
    smc:      { label: 'SMC',      minPlan: 'pro' },
    dca:      { label: 'DCA',      minPlan: 'pro' },
    grid:     { label: 'Grid',     minPlan: 'pro' },
    gerchik:  { label: 'Gerchik',  minPlan: 'elite' },
    scalping: { label: 'Scalping', minPlan: 'elite' },
  };

  var _plan = 'free';
  var _ready = false;
  var _readyPromise = null;

  function init() {
    if (_readyPromise) return _readyPromise;
    _readyPromise = (async function () {
      try {
        if (global.API && typeof API.me === 'function') {
          var r = await API.me();
          var u = r && (r.user || r);
          if (u && u.subscription && u.subscription.plan) _plan = u.subscription.plan;
        }
      } catch (_) { /* offline / not logged in → free */ }
      _ready = true;
    })();
    return _readyPromise;
  }

  function getPlan() { return _plan; }
  function ready() { return _ready; }
  function setPlan(p) { if (PLAN_TABLE[p]) _plan = p; }   // for testing / refresh

  function canUseStrategy(s) {
    var t = PLAN_TABLE[_plan];
    return Boolean(t && t.strategies.indexOf(s) !== -1);
  }
  function canUseFeature(flag) {
    var t = PLAN_TABLE[_plan];
    return Boolean(t && t[flag]);
  }
  function maxLeverage() {
    return (PLAN_TABLE[_plan] && PLAN_TABLE[_plan].maxLeverage) || 5;
  }
  function requiredForStrategy(s) {
    return (STRATEGY_INFO[s] && STRATEGY_INFO[s].minPlan) || 'pro';
  }
  function requiredForFeature(flag) {
    for (var i = 0; i < PLAN_ORDER.length; i++) {
      var t = PLAN_TABLE[PLAN_ORDER[i]];
      if (t && t[flag]) return PLAN_ORDER[i];
    }
    return 'elite';
  }
  function isAtLeast(target) {
    return PLAN_ORDER.indexOf(_plan) >= PLAN_ORDER.indexOf(target);
  }

  // ── UI helpers ───────────────────────────────────────────────────────

  // Show a toast (or alert fallback) explaining the upsell.
  function _upsell(featureName, requiredPlan) {
    var msg = featureName + ' — доступно на тарифе ' + (PLAN_LABEL[requiredPlan] || requiredPlan) + ' и выше';
    if (global.Toast && typeof Toast.warn === 'function') Toast.warn(msg);
    else if (global.Toast && typeof Toast.info === 'function') Toast.info(msg);
    else console.warn(msg);
  }

  // Premium lock icon — inline SVG (no emoji, no font dependency). Two
  // sizes: 12px for inline chips, 18px for hero banners. Solid amber-gold
  // fill that lights up on dark backgrounds without competing with our
  // primary orange CTA — feels like a hardware-keychain token rather than
  // a generic 🔒 glyph.
  var LOCK_SVG_SM = (
    '<svg class="plan-lock-svg" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">'
    +   '<path fill="currentColor" d="M12 1.5a4.5 4.5 0 0 0-4.5 4.5v3.75H6A1.5 1.5 0 0 0 4.5 11.25v9A1.5 1.5 0 0 0 6 21.75h12a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 18 9.75h-1.5V6A4.5 4.5 0 0 0 12 1.5Zm-3 4.5a3 3 0 0 1 6 0v3.75H9V6Z" opacity=".94"/>'
    +   '<path fill="rgba(255,255,255,.42)" d="M9 6a3 3 0 0 1 6 0v.6a3 3 0 0 0-6 0V6Z"/>'
    +   '<circle fill="rgba(0,0,0,.32)" cx="12" cy="15.6" r="1.4"/>'
    + '</svg>'
  );
  var LOCK_SVG_LG = (
    '<svg class="plan-lock-svg" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">'
    +   '<path fill="currentColor" d="M12 1.5a4.5 4.5 0 0 0-4.5 4.5v3.75H6A1.5 1.5 0 0 0 4.5 11.25v9A1.5 1.5 0 0 0 6 21.75h12a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 18 9.75h-1.5V6A4.5 4.5 0 0 0 12 1.5Zm-3 4.5a3 3 0 0 1 6 0v3.75H9V6Z"/>'
    +   '<path fill="rgba(255,255,255,.42)" d="M9 6a3 3 0 0 1 6 0v.6a3 3 0 0 0-6 0V6Z"/>'
    +   '<circle fill="rgba(0,0,0,.32)" cx="12" cy="15.6" r="1.4"/>'
    + '</svg>'
  );

  function _lockChip(planLabel) {
    return '<span class="plan-lock-chip">' + LOCK_SVG_SM + ' ' + planLabel + '</span>';
  }

  // Inject the lock-chip CSS once. Keeping styles co-located with the
  // helper (instead of styles.css) means a page just has to load
  // plan-gate.js to get the right premium look.
  function _injectStyles() {
    if (document.getElementById('plan-gate-styles')) return;
    var s = document.createElement('style');
    s.id = 'plan-gate-styles';
    s.textContent = (
      '.plan-lock-chip{display:inline-flex;align-items:center;gap:5px;'
      + 'font-size:9.5px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;'
      + 'color:#FFB28A;padding:3px 8px;border-radius:7px;'
      + 'background:linear-gradient(135deg,rgba(255,140,90,.18),rgba(255,90,31,.06));'
      + 'border:1px solid rgba(255,140,90,.36);'
      + 'box-shadow:inset 0 1px 0 rgba(255,255,255,.08),0 4px 10px -4px rgba(255,90,31,.4);'
      + 'white-space:nowrap;line-height:1}'
      + '.plan-lock-chip .plan-lock-svg{flex-shrink:0;color:#FFB28A;'
      + 'filter:drop-shadow(0 0 4px rgba(255,140,90,.5))}'
      + 'html.light .plan-lock-chip{color:#C44610;background:linear-gradient(135deg,rgba(255,90,31,.1),rgba(255,90,31,.02));border-color:rgba(255,90,31,.3)}'
      + 'html.light .plan-lock-chip .plan-lock-svg{color:#C44610;filter:none}'
      + '.plan-locked-btn{position:relative;cursor:pointer!important;opacity:.85;filter:saturate(.85)}'
      + '.plan-locked-btn::after{content:"";position:absolute;inset:0;border-radius:inherit;'
      + 'background:linear-gradient(135deg,rgba(255,140,90,.0),rgba(255,140,90,.12));pointer-events:none}'
      + '.plan-locked-btn .plan-lock-svg{margin-left:6px;color:#FFB28A;'
      + 'filter:drop-shadow(0 0 4px rgba(255,140,90,.6));vertical-align:-2px}'
      // Hero banner for whole-page locks (Terminal, etc.)
      + '.plan-gate-hero{max-width:560px;margin:48px auto;padding:32px 28px;'
      + 'border-radius:18px;text-align:center;'
      + 'background:radial-gradient(120% 100% at 50% 0%,rgba(255,90,31,.14),rgba(255,90,31,.02) 60%),'
      + 'linear-gradient(160deg,rgba(255,255,255,.04),rgba(255,255,255,.01));'
      + 'border:1px solid rgba(255,140,90,.28);'
      + 'box-shadow:inset 0 1px 0 rgba(255,255,255,.06),0 18px 48px -20px rgba(255,90,31,.45)}'
      + '.plan-gate-hero-ic{width:56px;height:56px;border-radius:14px;margin:0 auto 14px;'
      + 'background:linear-gradient(135deg,rgba(255,140,90,.22),rgba(255,90,31,.06));'
      + 'border:1px solid rgba(255,140,90,.4);color:#FFB28A;'
      + 'box-shadow:inset 0 1px 0 rgba(255,255,255,.1),0 8px 18px -6px rgba(255,90,31,.5);'
      + 'display:flex;align-items:center;justify-content:center}'
      + '.plan-gate-hero-ic .plan-lock-svg{filter:drop-shadow(0 0 8px rgba(255,140,90,.7))}'
      + '.plan-gate-hero h2{font-family:"Inter",sans-serif;font-weight:700;font-size:22px;'
      + 'color:#fff;margin:0 0 8px;letter-spacing:-.015em}'
      + 'html.light .plan-gate-hero h2{color:#0A0A0A}'
      + '.plan-gate-hero p{font-size:13.5px;line-height:1.55;color:rgba(255,255,255,.62);margin:0 0 22px}'
      + 'html.light .plan-gate-hero p{color:rgba(10,10,10,.65)}'
      + '.plan-gate-hero a{display:inline-flex;align-items:center;gap:7px;padding:10px 22px;'
      + 'border-radius:9999px;font-size:13px;font-weight:600;text-decoration:none;'
      + 'background:linear-gradient(180deg,#FF7840,#FF5A1F 60%,#C44610);color:#fff;'
      + 'box-shadow:inset 0 1px 1px rgba(255,255,255,.28),0 6px 16px -4px rgba(255,90,31,.55);'
      + 'transition:transform .15s,box-shadow .15s}'
      + '.plan-gate-hero a:hover{transform:translateY(-1px);box-shadow:inset 0 1px 1px rgba(255,255,255,.34),0 8px 20px -4px rgba(255,90,31,.7)}'
    );
    document.head.appendChild(s);
  }
  if (typeof document !== 'undefined' && document.head) _injectStyles();
  else if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', _injectStyles);

  /**
   * Walk every <input name="strategyType"> radio in `root`. Disable + dim
   * the ones the current plan can't use, and append a small 🔒 chip with
   * the unlocking plan. Click on a locked radio shows an upsell toast
   * and refuses to select it.
   */
  function lockStrategyRadios(root) {
    if (!root) return;
    var radios = root.querySelectorAll('input[type="radio"][name="strategyType"]');
    radios.forEach(function (r) {
      var s = r.value;
      if (canUseStrategy(s)) return;
      var req = requiredForStrategy(s);
      var card = r.closest('label, .wiz-card') || r.parentElement;
      if (!card) return;
      card.classList.add('plan-locked');
      card.setAttribute('data-plan-required', req);
      r.disabled = true;
      // Idempotency guard: every openWizard() call would otherwise stack
      // a new click listener, leading to N toasts on a single click after
      // N opens.
      if (card.dataset.planLocked === '1') return;
      card.dataset.planLocked = '1';
      if (!card.querySelector('.plan-lock-chip')) {
        var holder = card.querySelector('.wiz-card-body') || card;
        holder.insertAdjacentHTML('beforeend', _lockChip(PLAN_LABEL[req]));
      }
      card.addEventListener('click', function (ev) {
        if (r.disabled) {
          ev.preventDefault(); ev.stopPropagation();
          _upsell('Стратегия ' + (STRATEGY_INFO[s] && STRATEGY_INFO[s].label || s), req);
        }
      }, true);
    });
  }

  /**
   * Mark forbidden <option>s in a strategy <select> as disabled and
   * append a "(Pro+)" / "(Elite)" suffix. Optionally drop options
   * entirely (set dropForbidden=true) — used for filter dropdowns where
   * a forbidden option is just confusing.
   *
   * The bots page wraps every <select> with chmEnhanceSelects() into a
   * custom dropdown of <button class="chm-select-option" data-value="…">,
   * so we ALSO have to mirror the disabled / removed state onto those
   * buttons or the user clicks the visible UI and the native disabled
   * flag never fires.
   */
  function lockStrategySelect(sel, opts) {
    if (!sel) return;
    var dropForbidden = !!(opts && opts.dropForbidden);
    var wrap = sel.closest && sel.closest('.chm-select');
    var currentValue = sel.value;   // preserve legacy/grandfathered selection

    Array.from(sel.options).forEach(function (o) {
      var s = (o.value || '').toLowerCase();
      if (!s || !STRATEGY_INFO[s]) return;
      if (canUseStrategy(s)) return;
      // Never lock the currently-selected option — a user with a legacy
      // Gerchik bot from a previous Pro subscription should still see
      // their bot's strategy displayed correctly. They just can't switch
      // to another forbidden one.
      if (s === currentValue) return;
      var req = requiredForStrategy(s);
      var btn = wrap ? wrap.querySelector('.chm-select-option[data-value="' + CSS.escape(o.value) + '"]') : null;

      if (dropForbidden) {
        o.remove();
        if (btn) btn.remove();
        return;
      }
      o.disabled = true;
      if (o.text.indexOf('(') === -1) o.text = o.text + ' (' + PLAN_LABEL[req] + ')';

      if (btn && !btn.dataset.planLocked) {
        btn.dataset.planLocked = '1';
        btn.dataset.planRequired = req;
        btn.classList.add('chm-select-option-locked');
        if (btn.textContent.indexOf('(') === -1) btn.textContent = btn.textContent + ' (' + PLAN_LABEL[req] + ')';
        btn.title = 'Доступно на тарифе ' + PLAN_LABEL[req] + ' и выше';
        // Capture-phase listener wins over the default click handler that
        // would otherwise set sel.value to the locked option.
        btn.addEventListener('click', function (ev) {
          ev.stopImmediatePropagation();
          ev.preventDefault();
          _upsell('Стратегия ' + (STRATEGY_INFO[s] && STRATEGY_INFO[s].label || s), req);
        }, true);
      }
    });
  }

  /**
   * Lock a single <option value="X"> in any <select>. Used for non-strategy
   * dropdowns like tradingMode (paper/live).
   */
  function lockSelectOption(sel, value, requiredPlan, featureName) {
    if (!sel) return;
    var opt = Array.from(sel.options).find(function (o) { return o.value === value; });
    if (!opt) return;
    var label = PLAN_LABEL[requiredPlan] || requiredPlan;
    opt.disabled = true;
    if (opt.text.indexOf('(') === -1) opt.text = opt.text + ' (' + label + ')';
    var wrap = sel.closest && sel.closest('.chm-select');
    var btn = wrap ? wrap.querySelector('.chm-select-option[data-value="' + CSS.escape(value) + '"]') : null;
    if (btn && !btn.dataset.planLocked) {
      btn.dataset.planLocked = '1';
      btn.classList.add('chm-select-option-locked');
      if (btn.textContent.indexOf('(') === -1) btn.textContent = btn.textContent + ' (' + label + ')';
      btn.addEventListener('click', function (ev) {
        ev.stopImmediatePropagation();
        ev.preventDefault();
        _upsell(featureName, requiredPlan);
      }, true);
    }
    if (sel.value === value) {
      var firstAllowed = Array.from(sel.options).find(function (o) { return !o.disabled; });
      if (firstAllowed) {
        sel.value = firstAllowed.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        if (wrap) {
          var trig = wrap.querySelector('.chm-select-label');
          if (trig) trig.textContent = firstAllowed.text;
        }
      }
    }
  }

  /**
   * Lock the LIVE radio in a tradingMode pair when the plan is paper-only
   * (Free / Starter). No-op for Pro+ where live trading is allowed.
   */
  function lockTradingModeRadios(root) {
    if (!root) return;
    var t = PLAN_TABLE[_plan];
    if (!t || !t.paperOnly) return; // Pro+ → live is fine
    var liveRadios = root.querySelectorAll('input[type="radio"][name="tradingMode"][value="live"]');
    liveRadios.forEach(function (r) {
      var card = r.closest('label, .wiz-card') || r.parentElement;
      if (!card) return;
      card.classList.add('plan-locked');
      r.disabled = true;
      if (card.dataset.planLocked === '1') return;
      card.dataset.planLocked = '1';
      if (!card.querySelector('.plan-lock-chip')) {
        var holder = card.querySelector('.wiz-card-body') || card;
        holder.insertAdjacentHTML('beforeend', _lockChip('Pro'));
      }
      card.addEventListener('click', function (ev) {
        if (r.disabled) {
          ev.preventDefault(); ev.stopPropagation();
          _upsell('Live-торговля', 'pro');
        }
      }, true);
    });
  }

  /**
   * Clamp a leverage <input>'s `max` to the user's plan limit and add a
   * small label hint next to it.
   */
  function clampLeverageInput(input) {
    if (!input) return;
    var lim = maxLeverage();
    input.max = String(lim);
    if (Number(input.value) > lim) input.value = String(lim);
    if (!input.dataset.planClamped) {
      input.dataset.planClamped = '1';
      input.addEventListener('input', function () {
        if (Number(input.value) > lim) input.value = String(lim);
      });
    }
    var hint = input.parentElement && input.parentElement.querySelector('.plan-leverage-hint');
    if (!hint && input.parentElement) {
      hint = document.createElement('span');
      hint.className = 'plan-leverage-hint';
      hint.textContent = 'до ' + lim + '× на тарифе ' + PLAN_LABEL[_plan];
      input.parentElement.appendChild(hint);
    }
  }

  /**
   * Generic gate: if the feature is locked, replace `el`'s click with an
   * upsell toast and add `.plan-locked` class. `featureName` is shown in
   * the toast.
   */
  function gateClickable(el, flag, featureName) {
    if (!el) return;
    if (canUseFeature(flag)) return;
    var req = requiredForFeature(flag);
    el.classList.add('plan-locked');
    el.setAttribute('data-plan-required', req);
    el.addEventListener('click', function (ev) {
      ev.preventDefault(); ev.stopPropagation();
      _upsell(featureName, req);
    }, true);
  }

  function isReadOnly() { return Boolean(PLAN_TABLE[_plan] && PLAN_TABLE[_plan].readOnly); }

  /**
   * Lock a button (or any clickable). Adds the premium SVG inline,
   * intercepts click with an upsell toast, and applies the
   * .plan-locked-btn dimming.
   *   PlanGate.lockButton(btn, { flag: 'canCreateBot', requiredPlan: 'starter', featureName: 'Создание ботов' })
   * Either pass a `flag` (looked up via canUseFeature) or `force: true`
   * to always lock.
   */
  function lockButton(el, opts) {
    if (!el || !opts) return;
    var force = !!opts.force;
    var flag = opts.flag;
    if (!force && flag && canUseFeature(flag)) return;
    if (el.dataset.planLocked === '1') return;
    var req = opts.requiredPlan || (flag ? requiredForFeature(flag) : 'starter');
    var name = opts.featureName || 'Эта функция';
    el.dataset.planLocked = '1';
    el.classList.add('plan-locked-btn');
    el.setAttribute('data-plan-required', req);
    // Append the lock icon if not already present (inline so it lives
    // inside the button no matter what flex/grid layout it's in).
    if (!el.querySelector('.plan-lock-svg')) el.insertAdjacentHTML('beforeend', LOCK_SVG_SM);
    el.addEventListener('click', function (ev) {
      ev.preventDefault(); ev.stopImmediatePropagation();
      _upsell(name, req);
    }, true);
  }

  /**
   * Replace a container's contents with a premium upgrade banner. Used
   * for whole-page locks (Terminal, etc.).
   *   PlanGate.gatePageHero(document.querySelector('main'), {
   *     featureName: 'Терминал ручной торговли',
   *     requiredPlan: 'starter',
   *     description: 'На Free-тарифе можно только смотреть. ...',
   *   })
   * Returns true if the gate was applied (plan can't use the feature).
   */
  function gatePageHero(container, opts) {
    if (!container || !opts) return false;
    if (opts.flag && canUseFeature(opts.flag)) return false;
    if (!opts.flag && !opts.force) return false;
    var req = opts.requiredPlan || (opts.flag ? requiredForFeature(opts.flag) : 'starter');
    var name = opts.featureName || 'Эта функция';
    var desc = opts.description || ('Доступно на тарифе ' + (PLAN_LABEL[req] || req) + ' и выше. Free-пользователи могут только знакомиться с интерфейсом.');
    container.innerHTML =
      '<div class="plan-gate-hero">'
      +   '<h2>' + name + ' — ' + (PLAN_LABEL[req] || req) + '+</h2>'
      +   '<p>' + desc + '</p>'
      +   '<a href="subscriptions.html?plan=' + req + '">Перейти на ' + (PLAN_LABEL[req] || req) + ' →</a>'
      + '</div>';
    return true;
  }

  // Expose
  global.PlanGate = {
    init: init, ready: ready, getPlan: getPlan, setPlan: setPlan,
    canUseStrategy: canUseStrategy, canUseFeature: canUseFeature,
    maxLeverage: maxLeverage,
    requiredForStrategy: requiredForStrategy, requiredForFeature: requiredForFeature,
    isAtLeast: isAtLeast, isReadOnly: isReadOnly,
    PLAN_LABEL: PLAN_LABEL, STRATEGY_INFO: STRATEGY_INFO,
    LOCK_SVG_SM: LOCK_SVG_SM, LOCK_SVG_LG: LOCK_SVG_LG,
    lockStrategyRadios: lockStrategyRadios,
    lockStrategySelect: lockStrategySelect,
    lockSelectOption: lockSelectOption,
    lockTradingModeRadios: lockTradingModeRadios,
    clampLeverageInput: clampLeverageInput,
    gateClickable: gateClickable,
    lockButton: lockButton,
    gatePageHero: gatePageHero,
  };

  // Auto-init as soon as the script loads — most pages need the plan
  // immediately. Idempotent.
  init();
})(window);
