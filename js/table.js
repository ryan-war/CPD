// Task table: a spreadsheet-style grid of the current page's tasks.
//
// The cards are good for reading one task; this is for working across many —
// sort by any column, filter, show or hide columns, and edit the key fields in
// place. Computed figures (ES/EF, slack, critical, earned value) are read-only;
// they come from the schedule, not from you.

import { $, escapeHtml, refreshIcons, toast } from './dom.js';
import { schedule, effectiveStatus, rollupForNode, fmt } from './schedule.js';
import { getState, currentDiagram, findNode } from './state.js';
import { STATUS_LABELS } from './config.js';
import { tagsOf, parseTags } from './tags.js';
import { taskEV, taskPV } from './evm.js';

let app = {};
let tableOpen = false;
let sortKey = 'es';
let sortDir = 1;
const filters = {};                 // column key → lowercased needle
let hidden = new Set(['likely', 'ev', 'pv']); // sensible defaults; user-toggleable

export function initTable(callbacks) {
  app = callbacks;
}

export function isTableOpen() {
  return tableOpen;
}

export function setTableOpen(open) {
  tableOpen = open;
  $('table-panel').classList.toggle('open', open);
  if (open) renderTable();
}

// ─── Columns ───────────────────────────────────────────────
//
// `edit` names the node field an editable cell writes to; `ro` marks a computed
// column. `get` returns the display/sort value from a task and its metrics.

function columns(ctx) {
  const dateOrNum = offset => ctx.calendar.enabled ? ctx.calendar.formatOffset(offset) : fmt(offset);
  return [
    { key: 'id', label: 'ID', ro: true, get: n => n.id },
    { key: 'title', label: 'Task', edit: 'title', type: 'text', get: n => n.title || '' },
    { key: 'milestone', label: 'Milestone', ro: true, get: n => ctx.msOf[n.id] || '' },
    { key: 'status', label: 'Status', edit: 'status', type: 'status', get: n => effectiveStatus(n) },
    { key: 'progress', label: '%', edit: 'progress', type: 'progress', num: true, get: n => Math.round(ctx.progressOf(n)) },
    { key: 'assignee', label: 'Owner', edit: 'assignee', type: 'text', get: n => n.assignee || '' },
    { key: 'tags', label: 'Tags', edit: 'tags', type: 'tags', get: n => tagsOf(n).join(', ') },
    { key: 'min', label: 'O', edit: 'min', type: 'num', num: true, get: n => n.min },
    { key: 'likely', label: 'M', edit: 'likely', type: 'num', num: true, get: n => n.likely },
    { key: 'max', label: 'P', edit: 'max', type: 'num', num: true, get: n => n.max },
    { key: 'es', label: ctx.calendar.enabled ? 'Start' : 'ES', ro: true, num: true, get: (n, m) => m ? m.ES : 0, fmt: (n, m) => m ? dateOrNum(m.ES) : '—' },
    { key: 'ef', label: ctx.calendar.enabled ? 'Finish' : 'EF', ro: true, num: true, get: (n, m) => m ? m.EF : 0, fmt: (n, m) => m ? (ctx.calendar.enabled ? ctx.calendar.formatFinish(m.ES, m.duration) : fmt(m.EF)) : '—' },
    { key: 'slack', label: 'Slack', ro: true, num: true, get: (n, m) => m ? m.slack : 0, fmt: (n, m) => m ? fmt(m.slack) : '—' },
    { key: 'critical', label: 'Crit', ro: true, get: n => ctx.criticalIds.has(n.id) ? 'yes' : '' },
    { key: 'cost', label: 'Cost', edit: 'cost', type: 'num', num: true, get: n => n.cost || 0 },
    { key: 'actualCost', label: 'Actual', edit: 'actualCost', type: 'num', num: true, get: n => n.actualCost == null ? '' : n.actualCost },
    { key: 'ev', label: 'EV', ro: true, num: true, get: n => Math.round(taskEV(n)) },
    { key: 'pv', label: 'PV', ro: true, num: true, get: (n, m) => { const pv = taskPV(n, m, ctx.dataDate); return pv == null ? '' : Math.round(pv); } }
  ];
}

/** A task's completion comes from its linked sub-page, if it has one. */
function rolledProgress(node) {
  const r = rollupForNode(node);
  return r && r.progress != null ? r.progress : null;
}

