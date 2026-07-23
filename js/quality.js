// Schedule quality: whether the plan is sound, as against whether it computes.
//
// The engine will happily schedule a network that is quietly wrong. A task with
// nothing after it cannot delay anything, so it never looks critical and never
// raises an alarm — it simply falls out of the answer. A negative lag hides
// logic nobody wrote down. A hard constraint overrides the network and takes
// the float with it. Every one of these produces a schedule that computes
// perfectly and misleads completely.
//
// These are the checks a planner is audited against, adapted to what this tool
// models. Pure and DOM-free, like cpm.js — it takes a computed schedule and
// gives back findings.

import { dependenciesOf, predecessorIds } from './cpm.js';
import { QUALITY } from './config.js';

/**
 * Severity is about what the finding costs you, not how many there are.
 *
 * fail  the schedule is telling you something untrue
 * warn  it may be, and is worth a look
 * pass  checked, nothing found
 * n/a   nothing to check against — reported so a clean run is distinguishable
 *       from one that never ran
 */
const FAIL = 'fail';
const WARN = 'warn';
const PASS = 'pass';
const NA = 'n/a';

/** Severity from how much of the plan a finding covers. */
function bySpread(count, total, { pass = QUALITY.sharePass, warn = QUALITY.shareWarn } = {}) {
  if (!count) return PASS;
  if (!total) return WARN;
  const share = count / total;
  if (share <= pass) return WARN;   // present but contained
  return share <= warn ? WARN : FAIL;
}

/**
 * Assess a diagram.
 *
 * @param {object[]} nodes tasks of the page
 * @param {Object} metrics computed schedule, keyed by task id
 * @param {{cycleIds?: string[], outOfSequenceIds?: string[],
 *          overAllocated?: string[], tracking?: boolean}} context
 *   things the caller already computed and this should not recompute:
 *   `overAllocated` is the names of people carrying too much, `tracking` says
 *   whether a data date is set — without one, progress checks mean nothing.
 * @returns {{checks: object[], passed: number, total: number, worst: string}}
 *   each check is `{id, title, severity, detail, ids, count, of}`
 */
