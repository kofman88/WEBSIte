# INVENTORY — frontend HTML
Generated 2026-04-21T19:27:55.934Z


## about.html

- size: 16550 bytes
- sha256: c0ba4a689ae8689e

### links (20)
- href=`/` id=`` target=`` 
- href=`/` id=`` target=`` 
- href=`/leaderboard.html` id=`` target=`` 
- href=`/status.html` id=`` target=`` 
- href=`/api-docs.html` id=`` target=`` 
- href=`/risk.html` id=`` target=`` 
- href=`/leaderboard.html` id=`` target=`` 
- href=`mailto:support@chmup.top` id=`` target=`` 
- href=`mailto:legal@chmup.top` id=`` target=`` 
- href=`mailto:privacy@chmup.top` id=`` target=`` 
- href=`mailto:support@chmup.top` id=`` target=`` 
- href=`mailto:support@chmup.top` id=`` target=`` 
- href=`mailto:security@chmup.top` id=`` target=`` 
- href=`mailto:legal@chmup.top` id=`` target=`` 
- href=`mailto:press@chmup.top` id=`` target=`` 
- href=`mailto:privacy@chmup.top` id=`` target=`` 
- href=`https://t.me/CHMUP_bot` id=`` target=`_blank` 
- href=`/terms.html` id=`` target=`` 
- href=`/privacy.html` id=`` target=`` 
- href=`/risk.html` id=`` target=`` 

## admin.html

- size: 30007 bytes
- sha256: 1fd6539a17b93b8f

### forms (2)
- id=`promoForm` action=`` method=`get` inputs=5
  - input name=`code` type=`` id=`` req=``
  - select name=`plan` type=`` id=`` req=``
  - input name=`durationDays` type=`number` id=`` req=``
  - input name=`maxUses` type=`number` id=`` req=``
  - button name=`` type=`submit` id=`` req=``
- id=`admTdReplyForm` action=`` method=`get` inputs=3
  - textarea name=`body` type=`` id=`` req=``
  - button name=`` type=`submit` id=`` req=``
  - button name=`` type=`button` id=`admTdCloseBtn` req=``

### buttons with id/onclick/data-* (23)
- id=`` onclick=`Auth.logout()` type=`` 
- id=`` onclick=`` type=`` data-tab=stats
- id=`` onclick=`` type=`` data-tab=users
- id=`` onclick=`` type=`` data-tab=payments
- id=`` onclick=`` type=`` data-tab=promo
- id=`` onclick=`` type=`` data-tab=rewards
- id=`` onclick=`` type=`` data-tab=tickets
- id=`` onclick=`` type=`` data-tab=audit
- id=`userSearchBtn` onclick=`` type=`` 
- id=`paymentSearchBtn` onclick=`` type=`` 
- id=`rewardSearchBtn` onclick=`` type=`` 
- id=`ticketReloadBtn` onclick=`` type=`` 
- id=`` onclick=`document.getElementById('adminTicketModal').style.display='n` type=`` 
- id=`admTdCloseBtn` onclick=`` type=`button` 
- id=`auditSearchBtn` onclick=`` type=`` 
- id=`` onclick=`` type=`` data-uid=${u.id} data-active=${u.isActive?0:1}
- id=`` onclick=`` type=`` data-confirm=${p.id}
- id=`` onclick=`` type=`` data-refund=${p.id}
- id=`` onclick=`` type=`` data-toggle=${c.id} data-active=${c.isActive?0:1}
- id=`` onclick=`` type=`` data-del=${c.id}
- id=`` onclick=`` type=`` data-pay=${r.id}
- id=`` onclick=`` type=`` data-cancel=${r.id}
- id=`` onclick=`` type=`` data-tid=${t.id}

### links (2)
- href=`dashboard.html` id=`` target=`` 
- href=`admin.html` id=`` target=`` 

### scripts (3)
- external: `app.js`
- inline: sha256=2394f2bb0103610c bytes=54
- inline: sha256=128b3d8f06fdf87c bytes=16226

### api-ish urls (1)
- `fetch(ADMIN_BASE + path, opts);
  if (res.status === 403) {
    Toast.error(`

## analytics.html

- size: 21965 bytes
- sha256: a1374d89704ef03e

### buttons with id/onclick/data-* (11)
- id=`` onclick=`Auth.logout()` type=`` 
- id=`shellLang` onclick=`` type=`button` 
- id=`shellTheme` onclick=`` type=`button` 
- id=`portfolioRefresh` onclick=`` type=`` 
- id=`` onclick=`` type=`` data-days=30
- id=`` onclick=`` type=`` data-days=90
- id=`` onclick=`` type=`` data-days=365
- id=`exportBtn` onclick=`` type=`` 
- id=`` onclick=`closeJournal()` type=`` 
- id=`` onclick=`saveJournalNote()` type=`` 
- id=`` onclick=`closeJournal()` type=`` 

