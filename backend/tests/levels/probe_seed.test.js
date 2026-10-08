/**
 * probe_seed.test.js — LEVELS differential probe, independent re-check runs of the main suite
 * (tests/golden/levels_probe_s<seed>.json.gz):
 *
 *   make_levels_probe.py --seed <seed> --n-random <n>
 *
 * Every structured case keeps its spec (TF, config, modes, mutation) but runs on other fixture
 * candles (sources redrawn from the seed), and the random cases additionally draw mutations, the
 * live path (persistent indicator, injected clock, cache caps 2/3), analyze_on_demand windows,
 * short HTF frames and the corr modes self / tf1h. levels_probe_s20261009: 308 cases (2× the
 * main suite: 110 structured + 198 random).
 */
import { describe, it } from 'vitest';
import { defineProbeSuite, probeStems } from './probeReplay.js';

const stems = probeStems(/^levels_probe_s\d+$/);
if (!stems.length) {
  describe('LEVELS differential probe re-check runs', () => {
    it.todo('no levels_probe_s<seed>.json.gz generated yet (make_levels_probe.py --seed N --n-random M)');
  });
}
for (const stem of stems) defineProbeSuite(stem, { title: `re-check ${stem.slice('levels_probe_'.length)}`, minCases: 100 });
