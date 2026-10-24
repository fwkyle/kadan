# Dashboard storage snapshots

## Why

Dashboard collection should not hold a SQLite reader open while waiting for tmux,
collecting process resources, calculating card/work state or rendering a response.
Long readers can delay WAL checkpoint progress even while writers can still append.

The production wall loader has two stages: `read` captures ledger, cards, works,
briefs, decisions and follow-up inputs in one read transaction; `build` runs after
that transaction and connection close. Rendering uses those captured inputs.
The HTTP cache and its prewarm use the same boundary. Cached detail/decision
responses still refresh the decision list as before, with its own short read.
Function loaders used by existing integrations keep their original transaction
boundary. `loadWallSnapshot()` also uses the two-stage loader for direct callers.

Validation and materializing records still happen during the read stage. Full
ledger arrays and card/work histories still occupy memory; a tenfold history can
increase that cost. This change removes OS waits and derived computation from the
read transaction, rather than claiming constant history memory.

## Diagnostics

`GET /api/dashboard/storage` uses the normal dashboard access and origin checks.
It reports the current process's outer read/write transactions, recent p95/last
duration, lifetime count/max/total, failed/busy counts and maximum BEGIN duration.
BEGIN duration includes command execution and any waiting; it is not a measurement
of pure lock waiting. Open/connection validation time is outside the duration.
Nested reads count once. Recent samples are capped at 128 per kind and eight homes
per process. These counters reset with process restart or home eviction.

`oldestReadMs` covers only an active transaction in this process. A synchronous
HTTP handler normally observes none; it cannot inspect other processes' readers.
`walBytes` is the file's logical size, not its uncheckpointed or reclaimable bytes.
`null` sizes mean stat failed, while zero means no such file. The endpoint does
not run a checkpoint, change SQLite settings or write events. There is no automatic
checkpoint, deletion or lower-durability mode added here; writers retain `FULL`.

The isolated regression test holds a real SQLite reader, appends with another
connection and verifies that a passive checkpoint cannot finish until the capture
ends. A checkpoint can finish during the subsequent OS collection stage. This
test runs only against an isolated test home, never the operating database.

References: [SQLite WAL](https://sqlite.org/wal.html),
[Node 24 SQLite](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html).
