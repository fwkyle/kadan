import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {CardStore} from '../src/card-store.mjs';import {buildCardCenter} from '../src/card-center.mjs';import {finished} from '../src/human-brief.mjs';import {boardProgressCounts} from '../src/board-progress.mjs';
test('replacement validates target and cycle; preserves history; closed despite old run',()=>{const h=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-replaced-')),s=new CardStore(h);for(const id of ['old','new'])s.create({repo:'r',id,repoPath:h,body:'# '+id});assert.throws(()=>s.update('r/old',{status:'superseded'},{revision:1,note:'방향변경'}),/후속/);assert.throws(()=>s.update('r/old',{status:'superseded',replacedBy:'r/absent'},{revision:1,note:'방향변경'}));const c=s.update('r/old',{status:'superseded',replacedBy:'r/new'},{revision:1,note:'복제로 대체'});assert.equal(c.history[0].status,'draft');assert.throws(()=>s.update('r/new',{status:'superseded',replacedBy:'r/old'},{revision:1,note:'순환'}),/순환/);const center=buildCardCenter({cards:s.list(),entries:[{kind:'send',role:'p-worker',taskId:'old',t:'2020-01-01'}],tree:[]});const old=center.cards.find(c=>c.id==='old');assert.equal(old.displayState,'superseded');assert.equal(finished(old),true);const counts=boardProgressCounts({cards:[old]});assert.equal(counts.counts.done,0);assert.equal(counts.counts.closed,1);});

// 대체 넓히기(2026-10-05 [kyle]): 여러 카드·PR이 함께 끝낸 옛 카드는 후속 카드 대신 업무 키·설명으로 대체한다.
test('대체는 후속 카드 또는 이어받은 업무·설명 중 하나가 있으면 되고, 대체를 벗어나면 둘 다 지운다',async()=>{
 const {cardCommand}=await import('../src/card-command.mjs');
 const {storedStatusText}=await import('../src/status-labels.mjs');
 const {cardForms}=await import('../src/dashboard-forms.mjs');
 const h=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-replaced-text-')),s=new CardStore(h);
 for(const id of ['a','b'])s.create({repo:'r',id,repoPath:h,body:'# '+id});
 assert.throws(()=>s.update('r/a',{status:'superseded'},{revision:1,note:'근거 없음'}),/후속 카드.*이어받은 업무/);
 assert.throws(()=>s.update('r/a',{status:'superseded',replacedByText:'   '},{revision:1,note:'빈 설명'}),/이어받은 업무/);
 assert.throws(()=>s.update('r/a',{status:'superseded',replacedByText:'x'.repeat(301)},{revision:1,note:'너무 김'}),/300자/);
 assert.throws(()=>s.update('r/a',{replacedByText:'업무'},{revision:1,note:'대체 아님'}),/대체 상태에서만/);
 const text='9월 개편(9/29 운영 반영)으로 끝남';
 const done=cardCommand(['update','r/a'],{revision:'1',status:'superseded','replaced-by-text':'  '+text+' ',note:'업무 전체가 이어받음'},{home:h,by:'사람'});
 assert.equal(done.status,'superseded');assert.equal(done.replacedByText,text);assert.equal(done.replacedBy??null,null);
 assert.equal(storedStatusText(done),'대체 · '+text);
 assert.ok(cardForms(done).some(form=>form.fields?.some(f=>f.name==='replacedByText'&&f.value===text)));
 // 카드 하나로 대체하던 기존 경로와 설명을 함께 적을 수도 있다.
 const both=s.update('r/b',{status:'superseded',replacedBy:'r/a',replacedByText:'후속 정리'},{revision:1,note:'둘 다'});
 assert.equal(both.replacedBy,'r/a');assert.equal(storedStatusText(both),'대체 · 후속 정리');
 assert.equal(storedStatusText({status:'superseded',replacedBy:'r/a'}),'대체 · r/a');
 // 대체를 벗어나면 후속 연결과 설명을 모두 지운다.
 const reopened=s.update('r/a',{status:'draft'},{revision:2,note:'다시 연다'});
 assert.equal(reopened.replacedByText,null);assert.equal(reopened.replacedBy??null,null);
 assert.equal(storedStatusText(reopened),'초안');
});