### links (8)
- href=`dashboard.html` id=`` target=`` data-page=dashboard
- href=`bots.html` id=`` target=`` data-page=bots
- href=`signals.html` id=`` target=`` data-page=signals
- href=`analytics.html` id=`` target=`` data-page=analytics
- href=`backtests.html` id=`` target=`` data-page=backtests
- href=`wallet.html` id=`` target=`` data-page=wallet
- href=`leaderboard.html` id=`` target=`` data-page=leaderboard
- href=`settings.html` id=`` target=`` data-page=settings

### scripts (4)
- external: `assets/vendor/chart.umd.min.js`
- external: `app.js`
- external: `shell.js?v=6`
- inline: sha256=a5315e6f788446c5 bytes=11790

### api-ish urls (4)
- `fetch + blob download trick.
document.getElementById(`
- `fetch just this one)
  const all = await API.listTrades({ limit: 500 });
  const`
- `fetch(base + `
- `fetchedAt);
    if (!r.exchanges.length) {
      host.innerHTML = `

## api-docs.html

- size: 11808 bytes
- sha256: f18652187cfecd55

### links (14)
- href=`/` id=`` target=`` 
- href=`/` id=`` target=`` 
- href=`/leaderboard.html` id=`` target=`` 
- href=`/status.html` id=`` target=`` 
- href=`#base` id=`` target=`` 
- href=`#auth` id=`` target=`` 
- href=`#health` id=`` target=`` 
- href=`#public` id=`` target=`` 
- href=`#leaderboard` id=`` target=`` 
- href=`#profile` id=`` target=`` 
- href=`#errors` id=`` target=`` 
- href=`#ratelimits` id=`` target=`` 
- href=`mailto:support@chmup.top` id=`` target=`` 
- href=`mailto:support@chmup.top` id=`` target=`` 

### scripts (1)
- external: `aura-bg.js`

### api-ish urls (11)
- `/api/*</span>.</p>
        <p class=`
- `/api/auth/login</span> и живёт 15 минут. Обновляется через <span class=`
- `/api/auth/refresh</span>.</p>
      </div>

      <div class=`
- `/api/health*</span>) не требуют токена.</p>
        <p class=`
- `/api/health/deep</span></h3>
          <p class=`
- `/api/health</span></h3>
          <p class=`
- `/api/public/*</span>, <span class=`
- `/api/public/leaderboard</span></h3>
          <p class=`
- `/api/public/leaderboard?period=30d&sort=pnl&limit=10</code></pre>
          <p c`
- `/api/public/u/:code</span></h3>
          <p class=`
- `/api/public/u/A1B2C3D4</code></pre>
          <p class=`

## backtests.html

- size: 11849 bytes
- sha256: b4bb702cf32435b3

### forms (1)
- id=`btForm` action=`` method=`get` inputs=6
  - input name=`symbol` type=`` id=`` req=``
  - select name=`strategy` type=`` id=`` req=``
  - select name=`timeframe` type=`` id=`` req=``
  - input name=`startDate` type=`date` id=`` req=``
  - input name=`endDate` type=`date` id=`` req=``
  - button name=`` type=`submit` id=`` req=``

### buttons with id/onclick/data-* (4)
- id=`` onclick=`Auth.logout()` type=`` 
- id=`sidebar-toggle` onclick=`` type=`` 
- id=`shellLang` onclick=`` type=`button` 
- id=`shellTheme` onclick=`` type=`button` 

### links (8)
- href=`dashboard.html` id=`` target=`` data-page=dashboard
- href=`bots.html` id=`` target=`` data-page=bots
- href=`signals.html` id=`` target=`` data-page=signals
- href=`analytics.html` id=`` target=`` data-page=analytics
- href=`backtests.html` id=`` target=`` data-page=backtests
- href=`wallet.html` id=`` target=`` data-page=wallet
- href=`leaderboard.html` id=`` target=`` data-page=leaderboard
- href=`settings.html` id=`` target=`` data-page=settings

### scripts (4)
- external: `assets/vendor/chart.umd.min.js`
- external: `app.js`
- external: `shell.js?v=6`
- inline: sha256=d3ca365b83779ac9 bytes=5523

## bots.html

- size: 66320 bytes
- sha256: eee66bb2e7730eab

