// Scenarios dialog: save, load, rename, delete, and compare what-if branches.

import { $, escapeHtml, toast, openModal, closeModal, isModalOpen } from './dom.js';
import { getState, uid } from './state.js';
import { snapshotState, mainSummary, compareScenario } from './scenarios.js';
import { fmt, fmtDelta } from './schedule.js';

let app = {};
// The scenario a comparison is currently shown for, so the list and the compare
// panel stay in step across a re-render.
let comparingId = null;
// What that scenario is measured against: null means the live plan, otherwise
// the id of another scenario — so you can compare two saved branches directly.
let compareTargetId = null;

export function initScenarios(callbacks) {
  app = callbacks;
}

function scenarios() {
  const state = getState();
  if (!Array.isArray(state.scenarios)) state.scenarios = [];
  return state.scenarios;
}

export function openScenariosModal() {
  comparingId = null;
  renderScenarios();
  openModal('modal-scenarios');
}

export function closeScenariosModal() {
  closeModal('modal-scenarios');
}

export function isScenariosOpen() {
  return isModalOpen('modal-scenarios');
}

/** Redraw the list and, if one is open, the comparison — from current state. */
export function renderScenarios() {
  const list = $('scn-list');
  if (!list) return;
  const items = scenarios();

  const current = mainSummary(getState());
  $('scn-current-dur').textContent = fmt(current.projectDuration) + 'd';

  if (!items.length) {
    list.innerHTML = `<p class="hint px-1 py-2">
      No scenarios yet. Save the plan as it stands, change some estimates or
      dependencies, and compare to see what the change costs the finish date.</p>`;
  } else {
    list.innerHTML = items.map(s => {
      const summary = mainSummary(s.data);
      const delta = +(summary.projectDuration - current.projectDuration).toFixed(4);
      const deltaClass = delta > 0 ? 'text-late' : delta < 0 ? 'text-success' : 'text-muted';
      const deltaText = delta === 0 ? 'same as current' : `${fmtDelta(delta)}d vs current`;
      return `
        <div class="scenario-row${s.id === comparingId ? ' scenario-row-active' : ''}">
          <div class="scenario-meta">
            <div class="scenario-name" title="Captured ${escapeHtml(new Date(s.capturedAt).toLocaleString())}">${escapeHtml(s.name)}</div>
            <div class="scenario-sub">
              <span>${fmt(summary.projectDuration)}d</span>
              <span class="${deltaClass}">${escapeHtml(deltaText)}</span>
            </div>
          </div>
          <div class="scenario-actions">
            <button type="button" class="tool-btn" data-scn-compare="${escapeHtml(s.id)}">${s.id === comparingId ? 'Hide' : 'Compare'}</button>
            <button type="button" class="tool-btn" data-scn-load="${escapeHtml(s.id)}" title="Replace the working plan with this scenario">Load</button>
            <button type="button" class="tool-btn" data-scn-update="${escapeHtml(s.id)}" title="Overwrite this scenario with the current plan">Update</button>
            <button type="button" class="icon-btn" data-scn-duplicate="${escapeHtml(s.id)}" aria-label="Duplicate ${escapeHtml(s.name)}"><i data-lucide="copy" class="w-3.5 h-3.5" aria-hidden="true"></i></button>
            <button type="button" class="icon-btn" data-scn-rename="${escapeHtml(s.id)}" aria-label="Rename ${escapeHtml(s.name)}"><i data-lucide="pencil" class="w-3.5 h-3.5" aria-hidden="true"></i></button>
            <button type="button" class="icon-btn icon-btn-danger" data-scn-delete="${escapeHtml(s.id)}" aria-label="Delete ${escapeHtml(s.name)}"><i data-lucide="trash-2" class="w-3.5 h-3.5" aria-hidden="true"></i></button>
          </div>
        </div>`;
    }).join('');
  }

  renderCompare();
  app.refreshIcons();
}

