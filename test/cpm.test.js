// Scheduling engine tests. Run with: node --test
//
// These lock in the numbers the rest of the application is derived from. A
// regression here would be quietly wrong rather than visibly broken, which is
// exactly the kind that survives a manual pass through the interface.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeCPM, compileGraph, createRollup, createProgressRollup, nodesOf, baseDuration,
  wouldCreateCycle, traceFrom, toDependency, predecessorIds,
  indexGraph, scheduleSample
} from '../js/cpm.js';
import {
  computeCpmLayout, orderedNodes, columnGeometry, columnRowHeight, columnRowOrigin,
  freeSpotNear
} from '../js/layout.js';
import { resourceLoad, assigneeNames } from '../js/resources.js';
import { createDefaultState, normalizeState, captureBaseline } from '../js/state.js';
import { createCalendar, toISODate, parseISODate } from '../js/calendar.js';
import { sampleTriangular, percentile, histogram } from '../js/simulate.js';

const task = (id, min, max, dependencies = [], extra = {}) =>
  ({ id, title: id, min, max, dependencies, ...extra });

function schedule(nodes, options = {}) {
  return computeCPM(nodes, { mode: 'average', ...options });
}

// ─── Baseline: the shipped default project ─────────────────
// Captured from the original implementation before the rewrite. If these
// change, the engine's behaviour has changed.

test('default project matches the captured baseline', () => {
  const state = normalizeState(createDefaultState());
  const nodes = nodesOf(state.diagrams.main);

  for (const mode of ['average', 'pert']) {
    const rollup = createRollup(state.diagrams, mode);
    const result = computeCPM(nodes, { mode, rollup });

    assert.equal(result.projectDuration, 14.5, `${mode} project duration`);
    assert.deepEqual([...result.criticalIds].sort(), ['A', 'B', 'C', 'E']);
    assert.deepEqual(result.cycleIds, []);

    const expected = {
      A: { duration: 3, ES: 0, EF: 3, LS: 0, LF: 3, slack: 0 },
      B: { duration: 4, ES: 3, EF: 7, LS: 3, LF: 7, slack: 0 },
      C: { duration: 5, ES: 7, EF: 12, LS: 7, LF: 12, slack: 0 },
      D: { duration: 4, ES: 7, EF: 11, LS: 8, LF: 12, slack: 1 },
      E: { duration: 2.5, ES: 12, EF: 14.5, LS: 12, LF: 14.5, slack: 0 }
    };
    for (const [id, want] of Object.entries(expected)) {
      const got = result.metrics[id];
      for (const key of Object.keys(want)) {
        assert.equal(got[key], want[key], `${mode} ${id}.${key}`);
      }
    }
  }
});

test('estimation modes use the documented formulas', () => {
  const n = { min: 2, likely: 3, max: 10 };
  assert.equal(baseDuration(n, 'average'), 6);              // (2 + 10) / 2
  assert.equal(baseDuration(n, 'pert'), (2 + 12 + 10) / 6); // (O + 4M + P) / 6
  // A missing most-likely falls back to the midpoint, making PERT equal average.
  assert.equal(baseDuration({ min: 2, max: 10 }, 'pert'), 6);
});

// ─── Precedence relations ──────────────────────────────────

test('finish-to-start is the default relation', () => {
  const r = schedule([task('A', 4, 4), task('B', 2, 2, ['A'])]);
  assert.equal(r.metrics.B.ES, 4);
  assert.equal(r.projectDuration, 6);
});

test('start-to-start lets the successor overlap', () => {
  const r = schedule([
    task('A', 10, 10),
    task('B', 4, 4, [{ id: 'A', type: 'SS', lag: 2 }])
  ]);
  assert.equal(r.metrics.B.ES, 2, 'starts 2 days after A starts');
  assert.equal(r.projectDuration, 10, 'B finishes inside A');
});

test('finish-to-finish aligns the finishes', () => {
  const r = schedule([
    task('A', 10, 10),
    task('B', 4, 4, [{ id: 'A', type: 'FF', lag: 0 }])
  ]);
  assert.equal(r.metrics.B.EF, 10);
  assert.equal(r.metrics.B.ES, 6, 'derived by subtracting its own duration');
});

test('start-to-finish constrains the successor finish', () => {
  const r = schedule([
    task('A', 10, 10),
    task('B', 3, 3, [{ id: 'A', type: 'SF', lag: 5 }])
  ]);
  assert.equal(r.metrics.B.EF, 5);
  assert.equal(r.metrics.B.ES, 2);
});

test('positive lag delays and negative lag overlaps', () => {
  const delayed = schedule([task('A', 4, 4), task('B', 2, 2, [{ id: 'A', type: 'FS', lag: 3 }])]);
  assert.equal(delayed.metrics.B.ES, 7);
  assert.equal(delayed.projectDuration, 9);

  const lead = schedule([task('A', 4, 4), task('B', 2, 2, [{ id: 'A', type: 'FS', lag: -2 }])]);
  assert.equal(lead.metrics.B.ES, 2, 'a lead pulls the successor earlier');
  assert.equal(lead.projectDuration, 4);
});

test('a lead cannot pull the schedule before day zero', () => {
  const r = schedule([task('A', 2, 2), task('B', 2, 2, [{ id: 'A', type: 'SS', lag: -50 }])]);
  assert.equal(r.metrics.B.ES, 0);
});

test('backward pass respects the relation type', () => {
  // B is tied to A's finish, so A has no freedom despite the parallel path.
  const r = schedule([
    task('A', 5, 5),
    task('B', 5, 5, [{ id: 'A', type: 'FF', lag: 0 }]),
    task('C', 2, 2, [{ id: 'B', type: 'FS', lag: 0 }])
  ]);
  assert.equal(r.projectDuration, 7);
  assert.equal(r.metrics.A.slack, 0);
  assert.equal(r.metrics.B.slack, 0);
});

test('slack identifies the non-critical path', () => {
  const r = schedule([
    task('A', 2, 2),
    task('B', 6, 6, ['A']),
    task('C', 2, 2, ['A']),
    task('D', 1, 1, ['B', 'C'])
  ]);
  assert.equal(r.projectDuration, 9);
  assert.equal(r.metrics.C.slack, 4);
  assert.deepEqual([...r.criticalIds].sort(), ['A', 'B', 'D']);
});

