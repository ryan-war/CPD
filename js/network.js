// vis-network canvas: data construction, drawing overlays, and interaction.

import {
  CRITICAL_COLOR, NEAR_CRITICAL_COLOR, LATE_COLOR, TRACE_COLOR, SEARCH_COLOR, SELECTED_COLOR,
  LANE_ID_PREFIX, GHOST_ID_PREFIX, STATUS_COLORS, MINIMAP_WIDTH, MINIMAP_HEIGHT, GHOST_MAX_NODES,
  isLaneId, isGhostId, isSyntheticId, ghostId, parseGhostId, paletteFor
} from './config.js';
import { $, toast } from './dom.js';
import {
  traceFrom, wouldCreateCycle, dependenciesOf, isDrivingLink, nodesOf, computeCPM
} from './cpm.js';
import {
  schedule, fmt, fmtPercent, getCriticality, rollupForNode, isProjectCritical
} from './schedule.js';
import { getState, currentDiagram, allNodes, findNode, displayOpts, pageTitle } from './state.js';
import { tagsOf, matchesTags } from './tags.js';
import { linkTooltip } from './links.js';
import { columnGeometry, ghostLayout } from './layout.js';

let network = null;
let nodesDS = null;
let edgesDS = null;
let handlers = {};

let connectMode = false;
let connectSource = null;
let connectPointer = null;
let selectedIds = [];
let selectedEdgeId = null;
let searchQuery = '';
let traceIds = new Set();
// Tags currently filtered on. Transient view state, like the search query and
// the hover trace — it dims what it excludes rather than changing the project.
let activeTags = new Set();

// Snapshots used by the per-frame draw callbacks. Rebuilt on sync rather than
// read out of state on every animation frame.
let ringCache = [];
let laneCache = [];
let palette = paletteFor('dark');
let ghostNote = null;

export function getNetwork() {
  return network;
}

export function getSelection() {
  return { nodeIds: selectedIds.slice(), nodeId: selectedIds[0] || null, edgeId: selectedEdgeId };
}

export function clearSelection() {
  selectedIds = [];
  selectedEdgeId = null;
  if (network) network.unselectAll();
}

/** Select tasks from outside the canvas — used by the panel's selection sync. */
export function selectNodes(ids, { focus = false } = {}) {
  if (!network) return;
  const known = new Set(allNodes().map(n => n.id));
  selectedIds = ids.filter(id => known.has(id));
  selectedEdgeId = null;
  network.selectNodes(selectedIds, true);
  if (focus && selectedIds.length === 1) {
    network.focus(selectedIds[0], {
      scale: Math.max(1, network.getScale()),
      animation: { duration: 300, easingFunction: 'easeInOutQuad' }
    });
  }
  refreshHighlights();
  // vis-network fires no event for a programmatic selection, so nothing else
  // learns the selection changed. Ghosts that follow it — and the note saying
  // why none are drawn — would go on describing the previous selection: click
  // a linked task's card and its sub-path would not appear.
  syncGhostsToSelection();
}

/**
 * Redraw selection-dependent ghosts, wherever the selection came from.
 * A no-op unless ghosts are actually following the selection.
 */
function syncGhostsToSelection() {
  if ((displayOpts().ghosts || 'off') !== 'selected') return;
  refreshGhosts();
  if (handlers.onGhostsChanged) handlers.onGhostsChanged();
}

export function setSearchQuery(q) {
  searchQuery = q;
}

export function getSearchQuery() {
  return searchQuery;
}

export function matchesSearch(node) {
  if (!searchQuery) return false;
  const q = searchQuery.toLowerCase();
  return String(node.id).toLowerCase().includes(q) ||
    (node.title || '').toLowerCase().includes(q) ||
    (node.description || '').toLowerCase().includes(q) ||
    tagsOf(node).some(tag => tag.toLowerCase().includes(q));
}

// ─── Tag filter ────────────────────────────────────────────

export function getActiveTags() {
  return activeTags;
}

/** Flip one tag on or off. Returns the resulting set for the caller to act on. */
export function toggleActiveTag(tag) {
  if (activeTags.has(tag)) activeTags.delete(tag);
  else activeTags.add(tag);
  return activeTags;
}

export function clearActiveTags() {
  activeTags = new Set();
}

/**
 * Drop any filtered tag no longer present on the page. Called before styling on
 * every render, so deleting the last task with a tag — or switching to a page
 * that never had it — cannot leave the canvas dimmed against a tag that is gone.
 */
export function retainActiveTags(available) {
  activeTags.forEach(tag => {
    if (!available.has(tag)) activeTags.delete(tag);
  });
}

/** True when the task should read as filtered out — some filter is on and it has none of it. */
function filteredByTags(node) {
  return activeTags.size > 0 && !matchesTags(node, activeTags);
}

// ─── Labels ────────────────────────────────────────────────

