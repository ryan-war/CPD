// Boot, orchestration, and event wiring.

import { COLUMN_GAP } from './config.js';
import { $, escapeHtml, toast, refreshIcons, closeAllModals } from './dom.js';
import {
  getState, normalizeState, seedHistory, commit, undo, redo, canUndo, canRedo,
  currentDiagram, allNodes, findNode, pageTitle, nextNodeId, uid, displayOpts,
  captureBaseline
} from './state.js';
import { schedule, invalidateSchedule, clearCriticality } from './schedule.js';
import { dependenciesOf, wouldCreateCycle, toDependency } from './cpm.js';
import { followNodeLink } from './links.js';
import {
  initNetwork, applyVisData, fitView, focusNode, redraw, savePositionsFromNetwork,
  setConnectMode, isConnectMode, getSelection, clearSelection, clearTrace,
  setSearchQuery, getSearchQuery, matchesSearch, refreshHighlights,
  selectNodes, zoomBy, drawMinimap, getNetwork
} from './network.js';
import {
  renderBottomPanel, renderGantt, renderSummary, renderLegend, clearMonteCarloSummary,
  isGanttOpen, setGanttOpen, highlightTasks
} from './panel.js';
import {
  initModals, openNodeModal, closeNodeModal, saveNodeForm, addDependencyRow, removeDependencyRow,
  openEdgeModal, closeEdgeModal, saveEdgeForm, deleteEdge,
  openMilestoneModal, closeMilestoneModal, saveMilestoneForm,
  openSubpathModal, closeSubpathModal, saveSubpathForm, deleteSubpath,
  openSettingsModal, closeSettingsModal, saveSettingsForm,
  openMonteModal, closeMonteModal, runSimulation, anyDialogOpen
} from './modals.js';
import { saveJSON, exportPNG, exportCSV, bindFileInput } from './io.js';
import { initSplitter, initCompactToolbar } from './layout-ui.js';

let toolbarMenu = null;

// ─── Render ────────────────────────────────────────────────

/**
 * Re-render everything from state. The schedule is invalidated once here and
 * computed once on first use, so the canvas, panel, Gantt, and summary all
 * share a single CPM pass instead of running four.
 */
function render({ fit = false } = {}) {
  invalidateSchedule();
  $('work-area').classList.toggle('swimlane-mode', getState().layoutMode === 'milestone');
  applyVisData();
  renderSummary();
  renderBottomPanel();
  renderGantt();
  renderLegend();
  updateHistoryButtons();
  updateCanvasEmptyState();
  if (fit) fitView();
}

/** A state change: record history, clear stale results, re-render. */
function onChange(message, { fit = false, tabs = false, relayout = false } = {}) {
  if (relayout && getState().layoutMode === 'milestone') {
    applyMilestoneLayout({ silent: true });
  }
  commit();
  clearMonteCarloSummary();
  clearCriticality();
  if (tabs) updateTabUI();
  render({ fit });
  if (message) toast(message, 'success');
}

function updateHistoryButtons() {
  $('btn-undo').disabled = !canUndo();
  $('btn-redo').disabled = !canRedo();
}

/** A blank canvas gave no indication of what to do next. */
function updateCanvasEmptyState() {
  $('canvas-empty').classList.toggle('hidden', allNodes().length > 0);
}

function updateTabUI() {
  const state = getState();
  const nav = $('page-tabs');
  nav.innerHTML = (state.pageOrder || []).map(id => {
    const active = id === state.activeView;
    return `<button type="button" role="tab" aria-selected="${active}" data-view="${escapeHtml(id)}" class="tab-btn${active ? ' tab-btn-active' : ''}"${id !== 'main' ? ' title="Double-click to rename"' : ''}>${escapeHtml(pageTitle(id))}</button>`;
  }).join('');

  nav.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
    btn.addEventListener('dblclick', event => {
      event.preventDefault();
      if (btn.dataset.view !== 'main') openSubpathModal(btn.dataset.view);
    });
  });

  $('view-label').textContent = `(${pageTitle(state.activeView)})`;
  $('project-title').textContent = state.projectTitle;
  updateLayoutButtons();
  updatePertButton();
  syncDisplayMenu();
  refreshIcons(nav);
}

