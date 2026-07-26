// Project export. Run with: node --test test/io.test.js
//
// These cover the two paths that leave the app carrying data: saveJSON, which
// has to stamp a file so a future load can identify it, and exportCSV, which has
// to survive a spreadsheet. CSV is the fragile one — a task titled
// `Survey, site` or `He said "go"` will silently split or truncate a column if
// the quoting is wrong, and nothing in the interface would show it.
//
// io.js talks to the DOM only to trigger the download, so the stub below is just
// enough to catch what would have been written: the blob's contents and the
// filename. It is not a browser and does not pretend to be, in the same spirit
// as the stub in toolbar-menu.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ─── Harness ───────────────────────────────────────────────
// Installed before io.js is imported, since the module reaches for these
// globals as soon as an export runs.

const downloads = [];

globalThis.document = {
  // No toast host, so dom.js's toast() returns early instead of building nodes.
  getElementById: () => null,
  createElement: () => {
    const a = { href: '', download: '', click() {} };
    downloads.push(a);
    return a;
  }
};
globalThis.window = { setTimeout: () => 0 };
globalThis.URL = { createObjectURL: () => 'blob:stub', revokeObjectURL() {} };
globalThis.Blob = class {
  constructor(parts, options) {
    this.text = parts.join('');
    this.type = (options && options.type) || '';
    downloads.blob = this;
  }
};

const { setState, normalizeState } = await import('../js/state.js');
const { exportCSV, saveJSON } = await import('../js/io.js');
const { SCHEMA_VERSION, APP_VERSION } = await import('../js/config.js');

/** Run an export against `overrides` and return what would have hit disk. */
function exported(run, overrides) {
  downloads.length = 0;
  downloads.blob = undefined;
  setState(normalizeState(overrides));
  run();
  const anchor = downloads[downloads.length - 1];
  return {
    text: downloads.blob ? downloads.blob.text : null,
    type: downloads.blob ? downloads.blob.type : null,
    filename: anchor ? anchor.download : null
  };
}

/** A one-page project built from bare task definitions. */
function project(nodes, extra = {}) {
  return {
    projectTitle: 'Test Project',
    estimationMode: 'pert',
    pageOrder: ['main'],
    diagrams: {
      main: { title: 'Main', milestones: [{ id: 'm1', title: 'Phase 1', nodes }] }
    },
    ...extra
  };
}

const simple = [{ id: 'A', title: 'Survey', min: 2, likely: 4, max: 6 }];

/** Split a CSV row, honouring quotes — enough to check one field at a time. */
function cells(row) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (quoted) {
      if (ch === '"' && row[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(field); field = ''; }
    else field += ch;
  }
  out.push(field);
  return out;
}

// ─── CSV ───────────────────────────────────────────────────

test('a CSV opens in Excel as UTF-8 and uses spreadsheet line endings', () => {
  const out = exported(exportCSV, project(simple));
  assert.ok(out.text.startsWith('﻿'), 'a BOM leads, or Excel guesses the codepage');
  assert.match(out.type, /^text\/csv/);
  assert.ok(out.text.includes('\r\n'), 'rows are CRLF-separated');
  assert.equal(out.filename, 'Test_Project.csv');
});

test('titles containing commas, quotes, or newlines survive the round trip', () => {
  const out = exported(exportCSV, project([
    { id: 'A', title: 'Survey, site', min: 1, likely: 1, max: 1, description: 'has, a comma' },
    { id: 'B', title: 'He said "go"', min: 1, likely: 1, max: 1 },
    { id: 'C', title: 'Line\nbreak', min: 1, likely: 1, max: 1 }
  ]));

  // A field with a comma must be quoted, or it becomes two columns.
  assert.ok(out.text.includes('"Survey, site"'), 'commas are quoted');
  // A quote inside a field is doubled, per RFC 4180.
  assert.ok(out.text.includes('"He said ""go"""'), 'quotes are doubled');
  // A newline inside a field is quoted, so it stays one record.
  assert.ok(out.text.includes('"Line\nbreak"'), 'newlines are quoted');

  // And the header still describes what follows.
  const header = cells(out.text.replace('﻿', '').split('\r\n')[0]);
  assert.equal(header[2], 'Task ID');
  assert.equal(header[3], 'Title');
});

