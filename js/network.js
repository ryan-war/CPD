// vis-network canvas: data construction, drawing overlays, and interaction.

import {
  CRITICAL_COLOR, NODE_BG, NODE_BORDER, EDGE_COLOR, TRACE_COLOR, SEARCH_COLOR,
  LANE_COLORS, COLUMN_GAP, LANE_ID_PREFIX, STATUS_COLORS, isLaneId
} from './config.js';
import { $, toast } from './dom.js';
import { traceFrom, wouldCreateCycle } from './cpm.js';
import { schedule, fmt } from './schedule.js';
import {
  getState, currentDiagram, allNodes, findNode, displayOpts
} from './state.js';
import { linkTooltip } from './links.js';

let network = null;
let nodesDS = null;
let edgesDS = null;
let handlers = {};

let connectMode = false;
let connectSource = null;
let selectedNodeId = null;
let selectedEdgeId = null;
let searchQuery = '';
let traceIds = new Set();

// Snapshots used by the per-frame draw callbacks. Rebuilt on sync rather than
// read out of state on every animation frame, which is what the previous
// implementation did while panning and zooming.
let ringCache = [];
let laneCount = 0;

export function getNetwork() {
  return network;
}

export function getSelection() {
  return { nodeId: selectedNodeId, edgeId: selectedEdgeId };
}

export function clearSelection() {
  selectedNodeId = null;
  selectedEdgeId = null;
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
    (node.description || '').toLowerCase().includes(q);
}

// ─── Labels ────────────────────────────────────────────────

function buildNodeLabel(node, metric, mode) {
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
    if (mode === 'pert') {
      const likely = node.likely != null ? node.likely : (Number(node.min) + Number(node.max)) / 2;
      lines.push(`O:${node.min} M:${fmt(likely)} P:${node.max}`);
    } else {
      lines.push(`Min:${node.min}d Max:${node.max}d`);
    }
  }
  if (d.esEf) lines.push(`ES:${fmt(metric.ES)} EF:${fmt(metric.EF)}`);
  if (d.lsLf) lines.push(`LS:${fmt(metric.LS)} LF:${fmt(metric.LF)}`);
  if (d.slack) lines.push(`Slack:${fmt(metric.slack)}`);
  if (d.progress) lines.push(`${Math.round(node.progress || 0)}%`);

  return lines.join('\n') || node.id;
}

function nodeFontSize() {
  const d = displayOpts();
  const count = ['title', 'minMax', 'esEf', 'lsLf', 'slack', 'progress'].filter(k => d[k]).length;
  if (count >= 4) return 10;
  if (count >= 2) return 11;
  return 12;
}

// ─── Styling ───────────────────────────────────────────────
//
// Split out from data construction so hover and connect highlighting can
// restyle individual items through DataSet.update() instead of rebuilding
// every node and edge in the diagram.

function nodeStyle(node, isCritical) {
  const tracing = traceIds.size > 0;
  const inTrace = tracing && traceIds.has(node.id);
  const dimmed = tracing && !inTrace;
  const isHit = matchesSearch(node);
  const isSource = connectMode && connectSource === node.id;

  let border = isCritical ? CRITICAL_COLOR : (STATUS_COLORS[node.status] || NODE_BORDER);
  if (inTrace && !isCritical) border = TRACE_COLOR;
  if (isHit) border = SEARCH_COLOR;

  if (isSource) {
    return {
      opacity: 1,
      borderWidth: 4,
      color: {
        background: '#172554',
        border: '#3b82f6',
        highlight: { background: '#1e3a8a', border: '#60a5fa' },
        hover: { background: '#1e3a8a', border: '#60a5fa' }
      },
      shadow: { enabled: true, color: '#3b82f6', size: 16, x: 0, y: 0 },
      font: { color: '#f1f5f9', size: nodeFontSize(), face: 'system-ui, sans-serif', multi: true, align: 'center' }
    };
  }

  const accent = isHit ? SEARCH_COLOR : (isCritical ? CRITICAL_COLOR : '#94a3b8');
  return {
    opacity: dimmed ? 0.25 : 1,
    borderWidth: isHit || inTrace ? 4 : (isCritical ? 3 : 2),
    color: {
      background: NODE_BG,
      border,
      highlight: { background: '#334155', border: accent },
      hover: { background: '#334155', border: accent }
    },
    shadow: isHit
      ? { enabled: true, color: SEARCH_COLOR, size: 20, x: 0, y: 0 }
      : isCritical
        ? { enabled: true, color: CRITICAL_COLOR, size: 18, x: 0, y: 0 }
        : { enabled: true, color: 'rgba(0,0,0,0.4)', size: 8, x: 0, y: 2 },
    font: {
      color: dimmed ? '#64748b' : '#f1f5f9',
      size: nodeFontSize(),
      face: 'system-ui, sans-serif',
      multi: true,
      align: 'center',
      bold: { color: '#f1f5f9', size: nodeFontSize() + 2 }
    }
  };
}