function switchView(view) {
  const state = getState();
  if (!state.diagrams[view] || view === state.activeView) return;
  savePositionsFromNetwork();
  state.activeView = view;
  clearSelection();
  clearTrace();
  updateTabUI();
  render({ fit: true });
}

function setToggleButton(id, active) {
  const btn = $(id);
  if (!btn) return;
  btn.classList.toggle('tool-btn-active', active);
  btn.setAttribute('aria-pressed', String(active));
}

function updateLayoutButtons() {
  const mode = getState().layoutMode;
  setToggleButton('btn-auto-layout', mode === 'cpm');
  setToggleButton('btn-milestone-layout', mode === 'milestone');
}

function updatePertButton() {
  setToggleButton('btn-pert', getState().estimationMode === 'pert');
}

function syncDisplayMenu() {
  const d = displayOpts();
  document.querySelectorAll('#display-menu [data-display]').forEach(cb => {
    const key = cb.dataset.display;
    cb.checked = key === 'id' ? true : !!d[key];
  });
}

// ─── Theme ─────────────────────────────────────────────────

function applyTheme() {
  const theme = getState().theme;
  document.documentElement.setAttribute('data-theme', theme);
  const btn = $('btn-theme');
  btn.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  btn.innerHTML = `<i data-lucide="${theme === 'dark' ? 'sun' : 'moon'}" class="w-3.5 h-3.5" aria-hidden="true"></i>`;
  refreshIcons(btn);
}

function toggleTheme() {
  const state = getState();
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  applyTheme();
  commit();
  render();
}

// ─── Tasks ─────────────────────────────────────────────────

function newTask(id, x, y) {
  return {
    id,
    title: 'New Task',
    description: '',
    min: 1,
    likely: 1.5,
    max: 2,
    progress: 0,
    status: 'not_started',
    dependencies: [],
    position: { x, y },
    linkedSubPage: null,
    linkedMainNode: null
  };
}

function addNodeAt(x, y) {
  const diagram = currentDiagram();
  if (!diagram.milestones.length) {
    diagram.milestones.push({ id: uid('m'), title: 'Phase 1', nodes: [] });
  }
  const id = nextNodeId();
  diagram.milestones[0].nodes.push(newTask(id, x || 0, y || 0));
  onChange(null);
  openNodeModal(id);
}

function addNodeToMilestone(msId) {
  const ms = currentDiagram().milestones.find(m => m.id === msId);
  if (!ms) return;
  const id = nextNodeId();
  const count = allNodes().length;
  ms.nodes.push(newTask(id, (count % 5) * 180, Math.floor(count / 5) * 120));
  onChange(null, { relayout: true });
  openNodeModal(id);
}

function deleteNodes(ids) {
  const state = getState();
  const doomed = new Set(ids);
  const diagram = currentDiagram();
  diagram.milestones.forEach(ms => {
    ms.nodes = ms.nodes.filter(n => !doomed.has(n.id));
    ms.nodes.forEach(n => {
      n.dependencies = dependenciesOf(n).filter(d => !doomed.has(d.id));
    });
  });
  if (state.activeView === 'main') {
    Object.keys(state.diagrams).forEach(viewId => {
      if (viewId === 'main') return;
      allNodes(state.diagrams[viewId]).forEach(n => {
        if (doomed.has(n.linkedMainNode)) n.linkedMainNode = null;
      });
    });
  }
  clearSelection();
  onChange(ids.length === 1 ? `Deleted task ${ids[0]}` : `Deleted ${ids.length} tasks`);
}