function buildNodeLabel(node, metric, state, calendar) {
  const d = displayOpts();
  const lines = [];
  const hasLink = d.link && (node.linkedSubPage || node.linkedMainNode);
  const linkMark = hasLink ? ' 🔗' : '';

  if (d.id) lines.push(`${node.id}${linkMark}`);
  else if (linkMark) lines.push(linkMark.trim());

  if (d.title && node.title) {
    lines.push(node.title.length > 22 ? node.title.slice(0, 20) + '…' : node.title);
  }
  if (d.minMax) {
    if (state.estimationMode === 'pert') {
      const likely = node.likely != null ? node.likely : (Number(node.min) + Number(node.max)) / 2;
      lines.push(`O:${node.min} M:${fmt(likely)} P:${node.max}`);
    } else {
      lines.push(`Min:${node.min}d Max:${node.max}d`);
    }
  }
  if (d.dates && calendar.enabled) {
    lines.push(`${calendar.formatOffset(metric.ES)} → ${calendar.formatFinish(metric.ES, metric.duration)}`);
  }
  if (d.esEf) lines.push(`ES:${fmt(metric.ES)} EF:${fmt(metric.EF)}`);
  if (d.lsLf) lines.push(`LS:${fmt(metric.LS)} LF:${fmt(metric.LF)}`);
  if (d.slack) lines.push(`Slack:${fmt(metric.slack)}`);
  if (d.progress) lines.push(`${Math.round(node.progress || 0)}%`);

  if (d.criticality) {
    const index = getCriticality()?.get(node.id);
    if (index != null) lines.push(`Crit:${Math.round(index * 100)}%`);
  }

  if (d.rollup) {
    const entry = rollupForNode(node);
    if (entry) lines.push(`Sub:${fmtPercent(entry.share)}`);
  }

  if (d.tags) {
    const tags = tagsOf(node);
    if (tags.length) lines.push('🏷 ' + tags.join(' '));
  }

  return lines.join('\n') || node.id;
}

/**
 * Activity-on-node notation: a fixed grid where each figure always sits in the
 * same position, so you read across tasks by location rather than parsing each
 * label. Opt-in — circles remain the default.
 */
function buildBoxLabel(node, metric, calendar) {
  const d = displayOpts();
  const title = node.title && node.title.length > 18 ? node.title.slice(0, 17) + '…' : (node.title || '');
  const lines = [
    `${pad(fmt(metric.ES), 5)}│${pad(fmt(metric.duration), 6)}│${pad(fmt(metric.EF), 5)}`,
    '─────┼──────┼─────',
    center(`${node.id}${d.title && title ? ' ' + title : ''}`, 18),
    '─────┼──────┼─────',
    `${pad(fmt(metric.LS), 5)}│${pad(fmt(metric.slack), 6)}│${pad(fmt(metric.LF), 5)}`
  ];
  if (d.dates && calendar.enabled) {
    lines.push(`${calendar.formatOffset(metric.ES)} → ${calendar.formatFinish(metric.ES, metric.duration)}`);
  }
  if (d.progress) lines.push(center(`${Math.round(node.progress || 0)}%`, 18));
  return lines.join('\n');
}

function pad(text, width) {
  const s = String(text);
  const total = Math.max(0, width - s.length);
  const left = Math.floor(total / 2);
  return ' '.repeat(left) + s + ' '.repeat(total - left);
}

const center = pad;

function nodeFontSize() {
  const d = displayOpts();
  const count = ['title', 'minMax', 'esEf', 'lsLf', 'slack', 'progress', 'dates', 'criticality', 'rollup', 'tags']
    .filter(k => d[k]).length;
  if (count >= 5) return 9;
  if (count >= 4) return 10;
  if (count >= 2) return 11;
  return 12;
}

// ─── Node dimensions ───────────────────────────────────────
//
// The layouts space columns and rows by how much room a task actually takes.
// vis-network knows that exactly, but only once it has drawn, so an estimate
// from the label is recorded as each node is built and stands in until then.

let sizeEstimates = new Map();

function estimateNodeSize(label, boxes) {
  const lines = String(label).split('\n');
  const fontSize = nodeFontSize();
  if (boxes) {
    const widest = Math.max(...lines.map(line => line.length));
    return {
      width: Math.max(150, widest * fontSize * 0.62) + 20,
      height: lines.length * (fontSize + 4) + 20
    };
  }
  const diameter = Math.min(58, 32 + lines.length * 4) * 2;
  return { width: diameter, height: diameter };
}

/**
 * Measured width and height of a task on the canvas, falling back to the
 * estimate recorded when its label was built.
 */
export function nodeSizeOf(id) {
  if (network) {
    try {
      const box = network.getBoundingBox(id);
      const width = box ? box.right - box.left : 0;
      const height = box ? box.bottom - box.top : 0;
      if (width > 0 && height > 0) return { width, height };
    } catch {
      // not drawn yet — fall through to the estimate
    }
  }
  return sizeEstimates.get(id) || null;
}

/** Milestone column offsets and widths, sized to the tasks in each column. */
export function columnLayout(diagram) {
  return columnGeometry((diagram || currentDiagram()).milestones || [], nodeSizeOf);
}

// ─── Styling ───────────────────────────────────────────────
//
// Split out from data construction so hover, selection, and connect
// highlighting can restyle individual items through DataSet.update() instead
// of rebuilding every node and edge in the diagram.

/**
 * Border encodes schedule risk and interaction state, in priority order.
 * Status lives on the fill instead, so the two never overwrite each other.
 */
function borderFor(node, isCritical, isNearCritical, flags) {
  if (flags.isSource) return '#3b82f6';
  if (flags.isSelected) return SELECTED_COLOR;
  if (flags.isHit) return SEARCH_COLOR;
  // Late outranks critical: everything late is critical too, and "past its
  // deadline" is the more urgent of the two things to say.
  if (flags.isLate) return LATE_COLOR;
  if (isCritical) return CRITICAL_COLOR;
  if (isNearCritical) return NEAR_CRITICAL_COLOR;
  if (flags.inTrace) return TRACE_COLOR;
  return palette.nodeBorder;
}

