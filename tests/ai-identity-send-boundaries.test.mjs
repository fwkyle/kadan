import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectCardSendIdentity, matchesAiProcess} from '../src/ai-identity.mjs';
import {sendTmux, tmuxFloor} from '../src/floor-tmux.mjs';

const identity = {harness:'codex', model:'test-model', currentPid:'11'};
const inspect = cmd => inspectCardSendIdentity({entries:[{kind:'start', session:'kadan-r', panePid:'11', cmd}], session:'kadan-r', currentPid:'11'});

test('카드 명령 파서: 셸 결합·주석·프롬프트의 모델 문자열은 신원이 아니다', () => {
  for (const cmd of ['codex --version; exec cat # --model fake', 'codex --model x && cat',
    'codex --model x | cat', 'codex --model x # comment', 'codex --model $(echo x)',
    'codex --model `echo x`', 'codex --model x\ncat', 'codex "explain --model fake"',
    "codex ' --model fake '", 'codex -- --model x', 'codex --model=""',
    'codex --model x --version', 'codex --model x --help']) {
    assert.equal(inspect(cmd).ok, false, cmd);
  }
  for (const cmd of ['codex --model="x"', 'codex resume abc -m x', "'/opt/bin/claude' --model x",
    'devin --model x', 'omo --model p/m --thinking max', "X=1 codex --model x -c 'model_reasoning_effort=\"high\"'",
    'codex --model x "explain --model fake"']) assert.equal(inspect(cmd).ok, true, cmd);
  assert.equal(inspect('codex --model x "explain --model fake"').model, 'x');
});

test('kadan-<실행기> 래퍼는 그 실행기로 읽고, 실제 프로세스 대조는 그대로 한다', () => {
  const found = inspect('/opt/kadan/bin/kadan-claude --model claude-opus-5-5 --effort high');
  assert.equal(found.ok, true);
  assert.equal(found.harness, 'claude');
  assert.equal(found.model, 'claude-opus-5-5');
  for (const cmd of ['/opt/kadan/bin/kadan-bash --model x', 'kadan- --model x', 'kadan-claude']) assert.equal(inspect(cmd).ok, false, cmd);
  // 래퍼가 exec하지 않고 남아 있으면 전경 프로세스가 claude가 아니므로 카드는 거부된다.
  assert.equal(matchesAiProcess('/bin/sh /opt/kadan/bin/kadan-claude --model x', 'claude', 'x'), false);
  assert.equal(matchesAiProcess('/opt/bin/claude --model x --effort high', 'claude', 'x'), true);
});

test('프로세스 실행 파일/스크립트 자리만 실행기 이름으로 인정한다', () => {
  for (const args of ['/opt/bin/codex --model x', '/usr/bin/node /opt/bin/codex.js --model x', '/usr/bin/bun /opt/bin/omo --model x']) {
    assert.equal(matchesAiProcess(args, args.includes('omo') ? 'omo' : 'codex'), true, args);
  }
  for (const args of ['cat', '/usr/bin/node receiver.mjs codex --model x', '/bin/sh -c codex --model x', '/usr/bin/node --eval codex']) {
    assert.equal(matchesAiProcess(args, 'codex'), false, args);
  }
});

// 화면 모양(프롬프트·자리표시자·테두리·바닥글)은 보지 않는다(2026-10-17 [kyle]). 사람 보호는 client_activity 하나다.
// 가짜 run은 kadan 자신의 paste-buffer가 client_activity를 바꾸지 않는다는 전제를 따른다(실제 tmux도 키 입력만 센다).
const nowSec = () => Math.floor(Date.now() / 1000);
// list-clients 한 줄: "붙은 시각 마지막 활동". 붙기만 하면 둘이 같고, 키를 눌러야 활동이 뒤로 간다(2026-10-17 격리 소켓 실측).
const typed = (ago, at = nowSec(), attached = at - 3600) => `${attached} ${at - ago}`;
const attachedOnly = (ago, at = nowSec()) => `${at - ago} ${at - ago}`;
function fixture({state='11|0', ps='11 1 11 11 /opt/bin/codex --model test-model', clients='', afterLoad, psStatus=0, screen='› 쓰던 글', card=true} = {}) {
  const calls=[]; let loaded=false;
  return {calls, options:{...(card ? {cardIdentity:identity} : {}), pid:1, hrtime:()=>1n,
    run(args) {
      calls.push(args);
      if(args.includes('#{pane_in_mode}')) return '0';
      if(args.includes('#{pane_pid}|#{pane_dead}')) return loaded && afterLoad?.state || state;
      if(args[0]==='list-clients') return loaded && afterLoad?.clients !== undefined ? afterLoad.clients : clients;
      if(args[0]==='capture-pane') return screen;
      if(args[0]==='load-buffer') loaded=true;
      return '';
    },
    spawn(bin) {return bin==='ps' ? {status:psStatus,stdout:ps} : {status:0};},
  }};
}
const count = (f, name) => f.calls.filter(a=>a[0]===name).length;

