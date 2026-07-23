// Bottom panel: milestone sections, task cards, the mini-Gantt, and the legend.

import { $, escapeHtml, refreshIcons } from './dom.js';
import { schedule, fmt, fmtDelta, fmtPercent, getCriticality, rollupForNode } from './schedule.js';
import { getState, currentDiagram } from './state.js';
import { dependenciesOf } from './cpm.js';
import { linkBadgeHtml } from './links.js';
import { orderedNodes } from './layout.js';
import { CRITICAL_COLOR, NEAR_CRITICAL_COLOR, STATUS_COLORS, STATUS_LABELS } from './config.js';

let ganttOpen = false;
let highlightedIds = new Set();

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

/**
 * Mirror the canvas selection onto the cards. Selecting a task on the diagram
 * previously did nothing down here, so finding its card in a large project
 * meant scrolling and hunting.
 */
export function highlightTasks(ids, { scrollIntoView = true } = {}) {
  highlightedIds = new Set(ids);
  const container = $('milestones-container');
  let first = null;
  container.querySelectorAll('[data-task-card]').forEach(card => {
    const on = highlightedIds.has(card.dataset.taskCard);
    card.classList.toggle('task-card-selected', on);
    if (on && !first) first = card;
  });
  if (first && scrollIntoView) {
    first.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function statusChip(node) {
  const color = STATUS_COLORS[node.status] || STATUS_COLORS.not_started;
  return `<span class="status-chip" style="--chip:${color}" title="${escapeHtml(STATUS_LABELS[node.status] || 'Not started')}">${escapeHtml(STATUS_LABELS[node.status] || 'Not started')}</span>`;
}

function driftChip(drift) {
  if (!drift) return '';
  if (drift.isNew) return '<span class="drift-chip drift-new">new</span>';
  if (!drift.finish) return '<span class="drift-chip drift-flat">on baseline</span>';
  const cls = drift.finish > 0 ? 'drift-late' : 'drift-early';
  return `<span class="drift-chip ${cls}" title="Finish versus baseline">${fmtDelta(drift.finish)}d</span>`;
}

/**
 * What a linked sub-path is worth, on the card of the task standing in for it.
 *
 * Roll-up already replaced the task's estimate with the sub-page's duration,
 * but silently: nothing said how large a share of the project that branch had
 * become, or how far through it was. All three answers go here.
 */
function rollupBlockHtml(rollup) {
  if (!rollup) return '';
  const done = rollup.progress != null ? rollup.progress : 0;
  return `
    <div class="rollup-block" title="Figures rolled up from the linked sub-path">
      <div class="rollup-head">
        <i data-lucide="git-fork" class="w-3 h-3" aria-hidden="true"></i>
        Sub-path roll-up
      </div>
      <div class="grid grid-cols-2 gap-1.5 text-[10px]">
        <div class="stat-tile">
          <div class="text-muted">Of project</div>
          <div>${fmtPercent(rollup.share)} · ${fmt(rollup.duration)}d</div>
        </div>
        <div class="stat-tile ${rollup.isCritical ? 'stat-critical' : ''}">
          <div class="text-muted">Of critical path</div>
          <div>${rollup.isCritical ? fmtPercent(rollup.criticalShare) : 'not on it'}</div>
        </div>
      </div>
      ${rollup.progress != null ? `
      <div class="crit-meter">
        <span class="text-muted text-[10px]">Complete</span>
        <div class="crit-track"><div class="crit-fill rollup-fill" style="width:${done}%"></div></div>
        <span class="text-[10px]">${Math.round(done)}%</span>
      </div>
      <p class="hint">Weighted by task duration across the sub-path.</p>` : ''}
    </div>`;
}

function taskCardHtml(node, ctx) {
  const { metrics, criticalIds, nearCritical, successors, calendar, drift } = ctx;
  const m = metrics[node.id] || {};
  const isCrit = criticalIds.has(node.id);
  const isNear = nearCritical.has(node.id);
  const deps = dependenciesOf(node);
  const succs = successors.get(node.id) || [];
  const criticality = getCriticality()?.get(node.id);
  const taskDrift = drift?.tasks?.[node.id];

  const chip = 'dep-chip';
  const relation = d => (d.type === 'FS' && !d.lag)
    ? escapeHtml(d.id)
    : `${escapeHtml(d.id)}<span class="rel-tag">${escapeHtml(d.type)}${d.lag ? (d.lag > 0 ? '+' : '') + d.lag : ''}</span>`;

  const edgeClass = isCrit ? 'card-critical' : isNear ? 'card-near-critical' : '';
  const progress = Math.max(0, Math.min(100, Number(node.progress) || 0));
  // A task standing in for a sub-page does not own its own completion any
  // more — the sub-page's tasks decide it — so the slider goes away rather
  // than sitting there implying otherwise.
  const rollup = rollupForNode(node);
  const rolledProgress = rollup && rollup.progress != null;

  return `
    <article data-task-card="${escapeHtml(node.id)}" class="task-card ${edgeClass}">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="task-id ${isCrit ? 'task-id-critical' : ''}">${escapeHtml(node.id)}</span>
            <span class="text-sm font-medium truncate">${escapeHtml(node.title)}</span>
            ${statusChip(node)}
            ${driftChip(taskDrift)}
            ${linkBadgeHtml(node)}
          </div>
          <p class="text-xs text-muted mt-1 line-clamp-2">${escapeHtml(node.description || 'No description')}</p>
        </div>
        <button type="button" data-edit-node="${escapeHtml(node.id)}" class="icon-btn shrink-0" aria-label="Edit task ${escapeHtml(node.id)}"><i data-lucide="pencil" class="w-3.5 h-3.5" aria-hidden="true"></i></button>
      </div>

      <div class="grid grid-cols-3 gap-1.5 text-[10px]">
        <div class="stat-tile">
          <div class="text-muted">Duration</div>
          <div>${escapeHtml(node.min)} – ${escapeHtml(node.max)}d</div>
        </div>
        <div class="stat-tile">
          <div class="text-muted">${calendar.enabled ? 'Dates' : 'ES / EF'}</div>
          <div>${calendar.enabled
            ? `${escapeHtml(calendar.formatOffset(m.ES))} → ${escapeHtml(calendar.formatFinish(m.ES, m.duration))}`
            : `${fmt(m.ES)} / ${fmt(m.EF)}`}</div>
        </div>
        <div class="stat-tile ${isCrit ? 'stat-critical' : isNear ? 'stat-near-critical' : ''}">
          <div class="text-muted">Slack</div>
          <div>${fmt(m.slack)}d${isCrit ? ' · CRITICAL' : isNear ? ' · AT RISK' : ''}</div>
        </div>
      </div>

      ${criticality != null ? `
      <div class="crit-meter" title="On the critical path in ${Math.round(criticality * 100)}% of simulated runs">
        <span class="text-muted text-[10px]">Criticality</span>
        <div class="crit-track"><div class="crit-fill" style="width:${criticality * 100}%"></div></div>
        <span class="text-[10px]">${Math.round(criticality * 100)}%</span>
      </div>` : ''}

      ${rollupBlockHtml(rollup)}

      ${rolledProgress ? '' : `
      <label class="progress-row">
        <span class="text-muted text-[10px]">Progress</span>
        <input type="range" min="0" max="100" step="5" value="${progress}"
               data-progress-for="${escapeHtml(node.id)}"
               aria-label="Progress for task ${escapeHtml(node.id)}" />
        <output class="text-[10px] tabular-nums">${progress}%</output>
      </label>`}

      <div class="flex flex-wrap gap-1 text-[10px]">
        <span class="text-muted self-center">Pred:</span>
        ${deps.length ? deps.map(d => `<span class="${chip}">${relation(d)}</span>`).join('') : '<span class="text-faint">none</span>'}
        <span class="text-muted self-center ml-1">Succ:</span>
        ${succs.length ? succs.map(s => `<span class="${chip}">${escapeHtml(s)}</span>`).join('') : '<span class="text-faint">none</span>'}
      </div>
    </article>`;
}

/**
 * Totals for a milestone header. A column titled only "Phase 2" gave no reason
 * to look at it before any other; how much work it holds, how much of that is
 * critical, and how far through it is are the reasons.
 */
function milestoneStats(ms, ctx) {
  const nodes = ms.nodes || [];
  let duration = 0;
  let weighted = 0;
  let critical = 0;

  nodes.forEach(n => {
    const m = ctx.metrics[n.id] || {};
    const d = Number(m.duration) || 0;
    duration += d;
    weighted += d * Math.max(0, Math.min(100, Number(n.progress) || 0));
    if (ctx.criticalIds.has(n.id)) critical++;
  });

  return {
    count: nodes.length,
    duration,
    critical,
    progress: duration > 0 ? weighted / duration : 0
  };
}

function milestoneStatsHtml(ms, ctx) {
  const s = milestoneStats(ms, ctx);
  if (!s.count) return '<span class="ms-stat text-faint">empty</span>';
  return `
    <span class="ms-stat" title="Tasks in this milestone">${s.count} task${s.count === 1 ? '' : 's'}</span>
    <span class="ms-stat" title="Total duration of its tasks">${fmt(s.duration)}d</span>
    ${s.critical ? `<span class="ms-stat ms-stat-critical" title="Tasks on the critical path">${s.critical} critical</span>` : ''}
    <span class="ms-stat" title="Completion, weighted by task duration">${Math.round(s.progress)}%</span>`;
}

function milestoneActionsHtml(ms, index, total, compact) {
  const title = escapeHtml(ms.title);
  const id = escapeHtml(ms.id);
  const size = compact ? 'w-3 h-3' : 'w-3.5 h-3.5';
  return `
    <div class="flex items-center gap-0.5 shrink-0">
      <button type="button" data-move-ms="${id}" data-dir="-1" class="icon-btn" ${index === 0 ? 'disabled' : ''} aria-label="Move ${title} earlier"><i data-lucide="chevron-left" class="${size}" aria-hidden="true"></i></button>
      <button type="button" data-move-ms="${id}" data-dir="1" class="icon-btn" ${index === total - 1 ? 'disabled' : ''} aria-label="Move ${title} later"><i data-lucide="chevron-right" class="${size}" aria-hidden="true"></i></button>
      <button type="button" data-add-to-ms="${id}" class="icon-btn" aria-label="Add task to ${title}"><i data-lucide="plus" class="${size}" aria-hidden="true"></i></button>
      <button type="button" data-edit-ms="${id}" class="icon-btn" aria-label="Rename ${title}"><i data-lucide="pencil" class="${size}" aria-hidden="true"></i></button>
      <button type="button" data-del-ms="${id}" class="icon-btn icon-btn-danger" aria-label="Delete ${title}"><i data-lucide="trash-2" class="${size}" aria-hidden="true"></i></button>
    </div>`;
}

export function renderBottomPanel() {
  const container = $('milestones-container');
  const diagram = currentDiagram();
  const { metrics, criticalIds, nearCritical, nodes, graph, calendar, drift } = schedule();
  const columnsMode = getState().layoutMode === 'milestone';

  const successors = new Map(nodes.map(n => [n.id, []]));
  nodes.forEach(n => {
    dependenciesOf(n).forEach(d => {
      if (successors.has(d.id)) successors.get(d.id).push(n.id);
    });
  });

  const ctx = { metrics, criticalIds, nearCritical, successors, calendar, drift };

  if (!diagram.milestones.length) {
    container.className = columnsMode ? '' : 'space-y-4 flex-1 min-h-0';
    container.style.removeProperty('--swim-cols');
    container.innerHTML = `
      <div class="text-center py-10 text-muted text-sm w-full">
        No milestones yet. Select <strong>Add Milestone</strong> to get started.
      </div>`;
    renderCycleWarning(graph.cycleIds);
    return;
  }

  const total = diagram.milestones.length;
  if (columnsMode) {
    // One grid across every column, with each card placed in an explicit row,
    // so row n lines up horizontally the whole way across — the same ordinal
    // rows the canvas puts its tasks in.
    container.className = '';
    container.style.setProperty('--swim-cols', String(total));
    container.innerHTML = diagram.milestones.map((ms, i) => {
      const head = `
        <div class="swim-col-head" style="grid-column:${i + 1};grid-row:1">
          <div class="flex items-center justify-between gap-2">
            <h3 class="text-xs font-semibold truncate" title="${escapeHtml(ms.title)}">${escapeHtml(ms.title)}</h3>
            ${milestoneActionsHtml(ms, i, total, true)}
          </div>
          <div class="ms-stats">${milestoneStatsHtml(ms, ctx)}</div>
        </div>`;
      const cards = orderedNodes(ms, metrics).map((n, row) =>
        `<div class="swim-cell" style="grid-column:${i + 1};grid-row:${row + 2}">${taskCardHtml(n, ctx)}</div>`
      ).join('') || `<div class="swim-cell" style="grid-column:${i + 1};grid-row:2"><p class="text-xs text-muted">No tasks</p></div>`;
      return head + cards;
    }).join('');
  } else {
    container.className = 'space-y-4 flex-1 min-h-0';
    container.style.removeProperty('--swim-cols');
    container.innerHTML = diagram.milestones.map((ms, i) => `
      <section class="milestone-section">
        <div class="milestone-head">
          <div class="min-w-0">
            <h3 class="text-sm font-medium truncate">${escapeHtml(ms.title)}</h3>
            <div class="ms-stats">${milestoneStatsHtml(ms, ctx)}</div>
          </div>
          ${milestoneActionsHtml(ms, i, total, false)}
        </div>
        <div class="p-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          ${orderedNodes(ms, metrics).map(n => taskCardHtml(n, ctx)).join('') || '<p class="text-xs text-muted col-span-full">No tasks in this milestone.</p>'}
        </div>
      </section>`).join('');
  }

  renderCycleWarning(graph.cycleIds);
  renderBaselineBanner(drift);
  highlightTasks([...highlightedIds], { scrollIntoView: false });
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
  banner.classList.toggle('hidden', !cycleIds.length);
  banner.textContent = cycleIds.length
    ? `Circular dependency — no schedule can be calculated. Tasks involved: ${cycleIds.join(', ')}.`
    : '';
}

function renderBaselineBanner(drift) {
  const banner = $('baseline-banner');
  if (!banner) return;
  if (!drift) {
    banner.classList.add('hidden');
    return;
  }
  banner.classList.remove('hidden');
  const delta = drift.projectDuration;
  const verdict = delta === 0
    ? 'on baseline'
    : `${fmtDelta(delta)}d versus baseline`;
  banner.querySelector('[data-baseline-text]').textContent =
    `Baseline captured ${new Date(drift.capturedAt).toLocaleString()} — ${verdict}.`;
  banner.classList.toggle('baseline-late', delta > 0);
  banner.classList.toggle('baseline-early', delta < 0);
}

// ─── Gantt ─────────────────────────────────────────────────

export function renderGantt() {
  const panel = $('gantt-panel');
  const body = $('gantt-body');
  if (!ganttOpen) {
    panel.classList.remove('open');
    return;
  }
  panel.classList.add('open');

  const { metrics, projectDuration, criticalIds, nearCritical, nodes, calendar } = schedule();
  if (!nodes.length || projectDuration <= 0) {
    body.innerHTML = '<p class="text-xs text-muted">No schedule to display.</p>';
    $('gantt-scale').textContent = '';
    $('gantt-axis').innerHTML = '';
    return;
  }

  $('gantt-scale').textContent = calendar.enabled
    ? `${calendar.formatOffset(0)} → ${calendar.formatFinish(0, projectDuration)}`
    : `0 → ${projectDuration.toFixed(1)}d`;

  renderGanttAxis(projectDuration, calendar);

  const sorted = [...nodes].sort(
    (a, b) => (metrics[a.id].ES - metrics[b.id].ES) || String(a.id).localeCompare(String(b.id))
  );

  body.innerHTML = sorted.map(n => {
    const m = metrics[n.id];
    const left = (m.ES / projectDuration) * 100;
    const width = Math.max(1.5, (m.duration / projectDuration) * 100);
    const prog = Math.max(0, Math.min(100, Number(n.progress) || 0));
    const crit = criticalIds.has(n.id);
    const near = nearCritical.has(n.id);
    const label = calendar.enabled
      ? `${calendar.formatOffset(m.ES)} → ${calendar.formatFinish(m.ES, m.duration)}`
      : `${fmt(m.ES)}–${fmt(m.EF)}`;
    return `<div class="gantt-row" data-gantt-for="${escapeHtml(n.id)}">
      <div class="text-[11px] truncate" title="${escapeHtml(n.title)}"><span class="font-semibold ${crit ? 'text-critical' : ''}">${escapeHtml(n.id)}</span> ${escapeHtml(n.title)}</div>
      <div class="gantt-bar-track">
        <div class="gantt-bar ${crit ? 'critical' : near ? 'near-critical' : 'normal'}" style="left:${left}%;width:${width}%">
          <div class="prog" style="width:${prog}%"></div>
          <span class="relative z-[1]">${escapeHtml(label)}</span>
        </div>
      </div>
    </div>`;
  }).join('');
}

/**
 * Tick marks along the timeline. Bars previously floated against a bare track
 * with only a total in the corner, so there was no way to read a position off
 * the chart.
 */
function renderGanttAxis(projectDuration, calendar) {
  const axis = $('gantt-axis');
  if (!axis) return;
  const target = 6;
  const raw = projectDuration / target;
  const magnitude = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 0.1))));
  const step = [1, 2, 2.5, 5, 10].map(m => m * magnitude).find(s => s >= raw) || magnitude * 10;

  const ticks = [];
  for (let value = 0; value <= projectDuration + 1e-9; value += step) {
    ticks.push({
      value,
      percent: (value / projectDuration) * 100,
      label: calendar.enabled ? calendar.formatOffset(value) : `${fmt(+value.toFixed(4))}d`
    });
  }
  axis.innerHTML = ticks.map(t =>
    `<span class="gantt-tick" style="left:${t.percent}%"><span class="gantt-tick-label">${escapeHtml(t.label)}</span></span>`
  ).join('');
}

