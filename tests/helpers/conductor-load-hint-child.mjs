// 가짜 바닥·가짜 업무로 우편 한 통(cmdMail·cmdSend·cmdDispatch)을 실제 전송 경로로 보낸다. 자식 프로세스 전용 도구.
// 사용: node conductor-load-hint-child.mjs <저장소 절대경로> <경우 JSON>. stdout·stderr·종료 코드는 명령이 낸 그대로다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const [root, raw] = process.argv.slice(2);
const scenario = JSON.parse(raw);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'load-hint-'));
process.env.KADAN_HOME = home;
process.env.KADAN_NOTIFY = 'off';
const src = rel => import(pathToFileURL(path.join(root, 'src', rel)).href);
const {floor} = await src('floor.mjs');
const {appendLedger} = await src('ledger.mjs');
const {createDatabase, writeStorageMarker, appendStream} = await src('storage.mjs');
const {WorkStore} = await src('work-store.mjs');
const send = await src('commands/send.mjs');
createDatabase(home); writeStorageMarker(home, 'sqlite');

floor.alive = () => true;
floor.pid = () => '11';
floor.send = () => {
  if (scenario.floorThrows) { const error = new Error('가짜 전송 실패'); error.delivery = scenario.floorThrows; throw error; }
  return {keyDelivery: 'sent'};
};
// 역할: [이름, 프로필 또는 null, PID 기록 여부(false면 보관 경로)]
for (const [role, profile, withPid = true] of scenario.roles) {
  appendLedger({kind: 'start', role, session: `kadan-${role}`, ...(withPid ? {panePid: '11'} : {}),
    ...(profile ? {roleProfile: profile} : {})}, home);
}
const store = new WorkStore(home);
for (const [key, owner, status = 'open'] of scenario.works ?? []) {
  const work = store.create({key, title: `제목 ${key}`, goal: 'g', scope: 's', acceptance: 'a', owner, repoPath: home, by: owner});
  if (status === 'hold') store.change(key, 'update', {status: 'hold'}, {revision: work.revision, by: owner, note: '보류'});
}
for (const entry of scenario.ledger ?? []) appendLedger(entry, home);
// 과거 우편: [받는 역할, 보낸 역할, 몇 시간 전, 덧붙일 필드]
for (const [role, by, hoursAgo, extra = {}] of scenario.mails ?? []) {
  appendLedger({kind: 'send', role, session: `kadan-${role}`, by, mailId: `old-${Math.random()}`,
    t: new Date(Date.now() - hoursAgo * 3600_000).toISOString(), ...extra}, home);
}
if (scenario.limitsFile !== undefined) fs.writeFileSync(path.join(home, 'resource-limits.json'), scenario.limitsFile);
// 업무 이력 손상: 순서가 맞지 않는 줄을 넣어 업무 목록 조회가 던지게 한다.
if (scenario.corruptWork) appendStream(home, 'works/r/bad/events.jsonl', {key: 'r/bad', revision: 7, executions: [], mailRefs: []});

process.env.KADAN_ROLE = scenario.sender ?? '';
if (scenario.deliveryExit) process.env.KADAN_MAIL_DELIVERY_EXIT = '1';
send[scenario.command ?? 'cmdMail'](scenario.argv, scenario.flags ?? {});
