// Critical Path Method engine.
//
// Pure: no DOM, no module-level mutable state. Everything the schedule depends
// on — estimation mode, duration overrides, sub-path roll-up — arrives as an
// argument, which keeps the engine testable and lets Monte Carlo reuse it.

const EPSILON = 1e-9;

/** The four standard precedence relations. */
export const DEPENDENCY_TYPES = ['FS', 'SS', 'FF', 'SF'];

export const DEPENDENCY_LABELS = {
  FS: 'Finish → Start',
  SS: 'Start → Start',
  FF: 'Finish → Finish',
  SF: 'Start → Finish'
};

/**
 * Dependencies are stored as `{ id, type, lag }`, but older project files hold
 * a bare array of predecessor ids. Normalise either form.
 */
export function toDependency(entry) {
  if (entry && typeof entry === 'object') {
    const type = DEPENDENCY_TYPES.includes(entry.type) ? entry.type : 'FS';
    const lag = Number(entry.lag);
    return { id: String(entry.id), type, lag: Number.isFinite(lag) ? lag : 0 };
  }
  return { id: String(entry), type: 'FS', lag: 0 };
}

export function dependenciesOf(node) {
  return (node.dependencies || []).map(toDependency);
}

/** Predecessor ids only — for reachability and display. */
export function predecessorIds(node) {
  return dependenciesOf(node).map(d => d.id);
}

/** Tasks of a diagram, flattened across its milestones. */
export function nodesOf(diagram) {
  if (!diagram) return [];
  return (diagram.milestones || []).flatMap(ms => ms.nodes || []);
}

/**
 * Duration from a task's own estimates.
 * average: (O + P) / 2      pert: (O + 4M + P) / 6
 */
export function baseDuration(node, mode) {
  const o = Number(node.min) || 0;
  const p = Number(node.max) || 0;
  let m = node.likely != null ? Number(node.likely) : (o + p) / 2;
  if (Number.isNaN(m)) m = (o + p) / 2;
  if (mode === 'pert') return (o + 4 * m + p) / 6;
  return (o + p) / 2;
}

/**
 * Roll-up resolver: a task linked to a sub-page takes that page's own project
 * duration instead of its local estimate.
 *
 * Results are memoised per page. A page's duration does not depend on which
 * task asked for it, so caching is both a large saving on wide diagrams and the
 * fix for sibling tasks that link the same page. `visiting` guards against
 * pages that link back into each other.
 */
export function createRollup(diagrams, mode) {
  const cache = new Map();
  const visiting = new Set();

  return function pageDuration(pageId) {
    if (cache.has(pageId)) return cache.get(pageId);
    const diagram = diagrams && diagrams[pageId];
    if (!diagram) return 0;
    if (visiting.has(pageId)) return 0; // link cycle — fall back to local estimate
    visiting.add(pageId);
    const nodes = nodesOf(diagram);
    const duration = nodes.length
      ? computeCPM(nodes, { mode, rollup: pageDuration }).projectDuration
      : 0;
    visiting.delete(pageId);
    cache.set(pageId, duration);
    return duration;
  };
}

/** Duration actually used for a task, honouring overrides and roll-up. */
export function durationOf(node, { mode, overrides, rollup } = {}) {
  if (overrides && overrides[node.id] != null) return overrides[node.id];
  if (rollup && node.linkedSubPage) {
    const rolled = rollup(node.linkedSubPage);
    if (rolled > 0) return rolled;
  }
  return baseDuration(node, mode);
}

/**
 * Earliest start the relation permits for the successor.
 *
 * FS  successor starts after predecessor finishes
 * SS  successor starts after predecessor starts
 * FF  successor finishes after predecessor finishes
 * SF  successor finishes after predecessor starts
 *
 * The finish-constrained relations are expressed as a start by subtracting the
 * successor's own duration.
 */
function earliestStart(type, predES, predEF, lag, succDuration) {
  switch (type) {
    case 'SS': return predES + lag;
    case 'FF': return predEF + lag - succDuration;
    case 'SF': return predES + lag - succDuration;
    case 'FS':
    default:   return predEF + lag;
  }
}

/** Latest finish the relation permits for the predecessor. */
function latestFinish(type, succLS, succLF, lag, predDuration) {
  switch (type) {
    case 'SS': return succLS - lag + predDuration;
    case 'FF': return succLF - lag;
    case 'SF': return succLF - lag + predDuration;
    case 'FS':
    default:   return succLS - lag;
  }
}

/**
 * Is this relation binding — driving the successor's start rather than having
 * float in it? Used to colour the critical links.
 */
export function isDrivingLink(dep, metrics) {
  const pred = metrics[dep.id];
  const succ = metrics[dep.to];
  if (!pred || !succ) return false;
  const required = earliestStart(dep.type, pred.ES, pred.EF, dep.lag, succ.duration);
  return Math.abs(succ.ES - required) < 1e-6;
}