// ─── Legacy format migration ───────────────────────────────

test('bare predecessor ids migrate to finish-to-start with no lag', () => {
  assert.deepEqual(toDependency('A'), { id: 'A', type: 'FS', lag: 0 });
  assert.deepEqual(toDependency({ id: 'B', type: 'SS', lag: 3 }), { id: 'B', type: 'SS', lag: 3 });
  // Unknown relations degrade to the safe default rather than breaking maths.
  assert.deepEqual(toDependency({ id: 'C', type: 'XX' }), { id: 'C', type: 'FS', lag: 0 });
  assert.deepEqual(toDependency({ id: 'D', lag: 'abc' }), { id: 'D', type: 'FS', lag: 0 });
});

test('a legacy project file schedules identically after migration', () => {
  const legacy = normalizeState({
    diagrams: {
      main: {
        milestones: [{
          id: 'm', title: 'M', nodes: [
            { id: 'A', min: 2, max: 4, dependencies: [] },
            { id: 'B', min: 3, max: 5, dependencies: ['A'] }
          ]
        }]
      }
    }
  });
  const deps = nodesOf(legacy.diagrams.main)[1].dependencies;
  assert.deepEqual(deps, [{ id: 'A', type: 'FS', lag: 0 }]);
  assert.equal(schedule(nodesOf(legacy.diagrams.main)).projectDuration, 7);
});

test('import repairs malformed projects', () => {
  const repaired = normalizeState({
    diagrams: {
      main: {
        milestones: [{
          id: 'm', title: 'M', nodes: [
            // duplicate id, inverted range, out-of-range likely and progress,
            // self-dependency, and a dependency on a task that does not exist
            { id: 'A', min: 5, max: 2, likely: 99, progress: 900, dependencies: ['A', 'ghost'] },
            { id: 'A', min: 1, max: 2, dependencies: [] }
          ]
        }]
      }
    }
  });
  const nodes = nodesOf(repaired.diagrams.main);
  assert.equal(nodes.length, 2);
  assert.notEqual(nodes[0].id, nodes[1].id, 'duplicate ids are made unique');
  assert.ok(nodes[0].max >= nodes[0].min, 'range is corrected');
  assert.ok(nodes[0].likely >= nodes[0].min && nodes[0].likely <= nodes[0].max);
  assert.equal(nodes[0].progress, 100, 'progress is clamped');
  assert.deepEqual(nodes[0].dependencies, [], 'self and dangling links dropped');
});

test('normalize rejects a file with no main diagram', () => {
  assert.throws(() => normalizeState({}), /diagrams\.main/);
  assert.throws(() => normalizeState(null), /object/);
});

// ─── Cycles ────────────────────────────────────────────────

test('cycles are reported by name rather than failing silently', () => {
  const nodes = [
    task('X', 1, 1, ['Z']), task('Y', 1, 1, ['X']),
    task('Z', 1, 1, ['Y']), task('W', 1, 1)
  ];
  const graph = compileGraph(nodes);
  assert.deepEqual(graph.cycleIds.sort(), ['X', 'Y', 'Z']);
  assert.deepEqual(graph.order, ['W']);

  const r = schedule(nodes);
  assert.equal(r.projectDuration, 0);
  assert.equal(r.criticalIds.size, 0);
  assert.deepEqual(r.cycleIds.sort(), ['X', 'Y', 'Z']);
});

test('cycle detection catches indirect loops', () => {
  const nodes = [task('A', 1, 1), task('B', 1, 1, ['A']), task('C', 1, 1, ['B'])];
  assert.equal(wouldCreateCycle('C', 'A', nodes), true, 'C → A closes the loop');
  assert.equal(wouldCreateCycle('A', 'C', nodes), false, 'A → C is already implied');
});

test('trace collects ancestors and descendants', () => {
  const nodes = [
    task('A', 1, 1), task('B', 1, 1, ['A']), task('C', 1, 1, ['B']),
    task('X', 1, 1), task('Y', 1, 1, ['X'])
  ];
  assert.deepEqual([...traceFrom('B', nodes)].sort(), ['A', 'B', 'C']);
  assert.deepEqual(predecessorIds(nodes[1]), ['A']);
});

// ─── Sub-path roll-up ──────────────────────────────────────

test('sibling tasks linking the same sub-page both roll up', () => {
  const state = normalizeState({
    diagrams: {
      main: {
        milestones: [{
          id: 'm', title: 'M', nodes: [
            task('P', 1, 1, [], { linkedSubPage: 'sub_1' }),
            task('Q', 1, 1, [], { linkedSubPage: 'sub_1' })
          ]
        }]
      },
      sub_1: {
        milestones: [{
          id: 's', title: 'S', nodes: [task('S1', 10, 10), task('S2', 10, 10, ['S1'])]
        }]
      }
    }
  });
  const r = computeCPM(nodesOf(state.diagrams.main), {
    mode: 'average',
    rollup: createRollup(state.diagrams, 'average')
  });
  assert.equal(r.metrics.P.duration, 20);
  assert.equal(r.metrics.Q.duration, 20, 'the second sibling must not lose the roll-up');
});

test('pages linking each other terminate instead of recursing', () => {
  const state = normalizeState({
    diagrams: {
      main: { milestones: [{ id: 'm', title: 'm', nodes: [task('A', 1, 1, [], { linkedSubPage: 'sub_1' })] }] },
      sub_1: { milestones: [{ id: 'm', title: 'm', nodes: [task('B', 2, 2, [], { linkedSubPage: 'sub_2' })] }] },
      sub_2: { milestones: [{ id: 'm', title: 'm', nodes: [task('C', 3, 3, [], { linkedSubPage: 'sub_1' })] }] }
    }
  });
  const r = computeCPM(nodesOf(state.diagrams.main), {
    mode: 'average',
    rollup: createRollup(state.diagrams, 'average')
  });
  assert.equal(r.projectDuration, 3);
});

test('an empty sub-page leaves the local estimate alone', () => {
  const state = normalizeState({
    diagrams: {
      main: { milestones: [{ id: 'm', title: 'm', nodes: [task('A', 4, 4, [], { linkedSubPage: 'sub_1' })] }] },
      sub_1: { milestones: [] }
    }
  });
  const r = computeCPM(nodesOf(state.diagrams.main), {
    mode: 'average',
    rollup: createRollup(state.diagrams, 'average')
  });
  assert.equal(r.metrics.A.duration, 4);
});

