/**
 * pyre — a Python `re` str pattern (the subset the bot's ported regexes use) compiled to a JS
 * RegExp with CPython 3.11 semantics:
 *
 *   \d   Nd digits of unicodedata 14.0.0 (JS \d is ASCII only; CPython 3.12 adds Unicode 15 digits)
 *   \s   str.isspace() (JS \s adds U+FEFF and misses \x1c–\x1f, U+0085)
 *   \w   str.isalnum() + '_' (JS \w is ASCII only)
 *   \b   a \w / non-\w transition with the \w above (JS \b is ASCII only)
 *   re.IGNORECASE   an ASCII letter matches its two cases plus what CPython adds (i: İ ı,
 *                   k: U+212A KELVIN SIGN, s: ſ) — JS /i (and /iu) differ on exactly those
 *
 * Supported syntax: literals, `\` escapes of punctuation, \d \s \w \b \D \S \W, character classes
 * (with \d \s \w inside), groups (capturing and `(?:…)`), alternation, quantifiers, `.` `^` `$`. Anything else throws, so a
 * new pattern cannot silently fall back to JS semantics. The RegExp always has the `u` flag
 * (code points, like Python str); pass 'g' for re.sub / findall.
 */

'use strict';

const { ND_CLASS, SPACE_CLASS, WORD_CLASS, WORD_BOUNDARY, RE_IGNORECASE_EXTRA } = require('./pyUnicode');

const hexCp = (c) => `\\u{${c.toString(16)}}`;

/** The class members a letter stands for under re.IGNORECASE. */
function caseSet(ch) {
  const lo = ch.toLowerCase();
  const cps = [lo.codePointAt(0), ch.toUpperCase().codePointAt(0), ...(RE_IGNORECASE_EXTRA[lo.codePointAt(0)] || [])];
  return [...new Set(cps)].map(hexCp).join('');
}

const SYNTAX = new Set('^$\\.*+?()[]{}|/'.split(''));    // escapable in a `u` RegExp
const OTHER_PUNCT = /^[-:"'#=!<>,@%&~`;_ ]$/;            // Python allows the escape; JS `u` does not (literal)

/**
 * @param {string} pattern  the Python pattern (raw string text)
 * @param {{ignoreCase?: boolean, global?: boolean}} [opts]
 */
function pyRegExp(pattern, opts = {}) {
  const ic = Boolean(opts.ignoreCase);
  let out = '';
  let i = 0;
  let inClass = false;
  const isLetter = (c) => /^[A-Za-z]$/.test(c);
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '\\') {
      const e = pattern[i + 1];
      i += 2;
      if (e === 'd') out += inClass ? ND_CLASS : `[${ND_CLASS}]`;
      else if (e === 's') out += inClass ? SPACE_CLASS : `[${SPACE_CLASS}]`;
      else if (e === 'w') out += inClass ? WORD_CLASS : `[${WORD_CLASS}]`;
      else if (!inClass && e === 'D') out += `[^${ND_CLASS}]`;
      else if (!inClass && e === 'S') out += `[^${SPACE_CLASS}]`;
      else if (!inClass && e === 'W') out += `[^${WORD_CLASS}]`;
      else if (!inClass && e === 'b') out += WORD_BOUNDARY;
      else if (e === 'n') out += '\\n';
      else if (e === 't') out += '\\t';
      else if (e !== undefined && SYNTAX.has(e)) out += `\\${e}`;
      else if (e !== undefined && OTHER_PUNCT.test(e)) out += inClass && e === '-' ? '\\-' : e;
      else throw new Error(`pyRegExp: unsupported escape \\${e} in ${pattern}`);
      continue;
    }
    if (inClass) {
      if (c === ']') { inClass = false; out += c; } else if (ic && isLetter(c)) {
        if (pattern[i - 1] === '-' || pattern[i + 1] === '-') throw new Error(`pyRegExp: letter range under IGNORECASE in ${pattern}`);
        out += caseSet(c);
      } else if (c === '/') out += '\\/';
      else out += c;
      i += 1;
      continue;
    }
    if (c === '.') { out += '[^\\n]'; i += 1; continue; }        // no DOTALL: anything but newline (JS also excludes CR, LS, PS)
    if (c === '$') { out += '(?=\\n?$)'; i += 1; continue; }     // end, or before a final '\n'
    if (c === '[') {
      inClass = true;
      out += c;
      if (pattern[i + 1] === '^') { out += '^'; i += 1; }
      if (pattern[i + 1] === ']') { out += '\\]'; i += 1; }   // a leading ']' is literal in Python
      i += 1;
      continue;
    }
    if (c === '(' && pattern[i + 1] === '?') {
      if (pattern[i + 2] !== ':') throw new Error(`pyRegExp: unsupported group syntax in ${pattern}`);
      out += '(?:';                                              // non-capturing group: same in both
      i += 3;
      continue;
    }
    if (ic && isLetter(c)) out += `[${caseSet(c)}]`;
    else if (c === '/') out += '\\/';
    else if (c.codePointAt(0) > 0x7f) throw new Error(`pyRegExp: non-ASCII literal in ${pattern}`);
    else out += c;
    i += 1;
  }
  if (inClass) throw new Error(`pyRegExp: unterminated class in ${pattern}`);
  return new RegExp(out, `u${opts.global ? 'g' : ''}`);
}

module.exports = { pyRegExp };
