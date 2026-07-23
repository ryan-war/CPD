// Who is doing the work, and when they are doing too much of it.
//
// The schedule said when tasks could run but never whether anyone was free to
// run them: three critical tasks could sit on the same person in the same week
// and the plan would report itself as perfectly feasible.
//
// Pure and DOM-free, like cpm.js — it takes computed metrics and gives back
// timelines.

import { linkSlack } from './cpm.js';

/** Tasks with nobody named are pooled here rather than dropped. */
export const UNASSIGNED = '';

/**
 * Load per assignee over the life of the project.
 *
 * Works in half-open day intervals [ES, EF): a task finishing on day 4 and one
 * starting on day 4 do not overlap. Boundaries are taken from the tasks
 * themselves rather than a fixed grid, so a project measured in half-days is
 * as accurate as one measured in weeks.
 *
 * @param {object[]} nodes tasks, each optionally carrying `assignee`
 * @param {Object} metrics computed schedule, keyed by task id
 * @param {{capacity?: number}} options how many tasks one person can hold at once
 * @returns {{name: string, tasks: object[], segments: object[], peak: number,
 *   overloadedDays: number, busyDays: number}[]} one entry per assignee
 */
export function resourceLoad(nodes, metrics, { capacity = 1 } = {}) {
  const limit = Math.max(1, Number(capacity) || 1);
  const byName = new Map();

  nodes.forEach(node => {
    const m = metrics[node.id];
    if (!m) return;
    const name = String(node.assignee || UNASSIGNED);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push({
      id: node.id,
      title: node.title || node.id,
      start: Number(m.ES) || 0,
      end: Number(m.EF) || 0
    });
  });

  return [...byName.entries()]
    .map(([name, tasks]) => {
      const segments = loadSegments(tasks, limit);
      const peak = segments.reduce((max, s) => Math.max(max, s.count), 0);
      return {
        name,
        tasks: tasks.sort((a, b) => a.start - b.start || String(a.id).localeCompare(String(b.id))),
        segments,
        peak,
        busyDays: spanOf(segments, s => s.count > 0),
        overloadedDays: spanOf(segments, s => s.over)
      };
    })
    // Busiest first, but the unassigned pool always last: it is a to-do list,
    // not a person, and it should not head the chart.
    .sort((a, b) => {
      if ((a.name === UNASSIGNED) !== (b.name === UNASSIGNED)) return a.name === UNASSIGNED ? 1 : -1;
      return (b.peak - a.peak) || a.name.localeCompare(b.name);
    });
}

/**
 * Concurrency between every pair of adjacent task boundaries. Sampling on a
 * fixed grid would miss short overlaps and mis-time long ones; the boundaries
 * are the only points where the count can change.
 */
function loadSegments(tasks, limit) {
  const edges = [...new Set(tasks.flatMap(t => [t.start, t.end]))].sort((a, b) => a - b);
  const segments = [];

  for (let i = 0; i < edges.length - 1; i++) {
    const from = edges[i];
    const to = edges[i + 1];
    if (to <= from) continue;
    const running = tasks.filter(t => t.start < to && t.end > from);
    segments.push({
      from,
      to,
      count: running.length,
      over: running.length > limit,
      ids: running.map(t => t.id)
    });
  }

  // Merge neighbours that report the same thing, so a chart does not draw
  // twenty identical bars where one belongs.
  return segments.reduce((out, segment) => {
    const last = out[out.length - 1];
    if (last && last.to === segment.from && last.count === segment.count) {
      last.to = segment.to;
      return out;
    }
    out.push({ ...segment });
    return out;
  }, []);
}

function spanOf(segments, predicate) {
  return +segments.reduce((sum, s) => sum + (predicate(s) ? s.to - s.from : 0), 0).toFixed(4);
}

// ─── Levelling ─────────────────────────────────────────────

