/**
 * pytime — `datetime.fromtimestamp(ts, tz=timezone.utc)` of CPython 3.11 for a float timestamp:
 * _PyTime_ObjectToTimeval(ts, ROUND_HALF_EVEN) rounds the fraction to whole MICROseconds, half to
 * even, so 1700000059.9999996 is 1700000060.000000 — `new Date(ts * 1000)` truncates instead
 * (…59.999 → another minute / hour / day at the boundary). The calendar fields here are taken from
 * the rounded whole seconds (strftime / .hour / .weekday() never show the microseconds).
 */

'use strict';

/** _PyTime_RoundHalfEven */
function halfEven(x) {
  const r = Math.sign(x) * Math.round(Math.abs(x));      // C round(): half away from zero
  if (Math.abs(x - r) === 0.5) return 2.0 * (Math.sign(x / 2) * Math.round(Math.abs(x / 2)));
  return r;
}

/** _PyTime_DoubleToDenominator(ts, 1e6, HALF_EVEN) → the whole seconds of the datetime. */
function wholeSeconds(ts) {
  let intpart = Math.trunc(ts);
  let us = halfEven((ts - intpart) * 1e6);
  if (us >= 1e6) intpart += 1;
  else if (us < 0) { us += 1e6; intpart -= 1; }
  return intpart;
}

/** A JS Date at the whole second datetime.fromtimestamp(ts, tz=utc) shows. */
const utcDatetime = (ts) => new Date(wholeSeconds(Number(ts)) * 1000);
/** .strftime("%Y-%m-%d") */
const utcDate = (ts) => utcDatetime(ts).toISOString().slice(0, 10);
/** .hour */
const utcHour = (ts) => utcDatetime(ts).getUTCHours();
/** .weekday() (Monday = 0) */
const utcWeekday = (ts) => (utcDatetime(ts).getUTCDay() + 6) % 7;

module.exports = { halfEven, wholeSeconds, utcDatetime, utcDate, utcHour, utcWeekday };
