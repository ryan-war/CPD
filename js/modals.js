// Dialogs: task, dependency, milestone, sub-path, settings, and Monte Carlo.

import { $, escapeHtml, toast, openModal, closeModal, isModalOpen } from './dom.js';
import { isLaneId, CRITICAL_COLOR } from './config.js';
import { schedule, setCriticality } from './schedule.js';
import { runMonteCarlo, histogram } from './simulate.js';
import { DEPENDENCY_TYPES, DEPENDENCY_LABELS, dependenciesOf, toDependency } from './cpm.js';
import { WEEKDAY_NAMES, DEFAULT_CALENDAR } from './calendar.js';
import {
  getState, currentDiagram, allNodes, findNode, pageTitle, subPageIds, uid
} from './state.js';

let app = {};

export function initModals(callbacks) {
  app = callbacks;
}

// ─── Task ──────────────────────────────────────────────────

function populateLinkedSelect(currentValue) {
  const select = $('edit-linked');
  const label = $('edit-linked-label');
  const hint = $('edit-linked-hint');

  if (getState().activeView === 'main') {
    label.textContent = 'Linked Sub-Page';
    hint.textContent = 'Jump from this Main task into a Sub-Path diagram.';
    select.innerHTML = ['<option value="">None</option>'].concat(
      subPageIds().map(id =>
        `<option value="${escapeHtml(id)}"${id === currentValue ? ' selected' : ''}>${escapeHtml(pageTitle(id))}</option>`)
    ).join('');
  } else {
    label.textContent = 'Linked Main Task';
    const mainNodes = allNodes(getState().diagrams.main);
    hint.textContent = mainNodes.length
      ? 'Jump from this Sub-Path task back to a task on the Main Diagram.'
      : 'No tasks on the Main Diagram yet. Add one there first.';
    select.innerHTML = ['<option value="">None</option>'].concat(
      mainNodes.map(n =>
        `<option value="${escapeHtml(n.id)}"${n.id === currentValue ? ' selected' : ''}>${escapeHtml(n.id)} — ${escapeHtml(n.title)}</option>`)
    ).join('');
  }
}

/** Editable list of predecessors, each with a relation type and lag. */
function renderDependencyEditor(node) {
  const host = $('edit-deps');
  const deps = dependenciesOf(node);
  const candidates = allNodes().filter(n => n.id !== node.id);

  if (!candidates.length) {
    host.innerHTML = '<p class="text-[10px] text-muted">No other tasks to depend on yet.</p>';
    return;
  }

  host.innerHTML = deps.map((dep, i) => `
    <div class="dep-row" data-dep-index="${i}">
      <select class="dep-pred" aria-label="Predecessor">
        ${candidates.map(c => `<option value="${escapeHtml(c.id)}"${c.id === dep.id ? ' selected' : ''}>${escapeHtml(c.id)} — ${escapeHtml(c.title)}</option>`).join('')}
      </select>
      <select class="dep-type" aria-label="Relation type">
        ${DEPENDENCY_TYPES.map(t => `<option value="${t}"${t === dep.type ? ' selected' : ''}>${t} · ${escapeHtml(DEPENDENCY_LABELS[t])}</option>`).join('')}
      </select>
      <input class="dep-lag" type="number" step="0.5" value="${dep.lag}" aria-label="Lag in days" title="Lag in days; negative overlaps" />
      <button type="button" class="icon-btn icon-btn-danger dep-remove" aria-label="Remove dependency"><i data-lucide="x" class="w-3.5 h-3.5" aria-hidden="true"></i></button>
    </div>`).join('') || '<p class="text-[10px] text-muted">No predecessors.</p>';
}

export function readDependencyEditor() {
  const rows = [...$('edit-deps').querySelectorAll('.dep-row')];
  const seen = new Map();
  rows.forEach(row => {
    const id = row.querySelector('.dep-pred').value;
    if (!id) return;
    seen.set(id, {
      id,
      type: row.querySelector('.dep-type').value,
      lag: Number(row.querySelector('.dep-lag').value) || 0
    });
  });
  return [...seen.values()];
}

