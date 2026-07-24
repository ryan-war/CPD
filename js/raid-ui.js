// RAID entry dialog: add, edit, and delete register entries.

import { $, escapeHtml, toast, openModal, closeModal, isModalOpen } from './dom.js';
import { getState, uid } from './state.js';
import { createCalendar, toISODate } from './calendar.js';
import { dayOrNull, nodesOf } from './cpm.js';
import { assigneeNames } from './resources.js';

let app = {};

export function initRaid(callbacks) {
  app = callbacks;
  // Probability and impact only make sense for a risk or an issue.
  $('raid-type').addEventListener('change', updateTypeFields);
}

export function isRaidModalOpen() {
  return isModalOpen('modal-raid');
}

function raidById(id) {
  return (getState().raid || []).find(e => e.id === id);
}

/** Every task across every page, for the optional "linked task" select. */
function taskOptions(currentId) {
  const state = getState();
  const opts = ['<option value="">None</option>'];
  (state.pageOrder || []).forEach(pageId => {
    const suffix = pageId === 'main' ? '' : ` (${state.pageTitles[pageId] || pageId})`;
    nodesOf(state.diagrams[pageId] || {}).forEach(n => {
      opts.push(`<option value="${escapeHtml(n.id)}"${n.id === currentId ? ' selected' : ''}>${escapeHtml(n.id)} — ${escapeHtml(n.title || '')}${escapeHtml(suffix)}</option>`);
    });
  });
  return opts.join('');
}

// The due field reads as a date with the calendar on, a day number otherwise —
// the same convention as task deadlines.
function setupDue(value) {
  const input = $('raid-due');
  const hint = $('raid-due-hint');
  const calendar = createCalendar(getState().calendar);
  if (calendar.enabled) {
    input.type = 'date';
    input.value = value != null ? toISODate(calendar.offsetToDate(value)) : '';
    hint.textContent = 'Optional — when this is due.';
  } else {
    input.type = 'number';
    input.min = '0';
    input.step = '0.5';
    input.value = value != null ? String(value) : '';
    hint.textContent = 'Optional — a day from the project start.';
  }
}

function readDue() {
  const input = $('raid-due');
  const raw = input.value.trim();
  if (!raw) return null;
  if (input.type === 'date') {
    const offset = createCalendar(getState().calendar).dateToOffset(raw);
    return offset == null ? null : offset;
  }
  return dayOrNull(raw);
}

function updateTypeFields() {
  const showPI = $('raid-type').value === 'risk' || $('raid-type').value === 'issue';
  $('raid-probability').closest('div').classList.toggle('hidden', !showPI);
  $('raid-impact').closest('div').classList.toggle('hidden', !showPI);
}

export function openRaidModal(id) {
  const entry = id ? raidById(id) : null;
  $('raid-id').value = entry ? entry.id : '';
  $('modal-raid-heading').textContent = entry ? 'Edit RAID Entry' : 'Add RAID Entry';
  $('raid-type').value = entry?.type || 'risk';
  $('raid-status').value = entry?.status || 'open';
  $('raid-title').value = entry?.title || '';
  $('raid-description').value = entry?.description || '';
  $('raid-probability').value = entry?.probability || '';
  $('raid-impact').value = entry?.impact || '';
  setupDue(entry?.due ?? null);
  $('raid-owner').value = entry?.owner || '';
  $('raid-owner-names').innerHTML = assigneeNames(getState().diagrams)
    .map(n => `<option value="${escapeHtml(n)}"></option>`).join('');
  $('raid-linked').innerHTML = taskOptions(entry?.linkedTaskId || '');
  $('btn-delete-raid').classList.toggle('hidden', !entry);
  updateTypeFields();
  openModal('modal-raid');
}

export function closeRaidModal() {
  closeModal('modal-raid');
}

export function saveRaidForm(event) {
  event.preventDefault();
  const title = $('raid-title').value.trim();
  if (!title) {
    toast('A title is required', 'error');
    return;
  }
  const state = getState();
  if (!Array.isArray(state.raid)) state.raid = [];
  const entry = raidById($('raid-id').value);
  const data = {
    id: entry?.id || uid('raid'),
    type: $('raid-type').value,
    title: title.slice(0, 200),
    description: $('raid-description').value.trim(),
    owner: $('raid-owner').value.trim(),
    status: $('raid-status').value === 'closed' ? 'closed' : 'open',
    probability: $('raid-probability').value || null,
    impact: $('raid-impact').value || null,
    due: readDue(),
    linkedTaskId: $('raid-linked').value || null,
    raisedAt: entry?.raisedAt || new Date().toISOString()
  };
  if (entry) Object.assign(entry, data);
  else state.raid.push(data);

  closeRaidModal();
  app.onChange(entry ? 'RAID entry updated' : 'RAID entry added');
}

/** Delete by id — used by the panel row and, via the modal, its Delete button. */
export function deleteRaidById(id) {
  const entry = raidById(id);
  if (!entry) return;
  if (!window.confirm(`Delete this ${entry.type}: “${entry.title}”?`)) return;
  const state = getState();
  state.raid = (state.raid || []).filter(e => e.id !== id);
  if (isRaidModalOpen()) closeRaidModal();
  app.onChange('RAID entry deleted');
}

export function deleteRaidFromModal() {
  deleteRaidById($('raid-id').value);
}
