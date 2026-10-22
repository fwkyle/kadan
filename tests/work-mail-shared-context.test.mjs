import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {taskIdentity} from '../src/task-identity.mjs';
import {mailboxLetters} from '../src/mailbox-state.mjs';
import {workLetters} from '../src/work-mail.mjs';

// 업무마다 전체 우편 투영을 다시 만들던 옛 계산. 공유 계산이 같은 결과를 내는지 비교하는 기준이다.
function referenceLetters(work,entries,cards){
 const sends=entries.filter(x=>x.kind==='send'),executionKeys=new Set(work.executions.map(x=>x.key));
 const identity=taskIdentity(cards);
 const selected=new Set(sends.filter(x=>x.workKey===work.key||(!x.workKey&&executionKeys.has(identity.resolve(x.taskId,x.executionKey).key))||work.mailRefs.some(ref=>x.mailId===ref||x.digest===ref)));
 const byRef=new Map();for(const x of sends)for(const ref of [x.mailId,x.digest].filter(Boolean)){if(!byRef.has(ref))byRef.set(ref,[]);byRef.get(ref).push(x);}
 const children=new Map();for(const x of sends){const parents=byRef.get(x.replyTo);if(parents?.length!==1||x.workKey&&x.workKey!==work.key)continue;const parent=parents[0];if(!children.has(parent))children.set(parent,[]);children.get(parent).push(x);}
 const queue=[...selected];for(let i=0;i<queue.length;i++)for(const child of children.get(queue[i])||[]){if(!selected.has(child)){selected.add(child);queue.push(child);}}
 const projected=mailboxLetters(entries),byEntry=new Map(sends.map((entry,index)=>[entry,projected[index]]));
 return [...selected].map(x=>byEntry.get(x)).reverse();
}
const t=n=>new Date(Date.UTC(2026,0,1,0,n)).toISOString();
const cards=[{id:'a',key:'r/a'},{id:'b',key:'r/b'},{id:'c',key:'r/c'}];
const work=(key,executions,mailRefs=[])=>({key,executions:executions.map(k=>({key:k})),mailRefs});
const mail=(mailId,extra={})=>({kind:'send',role:'worker',by:'lead',session:'kadan-worker',mailId,digest:`d-${mailId}`,t:t(1),...extra});
const entries=[
 mail('m1',{workKey:'r/w1',executionKey:'r/a',taskId:'a'}),
 mail('m2',{taskId:'b'}),                                  // 업무 표시 없음: 실행 주소로 w2에 붙는다
 mail('m3',{replyTo:'m1',currentRecipient:'lead'}),         // 답장: 부모를 따라 w1에 붙는다
 mail('m4',{workKey:'r/w2',replyTo:'m1'}),                 // 다른 업무가 달아 둔 답장은 w1이 따르지 않는다
 mail('m5',{taskId:'c'}),                                  // 어느 업무에도 없다
 mail('m6',{workKey:'r/w2',executionKey:'r/b',taskId:'b'}),
 {kind:'mail-read',mailId:'m1',role:'lead',by:'lead',t:t(3)},
];
const works=[work('r/w1',['r/a']),work('r/w2',['r/b'],['m5'])];

test('업무별 우편 목록이 업무마다 전체를 다시 계산하던 결과와 같다', () => {
 for(const w of works)assert.deepEqual(workLetters(w,entries,cards),referenceLetters(w,entries,cards));
 assert.deepEqual(workLetters(works[0],entries,cards).map(x=>x.mailId).sort(),['m1','m3']);
 assert.deepEqual(workLetters(works[1],entries,cards).map(x=>x.mailId).sort(),['m2','m4','m5','m6']);
});

test('한 업무에서 받은 우편을 고쳐도 다른 호출에 번지지 않는다', () => {
 const first=workLetters(works[0],entries,cards);
 first[0].read='changed';first[0].replyRecipients.push('x');
 const again=workLetters(works[0],entries,cards);
 assert.notEqual(again[0].read,'changed');
 assert.ok(!again[0].replyRecipients.includes('x'));
});

test('같은 배열에 사건이 덧붙으면 이어 붙인 결과가 처음부터 다시 계산한 것과 같다', () => {
 const grown=[...entries];
 workLetters(works[0],grown,cards);
 grown.push(mail('m7',{workKey:'r/w1',replyTo:'m3'}));
 assert.deepEqual(workLetters(works[0],grown,cards),referenceLetters(works[0],grown,cards));
 assert.ok(workLetters(works[0],grown,cards).some(x=>x.mailId==='m7'));
});

test('카드 목록이 바뀌면 실행 주소 해석도 다시 한다', () => {
 const bare=[mail('n1',{taskId:'z'})],w=work('r/wz',['r/z']);
 assert.equal(workLetters(w,bare,[{id:'a',key:'r/a'}]).length,0);
 assert.equal(workLetters(w,bare,[{id:'z',key:'r/z'}]).length,1);
});
