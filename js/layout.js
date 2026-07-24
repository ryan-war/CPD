// Diagram layout: where tasks sit on the canvas.
//
// Pure — no DOM, no vis-network, no state. Node dimensions arrive through a
// `sizeOf` callback so the same code can be driven by real measurements from
// the canvas or by estimates in a test.

import {
  COLUMN_MIN_GAP, ROW_MIN_GAP, GHOST_DROP, GHOST_ROW_GAP, GHOST_COL_GAP
} from './config.js';
import { dependenciesOf } from './cpm.js';

/** Fallback dimensions when nothing has measured the node yet. */
const DEFAULT_SIZE = { width: 110, height: 110 };

function sizeFor(sizeOf, id) {
  const size = sizeOf ? sizeOf(id) : null;
  const width = Number(size?.width);
  const height = Number(size?.height);
  return {
    width: Number.isFinite(width) && width > 0 ? width : DEFAULT_SIZE.width,
    height: Number.isFinite(height) && height > 0 ? height : DEFAULT_SIZE.height
  };
}

/**
 * Longest-path rank for every task: one further right than its latest
 * predecessor. Tasks in a cycle, or with predecessors outside the diagram,
 * fall back to rank 0.
 */
function rankNodes(nodes, graph) {
  const ranks = new Map(nodes.map(n => [n.id, 0]));
  const order = graph?.order?.length ? graph.order : nodes.map(n => n.id);
  const known = new Set(ranks.keys());

  order.forEach(id => {
    const deps = graph?.deps?.get(id) || dependenciesOf(nodes.find(n => n.id === id) || {});
    const reachable = deps.filter(d => known.has(d.id));
    ranks.set(id, reachable.length ? Math.max(...reachable.map(d => ranks.get(d.id))) + 1 : 0);
  });

  return ranks;
}

/** Group ids by rank, each rank seeded in earliest-start then id order. */
function bucketByRank(nodes, ranks, metrics) {
  const buckets = new Map();
  nodes.forEach(n => {
    const rank = ranks.get(n.id) ?? 0;
    if (!buckets.has(rank)) buckets.set(rank, []);
    buckets.get(rank).push(n.id);
  });

  const es = id => Number(metrics?.[id]?.ES) || 0;
  buckets.forEach(list => {
    list.sort((a, b) => (es(a) - es(b)) || String(a).localeCompare(String(b)));
  });

  return [...buckets.keys()].sort((a, b) => a - b).map(rank => buckets.get(rank));
}

/** Adjacency in both directions, restricted to tasks present in the diagram. */
function neighbourMaps(nodes, graph) {
  const known = new Set(nodes.map(n => n.id));
  const preds = new Map(nodes.map(n => [n.id, []]));
  const succs = new Map(nodes.map(n => [n.id, []]));

  nodes.forEach(n => {
    const deps = graph?.deps?.get(n.id) || dependenciesOf(n);
    deps.forEach(d => {
      if (!known.has(d.id)) return;
      preds.get(n.id).push(d.id);
      succs.get(d.id).push(n.id);
    });
  });

  return { preds, succs };
}

/**
 * Barycenter ordering. Each node moves to the average position of its
 * neighbours in the rank just processed, which pulls connected tasks into line
 * and takes most of the crossings out. Nodes with no neighbour on that side
 * keep their current slot rather than collapsing to the top.
 *
 * `layers` is walked in sweep order — reversed for an upward pass — and each
 * rank is ordered against the one before it, which is by then settled.
 */
function barycenterSweep(layers, neighbours) {
  let settled = new Map();

  layers.forEach((layer, index) => {
    if (index > 0) {
      const original = new Map(layer.map((id, i) => [id, i]));
      const key = new Map(layer.map((id, i) => {
        const adjacent = (neighbours.get(id) || []).filter(n => settled.has(n));
        if (!adjacent.length) return [id, i];
        const sum = adjacent.reduce((acc, n) => acc + settled.get(n), 0);
        return [id, sum / adjacent.length];
      }));
      // The original index breaks ties, so a sweep that changes nothing is a
      // no-op rather than a reshuffle.
      layer.sort((a, b) => (key.get(a) - key.get(b)) || (original.get(a) - original.get(b)));
    }
    settled = new Map(layer.map((id, i) => [id, i]));
  });
}

