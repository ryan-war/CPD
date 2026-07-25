# Contributing to CPD

Thanks for looking under the hood. CPD is deliberately dependency-free: static
files, vendored libraries, and Node's built-in test runner. There is nothing to
install and nothing to build.

## Running it

```sh
npm start            # serves the directory (npx serve) — or: python -m http.server 8080
npm test             # runs the whole suite on Node's test runner
```

The app is built from ES modules, so it must be served over HTTP — opening
`index.html` from the filesystem will not work.

## Layout in one breath

- **Pure engine, no DOM** — `js/cpm.js`, `js/calendar.js`, `js/layout.js`,
  `js/resources.js`, `js/quality.js`, `js/evm.js`, `js/critical-chain.js`,
  `js/sampling.js`. These take data and return data; they are directly
  importable in Node and are where the tests live.
- **State** — `js/state.js` owns the project shape, validation/migration, and
  undo/redo.
- **Rendering** — `js/network.js` (canvas), `js/panel.js` (cards, Gantt, the
  analysis panels), `js/modals.js` (dialogs), `js/main.js` (boot + wiring).

Keep the pure files pure: if a change to one of them reaches for `document` or a
global, it belongs in a rendering module instead.

## Tests are the contract

- Run `npm test` before opening a PR. CI runs the same command on every push and
  PR, and **master will not deploy unless it is green**.
- `test/cpm.test.js` includes a **baseline lock**: the shipped default project
  must schedule to exactly the figures it always has. If that test changes, the
  engine's behaviour changed — make sure that was intended, and update the
  baseline deliberately in the same commit.
- New behaviour in a pure module should come with a test. The runner needs no
  setup: `import { test } from 'node:test'` and `import assert from 'node:assert'`.

## Style

Match the surrounding code: small pure functions, comments that explain *why*
rather than *what*, and no new runtime dependencies without discussion.