// ─── Progress roll-up ──────────────────────────────────────

test('sub-page progress is weighted by duration, not by task count', () => {
  const state = normalizeState({
    diagrams: {
      main: { milestones: [] },
      sub_1: {
        milestones: [{
          id: 's', title: 'S', nodes: [
            task('S1', 10, 10, [], { progress: 100 }),
            task('S2', 2, 2, [], { progress: 0 })
          ]
        }]
      }
    }
  });
  const progressOf = createProgressRollup(state.diagrams, 'average');
  // A plain mean would say 50%. Ten of the twelve days are done.
  assert.equal(progressOf('sub_1'), (10 * 100) / 12);
});

test('progress recurses through nested sub-pages', () => {
  const state = normalizeState({
    diagrams: {
      main: { milestones: [{ id: 'm', title: 'm', nodes: [task('A', 1, 1, [], { linkedSubPage: 'sub_1' })] }] },
      sub_1: {
        milestones: [{
          id: 's', title: 'S', nodes: [
            // Its own progress says 0, but the page it stands in for is half done.
            task('B', 1, 1, [], { progress: 0, linkedSubPage: 'sub_2' })
          ]
        }]
      },
      sub_2: {
        milestones: [{
          id: 's', title: 'S', nodes: [
            task('C', 4, 4, [], { progress: 100 }),
            task('D', 4, 4, [], { progress: 0 })
          ]
        }]
      }
    }
  });
  const progressOf = createProgressRollup(state.diagrams, 'average');
  assert.equal(progressOf('sub_2'), 50);
  assert.equal(progressOf('sub_1'), 50, 'B reports its sub-page rather than its own 0%');
});

test('an empty page reports no progress rather than zero progress', () => {
  const state = normalizeState({
    diagrams: { main: { milestones: [] }, sub_1: { milestones: [] } }
  });
  assert.equal(createProgressRollup(state.diagrams, 'average')('sub_1'), null);
  assert.equal(createProgressRollup(state.diagrams, 'average')('nope'), null);
});

test('progress roll-up terminates on a link cycle', () => {
  const state = normalizeState({
    diagrams: {
      main: { milestones: [] },
      sub_1: { milestones: [{ id: 'm', title: 'm', nodes: [task('B', 2, 2, [], { progress: 40, linkedSubPage: 'sub_2' })] }] },
      sub_2: { milestones: [{ id: 'm', title: 'm', nodes: [task('C', 2, 2, [], { progress: 60, linkedSubPage: 'sub_1' })] }] }
    }
  });
  const progressOf = createProgressRollup(state.diagrams, 'average');
  // The cycle resolves to the task's own figure rather than recursing forever.
  assert.equal(progressOf('sub_1'), 60);
});

test('zero-duration tasks still count towards progress', () => {
  const state = normalizeState({
    diagrams: {
      main: { milestones: [] },
      sub_1: {
        milestones: [{
          id: 's', title: 'S', nodes: [
            task('M1', 0, 0, [], { progress: 100 }),
            task('M2', 0, 0, [], { progress: 0 })
          ]
        }]
      }
    }
  });
  assert.equal(createProgressRollup(state.diagrams, 'average')('sub_1'), 50);
});

// ─── Layout ────────────────────────────────────────────────

const layoutOf = (nodes, options = {}) => {
  const graph = compileGraph(nodes);
  const result = computeCPM(nodes, { mode: 'average', graph });
  return computeCpmLayout(nodes, { ...result, graph }, options);
};

test('auto-layout ranks tasks by longest path', () => {
  // D depends on both A (rank 0) and C (rank 2), so it must sit past C.
  const nodes = [
    task('A', 1, 1), task('B', 1, 1, ['A']), task('C', 1, 1, ['B']),
    task('D', 1, 1, ['A', 'C'])
  ];
  const { ranks } = layoutOf(nodes);
  assert.equal(ranks.get('A'), 0);
  assert.equal(ranks.get('B'), 1);
  assert.equal(ranks.get('C'), 2);
  assert.equal(ranks.get('D'), 3, 'the longest path decides, not the first one found');
});

test('auto-layout draws the critical path as a straight line', () => {
  const nodes = [
    task('A', 4, 4), task('B', 4, 4, ['A']), task('C', 4, 4, ['B']),
    task('S', 1, 1, ['A']), task('T', 1, 1, ['A'])
  ];
  const { positions } = layoutOf(nodes);
  ['A', 'B', 'C'].forEach(id => {
    assert.equal(positions[id].y, 0, `${id} is critical and belongs on the centre line`);
  });
  assert.notEqual(positions.S.y, 0, 'the slack tasks move off it');
});

test('auto-layout spaces columns by how wide the tasks actually are', () => {
  const nodes = [task('A', 1, 1), task('B', 1, 1, ['A'])];
  const narrow = layoutOf(nodes, { sizeOf: () => ({ width: 60, height: 60 }) });
  const wide = layoutOf(nodes, { sizeOf: () => ({ width: 400, height: 60 }) });
  assert.ok(
    wide.positions.B.x > narrow.positions.B.x + 300,
    'wider tasks must not be laid out on the pitch of narrow ones'
  );
});

test('auto-layout leaves no two tasks on top of each other', () => {
  const nodes = [
    task('A', 1, 1),
    ...['P', 'Q', 'R', 'S'].map(id => task(id, 1, 1, ['A'])),
    task('Z', 1, 1, ['P', 'Q', 'R', 'S'])
  ];
  const size = { width: 100, height: 100 };
  const { positions } = layoutOf(nodes, { sizeOf: () => size });
  const points = Object.values(positions);
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const apart = Math.abs(points[i].x - points[j].x) >= size.width ||
        Math.abs(points[i].y - points[j].y) >= size.height;
      assert.ok(apart, `tasks overlap at ${JSON.stringify(points[i])}`);
    }
  }
});

test('auto-layout is deterministic', () => {
  const build = () => [
    task('A', 1, 1), task('B', 2, 2, ['A']), task('C', 1, 1, ['A']),
    task('D', 1, 1, ['B', 'C']), task('E', 3, 3, ['C'])
  ];
  assert.deepEqual(layoutOf(build()).positions, layoutOf(build()).positions);
});

