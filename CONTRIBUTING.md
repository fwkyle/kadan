# Contributing to kadan

Thanks for helping. A few rules keep this project small and safe.

## Ground rules

1. **Zero dependencies.** Node built-ins, tmux and standard OS commands only. New dependencies need a maintainer decision before code.
2. **The ledger is append-only.** Never add code that edits, deletes or reorders ledger events. Storage changes go through `src/storage.mjs`.
3. **No provider adapters.** Kadan does not special-case any AI CLI. If something needs a per-CLI branch, open an issue first.
4. **Fail closed.** Before sending, the session must exist and its pane PID must match. Unknown failures are reported, not retried.
5. **No completed DONE markers in prompts.** Prompts describe the format (`KADAN:DONE <card-id> <ok|failed>`); the agent assembles it. A literal marker in the prompt is read back as a false completion.
6. **`docs/daily/` is not part of this repository.** Do not commit files there or point code at that path.

This repository intentionally ships no `AGENTS.md` / `CLAUDE.md`. If you work with an AI coding agent, point it at this file and at `docs/design.md` (why the rules exist, ledger event format, glossary).

## Workflow

- Behaviour changes ship with tests in the same commit: `npm test`.
- Run `npm run setup:hooks` once per clone. The commit hook checks the exact staged contents; the push hook checks the outgoing tip and every commit not already on the destination, including files removed in later commits. Existing custom hook configurations are preserved.
- Run `npm run check:public` while editing. It checks tracked and non-ignored new files throughout the repository, including hidden configuration files. Keep private notes in the ignored local workspace.
- These checks detect known private paths and identifiers, not every possible secret. Review the staged diff before committing; CI runs after upload and cannot undo publication.
- Open a pull request for `main`. The required `ci` check passes only when both platform tests and the public-file check succeed.
- Stage files by name. `git add -A` / `git add .` are not used in this repo.
- Keep changes surgical. Do not reformat or rename unrelated code.
- Commit messages: short imperative summary; Korean or English.

## Layout

- `src/` — CLI (`cli.mjs`), floors (`floor-tmux.mjs`, `floor-rottie.mjs`), ledger/storage, watch, dashboards.
- `tests/` — `node --test`. Tests that need tmux skip when it is absent.
- `scripts/watch-judge.sh` — example judge command for `kadan watch`; requires `KADAN_JUDGE_MODEL`.
- `skills/` — agent skills that drive Kadan (conductor, supervisor, secretary).
- `docs/` — current rules; `docs/design.md` explains the locked rules and ledger format.