/**
 * A proposal for resolving over-allocation, expressed as a delay per task.
 *
 * `resourceLoad` above finds the stretches where someone is carrying more than
 * they can and stops there. The float needed to fix most of them is already
 * computed and sitting unused; this spends it.
 *
 * Serial resource-constrained scheduling with a minimum-float priority rule.
 * Tasks become eligible once their predecessors are placed, and the one with
 * least float goes first — delay the tight ones and the project moves, so they
 * get first claim on whoever is free. Ties break on earliest start and then on
 * id, because a proposal that changed between two identical runs would be
 * impossible to review.
 *
 * Delays rather than absolute dates, because a uniform shift satisfies all four
 * relation types alike: a task must absorb its predecessor's delay only to the
 * extent the link between them cannot. That keeps the proposal correct without
 * a second scheduling engine here to disagree with the first.
 *
 * Nothing is mutated. The caller decides whether to apply it.
 *
 * @param {object[]} nodes tasks, each optionally carrying `assignee`
 * @param {Object} metrics computed schedule, keyed by task id
 * @param {{capacity?: number, mode?: 'within-float'|'full'}} options
 *   `within-float` never delays a task past its own float, so the project end
 *   cannot move and some conflicts may survive; `full` resolves everything and
 *   reports what that cost.
 * @returns {{delays: Map<string, number>, constrained: string[],
 *   projectDuration: number, unresolved: string[], mode: string}}
 *   `delays` is every task that moves and by how much — the whole picture, for
 *   review. `constrained` is the subset the resource actually pushed, which is
 *   all a caller needs to write down.
 */
export function levelResources(nodes, metrics, { capacity = 1, mode = 'within-float' } = {}) {
  const limit = Math.max(1, Number(capacity) || 1);
  const byId = new Map(nodes.map(n => [n.id, n]));
  const spanOfTask = id => {
    const m = metrics[id];
    if (!m) return 0;
    return Math.max(0, m.span != null ? m.span : m.duration);
  };

  // Predecessors that exist here, and the slack in each of those links.
  const preds = new Map();
  const successorCount = new Map(nodes.map(n => [n.id, 0]));
  nodes.forEach(n => {
    const list = (n.dependencies || [])
      .map(entry => (entry && typeof entry === 'object' ? entry : { id: entry, type: 'FS', lag: 0 }))
      .filter(d => byId.has(String(d.id)) && String(d.id) !== n.id)
      .map(d => {
        const dep = { id: String(d.id), type: d.type || 'FS', lag: Number(d.lag) || 0, to: n.id };
        return { id: dep.id, slack: Math.max(0, linkSlack(dep, metrics)) };
      });
    preds.set(n.id, list);
    list.forEach(p => successorCount.set(p.id, (successorCount.get(p.id) || 0) + 1));
  });

  const placed = new Map();          // id → delay applied
  const busy = new Map();            // assignee → [{from, to}]
  const unresolved = [];
  // Tasks the resource itself pushed, as against those merely carried along by
  // a delayed predecessor. Only the former need writing down: the network
  // already moves the rest, and a constraint restating that would be redundant
  // now and wrong the moment the logic above it changes.
  const constrained = new Set();
  const remainingPreds = new Map(nodes.map(n => [n.id, preds.get(n.id).length]));

  const eligible = nodes.filter(n => remainingPreds.get(n.id) === 0).map(n => n.id);

  while (eligible.length) {
    eligible.sort((a, b) => {
      const ma = metrics[a] || {};
      const mb = metrics[b] || {};
      return (ma.slack - mb.slack) || (ma.ES - mb.ES) || String(a).localeCompare(String(b));
    });
    const id = eligible.shift();
    const node = byId.get(id);
    const m = metrics[id] || { ES: 0, slack: 0 };
    const span = spanOfTask(id);

    // A predecessor's delay only reaches this task through whatever the link
    // between them could not absorb.
    let inherited = 0;
    for (const p of preds.get(id)) {
      const passed = (placed.get(p.id) || 0) - p.slack;
      if (passed > inherited) inherited = passed;
    }

    const earliest = m.ES + inherited;
    const name = String(node.assignee || UNASSIGNED);
    // The unassigned pool is a to-do list, not a person: it is reported, never
    // levelled, exactly as it is never sorted among the people above.
    let start = name === UNASSIGNED || span <= 0
      ? earliest
      : nextFreeSlot(busy.get(name) || [], earliest, span, limit);

    if (mode === 'within-float') {
      const ceiling = m.ES + inherited + Math.max(0, m.slack - inherited);
      if (start > ceiling) {
        start = ceiling;
        unresolved.push(id);
      }
    }

    if (start > earliest + 1e-9) constrained.add(id);

    if (name !== UNASSIGNED && span > 0) {
      if (!busy.has(name)) busy.set(name, []);
      busy.get(name).push({ from: start, to: start + span });
    }
    placed.set(id, start - m.ES);

    preds.forEach((list, other) => {
      if (placed.has(other) || eligible.includes(other)) return;
      if (!list.some(p => p.id === id)) return;
      const left = remainingPreds.get(other) - 1;
      remainingPreds.set(other, left);
      if (left === 0) eligible.push(other);
    });
  }

  // A cycle would leave tasks unplaced; report them undelayed rather than
  // dropping them, so the caller's totals still add up.
  nodes.forEach(n => { if (!placed.has(n.id)) placed.set(n.id, 0); });

  let projectDuration = 0;
  nodes.forEach(n => {
    const m = metrics[n.id];
    if (!m) return;
    const finish = m.EF + (placed.get(n.id) || 0);
    if (finish > projectDuration) projectDuration = finish;
  });

  const delays = new Map();
  placed.forEach((delay, id) => {
    const rounded = +delay.toFixed(4);
    if (rounded > 0) delays.set(id, rounded);
  });

  return {
    delays,
    // The subset worth writing down; the network carries the others.
    constrained: [...constrained].filter(id => delays.has(id)).sort(),
    projectDuration: +projectDuration.toFixed(4),
    unresolved: [...new Set(unresolved)].sort(),
    mode
  };
}

