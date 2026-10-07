import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createWallServer} from '../src/wall.mjs';
import {askDefault, askMessage, askRecipient} from '../src/center-wall.mjs';
import {Mailbox} from '../src/mailbox.mjs';

const table = {'m-슈퍼감독':'@user', 'm-감독':'m-슈퍼감독', 'm-검수자':'m-감독', '비서':'@user'};

test('받는 사람: 관계표 사슬 끝의 슈퍼감독, 슈퍼감독 자신은 자신, 사슬 밖은 비서, 관계표를 모르면 거부', () => {
  assert.equal(askRecipient('m-검수자', table), 'm-슈퍼감독');
  assert.equal(askRecipient('m-슈퍼감독', table), 'm-슈퍼감독');
  assert.equal(askRecipient('떠돌이', table), '비서');
  assert.equal(askRecipient('고아', {...table, '고아':'없는-감독'}), '비서');
  assert.throws(() => askRecipient('m-검수자', null), /관계표를 읽을 수 없어/);
});

test('질문 편지: 머리에 대시보드 질문·유닛, 끝에 "발령·승인이 아니다"', () => {
  const message = askMessage({unit:'m-검수자', text:'왜 꺼졌어?', context:'유닛: m-검수자 · 창 없음'});
  assert.match(message, /^\[대시보드 질문 · m-검수자\]\n왜 꺼졌어\?\n\n유닛: m-검수자 · 창 없음\n\n이 편지는 사용자의 질문이다\. 새 발령·승인이 아니다\.$/);
  assert.doesNotMatch(askMessage({unit:'a', text:'t', context:''}), /\n\n\n/);
});

test('묻기 경로: 화면 표·같은 사이트, 받는 사람은 서버가 정하고 요청의 to는 무시', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-ask-'));
  const calls = [];
  const server = createWallServer(() => ({center:null, entries:[], tree:[], ledgerLines:0, collectedAt:new Date()}),
    {home, cacheSec:0, hierarchy:() => table, ask:async (args) => { calls.push(args); return {to:args.to, mailId:'id-1'}; }});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const token = (await (await fetch(base)).text()).match(/name="token" value="([a-f0-9]+)"/)[1];
    const post = (fields, origin = base) => fetch(base + '/ask', {method:'POST', redirect:'manual',
      headers:{'content-type':'application/x-www-form-urlencoded', accept:'application/json', origin}, body:new URLSearchParams(fields)});
    assert.equal((await post({token:'', unit:'m-검수자', text:'왜?'})).status, 403);
    assert.equal((await post({token, unit:'m-검수자', text:'왜?'}, 'http://evil.example')).status, 403);
    for (const [fields, pattern] of [[{unit:'a b', text:'왜?'}, /유닛 이름/], [{unit:'m-검수자', text:'  '}, /물어볼 내용/], [{unit:'m-검수자', text:'x'.repeat(4001)}, /너무 길다/]]) {
      const r = await post({token, ...fields});
      assert.equal(r.status, 409); assert.match(await r.text(), pattern);
    }
    assert.equal(calls.length, 0, '거부된 요청은 아무것도 보내지 않는다');
    const ok = await post({token, unit:'m-검수자', text:'왜 꺼졌어?', context:'유닛 정보', to:'아무-창'});
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), {location:'/#strategy-map', result:{to:'m-슈퍼감독', mailId:'id-1'}});
    assert.deepEqual(calls, [{to:'m-슈퍼감독', message:askMessage({unit:'m-검수자', text:'왜 꺼졌어?', context:'유닛 정보'})}]);
  } finally { server.close(); }
});

test('기본 보내기: 사용자 명의 --expect-reply, --raw 없이, 창 편지·비서 우편함 두 영수증 모두에서 우편ID', async () => {
  const seen = [];
  const run = async (cmd, args, opts) => { seen.push({args:args.slice(1), role:opts.env.KADAN_ROLE}); return {stdout:'키 전송됨: kadan-m (842B, 지문 abc, 우편ID ff9f7e35-0124-433f) — 입력 접수'}; };
  assert.deepEqual(await askDefault({to:'m-슈퍼감독', message:'[대시보드 질문 · x]\n왜?', cli:'/repo/cli.mjs', env:{KADAN_ROLE:'대시보드'}, run}), {to:'m-슈퍼감독', mailId:'ff9f7e35-0124-433f'});
  assert.deepEqual(seen, [{args:['send', 'm-슈퍼감독', '--expect-reply', '[대시보드 질문 · x]\n왜?'], role:''}]);
  assert.equal((await askDefault({to:'비서', message:'m', cli:'/x', env:{}, run:async () => ({stdout:'{"mailId":"a288c4e7-dd55","status":"stored"}'})})).mailId, 'a288c4e7-dd55');
  await assert.rejects(askDefault({to:'a', message:'m', cli:'/x', env:{}, run:async () => { throw Object.assign(new Error('x'), {stderr:'세션 없음'}); }}), /질문을 보내지 못했다: 세션 없음/);
});

test('사용자 우편함에 온 답은 OS 알림을 띄우고, 사용자가 보낸 편지와 KADAN_NOTIFY=off는 띄우지 않는다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-ask-notify-'));
  const bin = path.join(home, 'bin'), log = path.join(home, 'osascript.log');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'osascript'), `#!/bin/sh\necho "$2" >> ${JSON.stringify(log)}\n`, {mode:0o755});
  const question = new Mailbox(home, '슈퍼').send({by:'사람', message:'왜?', expectReply:true});
  const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
  const send = (by, args, extra = {}) => spawnSync(process.execPath, [cli, 'send', ...args], {env:{...process.env, KADAN_HOME:home, KADAN_ROLE:by, KADAN_SOCKET:path.basename(home), KADAN_WINDOW:'none', PATH:bin + ':' + process.env.PATH, KADAN_NOTIFY:'', ...extra}, encoding:'utf8'});
  const answer = send('슈퍼', ['사람', '--mailbox', '--reply-to', question.mailId, '--reply-final', '창은 일이 끝나서 닫혔다.\n카드는 재검수로 보낸다.']);
  assert.equal(answer.status, 0, answer.stderr);
  const lines = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
  assert.equal(lines().length, 1);
  assert.match(lines()[0], /카단 · 슈퍼의 답: 창은 일이 끝나서 닫혔다\./);
  assert.equal(send('사람', ['사람', '--mailbox', '메모']).status, 0);
  assert.equal(send('슈퍼', ['사람', '--mailbox', '편지'], {KADAN_NOTIFY:'off'}).status, 0);
  assert.equal(lines().length, 1, '사용자 자신의 편지와 알림 끔은 알리지 않는다');
});
