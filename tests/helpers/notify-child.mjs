// 다른 프로세스에서 알림 한 건을 보내는 시험 보조: node notify-child.mjs '{"home","envFile","work","title","key"}'. 가짜 값만 쓴다.
import {notifyUser} from '../../src/user-notify.mjs';
const a = JSON.parse(process.argv[2]);
const r = notifyUser('시험', () => ({status: 0}), {home: a.home, key: a.key, work: a.work, workTitle: a.title,
  env: {KADAN_NOTIFY: '', KADAN_NOTIFY_ENV_FILE: a.envFile}});
console.log(JSON.stringify({via: r.via, outcome: r.discord?.outcome}));