export function assessSchedule(nodes, metrics, context = {}) {
  const { cycleIds = [], outOfSequenceIds = [], overAllocated = [], tracking = false } = context;
  const checks = [];
  const total = nodes.length;

  const add = (id, title, severity, detail, ids = []) =>
    checks.push({ id, title, severity, detail, ids, count: ids.length, of: total });

  if (!total) {
    return { checks: [], passed: 0, total: 0, worst: NA };
  }

  // A cycle is not a quality problem, it is a broken schedule: nothing below
  // this can be trusted, so it is reported first and on its own terms.
  if (cycleIds.length) {
    add('cycles', 'Circular dependencies', FAIL,
      'These tasks depend on each other in a loop, so the schedule cannot be computed at all. Nothing else here is meaningful until it is broken.',
      cycleIds);
    return { checks, passed: 0, total: checks.length, worst: FAIL };
  }

  const relations = nodes.flatMap(n => dependenciesOf(n).filter(d => metrics[d.id]));
  const hasSuccessor = new Set();
  nodes.forEach(n => predecessorIds(n).forEach(p => hasSuccessor.add(p)));

  // ─── Logic ───────────────────────────────────────────────

  const noPredecessor = nodes.filter(n => !dependenciesOf(n).some(d => metrics[d.id]));
  const noSuccessor = nodes.filter(n => !hasSuccessor.has(n.id));

  // One task with nothing before it and one with nothing after it are the
  // project's own ends. More than that is work floating unattached to the plan.
  add('open-starts', 'Tasks with nothing before them',
    noPredecessor.length <= 1 ? PASS : bySpread(noPredecessor.length - 1, total),
    noPredecessor.length <= 1
      ? 'Every task follows something, apart from the one the project starts with.'
      : 'Only the first task should have nothing before it. The others are not anchored to anything, so nothing can ever push them later.',
    noPredecessor.map(n => n.id));

  add('open-ends', 'Tasks with nothing after them',
    noSuccessor.length <= 1 ? PASS : bySpread(noSuccessor.length - 1, total),
    noSuccessor.length <= 1
      ? 'Every task leads somewhere, apart from the one the project ends with.'
      : 'A task with nothing after it cannot delay anything, so it never appears critical however long it runs. This is the defect most likely to make a plan quietly wrong.',
    noSuccessor.map(n => n.id));

  // ─── Relations ───────────────────────────────────────────

  const leads = relations.filter(d => d.lag < 0);
  add('leads', 'Negative lag', leads.length ? FAIL : PASS,
    leads.length
      ? 'A lead overlaps two tasks by an amount nobody wrote down as work. Split the predecessor instead, so the overlap is visible and can be estimated.'
      : 'No relation pulls its successor earlier by an unexplained amount.',
    [...new Set(leads.map(d => d.id))]);

  const lags = relations.filter(d => d.lag > 0);
  add('lags', 'Positive lag',
    bySpread(lags.length, relations.length),
    lags.length
      ? 'Lag is waiting time with no task to own it — nobody is accountable for it and no resource is consumed by it. Where it stands for real work, make it a task.'
      : 'No relation relies on unattributed waiting time.',
    [...new Set(lags.map(d => d.id))]);

  const nonFS = relations.filter(d => d.type !== 'FS');
  const fsShare = relations.length ? (relations.length - nonFS.length) / relations.length : 1;
  add('relation-types', 'Finish-to-start relations',
    !relations.length ? NA : fsShare >= QUALITY.fsShare ? PASS : bySpread(nonFS.length, relations.length),
    !relations.length
      ? 'There are no relations to assess.'
      : `${Math.round(fsShare * 100)}% of relations are finish-to-start. The others overlap tasks, and a plan built mostly from overlaps is harder to hold anyone to.`,
    [...new Set(nonFS.map(d => d.id))]);

  // ─── Constraints ─────────────────────────────────────────

  const constrained = nodes.filter(n => n.mustFinishBy != null || n.startNoEarlierThan != null);
  add('constraints', 'Hard date constraints',
    bySpread(constrained.length, total),
    constrained.length
      ? 'A date constraint overrides the network and absorbs float that the logic would otherwise show you. Used widely, it stops the schedule being a model of the work and makes it a list of wishes.'
      : 'No task is pinned to a date; the network decides everything.',
    constrained.map(n => n.id));

  // ─── Float ───────────────────────────────────────────────

  const negative = nodes.filter(n => (metrics[n.id]?.slack ?? 0) < 0);
  add('negative-float', 'Negative float', negative.length ? FAIL : PASS,
    negative.length
      ? 'These tasks are already late against a date they must meet. The plan does not currently work.'
      : 'Nothing is behind a date it has been given.',
    negative.map(n => n.id));

  const highFloat = nodes.filter(n => (metrics[n.id]?.slack ?? 0) > QUALITY.highFloatDays);
  add('high-float', 'Excessive float',
    bySpread(highFloat.length, total),
    highFloat.length
      ? `Float above ${QUALITY.highFloatDays} days usually means missing logic rather than genuine freedom — the task is not really unconstrained, it is just not joined up to whatever constrains it.`
      : `No task carries more than ${QUALITY.highFloatDays} days of float.`,
    highFloat.map(n => n.id));

  // Room that cannot be used without moving someone else is not room.
  const noFreeFloat = nodes.filter(n => {
    const m = metrics[n.id];
    return m && m.slack > 0 && m.freeFloat === 0;
  });
  add('borrowed-float', 'Float that belongs to someone else',
    noFreeFloat.length ? WARN : PASS,
    noFreeFloat.length
      ? 'These tasks have float, but none of it is free: delaying them by a single day moves a successor immediately. Their slack is real for the project and unusable in practice.'
      : 'Every task with float can absorb some of it without moving anything downstream.',
    noFreeFloat.map(n => n.id));

  // ─── Durations ───────────────────────────────────────────

  const longRunning = nodes.filter(n => (metrics[n.id]?.duration ?? 0) > QUALITY.longDurationDays);
  add('long-durations', 'Very long tasks',
    bySpread(longRunning.length, total),
    longRunning.length
      ? `A task longer than ${QUALITY.longDurationDays} days cannot be tracked meaningfully — it is at "40% done" for weeks and nobody can tell whether that is true. Break it into parts with their own finishes.`
      : `No task runs longer than ${QUALITY.longDurationDays} days.`,
    longRunning.map(n => n.id));

  const zeroEstimate = nodes.filter(n => {
    const m = metrics[n.id];
    return m && m.duration === 0 && !n.linkedSubPage;
  });
  add('zero-durations', 'Tasks with no duration',
    zeroEstimate.length ? WARN : PASS,
    zeroEstimate.length
      ? 'These take no time at all. As milestones that is correct; as work it means an estimate was never given.'
      : 'Every task has an estimate or stands for a sub-path that does.',
    zeroEstimate.map(n => n.id));

  // ─── Progress ────────────────────────────────────────────

  add('out-of-sequence', 'Progress ahead of the logic',
    !tracking ? NA : outOfSequenceIds.length ? FAIL : PASS,
    !tracking
      ? 'Set a reporting date in Settings to check progress against the network.'
      : outOfSequenceIds.length
        ? 'These tasks report work done that the network says could not have started yet. Either the logic is wrong or the progress is.'
        : 'Nothing reports progress it could not have made.',
    tracking ? outOfSequenceIds : []);

  // ─── Resources ───────────────────────────────────────────

  const named = nodes.filter(n => String(n.assignee || '').trim());
  const unowned = nodes.filter(n => !String(n.assignee || '').trim());
  add('ownership', 'Tasks with an owner',
    !named.length ? NA : bySpread(unowned.length, total),
    !named.length
      ? 'Nobody is assigned to anything yet, so there is no ownership to check.'
      : 'Work nobody owns is work nobody is doing. Assign it or drop it.',
    named.length ? unowned.map(n => n.id) : []);

  add('over-allocation', 'People carrying too much',
    !named.length ? NA : overAllocated.length ? FAIL : PASS,
    !named.length
      ? 'Nobody is assigned to anything yet.'
      : overAllocated.length
        ? `${overAllocated.join(', ')} ${overAllocated.length === 1 ? 'is' : 'are'} booked on more at once than they can carry. The schedule says the work can run; it cannot say who will run it.`
        : 'Nobody is double-booked.',
    []);

  const graded = checks.filter(c => c.severity !== NA);
  return {
    checks,
    passed: graded.filter(c => c.severity === PASS).length,
    total: graded.length,
    worst: graded.some(c => c.severity === FAIL) ? FAIL
      : graded.some(c => c.severity === WARN) ? WARN
        : PASS
  };
}

export const SEVERITY = { FAIL, WARN, PASS, NA };
