// Crash net.
//
// The project lived in memory only: a reload, a crash, or a closed tab threw
// away everything not exported first. This keeps a copy of the workspace in
// localStorage and puts it back on the next visit. JSON export remains the
// portable format — this is only so that closing the tab is not destructive.

const KEY = 'cpd.workspace.v1';
const SAVE_DELAY = 800;

let timer = null;
let warned = false;

/** localStorage is absent in Node and can be blocked by browser settings. */
function store() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // access itself throws when cookies are blocked
  }
}

/**
 * Queue a save. Called from the render path, which runs on every change —
 * including drags that fire in quick succession — so the write is debounced
 * rather than run per event.
 */
export function scheduleSave(getSnapshot, onProblem) {
  if (!store()) return;
  clearTimeout(timer);
  timer = setTimeout(() => saveNow(getSnapshot, onProblem), SAVE_DELAY);
}

export function saveNow(getSnapshot, onProblem) {
  const target = store();
  if (!target) return false;
  clearTimeout(timer);
  try {
    target.setItem(KEY, JSON.stringify({
      savedAt: new Date().toISOString(),
      state: getSnapshot()
    }));
    warned = false;
    return true;
  } catch (err) {
    // Quota is the realistic failure: a big project on a tight budget. Say so
    // once rather than on every keystroke after.
    if (!warned && onProblem) {
      warned = true;
      onProblem(err && err.name === 'QuotaExceededError'
        ? 'Too large to autosave — use Save JSON to keep this project'
        : 'Autosave is unavailable in this browser');
    }
    return false;
  }
}

/** The stored workspace, or null if there is none or it is unreadable. */
export function readSaved() {
  const target = store();
  if (!target) return null;
  try {
    const raw = target.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.state) return null;
    return { savedAt: parsed.savedAt || null, state: parsed.state };
  } catch {
    return null; // corrupt entry — fall back to a fresh project
  }
}

export function clearSaved() {
  const target = store();
  clearTimeout(timer);
  if (!target) return;
  try {
    target.removeItem(KEY);
  } catch {
    // nothing sensible to do; the caller is discarding it anyway
  }
}

/** "2 minutes ago" — how stale the restored work is, in words. */
export function describeAge(iso) {
  const then = iso ? new Date(iso) : null;
  if (!then || Number.isNaN(then.getTime())) return 'earlier';
  const seconds = Math.max(0, (Date.now() - then.getTime()) / 1000);
  if (seconds < 90) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
