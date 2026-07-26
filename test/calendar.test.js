// Working-day calendar. Run with: node --test test/calendar.test.js
//
// Every date the interface shows comes through here, so a mistake in this file
// is a mistake in every Gantt bar, every finish date, and every deadline. The
// cases below pin the four things the rest of the app assumes:
//
//   1. offset 0 is the first *working* day, even if the project starts on one
//      that is not.
//   2. a task of n days finishes on the last day it touches, not n days later.
//   3. dateToOffset is a true inverse of offsetToDate.
//   4. the offset cache never changes an answer based on the order of asking.
//
// 2026-04-13 is a Monday; the fixtures lean on that so the weekend skips are
// readable. Dates are built and read locally at both ends, so these hold in any
// timezone.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createCalendar, parseISODate, toISODate, formatDate, formatDateLong,
  DEFAULT_CALENDAR, DAY_MS, WEEKDAY_NAMES
} from '../js/calendar.js';

/** Offsets 0..n as ISO dates — the shape most assertions here want. */
const dates = (cal, n) =>
  Array.from({ length: n }, (_, i) => toISODate(cal.offsetToDate(i)));

test('parseISODate reads a local midnight, or nothing at all', () => {
  assert.equal(toISODate(parseISODate('2026-04-13')), '2026-04-13');
  // A full timestamp keeps its calendar day rather than drifting a day via UTC.
  assert.equal(toISODate(parseISODate('2026-04-13T18:00:00Z')), '2026-04-13');
  // A Date passes through, stripped to the start of its day.
  assert.equal(toISODate(parseISODate(new Date(2026, 3, 13, 22, 30))), '2026-04-13');
  assert.equal(parseISODate('junk'), null);
  assert.equal(parseISODate(''), null);
  assert.equal(parseISODate(null), null);
  assert.equal(parseISODate(undefined), null);
});

test('toISODate pads, and refuses anything that is not a real date', () => {
  assert.equal(toISODate(new Date(2026, 0, 5)), '2026-01-05', 'single digits padded');
  assert.equal(toISODate(new Date('nope')), '', 'an invalid Date is not a date');
  assert.equal(toISODate('2026-04-13'), '', 'a string is not a Date');
  assert.equal(toISODate(null), '');
});

test('offsets walk working days and step over the weekend', () => {
  const cal = createCalendar({ enabled: true, startDate: '2026-04-13' });
  assert.equal(toISODate(cal.origin), '2026-04-13', 'a Monday start is its own origin');
  assert.deepEqual(dates(cal, 8), [
    '2026-04-13', '2026-04-14', '2026-04-15', '2026-04-16', '2026-04-17',
    // Sat 18 and Sun 19 are not working days, so offset 5 is the next Monday.
    '2026-04-20', '2026-04-21', '2026-04-22'
  ]);
});

test('a start date on a non-working day rolls forward, it does not schedule into it', () => {
  // Saturday: the project really begins on Monday, and offset 0 says so.
  assert.equal(toISODate(createCalendar({ startDate: '2026-04-18' }).origin), '2026-04-20');
  // Same rule for a holiday landing on the start date.
  const onHoliday = createCalendar({ startDate: '2026-04-13', holidays: ['2026-04-13'] });
  assert.equal(toISODate(onHoliday.origin), '2026-04-14');
});

test('holidays are skipped like weekends', () => {
  const cal = createCalendar({ startDate: '2026-04-13', holidays: ['2026-04-15'] });
  assert.equal(cal.isWorkingDay(parseISODate('2026-04-15')), false);
  assert.deepEqual(dates(cal, 5), [
    '2026-04-13', '2026-04-14', /* 15th off */ '2026-04-16', '2026-04-17', '2026-04-20'
  ]);
});

test('a task finishes on the last day it works, and a milestone on its own day', () => {
  const cal = createCalendar({ startDate: '2026-04-13' });
  // One day of work starting Monday finishes Monday — not Tuesday.
  assert.equal(toISODate(cal.finishDate(0, 1)), '2026-04-13');
  // A full week finishes Friday, not the Monday after.
  assert.equal(toISODate(cal.finishDate(0, 5)), '2026-04-17');
  // Zero duration is a milestone: it reports the day it sits on.
  assert.equal(toISODate(cal.finishDate(0, 0)), '2026-04-13');
  assert.equal(toISODate(cal.finishDate(3, 0)), '2026-04-16');
  // A part-day still occupies the day it spills into, so 2.5 days ends on day 3.
  assert.equal(toISODate(cal.finishDate(0, 2.5)), '2026-04-15');
  // Nonsense durations are treated as a milestone rather than throwing.
  assert.equal(toISODate(cal.finishDate(0, -4)), '2026-04-13');
  assert.equal(toISODate(cal.finishDate(0, NaN)), '2026-04-13');
});

test('dateToOffset inverts offsetToDate', () => {
  const cal = createCalendar({ startDate: '2026-04-13', holidays: ['2026-05-01'] });
  for (let n = 0; n <= 60; n++) {
    assert.equal(cal.dateToOffset(cal.offsetToDate(n)), n, `offset ${n} round-trips`);
  }
});

