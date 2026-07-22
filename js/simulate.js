// Monte Carlo schedule risk simulation.

import { compileGraph, projectDurationFor } from './cpm.js';

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

/**
 * Run `runs` schedule simulations without blocking the page.
 *
 * The dependency graph and its topological order are built once and reused,
 * and each run needs only a forward pass — the previous implementation rebuilt
 * the whole graph and ran Kahn's algorithm per run, which made 20 000 runs
 * freeze the tab. Work is sliced across animation frames so the progress
 * indicator paints and the window stays responsive.
 *
 * @returns {Promise<{mean:number,p50:number,p80:number,p95:number,results:number[]}|null>}
 *          null when the graph contains a cycle.
 */
export function runMonteCarlo({ nodes, mode, rollup, runs, onProgress, chunk = 250 }) {
  return new Promise(resolve => {
    if (!nodes.length) {
      resolve(null);
      return;
    }

    const graph = compileGraph(nodes);
    if (graph.cycleIds.length) {
      resolve(null);
      return;
    }

    // Tasks whose duration comes from a linked sub-page are held at their
    // rolled-up value; only leaf estimates are sampled.
    const sampled = [];
    const fixed = new Map();
    nodes.forEach(n => {
      const rolled = rollup && n.linkedSubPage ? rollup(n.linkedSubPage) : 0;
      if (rolled > 0) {
        fixed.set(n.id, rolled);
      } else {
        const o = Number(n.min) || 0;
        const p = Number(n.max) || 0;
        const m = n.likely != null && Number.isFinite(Number(n.likely))
          ? Number(n.likely)
          : (o + p) / 2;
        sampled.push({ id: n.id, o, m, p });
      }
    });

    const durations = new Map(fixed);
    const results = new Array(runs);
    let done = 0;

    function step() {
      const end = Math.min(runs, done + chunk);
      for (; done < end; done++) {
        for (const t of sampled) {
          durations.set(t.id, sampleTriangular(t.o, t.m, t.p));
        }
        results[done] = projectDurationFor(graph, durations);
      }

      if (done < runs) {
        if (onProgress) onProgress(done / runs);
        requestAnimationFrame(step);
        return;
      }

      if (onProgress) onProgress(1);
      results.sort((a, b) => a - b);
      resolve({
        mean: results.reduce((sum, v) => sum + v, 0) / results.length,
        p50: percentile(results, 0.5),
        p80: percentile(results, 0.8),
        p95: percentile(results, 0.95),
        results
      });
    }

    requestAnimationFrame(step);
  });
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
