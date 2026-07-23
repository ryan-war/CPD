// Shared constants and tunables.

export const CRITICAL_COLOR = '#ff4d4d';
export const NEAR_CRITICAL_COLOR = '#f59e0b';
export const TRACE_COLOR = '#a78bfa';
export const SEARCH_COLOR = '#38bdf8';
export const SELECTED_COLOR = '#22d3ee';

export const LANE_COLORS = ['#1e3a5f', '#1a3d32', '#3d2a1a', '#3d1a2e', '#2a1a3d', '#1a353d'];
export const LANE_COLORS_LIGHT = ['#dbeafe', '#d1fae5', '#fef3c7', '#fce7f3', '#ede9fe', '#cffafe'];
/**
 * Layout spacing. These are minimums and gutters, not fixed pitches: the
 * layout code sizes each column and row from the tasks actually in it, so a
 * milestone of wide activity-on-node boxes gets the room it needs and one
 * holding a single circle does not leave a hole.
 */
export const COLUMN_MIN_GAP = 140;
export const ROW_MIN_GAP = 46;
export const LANE_ID_PREFIX = '__lane__';

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
  rollup: false
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

export function paletteFor(theme) {
  return PALETTES[theme] || PALETTES.dark;
}
