// Bottom panel: milestone sections, task cards, the mini-Gantt, and the legend.

import { $, escapeHtml, refreshIcons } from './dom.js';
import {
  schedule, fmt, fmtDelta, fmtPercent, getCriticality, rollupForNode, isProjectCritical
} from './schedule.js';
import { getState, currentDiagram } from './state.js';
import { dependenciesOf } from './cpm.js';
import { linkBadgeHtml } from './links.js';
import { orderedNodes } from './layout.js';
import { resourceLoad, levelResources, UNASSIGNED } from './resources.js';
import { assessSchedule } from './quality.js';
// network.js does not import this module, so this direction is not a cycle.
import { getGhostNote, getActiveTags, clearActiveTags } from './network.js';
import { tagsOf, tagCounts, matchesTags } from './tags.js';
import { CRITICAL_COLOR, NEAR_CRITICAL_COLOR, LATE_COLOR, STATUS_COLORS, STATUS_LABELS, tagColor } from './config.js';

let ganttOpen = false;
let resourcesOpen = false;
let qualityOpen = false;
let resourceCapacity = 1;
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

export function isResourcesOpen() {
  return resourcesOpen;
}

export function setResourcesOpen(open) {
  resourcesOpen = open;
  $('resource-panel').classList.toggle('open', open);
  const btn = $('btn-resources');
  btn.classList.toggle('tool-btn-active', open);
  btn.setAttribute('aria-pressed', String(open));
  if (open) renderResources();
}

/** How many tasks one person is assumed able to hold at once. */
export function setResourceCapacity(value) {
  resourceCapacity = Math.max(1, Math.min(20, Number(value) || 1));
  if (resourcesOpen) renderResources();
}

