// Sampling and summary statistics.
//
// Separated from simulate.js so the worker can import it without pulling in
// anything that touches the DOM or the Worker API itself.

/**
 * Inverse-CDF sample from a triangular distribution.
 * `m` is clamped into [o, p]: outside that range the closed form takes the
 * square root of a negative and yields NaN, which a loaded project could
 * otherwise trigger.
 */
export function sampleTriangular(o, m, p) {
  if (!(p > o)) return o;
  const mode = Math.min(p, Math.max(o, m));
  const u = Math.random();
  const split = (mode - o) / (p - o);
  if (u < split) return o + Math.sqrt(u * (p - o) * (mode - o));
  return p - Math.sqrt((1 - u) * (p - o) * (p - mode));
}

/** Linear-interpolated percentile of an ascending array. */
export function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/** Pearson correlation, used for duration-to-outcome sensitivity. */
export function correlation(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n;
  const my = sy / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  return den < 1e-12 ? 0 : num / den;
}

/** Bin a sorted result set into a histogram of `bins` counts. */
export function histogram(sorted, bins = 24) {
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const span = Math.max(0.001, max - min);
  const counts = new Array(bins).fill(0);
  for (const v of sorted) {
    let b = Math.floor(((v - min) / span) * bins);
    if (b >= bins) b = bins - 1;
    if (b < 0) b = 0;
    counts[b]++;
  }
  return { counts, min, max };
}
