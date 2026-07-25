import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeState } from '../js/state.js';

// normalizeState is the repair gate every loaded, shared, or hand-edited project
// passes through. These lock the repairs the README promises: id de-duplication,
// dangling-reference cleanup, and migration of the legacy dependency form. The
// input in each case is a deliberately malformed file — the point is what comes
// out.

function fileWith(nodes, extra = {}) {
  return {
    diagrams: { main: { milestones: [{ id: 'm1', title: 'Phase', nodes }] } },
    ...extra
  };
}

function nodesOfMain(state) {
  return state.diagrams.main.milestones.flatMap(ms => ms.nodes);
}

test('duplicate task ids within a diagram are made unique', () => {
  // Lookups return the first match, so a silent duplicate would shadow the other.
  const state = normalizeState(fileWith([
    { id: 'A', min: 1, max: 2, dependencies: [] },
    { id: 'A', min: 1, max: 2, dependencies: [] },
    { id: 'A', min: 1, max: 2, dependencies: [] }
  ]));
  const ids = nodesOfMain(state).map(n => n.id);
  assert.equal(new Set(ids).size, ids.length, 'every id is unique after repair');
  assert.deepEqual(ids, ['A', 'A_1', 'A_1_1']);
});

test('dependencies pointing at tasks that no longer exist are dropped', () => {
  const state = normalizeState(fileWith([
    { id: 'A', min: 1, max: 2, dependencies: [] },
    { id: 'B', min: 1, max: 2, dependencies: ['A', 'GHOST'] }
  ]));
  const b = nodesOfMain(state).find(n => n.id === 'B');
  assert.deepEqual(b.dependencies.map(d => d.id), ['A'], 'GHOST is gone, A survives');
});

test('a self-dependency is rejected', () => {
  const state = normalizeState(fileWith([
    { id: 'A', min: 1, max: 2, dependencies: ['A'] }
  ]));
  assert.deepEqual(nodesOfMain(state)[0].dependencies, []);
});

test('the legacy bare-array dependency form migrates to objects', () => {
  // Files written before precedence types existed held dependencies as a plain
  // array of predecessor ids.
  const state = normalizeState(fileWith([
    { id: 'A', min: 1, max: 2, dependencies: [] },
    { id: 'B', min: 1, max: 2, dependencies: ['A'] }
  ]));
  const b = nodesOfMain(state).find(n => n.id === 'B');
  assert.deepEqual(b.dependencies, [{ id: 'A', type: 'FS', lag: 0 }]);
});

test('duplicate predecessors collapse to one', () => {
  const state = normalizeState(fileWith([
    { id: 'A', min: 1, max: 2, dependencies: [] },
    { id: 'B', min: 1, max: 2, dependencies: ['A', { id: 'A', type: 'SS', lag: 3 }] }
  ]));
  const b = nodesOfMain(state).find(n => n.id === 'B');
  assert.equal(b.dependencies.length, 1, 'A appears once');
});

test('out-of-range estimates are clamped into a sane triangle', () => {
  // max below min, and a most-likely outside [min, max], would make the
  // triangular sampler return NaN.
  const state = normalizeState(fileWith([
    { id: 'A', min: 5, max: 2, likely: 99, dependencies: [] }
  ]));
  const a = nodesOfMain(state)[0];
  assert.ok(a.max >= a.min, 'max is lifted to at least min');
  assert.ok(a.likely >= a.min && a.likely <= a.max, 'likely sits inside [min, max]');
});

test('links that no longer resolve are cleared', () => {
  const state = normalizeState(fileWith([
    { id: 'A', min: 1, max: 2, dependencies: [], linkedSubPage: 'sub_missing' }
  ]));
  assert.equal(nodesOfMain(state)[0].linkedSubPage, null);
});

test('the retired linkedMainNode back-pointer is dropped on load', () => {
  // linkedMainNode was a hand-set sub-path → Main back-pointer, removed in favour
  // of the page-tab strip's automatic back chip. Old files carrying it migrate
  // by having the field deleted, not merely nulled.
  const state = normalizeState({
    diagrams: {
      main: { milestones: [{ id: 'm1', nodes: [{ id: 'A', min: 1, max: 2, dependencies: [] }] }] },
      sub_1: { milestones: [{ id: 'm2', nodes: [{ id: 'S', min: 1, max: 2, dependencies: [], linkedMainNode: 'A' }] }] }
    },
    pageOrder: ['main', 'sub_1']
  });
  const s = state.diagrams.sub_1.milestones[0].nodes[0];
  assert.equal('linkedMainNode' in s, false, 'the field is gone, not just null');
});

test('the schema version is stamped and export provenance is stripped', () => {
  // appVersion/exportedAt belong to the file that was written, not the live
  // project — left in, they would autosave and override the next export.
  const state = normalizeState(fileWith(
    [{ id: 'A', min: 1, max: 2, dependencies: [] }],
    { schemaVersion: 1, appVersion: '0.0.1', exportedAt: '2020-01-01T00:00:00.000Z' }
  ));
  assert.equal(state.schemaVersion, 3);
  assert.equal(state.appVersion, undefined);
  assert.equal(state.exportedAt, undefined);
});

test('a negative deadline reads as no deadline, not a day-zero due date', () => {
  const state = normalizeState(fileWith(
    [{ id: 'A', min: 1, max: 2, dependencies: [] }],
    { deadline: -5, dataDate: -1 }
  ));
  assert.equal(state.deadline, null);
  assert.equal(state.dataDate, null);
});

test('a missing diagrams.main is rejected outright', () => {
  assert.throws(() => normalizeState({ diagrams: {} }), /diagrams\.main/);
  assert.throws(() => normalizeState(null), /object/);
});
