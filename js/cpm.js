// Critical Path Method engine.
//
// Pure: no DOM, no module-level mutable state. Everything the schedule depends
// on — estimation mode, duration overrides, sub-path roll-up — arrives as an
// argument, which keeps the engine testable and lets Monte Carlo reuse it.

const EPSILON = 1e-9;

/**
 * A day offset, or null when there is none.
 *
 * `Number(null)` is zero, so a plain numeric coercion turns "no deadline" into
 * "due on day zero" and marks the whole project catastrophically late.
 */
export function dayOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

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

/**
 * Progress roll-up resolver: how complete a page is, weighted by the duration
 * each task actually contributes. A page is not 50% done because half its
 * tasks are — it is 50% done when half its *work* is, so a ten-day task counts
 * for ten times a one-day one.
 *
 * Memoised and cycle-guarded exactly as `createRollup`, and recursive through
 * the same links: a task standing in for a sub-page reports that page's
 * progress rather than its own stored value.
 *
 * @returns {(pageId: string) => number|null} 0–100, or null for a page with no
 *   tasks — "empty" and "nothing done yet" are different answers.
 */
export function createProgressRollup(diagrams, mode) {
  const rollup = createRollup(diagrams, mode);
  const cache = new Map();
  const visiting = new Set();

  return function pageProgress(pageId) {
    if (cache.has(pageId)) return cache.get(pageId);
    const diagram = diagrams && diagrams[pageId];
    if (!diagram) return null;
    if (visiting.has(pageId)) return null; // link cycle — no answer to give
    visiting.add(pageId);

    const nodes = nodesOf(diagram);
    let weighted = 0;
    let total = 0;
    nodes.forEach(node => {
      const weight = durationOf(node, { mode, rollup });
      const nested = node.linkedSubPage ? pageProgress(node.linkedSubPage) : null;
      const percent = nested != null ? nested : clampPercent(node.progress);
      weighted += weight * percent;
      total += weight;
    });

    visiting.delete(pageId);
    // Zero-duration tasks still carry progress; fall back to a plain mean so a
    // page of milestones does not divide by zero.
    const value = !nodes.length
      ? null
      : total > 0
        ? weighted / total
        : nodes.reduce((sum, n) => sum + clampPercent(n.progress), 0) / nodes.length;
    cache.set(pageId, value);
    return value;
  };
}

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

/**
 * How a task's dates answer to the data date — the moment the project is
 * reported as of.
 *
 * Without one, progress is a decoration: a plan half-built still forecasts the
 * finish it was drawn with. With one, what is left of the work drives the dates
 * and the forecast moves as reality does.
 *
 * Three cases, which is how P6 and Project treat retained logic:
 *
 *   done         finished by definition, so it cannot still be running past the
 *                reporting date and cannot push a successor past it either
 *   in progress  started, so it cannot start later than now, and cannot finish
 *                before now plus whatever is left of it
 *   not started  cannot have started in the past
 *
 * Returns the adjusted pair plus whether the task reports progress the network
 * says it could not yet have made — worth surfacing rather than absorbing, as
 * it usually means the logic or the progress is wrong.
 */
