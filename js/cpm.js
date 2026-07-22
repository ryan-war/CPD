// Critical Path Method engine.
//
// Pure: no DOM, no module-level mutable state. Everything the schedule depends
// on — estimation mode, duration overrides, sub-path roll-up — arrives as an
// argument, which keeps the engine testable and lets Monte Carlo reuse it.

const EPSILON = 1e-9;

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
    const list = (n.dependencies || []).filter(d => known.has(d));
    deps.set(n.id, list);
    indeg.set(n.id, list.length);
    list.forEach(d => succs.get(d).push(n.id));
  });

  // Kahn's algorithm. A plain index cursor avoids the O(n²) shift() the
  // previous implementation used as a queue.
  const queue = ids.filter(id => indeg.get(id) === 0);
  const pending = new Map(indeg);
  const order = [];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const u = queue[cursor];
    order.push(u);
    succs.get(u).forEach(v => {
      const left = pending.get(v) - 1;
      pending.set(v, left);
      if (left === 0) queue.push(v);
    });
  }

  const placed = new Set(order);
  const cycleIds = ids.filter(id => !placed.has(id));

  return { ids, deps, succs, order, cycleIds };
}

/**
 * Forward pass only. Monte Carlo needs the project duration and nothing else,
 * so it skips the backward pass and the per-run object allocation entirely.
 */
export function projectDurationFor(graph, durations) {
  const ef = new Map();
  let total = 0;
  for (const id of graph.order) {
    let es = 0;
    for (const dep of graph.deps.get(id)) {
      const depEf = ef.get(dep);
      if (depEf > es) es = depEf;
    }
    const finish = es + (durations.get(id) || 0);
    ef.set(id, finish);
    if (finish > total) total = finish;
  }
  return total;
}

/**
 * Full schedule: forward pass for ES/EF, backward pass for LS/LF, slack, and
 * the critical set (slack of zero).
 *
 * @returns {{metrics: Object, projectDuration: number, criticalIds: Set<string>,
 *            order: string[], cycleIds: string[]}}
 */
export function computeCPM(nodes, options = {}) {
  const graph = options.graph || compileGraph(nodes);
  const metrics = {};

  nodes.forEach(n => {
    metrics[n.id] = {
      ...n,
      duration: durationOf(n, options),
      ES: 0, EF: 0, LS: 0, LF: 0, slack: 0,
      successors: graph.succs.get(n.id) || []
    };
  });

  if (graph.cycleIds.length) {
    return {
      metrics,
      projectDuration: 0,
      criticalIds: new Set(),
      order: [],
      cycleIds: graph.cycleIds
    };
  }

  for (const id of graph.order) {
    const n = metrics[id];
    let es = 0;
    for (const dep of graph.deps.get(id)) {
      if (metrics[dep].EF > es) es = metrics[dep].EF;
    }
    n.ES = es;
    n.EF = es + n.duration;
  }

  let projectDuration = 0;
  for (const id of graph.order) {
    if (metrics[id].EF > projectDuration) projectDuration = metrics[id].EF;
  }

  for (let i = graph.order.length - 1; i >= 0; i--) {
    const n = metrics[graph.order[i]];
    if (!n.successors.length) {
      n.LF = projectDuration;
    } else {
      let lf = Infinity;
      for (const s of n.successors) {
        if (metrics[s].LS < lf) lf = metrics[s].LS;
      }
      n.LF = lf;
    }
    n.LS = n.LF - n.duration;
    n.slack = +(n.LS - n.ES).toFixed(4);
    if (Math.abs(n.slack) < EPSILON) n.slack = 0;
  }

  const criticalIds = new Set();
  for (const id of graph.order) {
    if (metrics[id].slack === 0) criticalIds.add(id);
  }

  return { metrics, projectDuration, criticalIds, order: graph.order, cycleIds: [] };
}

/**
 * Would adding `fromId → toId` close a loop? True when `toId` can already
 * reach `fromId` by following successors.
 */
export function wouldCreateCycle(fromId, toId, nodes) {
  const succs = new Map(nodes.map(n => [n.id, []]));
  nodes.forEach(n => {
    (n.dependencies || []).forEach(dep => {
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
    (n.dependencies || []).forEach(d => {
      if (succs.has(d)) succs.get(d).push(n.id);
    });
  });

  const ids = new Set([nodeId]);

  const up = [...(byId.get(nodeId)?.dependencies || [])];
  while (up.length) {
    const u = up.pop();
    if (ids.has(u)) continue;
    ids.add(u);
    (byId.get(u)?.dependencies || []).forEach(d => up.push(d));
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
