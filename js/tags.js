// Tags: free-form labels on tasks that cut across milestones and owners.
//
// A task has a `tags` array of short strings. Grouping by milestone answers
// "what phase", by assignee "whose", and neither answers "which of these are
// QA, or client-facing, or blocked on legal". Tags do, and the filter below
// lets the diagram show only the ones that carry a given label.

import { nodesOf } from './cpm.js';

const MAX_LENGTH = 40;

/** The tags on a node, always as an array — older tasks may not carry the key. */
export function tagsOf(node) {
  return Array.isArray(node?.tags) ? node.tags : [];
}

/**
 * Parse a comma-separated field into a clean tag set: trimmed, de-duplicated,
 * nothing empty, in the order first seen. The same rules `normalizeState`
 * applies to a loaded file, so what the editor writes matches what a file
 * carries.
 */
export function parseTags(text) {
  const seen = new Set();
  const out = [];
  String(text || '').split(',').forEach(raw => {
    const tag = raw.trim().slice(0, MAX_LENGTH);
    if (!tag || seen.has(tag)) return;
    seen.add(tag);
    out.push(tag);
  });
  return out;
}

/** Every tag in use across every page, sorted, for autocomplete. */
export function allTags(diagrams) {
  const set = new Set();
  Object.values(diagrams || {}).forEach(diagram => {
    nodesOf(diagram).forEach(node => tagsOf(node).forEach(tag => set.add(tag)));
  });
  return [...set].sort((a, b) => a.localeCompare(b));
}

/**
 * Tags used on one page with how many tasks carry each — what the filter bar
 * needs. Sorted by count, then name, so the labels that organise the most of
 * the diagram come first.
 */
export function tagCounts(nodes) {
  const counts = new Map();
  nodes.forEach(node => tagsOf(node).forEach(tag => counts.set(tag, (counts.get(tag) || 0) + 1)));
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag, count]) => ({ tag, count }));
}

/** Does a task carry any of the active tags? Empty filter matches everything. */
export function matchesTags(node, active) {
  if (!active || !active.size) return true;
  return tagsOf(node).some(tag => active.has(tag));
}
