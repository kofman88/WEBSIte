/**
 * Geo-block middleware — refuse requests from restricted jurisdictions.
 *
 * Resolution order for country code:
 *   1. CF-IPCountry header (Cloudflare proxy)
 *   2. X-Country-Code header (custom reverse proxy)
 *   3. geoip-lite offline MaxMind DB lookup on req.ip
 *
 * Controlled by env:
 *   GEO_BLOCK_ENABLED=1                  enable enforcement (default off)
 *   GEO_BLOCK_COUNTRIES=US,IR,KP,CU,SY   comma-separated ISO-3166-1 alpha-2
 *
 * Defaults when enabled: OFAC / Treasury sanctioned + US (broker-licence gap).
 *
 * Returns HTTP 451 "Unavailable For Legal Reasons" with an explanation.
 * Designed to be mounted on /api/auth/register (and anywhere else the
 * operator wants to gate — but not on /api/public/* which stays open).
 */

const geoip = require('geoip-lite');
const logger = require('../utils/logger');

const DEFAULT_BLOCKED = ['US', 'IR', 'KP', 'CU', 'SY'];

function parseCountries(raw) {
  if (!raw) return DEFAULT_BLOCKED;
  return String(raw).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
}

function resolveCountry(req) {
  const cf = req.get('CF-IPCountry');
  if (cf && cf !== 'XX' && cf !== 'T1') return cf.toUpperCase();
  const xh = req.get('X-Country-Code');
  if (xh) return xh.toUpperCase();
  try {
    const ip = (req.ip || '').replace(/^::ffff:/, '');
    const row = ip ? geoip.lookup(ip) : null;
    return row && row.country ? row.country.toUpperCase() : null;
  } catch (_e) { return null; }
}

function geoBlock() {
  const enabled = process.env.GEO_BLOCK_ENABLED === '1';
  const blocked = new Set(parseCountries(process.env.GEO_BLOCK_COUNTRIES));
  return (req, res, next) => {
    if (!enabled) return next();
    const country = resolveCountry(req);
    if (country && blocked.has(country)) {
      logger.warn('geo-block rejected', { country, ip: req.ip, path: req.path });
      return res.status(451).json({
        error: 'Service unavailable in your region',
        code: 'GEO_BLOCKED',
        country,
      });
    }
    next();
  };
}

module.exports = { geoBlock, resolveCountry, DEFAULT_BLOCKED };
