/**
 * content/help — the bot's help_content.py verbatim ([HELP-V2] справочник
 * CHM Breaker: бот «Справка» и Mini App «Помощь»). 11 numbered sections,
 * Telegram-HTML texts in RU/EN, no emoji in headings.
 *
 *   SECTIONS — [sid, ru_title, en_title], menu order
 *   HELP     — {sid: {ru: html, en: html}}
 *   getText(sid, lang), getSectionTitle(sid, lang), sectionNumber(sid)
 *   plainSections(lang) — the `GET help` payload (HTML stripped like miniapp_api._strip_html)
 *
 * Generated from the bot source; do not edit the texts by hand.
 */

'use strict';

const { stripHtml } = require('../utils/stripHtml');

const ADMIN = "@crypto_chm";

const SECTIONS = Object.freeze([
  ["quick_start", "Быстрый старт", "Quick start"],
  ["strategies", "Стратегии", "Strategies"],
  ["signals", "Карточка сигнала", "Signal card"],
  ["scanners", "Настройки сканера", "Scanner settings"],
  ["auto_trade", "Авто-трейд и биржи", "Auto-trade and exchanges"],
  ["risk_mgmt", "Риск-менеджмент", "Risk management"],
  ["miniapp", "Приложение и уведомления", "App and notifications"],
  ["subscription", "Тариф и оплата", "Plan and payment"],
  ["why_no_signal", "Почему нет сигнала", "Why there is no signal"],
  ["commands", "Команды", "Commands"],
  ["contacts", "Поддержка", "Support"],
]);

