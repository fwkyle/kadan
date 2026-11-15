// The caller supplies a test-only home and one small event, in a separate process.
delete process.env.TMUX;
delete process.env.TMUX_PANE;
const [home, event] = process.argv.slice(2);
process.env.KADAN_HOME = home;
const {appendLedger} = await import('../../src/ledger.mjs');
appendLedger(JSON.parse(event), home);