### forms (2)
- id=`createBotForm` action=`` method=`get` inputs=24
  - input name=`name` type=`` id=`` req=``
  - select name=`exchangeName` type=`` id=`` req=``
  - input name=`symbol` type=`` id=`` req=``
  - select name=`timeframe` type=`` id=`` req=``
  - input name=`strategyType` type=`radio` id=`` req=``
  - input name=`strategyType` type=`radio` id=`` req=``
  - input name=`strategyType` type=`radio` id=`` req=``
  - input name=`strategyType` type=`radio` id=`` req=``
  - input name=`strategyType` type=`radio` id=`` req=``
  - input name=`strategyType` type=`radio` id=`` req=``
  - select name=`direction` type=`` id=`` req=``
  - button name=`` type=`button` id=`cfgReset` req=``
  - input name=`leverage` type=`number` id=`` req=``
  - input name=`riskPct` type=`number` id=`` req=``
  - input name=`positionSizeUsd` type=`number` id=`` req=``
  - input name=`maxOpenTrades` type=`number` id=`` req=``
  - select name=`` type=`` id=`btDays` req=``
  - button name=`` type=`button` id=`btRun` req=``
  - input name=`tradingMode` type=`radio` id=`` req=``
  - input name=`tradingMode` type=`radio` id=`` req=``
  - input name=`autoTrade` type=`checkbox` id=`` req=``
  - button name=`` type=`button` id=`wizBack` req=``
  - button name=`` type=`button` id=`wizNext` req=``
  - button name=`` type=`submit` id=`wizSubmit` req=``
- id=`smartTradeForm` action=`` method=`get` inputs=15
  - select name=`exchange` type=`` id=`` req=``
  - input name=`symbol` type=`` id=`` req=``
  - input name=`side` type=`radio` id=`` req=``
  - input name=`side` type=`radio` id=`` req=``
  - input name=`tradingMode` type=`radio` id=`` req=``
  - input name=`tradingMode` type=`radio` id=`` req=``
  - input name=`quantity` type=`number` id=`` req=``
  - input name=`leverage` type=`number` id=`` req=``
  - input name=`entryPrice` type=`number` id=`` req=``
  - input name=`stopLoss` type=`number` id=`` req=``
  - input name=`takeProfit1` type=`number` id=`` req=``
  - input name=`takeProfit2` type=`number` id=`` req=``
  - input name=`takeProfit3` type=`number` id=`` req=``
  - textarea name=`note` type=`` id=`` req=``
  - button name=`` type=`submit` id=`` req=``

### buttons with id/onclick/data-* (21)
- id=`` onclick=`Auth.logout()` type=`` 
- id=`sidebar-toggle` onclick=`` type=`` 
- id=`shellLang` onclick=`` type=`button` 
- id=`shellTheme` onclick=`` type=`button` 
- id=`` onclick=`openSmartTrade()` type=`` 
- id=`` onclick=`openWizard()` type=`` 
- id=`` onclick=`closeWizard()` type=`button` 
- id=`cfgReset` onclick=`` type=`button` 
- id=`btRun` onclick=`` type=`button` 
- id=`wizBack` onclick=`` type=`button` 
- id=`wizNext` onclick=`` type=`button` 
- id=`wizSubmit` onclick=`` type=`submit` 
- id=`liveCancelBtn` onclick=`` type=`button` 
- id=`liveConfirmBtn` onclick=`` type=`button` 
- id=`` onclick=`closeSmartTrade()` type=`button` 
- id=`` onclick=`closeTvWebhook()` type=`button` 
- id=`tvCopyUrl` onclick=`` type=`` 
- id=`tvCopySecret` onclick=`` type=`` 
- id=`tvRotateBtn` onclick=`` type=`` 
- id=`` onclick=`` type=`` data-tv=${b.id}
- id=`` onclick=`` type=`` data-delete=${b.id}

### links (8)
- href=`dashboard.html` id=`` target=`` data-page=dashboard
- href=`bots.html` id=`` target=`` data-page=bots
- href=`signals.html` id=`` target=`` data-page=signals
- href=`analytics.html` id=`` target=`` data-page=analytics
- href=`backtests.html` id=`` target=`` data-page=backtests
- href=`wallet.html` id=`` target=`` data-page=wallet
- href=`leaderboard.html` id=`` target=`` data-page=leaderboard
- href=`settings.html` id=`` target=`` data-page=settings

### scripts (3)
- external: `app.js`
- external: `shell.js?v=6`
- inline: sha256=6c7ea39f0cc2bade bytes=27171

### api-ish urls (2)
- `/api/bots/strategy-schema/:key) ──
let currentSchema = null;          // last-lo`
- `fetch stats for ALL bots so header aggregates stay stable when filters change.
 `

## dashboard.html

- size: 40029 bytes
- sha256: f81a299bad3037cd