const HELP = Object.freeze({
  quick_start: {
    ru: "<b>Быстрый старт</b>\n"
      + "\n"
      + "<b>1. Язык.</b> Главное меню → Язык / Language.\n"
      + "\n"
      + "<b>2. Стратегия и направление.</b> В главном меню выберите стратегию (Уровни, SMC, Объём + MA) и включите направление: LONG, SHORT или оба. Кнопка с точкой показывает состояние: зелёная — сканер работает. На тарифе Pro стратегии можно включить все сразу: одна монета в одну сторону даёт один сигнал.\n"
      + "\n"
      + "<b>3. Таймфрейм и качество.</b> /settings → Качество сигнала. Для старта: таймфрейм 1H, качество 3 из 5. Чем выше порог, тем реже и точнее сигналы.\n"
      + "\n"
      + "<b>4. Приложение.</b> Кнопка «Открыть приложение» в главном меню: сигналы с живым R, графики, тренд BTC, статистика и все настройки в одном месте.\n"
      + "\n"
      + "<b>5. Авто-трейд (по желанию).</b> Главное меню → Авто-трейдинг → биржа → API-ключи. Без ключей бот только присылает сигналы.\n"
      + "\n"
      + "<b>Нижняя клавиатура:</b> Меню, Позиции, Авто-трейд, Статистика, Анализ, Справка.\n"
      + "\n"
      + "Рекомендация на первую неделю: одна стратегия, 1H, качество 3, риск 1% на сделку, режим «с подтверждением», если включаете авто-трейд.",
    en: "<b>Quick start</b>\n"
      + "\n"
      + "<b>1. Language.</b> Main menu → Язык / Language.\n"
      + "\n"
      + "<b>2. Strategy and direction.</b> Pick a strategy in the main menu (Levels, SMC, Volume + MA) and enable LONG, SHORT or both. The dot on the button shows the state: green means the scanner is running. On Pro all strategies can run at once; one coin in one direction gives one signal.\n"
      + "\n"
      + "<b>3. Timeframe and quality.</b> /settings → Signal quality. To start: 1H and quality 3 of 5. A higher threshold means fewer, stricter signals.\n"
      + "\n"
      + "<b>4. App.</b> «Open app» in the main menu: signals with live R, charts, BTC trend, statistics and every setting in one place.\n"
      + "\n"
      + "<b>5. Auto-trade (optional).</b> Main menu → Auto trading → exchange → API keys. Without keys the bot only sends signals.\n"
      + "\n"
      + "<b>Bottom keyboard:</b> Menu, Positions, Auto-trade, Statistics, Analyze, Help.\n"
      + "\n"
      + "First week: one strategy, 1H, quality 3, 1% risk per trade, confirmation mode if auto-trade is on.",
  },
  strategies: {
    ru: "<b>Стратегии</b>\n"
      + "\n"
      + "<b>Уровни (LEVELS)</b> — доступна на Free.\n"
      + "Price Action по уровням поддержки и сопротивления: отбой от уровня или пробой с ретестом. Подтверждения: тренд по EMA, RSI, объём, старший таймфрейм, свечные модели, ложный пробой (SFP). Качество 0–10, в карточке 1–5 звёзд. Обычно 2–8 сигналов в день, лучшие таймфреймы 1H–4H.\n"
      + "\n"
      + "<b>SMC (Smart Money Concepts)</b> — Pro.\n"
      + "Структура рынка на трёх таймфреймах: снятие ликвидности, смена структуры (CHoCH / BOS), Order Block и Breaker, FVG и IFVG, зона дисконта / премиума, возврат в зону. Оценка — число подтверждений из 8, грейды B / A / A+. 1–4 сигнала в день, вход лимитной зоной, стоп за структурой.\n"
      + "\n"
      + "<b>Объём + MA (VOLUME)</b> — Pro.\n"
      + "Классическая система на скользящих с подтверждением объёмом. Сетапы: пересечение SMA 10/20, разворот SMA20, отскок от EMA50/EMA200 свечой отбоя, золотой крест EMA50/200, откат к ленте EMA 5–55 с возвратом над быстрой EMA. Фильтры: RSI, растяжение от MA, старший таймфрейм. Качество 1–5.\n"
      + "\n"
      + "<b>Тренд BTC</b> считается отдельно по 15m, 1H, 4H, 1D, 1W, 1M и отмечает каждый сигнал: по тренду, против тренда, против сильного тренда. Подробнее в разделе «Карточка сигнала».\n"
      + "\n"
      + "<b>Strategy Genome</b> (главное меню, Pro) — автоподбор параметров стратегии по вашей статистике. Показывает текущий набор параметров и историю.",
    en: "<b>Strategies</b>\n"
      + "\n"
      + "<b>Levels (LEVELS)</b> — available on Free.\n"
      + "Price action at support and resistance: bounce or breakout with retest. Confirmations: EMA trend, RSI, volume, higher timeframe, candle patterns, swing failure (SFP). Quality 0–10, shown as 1–5 stars. Usually 2–8 signals a day, best on 1H–4H.\n"
      + "\n"
      + "<b>SMC (Smart Money Concepts)</b> — Pro.\n"
      + "Market structure on three timeframes: liquidity sweep, structure shift (CHoCH / BOS), Order Block and Breaker, FVG and IFVG, discount / premium zone, retrace into the zone. Score = confirmations out of 8, grades B / A / A+. 1–4 signals a day, limit entry zone, stop behind structure.\n"
      + "\n"
      + "<b>Volume + MA (VOLUME)</b> — Pro.\n"
      + "Moving-average system confirmed by volume. Setups: SMA 10/20 cross, SMA20 turn, bounce off EMA50/EMA200 with a rejection candle, EMA50/200 golden cross, pullback into the EMA 5–55 ribbon with a reclaim of the fast EMA. Filters: RSI, stretch from MA, higher timeframe. Quality 1–5.\n"
      + "\n"
      + "<b>BTC trend</b> is computed separately on 15m, 1H, 4H, 1D, 1W, 1M and marks every signal: with the trend, against it, or against a strong trend. See «Signal card».\n"
      + "\n"
      + "<b>Strategy Genome</b> (main menu, Pro) tunes strategy parameters from your own statistics and shows the current set and its history.",
  },
  signals: {
    ru: "<b>Карточка сигнала</b>\n"
      + "\n"
      + "<b>Шапка.</b> Монета, направление, стратегия и таймфрейм, качество в звёздах (у Уровней в скобках исходная оценка из 10).\n"
      + "\n"
      + "<b>Уровни сделки.</b> Вход, стоп-лосс с процентом движения, три цели TP1 / TP2 / TP3 и лестница R:R. R — отношение прибыли к риску: цель 1:2 означает две величины стопа.\n"
      + "\n"
      + "<b>Строка тренда BTC.</b>\n"
      + "• «По тренду» — сигнал совпадает с трендом BTC 15m.\n"
      + "• «По тренду на 15m · 1H · 4H» — совпадает на всех трёх; качество +1.\n"
      + "• «Против тренда» — предупреждение, в приложении янтарная метка.\n"
      + "• «Против сильного тренда (86%)» — лента EMA выстроена более чем на 70%; качество −1. Такие входы требуют отдельного основания.\n"
      + "\n"
      + "<b>Выход из сжатия.</b> Если сетап сформировался после сжатия волатильности, в карточке есть строка «Выход из сжатия — +1 к качеству».\n"
      + "\n"
      + "<b>Размер позиции.</b> Расчёт по вашему риску на сделку и плечу; без баланса биржи показывается расчёт на условные $1000.\n"
      + "\n"
      + "<b>Сопровождение.</b> Бот присылает прогресс: TP1, безубыток, TP2, TP3, стоп. Если цена ушла к цели без отката к входу, сигнал закрывается как «Не входить — цена ушла без отката» и в статистику не идёт.\n"
      + "\n"
      + "<b>Ручной итог.</b> Кнопка «Результат» под карточкой или экран сигнала в приложении: TP1 / TP2 / TP3 / SL / BE / пропуск и заметка. Для сделок, открытых авто-трейдом, итог фиксирует биржа.",
    en: "<b>Signal card</b>\n"
      + "\n"
      + "<b>Header.</b> Coin, direction, strategy and timeframe, quality in stars (Levels also show the raw 0–10 score).\n"
      + "\n"
      + "<b>Trade levels.</b> Entry, stop-loss with its move in percent, three targets TP1 / TP2 / TP3 and the R:R ladder. R is reward to risk: a 1:2 target equals two stop distances.\n"
      + "\n"
      + "<b>BTC trend line.</b>\n"
      + "• «With the trend» — matches BTC 15m.\n"
      + "• «With the trend on 15m · 1H · 4H» — matches all three; quality +1.\n"
      + "• «Against the trend» — warning, amber tag in the app.\n"
      + "• «Against a strong trend (86%)» — EMA ribbon stacked above 70%; quality −1. Such entries need a separate reason.\n"
      + "\n"
      + "<b>Squeeze breakout.</b> A setup formed after a volatility squeeze carries the line «Breakout from squeeze — +1 quality».\n"
      + "\n"
      + "<b>Position size.</b> Computed from your risk per trade and leverage; without an exchange balance it is shown for a notional $1000.\n"
      + "\n"
      + "<b>Tracking.</b> The bot reports progress: TP1, break-even, TP2, TP3, stop. If price reaches the target without pulling back to entry the signal closes as «Missed — no pullback» and is excluded from statistics.\n"
      + "\n"
      + "<b>Manual result.</b> «Result» under the card or the signal screen in the app: TP1 / TP2 / TP3 / SL / BE / skip plus a note. Trades opened by auto-trade take their result from the exchange.",
  },
  scanners: {
    ru: "<b>Настройки сканера</b> — команда /settings\n"
      + "\n"
      + "<b>Таймфрейм.</b> Уровни: 15m, 30m, 1H, 4H, 1D; SMC и Объём: 15m, 1H, 4H (на Free: 15m и 1H). Сигнал формируется только по закрытой свече.\n"
      + "\n"
      + "<b>Качество сигнала.</b> Минимальный порог 1–5 звёзд. Сигналы ниже порога не отправляются. Для Уровней 3 звезды соответствуют оценке 5–6 из 10.\n"
      + "\n"
      + "<b>Cooldown.</b> Пауза между сигналами по одной монете в одну сторону. Повторная карточка по той же монете не приходит, пока не истечёт пауза или не закроется предыдущий сигнал.\n"
      + "\n"
      + "<b>Уровни: пивоты и S/R, EMA, фильтры.</b> Период пивотов, допуск касания уровня, трендовые EMA, фильтры RSI, объёма и старшего таймфрейма, стоп по ATR и цели по R:R.\n"
      + "\n"
      + "<b>SMC.</b> Тип подтверждения входа (касание тенью или закрытие), глубина возврата в зону, фильтр дисконта / премиума, проверка старшего таймфрейма, минимальный грейд, предельный размер стопа в процентах.\n"
      + "\n"
      + "<b>Объём + MA.</b> Какие сетапы включены (кросс, разворот, отскок, золотой крест) и фильтр старшего таймфрейма. Кнопка «Настройки Объёма» в главном меню.\n"
      + "\n"
      + "<b>Монеты.</b> Фильтр по суточному обороту и число монет в сканировании. Монеты с малым оборотом дают больше ложных сигналов.\n"
      + "\n"
      + "<b>Контр-тренд.</b> Разрешить ли сигналы против тренда и с каким минимальным качеством. По умолчанию против тренда проходят только сильные сигналы.",
    en: "<b>Scanner settings</b> — /settings\n"
      + "\n"
      + "<b>Timeframe.</b> Levels: 15m, 30m, 1H, 4H, 1D; SMC and Volume: 15m, 1H, 4H (Free: 15m and 1H). A signal forms only on a closed candle.\n"
      + "\n"
      + "<b>Signal quality.</b> Minimum threshold of 1–5 stars; weaker signals are not sent. For Levels 3 stars equal a 5–6 of 10 score.\n"
      + "\n"
      + "<b>Cooldown.</b> Pause between signals on the same coin in the same direction. No repeat card until the pause ends or the previous signal closes.\n"
      + "\n"
      + "<b>Levels: pivots and S/R, EMA, filters.</b> Pivot period, level touch tolerance, trend EMAs, RSI / volume / higher-timeframe filters, ATR stop and R:R targets.\n"
      + "\n"
      + "<b>SMC.</b> Entry confirmation type (wick touch or close), retrace depth, discount / premium filter, higher-timeframe check, minimum grade, maximum stop size in percent.\n"
      + "\n"
      + "<b>Volume + MA.</b> Which setups are enabled (cross, turn, bounce, golden cross) and the higher-timeframe filter. «Volume settings» in the main menu.\n"
      + "\n"
      + "<b>Coins.</b> Daily turnover filter and the number of coins scanned. Thin coins produce more false signals.\n"
      + "\n"
      + "<b>Counter-trend.</b> Whether signals against the trend are allowed and the minimum quality for them. By default only strong counter-trend signals pass.",
  },
  auto_trade: {
    ru: "<b>Авто-трейд и биржи</b>\n"
      + "\n"
      + "<b>Подключение.</b> Главное меню → Авто-трейдинг → биржа (Bybit, BingX, Binance, OKX) → API Key и Secret. Ключам нужны права только на торговлю фьючерсами; вывод средств запрещайте. Ключи хранятся в зашифрованном виде и в чат не возвращаются.\n"
      + "\n"
      + "<b>Режимы.</b>\n"
      + "• «С подтверждением» — к сигналу добавляется кнопка «Открыть сделку», вы решаете сами. Рекомендуется первые недели.\n"
      + "• «Авто-вход» — позиция открывается без участия.\n"
      + "\n"
      + "<b>Риск на сделку.</b> Процент баланса, который вы теряете при срабатывании стопа. 0.5–1% консервативно, 1–2% умеренно, выше 3% агрессивно.\n"
      + "\n"
      + "<b>Плечо.</b> 5–10 для большинства. Плечо не меняет риск в долларах, но уменьшает расстояние до ликвидации.\n"
      + "\n"
      + "<b>Лимит открытых сделок.</b> Максимум одновременных позиций; 3–5 достаточно.\n"
      + "\n"
      + "<b>Частичные цели и безубыток.</b> Позиция закрывается частями на TP1 / TP2 / TP3; после TP1 стоп переносится в точку входа.\n"
      + "\n"
      + "<b>Защита.</b> Дневной лимит убытка останавливает авто-трейд; серия стопов (3 за 24 часа) ставит паузу; сделки против сильного тренда, при экстремальном funding или широком спреде пропускаются с пометкой причины.\n"
      + "\n"
      + "<b>Позиции.</b> Кнопка «Позиции» на нижней клавиатуре: открытые сделки, закрытие по рынку, зависшие ордера.",
    en: "<b>Auto-trade and exchanges</b>\n"
      + "\n"
      + "<b>Connecting.</b> Main menu → Auto trading → exchange (Bybit, BingX, Binance, OKX) → API Key and Secret. Keys need futures trading permission only; never allow withdrawals. Keys are stored encrypted and are never echoed back.\n"
      + "\n"
      + "<b>Modes.</b>\n"
      + "• «Confirmation» — the signal gets an «Open trade» button, you decide. Recommended for the first weeks.\n"
      + "• «Auto entry» — the position opens on its own.\n"
      + "\n"
      + "<b>Risk per trade.</b> The share of balance you lose if the stop is hit. 0.5–1% conservative, 1–2% moderate, above 3% aggressive.\n"
      + "\n"
      + "<b>Leverage.</b> 5–10 for most. Leverage does not change the dollar risk but shortens the distance to liquidation.\n"
      + "\n"
      + "<b>Open trade limit.</b> Maximum simultaneous positions; 3–5 is enough.\n"
      + "\n"
      + "<b>Partial targets and break-even.</b> The position closes in parts at TP1 / TP2 / TP3; after TP1 the stop moves to entry.\n"
      + "\n"
      + "<b>Protection.</b> A daily loss limit stops auto-trade; a stop streak (3 in 24h) pauses it; trades against a strong trend, with extreme funding or a wide spread are skipped with the reason recorded.\n"
      + "\n"
      + "<b>Positions.</b> «Positions» on the bottom keyboard: open trades, market close, stuck orders.",
  },
  risk_mgmt: {
    ru: "<b>Риск-менеджмент</b>\n"
      + "\n"
      + "<b>Правило одного процента.</b> Риск на сделку — доля баланса, а не размер позиции. При 1% и балансе $1000 стоп стоит $10; размер позиции бот считает сам из расстояния до стопа.\n"
      + "\n"
      + "<b>Стоп-лосс.</b> У Уровней — за уровнем с буфером по ATR, у SMC — за структурой, у Объёма — за ближайшим свингом. Передвигать стоп дальше после входа не рекомендуется: это меняет R всей сделки.\n"
      + "\n"
      + "<b>Цели.</b> Три цели закрывают позицию частями. Первая цель фиксирует результат, безубыток после неё убирает риск по остатку.\n"
      + "\n"
      + "<b>Контр-тренд.</b> Сигнал против тренда BTC — не запрет, а повод уменьшить размер или пропустить. Против сильного тренда (лента EMA выстроена больше чем на 70%) бот снижает качество на единицу и отмечает карточку.\n"
      + "\n"
      + "<b>Серии убытков.</b> После трёх стопов подряд за сутки авто-трейд ставится на паузу. Для ручной торговли это такой же сигнал сделать перерыв.\n"
      + "\n"
      + "<b>Плечо.</b> Выбирайте так, чтобы расстояние до ликвидации было заметно больше стопа. 5–10 покрывает большинство сетапов на 1H.\n"
      + "\n"
      + "<b>Что смотреть в статистике.</b> Итог в R, а не в процентах, win rate и средний R на сделку по каждой стратегии: «Мои результаты» в меню или вкладка «Главная» в приложении.",
    en: "<b>Risk management</b>\n"
      + "\n"
      + "<b>The one-percent rule.</b> Risk per trade is a share of balance, not the position size. At 1% on $1000 a stop costs $10; the bot sizes the position from the stop distance.\n"
      + "\n"
      + "<b>Stop-loss.</b> Levels: behind the level with an ATR buffer; SMC: behind structure; Volume: behind the nearest swing. Moving the stop further after entry changes the R of the whole trade.\n"
      + "\n"
      + "<b>Targets.</b> Three targets close the position in parts. The first locks a result; break-even after it removes risk on the rest.\n"
      + "\n"
      + "<b>Counter-trend.</b> A signal against the BTC trend is a reason to size down or skip, not a ban. Against a strong trend (EMA ribbon stacked above 70%) the bot lowers quality by one and marks the card.\n"
      + "\n"
      + "<b>Losing streaks.</b> Three stops in a day pause auto-trade. For manual trading it is the same cue to take a break.\n"
      + "\n"
      + "<b>Leverage.</b> Keep the liquidation distance well beyond the stop. 5–10 covers most 1H setups.\n"
      + "\n"
      + "<b>What to read in statistics.</b> Total in R rather than percent, win rate and average R per trade for each strategy: «My results» in the menu or the Home tab in the app.",
  },
  miniapp: {
    ru: "<b>Приложение и уведомления</b>\n"
      + "\n"
      + "<b>Открыть.</b> Кнопка «Открыть приложение» в главном меню. Вход по вашему Telegram-аккаунту, ничего вводить не нужно.\n"
      + "\n"
      + "<b>Главная.</b> Тариф и активные стратегии, карточка «Тренд BTC» по шести таймфреймам с силой тренда, win rate, итог R и кривая R за 30 дней, последние сигналы.\n"
      + "\n"
      + "<b>Сигналы.</b> Фильтры по статусу и стратегии, живой R по открытым, метки «против тренда» и «все ТФ». На экране сигнала — график, уровни, прогресс, ручной итог и заметка.\n"
      + "\n"
      + "<b>Анализ.</b> Разбор любой монеты по выбранной стратегии или всем сразу.\n"
      + "\n"
      + "<b>Профиль.</b> Тариф и оплата, стратегии, авто-трейд, биржи, риск, позиции, статистика, язык, тихие часы, справка, обратная связь.\n"
      + "\n"
      + "<b>Уведомления в боте.</b> Карточки сигналов, прогресс сделки, смена тренда BTC по любому из шести таймфреймов (/trend — текущее состояние, /trend_on — вернуть рассылку после отключения кнопкой под уведомлением).\n"
      + "\n"
      + "<b>Тихие часы.</b> Уведомления → Тихие часы, либо в профиле приложения. В заданном окне сообщения приходят без звука; текст и состав не меняются.\n"
      + "\n"
      + "<b>Формат.</b> В главном меню переключается полная или короткая карточка и вложение графика.",
    en: "<b>App and notifications</b>\n"
      + "\n"
      + "<b>Open.</b> «Open app» in the main menu. Signed in with your Telegram account, nothing to type.\n"
      + "\n"
      + "<b>Home.</b> Plan and active strategies, the «BTC trend» card on six timeframes with trend strength, win rate, total R and the 30-day R curve, recent signals.\n"
      + "\n"
      + "<b>Signals.</b> Filters by status and strategy, live R on open ones, «against the trend» and «all TFs» tags. The signal screen has the chart, levels, progress, manual result and a note.\n"
      + "\n"
      + "<b>Analyze.</b> Any coin through one strategy or all at once.\n"
      + "\n"
      + "<b>Profile.</b> Plan and payment, strategies, auto-trade, exchanges, risk, positions, statistics, language, quiet hours, help, feedback.\n"
      + "\n"
      + "<b>Bot notifications.</b> Signal cards, trade progress, BTC trend change on any of the six timeframes (/trend shows the state, /trend_on re-enables alerts after the mute button).\n"
      + "\n"
      + "<b>Quiet hours.</b> Notifications → Quiet hours, or the app profile. Inside the window messages arrive silently; content does not change.\n"
      + "\n"
      + "<b>Format.</b> The main menu toggles the full or short card and the chart attachment.",
  },
  subscription: {
    ru: "<b>Тариф и оплата</b>\n"
      + "\n"
      + "<b>Free.</b> Стратегия Уровни, одно направление, 2 сигнала в день, один просмотр SMC в день, анализ монеты 1 раз в день, таймфреймы 15m и 1H.\n"
      + "\n"
      + "<b>Pro — $69 в месяц.</b> Все три стратегии одновременно, LONG и SHORT, все таймфреймы и монеты, без лимита сигналов и анализа, авто-трейд на Bybit, BingX, Binance и OKX, Strategy Genome, полное приложение.\n"
      + "\n"
      + "<b>Оплата в TON.</b> Профиль приложения → Тариф, либо /pay_ton в боте.\n"
      + "1. Бот показывает сумму в TON по текущему курсу, адрес и комментарий.\n"
      + "2. Кнопка «Открыть кошелёк» подставляет всё сама. При ручном переводе комментарий обязателен: по нему бот находит платёж.\n"
      + "3. Платёж проверяется каждые несколько секунд; подписка активируется автоматически, обычно в пределах двух минут, с сообщением в чат.\n"
      + "Счёт действует 30 минут, оплата по нему засчитывается в течение суток. Повторная оплата продлевает срок с текущей даты окончания.\n"
      + "\n"
      + "<b>Если платёж не засчитан.</b> Напишите @crypto_chm с хэшем транзакции или комментарием. Платёж без действующего счёта администратор видит и зачисляет вручную.\n"
      + "\n"
      + "<b>Промокод.</b> /subscribe → Ввести промокод.",
    en: "<b>Plan and payment</b>\n"
      + "\n"
      + "<b>Free.</b> Levels strategy, one direction, 2 signals a day, one SMC preview a day, one coin analysis a day, 15m and 1H.\n"
      + "\n"
      + "<b>Pro — $69 per month.</b> All three strategies at once, LONG and SHORT, all timeframes and coins, unlimited signals and analysis, auto-trade on Bybit, BingX, Binance and OKX, Strategy Genome, the full app.\n"
      + "\n"
      + "<b>Paying in TON.</b> App profile → Plan, or /pay_ton in the bot.\n"
      + "1. The bot shows the amount in TON at the current rate, the address and a comment.\n"
      + "2. «Open wallet» fills everything in. For a manual transfer the comment is required: it is how the bot finds your payment.\n"
      + "3. Payments are checked every few seconds; the plan activates automatically, usually within two minutes, with a message in the chat.\n"
      + "The invoice is shown for 30 minutes and matched for 24 hours. Paying again extends from the current expiry date.\n"
      + "\n"
      + "<b>If a payment is not credited.</b> Message @crypto_chm with the transaction hash or the comment. A payment without a live invoice is visible to the admin and credited manually.\n"
      + "\n"
      + "<b>Promo code.</b> /subscribe → Enter promo code.",
  },
  why_no_signal: {
    ru: "<b>Почему нет сигнала или сделки</b>\n"
      + "\n"
      + "<b>Сигналов нет.</b>\n"
      + "• Направление выключено: в главном меню точка у LONG / SHORT серая.\n"
      + "• Порог качества выше, чем даёт рынок: снизьте на одну звезду.\n"
      + "• Боковик без уровней и структуры. Карточка «Тренд BTC» показывает боковик на 15m и 1H.\n"
      + "• Cooldown по монете ещё не истёк или предыдущий сигнал не закрыт.\n"
      + "• На Free исчерпан дневной лимит.\n"
      + "\n"
      + "<b>Сигнал пришёл, сделка не открылась.</b>\n"
      + "• Режим «с подтверждением»: нужно нажать «Открыть сделку».\n"
      + "• Монеты нет на вашей бирже или она делистнута.\n"
      + "• Сработал фильтр: против тренда ниже минимального качества, funding выше 0.5%, спред шире 0.3%, серия из трёх стопов за сутки, дневной лимит убытка.\n"
      + "• Достигнут лимит открытых сделок или не хватает баланса на минимальный объём.\n"
      + "• Цена ушла от входа до исполнения; сигнал помечается как «Не входить».\n"
      + "Причина пропуска записывается и видна в статистике и в карточке.\n"
      + "\n"
      + "<b>Стоп срабатывает сразу.</b> Увеличьте буфер ATR в настройках стопа, снизьте плечо или уберите монеты с малым оборотом.\n"
      + "\n"
      + "<b>Позиция меньше ожидаемой.</b> Проверьте риск на сделку: 1% от $100 — это $1 риска. Некоторые биржи отдают доступный, а не общий баланс.\n"
      + "\n"
      + "<b>На бирже висят ордера.</b> Это ордера целей; бот снимает их при закрытии. Если остались, отмените вручную на бирже.",
    en: "<b>Why there is no signal or trade</b>\n"
      + "\n"
      + "<b>No signals.</b>\n"
      + "• Direction is off: the dot next to LONG / SHORT in the main menu is grey.\n"
      + "• Quality threshold above what the market gives: lower it by one star.\n"
      + "• Range without levels or structure. The «BTC trend» card shows range on 15m and 1H.\n"
      + "• Cooldown on the coin has not expired or the previous signal is still open.\n"
      + "• Free daily limit reached.\n"
      + "\n"
      + "<b>Signal arrived, no trade opened.</b>\n"
      + "• Confirmation mode: press «Open trade».\n"
      + "• The coin is not listed on your exchange or was delisted.\n"
      + "• A filter fired: counter-trend below minimum quality, funding above 0.5%, spread wider than 0.3%, three stops in a day, daily loss limit.\n"
      + "• Open trade limit reached or balance below the minimum size.\n"
      + "• Price left the entry before the order filled; the signal is marked «Missed».\n"
      + "The skip reason is recorded and shown in statistics and on the card.\n"
      + "\n"
      + "<b>Stop hit immediately.</b> Raise the ATR buffer in stop settings, lower leverage or drop thin coins.\n"
      + "\n"
      + "<b>Position smaller than expected.</b> Check risk per trade: 1% of $100 is $1 of risk. Some exchanges report available rather than total balance.\n"
      + "\n"
      + "<b>Orders left on the exchange.</b> Those are target orders; the bot removes them on close. If any remain, cancel them manually.",
  },
  commands: {
    ru: "<b>Команды</b>\n"
      + "\n"
      + "<b>Основные</b>\n"
      + "/menu — главное меню\n"
      + "/strategy — выбор стратегии\n"
      + "/settings — настройки сканера, стопа и целей\n"
      + "/stats — статистика по сделкам\n"
      + "/analyze — разбор монеты\n"
      + "/trend — тренд BTC по шести таймфреймам\n"
      + "/trend_on — включить уведомления о смене тренда\n"
      + "/cancel — выйти из текущего диалога\n"
      + "\n"
      + "<b>Тариф</b>\n"
      + "/subscribe — тарифы и промокод\n"
      + "/pay_ton — счёт на оплату Pro в TON\n"
      + "\n"
      + "<b>Дополнительно</b>\n"
      + "/simple и /expert — короткое или полное меню\n"
      + "/ai_filter — AI-фильтр сигналов (Pro)\n"
      + "/journal — дневник сделок\n"
      + "/chart_help — как читать график в карточке\n"
      + "/dashboard — сводка результатов\n"
      + "\n"
      + "Нижняя клавиатура дублирует главное: Меню, Позиции, Авто-трейд, Статистика, Анализ, Справка.",
    en: "<b>Commands</b>\n"
      + "\n"
      + "<b>Core</b>\n"
      + "/menu — main menu\n"
      + "/strategy — choose a strategy\n"
      + "/settings — scanner, stop and target settings\n"
      + "/stats — trade statistics\n"
      + "/analyze — analyze a coin\n"
      + "/trend — BTC trend on six timeframes\n"
      + "/trend_on — re-enable trend change alerts\n"
      + "/cancel — leave the current dialog\n"
      + "\n"
      + "<b>Plan</b>\n"
      + "/subscribe — plans and promo code\n"
      + "/pay_ton — Pro invoice in TON\n"
      + "\n"
      + "<b>More</b>\n"
      + "/simple and /expert — short or full menu\n"
      + "/ai_filter — AI signal filter (Pro)\n"
      + "/journal — trade journal\n"
      + "/chart_help — how to read the card chart\n"
      + "/dashboard — results summary\n"
      + "\n"
      + "The bottom keyboard mirrors the essentials: Menu, Positions, Auto-trade, Statistics, Analyze, Help.",
  },
  contacts: {
    ru: "<b>Поддержка</b>\n"
      + "\n"
      + "<b>Из бота.</b> Главное меню → Обратная связь. Сообщение приходит команде, ответ — в этот же чат.\n"
      + "\n"
      + "<b>Из приложения.</b> Профиль → Обратная связь.\n"
      + "\n"
      + "<b>Напрямую.</b> @crypto_chm — вопросы по оплате и доступу.\n"
      + "\n"
      + "<b>Сроки ответа.</b> Pro — до 4 часов, Free — до 72 часов.\n"
      + "\n"
      + "<b>Что приложить.</b> Описание, монета и время сигнала, биржа, скриншот карточки или экрана приложения. API-ключи и пароли не присылайте: они не нужны для разбора.",
    en: "<b>Support</b>\n"
      + "\n"
      + "<b>From the bot.</b> Main menu → Feedback. The message reaches the team; the reply lands in the same chat.\n"
      + "\n"
      + "<b>From the app.</b> Profile → Feedback.\n"
      + "\n"
      + "<b>Directly.</b> @crypto_chm — payment and access questions.\n"
      + "\n"
      + "<b>Response time.</b> Pro — up to 4 hours, Free — up to 72 hours.\n"
      + "\n"
      + "<b>What to attach.</b> Description, coin and signal time, exchange, a screenshot of the card or app screen. Never send API keys or passwords; they are not needed.",
  },
});

