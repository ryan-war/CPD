// Boot, orchestration, and event wiring.

import { $, escapeHtml, toast, refreshIcons, closeAllModals } from './dom.js';
import {
  getState, setState, createDefaultState, normalizeState, seedHistory, commit,
  undo, redo, canUndo, canRedo, currentDiagram, allNodes, findNode, pageTitle,
  nextNodeId, uid, displayOpts, captureBaseline, subPageIds
} from './state.js';
import { TABS_COMPACT_ABOVE, GHOST_ROW_GAP } from './config.js';
import {
  schedule, invalidateSchedule, clearCriticality, rollupForPage, fmtPercent
} from './schedule.js';
import { dependenciesOf, wouldCreateCycle, toDependency } from './cpm.js';
import { followNodeLink, groupPagesByMainNode } from './links.js';
import {
  computeCpmLayout, orderedNodes, columnRowHeight, columnRowOrigin, freeSpotNear,
  ghostLayout
} from './layout.js';
import {
  initNetwork, applyVisData, fitView, focusNode, redraw, savePositionsFromNetwork,
  setConnectMode, isConnectMode, getSelection, clearSelection, clearTrace,
  setSearchQuery, getSearchQuery, matchesSearch, refreshHighlights,
  selectNodes, zoomBy, drawMinimap, getNetwork, nodeSizeOf, columnLayout, viewCentre,
  toggleActiveTag, clearActiveTags, retainActiveTags
} from './network.js';
import {
  renderBottomPanel, renderGantt, renderSummary, renderLegend, clearMonteCarloSummary,
  isGanttOpen, setGanttOpen, highlightTasks,
  renderResources, isResourcesOpen, setResourcesOpen, setResourceCapacity, getResourceCapacity,
  renderQuality, isQualityOpen, setQualityOpen, renderTagFilter,
  renderEVM, isEvmOpen, setEvmOpen
} from './panel.js';
import { levelResources } from './resources.js';
import {
  initModals, openNodeModal, closeNodeModal, saveNodeForm, addDependencyRow, removeDependencyRow,
  openEdgeModal, closeEdgeModal, saveEdgeForm, deleteEdge,
  openMilestoneModal, closeMilestoneModal, saveMilestoneForm,
  openSubpathModal, closeSubpathModal, saveSubpathForm, deleteSubpath,
  openSettingsModal, closeSettingsModal, saveSettingsForm,
  openMonteModal, closeMonteModal, runSimulation, anyDialogOpen
} from './modals.js';
import {
  initScenarios, openScenariosModal, closeScenariosModal, saveCurrentAsScenario,
  handleScenarioClick, setCompareTarget
} from './scenario-ui.js';
import { saveJSON, exportPNG, exportSVG, exportCSV, bindFileInput } from './io.js';
import { buildShareLink, decodeProject, sharedPayloadInUrl, MAX_LINK_LENGTH } from './share.js';
import { initSplitter, initCompactToolbar } from './layout-ui.js';
import { scheduleSave, saveNow, readSaved, clearSaved, describeAge } from './storage.js';

let toolbarMenu = null;
let autosaveReady = false;

// ─── Render ────────────────────────────────────────────────

/**
 * Re-render everything from state. The schedule is invalidated once here and
 * computed once on first use, so the canvas, panel, Gantt, and summary all
 * share a single CPM pass instead of running four.
 */
function render({ fit = false } = {}) {
  invalidateSchedule();
  // Keep the tag filter to tags that still exist here before anything styles by
  // it, so a removed or off-page tag never dims the diagram against nothing.
  retainActiveTags(new Set(allNodes().flatMap(n => n.tags || [])));
  $('work-area').classList.toggle('swimlane-mode', getState().layoutMode === 'milestone');
  applyVisData();
  renderSummary();
  // The tabs carry each sub-path's share of the project, which any edit can
  // move, so they are rebuilt with everything else rather than only when a
  // page is added or renamed.
  updateTabUI();
  renderTagFilter();
  renderBottomPanel();
  renderGantt();
  renderResources();
  renderQuality();
  renderEVM();
  renderLegend();
  updateHistoryButtons();
  updateCanvasEmptyState();
  if (autosaveReady) scheduleSave(getState, message => toast(message, 'error'));
  if (fit) fitView();
}