### buttons with id/onclick/data-* (10)
- id=`` onclick=`Auth.logout()` type=`` 
- id=`sidebar-toggle` onclick=`` type=`` 
- id=`shellLang` onclick=`` type=`button` 
- id=`shellTheme` onclick=`` type=`button` 
- id=`` onclick=`location.href='bots.html'` type=`` 
- id=`pauseAllBtn` onclick=`` type=`` 
- id=`` onclick=`` type=`` data-days=7
- id=`` onclick=`` type=`` data-days=30
- id=`` onclick=`` type=`` data-days=90
- id=`` onclick=`` type=`` data-days=365

### links (10)
- href=`dashboard.html` id=`` target=`` data-page=dashboard
- href=`bots.html` id=`` target=`` data-page=bots data-tour=bots
- href=`signals.html` id=`` target=`` data-page=signals
- href=`analytics.html` id=`` target=`` data-page=analytics data-tour=analytics
- href=`backtests.html` id=`` target=`` data-page=backtests
- href=`wallet.html` id=`` target=`` data-page=wallet data-tour=wallet
- href=`leaderboard.html` id=`` target=`` data-page=leaderboard
- href=`settings.html` id=`` target=`` data-page=settings data-tour=settings
- href=`signals.html` id=`` target=`` 
- href=`analytics.html` id=`` target=`` 

### scripts (5)
- external: `assets/vendor/chart.umd.min.js`
- external: `app.js`
- external: `shell.js?v=6`
- external: `onboarding.js`
- inline: sha256=cc06b50591492e29 bytes=22758

### api-ish urls (2)
- `/api/health/deep`
- `fetch(`

## index.html

- size: 107538 bytes
- sha256: 2defd7d6af0d0bbf

### forms (5)
- id=`loginForm` action=`` method=`get` inputs=5
  - input name=`email` type=`email` id=`` req=``
  - input name=`password` type=`password` id=`` req=``
  - input name=`remember` type=`checkbox` id=`` req=``
  - button name=`` type=`button` id=`` req=``
  - button name=`` type=`submit` id=`` req=``
- id=`registerForm` action=`` method=`get` inputs=5
  - input name=`email` type=`email` id=`` req=``
  - input name=`password` type=`password` id=`` req=``
  - input name=`password2` type=`password` id=`` req=``
  - input name=`` type=`checkbox` id=`` req=``
  - button name=`` type=`submit` id=`` req=``
- id=`forgotForm` action=`` method=`get` inputs=2
  - input name=`email` type=`email` id=`` req=``
  - button name=`` type=`submit` id=`` req=``
- id=`resetForm` action=`` method=`get` inputs=4
  - input name=`token` type=`hidden` id=`` req=``
  - input name=`newPassword` type=`password` id=`` req=``
  - input name=`newPassword2` type=`password` id=`` req=``
  - button name=`` type=`submit` id=`` req=``
- id=`tfaForm` action=`` method=`get` inputs=3
  - input name=`pendingToken` type=`hidden` id=`` req=``
  - input name=`code` type=`text` id=`` req=``
  - button name=`` type=`submit` id=`` req=``

### buttons with id/onclick/data-* (21)
- id=`langBtn` onclick=`toggleLang()` type=`` 
- id=`themeBtn` onclick=`toggleTheme()` type=`` 
- id=`loginBtn` onclick=`` type=`button` data-open-modal=login data-t=nav-login
- id=`` onclick=`` type=`button` data-open-modal=register data-t=nav-start
- id=`` onclick=`` type=`button` data-open-modal=register data-t=hero-cta1
- id=`` onclick=`` type=`button` data-pick-plan=free
- id=`` onclick=`` type=`button` data-pick-plan=starter
- id=`` onclick=`` type=`button` data-pick-plan=pro
- id=`` onclick=`` type=`button` data-pick-plan=elite
- id=`` onclick=`` type=`button` data-open-modal=register data-t=cta-btn
- id=`` onclick=`` type=`button` data-open-modal=forgot data-t=ml-forgot
- id=`` onclick=`` type=`submit` data-t=ml-btn
- id=`` onclick=`` type=`button` data-open-modal=register data-t=ml-reg
- id=`` onclick=`` type=`submit` data-t=mr-btn
- id=`` onclick=`` type=`button` data-open-modal=login data-t=mr-login
- id=`` onclick=`` type=`submit` data-t=fp-btn
- id=`` onclick=`` type=`button` data-open-modal=login data-t=fp-back
- id=`` onclick=`` type=`submit` data-t=rp-btn
- id=`` onclick=`` type=`submit` data-t=tfa-btn
- id=`` onclick=`setCookieConsent('declined')` type=`button` data-t=cc-dec
- id=`` onclick=`setCookieConsent('accepted')` type=`button` data-t=cc-acc