for (const [name, config, code] of [
  ['현재 프로세스가 cat으로 교체됨', {ps:'11 1 11 11 cat\n22 1 22 22 codex --model x'}, 'KADAN_AI_PROCESS_UNVERIFIED'],
  ['AI가 뒤에서만 남고 cat이 입력을 받음', {ps:'11 1 11 11 cat\n12 11 12 11 codex --model x'}, 'KADAN_AI_PROCESS_UNVERIFIED'],
  ['죽은 pane', {state:'11|1'}, 'KADAN_PANE_DEAD'],
  ['pane 세대(PID) 변경', {state:'12|0'}, 'KADAN_PID_MISMATCH'],
  ['pane 상태 미확인', {state:'?'}, 'KADAN_PANE_STATE_UNKNOWN'],
  ['실제 모델 불일치', {ps:'11 1 11 11 codex --model other'}, 'KADAN_AI_PROCESS_UNVERIFIED'],
  ['실제 모델 미확인', {ps:'11 1 11 11 codex'}, 'KADAN_AI_PROCESS_UNVERIFIED'],
  ['프로세스 조회 실패', {psStatus:1}, 'KADAN_AI_PROCESS_UNKNOWN'],
  ['버퍼 준비 중 죽음', {afterLoad:{state:'11|1'}}, 'KADAN_PANE_DEAD'],
  ['사람 입력 시각 미확인', {clients:'x'}, 'KADAN_HUMAN_ACTIVITY_UNKNOWN'],
  ['버퍼 준비 중 사람이 키를 누름', {afterLoad:{clients:typed(1)}}, 'KADAN_HUMAN_ACTIVE'],
]) test(`붙여넣기 전 거부: ${name}`, () => {
  const f=fixture(config);
  assert.throws(()=>sendTmux('kadan-r','CARD',f.options), e=>e.code===code && e.delivery==='not-sent');
  assert.equal(count(f,'paste-buffer'),0);
  assert.equal(count(f,'send-keys'),0);
});

test('현재 pane 자식 AI는 허용하고 일반 우편은 프로세스 검사를 거치지 않는다', () => {
  const f=fixture({ps:'11 1 11 12 /bin/sh\n12 11 12 12 /usr/bin/node /opt/bin/codex.js --model test-model'});
  sendTmux('kadan-r','CARD',f.options);
  assert.equal(count(f,'paste-buffer'),1);
  assert.equal(count(f,'send-keys'),1);
  const mail=fixture({ps:'11 1 11 11 cat',card:false});
  sendTmux('kadan-r','MAIL',mail.options);
  assert.equal(count(mail,'paste-buffer'),1);
});

// 경로 이름 → 보내기 옵션 만들기. 알림은 감시기 보호 객체(now 고정)를 쓰고, 카드·일반 우편은 현재 시각을 쓴다.
const PATHS = {
  '카드': {card:true},
  '알림': {card:false, guard:true},
  '일반 우편': {card:false},
};
const send = (f, guard) => sendTmux('kadan-r','MAIL',{...f.options, ...(guard ? {notificationGuard:guard} : {})});

for (const [path, cfg] of Object.entries(PATHS)) {
  const guard = (extra={}) => cfg.guard ? {humanIdleMs:30_000, ...extra} : undefined;

  test(`9/23 사고 재현: kyle이 비서 창에 문장을 치는 중(5초 전 키 입력)이면 ${path}은 붙여넣지 않는다`, () => {
    const f=fixture({clients:typed(5), card:cfg.card});
    assert.throws(()=>send(f, guard()), e=>e.code==='KADAN_HUMAN_ACTIVE' && e.delivery==='not-sent');
    assert.equal(count(f,'paste-buffer'),0);
    assert.equal(count(f,'send-keys'),0);
  });

  test(`${path}: 60초 전 키 입력·붙은 client 없음은 통과한다`, () => {
    for (const clients of [typed(60), '', `${typed(60)}\n${typed(3600)}`]) {
      const f=fixture({clients, card:cfg.card});
      send(f, guard());
      assert.equal(count(f,'paste-buffer'),1, clients);
    }
  });

  test(`${path}: 붙은 client가 여럿이면 하나라도 최근 입력했을 때 보류한다`, () => {
    const f=fixture({clients:`${typed(3600)}\n${typed(2)}`, card:cfg.card});
    assert.throws(()=>send(f, guard()), e=>e.code==='KADAN_HUMAN_ACTIVE');
    assert.equal(count(f,'paste-buffer'),0);
  });

  test(`${path}: 활동 값이 숫자가 아니면 실패 닫힘`, () => {
    const f=fixture({clients:'x', card:cfg.card});
    assert.throws(()=>send(f, guard()), e=>e.code==='KADAN_HUMAN_ACTIVITY_UNKNOWN' && e.delivery==='not-sent');
    assert.equal(count(f,'paste-buffer'),0);
  });

  test(`${path}: 화면에 미제출 글처럼 보이는 내용이 있어도 사람 활동이 없으면 보낸다(바뀐 동작)`, () => {
    const f=fixture({screen:'› USER_PENDING_\nSECOND_PENDING', clients:'', card:cfg.card});
    send(f, guard());
    assert.equal(count(f,'paste-buffer'),1);
    assert.equal(count(f,'capture-pane'),0, '화면 모양은 읽지 않는다');
  });
}