/** Status as a translucent wash over the node background. */
function fillFor(node, dimmed) {
  const status = STATUS_COLORS[node.status];
  if (!status || node.status === 'not_started') return palette.nodeBg;
  return mix(palette.nodeBg, status, dimmed ? 0.08 : 0.22);
}

function mix(base, tint, amount) {
  const a = hexToRgb(base);
  const b = hexToRgb(tint);
  if (!a || !b) return base;
  const c = [0, 1, 2].map(i => Math.round(a[i] + (b[i] - a[i]) * amount));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex));
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
}

function nodeStyle(node, isCritical, isNearCritical, isLate = false) {
  const tracing = traceIds.size > 0;
  const inTrace = tracing && traceIds.has(node.id);
  // Dimmed by a hover trace it is outside, or by a tag filter it does not match.
  const dimmed = (tracing && !inTrace) || filteredByTags(node);
  const flags = {
    inTrace,
    isLate,
    isHit: matchesSearch(node),
    isSelected: selectedIds.includes(node.id),
    isSource: connectMode && connectSource === node.id
  };

  const border = borderFor(node, isCritical, isNearCritical, flags);
  const background = flags.isSource ? mix(palette.nodeBg, '#3b82f6', 0.3) : fillFor(node, dimmed);
  const emphasised = flags.isSelected || flags.isHit || flags.isSource || inTrace;

  return {
    opacity: dimmed ? 0.25 : 1,
    borderWidth: emphasised ? 4 : (isCritical || isNearCritical ? 3 : 2),
    color: {
      background,
      border,
      highlight: { background: mix(background, palette.edgeHighlight, 0.15), border },
      hover: { background: mix(background, palette.edgeHighlight, 0.12), border }
    },
    shadow: emphasised
      ? { enabled: true, color: border, size: 18, x: 0, y: 0 }
      : isLate
        ? { enabled: true, color: LATE_COLOR, size: 20, x: 0, y: 0 }
        : isCritical
          ? { enabled: true, color: CRITICAL_COLOR, size: 16, x: 0, y: 0 }
          : isNearCritical
            ? { enabled: true, color: NEAR_CRITICAL_COLOR, size: 12, x: 0, y: 0 }
            : { enabled: true, color: palette.shadow, size: 8, x: 0, y: 2 },
    font: {
      color: dimmed ? palette.nodeTextDim : palette.nodeText,
      size: nodeFontSize(),
      face: getState().nodeShape === 'box' ? 'monospace' : 'system-ui, sans-serif',
      multi: false,
      align: 'center'
    }
  };
}

function edgeStyle(link, metrics, criticalIds) {
  const tracing = traceIds.size > 0;
  const inTrace = tracing && traceIds.has(link.id) && traceIds.has(link.to);
  const dimmed = tracing && !inTrace;
  const critical = criticalIds.has(link.id) && criticalIds.has(link.to) &&
    isDrivingLink(link, metrics);
  const selected = selectedEdgeId === edgeId(link);

  return {
    color: {
      color: selected ? SELECTED_COLOR : inTrace ? TRACE_COLOR : (critical ? CRITICAL_COLOR : palette.edge),
      opacity: dimmed ? 0.15 : 1,
      highlight: critical ? CRITICAL_COLOR : palette.edgeHighlight,
      hover: critical ? CRITICAL_COLOR : palette.edgeHighlight
    },
    width: selected || inTrace ? 3.5 : (critical ? 3 : 1.5),
    // Non finish-to-start relations are drawn dashed: they behave differently
    // and should not be mistaken for ordinary sequence links.
    dashes: link.type === 'FS' ? false : [6, 4],
    label: edgeLabel(link),
    font: {
      size: 10,
      color: palette.nodeTextDim,
      strokeWidth: 3,
      strokeColor: palette.canvasBg,
      align: 'horizontal'
    },
    shadow: critical || inTrace
      ? { enabled: true, color: inTrace ? TRACE_COLOR : CRITICAL_COLOR, size: 10 }
      : false
  };
}

function edgeLabel(link) {
  const parts = [];
  if (link.type !== 'FS') parts.push(link.type);
  if (link.lag) parts.push(`${link.lag > 0 ? '+' : ''}${link.lag}d`);
  return parts.join(' ');
}

export function edgeId(link) {
  return `${link.id}->${link.to}`;
}

// ─── Data construction ─────────────────────────────────────