function buildContext() {
  const { metrics, criticalIds, nodes, calendar, dataDate } = schedule();
  const msOf = {};
  currentDiagram().milestones.forEach(ms =>
    (ms.nodes || []).forEach(n => { msOf[n.id] = ms.title; }));
  const progressOf = node => {
    const rolled = rolledProgress(node);
    return rolled != null ? rolled : Math.max(0, Math.min(100, Number(node.progress) || 0));
  };
  return { metrics, criticalIds, nodes, calendar, dataDate, msOf, progressOf };
}

export function renderTable() {
  if (!tableOpen) return;
  const body = $('table-body');
  const ctx = buildContext();
  const cols = columns(ctx).filter(c => !hidden.has(c.key));

  renderControls(ctx);

  if (!ctx.nodes.length) {
    body.innerHTML = '<p class="text-xs text-muted">No tasks on this page yet.</p>';
    $('table-count').textContent = '';
    return;
  }

  // Filter, then sort.
  let rows = ctx.nodes.filter(n => cols.every(c => {
    const needle = filters[c.key];
    if (!needle) return true;
    const val = (c.fmt ? c.fmt(n, ctx.metrics[n.id]) : c.get(n, ctx.metrics[n.id])) ?? '';
    return String(val).toLowerCase().includes(needle);
  }));
  const col = columns(ctx).find(c => c.key === sortKey) || columns(ctx)[0];
  rows = rows.sort((a, b) => {
    const va = col.get(a, ctx.metrics[a.id]);
    const vb = col.get(b, ctx.metrics[b.id]);
    const cmp = col.num ? (Number(va) || 0) - (Number(vb) || 0) : String(va).localeCompare(String(vb));
    return cmp * sortDir;
  });

  $('table-count').textContent = `${rows.length} of ${ctx.nodes.length}`;

  const head = cols.map(c => `
    <th data-sort="${c.key}" class="${sortKey === c.key ? 'sorted' : ''}" title="Sort by ${escapeHtml(c.label)}">
      ${escapeHtml(c.label)}${sortKey === c.key ? (sortDir > 0 ? ' ▲' : ' ▼') : ''}
    </th>`).join('');
  const filterRow = cols.map(c =>
    `<th><input class="tbl-filter" data-filter="${c.key}" value="${escapeHtml(filters[c.key] || '')}" aria-label="Filter ${escapeHtml(c.label)}" /></th>`
  ).join('');

  const bodyRows = rows.map(n => {
    const m = ctx.metrics[n.id];
    const cells = cols.map(c => cell(c, n, m, ctx)).join('');
    return `<tr data-tid="${escapeHtml(n.id)}">${cells}</tr>`;
  }).join('');

  body.innerHTML = `<div class="table-scroll"><table class="data-table">
    <thead><tr class="tbl-head">${head}</tr><tr class="tbl-filters">${filterRow}</tr></thead>
    <tbody>${bodyRows}</tbody></table></div>`;
  refreshIcons(body);
}

/** One cell: a read-only value, or an editable input/select. */
function cell(c, n, m, ctx) {
  const display = c.fmt ? c.fmt(n, m) : c.get(n, m);
  if (c.ro) {
    const cls = c.key === 'critical' && display === 'yes' ? 'text-critical font-semibold' : '';
    return `<td class="tbl-ro ${cls}">${escapeHtml(display)}</td>`;
  }
  // Status and progress belong to the linked sub-page for a task that stands in
  // for one, so they show read-only here, the same way the card hides the slider.
  const rolled = rolledProgress(n) != null;
  if (c.type === 'status') {
    if (rolled) return `<td class="tbl-ro" title="From the linked sub-path">${escapeHtml(STATUS_LABELS[effectiveStatus(n)] || '')}</td>`;
    const opts = Object.entries(STATUS_LABELS).map(([k, l]) =>
      `<option value="${k}"${n.status === k ? ' selected' : ''}>${escapeHtml(l)}</option>`).join('');
    return `<td><select class="tbl-input" data-tid="${escapeHtml(n.id)}" data-field="status">${opts}</select></td>`;
  }
  if (c.type === 'progress' && rolled) {
    return `<td class="tbl-ro" title="From the linked sub-path">${Math.round(rolledProgress(n))}</td>`;
  }
  const type = c.type === 'num' || c.type === 'progress' ? 'number' : 'text';
  const extra = c.type === 'progress' ? 'min="0" max="100" step="1"' : c.type === 'num' ? 'min="0" step="0.5"' : '';
  return `<td><input class="tbl-input" type="${type}" ${extra} data-tid="${escapeHtml(n.id)}" data-field="${c.edit}" value="${escapeHtml(c.get(n, m))}" /></td>`;
}

