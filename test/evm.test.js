// Earned-value maths. Run with: node --test test/evm.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  scheduledFraction, taskBAC, taskEV, taskPV, taskAC, projectEVM
} from '../js/evm.js';

test('scheduledFraction reads the plan against the data date', () => {
  const m = { ES: 0, EF: 10 };
  assert.equal(scheduledFraction(m, null), null, 'no data date, no planned fraction');
  assert.equal(scheduledFraction(m, 0), 0, 'at the start');
  assert.equal(scheduledFraction(m, 5), 0.5, 'halfway');
  assert.equal(scheduledFraction(m, 10), 1, 'at the finish');
  assert.equal(scheduledFraction(m, 15), 1, 'past the finish clamps to 1');
  assert.equal(scheduledFraction(m, -3), 0, 'before the start clamps to 0');
  // A zero-span task (a milestone) is either done or not by the date.
  assert.equal(scheduledFraction({ ES: 4, EF: 4 }, 3), 0);
  assert.equal(scheduledFraction({ ES: 4, EF: 4 }, 4), 1);
});

test('task-level EV, PV, AC, BAC', () => {
  const node = { cost: 200, progress: 50, actualCost: 120 };
  assert.equal(taskBAC(node), 200);
  assert.equal(taskEV(node), 100, 'earned = budget × progress');
  assert.equal(taskPV(node, { ES: 10, EF: 20 }, 15), 100, 'planned = budget × scheduled fraction');
  assert.equal(taskPV(node, { ES: 10, EF: 20 }, null), null, 'no PV without a data date');
  assert.equal(taskAC(node), 120);
  assert.equal(taskAC({ cost: 5 }), null, 'no actual recorded → null, not zero');
  assert.equal(taskBAC({ cost: -4 }), 0, 'negative budget floored at zero');
});

const project = [
  { id: 'A', title: 'A', cost: 100, progress: 100, actualCost: 90 },
  { id: 'B', title: 'B', cost: 200, progress: 50, actualCost: 120 }
];
const metrics = { A: { ES: 0, EF: 10 }, B: { ES: 10, EF: 20 } };

test('projectEVM rolls the whole page up', () => {
  const evm = projectEVM(project, metrics, 15);
  assert.equal(evm.BAC, 300);
  assert.equal(evm.EV, 200);   // 100×1 + 200×0.5
  assert.equal(evm.PV, 200);   // 100×1 + 200×0.5
  assert.equal(evm.SV, 0);
  assert.equal(evm.SPI, 1);
  assert.equal(evm.AC, 210);
  assert.equal(evm.CV, -10);
  assert.ok(Math.abs(evm.CPI - 0.9524) < 1e-3, 'CPI ≈ EV/AC');
  assert.ok(evm.EAC > 300, 'over budget → forecast above BAC');
  assert.ok(evm.VAC < 0, 'and a negative variance at completion');
  assert.equal(evm.hasCost, true);
  assert.equal(evm.hasActuals, true);
  assert.equal(evm.tracking, true);
  assert.equal(evm.byTask.length, 2);
});

test('without a data date there is no planned value', () => {
  const evm = projectEVM(project, metrics, null);
  assert.equal(evm.tracking, false);
  assert.equal(evm.PV, null);
  assert.equal(evm.SV, null);
  assert.equal(evm.SPI, null);
  assert.equal(evm.EV, 200, 'earned value still stands');
});

test('without actuals there is no cost performance', () => {
  const noActuals = project.map(n => ({ ...n, actualCost: null }));
  const evm = projectEVM(noActuals, metrics, 15);
  assert.equal(evm.hasActuals, false);
  assert.equal(evm.AC, null);
  assert.equal(evm.CV, null);
  assert.equal(evm.CPI, null);
  assert.equal(evm.EAC, null);
  assert.equal(evm.SPI, 1, 'schedule performance still computes');
});

test('a project with no budgets reports so', () => {
  const evm = projectEVM([{ id: 'A', cost: 0, progress: 30 }], { A: { ES: 0, EF: 5 } }, 2);
  assert.equal(evm.hasCost, false);
  assert.equal(evm.BAC, 0);
});
