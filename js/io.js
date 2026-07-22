// Project import/export and diagram image export.

import { $, toast } from './dom.js';
import { getState, setState, normalizeState, seedHistory } from './state.js';

function safeFilename(title, fallback) {
  return (String(title || '').replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '') || fallback);
}

export function saveJSON() {
  const state = getState();
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = safeFilename(state.projectTitle, 'cpm_project') + '.json';
  a.click();
  // Revoking immediately can cancel the download in some browsers.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
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
 * Export the canvas as a PNG.
 * The source canvas is transparent, so it is composited onto the diagram
 * background first — otherwise the file looks empty in most image viewers.
 */
export function exportPNG() {
  try {
    const canvas = document.querySelector('#network-canvas canvas');
    if (!canvas) {
      toast('Canvas not ready', 'error');
      return;
    }
    const out = document.createElement('canvas');
    out.width = canvas.width;
    out.height = canvas.height;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(canvas, 0, 0);

    const a = document.createElement('a');
    a.href = out.toDataURL('image/png');
    a.download = safeFilename(getState().projectTitle, 'diagram') + '.png';
    a.click();
    toast('PNG exported', 'success');
  } catch (err) {
    toast('Export failed: ' + err.message, 'error');
  }
}

export function bindFileInput(onLoaded) {
  $('file-input').addEventListener('change', event => {
    const file = event.target.files?.[0];
    if (file) loadJSON(file, onLoaded);
    event.target.value = '';
  });
}