// ─── Controls: column toggles + CSV ────────────────────────

function renderControls(ctx) {
  const host = $('table-controls');
  const all = columns(ctx);
  const toggles = all.map(c =>
    `<label class="tbl-col-toggle"><input type="checkbox" data-col="${c.key}" ${hidden.has(c.key) ? '' : 'checked'} /> ${escapeHtml(c.label)}</label>`
  ).join('');
  host.innerHTML = `
    <div class="tbl-cols-wrap">
      <button type="button" class="tool-btn" id="tbl-cols-btn" aria-haspopup="true">
        <i data-lucide="columns-3" class="w-3.5 h-3.5" aria-hidden="true"></i> Columns
      </button>
      <div id="tbl-cols-menu" class="hidden popover">${toggles}</div>
    </div>
    <button type="button" class="tool-btn" id="tbl-csv">
      <i data-lucide="table" class="w-3.5 h-3.5" aria-hidden="true"></i> CSV
    </button>`;
  refreshIcons(host);
}

// ─── Interaction (wired from main.js via delegation) ───────

export function handleTableClick(event) {
  const sortTh = event.target.closest('[data-sort]');
  if (sortTh) {
    const key = sortTh.dataset.sort;
    if (sortKey === key) sortDir = -sortDir; else { sortKey = key; sortDir = 1; }
    renderTable();
    return;
  }
  if (event.target.closest('#tbl-cols-btn')) {
    $('tbl-cols-menu').classList.toggle('hidden');
    return;
  }
  if (event.target.closest('#tbl-csv')) { exportVisibleCSV(); return; }
  // A row click (not on an input) selects the task on the canvas.
  const row = event.target.closest('tr[data-tid]');
  if (row && !event.target.closest('input,select,button')) {
    app.onSelect?.(row.dataset.tid);
  }
}

export function handleTableChange(event) {
  const colToggle = event.target.closest('[data-col]');
  if (colToggle) {
    const key = colToggle.dataset.col;
    if (colToggle.checked) hidden.delete(key); else hidden.add(key);
    renderTable();
    return;
  }
  const filter = event.target.closest('[data-filter]');
  if (filter) {
    const key = filter.dataset.filter;
    const v = filter.value.trim().toLowerCase();
    if (v) filters[key] = v; else delete filters[key];
    renderTable();
    return;
  }
  const input = event.target.closest('.tbl-input');
  if (input) commitEdit(input);
}

/** Write one edited cell back to its task, then let the app re-render. */
function commitEdit(input) {
  const found = findNode(input.dataset.tid);
  if (!found) return;
  const node = found.node;
  const field = input.dataset.field;
  const raw = input.value;

  if (field === 'title') node.title = raw.trim() || node.title;
  else if (field === 'assignee') node.assignee = raw.trim();
  else if (field === 'tags') node.tags = parseTags(raw);
  else if (field === 'status') {
    node.status = raw;
    if (raw === 'done') node.progress = 100;
    if (raw === 'not_started') node.progress = 0;
  } else if (field === 'progress') {
    node.progress = Math.max(0, Math.min(100, Number(raw) || 0));
    if (node.progress >= 100) node.status = 'done';
    else if (node.progress > 0 && node.status === 'not_started') node.status = 'in_progress';
  } else if (field === 'cost') {
    node.cost = Math.max(0, Number(raw) || 0);
  } else if (field === 'actualCost') {
    node.actualCost = raw.trim() === '' ? null : Math.max(0, Number(raw) || 0);
  } else if (field === 'min' || field === 'likely' || field === 'max') {
    const v = Math.max(0, Number(raw) || 0);
    node[field] = v;
    // Keep the estimate ordered so the sampler and schedule stay valid.
    if (node.max < node.min) { if (field === 'max') node.min = node.max; else node.max = node.min; }
    node.likely = Math.min(node.max, Math.max(node.min, node.likely ?? (node.min + node.max) / 2));
  }
  app.onChange?.();
}

function exportVisibleCSV() {
  const ctx = buildContext();
  const cols = columns(ctx).filter(c => !hidden.has(c.key));
  if (!ctx.nodes.length) { toast('No tasks to export', 'info'); return; }
  const esc = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const header = cols.map(c => c.label).join(',');
  const lines = ctx.nodes.map(n => {
    const m = ctx.metrics[n.id];
    return cols.map(c => esc(c.fmt ? c.fmt(n, m) : c.get(n, m))).join(',');
  });
  app.onExportCSV?.([header, ...lines].join('\r\n'));
}
