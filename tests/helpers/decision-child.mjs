// 다른 프로세스에서 결정 알림 한 건을 보내는 시험 보조: node decision-child.mjs '{"home","envFile","kind","d"}'. 가짜 값만 쓴다.
import {DecisionStore} from '../../src/decisions.mjs';
import {notifyUser} from '../../src/user-notify.mjs';
const a = JSON.parse(process.argv[2]);
const env = {KADAN_NOTIFY: '', KADAN_NOTIFY_ENV_FILE: a.envFile};
delete process.env.KADAN_NOTIFY;
const store = new DecisionStore(a.home, {notify: () => {}, userNotify: (m, o) => notifyUser(m, () => ({status: 0}), {...o, home: a.home, env})});
const r = store.announce(a.kind, a.d);
console.log(JSON.stringify({via: r?.via, outcome: r?.discord?.outcome}));
