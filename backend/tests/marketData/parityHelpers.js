'use strict';
/**
 * Helpers for the bot-parity tests: fixtures under tests/fixtures/marketData/parity were
 * produced by the bot's own Python (see parity/gen/*.py and parity/README.md); the tests
 * replay the same inputs through the JS port and compare value for value.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { expect } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));

export function loadParity(name) {
  return JSON.parse(fs.readFileSync(path.join(here, '../fixtures/marketData/parity', name), 'utf8'));
}

/** Exact float equality element by element (`===`, NaN == NaN) with a readable failure. */
export function sameNumbers(actual, expected, label = '') {
  const a = Array.from(actual);
  expect(a.length, `${label} length`).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    const x = a[i], e = expected[i];
    if (!(x === e || (Number.isNaN(x) && Number.isNaN(e)))) {
      expect.fail(`${label}[${i}]: JS ${x} !== bot ${e}`);
    }
  }
}

/** Frame vs the generator's {t,o,h,l,c,v} column dump. */
export function sameFrame(frame, expected, label = '') {
  expect(frame, label).not.toBe(null);
  expect(frame.length, `${label} length`).toBe(expected.t.length);
  for (const col of ['t', 'o', 'h', 'l', 'c', 'v']) sameNumbers(frame[col], expected[col], `${label}.${col}`);
}

/** `{ status, headers, json, text }` like httpClient.fetchJson for a JSON body. */
export function okJson(obj) {
  return { status: 200, headers: { get: () => null }, json: obj, text: JSON.stringify(obj) };
}

export function httpError(status) {
  return { status, headers: { get: () => null }, json: null, text: '' };
}

export const silentLog = { debug() {}, info() {}, warning() {}, warn() {}, error() {} };