test('auto-layout copes with an empty diagram and with a cycle', () => {
  assert.deepEqual(computeCpmLayout([], {}).positions, {});
  const looped = [task('X', 1, 1, ['Y']), task('Y', 1, 1, ['X'])];
  const { positions } = layoutOf(looped);
  assert.equal(Object.keys(positions).length, 2, 'every task still gets a place');
});

// ─── Columns view ──────────────────────────────────────────

test('columns are ordered by earliest start, then float, then id', () => {
  const nodes = [task('A', 5, 5), task('B', 1, 1), task('C', 1, 1)];
  const { metrics } = computeCPM(nodes, { mode: 'average' });
  const milestone = { nodes: [nodes[0], nodes[1], nodes[2]] };
  metrics.A.ES = 0; metrics.B.ES = 3; metrics.C.ES = 1;
  assert.deepEqual(orderedNodes(milestone, metrics).map(n => n.id), ['A', 'C', 'B']);
  assert.deepEqual(milestone.nodes.map(n => n.id), ['A', 'B', 'C'], 'the stored order is untouched');
});

test('each milestone column is sized to its own widest task', () => {
  const milestones = [
    { id: 'm1', nodes: [task('A', 1, 1)] },
    { id: 'm2', nodes: [task('B', 1, 1)] }
  ];
  const sizeOf = id => ({ width: id === 'B' ? 500 : 80, height: 80 });
  const { columns, totalWidth } = columnGeometry(milestones, sizeOf);

  assert.ok(columns[1].width > columns[0].width, 'the column of wide tasks is wider');
  assert.ok(columns[0].centre < columns[1].centre, 'columns run left to right');
  assert.ok(columns[1].left >= columns[0].left + columns[0].width, 'and do not overlap');
  assert.equal(totalWidth, columns[0].width + columns[1].width);
});

test('a new task never lands on top of an existing one', () => {
  const taken = [{ x: 0, y: 0 }, { x: 130, y: 0 }, { x: 0, y: 130 }, { x: 130, y: 130 }];
  const spot = freeSpotNear(0, 0, taken, 130);
  const clashes = taken.some(p =>
    Math.abs(p.x - spot.x) < 130 && Math.abs(p.y - spot.y) < 130);
  assert.equal(clashes, false);
  assert.deepEqual(freeSpotNear(500, 500, taken, 130), { x: 500, y: 500 }, 'empty space is used as-is');
});

test('every column starts its rows at the same height', () => {
  const milestones = [
    { id: 'm1', nodes: [task('A', 1, 1), task('B', 1, 1), task('C', 1, 1)] },
    { id: 'm2', nodes: [task('D', 1, 1)] }
  ];
  const sizeOf = () => ({ width: 100, height: 100 });
  const rowHeight = columnRowHeight(milestones, sizeOf);
  const origin = columnRowOrigin(milestones, rowHeight);

  // The tallest column is centred, and the short one starts on the same row.
  assert.equal(origin, -rowHeight);
  assert.ok(rowHeight >= 100, 'rows clear the tallest task on the page');
});

// ─── Deadlines and negative float ──────────────────────────

test('a deadline the plan already meets changes nothing', () => {
  const nodes = [task('A', 4, 4), task('B', 2, 2, ['A'])];
  const loose = schedule(nodes, { deadline: 20 });
  const none = schedule(nodes);
  assert.equal(loose.projectDuration, 6);
  assert.equal(loose.metrics.A.slack, none.metrics.A.slack, 'no free float invented');
  assert.deepEqual([...loose.criticalIds].sort(), ['A', 'B']);
  assert.equal(loose.worstSlack, 0);
});

test('a deadline the plan misses drives float negative', () => {
  const nodes = [task('A', 4, 4), task('B', 2, 2, ['A'])];
  const r = schedule(nodes, { deadline: 4 });
  assert.equal(r.projectDuration, 6, 'the schedule itself is unchanged');
  assert.equal(r.metrics.B.LF, 4, 'the deadline pulls the latest finish back');
  assert.equal(r.metrics.B.slack, -2);
  assert.equal(r.metrics.A.slack, -2, 'and propagates up the path');
  assert.equal(r.worstSlack, -2, 'two days late');
  assert.deepEqual([...r.criticalIds].sort(), ['A', 'B'], 'late tasks are still critical');
});

test('a task can be due before its path requires', () => {
  const nodes = [
    task('A', 2, 2),
    task('B', 2, 2, ['A'], { mustFinishBy: 3 }),
    task('C', 6, 6, ['A'])
  ];
  const r = schedule(nodes);
  assert.equal(r.projectDuration, 8, 'C still sets the length');
  assert.equal(r.metrics.B.LF, 3, 'B answers to its own date, not to C');
  assert.equal(r.metrics.B.slack, -1);
  assert.equal(r.metrics.C.slack, 0, 'and does not drag C down with it');
});

test('an unset or malformed deadline is ignored', () => {
  const nodes = [task('A', 4, 4)];
  for (const deadline of [null, undefined, NaN, 'soon', -3]) {
    assert.equal(schedule(nodes, { deadline }).metrics.A.slack, 0, String(deadline));
  }
});

// ─── Free float ────────────────────────────────────────────
//
// Total float measures delay before the project moves; free float measures
// delay before a successor does. The pair only earns its keep where they
// disagree, so most of these check exactly that.

test('free float is spent by the first task in a slack chain, not the last', () => {
  // X is a long parallel path. A → B has six days of total float against it,
  // but A cannot use any without moving B.
  const nodes = [
    task('X', 10, 10), task('A', 2, 2), task('B', 2, 2, ['A']),
    task('E', 1, 1, ['B', 'X'])
  ];
  const r = schedule(nodes);
  assert.equal(r.metrics.A.slack, 6);
  assert.equal(r.metrics.A.freeFloat, 0, 'A delays B immediately');
  assert.equal(r.metrics.B.slack, 6);
  assert.equal(r.metrics.B.freeFloat, 6, 'B absorbs the whole chain');
});

