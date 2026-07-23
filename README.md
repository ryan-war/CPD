# CPD — Critical Path Network

A browser-based Critical Path Method planner. Build a task network on a canvas,
and it computes the schedule as you go: earliest and latest start/finish, slack,
and the critical path. Adds PERT estimation, working-day calendars, a Gantt
timeline, Monte Carlo schedule risk analysis, and nested sub-path diagrams.

No accounts, no server, no build step — static files and a browser. Your work is
kept in the browser between visits, and projects are saved and loaded as JSON
files you keep yourself.

## Features

### Scheduling

- **CPM engine** — forward and backward pass, slack, and critical path,
  recalculated on every edit.
- **All four precedence relations** — finish-to-start, start-to-start,
  finish-to-finish, and start-to-finish, each with positive lag or negative
  lead. Non finish-to-start links are drawn dashed and labelled.
- **Two estimation modes** — average `(Min + Max) / 2`, or PERT
  `(O + 4M + P) / 6`.
- **Working-day calendar** — set a project start date, working days, and
  holidays, and every figure can be read as a real date instead of a day
  number.
- **Deadlines and negative float** — set a date for the project, or for a
  single task. A deadline the plan misses pulls every latest-finish back with
  it, so float goes negative and the schedule reports *how late it already is*
  rather than merely which tasks are critical. A deadline the plan already
  meets is left alone: it would otherwise hand every task float and empty the
  critical path.
- **Total and free float** — total float is delay before the *project* moves;
  free float is delay before a *successor* does. Where they disagree the card
  says so, because a task with ten days of total float and none free has room
  only by spending someone else's.
- **Start constraints** — as well as a due date, a task can be held back by
  something the network does not model: a permit, a delivery, a date someone
  else owns. A start constraint only ever delays a task, never pulls one in.
- **Progress that drives the schedule** — set a date the project is *reported
  as of* and what is left of each task is scheduled from there. Finished work
  stops at the reporting date, work in progress runs from it with only its
  remainder ahead, and work not started cannot begin in the past. The headline
  figure becomes a forecast that moves as the work does rather than the plan it
  was drawn with. Tasks reporting progress the logic says they could not yet
  have made are flagged rather than quietly absorbed.
- **At-risk highlighting** — tasks that are not critical but have little float
  are flagged separately, at a threshold you choose. Schedules slip through
  these far more often than through tasks already known to be critical.
- **Resource load** — assign an owner to a task and see who is carrying what
  over the project's timeline, with double-booked stretches marked. The
  schedule says when work *can* run; this says whether anyone is free to run
  it. Capacity is adjustable for people who genuinely do juggle.
- **Resource levelling** — and then resolve it. Two proposals are offered
  whenever someone is over-allocated: *within float*, which never moves the end
  date and reports what it could not fix, and *resolve everything*, which says
  what clearing the last conflict would cost. Tasks with least float get first
  claim on whoever is free, so the ones that would move the project are the
  ones that do not move. Applying writes an ordinary start constraint on each
  task the resource actually pushed — the rest follow through the logic — so
  the result is readable, editable, and one step of undo.
- **Sub-path pages** — link a task to its own diagram; the sub-path's project
  duration rolls up and replaces the parent task's estimate.
- **Ghosted sub-paths** — draw a linked sub-path in place, hanging below the
  task that stands for it. Main runs left to right, so the branch hangs
  downward: depth on screen is depth in the breakdown, and the two levels stay
  legible as different things. Ghosts are decoration, not data — they take no
  part in this page's schedule and cannot be selected, moved, or deleted. The
  one thing they do is take you to their page when clicked. Show them under
  every linked task, or only under the one you have selected.
- **Sub-path roll-up figures** — what each linked branch is actually worth:
  its share of the project duration, its share of the critical path, and its
  own completion, weighted by task duration rather than task count. The share
  appears on the page tab, the three figures on the parent task's card. A task
  standing in for a sub-page takes its progress from that page instead of a
  slider of its own.
- **Critical path across pages** — a sub-path task can be critical on its own
  page while the whole branch has float in Main, and colouring both the same
  red says it matters when it does not. Tasks that drive the *project* — every
  link in the chain critical, all the way up to Main — are marked separately.
- **Baseline comparison** — snapshot the schedule, then see per-task and
  whole-project drift against it as things change.
- **Cycle protection** — circular dependencies are rejected as you draw them,
  and any present in a loaded file are reported by name.

### Schedule health

