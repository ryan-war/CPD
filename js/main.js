// Boot, orchestration, and event wiring.

import { COLUMN_GAP } from './config.js';
import {
  $, escapeHtml, toast, refreshIcons, closeAllModals
} from './dom.js';
import {
  getState, normalizeState, seedHistory, commit, undo, redo, canUndo, canRedo,
  currentDiagram, allNodes, findNode, pageTitle, nextNodeId, uid, displayOpts
} from './state.js';
import { schedule, invalidateSchedule } from './schedule.js';
import { followNodeLink } from './links.js';
import {
  initNetwork, applyVisData, fitView, focusNode, redraw, savePositionsFromNetwork,
  setConnectMode, isConnectMode, getSelection, clearSelection, clearTrace,
  setSearchQuery, getSearchQuery, matchesSearch, refreshHighlights
} from './network.js';
import {
  renderBottomPanel, renderGantt, renderSummary, clearMonteCarloSummary,
  isGanttOpen, setGanttOpen
} from './panel.js';
import {
  initModals, openNodeModal, closeNodeModal, saveNodeForm,
  openMilestoneModal, closeMilestoneModal, saveMilestoneForm,
  openSubpathModal, closeSubpathModal, saveSubpathForm, deleteSubpath,
  openMonteModal, closeMonteModal, runSimulation, anyDialogOpen
} from './modals.js';
import { saveJSON, exportPNG, bindFileInput } from './io.js';
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
  updateHistoryButtons();
  if (fit) fitView();
}

/** A state change: record history, clear stale results, re-render. */
function onChange(message, { fit = false, tabs = false, relayout = false } = {}) {
  if (relayout && getState().layoutMode === 'milestone') {
    applyMilestoneLayout({ silent: true });
  }
  commit();
  clearMonteCarloSummary();
  if (tabs) updateTabUI();
  render({ fit });
  if (message) toast(message, 'success');
}

function updateHistoryButtons() {
  $('btn-undo').disabled = !canUndo();
  $('btn-redo').disabled = !canRedo();
}