test('방금 붙었지만 키를 누르지 않은 client는 사람 입력이 아니다 — 세 경로 모두 통과', () => {
  for (const cfg of Object.values(PATHS)) for (const clients of [attachedOnly(0), attachedOnly(3), `${attachedOnly(0)}\n${typed(3600)}`]) {
    const f=fixture({clients, card:cfg.card});
    send(f, cfg.guard ? {humanIdleMs:30_000} : undefined);
    assert.equal(count(f,'paste-buffer'),1, clients);
  }
});

test('붙은 뒤 10초에 키를 누르면 보류한다(활동이 붙은 시각보다 뒤일 때만 입력)', () => {
  const at=nowSec();
  for (const cfg of Object.values(PATHS)) {
    const f=fixture({clients:`${at - 12} ${at - 2}`, card:cfg.card});
    assert.throws(()=>send(f, cfg.guard ? {humanIdleMs:30_000} : undefined), e=>e.code==='KADAN_HUMAN_ACTIVE' && e.delivery==='not-sent');
    assert.equal(count(f,'paste-buffer'),0);
  }
  // 경계: 차이 0이면 통과, 차이 1이면 보류(붙은 뒤 1초대 입력도 입력이다, 검수 P2).
  for (const cfg of Object.values(PATHS)) {
    const pass=fixture({clients:`${at - 5} ${at - 5}`, card:cfg.card});
    send(pass, cfg.guard ? {humanIdleMs:30_000} : undefined);
    assert.equal(count(pass,'paste-buffer'),1);
    const held=fixture({clients:`${at - 5} ${at - 4}`, card:cfg.card});
    assert.throws(()=>send(held, cfg.guard ? {humanIdleMs:30_000} : undefined), e=>e.code==='KADAN_HUMAN_ACTIVE');
    assert.equal(count(held,'paste-buffer'),0);
  }
});

test('client 값이 한쪽만 있거나 음수·소수면 실패 닫힘', () => {
  for (const clients of ['1792000000', '-1 5', '1.5 2', 'x y', '1 ']) {
    const f=fixture({clients, card:false});
    assert.throws(()=>send(f), e=>e.code==='KADAN_HUMAN_ACTIVITY_UNKNOWN', clients);
  }
});

test('감시기 알림: 기준 시간은 호출부가 정한다(10분 기준 600초 안 입력은 보류)', () => {
  const now=1_000_000_000_000;
  const f=fixture({clients:typed(60, now/1000), card:false});
  assert.throws(()=>sendTmux('kadan-r','MAIL',{...f.options, notificationGuard:{humanIdleMs:600_000, now}}), e=>e.code==='KADAN_HUMAN_ACTIVE');
  const g=fixture({clients:typed(3600, now/1000), card:false});
  sendTmux('kadan-r','MAIL',{...g.options, notificationGuard:{humanIdleMs:600_000, now}});
  assert.equal(count(g,'paste-buffer'),1);
});

test('감시기 강제 알림(force)은 사람 입력 검사를 건너뛴다', () => {
  const f=fixture({clients:typed(1), card:false});
  sendTmux('kadan-r','MAIL',{...f.options, notificationGuard:{humanIdleMs:30_000, force:true}});
  assert.equal(count(f,'paste-buffer'),1);
  assert.equal(count(f,'list-clients'),0);
});

test('붙여넣기 전·후와 Enter 직전, 세 번 사람 입력을 본다', () => {
  const f=fixture({card:false});
  sendTmux('kadan-r','MAIL',f.options);
  assert.equal(count(f,'list-clients'),3);
});

test('notificationHold는 붙여넣지 않고 같은 사람 입력 기준으로 보류 사유만 돌려준다', () => {
  const hold = clients => tmuxFloor.notificationHold('kadan-r',{humanIdleMs:30_000},{run:args=>
    args.includes('#{pane_in_mode}') ? '0' : args[0]==='list-clients' ? clients : ''});
  assert.equal(hold(typed(5)).code,'KADAN_HUMAN_ACTIVE');
  assert.equal(hold(typed(60)),null);
});

test('현재 프로세스의 명시 모델은 실행기 자리와 함께 일치해야 한다', () => {
  for(const args of ['codex resume id -m x','node /opt/codex.js --model=x','bun /opt/omo --model x','claude --model x','devin --model x']) {
    const harness=args.includes('omo')?'omo':args.startsWith('claude')?'claude':args.startsWith('devin')?'devin':'codex';
    assert.equal(matchesAiProcess(args,harness,'x'),true,args);
    assert.equal(matchesAiProcess(args,harness,'y'),false,args);
  }
});