// ─── Summary and legend ────────────────────────────────────

export function renderSummary() {
  const { projectDuration, criticalIds, nearCritical, nodes, graph, calendar } = schedule();
  const state = getState();
  const usable = nodes.length && !graph.cycleIds.length;

  $('sum-duration').textContent = usable ? projectDuration.toFixed(1) + 'd' : '—';
  $('sum-critical').textContent = usable ? ([...criticalIds].join(', ') || 'none') : '—';
  $('sum-mode').textContent = state.estimationMode === 'pert' ? 'PERT' : 'Avg';

  const risk = $('sum-at-risk');
  risk.classList.toggle('hidden', !usable || !nearCritical.size);
  if (usable && nearCritical.size) {
    $('sum-at-risk-ids').textContent = [...nearCritical].join(', ');
  }

  const finish = $('sum-finish');
  finish.classList.toggle('hidden', !usable || !calendar.enabled);
  if (usable && calendar.enabled) {
    $('sum-finish-date').textContent = calendar.formatFinish(0, projectDuration);
  }
}

/** Six colours were load-bearing with nothing on screen explaining them. */
export function renderLegend() {
  const legend = $('legend-body');
  if (!legend) return;
  const entries = [
    { color: CRITICAL_COLOR, label: 'Critical path (zero slack)' },
    { color: NEAR_CRITICAL_COLOR, label: `At risk (slack ≤ ${getState().nearCriticalDays}d)` },
    ...Object.entries(STATUS_LABELS).map(([key, label]) => ({
      color: STATUS_COLORS[key], label, fill: true
    }))
  ];
  legend.innerHTML = entries.map(e => `
    <div class="legend-item">
      <span class="legend-swatch ${e.fill ? 'legend-fill' : ''}" style="--swatch:${e.color}"></span>
      <span>${escapeHtml(e.label)}</span>
    </div>`).join('') + `
    <div class="legend-item"><span class="legend-line legend-dashed"></span><span>Non finish-to-start link</span></div>
    <div class="legend-item"><span class="legend-line legend-solid"></span><span>Driving link</span></div>`;
}

/**
 * Simulation percentiles describe the schedule as it was when the run
 * happened, so they are cleared whenever the project changes rather than left
 * on screen contradicting the current numbers.
 */
export function clearMonteCarloSummary() {
  $('sum-mc').classList.add('hidden');
}
