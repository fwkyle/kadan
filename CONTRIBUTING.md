# Contributing to kadan

Thanks for helping. A few rules keep this project small and safe.

## Ground rules

1. **Zero runtime dependencies in the core.** The Node CLI/server, ledger, watch and floors use Node built-ins, tmux and standard OS commands only. The browser dashboard has a maintainer-approved React/TypeScript/Vite build under `gui/`; it ships compiled static assets. Other dependencies still need a maintainer decision before code.
2. **The ledger is append-only.** Never add code that edits, deletes or reorders ledger events. Storage changes go through `src/storage.mjs`.
3. **No provider adapters.** Kadan does not special-case any AI CLI. If something needs a per-CLI branch, open an issue first.
4. **Fail closed.** Before sending, the session must exist and its pane PID must match. Unknown failures are reported, not retried.
5. **No completed DONE markers in prompts.** Prompts describe the format (`KADAN:DONE <card-id> <ok|failed>`); the agent assembles it. A literal marker in the prompt is read back as a false completion.
6. **`docs/daily/` is not part of this repository.** Do not commit files there or point code at that path.

This repository intentionally ships no `AGENTS.md` / `CLAUDE.md`. If you work with an AI coding agent, point it at this file and at `docs/design.md` (why the rules exist, ledger event format, glossary).

## Workflow

- Behaviour changes ship with tests in the same commit: `npm test`.
- The test runner gives each file five minutes, then a bounded shutdown period. On timeout it reports
  the file and child PIDs carrying its unique inherited environment marker, then fails. Before each
  TERM/KILL it rechecks the marker, start time and command; it never signals an entire process group.
  Reparented detached children retain the marker. Children that clear their environment or cannot be
  identified are not signalled; fixtures must still clean up their own children. Process environment
  contents are inspected locally and never printed. A failed identity lookup cannot block runner exit.
  Fixtures must use `mkdtemp` under `os.tmpdir()` for writable homes and clean up spawned children in
  `finally` or a test cleanup hook; fixed shared `/tmp` homes are rejected by a regression check.
- `npm test` never calls a real model. Live checks of the senior (`kadan senior`, a costly model) use `npm run smoke:senior`, which runs at low effort by default (or `kadan senior … --effort low`); do not test at the configured effort. Details: [docs/senior.md](docs/senior.md#실측-시험).
- Run `npm run setup:hooks` once per clone. The commit hook checks the exact staged contents; the push hook checks the entire outgoing tip and every changed file version in commits not already on the destination, including files removed in later commits. Existing custom hook configurations are preserved.
- Run `npm run check:public` while editing. It checks tracked and non-ignored new files throughout the repository, including hidden configuration files. Keep private notes in the ignored local workspace.
- These checks detect known private paths and identifiers, not every possible secret. Review the staged diff before committing; CI runs after upload and cannot undo publication.
- Open a pull request for `main`. The required `ci` check passes only when both platform tests and the public-file check succeed.
- 설치·처음 시작·자주 쓰는 명령·핵심 개념이 바뀌는 PR은 같은 PR에서 README의 해당 절을 확인하고, 바꿀 것이 없으면 PR 본문에 'README 영향 없음' 한 줄을 적는다. (If a PR changes install, first run, common commands or core concepts, check the matching README section in the same PR; if nothing needs changing, write "README 영향 없음" in the PR description.)
- Stage files by name. `git add -A` / `git add .` are not used in this repo.
- Keep changes surgical. Do not reformat or rename unrelated code.
- Commit messages: short imperative summary; Korean or English.

## Layout

- `src/` — CLI (`cli.mjs`), floors (`floor-tmux.mjs`, `floor-herdr.mjs`), ledger/storage, watch, dashboards.
- `tests/` — run with `npm test` (`tests/run.mjs` sets an isolated tmux socket, no window, notifications off, then runs `node --test`). Do not run `node --test` bare. Tests that need tmux skip when it is absent.
- `scripts/watch-judge.sh` — example judge command for `kadan watch`; requires `KADAN_JUDGE_MODEL`.
- `skills/` — agent skills that drive Kadan (conductor, supervisor, secretary).
- `docs/` — current rules; `docs/design.md` explains the locked rules and ledger format.
