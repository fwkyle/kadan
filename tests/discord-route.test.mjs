import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {appendLedger} from '../src/ledger.mjs';
import {CardStore} from '../src/card-store.mjs';
import {WorkStore} from '../src/work-store.mjs';
import {setThread, setDecision} from '../src/notify-threads.mjs';
import {Mailbox} from '../src/mailbox.mjs';
import {resolveMailTarget} from '../src/discord-route.mjs';
import {createMailOut} from '../src/discord-mail.mjs';

// 가짜 역할·레포만 쓴다(운영 이름 금지). 레포 이름(zeta_app)과 판 이름(zeta)은 일부러 다르다.
const SUPER = 'zeta-슈퍼감독', LEAD = 'zeta-감독', WORKER = 'zeta-작업자';
const live = (...roles) => () => new Set(roles.map(r => `kadan-${r}`));

function world() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-droute-'));
  const table = path.join(home, 'hierarchy.json');
  fs.writeFileSync(table, JSON.stringify({[SUPER]: '@user', [LEAD]: SUPER, [WORKER]: LEAD}));
  appendLedger({kind: 'hierarchy-loaded', path: table}, home);
  for (const [role, roleProfile] of [[SUPER, 'super'], [LEAD, 'conductor'], [WORKER, 'worker']]) {
    appendLedger({kind: 'start', role, session: `kadan-${role}`, panePid: 1, roleProfile}, home);
  }
  const cards = new CardStore(home);
  cards.create({repo: 'zeta_app', id: 'card-1', repoPath: home, body: '# 시험'});
  cards.update('zeta_app/card-1', {role: WORKER}, {revision: 1, note: '담당 지정'});
  new WorkStore(home).create({key: 'zeta_app/work-1', title: '시험 업무', goal: 'g', scope: 's', acceptance: 'a', owner: LEAD, repoPath: home});
  setThread(home, 'zeta_app/work-1', {threadId: 'T-WORK', statusMessageId: null});
  setThread(home, 'zeta_app/__decisions__', {threadId: 'T-DEC', statusMessageId: null});
  return home;
}
const forumLine = (id, threadId, channel = 'zeta_app') => ({id, where: 'thread', threadId, channel, threadName: '시험 글', content: '질문입니다', at: '2026-10-16T00:00:00Z'});
const bodyOf = (home, role, mail) => new Mailbox(home, role).read(mail.mailId).body;

test('1 업무 스레드의 kyle 글 → 그 업무 owner의 최상위 슈퍼 우편 1통(머리에 레포·스레드·업무 키·받는이)', () => {
  const home = world();
  const route = resolveMailTarget(forumLine('11', 'T-WORK'), {home, liveSessions: live(SUPER)});
  assert.deepEqual([route.to, route.reason, route.workKey], [SUPER, null, 'zeta_app/work-1']);
  const line = forumLine('11', 'T-WORK');
  createMailOut({home, resolve: (l, o) => resolveMailTarget(l, {...o, liveSessions: live(SUPER)})})(line);
  assert.equal(new Mailbox(home, '비서').list({all: true}).length, 0, '비서 우편 0통');
  const mails = new Mailbox(home, SUPER).list({all: true});
  assert.equal(mails.length, 1);
  const body = bodyOf(home, SUPER, mails[0]);
  assert.match(body, /출처: 레포 포럼 zeta_app/);
  assert.match(body, /threadId: T-WORK/);
  assert.match(body, /업무 키: zeta_app\/work-1/);
  assert.match(body, new RegExp(`받는이: ${SUPER}\\n`));
  assert.match(body, /담당 슈퍼감독으로서 위 스레드에 직접 답한다/);
});

test('2 업무 아닌 레포 포럼 글 → 그 레포 카드 담당의 슈퍼. 슈퍼 없는 레포·꺼진 슈퍼·결정 글 → 비서(이유가 머리에)', () => {
  const home = world();
  const opts = {home, liveSessions: live(SUPER)};
  assert.deepEqual(resolveMailTarget(forumLine('12', 'T-OTHER'), opts), {to: SUPER, reason: null, workKey: null});
  assert.equal(resolveMailTarget(forumLine('12', 'T-DEC'), opts).to, SUPER, '결정 글은 업무가 아니라 레포 담당으로 찾는다');
  const none = resolveMailTarget(forumLine('13', 'T-X', 'nosuper_repo'), opts);
  assert.deepEqual([none.to, none.reason], ['비서', '담당 슈퍼 없음 → 비서']);
  const dead = resolveMailTarget(forumLine('14', 'T-OTHER'), {home, liveSessions: live()});
  assert.deepEqual([dead.to, dead.reason], ['비서', '담당 슈퍼 세션 없음 → 비서']);
  const broken = resolveMailTarget(forumLine('15', 'T-OTHER'), {home, liveSessions: () => { throw new Error('tmux 없음'); }});
  assert.equal(broken.to, '비서');
  const line = forumLine('13', 'T-X', 'nosuper_repo');
  createMailOut({home, resolve: (l, o) => resolveMailTarget(l, {...o, liveSessions: live(SUPER)})})(line);
  const mails = new Mailbox(home, '비서').list({all: true});
  assert.equal(mails.length, 1);
  assert.match(bodyOf(home, '비서', mails[0]), /받는이: 비서 \(담당 슈퍼 없음 → 비서\)/);
  assert.match(bodyOf(home, '비서', mails[0]), /담당 슈퍼감독에게 kadan send로 넘긴다/);
});

test('3 #비서 글(포럼 아님)은 슈퍼가 있어도 비서에게, 관계표가 없으면 포럼 글도 비서에게', () => {
  const home = world();
  const mine = {id: '16', where: 'channel', threadId: null, content: '안녕', at: '2026-10-16T00:00:00Z'};
  assert.deepEqual(resolveMailTarget(mine, {home, liveSessions: live(SUPER)}), {to: '비서', reason: null, workKey: null});
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-droute-bare-'));
  assert.match(resolveMailTarget(forumLine('17', 'T-OTHER'), {home: bare, liveSessions: live(SUPER)}).reason, /관계표를 모름/);
});

test('4 같은 디코 글은 받는이가 바뀐 뒤 다시 와도 우편이 둘이 되지 않는다', () => {
  const home = world();
  const line = forumLine('18', 'T-WORK');
  const first = createMailOut({home, resolve: (l, o) => resolveMailTarget(l, {...o, liveSessions: live(SUPER)})})(line);
  const again = createMailOut({home, resolve: (l, o) => resolveMailTarget(l, {...o, liveSessions: live()})})(line);   // 새 프로세스, 이제 슈퍼가 꺼짐
  assert.equal(again.duplicate, true);
  assert.equal(again.mailId, first.mailId);
  assert.equal(new Mailbox(home, '비서').list({all: true}).length, 0);
  assert.equal(new Mailbox(home, SUPER).list({all: true}).length, 1);
});

test('5 setDecision이 남긴 결정 글 키(__decisions__)는 업무 키로 읽지 않는다', () => {
  const home = world();
  setDecision(home, 'dec-1', {threadId: 'T-DEC', messageId: '99', forum: true});
  const route = resolveMailTarget(forumLine('19', 'T-DEC'), {home, liveSessions: live(SUPER)});
  assert.equal(route.workKey, null);
});
