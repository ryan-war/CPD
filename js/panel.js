// Bottom panel: milestone sections, task cards, and the mini-Gantt.

import { $, escapeHtml, refreshIcons } from './dom.js';
import { schedule, fmt } from './schedule.js';
import { getState, currentDiagram } from './state.js';
import { linkBadgeHtml } from './links.js';

let ganttOpen = false;

export function isGanttOpen() {
  return ganttOpen;
}

export function setGanttOpen(open) {
  ganttOpen = open;
  $('gantt-panel').classList.toggle('open', open);
  const btn = $('btn-gantt');
  btn.classList.toggle('tool-btn-active', open);
  btn.setAttribute('aria-pressed', String(open));
  if (open) renderGantt();
}

function taskCardHtml(node, metrics, criticalIds, successors) {
  const m = metrics[node.id] || {};
  const isCrit = criticalIds.has(node.id);
  const preds = node.dependencies || [];
  const succs = successors.get(node.id) || [];
  const chip = 'px-1.5 py-0.5 rounded bg-slate-900 border border-slate-600 text-slate-300';

  return `
    <article class="bg-slate-800 border ${isCrit ? 'border-[#ff4d4d] critical-glow' : 'border-slate-700'} rounded-lg p-3 flex flex-col gap-2">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="inline-flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold ${isCrit ? 'bg-[#ff4d4d]/20 text-[#ff4d4d] border border-[#ff4d4d]' : 'bg-slate-900 text-slate-200 border border-slate-600'}">${escapeHtml(node.id)}</span>
            <span class="text-sm font-medium truncate">${escapeHtml(node.title)}</span>
            ${linkBadgeHtml(node)}
          </div>
          <p class="text-xs text-slate-400 mt-1 line-clamp-2">${escapeHtml(node.description || 'No description')}</p>
        </div>
        <button type="button" data-edit-node="${escapeHtml(node.id)}" class="edit-node-btn p-1.5 rounded hover:bg-slate-700 text-slate-400 shrink-0" aria-label="Edit task ${escapeHtml(node.id)}"><i data-lucide="pencil" class="w-3.5 h-3.5" aria-hidden="true"></i></button>
      </div>
      <div class="grid grid-cols-3 gap-1.5 text-[10px]">
        <div class="bg-slate-900/80 rounded px-1.5 py-1 border border-slate-700/80">
          <div class="text-slate-500">Duration</div>
          <div class="text-slate-200">Min ${escapeHtml(node.min)}d · Max ${escapeHtml(node.max)}d</div>
        </div>
        <div class="bg-slate-900/80 rounded px-1.5 py-1 border border-slate-700/80">
          <div class="text-slate-500">ES / EF</div>
          <div class="text-slate-200">${fmt(m.ES)} / ${fmt(m.EF)}</div>
        </div>
        <div class="bg-slate-900/80 rounded px-1.5 py-1 border ${isCrit ? 'border-[#ff4d4d]/40' : 'border-slate-700/80'}">
          <div class="text-slate-500">Slack</div>
          <div class="${isCrit ? 'text-[#ff4d4d] font-semibold' : 'text-slate-200'}">${fmt(m.slack)}d ${isCrit ? '· CRITICAL' : ''}</div>
        </div>
      </div>
      <div class="flex flex-wrap gap-1 text-[10px]">
        <span class="text-slate-500 self-center">Pred:</span>
        ${preds.length ? preds.map(p => `<span class="${chip}">${escapeHtml(p)}</span>`).join('') : '<span class="text-slate-600">none</span>'}
        <span class="text-slate-500 self-center ml-1">Succ:</span>
        ${succs.length ? succs.map(s => `<span class="${chip}">${escapeHtml(s)}</span>`).join('') : '<span class="text-slate-600">none</span>'}
      </div>
    </article>`;
}

function milestoneActionsHtml(ms, compact) {
  const title = escapeHtml(ms.title);
  const id = escapeHtml(ms.id);
  if (compact) {
    return `
      <div class="flex items-center gap-0.5 shrink-0">
        <button type="button" data-add-to-ms="${id}" class="add-to-ms p-1 rounded hover:bg-slate-700 text-slate-400" aria-label="Add task to ${title}"><i data-lucide="plus" class="w-3.5 h-3.5" aria-hidden="true"></i></button>
        <button type="button" data-edit-ms="${id}" class="edit-ms p-1 rounded hover:bg-slate-700 text-slate-400" aria-label="Rename ${title}"><i data-lucide="pencil" class="w-3 h-3" aria-hidden="true"></i></button>
        <button type="button" data-del-ms="${id}" class="del-ms p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-red-400" aria-label="Delete ${title}"><i data-lucide="trash-2" class="w-3 h-3" aria-hidden="true"></i></button>
      </div>`;
  }
  return `
    <div class="flex items-center gap-1">
      <button type="button" data-add-to-ms="${id}" class="add-to-ms px-2 py-1 text-[11px] rounded border border-slate-600 hover:bg-slate-700 flex items-center gap-1"><i data-lucide="plus" class="w-3 h-3" aria-hidden="true"></i> Task</button>
      <button type="button" data-edit-ms="${id}" class="edit-ms p-1.5 rounded hover:bg-slate-700 text-slate-400" aria-label="Rename ${title}"><i data-lucide="pencil" class="w-3.5 h-3.5" aria-hidden="true"></i></button>
      <button type="button" data-del-ms="${id}" class="del-ms p-1.5 rounded hover:bg-slate-700 text-slate-400 hover:text-red-400" aria-label="Delete ${title}"><i data-lucide="trash-2" class="w-3.5 h-3.5" aria-hidden="true"></i></button>
    </div>`;
}

