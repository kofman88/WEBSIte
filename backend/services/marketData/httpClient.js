'use strict';
/**
 * httpClient.js — the HTTP layer every market-data module talks through.
 *
 * Mirrors the bot's aiohttp session (`fetcher_bingx.BingXFetcher._sess`):
 * UA `CHM-Breaker-Bot/4.0 (trading-bot)`, `Accept-Encoding: gzip, deflate`,
 * per-request total timeout. The function signature is the seam that tests
 * replace with a fake: `http(url, { params, timeoutMs, headers })` →
 * `{ status, headers: { get(name) }, json, text }`.
 *
 * A timeout rejects with an Error whose `name` is `'TimeoutError'` (the port of
 * `asyncio.TimeoutError`); every other transport failure rejects with the
 * underlying error.
 */

const DEFAULT_HEADERS = Object.freeze({
  'User-Agent': 'CHM-Breaker-Bot/4.0 (trading-bot)',
  'Accept': 'application/json',
  'Accept-Encoding': 'gzip, deflate',
});

function buildUrl(url, params) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    u.searchParams.set(k, String(v));
  }
  return u;
}

async function fetchJson(url, { params = null, timeoutMs = 20_000, headers = null } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(buildUrl(url, params), {
      method: 'GET',
      headers: { ...DEFAULT_HEADERS, ...(headers || {}) },
      signal: ac.signal,
      redirect: 'follow',
    });
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_e) { json = null; }
    return {
      status: resp.status,
      headers: { get: (name) => resp.headers.get(name) },
      json,
      text,
    };
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
      const err = new Error(`timeout after ${timeoutMs} ms: ${url}`);
      err.name = 'TimeoutError';
      err.code = 'ETIMEDOUT';
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function isTimeout(err) {
  return !!err && (err.name === 'TimeoutError' || err.code === 'ETIMEDOUT' || err.code === 'UND_ERR_CONNECT_TIMEOUT');
}

module.exports = { fetchJson, buildUrl, isTimeout, DEFAULT_HEADERS };
