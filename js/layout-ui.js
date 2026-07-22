// Chrome that is about the window rather than the project: the draggable
// canvas/panel divider and the toolbar's compact mode.

import { $ } from './dom.js';
import { COMPACT_BREAKPOINT, SPLIT_MIN, SPLIT_MAX, SPLIT_DEFAULT } from './config.js';

// ─── Split pane ────────────────────────────────────────────

export function initSplitter(onResize) {
  const workArea = $('work-area');
  const splitter = $('splitter');
  let ratio = SPLIT_DEFAULT;
  let dragging = false;

  function apply(next, notify = true) {
    ratio = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, next));
    workArea.style.setProperty('--canvas-height', ratio + '%');
    splitter.setAttribute('aria-valuenow', String(Math.round(ratio)));
    if (notify) onResize();
  }

  function ratioFromPointer(clientY) {
    const rect = workArea.getBoundingClientRect();
    if (!rect.height) return ratio;
    return ((clientY - rect.top) / rect.height) * 100;
  }

  splitter.addEventListener('pointerdown', event => {
    dragging = true;
    splitter.setPointerCapture(event.pointerId);
    splitter.classList.add('dragging');
    event.preventDefault();
  });

  splitter.addEventListener('pointermove', event => {
    if (!dragging) return;
    // Skip the network redraw while dragging; it happens once on release.
    apply(ratioFromPointer(event.clientY), false);
  });

  function endDrag(event) {
    if (!dragging) return;
    dragging = false;
    splitter.classList.remove('dragging');
    if (event.pointerId != null && splitter.hasPointerCapture(event.pointerId)) {
      splitter.releasePointerCapture(event.pointerId);
    }
    onResize();
  }

  splitter.addEventListener('pointerup', endDrag);
  splitter.addEventListener('pointercancel', endDrag);
  splitter.addEventListener('dblclick', () => apply(SPLIT_DEFAULT));

  splitter.addEventListener('keydown', event => {
    const step = event.shiftKey ? 10 : 2;
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      apply(ratio - step);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      apply(ratio + step);
    } else if (event.key === 'Home') {
      event.preventDefault();
      apply(SPLIT_MIN);
    } else if (event.key === 'End') {
      event.preventDefault();
      apply(SPLIT_MAX);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      apply(SPLIT_DEFAULT);
    }
  });

  apply(SPLIT_DEFAULT, false);
}

// ─── Compact toolbar ───────────────────────────────────────
//
// The header carries thirteen actions plus a search field. Below the
// breakpoint they wrap into three rows and eat the canvas, so the secondary
// ones move into an overflow menu and the primary ones stay on the bar.

export function initCompactToolbar() {
  const overflowBtn = $('btn-more');
  const overflowMenu = $('more-menu');
  const overflowSlot = $('more-slot');
  const toolbar = $('toolbar-actions');
  const secondary = Array.from(document.querySelectorAll('[data-secondary]'));
  let compact = null;

  function position() {
    const rect = overflowBtn.getBoundingClientRect();
    const width = overflowMenu.offsetWidth || 220;
    let left = rect.right - width;
    left = Math.min(Math.max(8, left), window.innerWidth - width - 8);
    overflowMenu.style.top = (rect.bottom + 6) + 'px';
    overflowMenu.style.left = left + 'px';
  }

  function closeMenu() {
    overflowMenu.classList.add('hidden');
    overflowBtn.setAttribute('aria-expanded', 'false');
  }

  function apply() {
    const next = window.innerWidth < COMPACT_BREAKPOINT;
    if (next === compact) return;
    compact = next;
    overflowBtn.classList.toggle('hidden', !compact);
    if (compact) {
      secondary.forEach(el => overflowSlot.appendChild(el));
    } else {
      closeMenu();
      secondary.forEach(el => toolbar.insertBefore(el, $('toolbar-divider')));
    }
    document.body.classList.toggle('compact-toolbar', compact);
  }

  overflowBtn.addEventListener('click', event => {
    event.stopPropagation();
    const opening = overflowMenu.classList.contains('hidden');
    if (opening) {
      overflowMenu.classList.remove('hidden');
      position();
      overflowBtn.setAttribute('aria-expanded', 'true');
    } else {
      closeMenu();
    }
  });

  overflowMenu.addEventListener('click', event => {
    if (event.target.closest('button, label')) closeMenu();
  });

  document.addEventListener('click', event => {
    if (!overflowMenu.contains(event.target) && !overflowBtn.contains(event.target)) closeMenu();
  });

  window.addEventListener('resize', () => {
    apply();
    if (!overflowMenu.classList.contains('hidden')) position();
  });

  apply();
  return { closeMenu };
}
