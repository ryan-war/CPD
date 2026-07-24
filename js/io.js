// Project import/export, image export, and CSV export.

import { $, toast } from './dom.js';
import { APP_VERSION, SCHEMA_VERSION } from './config.js';
import { getState, setState, normalizeState, seedHistory, pageTitle } from './state.js';
import { fmt, effectiveStatus } from './schedule.js';
import {
  dependenciesOf, nodesOf, computeCPM, createRollup, createProgressRollup
} from './cpm.js';
import { createCalendar, toISODate } from './calendar.js';
import { taskBAC, taskEV, taskPV, taskAC } from './evm.js';
import { renderFullImage, renderSVG } from './network.js';

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
  // The file is stamped with the format version it conforms to, the build that
  // wrote it, and when — so a project on disk is self-describing and a future
  // load can tell what it is looking at. schemaVersion leads, since that is the
  // field a loader reads first.
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    ...state
  };
  download(
    new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
    safeFilename(state.projectTitle, 'cpm_project') + '.json'
  );
  toast(`Project JSON downloaded (format v${SCHEMA_VERSION})`, 'success');
}

export function loadJSON(file, onLoaded) {
  const reader = new FileReader();
  reader.onerror = () => toast('Could not read that file', 'error');
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      // A file from a newer schema than this build knows about is loaded anyway,
      // but say so: normalizeState will drop or ignore anything it does not
      // recognise, so the project may come in missing something it was saved with.
      const fileSchema = Number(parsed && parsed.schemaVersion);
      if (Number.isFinite(fileSchema) && fileSchema > SCHEMA_VERSION) {
        toast(`Saved by a newer version (format v${fileSchema}). Loading anyway — some settings may not carry over.`, 'info');
      }
      const data = normalizeState(parsed);
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

/** The whole diagram as a standalone, scalable SVG — vector where PNG rasterises. */
export function exportSVG() {
  try {
    const svg = renderSVG();
    if (!svg) {
      toast('No diagram to export', 'info');
      return;
    }
    download(
      new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }),
      safeFilename(getState().projectTitle, 'diagram') + '.svg'
    );
    toast('SVG exported', 'success');
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
    'Budget', 'Actual Cost', 'Earned Value', 'Planned Value',
    'Optimistic', 'Most Likely', 'Pessimistic', 'Duration',
    ...(state.dataDate != null ? ['Remaining'] : []),
    'ES', 'EF', 'LS', 'LF', 'Total Float', 'Free Float', 'Critical', 'Late',
    'Start No Earlier Than', 'Must Finish By',
    ...(useDates ? ['Start Date', 'Finish Date'] : []),
    'Predecessors', 'Linked Sub-Page', 'Linked Main Task'
  ];

  const rows = [header];

  // Main first, so a sub-path can be dated from the Main task that owns it —
  // its schedule is offset to that task's start, exactly as on screen.
  const mainNodes = nodesOf(state.diagrams.main);
  const mainMetrics = computeCPM(mainNodes, {
    mode: state.estimationMode, rollup, deadline: state.deadline, dataDate: state.dataDate, progressRollup
  }).metrics;
  const pageStartFor = pid => {
    if (pid === 'main') return 0;
    const parent = mainNodes.find(n => n.linkedSubPage === pid);
    const es = parent && mainMetrics[parent.id]?.ES;
    return Number.isFinite(es) ? es : 0;
  };

  (state.pageOrder || []).forEach(pageId => {
    const diagram = state.diagrams[pageId];
    if (!diagram) return;
    const nodes = nodesOf(diagram);
    if (!nodes.length) return;
    const start = pageStartFor(pageId);
    const { metrics, criticalIds } = computeCPM(nodes, {
      mode: state.estimationMode,
      rollup,
      // Only Main answers to the project deadline, exactly as on screen.
      deadline: pageId === 'main' ? state.deadline : null,
      // The data date applies everywhere; a sub-path frames it into its own
      // window before scheduling, exactly as on screen.
      dataDate: state.dataDate == null ? null : state.dataDate - start,
      progressRollup
    });
    if (start) {
      Object.values(metrics).forEach(m => { m.ES += start; m.EF += start; m.LS += start; m.LF += start; });
    }

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
          effectiveStatus(node),
          Math.round(node.progress || 0),
          taskBAC(node),
          taskAC(node) ?? '',
          +taskEV(node).toFixed(2),
          (v => v == null ? '' : +v.toFixed(2))(taskPV(node, m, state.dataDate)),
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
