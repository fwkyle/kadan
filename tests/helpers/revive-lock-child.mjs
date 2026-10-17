// 다른 프로세스에서 revive 잠금을 얻어 보는 시험 보조: node revive-lock-child.mjs <home> <시작 시각(ms)> <붙들 시간(ms)>.
// 시작 시각까지 바쁘게 기다렸다가 동시에 획득을 시도한다. 얻으면 GOT, 못 얻으면 NO를 찍고 붙든 뒤 푼다.
import {acquireReviveLock} from '../../src/revive.mjs';
const [home, startAt, holdMs] = [process.argv[2], Number(process.argv[3]), Number(process.argv[4])];
while (Date.now() < startAt) { /* 동시 출발 */ }
const release = acquireReviveLock(home, {waitMs: 0});
console.log(release ? 'GOT' : 'NO');
if (release) { await new Promise(resolve => setTimeout(resolve, holdMs)); release(); }
