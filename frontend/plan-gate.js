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
               optimizer: false, apiAccess: false, marketplacePublish: false },
    starter: { strategies: ['levels'], maxLeverage: 10,
               autoTrade: false, paperOnly: true, multiExchange: false,
               marketScanner: false, multiStrategy: false,
               optimizer: false, apiAccess: false, marketplacePublish: true },
    pro:     { strategies: ['levels', 'smc', 'dca', 'grid'], maxLeverage: 25,
               autoTrade: true, paperOnly: false, multiExchange: true,
               marketScanner: false, multiStrategy: false,
               optimizer: false, apiAccess: false, marketplacePublish: true },
    elite:   { strategies: ['levels', 'smc', 'gerchik', 'scalping', 'dca', 'grid'], maxLeverage: 100,
               autoTrade: true, paperOnly: false, multiExchange: true,
               marketScanner: true, multiStrategy: true,
               optimizer: true, apiAccess: true, marketplacePublish: true },
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

  function _lockChip(planLabel) {
    return '<span class="plan-lock-chip">🔒 ' + planLabel + '</span>';
  }

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
      // Append lock chip if not already there
      if (!card.querySelector('.plan-lock-chip')) {
        var holder = card.querySelector('.wiz-card-body') || card;
        holder.insertAdjacentHTML('beforeend', _lockChip(PLAN_LABEL[req]));
      }
      r.disabled = true;
      // Capture click on the surrounding label so we can intercept early
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
   */
  function lockStrategySelect(sel, opts) {
    if (!sel) return;
    var dropForbidden = !!(opts && opts.dropForbidden);
    Array.from(sel.options).forEach(function (o) {
      var s = (o.value || '').toLowerCase();
      if (!s || !STRATEGY_INFO[s]) return;
      if (canUseStrategy(s)) return;
      if (dropForbidden) { o.remove(); return; }
      var req = requiredForStrategy(s);
      o.disabled = true;
      if (o.text.indexOf('(') === -1) o.text = o.text + ' (' + PLAN_LABEL[req] + ')';
    });
  }

  /**
   * Lock the LIVE radio in a tradingMode pair when the plan is paper-only.
   * Adds a lock chip and intercepts clicks.
   */
  function lockTradingModeRadios(root) {
    if (!root) return;
    if (!canUseFeature('paperOnly') === false) return; // plan IS paper-only
    if (!PLAN_TABLE[_plan].paperOnly) return;          // Pro+ → no-op
    var liveRadios = root.querySelectorAll('input[type="radio"][value="live"]');
    liveRadios.forEach(function (r) {
      var card = r.closest('label, .wiz-card') || r.parentElement;
      if (!card) return;
      card.classList.add('plan-locked');
      if (!card.querySelector('.plan-lock-chip')) {
        var holder = card.querySelector('.wiz-card-body') || card;
        holder.insertAdjacentHTML('beforeend', _lockChip('Pro'));
      }
      r.disabled = true;
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
    input.addEventListener('input', function () {
      if (Number(input.value) > lim) input.value = String(lim);
    });
    // Add hint next to the field if there isn't one already
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

  // Expose
  global.PlanGate = {
    init: init, ready: ready, getPlan: getPlan, setPlan: setPlan,
    canUseStrategy: canUseStrategy, canUseFeature: canUseFeature,
    maxLeverage: maxLeverage,
    requiredForStrategy: requiredForStrategy, requiredForFeature: requiredForFeature,
    isAtLeast: isAtLeast,
    PLAN_LABEL: PLAN_LABEL, STRATEGY_INFO: STRATEGY_INFO,
    lockStrategyRadios: lockStrategyRadios,
    lockStrategySelect: lockStrategySelect,
    lockTradingModeRadios: lockTradingModeRadios,
    clampLeverageInput: clampLeverageInput,
    gateClickable: gateClickable,
  };

  // Auto-init as soon as the script loads — most pages need the plan
  // immediately. Idempotent.
  init();
})(window);
