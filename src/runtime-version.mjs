// 서비스가 시작한 코드와 나중에 바뀐 체크아웃을 구분한다. 요청마다 Git을 읽지 않는다.
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
export function captureRuntimeVersion(root=fileURLToPath(new URL('..',import.meta.url))) {
 const startedAt=new Date(Date.now()-process.uptime()*1000).toISOString();
 const run=args=>spawnSync('git',['-C',root,...args],{encoding:'utf8',timeout:1000});
 const head=run(['rev-parse','--show-toplevel','HEAD']);
 let commit=null,dirty=null;
 if(head.status===0){
  const [top,sha]=head.stdout.trim().split('\n');
  // 배포 패키지의 상위에 있는 다른 저장소를 이 코드의 버전으로 표시하지 않는다.
  if(top&&fs.realpathSync(top)===fs.realpathSync(root)&&/^[a-f0-9]{40,64}$/.test(sha||'')){
   const status=run(['status','--porcelain','--untracked-files=normal','--','src','package.json']);
   if(status.status===0){commit=sha;dirty=Boolean(status.stdout.trim());}
  }
 }
 return Object.freeze({commit,dirty,startedAt});
}