function deleteMilestone(msId) {
  const state = getState();
  const diagram = currentDiagram();
  const ms = diagram.milestones.find(m => m.id === msId);
  if (!ms) return;
  if (ms.nodes.length &&
      !window.confirm(`Delete milestone "${ms.title}" and its ${ms.nodes.length} task(s)?`)) return;

  const ids = new Set(ms.nodes.map(n => n.id));
  diagram.milestones = diagram.milestones.filter(m => m.id !== msId);
  diagram.milestones.forEach(m => {
    m.nodes.forEach(n => {
      n.dependencies = dependenciesOf(n).filter(d => !ids.has(d.id));
    });
  });
  if (state.activeView === 'main') {
    Object.keys(state.diagrams).forEach(viewId => {
      if (viewId === 'main') return;
      allNodes(state.diagrams[viewId]).forEach(n => {
        if (ids.has(n.linkedMainNode)) n.linkedMainNode = null;
      });
    });
  }
  clearSelection();
  onChange('Milestone deleted', { relayout: true });
}

/** Milestone order defines the column order in the Columns view. */
function moveMilestone(msId, direction) {
  const diagram = currentDiagram();
  const from = diagram.milestones.findIndex(m => m.id === msId);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= diagram.milestones.length) return;
  const [moved] = diagram.milestones.splice(from, 1);
  diagram.milestones.splice(to, 0, moved);
  onChange('Milestone reordered', { relayout: true });
}

function removeSelected() {
  const { nodeIds, edgeId } = getSelection();
  if (edgeId) {
    const [from, to] = String(edgeId).split('->');
    const found = to ? findNode(to) : null;
    if (found) {
      found.node.dependencies = dependenciesOf(found.node).filter(d => d.id !== from);
      clearSelection();
      onChange(`Removed ${from} → ${to}`);
      return;
    }
  }
  if (nodeIds.length) deleteNodes(nodeIds);
}

/** Bulk status change across the current selection. */
function setStatusForSelection(status) {
  const { nodeIds } = getSelection();
  if (!nodeIds.length) {
    toast('Select one or more tasks first', 'info');
    return;
  }
  nodeIds.forEach(id => {
    const found = findNode(id);
    if (!found) return;
    found.node.status = status;
    if (status === 'done') found.node.progress = 100;
    if (status === 'not_started') found.node.progress = 0;
  });
  onChange(`${nodeIds.length} task(s) marked ${status.replace('_', ' ')}`);
}

// ─── Layouts ───────────────────────────────────────────────

function applyAutoLayout() {
  const nodes = allNodes();
  if (!nodes.length) {
    toast('No tasks to lay out', 'info');
    return;
  }

  getState().layoutMode = 'cpm';
  const { metrics, order } = schedule();

  const levels = {};
  order.forEach(id => {
    const deps = dependenciesOf(metrics[id]).filter(d => metrics[d.id]);
    levels[id] = deps.length ? Math.max(...deps.map(d => levels[d.id] ?? 0)) + 1 : 0;
  });
  nodes.forEach(n => { if (levels[n.id] == null) levels[n.id] = 0; });

  const byLevel = new Map();
  Object.keys(levels).forEach(id => {
    const level = levels[id];
    if (!byLevel.has(level)) byLevel.set(level, []);
    byLevel.get(level).push(id);
  });

  const xGap = 240;
  const yGap = 150;
  [...byLevel.keys()].sort((a, b) => a - b).forEach(level => {
    const row = byLevel.get(level);
    const totalHeight = (row.length - 1) * yGap;
    row.forEach((id, i) => {
      const found = findNode(id);
      if (found) found.node.position = { x: level * xGap, y: -totalHeight / 2 + i * yGap };
    });
  });

  updateLayoutButtons();
  onChange('CPM auto-layout applied', { fit: true });
}

function applyMilestoneLayout({ silent = false } = {}) {
  const diagram = currentDiagram();
  if (!diagram.milestones.length) {
    if (!silent) toast('Add a milestone first', 'info');
    return;
  }

  getState().layoutMode = 'milestone';
  const yGap = 150;
  const startY = 20;
  diagram.milestones.forEach((ms, col) => {
    const list = ms.nodes || [];
    const totalHeight = Math.max(0, (list.length - 1) * yGap);
    list.forEach((n, row) => {
      n.position = { x: col * COLUMN_GAP, y: startY - totalHeight / 2 + row * yGap };
    });
  });

  updateLayoutButtons();
  if (!silent) onChange('Columns view — tasks and cards aligned by milestone', { fit: true });
}

