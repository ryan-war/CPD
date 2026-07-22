// Project state: shape, validation, accessors, and undo/redo history.

import { DEFAULT_DISPLAY, HISTORY_MAX } from './config.js';
import { nodesOf } from './cpm.js';

let state = createDefaultState();

export function getState() {
  return state;
}

export function setState(next) {
  state = next;
}

export function createDefaultState() {
  return {
    projectTitle: 'Critical Path Network',
    activeView: 'main',
    layoutMode: 'free',
    estimationMode: 'average',
    nodeDisplay: { ...DEFAULT_DISPLAY },
    pageOrder: ['main', 'sub_1', 'sub_2', 'sub_3'],
    pageTitles: {
      main: 'Main Diagram',
      sub_1: 'Sub-Path 1',
      sub_2: 'Sub-Path 2',
      sub_3: 'Sub-Path 3'
    },
    diagrams: {
      main: {
        milestones: [
          {
            id: 'm1',
            title: 'Phase 1: Planning',
            nodes: [
              {
                id: 'A',
                title: 'Requirements Gathering',
                description: 'Collect baseline constraints and scope requirements.',
                min: 2, likely: 3, max: 4,
                progress: 100, status: 'done',
                dependencies: [],
                position: { x: 0, y: 20 },
                linkedSubPage: 'sub_1',
                linkedMainNode: null
              }
            ]
          },
          {
            id: 'm2',
            title: 'Phase 2: Design',
            nodes: [
              {
                id: 'B',
                title: 'Architecture Design',
                description: 'Design network diagram canvas workflow and CPM engine.',
                min: 3, likely: 4, max: 5,
                progress: 60, status: 'in_progress',
                dependencies: ['A'],
                position: { x: 280, y: 20 },
                linkedSubPage: null,
                linkedMainNode: null
              }
            ]
          },
          {
            id: 'm3',
            title: 'Phase 3: Build',
            nodes: [
              {
                id: 'C',
                title: 'Frontend Build',
                description: 'Implement canvas UI and milestone panels.',
                min: 4, likely: 5, max: 6,
                progress: 20, status: 'in_progress',
                dependencies: ['B'],
                position: { x: 560, y: -55 },
                linkedSubPage: null,
                linkedMainNode: null
              },
              {
                id: 'D',
                title: 'CPM Engine',
                description: 'Forward and backward pass calculations.',
                min: 3, likely: 4, max: 5,
                progress: 0, status: 'not_started',
                dependencies: ['B'],
                position: { x: 560, y: 95 },
                linkedSubPage: null,
                linkedMainNode: null
              }
            ]
          },
          {
            id: 'm4',
            title: 'Phase 4: Launch',
            nodes: [
              {
                id: 'E',
                title: 'Integration & Release',
                description: 'Merge paths, test, and publish.',
                min: 2, likely: 2.5, max: 3,
                progress: 0, status: 'not_started',
                dependencies: ['C', 'D'],
                position: { x: 840, y: 20 },
                linkedSubPage: null,
                linkedMainNode: null
              }
            ]
          }
        ]
      },
      sub_1: { milestones: [] },
      sub_2: { milestones: [] },
      sub_3: { milestones: [] }
    }
  };
}

/**
 * Bring a loaded project up to the current shape and repair anything a
 * hand-edited or older file might be missing. Also de-duplicates task ids
 * within a diagram — duplicates would otherwise silently shadow each other,
 * since lookups return the first match.
 */