export function buildVisData() {
  const state = getState();
  const { metrics, criticalIds, nearCritical, nodes, links, calendar } = schedule();
  const diagram = currentDiagram();
  const boxes = state.nodeShape === 'box';
  const visNodes = [];
  sizeEstimates = new Map();

  nodes.forEach(node => {
    const metric = metrics[node.id];
    const label = boxes
      ? buildBoxLabel(node, metric, calendar)
      : buildNodeLabel(node, metric, state, calendar);
    const lineCount = label.split('\n').length;
    const found = findNode(node.id);
    const criticality = getCriticality()?.get(node.id);
    const rollup = rollupForNode(node);
    sizeEstimates.set(node.id, estimateNodeSize(label, boxes));

    visNodes.push({
      id: node.id,
      label,
      x: node.position?.x ?? 0,
      y: node.position?.y ?? 0,
      fixed: false,
      shape: boxes ? 'box' : 'circle',
      ...(boxes
        ? { margin: 8, widthConstraint: { minimum: 150 } }
        : { size: Math.min(58, 32 + lineCount * 4) }),
      ...nodeStyle(node, criticalIds.has(node.id), nearCritical.has(node.id), metric.slack < 0),
      title: [
        `${node.title}`,
        node.description || '',
        linkTooltip(node).trim(),
        `Status: ${node.status || 'not_started'} · ${Math.round(node.progress || 0)}%`,
        node.assignee ? `Assigned to: ${node.assignee}` : '',
        tagsOf(node).length ? `Tags: ${tagsOf(node).join(', ')}` : '',
        `Milestone: ${found?.milestone.title || '—'}`,
        `Duration used: ${fmt(metric.duration)}d`,
        node.mustFinishBy != null
          ? `Must finish by: ${calendar.enabled ? calendar.formatOffset(node.mustFinishBy) : `day ${fmt(node.mustFinishBy)}`}`
          : '',
        metric.slack < 0 ? `LATE by ${fmt(-metric.slack)}d — past its deadline` : '',
        state.activeView !== 'main' && isProjectCritical(state.activeView, node.id)
          ? 'On the critical path of the whole project'
          : '',
        calendar.enabled
          ? `Dates: ${calendar.formatOffset(metric.ES)} → ${calendar.formatFinish(metric.ES, metric.duration)}`
          : '',
        criticality != null ? `Critical in ${Math.round(criticality * 100)}% of simulated runs` : '',
        rollup
          ? `Sub-path: ${fmtPercent(rollup.share)} of the project` +
            (rollup.criticalShare > 0 ? `, ${fmtPercent(rollup.criticalShare)} of the critical path` : '') +
            (rollup.progress != null ? ` · ${fmtPercent(rollup.progress / 100)} complete` : '')
          : ''
      ].filter(Boolean).join('\n')
    });
  });

  // Milestone headers are laid out after the tasks, so each column can be
  // sized to what is actually in it.
  if (state.layoutMode === 'milestone') {
    const { columns } = columnLayout(diagram);
    (diagram.milestones || []).forEach((ms, i) => {
      const lane = palette.lanes[i % palette.lanes.length];
      const column = columns[i];
      visNodes.push({
        id: `${LANE_ID_PREFIX}${ms.id}`,
        label: ms.title,
        x: column ? column.centre : 0,
        y: -220,
        fixed: true,
        shape: 'box',
        margin: 10,
        widthConstraint: { maximum: Math.max(120, (column?.width || 0) - 40) },
        font: { color: palette.laneText, size: 13, face: 'system-ui, sans-serif', bold: true },
        color: {
          background: lane,
          border: palette.laneBorder,
          highlight: { background: lane, border: palette.edgeHighlight },
          hover: { background: lane, border: palette.edgeHighlight }
        },
        borderWidth: 1,
        shadow: false,
        chosen: false,
        physics: false
      });
    });
  }

  const visEdges = links
    .filter(link => metrics[link.id])
    .map(link => ({
      id: edgeId(link),
      from: link.id,
      to: link.to,
      arrows: { to: { enabled: true, scaleFactor: 0.7 } },
      smooth: { type: 'cubicBezier', forceDirection: 'horizontal', roundness: 0.4 },
      ...edgeStyle(link, metrics, criticalIds)
    }));

  const ghosts = buildGhosts(nodes);
  visNodes.push(...ghosts.nodes);
  visEdges.push(...ghosts.edges);
  ghostNote = ghosts.note;

  return { visNodes, visEdges };
}

/**
 * Why the canvas is not showing what you asked it to, when that is the case:
 * the branch limit stopped it, or nothing is selected to show one for. Silently
 * drawing a subset would be the worst of the options — the diagram would look
 * complete and be wrong.
 */
export function getGhostNote() {
  return ghostNote;
}

/**
 * Linked sub-paths drawn in place, hanging below the Main task that stands for
 * each one.
 *
 * A linked task previously showed a marker and a share, and told you nothing
 * about the shape of the work behind it — you had to leave the page to see it,
 * and then you could no longer see where it sat. These are that work, in
 * context, drawn faintly enough to stay background.
 *
 * They are decoration, not project data: the sub-page owns them, they take no
 * part in this page's schedule, and every interaction handler refuses them.
 * The only thing a ghost does is take you to its page.
 */
