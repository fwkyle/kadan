// 설명 AI 시험용 가짜 한 번 호출 실행기. 실제 AI·네트워크를 쓰지 않는다. 모델 이름이 동작을 정한다(첫 인자).
//   empty 봉투 response가 빈 글 · nofield 봉투에 response 없음 · leak 비밀 모양이 든 긴 JSON 아님 글 · notenv 봉투가 JSON 아님
//   huge 12MiB 출력 · ok 정상 · garbage JSON 아님 · rule 칸 규칙 위반(stage) · fail 종료 코드 1 · slow 5초 지연
// 받은 글(표준 입력)은 FAKE_EXPLAIN_LOG에 한 줄로 남겨 시험이 호출 수와 프롬프트를 본다.
import fs from 'node:fs';
const mode = process.argv[2];
// 인자(argv[3])로 받으면 그 글, 아니면 표준 입력의 글이 프롬프트다.
let prompt = process.argv[3] ?? '';
if (process.argv[3] === undefined) for await (const chunk of process.stdin) prompt += chunk;
fs.appendFileSync(process.env.FAKE_EXPLAIN_LOG, JSON.stringify({mode, prompt}) + '\n');
if (mode === 'fail') { process.stderr.write('boom\n'); process.exit(1); }
if (mode === 'huge') { const block = 'x'.repeat(65536); for (let i = 0; i < 200; i++) if (!process.stdout.write(block)) await new Promise(r => process.stdout.once('drain', r)); process.exit(0); }
if (mode === 'empty') { process.stdout.write(JSON.stringify({response: ''})); process.exit(0); }
if (mode === 'nofield') { process.stdout.write(JSON.stringify({error: 'quota'})); process.exit(0); }
if (mode === 'notenv') { process.stdout.write('plain text, not an envelope'); process.exit(0); }
if (mode === 'leak') {
  const secret = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123 sk-abcdefghijklmnopqrstuvwxyz123456 Bearer abcdefghijklmnop1234567890';
  process.stdout.write(JSON.stringify({response: `${secret} ${'가'.repeat(600)}`})); process.exit(0);
}
if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 5000));
const brief = {title: '쉬운 제목', workstream: '시험 묶음', stage: mode === 'rule' ? '없는단계' : '구현', goal: '목표', summary: '요약', next: '다음', blocker: ''};
process.stdout.write(mode === 'garbage' ? '죄송합니다 JSON이 아닙니다' : JSON.stringify({response: JSON.stringify(brief)}));
