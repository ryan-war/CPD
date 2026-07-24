import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeCPM } from '../js/cpm.js';
import {
  taskSafety, sizeBuffer, criticalChain, feedingPaths, criticalChainReport
} from '../js/critical-chain.js';

// A schedule as the app builds it: computeCPM's result with the mode attached
// (schedule() does exactly this before the panel reads it).
function sched(nodes, opts = {}) {
  const mode = opts.mode || 'average';
  return { ...computeCPM(nodes, { mode, ...opts }), mode };
}

test('taskSafety is the pessimistic case beyond the used estimate, floored at zero', () => {
  assert.equal(taskSafety({ min: 2, likely: 3, max: 4 }, 'average'), 1); // used (2+4)/2=3
  assert.equal(taskSafety({ min: 5, likely: 5, max: 5 }, 'average'), 0); // no spread, no safety
  assert.equal(taskSafety({ min: 2, likely: 3, max: 4 }, 'pert'), 1);    // used (2+12+4)/6=3
});

test('sizeBuffer pools safeties by sum-of-squares, not by adding them', () => {
  assert.equal(sizeBuffer([3, 4]), 5);          // sqrt(9+16)
  assert.equal(sizeBuffer([2, 2]), 2.8284);     // sqrt(8), under the naive 4
  assert.equal(sizeBuffer([]), 0);
});

test('the critical chain is the zero-float tasks in schedule order', () => {
  // A and B both feed C; B is longer so it drives C — B and C are the chain, A
  // has float and feeds in.
  const nodes = [
    { id: 'A', min: 2, likely: 3, max: 4, dependencies: [] },
    { id: 'B', min: 1, likely: 5.5, max: 10, dependencies: [] },
    { id: 'C', min: 5, likely: 5, max: 5,
      dependencies: [{ id: 'A', type: 'FS', lag: 0 }, { id: 'B', type: 'FS', lag: 0 }] }
  ];
  const { chainIds } = criticalChain(sched(nodes));
  assert.deepEqual(chainIds, ['B', 'C']);
});

test('a feeding buffer sits at each merge, sized from the feeding path', () => {
  const nodes = [
    { id: 'A', min: 2, likely: 3, max: 4, dependencies: [] },              // safety 1
    { id: 'B', min: 1, likely: 5.5, max: 10, dependencies: [] },
    { id: 'C', min: 5, likely: 5, max: 5,
      dependencies: [{ id: 'A', type: 'FS', lag: 0 }, { id: 'B', type: 'FS', lag: 0 }] }
  ];
  const s = sched(nodes);
  const chain = new Set(criticalChain(s).chainIds);
  const feeders = feedingPaths(s, chain);

  assert.equal(feeders.length, 1);
  assert.equal(feeders[0].mergeId, 'C');
  assert.deepEqual(feeders[0].pathIds, ['A']);
  assert.equal(feeders[0].buffer, 1);
});

test('the project buffer pools the chain safety; a flat plan has none', () => {
  const spread = criticalChainReport(sched([
    { id: 'A', min: 1, likely: 5.5, max: 10, dependencies: [] },
    { id: 'B', min: 5, likely: 5, max: 5, dependencies: [{ id: 'A', type: 'FS', lag: 0 }] }
  ]), null);
  assert.equal(spread.projectBuffer, 4.5); // sqrt(4.5^2 + 0)

  const flat = criticalChainReport(sched([
    { id: 'A', min: 3, likely: 3, max: 3, dependencies: [] },
    { id: 'B', min: 4, likely: 4, max: 4, dependencies: [{ id: 'A', type: 'FS', lag: 0 }] }
  ]), null);
  assert.equal(flat.projectBuffer, 0);
  assert.equal(flat.consumption, null, 'no buffer means no consumption to read');
});

test('consumption reads the forecast slip against the baseline, and colours it', () => {
  // Half the chain done; the forecast finishes 3 past a baseline of 12, against a
  // ~2.83 buffer — buffer blown, deep in the red.
  const schedule = {
    criticalIds: new Set(['A', 'B']),
    order: ['A', 'B'],
    mode: 'average',
    dataDate: 6,
    projectDuration: 15,
    metrics: {
      A: { min: 4, likely: 6, max: 8, duration: 6, progress: 100, dependencies: [] },
      B: { min: 4, likely: 6, max: 8, duration: 6, progress: 0,
           dependencies: [{ id: 'A', type: 'FS', lag: 0 }] }
    }
  };
  const report = criticalChainReport(schedule, { projectDuration: 12 });
  assert.equal(report.projectBuffer, 2.8284);       // sqrt(2^2 + 2^2)
  assert.equal(report.consumption.chainComplete, 0.5);
  assert.equal(report.consumption.bufferConsumed, 1.0607); // 3 / 2.8284
  assert.equal(report.consumption.zone, 'red');
});

test('consumption stays null without a reporting date or a baseline', () => {
  const base = {
    criticalIds: new Set(['A']), order: ['A'], mode: 'average', projectDuration: 8,
    metrics: { A: { min: 4, likely: 6, max: 8, duration: 6, progress: 50, dependencies: [] } }
  };
  assert.equal(criticalChainReport({ ...base, dataDate: null }, { projectDuration: 6 }).consumption, null);
  assert.equal(criticalChainReport({ ...base, dataDate: 3 }, null).consumption, null);
});

test('a cyclic network yields no chain and no buffers', () => {
  const cyc = sched([
    { id: 'A', min: 1, likely: 1.5, max: 2, dependencies: [{ id: 'B', type: 'FS', lag: 0 }] },
    { id: 'B', min: 1, likely: 1.5, max: 2, dependencies: [{ id: 'A', type: 'FS', lag: 0 }] }
  ]);
  const report = criticalChainReport(cyc, { projectDuration: 4 });
  assert.deepEqual(report.chainIds, []);
  assert.equal(report.projectBuffer, 0);
  assert.deepEqual(report.feeders, []);
  assert.equal(report.consumption, null);
});
