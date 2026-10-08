/**
 * watermark — the bot's watermark.py verbatim (signal-pipeline.md §8.6).
 *
 * An invisible per-user mark: the user id (up to 2^40) as 40 zero-width
 * characters inserted after the first character of a card. U+200B (ZERO
 * WIDTH SPACE) = bit 0, U+200C (ZERO WIDTH NON-JOINER) = bit 1, LSB first.
 * Applied to every signal card (LEVELS / SMC / VOLUME, full and lite), never
 * to progress notifications, previews, trend alerts or reports.
 */

'use strict';

const ZW0 = '​'; // bit 0
const ZW1 = '‌'; // bit 1
const BITS = 40;      // up to 1_099_511_627_776 — enough for a Telegram user_id

/** wm_encode(user_id): 40 zero-width characters, bit i = (user_id >> i) & 1 (Python int semantics via BigInt). */
function wmEncode(userId) {
  const id = BigInt(typeof userId === 'bigint' ? userId : Math.trunc(Number(userId)));
  let out = '';
  for (let i = 0n; i < BigInt(BITS); i++) out += ((id >> i) & 1n) ? ZW1 : ZW0;
  return out;
}

/** wm_inject(text, user_id): text[:1] + wm + text[1:]; `len(text) < 2` → text + wm. */
function wmInject(text, userId) {
  const s = String(text);
  const wm = wmEncode(userId);
  // Python len()/slicing count code points; split on code points so an astral
  // first character is kept whole.
  const chars = Array.from(s);
  if (chars.length < 2) return s + wm;
  return chars[0] + wm + chars.slice(1).join('');
}

/** wm_decode(text): the user id when exactly 40 zero-width bits are present, else null. */
function wmDecode(text) {
  const bits = [];
  for (const ch of String(text)) {
    if (ch === ZW0) bits.push(0);
    else if (ch === ZW1) bits.push(1);
  }
  if (bits.length !== BITS) return null;
  let v = 0n;
  bits.forEach((b, i) => { if (b) v |= (1n << BigInt(i)); });
  return Number(v);
}

module.exports = { ZW0, ZW1, BITS, wmEncode, wmInject, wmDecode };