export function openNodeModal(nodeId) {
  if (!nodeId || isLaneId(nodeId)) return;
  const found = findNode(nodeId);
  if (!found) return;
  const { node, milestone } = found;

  $('edit-node-id').value = node.id;
  $('edit-id').value = node.id;
  $('edit-title').value = node.title;
  $('edit-description').value = node.description || '';
  $('edit-min').value = node.min;
  $('edit-likely').value = node.likely != null ? node.likely : (Number(node.min) + Number(node.max)) / 2;
  $('edit-max').value = node.max;
  $('edit-status').value = node.status || 'not_started';
  $('edit-progress').value = node.progress != null ? node.progress : 0;

  populateLinkedSelect(getState().activeView === 'main'
    ? (node.linkedSubPage || '')
    : (node.linkedMainNode || ''));
  renderDependencyEditor(node);

  $('edit-milestone').innerHTML = currentDiagram().milestones.map(ms =>
    `<option value="${escapeHtml(ms.id)}"${ms.id === milestone.id ? ' selected' : ''}>${escapeHtml(ms.title)}</option>`
  ).join('');

  openModal('modal-node');
}

export function addDependencyRow() {
  const node = findNode($('edit-node-id').value);
  if (!node) return;
  const existing = readDependencyEditor();
  const candidate = allNodes().find(n =>
    n.id !== node.node.id && !existing.some(d => d.id === n.id));
  if (!candidate) {
    toast('Every other task is already a predecessor', 'info');
    return;
  }
  renderDependencyEditor({
    ...node.node,
    dependencies: [...existing, { id: candidate.id, type: 'FS', lag: 0 }]
  });
  app.refreshIcons();
}

export function removeDependencyRow(row) {
  const node = findNode($('edit-node-id').value);
  if (!node) return;
  const index = Number(row.dataset.depIndex);
  const next = readDependencyEditor().filter((_, i) => i !== index);
  renderDependencyEditor({ ...node.node, dependencies: next });
  app.refreshIcons();
}

export function closeNodeModal() {
  closeModal('modal-node');
}

export function saveNodeForm(event) {
  event.preventDefault();
  const oldId = $('edit-node-id').value;
  const newId = $('edit-id').value.trim();
  const found = findNode(oldId);
  if (!found) return;

  if (!newId) {
    toast('Task ID is required', 'error');
    return;
  }
  if (newId !== oldId && findNode(newId)) {
    toast(`Task ID "${newId}" already exists`, 'error');
    return;
  }

  const min = Number($('edit-min').value);
  const max = Number($('edit-max').value);
  const likelyRaw = $('edit-likely').value;
  const likely = likelyRaw === '' ? (min + max) / 2 : Number(likelyRaw);

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    toast('Optimistic and Pessimistic must be numbers', 'error');
    return;
  }
  if (max < min) {
    toast('Pessimistic must be at least Optimistic', 'error');
    return;
  }
  if (likely < min || likely > max) {
    toast('Most Likely must be between Optimistic and Pessimistic', 'error');
    return;
  }

  const dependencies = readDependencyEditor().filter(d => d.id !== newId && d.id !== oldId);
  if (app.wouldCycle(oldId, dependencies)) {
    toast('Those dependencies would create a circular path', 'error');
    return;
  }

  const node = found.node;
  const state = getState();
  node.title = $('edit-title').value.trim();
  node.description = $('edit-description').value.trim();
  node.min = min;
  node.likely = likely;
  node.max = max;
  node.status = $('edit-status').value;
  node.progress = Math.max(0, Math.min(100, Number($('edit-progress').value) || 0));
  if (node.status === 'done') node.progress = 100;
  node.dependencies = dependencies.map(toDependency);

  const linkValue = $('edit-linked').value || null;
  if (state.activeView === 'main') {
    node.linkedSubPage = linkValue;
    node.linkedMainNode = null;
  } else {
    node.linkedMainNode = linkValue;
    node.linkedSubPage = null;
  }

  if (newId !== oldId) {
    node.id = newId;
    allNodes().forEach(n => {
      n.dependencies = (n.dependencies || []).map(d => {
        const dep = toDependency(d);
        return dep.id === oldId ? { ...dep, id: newId } : dep;
      });
    });
    if (state.activeView === 'main') {
      Object.keys(state.diagrams).forEach(viewId => {
        if (viewId === 'main') return;
        allNodes(state.diagrams[viewId]).forEach(n => {
          if (n.linkedMainNode === oldId) n.linkedMainNode = newId;
        });
      });
    }
  }

  const targetMsId = $('edit-milestone').value;
  if (targetMsId !== found.milestone.id) {
    found.milestone.nodes = found.milestone.nodes.filter(n => n.id !== node.id);
    const target = currentDiagram().milestones.find(ms => ms.id === targetMsId);
    if (target) target.nodes.push(node);
  }

  closeNodeModal();
  app.onChange('Task saved');
}

