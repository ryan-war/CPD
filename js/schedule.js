// One schedule per render pass.
//
// The previous build recomputed CPM separately in the canvas builder, the
// bottom panel, the Gantt, and again on every connect-mode highlight. Each of
// those also rebuilt the sub-path roll-up from scratch. Here the schedule is
// computed once, cached, and invalidated whenever state changes.

import { computeCPM, createRollup, compileGraph } from './cpm.js';
import { getState, allNodes } from './state.js';

let cached = null;

/** Drop the cached schedule. Call after any mutation. */
export function invalidateSchedule() {
  cached = null;
}

/** Schedule for the active diagram, computed at most once per invalidation. */
export function schedule() {
  if (cached) return cached;
  const state = getState();
  const nodes = allNodes();
  const mode = state.estimationMode;
  const rollup = createRollup(state.diagrams, mode);
  const graph = compileGraph(nodes);
  cached = { ...computeCPM(nodes, { mode, rollup, graph }), nodes, graph, rollup, mode };
  return cached;
}

/** Format a duration for display: whole numbers bare, otherwise one decimal. */
export function fmt(value) {
  if (value == null || Number.isNaN(value)) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
