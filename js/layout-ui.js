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

// ─── Toolbar popovers ──────────────────────────────────────
//
// Every toolbar menu — the overflow menu, Display, Model, File — is the same
// mechanism: a button that shows a `.popover` under its right edge, which
// closes on an outside click and follows the button on resize. This owns that
// much and nothing else; what the menu *contains* stays with whoever wired it.

/**
 * @param {HTMLElement} button the toolbar button that opens the menu
 * @param {HTMLElement} menu   the `.popover` it opens
 * @param {{ closeOnChoice?: boolean }} [options] close once an item is picked —
 *   right for menus of actions, wrong for menus of settings like Display.
 * @returns {{ open: Function, close: Function, isOpen: Function }}
 */
export function wireActionMenu(button, menu, { closeOnChoice = true } = {}) {
  function position() {
    const rect = button.getBoundingClientRect();
    const width = menu.offsetWidth || 208;
    const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
    menu.style.top = (rect.bottom + 6) + 'px';
    menu.style.left = left + 'px';
  }

  const isOpen = () => !menu.classList.contains('hidden');

  function close() {
    menu.classList.add('hidden');
    button.setAttribute('aria-expanded', 'false');
  }

  function open() {
    // One menu at a time. The button handler stops propagation so the
    // outside-click close does not immediately undo the open — which also means
    // opening File would otherwise leave Model hanging open beside it.
    closeAllMenus();
    menu.classList.remove('hidden');
    // Placed only once visible: a hidden element measures zero wide.
    position();
    button.setAttribute('aria-expanded', 'true');
  }

  button.addEventListener('click', event => {
    event.stopPropagation();
    if (isOpen()) close(); else open();
  });

  // `label` as well as `button`: the Load JSON item is a label wrapping a
  // hidden file input, not a button.
  menu.addEventListener('click', event => {
    if (closeOnChoice && event.target.closest('button, label')) close();
    else event.stopPropagation();
  });

  document.addEventListener('click', event => {
    if (!menu.contains(event.target) && !button.contains(event.target)) close();
  });
  window.addEventListener('resize', () => {
    if (isOpen()) position();
  });

  return { open, close, isOpen };
}

/** Close whichever toolbar popover is showing. Used by the Escape handler. */
export function closeAllMenus() {
  document.querySelectorAll('.popover:not(.hidden)').forEach(menu => {
    menu.classList.add('hidden');
    const owner = menu.id && document.querySelector(`[aria-controls="${menu.id}"]`);
    if (owner) owner.setAttribute('aria-expanded', 'false');
  });
}

// ─── Compact toolbar ───────────────────────────────────────
//
// Even grouped, the bar carries more than a narrow window holds. Below the
// breakpoint the secondary controls move into an overflow menu and the primary
// ones stay on the bar.

export function initCompactToolbar() {
  const overflowBtn = $('btn-more');
  const overflowSlot = $('more-slot');
  const toolbar = $('toolbar-actions');
  const menu = wireActionMenu(overflowBtn, $('more-menu'));
  // Where each control was authored, so coming back from compact restores the
  // bar rather than rebuilding it. Restoring "before the divider" instead would
  // shunt every secondary control to the end of the bar — and since the widen
  // path also runs once at boot, the order you wrote would never be the order
  // anyone sees.
  const secondary = Array.from(document.querySelectorAll('[data-secondary]'))
    .map(el => ({ el, before: el.nextElementSibling }));
  let compact = null;

  function apply() {
    const next = window.innerWidth < COMPACT_BREAKPOINT;
    if (next === compact) return;
    compact = next;
    overflowBtn.classList.toggle('hidden', !compact);
    if (compact) {
      secondary.forEach(({ el }) => overflowSlot.appendChild(el));
    } else {
      menu.close();
      // Back to front: each control's recorded neighbour is in place by the
      // time the one before it is inserted.
      [...secondary].reverse().forEach(({ el, before }) => toolbar.insertBefore(el, before));
    }
    document.body.classList.toggle('compact-toolbar', compact);
  }

  window.addEventListener('resize', apply);

  apply();
}
