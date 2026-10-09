'use strict';
/**
 * aioResponse.js — an answer written the way aiohttp writes web.Response / web.json_response:
 * status, Content-Type, Content-Length and the body bytes, nothing else. Express' res.send /
 * res.json would add an ETag and turn a 2xx GET into "304 Not Modified" when the request carries
 * If-None-Match / If-Modified-Since (even `If-None-Match: *` with no ETag at all) — aiohttp
 * never does either, so the /api/app answers bypass them. A HEAD request gets the headers only
 * (Node drops the body of a HEAD response).
 */

function writeResponse(res, status, contentType, text, headers = null) {
  const buf = Buffer.from(String(text), 'utf8');
  res.statusCode = status;
  if (headers) for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', String(buf.length));
  res.end(buf);
  return res;
}

const JSON_UTF8 = 'application/json; charset=utf-8';
const TEXT_UTF8 = 'text/plain; charset=utf-8';
const HTML_UTF8 = 'text/html; charset=utf-8';

module.exports = { writeResponse, JSON_UTF8, TEXT_UTF8, HTML_UTF8 };
