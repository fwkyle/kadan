// Exceptions use the existing secretary mailbox; no new role or repeated wake-up loop.
import {createHash} from 'node:crypto';
import {Mailbox} from './mailbox.mjs';
import {readMailLedger} from './ledger.mjs';

export function notifyAdoption(home, {id, role, reason}, deps = {}) {
  const message = [
    '카단 대화 이전 확인 요청',
    `인수 ID: ${id || '생성 전'} / 새 감독: ${role}`,
    `확인할 점: ${reason}`,
    id ? `현재 기록: kadan adopt status ${id}` : '원래 대화와 현재 권한부터 확인하세요.',
    '사용자는 기존 권한 유지와 새 감독 인수 확인 후 원본 Rottie 탭 종료를 요청했습니다.',
    '현재 기록과 두 창을 읽고, 새 감독이 인수할 수 있도록 필요한 맥락을 전달하세요.',
    '이미 받은 승인 안의 확인·안내는 바로 진행하고, 모호한 대상만 사용자에게 물으세요.',
    '새 감독 중복 생성·일괄 바이패스·인수 전 원본 종료는 하지 마세요.',
    '인수는 새 감독이 adopt accept로 확인합니다. 원본 탭을 특정하지 못한 경우는 보존 이유를 알려 주세요.',
  ].join('\n');
  const digest = createHash('sha256').update(message).digest('hex');
  const previous = (deps.read || (() => readMailLedger(home)))().find(event =>
    event.kind === 'send' && event.role === '비서' && event.by === 'kadan-adopt' && event.digest === digest);
  if (previous) return {status: 'stored', mailId: previous.mailId, duplicate: true};
  return (deps.send || (options => new Mailbox(home, '비서').send(options)))({
    by: 'kadan-adopt', message, category: 'request',
  });
}