// ─── Dependency (from double-clicking a link) ───────────────

export function openEdgeModal(edgeKey) {
  const [fromId, toId] = String(edgeKey).split('->');
  const found = findNode(toId);
  if (!found) return;
  const dep = dependenciesOf(found.node).find(d => d.id === fromId);
  if (!dep) return;

  $('edge-from').value = fromId;
  $('edge-to').value = toId;
  $('edge-summary').textContent = `${fromId} → ${toId}`;
  $('edge-type').innerHTML = DEPENDENCY_TYPES.map(t =>
    `<option value="${t}"${t === dep.type ? ' selected' : ''}>${t} · ${escapeHtml(DEPENDENCY_LABELS[t])}</option>`
  ).join('');
  $('edge-lag').value = dep.lag;
  openModal('modal-edge');
}

export function closeEdgeModal() {
  closeModal('modal-edge');
}

export function saveEdgeForm(event) {
  event.preventDefault();
  const fromId = $('edge-from').value;
  const toId = $('edge-to').value;
  const found = findNode(toId);
  if (!found) return;

  found.node.dependencies = dependenciesOf(found.node).map(d =>
    d.id === fromId
      ? { id: d.id, type: $('edge-type').value, lag: Number($('edge-lag').value) || 0 }
      : d
  );
  closeEdgeModal();
  app.onChange('Dependency updated');
}

export function deleteEdge() {
  const fromId = $('edge-from').value;
  const toId = $('edge-to').value;
  const found = findNode(toId);
  if (!found) return;
  found.node.dependencies = dependenciesOf(found.node).filter(d => d.id !== fromId);
  closeEdgeModal();
  app.onChange(`Removed ${fromId} → ${toId}`);
}

// ─── Milestone ─────────────────────────────────────────────

export function openMilestoneModal(msId) {
  if (msId) {
    const ms = currentDiagram().milestones.find(m => m.id === msId);
    if (!ms) return;
    $('modal-milestone-title').textContent = 'Edit Milestone';
    $('edit-ms-id').value = ms.id;
    $('edit-ms-title').value = ms.title;
  } else {
    $('modal-milestone-title').textContent = 'Add Milestone';
    $('edit-ms-id').value = '';
    $('edit-ms-title').value = '';
  }
  openModal('modal-milestone');
}

export function closeMilestoneModal() {
  closeModal('modal-milestone');
}

export function saveMilestoneForm(event) {
  event.preventDefault();
  const id = $('edit-ms-id').value;
  const title = $('edit-ms-title').value.trim();
  if (!title) return;

  const diagram = currentDiagram();
  if (id) {
    const ms = diagram.milestones.find(m => m.id === id);
    if (ms) ms.title = title;
  } else {
    diagram.milestones.push({ id: uid('m'), title, nodes: [] });
  }

  closeMilestoneModal();
  app.onChange(id ? 'Milestone renamed' : 'Milestone added', { relayout: true });
}

// ─── Sub-path ──────────────────────────────────────────────

