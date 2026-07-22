// Shared constants and tunables.

export const CRITICAL_COLOR = '#ff4d4d';
export const NODE_BG = '#1e293b';
export const NODE_BORDER = '#475569';
export const EDGE_COLOR = '#64748b';
export const TRACE_COLOR = '#a78bfa';
export const SEARCH_COLOR = '#38bdf8';

export const LANE_COLORS = ['#1e3a5f', '#1a3d32', '#3d2a1a', '#3d1a2e', '#2a1a3d', '#1a353d'];
export const COLUMN_GAP = 280;
export const LANE_ID_PREFIX = '__lane__';

export const STATUS_COLORS = {
  not_started: '#64748b',
  in_progress: '#3b82f6',
  blocked: '#f59e0b',
  done: '#22c55e'
};

export const DEFAULT_DISPLAY = {
  id: true,
  title: false,
  minMax: true,
  esEf: true,
  lsLf: true,
  slack: true,
  link: true,
  progress: true
};

export const HISTORY_MAX = 50;

// Below this viewport width the secondary toolbar actions collapse into a menu.
export const COMPACT_BREAKPOINT = 1100;

export const SPLIT_MIN = 20;
export const SPLIT_MAX = 80;
export const SPLIT_DEFAULT = 50;

export function isLaneId(id) {
  return String(id).startsWith(LANE_ID_PREFIX);
}
