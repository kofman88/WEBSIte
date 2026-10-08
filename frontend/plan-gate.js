/**
 * Plan-gate helper — single source of truth on the frontend for
 * "what's allowed on the current user's plan." Mirrors the backend
 * matrix in /backend/config/planFeatures.js (the bot's PLAN_FEATURES,
 * verbatim) so we stop showing buttons that the API will reject anyway.
 *
 * Two plans, like the bot: free and pro. Retired ids (starter / elite /
 * beginner) normalise exactly like the bot's normalize_plan:
 * pro | elite | beginner → pro, anything else → free.
 *
 * Usage:
 *   await PlanGate.init();                 // once, after Auth resolves
 *   PlanGate.canUseStrategy('smc');        // boolean (any case)
 *   PlanGate.canUseFeature('auto_trade');  // bot key …
 *   PlanGate.canUseFeature('autoTrade');   // … or the site's camelCase alias
 *   PlanGate.planLimit('analyze_per_day'); // 1 / 999
 *   PlanGate.requiredForStrategy('smc');   // 'pro'
 */
(function (global) {
  'use strict';

  // ── Mirror of backend/config/planFeatures.js — keep in sync ─────────
  var PLAN_FEATURES = {
    free: {
      strategies:                 ['LEVELS'],
      both_directions:            false,
      long_only:                  false,
      auto_trade:                 false,
      max_trades:                 0,
      signals_per_day:            2,
      min_signal_quality:         5,
      signal_window_morning_utc:  [6, 13],
      signal_window_evening_utc:  [13, 21],
      analyze_per_day:            1,
      symbols_limit:              5,
      timeframes:                 ['15m', '1h'],
      smc:                        false,
      volume:                     false,
      notifications:              'basic',
      optimizer:                  false,
      target_wr:                  false,
      genome:                     false,
      ai_explanations:            false,
      multi_exchange:             false,
      api_access:                 false,
      priority_support:           false,
      all_timeframes:             false,
      more_symbols:               false,
      unlimited_trades:           false,
      expert_mode:                false,
      strategies_extended:        false,
      ai_layer_market_regime:     false,
      ai_layer_news_monitor:      false,
      ai_layer_genome_engine:     false,
      ai_plus_tools:              false,
      challenge:                  false
    },
    pro: {
      strategies:                 ['LEVELS', 'SMC', 'VOLUME'],
      both_directions:            true,
      long_only:                  false,
      auto_trade:                 true,
      max_trades:                 0,
      signals_per_day:            999,
      min_signal_quality:         3,
      analyze_per_day:            999,
      symbols_limit:              999,
      timeframes:                 ['15m', '30m', '1h', '4h', '1d'],
      smc:                        true,
      volume:                     true,
      notifications:              'premium',
      optimizer:                  true,
      target_wr:                  true,
      genome:                     true,
      ai_explanations:            true,
      multi_exchange:             true,
      api_access:                 true,
      priority_support:           true,
      all_timeframes:             true,
      more_symbols:               true,
      unlimited_trades:           true,
      expert_mode:                true,
      strategies_extended:        true,
      ai_layer_market_regime:     true,
      ai_layer_news_monitor:      true,
      ai_layer_genome_engine:     true,
      ai_plus_tools:              true,
      challenge:                  true
    }
  };
  var PLAN_PRICES_USD = { free: 0, pro: 69 };
  var PLAN_ORDER = ['free', 'pro'];
  var PLAN_LABEL = { free: 'Free', pro: 'Pro' };

  // camelCase site flags → bot feature keys
  var FLAG_TO_FEATURE = {
    autoTrade: 'auto_trade', bothDirections: 'both_directions',
    multiExchange: 'multi_exchange', apiAccess: 'api_access',
    prioritySupport: 'priority_support', allTimeframes: 'all_timeframes',
    expertMode: 'expert_mode', moreSymbols: 'more_symbols',
    unlimitedTrades: 'unlimited_trades', aiExplanations: 'ai_explanations',
    targetWr: 'target_wr',
    // legacy site flags from the per-bot product
    canAddExchangeKey: 'auto_trade', paperOnly: 'paperTradingOnly'
  };

  // Display name + the plan that unlocks it (for upsell toast).
  var STRATEGY_INFO = {
    levels: { label: 'Levels', minPlan: 'free' },
    smc:    { label: 'SMC',    minPlan: 'pro' },
    volume: { label: 'Volume', minPlan: 'pro' }
  };

  function normalizePlan(p) {
    var id = String(p == null ? '' : p).trim().toLowerCase();
    if (id === 'pro' || id === 'elite' || id === 'beginner') return 'pro';
    return 'free';
  }

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
          if (u && u.subscription && u.subscription.plan) _plan = normalizePlan(u.subscription.plan);
        }
      } catch (_) { /* offline / not logged in → free */ }
      _ready = true;
    })();
    return _readyPromise;
  }

  function getPlan() { return _plan; }
  function ready() { return _ready; }
  function setPlan(p) { _plan = normalizePlan(p); }   // for testing / refresh

  // bot `can()`: bool → itself; number → > 0; set → non-empty; else Boolean
  function _can(plan, feature) {
    var row = PLAN_FEATURES[normalizePlan(plan)];
    if (feature === 'paperTradingOnly') return !row.auto_trade;
    var key = FLAG_TO_FEATURE[feature] || feature;
    if (key === 'paperTradingOnly') return !row.auto_trade;
    var val = row[key];
    if (typeof val === 'boolean') return val;
    if (typeof val === 'number') return val > 0;
    if (Array.isArray(val)) return val.length > 0;
    return Boolean(val);
  }

  function canUseStrategy(s) {
    return PLAN_FEATURES[_plan].strategies.indexOf(String(s || '').toUpperCase()) !== -1;
  }
  function canUseTimeframe(tf) {
    return PLAN_FEATURES[_plan].timeframes.indexOf(String(tf || '')) !== -1;
  }
  function canUseFeature(flag) { return _can(_plan, flag); }
  function planLimit(key) {
    var v = PLAN_FEATURES[_plan][key];
    return v === undefined ? 0 : v;
  }
  function requiredForStrategy(s) {
    var key = String(s || '').toLowerCase();
    return (STRATEGY_INFO[key] && STRATEGY_INFO[key].minPlan) || 'pro';
  }
  function requiredForFeature(flag) {
    for (var i = 0; i < PLAN_ORDER.length; i++) {
      if (_can(PLAN_ORDER[i], flag)) return PLAN_ORDER[i];
    }
    return 'pro';
  }
  function isAtLeast(target) {
    return PLAN_ORDER.indexOf(_plan) >= PLAN_ORDER.indexOf(normalizePlan(target));
  }
  // The bot lets Free users change every setting; there is no read-only tier.
  function isReadOnly() { return false; }

  // ── UI helpers ───────────────────────────────────────────────────────

  // Show a toast (or alert fallback) explaining the upsell.
  function _upsell(featureName, requiredPlan) {
    var msg = featureName + ' — доступно на тарифе ' + (PLAN_LABEL[requiredPlan] || requiredPlan);
    if (global.Toast && typeof Toast.warn === 'function') Toast.warn(msg);
    else if (global.Toast && typeof Toast.info === 'function') Toast.info(msg);
    else console.warn(msg);
  }

  // Premium lock icon — inline SVG (no emoji, no font dependency). Two
  // sizes: 12px for inline chips, 22px for hero banners. Solid amber-gold
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
      // Hero banner for whole-page locks
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
   * Lock a single <option value="X"> in any <select>. Used for non-strategy
   * dropdowns (e.g. an exchange or timeframe selector).
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

  /**
   * Lock a button (or any clickable). Adds the premium SVG inline,
   * intercepts click with an upsell toast, and applies the
   * .plan-locked-btn dimming.
   *   PlanGate.lockButton(btn, { flag: 'auto_trade', requiredPlan: 'pro', featureName: 'Автоторговля' })
   * Either pass a `flag` (looked up via canUseFeature) or `force: true`
   * to always lock.
   */
  function lockButton(el, opts) {
    if (!el || !opts) return;
    var force = !!opts.force;
    var flag = opts.flag;
    if (!force && flag && canUseFeature(flag)) return;
    if (el.dataset.planLocked === '1') return;
    var req = opts.requiredPlan || (flag ? requiredForFeature(flag) : 'pro');
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
   * for whole-page locks.
   *   PlanGate.gatePageHero(document.querySelector('main'), {
   *     featureName: 'Автоторговля',
   *     requiredPlan: 'pro',
   *     description: 'На Free-тарифе доступны только сигналы LEVELS. ...',
   *   })
   * Returns true if the gate was applied (plan can't use the feature).
   */
  function gatePageHero(container, opts) {
    if (!container || !opts) return false;
    if (opts.flag && canUseFeature(opts.flag)) return false;
    if (!opts.flag && !opts.force) return false;
    var req = opts.requiredPlan || (opts.flag ? requiredForFeature(opts.flag) : 'pro');
    var name = opts.featureName || 'Эта функция';
    var desc = opts.description || ('Доступно на тарифе ' + (PLAN_LABEL[req] || req) + '. Free — 2 сигнала LEVELS в день, одно направление.');
    container.innerHTML =
      '<div class="plan-gate-hero">'
      +   '<h2>' + name + ' — ' + (PLAN_LABEL[req] || req) + '</h2>'
      +   '<p>' + desc + '</p>'
      +   '<a href="subscriptions.html?plan=' + req + '">Перейти на ' + (PLAN_LABEL[req] || req) + ' →</a>'
      + '</div>';
    return true;
  }

  // Expose
  global.PlanGate = {
    init: init, ready: ready, getPlan: getPlan, setPlan: setPlan,
    normalizePlan: normalizePlan,
    canUseStrategy: canUseStrategy, canUseFeature: canUseFeature,
    canUseTimeframe: canUseTimeframe, planLimit: planLimit,
    requiredForStrategy: requiredForStrategy, requiredForFeature: requiredForFeature,
    isAtLeast: isAtLeast, isReadOnly: isReadOnly,
    PLAN_FEATURES: PLAN_FEATURES, PLAN_PRICES_USD: PLAN_PRICES_USD,
    PLAN_ORDER: PLAN_ORDER, PLAN_LABEL: PLAN_LABEL, STRATEGY_INFO: STRATEGY_INFO,
    LOCK_SVG_SM: LOCK_SVG_SM, LOCK_SVG_LG: LOCK_SVG_LG,
    lockSelectOption: lockSelectOption,
    gateClickable: gateClickable,
    lockButton: lockButton,
    gatePageHero: gatePageHero,
    _lockChip: _lockChip
  };

  // Auto-init as soon as the script loads — most pages need the plan
  // immediately. Idempotent.
  init();
})(window);