### links (40)
- href=`/` id=`` target=`` 
- href=`#features` id=`` target=`` data-t=nav-feat
- href=`#pricing` id=`` target=`` data-t=nav-price
- href=`#how` id=`` target=`` data-t=nav-how
- href=`#community` id=`` target=`` data-t=nav-community
- href=`#faq` id=`` target=`` data-t=nav-faq
- href=`academy/` id=`` target=`` data-t=nav-academy
- href=`dashboard.html` id=`` target=`` data-t=nav-cabinet
- href=`#how` id=`` target=`` data-t=hero-cta2
- href=`#disclaimer-1` id=`` target=`` 
- href=`/risk.html` id=`` target=`` 
- href=`https://t.me/chm_crypto` id=`` target=`_blank` 
- href=`/` id=`` target=`` 
- href=`#features` id=`` target=`` data-t=ft-feat
- href=`#pricing` id=`` target=`` data-t=ft-price
- href=`#how` id=`` target=`` data-t=ft-how
- href=`about.html` id=`` target=`` data-t=ft-about
- href=`status.html` id=`` target=`` data-t=ft-status
- href=`api-docs.html` id=`` target=`` data-t=ft-api
- href=`privacy.html` id=`` target=`` data-t=ft-priv
- href=`terms.html` id=`` target=`` data-t=ft-terms
- href=`risk.html` id=`` target=`` data-t=ft-risk
- href=`about.html#jurisdictions` id=`` target=`` data-t=ft-geo
- href=`#` id=`` target=`` 
- href=`#` id=`` target=`` 
- href=`#` id=`` target=`` 
- href=`/` id=`` target=`` 
- href=`/` id=`` target=`` 
- href=`terms.html` id=`` target=`` data-t=mr-terms
- href=`/` id=`` target=`` 
- href=`/` id=`` target=`` 
- href=`/` id=`` target=`` 
- href=`/privacy.html` id=`` target=`` 
- href=`#disclaimer-1` id=`` target=`` 
- href=`#disclaimer-1` id=`` target=`` 
- href=`/risk.html` id=`` target=`` 
- href=`/risk.html` id=`` target=`` 
- href=`/privacy.html` id=`` target=`` 
- href=`/privacy.html` id=`` target=`` 
- href=`${it.link}` id=`` target=`_blank` data-src=assets/promo/${resolveFile(it,lang)} data-title=${it.label[lang]}

### scripts (5)
- external: `assets/vendor/chart.umd.min.js`
- external: `https://code.iconify.design/iconify-icon/2.1.0/iconify-icon.min.js`
- external: `app.js`
- inline: sha256=aaded92f9603ae68 bytes=402
- inline: sha256=85a98d16980661dc bytes=34080

### api-ish urls (3)
- `fetch if app.js didn`
- `fetch(_apiBase+path,{method:`
- `fetch(base+`

## leaderboard.html

- size: 7716 bytes
- sha256: b73f36827c445d3d

### buttons with id/onclick/data-* (5)
- id=`` onclick=`` type=`` data-period=30d
- id=`` onclick=`` type=`` data-period=90d
- id=`` onclick=`` type=`` data-period=1y
- id=`` onclick=`` type=`` data-period=all
- id=`` onclick=`copyFollow('${escHtml(t.referralCode)}', '${escHtml(t.displa` type=`` 

### links (7)
- href=`/` id=`` target=`` 
- href=`/` id=`` target=`` 
- href=`/dashboard.html` id=`` target=`` 
- href=`/status.html` id=`` target=`` 
- href=`/settings.html` id=`` target=`` 
- href=`/settings.html` id=`` target=`` 
- href=`/u.html?code=${encodeURIComponent(t.referralCode)}` id=`` target=`` 

### scripts (2)
- external: `app.js`
- inline: sha256=89a22fea4f17d95c bytes=3513

## market.html

- size: 8261 bytes
- sha256: b9e59d352cee4073

### forms (1)
- id=`mkPubForm` action=`` method=`get` inputs=6
  - input name=`title` type=`` id=`` req=``
  - textarea name=`description` type=`` id=`` req=``
  - select name=`strategy` type=`` id=`` req=``
  - select name=`timeframe` type=`` id=`` req=``
  - select name=`direction` type=`` id=`` req=``
  - button name=`` type=`submit` id=`` req=``

### buttons with id/onclick/data-* (3)
- id=`mkPublishBtn` onclick=`` type=`` 
- id=`` onclick=`closeMkPub()` type=`` 
- id=`` onclick=`installStrategy('${escHtml(s.slug)}', '${escHtml(s.title).re` type=`` 

### links (4)
- href=`/` id=`` target=`` 
- href=`/` id=`` target=`` 
- href=`/leaderboard.html` id=`` target=`` 
- href=`/dashboard.html` id=`` target=`` 

### scripts (2)
- external: `app.js`
- inline: sha256=b30bdea1de40e5a6 bytes=3464

