import {spawn} from 'node:child_process';
import {childPids, signalPid} from './child-cleanup.mjs';

export function runTestFile(file, {env, timeoutMs, args = [], signal, report = console.error,
  stdio = 'inherit'} = {}) {
  return new Promise(resolve => {
    const childEnv = {...env};
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
      let pids = [];
      try { pids = childPids(child.pid); }
      catch (error) { report(`${file}: ${error.message}`); }
      report(`${reason}: ${file}; 남은 자식 PID: ${pids.join(', ') || child.pid}`);
      // 부모가 먼저 끝나도 그룹과 미리 확보한 detached 자손까지 정리한다.
      const send = sig => {
        for (const pid of pids.toReversed()) signalPid(pid, sig);
        if (child.pid) signalPid(-child.pid, sig);
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
