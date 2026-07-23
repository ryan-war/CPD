// Who is doing the work, and when they are doing too much of it.
//
// The schedule said when tasks could run but never whether anyone was free to
// run them: three critical tasks could sit on the same person in the same week
// and the plan would report itself as perfectly feasible.
//
// Pure and DOM-free, like cpm.js — it takes computed metrics and gives back
// timelines.

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