/** A state change: record history, clear stale results, re-render. */
function onChange(message, { fit = false, relayout = false } = {}) {
  if (relayout && getState().layoutMode === 'milestone') {
    applyMilestoneLayout({ silent: true });
  }
  commit();
  clearMonteCarloSummary();
  clearCriticality();
  render({ fit });
  if (message) toast(message, 'success');
}

function updateHistoryButtons() {
  $('btn-undo').disabled = !canUndo();
  $('btn-redo').disabled = !canRedo();
}

/**
 * Wipe every transient view state. Called by each path that swaps the whole
 * project — Load JSON, a shared link, loading a scenario, discarding — so the
 * incoming plan never inherits the last one's selection, hover trace, tag
 * filter, search, connect mode, or stale simulation results. (Undo/redo does
 * not go through here: stepping through history should keep your search and
 * filter where they were.)
 */
function resetViewState() {
  clearSelection();
  clearTrace();
  clearActiveTags();
  setConnectMode(false);
  setSearchQuery('');
  $('node-search').value = '';
  clearMonteCarloSummary();
  clearCriticality();
}

/** A blank canvas gave no indication of what to do next. */
function updateCanvasEmptyState() {
  $('canvas-empty').classList.toggle('hidden', allNodes().length > 0);
}

/** One page tab, carrying its share of the project when it has one. */
function tabButtonHtml(id, activeView) {
  const active = id === activeView;
  const rollup = id === 'main' ? null : rollupForPage(id);
  const badge = rollup && rollup.share > 0
    ? `<span class="tab-share" title="${fmtPercent(rollup.share)} of the project duration">${fmtPercent(rollup.share)}</span>`
    : '';
  const title = id === 'main'
    ? ''
    : ` title="${escapeHtml(rollupTabTitle(id, rollup))}"`;
  return `<button type="button" role="tab" aria-selected="${active}" data-view="${escapeHtml(id)}" class="tab-btn${active ? ' tab-btn-active' : ''}"${title}>${escapeHtml(pageTitle(id))}${badge}</button>`;
}

function rollupTabTitle(id, rollup) {
  const lines = ['Double-click to rename'];
  if (rollup) {
    lines.push(`${fmtPercent(rollup.share)} of the project duration`);
    if (rollup.criticalShare > 0) {
      lines.push(`${fmtPercent(rollup.criticalShare)} of the critical path`);
    }
    if (rollup.progress != null) lines.push(`${Math.round(rollup.progress)}% complete`);
    if (rollup.parents.length > 1) lines.push(`Also linked from ${rollup.parents.slice(1).join(', ')}`);
  }
  return lines.join(' · ');
}

/**
 * The page strip, with sub-paths gathered under the Main task each belongs to.
 * A flat row of "Sub-Path 1 … 7" told you nothing about what any of them was
 * part of; the parent chip does, and doubles as a jump back to that task.
 *
 * Past a dozen or so the strip stops being navigation and becomes a wall — at a
 * hundred sub-paths it wrapped to nineteen rows and took over half the window,
 * pushing the canvas off the bottom. Above the threshold it collapses to Main,
 * wherever you are now, and a searchable picker for the rest.
 */