/**
 * Build the adjacency structures and a topological order once, so callers that
 * schedule the same graph repeatedly (Monte Carlo) do not pay for it each run.
 *
 * Returns `cycleIds` — the tasks Kahn's algorithm could not place — rather than
 * failing silently, so a corrupt or hand-edited project can be reported.
 */
export function compileGraph(nodes) {
  const ids = nodes.map(n => n.id);
  const known = new Set(ids);
  const deps = new Map();
  const succs = new Map();
  const indeg = new Map();

  ids.forEach(id => {
    succs.set(id, []);
    indeg.set(id, 0);
  });

  nodes.forEach(n => {
    const list = dependenciesOf(n).filter(d => known.has(d.id));
    deps.set(n.id, list);
    indeg.set(n.id, list.length);
    list.forEach(d => succs.get(d.id).push({ id: n.id, type: d.type, lag: d.lag }));
  });

  // Kahn's algorithm. A plain index cursor avoids the O(n²) shift() the
  // previous implementation used as a queue.
  const queue = ids.filter(id => indeg.get(id) === 0);
  const pending = new Map(indeg);
  const order = [];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const u = queue[cursor];
    order.push(u);
    succs.get(u).forEach(s => {
      const left = pending.get(s.id) - 1;
      pending.set(s.id, left);
      if (left === 0) queue.push(s.id);
    });
  }

  const placed = new Set(order);
  const cycleIds = ids.filter(id => !placed.has(id));

  return { ids, deps, succs, order, cycleIds };
}

const TYPE_CODES = { FS: 0, SS: 1, FF: 2, SF: 3 };

/**
 * Flatten a compiled graph into typed arrays keyed by index rather than id.
 *
 * Monte Carlo runs this graph tens of thousands of times. Walking Maps and
 * allocating per run dominated the cost; here every lookup is an array index
 * and the working buffers are allocated once and reused.
 */
export function indexGraph(graph) {
  const index = new Map(graph.ids.map((id, i) => [id, i]));
  const n = graph.ids.length;

  const order = new Int32Array(graph.order.length);
  graph.order.forEach((id, i) => { order[i] = index.get(id); });

  function flatten(source, pick) {
    const start = new Int32Array(n + 1);
    let total = 0;
    for (let i = 0; i < n; i++) {
      start[i] = total;
      total += (source.get(graph.ids[i]) || []).length;
    }
    start[n] = total;

    const target = new Int32Array(total);
    const type = new Int8Array(total);
    const lag = new Float64Array(total);
    let cursor = 0;
    for (let i = 0; i < n; i++) {
      for (const entry of source.get(graph.ids[i]) || []) {
        target[cursor] = index.get(pick(entry));
        type[cursor] = TYPE_CODES[entry.type] ?? 0;
        lag[cursor] = entry.lag || 0;
        cursor++;
      }
    }
    return { start, target, type, lag };
  }

  return {
    n,
    ids: graph.ids,
    order,
    deps: flatten(graph.deps, d => d.id),
    succs: flatten(graph.succs, s => s.id),
    buffers: {
      es: new Float64Array(n),
      ef: new Float64Array(n),
      ls: new Float64Array(n),
      lf: new Float64Array(n)
    }
  };
}

/**
 * One sampled schedule: forward pass, backward pass, and the resulting
 * critical set, written into the caller's reusable buffers.
 *
 * @param {Float64Array} durations indexed like `indexed.ids`
 * @param {Uint8Array} criticalOut set to 1 for tasks with zero float
 * @returns {number} project duration for this sample
 */
export function scheduleSample(indexed, durations, criticalOut) {
  const { order, deps, succs, buffers, n } = indexed;
  const { es, ef, ls, lf } = buffers;
  let total = 0;

  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    const duration = durations[i];
    let start = 0;
    for (let e = deps.start[i]; e < deps.start[i + 1]; e++) {
      const p = deps.target[e];
      const lag = deps.lag[e];
      let required;
      switch (deps.type[e]) {
        case 1: required = es[p] + lag; break;
        case 2: required = ef[p] + lag - duration; break;
        case 3: required = es[p] + lag - duration; break;
        default: required = ef[p] + lag;
      }
      if (required > start) start = required;
    }
    if (start < 0) start = 0;
    es[i] = start;
    ef[i] = start + duration;
    if (ef[i] > total) total = ef[i];
  }

  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k];
    const duration = durations[i];
    let finish = Infinity;
    if (succs.start[i] === succs.start[i + 1]) {
      finish = total;
    } else {
      for (let e = succs.start[i]; e < succs.start[i + 1]; e++) {
        const s = succs.target[e];
        const lag = succs.lag[e];
        let allowed;
        switch (succs.type[e]) {
          case 1: allowed = ls[s] - lag + duration; break;
          case 2: allowed = lf[s] - lag; break;
          case 3: allowed = lf[s] - lag + duration; break;
          default: allowed = ls[s] - lag;
        }
        if (allowed < finish) finish = allowed;
      }
    }
    lf[i] = finish;
    ls[i] = finish - duration;
  }

  if (criticalOut) {
    for (let i = 0; i < n; i++) {
      criticalOut[i] = Math.abs(ls[i] - es[i]) < 1e-6 ? 1 : 0;
    }
  }
  return total;
}