test('every task lands on its own row, with its computed schedule', () => {
  const out = exported(exportCSV, project([
    { id: 'A', title: 'A', min: 2, likely: 4, max: 6 },
    { id: 'B', title: 'B', min: 1, likely: 1, max: 1, dependencies: [{ id: 'A', type: 'FS', lag: 0 }] }
  ]));
  const rows = out.text.replace('﻿', '').split('\r\n');
  assert.equal(rows.length, 3, 'a header and two tasks');

  const header = cells(rows[0]);
  const a = cells(rows[1]);
  const b = cells(rows[2]);
  const col = name => header.indexOf(name);

  assert.equal(a[col('Task ID')], 'A');
  assert.equal(a[col('Duration')], '4', 'PERT of 2/4/6');
  assert.equal(a[col('ES')], '0');
  assert.equal(a[col('EF')], '4');
  assert.equal(a[col('Critical')], 'yes', 'the only chain is the critical one');
  assert.equal(b[col('ES')], '4', 'B follows A finish-to-start');
  assert.equal(b[col('Total Float')], '0');
  assert.equal(a[col('Status')], 'not_started');
});

test('dependencies are written the short way when there is nothing to qualify', () => {
  const out = exported(exportCSV, project([
    { id: 'A', title: 'A', min: 1, likely: 1, max: 1 },
    { id: 'B', title: 'B', min: 1, likely: 1, max: 1, dependencies: [{ id: 'A', type: 'FS', lag: 0 }] },
    { id: 'C', title: 'C', min: 1, likely: 1, max: 1, dependencies: [{ id: 'B', type: 'SS', lag: 2 }] },
    { id: 'D', title: 'D', min: 1, likely: 1, max: 1, dependencies: [{ id: 'C', type: 'FS', lag: 3 }] },
    { id: 'E', title: 'E', min: 1, likely: 1, max: 1, dependencies: [{ id: 'D', type: 'FS', lag: -1 }] }
  ]));
  const rows = out.text.replace('﻿', '').split('\r\n');
  const header = cells(rows[0]);
  const preds = header.indexOf('Predecessors');
  const byId = {};
  rows.slice(1).forEach(r => { const c = cells(r); byId[c[2]] = c; });

  // A plain finish-to-start with no lag needs no annotation — it is the default.
  assert.equal(byId.B[preds], 'A');
  // Anything else carries its type and, where set, its signed lag.
  assert.equal(byId.C[preds], 'B(SS+2)');
  assert.equal(byId.D[preds], 'C(FS+3)');
  assert.equal(byId.E[preds], 'D(FS-1)');
});

test('turning the calendar on adds real dates, and only then', () => {
  const withoutDates = exported(exportCSV, project(simple));
  assert.ok(!withoutDates.text.includes('Start Date'),
    'no date columns while the calendar is off');

  const out = exported(exportCSV, project(
    [{ id: 'A', title: 'A', min: 5, likely: 5, max: 5 }],
    { calendar: { enabled: true, startDate: '2026-04-13', workdays: [1, 2, 3, 4, 5], holidays: [] } }
  ));
  const rows = out.text.replace('﻿', '').split('\r\n');
  const header = cells(rows[0]);
  const a = cells(rows[1]);
  assert.ok(header.includes('Start Date') && header.includes('Finish Date'));
  assert.equal(a[header.indexOf('Start Date')], '2026-04-13', 'the Monday it starts');
  // Five working days from Monday ends on the Friday, not the Monday after.
  assert.equal(a[header.indexOf('Finish Date')], '2026-04-17');
});

test('a data date adds the remaining-work column', () => {
  const without = exported(exportCSV, project(simple));
  assert.ok(!without.text.includes('Remaining'), 'not reported unless the project is tracking');

  const out = exported(exportCSV, project(
    [{ id: 'A', title: 'A', min: 10, likely: 10, max: 10, progress: 40 }],
    { dataDate: 5 }
  ));
  const rows = out.text.replace('﻿', '').split('\r\n');
  const header = cells(rows[0]);
  assert.ok(header.includes('Remaining'));
  assert.equal(cells(rows[1])[header.indexOf('Progress %')], '40');
});