/** Crossings between two adjacent ranks, counted pairwise. */
function crossingsBetween(upper, lower, succs) {
  const index = new Map(lower.map((id, i) => [id, i]));
  const edges = [];
  upper.forEach((id, i) => {
    (succs.get(id) || []).forEach(target => {
      if (index.has(target)) edges.push([i, index.get(target)]);
    });
  });

  let count = 0;
  for (let a = 0; a < edges.length; a++) {
    for (let b = a + 1; b < edges.length; b++) {
      const [ua, la] = edges[a];
      const [ub, lb] = edges[b];
      if ((ua - ub) * (la - lb) < 0) count++;
    }
  }
  return count;
}

/** Total crossings over the whole diagram — the value the sweeps minimise. */
function totalCrossings(layers, succs) {
  let count = 0;
  for (let i = 0; i < layers.length - 1; i++) {
    count += crossingsBetween(layers[i], layers[i + 1], succs);
  }
  return count;
}

/**
 * Adjacent-swap pass: try exchanging each neighbouring pair and keep the swap
 * only when it removes crossings. Cleans up what the barycenter sweeps leave
 * behind, where two nodes have equal or near-equal averages.
 */
function transposePass(layers, succs) {
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 4) {
    improved = false;
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      for (let j = 0; j < layer.length - 1; j++) {
        const before = neighbourCrossings(layers, i, succs);
        [layer[j], layer[j + 1]] = [layer[j + 1], layer[j]];
        const after = neighbourCrossings(layers, i, succs);
        if (after < before) {
          improved = true;
        } else {
          [layer[j], layer[j + 1]] = [layer[j + 1], layer[j]];
        }
      }
    }
  }
}

function neighbourCrossings(layers, i, succs) {
  let count = 0;
  if (i > 0) count += crossingsBetween(layers[i - 1], layers[i], succs);
  if (i < layers.length - 1) count += crossingsBetween(layers[i], layers[i + 1], succs);
  return count;
}

/**
 * Reorder a rank so its critical task sits in the middle, the rest fanning out
 * alternately above and below in the order the sweeps settled on. Every rank
 * doing this puts the critical path on one straight horizontal line, which is
 * the thing you are looking for on a CPM diagram and the thing a generic
 * hierarchical layout will not give you.
 */
function centreOnCritical(layer, criticalIds) {
  const spine = layer.filter(id => criticalIds.has(id));
  if (!spine.length) return layer.slice();

  const rest = layer.filter(id => !criticalIds.has(id));
  const above = [];
  const below = [];
  rest.forEach((id, i) => (i % 2 === 0 ? above : below).push(id));
  above.reverse();
  return [...above, ...spine, ...below];
}

/**
 * Positions for the CPM hierarchical layout.
 *
 * @param {object[]} nodes tasks of the diagram
 * @param {{metrics?: object, criticalIds?: Set<string>, graph?: object}} schedule
 * @param {{sizeOf?: (id: string) => {width: number, height: number}}} options
 * @returns {{positions: Object<string, {x: number, y: number}>, layers: string[][], ranks: Map}}
 */
/** Height a virtual routing node reserves — a lane a long edge travels down. */
const VIRTUAL_HEIGHT = 34;
/** Virtual-node ids use a character no real task id can hold (a null byte). */
const VIRTUAL_PREFIX = '\u0000v';