function applyDataDate(es, ef, duration, progress, dataDate) {
  const percent = clampPercent(progress);
  const outOfSequence = percent > 0 && es > dataDate;

  if (percent >= 100) {
    const finish = Math.min(ef, dataDate);
    return { es: Math.min(es, finish), ef: finish, outOfSequence };
  }
  if (percent > 0) {
    const start = Math.min(es, dataDate);
    const remaining = duration * (1 - percent / 100);
    return { es: start, ef: Math.max(start, dataDate) + remaining, outOfSequence };
  }
  const start = Math.max(es, dataDate);
  return { es: start, ef: start + duration, outOfSequence };
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
 * Slack in one relation: how much later than the relation demands the successor
 * actually starts. Zero means the link is binding.
 *
 * Both readings of this number are used — whether it is zero, to colour the
 * driving links, and how small it gets across a task's successors, which is
 * that task's free float. One expression so the two cannot drift apart.
 */
function linkGap(type, predES, predEF, lag, succES, succDuration) {
  return succES - earliestStart(type, predES, predEF, lag, succDuration);
}

/**
 * Is this relation binding — driving the successor's start rather than having
 * float in it? Used to colour the critical links.
 */
export function isDrivingLink(dep, metrics) {
  const pred = metrics[dep.id];
  const succ = metrics[dep.to];
  if (!pred || !succ) return false;
  return Math.abs(linkGap(dep.type, pred.ES, pred.EF, dep.lag, succ.ES, succ.duration)) < 1e-6;
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
 * @param {{dataDate?: number|null, notBefore?: Float64Array,
 *          progress?: Float64Array}} [status] reporting date and the per-task
 *   constraint and progress arrays it is read against. Omitted, the sample is
 *   a plain forward pass over the planned network, exactly as before.
 * @returns {number} project duration for this sample
 */
export function scheduleSample(indexed, durations, criticalOut, status) {
  const { order, deps, succs, buffers, n } = indexed;
  const { es, ef, ls, lf } = buffers;
  const notBefore = status && status.notBefore;
  const progress = status && status.progress;
  const dataDate = status && status.dataDate != null ? status.dataDate : null;
  const hasDataDate = dataDate != null;
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
    if (notBefore && notBefore[i] > start) start = notBefore[i];
    es[i] = start;
    ef[i] = start + duration;

    // The same three cases computeCPM applies, inlined: this loop runs tens of
    // thousands of times and the whole block is skipped when nothing is being
    // reported as of a date.
    if (hasDataDate) {
      const percent = progress ? progress[i] : 0;
      if (percent >= 100) {
        const finish = ef[i] < dataDate ? ef[i] : dataDate;
        ef[i] = finish;
        if (es[i] > finish) es[i] = finish;
      } else if (percent > 0) {
        if (es[i] > dataDate) es[i] = dataDate;
        const from = es[i] > dataDate ? es[i] : dataDate;
        ef[i] = from + duration * (1 - percent / 100);
      } else {
        if (es[i] < dataDate) es[i] = dataDate;
        ef[i] = es[i] + duration;
      }
    }

    if (ef[i] > total) total = ef[i];
  }

  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k];
    // The span the forward pass actually gave the task, which under a data date
    // is not its planned duration — measure the same task both ways or float
    // comes back negative on work that is not late.
    const span = ef[i] - es[i];
    let finish = Infinity;
    if (succs.start[i] === succs.start[i + 1]) {
      finish = total;
    } else {
      for (let e = succs.start[i]; e < succs.start[i + 1]; e++) {
        const s = succs.target[e];
        const lag = succs.lag[e];
        let allowed;
        switch (succs.type[e]) {
          case 1: allowed = ls[s] - lag + span; break;
          case 2: allowed = lf[s] - lag; break;
          case 3: allowed = lf[s] - lag + span; break;
          default: allowed = ls[s] - lag;
        }
        if (allowed < finish) finish = allowed;
      }
    }
    lf[i] = finish;
    ls[i] = finish - span;
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
      ES: 0, EF: 0, LS: 0, LF: 0, slack: 0, freeFloat: 0,
      remaining: durationOf(n, options),
      span: durationOf(n, options),
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
      worstSlack: 0,
      order: [],
      cycleIds: graph.cycleIds,
      links,
      dataDate: dayOrNull(options.dataDate),
      outOfSequenceIds: []
    };
  }

  const dataDate = dayOrNull(options.dataDate);
  const outOfSequenceIds = [];

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
    // A task can be held back by something the network does not model — a
    // permit, a delivery, a date someone else owns. The constraint is a floor
    // on the start, never a ceiling: it can delay a task but not pull one in.
    const notBefore = dayOrNull(n.startNoEarlierThan);
    if (notBefore != null && notBefore > n.ES) n.ES = notBefore;
    n.EF = n.ES + n.duration;

    if (dataDate != null) {
      // A task standing in for a sub-page is as complete as that page is, not
      // as complete as its own untouched slider says. Same rule the panel
      // already displays; the schedule now answers to it too.
      let percent = n.progress;
      if (options.progressRollup && n.linkedSubPage) {
        const rolled = options.progressRollup(n.linkedSubPage);
        if (rolled != null) percent = rolled;
      }
      const dated = applyDataDate(n.ES, n.EF, n.duration, percent, dataDate);
      n.ES = dated.es;
      n.EF = dated.ef;
      n.remaining = +(n.EF - Math.max(n.ES, dataDate)).toFixed(4);
      if (n.remaining < 0) n.remaining = 0;
      if (dated.outOfSequence) outOfSequenceIds.push(id);
    } else {
      n.remaining = n.duration;
    }
    // The length the task actually occupies. Under a data date this parts
    // company with the planned duration — work already done is behind us, and
    // the backward pass has to measure the same task the forward pass did or
    // it will demand a start that has already been and gone, and report
    // negative float on work that is not late at all.
    n.span = n.EF - n.ES;
  }

  let projectDuration = 0;
  for (const id of graph.order) {
    if (metrics[id].EF > projectDuration) projectDuration = metrics[id].EF;
  }

  // A deadline earlier than the schedule pulls every latest-finish back with
  // it, which is what turns float negative. A deadline the plan already meets
  // is not applied: it would hand every task slack and empty the critical
  // path, when the useful reading is still "what drives the finish".
  const deadline = dayOrNull(options.deadline);
  const limit = deadline != null ? Math.min(projectDuration, deadline) : projectDuration;

  for (let i = graph.order.length - 1; i >= 0; i--) {
    const n = metrics[graph.order[i]];
    const succ = graph.succs.get(n.id);
    if (!succ.length) {
      n.LF = limit;
    } else {
      let finish = Infinity;
      for (const s of succ) {
        const target = metrics[s.id];
        const allowed = latestFinish(s.type, target.LS, target.LF, s.lag, n.span);
        if (allowed < finish) finish = allowed;
      }
      n.LF = finish;
    }
    // A task of its own can be due before the path would otherwise require.
    const own = dayOrNull(n.mustFinishBy);
    if (own != null && own < n.LF) n.LF = own;

    n.LS = n.LF - n.span;
    n.slack = +(n.LS - n.ES).toFixed(4);
    if (Math.abs(n.slack) < EPSILON) n.slack = 0;

    // Free float: delay available before *a successor* moves, as against total
    // float, which measures delay before the *project* moves. The difference is
    // the useful one — a task with ten days of total float and none free has
    // room only by spending someone else's.
    //
    // A delay shifts ES and EF together by the same amount, so the minimum gap
    // across the successors is the answer for all four relation types alike.
    // With no successors the task runs into the project finish, which a missed
    // deadline pulls in, so free float goes negative there exactly as total
    // float does.
    let free = succ.length ? Infinity : limit - n.EF;
    for (const s of succ) {
      const target = metrics[s.id];
      const gap = linkGap(s.type, n.ES, n.EF, s.lag, target.ES, target.span);
      if (gap < free) free = gap;
    }
    n.freeFloat = +free.toFixed(4);
    if (Math.abs(n.freeFloat) < EPSILON) n.freeFloat = 0;
  }

  // Zero float is critical; negative float is critical *and* already late.
  // Testing `<= 0` rather than `=== 0` keeps the no-deadline result identical.
  const criticalIds = new Set();
  let worstSlack = 0;
  for (const id of graph.order) {
    const { slack } = metrics[id];
    if (slack <= 0) criticalIds.add(id);
    if (slack < worstSlack) worstSlack = slack;
  }

  return {
    metrics, projectDuration, criticalIds, worstSlack,
    order: graph.order, cycleIds: [], links,
    dataDate, outOfSequenceIds
  };
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
