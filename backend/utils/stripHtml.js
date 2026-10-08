/**
 * miniapp_api._strip_html: Telegram-HTML → plain text.
 *   <br> → "\n", tags removed, entities unescaped, trailing spaces before a
 *   newline trimmed, 3+ newlines collapsed to 2, surrounding whitespace stripped.
 */

'use strict';

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…', copy: '©' };

function unescapeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(NAMED, ent) ? NAMED[ent] : m;
  });
}

function stripHtml(text) {
  let t = String(text || '').replace(/<br\s*\/?>/gi, '\n');
  t = unescapeEntities(t.replace(/<[^>]+>/g, ''));
  t = t.replace(/[ \t]+\n/g, '\n');
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = { stripHtml, unescapeEntities };