export function openSubpathModal(spId) {
  const deleteBtn = $('btn-delete-subpath');
  if (spId) {
    $('modal-subpath-title').textContent = 'Edit Sub-Path';
    $('edit-sp-id').value = spId;
    $('edit-sp-title').value = pageTitle(spId);
    deleteBtn.classList.remove('hidden');
  } else {
    $('modal-subpath-title').textContent = 'Add Sub-Path';
    $('edit-sp-id').value = '';
    $('edit-sp-title').value = `Sub-Path ${subPageIds().length + 1}`;
    deleteBtn.classList.add('hidden');
  }
  openModal('modal-subpath');
}

export function closeSubpathModal() {
  closeModal('modal-subpath');
}

export function saveSubpathForm(event) {
  event.preventDefault();
  const state = getState();
  const id = $('edit-sp-id').value;
  const title = $('edit-sp-title').value.trim();
  if (!title) return;

  if (id) {
    state.pageTitles[id] = title;
  } else {
    let num = 1;
    while (state.diagrams[`sub_${num}`]) num++;
    const newId = `sub_${num}`;
    state.diagrams[newId] = { milestones: [] };
    state.pageTitles[newId] = title;
    if (!state.pageOrder.includes(newId)) state.pageOrder.push(newId);
    state.activeView = newId;
  }

  closeSubpathModal();
  app.onChange(id ? 'Sub-path renamed' : 'Sub-path added', { fit: true });
}

export function deleteSubpath() {
  const state = getState();
  const id = $('edit-sp-id').value;
  if (!id || id === 'main') return;
  if (!window.confirm(`Delete "${pageTitle(id)}" and all of its milestones and tasks?`)) return;

  Object.values(state.diagrams).forEach(diagram => {
    (diagram.milestones || []).forEach(ms => {
      (ms.nodes || []).forEach(n => {
        if (n.linkedSubPage === id) n.linkedSubPage = null;
      });
    });
  });

  delete state.diagrams[id];
  delete state.pageTitles[id];
  state.pageOrder = state.pageOrder.filter(p => p !== id);
  if (state.activeView === id) state.activeView = 'main';

  closeSubpathModal();
  app.onChange('Sub-path deleted', { fit: true });
}

// ─── Project settings ──────────────────────────────────────

export function openSettingsModal() {
  const state = getState();
  const cal = { ...DEFAULT_CALENDAR, ...(state.calendar || {}) };

  $('set-calendar-enabled').checked = !!cal.enabled;
  $('set-start-date').value = cal.startDate || '';
  $('set-holidays').value = (cal.holidays || []).join('\n');
  $('set-near-critical').value = state.nearCriticalDays;
  $('set-node-shape').value = state.nodeShape;

  $('set-workdays').innerHTML = WEEKDAY_NAMES.map((name, i) => `
    <label class="workday-chip">
      <input type="checkbox" value="${i}"${cal.workdays.includes(i) ? ' checked' : ''} />
      <span>${name}</span>
    </label>`).join('');

  openModal('modal-settings');
}

export function closeSettingsModal() {
  closeModal('modal-settings');
}

export function saveSettingsForm(event) {
  event.preventDefault();
  const state = getState();
  const workdays = [...$('set-workdays').querySelectorAll('input:checked')].map(cb => Number(cb.value));

  if (!workdays.length) {
    toast('Select at least one working day', 'error');
    return;
  }

  state.calendar = {
    enabled: $('set-calendar-enabled').checked,
    startDate: $('set-start-date').value || null,
    workdays,
    holidays: $('set-holidays').value.split(/[\s,]+/).map(s => s.trim()).filter(Boolean)
  };
  state.nearCriticalDays = Math.max(0, Number($('set-near-critical').value) || 0);
  state.nodeShape = $('set-node-shape').value === 'box' ? 'box' : 'circle';

  closeSettingsModal();
  app.onChange('Project settings saved');
}

// ─── Monte Carlo ───────────────────────────────────────────

let simulating = false;

export function openMonteModal() {
  openModal('modal-monte');
}

export function closeMonteModal() {
  closeModal('modal-monte');
}