- **Quality checks** — whether the plan is *sound*, as against whether it
  computes. The engine will happily schedule a network that is quietly wrong:
  a task with nothing after it cannot delay anything, so it never appears
  critical however long it runs — it simply falls out of the answer. A negative
  lag hides logic nobody wrote down. A hard date constraint overrides the
  network and takes the float with it. Each of these produces a schedule that
  is perfectly computed and misleading.

  Fourteen checks cover logic (open starts and ends), relations (leads, lags,
  how much of the plan is built from overlaps), constraints, float (negative,
  excessive, and float that cannot be spent without moving a successor),
  durations (very long tasks, missing estimates), progress reported ahead of
  the logic, and ownership. Each says what it found, why it matters, and which
  tasks — click the ids and they are selected on the diagram.

  Checks that cannot run say so rather than passing: with nobody assigned and
  no reporting date set, silence would read as a clean bill of health for
  something never examined.

### Risk analysis

- **Monte Carlo simulation** — samples each task from a triangular O/M/P
  distribution and reports mean, P50, P80 and P95 durations with a histogram.
  With a reporting date set it samples what is left of the work rather than
  what was planned, so a project already under way is simulated as it stands
  and its spread narrows as the estimates stop being guesses.
  Runs in a worker, so the page stays responsive and the run continues if you
  switch tabs. 20 000 runs on a small project takes about a second.
- **Criticality index** — how often each task landed on the critical path
  across every run. A task critical in 96% of runs deserves more attention than
  one critical in 4%.
- **Sensitivity** — which estimates actually drive the project duration, by
  correlation between each task's sampled duration and the outcome.

### Cost and earned value

- **Per-task budget and actuals** — give a task a cost, and record what it has
  actually cost as the work is done.
- **Earned value** — the **Cost** panel reports budget (BAC), planned value,
  earned value, and actual cost, with the schedule and cost variances, the SPI
  and CPI indices, and an EAC forecast of the final cost at the current rate.
  Planned value reads off the same reporting date the schedule does, so the
  money and the dates agree; figures that need an input the plan lacks (a
  reporting date, a recorded actual) say so rather than reading as zero.

### Sharing and export

- **What-if scenarios** — save the whole plan under a name, change it, and
  compare: the change in finish date and, task by task, what moved — against the
  current plan or against another scenario. Duplicate and load them freely.
- **Tags** — free-form, colour-coded labels that cut across milestones and
  owners, with a filter strip that dims everything without the chosen tags.
- **Shareable link** — copy a link that carries the whole project (compressed
  into the URL, no server); open it anywhere for an editable copy.
- **Export** — the diagram as PNG or vector **SVG**, the schedule as CSV, or
  **Print** (Save as PDF) stripped down to the diagram and summary.

### Interface

- **Two task shapes** — circles by default, or activity-on-node boxes that lay
  ES, duration, EF, LS, slack and LF out in a fixed grid.
- **Grouped page tabs** — sub-paths sit under the Main task that links them,
  behind a chip that jumps back to it. The strip takes the width the header
  has spare and wraps rather than scrolling out of sight. Past a dozen or so
  it becomes a searchable picker instead: at a hundred sub-paths a strip of
  tabs is not navigation, it is a wall, and it pushed the canvas off the bottom
  of the window. The picker filters on page title, on the Main task the page
  hangs from, and on that task's title — because "the one under T73" is what
  anyone actually remembers.
- **Milestones** — group tasks into phases, reorder them, and use the columns
  view to align the canvas and the task cards by milestone. Column headers
  carry the task count, total duration, critical count, and completion.
- **CPM auto-layout** — longest-path ranks, barycenter ordering to cut edge
  crossings, and the critical path drawn as one straight horizontal line.
  Columns and rows are spaced by how much room the tasks actually need, so
  box-shape diagrams do not overlap.
- **Mini-Gantt** — timeline bars positioned by ES/EF with a real date axis,
  shaded by progress, critical and at-risk paths highlighted.
- **Autosave** — the workspace is written to browser storage as you go and
  restored on your next visit, with a banner saying when it was saved and a way
  back to a blank project. Closing the tab is no longer destructive. JSON
  export remains the way to keep, move, or share a project.
- **Light and dark themes.**
- **Dependency tracing** — hover a task to highlight everything upstream and
  downstream of it.
- **Minimap and zoom controls**, a resizable diagram/panel split, a colour
  legend, multi-select with bulk status changes, and inline progress sliders.
- **Undo / redo**, search, and full keyboard access to the canvas.

## Usage

Open the published page, or serve the directory locally (see below).

### Building a network