function edgeStyle(fromId, toId, isCriticalEdge) {
  const tracing = traceIds.size > 0;
  const inTrace = tracing && traceIds.has(fromId) && traceIds.has(toId);
  const dimmed = tracing && !inTrace;
  return {
    color: {
      color: inTrace ? TRACE_COLOR : (isCriticalEdge ? CRITICAL_COLOR : EDGE_COLOR),
      opacity: dimmed ? 0.15 : 1,
      highlight: isCriticalEdge ? CRITICAL_COLOR : '#94a3b8',
      hover: isCriticalEdge ? CRITICAL_COLOR : '#94a3b8'
    },
    width: inTrace ? 3.5 : (isCriticalEdge ? 3 : 1.5),
    shadow: isCriticalEdge || inTrace
      ? { enabled: true, color: inTrace ? TRACE_COLOR : CRITICAL_COLOR, size: 10 }
      : false
  };
}

function isCriticalEdge(fromId, toId, metrics, criticalIds) {
  return criticalIds.has(fromId) && criticalIds.has(toId) &&
    Math.abs(metrics[toId].ES - metrics[fromId].EF) < 1e-6;
}

// ─── Data construction ─────────────────────────────────────

export function buildVisData() {
  const state = getState();
  const { metrics, criticalIds, nodes } = schedule();
  const diagram = currentDiagram();
  const visNodes = [];

  if (state.layoutMode === 'milestone') {
    (diagram.milestones || []).forEach((ms, i) => {
      const lane = LANE_COLORS[i % LANE_COLORS.length];
      visNodes.push({
        id: `${LANE_ID_PREFIX}${ms.id}`,
        label: ms.title,
        x: i * COLUMN_GAP,
        y: -200,
        fixed: true,
        shape: 'box',
        margin: 10,
        widthConstraint: { maximum: COLUMN_GAP - 40 },
        font: { color: '#cbd5e1', size: 13, face: 'system-ui, sans-serif', multi: false, bold: true },
        color: {
          background: lane,
          border: '#64748b',
          highlight: { background: lane, border: '#94a3b8' },
          hover: { background: lane, border: '#94a3b8' }
        },
        borderWidth: 1,
        shadow: false,
        chosen: false,
        physics: false
      });
    });
  }

  nodes.forEach(node => {
    const metric = metrics[node.id];
    const label = buildNodeLabel(node, metric, state.estimationMode);
    const lineCount = label.split('\n').length;
    const found = findNode(node.id);
    visNodes.push({
      id: node.id,
      label,
      x: node.position?.x ?? 0,
      y: node.position?.y ?? 0,
      fixed: false,
      shape: 'circle',
      size: Math.min(56, 32 + lineCount * 4),
      ...nodeStyle(node, criticalIds.has(node.id)),
      title: `${node.title}\n${node.description || ''}${linkTooltip(node)}\n` +
        `Status: ${node.status || 'not_started'} · ${Math.round(node.progress || 0)}%\n` +
        `Milestone: ${found?.milestone.title || '—'}\n` +
        `Duration used: ${fmt(metric.duration)}d`
    });
  });

  const visEdges = [];
  nodes.forEach(node => {
    (node.dependencies || []).forEach(dep => {
      if (!metrics[dep]) return;
      visEdges.push({
        id: `${dep}->${node.id}`,
        from: dep,
        to: node.id,
        arrows: { to: { enabled: true, scaleFactor: 0.7 } },
        smooth: { type: 'cubicBezier', forceDirection: 'horizontal', roundness: 0.4 },
        ...edgeStyle(dep, node.id, isCriticalEdge(dep, node.id, metrics, criticalIds))
      });
    });
  });

  return { visNodes, visEdges };
}

