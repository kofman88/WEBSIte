/**
 * SITE_MODE=bot — hide the website's own trading engine.
 *
 * The bot is the only engine: bots / backtests / optimizer / strategy market /
 * copy-trading / site signals / exchange keys / risk / AI endpoints answer
 * 410 ENGINE_MOVED with a pointer to /app, and the legacy dashboard pages
 * redirect there. Auth, payments, subscriptions, admin, support, public
 * stats and Telegram linking keep working — that is all a shell needs.
 */

const ENGINE_API_PREFIXES = [
  '/api/bots', '/api/backtests', '/api/optimizations', '/api/strategies', '/api/copy',
  '/api/signals', '/api/exchanges', '/api/risk', '/api/ai', '/api/analytics', '/api/wallet',
];

const ENGINE_PAGES = new Set([
  '/dashboard.html', '/bots.html', '/signals.html', '/backtests.html', '/market-scanner.html',
  '/analytics.html', '/copy.html', '/leaderboard.html', '/risk.html', '/ai.html', '/market.html',
  '/settings.html', '/onboarding.html', '/wallet.html', '/exchanges.html', '/strategies.html',
]);

function isEngineApi(pathname) {
  return ENGINE_API_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

function createEngineGate({ enabled }) {
  return function engineGate(req, res, next) {
    if (!enabled) return next();
    const pathname = req.path || req.url.split('?')[0];
    if (isEngineApi(pathname)) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(410).json({
        error: 'Движок перенесён в приложение бота',
        code: 'ENGINE_MOVED',
        app: '/app',
      });
    }
    if (req.method === 'GET' && ENGINE_PAGES.has(pathname)) {
      res.setHeader('Cache-Control', 'no-store');
      return res.redirect(302, '/app/');
    }
    next();
  };
}

module.exports = { createEngineGate, isEngineApi, ENGINE_API_PREFIXES, ENGINE_PAGES };
