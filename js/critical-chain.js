// Critical Chain (CCPM): buffers, and how much of them the work has eaten.
//
// The critical path answers "which tasks drive the finish". Critical Chain asks
// the next question a project manager lives by: "are we still protected?" It
// takes the safety padded into individual estimates, pools it into buffers, and
// then watches those buffers drain as the work reports in — so a slip shows up
// as buffer spent, not as a dozen separate tasks quietly turning red.
//
// This module is pure and DOM-free, like cpm.js and quality.js, and reads only
// what the schedule already computed. Two honest limits, surfaced in the panel:
//
//   * The chain here is the critical path of the *current* schedule. True CCPM
//     levels resources first; this app levels separately (it writes start
//     constraints the engine already honours), so levelling first makes the
//     critical path resource-feasible — i.e. the chain — with no work here.
//   * Buffers are sized from the O/M/P spread each task carries. A task with no
//     spread (min === likely === max) has no safety to pool, so it adds nothing
//     to a buffer. That is reported, not hidden as a zero that looks measured.

import { baseDuration, dependenciesOf } from './cpm.js';

const round = value => +(Number(value) || 0).toFixed(4);

/**
 * The safety cut from a task's estimate: how much longer the pessimistic case
 * runs than the figure the schedule actually uses. This is the padding CCPM
 * pulls out of the task and into a shared buffer.
 */
export function taskSafety(node, mode) {
  const safe = Number(node?.max) || 0;
  const aggressive = baseDuration(node || {}, mode);
  return Math.max(0, safe - aggressive);
}

/**
 * Pool a set of safeties into one buffer by the sum-of-squares method — the
 * square root of the summed squares. Unlike simply adding the safeties, this
 * assumes the tasks will not all run long together, so a long chain is not
 * over-protected; it is the defensible CCPM default. (The cruder "50% of the
 * chain" method could be offered as a toggle later.)
 */
export function sizeBuffer(safeties) {
  const sumSq = (safeties || []).reduce((acc, s) => acc + s * s, 0);
  return round(Math.sqrt(sumSq));
}

/** Predecessor ids of a task, read from the metric (which spreads the node). */
function predIds(metric) {
  return dependenciesOf(metric || {}).map(d => d.id);
}

/**
 * The critical chain: the tasks with no float, in schedule order. Empty when the
 * network has a cycle, since then nothing has a trustworthy schedule.
 *
 * @returns {{chainIds: string[], length: number}}
 */
export function criticalChain(schedule) {
  const { criticalIds, order, metrics = {}, projectDuration = 0, cycleIds } = schedule || {};
  if ((cycleIds && cycleIds.length) || !criticalIds) return { chainIds: [], length: 0 };
  const ids = order && order.length ? order : Object.keys(metrics);
  const chainIds = ids.filter(id => criticalIds.has(id));
  return { chainIds, length: round(projectDuration) };
}

/**
 * Feeding buffers: where a path that is *not* on the chain merges into it, a
 * buffer protects the chain from that path running late. One per merge task,
 * sized from the safety of every task feeding that merge (stopping wherever the
 * chain is reached).
 *
 * @param {object} schedule the computed schedule
 * @param {Set<string>} chainSet the chain task ids
 * @returns {Array<{mergeId:string, pathIds:string[], buffer:number}>}
 */
export function feedingPaths(schedule, chainSet) {
  const { metrics = {}, mode, order, cycleIds } = schedule || {};
  if (cycleIds && cycleIds.length) return [];
  const ids = order && order.length ? order : Object.keys(metrics);
  const feeders = [];

  ids.forEach(mergeId => {
    if (!chainSet.has(mergeId)) return;
    const offChainPreds = predIds(metrics[mergeId]).filter(id => !chainSet.has(id) && metrics[id]);
    if (!offChainPreds.length) return;

    // Collect the whole feeding sub-network behind this merge: every off-chain
    // ancestor reachable without crossing back onto the chain.
    const pathIds = new Set();
    const stack = [...offChainPreds];
    while (stack.length) {
      const id = stack.pop();
      if (chainSet.has(id) || pathIds.has(id) || !metrics[id]) continue;
      pathIds.add(id);
      predIds(metrics[id]).forEach(p => stack.push(p));
    }

    const buffer = sizeBuffer([...pathIds].map(id => taskSafety(metrics[id], mode)));
    feeders.push({ mergeId, pathIds: [...pathIds], buffer });
  });

  return feeders;
}

// Fever-chart zones. Buffer consumption is tolerated more the further the chain
// has run: spending buffer at 10% complete is worse than the same spend at 90%.
// Two rising boundaries divide green/amber/red. Pragmatic thresholds — amber
// from a quarter of the buffer early to two-thirds at the end, red from a half
// to the whole — commented so they are easy to tune.
function feverZone(chainComplete, bufferConsumed) {
  const c = Math.max(0, Math.min(1, chainComplete));
  const amberLine = 0.25 + 0.40 * c;
  const redLine = 0.50 + 0.50 * c;
  if (bufferConsumed >= redLine) return 'red';
  if (bufferConsumed >= amberLine) return 'amber';
  return 'green';
}

/**
 * The whole Critical Chain picture the panel renders.
 *
 * `consumption` needs both a reporting date (so there is progress to read) and a
 * baseline (so there is a planned finish to measure the slip against), plus a
 * non-zero project buffer to measure it in. Missing any of those, it is null and
 * the panel says which input to supply rather than drawing a meaningless dot.
 *
 * @param {object} schedule the computed schedule (metrics, criticalIds, order,
 *                 projectDuration, dataDate, mode)
 * @param {?{projectDuration:number}} baseline the captured baseline, or null
 * @returns {{chainIds:string[], chainLength:number, projectBuffer:number,
 *            feeders:Array, consumption:?object}}
 */
export function criticalChainReport(schedule, baseline) {
  const { chainIds, length } = criticalChain(schedule);
  const chainSet = new Set(chainIds);
  const metrics = schedule?.metrics || {};
  const mode = schedule?.mode;

  const projectBuffer = sizeBuffer(chainIds.map(id => taskSafety(metrics[id], mode)));
  const feeders = feedingPaths(schedule, chainSet);

  let consumption = null;
  const dataDate = schedule?.dataDate;
  if (dataDate != null && baseline && projectBuffer > 0) {
    // Chain completion, weighted by how long each task is: a long task half done
    // has moved the chain more than a short one finished.
    let totalDur = 0;
    let doneDur = 0;
    chainIds.forEach(id => {
      const m = metrics[id];
      const dur = Number(m?.duration) || 0;
      const p = Math.max(0, Math.min(100, Number(m?.progress) || 0));
      totalDur += dur;
      doneDur += dur * (p / 100);
    });
    const chainComplete = totalDur > 0 ? doneDur / totalDur : 0;

    // Buffer spent = how far the forecast finish has slipped past the baseline,
    // as a fraction of the buffer. The forecast already answers to the reporting
    // date (computeCPM reforecast it), so this is a live reading.
    const overrun = Math.max(0, (schedule.projectDuration || 0) - (baseline.projectDuration || 0));
    const bufferConsumed = overrun / projectBuffer;

    consumption = {
      chainComplete: round(chainComplete),
      bufferConsumed: round(bufferConsumed),
      zone: feverZone(chainComplete, bufferConsumed)
    };
  }

  return { chainIds, chainLength: length, projectBuffer, feeders, consumption };
}
