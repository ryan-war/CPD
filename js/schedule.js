// One schedule per render pass.
//
// The previous build recomputed CPM separately in the canvas builder, the
// bottom panel, the Gantt, and again on every connect-mode highlight. Each of
// those also rebuilt the sub-path roll-up from scratch. Here the schedule is
// computed once, cached, and invalidated whenever state changes.

import { computeCPM, createRollup, compileGraph } from './cpm.js';
import { createCalendar } from './calendar.js';
import { getState, allNodes } from './state.js';

let cached = null;
let criticality = null;

/** Drop the cached schedule. Call after any mutation. */
export function invalidateSchedule() {
  cached = null;
}

/**
 * Criticality indices from the most recent simulation. Kept outside the
 * schedule cache because they survive re-renders but are cleared whenever the
 * project changes and the old percentages no longer describe it.
 */
export function setCriticality(map) {
  criticality = map;
}

export function getCriticality() {
  return criticality;
}

export function clearCriticality() {
  criticality = null;
}

/** Schedule for the active diagram, computed at most once per invalidation. */
export function schedule() {
  if (cached) return cached;
  const state = getState();
  const nodes = allNodes();
  const mode = state.estimationMode;
  const rollup = createRollup(state.diagrams, mode);
  const graph = compileGraph(nodes);
  const result = computeCPM(nodes, { mode, rollup, graph });
  const calendar = createCalendar(state.calendar);

  cached = {
    ...result,
    nodes,
    graph,
    rollup,
    mode,
    calendar,
    nearCritical: nearCriticalSet(result, state.nearCriticalDays),
    drift: baselineDrift(result, state.baseline)
  };
  return cached;
}

/**
 * Tasks that are not critical but have little float. Schedules slip through
 * these far more often than through the tasks already marked critical, and
 * nothing previously distinguished a task with half a day of slack from one
 * with three weeks.
 */
function nearCriticalSet(result, threshold) {
  const limit = Number(threshold);
  const ids = new Set();
  if (!Number.isFinite(limit) || limit <= 0) return ids;
  Object.values(result.metrics).forEach(m => {
    if (m.slack > 0 && m.slack <= limit) ids.add(m.id);
  });
  return ids;
}

/** Per-task change against the captured baseline, if there is one. */
function baselineDrift(result, baseline) {
  if (!baseline || !baseline.tasks) return null;
  const tasks = {};
  Object.values(result.metrics).forEach(m => {
    const base = baseline.tasks[m.id];
    if (!base) {
      tasks[m.id] = { isNew: true, start: 0, finish: 0, duration: 0 };
      return;
    }
    tasks[m.id] = {
      isNew: false,
      start: +(m.ES - base.ES).toFixed(4),
      finish: +(m.EF - base.EF).toFixed(4),
      duration: +(m.duration - base.duration).toFixed(4)
    };
  });
  return {
    capturedAt: baseline.capturedAt,
    projectDuration: +(result.projectDuration - baseline.projectDuration).toFixed(4),
    tasks
  };
}

/** Format a duration for display: whole numbers bare, otherwise one decimal. */
export function fmt(value) {
  if (value == null || Number.isNaN(value)) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** Signed variance, for baseline drift: "+2.5", "-1", "0". */
export function fmtDelta(value) {
  if (value == null || Number.isNaN(value)) return '—';
  if (value === 0) return '0';
  const text = Number.isInteger(value) ? String(Math.abs(value)) : Math.abs(value).toFixed(1);
  return (value > 0 ? '+' : '−') + text;
}
