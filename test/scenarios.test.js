import { test } from 'node:test';
import assert from 'node:assert/strict';

import { rankScenarios } from '../js/scenarios.js';

// Minimal project builders. Average mode means a task's duration is (min+max)/2,
// so a single-task plan finishes in exactly that — easy to reason about.
function node(id, min, max, extra = {}) {
  return { id, title: id, min, likely: (min + max) / 2, max, dependencies: [], progress: 0, ...extra };
}

function project(nodes, { dataDate = null } = {}) {
  return {
    estimationMode: 'average',
    dataDate,
    deadline: null,
    diagrams: { main: { milestones: [{ id: 'm1', nodes }] } }
  };
}

function scenario(id, name, data) {
  return { id, name, capturedAt: '2026-07-23T00:00:00.000Z', data };
}

test('ranks the live plan and scenarios together, soonest finish first', () => {
  const current = project([node('A', 4, 6)]);            // duration 5
  const fast = scenario('fast', 'Fast', project([node('A', 2, 4)]));   // 3
  const slow = scenario('slow', 'Slow', project([node('A', 8, 10)]));  // 9

  const ranked = rankScenarios(current, [fast, slow], 'finish');

  assert.deepEqual(ranked.map(e => e.id), ['fast', 'current', 'slow']);
  assert.equal(ranked[0].isBest, true);
  assert.equal(ranked[1].isBest, false);
});

test('the live plan is present as a synthetic current entry, delta zero', () => {
  const current = project([node('A', 4, 6)]);
  const ranked = rankScenarios(current, [], 'finish');

  const live = ranked.find(e => e.isCurrent);
  assert.ok(live, 'a current entry exists');
  assert.equal(live.id, 'current');
  assert.equal(live.projectDuration, 5);
  assert.equal(live.finishDelta, 0);
});

test('finishDelta is measured against the live plan', () => {
  const current = project([node('A', 4, 6)]);            // 5
  const fast = scenario('fast', 'Fast', project([node('A', 2, 4)]));   // 3 → -2
  const slow = scenario('slow', 'Slow', project([node('A', 8, 10)]));  // 9 → +4

  const ranked = rankScenarios(current, [fast, slow], 'finish');
  assert.equal(ranked.find(e => e.id === 'fast').finishDelta, -2);
  assert.equal(ranked.find(e => e.id === 'slow').finishDelta, 4);
});

test('ranks by EAC when asked, cheapest forecast first', () => {
  // EAC = BAC / CPI, CPI = EV / AC. progress 50 on a 1000 budget earns 500.
  const cheap = scenario('cheap', 'Cheap',
    project([node('A', 4, 6, { cost: 1000, progress: 50, actualCost: 400 })])); // CPI 1.25 → EAC 800
  const dear = scenario('dear', 'Dear',
    project([node('A', 4, 6, { cost: 1000, progress: 50, actualCost: 600 })]));  // CPI 0.83 → EAC 1200
  const current = project([node('A', 4, 6, { cost: 1000, progress: 50, actualCost: 500 })]); // EAC 1000

  const ranked = rankScenarios(current, [cheap, dear], 'eac');
  assert.deepEqual(ranked.map(e => e.id), ['cheap', 'current', 'dear']);
  assert.equal(ranked[0].eac, 800);
  assert.equal(ranked[0].isBest, true);
});

test('plans with no actuals have a null EAC and sort last on the cost key', () => {
  const withEac = scenario('has', 'Has cost',
    project([node('A', 4, 6, { cost: 1000, progress: 50, actualCost: 400 })])); // EAC 800
  const noEac = scenario('none', 'No cost',
    project([node('A', 4, 6, { cost: 1000, progress: 50 })]));                   // actualCost null → EAC null
  const current = project([node('A', 4, 6)]);                                    // no cost → EAC null

  const ranked = rankScenarios(current, [withEac, noEac], 'eac');
  // The only entry with a real forecast leads; the two nulls follow, never ahead.
  assert.equal(ranked[0].id, 'has');
  assert.equal(ranked[0].eac, 800);
  assert.equal(ranked[0].isBest, true);
  assert.ok(ranked.slice(1).every(e => e.eac == null), 'null EACs are last');
});

test('an empty scenario list still ranks the live plan alone', () => {
  const ranked = rankScenarios(project([node('A', 4, 6)]), [], 'finish');
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].isCurrent, true);
  assert.equal(ranked[0].isBest, true);
});
