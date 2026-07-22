// Monte Carlo worker.
//
// The simulation used to run on the main thread, sliced across animation
// frames. That kept the page responsive while the tab was visible, but
// requestAnimationFrame stops firing in a background tab — switching away
// mid-run stalled the simulation indefinitely. A worker is not throttled and
// leaves the main thread entirely free.

import { compileGraph, indexGraph, scheduleSample } from './cpm.js';
import { sampleTriangular } from './sampling.js';

self.onmessage = event => {
  const { nodes, runs, fixed } = event.data;

  const graph = compileGraph(nodes);
  if (graph.cycleIds.length) {
    self.postMessage({ type: 'error', reason: 'cycle' });
    return;
  }

  const indexed = indexGraph(graph);
  const durations = new Float64Array(indexed.n);
  const criticalFlags = new Uint8Array(indexed.n);
  const criticalCount = new Uint32Array(indexed.n);
  const results = new Float64Array(runs);

  // Tasks whose duration comes from a linked sub-page are held at their
  // rolled-up value; only leaf estimates are sampled.
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

  const reportEvery = Math.max(1, Math.floor(runs / 50));
  for (let run = 0; run < runs; run++) {
    for (let s = 0; s < sampled.length; s++) {
      const task = sampled[s];
      const value = sampleTriangular(task.o, task.m, task.p);
      task.samples[run] = value;
      durations[task.index] = value;
    }
    results[run] = scheduleSample(indexed, durations, criticalFlags);
    for (let i = 0; i < criticalFlags.length; i++) {
      if (criticalFlags[i]) criticalCount[i]++;
    }
    if (run % reportEvery === 0) {
      self.postMessage({ type: 'progress', fraction: run / runs });
    }
  }

  const payload = {
    type: 'done',
    ids: indexed.ids,
    results,
    criticalCount,
    samples: sampled.map(t => ({ id: t.id, values: t.samples }))
  };

  // Hand the buffers over rather than copying them.
  self.postMessage(payload, [
    results.buffer,
    criticalCount.buffer,
    ...payload.samples.map(s => s.values.buffer)
  ]);
};
