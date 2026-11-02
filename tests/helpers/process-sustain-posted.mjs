// 자식 프로세스 전용(--experimental-test-module-mocks): 알림 함수 대역이 디코 게시 성공(posted:true)을 돌려줄 때
// 해소 글 고치기 분기를 지나는지 본다. 마지막 줄에 JSON 한 줄을 낸다.
import './isolated-home.mjs';
import {mock} from 'node:test';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const notifications = [];
mock.module(pathToFileURL(path.join(here, '../../src/watch-system.mjs')).href, {namedExports: {
  assertSingleWatch: () => {},
  watchProcessName: () => 'fake-watch',
  notifyUser: (message, spawn, opts) => { notifications.push(opts.kind); return {error: null, posted: opts.kind === 'alert'}; },
}});
const {runWatch} = await import('./watch-runner.mjs');

const epoch = Date.parse('2026-11-02T00:00:00.000Z');
const psFor = pids => ['100 1 2048 05:00:00 tmux', '200 100 4096 05:00:00 zsh',
  ...pids.map(pid => `${pid} 200 ${1536 * 1024} 01:00 node`)].join('\n');

async function simulate(plan) {
  let cycle = 0;
  const before = notifications.length, stop = Error('end');
  try {
    await runWatch({
      floor: {list: () => [], read: () => ''}, readEntries: () => [], readCards: () => [], parents: new Map(),
      intervalMs: 60_000, stallN: 2, routes: {}, superRole: '@user', userNotify: true, processEveryMs: 0,
      now: () => epoch + cycle * 60_000, record: () => {}, print: () => {},
      sendAlert: () => { throw Error('역할 전송 금지'); },
      spawn: command => {
        if (command === 'sleep') { if (++cycle === plan.length) throw stop; return {status: 0, stdout: ''}; }
        if (command === 'tmux') return {status: 0, stdout: '100 s 200\n'};
        if (command === 'ps') return {status: 0, stdout: psFor(plan[cycle])};
        throw Error(`예상 밖 호출 ${command}`);
      },
    });
  } catch (error) { if (error !== stop) throw error; }
  return notifications.slice(before);
}

const long = await simulate([...Array(12).fill([300]), [], [], []]);
const short = await simulate([...Array(6).fill([300]), ...Array(4).fill([301]), [], [], []]);
console.log(JSON.stringify({long, short}));
