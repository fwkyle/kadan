import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adoptCommand, ADOPT_UNCHECKED_HARNESSES, detectConversation, runAdopt } from '../src/adopt.mjs';
import { findAgyConversation } from '../src/adopt-process.mjs';
import { inspectCardSendIdentity } from '../src/ai-identity.mjs';

const ID = '158a8380-2bc4-4110-aea9-3a30417d29b5';

test('agy·omo 이어 열기 명령: 모델이 적히고 카드 전송 신원 확인을 통과한다', () => {
  const agy = adoptCommand({ harness: 'agy', id: ID, model: 'gemini-4-neon-xhigh', effort: 'high' });
  assert.equal(agy, `agy --conversation ${ID} --model gemini-4-neon-xhigh --effort high`);
  assert.equal(adoptCommand({ harness: 'agy', id: ID, model: 'gemini-4-neon-xhigh' }),
    `agy --conversation ${ID} --model gemini-4-neon-xhigh`);
  const omo = adoptCommand({ harness: 'omo', id: ID, model: 'openai/gpt-6:high' });
  assert.equal(omo, `omo --fork ${ID} --model openai/gpt-6:high`);
  for (const cmd of [agy, omo]) {
    const identity = inspectCardSendIdentity({ entries: [{ kind: 'start', session: 'kadan-r', panePid: '1', cmd }], session: 'kadan-r', currentPid: '1' });
    assert.equal(identity.ok, true, cmd);
  }
});

test('agy·omo: 모델 없음·나쁜 ID·omo의 --effort·모르는 실행기는 거절한다', () => {
  assert.throws(() => adoptCommand({ harness: 'agy', id: ID }), /--model이 필요하다/);
  assert.throws(() => adoptCommand({ harness: 'omo', id: 'x; rm -rf ~', model: 'm' }), /대화 ID/);
  assert.throws(() => adoptCommand({ harness: 'omo', id: ID, model: 'openai/gpt-6', effort: 'high' }), /omo는 --effort 대신/);
  assert.throws(() => adoptCommand({ harness: 'gemini', id: ID, model: 'm' }), /claude·codex·agy·omo 중 하나다/);
});

function fakes() {
  const calls = { start: [], send: [], log: [], inherit: [], prepare: [] };
  return {
    calls,
    deps: {
      floor: { alive: () => false, read: () => '› ' },
      sessionName: (role) => 'kadan-' + role,
      start: (argv, flags) => calls.start.push({ argv, flags }),
      send: (m) => calls.send.push(m),
      log: (line) => calls.log.push(line),
      sleep: () => {},
      // cmdAdopt가 agy·omo에 쓰는 것과 같은 꼴: 권한은 기본값, 안내 한 줄.
      inherit: (conversation) => {
        calls.inherit.push(conversation);
        return ADOPT_UNCHECKED_HARNESSES.includes(conversation.harness)
          ? { permissions: { args: [] }, unsupported: `${conversation.harness}는 권한·원본 탭을 확인할 수 없다` } : null;
      },
      prepare: (options) => { calls.prepare.push(options); return null; },
    },
  };
}

for (const [harness, model, cmd] of [
  ['agy', 'gemini-4-neon-xhigh', `agy --conversation ${ID} --model gemini-4-neon-xhigh`],
  ['omo', 'openai/gpt-6:high', `omo --fork ${ID} --model openai/gpt-6:high`],
]) {
  test(`adopt --resume --harness ${harness}: 이어 열기 명령으로 start하고, 권한 못 읽음을 한 줄 안내한다`, () => {
    const { calls, deps } = fakes();
    const out = runAdopt({ role: `감독-${harness}`, flags: { model, resume: ID, harness }, env: {}, ...deps });
    assert.equal(calls.start[0].flags.cmd, cmd);
    assert.equal(calls.start[0].flags.reason, `대화 옮기기(adopt): ${harness} ${ID}`);
    assert.ok(!/--permission-mode|approval_policy|dangerously/.test(calls.start[0].flags.cmd), '없던 권한을 붙이지 않는다');
    assert.ok(calls.log.some((l) => l.includes('권한·원본 탭을 확인할 수 없다')), '안내 한 줄');
    assert.equal(out.adoptionId, undefined, '인수 확인(원본 탭 닫기) 요청을 만들지 않는다');
    assert.equal(out.prompt, 'sent');
    assert.doesNotMatch(calls.send[0].message, /adopt accept/);
  });
}

test('adopt: agy·omo도 대화 ID가 없으면 거절하고, 모르는 실행기는 넷을 안내한다', () => {
  const { deps } = fakes();
  assert.throws(() => runAdopt({ role: '감독', flags: { model: 'm' }, env: {}, ...deps }),
    /--resume <대화ID> --harness codex\|agy\|omo/);
  assert.throws(() => runAdopt({ role: '감독', flags: { model: 'm', resume: ID, harness: 'gemini' }, env: {}, ...deps }),
    /claude·codex·agy·omo/);
  assert.throws(() => runAdopt({ role: '감독', flags: { model: 'openai/gpt-6', resume: ID, harness: 'omo', effort: 'high' }, env: {}, ...deps }),
    /omo는 --effort 대신/);
});

test('adopt: detect가 agy 대화를 알려 주면 --resume 없이도 이어 연다', () => {
  const { calls, deps } = fakes();
  runAdopt({ role: '감독', flags: { model: 'gemini-4-neon-xhigh' }, env: {},
    detect: (env) => detectConversation(env) ?? { harness: 'agy', id: ID }, ...deps });
  assert.equal(calls.start[0].flags.cmd, `agy --conversation ${ID} --model gemini-4-neon-xhigh`);
});

test('findAgyConversation: 상위 agy가 연 presence 잠금이 정확히 하나일 때만 ID로 쓴다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-agy-home-'));
  const root = path.join(home, '.gemini', 'antigravity-cli');
  fs.mkdirSync(path.join(root, 'conversations'), { recursive: true });
  fs.writeFileSync(path.join(root, 'conversations', `${ID}.db`), '');
  const lock = id => `n${path.join(root, 'presence', `${id}.lock`)}`;
  const lsof = lines => () => ({ status: 0, stdout: ['p1', 'n/tmp/other', ...lines].join('\n') });
  const lineage = [{ pid: '5', executable: '/bin/zsh' }, { pid: '6', executable: '/opt/bin/agy' }];
  const find = (run, l = lineage) => findAgyConversation({ lineage: l, run, userHome: home });
  assert.deepEqual(find(lsof([lock(ID)])), { harness: 'agy', id: ID });
  assert.equal(find(lsof([])), null, '잠금이 없으면 모른다');
  assert.equal(find(lsof([lock(ID), lock('other-id')])), null, '둘 이상이면 고르지 않는다');
  assert.equal(find(lsof([lock('no-such-db')])), null, '대화 DB가 없으면 쓰지 않는다');
  assert.equal(find(lsof([`n${path.join(root, 'presence', 'sub', `${ID}.lock`)}`])), null, '다른 폴더의 같은 이름은 쓰지 않는다');
  assert.equal(find(() => ({ status: 1, stdout: '' })), null, 'lsof 실패');
  assert.equal(find(lsof([lock(ID)]), [{ pid: '5', executable: '/bin/zsh' }]), null, '상위에 agy가 없으면 모른다');
});