/** How many tasks one person is taken to carry at once. */
export function getResourceCapacity() {
  return resourceCapacity;
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

/** A day offset as the user set it: a date when the calendar is on, else a day. */
function offsetLabel(offset, calendar) {
  if (offset == null) return '';
  return calendar.enabled ? calendar.formatOffset(offset) : `day ${fmt(offset)}`;
}

/** A deadline as the user set it: a date when the calendar is on, else a day. */
export function dueLabel(node, calendar) {
  return offsetLabel(node.mustFinishBy, calendar);
}

/**
 * The float tile's tooltip: both floats, and any constraint behind them.
 *
 * Total float is delay before the project moves, free float delay before a
 * successor does. Where they disagree the card shows it, but the reason — a
 * date someone set — only fits here.
 */
function floatTitle(node, m, calendar) {
  const parts = [
    `Total float ${fmt(m.slack)}d — delay before the project moves`,
    `Free float ${fmt(m.freeFloat)}d — delay before a successor moves`
  ];
  if (node.startNoEarlierThan != null) {
    parts.push(`Starts no earlier than ${offsetLabel(node.startNoEarlierThan, calendar)}`);
  }
  if (node.mustFinishBy != null) {
    parts.push(`Due by ${offsetLabel(node.mustFinishBy, calendar)}`);
  }
  return parts.join('\n');
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

/** Named owner, so you can see at a glance who a card belongs to. */
function assigneeChipHtml(node) {
  const name = String(node.assignee || '').trim();
  if (!name) return '';
  return `<span class="assignee-chip" title="Assigned to ${escapeHtml(name)}"><i data-lucide="user" class="w-3 h-3" aria-hidden="true"></i>${escapeHtml(name)}</span>`;
}

/**
 * A task's tags as colour-coded chips. The active filter is reflected here too:
 * a chip on the filter reads as pressed, so the card shows which of its labels
 * is doing the filtering.
 */
function tagChipsHtml(node) {
  const active = getActiveTags();
  return tagsOf(node).map(tag => {
    const on = active.has(tag);
    return `<button type="button" class="tag-chip${on ? ' tag-chip-on' : ''}" data-tag="${escapeHtml(tag)}"
              style="--tag:${tagColor(tag)}" title="Filter the diagram by ${escapeHtml(tag)}">${escapeHtml(tag)}</button>`;
  }).join('');
}

/**
 * On a sub-path page, "critical" on its own means critical *here*. It only
 * matters to the delivery date if the branch above it is critical too, and the
 * diagram would otherwise colour both the same red.
 */
function projectCriticalChipHtml(node) {
  if (getState().activeView === 'main') return '';
  if (!isProjectCritical(getState().activeView, node.id)) return '';
  return '<span class="chain-chip" title="On the critical path of the whole project, not just this page"><i data-lucide="git-branch" class="w-3 h-3" aria-hidden="true"></i>drives Main</span>';
}

function taskCardHtml(node, ctx) {
  const { metrics, criticalIds, nearCritical, successors, calendar, drift } = ctx;
  const m = metrics[node.id] || {};
  const isCrit = criticalIds.has(node.id);
  const isNear = nearCritical.has(node.id);
  const isLate = Number(m.slack) < 0;
  const deps = dependenciesOf(node);
  const succs = successors.get(node.id) || [];
  const criticality = getCriticality()?.get(node.id);
  const taskDrift = drift?.tasks?.[node.id];

  const chip = 'dep-chip';
  const relation = d => (d.type === 'FS' && !d.lag)
    ? escapeHtml(d.id)
    : `${escapeHtml(d.id)}<span class="rel-tag">${escapeHtml(d.type)}${d.lag ? (d.lag > 0 ? '+' : '') + d.lag : ''}</span>`;

  const edgeClass = isLate ? 'card-late' : isCrit ? 'card-critical' : isNear ? 'card-near-critical' : '';
  // A card the tag filter excludes is dimmed rather than hidden, so the columns
  // and rows do not reshuffle every time a filter is toggled.
  const dimClass = matchesTags(node, getActiveTags()) ? '' : ' task-card-dim';
  const progress = Math.max(0, Math.min(100, Number(node.progress) || 0));
  // A task standing in for a sub-page does not own its own completion any
  // more — the sub-page's tasks decide it — so the slider goes away rather
  // than sitting there implying otherwise.
  const rollup = rollupForNode(node);
  const rolledProgress = rollup && rollup.progress != null;

  return `
    <article data-task-card="${escapeHtml(node.id)}" class="task-card ${edgeClass}${dimClass}">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="task-id ${isCrit ? 'task-id-critical' : ''}">${escapeHtml(node.id)}</span>
            <span class="text-sm font-medium truncate">${escapeHtml(node.title)}</span>
            ${statusChip(node)}
            ${assigneeChipHtml(node)}
            ${driftChip(taskDrift)}
            ${projectCriticalChipHtml(node)}
            ${linkBadgeHtml(node)}
            ${tagChipsHtml(node)}
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
        <div class="stat-tile ${isLate ? 'stat-late' : isCrit ? 'stat-critical' : isNear ? 'stat-near-critical' : ''}"
             title="${escapeHtml(floatTitle(node, m, calendar))}">
          <div class="text-muted">${isLate ? 'Float' : 'Slack'}</div>
          <div>${fmt(m.slack)}d${isLate ? ' · LATE' : isCrit ? ' · CRITICAL' : isNear ? ' · AT RISK'
            // Room that cannot be taken without moving a successor is worth
            // saying out loud; equal figures are the common case and noise.
            : m.freeFloat !== m.slack ? ` · ${fmt(m.freeFloat)}d free` : ''}</div>
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

/**
 * The tag filter strip. One toggle per tag on the current page, coloured to
 * match its chips, showing how many tasks carry it. Selecting tags dims
 * everything without them, on the canvas and on the cards at once, so "show me
 * the QA work" is one click rather than a scroll and a squint. Hidden entirely
 * when the page has no tags, so it costs nothing until tags are used.
 */
export function renderTagFilter() {
  const bar = $('tag-filter-bar');
  if (!bar) return;
  const { nodes } = schedule();
  const counts = tagCounts(nodes);
  const active = getActiveTags();

  if (!counts.length) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
    // A filter left active from another page would silently hide tasks here.
    if (active.size) clearActiveTags();
    return;
  }

  bar.classList.remove('hidden');
  const chips = counts.map(({ tag, count }) => {
    const on = active.has(tag);
    return `<button type="button" class="tag-toggle${on ? ' tag-toggle-on' : ''}" data-tag-filter="${escapeHtml(tag)}"
              style="--tag:${tagColor(tag)}" aria-pressed="${on}" title="${count} task${count === 1 ? '' : 's'}">
              ${escapeHtml(tag)}<span class="tag-toggle-count">${count}</span>
            </button>`;
  }).join('');

  bar.innerHTML = `
    <span class="tag-filter-label"><i data-lucide="tag" class="w-3 h-3" aria-hidden="true"></i>Filter by tag</span>
    ${chips}
    ${active.size ? '<button type="button" class="tag-filter-clear" data-tag-clear>Clear</button>' : ''}`;
  refreshIcons(bar);
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

  const {
    metrics, projectDuration, criticalIds, nearCritical, nodes, calendar, dataDate
  } = schedule();
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

  // Where "now" falls across the chart, so a bar can be read as behind or ahead
  // of it rather than merely long.
  const nowPercent = dataDate != null
    ? Math.max(0, Math.min(100, (dataDate / projectDuration) * 100))
    : null;
  const nowMarker = nowPercent == null
    ? ''
    : `<div class="gantt-now" style="left:${nowPercent}%" aria-hidden="true"></div>`;

  body.innerHTML = sorted.map(n => {
    const m = metrics[n.id];
    const left = (m.ES / projectDuration) * 100;
    // The span the task actually occupies. With a data date these part company
    // with the planned duration: finished work stops at the reporting date and
    // work in progress runs from it.
    const span = Math.max(0, m.EF - m.ES);
    const width = Math.max(1.5, (span / projectDuration) * 100);
    // Reported as of a date, the filled portion is the part of the bar already
    // behind that date — the same thing the schedule itself is saying — rather
    // than a percentage read off a slider independently of it.
    const prog = dataDate == null
      ? Math.max(0, Math.min(100, Number(n.progress) || 0))
      : span <= 0 ? 100 : Math.max(0, Math.min(100, ((dataDate - m.ES) / span) * 100));
    const crit = criticalIds.has(n.id);
    const near = nearCritical.has(n.id);
    const label = calendar.enabled
      ? `${calendar.formatOffset(m.ES)} → ${calendar.formatFinish(m.ES, span)}`
      : `${fmt(m.ES)}–${fmt(m.EF)}`;
    return `<div class="gantt-row" data-gantt-for="${escapeHtml(n.id)}">
      <div class="text-[11px] truncate" title="${escapeHtml(n.title)}"><span class="font-semibold ${crit ? 'text-critical' : ''}">${escapeHtml(n.id)}</span> ${escapeHtml(n.title)}</div>
      <div class="gantt-bar-track">
        ${nowMarker}
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

// ─── Resource load ─────────────────────────────────────────

/**
 * One lane per person, over the same timeline as the Gantt. The schedule said
 * when work *could* run but never whether anyone was free to run it, so three
 * critical tasks could sit on one person in one week and the plan called
 * itself feasible. Overloaded stretches are marked.
 */
export function renderResources() {
  const panel = $('resource-panel');
  const body = $('resource-body');
  if (!resourcesOpen) {
    panel.classList.remove('open');
    return;
  }
  panel.classList.add('open');

  const { metrics, projectDuration, nodes, calendar } = schedule();
  if (!nodes.length || projectDuration <= 0) {
    body.innerHTML = '<p class="text-xs text-muted">No schedule to analyse.</p>';
    return;
  }

  const load = resourceLoad(nodes, metrics, { capacity: resourceCapacity });
  const anyNamed = load.some(r => r.name !== UNASSIGNED);
  if (!anyNamed) {
    body.innerHTML = `
      <p class="text-xs text-muted">
        No tasks are assigned to anyone yet. Set <strong>Assigned to</strong> on a
        task to see who is carrying what, and where they are double-booked.
      </p>`;
    return;
  }

  const scale = value => (value / projectDuration) * 100;
  const when = (from, to) => calendar.enabled
    ? `${calendar.formatOffset(from)} → ${calendar.formatFinish(from, to - from)}`
    : `${fmt(from)}–${fmt(to)}d`;

  body.innerHTML = load.map(person => {
    const named = person.name !== UNASSIGNED;
    const over = person.overloadedDays > 0;
    return `
      <div class="resource-row">
        <div class="resource-name ${named ? '' : 'text-faint'}" title="${escapeHtml(named ? person.name : 'Not assigned to anyone')}">
          ${escapeHtml(named ? person.name : 'Unassigned')}
          <span class="resource-meta">${person.tasks.length} task${person.tasks.length === 1 ? '' : 's'}</span>
        </div>
        <div class="resource-track">
          ${person.segments.map(s => `
            <div class="resource-seg${s.over ? ' resource-over' : ''}"
                 style="left:${scale(s.from)}%;width:${Math.max(0.6, scale(s.to - s.from))}%"
                 title="${escapeHtml(`${s.ids.join(', ')} · ${when(s.from, s.to)}${s.over ? ` · ${s.count} at once` : ''}`)}">
            </div>`).join('')}
        </div>
        <div class="resource-verdict ${over ? 'text-late' : 'text-muted'}">
          ${over
            ? `${fmt(person.overloadedDays)}d over`
            : `${fmt(person.busyDays)}d busy`}
        </div>
      </div>`;
  }).join('') + levellingSection(nodes, metrics, projectDuration, calendar, load);
}

/**
 * What levelling would cost, offered before it is applied.
 *
 * Finding the over-allocation was only ever half the job — the float needed to
 * fix most of it is already computed. Both proposals are shown together because
 * the choice between them is the whole question: spend the float, or spend the
 * end date.
 */
function levellingSection(nodes, metrics, projectDuration, calendar, load) {
  const overloaded = load.filter(p => p.name !== UNASSIGNED && p.overloadedDays > 0);
  if (!overloaded.length) return '';

  const within = levelResources(nodes, metrics, {
    capacity: resourceCapacity, mode: 'within-float'
  });
  const full = levelResources(nodes, metrics, {
    capacity: resourceCapacity, mode: 'full'
  });

  const describe = plan => {
    if (!plan.delays.size) return 'nothing it can move';
    return [...plan.delays.entries()]
      .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
      .map(([id, days]) => `${escapeHtml(id)} by ${fmt(days)}d`)
      .join(', ');
  };

  const slip = +(full.projectDuration - projectDuration).toFixed(4);

  return `
    <div class="level-panel">
      <p class="level-intro">
        ${overloaded.map(p => escapeHtml(p.name)).join(', ')}
        ${overloaded.length === 1 ? 'is' : 'are'} carrying more than
        ${resourceCapacity === 1 ? 'one task' : `${resourceCapacity} tasks`} at once.
        Levelling delays tasks so nobody is in two places, tightest float first.
      </p>

      <div class="level-option">
        <div>
          <span class="level-title">Within float</span>
          <span class="level-detail">${describe(within)}</span>
          <span class="level-cost ${within.unresolved.length ? 'text-warning' : 'text-success'}">
            ${within.unresolved.length
              ? `finishes on time, but ${escapeHtml(within.unresolved.join(', '))} still overlap${within.unresolved.length === 1 ? 's' : ''}`
              : 'finishes on time, nothing left over'}
          </span>
        </div>
        <button type="button" class="tool-btn" data-level-apply="within-float"
                ${within.delays.size ? '' : 'disabled'}>Apply</button>
      </div>

      <div class="level-option">
        <div>
          <span class="level-title">Resolve everything</span>
          <span class="level-detail">${describe(full)}</span>
          <span class="level-cost ${slip > 0 ? 'text-late' : 'text-success'}">
            ${slip > 0
              ? `project finishes ${fmt(slip)}d later${calendar.enabled ? `, on ${escapeHtml(calendar.formatFinish(0, full.projectDuration))}` : ''}`
              : 'at no cost to the end date'}
          </span>
        </div>
        <button type="button" class="tool-btn" data-level-apply="full"
                ${full.delays.size ? '' : 'disabled'}>Apply</button>
      </div>

      <p class="hint">
        Applying writes a <strong>start no earlier than</strong> on each delayed task,
        so the result is ordinary constraints you can read, edit, or undo.
      </p>
    </div>`;
}

// ─── Schedule health ───────────────────────────────────────

export function isQualityOpen() {
  return qualityOpen;
}

export function setQualityOpen(open) {
  qualityOpen = open;
  $('quality-panel').classList.toggle('open', open);
  const btn = $('btn-quality');
  btn.classList.toggle('tool-btn-active', open);
  btn.setAttribute('aria-pressed', String(open));
  if (open) renderQuality();
}

/**
 * What the schedule is doing wrong, as against what it is.
 *
 * The findings are lists of task ids, and a list of ids you cannot act on is
 * just a reproach — so each one selects those tasks on the diagram.
 */
export function renderQuality() {
  const panel = $('quality-panel');
  const body = $('quality-body');
  if (!qualityOpen) {
    panel.classList.remove('open');
    return;
  }
  panel.classList.add('open');

  const {
    metrics, nodes, graph, dataDate, outOfSequenceIds
  } = schedule();

  if (!nodes.length) {
    body.innerHTML = '<p class="text-xs text-muted">Nothing to check on this page yet.</p>';
    $('quality-score').textContent = '';
    return;
  }

  const overAllocated = resourceLoad(nodes, metrics, { capacity: resourceCapacity })
    .filter(p => p.name !== UNASSIGNED && p.overloadedDays > 0)
    .map(p => p.name);

  const report = assessSchedule(nodes, metrics, {
    cycleIds: graph.cycleIds,
    outOfSequenceIds,
    overAllocated,
    tracking: dataDate != null
  });

  const score = $('quality-score');
  score.textContent = `${report.passed} of ${report.total} checks passed`;
  score.className = 'text-[10px] font-medium ' + (
    report.worst === 'fail' ? 'text-late' : report.worst === 'warn' ? 'text-warning' : 'text-success'
  );

  // Worst first: the point of the panel is what to look at, not a tidy list.
  const rank = { fail: 0, warn: 1, pass: 2, 'n/a': 3 };
  const ordered = [...report.checks].sort((a, b) => rank[a.severity] - rank[b.severity]);

  body.innerHTML = ordered.map(c => `
    <div class="health-row health-${c.severity.replace('/', '')}">
      <span class="health-mark" aria-hidden="true">${
        c.severity === 'pass' ? '✓' : c.severity === 'fail' ? '!' : c.severity === 'warn' ? '·' : '–'
      }</span>
      <div class="health-text">
        <div class="health-title">
          ${escapeHtml(c.title)}
          ${c.count ? `<span class="health-count">${c.count}</span>` : ''}
        </div>
        <p class="health-detail">${escapeHtml(c.detail)}</p>
        ${c.ids.length ? `
          <button type="button" class="health-ids" data-health-ids="${escapeHtml(c.ids.join(','))}"
                  title="Select these tasks on the diagram">${escapeHtml(summariseIds(c.ids))}</button>` : ''}
      </div>
    </div>`).join('');
}

// ─── Summary and legend ────────────────────────────────────

export function renderSummary() {
  const {
    projectDuration, criticalIds, nearCritical, nodes, graph, calendar, deadline, overrun,
    dataDate, outOfSequenceIds, metrics
  } = schedule();
  const state = getState();
  const usable = nodes.length && !graph.cycleIds.length;

  $('sum-duration').textContent = usable ? projectDuration.toFixed(1) + 'd' : '—';

  // Against a deadline, "how late" is the number that matters, and nothing on
  // screen could express it before.
  const late = $('sum-deadline');
  late.classList.toggle('hidden', !usable || deadline == null);
  if (usable && deadline == null) late.classList.add('hidden');
  if (usable && deadline != null) {
    const target = calendar.enabled ? calendar.formatOffset(deadline) : `day ${fmt(deadline)}`;
    const value = $('sum-deadline-value');
    if (overrun > 0) {
      value.textContent = `${fmt(overrun)}d late`;
      value.className = 'text-late font-medium';
    } else if (overrun < 0) {
      value.textContent = `${fmt(-overrun)}d spare`;
      value.className = 'text-success font-medium';
    } else {
      value.textContent = 'exactly on time';
      value.className = 'text-warning font-medium';
    }
    value.title = `Deadline: ${target}`;
  }
  // On a large project nearly everything can be critical, and spelling out a
  // hundred ids turned the one-line summary into three wrapped rows.
  const critical = $('sum-critical');
  critical.textContent = usable ? summariseIds([...criticalIds]) : '—';
  critical.title = usable && criticalIds.size ? [...criticalIds].join(', ') : '';
  $('sum-mode').textContent = state.estimationMode === 'pert' ? 'PERT' : 'Avg';

  const risk = $('sum-at-risk');
  risk.classList.toggle('hidden', !usable || !nearCritical.size);
  if (usable && nearCritical.size) {
    const atRisk = $('sum-at-risk-ids');
    atRisk.textContent = summariseIds([...nearCritical]);
    atRisk.title = [...nearCritical].join(', ');
  }

  const finish = $('sum-finish');
  finish.classList.toggle('hidden', !usable || !calendar.enabled);
  if (usable && calendar.enabled) {
    $('sum-finish-date').textContent = calendar.formatFinish(0, projectDuration);
  }

  // Reported as of a date, the headline duration is a forecast rather than a
  // plan, and how complete the work is says whether to believe it.
  const asOf = $('sum-as-of');
  asOf.classList.toggle('hidden', !usable || dataDate == null);
  if (usable && dataDate != null) {
    $('sum-as-of-date').textContent = calendar.enabled
      ? calendar.formatOffset(dataDate)
      : `day ${fmt(dataDate)}`;
    const complete = completedShare(nodes, metrics);
    $('sum-as-of-progress').textContent = complete == null
      ? 'nothing estimated'
      : `${Math.round(complete * 100)}% complete`;
  }

  // Tasks reporting progress the network says they could not yet have made.
  // Usually the logic is wrong, occasionally the progress is; either way it is
  // the schedule quietly disagreeing with itself and worth saying.
  const oos = $('sum-out-of-sequence');
  const flagged = usable && dataDate != null ? (outOfSequenceIds || []) : [];
  oos.classList.toggle('hidden', !flagged.length);
  if (flagged.length) $('sum-out-of-sequence-ids').textContent = summariseIds(flagged);

  // When the canvas could not draw every ghosted sub-path it was asked for,
  // say so. A diagram quietly missing branches looks complete and is not.
  const ghosts = $('sum-ghosts');
  const note = getGhostNote();
  ghosts.classList.toggle('hidden', !note);
  if (note) ghosts.textContent = note;
}

/**
 * A list of task ids for a one-line summary: the first few, then a count. The
 * full list stays available as the element's tooltip.
 */
function summariseIds(ids, limit = 12) {
  if (!ids.length) return 'none';
  if (ids.length <= limit) return ids.join(', ');
  return `${ids.slice(0, limit).join(', ')} +${ids.length - limit} more`;
}

/**
 * How much of the work is behind us, weighted by duration: a ten-day task
 * counts for ten times a one-day one. Null when there is no work to weigh.
 */
function completedShare(nodes, metrics) {
  let done = 0;
  let total = 0;
  nodes.forEach(node => {
    const m = metrics[node.id];
    if (!m) return;
    total += m.duration;
    done += m.duration - m.remaining;
  });
  return total > 0 ? Math.max(0, Math.min(1, done / total)) : null;
}

/** Six colours were load-bearing with nothing on screen explaining them. */
export function renderLegend() {
  const legend = $('legend-body');
  if (!legend) return;
  const entries = [
    { color: CRITICAL_COLOR, label: 'Critical path (zero slack)' },
    ...(getState().deadline != null
      ? [{ color: LATE_COLOR, label: 'Late (negative float)' }]
      : []),
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