// ─── Search ────────────────────────────────────────────────

function applySearch(value) {
  setSearchQuery(value.trim());
  refreshHighlights();
  if (!getSearchQuery()) return;
  const hits = allNodes().filter(matchesSearch);
  if (hits.length === 1) {
    focusNode(hits[0].id, 1.15);
  } else if (!hits.length) {
    toast('No matching tasks', 'info');
  }
}

function clearSearch() {
  if (!getSearchQuery()) return;
  setSearchQuery('');
  $('node-search').value = '';
  refreshHighlights();
}

// ─── Baseline ──────────────────────────────────────────────

function setBaseline() {
  const { metrics, projectDuration, graph } = schedule();
  if (graph.cycleIds.length) {
    toast('Resolve the circular dependency first', 'error');
    return;
  }
  getState().baseline = captureBaseline(metrics, projectDuration);
  onChange('Baseline captured');
}

function clearBaseline() {
  getState().baseline = null;
  onChange('Baseline cleared');
}

// ─── Wiring ────────────────────────────────────────────────

function wireToolbar() {
  $('btn-add-subpath').addEventListener('click', () => openSubpathModal(null));
  $('btn-connect').addEventListener('click', () => setConnectMode(!isConnectMode()));
  $('btn-add-node').addEventListener('click', () => addNodeAt(0, 0));
  $('btn-auto-layout').addEventListener('click', () => applyAutoLayout());
  $('btn-milestone-layout').addEventListener('click', () => applyMilestoneLayout());
  $('btn-fit').addEventListener('click', () => fitView(300));
  $('btn-undo').addEventListener('click', doUndo);
  $('btn-redo').addEventListener('click', doRedo);
  $('btn-gantt').addEventListener('click', () => setGanttOpen(!isGanttOpen()));
  $('btn-monte').addEventListener('click', openMonteModal);
  $('btn-save').addEventListener('click', saveJSON);
  $('btn-export-png').addEventListener('click', exportPNG);
  $('btn-export-csv').addEventListener('click', exportCSV);
  $('btn-settings').addEventListener('click', openSettingsModal);
  $('btn-theme').addEventListener('click', toggleTheme);
  $('btn-add-milestone').addEventListener('click', () => openMilestoneModal(null));
  $('btn-baseline').addEventListener('click', setBaseline);
  $('btn-clear-baseline').addEventListener('click', clearBaseline);
  $('btn-zoom-in').addEventListener('click', () => zoomBy(1.25));
  $('btn-zoom-out').addEventListener('click', () => zoomBy(0.8));
  $('btn-canvas-add').addEventListener('click', () => addNodeAt(0, 0));

  $('btn-pert').addEventListener('click', () => {
    const state = getState();
    state.estimationMode = state.estimationMode === 'pert' ? 'average' : 'pert';
    updatePertButton();
    onChange(state.estimationMode === 'pert'
      ? 'PERT mode: (O + 4M + P) / 6'
      : 'Average mode: (Min + Max) / 2');
  });

  $('legend-toggle').addEventListener('click', () => {
    const body = $('legend-body');
    const open = body.classList.toggle('hidden');
    $('legend-toggle').setAttribute('aria-expanded', String(!open));
  });

  let searchTimer = null;
  const searchInput = $('node-search');
  searchInput.addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => applySearch(searchInput.value), 180);
  });
  searchInput.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      clearSearch();
      searchInput.blur();
    }
  });

  bindFileInput(() => {
    applyTheme();
    updateTabUI();
    setGanttOpen(isGanttOpen());
    render({ fit: true });
  });
}