/**
 * The earliest time at or after `from` where this person has room for a task of
 * `span`, given what they are already holding.
 *
 * Only the ends of existing commitments can open a slot, so those are the only
 * candidates worth testing — sampling a grid would both miss short gaps and
 * invent precision the schedule does not have.
 */
function nextFreeSlot(intervals, from, span, limit) {
  if (!intervals.length) return from;
  const candidates = [from, ...intervals.map(i => i.to).filter(t => t > from)]
    .sort((a, b) => a - b);

  for (const t of candidates) {
    if (fits(intervals, t, t + span, limit)) return t;
  }
  // Nothing opened up in between, so the last commitment clearing always does.
  return Math.max(from, ...intervals.map(i => i.to));
}

/** Does a task over [from, to) keep this person at or under capacity throughout? */
function fits(intervals, from, to, limit) {
  const edges = [from, ...intervals.map(i => i.from), ...intervals.map(i => i.to)]
    .filter(t => t >= from && t < to)
    .sort((a, b) => a - b);
  for (const t of edges) {
    // Half-open intervals: a task ending when another starts is not an overlap.
    const running = intervals.filter(i => i.from <= t && i.to > t).length;
    if (running + 1 > limit) return false;
  }
  return true;
}

/** Every assignee named anywhere in the project, for autocomplete. */
export function assigneeNames(diagrams) {
  const names = new Set();
  Object.values(diagrams || {}).forEach(diagram => {
    (diagram.milestones || []).forEach(ms => {
      (ms.nodes || []).forEach(n => {
        const name = String(n.assignee || '').trim();
        if (name) names.add(name);
      });
    });
  });
  return [...names].sort((a, b) => a.localeCompare(b));
}
