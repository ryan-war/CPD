// Workspace overlay: the roomy home for the analysis views.
//
// The Gantt, table, resources, cost, health, chain, and RAID views used to sit
// stacked under the task cards, where they were cramped and hard to read. They
// now live in one large floating panel, one tab shown at a time. Each view keeps
// its own render function and its `.open` class — this just decides which is
// open and makes the overlay visible.

import { $ } from './dom.js';
import {
  setGanttOpen, setResourcesOpen, setQualityOpen, setEvmOpen, setCCOpen, setRaidOpen
} from './panel.js';
import { setTableOpen } from './table.js';

const SETTERS = {
  gantt: setGanttOpen,
  table: setTableOpen,
  resources: setResourcesOpen,
  evm: setEvmOpen,
  quality: setQualityOpen,
  cc: setCCOpen,
  raid: setRaidOpen
};
const TOOLS = Object.keys(SETTERS);

let current = 'gantt';
let open = false;

export function isWorkspaceOpen() {
  return open;
}

export function openWorkspace(tool) {
  if (tool && SETTERS[tool]) current = tool;
  open = true;
  $('workspace-overlay').classList.remove('hidden');
  markToolbar();
  apply();
}

export function closeWorkspace() {
  if (!open) return;
  open = false;
  $('workspace-overlay').classList.add('hidden');
  markToolbar();
  TOOLS.forEach(t => SETTERS[t](false));
}

/**
 * The single Analyze button. There is one toolbar control for seven views
 * because the overlay carries its own tab strip — a second copy of that picker
 * on the header bought nothing and cost six buttons. Reopening lands on the tab
 * you left, so returning to a view is one click.
 */
export function toggleWorkspaceOverlay() {
  if (open) closeWorkspace();
  else openWorkspace();
}

function markToolbar() {
  const btn = $('btn-analyze');
  btn.classList.toggle('tool-btn-active', open);
  btn.setAttribute('aria-pressed', String(open));
}

export function setWorkspaceTool(tool) {
  if (!SETTERS[tool]) return;
  current = tool;
  apply();
}

/** Show only the current tool's view, and mark its tab and toolbar button. */
function apply() {
  TOOLS.forEach(t => SETTERS[t](t === current));
  document.querySelectorAll('.ws-tab').forEach(btn => {
    const on = btn.dataset.wsTab === current;
    btn.classList.toggle('ws-tab-active', on);
    btn.setAttribute('aria-selected', String(on));
  });
}
