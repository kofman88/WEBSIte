/**
 * help-tips.js — универсальные подсказки для новичков.
 *
 * Декларативное использование: на любом элементе пишешь
 *   <span data-help="pnl">PnL</span>
 * скрипт автоматически дорисует ?-иконку рядом и при hover/click
 * покажет всплывающее объяснение из словаря HELP_TEXTS.
 *
 * Можно также передать кастомный текст напрямую:
 *   <span data-help-text="Здесь будет твой текст">Что-то</span>
 *
 * Tooltip:
 *   - открывается на mouseenter / focus / click (mobile-friendly)
 *   - закрывается на mouseleave / blur / Escape / клик вне
 *   - позиционируется снизу элемента, флипается наверх если не помещается
 *   - keyboard-accessible (tabindex=0 на иконке)
 *
 * Совместимость: подключай через
 *   <script src="help-tips.js" defer></script>
 * на любой авторизованной странице.
 */
(function () {
  'use strict';

  // ── Словарь объяснений (RU). Ключи — короткие токены чтобы было удобно
  //    проставлять data-help. Ru + краткое определение + чем полезно.
  const HELP_TEXTS = {
    // ── Trading metrics ────────────────────────────────────────────────
    'pnl': 'PnL (Profit and Loss) — сколько ты заработал или потерял в долларах. Положительный = профит, отрицательный = убыток.',
    'r-multiple': 'R-multiple — результат сделки в единицах риска. 1R = заработал столько же, сколько ставил на стоп. 3R = заработал в 3 раза больше риска. Распределение показывает, есть ли «жирный правый хвост» — главный признак прибыльной стратегии.',
    'pnl-by-strategy': 'PnL по стратегиям — какая стратегия принесла сколько прибыли/убытка. Помогает увидеть, какие алгоритмы работают, а какие пора отключить.',
    'top-bots': 'Топ ботов — твои самые прибыльные боты за последние 30 дней по сумме PnL. Используй для отбора лучших и удаления отстающих.',
    'risk-in-play': 'Risk in Play — сколько долларов сейчас под риском в открытых позициях (сумма потенциальных потерь, если все стопы сработают). Не должно превышать 5-10% от депозита.',
    'percentile': 'Percentile — твоя позиция в leaderboard по доходности за период. 80-й перцентиль = ты лучше 80% трейдеров платформы.',
    'best-trade': 'Лучшая сделка — самая прибыльная закрытая сделка за всё время. Помогает понять потолок одного входа.',
    'worst-trade': 'Худшая сделка — самый крупный убыток на одной сделке. Если он больше 2-3% депозита — нужно ужесточить SL.',
    'streak': 'Серия — сколько прибыльных или убыточных сделок подряд закрыл бот. Длинная win-стрик = стратегия в потоке. Длинная loss-стрик = повод включить kill-switch.',
    'calendar-pnl': 'Календарь P&L — каждая клетка это один день. Зелёная = плюс, красная = минус, серая = не торговал. Помогает увидеть «больные дни» недели.',
    'hourly-pnl': 'PnL по часам — в какие часы дня (UTC) бот зарабатывает лучше всего. Если у тебя пик в 14:00 UTC — можно ограничить торговлю этим окном.',
    'equity-curve': 'Кривая капитала — график твоего депозита по дням. Идёт вверх под углом 30-45° = стратегия здоровая. Резкие скачки или провалы = повышенный риск.',
    'open-positions': 'Открытые позиции — сделки которые сейчас идут, ещё не закрыты. PnL по ним — нереализованный, может ещё измениться.',
    'total-pnl': 'Total PnL — суммарная прибыль/убыток по всем закрытым сделкам бота за всё время.',
    'live-pnl': 'Live PnL — прибыль/убыток только по реальным сделкам (live-режим). Demo-сделки не учитываются.',
    'unrealized-pnl': 'Unrealized PnL — потенциальная прибыль/убыток по ОТКРЫТЫМ позициям. Зафиксируется только когда позиция закроется.',
    'realized-pnl': 'Realized PnL — фактически зафиксированная прибыль/убыток по уже ЗАКРЫТЫМ сделкам.',
    'win-rate': 'Win Rate — процент прибыльных сделок от всех закрытых. 60% значит 6 из 10 сделок в плюс. Норма для бота — 45-65%.',
    'trades': 'Trades — общее количество закрытых сделок. Чем больше история, тем надёжнее статистика.',
    'open-trades': 'Открытых позиций — сколько сделок прямо сейчас в работе (ещё не закрыты).',
    'profit-factor': 'Profit Factor = валовая прибыль / валовый убыток. PF=1.5 — стратегия заработала в 1.5 раза больше, чем потеряла. Хорошо ≥ 1.5, отлично ≥ 2.0.',
    'sharpe': 'Sharpe Ratio — доходность с поправкой на волатильность. Sharpe ≥ 1.0 — норма, ≥ 1.5 — хорошо, ≥ 2.0 — отлично. Подробно в блоге.',
    'sortino': 'Sortino Ratio — улучшенный Sharpe: учитывает только волатильность ВНИЗ (убытки). Для крипты честнее, чем Sharpe.',
    'calmar': 'Calmar Ratio = годовая доходность / максимальная просадка. Calmar = 2 — заработал 30% при просадке 15%. Чем выше, тем лучше.',
    'max-drawdown': 'Max Drawdown — максимальная просадка от пика капитала. Drawdown 25% значит после максимума депозит просел на четверть.',
    'avg-trade': 'Средняя сделка — средний результат одной сделки в долларах или процентах.',
    'avg-win': 'Средняя прибыль — средний размер прибыльной сделки.',
    'avg-loss': 'Средний убыток — средний размер убыточной сделки. Хорошо когда avg-win больше avg-loss.',
    'rrr': 'R:R (Risk/Reward Ratio) — соотношение «сколько готов потерять» к «сколько хочешь заработать». R:R = 1:3 = риск $10 ради $30 профита. Минимум 1:2.',
    'equity': 'Equity — твой текущий капитал (стартовый депозит + Total PnL). Это «сколько у тебя в кошельке прямо сейчас».',
    'balance': 'Balance — баланс на бирже (свободные средства, не в открытых сделках).',
    'margin': 'Margin — сколько денег заблокировано как залог под открытые позиции с плечом.',

    // ── Risk parameters ────────────────────────────────────────────────
    'leverage': 'Leverage (плечо) — коэффициент, который увеличивает позицию относительно депозита. 5× = с $1000 контролируешь $5000. Удвоенный профит, но и удвоенный риск ликвидации.',
    'risk-pct': 'Risk per Trade — процент депозита, которым рискуешь на одну сделку. 1% = с $1000 максимум $10 потерь. Дисциплина: ≤ 1% для новичков.',
    'max-trades': 'Max Open Trades — максимум одновременных позиций бота. Защищает от концентрации риска: при коррелированном движении убыток словишь со всех сразу.',
    'sl': 'Stop Loss — цена, на которой бот автоматически закроет позицию в убыток. Обязателен всегда — без SL одна неудачная сделка может слить весь депозит.',
    'tp': 'Take Profit — цена фиксации прибыли. Обычно 2-3 уровня (TP1, TP2, TP3) по 33% позиции на каждый.',
    'tp1': 'TP1 — первый уровень фиксации прибыли. Закрывается часть позиции (обычно 33%).',
    'tp2': 'TP2 — второй уровень фиксации. Закрывается ещё часть. Стоп подтягивается в безубыток.',
    'tp3': 'TP3 — финальный уровень. Закрывается остаток позиции — максимальный профит.',
    'liquidation': 'Liquidation — цена принудительного закрытия позиции биржей при потере залога. Происходит при больших плечах + движении против.',

    // ── Trading modes ──────────────────────────────────────────────────
    'demo': 'DEMO (paper trading) — симуляция на виртуальных $10k. Сделки не реальные, деньги не теряешь. Идеально для первых 2 недель — проверить стратегию.',
    'live': 'LIVE — реальная торговля с твоего API-ключа биржи. Сделки исполняются на бирже, прибыль и убыток настоящие.',
    'auto-trade': 'Авто-исполнение — бот сам открывает и закрывает сделки по сигналам стратегии. Без этой опции бот только показывает сигналы, но не торгует.',
    'paper-mode': 'Paper-режим — то же что DEMO. Бот делает сделки в симуляции, не на бирже.',

    // ── Strategy concepts ──────────────────────────────────────────────
    'strategy': 'Стратегия — алгоритм по которому бот ищет сигналы. У нас 6 стратегий: SMC, Levels (Гречик), Scalping, DCA, Grid и Multi.',
    'timeframe': 'Таймфрейм — длительность одной свечи на графике. 1m = минута, 1h = час, 1d = день. Чем больше TF, тем меньше шума и реже сделки.',
    'symbol': 'Символ — торговая пара. BTCUSDT = биткоин против USDT. Бот может работать сразу с несколькими.',
    'direction': 'Direction — какие сделки разрешены: long (на рост), short (на падение) или оба. По умолчанию — оба.',
    'long': 'Long (лонг) — позиция на рост. Покупаешь дешевле, продаёшь дороже.',
    'short': 'Short (шорт) — позиция на падение. Продаёшь дороже, выкупаешь дешевле. Доступно только на фьючерсах.',

    // ── Signal/quality ────────────────────────────────────────────────
    'signal': 'Signal — сигнал на вход в позицию. Стратегия нашла сетап и предлагает открыть сделку. Может конвертироваться в сделку (auto-trade) или просто записаться для анализа.',
    'quality': 'Quality — оценка сигнала от 0 до 100. Учитывает confluence факторов (объём, тренд, индикаторы). Высокое quality = сильный сигнал.',
    'confidence': 'Confidence — уверенность модели в сигнале. Похоже на quality, но учитывает совпадение нескольких стратегий.',

    // ── Backtest specific ─────────────────────────────────────────────
    'backtest': 'Backtest — прогон стратегии на исторических данных. Показывает как бот работал бы в прошлом — но не гарантирует будущее.',
    'walk-forward': 'Walk-forward — проверка стратегии на out-of-sample периоде. Оптимизируешь параметры на 3 месяцах, тестируешь на следующем — и так шаг за шагом. Защищает от overfitting.',
    'overfitting': 'Overfitting — стратегия идеально подобрана под историю, но на новых данных проваливается. Признак: profit factor &gt; 3.0 на бэктесте.',
    'period': 'Период — за сколько дней прогнать бэктест. Минимум 30 дней, лучше 90+. Должны попасть разные режимы рынка (тренд + боковик).',

    // ── Exchanges/balances ────────────────────────────────────────────
    'exchange': 'Биржа — площадка где исполняются сделки. Поддерживаем Bybit, Binance, OKX, BingX. У каждой биржи свой API-ключ.',
    'api-key': 'API-ключ — пара ключей (key + secret) с правами read + trade на бирже. Бот использует их чтобы открывать сделки от твоего имени. БЕЗ права withdraw!',
    'fees': 'Комиссии — плата биржи за каждую сделку. Maker (limit-ордер) ≈ 0.02%, taker (market-ордер) ≈ 0.04-0.06% на крупных биржах.',
    'funding': 'Funding rate — комиссия которую держатели лонгов и шортов платят друг другу каждые 8 часов на perpetual-фьючерсах.',
    'spread': 'Spread — разница между ценой покупки и продажи. На ликвидных парах (BTC, ETH) спред крошечный. На альтах может быть 0.1%+.',
    'slippage': 'Slippage — отклонение цены исполнения от ожидаемой. Чем больше объём ордера и хуже ликвидность, тем выше slippage.',

    // ── Plan/payments ─────────────────────────────────────────────────
    'plan': 'План подписки — Free, Starter, Pro, Elite. Чем выше план, тем больше ботов, стратегий и features. Free хватает для старта в DEMO.',
    'tier': 'Tier — то же что план подписки.',

    // ── Copy trading ──────────────────────────────────────────────────
    'copy-trading': 'Copy Trading — копирование сделок успешных трейдеров. Подписываешься на лидера → его сделки автоматически дублируются на твоём счёте.',
    'leader': 'Leader — трейдер чьи сделки копируешь. Видишь его статистику в Leaderboard перед подпиской.',
    'follower': 'Follower — тот кто копирует тебя. Если ты сам лидер — твои сделки автоматически дублируются у followers.',
  };

  // ── Иконка ?
  const ICON_SVG = '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<circle cx="8" cy="8" r="6.5"/>'
    + '<path d="M6.2 6c.2-.9 1-1.6 1.9-1.6 1.1 0 1.9.7 1.9 1.7 0 .9-.6 1.3-1.3 1.7-.5.3-.7.6-.7 1.2"/>'
    + '<circle cx="8" cy="11.5" r=".7" fill="currentColor" stroke="none"/>'
    + '</svg>';

  let activePop = null;
  let activeAnchor = null;

  function closePop() {
    if (activePop) { activePop.remove(); activePop = null; }
    if (activeAnchor) { activeAnchor.setAttribute('aria-expanded', 'false'); activeAnchor = null; }
  }

  function openPop(anchor, text) {
    closePop();
    const pop = document.createElement('div');
    pop.className = 'help-tip-pop';
    pop.setAttribute('role', 'tooltip');
    pop.innerHTML = text;
    document.body.appendChild(pop);

    const r = anchor.getBoundingClientRect();
    const popR = pop.getBoundingClientRect();
    const margin = 8;
    let top = r.bottom + window.scrollY + margin;
    let left = r.left + window.scrollX + r.width / 2 - popR.width / 2;
    // Flip if not enough room below
    if (r.bottom + popR.height + margin > window.innerHeight) {
      top = r.top + window.scrollY - popR.height - margin;
      pop.classList.add('flip-up');
    }
    // Clamp horizontally
    const maxLeft = window.innerWidth - popR.width - 12;
    left = Math.max(12, Math.min(left, maxLeft));
    pop.style.top = top + 'px';
    pop.style.left = left + 'px';
    requestAnimationFrame(() => pop.classList.add('show'));

    activePop = pop;
    activeAnchor = anchor;
    anchor.setAttribute('aria-expanded', 'true');
  }

  function injectIcon(host) {
    if (host._helpIconAdded) return;
    host._helpIconAdded = true;
    const key = host.getAttribute('data-help');
    const customText = host.getAttribute('data-help-text');
    const text = customText || (key && HELP_TEXTS[key]);
    if (!text) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'help-tip';
    btn.setAttribute('tabindex', '0');
    btn.setAttribute('aria-label', 'Подсказка: ' + (key || 'информация'));
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = ICON_SVG;

    let hoverTimer = null;
    const open = () => openPop(btn, text);
    const close = () => closePop();

    btn.addEventListener('mouseenter', () => {
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(open, 80);
    });
    btn.addEventListener('mouseleave', () => {
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(close, 120);
    });
    btn.addEventListener('focus', open);
    btn.addEventListener('blur', () => setTimeout(() => {
      // don't close if the pop itself got focused (rare, but possible)
      if (activePop && activePop.contains(document.activeElement)) return;
      close();
    }, 50));
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (activeAnchor === btn) close(); else open();
    });

    host.appendChild(btn);
  }

  function scan(root) {
    (root || document).querySelectorAll('[data-help],[data-help-text]').forEach(injectIcon);
  }

  // Click outside / Escape closes pop.
  document.addEventListener('click', (e) => {
    if (!activePop) return;
    if (e.target === activeAnchor || activeAnchor.contains(e.target)) return;
    if (activePop.contains(e.target)) return;
    closePop();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePop();
  });
  // Reposition / hide on scroll/resize.
  window.addEventListener('scroll', closePop, { passive: true, capture: true });
  window.addEventListener('resize', closePop);

  // Auto-init on DOM ready + observe future DOM mutations so dynamically
  // rendered cards (botGrid, analytics tables) get icons too.
  function init() {
    scan(document);
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches && node.matches('[data-help],[data-help-text]')) injectIcon(node);
          if (node.querySelectorAll) scan(node);
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose for debugging / programmatic use
  window.HelpTips = { texts: HELP_TEXTS, scan, close: closePop };
})();