export async function runSimulation() {
  if (simulating) return;
  const { nodes, rollup, graph } = schedule();

  if (!nodes.length) {
    toast('No tasks to simulate', 'info');
    return;
  }
  if (graph.cycleIds.length) {
    toast('Resolve the circular dependency before simulating', 'error');
    return;
  }

  const runs = Math.max(100, Math.min(20000, Number($('mc-runs').value) || 2000));
  $('mc-runs').value = runs;

  const button = $('btn-run-monte');
  const progress = $('mc-progress');
  simulating = true;
  button.disabled = true;
  button.textContent = 'Running…';
  progress.classList.remove('hidden');
  $('mc-progress-bar').style.width = '0%';

  const stats = await runMonteCarlo({
    nodes,
    rollup,
    runs,
    onProgress: fraction => {
      const pct = Math.round(fraction * 100);
      $('mc-progress-bar').style.width = pct + '%';
      progress.setAttribute('aria-valuenow', String(pct));
    }
  });

  simulating = false;
  button.disabled = false;
  button.textContent = 'Run';
  progress.classList.add('hidden');

  if (!stats) {
    toast('Simulation could not run on this schedule', 'error');
    return;
  }

  showMonteResults(stats);
  setCriticality(stats.criticalityById);
  app.onSimulationComplete();
  toast(`Simulated ${runs} runs`, 'success');
}

function showMonteResults(stats) {
  $('mc-results').classList.remove('hidden');
  $('mc-mean').textContent = stats.mean.toFixed(1) + 'd';
  $('mc-p50').textContent = stats.p50.toFixed(1) + 'd';
  $('mc-p80').textContent = stats.p80.toFixed(1) + 'd';
  $('mc-p95').textContent = stats.p95.toFixed(1) + 'd';

  $('sum-mc').classList.remove('hidden');
  $('sum-p50').textContent = stats.p50.toFixed(1) + 'd';
  $('sum-p80').textContent = stats.p80.toFixed(1) + 'd';
  $('sum-p95').textContent = stats.p95.toFixed(1) + 'd';

  const { counts } = histogram(stats.results);
  const peak = Math.max(...counts, 1);
  $('mc-hist').innerHTML = counts.map(c =>
    `<div class="mc-bar flex-1" style="height:${Math.max(4, (c / peak) * 100)}%" title="${c} runs"></div>`
  ).join('');

  renderCriticality(stats.criticality);
  renderTornado(stats.sensitivity);
}

/** How often each task landed on the critical path across all runs. */
function renderCriticality(criticality) {
  const host = $('mc-criticality');
  const top = criticality.filter(c => c.index > 0).slice(0, 8);
  if (!top.length) {
    host.innerHTML = '<p class="text-[10px] text-muted">No task was critical in any run.</p>';
    return;
  }
  host.innerHTML = top.map(c => `
    <div class="bar-row">
      <span class="bar-label">${escapeHtml(c.id)}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${c.index * 100}%;--bar:${CRITICAL_COLOR}"></div></div>
      <span class="bar-value">${Math.round(c.index * 100)}%</span>
    </div>`).join('');
}

/**
 * Which estimates actually drive the outcome, by correlation between a task's
 * sampled duration and the resulting project duration.
 */
function renderTornado(sensitivity) {
  const host = $('mc-tornado');
  const top = sensitivity.filter(s => Math.abs(s.correlation) > 0.01).slice(0, 8);
  if (!top.length) {
    host.innerHTML = '<p class="text-[10px] text-muted">No single task dominates the outcome.</p>';
    return;
  }
  host.innerHTML = top.map(s => {
    const magnitude = Math.abs(s.correlation);
    return `
      <div class="bar-row">
        <span class="bar-label">${escapeHtml(s.id)}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${magnitude * 100}%;--bar:${s.correlation >= 0 ? '#f59e0b' : '#38bdf8'}"></div></div>
        <span class="bar-value">${s.correlation.toFixed(2)}</span>
      </div>`;
  }).join('');
}

export function anyDialogOpen() {
  return ['modal-node', 'modal-edge', 'modal-milestone', 'modal-subpath', 'modal-settings', 'modal-monte']
    .some(isModalOpen);
}
