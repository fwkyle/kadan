import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createDatabase,writeStorageMarker} from '../src/storage.mjs';
import {appendLedger} from '../src/ledger.mjs';
import {doneHintFor,findDoneMarkers} from '../src/cli.mjs';

test('완료 표시 안내: 열린 카드가 있을 때만, 완성된 마커 없이 형식과 카드 id를 따로 알린다', () => {
  assert.equal(doneHintFor([]), null);
  assert.equal(doneHintFor(undefined), null);
  const hint = doneHintFor(['card-a', 'card-b']);
  assert.match(hint, /KADAN:DONE <카드id> <ok\|failed>/);
  assert.match(hint, /열린 카드 id: card-a, card-b/);
  // 보낸 쪽 화면에 찍혀도 완료로 읽히면 안 된다(잠긴 규칙 6).
  assert.equal(findDoneMarkers(hint).length, 0);
  assert.doesNotMatch(hint, /KADAN:DONE\s+\S+\s+(?:ok|failed)(?=\s|$)/u);
});

test('격리 실제 tmux: 열린 카드가 있는 작업자의 send 출력에만 완료 표시 안내가 붙고, 지침은 받는 쪽 것으로 표시한다', {skip:spawnSync('tmux',['-V']).status!==0}, () => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-done-hint-'));
  createDatabase(home);writeStorageMarker(home,'sqlite');
  const cli=new URL('../src/cli.mjs',import.meta.url).pathname;
  const env={...process.env,KADAN_HOME:home,KADAN_SOCKET:path.basename(home),KADAN_FLOOR:'tmux',KADAN_WINDOW:'none'};
  const run=(args,role)=>{const r=spawnSync(process.execPath,[cli,...args],{env:{...env,KADAN_ROLE:role},cwd:home,encoding:'utf8',timeout:10000});assert.equal(r.status,0,r.stderr+r.stdout);return r.stdout;};
  const roles=['dh-감독','dh-작업자'];
  try {
    for (const role of roles) run(['start',role,'--cmd','stty -echo; exec cat'],'사람');
    // 감독이 작업자에게 card-a를 발령한 상태(발령 우편 원장 기록)를 만든다.
    appendLedger({kind:'send',role:'dh-작업자',session:'kadan-dh-작업자',by:'dh-감독',taskId:'card-a',mailId:'mail-a',dispatchId:'mail-a'},home);

    const report=run(['send','dh-감독','완료 통지: card-a ok'],'dh-작업자');
    assert.match(report,/받는 쪽에 붙인 역할 지침/);
    assert.match(report,/열린 카드 id: card-a/);
    assert.equal(findDoneMarkers(report).length,0);

    const other=run(['send','dh-작업자','다음 확인 부탁'],'dh-감독');
    assert.doesNotMatch(other,/완료 표시/);

    const human=run(['send','dh-감독','사람이 보낸 편지'],'');
    assert.doesNotMatch(human,/완료 표시/);

    run(['done','dh-작업자','card-a','ok'],'dh-감독');
    const after=run(['send','dh-감독','추가 보고'],'dh-작업자');
    assert.doesNotMatch(after,/완료 표시/);
  } finally {
    for (const role of roles) spawnSync(process.execPath,[cli,'stop',role],{env,cwd:home,encoding:'utf8'});
  }
});
