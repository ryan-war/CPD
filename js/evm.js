// Earned Value Management: the cost dimension.
//
// The schedule says whether the plan is on time and the resource view whether
// anyone is free to run it. Neither says whether it is on budget. EVM does, by
// comparing three numbers at a reporting date:
//
//   PV — planned value: budget for the work that *should* be done by now.
//   EV — earned value:  budget for the work *actually* done.
//   AC — actual cost:   what that work *actually* cost.
//
// From them: schedule variance EV−PV (behind or ahead, in money), cost variance
// EV−AC (over or under), the indices SPI=EV/PV and CPI=EV/AC, and a forecast
// EAC=BAC/CPI of what the whole job will cost at the current rate.
//
// A task carries `cost` (its budget, BAC) and optionally `actualCost` (AC, null
// until recorded). PV needs a data date to mean anything; CV/CPI/EAC need at
// least one recorded actual. Where an input is missing the figure is returned
// as null, for the panel to explain rather than to invent.

/** Budget at completion for a task: its own cost, floored at zero. */
export function taskBAC(node) {
  return Math.max(0, Number(node.cost) || 0);
}

/**
 * The share of a task the plan expects finished by the reporting date, from its
 * scheduled span — the same reading the Gantt draws its "as of" fill from, so
 * planned value and the bar agree. Without a data date there is no "by now", so
 * fall back to reported progress.
 */
export function scheduledFraction(metric, dataDate) {
  const es = Number(metric?.ES) || 0;
  const ef = Number(metric?.EF) || 0;
  const span = Math.max(0, ef - es);
  if (dataDate == null) return null;
  if (span <= 0) return dataDate >= es ? 1 : 0;
  return Math.max(0, Math.min(1, (dataDate - es) / span));
}

/** Earned value: budget for the fraction actually reported complete. */
export function taskEV(node) {
  const progress = Math.max(0, Math.min(100, Number(node.progress) || 0));
  return taskBAC(node) * (progress / 100);
}

/** Planned value: budget for the fraction scheduled done by the data date. */
export function taskPV(node, metric, dataDate) {
  const fraction = scheduledFraction(metric, dataDate);
  return fraction == null ? null : taskBAC(node) * fraction;
}

/** Recorded actual cost, or null when none has been entered. */
export function taskAC(node) {
  // null/undefined/'' mean "no actual recorded" — distinct from a real $0.
  // Number(null) and Number('') are both 0, so guard before coercing or an
  // unrecorded actual reads as a genuine zero and invents a cost variance.
  if (node.actualCost == null || node.actualCost === '') return null;
  const ac = Number(node.actualCost);
  return Number.isFinite(ac) && ac >= 0 ? ac : null;
}

const round = value => (value == null ? null : +(+value).toFixed(2));
const ratio = (num, den) => (den > 0 ? +(num / den).toFixed(4) : null);

/**
 * Roll every task on a page up into one earned-value report.
 *
 * @returns {{
 *   BAC:number, EV:number,
 *   PV:number|null, SV:number|null, SPI:number|null,
 *   AC:number|null, CV:number|null, CPI:number|null,
 *   EAC:number|null, ETC:number|null, VAC:number|null,
 *   hasCost:boolean, hasActuals:boolean, tracking:boolean,
 *   byTask:Array<{id,title,BAC,EV,PV,AC,CV,SV}>
 * }}
 */
export function projectEVM(nodes, metrics, dataDate) {
  const tracking = dataDate != null;
  let BAC = 0;
  let EV = 0;
  let PV = tracking ? 0 : null;
  let AC = 0;
  let hasCost = false;
  let hasActuals = false;
  const byTask = [];

  nodes.forEach(node => {
    const m = metrics[node.id] || {};
    const bac = taskBAC(node);
    const ev = taskEV(node);
    const pv = taskPV(node, m, dataDate);
    const ac = taskAC(node);
    if (bac > 0) hasCost = true;
    if (ac != null) hasActuals = true;

    BAC += bac;
    EV += ev;
    if (tracking && pv != null) PV += pv;
    if (ac != null) AC += ac;

    byTask.push({
      id: node.id,
      title: node.title || node.id,
      BAC: round(bac),
      EV: round(ev),
      PV: round(pv),
      AC: ac == null ? null : round(ac),
      CV: ac == null ? null : round(ev - ac),
      SV: pv == null ? null : round(ev - pv)
    });
  });

  const acTotal = hasActuals ? AC : null;
  const CPI = acTotal != null ? ratio(EV, acTotal) : null;
  const EAC = CPI ? round(BAC / CPI) : null;

  return {
    BAC: round(BAC),
    EV: round(EV),
    PV: tracking ? round(PV) : null,
    SV: tracking ? round(EV - PV) : null,
    SPI: tracking ? ratio(EV, PV) : null,
    AC: acTotal == null ? null : round(acTotal),
    CV: acTotal == null ? null : round(EV - acTotal),
    CPI,
    EAC,
    ETC: EAC != null && acTotal != null ? round(EAC - acTotal) : null,
    VAC: EAC != null ? round(BAC - EAC) : null,
    hasCost,
    hasActuals,
    tracking,
    byTask
  };
}