export function computeCpmLayout(nodes, schedule = {}, options = {}) {
  const positions = {};
  if (!nodes.length) return { positions, layers: [], ranks: new Map() };

  const { metrics, graph } = schedule;
  const criticalIds = schedule.criticalIds || new Set();
  const { sizeOf } = options;

  const ranks = rankNodes(nodes, graph);
  const known = new Set(nodes.map(n => n.id));
  const maxRank = Math.max(0, ...ranks.values());

  // Expand the graph with virtual routing nodes: an edge spanning more than one
  // rank is broken into a chain through a placeholder on every rank between its
  // ends. Those placeholders take part in the ordering and reserve a slot when
  // the ranks are laid out, so the straight edge travels down an empty lane
  // rather than being drawn across the tasks that sit between its endpoints —
  // which is what made long arrows cut through nodes.
  const layers = Array.from({ length: maxRank + 1 }, () => []);
  const succs = new Map();
  const preds = new Map();
  const esKey = new Map();
  const virtual = new Set();
  const ensure = id => { if (!succs.has(id)) succs.set(id, []); if (!preds.has(id)) preds.set(id, []); };

  nodes.forEach(n => {
    ensure(n.id);
    layers[ranks.get(n.id) ?? 0].push(n.id);
    esKey.set(n.id, Number(metrics?.[n.id]?.ES) || 0);
  });

  let vcount = 0;
  nodes.forEach(n => {
    const deps = graph?.deps?.get(n.id) || dependenciesOf(n);
    const rv = ranks.get(n.id) ?? 0;
    deps.forEach(d => {
      if (!known.has(d.id)) return;
      const ru = ranks.get(d.id) ?? 0;
      if (rv - ru <= 1) {
        succs.get(d.id).push(n.id);
        preds.get(n.id).push(d.id);
        return;
      }
      let prev = d.id;
      const srcEs = esKey.get(d.id) || 0;
      for (let r = ru + 1; r < rv; r++) {
        const vid = `${VIRTUAL_PREFIX}${vcount++}`;
        virtual.add(vid);
        ensure(vid);
        esKey.set(vid, srcEs);
        layers[r].push(vid);
        succs.get(prev).push(vid);
        preds.get(vid).push(prev);
        prev = vid;
      }
      succs.get(prev).push(n.id);
      preds.get(n.id).push(prev);
    });
  });

  // Seed each rank by earliest start, a virtual taking its edge's start.
  layers.forEach(list =>
    list.sort((a, b) => (esKey.get(a) - esKey.get(b)) || String(a).localeCompare(String(b))));

  // Alternating sweeps over the expanded graph: downward orders each rank by its
  // predecessors, upward by its successors. Six passes settles diagrams this size.
  let best = layers.map(layer => layer.slice());
  let bestScore = totalCrossings(layers, succs);
  for (let pass = 0; pass < 6; pass++) {
    barycenterSweep(pass % 2 === 0 ? layers : [...layers].reverse(),
      pass % 2 === 0 ? preds : succs);
    transposePass(layers, succs);
    const score = totalCrossings(layers, succs);
    if (score < bestScore) {
      bestScore = score;
      best = layers.map(layer => layer.slice());
    }
  }

  const ordered = best.map(layer => centreOnCritical(layer, criticalIds));
  const heightOf = id => virtual.has(id) ? VIRTUAL_HEIGHT : sizeFor(sizeOf, id).height;

  // Column x from the widest real task in each rank; virtual nodes have no width.
  let x = 0;
  ordered.forEach((layer, i) => {
    const reals = layer.filter(id => !virtual.has(id));
    const width = reals.length
      ? Math.max(...reals.map(id => sizeFor(sizeOf, id).width))
      : DEFAULT_SIZE.width;
    if (i > 0) x += width / 2;
    const columnX = x;

    // Rows stack by height — real tasks by their own, virtuals by their lane —
    // centred on the critical task's line at y = 0, or on the rank itself when
    // nothing on it is critical.
    const offsets = [];
    let cursor = 0;
    layer.forEach(id => {
      const span = heightOf(id) + ROW_MIN_GAP;
      offsets.push(cursor + span / 2);
      cursor += span;
    });
    const spineIndex = layer.findIndex(id => criticalIds.has(id));
    const centre = spineIndex >= 0 ? offsets[spineIndex] : cursor / 2;

    layer.forEach((id, j) => {
      if (virtual.has(id)) return; // placeholders are not tasks; they only reserve space
      positions[id] = { x: columnX, y: Math.round(offsets[j] - centre) };
    });

    x += width / 2 + COLUMN_MIN_GAP;
  });

  return { positions, layers: ordered.map(l => l.filter(id => !virtual.has(id))), ranks };
}

// ─── Columns view ──────────────────────────────────────────

/**
 * Tasks of a milestone in schedule order: earliest start first, then the
 * tighter float, then id. Returns a copy — `ms.nodes` order is the user's,
 * and reordering it in place would fight the milestone controls.
 */
/**
 * Where a linked sub-path's tasks sit when drawn under the Main task that
 * stands for them.
 *
 * The Main diagram flows left to right, so a sub-path drawn the same way would
 * run straight through its neighbours and read as one flat network. Hanging it
 * downward instead uses the axis Main is not using: depth on screen becomes
 * depth in the breakdown, and the two levels stay legible as different things.
 *
 * Same ranking as the main layout, rotated — longest path sets the row, and
 * tasks sharing a row spread sideways about the parent's centre.
 *
 * @param {object[]} subNodes tasks of the sub-page
 * @param {{x: number, y: number}} origin position of the parent Main task
 * @param {{metrics?: object, graph?: object, drop?: number, rowGap?: number,
 *          colGap?: number}} options
 * @returns {{positions: Object<string, {x: number, y: number}>, rows: number,
 *   depth: number}} `depth` is how far below the parent the last row sits.
 */
