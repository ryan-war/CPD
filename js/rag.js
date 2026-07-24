// RAG status: Red / Amber / Green, derived from the plan's own signals.
//
// A RAG is the one-glance health a project manager reports upward. This module
// computes it — for the whole project, or for one milestone — from what the
// schedule and the earned-value engine already know, so the colour is grounded
// in the plan rather than a mood. It is a default, not a verdict: the PM can
// override any RAG by hand, and the override always wins (effectiveRAG).
//
// Pure and DOM-free, like cpm.js / evm.js / critical-chain.js.

import { projectEVM } from './evm.js';

export const RAG_LEVELS = ['green', 'amber', 'red'];

/**
 * Thresholds, gathered so the rule is one place a reader can audit. The index
 * figures are the standard earned-value tripwires: below 0.9 is trouble, 0.9 to
 * 1.0 is slipping, at or above 1.0 is on plan.
 */
export const RAG = {
  indexRed: 0.9,   // SPI or CPI below this is Red
  indexAmber: 1.0  // below this (but not Red) is Amber
};

const RANK = { low: 1, medium: 2, high: 3 };

/** A risk's severity 1–9, probability × impact, or 0 when either is unscored. */
export function riskSeverity(entry) {
  return (RANK[entry?.probability] || 0) * (RANK[entry?.impact] || 0);
}

/**
 * The worse of two levels — Red beats Amber beats Green — so a scope can be
 * escalated by any one signal without a later, milder one pulling it back.
 */
function worst(a, b) {
  return RAG_LEVELS.indexOf(a) >= RAG_LEVELS.indexOf(b) ? a : b;
}

/**
 * Derive a RAG for a set of tasks.
 *
 * @param {Array} scopeNodes tasks in scope (a milestone's, or the whole project's)
 * @param {object} ctx
 *   - metrics:      the schedule's per-task metrics (for slack)
 *   - nearCritical: Set of at-risk task ids
 *   - dataDate:     reporting date, for earned value
 *   - overrun:      days past the project deadline (project scope only), or null
 *   - openRaid:     open RAID entries in scope (risks/issues escalate the colour)
 * @returns {'green'|'amber'|'red'}
 */
export function deriveRAG(scopeNodes, ctx = {}) {
  const { metrics = {}, nearCritical = new Set(), dataDate = null, overrun = null, openRaid = [] } = ctx;
  let level = 'green';

  // Schedule: a task past its deadline is Red; one merely at risk is Amber.
  for (const node of scopeNodes) {
    const m = metrics[node.id];
    if (m && m.slack < 0) level = worst(level, 'red');
    else if (nearCritical.has(node.id)) level = worst(level, 'amber');
  }
  if (overrun != null && overrun > 0) level = worst(level, 'red');

  // Earned value for this scope, when there is a reporting date and any cost.
  const evm = projectEVM(scopeNodes, metrics, dataDate);
  [evm.SPI, evm.CPI].forEach(index => {
    if (index == null) return;
    if (index < RAG.indexRed) level = worst(level, 'red');
    else if (index < RAG.indexAmber) level = worst(level, 'amber');
  });

  // Governance: an open High×High risk (or high Issue) is Red; a medium-or-worse
  // one is Amber. Assumptions and dependencies inform, but do not colour.
  for (const entry of openRaid) {
    if (entry.type !== 'risk' && entry.type !== 'issue') continue;
    const severity = riskSeverity(entry);
    if (severity >= 9) level = worst(level, 'red');
    else if (severity >= 4) level = worst(level, 'amber');
  }

  return level;
}

/** The RAG shown: a manual override if set, otherwise the derived value. */
export function effectiveRAG(override, derived) {
  return RAG_LEVELS.includes(override) ? override : derived;
}

/** Cycle an override through auto → red → amber → green → auto (on click). */
export function nextOverride(current) {
  const order = [null, 'red', 'amber', 'green'];
  const i = order.indexOf(RAG_LEVELS.includes(current) ? current : null);
  return order[(i + 1) % order.length];
}