/** «01»…«11» — section number for the menu and the Mini App; "--" when unknown. */
function sectionNumber(sectionId) {
  const i = SECTIONS.findIndex((s) => s[0] === sectionId);
  return i >= 0 ? String(i + 1).padStart(2, '0') : '--';
}

/** Section HTML for lang (ru|en); falls back to ru. */
function getText(sectionId, lang) {
  const entry = HELP[sectionId];
  if (!entry) return 'Раздел не найден / Section not found';
  return entry[lang] || entry.ru || '';
}

function getSectionTitle(sectionId, lang) {
  const s = SECTIONS.find((x) => x[0] === sectionId);
  if (!s) return sectionId;
  return lang === 'en' ? s[2] : s[1];
}

/** miniapp_api.h_help: [{id, number, title, text}] with the HTML stripped. */
function plainSections(lang) {
  const l = lang === 'en' ? 'en' : 'ru';
  const out = [];
  for (const [sid, ruTitle, enTitle] of SECTIONS) {
    const entry = HELP[sid] || {};
    const raw = entry[l] || entry.ru || '';
    if (!raw) continue;
    out.push({ id: sid, number: sectionNumber(sid), title: l === 'en' ? enTitle : ruTitle, text: stripHtml(raw) });
  }
  return out;
}

module.exports = { ADMIN, SECTIONS, HELP, sectionNumber, getText, getSectionTitle, plainSections };
