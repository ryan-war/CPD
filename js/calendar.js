// Working-day calendar.
//
// The scheduler works in abstract day offsets from zero. This maps those
// offsets onto real dates, skipping non-working days and holidays, so a task
// reading "ES:7 EF:12" can also read "Mon 13 Apr → Fri 17 Apr".
//
// Pure and DOM-free, like cpm.js.

export const DAY_MS = 86400000;

export const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const DEFAULT_CALENDAR = {
  enabled: false,
  startDate: null,           // 'YYYY-MM-DD'; null means today at load time
  workdays: [1, 2, 3, 4, 5], // 0 = Sunday … 6 = Saturday
  holidays: []               // ['YYYY-MM-DD', …]
};

/** Parse 'YYYY-MM-DD' as a local-midnight date, avoiding UTC drift. */
export function parseISODate(value) {
  if (value instanceof Date) return startOfDay(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

export function toISODate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/**
 * A calendar bound to one project's settings.
 *
 * `offsetToDate(n)` answers "which calendar day is working-day n?", counting
 * the start date itself as offset 0. Fractional offsets floor to the day the
 * work falls on, which is what a day-granularity Gantt can show.
 */
export function createCalendar(settings = {}) {
  const config = { ...DEFAULT_CALENDAR, ...settings };
  const workdays = new Set(
    Array.isArray(config.workdays) && config.workdays.length
      ? config.workdays.map(Number)
      : DEFAULT_CALENDAR.workdays
  );
  const holidays = new Set(
    (Array.isArray(config.holidays) ? config.holidays : [])
      .map(h => toISODate(parseISODate(h)))
      .filter(Boolean)
  );

  const start = parseISODate(config.startDate) || startOfDay(new Date());

  function isWorkingDay(date) {
    return workdays.has(date.getDay()) && !holidays.has(toISODate(date));
  }

  // If the configured start lands on a weekend or holiday, begin on the next
  // working day rather than silently scheduling into non-working time.
  function firstWorkingDay() {
    let cursor = start;
    for (let guard = 0; guard < 400 && !isWorkingDay(cursor); guard++) {
      cursor = addDays(cursor, 1);
    }
    return cursor;
  }

  const origin = workdays.size ? firstWorkingDay() : start;

  // Offsets are requested repeatedly while rendering; walking the calendar
  // from the origin each time would be quadratic across a long project.
  const cache = new Map([[0, origin]]);
  let furthest = { offset: 0, date: origin };

  function offsetToDate(offset) {
    const target = Math.max(0, Math.floor(Number(offset) || 0));
    if (cache.has(target)) return cache.get(target);
    if (!workdays.size) return addDays(origin, target);

    let { offset: n, date } = furthest;
    let guard = 0;
    while (n < target && guard < 100000) {
      date = addDays(date, 1);
      guard++;
      if (isWorkingDay(date)) {
        n++;
        cache.set(n, date);
      }
    }
    furthest = { offset: n, date };
    return date;
  }

  /**
   * A task occupying `duration` working days from `offset` finishes at the end
   * of the last day it touches, so the finish date is one working day short of
   * the raw offset sum. Zero-length milestones report the start day itself.
   */
  function finishDate(offset, duration) {
    const days = Math.max(0, Number(duration) || 0);
    if (days <= 0) return offsetToDate(offset);
    return offsetToDate(offset + Math.ceil(days) - 1);
  }

  return {
    enabled: !!config.enabled,
    config,
    origin,
    isWorkingDay,
    offsetToDate,
    finishDate,
    format: date => formatDate(date),
    formatOffset: offset => formatDate(offsetToDate(offset)),
    formatFinish: (offset, duration) => formatDate(finishDate(offset, duration))
  };
}

/** Short, unambiguous, locale-independent: "Mon 13 Apr". */
export function formatDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '—';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${WEEKDAY_NAMES[date.getDay()]} ${date.getDate()} ${months[date.getMonth()]}`;
}

/** Includes the year — for axis endpoints and exports. */
export function formatDateLong(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '—';
  return `${formatDate(date)} ${date.getFullYear()}`;
}
