import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

delete process.env.TMUX;
delete process.env.TMUX_PANE;
const [root, scenario, mode = 'current'] = process.argv.slice(2);
const calls = [];
let found = false;
globalThis.__pruneCount = () => calls.push('full');
registerHooks({load(url, context, next) {
  const loaded = next(url, context);
  if (!url.startsWith(pathToFileURL(path.join(root, 'src') + '/').href)) return loaded;
  let source = String(loaded.source);
  if (url.endsWith('/ledger-domains.mjs')) {
    const entry = /export function readLedgerState\(home,\{domain=null[^)]*\}=\{\}\) \{/;
    if (!entry.test(source)) throw new Error('readLedgerState counter entry not found');
    source = source.replace(entry, text => `${text} globalThis.__pruneCount();`);
    found = true;
  }
  if (url.endsWith('/hierarchy-prune.mjs')) {
    const before = 'const current = inspect(currentRead());';
    if (!source.includes(before)) throw new Error('locked snapshot entry not found');
    source = source.replace(before, `globalThis.__beforePruneRead?.(home);\n    ${before}`);
  }
  if (url.endsWith('/watch-runner.mjs')) {
    source = 'export async function runWatch(options) { globalThis.__pruneWatchOptions = options; }';
  }
  return {...loaded, source};
}});
const src = name => import(pathToFileURL(path.join(root, 'src', name)).href);
const {appendStream, storageVersion} = await src('storage.mjs');
const {createWatchStoreReaders} = await src('watch-store-cache.mjs');
const {createWatchMailReader} = await src('watch-mail-reader.mjs');
const {cycleReads} = await src('watch-reads.mjs');
const {pruneHierarchy, hierarchyCommand} = await src('hierarchy-prune.mjs');
const {runDailyHierarchyPrune} = await src('watch-prune.mjs');
const {createWatchPruner, cmdWatch} = await src('commands/watch.mjs');
const {floor} = await src('floor.mjs');
const {createWatchReplayMetrics} = await src('watch-replay-metrics.mjs');
const now = Date.parse('2026-11-15T12:00:00Z');
const at = days => new Date(now - days * 86400000).toISOString();
const canonical = result => {
  return {...result, file:'fixture', backup:result.backup ? 'backup' : null};
};

