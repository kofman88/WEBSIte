# CHM Finance — SEO setup (после деплоя)

Что нужно сделать руками после мержа ветки `feat/seo-foundation` в main.

## 1. Google Search Console (5 минут)

1. Открой https://search.google.com/search-console
2. **Add Property** → **URL prefix** → `https://chmup.top/`
3. Верификация — выбери **HTML tag**: получишь строку вида
   ```html
   <meta name="google-site-verification" content="abc123xyz..." />
   ```
4. Скинь мне эту строку → я вставлю в `<head>` index.html (или добавь сам перед первым `<link>`)
5. После верификации в Search Console:
   - **Sitemaps** → отправь `https://chmup.top/sitemap.xml`
   - **URL Inspection** → проверь `/`, `/subscriptions.html` — нажми **Request indexing**

**Проверка через неделю:** во вкладке **Performance** должны начать появляться Impressions.

## 2. Яндекс.Вебмастер (5 минут)

1. Открой https://webmaster.yandex.ru
2. **Добавить сайт** → `https://chmup.top`
3. Верификация: выбери **Мета-тег**. Получишь строку вида
   ```html
   <meta name="yandex-verification" content="abc..." />
   ```
4. Вставь её рядом с Google meta (или скинь мне)
5. После верификации:
   - **Индексирование → Файлы Sitemap** → добавь `https://chmup.top/sitemap.xml`
   - **Индексирование → Переобход страниц** → отправь приоритетные: `/`, `/subscriptions.html`

Яндекс индексирует медленнее Google — первые результаты через 2-4 недели.

## 3. Яндекс.Метрика (аналитика, бесплатно) — 5 минут

1. https://metrika.yandex.ru → **Добавить счётчик**
2. Включи **Вебвизор**, **Цели и конверсии**, **Электронная коммерция**
3. Получи код счётчика (выглядит как `<script>...(m,e,t,r,i,k,a)...</script>`)
4. Вставь перед `</head>` на **всех** HTML страницах

После этого в Метрике появится трафик в реальном времени.

## 4. Google Analytics 4 (опционально, дополняет Яндекс) — 5 минут

1. https://analytics.google.com → **Admin → Create Property**
2. Получи **Measurement ID** (`G-XXXXXXXXXX`)
3. Вставь `gtag.js` код перед `</head>`

## 5. OpenGraph картинка — КРИТИЧНО

Сейчас в HTML зареферен `https://chmup.top/og-cover.png`, но файла **нет**. Без него превью в Telegram/Twitter/Slack — дефолтное серое поле.

Что делать:
1. Создай картинку **1200×630 px** с логотипом + tagline («AI-автоторговля криптой · Bybit, Binance, OKX»)
2. Сохрани как `frontend/og-cover.png` (≤ 300 КБ)
3. Пусть будет единая для всего сайта — проще поддерживать

Без OG-картинки: Google показывает в Discover'e дефолтное изображение, CTR падает на 40%.

## 6. Favicon — тоже критично для доверия

В HTML зареферены `/favicon.svg`, `/favicon-32.png`, `/apple-touch-icon.png`. Проверь что файлы существуют:

```bash
ls -la ~/public_html/favicon.svg ~/public_html/favicon-32.png ~/public_html/apple-touch-icon.png
```

Если нет — создай. Простейший вариант: иди на https://realfavicongenerator.net, загружаешь любой логотип 512×512, скачиваешь ZIP, распаковываешь в `public_html/`.

## 7. DMARC upgrade (SEO тоже про email reputation)

Сейчас `v=DMARC1; p=none;` — слишком мягко, Gmail периодически кидает в spam. Замени на:

```
v=DMARC1; p=quarantine; pct=25; rua=mailto:postmaster@chmup.top
```

В cPanel → **Zone Editor** → найди запись `_dmarc.chmup.top` → Edit → замени TXT value → Save.

## 8. Schema.org валидация

После деплоя проверь что разметка без ошибок:

1. https://search.google.com/test/rich-results → вставь `https://chmup.top/` → должно показать:
   - Organization ✓
   - SoftwareApplication ✓
   - FAQPage ✓ (с dropdown'ом из 6 вопросов)
2. https://search.google.com/test/rich-results → `https://chmup.top/subscriptions.html` → должно показать:
   - Product ✓ с 4 Offer'ами

Если есть ошибки — скинь мне скрин.

## 9. Page Speed Insights

https://pagespeed.web.dev → вставь `https://chmup.top/` → проверь Core Web Vitals:
- **LCP** (Largest Contentful Paint) < 2.5s
- **FID** (First Input Delay) < 100ms
- **CLS** (Cumulative Layout Shift) < 0.1

Если LCP > 2.5s — приходи, оптимизируем (lazy-loading картинок, preload шрифтов).

## 10. Контент и соцсети

Блог и академия удалены в M0 порт-плана (у бота их нет); контент-маркетинг —
вне скоупа до запуска приложения. Для анонсов в соцсетях:
- **Telegram канал** (собственный): пост с превью + ссылка
- **Telegram чаты** про крипту: аккуратно, не спам, дай ценность первую
- **Twitter/X**: тред из 4-6 твитов + финальная ссылка
- **Dev.to** (английская версия): то же самое
- **VC.ru** (бизнес-тон): переформулируй под стартап-аудиторию

Каждый re-post = бесплатный бэклинк + прямой трафик.

## 11. Повтор через месяц

Через 30 дней после деплоя:
- Зайди в Search Console → сколько страниц в индексе, какие запросы, средняя позиция
- Яндекс.Вебмастер → то же самое
- Если нет — приходи, разберёмся что ломается

---

**Последовательность:** #1 + #2 + #3 сегодня (15 минут) → #5-6 (дизайн OG + favicon, 30 минут) → #7 (DMARC, 2 минуты).

Через 3 месяца — 500+ uniq в день органики. Через 6 — 2-5k uniq/день.
