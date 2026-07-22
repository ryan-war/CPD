# CPD — Critical Path Network

A browser-based Critical Path Method planner. Build a task network on a canvas,
and it computes the schedule as you go: earliest and latest start/finish, slack,
and the critical path. Adds PERT estimation, a Gantt timeline, Monte Carlo
schedule risk analysis, and nested sub-path diagrams.

No accounts, no server, no build step — static files and a browser. Projects are
saved and loaded as JSON files you keep yourself.

## Features

- **CPM engine** — forward and backward pass, slack, and critical path,
  recalculated on every edit.
- **Two estimation modes** — average `(Min + Max) / 2`, or PERT
  `(O + 4M + P) / 6`.
- **Milestones** — group tasks into phases, with a columns view that aligns the
  canvas and the task cards by milestone.
- **Sub-path pages** — link a task to its own diagram; the sub-path's project
  duration rolls up and replaces the parent task's estimate.
- **Mini-Gantt** — timeline bars positioned by ES/EF, shaded by progress, with
  the critical path highlighted.
- **Monte Carlo simulation** — samples each task from a triangular O/M/P
  distribution and reports mean, P50, P80, and P95 durations with a histogram.
- **Progress and status** — per-task status and percentage, drawn as a ring
  around each node.
- **Dependency tracing** — hover a task to highlight everything upstream and
  downstream of it.
- **Cycle protection** — circular dependencies are rejected as you draw them,
  and any present in a loaded file are reported by name.
- **Undo / redo**, search, PNG export, and JSON save/load.

## Usage

Open the published page, or serve the directory locally (see below).

### Building a network

| Action | How |
| --- | --- |
| Add a task | **Add Task**, or double-click empty canvas |
| Edit a task | Double-click it, or the pencil on its card |
| Draw a dependency | **Connect**, then select predecessor and successor |
| Delete a task or dependency | Select it and press `Delete` |
| Move a task | Drag it |
| Follow a task's link | `Alt`-click (or `Cmd`-click) it |

### Keyboard shortcuts

| Key | Action |
| --- | --- |
| `/` | Focus the search box |
| `c` | Toggle connection mode |
| `Delete` / `Backspace` | Remove the selected task or dependency |
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
python -m http.server 8080
```

Then open <http://localhost:8080>.

Any static server works equally well (`npx serve`, `php -S localhost:8080`, and
so on). There is nothing to install and nothing to build.

## Project file format

**Save JSON** downloads the whole workspace — every page, its milestones, tasks,
positions, and view settings — as a single file. **Load JSON** restores it.
Loaded files are validated and repaired on import: missing fields are filled in,
out-of-range estimates are clamped, duplicate task IDs are made unique, and
dependencies or links pointing at things that no longer exist are dropped.

```jsonc
{
  "projectTitle": "Critical Path Network",
  "activeView": "main",
  "layoutMode": "free",          // "free" | "cpm" | "milestone"
  "estimationMode": "average",   // "average" | "pert"
  "nodeDisplay": { "id": true, "esEf": true, "slack": true },
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
              "dependencies": [],        // IDs of predecessor tasks
              "position": { "x": 0, "y": 20 },
              "linkedSubPage": "sub_1",  // roll up this page's duration
              "linkedMainNode": null     // sub-path tasks point back to Main
            }
          ]
        }
      ]
    },
    "sub_1": { "milestones": [] }
  }
}
```

Note that state lives in memory only — reloading the page discards unsaved work.
Export to JSON before closing the tab.

## Structure

```
index.html          markup and module entry point
css/app.css         canvas, split pane, Gantt, and widget styles
js/main.js          boot, orchestration, event wiring
js/state.js         project shape, validation, accessors, undo/redo
js/cpm.js           scheduling engine — pure, no DOM
js/schedule.js      per-render schedule cache
js/simulate.js      triangular sampling and Monte Carlo
js/network.js       canvas rendering and interaction
js/panel.js         milestone cards, Gantt, summary
js/modals.js        dialogs
js/layout-ui.js     split pane and compact toolbar
js/links.js         cross-page task links
js/io.js            JSON and PNG export/import
js/dom.js           escaping, toasts, focus management
js/config.js        constants
```

`js/cpm.js` has no DOM dependency and can be imported directly in Node:

```sh
node --input-type=module -e "
import {computeCPM} from './js/cpm.js';
console.log(computeCPM([
  {id:'A', min:2, likely:3, max:4, dependencies:[]},
  {id:'B', min:3, likely:4, max:5, dependencies:['A']}
]).projectDuration);
"
```

Tailwind, vis-network, and Lucide load from a CDN at pinned versions; if either
library fails to load the page reports it rather than rendering blank.

## Licence

MIT — see [LICENSE](LICENSE).