test('a lone slack branch has free float equal to its total float', () => {
  const nodes = [
    task('A', 2, 2), task('B', 2, 2, ['A']), task('C', 6, 6, ['A']),
    task('D', 1, 1, ['B', 'C'])
  ];
  const r = schedule(nodes);
  assert.equal(r.metrics.B.slack, 4);
  assert.equal(r.metrics.B.freeFloat, 4);
});

test('free float never exceeds total float', () => {
  const nodes = [
    task('A', 3, 3), task('B', 2, 2, ['A']), task('C', 5, 5, ['A']),
    task('D', 1, 1, ['B']), task('E', 2, 2, ['C', 'D']), task('F', 4, 4, ['A']),
    task('G', 1, 1, ['E', 'F'])
  ];
  const r = schedule(nodes);
  for (const m of Object.values(r.metrics)) {
    assert.ok(m.freeFloat <= m.slack + 1e-9, `${m.id}: free ${m.freeFloat} > total ${m.slack}`);
  }
});

test('free float reads through every relation type', () => {
  for (const type of ['FS', 'SS', 'FF', 'SF']) {
    // P holds A off day zero. Without it, SF would compute a start before the
    // project origin, the clamp would hold B at day zero instead, and A would
    // be reported with float the relation has nothing to do with.
    const nodes = [
      task('P', 5, 5),
      task('A', 2, 2, ['P']),
      task('B', 2, 2, [], { dependencies: [{ id: 'A', type, lag: 0 }] }),
      task('X', 20, 20)
    ];
    const r = schedule(nodes);
    // Whatever the relation demands, B sits exactly where it demands, so A has
    // no room to move before B does.
    assert.equal(r.metrics.A.freeFloat, 0, type);
  }
});

test('a terminal task takes its free float from the project finish', () => {
  const nodes = [task('A', 10, 10), task('B', 4, 4)];
  assert.equal(schedule(nodes).metrics.B.freeFloat, 6, 'B runs into the finish');
  assert.equal(schedule(nodes).metrics.A.freeFloat, 0, 'A sets it');

  // A deadline the plan misses pulls the finish in, and a terminal task's free
  // float goes negative with its total float rather than staying stubbornly
  // positive. B is not the late one here — it lands on day 4 against a day-8
  // demand and keeps its slack. A is.
  const tight = schedule(nodes, { deadline: 8 });
  assert.equal(tight.metrics.A.freeFloat, -2, 'two days past what is allowed');
  assert.equal(tight.metrics.A.slack, -2, 'and it agrees with total float');
  assert.equal(tight.metrics.B.freeFloat, 4, 'the short branch is still fine');
});

// ─── Start constraints ─────────────────────────────────────

test('start-no-earlier-than delays a task and its successors', () => {
  const nodes = [
    task('A', 2, 2), task('B', 2, 2, ['A'], { startNoEarlierThan: 5 }),
    task('C', 1, 1, ['B'])
  ];
  const r = schedule(nodes);
  assert.equal(r.metrics.B.ES, 5, 'held back past what the logic allows');
  assert.equal(r.metrics.C.ES, 7, 'and the delay carries downstream');
  assert.equal(r.projectDuration, 8);
});

test('a start constraint earlier than the logic allows changes nothing', () => {
  const nodes = [task('A', 2, 2), task('B', 2, 2, ['A'], { startNoEarlierThan: 1 })];
  const constrained = schedule(nodes).metrics.B;
  const plain = schedule([task('A', 2, 2), task('B', 2, 2, ['A'])]).metrics.B;
  assert.equal(constrained.ES, 2, 'a floor, never a ceiling');
  for (const key of ['ES', 'EF', 'LS', 'LF', 'slack', 'freeFloat']) {
    assert.equal(constrained[key], plain[key], key);
  }
});

test('a start constraint hands float to the path feeding it', () => {
  const nodes = [
    task('A', 2, 2), task('B', 4, 4, ['A'], { startNoEarlierThan: 6 })
  ];
  const r = schedule(nodes);
  assert.equal(r.metrics.A.slack, 4, 'A can drift up to the constraint');
  assert.equal(r.metrics.A.freeFloat, 4);
  assert.equal(r.metrics.B.slack, 0);
});

test('a start constraint against a due date yields negative float, not an error', () => {
  const nodes = [
    task('A', 4, 4, [], { startNoEarlierThan: 5, mustFinishBy: 6 })
  ];
  const r = schedule(nodes);
  assert.equal(r.metrics.A.ES, 5);
  assert.equal(r.metrics.A.EF, 9);
  assert.equal(r.metrics.A.slack, -3, 'three days of it cannot be met');
});

test('an unset or malformed start constraint is ignored', () => {
  for (const value of [null, undefined, NaN, 'monday', -3]) {
    const r = schedule([task('A', 2, 2), task('B', 2, 2, ['A'], { startNoEarlierThan: value })]);
    assert.equal(r.metrics.B.ES, 2, String(value));
  }
});

test('normalize fills in the start constraint and drops junk', () => {
  const data = normalizeState({
    diagrams: {
      main: {
        milestones: [{
          id: 'm', title: 'M', nodes: [
            { id: 'A', min: 1, max: 1 },
            { id: 'B', min: 1, max: 1, startNoEarlierThan: 4 },
            { id: 'C', min: 1, max: 1, startNoEarlierThan: 'soon' }
          ]
        }]
      }
    }
  });
  const [a, b, c] = data.diagrams.main.milestones[0].nodes;
  assert.equal(a.startNoEarlierThan, null, 'absent becomes null, not zero');
  assert.equal(b.startNoEarlierThan, 4);
  assert.equal(c.startNoEarlierThan, null);
});

// ─── Data date: progress drives the schedule ───────────────
//
// Without a data date, progress is a decoration and these all reduce to the
// planned schedule — which the baseline lock above depends on.

const paced = (id, d, progress, deps = []) =>
  task(id, d, d, deps, { progress });

test('no data date leaves progress out of the schedule entirely', () => {
  const nodes = [paced('A', 10, 50), paced('B', 5, 0, ['A'])];
  const r = schedule(nodes);
  assert.equal(r.metrics.A.EF, 10, 'half-done or not, the plan is the plan');
  assert.equal(r.projectDuration, 15);
  assert.equal(r.dataDate, null);
});

