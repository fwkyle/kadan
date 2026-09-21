import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectCardSendIdentity, matchesAiProcess} from '../src/ai-identity.mjs';
import {sendTmux} from '../src/floor-tmux.mjs';

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

test('프로세스 실행 파일/스크립트 자리만 실행기 이름으로 인정한다', () => {
  for (const args of ['/opt/bin/codex --model x', '/usr/bin/node /opt/bin/codex.js --model x', '/usr/bin/bun /opt/bin/omo --model x']) {
    assert.equal(matchesAiProcess(args, args.includes('omo') ? 'omo' : 'codex'), true, args);
  }
  for (const args of ['cat', '/usr/bin/node receiver.mjs codex --model x', '/bin/sh -c codex --model x', '/usr/bin/node --eval codex']) {
    assert.equal(matchesAiProcess(args, 'codex'), false, args);
  }
});

function fixture({state='11|0|0|0', screen='› ', ps='11 1 11 11 /opt/bin/codex --model test-model', afterLoad, psStatus=0} = {}) {
  const calls=[]; let loaded=false;
  return {calls, options:{cardIdentity:identity, pid:1, hrtime:()=>1n,
    run(args) {
      calls.push(args);
      if(args.includes('#{pane_in_mode}')) return '0';
      if(args.includes('#{pane_pid}|#{pane_dead}|#{cursor_y}|#{cursor_x}')) return loaded && afterLoad?.state || state;
      if(args[0]==='capture-pane') return loaded && afterLoad?.screen !== undefined ? afterLoad.screen : screen;
      if(args[0]==='load-buffer') loaded=true;
      return '';
    },
    spawn(bin) {return bin==='ps' ? {status:psStatus,stdout:ps} : {status:0};},
  }};
}

for (const [name, config, code] of [
  ['현재 프로세스가 cat으로 교체됨', {ps:'11 1 11 11 cat\n22 1 22 22 codex --model x'}, 'KADAN_AI_PROCESS_UNVERIFIED'],
  ['AI가 뒤에서만 남고 cat이 입력을 받음', {ps:'11 1 11 11 cat\n12 11 12 11 codex --model x'}, 'KADAN_AI_PROCESS_UNVERIFIED'],
  ['죽은 pane', {state:'11|1|0|0'}, 'KADAN_PANE_DEAD'],
  ['미제출 입력', {state:'11|0|0|13',screen:'› USER_PENDING_'}, 'KADAN_PANE_INPUT_PENDING'],
  ['커서를 맨 앞으로 옮긴 미제출 입력', {screen:'› USER_PENDING_'}, 'KADAN_PANE_INPUT_PENDING'],
  ['여러 줄 입력', {state:'11|0|2|0',screen:'› first\nsecond\n'}, 'KADAN_PANE_INPUT_PENDING'],
  ['커서 아래 미제출 입력', {screen:'› \nSECOND_PENDING'}, 'KADAN_PANE_INPUT_PENDING'],
  ...['›', '>', '❯'].map(prompt => ['본문 속 가짜 프롬프트 '+prompt, {state:'11|0|1|2',screen:'› USER_UNSUBMITTED\n'+prompt+' '}, 'KADAN_PANE_INPUT_UNKNOWN']),
  ['본문 속 가짜 구분선', {screen:'› \n──────\nUSER_BELOW_BORDER'}, 'KADAN_PANE_INPUT_PENDING'],
  ['본문 끝의 구분선도 빈 입력이 아니다', {screen:'› \n──────'}, 'KADAN_PANE_INPUT_PENDING'],
  ['테두리 안 커서 아래 미제출 입력', {state:'11|0|1|2',screen:'╭────╮\n│ ›  │\n│ SECOND_PENDING │\n╰────╯\nstatus'}, 'KADAN_PANE_INPUT_PENDING'],
  ['프롬프트 없는 빈 화면', {screen:''}, 'KADAN_PANE_INPUT_UNKNOWN'],
  ['실제 모델 불일치', {ps:'11 1 11 11 codex --model other'}, 'KADAN_AI_PROCESS_UNVERIFIED'],
  ['실제 모델 미확인', {ps:'11 1 11 11 codex'}, 'KADAN_AI_PROCESS_UNVERIFIED'],
  ['입력 상태 미확인', {state:'11|0|9|0',screen:''}, 'KADAN_PANE_INPUT_UNKNOWN'],
  ['프로세스 조회 실패', {psStatus:1}, 'KADAN_AI_PROCESS_UNKNOWN'],
  ['버퍼 준비 중 죽음', {afterLoad:{state:'11|1|0|0'}}, 'KADAN_PANE_DEAD'],
  ['버퍼 준비 중 사용자 입력', {afterLoad:{screen:'› new input'}}, 'KADAN_PANE_INPUT_PENDING'],
]) test(`붙여넣기 전 거부: ${name}`, () => {
  const f=fixture(config);
  assert.throws(()=>sendTmux('kadan-r','CARD',f.options), e=>e.code===code && e.delivery==='not-sent');
  assert.equal(f.calls.filter(a=>a[0]==='paste-buffer').length,0);
  assert.equal(f.calls.filter(a=>a[0]==='send-keys').length,0);
});

test('빈 프롬프트·현재 pane 자식 AI는 허용하고 일반 우편은 카드 검사를 거치지 않는다', () => {
  const f=fixture({screen:'› ',state:'11|0|0|2',ps:'11 1 11 12 /bin/sh\n12 11 12 12 /usr/bin/node /opt/bin/codex.js --model test-model'});
  sendTmux('kadan-r','CARD',f.options);
  assert.equal(f.calls.filter(a=>a[0]==='paste-buffer').length,1);
  assert.equal(f.calls.filter(a=>a[0]==='send-keys').length,1);
  const mail=fixture({screen:'› USER_PENDING_',ps:'11 1 11 11 cat'});
  delete mail.options.cardIdentity;
  sendTmux('kadan-r','MAIL',mail.options);
  assert.equal(mail.calls.filter(a=>a[0]==='paste-buffer').length,1);
});

test('과거 출력과 본문의 프롬프트·상태 줄을 구별할 수 없으면 거부한다', () => {
  const f=fixture({state:'11|0|3|4',screen:'old output\n› OLD_PROMPT\n╭────╮\n│ ›  │\n│    │\n╰────╯\nstatus'});
  assert.throws(()=>sendTmux('kadan-r','CARD',f.options), e=>e.code==='KADAN_PANE_INPUT_UNKNOWN');
  assert.equal(f.calls.filter(a=>a[0]==='paste-buffer').length,0);
});

test('현재 프로세스의 명시 모델은 실행기 자리와 함께 일치해야 한다', () => {
  for(const args of ['codex resume id -m x','node /opt/codex.js --model=x','bun /opt/omo --model x','claude --model x','devin --model x']) {
    const harness=args.includes('omo')?'omo':args.startsWith('claude')?'claude':args.startsWith('devin')?'devin':'codex';
    assert.equal(matchesAiProcess(args,harness,'x'),true,args);
    assert.equal(matchesAiProcess(args,harness,'y'),false,args);
  }
});
