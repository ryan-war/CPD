// One schedule per render pass.
//
// The previous build recomputed CPM separately in the canvas builder, the
// bottom panel, the Gantt, and again on every connect-mode highlight. Each of
// those also rebuilt the sub-path roll-up from scratch. Here the schedule is
// computed once, cached, and invalidated whenever state changes.

import {
  computeCPM, createRollup, createProgressRollup, compileGraph, nodesOf
} from './cpm.js';
import { createCalendar } from './calendar.js';
import { getState, allNodes } from './state.js';

let cached = null;
let cachedMain = null;
let cachedRollups = null;
let criticality = null;

/** Drop the cached schedule. Call after any mutation. */
export function invalidateSchedule() {
  cached = null;
  cachedMain = null;
  cachedRollups = null;
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
 * The Main Diagram's schedule, whichever page is on screen. Sub-path figures
 * are all relative to Main — a branch is 30% of *the project*, not of itself —
 * so a sub-page needs Main costed even while Main is not being displayed.
 */
export function mainSchedule() {
  const state = getState();
  if (state.activeView === 'main') return schedule();
  if (cachedMain) return cachedMain;

  const nodes = nodesOf(state.diagrams.main);
  const mode = state.estimationMode;
  const rollup = createRollup(state.diagrams, mode);
  cachedMain = { ...computeCPM(nodes, { mode, rollup }), nodes };
  return cachedMain;
}

/**
 * What each linked sub-page is worth, as a share of the Main Diagram.
 *
 * A sub-path replacing a task's estimate told you nothing about its weight in
 * the project. These three figures do: how much of the total duration the
 * branch accounts for, how much of the critical path runs through it, and how
 * far through its own work it is.
 *
 * @returns {{byPage: Map<string, object>, byNode: Map<string, object>}}
 *   entries of `{pageId, mainNodeId, parents, duration, share, criticalShare,
 *   isCritical, progress}`
 */
export function subPathRollups() {
  if (cachedRollups) return cachedRollups;

  const state = getState();
  const { metrics, criticalIds, projectDuration, nodes } = mainSchedule();
  const progressOf = createProgressRollup(state.diagrams, state.estimationMode);
  const byPage = new Map();
  const byNode = new Map();

  nodes.forEach(node => {
    const pageId = node.linkedSubPage;
    if (!pageId || !state.diagrams[pageId]) return;
    // An empty sub-page rolls nothing up: the task is still costed from its own
    // estimate, so crediting the branch with a share of the project would be
    // reporting the task's own duration back as if it came from somewhere else.
    if (!nodesOf(state.diagrams[pageId]).length) return;

    const duration = Number(metrics[node.id]?.duration) || 0;
    const isCritical = criticalIds.has(node.id);
    const entry = {
      pageId,
      mainNodeId: node.id,
      mainTitle: node.title || node.id,
      parents: [node.id],
      duration,
      share: projectDuration > 0 ? duration / projectDuration : 0,
      // The critical path *is* the project duration, so a critical task's
      // share of one is its share of the other. Off the path it contributes
      // nothing to the length at all.
      criticalShare: isCritical && projectDuration > 0 ? duration / projectDuration : 0,
      isCritical,
      progress: progressOf(pageId)
    };
    byNode.set(node.id, entry);

    // A page can be linked from more than one Main task. The first one owns
    // it — for grouping, and for the share the tab is labelled with.
    if (byPage.has(pageId)) byPage.get(pageId).parents.push(node.id);
    else byPage.set(pageId, entry);
  });

  cachedRollups = { byPage, byNode };
  return cachedRollups;
}

/** The roll-up for one sub-page, or null when Main does not link it. */
export function rollupForPage(pageId) {
  return subPathRollups().byPage.get(pageId) || null;
}

/** What a Main task's linked sub-page contributes, or null if it has none. */
export function rollupForNode(node) {
  if (!node?.linkedSubPage) return null;
  return subPathRollups().byNode.get(node.id) || null;
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

/** A 0–1 ratio as a whole percentage: "34%". */
export function fmtPercent(ratio) {
  if (ratio == null || Number.isNaN(ratio)) return '—';
  return Math.round(ratio * 100) + '%';
}

/** Signed variance, for baseline drift: "+2.5", "-1", "0". */
export function fmtDelta(value) {
  if (value == null || Number.isNaN(value)) return '—';
  if (value === 0) return '0';
  const text = Number.isInteger(value) ? String(Math.abs(value)) : Math.abs(value).toFixed(1);
  return (value > 0 ? '+' : '−') + text;
}