export function ghostLayout(subNodes, origin = { x: 0, y: 0 }, options = {}) {
  const positions = {};
  if (!subNodes || !subNodes.length) return { positions, rows: 0, depth: 0 };

  const drop = options.drop ?? GHOST_DROP;
  const rowGap = options.rowGap ?? GHOST_ROW_GAP;
  const colGap = options.colGap ?? GHOST_COL_GAP;
  const baseX = Number(origin?.x) || 0;
  const baseY = Number(origin?.y) || 0;

  const ranks = rankNodes(subNodes, options.graph);
  const layers = bucketByRank(subNodes, ranks, options.metrics);

  layers.forEach((layer, row) => {
    // Centre each row on the parent so the branch hangs straight down from it
    // rather than drifting right as it deepens.
    const span = (layer.length - 1) * colGap;
    layer.forEach((id, i) => {
      positions[id] = {
        x: baseX - span / 2 + i * colGap,
        y: baseY + drop + row * rowGap
      };
    });
  });

  return {
    positions,
    rows: layers.length,
    depth: layers.length ? drop + (layers.length - 1) * rowGap : 0
  };
}

export function orderedNodes(milestone, metrics) {
  const list = (milestone?.nodes || []).slice();
  const of = (id, key) => Number(metrics?.[id]?.[key]) || 0;
  return list.sort((a, b) =>
    (of(a.id, 'ES') - of(b.id, 'ES')) ||
    (of(a.id, 'slack') - of(b.id, 'slack')) ||
    String(a.id).localeCompare(String(b.id))
  );
}

/**
 * Where each milestone column sits on the canvas and how wide it is.
 *
 * The column gap used to be one constant shared by the lane headers, the
 * background bands, and the task positions, so a milestone holding wide boxes
 * overflowed into its neighbour while one holding a single circle left a gap.
 * Each column is now sized to its own widest task.
 */
export function columnGeometry(milestones, sizeOf) {
  const columns = [];
  let x = 0;

  (milestones || []).forEach((ms, i) => {
    const nodes = ms.nodes || [];
    const widest = nodes.length
      ? Math.max(...nodes.map(n => sizeFor(sizeOf, n.id).width))
      : DEFAULT_SIZE.width;
    const width = Math.max(COLUMN_MIN_GAP * 2, widest + COLUMN_MIN_GAP);

    columns.push({ id: ms.id, index: i, width, centre: x + width / 2, left: x });
    x += width;
  });

  return { columns, totalWidth: x };
}

/**
 * Row height for the columns view: tall enough for the tallest task anywhere
 * on the page, so row n sits at the same height in every column.
 */
export function columnRowHeight(milestones, sizeOf) {
  const heights = (milestones || []).flatMap(ms =>
    (ms.nodes || []).map(n => sizeFor(sizeOf, n.id).height));
  return Math.max(...heights, DEFAULT_SIZE.height) + ROW_MIN_GAP;
}

/**
 * A free spot near (x, y) for a newly added task.
 *
 * Every task added from the toolbar used to land on exactly (0, 0), so adding
 * three in a row stacked them on top of each other with only the top one
 * visible. Spirals outward until nothing else is within `spacing`.
 */
export function freeSpotNear(x, y, taken, spacing = 130) {
  const clear = (px, py) => !taken.some(p =>
    Math.abs(p.x - px) < spacing && Math.abs(p.y - py) < spacing);
  if (clear(x, y)) return { x, y };

  // Rings of eight, each further out than the last.
  for (let ring = 1; ring <= 12; ring++) {
    const step = spacing * ring;
    for (const [dx, dy] of [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]) {
      const px = x + dx * step;
      const py = y + dy * step;
      if (clear(px, py)) return { x: px, y: py };
    }
  }
  return { x, y };
}

/**
 * Y of the first row, shared by every column.
 *
 * Centring each column on its own contents was what broke the correspondence
 * with the task cards: a column of two tasks and one of five put their first
 * rows at different heights, so nothing lined up across the page. One origin
 * for all of them, positioned so the fullest column is centred.
 */
export function columnRowOrigin(milestones, rowHeight) {
  const rows = Math.max(1, ...(milestones || []).map(ms => (ms.nodes || []).length));
  return -((rows - 1) * rowHeight) / 2;
}
