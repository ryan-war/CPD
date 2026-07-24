// RAG derivation + RAID normalization. Run: node --test test/rag.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveRAG, effectiveRAG, riskSeverity, nextOverride } from '../js/rag.js';
import { normalizeState, createDefaultState } from '../js/state.js';

const nodes = [{ id: 'A' }, { id: 'B' }];
const okMetrics = { A: { slack: 2, ES: 0, EF: 3, duration: 3 }, B: { slack: 1, ES: 3, EF: 5, duration: 2 } };
const base = extra => ({ metrics: okMetrics, nearCritical: new Set(), ...extra });

test('green when nothing is wrong', () => {
  assert.equal(deriveRAG(nodes, base()), 'green');
});

test('negative float is red', () => {
  assert.equal(deriveRAG(nodes, { metrics: { A: { slack: -1 }, B: { slack: 1 } }, nearCritical: new Set() }), 'red');
});

test('an at-risk task is amber', () => {
  assert.equal(deriveRAG(nodes, base({ nearCritical: new Set(['A']) })), 'amber');
});

test('a missed deadline (overrun) is red', () => {
  assert.equal(deriveRAG(nodes, base({ overrun: 3 })), 'red');
});

test('SPI below 0.9 is red, 0.9–1.0 is amber', () => {
  const behind = [{ id: 'A', cost: 100, progress: 50 }];
  const m = { A: { slack: 5, ES: 0, EF: 10, duration: 10 } };
  assert.equal(deriveRAG(behind, { metrics: m, nearCritical: new Set(), dataDate: 10 }), 'red');

  const slipping = [{ id: 'A', cost: 100, progress: 95 }];
  assert.equal(deriveRAG(slipping, { metrics: m, nearCritical: new Set(), dataDate: 10 }), 'amber');
});

test('an open High risk is red, a medium one amber', () => {
  assert.equal(deriveRAG(nodes, base({ openRaid: [{ type: 'risk', status: 'open', probability: 'high', impact: 'high' }] })), 'red');
  assert.equal(deriveRAG(nodes, base({ openRaid: [{ type: 'issue', status: 'open', probability: 'medium', impact: 'medium' }] })), 'amber');
});

test('assumptions and dependencies do not colour the RAG', () => {
  const openRaid = [
    { type: 'assumption', status: 'open', probability: 'high', impact: 'high' },
    { type: 'dependency', status: 'open' }
  ];
  assert.equal(deriveRAG(nodes, base({ openRaid })), 'green');
});

test('the worst signal wins', () => {
  // an at-risk task (amber) alongside a negative-float task (red) → red
  assert.equal(deriveRAG(nodes, { metrics: { A: { slack: -1 }, B: { slack: 1 } }, nearCritical: new Set(['B']) }), 'red');
});

test('riskSeverity is probability × impact, 0 when unscored', () => {
  assert.equal(riskSeverity({ probability: 'high', impact: 'high' }), 9);
  assert.equal(riskSeverity({ probability: 'low', impact: 'medium' }), 2);
  assert.equal(riskSeverity({ probability: 'high' }), 0);
});

test('effectiveRAG: a valid override wins, else the derived value', () => {
  assert.equal(effectiveRAG('red', 'green'), 'red');
  assert.equal(effectiveRAG(null, 'amber'), 'amber');
  assert.equal(effectiveRAG('bogus', 'green'), 'green');
});

test('nextOverride cycles auto → red → amber → green → auto', () => {
  assert.equal(nextOverride(null), 'red');
  assert.equal(nextOverride('red'), 'amber');
  assert.equal(nextOverride('amber'), 'green');
  assert.equal(nextOverride('green'), null);
});

// ─── RAID / RAG normalization ──────────────────────────────

test('a default project carries rag null and an empty raid, at schema 4', () => {
  const s = normalizeState(createDefaultState());
  assert.equal(s.rag, null);
  assert.deepEqual(s.raid, []);
  assert.equal(s.schemaVersion, 4);
  assert.equal(s.diagrams.main.milestones[0].rag, null);
});

test('normalizeRaid drops untitled entries, coerces enums, clears dangling links', () => {
  const s = normalizeState({
    diagrams: { main: { milestones: [{ id: 'm', nodes: [{ id: 'A', min: 1, max: 1 }] }] } },
    raid: [
      { title: 'ok', type: 'risk', probability: 'high', impact: 'nonsense', linkedTaskId: 'A' },
      { title: '   ', type: 'issue' },              // no title → dropped
      { title: 'orphan', type: 'weird', linkedTaskId: 'ZZZ' } // bad type + dead link
    ]
  });
  assert.equal(s.raid.length, 2);
  assert.equal(s.raid[0].impact, null, 'bad enum cleared');
  assert.equal(s.raid[0].linkedTaskId, 'A', 'valid link kept');
  assert.equal(s.raid[1].type, 'risk', 'unknown type falls back to risk');
  assert.equal(s.raid[1].linkedTaskId, null, 'dead link cleared');
});

test('a bogus rag override is normalized to null', () => {
  const s = normalizeState({ rag: 'purple', diagrams: { main: { milestones: [] } } });
  assert.equal(s.rag, null);
});