function updateTabUI() {
  const state = getState();
  const nav = $('page-tabs');
  nav.innerHTML = (state.pageOrder || []).map(id => {
    const active = id === state.activeView;
    const cls = active
      ? 'tab-btn px-3 py-1.5 text-xs rounded-md bg-[#ff4d4d]/20 text-[#ff4d4d] font-medium whitespace-nowrap'
      : 'tab-btn px-3 py-1.5 text-xs rounded-md text-slate-400 hover:text-slate-200 whitespace-nowrap';
    const hint = id !== 'main' ? ' title="Double-click to rename"' : '';
    return `<button type="button" role="tab" aria-selected="${active}" data-view="${escapeHtml(id)}" class="${cls}"${hint}>${escapeHtml(pageTitle(id))}</button>`;
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

function deleteNode(nodeId) {
  const state = getState();
  const diagram = currentDiagram();
  diagram.milestones.forEach(ms => {
    ms.nodes = ms.nodes.filter(n => n.id !== nodeId);
    ms.nodes.forEach(n => {
      n.dependencies = (n.dependencies || []).filter(dep => dep !== nodeId);
    });
  });
  if (state.activeView === 'main') {
    Object.keys(state.diagrams).forEach(viewId => {
      if (viewId === 'main') return;
      allNodes(state.diagrams[viewId]).forEach(n => {
        if (n.linkedMainNode === nodeId) n.linkedMainNode = null;
      });
    });
  }
  clearSelection();
  onChange(`Deleted task ${nodeId}`);
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
      n.dependencies = (n.dependencies || []).filter(dep => !ids.has(dep));
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

function removeSelected() {
  const { nodeId, edgeId } = getSelection();
  if (edgeId) {
    const [from, to] = String(edgeId).split('->');
    const found = to ? findNode(to) : null;
    if (found) {
      found.node.dependencies = (found.node.dependencies || []).filter(d => d !== from);
      clearSelection();
      onChange(`Removed ${from} → ${to}`);
      return;
    }
  }
  if (nodeId) deleteNode(nodeId);
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
    const deps = (metrics[id].dependencies || []).filter(d => metrics[d]);
    levels[id] = deps.length ? Math.max(...deps.map(d => levels[d] ?? 0)) + 1 : 0;
  });
  nodes.forEach(n => { if (levels[n.id] == null) levels[n.id] = 0; });

  const byLevel = new Map();
  Object.keys(levels).forEach(id => {
    const level = levels[id];
    if (!byLevel.has(level)) byLevel.set(level, []);
    byLevel.get(level).push(id);
  });

  const xGap = 220;
  const yGap = 140;
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
  $('btn-add-milestone').addEventListener('click', () => openMilestoneModal(null));

  $('btn-pert').addEventListener('click', () => {
    const state = getState();
    state.estimationMode = state.estimationMode === 'pert' ? 'average' : 'pert';
    updatePertButton();
    onChange(state.estimationMode === 'pert'
      ? 'PERT mode: (O + 4M + P) / 6'
      : 'Average mode: (Min + Max) / 2');
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
    let left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
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
    onChange(null);
  });
}

function wireModals() {
  $('form-node').addEventListener('submit', saveNodeForm);
  $('modal-node-close').addEventListener('click', closeNodeModal);
  $('modal-node-cancel').addEventListener('click', closeNodeModal);
  $('btn-delete-node').addEventListener('click', () => {
    const id = $('edit-node-id').value;
    closeNodeModal();
    deleteNode(id);
  });

  $('form-milestone').addEventListener('submit', saveMilestoneForm);
  $('modal-milestone-close').addEventListener('click', closeMilestoneModal);
  $('modal-milestone-cancel').addEventListener('click', closeMilestoneModal);

  $('form-subpath').addEventListener('submit', saveSubpathForm);
  $('modal-subpath-close').addEventListener('click', closeSubpathModal);
  $('modal-subpath-cancel').addEventListener('click', closeSubpathModal);
  $('btn-delete-subpath').addEventListener('click', deleteSubpath);

  $('modal-monte-close').addEventListener('click', closeMonteModal);
  $('btn-run-monte').addEventListener('click', runSimulation);

  [
    ['modal-node', closeNodeModal],
    ['modal-milestone', closeMilestoneModal],
    ['modal-subpath', closeSubpathModal],
    ['modal-monte', closeMonteModal]
  ].forEach(([id, close]) => {
    $(id).addEventListener('click', event => {
      if (event.target.id === id) close();
    });
  });
}

function wirePanelDelegation() {
  // One delegated listener rather than rebinding every card button on each
  // render of the panel.
  $('milestones-container').addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    const { editNode, gotoPage, gotoMain, addToMs, editMs, delMs } = button.dataset;
    if (editNode) openNodeModal(editNode);
    else if (gotoPage) switchView(gotoPage);
    else if (gotoMain) followNodeLink({ linkedMainNode: gotoMain }, nav);
    else if (addToMs) addNodeToMilestone(addToMs);
    else if (editMs) openMilestoneModal(editMs);
    else if (delMs) deleteMilestone(delMs);
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
  clearSelection();
  clearTrace();
  clearMonteCarloSummary();
  updateTabUI();
  render();
}

function doRedo() {
  if (!redo()) {
    toast('Nothing to redo', 'info');
    return;
  }
  clearSelection();
  clearTrace();
  clearMonteCarloSummary();
  updateTabUI();
  render();
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

    if (event.key === '/') {
      event.preventDefault();
      $('node-search').focus();
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      removeSelected();
      return;
    }
    if (event.key === 'c' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      setConnectMode(!isConnectMode());
    }
  });
}

/**
 * Resizing the window changes the canvas size but not the camera, which left
 * the diagram clipped off the edge of a smaller viewport. Refit after the
 * resize settles. Splitter drags deliberately do not refit — those redraw
 * only, so dragging the divider never disturbs the user's zoom.
 */
function wireWindowResize() {
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
  refreshIcons();

  initModals({ onChange });
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
    onAddNodeAt: addNodeAt,
    onFollowLink: node => followNodeLink(node, nav),
    onLayoutModeChange: updateLayoutButtons,
    onPositionsChanged: () => {
      commit();
      updateHistoryButtons();
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
