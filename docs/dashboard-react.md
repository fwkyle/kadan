# React dashboard

## Why

카단 사용자가 작업을 읽고 편집하는 동안 최신 상태와 작성 내용이 어긋나지 않도록, 화면과 데이터 갱신을 분리한다.

## Architecture

- `gui/`: React, TypeScript and Vite. Built browser assets are served by the existing Node HTTP server; no second production server is needed.
- `src/dashboard-api.mjs`: bounded JSON reads using the existing card, work, mail, decision and runner models.
- Existing form actions remain authoritative for writes, including revisions, CSRF tokens, origin validation and append-only storage. JSON responses avoid redirecting the browser after a save.
- A shared client resource owns request cancellation, deadlines, deduplication, visibility suspension and freshness. Each screen subscribes to its own resource.
- The CLI, storage, watch and floor retain zero package dependencies. The maintainer-approved exception is the browser build under `gui/`.

The structure follows OpenCodex's separation of a built GUI, JSON management endpoints and shared client resources. Its provider-specific code and application-wide abstractions are not copied.

The visual reference is the Kadan dashboard before the React migration: top navigation, the operations menu, footer freshness, compact workspace rows, status sections and inline decision replies. `gui/styles.mjs` reuses its shared CSS at build time; `src/theme.mjs` supplies the same automatic/light/dark palette and the browser keeps the existing `kadan-theme` preference. Architecture changes do not authorize a redesign. Check the rendered reference alongside the React screen when changing presentation; `?legacy=1` is an older ledger view, not this visual reference.

## Completion checks

- The default dashboard is the built React application. It does not fetch or parse full dashboard HTML to refresh.
- Status, workspace, card/work detail and edits, decisions, mailbox, event/run records, sessions, runner settings, creation and operations flow remain accessible.
- Existing URLs, collection filters, layouts, sort order and browser navigation work. Decisions initially show oldest requests first.
- Detail refresh follows both card changes and execution changes; dirty drafts survive reads and failed saves.
- Each screen shows its own freshness and error state. An unanswered request cannot permanently block polling.
- Long tables have a bounded DOM; documents/mail bodies are loaded only when needed.
- Tests exercise real API contracts, request races/timeouts, mutations and representative browser flows, including mobile navigation.
- The Node suite, GUI typecheck/build/tests and public-file check pass. Source and package distribution both include a usable dashboard.

## Development

Run `npm --prefix gui ci`, then `npm run build:gui`. `kadan dashboard` serves the built application. `npm run dev:gui` runs Vite with a loopback proxy to the dashboard server for development. The explicit `?legacy=1` view remains a read-only reference during migration.

`npm pack` runs the GUI build and includes `gui/dist` in the package. A package consumer needs no React or Vite installation; maintainers building from source install GUI dependencies first. The core package has no npm runtime dependencies.

For manual QA, `node tests/helpers/dashboard-fixture.mjs` prints an isolated loopback URL and a temporary state directory. Its synthetic notifications stay in memory. Stop only that process after use; it does not touch live sessions or the normal ledger. The fixture intentionally reports resource metrics as uncollected.

The workspace table uses server pagination (50 rows) instead of adding a virtualization dependency. Columns support hiding, ordering, pointer/keyboard resizing and local preferences. Relationship maps load compact rows and expand long groups on demand. JSON endpoints retain the core's distinction between missing state and an empty list.