| Action | How |
| --- | --- |
| Add a task | **Add Task**, `n`, or double-click empty canvas |
| Edit a task | Double-click it, press `Enter`, or the pencil on its card |
| Draw a dependency | **Connect**, then select predecessor and successor |
| Change a relation or lag | Double-click the link, or edit it on the task |
| Delete a task or dependency | Select it and press `Delete` |
| Select several tasks | `Ctrl`-click, or `Ctrl+A` |
| Update progress | Drag the slider on the task card |
| Reorder milestones | The arrows in the milestone header |
| Follow a task's link | `Alt`-click (or `Cmd`-click) it |
| Show sub-paths on Main | **Display**, then a **Sub-paths on Main** option |
| Find a page among many | The **sub-paths** button in the page strip |
| Assign an owner | **Assigned to** on the task, then **Resources** |
| Resolve a double-booking | **Resources**, then **Apply** on a levelling option |
| Check the plan is sound | **Health** |
| Set a deadline | **Settings** for the project, or **Must finish by** on a task |
| Hold a task back | **Start no earlier than** on the task |
| Report progress as of a date | **Reported as of** in **Settings** |

### Keyboard shortcuts

| Key | Action |
| --- | --- |
| `/` | Focus the search box |
| `n` | Add a task |
| `c` | Toggle connection mode |
| `f` | Fit the diagram to the view |
| `←` `→` | Move between tasks |
| `Enter` | Edit the selected task |
| `1` `2` `3` `4` | Set the selected tasks to not started / in progress / blocked / done |
| `+` `−` | Zoom in and out |
| `Ctrl+A` | Select all tasks |
| `Delete` | Remove the selected tasks or dependency |
| `Ctrl+Z` | Undo |
| `Ctrl+Y` or `Ctrl+Shift+Z` | Redo |
| `Esc` | Close a dialog or menu, cancel connecting, clear search |
| `↑` `↓` on the divider | Resize the canvas and panel |

## Running locally

The application is built from ES modules, so it needs to be served over HTTP —
opening `index.html` directly from the filesystem will not work.

```sh
git clone https://github.com/ryan-war/CPD.git
cd CPD
npx serve            # or: python -m http.server 8080
```

Any static server works. There is nothing to install and nothing to build.

### Tests

The scheduling engine, calendar, layout, resource load, and simulation
primitives are covered by tests with no dependencies beyond Node itself:

```sh
node --test test/cpm.test.js
```

These include a baseline lock: the shipped default project must schedule to
exactly the figures it always has. A change there means the engine's behaviour
has changed.

## Project file format

**Save JSON** downloads the whole workspace — every page, its milestones, tasks,
positions, and settings — as a single file. **Load JSON** restores it.

Every saved file is stamped with a version: `schemaVersion` (the file format
this project conforms to), `appVersion` (the build that wrote it), and
`exportedAt` (when). The current version is shown in **Settings**. A file from
an older schema is migrated up on load; one from a newer schema than this build
knows about is loaded on a best-effort basis with a warning, since it may carry
fields this build does not understand.

Loaded files are validated and repaired on import: missing fields are filled in,
out-of-range estimates are clamped, duplicate task IDs are made unique, and
dependencies or links pointing at things that no longer exist are dropped. Files
written before precedence types existed — where `dependencies` was a plain array
of task IDs — are migrated automatically to finish-to-start with no lag.

**Export CSV** writes every task on every page with its computed schedule, for
use in a spreadsheet.

