// 가짜 웹훅 서버 — 시험 프로세스와 따로 띄운다(알림 전송이 spawnSync로 부모를 막으므로 같은 프로세스에선 응답할 수 없다).
// 사용: node fake-webhook.mjs <요청 기록 파일> '<JSON 응답 목록>'. 요청 n번째에 목록의 n번째 동작을 쓰고, 목록이 끝나면 마지막을 반복한다.
// 동작: {status, body, hang, destroy}. 첫 줄에 "PORT <번호>"를 출력한다. 주소는 가짜 값만 쓴다.
import http from 'node:http';
import fs from 'node:fs';

const [, , logFile, scriptJson = '[{"status":204}]'] = process.argv;
const script = JSON.parse(scriptJson);
let n = 0;
const sockets = new Set();
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const step = script[Math.min(n++, script.length - 1)];
    fs.appendFileSync(logFile, JSON.stringify({at: Date.now(), url: req.url, body: Buffer.concat(chunks).toString('utf8')}) + '\n');
    if (step.destroy) return req.socket.destroy();
    if (step.hang) return;
    res.writeHead(step.status, {'content-type': 'application/json'});
    res.end(step.body ? JSON.stringify(step.body) : '');
  });
});
server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
server.listen(0, '127.0.0.1', () => console.log(`PORT ${server.address().port}`));
process.on('SIGTERM', () => { for (const s of sockets) s.destroy(); server.close(() => process.exit(0)); });
