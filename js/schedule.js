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
import { resourceLoad } from './resources.js';
import { getState, allNodes } from './state.js';

let cached = null;
let cachedMain = null;
let cachedRollups = null;
let cachedChain = null;
let cachedLoad = null;
let criticality = null;

/** Drop the cached schedule. Call after any mutation. */
export function invalidateSchedule() {
  cached = null;
  cachedMain = null;
  cachedRollups = null;
  cachedChain = null;
  cachedLoad = null;
}

/**
 * Resource load for the active schedule, computed once per render.
 *
 * The Resources panel, the Health panel, and the levelling section each need
 * it, so the same over-allocation sweep ran up to three times per render off
 * the same nodes and metrics. Memoised on the capacity it was asked for, and
 * dropped with the rest of the cache on any mutation.
 */
export function resourceLoadFor(capacity) {
  if (cachedLoad && cachedLoad.capacity === capacity) return cachedLoad.load;
  const s = schedule();
  const load = resourceLoad(s.nodes, s.metrics, { capacity });
  cachedLoad = { capacity, load };
  return load;
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
  // Only the Main Diagram answers to the project deadline. A sub-path is a
  // component of it, not a project with a delivery date of its own.
  const deadline = state.activeView === 'main' ? state.deadline : null;
  // The data date, unlike the deadline, applies to every page. A sub-path has
  // no delivery date of its own, but it is reported as of the same moment as
  // everything else. The progress roll-up is only built when it will be read.
  const dataDate = state.dataDate;
  const progressRollup = dataDate != null
    ? createProgressRollup(state.diagrams, mode)
    : null;

  // A sub-path is a breakdown of a Main task; its work begins where that task
  // does, not at the project origin. `pageStart` is that Main task's earliest
  // start, so the page's schedule reads in project time. The reporting date is
  // framed into the page before scheduling — a data date before the page starts
  // means the page has not begun, so progress does not drive it yet.
  const pageStart = pageStartOffset(state);
  const localDataDate = dataDate == null ? null : dataDate - pageStart;
  // Hard date constraints on a sub-path task are stored in project time, like
  // every other figure the interface writes. Frame them into the page's own
  // window before scheduling so a "must finish by 15 May" binds on that date,
  // not fifteen days into the branch; the shift below puts the result back.
  const scheduleNodes = framedNodes(nodes, pageStart);
  const result = computeCPM(scheduleNodes, {
    mode, rollup, graph, deadline, dataDate: localDataDate, progressRollup
  });
  shiftSchedule(result.metrics, pageStart);
  const calendar = createCalendar(state.calendar);

  cached = {
    ...result,
    // The absolute reporting date, for positioning and date display; the framed
    // one above only steered the page's own scheduling.
    dataDate,
    pageStart,
    nodes,
    graph,
    rollup,
    progressRollup,
    mode,
    calendar,
    deadline,
    overrun: overrunAgainst(result, deadline),
    nearCritical: nearCriticalSet(result, state.nearCriticalDays),
    drift: baselineDrift(result, state.baseline)
  };
  return cached;
}

/**
 * Where the active page sits in project time. Zero for Main; for a sub-path,
 * the earliest start of the Main task that links it — so a branch of a task
 * that begins on day 12 is dated from day 12, not from the project origin.
 */
function pageStartOffset(state) {
  if (state.activeView === 'main') return 0;
  const parent = nodesOf(state.diagrams.main).find(n => n.linkedSubPage === state.activeView);
  if (!parent) return 0;
  const es = mainSchedule().metrics[parent.id]?.ES;
  return Number.isFinite(es) ? es : 0;
}

/** Shift a schedule's placements into project time, leaving spans and slack alone. */
function shiftSchedule(metrics, offset) {
  if (!offset) return;
  Object.values(metrics).forEach(m => {
    m.ES += offset; m.EF += offset; m.LS += offset; m.LF += offset;
  });
}

/**
 * Nodes with their hard date constraints framed into the page — each
 * project-time constraint reduced by the page's start so the engine, which
 * schedules the page from zero, applies it where the user meant. Only the
 * constrained nodes are cloned; the rest pass through untouched. A no-op for
 * Main and for any page whose parent starts on day zero.
 */
function framedNodes(nodes, offset) {
  if (!offset) return nodes;
  return nodes.map(n => (n.startNoEarlierThan == null && n.mustFinishBy == null)
    ? n
    : {
        ...n,
        startNoEarlierThan: n.startNoEarlierThan == null ? null : n.startNoEarlierThan - offset,
        mustFinishBy: n.mustFinishBy == null ? null : n.mustFinishBy - offset
      });
}

/**
 * Days by which the schedule misses its deadline, or null when there is no
 * deadline. Negative means it lands early — the slack the plan has in hand.
 */
function overrunAgainst(result, deadline) {
  if (deadline == null || !Number.isFinite(deadline)) return null;
  return +(result.projectDuration - deadline).toFixed(4);
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
  cachedMain = {
    ...computeCPM(nodes, { mode, rollup, deadline: state.deadline, dataDate: state.dataDate }),
    nodes
  };
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

/**
 * The critical path traced down through linked sub-pages.
 *
 * On its own page a sub-path task can be critical while the whole branch has
 * float in Main, and the diagram would still colour it red — telling you it
 * matters when it does not. A task drives the *project* only when its page's
 * parent task is itself critical, all the way up to Main. This walks that
 * chain and returns, per page, the tasks that genuinely do.
 *
 * @returns {Map<string, Set<string>>} page id → task ids critical to Main
 */
export function projectCriticalPath() {
  if (cachedChain) return cachedChain;

  const state = getState();
  const mode = state.estimationMode;
  const rollup = createRollup(state.diagrams, mode);
  const chain = new Map();
  const visited = new Set();

  const walk = (pageId, criticalIds) => {
    if (visited.has(pageId)) return; // link cycle
    visited.add(pageId);
    chain.set(pageId, criticalIds);

    nodesOf(state.diagrams[pageId] || {}).forEach(node => {
      const child = node.linkedSubPage;
      if (!child || !state.diagrams[child]) return;
      // A branch below a task with float cannot be driving the project, so
      // the whole sub-tree under it is left out rather than walked.
      if (!criticalIds.has(node.id)) return;
      const childNodes = nodesOf(state.diagrams[child]);
      if (!childNodes.length) return;
      walk(child, computeCPM(childNodes, { mode, rollup }).criticalIds);
    });
  };

  walk('main', mainSchedule().criticalIds);
  cachedChain = chain;
  return cachedChain;
}

/** Is this task on the critical path of the whole project, not just its page? */
export function isProjectCritical(pageId, nodeId) {
  return projectCriticalPath().get(pageId)?.has(nodeId) ?? false;
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
 * A task's status for display. A task standing in for a linked sub-page owns its
 * status no more than it owns its progress — both come from the page below it:
 * done when that page is complete, in progress when it is under way, not started
 * when it is untouched. Tasks with no sub-page keep the status they were given.
 * ("Blocked" cannot be inferred from completion, so a rolled-up task never
 * reads as blocked — the same trade the rolled-up progress already makes.)
 */
export function effectiveStatus(node) {
  const rollup = rollupForNode(node);
  if (rollup && rollup.progress != null) {
    const p = rollup.progress;
    return p >= 100 ? 'done' : p > 0 ? 'in_progress' : 'not_started';
  }
  return node.status || 'not_started';
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
