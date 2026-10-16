// 가짜 디스코드 포럼 웹훅 + 봇 보관 API 서버 — 시험 프로세스와 따로 띄운다(알림 전송이 spawnSync로 부모를 막는다).
// 사용: node fake-forum-bot.mjs <요청 기록 파일> '<옵션 JSON>'. 첫 줄에 "PORT <번호>"를 출력한다. 모든 값은 가짜다.
// 웹훅(/api/webhooks/<id>/<token>): thread_name이면 새 글, thread_id면 그 글에 쓰기, PATCH .../messages/<id>는 메시지 수정.
//   보관된 글에 쓰면 400 {code: 50083}(디스코드 '보관된 스레드' 오류). 옵션 autoReopen이면 대신 글을 다시 열고 받아 준다.
// 봇(PATCH /channels/<글 id> {archived}): 헤더 x-fake-manual이 있으면 상태 주입을 건너뛴다(사람이 손으로 보관한 것을 흉내).
//    Authorization이 "Bot <TOKEN>"이어야 한다. 글 id는 숫자여야 한다(진짜 스노플레이크 모양).
// 옵션: {token, archiveStatus(보관 요청에 줄 상태, 기본 200), resumeStatus(재개 요청), failEditStatus(메시지 수정에 줄 상태),
//        editDelayMs(메시지 수정 응답 지연), autoReopen}. 기록 줄: {method, url, auth(토큰 앞 일부만), body}.
import http from 'node:http';
import fs from 'node:fs';

const [, , logFile, optionsJson = '{}'] = process.argv;
const options = JSON.parse(optionsJson), token = options.token ?? 'FAKE-BOT-TOKEN-zz99';
const base = 9000000000000000000n;
let seq = 0n;
const nextId = () => String(base + (seq += 1n));
const threads = new Set(), archived = new Set(), messages = new Map(); // 메시지 id → 글 id
const sockets = new Set();

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf8'), url = new URL(req.url, 'http://x'), p = url.pathname.split('/').filter(Boolean);
    const body = text ? JSON.parse(text) : {};
    fs.appendFileSync(logFile, JSON.stringify({method: req.method, url: req.url, auth: req.headers.authorization ? 'Bot ***' : null,
      authOk: req.headers.authorization === `Bot ${token}`, body: text}) + '\n');
    const reply = (status, json, delay = 0) => setTimeout(() => { res.writeHead(status, {'content-type': 'application/json'}); res.end(json === undefined ? '' : JSON.stringify(json)); }, delay);
    if (p[0] === 'channels' && p.length === 2 && req.method === 'PATCH') {
      if (req.headers.authorization !== `Bot ${token}`) return reply(401, {code: 0});
      if (!threads.has(p[1])) return reply(404, {code: 10003});
      const wanted = body.archived === true, status = wanted ? options.archiveStatus : options.resumeStatus;
      if (status && status !== 200 && !req.headers['x-fake-manual']) return reply(status, {code: status === 403 ? 50013 : 0, message: `fake ${status}`});
      if (wanted) archived.add(p[1]); else archived.delete(p[1]);
      return reply(200, {id: p[1], thread_metadata: {archived: wanted}});
    }
    if (p[0] === 'api' && p[1] === 'webhooks') {
      const thread = url.searchParams.get('thread_id');
      if (thread && threads.has(thread) && archived.has(thread)) {
        if (!options.autoReopen) return reply(400, {code: 50083, message: 'Thread is archived'});
        archived.delete(thread);
      }
      if (req.method === 'PATCH') {
        const mid = p[5];
        if (!thread || !threads.has(thread) || messages.get(mid) !== thread) return reply(404, {code: 10008});
        if (options.failEditStatus) return reply(options.failEditStatus, {code: 0}, options.editDelayMs ?? 0);
        return reply(200, {id: mid, channel_id: thread}, options.editDelayMs ?? 0);
      }
      const mid = nextId();
      if (thread) {
        if (!threads.has(thread)) return reply(404, {code: 10003});
        messages.set(mid, thread);
        return reply(200, {id: mid, channel_id: thread});
      }
      if (!body.thread_name) return reply(400, {message: 'thread_name or thread_id required'});
      const id = nextId(); threads.add(id); messages.set(mid, id);
      return reply(200, {id: mid, channel_id: id});
    }
    reply(404, {code: 0});
  });
});
server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
server.listen(0, '127.0.0.1', () => console.log(`PORT ${server.address().port}`));
process.on('SIGTERM', () => { for (const s of sockets) s.destroy(); server.close(() => process.exit(0)); });