function buildGhosts(mainNodes) {
  const state = getState();
  const mode = displayOpts().ghosts || 'off';
  const empty = { nodes: [], edges: [], note: null };
  // Only Main links sub-paths, and only its own tasks can stand for one.
  if (mode === 'off' || state.activeView !== 'main') return empty;

  const wanted = mainNodes.filter(n => {
    if (!n.linkedSubPage || !state.diagrams[n.linkedSubPage]) return false;
    return mode === 'all' || selectedIds.includes(n.id);
  });
  if (!wanted.length) {
    return mode === 'selected'
      ? { ...empty, note: 'Select a linked task to see its sub-path here' }
      : empty;
  }

  const nodes = [];
  const edges = [];
  let note = null;

  for (const parent of wanted) {
    const pageId = parent.linkedSubPage;
    const subNodes = nodesOf(state.diagrams[pageId]);
    if (!subNodes.length) continue;

    // Drawing every branch at once stops being a diagram somewhere past a few
    // hundred nodes. Rather than freeze, stop and say where it stopped.
    if (nodes.length + subNodes.length > GHOST_MAX_NODES) {
      note = `Showing ${nodes.length} of the linked tasks — switch to "selected" for the rest`;
      break;
    }

    // The sub-page's own schedule, for colouring. Roll-up is deliberately not
    // threaded through: a ghost shows that page as that page reads it.
    const { metrics: subMetrics, criticalIds: subCritical, graph } =
      computeCPM(subNodes, { mode: state.estimationMode });

    const { positions } = ghostLayout(subNodes, parent.position || { x: 0, y: 0 }, {
      metrics: subMetrics, graph
    });

    subNodes.forEach(sub => {
      const at = positions[sub.id] || { x: 0, y: 0 };
      const m = subMetrics[sub.id] || {};
      nodes.push({
        id: ghostId(pageId, sub.id),
        label: `${sub.id}\n${fmt(m.duration)}d`,
        x: at.x,
        y: at.y,
        fixed: true,
        physics: false,
        chosen: false,
        shape: 'circle',
        size: 22,
        ...ghostStyle(subCritical.has(sub.id)),
        title: [
          `${sub.id} — ${sub.title}`,
          `On ${pageTitle(pageId)}, under ${parent.id}`,
          `${fmt(m.ES)} → ${fmt(m.EF)} on its own page · ${fmt(m.duration)}d`,
          subCritical.has(sub.id) ? 'Critical on that page' : '',
          'Click to open the sub-path'
        ].filter(Boolean).join('\n')
      });
    });

    // The sub-path's own dependencies, so the branch reads as a network rather
    // than a column of unrelated dots.
    subNodes.forEach(sub => {
      dependenciesOf(sub).forEach(dep => {
        if (!subMetrics[dep.id]) return;
        edges.push({
          id: `${ghostId(pageId, dep.id)}->${ghostId(pageId, sub.id)}`,
          from: ghostId(pageId, dep.id),
          to: ghostId(pageId, sub.id),
          arrows: { to: { enabled: true, scaleFactor: 0.4 } },
          smooth: { type: 'cubicBezier', forceDirection: 'vertical', roundness: 0.4 },
          ...ghostEdgeStyle(false)
        });
      });
    });

    // And the tether from the Main task down into its branch, to the tasks that
    // start it — which is where the work actually begins.
    subNodes
      .filter(sub => !dependenciesOf(sub).some(d => subMetrics[d.id]))
      .forEach(sub => {
        edges.push({
          id: `${parent.id}=>${ghostId(pageId, sub.id)}`,
          from: parent.id,
          to: ghostId(pageId, sub.id),
          arrows: { to: { enabled: true, scaleFactor: 0.4 } },
          smooth: { type: 'cubicBezier', forceDirection: 'vertical', roundness: 0.5 },
          ...ghostEdgeStyle(true)
        });
      });
  }

  return { nodes, edges, note };
}

/** Faint, dashed, and unmistakably not part of this page's schedule. */
function ghostStyle(isCritical) {
  const border = isCritical ? CRITICAL_COLOR : palette.nodeBorder;
  return {
    borderWidth: 1,
    shapeProperties: { borderDashes: [3, 3] },
    shadow: false,
    color: {
      background: mix(palette.nodeBg, palette.canvasBg, 0.55),
      border: mix(border, palette.canvasBg, 0.45),
      highlight: { background: mix(palette.nodeBg, palette.canvasBg, 0.35), border },
      hover: { background: mix(palette.nodeBg, palette.canvasBg, 0.35), border }
    },
    font: {
      color: mix(palette.nodeText, palette.canvasBg, 0.4),
      size: 9,
      face: 'ui-monospace, monospace',
      multi: false
    }
  };
}

function ghostEdgeStyle(isTether) {
  const colour = mix(palette.edge, palette.canvasBg, isTether ? 0.3 : 0.45);
  return {
    width: 1,
    dashes: isTether ? [2, 4] : [3, 3],
    color: { color: colour, highlight: colour, hover: colour, opacity: 1 },
    font: { size: 0 },
    selectionWidth: 0,
    chosen: false
  };
}

/** Cache what the draw callbacks need so they never touch state per frame. */
function rebuildDrawCache() {
  const state = getState();
  const criticality = getCriticality();
  ringCache = state.nodeShape === 'box' ? [] : allNodes().map(n => {
    const visNode = nodesDS.get(n.id);
    return {
      id: n.id,
      radius: (visNode?.size || 40) + 6,
      progress: Math.max(0, Math.min(100, Number(n.progress) || 0)) / 100,
      color: STATUS_COLORS[n.status] || palette.nodeBorder,
      criticality: criticality?.get(n.id) ?? null
    };
  });

  laneCache = state.layoutMode === 'milestone' ? columnLayout().columns : [];
}

export function applyVisData() {
  palette = paletteFor(getState().theme);
  const { visNodes, visEdges } = buildVisData();
  nodesDS.clear();
  edgesDS.clear();
  nodesDS.add(visNodes);
  edgesDS.add(visEdges);
  rebuildDrawCache();
  if (network) {
    network.setOptions({ nodes: { shape: getState().nodeShape === 'box' ? 'box' : 'circle' } });
  }
  drawMinimap();
}

/**
 * Redraw only the ghosts, leaving the real network alone.
 *
 * In "selected" mode the ghosts follow the selection, and rebuilding everything
 * to achieve that does not work: clearing the DataSet drops the selection,
 * which fires a deselect, which asks for another rebuild — by which time there
 * is nothing selected and the ghosts that prompted it have gone. Touching only
 * the ghost rows sidesteps that entirely, and is far cheaper besides.
 */
