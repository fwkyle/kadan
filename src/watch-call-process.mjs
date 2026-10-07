// 감시AI 한 호출의 프로세스 구획만 종료한다. 다른 역할/감시 프로세스에는 신호를 보내지 않는다.
import {spawn} from 'node:child_process';
const [command,limit]=process.argv.slice(2);
const timeout=Number(limit);
if(!command||!Number.isFinite(timeout)||timeout<=0)process.exit(2);
const child=spawn(command,{shell:true,detached:true,stdio:['pipe','pipe','pipe']});
let exitCode=null,closing=false,hardStop;
const signalGroup=signal=>{if(child.pid)try{process.kill(-child.pid,signal)}catch{}};
const stop=(reason='cancelled')=>{
 if(closing)return;closing=true;
 exitCode=reason==='reported'?0:reason==='timeout'?124:143;
 if(reason==='timeout')process.stderr.write('KADAN_JUDGE_TIMEOUT=1\n');
 if(reason==='slept')process.stderr.write('KADAN_JUDGE_SLEPT=1\n');
 if(reason==='cancelled')process.stderr.write('KADAN_JUDGE_CANCELLED=1\n');
 signalGroup('SIGTERM');
 hardStop=setTimeout(()=>{signalGroup('SIGKILL');process.exit(exitCode);},1000);
};
// 시간 초과는 깨어 있던 시간으로 잰다. 맥북을 덮어 잠든 동안 멈췄다 깨면 확인 간격이 크게 벌어진다 — 그때는 연결이 이미 끊겼고
// 호출 기록의 만료 시각도 지났으므로 붙잡지 않고 'slept'로 끝낸다(2026-10-07: 잠든 18분을 포함해 시간 초과로 알림).
const SLEEP_GAP_MS=Number(process.env.KADAN_JUDGE_SLEEP_GAP_MS)||30_000,tick=Math.min(1000,Math.max(10,timeout/10));
let awake=0,last=Date.now();
const timer=setInterval(()=>{
 const now=Date.now(),gap=now-last;last=now;
 if(gap>SLEEP_GAP_MS)return stop('slept');
 awake+=gap;if(awake>=timeout)stop('timeout');
},tick);
process.on('SIGTERM',()=>stop());process.on('SIGINT',()=>stop());
process.on('disconnect',()=>stop());
process.on('message',message=>{if(['reported','cancelled'].includes(message?.kind))stop(message.kind);});
process.stdin.pipe(child.stdin);child.stdin.on('error',()=>{});
child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
child.on('error',()=>{clearInterval(timer);clearTimeout(hardStop);process.exit(1)});
child.on('close',code=>{
 clearInterval(timer);clearTimeout(hardStop);
 // 부모가 먼저 종료돼도 남아 있는 같은 호출의 자식에게 종료 신호를 보낸다.
 signalGroup('SIGKILL');
 process.exit(exitCode??code??1);
});