function wireDisplayMenu() {
  const button = $('btn-display');
  const menu = $('display-menu');

  function position() {
    const rect = button.getBoundingClientRect();
    const width = menu.offsetWidth || 208;
    const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
    menu.style.top = (rect.bottom + 6) + 'px';
    menu.style.left = left + 'px';
  }

  function close() {
    menu.classList.add('hidden');
    button.setAttribute('aria-expanded', 'false');
  }

  button.addEventListener('click', event => {
    event.stopPropagation();
    if (menu.classList.contains('hidden')) {
      menu.classList.remove('hidden');
      position();
      button.setAttribute('aria-expanded', 'true');
    } else {
      close();
    }
  });

  document.addEventListener('click', event => {
    if (!menu.contains(event.target) && !button.contains(event.target)) close();
  });
  window.addEventListener('resize', () => {
    if (!menu.classList.contains('hidden')) position();
  });
  menu.addEventListener('click', event => event.stopPropagation());
  menu.addEventListener('change', event => {
    const cb = event.target.closest('[data-display]');
    if (!cb || cb.dataset.display === 'id') return;
    getState().nodeDisplay[cb.dataset.display] = cb.checked;
    commit();
    render();
  });
}

function wireModals() {
  $('form-node').addEventListener('submit', saveNodeForm);
  $('modal-node-close').addEventListener('click', closeNodeModal);
  $('modal-node-cancel').addEventListener('click', closeNodeModal);
  $('btn-add-dep').addEventListener('click', addDependencyRow);
  $('edit-deps').addEventListener('click', event => {
    const remove = event.target.closest('.dep-remove');
    if (remove) removeDependencyRow(remove.closest('.dep-row'));
  });
  $('btn-delete-node').addEventListener('click', () => {
    const id = $('edit-node-id').value;
    closeNodeModal();
    deleteNodes([id]);
  });

  $('form-edge').addEventListener('submit', saveEdgeForm);
  $('modal-edge-close').addEventListener('click', closeEdgeModal);
  $('modal-edge-cancel').addEventListener('click', closeEdgeModal);
  $('btn-delete-edge').addEventListener('click', deleteEdge);

  $('form-milestone').addEventListener('submit', saveMilestoneForm);
  $('modal-milestone-close').addEventListener('click', closeMilestoneModal);
  $('modal-milestone-cancel').addEventListener('click', closeMilestoneModal);

  $('form-subpath').addEventListener('submit', saveSubpathForm);
  $('modal-subpath-close').addEventListener('click', closeSubpathModal);
  $('modal-subpath-cancel').addEventListener('click', closeSubpathModal);
  $('btn-delete-subpath').addEventListener('click', deleteSubpath);

  $('form-settings').addEventListener('submit', saveSettingsForm);
  $('modal-settings-close').addEventListener('click', closeSettingsModal);
  $('modal-settings-cancel').addEventListener('click', closeSettingsModal);

  $('modal-monte-close').addEventListener('click', closeMonteModal);
  $('btn-run-monte').addEventListener('click', runSimulation);

  [
    ['modal-node', closeNodeModal],
    ['modal-edge', closeEdgeModal],
    ['modal-milestone', closeMilestoneModal],
    ['modal-subpath', closeSubpathModal],
    ['modal-settings', closeSettingsModal],
    ['modal-monte', closeMonteModal]
  ].forEach(([id, close]) => {
    $(id).addEventListener('click', event => {
      if (event.target.id === id) close();
    });
  });
}

