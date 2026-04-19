/**
 * Level builder — clusters raw pivots into "levels" with touch-count.
 *
 * A Level = { price, touches: [{index, price}], side: 'resistance'|'support', firstTouch, lastTouch }.
 * Two pivots merge into the same level when their prices are within
 * `clusterAtrMult * atrNow`.
 *
 * Levels are returned sorted by strength descending (more touches = stronger).
 */

const indicators = require('../../services/indicators');

/**
 * @param {Array<[t,o,h,l,c,v,ct]>} candles
 * @param {object} cfg
 * @param {number} atrNow   Current ATR value (used for cluster threshold)
 * @returns {Array<Level>}
 */
function buildLevels(candles, cfg, atrNow) {
  if (!Number.isFinite(atrNow) || atrNow <= 0) return [];
  const { highs, lows } = indicators.findPivots(candles, cfg.pivotStrength);
  const threshold = cfg.clusterAtrMult * atrNow;

  const levelsR = clusterPivots(highs, threshold, 'resistance');
  const levelsS = clusterPivots(lows,  threshold, 'support');

  // Filter: minimum touches
  const keepR = levelsR.filter((l) => l.touches.length >= cfg.minTouches);
  const keepS = levelsS.filter((l) => l.touches.length >= cfg.minTouches);

  // Sort by touches desc, then by recency (lastTouch desc)
  const sortFn = (a, b) => (b.touches.length - a.touches.length) || (b.lastTouch - a.lastTouch);
  keepR.sort(sortFn);
  keepS.sort(sortFn);

  return [
    ...keepR.slice(0, cfg.topLevelsPerSide),
    ...keepS.slice(0, cfg.topLevelsPerSide),
  ];
}

function clusterPivots(pivots, threshold, side) {
  if (!pivots.length) return [];
  // Sort by price asc to make clustering linear
  const sorted = pivots.slice().sort((a, b) => a.price - b.price);
  const clusters = [];
  let curr = { price: sorted[0].price, touches: [sorted[0]] };
  for (let i = 1; i < sorted.length; i++) {
    const p = sorted[i];
    if (Math.abs(p.price - curr.price) <= threshold) {
      curr.touches.push(p);
      // Recompute cluster price as simple mean of touches
      const mean = curr.touches.reduce((s, t) => s + t.price, 0) / curr.touches.length;
      curr.price = mean;
    } else {
      clusters.push(curr);
      curr = { price: p.price, touches: [p] };
    }
  }
  clusters.push(curr);

  return clusters.map((c) => ({
    price: c.price,
    side,
    touches: c.touches,
    firstTouch: Math.min(...c.touches.map((t) => t.index)),
    lastTouch:  Math.max(...c.touches.map((t) => t.index)),
  }));
}

module.exports = { buildLevels };
