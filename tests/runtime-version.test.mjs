import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {captureRuntimeVersion} from '../src/runtime-version.mjs';
import {buildCycleEntry,cycleStatus,watchVerdict} from '../src/watch-cycle.mjs';
import {renderCenterWall} from '../src/center-wall.mjs';

test('실행 버전은 시작 시 고정되고 이후 변경·커밋을 소급 반영하지 않는다',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-runtime-'));
 const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 git('init');fs.mkdirSync(path.join(root,'src'));fs.writeFileSync(path.join(root,'src','main.mjs'),'// first\n');
 git('add','src/main.mjs');git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','first');
 const first=captureRuntimeVersion(root);assert.equal(first.commit,git('rev-parse','HEAD'));assert.equal(first.dirty,false);
 fs.writeFileSync(path.join(root,'src','main.mjs'),'// second\n');
 assert.equal(captureRuntimeVersion(root).dirty,true);assert.equal(first.dirty,false);
 git('add','src/main.mjs');git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','second');
 assert.notEqual(captureRuntimeVersion(root).commit,first.commit);
 const packageDir=path.join(root,'package');fs.mkdirSync(packageDir);
 assert.equal(captureRuntimeVersion(packageDir).commit,null);
});

test('대시보드·감시 주기는 기록된 실행 버전을 표시하고 옛 기록은 모름으로 남긴다',()=>{
 const runtime={commit:'a'.repeat(40),dirty:true,startedAt:new Date().toISOString()};
 const html=renderCenterWall({collectedAt:new Date(),center:null,runtime});
 assert.match(html,/실행 코드 a{40} · 시작 시 미커밋 변경 있음/);
 const cycle=buildCycleEntry({pid:42,runtime,hierarchyPath:'/test/hierarchy.json',judge:true});
 const t=new Date().toISOString(),worker={pid:42,startedAt:runtime.startedAt};
 const status=cycleStatus([{...cycle,t}],worker,Date.now());
 assert.deepEqual(status.settings.runtime,runtime);
 const verdict=watchVerdict({process:{state:'running'},configuration:{state:'matched'},cycle:status});
 assert.match(verdict.text,/감시기 코드 a{7}(?!a)/);
 const old=cycleStatus([{...buildCycleEntry({pid:42}),t}],worker,Date.now());
 assert.equal(old.settings.runtime,undefined);
 assert.match(watchVerdict({process:{state:'running'},configuration:{state:'unknown'},cycle:old}).text,/감시기 코드 모름/);
});