## ops.html

- size: 8069 bytes
- sha256: 820db15dd80a875c

### buttons with id/onclick/data-* (14)
- id=`` onclick=`` type=`` data-tab=dash
- id=`` onclick=`` type=`` data-tab=users
- id=`` onclick=`` type=`` data-tab=bots
- id=`` onclick=`` type=`` data-tab=trades
- id=`` onclick=`` type=`` data-tab=signals
- id=`` onclick=`` type=`` data-tab=payments
- id=`` onclick=`` type=`` data-tab=billing
- id=`` onclick=`` type=`` data-tab=promo
- id=`` onclick=`` type=`` data-tab=rewards
- id=`` onclick=`` type=`` data-tab=support
- id=`` onclick=`` type=`` data-tab=system
- id=`` onclick=`` type=`` data-tab=flags
- id=`` onclick=`` type=`` data-tab=audit
- id=`` onclick=`closeDrawer()` type=`` 

### links (1)
- href=`/dashboard.html` id=`` target=`` 

### scripts (3)
- external: `assets/vendor/chart.umd.min.js`
- external: `app.js`
- external: `ops.js`

## privacy.html

- size: 14646 bytes
- sha256: ce516efd09b01b9d

### buttons with id/onclick/data-* (1)
- id=`burger` onclick=`` type=`` 

### links (13)
- href=`/` id=`` target=`` 
- href=`/#services` id=`` target=`` 
- href=`/#how` id=`` target=`` 
- href=`/#pricing` id=`` target=`` 
- href=`/academy/` id=`` target=`` 
- href=`https://t.me/crypto_chm` id=`` target=`_blank` 
- href=`/academy/` id=`` target=`` 
- href=`/` id=`` target=`` 
- href=`https://t.me/crypto_chm` id=`` target=`` 
- href=`https://t.me/crypto_chm` id=`` target=`_blank` 
- href=`/terms.html` id=`` target=`` 
- href=`/privacy.html` id=`` target=`` 
- href=`/risk.html` id=`` target=`` 

### scripts (3)
- external: `https://unpkg.com/lucide@latest/dist/umd/lucide.min.js`
- external: `aura-bg.js`
- inline: sha256=1e559e961494e866 bytes=333

## risk.html

- size: 15433 bytes
- sha256: 562216ae35b43a2d

### buttons with id/onclick/data-* (1)
- id=`burger` onclick=`` type=`` 

### links (11)
- href=`/` id=`` target=`` 
- href=`/#services` id=`` target=`` 
- href=`/#how` id=`` target=`` 
- href=`/#pricing` id=`` target=`` 
- href=`/academy/` id=`` target=`` 
- href=`https://t.me/crypto_chm` id=`` target=`_blank` 
- href=`/academy/` id=`` target=`` 
- href=`/` id=`` target=`` 
- href=`/terms.html` id=`` target=`` 
- href=`/privacy.html` id=`` target=`` 
- href=`/risk.html` id=`` target=`` 

### scripts (3)
- external: `https://unpkg.com/lucide@latest/dist/umd/lucide.min.js`
- external: `aura-bg.js`
- inline: sha256=1e559e961494e866 bytes=333

## settings.html

- size: 66131 bytes
- sha256: 5f2c0fd835ea0454

### forms (5)
- id=`` action=`` method=`get` inputs=2
  - button name=`` type=`button` id=`` req=``
  - button name=`` type=`button` id=`` req=``
- id=`` action=`` method=`get` inputs=7
  - input name=`` type=`range` id=`` req=``
  - input name=`` type=`range` id=`` req=``
  - input name=`` type=`number` id=`paperBalanceInput` req=``
  - button name=`` type=`button` id=`paperBalanceSave` req=``
  - input name=`` type=`number` id=`` req=``
  - input name=`` type=`number` id=`` req=``
  - button name=`` type=`button` id=`` req=``
- id=`changePassForm` action=`` method=`get` inputs=4
  - input name=`currentPassword` type=`password` id=`` req=``
  - input name=`newPassword` type=`password` id=`` req=``
  - input name=`newPassword2` type=`password` id=`` req=``
  - button name=`` type=`submit` id=`` req=``
- id=`ticketForm` action=`` method=`get` inputs=3
  - input name=`subject` type=`` id=`` req=``
  - textarea name=`body` type=`` id=`` req=``
  - button name=`` type=`submit` id=`` req=``
- id=`tdReplyForm` action=`` method=`get` inputs=3
  - textarea name=`body` type=`` id=`` req=``
  - button name=`` type=`submit` id=`` req=``
  - button name=`` type=`button` id=`tdCloseBtn` req=``

