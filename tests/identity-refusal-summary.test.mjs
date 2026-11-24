import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {inspectCardSendIdentity} from '../src/ai-identity.mjs';
import {describeCommand} from '../src/command-summary.mjs';
import {guardedSend} from '../src/cli-guarded-send.mjs';
import {CardStore} from '../src/card-store.mjs';

// Why: not-ai 발령 거절 문구가 시작 명령 원문 앞 80자를 그대로 싣지 않고
// describeCommand 요약을 쓰는지, 앞머리의 가짜 비밀 값과 명령 원문 조각이 0건인지 검증한다.
const FAKE_ENV = 'zz-not-a-secret-123';
const FAKE_OPT = 'zz-not-a-secret-456';
const FAKE_PROMPT = 'zz-not-a-secret-789';

const inspect = cmd => inspectCardSendIdentity({
  entries: [{kind: 'start', role: 'r', session: 'kadan-r', panePid: '111', cmd}],
  session: 'kadan-r',
  currentPid: '111',
});

function assertNoLeak(message, fragments, label) {
  for (const fragment of fragments) {
    assert.equal(
      message.includes(fragment),
      false,
      `${label}: 거절 문구에 원문 조각(${fragment})이 남았다\n${message}`,
    );
  }
}

test('inspectCardSendIdentity(not-ai): 가짜 비밀 값과 시작 명령 원문 조각이 0건이다', () => {
  const cases = [
    {
      label: '환경변수 앞머리 + 셸',
      cmd: `KADAN_FAKE_VALUE=${FAKE_ENV} /bin/zsh -l`,
      fragments: [FAKE_ENV, 'KADAN_FAKE_VALUE', '/bin/zsh'],
    },
    {
      label: '환경변수 앞머리 + 일반 명령과 옵션 값',
      cmd: `KADAN_FAKE_VALUE=${FAKE_ENV} cat --opt=${FAKE_OPT} -- ${FAKE_PROMPT}`,
      fragments: [FAKE_ENV, FAKE_OPT, FAKE_PROMPT, 'KADAN_FAKE_VALUE', 'cat --opt'],
    },
    {
      label: '80자를 넘는 긴 비AI 시작 명령',
      cmd:
        `KADAN_FAKE_VALUE=${FAKE_ENV} /opt/custom/non-ai-wrapper ` +
        `--first-arg=${FAKE_OPT} --second-arg ${FAKE_PROMPT}`,
      fragments: [FAKE_ENV, FAKE_OPT, FAKE_PROMPT, 'KADAN_FAKE_VALUE', '/opt/custom/non-ai-wrapper'],
    },
    {
      label: 'env -S 미지원 옵션',
      cmd: `env -S "${FAKE_ENV} claude" --model test-model`,
      fragments: [FAKE_ENV, 'env -S'],
    },
    {
      label: 'env 앞머리 + 등록 실행기(launchIdentityOf에서는 not-ai)',
      cmd:
        `env KADAN_FAKE_VALUE=${FAKE_ENV} claude --model test-model ` +
        `--opt=${FAKE_OPT} -- ${FAKE_PROMPT}`,
      fragments: [FAKE_ENV, FAKE_OPT, FAKE_PROMPT, 'KADAN_FAKE_VALUE', 'env '],
    },
  ];

  for (const {label, cmd, fragments} of cases) {
    assert.ok(cmd.slice(0, 80).includes(FAKE_ENV), `${label}: 앞 80자 안에 가짜 값이 있어야 한다`);
    const result = inspect(cmd);
    assert.equal(result.ok, false, label);
    assert.equal(result.reason, 'not-ai', label);
    assert.equal(
      result.message,
      '카드 전송 불가: kadan-r의 시작 명령은 등록 AI 실행기(codex·omo·claude·devin·agy)가 ' +
        `아니다: ${describeCommand(cmd)}`,
      label,
    );
    assertNoLeak(result.message, [...fragments, cmd.slice(0, 80)], label);
  }
});

test('guardedSend(not-ai): 카드 전송 거절 오류에도 가짜 값·명령 원문이 0건이고 송신 0건이다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-identity-refusal-'));
  const store = new CardStore(home);
  const card = store.create({repo: 'r', id: 'card-1', repoPath: home, body: '# 지시'});
  store.update(
    card.key,
    {
      status: 'assigned',
      role: 'r',
      board: 'r',
      scope: '시험 범위',
      rallyId: 'rally',
      rallyTitle: '묶음',
      rallyRound: '1',
      rallyStep: 'implementation',
    },
    {revision: 1, note: '배정'},
  );

  const cmd = `KADAN_FAKE_VALUE=${FAKE_ENV} /bin/zsh -l --opt=${FAKE_OPT}`;
  const entries = [{kind: 'start', role: 'r', session: 'kadan-r', panePid: '111', cmd}];
  let sends = 0;
  const records = [];
  const floor = {name: 'fake', alive: () => true, pid: () => '111', send: () => { sends++; return {}; }};

  let caught;
  try {
    guardedSend({
      floor,
      session: 'kadan-r',
      role: 'r',
      message: '카드 지시',
      taskId: 'card-1',
      mailContext: {executionKey: card.key},
      recordedPid: '111',
      env: {KADAN_HOME: home},
      readEntries: () => entries,
      record: entry => records.push(entry),
      saveBody: () => {},
    });
  } catch (error) {
    caught = error;
  }

  assert.ok(caught, 'not-ai 세션의 카드 전송은 거절되어야 한다');
  assert.equal(caught.code, 'KADAN_AI_IDENTITY_UNVERIFIED');
  assert.equal(caught.delivery, 'not-sent');
  assert.match(caught.message, /시작 명령을 읽지 못함\(내용은 표시하지 않음\)/);
  assertNoLeak(
    caught.message,
    [FAKE_ENV, FAKE_OPT, 'KADAN_FAKE_VALUE', '/bin/zsh', cmd.slice(0, 80)],
    'guardedSend not-ai',
  );
  assert.equal(sends, 0);
  assert.equal(records.filter(entry => entry.kind === 'send').length, 0);
});

test('inspectCardSendIdentity: 정상 등록 실행기와 다른 거절 사유는 기존 동작을 유지한다', () => {
  const valid = inspect(`KADAN_FAKE_VALUE=${FAKE_ENV} codex --model test-model`);
  assert.equal(valid.ok, true);
  assert.equal(valid.harness, 'codex');
  assert.equal(valid.model, 'test-model');

  const noModel = inspect(`KADAN_FAKE_VALUE=${FAKE_ENV} codex`);
  assert.equal(noModel.ok, false);
  assert.equal(noModel.reason, 'no-model');
  assertNoLeak(noModel.message, [FAKE_ENV, 'KADAN_FAKE_VALUE'], 'no-model');

  const unsafe = inspect(`KADAN_FAKE_VALUE=${FAKE_ENV} codex --model x; echo ${FAKE_OPT}`);
  assert.equal(unsafe.ok, false);
  assert.equal(unsafe.reason, 'unsafe-command');
  assertNoLeak(unsafe.message, [FAKE_ENV, FAKE_OPT, 'KADAN_FAKE_VALUE'], 'unsafe-command');
});