test('unstarted work cannot begin in the past', () => {
  const nodes = [paced('A', 10, 0), paced('B', 5, 0, ['A'])];
  const r = schedule(nodes, { dataDate: 5 });
  assert.equal(r.metrics.A.ES, 5, 'pushed to the reporting date');
  assert.equal(r.metrics.B.ES, 15);
  assert.equal(r.projectDuration, 20);
});

test('work in progress is scheduled from what is left of it', () => {
  const nodes = [paced('A', 10, 50), paced('B', 5, 0, ['A'])];
  const r = schedule(nodes, { dataDate: 5 });
  assert.equal(r.metrics.A.EF, 10, 'five days in, five days left');
  assert.equal(r.metrics.A.remaining, 5);
  assert.equal(r.projectDuration, 15, 'exactly on plan');
});

test('a task that has not kept pace pushes the forecast out', () => {
  const nodes = [paced('A', 10, 50), paced('B', 5, 0, ['A'])];
  // Eight days in and still only half done: the five days left now run from
  // day eight, and the whole project slips by three.
  const r = schedule(nodes, { dataDate: 8 });
  assert.equal(r.metrics.A.EF, 13);
  assert.equal(r.projectDuration, 18);
  assert.equal(schedule(nodes).projectDuration, 15, 'against a plan of fifteen');
});

test('finished work stops at the reporting date and stops dragging successors', () => {
  const nodes = [paced('A', 10, 100), paced('B', 5, 0, ['A'])];
  const r = schedule(nodes, { dataDate: 3 });
  assert.equal(r.metrics.A.EF, 3, 'done is done, whatever was planned');
  assert.equal(r.metrics.A.remaining, 0);
  assert.equal(r.metrics.B.ES, 3, 'B is free to start now');
  assert.equal(r.projectDuration, 8);
});

test('progress ahead of the logic is scheduled and flagged, not thrown', () => {
  // B reports 40% while A, which must precede it, has not started.
  const nodes = [paced('A', 10, 0), paced('B', 5, 40, ['A'])];
  const r = schedule(nodes, { dataDate: 2 });
  assert.deepEqual(r.outOfSequenceIds, ['B']);
  assert.equal(r.metrics.B.EF, 5, 'three of its five days remain');
  assert.equal(r.projectDuration, 12, 'A still governs the finish');
  assert.deepEqual(schedule(nodes, { dataDate: null }).outOfSequenceIds, [],
    'and nothing is flagged when nothing is being reported');
});

test('a linked sub-page lends its progress to the task standing in for it', () => {
  const diagrams = {
    main: {
      milestones: [{
        id: 'm', title: 'M', nodes: [
          { id: 'P', title: 'P', min: 0, max: 0, progress: 0, dependencies: [], linkedSubPage: 'sub' }
        ]
      }]
    },
    sub: {
      milestones: [{
        id: 's', title: 'S', nodes: [
          { id: 'X', title: 'X', min: 10, max: 10, progress: 100, dependencies: [] }
        ]
      }]
    }
  };
  const rollup = createRollup(diagrams, 'average');
  const progressRollup = createProgressRollup(diagrams, 'average');
  const nodes = nodesOf(diagrams.main);

  // P's own slider says nothing is done; the page it stands for says all of it
  // is. The page wins, so P is complete and clamps to the reporting date.
  const r = computeCPM(nodes, { mode: 'average', rollup, progressRollup, dataDate: 4 });
  assert.equal(r.metrics.P.duration, 10, 'duration still rolls up');
  assert.equal(r.metrics.P.EF, 4);
  assert.equal(r.metrics.P.remaining, 0);

  // Without the resolver it falls back to the stored value and is unstarted.
  const naive = computeCPM(nodes, { mode: 'average', rollup, dataDate: 4 });
  assert.equal(naive.metrics.P.EF, 14);
});

test('the indexed scheduler agrees with computeCPM under a data date', () => {
  const nodes = [
    paced('A', 10, 50), paced('B', 5, 0, ['A']), paced('C', 4, 100),
    paced('D', 3, 25, ['C']), paced('E', 2, 0, ['B', 'D'])
  ];
  const graph = compileGraph(nodes);
  const indexed = indexGraph(graph);
  const durations = new Float64Array(indexed.ids.map(
    id => nodes.find(n => n.id === id).min
  ));
  const progress = new Float64Array(indexed.ids.map(
    id => nodes.find(n => n.id === id).progress
  ));

  for (const dataDate of [0, 3, 7, 12]) {
    const sampled = scheduleSample(indexed, durations, null, { dataDate, progress });
    const exact = schedule(nodes, { dataDate, graph });
    assert.ok(Math.abs(sampled - exact.projectDuration) < 1e-9,
      `data date ${dataDate}: ${sampled} vs ${exact.projectDuration}`);
  }
});

test('the indexed scheduler honours start constraints too', () => {
  const nodes = [task('A', 2, 2), task('B', 2, 2, ['A'], { startNoEarlierThan: 6 })];
  const graph = compileGraph(nodes);
  const indexed = indexGraph(graph);
  const durations = new Float64Array([2, 2]);
  const notBefore = new Float64Array(indexed.ids.map(
    id => nodes.find(n => n.id === id).startNoEarlierThan || 0
  ));
  assert.equal(scheduleSample(indexed, durations, null, { notBefore }), 8);
  assert.equal(schedule(nodes).projectDuration, 8, 'and agrees with computeCPM');
});

test('work already behind the data date is not reported as late', () => {
  // The forward pass schedules a started task from what is left of it, so the
  // backward pass has to measure that same shortened span. Measuring the full
  // planned duration instead demands a start that has already been and gone,
  // and hands negative float to everything feeding it.
  const nodes = [
    paced('A', 3, 100), paced('B', 4, 60, ['A']), paced('C', 5, 20, ['B']),
    paced('D', 4, 0, ['B']), paced('E', 2.5, 0, ['C', 'D'])
  ];
  const r = schedule(nodes, { dataDate: 5 });

  assert.ok(r.metrics.A.slack >= 0, `A float ${r.metrics.A.slack} — finished work is never late`);
  assert.ok(r.metrics.B.slack >= 0, `B float ${r.metrics.B.slack}`);
  assert.equal(r.worstSlack, 0, 'nothing in the plan is behind');
  assert.equal(r.projectDuration, 13.1);
  assert.deepEqual([...r.criticalIds].sort(), ['A', 'B', 'D', 'E'],
    'C has made enough progress to drop off the path');

  // LS is derived from the same span the forward pass used, so a task that has
  // started still reports a self-consistent pair of dates.
  for (const m of Object.values(r.metrics)) {
    assert.ok(m.LF - m.LS >= -1e-9, `${m.id}: LS after LF`);
    assert.ok(Math.abs((m.LF - m.LS) - (m.EF - m.ES)) < 1e-9, `${m.id}: spans disagree`);
  }
});