async function execute(current) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-reads-'));
  process.env.KADAN_HOME = home;
  process.env.KADAN_NOTIFY = 'off';process.env.KADAN_WINDOW = 'none';
  const file = path.join(home, 'parents.json');
  const table = {'fixture-top':'@user', 'fixture-leaf':'fixture-top', 'fixture-heir':'fixture-top'};
  fs.writeFileSync(file, JSON.stringify(table));
  const events = [{kind:'hierarchy-loaded', path:file, t:at(4)}];
  for (const role of Object.keys(table)) events.push(
    {kind:'start', role, panePid:10, t:at(4)}, {kind:'stop', role, t:at(3)});
  events.push({kind:'watch-cycle', by:'watch', t:at(2), timing:{unused:'large'}});
  events.push({kind:'watch-scope', by:'watch', t:at(2), scope:{unused:true}});
  if (scenario === 'recent') events.push({kind:'start', role:'fixture-leaf', panePid:11, t:at(0.5)},
    {kind:'stop', role:'fixture-leaf', t:at(0.25)});
  if (scenario === 'pending') events.push({kind:'send', role:'fixture-leaf', taskId:'fixture/task',
    roleInstructions:{unused:true}, t:at(4)});
  if (scenario === 'broken') events.push({kind:'bad', broken:true, t:at(1)});
  for (const event of events) appendStream(home, 'ledger.jsonl', event);
  if (['open-card', 'pending', 'reopened-card'].includes(scenario)) {
    const card = {key:'fixture/task', id:'task', role:'fixture-leaf', status:'assigned',
      revision:1, at:at(4), title:'fixture', repoPath:root};
    appendStream(home, 'cards/fixture/task/events.jsonl', card);
    if (scenario === 'reopened-card') {
      appendStream(home, 'cards/fixture/task/events.jsonl', {...card, status:'done', revision:2, at:at(3)});
      appendStream(home, 'cards/fixture/task/events.jsonl', {...card, revision:3, at:at(1)});
    }
  }
  const workCases = ['work-handover', 'work-before', 'reassigned', 'reopened', 'fresh-handover'];
  if (workCases.includes(scenario)) {
    const work = {key:'fixture/work', owner:'fixture-leaf', turnOwner:'', status:'open',
      executions:[], mailRefs:[], revision:1, action:'create', at:at(scenario === 'work-before' ? 1 : 4)};
    appendStream(home, 'works/fixture/work/events.jsonl', work);
    appendStream(home, 'works/fixture/work/events.jsonl', {...work, revision:2, at:at(0.5),
      action:scenario === 'reopened' ? 'reopen' : 'update',
      ...(scenario === 'reassigned' ? {ownerAssignedAt:at(1)} : {})});
    if (scenario !== 'fresh-handover') appendStream(home, 'ledger.jsonl', {
      kind:'handover', phase:'transferred', from:'fixture-leaf', to:'fixture-heir', taskIds:[], t:at(2),
    });
  }
  const live = scenario === 'alive' ? [{session:'kadan-fixture-leaf', pid:10}] : [];
  floor.list = () => live;
  const stores = createWatchStoreReaders(home);
  const reader = createWatchMailReader(home, null, {readCards:stores.cards.read, readWorks:stores.works.read});
  const reads = cycleReads({readEntries:reader.readEntries, readCards:stores.cards.read,
    readWorks:stores.works.read, version:() => storageVersion(home)});
  let warmError;
  let stale;
  try { stale = {entries:reads.readEntries(), cards:reads.readCards(), works:reads.readWorks()}; }
  catch (error) { warmError = error; }
  const supplied = mode === 'stale' ? {readEntries:() => stale.entries,
    readCards:() => stale.cards, readWorks:() => stale.works} : mode === 'latest-only'
      ? {...reads, readWorks:() => reads.readWorks().map(({history, ...work}) => work)} : reads;
  const metrics = createWatchReplayMetrics();
  const records = [];
  let appended = false;
  globalThis.__beforePruneRead = destination => {
    if (!scenario.startsWith('fresh-') || appended || destination !== home) return;
    appended = true;
    const event = scenario === 'fresh-start'
      ? {kind:'start', role:'fixture-leaf', panePid:99, t:new Date(now).toISOString()}
      : {kind:'handover', phase:'transferred', from:'fixture-leaf', to:'fixture-heir',
        taskIds:[], t:new Date(now).toISOString()};
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./prune-append.mjs', import.meta.url)),
      home, JSON.stringify(event)], {encoding:'utf8', env:process.env});
    assert.equal(child.status, 0, child.stderr);
  };
  calls.length = 0;
  let result, detail;
  const legacy = options => pruneHierarchy({...options, home, floor, file, apply:true, now:() => now});
  if (['preview', 'no-file', 'cli'].includes(scenario)) {
    result = hierarchyCommand(['prune'], scenario === 'preview' ? {file} :
      scenario === 'no-file' ? {apply:true} : {apply:true, file}, {home, floor});
  } else {
    const prune = current ? createWatchPruner(supplied, {home, selectedFloor:floor}) : legacy;
    if (current && scenario === 'missing-lists') {
      supplied.readEntries = () => { throw new Error('fixture unavailable'); };
    }
    result = runDailyHierarchyPrune({entries:[], now, file, prune:args => {
      const value = prune(args);detail = value;return value;
    }, record:row => records.push(row), metrics});
  }
  if (!found) throw new Error('Full-read counter did not find its entry');
  const record = records[0];
  const backup = record?.backup ?? result?.backup;
  const output = {reads:calls.length, result:canonical(result), records:records.map(canonical),
    plan:detail ? canonical(detail) : null,
    backup:backup ? {content:fs.readFileSync(backup, 'utf8'), mode:fs.statSync(backup).mode & 0o777} : null,
    table:JSON.parse(fs.readFileSync(file, 'utf8')), pruneMetric:metrics.snapshot().replay.prune,
    warmError:!!warmError};
  // runDaily returns the same event shape; full plan comparison lives in the pure fixture tests.
  return output;
}

if (scenario === 'connection') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-wire-'));
  process.env.KADAN_HOME = home;process.env.KADAN_WINDOW = 'none';
  const file = path.join(home, 'parents.json');fs.writeFileSync(file, '{}');
  floor.list = () => [];
  const print = console.log;console.log = () => {};
  await cmdWatch([], {hierarchy:file});console.log = print;
  assert.equal(typeof globalThis.__pruneWatchOptions.pruneHierarchy, 'function');
  const result = globalThis.__pruneWatchOptions.pruneHierarchy({file, now});
  assert.equal(result.removeCount, 0);assert.equal(calls.length, 0);assert.ok(found);
  console.log(JSON.stringify({connected:true, reads:calls.length}));
} else {
  const legacy = await execute(false);
  const current = await execute(true);
  if (scenario === 'missing-lists') {
    assert.match(current.records[0].error, /unavailable/);
    assert.equal(current.result.applied, false);
    assert.equal(current.reads, 0);
  } else if (scenario === 'broken') {
    for (const value of [legacy, current]) {
      assert.equal(value.records[0].applied, false);
      assert.ok(value.records[0].error);
      assert.equal(value.backup, null);
      assert.equal(Object.keys(value.table).length, 3);
    }
    assert.ok(legacy.reads >= 1);
    assert.equal(current.reads, 0);
  } else {
    const withoutCosts = ({reads, pruneMetric, ...rest}) => rest;
    assert.deepEqual(withoutCosts(current), withoutCosts(legacy), `fresh/equivalent plan: ${scenario}`);
    const manual = ['preview', 'no-file', 'cli'].includes(scenario);
    assert.equal(legacy.reads, scenario === 'preview' ? 1 : 2);
    assert.equal(current.reads, manual ? legacy.reads : 0);
  }
  console.log(JSON.stringify({scenario, legacyReads:legacy.reads, currentReads:current.reads,
    table:current.table, metric:current.pruneMetric, records:current.records,
    matched:scenario !== 'missing-lists'}));
}