test('costs and tags are reported per task', () => {
  const out = exported(exportCSV, project([
    { id: 'A', title: 'A', min: 4, likely: 4, max: 4, cost: 200, progress: 50, actualCost: 120, tags: ['civil', 'phase-1'] }
  ]));
  const rows = out.text.replace('﻿', '').split('\r\n');
  const header = cells(rows[0]);
  const a = cells(rows[1]);
  assert.equal(a[header.indexOf('Budget')], '200');
  assert.equal(a[header.indexOf('Actual Cost')], '120');
  assert.equal(a[header.indexOf('Earned Value')], '100', 'budget × progress');
  assert.equal(a[header.indexOf('Tags')], 'civil; phase-1', 'tags read as one field');
});

test('a task with no recorded actual cost is left blank, not zeroed', () => {
  // Writing 0 would claim the task was free, which is a different statement from
  // "nobody has recorded what this cost".
  const out = exported(exportCSV, project([
    { id: 'A', title: 'A', min: 1, likely: 1, max: 1, cost: 50 }
  ]));
  const rows = out.text.replace('﻿', '').split('\r\n');
  const header = cells(rows[0]);
  assert.equal(cells(rows[1])[header.indexOf('Actual Cost')], '');
});

test('an empty project writes nothing at all', () => {
  const out = exported(exportCSV, project([]));
  assert.equal(out.text, null, 'no file, rather than a lone header row');
});

test('a filename is derived from the title, and always usable', () => {
  const messy = exported(exportCSV, project(simple, { projectTitle: 'Quoted, "Tricky"/Title' }));
  assert.match(messy.filename, /^[\w\-]+\.csv$/, 'punctuation cannot reach the filesystem');

  // normalizeState names an untitled project before io.js ever sees it.
  const untitled = exported(exportCSV, project(simple, { projectTitle: '' }));
  assert.equal(untitled.filename, 'Critical_Path_Network.csv');

  // A title that is *only* punctuation survives normalizeState but sanitises
  // away to nothing, which is what the fallback name is there to catch.
  const punctuation = exported(exportCSV, project(simple, { projectTitle: '///' }));
  assert.equal(punctuation.filename, 'cpm_project.csv', 'never an extension on its own');
});

// ─── JSON ──────────────────────────────────────────────────

test('a saved project stamps the format it conforms to', () => {
  const out = exported(saveJSON, project(simple, { projectTitle: 'Stamped' }));
  const parsed = JSON.parse(out.text);

  // A file on disk has to be self-describing, so a later load can tell what it
  // is looking at before it tries to read the rest.
  assert.equal(parsed.schemaVersion, SCHEMA_VERSION);
  assert.equal(parsed.appVersion, APP_VERSION);
  assert.match(parsed.exportedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(out.filename, 'Stamped.json');
  assert.match(out.type, /^application\/json/);

  // And it carries the project itself, not just the stamp.
  assert.equal(parsed.projectTitle, 'Stamped');
  assert.equal(parsed.diagrams.main.milestones[0].nodes[0].id, 'A');
});

test('a saved project reloads as the same project', () => {
  const source = project([
    { id: 'A', title: 'Survey, site', min: 2, likely: 4, max: 6, tags: ['civil'] },
    { id: 'B', title: 'B', min: 1, likely: 1, max: 1, dependencies: [{ id: 'A', type: 'SS', lag: 2 }] }
  ], { projectTitle: 'Round Trip', deadline: 12 });

  const out = exported(saveJSON, source);
  const reloaded = normalizeState(JSON.parse(out.text));

  assert.equal(reloaded.projectTitle, 'Round Trip');
  assert.equal(reloaded.deadline, 12);
  const [a, b] = reloaded.diagrams.main.milestones[0].nodes;
  assert.equal(a.title, 'Survey, site');
  assert.deepEqual(a.tags, ['civil']);
  assert.equal(b.dependencies[0].type, 'SS');
  assert.equal(b.dependencies[0].lag, 2);
});
