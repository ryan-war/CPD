// Small DOM helpers: escaping, toasts, icons, and modal focus management.

export function $(id) {
  return document.getElementById(id);
}

const ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ESCAPES[ch]);
}

/**
 * Refresh Lucide icons. Scoped to a root when possible so a panel re-render
 * does not force a scan of the whole document.
 */
export function refreshIcons(root) {
  if (typeof lucide === 'undefined') return;
  if (root && root !== document) {
    lucide.createIcons({ nameAttr: 'data-lucide', root });
    return;
  }
  lucide.createIcons();
}

const TOAST_STYLES = {
  error: 'bg-red-950 border-red-700 text-red-200',
  success: 'bg-emerald-950 border-emerald-700 text-emerald-200',
  info: 'bg-slate-800 border-slate-600 text-slate-200'
};

export function toast(message, type = 'info') {
  const host = $('toasts');
  if (!host) return;
  const el = document.createElement('div');
  el.className = `toast-enter pointer-events-auto px-4 py-2.5 rounded-lg border text-sm shadow-xl max-w-sm ${TOAST_STYLES[type] || TOAST_STYLES.info}`;
  el.textContent = message;
  host.appendChild(el);
  window.setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.3s';
    window.setTimeout(() => el.remove(), 300);
  }, 3200);
}

// ─── Modal focus handling ──────────────────────────────────
// Each open modal remembers the element that had focus, moves focus inside,
// and keeps Tab cycling within the dialog until it closes.

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])'
].join(',');

const openModals = new Map();

function focusableIn(modal) {
  return Array.from(modal.querySelectorAll(FOCUSABLE))
    .filter(el => el.offsetParent !== null || el === document.activeElement);
}

function trapTab(event) {
  if (event.key !== 'Tab') return;
  const modal = event.currentTarget;
  const items = focusableIn(modal);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function openModal(id) {
  const modal = $(id);
  if (!modal || !modal.classList.contains('hidden')) return;
  openModals.set(id, document.activeElement);
  modal.classList.remove('hidden');
  modal.addEventListener('keydown', trapTab);
  refreshIcons(modal);
  const items = focusableIn(modal);
  const preferred = modal.querySelector('[data-autofocus]') || items[0];
  if (preferred) preferred.focus();
}

export function closeModal(id) {
  const modal = $(id);
  if (!modal || modal.classList.contains('hidden')) return;
  modal.classList.add('hidden');
  modal.removeEventListener('keydown', trapTab);
  const restore = openModals.get(id);
  openModals.delete(id);
  if (restore && typeof restore.focus === 'function' && document.contains(restore)) {
    restore.focus();
  }
}

export function isModalOpen(id) {
  const modal = $(id);
  return !!modal && !modal.classList.contains('hidden');
}

export function anyModalOpen() {
  return openModals.size > 0;
}

export function closeAllModals() {
  Array.from(openModals.keys()).forEach(closeModal);
}
