// Scenarios: saved what-if branches of the whole plan.
//
// The baseline captures one schedule to measure drift against. A scenario goes
// further: it stores the whole project — every task, estimate, dependency and
// setting — under a name, so you can fork the plan, change what a task costs or
// how the work is sequenced, and see what it does to the finish date without
// losing the plan you started from. Compare answers the question a baseline
// cannot: not "how far has it drifted" but "what would this change buy me".

import { computeCPM, createRollup, nodesOf } from './cpm.js';

/**
 * A frozen copy of the plan for storing as a scenario.
 *
 * Everything except the scenario list itself is captured — a scenario holding
 * its siblings would nest without limit, doubling in size each save. The copy
 * is deep so later edits to the live project never reach back into it.
 */
export function snapshotState(state) {
  const clone = JSON.parse(JSON.stringify(state));
  delete clone.scenarios;
  return clone;
}

/**
 * The whole-project schedule for a plan snapshot: the Main diagram, costed with
 * its own sub-path roll-up exactly as the live app costs it. Returned figures
 * are what the project finishes in and where each task lands, for comparison.
 */
export function mainSummary(data) {
  const mode = data.estimationMode === 'pert' ? 'pert' : 'average';
  const diagrams = data.diagrams || {};
  const nodes = nodesOf(diagrams.main || {});
  const rollup = createRollup(diagrams, mode);
  const { metrics, criticalIds, projectDuration } = computeCPM(nodes, {
    mode,
    rollup,
    deadline: data.deadline ?? null,
    dataDate: data.dataDate ?? null
  });
  return { nodes, metrics, criticalIds, projectDuration };
}

const round = value => +(Number(value) || 0).toFixed(4);

/**
 * Compare a scenario's plan against the current one, task by task, on the Main
 * diagram.
 *
 * Reports the change in project duration and, per task, how its duration and
 * start move between the two — plus tasks that exist in only one of them. Only
 * tasks that actually differ are returned: a table where most rows say "no
 * change" buries the handful that do.
 *
 * @returns {{
 *   projectDelta: number,
 *   current: {projectDuration: number},
 *   scenario: {projectDuration: number},
 *   tasks: Array<{id, title, status, durationDelta, startDelta, finishDelta,
 *                 critCurrent, critScenario}>
 * }}
 */
export function compareScenario(currentData, scenarioData) {
  const current = mainSummary(currentData);
  const scenario = mainSummary(scenarioData);

  const titleOf = new Map();
  scenario.nodes.forEach(n => titleOf.set(n.id, n.title));
  current.nodes.forEach(n => titleOf.set(n.id, n.title));

  const ids = new Set([
    ...current.nodes.map(n => n.id),
    ...scenario.nodes.map(n => n.id)
  ]);

  const tasks = [];
  ids.forEach(id => {
    const c = current.metrics[id];
    const s = scenario.metrics[id];
    const inCurrent = !!c;
    const inScenario = !!s;

    if (inCurrent && inScenario) {
      const durationDelta = round(s.duration - c.duration);
      const startDelta = round(s.ES - c.ES);
      const finishDelta = round(s.EF - c.EF);
      const critCurrent = current.criticalIds.has(id);
      const critScenario = scenario.criticalIds.has(id);
      if (durationDelta === 0 && startDelta === 0 && finishDelta === 0 && critCurrent === critScenario) {
        return; // unchanged — left out so the changes stand alone
      }
      tasks.push({
        id, title: titleOf.get(id) || id, status: 'changed',
        durationDelta, startDelta, finishDelta, critCurrent, critScenario
      });
    } else if (inScenario) {
      tasks.push({ id, title: titleOf.get(id) || id, status: 'added' });
    } else {
      tasks.push({ id, title: titleOf.get(id) || id, status: 'removed' });
    }
  });

  // Biggest schedule movers first, then added/removed, then by id.
  const weight = t => t.status === 'changed'
    ? -Math.abs(t.finishDelta || 0) - Math.abs(t.durationDelta || 0)
    : 1;
  tasks.sort((a, b) => weight(a) - weight(b) || String(a.id).localeCompare(String(b.id)));

  return {
    projectDelta: round(scenario.projectDuration - current.projectDuration),
    current: { projectDuration: current.projectDuration },
    scenario: { projectDuration: scenario.projectDuration },
    tasks
  };
}