test('normalize fills in the data date and drops junk', () => {
  const base = () => ({ diagrams: { main: { milestones: [] } } });
  assert.equal(normalizeState(base()).dataDate, null, 'absent becomes null');
  assert.equal(normalizeState({ ...base(), dataDate: 6 }).dataDate, 6);
  assert.equal(normalizeState({ ...base(), dataDate: 'today' }).dataDate, null);
  assert.equal(normalizeState({ ...base(), dataDate: -2 }).dataDate, null);
});

// ─── Resources ─────────────────────────────────────────────

const loadOf = (nodes, options) => {
  const { metrics } = computeCPM(nodes, { mode: 'average' });
  return resourceLoad(nodes, metrics, options);
};

test('overlapping tasks on one person are flagged, sequential ones are not', () => {
  const sequential = loadOf([
    task('A', 4, 4, [], { assignee: 'Sam' }),
    task('B', 4, 4, ['A'], { assignee: 'Sam' })
  ]);
  assert.equal(sequential[0].peak, 1);
  assert.equal(sequential[0].overloadedDays, 0, 'B starts exactly as A ends');
  assert.equal(sequential[0].busyDays, 8);

  const parallel = loadOf([
    task('A', 4, 4, [], { assignee: 'Sam' }),
    task('B', 4, 4, [], { assignee: 'Sam' })
  ]);
  assert.equal(parallel[0].peak, 2);
  assert.equal(parallel[0].overloadedDays, 4);
});

test('capacity decides what counts as overloaded', () => {
  const nodes = ['A', 'B', 'C'].map(id => task(id, 5, 5, [], { assignee: 'Sam' }));
  assert.equal(loadOf(nodes, { capacity: 1 })[0].overloadedDays, 5);
  assert.equal(loadOf(nodes, { capacity: 2 })[0].overloadedDays, 5);
  assert.equal(loadOf(nodes, { capacity: 3 })[0].overloadedDays, 0);
});

test('load is split by person and the unassigned pool sorts last', () => {
  const load = loadOf([
    task('A', 4, 4, [], { assignee: 'Sam' }),
    task('B', 4, 4, [], { assignee: 'Ada' }),
    task('C', 4, 4, [], { assignee: 'Ada' }),
    task('D', 4, 4)
  ]);
  assert.deepEqual(load.map(r => r.name), ['Ada', 'Sam', '']);
  assert.equal(load[0].peak, 2, 'Ada has two at once');
  assert.equal(load[1].peak, 1);
});

test('adjacent segments reporting the same load are merged', () => {
  // Three tasks end at different times, but nobody is ever doubled up.
  const load = loadOf([
    task('A', 2, 2, [], { assignee: 'Sam' }),
    task('B', 3, 3, ['A'], { assignee: 'Sam' }),
    task('C', 1, 1, ['B'], { assignee: 'Sam' })
  ]);
  assert.equal(load[0].segments.length, 1, 'one unbroken run of work');
  assert.deepEqual(
    { from: load[0].segments[0].from, to: load[0].segments[0].to, count: load[0].segments[0].count },
    { from: 0, to: 6, count: 1 }
  );
});

test('zero-length milestones do not create phantom load', () => {
  const load = loadOf([task('M', 0, 0, [], { assignee: 'Sam' })]);
  assert.deepEqual(load[0].segments, []);
  assert.equal(load[0].busyDays, 0);
});

test('assignee names are collected across every page', () => {
  const state = normalizeState({
    diagrams: {
      main: { milestones: [{ id: 'm', title: 'm', nodes: [task('A', 1, 1, [], { assignee: 'Sam' })] }] },
      sub_1: { milestones: [{ id: 'm', title: 'm', nodes: [
        task('B', 1, 1, [], { assignee: 'Ada' }),
        task('C', 1, 1, [], { assignee: 'Sam' })
      ] }] }
    }
  });
  assert.deepEqual(assigneeNames(state.diagrams), ['Ada', 'Sam']);
});

// ─── Calendar ──────────────────────────────────────────────

test('working days skip weekends', () => {
  // 2026-04-13 is a Monday.
  const cal = createCalendar({ startDate: '2026-04-13', workdays: [1, 2, 3, 4, 5] });
  assert.equal(toISODate(cal.offsetToDate(0)), '2026-04-13', 'Mon');
  assert.equal(toISODate(cal.offsetToDate(4)), '2026-04-17', 'Fri');
  assert.equal(toISODate(cal.offsetToDate(5)), '2026-04-20', 'skips the weekend');
  assert.equal(toISODate(cal.offsetToDate(9)), '2026-04-24');
});

test('holidays are skipped', () => {
  const cal = createCalendar({
    startDate: '2026-04-13',
    workdays: [1, 2, 3, 4, 5],
    holidays: ['2026-04-15']
  });
  assert.equal(toISODate(cal.offsetToDate(1)), '2026-04-14');
  assert.equal(toISODate(cal.offsetToDate(2)), '2026-04-16', 'the 15th is a holiday');
});

test('a start on a non-working day rolls forward', () => {
  // 2026-04-18 is a Saturday.
  const cal = createCalendar({ startDate: '2026-04-18', workdays: [1, 2, 3, 4, 5] });
  assert.equal(toISODate(cal.offsetToDate(0)), '2026-04-20', 'begins Monday');
});

test('a seven-day calendar skips nothing', () => {
  const cal = createCalendar({ startDate: '2026-04-13', workdays: [0, 1, 2, 3, 4, 5, 6] });
  assert.equal(toISODate(cal.offsetToDate(5)), '2026-04-18');
});