### buttons with id/onclick/data-* (37)
- id=`` onclick=`Auth.logout()` type=`` 
- id=`sidebar-toggle` onclick=`` type=`` 
- id=`shellLang` onclick=`` type=`button` 
- id=`shellTheme` onclick=`` type=`button` 
- id=`` onclick=`stab('profile')` type=`` 
- id=`` onclick=`stab('subscription')` type=`` 
- id=`` onclick=`stab('trading')` type=`` 
- id=`` onclick=`stab('notifications')` type=`` 
- id=`` onclick=`stab('security')` type=`` 
- id=`` onclick=`stab('community')` type=`` 
- id=`` onclick=`stab('support')` type=`` 
- id=`` onclick=`Toast.success('Профиль сохранён')` type=`button` 
- id=`` onclick=`location.href='/dashboard.html?tour=1'` type=`button` 
- id=`upgradeBtn` onclick=`` type=`` 
- id=`refCopyBtn` onclick=`` type=`` 
- id=`paperBalanceSave` onclick=`` type=`button` 
- id=`` onclick=`Toast.success('Настройки сохранены')` type=`button` 
- id=`tgLinkBtn` onclick=`` type=`` 
- id=`savePrefsBtn` onclick=`` type=`` 
- id=`pushToggleBtn` onclick=`` type=`` 
- id=`pushTestBtn` onclick=`` type=`` 
- id=`emailVerifyBtn` onclick=`` type=`` 
- id=`tfaBtn` onclick=`` type=`` 
- id=`tfaConfirmBtn` onclick=`` type=`` 
- id=`exportDataBtn` onclick=`` type=`button` 
- id=`newTicketBtn` onclick=`` type=`` 
- id=`` onclick=`closeTicketModal()` type=`` 
- id=`` onclick=`closeTicketDetail()` type=`` 
- id=`tdCloseBtn` onclick=`` type=`button` 
- id=`` onclick=`closeCheckout()` type=`` 
- id=`` onclick=`` type=`button` data-method=stripe
- id=`` onclick=`` type=`button` data-method=usdt_bep20
- id=`` onclick=`` type=`button` data-method=usdt_trc20
- id=`coCopy` onclick=`` type=`` 
- id=`` onclick=`closeCheckout()` type=`` 
- id=`` onclick=`` type=`` data-revoke=${s.id}
- id=`` onclick=`openTicket(${t.id})` type=`` 

### links (16)
- href=`dashboard.html` id=`` target=`` data-page=dashboard
- href=`bots.html` id=`` target=`` data-page=bots
- href=`signals.html` id=`` target=`` data-page=signals
- href=`analytics.html` id=`` target=`` data-page=analytics
- href=`backtests.html` id=`` target=`` data-page=backtests
- href=`wallet.html` id=`` target=`` data-page=wallet
- href=`leaderboard.html` id=`` target=`` data-page=leaderboard
- href=`settings.html` id=`` target=`` data-page=settings
- href=`#` id=`tgLinkUrl` target=`_blank` 
- href=`/leaderboard.html` id=`` target=`` 
- href=`#` id=`pubProfileUrl` target=`_blank` 
- href=`/leaderboard.html` id=`` target=`` 
- href=`/faq.html` id=`` target=`` 
- href=`/api-docs.html` id=`` target=`` 
- href=`/status.html` id=`` target=`` 
- href=`https://support.google.com/chrome/answer/3220216` id=`` target=`_blank` 

### scripts (3)
- external: `app.js`
- external: `shell.js?v=6`
- inline: sha256=8948baf5f58f4874 bytes=30717

### api-ish urls (7)
- `/api/auth/me/export`
- `fetch current value + wire save button
  (async () => {
    const inp = document`
- `fetch data
  const origStab = window.stab;
  window.stab = function(t, ev){
    `
- `fetch(`
- `fetch(
          (location.hostname === `
- `fetch(
      (location.hostname === `
- `fetch(base + path, {
    method, headers: {
      `

## signals.html

- size: 14325 bytes
- sha256: 3c6af4a4c92df140

### buttons with id/onclick/data-* (9)
- id=`` onclick=`Auth.logout()` type=`` 
- id=`sidebar-toggle` onclick=`` type=`` 
- id=`shellLang` onclick=`` type=`button` 
- id=`shellTheme` onclick=`` type=`button` 
- id=`` onclick=`` type=`` data-filter-strategy=all
- id=`` onclick=`` type=`` data-filter-strategy=smc
- id=`` onclick=`` type=`` data-filter-strategy=gerchik
- id=`` onclick=`` type=`` data-filter-strategy=scalping
- id=`` onclick=`` type=`` data-filter-strategy=levels