```jsonc
{
  "schemaVersion": 3,            // saved-project format version
  "appVersion": "1.2.0",        // build that wrote the file
  "exportedAt": "2026-07-23T12:00:00.000Z",
  "projectTitle": "Critical Path Network",
  "currency": "$",               // symbol shown against cost figures
  "activeView": "main",
  "layoutMode": "free",          // "free" | "cpm" | "milestone"
  "estimationMode": "average",   // "average" | "pert"
  "theme": "dark",               // "dark" | "light"
  "nodeShape": "circle",         // "circle" | "box"
  "nearCriticalDays": 1,         // slack at or below this is flagged at-risk
  "deadline": null,              // day offset the project must finish by
  "dataDate": null,              // day offset the project is reported as of
  "calendar": {
    "enabled": false,
    "startDate": "2026-04-13",
    "workdays": [1, 2, 3, 4, 5], // 0 = Sunday … 6 = Saturday
    "holidays": ["2026-12-25"]
  },
  "baseline": null,              // captured schedule, for drift comparison
  "nodeDisplay": {           // "rollup" shows a linked sub-path's share
    "id": true, "esEf": true, "slack": true, "rollup": false,
    "ghosts": "off"          // "off" | "selected" | "all" — sub-paths on Main
  },
  "pageOrder": ["main", "sub_1"],
  "pageTitles": { "main": "Main Diagram", "sub_1": "Sub-Path 1" },
  "diagrams": {
    "main": {
      "milestones": [
        {
          "id": "m1",
          "title": "Phase 1: Planning",
          "nodes": [
            {
              "id": "A",
              "title": "Requirements Gathering",
              "description": "Collect baseline constraints and scope.",
              "min": 2,                  // optimistic
              "likely": 3,               // most likely
              "max": 4,                  // pessimistic
              "progress": 100,
              "status": "done",          // not_started | in_progress | blocked | done
              "assignee": "Ada",         // "" for nobody
              "tags": ["QA", "client-facing"], // free-form labels, filterable
              "cost": 12000,             // budget (BAC) for earned value
              "actualCost": 8000,        // spent so far, or null if unrecorded
              "mustFinishBy": null,      // day offset this task is due by
              "startNoEarlierThan": null,// day offset it cannot start before
              "dependencies": [
                { "id": "Z", "type": "FS", "lag": 0 }  // FS | SS | FF | SF
              ],
              "position": { "x": 0, "y": 20 },
              "linkedSubPage": "sub_1",  // roll up this page's duration
              "linkedMainNode": null     // sub-path tasks point back to Main
            }
          ]
        }
      ]
    },
    "sub_1": { "milestones": [] }
  },
  "scenarios": [                 // saved what-if branches; each holds a whole
    {                            // snapshot of the plan under a name
      "id": "scn_ab12cd3",
      "name": "Compressed schedule",
      "capturedAt": "2026-07-23T12:00:00.000Z",
      "data": { "…": "a full project, minus its own scenarios" }
    }
  ]
}
```

Deadlines, start constraints, and the reporting date are stored as day offsets
from the project start, like every other figure in the file. With the calendar
switched on the interface shows and reads them as dates, converting through the
working-day calendar; the stored value does not change.

`dataDate` is null in every file written before it existed, and null means the
schedule ignores progress entirely — which is exactly how those files have
always behaved.

The workspace is also mirrored into `localStorage` under `cpd.workspace.v1` and
restored on the next visit, so a closed tab is not a lost project. That copy is
per-browser and per-device: export to JSON to keep, move, or share the work.

## Structure

```
index.html               markup and module entry point
css/app.css              theming, canvas chrome, panel, Gantt, widgets
js/main.js               boot, orchestration, event wiring
js/state.js              project shape, validation, accessors, undo/redo
js/cpm.js                scheduling engine — pure, no DOM
js/calendar.js           working-day calendar — pure, no DOM
js/layout.js             auto-layout and column geometry — pure, no DOM
js/schedule.js           per-render schedule cache, at-risk set, baseline drift,
                         sub-path roll-up figures
js/resources.js          assignee load, over-allocation, and levelling — pure,
                         no DOM
js/quality.js            schedule quality checks — pure, no DOM
js/storage.js            autosave to browser storage
js/sampling.js           distributions and summary statistics
js/simulate.js           Monte Carlo driver (worker, with inline fallback)
js/simulate.worker.js    the simulation loop itself
js/network.js            canvas rendering, interaction, minimap, image export
js/panel.js              milestone cards, Gantt, summary, legend
js/modals.js             dialogs
js/layout-ui.js          split pane and compact toolbar
js/links.js              cross-page task links
js/io.js                 JSON, CSV, and PNG export/import
js/dom.js                escaping, toasts, focus management
js/config.js             constants and theme palettes
test/cpm.test.js         engine, calendar, and migration tests
```

`js/cpm.js`, `js/calendar.js`, `js/layout.js`, `js/resources.js`, and
`js/quality.js` have no DOM
dependency and can be imported directly in Node:

```sh
node --input-type=module -e "
import {computeCPM} from './js/cpm.js';
console.log(computeCPM([
  {id:'A', min:2, likely:3, max:4, dependencies:[]},
  {id:'B', min:3, likely:4, max:5, dependencies:[{id:'A', type:'FS', lag:0}]}
]).projectDuration);
"
```

Tailwind, vis-network, and Lucide are vendored in `vendor/` at pinned versions
and served locally — no CDN, no third-party request, and the app runs offline.
If a bundle fails to load the page reports it rather than rendering blank. To
update one, replace the file in `vendor/` and its `<script>` tag in `index.html`.

## Licence

MIT — see [LICENSE](LICENSE).
