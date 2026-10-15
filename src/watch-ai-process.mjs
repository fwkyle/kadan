// AI 프로세스가 응답하는 동안 감시sh의 이벤트 루프를 비워 둔다.
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export function runJudgeProcess(command, settings) {
  return new Promise(resolve => {
    const child=spawn(process.execPath,
      [fileURLToPath(new URL('./watch-call-process.mjs',import.meta.url)),command,String(settings.timeout)],
      {env:settings.env,stdio:['pipe','pipe','pipe','ipc'],...(settings.cwd?{cwd:settings.cwd}:{})});
    let stdout='',stderr='',error=null,stopping=false;
    const stop=kind=>{
      if(stopping)return;
      stopping=true;
      if(child.connected)child.send({kind},err=>{if(err)child.kill('SIGTERM');});
      else child.kill('SIGTERM');
    };
    const cancel=()=>stop('cancelled');
    const poll=setInterval(()=>{
      try {if(settings.reportComplete())stop('reported');}
      catch { /* 조회 실패는 종료 시 원장을 대조해 판정한다. */ }
    },200);
    child.stdout.on('data',data=>{stdout+=data;});
    child.stderr.on('data',data=>{stderr+=data;});
    child.on('error',err=>{error=err;});
    child.stdin.on('error',()=>{});
    child.on('close',(status,signal)=>{
      clearInterval(poll);
      settings.signal?.removeEventListener('abort',cancel);
      resolve({status,signal,stdout,stderr,error});
    });
    settings.signal?.addEventListener('abort',cancel,{once:true});
    child.stdin.end(settings.input);
    if(settings.signal?.aborted)cancel();
  });
}