export function refreshGhosts() {
  if (!nodesDS || !edgesDS) return;
  palette = paletteFor(getState().theme);

  const staleNodes = nodesDS.getIds().filter(isGhostId);
  const staleEdges = edgesDS.getIds().filter(id => String(id).includes(GHOST_ID_PREFIX));
  if (staleNodes.length) nodesDS.remove(staleNodes);
  if (staleEdges.length) edgesDS.remove(staleEdges);

  const { nodes, edges, note } = buildGhosts(allNodes());
  if (nodes.length) nodesDS.add(nodes);
  if (edges.length) edgesDS.add(edges);
  ghostNote = note;
  drawMinimap();
}

// ─── Drawing overlays ──────────────────────────────────────

function drawLanes(ctx) {
  const count = laneCache.length;
  if (count < 1) return;
  const scale = network.getScale() || 1;

  // Bands are drawn in canvas coordinates so they stay locked to the task
  // columns under pan and zoom. A DOM overlay cannot do this — it drifted out
  // of alignment as soon as the view moved. Each band takes its own column's
  // width, so a milestone of wide boxes is not clipped by a neighbour's.
  ctx.save();
  ctx.fillStyle = palette.laneBand;
  for (let i = 0; i < count; i += 2) {
    ctx.fillRect(laneCache[i].left, -2000, laneCache[i].width, 4000);
  }
  ctx.strokeStyle = palette.laneDivider;
  ctx.lineWidth = 1.5 / scale;
  ctx.setLineDash([6, 6]);
  for (let i = 0; i < count - 1; i++) {
    const x = laneCache[i].left + laneCache[i].width;
    ctx.beginPath();
    ctx.moveTo(x, -2000);
    ctx.lineTo(x, 2000);
    ctx.stroke();
  }
  ctx.restore();
}

function drawProgressRings(ctx) {
  if (!ringCache.length) return;
  const positions = network.getPositions();
  const lineWidth = 3 / (network.getScale() || 1);

  ctx.save();
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  for (const entry of ringCache) {
    const pos = positions[entry.id];
    if (!pos) continue;
    ctx.strokeStyle = palette.ringTrack;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, entry.radius, 0, Math.PI * 2);
    ctx.stroke();
    if (entry.progress > 0) {
      ctx.strokeStyle = entry.color;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, entry.radius, -Math.PI / 2, -Math.PI / 2 + entry.progress * Math.PI * 2);
      ctx.stroke();
    }
    // Simulated criticality as a second, outer arc.
    if (entry.criticality != null && entry.criticality > 0) {
      ctx.strokeStyle = CRITICAL_COLOR;
      ctx.globalAlpha = 0.75;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, entry.radius + 5, -Math.PI / 2, -Math.PI / 2 + entry.criticality * Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
  ctx.restore();
}

/** Rubber-band line from the chosen predecessor to the pointer. */
function drawConnectPreview(ctx) {
  if (!connectMode || !connectSource || !connectPointer) return;
  const from = network.getPositions([connectSource])[connectSource];
  if (!from) return;
  ctx.save();
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 2 / (network.getScale() || 1);
  ctx.setLineDash([8, 6]);
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(connectPointer.x, connectPointer.y);
  ctx.stroke();
  ctx.restore();
}

// ─── Minimap ───────────────────────────────────────────────

/**
 * An overview of the whole network with the current viewport marked. The
 * canvas has no navigation buttons and no other way to recover once you have
 * panned away from the tasks.
 */
export function drawMinimap() {
  const canvas = $('minimap');
  if (!canvas || !network) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = MINIMAP_WIDTH * dpr;
  canvas.height = MINIMAP_HEIGHT * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, MINIMAP_WIDTH, MINIMAP_HEIGHT);

  const nodes = allNodes();
  if (!nodes.length) {
    canvas.classList.add('hidden');
    return;
  }
  canvas.classList.remove('hidden');

  const positions = network.getPositions();
  const pts = nodes.map(n => positions[n.id]).filter(Boolean);
  if (!pts.length) return;

  const pad = 60;
  const minX = Math.min(...pts.map(p => p.x)) - pad;
  const maxX = Math.max(...pts.map(p => p.x)) + pad;
  const minY = Math.min(...pts.map(p => p.y)) - pad;
  const maxY = Math.max(...pts.map(p => p.y)) + pad;
  const scale = Math.min(MINIMAP_WIDTH / (maxX - minX), MINIMAP_HEIGHT / (maxY - minY));
  const offX = (MINIMAP_WIDTH - (maxX - minX) * scale) / 2;
  const offY = (MINIMAP_HEIGHT - (maxY - minY) * scale) / 2;
  const project = p => ({ x: (p.x - minX) * scale + offX, y: (p.y - minY) * scale + offY });

  const { criticalIds } = schedule();
  ctx.fillStyle = palette.canvasBg;
  ctx.fillRect(0, 0, MINIMAP_WIDTH, MINIMAP_HEIGHT);

  nodes.forEach(n => {
    const p = positions[n.id];
    if (!p) return;
    const { x, y } = project(p);
    ctx.fillStyle = criticalIds.has(n.id) ? CRITICAL_COLOR : palette.edge;
    ctx.beginPath();
    ctx.arc(x, y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  });

  // Viewport rectangle.
  const container = $('network-canvas');
  const view = network.getViewPosition();
  const zoom = network.getScale() || 1;
  const halfW = container.clientWidth / (2 * zoom);
  const halfH = container.clientHeight / (2 * zoom);
  const tl = project({ x: view.x - halfW, y: view.y - halfH });
  const br = project({ x: view.x + halfW, y: view.y + halfH });
  // Zoomed out far enough, the viewport is larger than the whole graph and the
  // rectangle would spill outside the map.
  const clampX = v => Math.min(MINIMAP_WIDTH - 1, Math.max(1, v));
  const clampY = v => Math.min(MINIMAP_HEIGHT - 1, Math.max(1, v));
  ctx.strokeStyle = SEARCH_COLOR;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(
    clampX(tl.x), clampY(tl.y),
    clampX(br.x) - clampX(tl.x), clampY(br.y) - clampY(tl.y)
  );

  canvas._project = { minX, minY, scale, offX, offY };
}