function wirePanelDelegation() {
  const container = $('milestones-container');

  // One delegated listener rather than rebinding every card button on each
  // render of the panel.
  container.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (button) {
      const { editNode, gotoPage, gotoMain, addToMs, editMs, delMs, moveMs, dir } = button.dataset;
      if (editNode) openNodeModal(editNode);
      else if (gotoPage) switchView(gotoPage);
      else if (gotoMain) followNodeLink({ linkedMainNode: gotoMain }, nav);
      else if (addToMs) addNodeToMilestone(addToMs);
      else if (editMs) openMilestoneModal(editMs);
      else if (delMs) deleteMilestone(delMs);
      else if (moveMs) moveMilestone(moveMs, Number(dir));
      return;
    }
    // Selecting a card selects the task on the diagram.
    const card = event.target.closest('[data-task-card]');
    if (card && !event.target.closest('input')) {
      selectNodes([card.dataset.taskCard], { focus: true });
      highlightTasks([card.dataset.taskCard], { scrollIntoView: false });
    }
  });

  // Inline progress: live feedback while dragging, one history entry on release.
  container.addEventListener('input', event => {
    const slider = event.target.closest('[data-progress-for]');
    if (!slider) return;
    const output = slider.parentElement.querySelector('output');
    if (output) output.textContent = `${slider.value}%`;
  });

  container.addEventListener('change', event => {
    const slider = event.target.closest('[data-progress-for]');
    if (!slider) return;
    const found = findNode(slider.dataset.progressFor);
    if (!found) return;
    const value = Math.max(0, Math.min(100, Number(slider.value) || 0));
    found.node.progress = value;
    if (value >= 100) found.node.status = 'done';
    else if (value > 0 && found.node.status === 'not_started') found.node.status = 'in_progress';
    else if (value === 0 && found.node.status === 'done') found.node.status = 'in_progress';
    onChange(null);
  });
}

const nav = {
  switchView,
  focusNode: id => focusNode(id)
};

function doUndo() {
  if (!undo()) {
    toast('Nothing to undo', 'info');
    return;
  }
  afterHistoryMove();
}

function doRedo() {
  if (!redo()) {
    toast('Nothing to redo', 'info');
    return;
  }
  afterHistoryMove();
}

function afterHistoryMove() {
  clearSelection();
  clearTrace();
  clearMonteCarloSummary();
  clearCriticality();
  applyTheme();
  updateTabUI();
  render();
}

/**
 * Keyboard access to the canvas. The diagram was entirely mouse-driven —
 * there was no way to move between tasks, open one, or draw a link without a
 * pointer.
 */
function focusAdjacentNode(direction) {
  const nodes = allNodes();
  if (!nodes.length) return;
  const network = getNetwork();
  const positions = network ? network.getPositions(nodes.map(n => n.id)) : {};
  const ordered = nodes.slice().sort((a, b) => {
    const pa = positions[a.id] || { x: 0, y: 0 };
    const pb = positions[b.id] || { x: 0, y: 0 };
    return (pa.x - pb.x) || (pa.y - pb.y) || String(a.id).localeCompare(String(b.id));
  });
  const { nodeId } = getSelection();
  const index = ordered.findIndex(n => n.id === nodeId);
  const next = index < 0
    ? ordered[0]
    : ordered[(index + direction + ordered.length) % ordered.length];
  selectNodes([next.id], { focus: true });
  highlightTasks([next.id]);
}

function wireKeyboard() {
  document.addEventListener('keydown', event => {
    const target = event.target;
    const tag = (target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;

    // Escape is handled before the typing guard: previously it was swallowed
    // whenever focus sat in a modal field, so a dialog could not be dismissed
    // from the keyboard.
    if (event.key === 'Escape') {
      if (anyDialogOpen()) {
        closeAllModals();
        return;
      }
      if (!$('display-menu').classList.contains('hidden')) {
        $('display-menu').classList.add('hidden');
        $('btn-display').setAttribute('aria-expanded', 'false');
        return;
      }
      if (toolbarMenu) toolbarMenu.closeMenu();
      if (isConnectMode()) {
        setConnectMode(false);
        return;
      }
      clearSearch();
      clearTrace();
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) doRedo(); else doUndo();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      doRedo();
      return;
    }

    if (typing) return;

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      selectNodes(allNodes().map(n => n.id));
      highlightTasks(allNodes().map(n => n.id), { scrollIntoView: false });
      return;
    }

    switch (event.key) {
      case '/':
        event.preventDefault();
        $('node-search').focus();
        return;
      case 'Delete':
      case 'Backspace':
        event.preventDefault();
        removeSelected();
        return;
      case 'Tab':
        if (document.activeElement === $('network-canvas') ||
            $('network-canvas').contains(document.activeElement)) {
          event.preventDefault();
          focusAdjacentNode(event.shiftKey ? -1 : 1);
        }
        return;
      case 'ArrowRight':
        event.preventDefault();
        focusAdjacentNode(1);
        return;
      case 'ArrowLeft':
        event.preventDefault();
        focusAdjacentNode(-1);
        return;
      case 'Enter': {
        const { nodeId } = getSelection();
        if (nodeId) {
          event.preventDefault();
          openNodeModal(nodeId);
        }
        return;
      }
      case '+':
      case '=':
        zoomBy(1.25);
        return;
      case '-':
        zoomBy(0.8);
        return;
      case 'n':
        addNodeAt(0, 0);
        return;
      case 'c':
        if (!event.ctrlKey && !event.metaKey && !event.altKey) setConnectMode(!isConnectMode());
        return;
      case 'f':
        fitView(300);
        return;
      case '1': setStatusForSelection('not_started'); return;
      case '2': setStatusForSelection('in_progress'); return;
      case '3': setStatusForSelection('blocked'); return;
      case '4': setStatusForSelection('done'); return;
      default:
    }
  });
}