function updateTabUI() {
  const state = getState();
  const tabs = $('page-tabs');
  const groups = groupPagesByMainNode();
  const subCount = subPageIds().length;
  const compact = subCount > TABS_COMPACT_ABOVE;

  if (compact) {
    const here = state.activeView !== 'main' ? tabButtonHtml(state.activeView, state.activeView) : '';
    tabs.innerHTML = tabButtonHtml('main', state.activeView) + here +
      `<button type="button" id="btn-page-picker" class="tab-picker"
               aria-haspopup="true" aria-expanded="false" aria-controls="page-picker"
               title="Find and open a sub-path">
         <i data-lucide="search" class="w-3 h-3" aria-hidden="true"></i>
         ${subCount} sub-paths
       </button>`;
    $('btn-page-picker').addEventListener('click', event => {
      event.stopPropagation();
      togglePagePicker();
    });
  } else {
    tabs.innerHTML = tabButtonHtml('main', state.activeView) + groups.map(group => {
      const chip = group.mainNodeId
        ? `<button type="button" class="tab-parent" data-parent-node="${escapeHtml(group.mainNodeId)}" title="${escapeHtml(`${group.mainNodeId} — ${group.mainTitle}`)}">${escapeHtml(group.mainNodeId)}<span aria-hidden="true">▸</span></button>`
        : '<span class="tab-parent tab-parent-none" title="Not linked from any Main task">⌁</span>';
      return `<span class="tab-group">${chip}${group.pages.map(id => tabButtonHtml(id, state.activeView)).join('')}</span>`;
    }).join('');
  }

  tabs.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
    btn.addEventListener('dblclick', event => {
      event.preventDefault();
      if (btn.dataset.view !== 'main') openSubpathModal(btn.dataset.view);
    });
  });
  tabs.querySelectorAll('[data-parent-node]').forEach(btn => {
    btn.addEventListener('click', () =>
      followNodeLink({ linkedMainNode: btn.dataset.parentNode }, nav));
  });
  if (!compact) closePagePicker();

  updateViewLabel();
  $('project-title').textContent = state.projectTitle;
  updateLayoutButtons();
  updatePertButton();
  syncDisplayMenu();
  refreshIcons(tabs);
}

// ─── Page picker ───────────────────────────────────────────
//
// The searchable stand-in for the tab strip once there are too many pages to
// show at once. Filters on the page title, on the Main task it hangs from, and
// on that task's title, because at a hundred sub-paths "Sub-Path 73" is not
// what anyone remembers — "the one under T73, the survey" is.

function pagePickerRows(filter) {
  const state = getState();
  const needle = filter.trim().toLowerCase();
  const rows = [];

  groupPagesByMainNode().forEach(group => {
    group.pages.forEach(id => {
      const rollup = rollupForPage(id);
      const parent = group.mainNodeId || '';
      const haystack = `${pageTitle(id)} ${parent} ${group.mainTitle || ''}`.toLowerCase();
      if (needle && !haystack.includes(needle)) return;
      rows.push({ id, parent, parentTitle: group.mainTitle || '', rollup });
    });
  });

  return rows;
}

function renderPagePicker(filter = '') {
  const list = $('page-picker-list');
  const rows = pagePickerRows(filter);
  const active = getState().activeView;

  if (!rows.length) {
    list.innerHTML = '<p class="hint px-2 py-3">No sub-path matches that.</p>';
    return;
  }

  list.innerHTML = rows.map(row => `
    <button type="button" class="picker-row${row.id === active ? ' picker-row-active' : ''}"
            data-picker-view="${escapeHtml(row.id)}">
      <span class="picker-title">${escapeHtml(pageTitle(row.id))}</span>
      ${row.parent
        ? `<span class="picker-parent" title="${escapeHtml(`${row.parent} — ${row.parentTitle}`)}">${escapeHtml(row.parent)}</span>`
        : '<span class="picker-parent picker-parent-none" title="Not linked from any Main task">⌁</span>'}
      ${row.rollup && row.rollup.share > 0
        ? `<span class="picker-share">${fmtPercent(row.rollup.share)}</span>`
        : '<span class="picker-share"></span>'}
    </button>`).join('');
}