function renderCompare() {
  const host = $('scn-compare');
  const scenario = scenarios().find(s => s.id === comparingId);
  if (!scenario) {
    host.classList.add('hidden');
    host.innerHTML = '';
    return;
  }

  // The baseline of the comparison: the live plan, or another saved scenario.
  // A target that no longer exists (deleted while selected) falls back to live.
  const target = compareTargetId ? scenarios().find(s => s.id === compareTargetId) : null;
  if (compareTargetId && !target) compareTargetId = null;
  const targetData = target ? target.data : getState();
  const targetLabel = target ? target.name : 'the current plan';

  const cmp = compareScenario(targetData, scenario.data);
  const deltaClass = cmp.projectDelta > 0 ? 'text-late' : cmp.projectDelta < 0 ? 'text-success' : 'text-muted';
  const verdict = cmp.projectDelta === 0
    ? `finishes at the same time as ${targetLabel}`
    : cmp.projectDelta > 0
      ? `finishes ${fmt(cmp.projectDelta)}d later than ${targetLabel}`
      : `finishes ${fmt(-cmp.projectDelta)}d sooner than ${targetLabel}`;

  const options = [`<option value="current"${compareTargetId ? '' : ' selected'}>the current plan</option>`]
    .concat(scenarios()
      .filter(s => s.id !== comparingId)
      .map(s => `<option value="${escapeHtml(s.id)}"${s.id === compareTargetId ? ' selected' : ''}>${escapeHtml(s.name)}</option>`))
    .join('');

  const rows = cmp.tasks.length
    ? cmp.tasks.map(t => {
        if (t.status === 'added') {
          return `<tr><td>${escapeHtml(t.id)}</td><td class="scenario-cell-title">${escapeHtml(t.title)}</td>
            <td colspan="3" class="text-success">only in this scenario</td></tr>`;
        }
        if (t.status === 'removed') {
          return `<tr><td>${escapeHtml(t.id)}</td><td class="scenario-cell-title">${escapeHtml(t.title)}</td>
            <td colspan="3" class="text-late">only in ${escapeHtml(targetLabel)}</td></tr>`;
        }
        const critFlip = t.critCurrent !== t.critScenario
          ? (t.critScenario ? ' <span class="text-critical">now critical</span>' : ' <span class="text-muted">off critical</span>')
          : '';
        return `<tr>
          <td>${escapeHtml(t.id)}</td>
          <td class="scenario-cell-title">${escapeHtml(t.title)}${critFlip}</td>
          <td class="${deltaCell(t.durationDelta)}">${escapeHtml(fmtDelta(t.durationDelta))}d</td>
          <td class="${deltaCell(t.startDelta)}">${escapeHtml(fmtDelta(t.startDelta))}d</td>
          <td class="${deltaCell(t.finishDelta)}">${escapeHtml(fmtDelta(t.finishDelta))}d</td>
        </tr>`;
      }).join('')
    : `<tr><td colspan="5" class="hint">Every task lands exactly where it does in ${escapeHtml(targetLabel)} — only project-level settings differ.</td></tr>`;

  host.classList.remove('hidden');
  host.innerHTML = `
    <div class="scenario-compare-head">
      <span class="font-medium">${escapeHtml(scenario.name)}</span>
      <label class="scenario-compare-against">vs
        <select data-compare-target aria-label="Compare against">${options}</select>
      </label>
    </div>
    <p class="text-xs ${deltaClass}">${escapeHtml(verdict)}.</p>
    <div class="scenario-table-wrap">
      <table class="scenario-table">
        <thead><tr><th>ID</th><th>Task</th><th>Duration</th><th>Start</th><th>Finish</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="hint">Deltas are "${escapeHtml(scenario.name)}" minus ${escapeHtml(targetLabel)}. Positive means longer, later, or downstream.</p>`;
}

/** The compare panel's "vs" selector changed which plan is the baseline. */
export function setCompareTarget(value) {
  compareTargetId = value && value !== 'current' ? value : null;
  renderCompare();
  app.refreshIcons();
}

