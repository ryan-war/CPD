// Dialogs: task, milestone, sub-path, and Monte Carlo.

import { $, escapeHtml, toast, openModal, closeModal, isModalOpen } from './dom.js';
import { isLaneId } from './config.js';
import { schedule } from './schedule.js';
import { runMonteCarlo, histogram } from './simulate.js';
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

  $('edit-milestone').innerHTML = currentDiagram().milestones.map(ms =>
    `<option value="${escapeHtml(ms.id)}"${ms.id === milestone.id ? ' selected' : ''}>${escapeHtml(ms.title)}</option>`
  ).join('');

  openModal('modal-node');
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
      n.dependencies = (n.dependencies || []).map(d => (d === oldId ? newId : d));
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
  app.onChange(id ? 'Sub-path renamed' : 'Sub-path added', { fit: true, tabs: true });
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
  app.onChange('Sub-path deleted', { fit: true, tabs: true });
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
  const { nodes, mode, rollup, graph } = schedule();

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
  progress.setAttribute('aria-valuenow', '0');
  $('mc-progress-bar').style.width = '0%';

  const stats = await runMonteCarlo({
    nodes,
    mode,
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
}

export function anyDialogOpen() {
  return ['modal-node', 'modal-milestone', 'modal-subpath', 'modal-monte'].some(isModalOpen);
}