/** Cache what the draw callbacks need so they never touch state per frame. */
function rebuildDrawCache() {
  ringCache = allNodes().map(n => {
    const visNode = nodesDS.get(n.id);
    return {
      id: n.id,
      radius: (visNode?.size || 40) + 6,
      progress: Math.max(0, Math.min(100, Number(n.progress) || 0)) / 100,
      color: STATUS_COLORS[n.status] || NODE_BORDER
    };
  });
  laneCount = getState().layoutMode === 'milestone'
    ? (currentDiagram().milestones || []).length
    : 0;
}

export function applyVisData() {
  const { visNodes, visEdges } = buildVisData();
  nodesDS.clear();
  edgesDS.clear();
  nodesDS.add(visNodes);
  edgesDS.add(visEdges);
  rebuildDrawCache();
}

// ─── Drawing overlays ──────────────────────────────────────

function drawLanes(ctx) {
  const count = laneCount;
  if (count < 1) return;
  const scale = network.getScale() || 1;

  // Bands are drawn in canvas coordinates so they stay locked to the task
  // columns under pan and zoom. A DOM overlay cannot do this — it drifted out
  // of alignment as soon as the view moved.
  ctx.save();
  for (let i = 0; i < count; i++) {
    if (i % 2 === 0) {
      ctx.fillStyle = 'rgba(30, 41, 59, 0.35)';
      ctx.fillRect(i * COLUMN_GAP - COLUMN_GAP / 2, -2000, COLUMN_GAP, 4000);
    }
  }
  ctx.strokeStyle = 'rgba(100, 116, 139, 0.65)';
  ctx.lineWidth = 1.5 / scale;
  ctx.setLineDash([6, 6]);
  for (let i = 0; i < count - 1; i++) {
    const x = i * COLUMN_GAP + COLUMN_GAP / 2;
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
    ctx.strokeStyle = 'rgba(51, 65, 85, 0.9)';
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, entry.radius, 0, Math.PI * 2);
    ctx.stroke();
    if (entry.progress > 0) {
      ctx.strokeStyle = entry.color;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, entry.radius, -Math.PI / 2, -Math.PI / 2 + entry.progress * Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.restore();
}

// ─── Hover trace ───────────────────────────────────────────
//
// Restyles only the nodes and edges whose appearance changes. Previously this
// path re-ran the full sync — clearing both DataSets, re-rendering the bottom
// panel and Gantt from HTML strings, and rescanning the document for icons —
// on every single mouse move between tasks.

function restyleAll() {
  const { metrics, criticalIds, nodes } = schedule();
  const nodeUpdates = nodes.map(n => ({ id: n.id, ...nodeStyle(n, criticalIds.has(n.id)) }));
  const edgeUpdates = [];
  nodes.forEach(n => {
    (n.dependencies || []).forEach(dep => {
      if (!metrics[dep]) return;
      edgeUpdates.push({
        id: `${dep}->${n.id}`,
        ...edgeStyle(dep, n.id, isCriticalEdge(dep, n.id, metrics, criticalIds))
      });
    });
  });
  nodesDS.update(nodeUpdates);
  edgesDS.update(edgeUpdates);
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

  const btn = $('btn-connect');
  const hint = $('connect-hint');
  if (btn) {
    btn.classList.toggle('bg-blue-600', on);
    btn.classList.toggle('border-blue-500', on);
    btn.classList.toggle('text-white', on);
    btn.classList.toggle('bg-slate-900', !on);
    btn.setAttribute('aria-pressed', String(on));
  }
  if (hint) hint.classList.toggle('hidden', !on);

  if (network) {
    network.setOptions({ interaction: { dragNodes: !on, hover: true } });
  }
  if (changed || !on) restyleAll();
}

function addDependency(fromId, toId) {
  if (isLaneId(fromId) || isLaneId(toId)) return;
  const found = findNode(toId);
  if (!found) return;

  if ((found.node.dependencies || []).includes(fromId)) {
    toast('Dependency already exists', 'info');
    return;
  }
  if (wouldCreateCycle(fromId, toId, allNodes())) {
    toast(`Cycle detected: cannot connect ${fromId} → ${toId}`, 'error');
    return;
  }

  found.node.dependencies = [...(found.node.dependencies || []), fromId];
  handlers.onChange(`Connected ${fromId} → ${toId}`);
}

// ─── Init ──────────────────────────────────────────────────

export function initNetwork(container, callbacks) {
  handlers = callbacks;
  nodesDS = new vis.DataSet([]);
  edgesDS = new vis.DataSet([]);

  network = new vis.Network(container, { nodes: nodesDS, edges: edgesDS }, {
    physics: { enabled: false },
    interaction: {
      hover: true,
      multiselect: false,
      navigationButtons: false,
      keyboard: false,
      selectConnectedEdges: true
    },
    manipulation: { enabled: false, initiallyActive: false },
    edges: { selectionWidth: 2, hoverWidth: 1.5 },
    nodes: { chosen: true }
  });

  network.on('beforeDrawing', drawLanes);
  network.on('afterDrawing', drawProgressRings);

  network.on('hoverNode', params => {
    if (connectMode || isLaneId(params.node)) return;
    setTrace(traceFrom(params.node, allNodes()));
  });
  network.on('blurNode', clearTrace);

  network.on('dragEnd', params => {
    if (!params.nodes.length) return;
    let moved = false;
    params.nodes.forEach(id => {
      if (isLaneId(id)) return;
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
    const id = params.nodes[0] || null;
    selectedNodeId = id && !isLaneId(id) ? id : null;
    selectedEdgeId = null;
  });
  network.on('selectEdge', params => {
    selectedEdgeId = params.edges[0] || null;
    if (!params.nodes.length) selectedNodeId = null;
  });
  network.on('deselectNode', () => { selectedNodeId = null; });
  network.on('deselectEdge', () => { selectedEdgeId = null; });

  network.on('doubleClick', params => {
    if (connectMode) return;
    if (params.nodes.length) {
      const id = params.nodes[0];
      if (isLaneId(id)) return;
      const found = findNode(id);
      const evt = params.event.srcEvent;
      if ((evt.altKey || evt.metaKey) && found && handlers.onFollowLink(found.node)) return;
      handlers.onEditNode(id);
    } else if (!params.edges.length) {
      handlers.onAddNodeAt(params.pointer.canvas.x, params.pointer.canvas.y);
    }
  });

  network.on('click', params => {
    if (!connectMode) {
      const evt = params.event.srcEvent;
      if (params.nodes.length === 1 && (evt.altKey || evt.metaKey)) {
        const id = params.nodes[0];
        if (isLaneId(id)) return;
        const found = findNode(id);
        if (found) handlers.onFollowLink(found.node);
      }
      return;
    }

    if (!params.nodes.length) {
      if (connectSource) {
        connectSource = null;
        restyleAll();
        toast('Connection cancelled', 'info');
      }
      return;
    }

    const clicked = params.nodes[0];
    if (isLaneId(clicked)) return;

    if (!connectSource) {
      connectSource = clicked;
      restyleAll();
      toast(`From ${clicked} — click the successor task`, 'info');
    } else if (connectSource === clicked) {
      connectSource = null;
      restyleAll();
      toast('Source cleared', 'info');
    } else {
      const from = connectSource;
      connectSource = null;
      addDependency(from, clicked);
    }
  });

  return network;
}

export function fitView(duration = 400) {
  if (!network) return;
  window.setTimeout(
    () => network.fit({ animation: { duration, easingFunction: 'easeInOutQuad' } }),
    50
  );
}

export function focusNode(id, scale = 1.2) {
  if (!network) return;
  window.setTimeout(() => {
    try {
      network.selectNodes([id]);
      network.focus(id, { scale, animation: { duration: 400, easingFunction: 'easeInOutQuad' } });
      selectedNodeId = id;
    } catch {
      // node may have been removed between scheduling and running
    }
  }, 120);
}

export function redraw() {
  if (network) network.redraw();
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
