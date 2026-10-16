// 시험이 진짜 원장(~/.kadan)을 건드리지 않게 한다. guardedSend 등은 KADAN_HOME이 없으면 기본 폴더의 원장을
// 쓰기 잠금으로 연다 — 기록 함수를 가짜로 넣어도 잠금은 진짜였다(2026-09-24: 진짜 원장이 바쁠 때 시험이 대기 한도
// 15초를 기다리다 실패했고, 시험 실행이 운영 중인 원장의 잠금 경쟁에도 끼어들었다). 파일의 첫 import로 둔다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-test-home-'));
process.env.KADAN_HOME = home;
// 자기가 만든 홈만 시험 프로세스가 끝날 때 지운다(다시 만들 수 있는 임시 폴더, 2026-10-16 누수).
process.once('exit', () => fs.rmSync(home, {recursive: true, force: true}));
delete process.env.KADAN_LITE_HOME;
// 사용자 우편함 편지의 OS 알림을 시험 중에는 끈다(2026-10-07).
process.env.KADAN_NOTIFY = 'off';
