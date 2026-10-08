'use strict';
/**
 * rng.js — the seeded random source of the genome (mulberry32) with the subset of
 * Python's `random` module API the bot's genome.py uses:
 *
 *   random()            random.random()            float in [0, 1)
 *   randbelow(n)        random._randbelow(n)       int in [0, n)
 *   randint(a, b)       random.randint(a, b)       int in [a, b] (inclusive)
 *   choice(seq)         random.choice(seq)
 *   sample(seq, k)      random.sample(seq, k)      k distinct elements (partial Fisher–Yates)
 *   shuffle(arr)        random.shuffle(arr)        in place, CPython's loop order
 *                                                  (for i in reversed(range(1, n)): j = randbelow(i + 1))
 *
 * DESIGN (PLAN M16): the operators and the Monte-Carlo drawdown take the generator as an
 * argument, so tests replay a fixed seed and get identical genomes run-to-run. The stream
 * is NOT Python's Mersenne Twister — values drawn here differ from the bot's by design;
 * only the algorithms that consume the stream are one-to-one.
 */

/** mulberry32(seed) → () => uint32 */
function mulberry32Uint(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

/** A seed from the clock + Math.random for the production default (not reproducible). */
function freshSeed() {
  return ((Date.now() & 0xffffffff) ^ Math.floor(Math.random() * 0x100000000)) >>> 0;
}

/**
 * createRng(seed) → { seed, random, randbelow, randint, choice, sample, shuffle }.
 * `seed` is any number (coerced to uint32); omitted → a fresh non-reproducible seed.
 */
function createRng(seed = undefined) {
  const s = seed === undefined || seed === null ? freshSeed() : (Number(seed) >>> 0);
  const nextU32 = mulberry32Uint(s);

  const random = () => nextU32() / 4294967296;

  const randbelow = (n) => {
    n = Math.trunc(Number(n));
    if (!(n > 0)) throw new RangeError('randbelow: n must be > 0');
    return Math.floor(random() * n);
  };

  const randint = (a, b) => {
    a = Math.trunc(Number(a));
    b = Math.trunc(Number(b));
    if (b < a) throw new RangeError(`empty range for randint(${a}, ${b})`);
    return a + randbelow(b - a + 1);
  };

  const choice = (seq) => {
    if (!seq || !seq.length) throw new RangeError('Cannot choose from an empty sequence');
    return seq[randbelow(seq.length)];
  };

  const sample = (seq, k) => {
    const pool = Array.from(seq);
    const n = pool.length;
    k = Math.trunc(Number(k));
    if (k < 0 || k > n) throw new RangeError('Sample larger than population or is negative');
    const out = [];
    for (let i = 0; i < k; i++) {
      const j = i + randbelow(n - i);
      const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
      out.push(pool[i]);
    }
    return out;
  };

  const shuffle = (arr) => {
    for (let i = arr.length - 1; i >= 1; i--) {
      const j = randbelow(i + 1);
      const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  };

  return { seed: s, random, randbelow, randint, choice, sample, shuffle };
}

// ── module default (production): one stream per process, re-seedable for tests ──
let _default = createRng();

function defaultRng() {
  return _default;
}

/** Replace the process-wide default generator (tests / the worker pass a seed). */
function setDefaultRng(rngOrSeed) {
  _default = rngOrSeed && typeof rngOrSeed === 'object' ? rngOrSeed : createRng(rngOrSeed);
  return _default;
}

module.exports = { mulberry32Uint, createRng, defaultRng, setDefaultRng, freshSeed };