function togglePagePicker() {
  const menu = $('page-picker');
  if (!menu.classList.contains('hidden')) {
    closePagePicker();
    return;
  }
  renderPagePicker('');
  menu.classList.remove('hidden');
  $('btn-page-picker')?.setAttribute('aria-expanded', 'true');

  const anchor = $('btn-page-picker').getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${anchor.bottom + 4}px`;

  const search = $('page-picker-search');
  search.value = '';
  search.focus();
  refreshIcons(menu);
}

function closePagePicker() {
  const menu = $('page-picker');
  if (!menu || menu.classList.contains('hidden')) return;
  menu.classList.add('hidden');
  $('btn-page-picker')?.setAttribute('aria-expanded', 'false');
}

function isPagePickerOpen() {
  return !$('page-picker').classList.contains('hidden');
}

function wirePagePicker() {
  const menu = $('page-picker');
  menu.addEventListener('click', event => {
    event.stopPropagation();
    const row = event.target.closest('[data-picker-view]');
    if (!row) return;
    closePagePicker();
    switchView(row.dataset.pickerView);
  });
  $('page-picker-search').addEventListener('input', event =>
    renderPagePicker(event.target.value));
  // Enter opens the only thing left, which is what filtering down to one is for.
  $('page-picker-search').addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    const first = menu.querySelector('[data-picker-view]');
    if (!first) return;
    event.preventDefault();
    closePagePicker();
    switchView(first.dataset.pickerView);
  });
  document.addEventListener('click', () => closePagePicker());
}

/** Which page you are on, and — for a sub-path — what it is worth. */
function updateViewLabel() {
  const state = getState();
  const rollup = state.activeView === 'main' ? null : rollupForPage(state.activeView);
  const parts = [pageTitle(state.activeView)];
  if (rollup) {
    parts.push(`${fmtPercent(rollup.share)} of Main`);
    parts.push(`via ${rollup.mainNodeId}`);
  }
  $('view-label').textContent = `(${parts.join(' · ')})`;
}

function switchView(view) {
  const state = getState();
  if (!state.diagrams[view] || view === state.activeView) return;
  savePositionsFromNetwork();
  state.activeView = view;
  clearSelection();
  clearTrace();
  // Tags differ from page to page, so a filter set on one page would otherwise
  // arrive on the next matching nothing and dim the whole diagram.
  clearActiveTags();
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
  const ghosts = d.ghosts || 'off';
  document.querySelectorAll('#display-menu [data-ghosts]').forEach(radio => {
    radio.checked = radio.dataset.ghosts === ghosts;
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
    // Spelled out rather than left undefined: normalizeState only runs on load,
    // so a task created here would otherwise reach the saved file missing keys
    // the documented format says it carries.
    assignee: '',
    tags: [],
    cost: 0,
    actualCost: null,
    mustFinishBy: null,
    startNoEarlierThan: null,
    dependencies: [],
    position: { x, y },
    linkedSubPage: null,
    linkedMainNode: null
  };
}

/**
 * Somewhere visible and unoccupied. Adding from the toolbar always used the
 * origin, which both stacked new tasks on top of each other and dropped them
 * off-screen once you had panned away from it.
 */
function placeNewTask() {
  const centre = viewCentre();
  return freeSpotNear(centre.x, centre.y, allNodes().map(n => n.position || { x: 0, y: 0 }));
}

function addNodeAt(x, y) {
  const diagram = currentDiagram();
  if (!diagram.milestones.length) {
    diagram.milestones.push({ id: uid('m'), title: 'Phase 1', nodes: [] });
  }
  const spot = (x == null || y == null) ? placeNewTask() : { x, y };
  const id = nextNodeId();
  diagram.milestones[0].nodes.push(newTask(id, spot.x, spot.y));
  onChange(null);
  openNodeModal(id);
}

function addNodeToMilestone(msId) {
  const ms = currentDiagram().milestones.find(m => m.id === msId);
  if (!ms) return;
  const id = nextNodeId();
  const spot = placeNewTask();
  ms.nodes.push(newTask(id, spot.x, spot.y));
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

/**
 * Node dimensions for layout, with room left for whatever hangs below.
 *
 * The layouts space rows by how tall the tasks in them actually are. A ghosted
 * sub-path is drawn below its parent but is not a task, so without this the
 * next row lands straight on top of it and the branch is lost behind the
 * diagram it belongs to. Claiming the height up front is what gives it room.
 */
function ghostAwareSize(nodes) {
  const state = getState();
  const mode = displayOpts().ghosts || 'off';
  // Only "all" reserves room. Under "selected" the branch is transient and one
  // at a time, and permanently spreading the diagram out for it would cost more
  // than it gives.
  if (mode !== 'all' || state.activeView !== 'main') return nodeSizeOf;

  const depths = new Map();
  nodes.forEach(n => {
    const page = n.linkedSubPage && state.diagrams[n.linkedSubPage];
    if (!page) return;
    const sub = allNodes(page);
    if (!sub.length) return;
    depths.set(n.id, ghostLayout(sub, { x: 0, y: 0 }).depth);
  });
  if (!depths.size) return nodeSizeOf;

  return id => {
    const size = nodeSizeOf(id);
    const depth = depths.get(id) || 0;
    if (!size || !depth) return size;
    return { width: size.width, height: size.height + depth + GHOST_ROW_GAP };
  };
}

function applyAutoLayout() {
  const nodes = allNodes();
  if (!nodes.length) {
    toast('No tasks to lay out', 'info');
    return;
  }

  getState().layoutMode = 'cpm';
  const { positions } = computeCpmLayout(nodes, schedule(), { sizeOf: ghostAwareSize(nodes) });
  nodes.forEach(n => {
    if (positions[n.id]) n.position = positions[n.id];
  });

  updateLayoutButtons();
  onChange('CPM auto-layout applied', { fit: true });
}

/**
 * Columns view: one column per milestone, tasks within it in schedule order.
 * The row a task occupies here is the row its card takes in the panel, so the
 * two read as the same table.
 */
function applyMilestoneLayout({ silent = false } = {}) {
  const diagram = currentDiagram();
  if (!diagram.milestones.length) {
    if (!silent) toast('Add a milestone first', 'info');
    return;
  }

  getState().layoutMode = 'milestone';
  const { metrics } = schedule();
  const { columns } = columnLayout(diagram);
  const rowHeight = columnRowHeight(diagram.milestones, nodeSizeOf);
  const originY = columnRowOrigin(diagram.milestones, rowHeight);

  diagram.milestones.forEach((ms, col) => {
    orderedNodes(ms, metrics).forEach((n, row) => {
      n.position = {
        x: columns[col] ? columns[col].centre : 0,
        y: originY + row * rowHeight
      };
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

// ─── Tag filter ────────────────────────────────────────────
//
// Transient view state, like the search query: it dims what it excludes rather
// than editing the project, so it takes no history entry and is not saved.

function toggleTagFilter(tag) {
  if (!tag) return;
  toggleActiveTag(tag);
  render();
}

function clearTagFilter() {
  clearActiveTags();
  render();
}

// ─── Share link ────────────────────────────────────────────

async function shareLink() {
  try {
    const link = await buildShareLink(getState());
    if (link.length > MAX_LINK_LENGTH) {
      toast('This project is too large to share as a link — use Save JSON instead', 'error');
      return;
    }
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(link);
      // The link carries the whole project, unencrypted — anyone who has it can
      // read every task, owner, and cost. Say so, since a link feels casual.
      toast('Link copied — it contains the whole project; share it only with people who may see all its data', 'success');
    } else {
      // No clipboard access (older browser, insecure origin) — hand it over to copy.
      window.prompt('Copy this link. It contains the whole project — share it only with people who may see all its data.', link);
    }
  } catch (err) {
    toast('Could not create a share link: ' + (err?.message || err), 'error');
  }
}

/**
 * A project encoded into the URL wins over the restored session: someone
 * followed a link to see *this* plan, not to be dropped back into their own.
 * The hash is cleared once read, so a reload does not re-import and Save does
 * not inherit it. Returns whether a shared plan was loaded.
 */
async function loadSharedIfPresent() {
  const payload = sharedPayloadInUrl();
  if (!payload) return false;
  try {
    const data = await decodeProject(payload);
    setState(normalizeState(data));
    history.replaceState(null, '', location.pathname + location.search);
    return true;
  } catch {
    toast('That shared link could not be read — starting fresh', 'error');
    return false;
  }
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

/**
 * Commit a levelling proposal as ordinary start constraints.
 *
 * Writing the delays as `startNoEarlierThan` rather than storing a levelled
 * schedule of its own means the result is inspectable and editable as any other
 * constraint, undo is one step, and nothing has to remember that these dates
 * came from levelling rather than from someone typing them.
 */
function applyLevelling(mode) {
  const { metrics, nodes, graph, projectDuration: before } = schedule();
  if (graph.cycleIds.length) {
    toast('Resolve the circular dependency first', 'error');
    return;
  }

  const { delays, constrained, projectDuration, unresolved } = levelResources(nodes, metrics, {
    capacity: getResourceCapacity(),
    mode
  });
  if (!delays.size) {
    toast('Nothing to level', 'info');
    return;
  }

  // Only the tasks the resource pushed get a constraint. Their successors move
  // because the logic says they must, which is already written down.
  constrained.forEach(id => {
    const found = findNode(id);
    if (found) found.node.startNoEarlierThan = +(metrics[id].ES + delays.get(id)).toFixed(4);
  });

  const moved = `${delays.size} task${delays.size === 1 ? '' : 's'}`;
  const slip = +(projectDuration - before).toFixed(4);
  onChange(unresolved.length
    ? `Levelled ${moved}; ${unresolved.join(', ')} could not be separated within their float`
    : `Levelled ${moved}${slip > 0 ? `, finishing ${slip}d later` : ''}`);
}

// ─── Wiring ────────────────────────────────────────────────

function wireToolbar() {
  $('btn-add-subpath').addEventListener('click', () => openSubpathModal(null));
  $('btn-connect').addEventListener('click', () => setConnectMode(!isConnectMode()));
  $('btn-add-node').addEventListener('click', () => addNodeAt());
  $('btn-auto-layout').addEventListener('click', () => applyAutoLayout());
  $('btn-milestone-layout').addEventListener('click', () => applyMilestoneLayout());
  $('btn-fit').addEventListener('click', () => fitView(300));
  $('btn-undo').addEventListener('click', doUndo);
  $('btn-redo').addEventListener('click', doRedo);
  $('btn-gantt').addEventListener('click', () => setGanttOpen(!isGanttOpen()));
  $('btn-resources').addEventListener('click', () => setResourcesOpen(!isResourcesOpen()));
  $('btn-quality').addEventListener('click', () => setQualityOpen(!isQualityOpen()));
  $('btn-evm').addEventListener('click', () => setEvmOpen(!isEvmOpen()));
  // A list of ids you cannot act on is just a reproach; clicking a finding
  // selects the tasks it names so you can go and look at them.
  $('quality-body').addEventListener('click', event => {
    const button = event.target.closest('[data-health-ids]');
    if (!button) return;
    const ids = button.dataset.healthIds.split(',').filter(Boolean);
    selectNodes(ids, { focus: ids.length === 1 });
    highlightTasks(ids);
  });
  $('tag-filter-bar').addEventListener('click', event => {
    if (event.target.closest('[data-tag-clear]')) {
      clearTagFilter();
      return;
    }
    const btn = event.target.closest('[data-tag-filter]');
    if (btn) toggleTagFilter(btn.dataset.tagFilter);
  });
  $('resource-capacity').addEventListener('change', event => setResourceCapacity(event.target.value));
  // The panel is rebuilt on every render, so the Apply buttons are reached by
  // delegation rather than rebound each time.
  $('resource-body').addEventListener('click', event => {
    const button = event.target.closest('[data-level-apply]');
    if (button) applyLevelling(button.dataset.levelApply);
  });
  $('btn-monte').addEventListener('click', openMonteModal);
  $('btn-save').addEventListener('click', saveJSON);
  $('btn-share').addEventListener('click', shareLink);
  $('btn-export-png').addEventListener('click', exportPNG);
  $('btn-export-svg').addEventListener('click', exportSVG);
  $('btn-export-csv').addEventListener('click', exportCSV);
  // Fit the whole graph into view first, so the print/PDF shows the diagram
  // rather than whatever slice happened to be on screen.
  $('btn-print').addEventListener('click', () => {
    fitView(0);
    window.setTimeout(() => window.print(), 300);
  });
  $('btn-settings').addEventListener('click', openSettingsModal);
  $('btn-theme').addEventListener('click', toggleTheme);
  $('btn-add-milestone').addEventListener('click', () => openMilestoneModal(null));
  $('btn-baseline').addEventListener('click', setBaseline);
  $('btn-clear-baseline').addEventListener('click', clearBaseline);
  $('btn-scenarios').addEventListener('click', openScenariosModal);
  $('modal-scenarios-close').addEventListener('click', closeScenariosModal);
  $('modal-scenarios').addEventListener('click', event => {
    if (event.target.id === 'modal-scenarios') closeScenariosModal();
  });
  $('form-scenario').addEventListener('submit', event => {
    event.preventDefault();
    saveCurrentAsScenario();
  });
  $('scn-list').addEventListener('click', handleScenarioClick);
  $('scn-compare').addEventListener('change', event => {
    const select = event.target.closest('[data-compare-target]');
    if (select) setCompareTarget(select.value);
  });
  $('btn-discard-restore').addEventListener('click', discardSavedWork);
  $('btn-shared-save').addEventListener('click', saveJSON);
  $('btn-zoom-in').addEventListener('click', () => zoomBy(1.25));
  $('btn-zoom-out').addEventListener('click', () => zoomBy(0.8));
  $('btn-canvas-add').addEventListener('click', () => addNodeAt());

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
    resetViewState();
    applyTheme();
    setGanttOpen(isGanttOpen());
    // What is on screen is now the loaded file, not the restored session.
    $('restore-banner').classList.add('hidden');
    $('shared-banner').classList.add('hidden');
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
    const ghost = event.target.closest('[data-ghosts]');
    if (ghost) {
      getState().nodeDisplay.ghosts = ghost.dataset.ghosts;
      commit();
      render();
      return;
    }
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
      const { editNode, gotoPage, gotoMain, addToMs, editMs, delMs, moveMs, dir, tag } = button.dataset;
      if (editNode) openNodeModal(editNode);
      else if (gotoPage) switchView(gotoPage);
      else if (gotoMain) followNodeLink({ linkedMainNode: gotoMain }, nav);
      else if (addToMs) addNodeToMilestone(addToMs);
      else if (editMs) openMilestoneModal(editMs);
      else if (delMs) deleteMilestone(delMs);
      else if (moveMs) moveMilestone(moveMs, Number(dir));
      // A tag chip on a card toggles the same filter as the strip above.
      else if (tag) toggleTagFilter(tag);
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
      if (isPagePickerOpen()) {
        closePagePicker();
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
        addNodeAt();
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

/**
 * The debounced autosave can still have a write pending when the tab goes.
 * `pagehide` fires on close, reload, and navigation away, including the
 * bfcache path that `beforeunload` misses on mobile.
 */
function wireAutosaveFlush() {
  const flush = () => {
    if (autosaveReady) saveNow(getState);
  };
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
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

// ─── Autosave ──────────────────────────────────────────────

/**
 * Put back whatever was on screen when the tab was last closed.
 *
 * Restoring outright rather than asking first: the saved copy is what the user
 * was working on, and a dialog in front of it on every visit would be noise.
 * The banner offers the way back to a blank project, which is the rarer want.
 */
function restoreSavedWork() {
  const saved = readSaved();
  if (!saved) return;
  try {
    const restored = normalizeState(saved.state);
    const untouched = JSON.stringify(restored) === JSON.stringify(normalizeState(createDefaultState()));
    setState(restored);
    // Saying "picked up where you left off" over a project identical to the
    // one everyone starts with tells the user nothing and looks like a bug.
    if (!untouched) showRestoreBanner(saved.savedAt);
  } catch {
    // Written by an older or broken build: start clean rather than failing to
    // boot, and drop it so it cannot fail again.
    clearSaved();
  }
}

function showRestoreBanner(savedAt) {
  const banner = $('restore-banner');
  banner.classList.remove('hidden');
  banner.querySelector('[data-restore-text]').textContent =
    `Picked up where you left off — autosaved ${describeAge(savedAt)}.`;
}

function discardSavedWork() {
  if (!window.confirm('Discard this project and start a fresh one? Save JSON first if you want to keep it.')) return;
  clearSaved();
  setState(normalizeState(createDefaultState()));
  seedHistory();
  $('restore-banner').classList.add('hidden');
  $('shared-banner').classList.add('hidden');
  getState().baseline = null;
  resetViewState();
  applyTheme();
  render({ fit: true });
  toast('Started a fresh project', 'success');
}

/**
 * Swap the working plan for another whole state — the way a scenario is loaded.
 * Like importing a file: the new plan becomes the one on screen, history starts
 * fresh from it, and anything describing the old plan (selection, trace, tag
 * filter, simulation results) is cleared rather than left contradicting it.
 */
function loadScenarioState(newState) {
  setState(normalizeState(newState));
  seedHistory();
  resetViewState();
  applyTheme();
  render({ fit: true });
}

async function boot() {
  // Both libraries come from a CDN. Without this check a blocked or failed
  // request leaves a blank page and a console stack trace.
  const missing = [];
  if (typeof vis === 'undefined') missing.push('vis-network');
  if (typeof lucide === 'undefined') missing.push('lucide');
  if (missing.length) {
    showLoadError(
      `Could not load the bundled ${missing.join(' and ')} library — check that the vendor/ files are present, then reload.`
    );
    return;
  }

  // A shared link, if present, is what to show — ahead of the restored session.
  const fromShare = await loadSharedIfPresent();
  if (!fromShare) restoreSavedWork();
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

  initScenarios({
    // Saving, renaming, or deleting a scenario changes the project but not its
    // schedule, so it takes a history entry and re-renders — without clearing
    // the simulation results, which still describe the live plan.
    onChange: message => {
      commit();
      render();
      if (message) toast(message, 'success');
    },
    onReplace: newState => loadScenarioState(newState),
    refreshIcons: () => refreshIcons($('modal-scenarios'))
  });

  wireToolbar();
  wireDisplayMenu();
  wirePagePicker();
  wireModals();
  wirePanelDelegation();
  wireKeyboard();
  wireProjectTitle();
  wireWindowResize();
  wireAutosaveFlush();
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
    // The note explaining what the canvas is or is not ghosting lives in the
    // summary strip, so it is redrawn whenever the ghosts are.
    onGhostsChanged: () => renderSummary(),
    onOpenGhost: (pageId, nodeId) => {
      switchView(pageId);
      selectNodes([nodeId], { focus: true });
      highlightTasks([nodeId]);
    },
    onPositionsChanged: () => {
      commit();
      updateHistoryButtons();
      drawMinimap();
      scheduleSave(getState);
    }
  });

  // Only from here on: a save queued during boot would overwrite the restored
  // project with a half-initialised one if anything above threw.
  autosaveReady = true;
  render({ fit: true });

  if (fromShare) $('shared-banner').classList.remove('hidden');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