/** A signed delta reads late when positive (later/longer), early when negative. */
function deltaCell(value) {
  if (!value) return 'text-muted';
  return value > 0 ? 'text-late' : 'text-success';
}

// ─── Operations ────────────────────────────────────────────

export function saveCurrentAsScenario() {
  const input = $('scn-new-name');
  const name = (input.value || '').trim() || defaultName();
  scenarios().push({
    id: uid('scn'),
    name: name.slice(0, 80),
    capturedAt: new Date().toISOString(),
    data: snapshotState(getState())
  });
  input.value = '';
  app.onChange(`Saved scenario "${name}"`);
  renderScenarios();
}

function defaultName() {
  const n = scenarios().length + 1;
  return `Scenario ${n}`;
}

export function handleScenarioClick(event) {
  const btn = event.target.closest('button');
  if (!btn) return;
  const { scnCompare, scnLoad, scnUpdate, scnRename, scnDelete, scnDuplicate } = btn.dataset;

  if (scnCompare) {
    comparingId = comparingId === scnCompare ? null : scnCompare;
    // A fresh comparison starts against the live plan, not a target left over
    // from the last one — which may have been this very scenario.
    compareTargetId = null;
    renderScenarios();
  } else if (scnLoad) {
    loadScenario(scnLoad);
  } else if (scnUpdate) {
    updateScenario(scnUpdate);
  } else if (scnDuplicate) {
    duplicateScenario(scnDuplicate);
  } else if (scnRename) {
    renameScenario(scnRename);
  } else if (scnDelete) {
    deleteScenario(scnDelete);
  }
}

function duplicateScenario(id) {
  const s = find(id);
  if (!s) return;
  scenarios().push({
    id: uid('scn'),
    name: `${s.name} (copy)`.slice(0, 80),
    capturedAt: new Date().toISOString(),
    // A deep copy so editing or reloading one never reaches into the other.
    data: JSON.parse(JSON.stringify(s.data))
  });
  app.onChange(`Duplicated "${s.name}"`);
  renderScenarios();
}

function find(id) {
  return scenarios().find(s => s.id === id);
}

function updateScenario(id) {
  const s = find(id);
  if (!s) return;
  s.data = snapshotState(getState());
  s.capturedAt = new Date().toISOString();
  app.onChange(`Updated scenario "${s.name}"`);
  renderScenarios();
}

function renameScenario(id) {
  const s = find(id);
  if (!s) return;
  const next = window.prompt('Rename scenario', s.name);
  if (next == null) return;
  const name = next.trim();
  if (!name || name === s.name) return;
  s.name = name.slice(0, 80);
  app.onChange('Scenario renamed');
  renderScenarios();
}

function deleteScenario(id) {
  const s = find(id);
  if (!s) return;
  if (!window.confirm(`Delete scenario "${s.name}"? This cannot be undone from here.`)) return;
  const state = getState();
  state.scenarios = scenarios().filter(x => x.id !== id);
  if (comparingId === id) comparingId = null;
  app.onChange(`Deleted scenario "${s.name}"`);
  renderScenarios();
}

/**
 * Replace the working plan with a scenario's.
 *
 * The current plan is not lost silently: the confirm names the way to keep it
 * (save it as a scenario first). The scenario list itself carries over — you
 * are switching which plan is live, not throwing the others away.
 */
function loadScenario(id) {
  const s = find(id);
  if (!s) return;
  if (!window.confirm(
    `Load "${s.name}"? It replaces the plan on screen. Save the current one as a scenario first if you want to keep it.`
  )) return;

  const next = JSON.parse(JSON.stringify(s.data));
  // The branches survive the switch — carry them onto the loaded plan.
  next.scenarios = scenarios().map(x => ({ ...x }));
  closeScenariosModal();
  app.onReplace(next, `Loaded scenario "${s.name}"`);
  toast(`Loaded scenario "${s.name}"`, 'success');
}
