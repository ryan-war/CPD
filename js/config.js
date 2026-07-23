// Shared constants and tunables.

/**
 * Versioning.
 *
 * APP_VERSION is the build of the tool; it is stamped onto exported files as
 * provenance — which version wrote this. SCHEMA_VERSION is the saved-project
 * format, bumped only when the shape of the file changes in a way an older
 * build could misread. normalizeState migrates any lower or absent version up
 * to the current one, so old files keep loading; a file written by a *newer*
 * schema than this build understands is loaded on a best-effort basis with a
 * warning. Schema 1 was the original release, before tags, scenarios, or a
 * version stamp existed; schema 2 adds them; schema 3 adds task cost and the
 * earned-value fields.
 */
export const APP_VERSION = '1.2.0';
export const SCHEMA_VERSION = 3;

export const CRITICAL_COLOR = '#ff4d4d';
export const NEAR_CRITICAL_COLOR = '#f59e0b';
/** Negative float — past a deadline, not merely driving the finish. */
export const LATE_COLOR = '#c026d3';
export const TRACE_COLOR = '#a78bfa';
export const SEARCH_COLOR = '#38bdf8';
export const SELECTED_COLOR = '#22d3ee';

export const LANE_COLORS = ['#1e3a5f', '#1a3d32', '#3d2a1a', '#3d1a2e', '#2a1a3d', '#1a353d'];
export const LANE_COLORS_LIGHT = ['#dbeafe', '#d1fae5', '#fef3c7', '#fce7f3', '#ede9fe', '#cffafe'];

/**
 * Tags are free-form labels that cut across milestones and owners — "QA",
 * "client-facing", "needs-review". Their colour is derived from the text so the
 * same tag reads the same everywhere without anyone having to assign one, and a
 * tag renamed becomes a different colour rather than inheriting a stale slot.
 */
export const TAG_COLORS = [
  '#38bdf8', '#22c55e', '#f59e0b', '#e879f9', '#a78bfa',
  '#f472b6', '#2dd4bf', '#fb7185', '#84cc16', '#60a5fa'
];

export function tagColor(name) {
  const text = String(name || '');
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length];
}
/**
 * Layout spacing. These are minimums and gutters, not fixed pitches: the
 * layout code sizes each column and row from the tasks actually in it, so a
 * milestone of wide activity-on-node boxes gets the room it needs and one
 * holding a single circle does not leave a hole.
 */
export const COLUMN_MIN_GAP = 140;
export const ROW_MIN_GAP = 46;
export const LANE_ID_PREFIX = '__lane__';
export const GHOST_ID_PREFIX = '__ghost__';

/**
 * Ghosts: a linked sub-path drawn in place, underneath the Main task that
 * stands for it, so the shape of the work is visible without leaving the page.
 *
 * The Main flow runs left to right, so the sub-path hangs downward — the free
 * axis, and the one that makes the two levels read as different things rather
 * than as one tangled network.
 */
export const GHOST_MODES = ['off', 'selected', 'all'];
export const GHOST_DROP = 150;      // parent to the first row of its sub-path
export const GHOST_ROW_GAP = 78;    // between ranks going down
export const GHOST_COL_GAP = 132;   // between tasks that share a rank

/**
 * Past this many, drawing every sub-path at once stops being a diagram and
 * starts being a wall. `selected` still works at any size, so the toggle
 * degrades to it rather than freezing the canvas.
 */
export const GHOST_MAX_NODES = 400;

/** Above this many sub-paths the page strip becomes a searchable picker. */
export const TABS_COMPACT_ABOVE = 12;

/**
 * Thresholds for the schedule quality checks.
 *
 * The day figures come from the assessment planners are audited against, where
 * they are two working months — long enough that a task exceeding one has
 * almost certainly not been thought through, rather than being genuinely that
 * shape. The share figures say how much of a plan may carry a given defect
 * before it stops being an exception and becomes how the plan is built.
 */
export const QUALITY = {
  highFloatDays: 44,
  longDurationDays: 44,
  sharePass: 0.05,
  shareWarn: 0.10,
  fsShare: 0.90
};

/**
 * Status is shown as a fill tint rather than a border colour. The border
 * carries schedule risk — critical, near-critical, selected, search hit — and
 * previously all four meanings competed for that one channel, so a completed
 * task on the critical path simply lost its status.
 */
