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

export function activeWorkspaceTool() {
  return open ? current : null;
}

export function openWorkspace(tool) {
  if (tool && SETTERS[tool]) current = tool;
  open = true;
  $('workspace-overlay').classList.remove('hidden');
  apply();
}

export function closeWorkspace() {
  if (!open) return;
  open = false;
  $('workspace-overlay').classList.add('hidden');
  TOOLS.forEach(t => SETTERS[t](false));
}

/** Toolbar buttons toggle: click the active tool's button to close it. */
export function toggleWorkspace(tool) {
  if (open && current === tool) closeWorkspace();
  else openWorkspace(tool);
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