test('dateToOffset clamps outside the working calendar', () => {
  const cal = createCalendar({ startDate: '2026-04-13' });
  assert.equal(cal.dateToOffset('2026-04-13'), 0);
  assert.equal(cal.dateToOffset('2026-04-17'), 4, 'Friday of the first week');
  // "By Saturday" is really "by the end of Friday", so a non-working day reports
  // the working day that precedes it rather than inventing an offset.
  assert.equal(cal.dateToOffset('2026-04-18'), 4, 'Saturday reads as Friday');
  assert.equal(cal.dateToOffset('2026-04-19'), 4, 'Sunday too');
  assert.equal(cal.dateToOffset('2026-04-20'), 5, 'and Monday moves on');
  // A deadline before the project starts is offset 0, not a negative day.
  assert.equal(cal.dateToOffset('2026-01-01'), 0);
  assert.equal(cal.dateToOffset('nonsense'), null, 'an unreadable date has no offset');
  assert.equal(cal.dateToOffset(null), null);
});

test('the offset cache does not depend on the order offsets are asked for', () => {
  // offsetToDate memoises and tracks the furthest offset it has walked to. Asking
  // for a far offset first, then a nearer one, must not corrupt either answer.
  const jumped = createCalendar({ startDate: '2026-04-13' });
  const far = toISODate(jumped.offsetToDate(30));
  const near = toISODate(jumped.offsetToDate(5));
  assert.equal(toISODate(jumped.offsetToDate(30)), far, 'the far answer is stable');

  const sequential = createCalendar({ startDate: '2026-04-13' });
  assert.equal(toISODate(sequential.offsetToDate(5)), near, 'and matches a walk in order');
  assert.equal(toISODate(sequential.offsetToDate(30)), far);

  // Descending is the worst case for the cache; it must still agree.
  const descending = createCalendar({ startDate: '2026-01-01' });
  for (let n = 40; n >= 0; n--) descending.offsetToDate(n);
  const ascending = createCalendar({ startDate: '2026-01-01' });
  for (let n = 0; n <= 40; n++) ascending.offsetToDate(n);
  assert.equal(toISODate(descending.offsetToDate(37)), toISODate(ascending.offsetToDate(37)));
});

test('offsets below zero or unreadable land on the origin', () => {
  const cal = createCalendar({ startDate: '2026-04-13' });
  assert.equal(toISODate(cal.offsetToDate(-5)), '2026-04-13');
  assert.equal(toISODate(cal.offsetToDate(NaN)), '2026-04-13');
  assert.equal(toISODate(cal.offsetToDate(undefined)), '2026-04-13');
});

test('the working week is configurable', () => {
  const everyDay = createCalendar({ startDate: '2026-04-13', workdays: [0, 1, 2, 3, 4, 5, 6] });
  assert.deepEqual(dates(everyDay, 8), [
    '2026-04-13', '2026-04-14', '2026-04-15', '2026-04-16',
    '2026-04-17', '2026-04-18', '2026-04-19', '2026-04-20'
  ], 'a seven-day week never skips');

  // A four-day week (Mon–Thu) takes the long weekend every week.
  const fourDay = createCalendar({ startDate: '2026-04-13', workdays: [1, 2, 3, 4] });
  assert.deepEqual(dates(fourDay, 5), [
    '2026-04-13', '2026-04-14', '2026-04-15', '2026-04-16', '2026-04-20'
  ]);
});

test('a calendar with no working days falls back to Mon–Fri rather than stalling', () => {
  // An empty workdays list can never advance, so it is treated as unset. This
  // mirrors normalizeCalendar in state.js, which applies the same fallback
  // before a loaded file ever reaches here.
  const cal = createCalendar({ startDate: '2026-04-13', workdays: [] });
  assert.deepEqual(dates(cal, 6), [
    '2026-04-13', '2026-04-14', '2026-04-15', '2026-04-16', '2026-04-17', '2026-04-20'
  ]);
  assert.deepEqual(DEFAULT_CALENDAR.workdays, [1, 2, 3, 4, 5]);
});

test('dates cross months, years, and a daylight-saving change intact', () => {
  const yearEnd = createCalendar({ startDate: '2026-12-28' }); // a Monday
  assert.deepEqual(dates(yearEnd, 7), [
    '2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31',
    '2027-01-01', '2027-01-04', '2027-01-05'
  ]);
  // Spanning the 2026-03-08 clock change: adding days must not slip an hour into
  // the previous day.
  const dst = createCalendar({ startDate: '2026-03-05' }); // a Thursday
  assert.deepEqual(dates(dst, 4), ['2026-03-05', '2026-03-06', '2026-03-09', '2026-03-10']);
});

test('formatting is short, locale-independent, and safe on bad input', () => {
  const monday = parseISODate('2026-04-13');
  assert.equal(formatDate(monday), 'Mon 13 Apr');
  assert.equal(formatDateLong(monday), 'Mon 13 Apr 2026');
  assert.equal(formatDate(new Date('nope')), '—', 'an unreadable date shows a dash');
  assert.equal(formatDateLong(null), '—');

  const cal = createCalendar({ startDate: '2026-04-13' });
  assert.equal(cal.formatOffset(0), 'Mon 13 Apr');
  assert.equal(cal.formatFinish(0, 5), 'Fri 17 Apr', 'a week of work ends on the Friday');
});

test('the calendar reports its own settings back', () => {
  assert.equal(createCalendar({}).enabled, false, 'off unless a project turns it on');
  assert.equal(createCalendar({ enabled: true }).enabled, true);
  assert.equal(createCalendar({ startDate: '2026-04-13' }).config.startDate, '2026-04-13');
  assert.equal(DAY_MS, 86400000);
  assert.equal(WEEKDAY_NAMES[1], 'Mon');
  assert.equal(WEEKDAY_NAMES.length, 7);
});