function wireWindowResize() {
  // Resizing the window changes the canvas size but not the camera, which left
  // the diagram clipped off the edge of a smaller viewport. Refit after the
  // resize settles. Splitter drags deliberately do not refit — those redraw
  // only, so dragging the divider never disturbs the user's zoom.
  let timer = null;
  window.addEventListener('resize', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fitView(200), 200);
  });
}

function wireProjectTitle() {
  const title = $('project-title');
  title.addEventListener('blur', () => {
    const value = title.textContent.trim() || 'Critical Path Network';
    title.textContent = value;
    if (value !== getState().projectTitle) {
      getState().projectTitle = value;
      commit();
    }
  });
  title.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      title.blur();
    }
  });
}

// ─── Boot ──────────────────────────────────────────────────

function showLoadError(message) {
  const banner = $('boot-error');
  banner.textContent = message;
  banner.classList.remove('hidden');
}

function boot() {
  // Both libraries come from a CDN. Without this check a blocked or failed
  // request leaves a blank page and a console stack trace.
  const missing = [];
  if (typeof vis === 'undefined') missing.push('vis-network');
  if (typeof lucide === 'undefined') missing.push('lucide');
  if (missing.length) {
    showLoadError(
      `Could not load ${missing.join(' and ')}. Check your network connection and reload.`
    );
    return;
  }

  normalizeState(getState());
  seedHistory();
  applyTheme();
  refreshIcons();

  initModals({
    onChange,
    onSimulationComplete: () => render(),
    refreshIcons: () => refreshIcons($('modal-node')),
    // Validate a whole proposed predecessor set at once, since the dependency
    // editor can add several links before anything is saved.
    wouldCycle: (nodeId, dependencies) => {
      const nodes = allNodes().map(n => n.id === nodeId
        ? { ...n, dependencies: dependencies.map(toDependency) }
        : n);
      return dependencies.some(d => {
        const others = nodes.map(n => n.id === nodeId
          ? { ...n, dependencies: dependenciesOf(n).filter(x => x.id !== d.id) }
          : n);
        return wouldCreateCycle(d.id, nodeId, others);
      });
    }
  });

  wireToolbar();
  wireDisplayMenu();
  wireModals();
  wirePanelDelegation();
  wireKeyboard();
  wireProjectTitle();
  wireWindowResize();
  toolbarMenu = initCompactToolbar();
  initSplitter(() => redraw());

  initNetwork($('network-canvas'), {
    onChange: message => onChange(message),
    onEditNode: openNodeModal,
    onEditEdge: openEdgeModal,
    onAddNodeAt: addNodeAt,
    onFollowLink: node => followNodeLink(node, nav),
    onLayoutModeChange: updateLayoutButtons,
    onSelectionChange: ids => highlightTasks(ids),
    onPositionsChanged: () => {
      commit();
      updateHistoryButtons();
      drawMinimap();
    }
  });

  updateTabUI();
  render({ fit: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
