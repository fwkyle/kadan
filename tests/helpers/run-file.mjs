import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {markedChildren, signalChild} from './child-cleanup.mjs';

export function runTestFile(file, {env, timeoutMs, args = [], signal, report = console.error,
  stdio = 'inherit'} = {}) {
  return new Promise(resolve => {
    // 중첩 실행도 바깥 표지를 보존한다. 값 하나를 덮어쓰면 바깥 정리에서 빠진다.
    const marker = `KADAN_TEST_OWNER_${randomUUID().replaceAll('-', '')}`;
    const childEnv = {...env, [marker]: '1'};
    delete childEnv.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ['--test', ...args, file], {
      env: childEnv, stdio, detached: true,
    });
    let stopping = false, finished = false, timedOut = false, killTimer, finishTimer;
    const finish = code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); clearTimeout(killTimer); clearTimeout(finishTimer);
      signal?.removeEventListener('abort', abort);
      resolve(timedOut || stopping ? 1 : code);
    };
    const stop = reason => {
      if (stopping || finished) return;
      stopping = true;
      let children = [];
      try { children = markedChildren(marker); }
      catch (error) { report(`${file}: ${error.message}`); }
      report(`${reason}: ${file}; 남은 자식 PID: ${children.map(p => p.pid).join(', ') || child.pid}`);
      // 그룹 주소는 재사용될 수 있다. 개별 PID의 표지·시작 시각·명령을 매번 다시 확인한다.
      const send = sig => {
        for (const row of children.toReversed()) {
          try { signalChild(row, marker, sig); }
          catch (error) { report(`${file}: PID ${row.pid}: ${error.message}`); }
        }
      };
      send('SIGTERM');
      killTimer = setTimeout(() => {
        send('SIGKILL');
        finishTimer = setTimeout(() => finish(1), 500);
      }, 500);
    };
    const abort = () => stop('시험 중단');
    const timer = setTimeout(() => { timedOut = true; stop(`파일 종료 상한 ${timeoutMs}ms 초과`); }, timeoutMs);
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
    child.on('error', error => { report(`${file}: ${error.message}`); finish(1); });
    child.on('close', code => {
      if (!stopping) finish(code ?? 1);
      // close가 먼저 와도 SIGTERM을 무시하는 자손의 SIGKILL까지 기다린다.
    });
  });
}