// ─── Hover trace ───────────────────────────────────────────
//
// Restyles only the nodes and edges whose appearance changes. Previously this
// path re-ran the full sync — clearing both DataSets, re-rendering the bottom
// panel and Gantt from HTML strings, and rescanning the document for icons —
// on every single mouse move between tasks.

function restyleAll() {
  const { metrics, criticalIds, nearCritical, nodes, links } = schedule();
  nodesDS.update(nodes.map(n => ({
    id: n.id,
    ...nodeStyle(n, criticalIds.has(n.id), nearCritical.has(n.id), metrics[n.id]?.slack < 0)
  })));
  edgesDS.update(
    links.filter(l => metrics[l.id]).map(l => ({ id: edgeId(l), ...edgeStyle(l, metrics, criticalIds) }))
  );
}

function setTrace(ids) {
  const same = ids.size === traceIds.size && [...ids].every(id => traceIds.has(id));
  if (same) return;
  traceIds = ids;
  restyleAll();
}

export function clearTrace() {
  if (!traceIds.size) return;
  traceIds = new Set();
  restyleAll();
}

export function refreshHighlights() {
  restyleAll();
}

// ─── Connect mode ──────────────────────────────────────────

export function isConnectMode() {
  return connectMode;
}

export function setConnectMode(on) {
  if (connectMode === on && !connectSource) return;
  const changed = connectMode !== on;
  connectMode = on;
  connectSource = null;
  connectPointer = null;

  const btn = $('btn-connect');
  const hint = $('connect-hint');
  if (btn) {
    btn.classList.toggle('tool-btn-connect', on);
    btn.setAttribute('aria-pressed', String(on));
  }
  if (hint) hint.classList.toggle('hidden', !on);

  if (network) {
    network.setOptions({ interaction: { dragNodes: !on, hover: true } });
    network.redraw();
  }
  if (changed || !on) restyleAll();
}

function addDependency(fromId, toId) {
  if (isSyntheticId(fromId) || isSyntheticId(toId)) return;
  const found = findNode(toId);
  if (!found) return;

  if (dependenciesOf(found.node).some(d => d.id === fromId)) {
    toast('Dependency already exists', 'info');
    return;
  }
  if (wouldCreateCycle(fromId, toId, allNodes())) {
    toast(`Cycle detected: cannot connect ${fromId} → ${toId}`, 'error');
    return;
  }

  found.node.dependencies = [...(found.node.dependencies || []), { id: fromId, type: 'FS', lag: 0 }];
  handlers.onChange(`Connected ${fromId} → ${toId}`);
}

// ─── Init ──────────────────────────────────────────────────

