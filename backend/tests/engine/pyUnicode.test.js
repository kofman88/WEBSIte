/**
 * engine/pyUnicode.js — the bot's Unicode database (CPython 3.11.17, unicodedata 14.0.0, the
 * production interpreter), not Node's (Unicode 16) and not CPython 3.12's (15.0.0). Every
 * expected value below was printed by CPython 3.11.17 (int() / float() / repr() directly, and
 * the bot's own handlers/challenge._parse_num for parseNum):
 *   python3.11 -c "int('\U00011f51')"            → ValueError: invalid literal for int() with base 10: '\U00011f51'
 *   python3.11 -c "print(ascii(repr('\U0001fae8')))"  → "'\\U0001fae8'"
 * Under 3.12 the Kawi / Nag Mundari digits (Unicode 15.0) are digits (int('\U00011f51') == 1)
 * and every character assigned in 15.0 is printable; under 3.11 they are unassigned.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);
const U = req('../../services/engine/pyUnicode.js');
const C = req('../../services/challengeService.js');
const PC = req('../../services/exchanges/pyCompat.js');
const CF = req('../../services/marketData/candleFrame.js');

const KAWI_1 = '\u{11F51}';
const NAG_2 = '\u{1E4F2}';

describe('pyUnicode: the tables are CPython 3.11 (unicodedata 14.0.0)', () => {
  it('version and the Unicode 15.0 digit runs that 3.11 does not have', () => {
    expect(U.UNIDATA_VERSION).toBe('14.0.0');
    expect(U.ND_ZEROS.length).toBe(66);           // 68 in 3.12 (unicodedata 15.0.0)
    expect(U.ND_ZEROS).not.toContain(0x11f50);    // Kawi digit zero (15.0)
    expect(U.ND_ZEROS).not.toContain(0x1e4f0);    // Nag Mundari digit zero (15.0)
    expect(U.digitValue(0x11f51)).toBe(-1);
    expect(U.digitValue(0x1e4f2)).toBe(-1);
    expect(U.digitValue(0x0662)).toBe(2);         // Arabic-Indic two
    expect(U.digitValue(0x16a61)).toBe(1);        // Mro digit one (Unicode 7)
  });

  it('isprintable: characters assigned in Unicode 15.0 are unassigned (not printable) for 3.11', () => {
    for (const cp of [0x1fae8, 0x1f6dc, 0x1fa75, 0x11f50, 0x1e4f0, 0x1e030]) expect(U.isPrintable(cp), cp.toString(16)).toBe(false);
    expect(U.isPrintable(0x0c5d)).toBe(true);     // Telugu, Unicode 14.0
    expect(U.isPrintable(0x0c3c)).toBe(true);     // Telugu sign nukta, Unicode 14.0
    expect(U.isPrintable(0x20)).toBe(true);
    expect(U.isPrintable(0xa0)).toBe(false);      // Zs other than ' '
  });

  it('isspace: the 29 code points of str.isspace() (U+FEFF / U+180E / U+200B are not)', () => {
    expect([...U.PY_SPACE].sort((a, b) => a - b)).toEqual([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85,
      0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028,
      0x2029, 0x202f, 0x205f, 0x3000]);
    for (const cp of [0xfeff, 0x180e, 0x200b]) expect(U.isSpace(cp)).toBe(false);
  });
});

describe('int() / float() / re \\d / repr() ports follow 3.11', () => {
  it('challengeService.pyInt / pyFloat: Unicode 15.0 digits raise with the escaped repr', () => {
    expect(() => C.pyInt(KAWI_1)).toThrow("invalid literal for int() with base 10: '\\U00011f51'");
    expect(() => C.pyFloat(KAWI_1)).toThrow("could not convert string to float: '\\U00011f51'");
    expect(() => C.pyInt(NAG_2)).toThrow("invalid literal for int() with base 10: '\\U0001e4f2'");
    expect(() => C.pyInt('1\u{1E4F0}')).toThrow("invalid literal for int() with base 10: '1\\U0001e4f0'");
    expect(C.pyInt('١٢')).toBe(12);
    expect(C.pyFloat('\u{1D7CE}\u{1D7CF}')).toBe(1);
    expect(C.pyInt('\u{16A61}')).toBe(1);
  });

  it('challengeService.parseNum (handlers/challenge._parse_num): `\\d` skips Unicode 15.0 digits', () => {
    expect(C.parseNum(`${KAWI_1}5`)).toBe(5.0);
    expect(C.parseNum('x\u{1E4F3},5')).toBe(5.0);
    expect(C.parseNum('١٢,5')).toBe(12.5);
    expect(C.parseNum('\u{11F50}')).toBe(null);
  });

  it('repr(): challengeService.pyStrRepr and exchanges pyCompat.pyStrRepr escape Unicode 15.0 characters', () => {
    const cases = [
      ['\u{1FAE8}', "'\\U0001fae8'"], ['\u{1F6DC}', "'\\U0001f6dc'"], ['ౝ', "'ౝ'"],
      ['a\u{1FA75}b', "'a\\U0001fa75b'"], ['\u{11F50}', "'\\U00011f50'"], ['\u{1E4F0}', "'\\U0001e4f0'"],
      ['\u{1E030}', "'\\U0001e030'"], ['఼', "'఼'"],
    ];
    for (const [s, r] of cases) {
      expect(C.pyStrRepr(s), r).toBe(r);
      expect(PC.pyStrRepr(s), r).toBe(r);
    }
  });

  it('marketData candleFrame.pyInt / pyFloat (fetcher_bingx._rows_to_df): digits and number whitespace', () => {
    for (const s of [KAWI_1, NAG_2, '1\u{1E4F0}', '﻿12', '\x1C12', '12᠎']) {
      expect(() => CF.pyInt(s), JSON.stringify(s)).toThrow(CF.PyValueError);
      expect(() => CF.pyFloat(s), JSON.stringify(s)).toThrow(CF.PyValueError);
    }
    for (const s of ['١٢', '12\x85', '\x0B12\x0C', '\xA012', ' 12　']) {
      expect(CF.pyInt(s), JSON.stringify(s)).toBe(12);
      expect(CF.pyFloat(s), JSON.stringify(s)).toBe(12);
    }
    expect(CF.pyInt('\u{1D7CE}\u{1D7CF}')).toBe(1);
    expect(CF.pyFloat('\u{16A61}')).toBe(1);
  });
});