### links (9)
- href=`dashboard.html` id=`` target=`` data-page=dashboard
- href=`bots.html` id=`` target=`` data-page=bots
- href=`signals.html` id=`` target=`` data-page=signals
- href=`analytics.html` id=`` target=`` data-page=analytics
- href=`backtests.html` id=`` target=`` data-page=backtests
- href=`wallet.html` id=`` target=`` data-page=wallet
- href=`leaderboard.html` id=`` target=`` data-page=leaderboard
- href=`settings.html` id=`` target=`` data-page=settings
- href=`#pricing` id=`` target=`` 

### scripts (4)
- external: `assets/vendor/chart.umd.min.js`
- external: `app.js`
- external: `shell.js?v=6`
- inline: sha256=28a447cc48510e2c bytes=7428

## status.html

- size: 5884 bytes
- sha256: c94a9b1865864f46

### links (5)
- href=`/` id=`` target=`` 
- href=`/` id=`` target=`` 
- href=`/leaderboard.html` id=`` target=`` 
- href=`/api-docs.html` id=`` target=`` 
- href=`/api/health/deep` id=`` target=`_blank` 

### scripts (3)
- external: `app.js`
- external: `aura-bg.js`
- inline: sha256=8abb8271d61f02e2 bytes=2635

### api-ish urls (2)
- `/api/health/deep`
- `fetch(`

## terms.html

- size: 14738 bytes
- sha256: 5e9dc8b9ffea7161

### buttons with id/onclick/data-* (1)
- id=`burger` onclick=`` type=`` 

### links (13)
- href=`/` id=`` target=`` 
- href=`/#services` id=`` target=`` 
- href=`/#how` id=`` target=`` 
- href=`/#pricing` id=`` target=`` 
- href=`/academy/` id=`` target=`` 
- href=`https://t.me/crypto_chm` id=`` target=`_blank` 
- href=`/academy/` id=`` target=`` 
- href=`/` id=`` target=`` 
- href=`https://t.me/crypto_chm` id=`` target=`_blank` 
- href=`https://t.me/chm` id=`` target=`_blank` 
- href=`/terms.html` id=`` target=`` 
- href=`/privacy.html` id=`` target=`` 
- href=`/risk.html` id=`` target=`` 

### scripts (3)
- external: `https://unpkg.com/lucide@latest/dist/umd/lucide.min.js`
- external: `aura-bg.js`
- inline: sha256=1e559e961494e866 bytes=333

## u.html

- size: 7413 bytes
- sha256: 9e677a6aae359c71

### links (5)
- href=`/` id=`` target=`` 
- href=`/` id=`` target=`` 
- href=`/leaderboard.html` id=`` target=`` 
- href=`/dashboard.html` id=`` target=`` 
- href=`/leaderboard.html` id=`` target=`` 

### scripts (2)
- external: `app.js`
- inline: sha256=fdd4cf9b154c17eb bytes=3046

## wallet.html

- size: 16312 bytes
- sha256: bac7b0fcc290234f

### forms (1)
- id=`` action=`` method=`get` inputs=2
  - input name=`` type=`password` id=`` req=``
  - button name=`` type=`button` id=`` req=``

### buttons with id/onclick/data-* (13)
- id=`` onclick=`Auth.logout()` type=`` 
- id=`sidebar-toggle` onclick=`` type=`` 
- id=`shellLang` onclick=`` type=`button` 
- id=`shellTheme` onclick=`` type=`button` 
- id=`` onclick=`switchTab('exchanges')` type=`` 
- id=`` onclick=`switchTab('wallet')` type=`` 
- id=`` onclick=`document.getElementById('exModal').style.display='flex'` type=`` 
- id=`` onclick=`switchTab('exchanges')` type=`` 
- id=`` onclick=`document.getElementById('exModal').style.display='none'` type=`` 
- id=`` onclick=`Toast.success('Биржа подключена!');document.getElementById('` type=`button` 
- id=`` onclick=`` type=`` data-verify=${k.id}
- id=`` onclick=`` type=`` data-delete=${k.id}
- id=`` onclick=`document.getElementById('exModal').style.display='flex'` type=`` 

### links (9)
- href=`dashboard.html` id=`` target=`` data-page=dashboard
- href=`bots.html` id=`` target=`` data-page=bots
- href=`signals.html` id=`` target=`` data-page=signals
- href=`analytics.html` id=`` target=`` data-page=analytics
- href=`backtests.html` id=`` target=`` data-page=backtests
- href=`wallet.html` id=`` target=`` data-page=wallet
- href=`leaderboard.html` id=`` target=`` data-page=leaderboard
- href=`settings.html` id=`` target=`` data-page=settings
- href=`settings.html?upgrade=pro` id=`` target=`` 

### scripts (3)
- external: `app.js`
- external: `shell.js?v=6`
- inline: sha256=b9699ba368ceeaec bytes=5438