export function initNetwork(container, callbacks) {
  handlers = callbacks;
  palette = paletteFor(getState().theme);
  nodesDS = new vis.DataSet([]);
  edgesDS = new vis.DataSet([]);

  network = new vis.Network(container, { nodes: nodesDS, edges: edgesDS }, {
    physics: { enabled: false },
    interaction: {
      hover: true,
      multiselect: true,
      navigationButtons: false,
      keyboard: false,
      selectConnectedEdges: false
    },
    manipulation: { enabled: false, initiallyActive: false },
    edges: { selectionWidth: 2, hoverWidth: 1.5 },
    nodes: { chosen: true }
  });

  network.on('beforeDrawing', drawLanes);
  network.on('afterDrawing', ctx => {
    drawProgressRings(ctx);
    drawConnectPreview(ctx);
  });

  network.on('hoverNode', params => {
    if (connectMode || isSyntheticId(params.node)) return;
    setTrace(traceFrom(params.node, allNodes()));
  });
  network.on('blurNode', clearTrace);

  // Rubber-band preview while choosing a successor.
  container.addEventListener('pointermove', event => {
    if (!connectMode || !connectSource) return;
    const rect = container.getBoundingClientRect();
    connectPointer = network.DOMtoCanvas({
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
    });
    network.redraw();
  });

  network.on('dragEnd', params => {
    if (!params.nodes.length) return;
    let moved = false;
    params.nodes.forEach(id => {
      if (isSyntheticId(id)) return;
      const pos = network.getPositions([id])[id];
      const found = findNode(id);
      if (found && pos) {
        found.node.position = { x: pos.x, y: pos.y };
        moved = true;
      }
    });
    if (!moved) return;
    // A drag is a state change like any other, so it belongs in the history.
    if (getState().layoutMode !== 'free') {
      getState().layoutMode = 'free';
      handlers.onLayoutModeChange();
    }
    handlers.onPositionsChanged();
  });

  network.on('selectNode', params => {
    selectedIds = params.nodes.filter(id => !isSyntheticId(id));
    selectedEdgeId = null;
    handlers.onSelectionChange(selectedIds);
    syncGhostsToSelection();
    restyleAll();
  });
  network.on('selectEdge', params => {
    if (params.nodes.length) return;
    selectedEdgeId = params.edges[0] || null;
    selectedIds = [];
    handlers.onSelectionChange([]);
    restyleAll();
  });
  network.on('deselectNode', () => {
    selectedIds = [];
    handlers.onSelectionChange([]);
    syncGhostsToSelection();
    restyleAll();
  });
  network.on('deselectEdge', () => {
    selectedEdgeId = null;
    restyleAll();
  });

  network.on('doubleClick', params => {
    if (connectMode) return;
    if (params.nodes.length) {
      const id = params.nodes[0];
      if (isSyntheticId(id)) return;
      const found = findNode(id);
      const evt = params.event.srcEvent;
      if ((evt.altKey || evt.metaKey) && found && handlers.onFollowLink(found.node)) return;
      handlers.onEditNode(id);
    } else if (params.edges.length) {
      handlers.onEditEdge(params.edges[0]);
    } else {
      handlers.onAddNodeAt(params.pointer.canvas.x, params.pointer.canvas.y);
    }
  });

  network.on('click', params => {
    if (!connectMode) {
      // The one thing a ghost does: take you to the page it came from, with
      // the task it stands for already selected.
      const ghost = params.nodes.length === 1 ? parseGhostId(params.nodes[0]) : null;
      if (ghost) {
        network.unselectAll();
        handlers.onOpenGhost(ghost.pageId, ghost.nodeId);
        return;
      }
      const evt = params.event.srcEvent;
      if (params.nodes.length === 1 && (evt.altKey || evt.metaKey)) {
        const id = params.nodes[0];
        if (isSyntheticId(id)) return;
        const found = findNode(id);
        if (found) handlers.onFollowLink(found.node);
      }
      return;
    }

    if (!params.nodes.length) {
      if (connectSource) {
        connectSource = null;
        connectPointer = null;
        restyleAll();
        toast('Connection cancelled', 'info');
      }
      return;
    }

    const clicked = params.nodes[0];
    if (isSyntheticId(clicked)) return;

    if (!connectSource) {
      connectSource = clicked;
      restyleAll();
      toast(`From ${clicked} — select the successor task`, 'info');
    } else if (connectSource === clicked) {
      connectSource = null;
      connectPointer = null;
      restyleAll();
      toast('Source cleared', 'info');
    } else {
      const from = connectSource;
      connectSource = null;
      connectPointer = null;
      addDependency(from, clicked);
    }
  });

  network.on('zoom', drawMinimap);
  network.on('dragging', drawMinimap);
  network.on('animationFinished', drawMinimap);

  return network;
}

// ─── View controls ─────────────────────────────────────────

export function fitView(duration = 400) {
  if (!network) return;
  window.setTimeout(() => {
    network.fit({ animation: { duration, easingFunction: 'easeInOutQuad' } });
    window.setTimeout(drawMinimap, duration + 30);
  }, 50);
}

/** Canvas coordinates at the middle of what the user is currently looking at. */
export function viewCentre() {
  if (!network) return { x: 0, y: 0 };
  const position = network.getViewPosition();
  return { x: Math.round(position.x), y: Math.round(position.y) };
}

export function zoomBy(factor) {
  if (!network) return;
  network.moveTo({
    scale: Math.min(4, Math.max(0.1, (network.getScale() || 1) * factor)),
    animation: { duration: 180, easingFunction: 'easeInOutQuad' }
  });
  window.setTimeout(drawMinimap, 220);
}

export function focusNode(id, scale = 1.2) {
  if (!network) return;
  window.setTimeout(() => {
    try {
      network.selectNodes([id]);
      selectedIds = [id];
      network.focus(id, { scale, animation: { duration: 400, easingFunction: 'easeInOutQuad' } });
      handlers.onSelectionChange?.(selectedIds);
      restyleAll();
    } catch {
      // node may have been removed between scheduling and running
    }
  }, 120);
}

export function redraw() {
  if (network) {
    network.redraw();
    drawMinimap();
  }
}

export function savePositionsFromNetwork() {
  if (!network) return;
  const nodes = allNodes();
  if (!nodes.length) return;
  const positions = network.getPositions(nodes.map(n => n.id));
  nodes.forEach(n => {
    if (positions[n.id]) n.position = { x: positions[n.id].x, y: positions[n.id].y };
  });
}

/**
 * Render the entire network to an off-screen image at higher resolution.
 * The visible canvas only ever holds the current viewport, so exporting it
 * directly produced a cropped screenshot at whatever zoom happened to be set.
 */
export function renderFullImage(scaleFactor = 2) {
  if (!network) return null;
  const container = $('network-canvas');
  const source = container.querySelector('canvas');
  if (!source) return null;

  const previousPosition = network.getViewPosition();
  const previousScale = network.getScale();

  network.fit({ animation: false });
  network.redraw();

  const out = document.createElement('canvas');
  out.width = source.width * scaleFactor;
  out.height = source.height * scaleFactor;
  const ctx = out.getContext('2d');
  ctx.fillStyle = palette.canvasBg;
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, out.width, out.height);

  network.moveTo({ position: previousPosition, scale: previousScale, animation: false });
  network.redraw();

  return out;
}
