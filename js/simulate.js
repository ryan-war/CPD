// Monte Carlo schedule risk simulation.
//
// The work happens in a worker (see simulate.worker.js) so the page stays
// responsive and the run continues even if the tab is put in the background.
// A main-thread fallback covers environments where workers are unavailable.

import { compileGraph, indexGraph, scheduleSample } from './cpm.js';
import { sampleTriangular, percentile, correlation, histogram } from './sampling.js';

export { sampleTriangular, percentile, histogram };

/**
 * @returns {Promise<object|null>} null when the graph contains a cycle.
 */
export function runMonteCarlo({ nodes, rollup, runs, onProgress, dataDate, progressRollup }) {
  if (!nodes.length) return Promise.resolve(null);

  const graph = compileGraph(nodes);
  if (graph.cycleIds.length) return Promise.resolve(null);

  // Sub-path roll-up needs the whole project, which the worker does not have,
  // so those durations are resolved here and passed across as fixed values.
  const fixed = nodes.map(n => (rollup && n.linkedSubPage ? rollup(n.linkedSubPage) : 0));
  const plain = nodes.map(n => ({
    id: n.id,
    min: n.min,
    likely: n.likely,
    max: n.max,
    dependencies: n.dependencies
  }));

  const status = statusArrays(nodes, { dataDate, progressRollup });

  return runInWorker({ nodes: plain, fixed, runs, onProgress, status })
    .catch(() => runInline({ nodes, fixed, runs, onProgress, status }));
}

/**
 * The per-task constraint and progress the sampler schedules against, flattened
 * to arrays indexed like `nodes` — which is also how `compileGraph` indexes
 * them, so they line up with the typed-array scheduler without a lookup.
 *
 * Simulating without these re-rolls work that is already finished and reports
 * risk on a project that no longer exists: an 80%-done task would draw a fresh
 * full-width estimate every run rather than the fifth of one still outstanding.
 */
function statusArrays(nodes, { dataDate, progressRollup }) {
  const notBefore = new Float64Array(nodes.length);
  const progress = new Float64Array(nodes.length);
  let anyConstraint = false;

  nodes.forEach((n, i) => {
    const floor = Number(n.startNoEarlierThan);
    if (Number.isFinite(floor) && floor > 0) {
      notBefore[i] = floor;
      anyConstraint = true;
    }
    let percent = Number(n.progress) || 0;
    if (progressRollup && n.linkedSubPage) {
      const rolled = progressRollup(n.linkedSubPage);
      if (rolled != null) percent = rolled;
    }
    progress[i] = Math.max(0, Math.min(100, percent));
  });

  const reporting = dataDate == null ? null : Number(dataDate);
  if (reporting == null && !anyConstraint) return null;
  return {
    dataDate: Number.isFinite(reporting) ? reporting : null,
    notBefore: anyConstraint ? notBefore : null,
    progress
  };
}

function runInWorker({ nodes, fixed, runs, onProgress, status }) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL('./simulate.worker.js', import.meta.url), { type: 'module' });
    } catch (err) {
      reject(err);
      return;
    }

    const started = performance.now();
    let settled = false;

    const finish = value => {
      if (settled) return;
      settled = true;
      worker.terminate();
      resolve(value);
    };

    worker.onerror = err => {
      if (settled) return;
      settled = true;
      worker.terminate();
      reject(err);
    };

    worker.onmessage = event => {
      const data = event.data;
      if (data.type === 'progress') {
        if (onProgress) onProgress(data.fraction);
        return;
      }
      if (data.type === 'error') {
        finish(null);
        return;
      }
      if (onProgress) onProgress(1);
      finish(summarise({
        results: data.results,
        runs,
        sampled: data.samples.map(s => ({ id: s.id, samples: s.values })),
        criticalCount: data.criticalCount,
        ids: data.ids,
        elapsedMs: performance.now() - started
      }));
    };

    worker.postMessage({ nodes, runs, fixed, status });
  });
}

/**
 * Fallback path: the same loop on the main thread, sliced across timeouts so
 * the window keeps painting. Slower and pausable by the browser, but correct.
 */
function runInline({ nodes, fixed, runs, onProgress, status }) {
  return new Promise(resolve => {
    const indexed = indexGraph(compileGraph(nodes));
    const durations = new Float64Array(indexed.n);
    const criticalFlags = new Uint8Array(indexed.n);
    const criticalCount = new Uint32Array(indexed.n);
    const results = new Float64Array(runs);
    const started = performance.now();

    const sampled = [];
    nodes.forEach((n, i) => {
      if (fixed[i] > 0) {
        durations[i] = fixed[i];
        return;
      }
      const o = Number(n.min) || 0;
      const p = Number(n.max) || 0;
      const m = n.likely != null && Number.isFinite(Number(n.likely))
        ? Number(n.likely)
        : (o + p) / 2;
      sampled.push({ index: i, id: n.id, o, m, p, samples: new Float64Array(runs) });
    });

    let done = 0;
    const chunk = Math.max(200, Math.ceil(runs / 40));

    function step() {
      const end = Math.min(runs, done + chunk);
      for (; done < end; done++) {
        for (let s = 0; s < sampled.length; s++) {
          const task = sampled[s];
          const value = sampleTriangular(task.o, task.m, task.p);
          task.samples[done] = value;
          durations[task.index] = value;
        }
        results[done] = scheduleSample(indexed, durations, criticalFlags, status);
        for (let i = 0; i < criticalFlags.length; i++) {
          if (criticalFlags[i]) criticalCount[i]++;
        }
      }

      if (done < runs) {
        if (onProgress) onProgress(done / runs);
        window.setTimeout(step, 0);
        return;
      }
      if (onProgress) onProgress(1);
      resolve(summarise({
        results, runs, sampled, criticalCount,
        ids: indexed.ids, elapsedMs: performance.now() - started
      }));
    }

    window.setTimeout(step, 0);
  });
}

function summarise({ results, runs, sampled, criticalCount, ids, elapsedMs }) {
  const sensitivity = sampled
    .map(task => ({ id: task.id, correlation: correlation(task.samples, results) }))
    .filter(entry => Number.isFinite(entry.correlation))
    .sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));

  const criticality = Array.from(ids)
    .map((id, i) => ({ id, index: criticalCount[i] / runs }))
    .sort((a, b) => b.index - a.index);

  const sorted = Array.from(results).sort((a, b) => a - b);
  return {
    runs,
    elapsedMs,
    mean: sorted.reduce((sum, v) => sum + v, 0) / sorted.length,
    p50: percentile(sorted, 0.5),
    p80: percentile(sorted, 0.8),
    p95: percentile(sorted, 0.95),
    results: sorted,
    criticality,
    criticalityById: new Map(criticality.map(c => [c.id, c.index])),
    sensitivity
  };
}