/**
 * Full schedule: forward pass for ES/EF, backward pass for LS/LF, slack, and
 * the critical set (slack of zero).
 *
 * @returns {{metrics: Object, projectDuration: number, criticalIds: Set<string>,
 *            order: string[], cycleIds: string[], links: object[]}}
 */
export function computeCPM(nodes, options = {}) {
  const graph = options.graph || compileGraph(nodes);
  const metrics = {};

  nodes.forEach(n => {
    metrics[n.id] = {
      ...n,
      duration: durationOf(n, options),
      ES: 0, EF: 0, LS: 0, LF: 0, slack: 0,
      successors: (graph.succs.get(n.id) || []).map(s => s.id)
    };
  });

  const links = [];
  graph.deps.forEach((list, to) => {
    list.forEach(d => links.push({ ...d, to }));
  });

  if (graph.cycleIds.length) {
    return {
      metrics,
      projectDuration: 0,
      criticalIds: new Set(),
      order: [],
      cycleIds: graph.cycleIds,
      links
    };
  }

  for (const id of graph.order) {
    const n = metrics[id];
    let start = 0;
    for (const dep of graph.deps.get(id)) {
      const pred = metrics[dep.id];
      const required = earliestStart(dep.type, pred.ES, pred.EF, dep.lag, n.duration);
      if (required > start) start = required;
    }
    // A lead (negative lag) on the first task could pull the schedule before
    // day zero; the project cannot start before its own origin.
    n.ES = Math.max(0, start);
    n.EF = n.ES + n.duration;
  }

  let projectDuration = 0;
  for (const id of graph.order) {
    if (metrics[id].EF > projectDuration) projectDuration = metrics[id].EF;
  }

  for (let i = graph.order.length - 1; i >= 0; i--) {
    const n = metrics[graph.order[i]];
    const succ = graph.succs.get(n.id);
    if (!succ.length) {
      n.LF = projectDuration;
    } else {
      let finish = Infinity;
      for (const s of succ) {
        const target = metrics[s.id];
        const allowed = latestFinish(s.type, target.LS, target.LF, s.lag, n.duration);
        if (allowed < finish) finish = allowed;
      }
      n.LF = finish;
    }
    n.LS = n.LF - n.duration;
    n.slack = +(n.LS - n.ES).toFixed(4);
    if (Math.abs(n.slack) < EPSILON) n.slack = 0;
  }

  const criticalIds = new Set();
  for (const id of graph.order) {
    if (metrics[id].slack === 0) criticalIds.add(id);
  }

  return { metrics, projectDuration, criticalIds, order: graph.order, cycleIds: [], links };
}

/**
 * Would adding `fromId → toId` close a loop? True when `toId` can already
 * reach `fromId` by following successors.
 */
export function wouldCreateCycle(fromId, toId, nodes) {
  const succs = new Map(nodes.map(n => [n.id, []]));
  nodes.forEach(n => {
    predecessorIds(n).forEach(dep => {
      if (succs.has(dep)) succs.get(dep).push(n.id);
    });
  });

  const stack = [toId];
  const seen = new Set();
  while (stack.length) {
    const u = stack.pop();
    if (u === fromId) return true;
    if (seen.has(u)) continue;
    seen.add(u);
    (succs.get(u) || []).forEach(v => stack.push(v));
  }
  return false;
}

/** Ancestors and descendants of a task, plus the task itself. */
export function traceFrom(nodeId, nodes) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const succs = new Map(nodes.map(n => [n.id, []]));
  nodes.forEach(n => {
    predecessorIds(n).forEach(d => {
      if (succs.has(d)) succs.get(d).push(n.id);
    });
  });

  const ids = new Set([nodeId]);

  const up = [...predecessorIds(byId.get(nodeId) || {})];
  while (up.length) {
    const u = up.pop();
    if (ids.has(u)) continue;
    ids.add(u);
    predecessorIds(byId.get(u) || {}).forEach(d => up.push(d));
  }

  const down = [...(succs.get(nodeId) || [])];
  while (down.length) {
    const u = down.pop();
    if (ids.has(u)) continue;
    ids.add(u);
    (succs.get(u) || []).forEach(v => down.push(v));
  }

  return ids;
}