test('finish date is the last day the task occupies', () => {
  const cal = createCalendar({ startDate: '2026-04-13', workdays: [1, 2, 3, 4, 5] });
  // A 5-day task starting Monday finishes Friday, not the following Monday.
  assert.equal(toISODate(cal.finishDate(0, 5)), '2026-04-17');
  // A zero-length milestone reports its own day.
  assert.equal(toISODate(cal.finishDate(0, 0)), '2026-04-13');
});

test('dates convert back to working-day offsets', () => {
  // 2026-04-13 is a Monday; the Wednesday is a holiday.
  const cal = createCalendar({
    startDate: '2026-04-13',
    workdays: [1, 2, 3, 4, 5],
    holidays: ['2026-04-15']
  });

  assert.equal(cal.dateToOffset('2026-04-13'), 0, 'the start date is offset zero');
  assert.equal(cal.dateToOffset('2026-04-14'), 1);
  assert.equal(cal.dateToOffset('2026-04-16'), 2, 'the holiday is not counted');
  assert.equal(cal.dateToOffset('2026-04-20'), 4, 'the weekend is not counted');

  // A deadline set on a non-working day means the end of the last working day
  // before it, which is what "by Saturday" means for a plan that stops on
  // Friday. The round trip lands there rather than on the date typed in.
  assert.equal(cal.dateToOffset('2026-04-18'), 3);
  assert.equal(toISODate(cal.offsetToDate(3)), '2026-04-17', 'Saturday reads back as the Friday');

  assert.equal(cal.dateToOffset('2026-01-01'), 0, 'before the project starts is day zero');
  assert.equal(cal.dateToOffset('not-a-date'), null);
  assert.equal(cal.dateToOffset(null), null);

  // Offsets survive a round trip on every ordinary working day.
  for (let offset = 0; offset < 30; offset++) {
    assert.equal(cal.dateToOffset(toISODate(cal.offsetToDate(offset))), offset, `offset ${offset}`);
  }
});

test('dates parse and format without timezone drift', () => {
  const d = parseISODate('2026-01-01');
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 0);
  assert.equal(d.getDate(), 1);
  assert.equal(toISODate(d), '2026-01-01');
  assert.equal(parseISODate('nonsense'), null);
});

// ─── Simulation primitives ─────────────────────────────────

test('triangular samples stay within bounds', () => {
  for (let i = 0; i < 2000; i++) {
    const v = sampleTriangular(2, 5, 9);
    assert.ok(v >= 2 && v <= 9, `sample ${v} out of range`);
  }
});

test('a most-likely outside the range does not produce NaN', () => {
  for (let i = 0; i < 500; i++) {
    assert.ok(Number.isFinite(sampleTriangular(2, 50, 9)), 'M above P');
    assert.ok(Number.isFinite(sampleTriangular(2, -50, 9)), 'M below O');
  }
  assert.equal(sampleTriangular(5, 5, 5), 5, 'a degenerate range is its own value');
});

test('percentiles interpolate', () => {
  const sorted = [1, 2, 3, 4, 5];
  assert.equal(percentile(sorted, 0), 1);
  assert.equal(percentile(sorted, 0.5), 3);
  assert.equal(percentile(sorted, 1), 5);
  assert.equal(percentile(sorted, 0.25), 2);
  assert.equal(percentile([], 0.5), 0);
});

test('histogram bins every sample exactly once', () => {
  const sorted = Array.from({ length: 500 }, (_, i) => i / 10);
  const { counts } = histogram(sorted, 24);
  assert.equal(counts.reduce((a, b) => a + b, 0), 500);
  assert.equal(counts.length, 24);
});

// ─── Indexed fast path ─────────────────────────────────────
//
// The simulation runs a typed-array version of the scheduler for speed. It has
// to agree with the readable one exactly, or the risk figures describe a
// different project from the one on screen.

test('the indexed scheduler agrees with computeCPM', () => {
  const nodes = [
    task('A', 2, 4),
    task('B', 3, 5, ['A']),
    task('C', 1, 3, [{ id: 'A', type: 'SS', lag: 1 }]),
    task('D', 2, 2, [{ id: 'B', type: 'FF', lag: 0 }, { id: 'C', type: 'FS', lag: 2 }]),
    task('E', 1, 1, [{ id: 'D', type: 'SF', lag: 4 }])
  ];

  const reference = schedule(nodes);
  const graph = compileGraph(nodes);
  const indexed = indexGraph(graph);

  const durations = new Float64Array(indexed.n);
  indexed.ids.forEach((id, i) => { durations[i] = reference.metrics[id].duration; });

  const critical = new Uint8Array(indexed.n);
  const total = scheduleSample(indexed, durations, critical);

  assert.equal(total, reference.projectDuration, 'project duration');
  indexed.ids.forEach((id, i) => {
    assert.ok(Math.abs(indexed.buffers.es[i] - reference.metrics[id].ES) < 1e-9, `${id} ES`);
    assert.ok(Math.abs(indexed.buffers.ef[i] - reference.metrics[id].EF) < 1e-9, `${id} EF`);
    assert.ok(Math.abs(indexed.buffers.ls[i] - reference.metrics[id].LS) < 1e-9, `${id} LS`);
    assert.ok(Math.abs(indexed.buffers.lf[i] - reference.metrics[id].LF) < 1e-9, `${id} LF`);
    assert.equal(!!critical[i], reference.criticalIds.has(id), `${id} critical`);
  });
});

test('the indexed scheduler reuses its buffers across runs', () => {
  const nodes = [task('A', 1, 1), task('B', 2, 2, ['A'])];
  const indexed = indexGraph(compileGraph(nodes));
  const durations = new Float64Array([1, 2]);
  const flags = new Uint8Array(indexed.n);

  assert.equal(scheduleSample(indexed, durations, flags), 3);
  durations[0] = 10;
  assert.equal(scheduleSample(indexed, durations, flags), 12, 'no state carried over');
});

// ─── Baseline ──────────────────────────────────────────────

test('baseline captures the schedule for later comparison', () => {
  const nodes = [task('A', 2, 2), task('B', 3, 3, ['A'])];
  const r = schedule(nodes);
  const baseline = captureBaseline(r.metrics, r.projectDuration);
  assert.equal(baseline.projectDuration, 5);
  assert.equal(baseline.tasks.B.ES, 2);
  assert.ok(baseline.capturedAt);
});