export const STATUS_COLORS = {
  not_started: '#64748b',
  in_progress: '#3b82f6',
  blocked: '#f59e0b',
  done: '#22c55e'
};

export const STATUS_LABELS = {
  not_started: 'Not started',
  in_progress: 'In progress',
  blocked: 'Blocked',
  done: 'Done'
};

/** Canvas colours per theme. vis-network needs concrete values, not CSS vars. */
export const PALETTES = {
  dark: {
    canvasBg: '#0f172a',
    nodeBg: '#1e293b',
    nodeBorder: '#475569',
    nodeText: '#f1f5f9',
    nodeTextDim: '#64748b',
    edge: '#64748b',
    edgeHighlight: '#94a3b8',
    laneText: '#cbd5e1',
    laneBorder: '#64748b',
    laneBand: 'rgba(30, 41, 59, 0.35)',
    laneDivider: 'rgba(100, 116, 139, 0.65)',
    ringTrack: 'rgba(51, 65, 85, 0.9)',
    lanes: LANE_COLORS,
    shadow: 'rgba(0,0,0,0.4)'
  },
  light: {
    canvasBg: '#f1f5f9',
    nodeBg: '#ffffff',
    nodeBorder: '#94a3b8',
    nodeText: '#0f172a',
    nodeTextDim: '#94a3b8',
    edge: '#94a3b8',
    edgeHighlight: '#475569',
    laneText: '#334155',
    laneBorder: '#94a3b8',
    laneBand: 'rgba(148, 163, 184, 0.14)',
    laneDivider: 'rgba(100, 116, 139, 0.5)',
    ringTrack: 'rgba(203, 213, 225, 0.95)',
    lanes: LANE_COLORS_LIGHT,
    shadow: 'rgba(15,23,42,0.18)'
  }
};

export const DEFAULT_DISPLAY = {
  id: true,
  title: false,
  minMax: true,
  esEf: true,
  lsLf: true,
  slack: true,
  link: true,
  progress: true,
  dates: false,
  criticality: false,
  rollup: false,
  tags: false,
  ghosts: 'off'   // 'off' | 'selected' | 'all' — see GHOST_MODES
};

export const HISTORY_MAX = 50;

// Below this viewport width the secondary toolbar actions collapse into a menu.
export const COMPACT_BREAKPOINT = 1100;

export const SPLIT_MIN = 20;
export const SPLIT_MAX = 80;
export const SPLIT_DEFAULT = 50;

export const MINIMAP_WIDTH = 168;
export const MINIMAP_HEIGHT = 108;

export function isLaneId(id) {
  return String(id).startsWith(LANE_ID_PREFIX);
}

/**
 * Canvas id for a task borrowed from another page.
 *
 * Task ids come from a text field and from imported files, so they hold
 * whatever a person can type — spaces included. The separator has to be a
 * character that cannot appear in one, written as an escape rather than typed
 * literally so it stays visible to whoever reads this next.
 */
const GHOST_SEPARATOR = '\u0000';

export function ghostId(pageId, nodeId) {
  return `${GHOST_ID_PREFIX}${pageId}${GHOST_SEPARATOR}${nodeId}`;
}

export function isGhostId(id) {
  return String(id).startsWith(GHOST_ID_PREFIX);
}

/** Which page and task a ghost stands for, or null if it is not one. */
export function parseGhostId(id) {
  if (!isGhostId(id)) return null;
  const rest = String(id).slice(GHOST_ID_PREFIX.length);
  const at = rest.indexOf(GHOST_SEPARATOR);
  if (at < 0) return null;
  return {
    pageId: rest.slice(0, at),
    nodeId: rest.slice(at + GHOST_SEPARATOR.length)
  };
}

/**
 * Drawn by the canvas but not part of the project: milestone lane headers and
 * ghosted sub-path tasks. Neither can be selected, dragged, deleted, or wired
 * up, so every interaction handler checks this before acting on an id.
 */
export function isSyntheticId(id) {
  return isLaneId(id) || isGhostId(id);
}

export function paletteFor(theme) {
  return PALETTES[theme] || PALETTES.dark;
}