export function renderBottomPanel() {
  const container = $('milestones-container');
  const diagram = currentDiagram();
  const { metrics, criticalIds, nodes, graph } = schedule();
  const columnsMode = getState().layoutMode === 'milestone';

  const successors = new Map(nodes.map(n => [n.id, []]));
  nodes.forEach(n => {
    (n.dependencies || []).forEach(dep => {
      if (successors.has(dep)) successors.get(dep).push(n.id);
    });
  });

  if (!diagram.milestones.length) {
    container.className = columnsMode ? '' : 'space-y-4 flex-1 min-h-0';
    container.innerHTML = `
      <div class="text-center py-10 text-slate-500 text-sm w-full">
        No milestones yet. Select <strong class="text-slate-300">Add Milestone</strong> to get started.
      </div>`;
    return;
  }

  if (columnsMode) {
    container.className = '';
    container.innerHTML = diagram.milestones.map(ms => `
      <div class="swim-col">
        <div class="swim-col-head flex items-center justify-between gap-2">
          <h3 class="text-xs font-semibold text-slate-200 truncate" title="${escapeHtml(ms.title)}">${escapeHtml(ms.title)}</h3>
          ${milestoneActionsHtml(ms, true)}
        </div>
        <div class="swim-col-body">
          ${(ms.nodes || []).map(n => taskCardHtml(n, metrics, criticalIds, successors)).join('') || '<p class="text-xs text-slate-500">No tasks</p>'}
        </div>
      </div>`).join('');
  } else {
    container.className = 'space-y-4 flex-1 min-h-0';
    container.innerHTML = diagram.milestones.map(ms => `
      <section class="border border-slate-700 rounded-xl bg-slate-800/40 overflow-hidden">
        <div class="flex items-center justify-between px-3 py-2 border-b border-slate-700 bg-slate-800/80">
          <h3 class="text-sm font-medium text-slate-200">${escapeHtml(ms.title)}</h3>
          ${milestoneActionsHtml(ms, false)}
        </div>
        <div class="p-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          ${(ms.nodes || []).map(n => taskCardHtml(n, metrics, criticalIds, successors)).join('') || '<p class="text-xs text-slate-500 col-span-full">No tasks in this milestone.</p>'}
        </div>
      </section>`).join('');
  }

  renderCycleWarning(graph.cycleIds);
  refreshIcons(container);
}

/**
 * A dependency loop makes the schedule undefined. The old build returned a
 * duration of zero and no critical path with no explanation; naming the tasks
 * involved is the difference between "the app is broken" and "fix this link".
 */
function renderCycleWarning(cycleIds) {
  const banner = $('cycle-warning');
  if (!banner) return;
  if (!cycleIds.length) {
    banner.classList.add('hidden');
    banner.textContent = '';
    return;
  }
  banner.classList.remove('hidden');
  banner.textContent =
    `Circular dependency — no schedule can be calculated. Tasks involved: ${cycleIds.join(', ')}.`;
}

export function renderGantt() {
  const panel = $('gantt-panel');
  const body = $('gantt-body');
  if (!ganttOpen) {
    panel.classList.remove('open');
    return;
  }
  panel.classList.add('open');

  const { metrics, projectDuration, criticalIds, nodes } = schedule();
  if (!nodes.length || projectDuration <= 0) {
    body.innerHTML = '<p class="text-xs text-slate-500">No schedule to display.</p>';
    $('gantt-scale').textContent = '';
    return;
  }

  $('gantt-scale').textContent = `0 → ${projectDuration.toFixed(1)}d`;
  const sorted = [...nodes].sort(
    (a, b) => (metrics[a.id].ES - metrics[b.id].ES) || String(a.id).localeCompare(String(b.id))
  );

  body.innerHTML = sorted.map(n => {
    const m = metrics[n.id];
    const left = (m.ES / projectDuration) * 100;
    const width = Math.max(1.5, (m.duration / projectDuration) * 100);
    const prog = Math.max(0, Math.min(100, Number(n.progress) || 0));
    const crit = criticalIds.has(n.id);
    return `<div class="gantt-row">
      <div class="text-[11px] text-slate-300 truncate" title="${escapeHtml(n.title)}"><span class="font-semibold ${crit ? 'text-[#ff4d4d]' : ''}">${escapeHtml(n.id)}</span> ${escapeHtml(n.title)}</div>
      <div class="gantt-bar-track">
        <div class="gantt-bar ${crit ? 'critical' : 'normal'}" style="left:${left}%;width:${width}%">
          <div class="prog" style="width:${prog}%"></div>
          <span class="relative z-[1]">${fmt(m.ES)}–${fmt(m.EF)}</span>
        </div>
      </div>
    </div>`;
  }).join('');
}

export function renderSummary() {
  const { projectDuration, criticalIds, nodes, graph } = schedule();
  const state = getState();
  $('sum-duration').textContent = nodes.length && !graph.cycleIds.length
    ? projectDuration.toFixed(1) + 'd'
    : '—';
  $('sum-critical').textContent = nodes.length && !graph.cycleIds.length
    ? ([...criticalIds].join(', ') || 'none')
    : '—';
  $('sum-mode').textContent = state.estimationMode === 'pert' ? 'PERT' : 'Avg';
}

/**
 * Simulation percentiles describe the schedule as it was when the run
 * happened, so they are cleared whenever the project changes rather than left
 * on screen contradicting the current numbers.
 */
export function clearMonteCarloSummary() {
  $('sum-mc').classList.add('hidden');
}