export function normalizeState(data) {
  if (!data || typeof data !== 'object') throw new Error('project must be an object');
  if (!data.diagrams || !data.diagrams.main) throw new Error('missing diagrams.main');

  data.projectTitle = String(data.projectTitle || 'Critical Path Network');
  data.nodeDisplay = { ...DEFAULT_DISPLAY, ...(data.nodeDisplay || {}) };
  if (!data.layoutMode) data.layoutMode = 'free';
  if (!data.estimationMode) data.estimationMode = 'average';
  if (!data.pageTitles) data.pageTitles = {};
  if (!Array.isArray(data.pageOrder)) {
    data.pageOrder = ['main', ...Object.keys(data.diagrams).filter(k => k !== 'main').sort()];
  }
  if (!data.pageTitles.main) data.pageTitles.main = 'Main Diagram';

  Object.keys(data.diagrams).forEach(pageId => {
    const diagram = data.diagrams[pageId];
    if (!diagram || typeof diagram !== 'object') {
      data.diagrams[pageId] = { milestones: [] };
      return;
    }
    if (!Array.isArray(diagram.milestones)) diagram.milestones = [];

    if (!data.pageTitles[pageId]) {
      data.pageTitles[pageId] = pageId === 'main'
        ? 'Main Diagram'
        : pageId.replace(/^sub_/, 'Sub-Path ').replace(/_/g, ' ');
    }
    if (!data.pageOrder.includes(pageId)) data.pageOrder.push(pageId);

    const seen = new Set();
    diagram.milestones.forEach(ms => {
      if (!ms.id) ms.id = uid('m');
      ms.title = String(ms.title || 'Untitled milestone');
      if (!Array.isArray(ms.nodes)) ms.nodes = [];
      ms.nodes.forEach(n => {
        n.id = String(n.id ?? uid('N'));
        while (seen.has(n.id)) n.id = `${n.id}_1`;
        seen.add(n.id);

        n.title = String(n.title || 'Untitled task');
        n.description = String(n.description || '');
        n.min = numberOr(n.min, 0);
        n.max = numberOr(n.max, n.min);
        if (n.max < n.min) n.max = n.min;
        n.likely = numberOr(n.likely, (n.min + n.max) / 2);
        // Keep the most-likely estimate inside [O, P]; outside that range the
        // triangular sampler produces NaN.
        n.likely = Math.min(n.max, Math.max(n.min, n.likely));
        n.progress = Math.max(0, Math.min(100, numberOr(n.progress, 0)));
        if (!n.status) n.status = n.progress >= 100 ? 'done' : (n.progress > 0 ? 'in_progress' : 'not_started');
        if (!Array.isArray(n.dependencies)) n.dependencies = [];
        n.dependencies = [...new Set(n.dependencies.map(String).filter(d => d !== n.id))];
        if (!n.position || typeof n.position !== 'object') n.position = { x: 0, y: 0 };
        n.position = { x: numberOr(n.position.x, 0), y: numberOr(n.position.y, 0) };
        if (n.linkedSubPage === undefined) n.linkedSubPage = null;
        if (n.linkedMainNode === undefined) n.linkedMainNode = null;
      });
    });

    // Drop dependencies pointing at tasks that no longer exist.
    diagram.milestones.forEach(ms => {
      ms.nodes.forEach(n => {
        n.dependencies = n.dependencies.filter(d => seen.has(d));
      });
    });
  });

  data.pageOrder = [...new Set(data.pageOrder)].filter(id => data.diagrams[id]);
  if (!data.pageOrder.includes('main')) data.pageOrder.unshift('main');
  if (!data.activeView || !data.diagrams[data.activeView]) data.activeView = 'main';

  // Clear links that no longer resolve.
  Object.keys(data.diagrams).forEach(pageId => {
    nodesOf(data.diagrams[pageId]).forEach(n => {
      if (n.linkedSubPage && !data.diagrams[n.linkedSubPage]) n.linkedSubPage = null;
    });
  });
  const mainIds = new Set(nodesOf(data.diagrams.main).map(n => n.id));
  Object.keys(data.diagrams).forEach(pageId => {
    if (pageId === 'main') return;
    nodesOf(data.diagrams[pageId]).forEach(n => {
      if (n.linkedMainNode && !mainIds.has(n.linkedMainNode)) n.linkedMainNode = null;
    });
  });

  return data;
}

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// ─── Accessors ─────────────────────────────────────────────

export function currentDiagram() {
  return state.diagrams[state.activeView];
}

export function allNodes(diagram) {
  return nodesOf(diagram || currentDiagram());
}

export function findNode(nodeId, diagram) {
  const d = diagram || currentDiagram();
  if (!d) return null;
  for (const ms of d.milestones || []) {
    const node = (ms.nodes || []).find(n => n.id === nodeId);
    if (node) return { node, milestone: ms };
  }
  return null;
}

export function findNodeInDiagram(nodeId, viewId) {
  return findNode(nodeId, state.diagrams[viewId]);
}

export function pageTitle(id) {
  return (state.pageTitles && state.pageTitles[id]) || id;
}

export function subPageIds() {
  return (state.pageOrder || []).filter(id => id !== 'main');
}

export function displayOpts() {
  return state.nodeDisplay || DEFAULT_DISPLAY;
}

export function uid(prefix) {
  return prefix + '_' + Math.random().toString(36).slice(2, 9);
}

export function nextNodeId() {
  const existing = new Set(allNodes().map(n => n.id));
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (const ch of letters) {
    if (!existing.has(ch)) return ch;
  }
  for (let i = 1; i < 1000; i++) {
    for (const ch of letters) {
      const id = ch + i;
      if (!existing.has(id)) return id;
    }
  }
  return uid('N');
}

// ─── History ───────────────────────────────────────────────
//
// Snapshots are taken *after* a mutation: `past` always ends with the state
// currently on screen. Undo moves that entry to `future` and restores the new
// tail, so redo can put it back — the previous implementation snapshotted
// before mutating, which meant the post-mutation state was never stored and
// redo replayed a duplicate of the undone state.

let past = [];
let future = [];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function seedHistory() {
  past = [clone(state)];
  future = [];
}

/** Record the current state as a new history entry. Call after mutating. */
export function commit() {
  past.push(clone(state));
  if (past.length > HISTORY_MAX) past.shift();
  future = [];
}

export function canUndo() {
  return past.length > 1;
}

export function canRedo() {
  return future.length > 0;
}

export function undo() {
  if (!canUndo()) return false;
  future.push(past.pop());
  state = clone(past[past.length - 1]);
  return true;
}

export function redo() {
  if (!canRedo()) return false;
  const next = future.pop();
  past.push(next);
  state = clone(next);
  return true;
}
