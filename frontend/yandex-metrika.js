/**
 * yandex-metrika.js — Метрика + цели (events) для CHM Finance.
 *
 * Loaded once on every page; the inline counter snippet below is the
 * official one Yandex generates for counter 108973987 (Webvisor + click
 * map + scroll map + form analytics). Then we wire delegated listeners
 * for the 8 product events so any new button matching the selectors
 * automatically gets tracked without touching markup.
 *
 * Goals (visible in Метрика → Цели as JS-event goals):
 *   cta_hero_click       — клик главного CTA «Начать бесплатно» в hero
 *   cta_pricing_click    — клик «Начать / Выбрать» под планом (с params: plan)
 *   cta_telegram_click   — клик любой TG-кнопки  (params: target=bot|community, placement=hero|pricing|community|footer)
 *   register_open        — модалка регистрации открыта
 *   register_success     — успешная регистрация
 *   login_success        — успешный вход
 *   cookies_accept       — клик «Принять» на cookie-баннере
 *   cookies_decline      — клик «Отклонить»
 *
 * Wired through one delegated listener so it survives any DOM rerender
 * (modals, dynamic cards, lazy-loaded sections).
 */
(function(){
  // ── Official Yandex counter snippet (108973987) ────────────────────
  (function(m,e,t,r,i,k,a){m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};
  m[i].l=1*new Date();
  for (var j=0; j<document.scripts.length; j++) {if (document.scripts[j].src===r) { return; }}
  k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)})
  (window, document, "script", "https://mc.yandex.ru/metrika/tag.js?id=108973987", "ym");

  ym(108973987, "init", {
    ssr:true,
    webvisor:true,
    clickmap:true,
    ecommerce:"dataLayer",
    accurateTrackBounce:true,
    trackLinks:true,
    triggerEvent:true
  });

  // Helper: send a goal with optional params. Wrap in try so a single
  // error never breaks the page. params shows up in Метрика → Параметры
  // визитов / целей as nested keys.
  function track(goal, params){
    try { ym(108973987, 'reachGoal', goal, params || {}); } catch (_) {}
  }
  window.chmTrack = track;

  // ── Delegated listeners (one per page, no per-button wiring) ────────
  document.addEventListener('click', function(e){
    var t = e.target;
    if (!t || !t.closest) return;

    // CTAs in the hero section
    var heroCta = t.closest('.hero [data-open-modal="register"], .hero a[href="#how"]');
    if (heroCta && heroCta.matches('[data-open-modal="register"]')) {
      track('cta_hero_click', { variant: 'register' });
    }

    // Pricing plan buttons
    var planBtn = t.closest('[data-pick-plan]');
    if (planBtn) {
      track('cta_pricing_click', { plan: planBtn.getAttribute('data-pick-plan') || 'unknown' });
    }

    // Any Telegram link — classify by where it lives + target handle
    var tgLink = t.closest('a[href*="t.me/"]');
    if (tgLink) {
      var href = tgLink.getAttribute('href') || '';
      var handle = (href.match(/t\.me\/([\w_]+)/) || [])[1] || '';
      var target = handle === 'chmbotsignal' ? 'bot' : 'community';
      var placement = 'unknown';
      if (tgLink.classList.contains('hero-tg')) placement = 'hero';
      else if (tgLink.classList.contains('price-tg-btn')) placement = 'pricing';
      else if (tgLink.closest('#community')) placement = 'community';
      else if (tgLink.closest('footer')) placement = 'footer';
      else if (tgLink.closest('.sidebar-footer')) placement = 'sidebar';
      track('cta_telegram_click', { target: target, placement: placement, handle: handle });
    }

    // Generic "open register modal" — broader than hero (nav, etc.)
    var regOpen = t.closest('[data-open-modal="register"]');
    if (regOpen && !heroCta) {
      track('register_open', { from: regOpen.closest('nav') ? 'nav' : 'page' });
    }

    // Cookie banner — buttons have explicit ids
    if (t.closest('#cbAccept'))  track('cookies_accept');
    if (t.closest('#cbDecline')) track('cookies_decline');
  }, true);

  // Form submits — we hook into the inline auth-form submit handlers in
  // index.html via window.chmTrack(). They fire register_success /
  // login_success after Toast.success(). We expose chmTrack globally
  // above so those handlers can call it without re-importing.
})();
