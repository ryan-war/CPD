// Project import/export, image export, and CSV export.

import { $, toast } from './dom.js';
import { getState, setState, normalizeState, seedHistory, pageTitle } from './state.js';
import { fmt } from './schedule.js';
import {
  dependenciesOf, nodesOf, computeCPM, createRollup, createProgressRollup
} from './cpm.js';
import { createCalendar, toISODate } from './calendar.js';
import { renderFullImage } from './network.js';

function safeFilename(title, fallback) {
  return (String(title || '').replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '') || fallback);
}

function download(blobOrUrl, filename) {
  const url = typeof blobOrUrl === 'string' ? blobOrUrl : URL.createObjectURL(blobOrUrl);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  if (typeof blobOrUrl !== 'string') {
    // Revoking immediately can cancel the download in some browsers.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export function saveJSON() {
  const state = getState();
  download(
    new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }),
    safeFilename(state.projectTitle, 'cpm_project') + '.json'
  );
  toast('Project JSON downloaded', 'success');
}

export function loadJSON(file, onLoaded) {
  const reader = new FileReader();
  reader.onerror = () => toast('Could not read that file', 'error');
  reader.onload = () => {
    try {
      const data = normalizeState(JSON.parse(reader.result));
      setState(data);
      seedHistory();
      onLoaded();
      toast('Project loaded', 'success');
    } catch (err) {
      toast('Failed to load project: ' + err.message, 'error');
    }
  };
  reader.readAsText(file);
}

/**
 * Export the whole diagram at 2× resolution.
 *
 * The visible canvas only ever contains the current viewport, so exporting it
 * directly produced a screenshot cropped to whatever happened to be on screen
 * at whatever zoom was set. This fits the graph first and upscales.
 */
export function exportPNG() {
  try {
    const out = renderFullImage(2);
    if (!out) {
      toast('Canvas not ready', 'error');
      return;
    }
    download(out.toDataURL('image/png'), safeFilename(getState().projectTitle, 'diagram') + '.png');
    toast('PNG exported', 'success');
  } catch (err) {
    toast('Export failed: ' + err.message, 'error');
  }
}

// ─── CSV ───────────────────────────────────────────────────

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvRows(rows) {
  return rows.map(r => r.map(csvCell).join(',')).join('\r\n');
}

/**
 * Every task on every page, with its computed schedule. Each page is costed
 * with its own roll-up so sub-path figures match what the interface shows.
 */
/** A constraint offset for a spreadsheet: a date if the calendar is on, else a day. */
function constraintCell(offset, calendar, useDates) {
  if (offset == null) return '';
  return useDates ? toISODate(calendar.offsetToDate(offset)) : fmt(offset);
}

export function exportCSV() {
  const state = getState();
  const rollup = createRollup(state.diagrams, state.estimationMode);
  const progressRollup = state.dataDate != null
    ? createProgressRollup(state.diagrams, state.estimationMode)
    : null;
  const calendar = createCalendar(state.calendar);
  const useDates = calendar.enabled;

  const header = [
    'Page', 'Milestone', 'Task ID', 'Title', 'Description', 'Assigned To', 'Tags',
    'Status', 'Progress %',
    'Optimistic', 'Most Likely', 'Pessimistic', 'Duration',
    ...(state.dataDate != null ? ['Remaining'] : []),
    'ES', 'EF', 'LS', 'LF', 'Total Float', 'Free Float', 'Critical', 'Late',
    'Start No Earlier Than', 'Must Finish By',
    ...(useDates ? ['Start Date', 'Finish Date'] : []),
    'Predecessors', 'Linked Sub-Page', 'Linked Main Task'
  ];

  const rows = [header];

  (state.pageOrder || []).forEach(pageId => {
    const diagram = state.diagrams[pageId];
    if (!diagram) return;
    const nodes = nodesOf(diagram);
    if (!nodes.length) return;
    const { metrics, criticalIds } = computeCPM(nodes, {
      mode: state.estimationMode,
      rollup,
      // Only Main answers to the project deadline, exactly as on screen.
      deadline: pageId === 'main' ? state.deadline : null,
      // The data date applies everywhere, also exactly as on screen.
      dataDate: state.dataDate,
      progressRollup
    });

    (diagram.milestones || []).forEach(ms => {
      (ms.nodes || []).forEach(node => {
        const m = metrics[node.id] || {};
        rows.push([
          pageTitle(pageId),
          ms.title,
          node.id,
          node.title,
          node.description || '',
          node.assignee || '',
          (node.tags || []).join('; '),
          node.status || 'not_started',
          Math.round(node.progress || 0),
          node.min,
          node.likely ?? '',
          node.max,
          fmt(m.duration),
          ...(state.dataDate != null ? [fmt(m.remaining)] : []),
          fmt(m.ES), fmt(m.EF), fmt(m.LS), fmt(m.LF), fmt(m.slack), fmt(m.freeFloat),
          criticalIds.has(node.id) ? 'yes' : 'no',
          m.slack < 0 ? 'yes' : 'no',
          constraintCell(node.startNoEarlierThan, calendar, useDates),
          constraintCell(node.mustFinishBy, calendar, useDates),
          ...(useDates
            ? [toISODate(calendar.offsetToDate(m.ES)), toISODate(calendar.finishDate(m.ES, m.duration))]
            : []),
          dependenciesOf(node)
            .map(d => (d.type === 'FS' && !d.lag) ? d.id : `${d.id}(${d.type}${d.lag ? (d.lag > 0 ? '+' : '') + d.lag : ''})`)
            .join(' '),
          node.linkedSubPage ? pageTitle(node.linkedSubPage) : '',
          node.linkedMainNode || ''
        ]);
      });
    });
  });

  if (rows.length === 1) {
    toast('No tasks to export', 'info');
    return;
  }

  // The BOM makes Excel read it as UTF-8 rather than the system codepage.
  download(
    new Blob(['﻿' + csvRows(rows)], { type: 'text/csv;charset=utf-8' }),
    safeFilename(getState().projectTitle, 'cpm_project') + '.csv'
  );
  toast(`Exported ${rows.length - 1} tasks to CSV`, 'success');
}

export function bindFileInput(onLoaded) {
  $('file-input').addEventListener('change', event => {
    const file = event.target.files?.[0];
    if (file) loadJSON(file, onLoaded);
    event.target.value = '';
  });
}
