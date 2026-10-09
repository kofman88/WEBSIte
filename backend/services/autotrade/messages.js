'use strict';
/**
 * messages.js — i18n.t() for the auto-trade texts (data copied verbatim from the bot's
 * i18n.MESSAGES by tests/autotrade/core/gen/gen_messages.py → messagesData.json).
 *
 *   t(key, lang='ru', kwargs)  MESSAGES[key][lang] or [ru] or key; `.format(**kwargs)` when
 *                              kwargs is non-empty; a formatting error returns the raw text.
 *
 * Values follow services/autotrade/pyfmt (wrap integral Python floats with F()).
 */

const DATA = require('./messagesData.json');
const { sformat } = require('./pyfmt');

function t(key, lang = 'ru', kwargs = null) {
  try {
    const entry = Object.prototype.hasOwnProperty.call(DATA, key) ? DATA[key] : null;
    if (entry === null) return key;
    const text = (lang && entry[lang]) || entry.ru || key;
    if (kwargs && Object.keys(kwargs).length) {
      try {
        return sformat(text, kwargs);
      } catch (_e) {
        return text;
      }
    }
    return text;
  } catch (_e) {
    return key;
  }
}

module.exports = { t, MESSAGES: DATA };
